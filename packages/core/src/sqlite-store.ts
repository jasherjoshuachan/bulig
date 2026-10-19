import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';
import { storableJson } from '@bulig/text';
import { eventSeq, text } from './store-text.ts';
import {
  DuplicateEventError,
  LEASE_LOST_OUTPUT,
  LeaseHeldError,
  LeaseLostError,
  StageClaimedError,
  StageNotClaimedError,
  StoreFatalError,
  type Store,
  type StoreTx,
} from './store.ts';

// Each entry upgrades the schema by one version. Never edit an old entry; add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE stages (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    output JSON
  );
  CREATE INDEX stages_job ON stages(job_id);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    job_id TEXT,
    source TEXT NOT NULL,
    payload JSON,
    at TEXT NOT NULL
  );
  CREATE INDEX events_job ON events(job_id);
  `,
  // 2: a job can carry a longer body, such as the issue text.
  `ALTER TABLE jobs ADD COLUMN body TEXT NOT NULL DEFAULT '';`,
  // 3: a small key-value store per plugin.
  `CREATE TABLE plugin_state (
    plugin TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (plugin, key)
  );`,
  // 4: the executor lease (ADR 0010). One row. expires_at is milliseconds since 1970 on SQLite's own clock (see NOW).
  `CREATE TABLE executor_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );`,
  // 5: one claim per stage of a job (ADR 0010). A claim that is not released is live, and only one may be live.
  `CREATE TABLE claims (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    stage TEXT NOT NULL,
    generation INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    claimed_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT,
    PRIMARY KEY (job_id, stage, attempt)
  );
  CREATE UNIQUE INDEX claims_live ON claims(job_id, stage) WHERE released_at IS NULL;`,
  // 6: an event id is a key. An id written twice is refused. Events a handler causes get ids derived from their cause (bus.ts), so a handler run twice meets this index; the stageId guards cover effects outside the record.
  `CREATE UNIQUE INDEX events_id ON events(id);`,
];

/**
 * The lease's clock. SQLite's 'now' is fixed for the length of one statement, and the next statement reads the host clock again.
 * That is the same source for every process using this file on this machine. Every lease statement reads it in SQL, never from
 * JavaScript, so acquire, renew and assert all use one source. Milliseconds since 1970.
 */
const NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

interface ClaimRow { job_id: string; stage: string; generation: number; attempt: number; claimed_at: string; released_at: string | null; release_reason: string | null }
interface JobRow { id: string; repo: string; title: string; body: string; status: JobStatus; created_at: string; updated_at: string }
interface StageRow {
  id: string; job_id: string; name: string; status: StageStatus; attempt: number;
  started_at: string; ended_at: string | null; output: string | null;
  /** From the stage's claim; null for a stage that began before claims existed. */
  claim_generation: number | null;
}
interface EventRow { seq: number; id: string; type: string; job_id: string | null; source: string; payload: string | null; at: string }

/** A lease that lasts a positive whole number of milliseconds. */
function ttl(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('A lease lasts a positive whole number of milliseconds');
}

const toJob = (r: JobRow): Job => ({
  id: r.id, repo: r.repo, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toStage = (r: StageRow): Stage => ({
  id: r.id, jobId: r.job_id, name: r.name, status: r.status, attempt: r.attempt,
  startedAt: r.started_at, endedAt: r.ended_at, output: r.output === null ? null : JSON.parse(r.output),
  ...(r.claim_generation !== null && { claimGeneration: r.claim_generation }),
});
/** A stage with the generation its claim was taken under (ADR 0010). */
const STAGE_SELECT = 'SELECT s.*, c.generation AS claim_generation FROM stages s LEFT JOIN claims c ON c.job_id = s.job_id AND c.stage = s.name AND c.attempt = s.attempt';
const toEvent = (r: EventRow): BuligEvent => ({
  id: r.id, seq: r.seq, type: r.type, ...(r.job_id !== null && { jobId: r.job_id }),
  source: r.source, payload: r.payload === null ? null : JSON.parse(r.payload), at: r.at,
});

/**
 * The first adapter behind the Store port: one better-sqlite3 connection in WAL mode.
 * better-sqlite3 is synchronous, so every method runs its SQL at once, in call order, and hands back a settled promise.
 * An error becomes a rejection, the way a network adapter's would.
 */
export class SqliteStore implements Store {
  private db: Database.Database;
  /** Set while a transaction is open: the generation its writes are fenced with (ADR 0010). Undefined means unfenced, generation 0. */
  private fence: { holder: string; generation: number } | undefined;
  private inTx = false;
  /** The newest renewal made while a transaction was open on this connection. If that transaction rolls back it is made again. */
  private renewedInTx: { holder: string; generation: number; ttlMs: number } | undefined;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  async schemaVersion(): Promise<number> {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  /**
   * SQLite's COMMIT is synchronous: it has finished before control returns to the event loop, so no commit of this
   * connection can be in flight while the kernel waits on a stuck call. What can be in flight is a transaction that is
   * still open while its function waits. Roll that back now, so a function that wakes up later finds no transaction to commit.
   */
  abort(): void {
    if (this.db.open && this.db.inTransaction) this.db.exec('ROLLBACK');
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * BEGIN IMMEDIATE, run `fn`, then COMMIT; ROLLBACK if `fn` or the commit fails. There is one connection, so the
   * calls `fn` makes are the transaction's. That only stays true while nothing else uses this store until it ends,
   * which the kernel's queue guarantees. Written by hand rather than with db.transaction(), which cannot wait on a promise.
   */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    this.fence = undefined;
    this.renewedInTx = undefined;
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      this.inTx = false;
      this.fence = undefined;
      return result;
    } catch (err) {
      this.inTx = false;
      this.fence = undefined;
      try {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
        // A renewal made while this transaction was open went down with it. The lease must not lose time to that.
        const again = this.renewedInTx as { holder: string; generation: number; ttlMs: number } | undefined;
        this.renewedInTx = undefined;
        if (again && this.db.open) this.renewNow(again.holder, again.generation, again.ttlMs);
      } catch (rollbackErr) {
        // The transaction may still be open. Nothing can be said about what the record holds.
        throw new StoreFatalError(`ROLLBACK failed after "${err instanceof Error ? err.message : String(err)}", so a transaction may be left open`, { cause: rollbackErr });
      }
      throw err;
    }
  }

  // ----- executor lease (ADR 0010) -----

  async acquireLease(holder: string, ttlMs: number): Promise<{ generation: number }> {
    holder = text('lease holder', holder);
    ttl(ttlMs);
    // One statement: take the row if there is none, if it ran out, or if it is ours. Otherwise nothing changes.
    const row = this.db
      .prepare(
        `INSERT INTO executor_lease (id, holder, generation, expires_at) VALUES (1, ?, 1, ${NOW} + ?)
         ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, generation = executor_lease.generation + 1, expires_at = excluded.expires_at
         WHERE executor_lease.holder = excluded.holder OR executor_lease.expires_at <= ${NOW}
         RETURNING generation`,
      )
      .get(holder, ttlMs) as { generation: number } | undefined;
    if (row) return { generation: row.generation };
    const held = this.db.prepare('SELECT holder, expires_at FROM executor_lease WHERE id = 1').get() as { holder: string; expires_at: number };
    throw new LeaseHeldError(held.holder, new Date(held.expires_at));
  }

  async renewLease(holder: string, generation: number, ttlMs: number): Promise<boolean> {
    holder = text('lease holder', holder);
    ttl(ttlMs);
    const ok = this.renewNow(holder, generation, ttlMs);
    // On this one connection a renewal made during a transaction is part of it. Remember it, in case that transaction rolls back.
    if (ok && this.db.inTransaction) this.renewedInTx = { holder, generation, ttlMs };
    return ok;
  }

  private renewNow(holder: string, generation: number, ttlMs: number): boolean {
    const res = this.db
      .prepare(`UPDATE executor_lease SET expires_at = ${NOW} + ? WHERE id = 1 AND holder = ? AND generation = ? AND expires_at > ${NOW}`)
      .run(ttlMs, holder, generation);
    return res.changes === 1;
  }

  async releaseLease(holder: string, generation: number): Promise<void> {
    holder = text('lease holder', holder);
    // The generation stays, so the next holder's number is still higher than every one before it.
    this.db.prepare(`UPDATE executor_lease SET expires_at = 0 WHERE id = 1 AND holder = ? AND generation = ?`).run(holder, generation);
  }

  async assertLease(holder: string, generation: number): Promise<void> {
    holder = text('lease holder', holder);
    const row = this.db.prepare(`SELECT holder, generation, expires_at > ${NOW} AS live FROM executor_lease WHERE id = 1`).get() as
      | { holder: string; generation: number; live: number }
      | undefined;
    if (!row) throw new LeaseLostError(holder, generation, 'no lease has been taken on this record');
    if (row.holder !== holder || row.generation !== generation) {
      throw new LeaseLostError(holder, generation, `the lease is now "${row.holder}" at generation ${row.generation}`);
    }
    if (!row.live) throw new LeaseLostError(holder, generation, 'the lease ran out');
    // SQLite has one writer: this transaction holds the write lock, so a takeover through this file waits for it by itself.
    if (this.inTx) this.fence = { holder, generation };
  }

  // ----- jobs -----

  async createJob(input: { repo: string; title: string; body?: string }): Promise<Job> {
    input = { repo: text('repo', input.repo), title: text('title', input.title), ...(input.body !== undefined && { body: text('body', input.body) }) };
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO jobs (id, repo, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.repo, input.title, input.body ?? '', 'queued', now, now);
    return this.requireJob(id);
  }

  async getJob(id: string): Promise<Job | undefined> {
    return this.readJob(id);
  }

  private readJob(id: string): Job | undefined {
    id = text('job id', id);
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  private requireJob(id: string): Job {
    const job = this.readJob(id);
    if (!job) throw new Error(`No such job: ${id}`);
    return job;
  }

  async listJobs(filter: { status?: JobStatus } = {}): Promise<Job[]> {
    if (filter.status) filter = { status: text('status', filter.status) };
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid').all(filter.status)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at, rowid').all();
    return (rows as JobRow[]).map(toJob);
  }

  async setJobStatus(id: string, status: JobStatus): Promise<Job> {
    id = text('job id', id); status = text('status', status);
    const res = this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    if (res.changes === 0) throw new Error(`No such job: ${id}`);
    return this.requireJob(id);
  }

  // ----- stages -----

  async startStage(jobId: string, name: string): Promise<Stage> {
    jobId = text('job id', jobId); name = text('stage name', name);
    this.requireJob(jobId);
    const generation = this.fence?.generation ?? 0;
    const now = new Date().toISOString();
    const live = this.db.prepare('SELECT * FROM claims WHERE job_id = ? AND stage = ? AND released_at IS NULL').get(jobId, name) as ClaimRow | undefined;
    if (live) {
      // A claim of this generation or a newer one is somebody's work in progress. An older one belongs to a kernel that lost its lease.
      if (live.generation >= generation) throw new StageClaimedError(jobId, name, live.attempt, live.generation);
      this.db.prepare("UPDATE claims SET released_at = ?, release_reason = 'lease-lost' WHERE job_id = ? AND stage = ? AND attempt = ?").run(now, jobId, name, live.attempt);
      this.db
        .prepare("UPDATE stages SET status = 'failed', ended_at = ?, output = ? WHERE job_id = ? AND name = ? AND attempt = ? AND status = 'running'")
        .run(now, JSON.stringify(LEASE_LOST_OUTPUT), jobId, name, live.attempt);
    }
    const prev = this.db
      .prepare('SELECT COUNT(*) AS n FROM stages WHERE job_id = ? AND name = ?')
      .get(jobId, name) as { n: number };
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO stages (id, job_id, name, status, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, jobId, name, 'running', prev.n + 1, now);
    this.db
      .prepare('INSERT INTO claims (job_id, stage, generation, attempt, claimed_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, name, generation, prev.n + 1, now);
    return this.requireStage(id);
  }

  async getStage(id: string): Promise<Stage | undefined> {
    return this.readStage(id);
  }

  private readStage(id: string): Stage | undefined {
    id = text('stage id', id);
    const row = this.db.prepare(`${STAGE_SELECT} WHERE s.id = ?`).get(id) as StageRow | undefined;
    return row && toStage(row);
  }

  private requireStage(id: string): Stage {
    const stage = this.readStage(id);
    if (!stage) throw new Error(`No such stage: ${id}`);
    return stage;
  }

  async listStages(jobId: string): Promise<Stage[]> {
    jobId = text('job id', jobId);
    const rows = this.db.prepare(`${STAGE_SELECT} WHERE s.job_id = ? ORDER BY s.started_at, s.rowid`).all(jobId);
    return (rows as StageRow[]).map(toStage);
  }

  async finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage> {
    id = text('stage id', id); status = text('status', status);
    const json = output === undefined ? null : storableJson(output);
    if (json === undefined) throw new Error(`Output of stage ${id} is not JSON`);
    const stage = this.requireStage(id);
    const claim = this.db.prepare('SELECT * FROM claims WHERE job_id = ? AND stage = ? AND attempt = ?').get(stage.jobId, stage.name, stage.attempt) as ClaimRow | undefined;
    const now = new Date().toISOString();
    if (claim) {
      // The attempt number is the fence: an attempt whose claim was taken over or already released cannot write its end.
      if (claim.released_at !== null) throw new StageNotClaimedError(id, `attempt ${stage.attempt} no longer holds the claim (released: ${claim.release_reason})`);
      this.db.prepare("UPDATE claims SET released_at = ?, release_reason = 'finished' WHERE job_id = ? AND stage = ? AND attempt = ?").run(now, stage.jobId, stage.name, stage.attempt);
    }
    this.db.prepare('UPDATE stages SET status = ?, ended_at = ?, output = ? WHERE id = ?').run(status, now, json, id);
    return this.requireStage(id);
  }

  // ----- plugin state -----

  async getState(plugin: string, key: string): Promise<unknown> {
    plugin = text('plugin name', plugin); key = text('state key', key);
    const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin = ? AND key = ?').get(plugin, key) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async setState(plugin: string, key: string, value: unknown): Promise<void> {
    plugin = text('plugin name', plugin); key = text('state key', key);
    const json = storableJson(value);
    if (json === undefined) throw new Error(`State value for "${key}" is not JSON`);
    this.db
      .prepare('INSERT INTO plugin_state (plugin, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value')
      .run(plugin, key, json);
  }

  // ----- events -----

  async appendEvent(e: { id?: string; type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent> {
    e = { ...e, type: text('event type', e.type), source: text('event source', e.source), ...(e.jobId !== undefined && { jobId: text('job id', e.jobId) }), ...(e.id !== undefined && { id: text('event id', e.id) }) };
    const id = e.id ?? randomUUID();
    const at = new Date().toISOString();
    const json = e.payload === undefined ? null : storableJson(e.payload);
    if (json === undefined) throw new Error(`Payload of event "${e.type}" is not JSON`);
    const res = this.db
      .prepare('INSERT INTO events (id, type, job_id, source, payload, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .run(id, e.type, e.jobId ?? null, e.source, json, at);
    if (res.changes === 0) throw new DuplicateEventError(id, toEvent(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow));
    return toEvent(this.db.prepare('SELECT * FROM events WHERE seq = ?').get(res.lastInsertRowid) as EventRow);
  }

  /** Events with seq greater than `afterSeq`, oldest first. */
  async eventsAfter(afterSeq = 0): Promise<BuligEvent[]> {
    eventSeq(afterSeq);
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(afterSeq);
    return (rows as EventRow[]).map(toEvent);
  }

  async eventsForJob(jobId: string): Promise<BuligEvent[]> {
    jobId = text('job id', jobId);
    const rows = this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq').all(jobId);
    return (rows as EventRow[]).map(toEvent);
  }
}

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';
import type { Store, StoreTx } from './store.ts';

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
];

interface JobRow { id: string; repo: string; title: string; body: string; status: JobStatus; created_at: string; updated_at: string }
interface StageRow {
  id: string; job_id: string; name: string; status: StageStatus; attempt: number;
  started_at: string; ended_at: string | null; output: string | null;
}
interface EventRow { seq: number; id: string; type: string; job_id: string | null; source: string; payload: string | null; at: string }

const toJob = (r: JobRow): Job => ({
  id: r.id, repo: r.repo, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toStage = (r: StageRow): Stage => ({
  id: r.id, jobId: r.job_id, name: r.name, status: r.status, attempt: r.attempt,
  startedAt: r.started_at, endedAt: r.ended_at, output: r.output === null ? null : JSON.parse(r.output),
});
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
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
      } catch {
        // The original error is the one to report.
      }
      throw err;
    }
  }

  // ----- jobs -----

  async createJob(input: { repo: string; title: string; body?: string }): Promise<Job> {
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
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  private requireJob(id: string): Job {
    const job = this.readJob(id);
    if (!job) throw new Error(`No such job: ${id}`);
    return job;
  }

  async listJobs(filter: { status?: JobStatus } = {}): Promise<Job[]> {
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid').all(filter.status)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at, rowid').all();
    return (rows as JobRow[]).map(toJob);
  }

  async setJobStatus(id: string, status: JobStatus): Promise<Job> {
    const res = this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    if (res.changes === 0) throw new Error(`No such job: ${id}`);
    return this.requireJob(id);
  }

  // ----- stages -----

  async startStage(jobId: string, name: string): Promise<Stage> {
    this.requireJob(jobId);
    const prev = this.db
      .prepare('SELECT COUNT(*) AS n FROM stages WHERE job_id = ? AND name = ?')
      .get(jobId, name) as { n: number };
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO stages (id, job_id, name, status, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, jobId, name, 'running', prev.n + 1, new Date().toISOString());
    return this.requireStage(id);
  }

  async getStage(id: string): Promise<Stage | undefined> {
    return this.readStage(id);
  }

  private readStage(id: string): Stage | undefined {
    const row = this.db.prepare('SELECT * FROM stages WHERE id = ?').get(id) as StageRow | undefined;
    return row && toStage(row);
  }

  private requireStage(id: string): Stage {
    const stage = this.readStage(id);
    if (!stage) throw new Error(`No such stage: ${id}`);
    return stage;
  }

  async listStages(jobId: string): Promise<Stage[]> {
    const rows = this.db.prepare('SELECT * FROM stages WHERE job_id = ? ORDER BY started_at, rowid').all(jobId);
    return (rows as StageRow[]).map(toStage);
  }

  async finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage> {
    const json = output === undefined ? null : JSON.stringify(output);
    if (json === undefined) throw new Error(`Output of stage ${id} is not JSON`);
    const res = this.db
      .prepare('UPDATE stages SET status = ?, ended_at = ?, output = ? WHERE id = ?')
      .run(status, new Date().toISOString(), json, id);
    if (res.changes === 0) throw new Error(`No such stage: ${id}`);
    return this.requireStage(id);
  }

  // ----- plugin state -----

  async getState(plugin: string, key: string): Promise<unknown> {
    const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin = ? AND key = ?').get(plugin, key) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async setState(plugin: string, key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`State value for "${key}" is not JSON`);
    this.db
      .prepare('INSERT INTO plugin_state (plugin, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value')
      .run(plugin, key, json);
  }

  // ----- events -----

  async appendEvent(e: { type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent> {
    const id = randomUUID();
    const at = new Date().toISOString();
    const json = e.payload === undefined ? null : JSON.stringify(e.payload);
    if (json === undefined) throw new Error(`Payload of event "${e.type}" is not JSON`);
    const res = this.db
      .prepare('INSERT INTO events (id, type, job_id, source, payload, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, e.type, e.jobId ?? null, e.source, json, at);
    return toEvent(this.db.prepare('SELECT * FROM events WHERE seq = ?').get(res.lastInsertRowid) as EventRow);
  }

  /** Events with seq greater than `afterSeq`, oldest first. */
  async eventsAfter(afterSeq = 0): Promise<BuligEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(afterSeq);
    return (rows as EventRow[]).map(toEvent);
  }

  async eventsForJob(jobId: string): Promise<BuligEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq').all(jobId);
    return (rows as EventRow[]).map(toEvent);
  }
}

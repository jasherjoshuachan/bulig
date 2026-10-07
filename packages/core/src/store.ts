import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';

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

/** The only writer to the database. One connection, synchronous, WAL mode. */
export class Store {
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

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.db.close();
  }

  // ----- jobs -----

  createJob(input: { repo: string; title: string; body?: string }): Job {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO jobs (id, repo, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.repo, input.title, input.body ?? '', 'queued', now, now);
    return this.requireJob(id);
  }

  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  private requireJob(id: string): Job {
    const job = this.getJob(id);
    if (!job) throw new Error(`No such job: ${id}`);
    return job;
  }

  listJobs(filter: { status?: JobStatus } = {}): Job[] {
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid').all(filter.status)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at, rowid').all();
    return (rows as JobRow[]).map(toJob);
  }

  setJobStatus(id: string, status: JobStatus): Job {
    const res = this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    if (res.changes === 0) throw new Error(`No such job: ${id}`);
    return this.requireJob(id);
  }

  // ----- stages -----

  startStage(jobId: string, name: string): Stage {
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

  getStage(id: string): Stage | undefined {
    const row = this.db.prepare('SELECT * FROM stages WHERE id = ?').get(id) as StageRow | undefined;
    return row && toStage(row);
  }

  private requireStage(id: string): Stage {
    const stage = this.getStage(id);
    if (!stage) throw new Error(`No such stage: ${id}`);
    return stage;
  }

  listStages(jobId: string): Stage[] {
    const rows = this.db.prepare('SELECT * FROM stages WHERE job_id = ? ORDER BY started_at, rowid').all(jobId);
    return (rows as StageRow[]).map(toStage);
  }

  finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Stage {
    const res = this.db
      .prepare('UPDATE stages SET status = ?, ended_at = ?, output = ? WHERE id = ?')
      .run(status, new Date().toISOString(), output === undefined ? null : JSON.stringify(output), id);
    if (res.changes === 0) throw new Error(`No such stage: ${id}`);
    return this.requireStage(id);
  }

  // ----- plugin state -----

  getState(plugin: string, key: string): unknown {
    const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin = ? AND key = ?').get(plugin, key) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  setState(plugin: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`State value for "${key}" is not JSON`);
    this.db
      .prepare('INSERT INTO plugin_state (plugin, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value')
      .run(plugin, key, json);
  }

  // ----- events -----

  appendEvent(e: { type: string; jobId?: string; source: string; payload: unknown }): BuligEvent {
    const id = randomUUID();
    const at = new Date().toISOString();
    const res = this.db
      .prepare('INSERT INTO events (id, type, job_id, source, payload, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, e.type, e.jobId ?? null, e.source, e.payload === undefined ? null : JSON.stringify(e.payload), at);
    return toEvent(this.db.prepare('SELECT * FROM events WHERE seq = ?').get(res.lastInsertRowid) as EventRow);
  }

  /** Events with seq greater than `afterSeq`, oldest first. */
  eventsAfter(afterSeq = 0): BuligEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(afterSeq);
    return (rows as EventRow[]).map(toEvent);
  }

  eventsForJob(jobId: string): BuligEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq').all(jobId);
    return (rows as EventRow[]).map(toEvent);
  }
}

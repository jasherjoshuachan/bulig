import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';
import { StoreFatalError, type Store, type StoreTx } from './store.ts';

// Each entry upgrades the schema by one version. Never edit an old entry once it has shipped; add a new one.
// They mirror the SQLite migrations one for one, so both adapters report the same schema version.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    ord BIGINT GENERATED ALWAYS AS IDENTITY,
    repo TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX jobs_order ON jobs (created_at, ord);
  CREATE INDEX jobs_status_order ON jobs (status, created_at, ord);
  CREATE TABLE stages (
    id TEXT PRIMARY KEY,
    ord BIGINT GENERATED ALWAYS AS IDENTITY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    output JSONB
  );
  CREATE INDEX stages_job ON stages (job_id, started_at, ord);
  CREATE TABLE events (
    seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    job_id TEXT,
    source TEXT NOT NULL,
    payload JSONB,
    at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX events_job ON events (job_id, seq);
  `,
  // 2: a job can carry a longer body, such as the issue text.
  `ALTER TABLE jobs ADD COLUMN body TEXT NOT NULL DEFAULT '';`,
  // 3: a small key-value store per plugin.
  `CREATE TABLE plugin_state (
    plugin TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (plugin, key)
  );`,
];

/** Held for the length of a migration run, so two processes opening a fresh database cannot both create the tables. */
const MIGRATION_LOCK = 0x42554c47; // "BULG"

interface JobRow { id: string; repo: string; title: string; body: string; status: JobStatus; created_at: Date; updated_at: Date }
interface StageRow {
  id: string; job_id: string; name: string; status: StageStatus; attempt: number;
  started_at: Date; ended_at: Date | null; output: unknown;
}
interface EventRow { seq: string; id: string; type: string; job_id: string | null; source: string; payload: unknown; at: Date }

// The driver parses JSONB for us, and gives an SQL NULL and a JSON null alike as null.
const toJob = (r: JobRow): Job => ({
  id: r.id, repo: r.repo, title: r.title, body: r.body, status: r.status,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});
const toStage = (r: StageRow): Stage => ({
  id: r.id, jobId: r.job_id, name: r.name, status: r.status, attempt: r.attempt,
  startedAt: r.started_at.toISOString(), endedAt: r.ended_at === null ? null : r.ended_at.toISOString(), output: r.output ?? null,
});
const toEvent = (r: EventRow): BuligEvent => ({
  id: r.id, seq: Number(r.seq), type: r.type, ...(r.job_id !== null && { jobId: r.job_id }),
  source: r.source, payload: r.payload ?? null, at: r.at.toISOString(),
});

const JOB_COLS = 'id, repo, title, body, status, created_at, updated_at';
const STAGE_COLS = 'id, job_id, name, status, attempt, started_at, ended_at, output';
const EVENT_COLS = 'seq, id, type, job_id, source, payload, at';

/**
 * JSONB cannot hold a NUL character (the escape \u0000 in JSON text), where SQLite's text column can. Left to the server it
 * would be an error in the middle of a transaction, and Postgres abandons the whole transaction on any error. Say so first.
 * An even number of backslashes before the escape means a literal backslash followed by text, which is fine.
 */
const NUL_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u0000/;
const jsonText = (value: unknown, what: string): string | undefined => {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (NUL_ESCAPE.test(json)) throw new Error(`${what} contains a NUL character, which Postgres cannot keep in JSONB`);
  return json;
};

/**
 * The Postgres adapter behind the Store port (ADR 0007).
 *
 * One dedicated connection (a pg.Client, not a pool) serves every call. The kernel queue runs one task at a time, and a
 * transaction has to stay on a single connection. The pg client queues queries in the order they were made, which is
 * what the port promises for calls made one after another.
 *
 * The connection opens, and the schema is brought up to date, on the first call (or in `PostgresStore.open`, which waits
 * for it). The constructor does not touch the network, so `createKernel`, which is not async, can take a store as it is.
 * The connection string is the caller's: it is never logged here, never read from a file, and never stored anywhere else.
 *
 * Differences from SQLite that callers can see:
 * - Postgres abandons a transaction when any statement in it fails. The calls here check the things they reject for
 *   (a missing job, a value with no JSON form) before they send anything, so those rejections leave the transaction usable,
 *   as they do in SQLite. A genuine database error does not: the transaction can only be rolled back. If a function
 *   carries on after one, `transaction` notices that the server undid it and rejects instead of reporting a commit.
 * - JSONB cannot hold a NUL character; see jsonText.
 * - There is no reconnect. If the connection drops, every later call rejects until the process starts again.
 */
export class PostgresStore implements Store {
  private client: pg.Client | undefined;
  private starting: Promise<pg.Client> | undefined;
  private ended: 'closed' | 'aborted' | undefined;
  /** The statement sent last. The next one waits for it: the driver's own queue is deprecated, and this keeps the order explicit. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly connectionString: string) {
    if (!connectionString) throw new Error('PostgresStore needs a connection string');
  }

  /** Open the connection and apply any migrations it has not seen, then hand the store back. */
  static async open<T extends PostgresStore>(this: new (connectionString: string) => T, connectionString: string): Promise<T> {
    const store = new this(connectionString);
    try {
      await store.connected();
    } catch (err) {
      await store.close().catch(() => {});
      throw err;
    }
    return store;
  }

  private connected(): Promise<pg.Client> {
    if (this.ended) return Promise.reject(new Error(`PostgresStore was ${this.ended}, so no call can follow`));
    this.starting ??= this.connect().catch((err: unknown) => {
      this.starting = undefined; // a later call may try again, with a new client
      throw err;
    });
    return this.starting;
  }

  private async connect(): Promise<pg.Client> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      application_name: 'bulig',
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    // A connection that drops while idle emits 'error'. Unhandled, that would end the process. The next call fails on its own.
    client.on('error', () => {});
    try {
      await client.connect();
      await migrate(client);
    } catch (err) {
      client.end().catch(() => {});
      throw err;
    }
    if (this.ended) {
      client.end().catch(() => {});
      throw new Error(`PostgresStore was ${this.ended} while it was connecting`);
    }
    this.client = client;
    return client;
  }

  private async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.send<R>(await this.connected(), text, params);
  }

  /** One statement at a time, in the order they were asked for. Calls made without waiting for each other still go out in order. */
  private send<R extends pg.QueryResultRow = pg.QueryResultRow>(client: pg.Client, text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    const go = () => (this.ended ? Promise.reject(new Error(`PostgresStore was ${this.ended}, so no call can follow`)) : client.query<R>(text, params));
    const run = this.tail.then(go, go);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  async schemaVersion(): Promise<number> {
    const res = await this.query<{ version: number }>('SELECT version FROM bulig_schema');
    return res.rows[0]?.version ?? 0;
  }

  /**
   * Drop the connection now, without asking the server. The kernel calls this once, when a call never came back.
   *
   * That is enough to stop later commits, for two reasons. This process sends nothing more on a destroyed socket, and every
   * later call rejects at once, so a task that wakes up after this cannot send its COMMIT. And an open transaction is not
   * a promise of anything on the server's side: when the connection goes away the server rolls the transaction back. A
   * query the server is still running may finish first; its result goes nowhere.
   *
   * What it cannot do is recall a COMMIT that was already on the wire. If the stuck call is the commit itself, whether it
   * landed is unknown, and the kernel's error says "may or may not have been kept". Callers waiting on the connection
   * see their query rejected ("Connection terminated unexpectedly").
   */
  abort(): void {
    if (this.ended) return;
    this.ended = 'aborted';
    const stream = (this.client as unknown as { connection?: { stream?: { destroy(): void } } } | undefined)?.connection?.stream;
    stream?.destroy();
  }

  async close(): Promise<void> {
    if (this.ended) return; // closed before, or aborted (the socket is already gone)
    this.ended = 'closed';
    const client = this.client ?? (await this.starting?.catch(() => undefined));
    await client?.end();
  }

  /**
   * BEGIN, run `fn`, COMMIT; ROLLBACK if `fn` fails. All on the one connection, so the calls `fn` makes are the transaction's.
   * That only stays true while nothing else uses this store until it ends, which the kernel's queue guarantees.
   *
   * A COMMIT that fails is treated like a ROLLBACK that fails: the answer may have been lost on the way, so nothing can be
   * said about what the record holds. That throws StoreFatalError and the kernel stops using the store.
   */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const client = await this.connected();
    await this.send(client, 'BEGIN');
    let result: T;
    try {
      result = await fn(this);
    } catch (err) {
      await this.rollback(client, err);
      throw err;
    }
    if (this.ended) throw new Error(`PostgresStore was ${this.ended} before the commit, so nothing was committed`);
    let committed: pg.QueryResult;
    try {
      committed = await this.send(client, 'COMMIT');
    } catch (commitErr) {
      await this.rollback(client, commitErr, 'COMMIT failed');
      throw new StoreFatalError(`COMMIT failed (${commitErr instanceof Error ? commitErr.message : String(commitErr)}), so what the record holds is unknown`, { cause: commitErr });
    }
    // COMMIT on a transaction the server had already abandoned does not fail: it answers ROLLBACK.
    if (committed.command === 'ROLLBACK') {
      throw new Error('The transaction was undone by the server because a statement in it failed earlier, and the function went on without letting that through');
    }
    return result;
  }

  private async rollback(client: pg.Client, original: unknown, during = 'the function'): Promise<void> {
    // After abort() or close() the connection is gone and the server has already undone the transaction.
    if (this.ended) return;
    try {
      await this.send(client, 'ROLLBACK');
    } catch (rollbackErr) {
      const why = original instanceof Error ? original.message : String(original);
      throw new StoreFatalError(`ROLLBACK failed after "${why}" (${during}), so a transaction may be left open`, { cause: rollbackErr });
    }
  }

  // ----- jobs -----

  async createJob(input: { repo: string; title: string; body?: string }): Promise<Job> {
    const now = new Date().toISOString();
    const res = await this.query<JobRow>(
      `INSERT INTO jobs (id, repo, title, body, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'queued', $5, $5) RETURNING ${JOB_COLS}`,
      [randomUUID(), input.repo, input.title, input.body ?? '', now],
    );
    return toJob(res.rows[0]!);
  }

  async getJob(id: string): Promise<Job | undefined> {
    const res = await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1`, [id]);
    return res.rows[0] && toJob(res.rows[0]);
  }

  async listJobs(filter: { status?: JobStatus } = {}): Promise<Job[]> {
    const res = filter.status
      ? await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE status = $1 ORDER BY created_at, ord`, [filter.status])
      : await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs ORDER BY created_at, ord`);
    return res.rows.map(toJob);
  }

  async setJobStatus(id: string, status: JobStatus): Promise<Job> {
    const res = await this.query<JobRow>(`UPDATE jobs SET status = $2, updated_at = $3 WHERE id = $1 RETURNING ${JOB_COLS}`, [id, status, new Date().toISOString()]);
    if (res.rows.length === 0) throw new Error(`No such job: ${id}`);
    return toJob(res.rows[0]!);
  }

  // ----- stages -----

  async startStage(jobId: string, name: string): Promise<Stage> {
    // One statement, so the job check, the attempt count and the insert cannot be split by another call, and a missing job
    // is an empty result rather than a foreign key error that would abandon the transaction.
    const res = await this.query<StageRow>(
      `INSERT INTO stages (id, job_id, name, status, attempt, started_at)
       SELECT $1::text, $2::text, $3::text, 'running', (SELECT COUNT(*) + 1 FROM stages WHERE job_id = $2::text AND name = $3::text), $4::timestamptz
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = $2::text)
       RETURNING ${STAGE_COLS}`,
      [randomUUID(), jobId, name, new Date().toISOString()],
    );
    if (res.rows.length === 0) throw new Error(`No such job: ${jobId}`);
    return toStage(res.rows[0]!);
  }

  async getStage(id: string): Promise<Stage | undefined> {
    const res = await this.query<StageRow>(`SELECT ${STAGE_COLS} FROM stages WHERE id = $1`, [id]);
    return res.rows[0] && toStage(res.rows[0]);
  }

  async listStages(jobId: string): Promise<Stage[]> {
    const res = await this.query<StageRow>(`SELECT ${STAGE_COLS} FROM stages WHERE job_id = $1 ORDER BY started_at, ord`, [jobId]);
    return res.rows.map(toStage);
  }

  async finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage> {
    const json = output === undefined ? null : jsonText(output, `Output of stage ${id}`);
    if (json === undefined) throw new Error(`Output of stage ${id} is not JSON`);
    const res = await this.query<StageRow>(
      `UPDATE stages SET status = $2, ended_at = $3, output = $4::jsonb WHERE id = $1 RETURNING ${STAGE_COLS}`,
      [id, status, new Date().toISOString(), json],
    );
    if (res.rows.length === 0) throw new Error(`No such stage: ${id}`);
    return toStage(res.rows[0]!);
  }

  // ----- plugin state -----

  async getState(plugin: string, key: string): Promise<unknown> {
    const res = await this.query<{ value: unknown }>('SELECT value FROM plugin_state WHERE plugin = $1 AND key = $2', [plugin, key]);
    return res.rows[0] === undefined ? undefined : res.rows[0].value;
  }

  async setState(plugin: string, key: string, value: unknown): Promise<void> {
    const json = jsonText(value, `State value for "${key}"`);
    if (json === undefined) throw new Error(`State value for "${key}" is not JSON`);
    await this.query(
      'INSERT INTO plugin_state (plugin, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value',
      [plugin, key, json],
    );
  }

  // ----- events -----

  async appendEvent(e: { type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent> {
    const json = e.payload === undefined ? null : jsonText(e.payload, `Payload of event "${e.type}"`);
    if (json === undefined) throw new Error(`Payload of event "${e.type}" is not JSON`);
    const res = await this.query<EventRow>(
      `INSERT INTO events (id, type, job_id, source, payload, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${EVENT_COLS}`,
      [randomUUID(), e.type, e.jobId ?? null, e.source, json, new Date().toISOString()],
    );
    return toEvent(res.rows[0]!);
  }

  async eventsAfter(afterSeq = 0): Promise<BuligEvent[]> {
    const res = await this.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE seq > $1 ORDER BY seq`, [afterSeq]);
    return res.rows.map(toEvent);
  }

  async eventsForJob(jobId: string): Promise<BuligEvent[]> {
    const res = await this.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE job_id = $1 ORDER BY seq`, [jobId]);
    return res.rows.map(toEvent);
  }
}

/**
 * Bring the schema up to date in one transaction: all pending migrations apply, or none do. The advisory lock makes a second
 * process that opens the same database at the same moment wait, then find nothing left to do. The version lives in
 * `bulig_schema`, one row; Postgres has no user_version.
 */
async function migrate(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS bulig_schema (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), version INTEGER NOT NULL)');
    const current = (await client.query<{ version: number }>('SELECT version FROM bulig_schema')).rows[0]?.version ?? 0;
    if (current > MIGRATIONS.length) {
      throw new Error(`This database is at schema version ${current}, but this Bulig only knows ${MIGRATIONS.length}. Upgrade Bulig before opening it.`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) await client.query(MIGRATIONS[v]!);
    if (current < MIGRATIONS.length) {
      await client.query('INSERT INTO bulig_schema (id, version) VALUES (TRUE, $1) ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version', [MIGRATIONS.length]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

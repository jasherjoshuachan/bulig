import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
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
  // 4: the executor lease (ADR 0010). One row. The unique index on (id, generation) makes generation a "key" column to
  // Postgres: a transaction that reads the row with FOR KEY SHARE (assertLease) then blocks a takeover, which changes the
  // generation, but not a renewal, which changes only expires_at. That is how a takeover waits for the old holder's open
  // transactions while the old holder's heartbeat is never made to wait.
  `CREATE TABLE executor_lease (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    holder TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX executor_lease_key ON executor_lease (id, generation);`,
  // 5: one claim per stage of a job (ADR 0010). A claim that is not released is live, and only one may be live.
  `CREATE TABLE claims (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    stage TEXT NOT NULL,
    generation INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    PRIMARY KEY (job_id, stage, attempt)
  );
  CREATE UNIQUE INDEX claims_live ON claims (job_id, stage) WHERE released_at IS NULL;`,
  // 6: an event id is a key. An id written twice is refused. The kernel does not pass fixed ids yet (bus.record makes a fresh one), so this index is a guard for later; handler idempotency today comes from the stageId guards.
  `CREATE UNIQUE INDEX events_id ON events (id);`,
];

/** Held for the length of a migration run, so two processes opening a fresh database cannot both create the tables. */
const MIGRATION_LOCK = 0x42554c47; // "BULG"

interface ClaimRow { job_id: string; stage: string; generation: number; attempt: number; claimed_at: Date; released_at: Date | null; release_reason: string | null }
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
 * The session-level advisory lock a writer holds on its one connection for as long as it is open. Advisory locks belong to
 * one database, so this is "one kernel writing to this database". The key is 64 bits taken from a fixed string. The
 * migration lock above is a different, smaller key. A lock taken on a session is released by the server when the
 * connection closes, however it closes.
 */
const WRITER_LOCK = BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update('bulig.kernel.writer').digest('hex').slice(0, 16)}`)).toString();

/** Another kernel already holds the writer lock on this database. */
export class OtherWriterError extends Error {
  constructor() {
    super('Another Bulig kernel is already writing to this database (it holds the writer lock). Only one kernel may write to a record. Stop the other one, or point this one at a different database.');
    this.name = 'OtherWriterError';
  }
}

/**
 * Check a connection string without ever repeating it. It must start with postgres:// or postgresql://, and the driver
 * must end up with a host (a name, an address, or a socket folder). A string with no scheme is read by the driver as a
 * mess of pieces whose errors can quote part of it, including a password. A string with no host makes the driver dial
 * localhost on the default port, which is whatever Postgres happens to run there, so it is refused rather than guessed.
 *
 * The host is taken from the driver's own parser (pg-connection-string, the one pg uses), not worked out here: which
 * `host=` wins, how an empty one falls back to the URL's host, and how a socket path is read are its rules, and two
 * earlier home-made checks got them wrong. If the parser cannot read the string at all, this lets it through: the
 * driver then refuses it before any connection, and the store reports only that it could not be read.
 */
export function assertPostgresUrl(url: string): void {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new Error(CONNECTION_STRING_HELP);
  let host: string | null | undefined;
  try {
    host = parseConnectionString(url).host;
  } catch {
    return;
  }
  if (!host) throw new Error(CONNECTION_STRING_HELP);
}
const CONNECTION_STRING_HELP = 'The Postgres connection string must start with postgres:// or postgresql:// and name a host (for example postgresql://user@host/database)';

/** A reader found no usable schema, and a reader never creates or upgrades one: the kernel (the writer) does. */
export class SchemaNotReadyError extends Error {
  constructor(public readonly reason: 'empty' | 'old', message: string) {
    super(message);
    this.name = 'SchemaNotReadyError';
  }
}

export interface PostgresStoreOptions {
  /**
   * `writer` (the default) is the kernel's store: it takes the writer lock when it connects and keeps it until it closes, and
   * opening fails with OtherWriterError if another writer holds it. `reader` never takes or waits for the lock; it is for
   * short, read-only looks from outside the kernel, such as `bulig status`. A reader never migrates: a database with no
   * schema, or an older one than this code, is refused with SchemaNotReadyError, because upgrading under a running older
   * kernel is the writer's decision. A reader is not forced to be read-only.
   */
  mode?: 'writer' | 'reader';
}

/**
 * The Postgres adapter behind the Store port (ADR 0007).
 *
 * One dedicated connection (a pg.Client, not a pool) serves every call. The kernel queue runs one task at a time, and a
 * transaction has to stay on a single connection. The pg client queues queries in the order they were made, which is
 * what the port promises for calls made one after another.
 * The executor lease (ADR 0010) is the one exception: it has a second connection of its own (see `leaseClient`), so a heartbeat is
 * never queued behind a slow transaction.
 *
 * The connection opens on the first call (or in `PostgresStore.open`, which waits for it). A writer also brings the schema up
 * to date then; a reader never creates or upgrades it and refuses a missing or older schema (SchemaNotReadyError). The
 * constructor does not touch the network, so `createKernel`, which is not async, can take a store as it is.
 * The connection string is the caller's: it is never logged here, never read from a file, and never stored anywhere else.
 *
 * Differences from SQLite that callers can see:
 * - Postgres abandons a transaction when any statement in it fails. The calls here check the things they reject for
 *   (a missing job, a value with no JSON form) before they send anything, so those rejections leave the transaction usable,
 *   as they do in SQLite. A genuine database error does not: the transaction can only be rolled back. If a function
 *   carries on after one, `transaction` notices that the server undid it and rejects instead of reporting a commit.
 * - JSONB does not keep the order of an object's keys, and cannot hold NUL or a lone surrogate in a string. See store-text.ts:
 *   both engines turn those two into U+FFFD in JSON, and refuse NUL in plain text columns. No caller depends on key order.
 * - Only one writer per database: see PostgresStoreOptions.mode. SQLite has the file lock the CLI takes instead.
 * - There is no reconnect. If the connection drops, every later call rejects until the process starts again.
 */
export class PostgresStore implements Store {
  private client: pg.Client | undefined;
  private starting: Promise<pg.Client> | undefined;
  private ended: 'closed' | 'aborted' | undefined;
  /** The statement sent last. The next one waits for it: the driver's own queue is deprecated, and this keeps the order explicit. */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly writer: boolean;

  /**
   * A second connection, used only for the executor lease (ADR 0010): acquire, renew and release. It takes no advisory lock and runs
   * no migration. The main connection is busy for as long as a transaction is open, and a heartbeat that waited behind a slow
   * task would let a healthy kernel lose its lease. It opens on first use, after the main connection has the schema ready.
   */
  private leaseClient: pg.Client | undefined;
  private leaseStarting: Promise<pg.Client> | undefined;
  /** Set while a transaction is open: the generation its writes are fenced with. Undefined means unfenced, generation 0. */
  private fence: { holder: string; generation: number } | undefined;
  private inTx = false;

  constructor(private readonly connectionString: string, options: PostgresStoreOptions = {}) {
    if (!connectionString) throw new Error('PostgresStore needs a connection string');
    assertPostgresUrl(connectionString);
    this.writer = (options.mode ?? 'writer') === 'writer';
  }

  /** Open the connection and apply any migrations it has not seen, then hand the store back. */
  static async open<T extends PostgresStore>(this: new (connectionString: string, options?: PostgresStoreOptions) => T, connectionString: string, options?: PostgresStoreOptions): Promise<T> {
    const store = new this(connectionString, options);
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
    let client: pg.Client;
    try {
      client = new pg.Client({
        connectionString: this.connectionString,
        application_name: 'bulig',
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
      });
    } catch {
      // The parser's own message can quote the string. Say only that it could not be read.
      throw new Error('The Postgres connection string could not be read');
    }
    // A connection that drops while idle emits 'error'. Unhandled, that would end the process. The next call fails on its own.
    client.on('error', () => {});
    try {
      await client.connect();
      if (this.writer) {
        const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [WRITER_LOCK]);
        if (!got.rows[0]?.ok) throw new OtherWriterError();
        await migrate(client);
      } else {
        await checkSchema(client);
      }
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
    for (const c of [this.client, this.leaseClient]) {
      const stream = (c as unknown as { connection?: { stream?: { destroy(): void } } } | undefined)?.connection?.stream;
      stream?.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.ended) return; // closed before, or aborted (the socket is already gone)
    this.ended = 'closed';
    const client = this.client ?? (await this.starting?.catch(() => undefined));
    // Give the writer lock back before hanging up, so a kernel that starts straight afterwards is not refused while the
    // server is still tidying up the old session.
    if (this.writer) await client?.query('SELECT pg_advisory_unlock($1::bigint)', [WRITER_LOCK]).catch(() => {});
    const lease = this.leaseClient ?? (await this.leaseStarting?.catch(() => undefined));
    await lease?.end().catch(() => {});
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
    this.inTx = true;
    this.fence = undefined;
    let result: T;
    try {
      result = await fn(this);
    } catch (err) {
      this.inTx = false;
      this.fence = undefined;
      await this.rollback(client, err);
      throw err;
    }
    this.inTx = false;
    this.fence = undefined;
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

  // ----- executor lease (ADR 0010) -----

  /** The lease connection, opened the first time it is needed. Only after the main connection has made sure the schema is there. */
  private leased(): Promise<pg.Client> {
    if (this.ended) return Promise.reject(new Error(`PostgresStore was ${this.ended}, so no call can follow`));
    this.leaseStarting ??= (async () => {
      await this.connected();
      const client = new pg.Client({ connectionString: this.connectionString, application_name: 'bulig-lease', connectionTimeoutMillis: 10_000, keepAlive: true });
      client.on('error', () => {});
      try {
        await client.connect();
      } catch (err) {
        client.end().catch(() => {});
        throw err;
      }
      if (this.ended) {
        client.end().catch(() => {});
        throw new Error(`PostgresStore was ${this.ended} while it was connecting`);
      }
      this.leaseClient = client;
      return client;
    })().catch((err: unknown) => {
      this.leaseStarting = undefined;
      throw err;
    });
    return this.leaseStarting;
  }

  async acquireLease(holder: string, ttlMs: number): Promise<{ generation: number }> {
    holder = text('lease holder', holder);
    ttl(ttlMs);
    const client = await this.leased();
    // Look first, without a lock: a live lease of someone else is refused without touching the row. The upsert below would
    // lock it even when its condition fails, and so wait behind a transaction that is only reading the lease.
    const seen = await client.query<{ holder: string; expires_at: Date; live: boolean }>('SELECT holder, expires_at, expires_at > clock_timestamp() AS live FROM executor_lease WHERE id');
    const now = seen.rows[0];
    if (now && now.live && now.holder !== holder) throw new LeaseHeldError(now.holder, now.expires_at);
    // A takeover changes the generation, so it waits for every transaction the old holder has open (they hold FOR KEY SHARE).
    // The wait is bounded, so a kernel that cannot get in says so instead of hanging.
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      const res = await client.query<{ generation: number }>(
        `INSERT INTO executor_lease (id, holder, generation, expires_at) VALUES (TRUE, $1, 1, clock_timestamp() + $2::double precision * interval '1 millisecond')
         ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, generation = executor_lease.generation + 1, expires_at = EXCLUDED.expires_at
         WHERE executor_lease.holder = EXCLUDED.holder OR executor_lease.expires_at <= clock_timestamp()
         RETURNING generation`,
        [holder, ttlMs],
      );
      if (res.rows.length === 0) {
        const held = (await client.query<{ holder: string; expires_at: Date }>('SELECT holder, expires_at FROM executor_lease WHERE id')).rows[0]!;
        await client.query('ROLLBACK');
        throw new LeaseHeldError(held.holder, held.expires_at);
      }
      await client.query('COMMIT');
      return { generation: res.rows[0]!.generation };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async renewLease(holder: string, generation: number, ttlMs: number): Promise<boolean> {
    holder = text('lease holder', holder);
    ttl(ttlMs);
    const client = await this.leased();
    // Only expires_at changes, so this never waits for a transaction that has asserted the lease.
    const res = await client.query(
      `UPDATE executor_lease SET expires_at = clock_timestamp() + $3::double precision * interval '1 millisecond'
       WHERE id AND holder = $1 AND generation = $2 AND expires_at > clock_timestamp()`,
      [holder, generation, ttlMs],
    );
    return res.rowCount === 1;
  }

  async releaseLease(holder: string, generation: number): Promise<void> {
    holder = text('lease holder', holder);
    const client = await this.leased();
    await client.query('UPDATE executor_lease SET expires_at = to_timestamp(0) WHERE id AND holder = $1 AND generation = $2', [holder, generation]);
  }

  async assertLease(holder: string, generation: number): Promise<void> {
    holder = text('lease holder', holder);
    // FOR KEY SHARE: a takeover (new generation) now waits until this transaction ends, and a renewal does not. See migration 4.
    const res = await this.query<{ holder: string; generation: number; live: boolean }>(
      'SELECT holder, generation, expires_at > clock_timestamp() AS live FROM executor_lease WHERE id FOR KEY SHARE',
    );
    const row = res.rows[0];
    if (!row) throw new LeaseLostError(holder, generation, 'no lease has been taken on this record');
    if (row.holder !== holder || row.generation !== generation) {
      throw new LeaseLostError(holder, generation, `the lease is now "${row.holder}" at generation ${row.generation}`);
    }
    if (!row.live) throw new LeaseLostError(holder, generation, 'the lease ran out');
    if (this.inTx) this.fence = { holder, generation };
  }

  // ----- jobs -----

  async createJob(input: { repo: string; title: string; body?: string }): Promise<Job> {
    input = { repo: text('repo', input.repo), title: text('title', input.title), ...(input.body !== undefined && { body: text('body', input.body) }) };
    const now = new Date().toISOString();
    const res = await this.query<JobRow>(
      `INSERT INTO jobs (id, repo, title, body, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'queued', $5, $5) RETURNING ${JOB_COLS}`,
      [randomUUID(), input.repo, input.title, input.body ?? '', now],
    );
    return toJob(res.rows[0]!);
  }

  async getJob(id: string): Promise<Job | undefined> {
    id = text('job id', id);
    const res = await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1`, [id]);
    return res.rows[0] && toJob(res.rows[0]);
  }

  async listJobs(filter: { status?: JobStatus } = {}): Promise<Job[]> {
    if (filter.status) filter = { status: text('status', filter.status) };
    const res = filter.status
      ? await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE status = $1 ORDER BY created_at, ord`, [filter.status])
      : await this.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs ORDER BY created_at, ord`);
    return res.rows.map(toJob);
  }

  async setJobStatus(id: string, status: JobStatus): Promise<Job> {
    id = text('job id', id); status = text('status', status);
    const res = await this.query<JobRow>(`UPDATE jobs SET status = $2, updated_at = $3 WHERE id = $1 RETURNING ${JOB_COLS}`, [id, status, new Date().toISOString()]);
    if (res.rows.length === 0) throw new Error(`No such job: ${id}`);
    return toJob(res.rows[0]!);
  }

  // ----- stages -----

  async startStage(jobId: string, name: string): Promise<Stage> {
    jobId = text('job id', jobId); name = text('stage name', name);
    const generation = this.fence?.generation ?? 0;
    const job = await this.query('SELECT 1 FROM jobs WHERE id = $1', [jobId]);
    if (job.rows.length === 0) throw new Error(`No such job: ${jobId}`);
    const now = new Date().toISOString();
    // SKIP LOCKED: a claim row another transaction is changing right now is not waited for. It is not ours to take over; the
    // insert below then meets the partial unique index and is refused if that claim turns out to be live.
    const live = (
      await this.query<ClaimRow>('SELECT * FROM claims WHERE job_id = $1 AND stage = $2 AND released_at IS NULL FOR UPDATE SKIP LOCKED', [jobId, name])
    ).rows[0];
    if (live) {
      // A claim of this generation or a newer one is somebody's work in progress. An older one belongs to a kernel that lost its lease.
      if (live.generation >= generation) throw new StageClaimedError(jobId, name, live.attempt, live.generation);
      await this.query("UPDATE claims SET released_at = $4, release_reason = 'lease-lost' WHERE job_id = $1 AND stage = $2 AND attempt = $3", [jobId, name, live.attempt, now]);
      await this.query("UPDATE stages SET status = 'failed', ended_at = $4, output = $5::jsonb WHERE job_id = $1 AND name = $2 AND attempt = $3 AND status = 'running'", [
        jobId,
        name,
        live.attempt,
        now,
        JSON.stringify(LEASE_LOST_OUTPUT),
      ]);
    }
    const res = await this.query<StageRow>(
      `INSERT INTO stages (id, job_id, name, status, attempt, started_at)
       SELECT $1::text, $2::text, $3::text, 'running', (SELECT COUNT(*) + 1 FROM stages WHERE job_id = $2::text AND name = $3::text), $4::timestamptz
       RETURNING ${STAGE_COLS}`,
      [randomUUID(), jobId, name, now],
    );
    const stage = toStage(res.rows[0]!);
    try {
      await this.query('INSERT INTO claims (job_id, stage, generation, attempt, claimed_at) VALUES ($1, $2, $3, $4, $5)', [jobId, name, generation, stage.attempt, now]);
    } catch (err) {
      // Lost a race with another writer: its claim is live. The server has abandoned this transaction, which the caller's rollback finishes.
      if ((err as { code?: string }).code === '23505') throw new StageClaimedError(jobId, name, stage.attempt, generation);
      throw err;
    }
    return stage;
  }

  async getStage(id: string): Promise<Stage | undefined> {
    id = text('stage id', id);
    const res = await this.query<StageRow>(`SELECT ${STAGE_COLS} FROM stages WHERE id = $1`, [id]);
    return res.rows[0] && toStage(res.rows[0]);
  }

  async listStages(jobId: string): Promise<Stage[]> {
    jobId = text('job id', jobId);
    const res = await this.query<StageRow>(`SELECT ${STAGE_COLS} FROM stages WHERE job_id = $1 ORDER BY started_at, ord`, [jobId]);
    return res.rows.map(toStage);
  }

  async finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage> {
    id = text('stage id', id); status = text('status', status);
    const json = output === undefined ? null : storableJson(output);
    if (json === undefined) throw new Error(`Output of stage ${id} is not JSON`);
    const found = await this.query<StageRow>(`SELECT ${STAGE_COLS} FROM stages WHERE id = $1`, [id]);
    if (found.rows.length === 0) throw new Error(`No such stage: ${id}`);
    const stage = toStage(found.rows[0]!);
    const now = new Date().toISOString();
    // FOR UPDATE: waits if another transaction is taking this claim over, then sees the result.
    const claim = (await this.query<ClaimRow>('SELECT * FROM claims WHERE job_id = $1 AND stage = $2 AND attempt = $3 FOR UPDATE', [stage.jobId, stage.name, stage.attempt])).rows[0];
    if (claim) {
      // The attempt number is the fence: an attempt whose claim was taken over or already released cannot write its end.
      if (claim.released_at !== null) throw new StageNotClaimedError(id, `attempt ${stage.attempt} no longer holds the claim (released: ${claim.release_reason})`);
      await this.query("UPDATE claims SET released_at = $4, release_reason = 'finished' WHERE job_id = $1 AND stage = $2 AND attempt = $3", [stage.jobId, stage.name, stage.attempt, now]);
    }
    const res = await this.query<StageRow>(`UPDATE stages SET status = $2, ended_at = $3, output = $4::jsonb WHERE id = $1 RETURNING ${STAGE_COLS}`, [id, status, now, json]);
    return toStage(res.rows[0]!);
  }

  // ----- plugin state -----

  async getState(plugin: string, key: string): Promise<unknown> {
    plugin = text('plugin name', plugin); key = text('state key', key);
    const res = await this.query<{ value: unknown }>('SELECT value FROM plugin_state WHERE plugin = $1 AND key = $2', [plugin, key]);
    return res.rows[0] === undefined ? undefined : res.rows[0].value;
  }

  async setState(plugin: string, key: string, value: unknown): Promise<void> {
    plugin = text('plugin name', plugin); key = text('state key', key);
    const json = storableJson(value);
    if (json === undefined) throw new Error(`State value for "${key}" is not JSON`);
    await this.query(
      'INSERT INTO plugin_state (plugin, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value',
      [plugin, key, json],
    );
  }

  // ----- events -----

  async appendEvent(e: { id?: string; type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent> {
    e = { ...e, type: text('event type', e.type), source: text('event source', e.source), ...(e.jobId !== undefined && { jobId: text('job id', e.jobId) }), ...(e.id !== undefined && { id: text('event id', e.id) }) };
    const json = e.payload === undefined ? null : storableJson(e.payload);
    if (json === undefined) throw new Error(`Payload of event "${e.type}" is not JSON`);
    const id = e.id ?? randomUUID();
    // ON CONFLICT DO NOTHING, not an error: a unique violation would abandon the whole transaction.
    const res = await this.query<EventRow>(
      `INSERT INTO events (id, type, job_id, source, payload, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING RETURNING ${EVENT_COLS}`,
      [id, e.type, e.jobId ?? null, e.source, json, new Date().toISOString()],
    );
    if (res.rows.length === 0) {
      const held = await this.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [id]);
      throw new DuplicateEventError(id, held.rows[0] && toEvent(held.rows[0]));
    }
    return toEvent(res.rows[0]!);
  }

  async eventsAfter(afterSeq = 0): Promise<BuligEvent[]> {
    eventSeq(afterSeq);
    const res = await this.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE seq > $1 ORDER BY seq`, [afterSeq]);
    return res.rows.map(toEvent);
  }

  async eventsForJob(jobId: string): Promise<BuligEvent[]> {
    jobId = text('job id', jobId);
    const res = await this.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE job_id = $1 ORDER BY seq`, [jobId]);
    return res.rows.map(toEvent);
  }
}

/** A lease that lasts a positive whole number of milliseconds. */
function ttl(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('A lease lasts a positive whole number of milliseconds');
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

/** What a reader does instead of migrating: look, and refuse unless the schema is there and is the one this code knows. */
async function checkSchema(client: pg.Client): Promise<void> {
  const has = (await client.query<{ has: boolean }>("SELECT to_regclass('bulig_schema') IS NOT NULL AS has")).rows[0]?.has;
  if (!has) throw new SchemaNotReadyError('empty', 'The database has no Bulig schema yet. Run a job first (the kernel creates it).');
  const current = (await client.query<{ version: number }>('SELECT version FROM bulig_schema')).rows[0]?.version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`This database is at schema version ${current}, but this Bulig only knows ${MIGRATIONS.length}. Upgrade Bulig before opening it.`);
  }
  if (current < MIGRATIONS.length) {
    throw new SchemaNotReadyError('old', `This database is at schema version ${current} and this Bulig needs ${MIGRATIONS.length}. Start the kernel (serve, or run) so it upgrades the database first. A read-only command does not.`);
  }
}

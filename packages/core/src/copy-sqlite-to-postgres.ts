import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { assertPostgresUrl, PostgresStore } from './postgres-store.ts';

/**
 * A one-off copy of a SQLite record into an empty Postgres record (ADR 0011).
 *
 * The SQLite file is opened read-only and read inside one read transaction, so the copy and the checks afterwards see one
 * snapshot even if something else writes to the file meanwhile. Postgres gets everything in one transaction: all of it or none.
 * Then each table is counted and checksummed on both sides, and the two must agree.
 *
 * The lease is copied but released: its holder and generation stay, and it is already expired. The kernel that starts on
 * the Postgres record then takes generation max + 1, so its work is fenced above every claim in the copy.
 */

/** The only schema version this tool reads and writes. A change to the schema needs a change here, on purpose. */
export const COPY_SCHEMA_VERSION = 6;

/** The copy cannot go ahead, and says why in a sentence. Nothing was written to the target. */
export class CopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyRefusedError';
  }
}

export const COPY_TABLES = ['jobs', 'stages', 'claims', 'events', 'plugin_state', 'executor_lease'] as const;
export type CopyTable = (typeof COPY_TABLES)[number];

export interface TableComparison {
  table: CopyTable;
  sqliteRows: number;
  postgresRows: number;
  sqliteChecksum: string;
  postgresChecksum: string;
  match: boolean;
}

export interface CopyReport {
  dryRun: boolean;
  /** True when every table agrees. A real copy that does not agree is committed all the same: see `committed`. */
  ok: boolean;
  /** Was the copy kept in Postgres? Never true for a dry run. */
  committed: boolean;
  tables: TableComparison[];
  /** The generation the lease was copied at. The next kernel takes this plus one. Undefined if the source had no lease. */
  leaseGeneration?: number;
  warnings: string[];
}

export interface CopyOptions {
  /** The SQLite file to read. It is opened read-only. */
  from: string;
  /** The Postgres connection string. Never printed. */
  postgresUrl: string;
  /** Do everything, compare, then roll back. */
  dryRun?: boolean;
  /** Test seam: runs inside the copy's transaction after the rows are written and before they are compared. Lets a test damage the copy and see it caught. */
  beforeCompare?: (client: pg.Client) => Promise<void>;
}

// ----- canonical rows: the same shape from both sides, so one hash can say whether they agree -----

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Canon = Record<string, Json>;

/** JSON with object keys sorted, so key order (which JSONB does not keep) does not matter. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** A time as an instant, in one spelling. Postgres keeps an instant, not the text it was given. */
function instant(what: string, v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new CopyRefusedError(`${what} is not a time Postgres can read: ${JSON.stringify(v)}`);
  return d.toISOString();
}
const instantOrNull = (what: string, v: unknown): string | null => (v === null || v === undefined ? null : instant(what, v));

/** A JSON column. SQL NULL and the JSON value null are different things in the record, so they stay different. */
function jsonCell(v: string | null): Json {
  return v === null ? null : { json: JSON.parse(v) as Json };
}

const byKey = (keys: string[]) => (a: Canon, b: Canon) => {
  for (const k of keys) {
    const x = a[k]!;
    const y = b[k]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

const PRIMARY_KEY: Record<CopyTable, string[]> = {
  jobs: ['id'],
  stages: ['id'],
  claims: ['job_id', 'stage', 'attempt'],
  events: ['seq'],
  plugin_state: ['plugin', 'key'],
  executor_lease: ['id'],
};

interface Snapshot {
  jobs: Canon[];
  stages: Canon[];
  claims: Canon[];
  events: Canon[];
  plugin_state: Canon[];
  executor_lease: Canon[];
}

interface Digest {
  rows: number;
  checksum: string;
}

/** sha256 over the table's rows, one canonical line each, in primary key order. */
function digest(table: CopyTable, rows: Canon[]): Digest {
  const sorted = [...rows].sort(byKey(PRIMARY_KEY[table]));
  const h = createHash('sha256');
  for (const r of sorted) h.update(`${canonicalJson(r)}\n`);
  return { rows: rows.length, checksum: h.digest('hex') };
}

// ----- the SQLite side -----

type Row = Record<string, unknown>;

/**
 * What the target should hold, read from the file. Order-bearing columns: `rank` is the row's place in the order the store lists
 * it (SQLite's rowid), and the Postgres side reads the same thing from its `ord`, so a copy that scrambled the order would not match.
 * JSON columns are read as text (CAST), because a column declared JSON has numeric affinity and would hand a bare 5 back as a number.
 */
function readSqlite(db: Database.Database): Snapshot {
  const all = (sql: string) => db.prepare(sql).all() as Row[];
  const jobs = all('SELECT id, repo, title, body, status, created_at, updated_at, ROW_NUMBER() OVER (ORDER BY rowid) AS rank FROM jobs').map((r) => ({
    id: r.id as string, repo: r.repo as string, title: r.title as string, body: r.body as string, status: r.status as string,
    created_at: instant(`jobs.created_at of job ${String(r.id)}`, r.created_at),
    updated_at: instant(`jobs.updated_at of job ${String(r.id)}`, r.updated_at),
    rank: r.rank as number,
  }));
  const stages = all('SELECT id, job_id, name, status, attempt, started_at, ended_at, CAST(output AS TEXT) AS output, ROW_NUMBER() OVER (ORDER BY rowid) AS rank FROM stages').map((r) => ({
    id: r.id as string, job_id: r.job_id as string, name: r.name as string, status: r.status as string, attempt: r.attempt as number,
    started_at: instant(`stages.started_at of stage ${String(r.id)}`, r.started_at),
    ended_at: instantOrNull(`stages.ended_at of stage ${String(r.id)}`, r.ended_at),
    output: jsonCell(r.output as string | null),
    rank: r.rank as number,
  }));
  const claims = all('SELECT job_id, stage, generation, attempt, claimed_at, released_at, release_reason FROM claims').map((r) => ({
    job_id: r.job_id as string, stage: r.stage as string, generation: r.generation as number, attempt: r.attempt as number,
    claimed_at: instant(`claims.claimed_at of ${String(r.job_id)}/${String(r.stage)}`, r.claimed_at),
    released_at: instantOrNull(`claims.released_at of ${String(r.job_id)}/${String(r.stage)}`, r.released_at),
    release_reason: r.release_reason as string | null,
  }));
  const events = all('SELECT seq, id, type, job_id, source, CAST(payload AS TEXT) AS payload, at FROM events').map((r) => ({
    seq: r.seq as number, id: r.id as string, type: r.type as string, job_id: r.job_id as string | null, source: r.source as string,
    payload: jsonCell(r.payload as string | null),
    at: instant(`events.at of event ${String(r.id)}`, r.at),
  }));
  const plugin_state = all('SELECT plugin, key, CAST(value AS TEXT) AS value FROM plugin_state').map((r) => ({
    plugin: r.plugin as string, key: r.key as string, value: jsonCell(r.value as string),
  }));
  // Copied released: the holder and the generation stay, the lease is already over (time 0, as releaseLease writes it).
  const executor_lease = all('SELECT holder, generation FROM executor_lease').map((r) => ({
    id: 1, holder: r.holder as string, generation: r.generation as number, expires_at_ms: 0,
  }));
  return { jobs, stages, claims, events, plugin_state, executor_lease };
}

// ----- the Postgres side -----

/** The same canonical rows, read back from Postgres. */
async function readPostgres(c: pg.Client): Promise<Snapshot> {
  const all = async (sql: string) => (await c.query(sql)).rows as Row[];
  const iso = (v: unknown) => (v === null ? null : (v as Date).toISOString());
  const json = (v: unknown): Json => (v === null ? null : { json: JSON.parse(v as string) as Json });
  const jobs = (await all('SELECT id, repo, title, body, status, created_at, updated_at, ROW_NUMBER() OVER (ORDER BY ord) AS rank FROM jobs')).map((r) => ({
    id: r.id as string, repo: r.repo as string, title: r.title as string, body: r.body as string, status: r.status as string,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), rank: Number(r.rank),
  }));
  const stages = (await all('SELECT id, job_id, name, status, attempt, started_at, ended_at, output::text AS output, ROW_NUMBER() OVER (ORDER BY ord) AS rank FROM stages')).map((r) => ({
    id: r.id as string, job_id: r.job_id as string, name: r.name as string, status: r.status as string, attempt: r.attempt as number,
    started_at: iso(r.started_at), ended_at: iso(r.ended_at), output: json(r.output), rank: Number(r.rank),
  }));
  const claims = (await all('SELECT job_id, stage, generation, attempt, claimed_at, released_at, release_reason FROM claims')).map((r) => ({
    job_id: r.job_id as string, stage: r.stage as string, generation: r.generation as number, attempt: r.attempt as number,
    claimed_at: iso(r.claimed_at), released_at: iso(r.released_at), release_reason: r.release_reason as string | null,
  }));
  const events = (await all('SELECT seq, id, type, job_id, source, payload::text AS payload, at FROM events')).map((r) => ({
    seq: Number(r.seq), id: r.id as string, type: r.type as string, job_id: r.job_id as string | null, source: r.source as string,
    payload: json(r.payload), at: iso(r.at),
  }));
  const plugin_state = (await all('SELECT plugin, key, value::text AS value FROM plugin_state')).map((r) => ({
    plugin: r.plugin as string, key: r.key as string, value: json(r.value),
  }));
  const executor_lease = (await all('SELECT holder, generation, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms FROM executor_lease')).map((r) => ({
    id: 1, holder: r.holder as string, generation: r.generation as number, expires_at_ms: Number(r.expires_at_ms),
  }));
  return { jobs, stages, claims, events, plugin_state, executor_lease };
}

/** Every table, counted. Used to see that a target is empty before anything is written. */
async function countRows(c: pg.Client): Promise<Record<CopyTable, number>> {
  const out = {} as Record<CopyTable, number>;
  for (const t of COPY_TABLES) out[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
  return out;
}

/** Write the snapshot, in an order the foreign keys allow, inside the transaction the caller opened. */
async function writePostgres(c: pg.Client, db: Database.Database, snap: Snapshot): Promise<void> {
  const all = (sql: string) => db.prepare(sql).all() as Row[];
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  // Insert in the order the source lists them, so the identity column `ord` (which the stores list by) comes out in that order too.
  for (const r of all('SELECT id, repo, title, body, status, created_at, updated_at FROM jobs ORDER BY rowid')) {
    await c.query('INSERT INTO jobs (id, repo, title, body, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      r.id, r.repo, r.title, r.body, r.status, instant('jobs.created_at', r.created_at), instant('jobs.updated_at', r.updated_at),
    ]);
  }
  for (const r of all('SELECT id, job_id, name, status, attempt, started_at, ended_at, CAST(output AS TEXT) AS output FROM stages ORDER BY rowid')) {
    await c.query('INSERT INTO stages (id, job_id, name, status, attempt, started_at, ended_at, output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)', [
      r.id, r.job_id, r.name, r.status, r.attempt, instant('stages.started_at', r.started_at), instantOrNull('stages.ended_at', r.ended_at), text(r.output),
    ]);
  }
  for (const r of all('SELECT job_id, stage, generation, attempt, claimed_at, released_at, release_reason FROM claims ORDER BY job_id, stage, attempt')) {
    await c.query('INSERT INTO claims (job_id, stage, generation, attempt, claimed_at, released_at, release_reason) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      r.job_id, r.stage, r.generation, r.attempt, instant('claims.claimed_at', r.claimed_at), instantOrNull('claims.released_at', r.released_at), r.release_reason,
    ]);
  }
  for (const r of all('SELECT seq, id, type, job_id, source, CAST(payload AS TEXT) AS payload, at FROM events ORDER BY seq')) {
    await c.query('INSERT INTO events (seq, id, type, job_id, source, payload, at) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)', [
      r.seq, r.id, r.type, r.job_id, r.source, text(r.payload), instant('events.at', r.at),
    ]);
  }
  for (const r of all('SELECT plugin, key, CAST(value AS TEXT) AS value FROM plugin_state ORDER BY plugin, key')) {
    await c.query('INSERT INTO plugin_state (plugin, key, value) VALUES ($1, $2, $3::jsonb)', [r.plugin, r.key, r.value]);
  }
  for (const r of all('SELECT holder, generation FROM executor_lease')) {
    await c.query('INSERT INTO executor_lease (id, holder, generation, expires_at) VALUES (TRUE, $1, $2, to_timestamp(0))', [r.holder, r.generation]);
  }
  // The log's numbers carry on from the copy. An identity column does not move when rows are given their own numbers, so the next
  // event would be number 1 again and be refused. Go past the highest number the SQLite log ever handed out (AUTOINCREMENT keeps
  // that, even if the newest rows were deleted), never below the highest seq in the copy.
  const used = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined)?.seq ?? 0;
  const top = snap.events.reduce((m, e) => Math.max(m, e.seq as number), used);
  if (top > 0) await c.query("SELECT setval(pg_get_serial_sequence('events', 'seq'), $1::bigint, true)", [top]);
}

function compare(source: Snapshot, target: Snapshot): TableComparison[] {
  return COPY_TABLES.map((table) => {
    const a = digest(table, source[table]);
    const b = digest(table, target[table]);
    return { table, sqliteRows: a.rows, postgresRows: b.rows, sqliteChecksum: a.checksum, postgresChecksum: b.checksum, match: a.rows === b.rows && a.checksum === b.checksum };
  });
}

const connect = async (url: string): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: url, application_name: 'bulig-copy', connectionTimeoutMillis: 10_000 });
  c.on('error', () => {});
  await c.connect();
  return c;
};

/**
 * Copy the SQLite record at `from` into the empty Postgres record at `postgresUrl`. Throws CopyRefusedError, before writing anything,
 * when the source or the target is not in a state the copy can start from. Returns the comparison; `ok` says whether the two sides agree.
 */
export async function copySqliteToPostgres(options: CopyOptions): Promise<CopyReport> {
  const { from, postgresUrl } = options;
  const dryRun = options.dryRun ?? false;
  const warnings: string[] = [];

  // 1. The source: read-only, at the schema this tool knows.
  if (!existsSync(from)) throw new CopyRefusedError(`There is no SQLite file at ${from}.`);
  let db: Database.Database;
  try {
    db = new Database(from, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new CopyRefusedError(`Could not open ${from} for reading: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version !== COPY_SCHEMA_VERSION) {
      throw new CopyRefusedError(
        version < COPY_SCHEMA_VERSION
          ? `The SQLite record is at schema version ${version}, and this copy reads version ${COPY_SCHEMA_VERSION}. Let a current Bulig open it once (bulig status does) so it upgrades, then copy. Nothing was written.`
          : `The SQLite record is at schema version ${version}, which is newer than the ${COPY_SCHEMA_VERSION} this copy reads. Use a newer Bulig. Nothing was written.`,
      );
    }
    // One snapshot for the whole run, so the checks after the copy look at what the copy saw.
    db.exec('BEGIN');
    const source = readSqlite(db);
    const lease = db.prepare("SELECT holder, generation, expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS live FROM executor_lease WHERE id = 1").get() as
      | { holder: string; generation: number; live: number }
      | undefined;
    if (lease?.live) {
      warnings.push(
        `The SQLite record's lease is still live (held by ${lease.holder}), so a Bulig is probably still writing to this file. The copy is the record as it is now; anything written after this is not in it. Stop that Bulig before the real copy.`,
      );
    }

    // 2. The target: the schema is brought up to date the way the kernel would, then every table must be empty.
    assertPostgresUrl(postgresUrl);
    let store: PostgresStore;
    try {
      // A writer: it holds the writer lock on the database, so no kernel can write to it while the copy runs.
      store = await PostgresStore.open(postgresUrl, { mode: 'writer' });
    } catch (err) {
      throw new CopyRefusedError(`Could not open the Postgres record: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const targetVersion = await store.schemaVersion();
      if (targetVersion !== COPY_SCHEMA_VERSION) {
        throw new CopyRefusedError(`The Postgres record is at schema version ${targetVersion}, and this copy writes version ${COPY_SCHEMA_VERSION}. Nothing was written.`);
      }
      const client = await connect(postgresUrl);
      let committed = false;
      try {
        const counts = await countRows(client);
        const filled = COPY_TABLES.filter((t) => counts[t] > 0);
        if (filled.length) {
          throw new CopyRefusedError(
            `The Postgres record is not empty (${filled.map((t) => `${t}: ${counts[t]} rows`).join(', ')}). The copy only goes into an empty record, so nothing was written. Point it at a new database.`,
          );
        }

        // 3. One transaction. Compare inside it before committing, so a copy that does not match is never kept.
        await client.query('BEGIN');
        let tables: TableComparison[];
        try {
          await writePostgres(client, db, source);
          await options.beforeCompare?.(client);
          tables = compare(source, await readPostgres(client));
          if (dryRun || !tables.every((t) => t.match)) {
            await client.query('ROLLBACK');
          } else {
            await client.query('COMMIT');
            committed = true;
          }
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          if (err instanceof CopyRefusedError) throw err;
          throw new CopyRefusedError(`Postgres refused the copy, so nothing was kept: ${err instanceof Error ? err.message : String(err)}`);
        }

        // 4. After the commit, look again from a fresh connection: what is in Postgres now, not what this session saw.
        if (committed) {
          const fresh = await connect(postgresUrl);
          try {
            tables = compare(source, await readPostgres(fresh));
          } finally {
            await fresh.end().catch(() => {});
          }
        }
        const gen = source.executor_lease[0]?.generation as number | undefined;
        return { dryRun, ok: tables.every((t) => t.match), committed, tables, ...(gen !== undefined && { leaseGeneration: gen }), warnings };
      } finally {
        await client.end().catch(() => {});
      }
    } finally {
      await store.close().catch(() => {});
    }
  } finally {
    db.close();
  }
}

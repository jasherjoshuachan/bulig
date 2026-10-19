import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copySqliteToPostgres, COPY_TABLES, CopyRefusedError, createKernel, PostgresStore, SqliteStore, type CopyReport } from '../src/index.ts';
import type { Stage } from '@bulig/plugin-sdk';
import { tempDb } from './helpers.ts';
import { buildPopulatedV6, type PopulatedRecord } from './populated-v6.ts';
import { pgSupport, queryRows, usePgServer, type PgDatabase } from './pg-throwaway.ts';

// The one-off copy of the SQLite record into Postgres (ADR 0011). Each test copies a populated schema-6 record into a database
// of its own, and looks at what is there afterwards.

const server = usePgServer();
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function world(): Promise<{ from: string; record: PopulatedRecord; db: PgDatabase }> {
  const from = tempDb();
  const record = await buildPopulatedV6(from);
  const db = await server().newDatabase();
  cleanups.push(() => db.drop());
  return { from, record, db };
}

const counts = async (url: string) => {
  const out: Record<string, number> = {};
  for (const t of COPY_TABLES) out[t] = Number((await queryRows<{ n: string }>(url, `SELECT count(*) AS n FROM ${t}`))[0]!.n);
  return out;
};

const sqliteCounts = (path: string) => {
  const raw = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(COPY_TABLES.map((t) => [t, (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]));
  } finally {
    raw.close();
  }
};

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe.skipIf(!pgSupport.available)('copying a populated SQLite record into Postgres', () => {
  it('copies every table, and the counts and the checksums agree on both sides', async () => {
    const { from, record, db } = await world();
    const before = sqliteCounts(from);
    // the record really is populated: every table has rows, and the jobs cover every status
    for (const t of COPY_TABLES) expect(before[t], t).toBeGreaterThan(0);
    expect(Object.keys(record.jobs).sort()).toEqual(['awaiting_approval', 'cancelled', 'done', 'failed', 'queued', 'running']);

    const report = await copySqliteToPostgres({ from, postgresUrl: db.url });

    expect(report).toMatchObject({ ok: true, committed: true, dryRun: false, leaseGeneration: 3 });
    expect(report.tables.map((t) => t.table)).toEqual([...COPY_TABLES]);
    for (const t of report.tables) {
      expect(t.match, t.table).toBe(true);
      expect(t.postgresRows, t.table).toBe(before[t.table]);
      expect(t.sqliteChecksum, t.table).toBe(t.postgresChecksum);
      expect(t.sqliteChecksum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await counts(db.url)).toEqual(before);
    // a live lease in the source is said out loud
    expect(report.warnings.join(' ')).toMatch(/lease is still live/);
  });

  it('keeps ids, the order the stores list in, event numbers, output that is null, and a bare number in a JSON column', async () => {
    const { from, record, db } = await world();
    await copySqliteToPostgres({ from, postgresUrl: db.url });
    const sqlite = new SqliteStore(from);
    const pgStore = await PostgresStore.open(db.url);
    cleanups.push(() => pgStore.close());
    try {
      expect((await pgStore.listJobs()).map((j) => j.id)).toEqual((await sqlite.listJobs()).map((j) => j.id));
      for (const id of Object.values(record.jobs)) {
        // a time SQLite kept as written ('...:00Z') comes back from Postgres in the one spelling it has for an instant ('...:00.000Z')
        const spelled = (list: Stage[]) => list.map((s) => ({ ...s, startedAt: new Date(s.startedAt).toISOString(), endedAt: s.endedAt && new Date(s.endedAt).toISOString() }));
        expect(spelled(await pgStore.listStages(id)), id).toEqual(spelled(await sqlite.listStages(id)));
        expect(await pgStore.eventsForJob(id)).toEqual(await sqlite.eventsForJob(id));
      }
      // events: same ids and same seq, in the same order, including the ones derived from a cause
      const [a, b] = [await sqlite.eventsAfter(0), await pgStore.eventsAfter(0)];
      expect(b).toHaveLength(record.eventCount);
      expect(b.map((e) => [e.seq, e.id])).toEqual(a.map((e) => [e.seq, e.id]));
      expect(b.find((e) => e.type === 'plugin.count')!.payload).toBe(5);
      expect(b.find((e) => e.type === 'plugin.note')!.payload).toBeNull();
      expect(await pgStore.getState('github', 'cursor')).toEqual({ page: 7, seen: ['a', 'b'] });
      expect(await pgStore.getState('channel-telegram', 'offset')).toBe(90210);
      // SQL NULL output and JSON null output stay different things in the copy
      const nulls = await queryRows<{ id: string; sql_null: boolean }>(db.url, "SELECT id, output IS NULL AS sql_null FROM stages WHERE id = 'legacy-stage-1' OR (name = 'build' AND attempt = 2 AND job_id = '" + record.jobs.done + "')");
      expect(nulls.find((r) => r.id === 'legacy-stage-1')!.sql_null).toBe(true);
      expect(nulls.find((r) => r.id !== 'legacy-stage-1')!.sql_null).toBe(false);
      expect((await pgStore.getStage('legacy-stage-2'))!.output).toBe(7);
      // claims: every one, with its generation, and the live one is still live
      const claims = await queryRows<{ job_id: string; stage: string; attempt: number; generation: number; live: boolean }>(
        db.url,
        'SELECT job_id, stage, attempt, generation, released_at IS NULL AS live FROM claims ORDER BY job_id, stage, attempt',
      );
      expect(claims.filter((c) => c.live).map((c) => [c.job_id, c.stage, c.generation])).toEqual([[record.busyJob, 'build', 3]]);
      expect(claims.every((c) => c.generation === 3)).toBe(true);
    } finally {
      await sqlite.close();
    }
  });

  it('copies the lease already released, so a kernel on the copy takes generation + 1 and leaves no running stage behind', async () => {
    const { from, record, db } = await world();
    await copySqliteToPostgres({ from, postgresUrl: db.url });

    // released: the holder and the generation are there, and the lease is over
    const [lease] = await queryRows<{ holder: string; generation: number; over: boolean }>(db.url, 'SELECT holder, generation, expires_at <= now() AS over FROM executor_lease');
    expect(lease).toEqual({ holder: 'kernel-mac-before-copy', generation: 3, over: true });

    const store = await PostgresStore.open(db.url);
    const kernel = createKernel({ store, plugins: [], enabled: [], logger: quiet, leaseHolder: 'kernel-vps', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000 });
    cleanups.push(() => kernel.stop());
    await kernel.start(); // no wait for the old lease to run out
    const [after] = await queryRows<{ holder: string; generation: number }>(db.url, 'SELECT holder, generation FROM executor_lease');
    expect(after).toEqual({ holder: 'kernel-vps', generation: record.leaseGeneration + 1 });

    // the stage the Mac kernel left running: starting it again at generation 4 closes the old attempt as lease-lost
    const stages = await kernel.jobs.stages(record.busyJob);
    expect(stages.map((s) => [s.id, s.status])).toEqual([[record.runningStage, 'running']]);
    const again = await kernel.jobs.startStage(record.busyJob, 'build');
    expect(again).toMatchObject({ attempt: 2, status: 'running', claimGeneration: 4 });
    await kernel.jobs.finishStage(again.id, 'passed', { result: 'resumed' });
    const finished = await kernel.jobs.stages(record.busyJob);
    expect(finished.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(finished[0]!.output).toMatchObject({ interrupted: true });
    expect(await queryRows(db.url, "SELECT 1 FROM stages WHERE status = 'running'")).toEqual([]);
    expect(await queryRows(db.url, 'SELECT 1 FROM claims WHERE released_at IS NULL')).toEqual([]);
  });

  it('carries the event numbers on: the next event is the last one + 1, not number 1 again', async () => {
    const { from, record, db } = await world();
    await copySqliteToPostgres({ from, postgresUrl: db.url });
    const store = await PostgresStore.open(db.url);
    cleanups.push(() => store.close());
    const next = await store.appendEvent({ type: 'after.copy', source: 'test', payload: null });
    expect(next.seq).toBe(record.lastSeq + 1);
  });

  it('goes past the highest number the SQLite log ever used, even when the newest events were deleted', async () => {
    const { from, record, db } = await world();
    const raw = new Database(from);
    raw.prepare('DELETE FROM events WHERE seq = ?').run(record.lastSeq);
    raw.close();
    await copySqliteToPostgres({ from, postgresUrl: db.url });
    const store = await PostgresStore.open(db.url);
    cleanups.push(() => store.close());
    // SQLite (AUTOINCREMENT) would give lastSeq + 1 next, never reuse lastSeq
    expect((await store.appendEvent({ type: 'after.copy', source: 'test', payload: null })).seq).toBe(record.lastSeq + 1);
  });

  it('refuses a target that already has rows, names which tables, and leaves it as it was', async () => {
    const { from, db } = await world();
    await copySqliteToPostgres({ from, postgresUrl: db.url });
    const first = await counts(db.url);

    const err = await copySqliteToPostgres({ from, postgresUrl: db.url }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopyRefusedError);
    expect((err as Error).message).toMatch(/not empty/);
    expect((err as Error).message).toMatch(/jobs: 6 rows/);
    expect(await counts(db.url)).toEqual(first);
  });

  it('refuses a target with a single row in a single table', async () => {
    const { from, db } = await world();
    const seed = await PostgresStore.open(db.url);
    await seed.setState('github', 'k', 'v');
    await seed.close();
    await expect(copySqliteToPostgres({ from, postgresUrl: db.url })).rejects.toThrow(/plugin_state: 1 rows/);
    expect((await counts(db.url)).jobs).toBe(0);
  });

  it('refuses a source that is not at schema version 6, before it touches the target', async () => {
    for (const version of [5, 7]) {
      const { from, db } = await world();
      const raw = new Database(from);
      raw.pragma(`user_version = ${version}`);
      raw.close();
      const err = await copySqliteToPostgres({ from, postgresUrl: db.url }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CopyRefusedError);
      expect((err as Error).message).toContain(`schema version ${version}`);
      // the target was never opened, so it has no schema at all
      expect(await queryRows(db.url, "SELECT 1 FROM pg_tables WHERE tablename = 'jobs'")).toEqual([]);
    }
  });

  it('refuses a file that is not there', async () => {
    const { db } = await world();
    await expect(copySqliteToPostgres({ from: '/tmp/bulig-no-such-file.sqlite', postgresUrl: db.url })).rejects.toThrow(/no SQLite file/);
  });

  it('a dry run writes nothing: every table is empty afterwards, the comparison is still full, and a real copy can follow', async () => {
    const { from, record, db } = await world();
    const before = sqliteCounts(from);
    const dry = await copySqliteToPostgres({ from, postgresUrl: db.url, dryRun: true });
    expect(dry).toMatchObject({ ok: true, committed: false, dryRun: true });
    for (const t of dry.tables) {
      expect(t.postgresRows, t.table).toBe(before[t.table]);
      expect(t.match, t.table).toBe(true);
    }
    expect(Object.values(await counts(db.url)).every((n) => n === 0)).toBe(true);

    const real = await copySqliteToPostgres({ from, postgresUrl: db.url });
    expect(real).toMatchObject({ ok: true, committed: true });
    expect(real.tables.map((t) => t.sqliteChecksum)).toEqual(dry.tables.map((t) => t.sqliteChecksum));
    // the next event is still last + 1: the dry run's sequence moves were undone with it
    const store = await PostgresStore.open(db.url);
    cleanups.push(() => store.close());
    expect((await store.appendEvent({ type: 'after.copy', source: 'test', payload: null })).seq).toBe(record.lastSeq + 1);
  });

  it('does not change the SQLite file', async () => {
    const { from, db } = await world();
    const dump = (path: string) => {
      const raw = new Database(path, { readonly: true });
      try {
        return COPY_TABLES.map((t) => raw.prepare(`SELECT * FROM ${t}`).all());
      } finally {
        raw.close();
      }
    };
    const before = dump(from);
    await copySqliteToPostgres({ from, postgresUrl: db.url });
    expect(dump(from)).toEqual(before);
  });

  it('catches a copy that does not match, rolls it back, and keeps nothing', async () => {
    const { from, db } = await world();
    const report: CopyReport = await copySqliteToPostgres({
      from,
      postgresUrl: db.url,
      beforeCompare: async (c) => void (await c.query("UPDATE events SET type = 'tampered' WHERE seq = (SELECT min(seq) FROM events)")),
    });
    expect(report).toMatchObject({ ok: false, committed: false });
    expect(report.tables.filter((t) => !t.match).map((t) => t.table)).toEqual(['events']);
    const events = report.tables.find((t) => t.table === 'events')!;
    expect(events.sqliteRows).toBe(events.postgresRows); // same count, different content: only the checksum can tell
    expect(Object.values(await counts(db.url)).every((n) => n === 0)).toBe(true);
  });

  it('catches a lost row, a changed time, and a changed JSON value, each in its own table', async () => {
    const cases: [string, string, string][] = [
      ['claims', 'DELETE FROM claims WHERE (job_id, stage, attempt) = (SELECT job_id, stage, attempt FROM claims LIMIT 1)', 'claims'],
      ['stages', "UPDATE stages SET started_at = started_at + interval '1 millisecond' WHERE id = 'legacy-stage-1'", 'stages'],
      ['plugin_state', "UPDATE plugin_state SET value = '{\"page\":8}' WHERE key = 'cursor'", 'plugin_state'],
      ['executor_lease', "UPDATE executor_lease SET generation = generation + 1", 'executor_lease'],
    ];
    for (const [, sql, table] of cases) {
      const { from, db } = await world();
      const report = await copySqliteToPostgres({ from, postgresUrl: db.url, dryRun: true, beforeCompare: async (c) => void (await c.query(sql)) });
      expect(report.ok, table).toBe(false);
      expect(report.tables.filter((t) => !t.match).map((t) => t.table), table).toEqual([table]);
    }
  });

  it('says plainly when the target has no host, and never repeats the string', async () => {
    const { from } = await world();
    const err = await copySqliteToPostgres({ from, postgresUrl: 'postgresql:///bulig?password=hunter2' }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/name a host/);
    expect((err as Error).message).not.toContain('hunter2');
  });
});

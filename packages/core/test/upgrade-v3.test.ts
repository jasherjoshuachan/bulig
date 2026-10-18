import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, PostgresStore, SqliteStore, StageClaimedError, type Store } from '../src/index.ts';
import { tempDb } from './helpers.ts';
import { pgSupport, queryRows, usePgServer, type PgDatabase } from './pg-throwaway.ts';

// A record written by the code before claims existed (schema version 3: jobs, stages, events, plugin state) is opened by this
// code, so migrations 4 to 6 run on data that is already there. The old tables are made with raw SQL, the way that code left
// them: a job in the middle of a stage, no claim row for it, events with random ids. ADR 0010.

const JOB = 'job-from-v3';
const DONE_STAGE = 'stage-plan-v3';
const RUNNING_STAGE = 'stage-build-v3';
const EVENT_IDS = ['3f1c9a52-0d7e-4c11-9b43-0a6f5d2e8c01', 'b7e24d90-5a38-47f6-8c1d-91e0a4c3f7b2', '5c08e1ad-62b9-4e07-a3f4-d8b1769c0e55'];

interface Adapter {
  name: string;
  skip: boolean;
  /** Make a record as schema version 3 left it, filled with the data above. */
  seed(): Promise<void>;
  /** Open that record with the current code. Every store opened here is closed after the test. */
  open(): Promise<Store>;
  /** The claims table, as a plain list, for looking at what the upgrade and the kernel left. */
  claims(): Promise<{ stage: string; attempt: number; generation: number; released: boolean }[]>;
}

const server = usePgServer();
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

const SQLITE_V3 = `
  CREATE TABLE jobs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE stages (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, output JSON);
  CREATE INDEX stages_job ON stages(job_id);
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, type TEXT NOT NULL, job_id TEXT, source TEXT NOT NULL, payload JSON, at TEXT NOT NULL);
  CREATE INDEX events_job ON events(job_id);
  ALTER TABLE jobs ADD COLUMN body TEXT NOT NULL DEFAULT '';
  CREATE TABLE plugin_state (plugin TEXT NOT NULL, key TEXT NOT NULL, value JSON NOT NULL, PRIMARY KEY (plugin, key));
`;
const SQLITE_DATA = `
  INSERT INTO jobs (id, repo, title, status, created_at, updated_at, body) VALUES ('${JOB}', '/repo', 'Add multiply', 'running', '2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z', 'Add src/multiply.js');
  INSERT INTO stages (id, job_id, name, status, attempt, started_at, ended_at, output) VALUES ('${DONE_STAGE}', '${JOB}', 'plan', 'passed', 1, '2026-10-01T00:00:10.000Z', '2026-10-01T00:01:00.000Z', '{"result":"A plan."}');
  INSERT INTO stages (id, job_id, name, status, attempt, started_at) VALUES ('${RUNNING_STAGE}', '${JOB}', 'build', 'running', 1, '2026-10-01T00:02:00.000Z');
  INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[0]}', 'job.created', '${JOB}', 'kernel', '{"title":"Add multiply"}', '2026-10-01T00:00:00.000Z');
  INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[1]}', 'stage.requested', '${JOB}', 'pipeline-dev', '{"stage":"build"}', '2026-10-01T00:02:00.000Z');
  INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[2]}', 'plugin.note', NULL, 'github', NULL, '2026-10-01T00:03:00.000Z');
  INSERT INTO plugin_state (plugin, key, value) VALUES ('github', 'cursor', '{"page":7}');
`;

const PG_V3 = `
  CREATE TABLE jobs (id TEXT PRIMARY KEY, ord BIGINT GENERATED ALWAYS AS IDENTITY, repo TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX jobs_order ON jobs (created_at, ord);
  CREATE INDEX jobs_status_order ON jobs (status, created_at, ord);
  CREATE TABLE stages (id TEXT PRIMARY KEY, ord BIGINT GENERATED ALWAYS AS IDENTITY, job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, output JSONB);
  CREATE INDEX stages_job ON stages (job_id, started_at, ord);
  CREATE TABLE events (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, job_id TEXT, source TEXT NOT NULL, payload JSONB, at TIMESTAMPTZ NOT NULL);
  CREATE INDEX events_job ON events (job_id, seq);
  ALTER TABLE jobs ADD COLUMN body TEXT NOT NULL DEFAULT '';
  CREATE TABLE plugin_state (plugin TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, PRIMARY KEY (plugin, key));
  CREATE TABLE bulig_schema (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), version INTEGER NOT NULL);
  INSERT INTO bulig_schema (id, version) VALUES (TRUE, 3);
`;

let sqlitePath = '';
let pgDb: PgDatabase | undefined;
const ADAPTERS: Adapter[] = [
  {
    name: 'SqliteStore',
    skip: false,
    async seed() {
      sqlitePath = tempDb();
      const raw = new Database(sqlitePath);
      raw.pragma('journal_mode = WAL');
      raw.exec(SQLITE_V3);
      raw.exec(SQLITE_DATA);
      raw.pragma('user_version = 3');
      raw.close();
    },
    async open() {
      const s = new SqliteStore(sqlitePath);
      cleanups.push(() => s.close());
      return s;
    },
    async claims() {
      const raw = new Database(sqlitePath, { readonly: true });
      try {
        const rows = raw.prepare('SELECT stage, attempt, generation, released_at FROM claims ORDER BY attempt').all() as { stage: string; attempt: number; generation: number; released_at: string | null }[];
        return rows.map((r) => ({ stage: r.stage, attempt: r.attempt, generation: r.generation, released: r.released_at !== null }));
      } finally {
        raw.close();
      }
    },
  },
  {
    name: 'PostgresStore',
    skip: !pgSupport.available,
    async seed() {
      const db = (pgDb = await server().newDatabase());
      cleanups.push(() => db.drop());
      await queryRows(db.url, PG_V3);
      await queryRows(
        db.url,
        `
        INSERT INTO jobs (id, repo, title, status, created_at, updated_at, body) VALUES ('${JOB}', '/repo', 'Add multiply', 'running', '2026-10-01T00:00:00Z', '2026-10-01T00:05:00Z', 'Add src/multiply.js');
        INSERT INTO stages (id, job_id, name, status, attempt, started_at, ended_at, output) VALUES ('${DONE_STAGE}', '${JOB}', 'plan', 'passed', 1, '2026-10-01T00:00:10Z', '2026-10-01T00:01:00Z', '{"result":"A plan."}');
        INSERT INTO stages (id, job_id, name, status, attempt, started_at) VALUES ('${RUNNING_STAGE}', '${JOB}', 'build', 'running', 1, '2026-10-01T00:02:00Z');
        INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[0]}', 'job.created', '${JOB}', 'kernel', '{"title":"Add multiply"}', '2026-10-01T00:00:00Z');
        INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[1]}', 'stage.requested', '${JOB}', 'pipeline-dev', '{"stage":"build"}', '2026-10-01T00:02:00Z');
        INSERT INTO events (id, type, job_id, source, payload, at) VALUES ('${EVENT_IDS[2]}', 'plugin.note', NULL, 'github', NULL, '2026-10-01T00:03:00Z');
        INSERT INTO plugin_state (plugin, key, value) VALUES ('github', 'cursor', '{"page":7}');
        `,
      );
    },
    async open() {
      const s = await PostgresStore.open(pgDb!.url);
      cleanups.push(() => s.close());
      return s;
    },
    async claims() {
      const rows = await queryRows<{ stage: string; attempt: number; generation: number; released: boolean }>(
        pgDb!.url,
        'SELECT stage, attempt, generation, released_at IS NOT NULL AS released FROM claims ORDER BY attempt',
      );
      return rows;
    },
  },
];

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`a populated schema-v3 record opened by claims code, with ${adapter.name}`, () => {
    const kernelOn = async (store: Store) => {
      const k = createKernel({
        store,
        plugins: [],
        enabled: [],
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        leaseHolder: 'upgraded-kernel',
        leaseTtlMs: 5_000,
        leaseHeartbeatMs: 1_000,
      });
      cleanups.push(() => k.stop());
      await k.start();
      return k;
    };

    it('keeps every row, gets to schema version 6, and takes new events after the old ones', async () => {
      await adapter.seed();
      const store = await adapter.open();
      expect(await store.schemaVersion()).toBe(6);

      expect(await store.getJob(JOB)).toMatchObject({ id: JOB, repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js', status: 'running' });
      expect((await store.listStages(JOB)).map((s) => ({ id: s.id, name: s.name, status: s.status, attempt: s.attempt }))).toEqual([
        { id: DONE_STAGE, name: 'plan', status: 'passed', attempt: 1 },
        { id: RUNNING_STAGE, name: 'build', status: 'running', attempt: 1 },
      ]);
      expect((await store.getStage(DONE_STAGE))!.output).toEqual({ result: 'A plan.' });
      expect(await store.getState('github', 'cursor')).toEqual({ page: 7 });
      const events = await store.eventsAfter(0);
      expect(events.map((e) => e.id)).toEqual(EVENT_IDS);
      expect(events.map((e) => e.type)).toEqual(['job.created', 'stage.requested', 'plugin.note']);
      expect(events[1]!.payload).toEqual({ stage: 'build' });
      // the upgrade made no claim for work it did not see start
      expect(await adapter.claims()).toEqual([]);
      // the log carries on from where it was
      const next = await store.appendEvent({ type: 'after.upgrade', source: 'test', payload: null });
      expect(next.seq!).toBeGreaterThan(events[2]!.seq!);
      // and the new unique index on event ids is in force over the old ids
      await expect(store.appendEvent({ id: EVENT_IDS[0], type: 'x.y', source: 'test', payload: null })).rejects.toThrow(/already|duplicate|exists/i);
    });

    it('lets a fenced kernel finish the old running stage once, with no claim to release', async () => {
      await adapter.seed();
      const k = await kernelOn(await adapter.open());
      const done = await k.jobs.finishStage(RUNNING_STAGE, 'passed', { result: 'finished after upgrade' });
      expect(done).toMatchObject({ id: RUNNING_STAGE, status: 'passed', output: { result: 'finished after upgrade' } });
      expect((await k.jobs.stages(JOB)).map((s) => s.status)).toEqual(['passed', 'passed']);
      expect(await adapter.claims()).toEqual([]); // the stage was never claimed, so nothing was written to the claims table
      // and the stage can be run again, as a fresh attempt with a claim of its own
      const again = await k.jobs.startStage(JOB, 'build');
      expect(again.attempt).toBe(2);
    });

    it('opens attempt 2 for a fenced restart, leaves the old attempt for the pipeline to close, and then guards attempt 2', async () => {
      await adapter.seed();
      const k = await kernelOn(await adapter.open());
      const started = await k.jobs.startStage(JOB, 'build');
      expect(started).toMatchObject({ jobId: JOB, name: 'build', attempt: 2, status: 'running' });
      const stages = await k.jobs.stages(JOB);
      expect(stages.find((s) => s.id === RUNNING_STAGE)).toMatchObject({ status: 'running', attempt: 1 }); // untouched: the pipeline closes it as interrupted
      // exactly one claim, for attempt 2, held under this kernel's generation
      expect(await adapter.claims()).toEqual([{ stage: 'build', attempt: 2, generation: 1, released: false }]);
      // and it is a real claim: a second start of the same stage is refused
      const err = await k.jobs.startStage(JOB, 'build').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StageClaimedError);
      // the old stage closes without a claim, and attempt 2 finishes through its claim, once
      await k.jobs.finishStage(RUNNING_STAGE, 'failed', { interrupted: true });
      await k.jobs.finishStage(started.id, 'passed');
      await expect(k.jobs.finishStage(started.id, 'passed')).rejects.toMatchObject({ name: 'StageNotClaimedError' });
      expect(await adapter.claims()).toEqual([{ stage: 'build', attempt: 2, generation: 1, released: true }]);
    });
  });
}

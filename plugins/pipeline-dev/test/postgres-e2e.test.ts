import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStore, type Store } from '@bulig/core';
import { describePg, usePgServer, type PgDatabase } from '../../../packages/core/test/pg-throwaway.ts';
import { slowStore } from '../../../packages/core/test/slow-store.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, newDb, stageNames, types, settle, type Sent } from './harness.ts';

// The pipeline end to end with Postgres as the record (ADR 0007, step 3): the same fake worker, fake GitHub and fake human as
// pipeline.test.ts, but every read, write and event goes through PostgresStore and the kernel queue.

const PASS = 'All good.\nVERDICT: PASS';

describePg('pipeline-dev on PostgresStore', () => {
  const server = usePgServer();
  const dbs: PgDatabase[] = [];
  const stores: Store[] = [];
  afterEach(async () => {
    // The kernels are stopped by the harness's own afterEach (which closes their stores); closing again is harmless.
    for (const s of stores.splice(0)) await s.close().catch(() => {});
    for (const d of dbs.splice(0)) await d.drop();
  });

  const rig = async (wrap: (s: PostgresStore) => Store = (s) => s) => {
    const db = await server().newDatabase();
    dbs.push(db);
    const pgStore = await PostgresStore.open(db.url);
    const store = wrap(pgStore);
    stores.push(store);
    const worker: Sent[] = [];
    const github: { type: string; payload: unknown }[] = [];
    const human = fakeHuman();
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub(github), human.plugin], {}, { store });
    return { k, worker, github, human, db };
  };

  const create = (k: Awaited<ReturnType<typeof rig>>['k']) => k.jobs.create({ repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js' });

  it('runs a whole job: create, plan, approval, build, test, docs, review, PR, approval, merge', async () => {
    const r = await rig();
    await r.k.start();
    await settle(r.k);
    const job = await create(r.k);
    await settle(r.k);

    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique']);

    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'test', 'docs', 'review']);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');

    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('done');
    expect(r.github.at(-1)!.type).toBe('merge.requested');
    expect(await stageNames(r.k, job.id)).toEqual([
      'worktree:passed', 'plan:passed', 'critique:passed', 'approve-plan:passed', 'build:passed',
      'test:passed', 'docs:passed', 'review:passed', 'pr:passed', 'approve-merge:passed', 'merge:passed',
    ]);

    // The log is in order and complete: seq only goes up, and the job's story reads start to finish.
    const log = await r.k.bus.replay();
    const seqs = log.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const story = await types(r.k, job.id);
    expect(story[0]).toBe('job.created');
    expect(story).toContain('pr.merged');
    expect(story.at(-1)).toBe('job.status');
  });

  it('a finished job is still there, with its stages and its events, after the kernel stops and another opens the same database', async () => {
    const r = await rig();
    await r.k.start();
    await settle(r.k);
    const job = await create(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    const stages = await stageNames(r.k, job.id);
    const story = await types(r.k, job.id);
    await r.k.stop();

    const again = await PostgresStore.open(r.db.url, { mode: 'reader' });
    stores.push(again);
    expect((await again.getJob(job.id))!.status).toBe('done');
    expect((await again.listStages(job.id)).map((s) => `${s.name}:${s.status}`)).toEqual(stages);
    expect((await again.eventsForJob(job.id)).map((e) => e.type)).toEqual(story);
  });

  it('denying the plan cancels the job and nothing else runs', async () => {
    const r = await rig();
    await r.k.start();
    await settle(r.k);
    const job = await create(r.k);
    await settle(r.k);
    r.human.deny(job.id);
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('cancelled');
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect(await stageNames(r.k, job.id)).toContain('approve-plan:failed');
  });

  it('two jobs at once both reach their plan approval, each with its own stages', async () => {
    const r = await rig();
    await r.k.start();
    await settle(r.k);
    const [a, b] = await Promise.all([create(r.k), create(r.k)]);
    await settle(r.k);
    for (const j of [a, b]) {
      expect((await r.k.jobs.get(j.id))!.status).toBe('awaiting_approval');
      expect(r.worker.filter((s) => s.jobId === j.id).map((s) => s.stage)).toEqual(['plan', 'critique']);
    }
  });

  it('the whole job also works when every call to Postgres is slow and uneven (ordering does not depend on speed)', async () => {
    const before = [4, 0, 3, 1, 5, 0, 2];
    const after = [0, 3, 1, 4, 0, 2, 5];
    const r = await rig((s) => slowStore(s, { before: (_m, n) => before[n % 7]!, after: (_m, n) => after[n % 7]! }));
    await r.k.start();
    await settle(r.k);
    const job = await create(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('done');
    const log = await r.k.bus.replay();
    const seqs = log.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

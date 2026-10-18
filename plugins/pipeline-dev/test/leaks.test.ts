import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@bulig/core';
import { slowStore } from '../../../packages/core/test/slow-store.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, newDb, type Sent } from './harness.ts';

const PASS = 'All good.\nVERDICT: PASS';
const until = async (cond: () => Promise<boolean> | boolean, what: string, ms = 6000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const reasonOf = async (k: ReturnType<typeof boot>, jobId: string) => ((await k.history(jobId)).find((e) => e.type === 'pipeline.failed')!.payload as { reason: string }).reason;

describe('R1: a timed-out store call must not leave a stage running', () => {
  it('a timed-out job read just before commit.requested fails the job, closes the edit stage, and the worktree is cleaned up', async () => {
    // The first job read after the build stage opens is the one the result handler makes before it asks for the commit.
    let armed = false;
    let once = true;
    const store = slowStore(new SqliteStore(newDb()), {
      after: (m, _n, args) => {
        if (m === 'startStage' && args[1] === 'build') armed = true;
        if (m === 'getJob' && armed && once) return ((once = false), 300);
        return 0;
      },
    });
    const github: { type: string; payload: unknown }[] = [];
    const human = fakeHuman();
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub(github), human.plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k.start();
    const job = await k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => human.requests.length === 1, 'the plan question');
    human.grant(job.id, 'plan');
    await until(async () => (await k.jobs.get(job.id))!.status === 'failed', 'the job to fail');
    expect(await reasonOf(k, job.id)).toMatch(/did not finish within 100 ms/);
    expect((await k.jobs.stages(job.id)).find((s) => s.name === 'build')).toMatchObject({ status: 'failed' });
    expect((await k.jobs.stages(job.id)).filter((s) => s.status === 'running')).toEqual([]);
    await until(() => github.some((g) => g.type === 'worktree.cleanup.requested'), 'the cleanup request');
    expect(github.some((g) => g.type === 'commit.requested')).toBe(false);
  });

  it('a timed-out finishStage closes that stage as failed with the reason, instead of leaving it running', async () => {
    // finishStage calls in order: worktree, then plan. The plan's close is the one that times out.
    let finishes = 0;
    const store = slowStore(new SqliteStore(newDb()), { after: (m) => (m === 'finishStage' && ++finishes === 2 ? 300 : 0) });
    const worker: Sent[] = [];
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), fakeHuman().plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k.start();
    const job = await k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(async () => (await k.jobs.get(job.id))!.status === 'failed', 'the job to fail');
    expect(await reasonOf(k, job.id)).toMatch(/did not finish within 100 ms/);
    const plan = (await k.jobs.stages(job.id)).find((s) => s.name === 'plan')!;
    expect(plan.status).toBe('failed');
    expect(JSON.stringify(plan.output)).toMatch(/did not finish within 100 ms/);
    expect((await k.jobs.stages(job.id)).filter((s) => s.status === 'running')).toEqual([]);
  });
});

describe('R2: a lost worktree.cleanup.requested is asked for again on the next start', () => {
  it('a restart repeats the request until a cleanup is on record, then stops', async () => {
    const path = newDb();
    // The first run loses the cleanup request: the event is written, but the answer is late, so it is rolled back.
    let lost = true;
    const store = slowStore(new SqliteStore(path), {
      after: (m, _n, args) => (m === 'appendEvent' && (args[0] as { type: string }).type === 'worktree.cleanup.requested' && lost ? ((lost = false), 300) : 0),
    });
    const first: { type: string; payload: unknown }[] = [];
    const human = fakeHuman();
    const k1 = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub(first), human.plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k1.start();
    const job = await k1.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => human.requests.length === 1, 'the plan question');
    human.deny(job.id);
    await until(async () => (await k1.jobs.get(job.id))!.status === 'cancelled', 'the job to be cancelled');
    await until(() => !lost, 'the cleanup request to be attempted');
    await new Promise((r) => setTimeout(r, 500));
    await k1.stop();
    expect(first.filter((g) => g.type === 'worktree.cleanup.requested')).toEqual([]);

    const second: { type: string; payload: unknown }[] = [];
    const k2 = boot(newDb(), [fakeWorker({}, []), fakeGithub(second), fakeHuman().plugin], {}, { store: new SqliteStore(path) });
    await k2.start();
    await until(async () => (await k2.history(job.id)).some((e) => e.type === 'worktree.cleaned'), 'the repeated cleanup');
    expect(second.filter((g) => g.type === 'worktree.cleanup.requested')).toHaveLength(1);
    await k2.stop();

    const third: { type: string; payload: unknown }[] = [];
    const k3 = boot(newDb(), [fakeWorker({}, []), fakeGithub(third), fakeHuman().plugin], {}, { store: new SqliteStore(path) });
    await k3.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(third.filter((g) => g.type === 'worktree.cleanup.requested')).toEqual([]);
  });
});

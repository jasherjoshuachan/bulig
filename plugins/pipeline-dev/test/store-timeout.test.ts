import { describe, expect, it } from 'vitest';
import { SqliteStore, StoreBrokenError } from '@bulig/core';
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

describe('a store call that is late (R1)', () => {
  it('fails the one job it belonged to with a clear reason, and the next job carries on once the late call is over', async () => {
    // The pipeline handles one event at a time. A call that answers late must not hold the jobs behind it for good.
    let calls = 0;
    const store = slowStore(new SqliteStore(newDb()), { after: (m) => (m === 'startStage' && calls++ === 0 ? 400 : 0) });
    const worker: Sent[] = [];
    const human = fakeHuman();
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), human.plugin], {}, { store, storeTimeoutMs: 150, storeBrokenMs: 5000 });
    await k.start();

    const first = await k.jobs.create({ repo: '/repo', title: 'First', body: 'x' });
    const second = await k.jobs.create({ repo: '/repo', title: 'Second', body: 'x' });

    await until(async () => (await k.jobs.get(first.id))!.status === 'failed', 'the first job to fail');
    const failure = (await k.history(first.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failure.payload as { reason: string }).reason).toMatch(/did not finish within 150 ms/);

    await until(async () => (await k.jobs.get(second.id))!.status === 'awaiting_approval', 'the second job to reach its plan approval');
    expect(worker.filter((s) => s.jobId === second.id).map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect(worker.some((s) => s.jobId === first.id)).toBe(false);
    // The late startStage was rolled back: the first job never got the stage it asked for.
    expect((await k.jobs.stages(first.id)).filter((s) => s.name === 'worktree')).toEqual([]);
  });
});

describe('a store call that never comes back', () => {
  it('stops the kernel writing: the job that hit it sees the timeout, nothing is written after, and one loud error is logged', async () => {
    // Changed from the first version of this test, which expected the next job to carry on. A call that never comes back
    // leaves the record in an unknown state, so the kernel now stops using it instead of carrying on.
    let calls = 0;
    const inner = new SqliteStore(newDb());
    const store = slowStore(inner, { hang: (m) => m === 'startStage' && calls++ === 0 });
    const errors: string[] = [];
    const worker: Sent[] = [];
    const human = fakeHuman();
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), human.plugin], {}, {
      store,
      storeTimeoutMs: 100,
      storeBrokenMs: 400,
      logger: { debug() {}, info() {}, warn() {}, error: (m: string) => void errors.push(m) },
    });
    await k.start();

    const first = await k.jobs.create({ repo: '/repo', title: 'First', body: 'x' });
    // The job that hit the stuck call heard the timeout, through the pipeline's own error log.
    await until(() => errors.some((e) => /pipeline-dev: .*did not finish within 100 ms/.test(e)), 'the pipeline to log the timeout');
    // This one queues behind the stuck call, so it is refused when the queue gives up on the store.
    const second = await Promise.race([k.jobs.create({ repo: '/repo', title: 'Second', body: 'x' }).then(() => 'created', (e: unknown) => e), new Promise((r) => setTimeout(() => r('stalled'), 4000))]);
    expect(second).toBeInstanceOf(StoreBrokenError);
    const eventsAtBreak = (await inner.eventsAfter()).length;
    await new Promise((r) => setTimeout(r, 300));
    await expect(k.jobs.create({ repo: '/repo', title: 'Third', body: 'x' })).rejects.toBeInstanceOf(StoreBrokenError);
    // Nothing written since: the first job was not failed, no second job exists, no new events, nothing started.
    expect((await inner.eventsAfter()).length).toBe(eventsAtBreak);
    expect((await inner.listJobs()).map((j) => j.title)).toEqual(['First']);
    expect((await inner.getJob(first.id))!.status).not.toBe('failed');
    expect(worker).toEqual([]);
    expect(errors.filter((e) => /record is unusable/.test(e))).toHaveLength(1);
  });
});

describe('an event that follows a saved state change is lost (D4)', () => {
  const eventAfter = (type: string, ms: number) => {
    let once = true;
    return (m: string, _n: number, args: unknown[]) => (m === 'appendEvent' && (args[0] as { type: string }).type === type && once ? ((once = false), ms) : 0);
  };

  it('a lost stage.requested fails the job with the reason, and closes the stage it opened', async () => {
    const worker: Sent[] = [];
    const store = slowStore(new SqliteStore(newDb()), { after: eventAfter('stage.requested', 300) });
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), fakeHuman().plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k.start();
    const job = await k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(async () => (await k.jobs.get(job.id))!.status === 'failed', 'the job to fail');
    const failure = (await k.history(job.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failure.payload as { reason: string }).reason).toMatch(/^could not announce stage.requested: .*did not finish within 100 ms/);
    expect(worker).toEqual([]);
    expect((await k.jobs.stages(job.id)).find((s) => s.name === 'plan')).toMatchObject({ status: 'failed' });
  });

  it('a lost approval.requested fails the job with the reason; nobody is left waiting on a question that was never asked', async () => {
    const human = fakeHuman();
    const store = slowStore(new SqliteStore(newDb()), { after: eventAfter('approval.requested', 300) });
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub([]), human.plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k.start();
    const job = await k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(async () => (await k.jobs.get(job.id))!.status === 'failed', 'the job to fail');
    const failure = (await k.history(job.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failure.payload as { reason: string }).reason).toMatch(/^could not announce approval.requested/);
    expect(human.requests).toHaveLength(0);
  });

  it('a lost commit.requested fails the job, closes the edit stage and forgets the held result, so the worktree is cleaned up', async () => {
    const human = fakeHuman();
    const store = slowStore(new SqliteStore(newDb()), { after: eventAfter('commit.requested', 300) });
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub([]), human.plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await k.start();
    const job = await k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => human.requests.length === 1, 'the plan question');
    human.grant(job.id, 'plan');
    await until(async () => (await k.jobs.get(job.id))!.status === 'failed', 'the job to fail');
    const failure = (await k.history(job.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failure.payload as { reason: string }).reason).toMatch(/^could not announce commit.requested/);
    expect((await k.jobs.stages(job.id)).find((s) => s.name === 'build')).toMatchObject({ status: 'failed' });
    await until(async () => (await k.history(job.id)).some((e) => e.type === 'worktree.cleanup.requested'), 'the cleanup request');
  });

  it('when the job cannot even be failed (the record is broken), it stays as it is and a restart does not ask the question again', async () => {
    // Known gap, left open on purpose: a re-ask would let an old card approve a later question, because a grant is not
    // bound to the stage it was asked for. That is fixed separately.
    const path = newDb();
    const inner = new SqliteStore(path);
    const store = slowStore(inner, { hang: (m, args) => m === 'appendEvent' && (args[0] as { type: string }).type === 'approval.requested' });
    const first = fakeHuman();
    const k1 = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub([]), first.plugin], {}, { store, storeTimeoutMs: 100, storeBrokenMs: 300 });
    await k1.start();
    const job = await k1.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => k1.bus['queue'].brokenError !== undefined, 'the queue to give up');
    await k1.stop();
    expect(first.requests).toHaveLength(0);

    const second = fakeHuman();
    const k2 = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, []), fakeGithub([]), second.plugin], {}, { store: new SqliteStore(path) });
    await k2.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(second.requests).toHaveLength(0);
    expect((await k2.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });
});

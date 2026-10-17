import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@bulig/core';
import { slowStore } from '../../../packages/core/test/slow-store.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, newDb, type Sent } from './harness.ts';

const PASS = 'All good.\nVERDICT: PASS';
const until = async (cond: () => Promise<boolean>, what: string, ms = 6000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('a store call that never answers (R1)', () => {
  it('fails the one job it belonged to with a clear reason, and the next job carries on', async () => {
    // The pipeline handles one event at a time. A call that never ends would hold every job behind it for good.
    let calls = 0;
    const store = slowStore(new SqliteStore(newDb()), { hang: (m) => m === 'startStage' && calls++ === 0 });
    const worker: Sent[] = [];
    const human = fakeHuman();
    const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), human.plugin], {}, { store, storeTimeoutMs: 150 });
    await k.start();

    const first = await k.jobs.create({ repo: '/repo', title: 'First', body: 'x' });
    const second = await k.jobs.create({ repo: '/repo', title: 'Second', body: 'x' });

    await until(async () => (await k.jobs.get(first.id))!.status === 'failed', 'the first job to fail');
    const failure = (await k.history(first.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failure.payload as { reason: string }).reason).toMatch(/did not finish within 150 ms/);

    await until(async () => (await k.jobs.get(second.id))!.status === 'awaiting_approval', 'the second job to reach its plan approval');
    expect(worker.filter((s) => s.jobId === second.id).map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect(worker.some((s) => s.jobId === first.id)).toBe(false);
  });
});

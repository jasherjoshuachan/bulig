import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStore, type Store } from '@bulig/core';
import type { BuligEvent } from '@bulig/plugin-sdk';
import { describePg, usePgServer, type PgDatabase } from '../../../packages/core/test/pg-throwaway.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, newDb, settle, type Sent } from './harness.ts';

// ADR 0010, addendum of 19 Oct 2026: the log is delivered a second time, as a standby that takes over (or a remote worker that
// redelivers) would do it. The pipeline must not open a second attempt of any stage, because the request for it would be dropped as
// already done and the attempt would sit running with nobody working on it.

const PASS = 'All good.\nVERDICT: PASS';

type Rig = Awaited<ReturnType<typeof rigOn>>;

async function rigOn(options: { store?: Store }) {
  const worker: Sent[] = [];
  const human = fakeHuman();
  const k = boot(newDb(), [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub([]), human.plugin], {}, options);
  return { k, worker, human };
}

/** Deliver every event in the log to the handlers again, in log order, and wait until they have all finished. */
async function redeliverAll(k: Rig['k']): Promise<BuligEvent[]> {
  const log = await k.bus.replay();
  for (const e of log) {
    (k.bus as unknown as { dispatch(e: BuligEvent): void }).dispatch(e);
    await settle(k);
  }
  return log;
}

const shape = async (k: Rig['k'], jobId: string) => (await k.jobs.stages(jobId)).map((s) => `${s.id}:${s.name}#${s.attempt}:${s.status}`);

async function scenario(r: Rig) {
  await r.k.start();
  await settle(r.k);
  const job = await r.k.jobs.create({ repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js' });
  await settle(r.k);
  expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  const before = await shape(r.k, job.id);
  const eventsBefore = (await r.k.bus.replay()).map((e) => e.id);

  await redeliverAll(r.k);

  expect(await shape(r.k, job.id)).toEqual(before); // no second attempt of anything, and nothing changed state
  expect((await r.k.bus.replay()).map((e) => e.id)).toEqual(eventsBefore); // nothing new in the log
  // (The fake worker hears stage.requested again, as any listener does. Fencing a worker that is handed a request twice is the worker's job, not the kernel's.)
  const running = (await r.k.jobs.stages(job.id)).filter((s) => s.status === 'running').map((s) => s.name);
  expect(running).toEqual(['approve-plan']); // the only attempt left open is the one a person is deciding on
  return job;
}

describe('pipeline-dev when the whole log is delivered again, on SqliteStore', () => {
  it('opens no stage a second time', async () => {
    await scenario(await rigOn({}));
  });
});

describePg('pipeline-dev when the whole log is delivered again, on PostgresStore', () => {
  const server = usePgServer();
  const dbs: PgDatabase[] = [];
  const stores: Store[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close().catch(() => {});
    for (const d of dbs.splice(0)) await d.drop();
  });

  it('opens no stage a second time', async () => {
    const db = await server().newDatabase();
    dbs.push(db);
    const store = await PostgresStore.open(db.url);
    stores.push(store);
    await scenario(await rigOn({ store }));
  });
});

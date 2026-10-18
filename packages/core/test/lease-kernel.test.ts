import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, LeaseHeldError, PostgresStore, SqliteStore, StoreBrokenError, type Store } from '../src/index.ts';
import { tempDb } from './helpers.ts';
import { pgSupport, usePgServer, type PgDatabase } from './pg-throwaway.ts';

// The kernel's side of the executor lease (ADR 0010): it takes the lease before any plugin runs, renews it from a path of its
// own, and stops writing the moment it cannot show the lease is still its own. Each rule runs on every adapter there is.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Adapter {
  name: string;
  skip: boolean;
  make(): Promise<Store>;
  /** A second store on the same record, standing in for the next kernel's. */
  peek(): Promise<Store>;
}
const server = usePgServer();
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});
let sqlitePath = '';
let pgDb: PgDatabase | undefined;
const ADAPTERS: Adapter[] = [
  {
    name: 'SqliteStore',
    skip: false,
    async make() {
      sqlitePath = tempDb();
      const s = new SqliteStore(sqlitePath);
      cleanups.push(() => s.close());
      return s;
    },
    async peek() {
      const s = new SqliteStore(sqlitePath);
      cleanups.push(() => s.close());
      return s;
    },
  },
  {
    name: 'PostgresStore',
    skip: !pgSupport.available,
    async make() {
      const db = (pgDb = await server().newDatabase());
      const s = await PostgresStore.open(db.url);
      cleanups.push(async () => {
        await s.close();
        await db.drop();
      });
      return s;
    },
    async peek() {
      const s = await PostgresStore.open(pgDb!.url, { mode: 'reader' });
      cleanups.push(() => s.close());
      return s;
    },
  },
];

/** A store with some of its lease calls replaced, for making the lease misbehave. */
function withLease(inner: Store, over: Partial<Pick<Store, 'renewLease' | 'acquireLease'>>): Store {
  const wrapped = Object.create(inner) as Store;
  Object.assign(wrapped, {
    // methods on the prototype need the real store as `this`
    transaction: inner.transaction.bind(inner),
    close: inner.close.bind(inner),
    abort: inner.abort?.bind(inner),
    schemaVersion: inner.schemaVersion.bind(inner),
    acquireLease: inner.acquireLease.bind(inner),
    renewLease: inner.renewLease.bind(inner),
    releaseLease: inner.releaseLease.bind(inner),
    ...over,
  });
  return wrapped;
}

function spyLogger() {
  const errors: string[] = [];
  const warns: string[] = [];
  return { errors, warns, logger: { debug() {}, info() {}, warn: (m: string) => void warns.push(m), error: (m: string) => void errors.push(m) } };
}

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`the kernel and the executor lease with ${adapter.name}`, () => {
    const kernelOn = (store: Store, extra: Partial<Parameters<typeof createKernel>[0]> = {}) => {
      const spy = spyLogger();
      const k = createKernel({ store, plugins: [], enabled: [], logger: spy.logger, ...extra });
      cleanups.push(() => k.stop());
      return { k, ...spy };
    };

    it('holds the lease from start to stop, and hands it back on stop so the next kernel need not wait', async () => {
      const store = await adapter.make();
      const { k } = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000 });
      await k.start();
      const other = await adapter.peek();
      const err = await other.acquireLease('someone-else', 5_000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseHeldError);
      expect((err as LeaseHeldError).holder).toBe('kernel-a');
      await k.stop();
      expect((await other.acquireLease('someone-else', 5_000)).generation).toBe(2);
    });

    it('does not start while another kernel holds the lease, and says why', async () => {
      const store = await adapter.make();
      const first = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000 });
      await first.k.start();
      const second = kernelOn(await adapter.peek(), { leaseHolder: 'kernel-b', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000, leaseWaitMs: 150 });
      await expect(second.k.start()).rejects.toBeInstanceOf(LeaseHeldError);
      expect(second.warns.join('\n')).toMatch(/kernel-a/);
    });

    it('waits for a dead kernel\'s lease to run out and then takes over with the next generation', async () => {
      const store = await adapter.make();
      // The first kernel starts and then dies without a goodbye: its store is cut and nothing is released.
      const dead = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: 600, leaseHeartbeatMs: 120 });
      await dead.k.start();
      await store.close(); // the process is gone: its heartbeat has nothing left to renew with, and nothing was handed back
      const next = kernelOn(await adapter.peek(), { leaseHolder: 'kernel-b', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000, leaseWaitMs: 3_000 });
      const began = Date.now();
      await next.k.start();
      expect(Date.now() - began).toBeGreaterThan(100); // it had to wait for the old one to run out
      const probe = await adapter.peek();
      expect((await probe.acquireLease('kernel-b', 5_000)).generation).toBe(3); // a=1, b=2, this re-acquire by the same holder=3
    });

    it('keeps renewing while a long task holds the queue, so the lease does not run out under a healthy kernel', async () => {
      const store = await adapter.make();
      const { k, errors } = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: 800, leaseHeartbeatMs: 150, storeTimeoutMs: 5_000 });
      await k.start();
      // A task that holds the queue for more than twice the length of the lease.
      const slow = k.jobs.atomic(async () => {
        await sleep(2_000);
      });
      await sleep(1_700); // twice past the original lease end
      await expect(store.acquireLease('rival', 300)).rejects.toBeInstanceOf(LeaseHeldError); // the lease is still the kernel's
      await slow;
      expect(errors).toEqual([]);
      const job = await k.jobs.create({ repo: 'r', title: 'still alive' }); // not broken
      expect(job.title).toBe('still alive');
    });

    it('stops writing at once, and says so, when a renewal is refused', async () => {
      const store = await adapter.make();
      const lost: string[] = [];
      let refuse = false;
      const flaky = withLease(store, { renewLease: async (h, g, t) => (refuse ? false : store.renewLease(h, g, t)) });
      const { k, errors } = kernelOn(flaky, { leaseHolder: 'kernel-a', leaseTtlMs: 1_000, leaseHeartbeatMs: 60, onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      await k.jobs.create({ repo: 'r', title: 'before' });
      refuse = true;
      await sleep(200);
      await expect(k.jobs.create({ repo: 'r', title: 'after' })).rejects.toBeInstanceOf(StoreBrokenError);
      expect(await (await adapter.peek()).listJobs()).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(errors.join('\n')).toMatch(/executor lease was lost/);
      expect(errors).toHaveLength(1); // one loud line, not one per refused call
    });

    it('stops writing when a renewal throws, and when one never comes back', async () => {
      for (const how of ['throws', 'hangs'] as const) {
        const store = await adapter.make();
        const lost: string[] = [];
        const bad = withLease(store, {
          renewLease: (h, g, t) => (how === 'throws' ? Promise.reject(new Error('connection reset')) : new Promise<boolean>(() => {})),
        });
        const { k } = kernelOn(bad, { leaseHolder: 'kernel-a', leaseTtlMs: 1_000, leaseHeartbeatMs: 60, onLeaseLost: (r) => void lost.push(r) });
        await k.start();
        await sleep(250);
        await expect(k.jobs.create({ repo: 'r', title: 'after' })).rejects.toBeInstanceOf(StoreBrokenError);
        expect(lost[0]).toMatch(how === 'throws' ? /connection reset/ : /did not come back/);
      }
    });

    it('refuses the next task, and writes nothing, when the lease was taken while a renewal still claimed to work', async () => {
      const store = await adapter.make();
      // The heartbeat is told "renewed" but nothing is renewed, so the lease runs out for real and a rival takes it.
      const liar = withLease(store, { renewLease: async () => true });
      const { k, errors } = kernelOn(liar, { leaseHolder: 'kernel-a', leaseTtlMs: 400, leaseHeartbeatMs: 80 });
      await k.start();
      await sleep(600);
      const rival = await adapter.peek();
      const taken = await rival.acquireLease('rival', 60_000);
      expect(taken.generation).toBe(2);
      await expect(k.jobs.create({ repo: 'r', title: 'late write' })).rejects.toBeInstanceOf(StoreBrokenError);
      await expect(k.jobs.create({ repo: 'r', title: 'and again' })).rejects.toBeInstanceOf(StoreBrokenError);
      expect(await rival.listJobs()).toEqual([]);
      expect(errors.join('\n')).toMatch(/executor lease was lost/);
    });

    it('refuses a heartbeat that is not well inside the lease', () => {
      expect(() => createKernel({ dbPath: tempDb(), plugins: [], enabled: [], leaseTtlMs: 1_000, leaseHeartbeatMs: 600 })).toThrow(/less than half/);
    });
  });
}

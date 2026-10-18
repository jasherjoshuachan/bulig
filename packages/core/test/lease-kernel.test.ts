import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, LeaseHeldError, PostgresStore, SqliteStore, StoreBrokenError, type Store } from '../src/index.ts';
import type { Plugin } from '@bulig/plugin-sdk';
import { manifest, tempDb } from './helpers.ts';
import { slowStore } from './slow-store.ts';
import { pgSupport, usePgServer, type PgDatabase } from './pg-throwaway.ts';

// The kernel's side of the executor lease (ADR 0010): it takes the lease before any plugin runs, renews it from a path of its
// own, and stops writing the moment it cannot show the lease is still its own. Each rule runs on every adapter there is.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A renewal must come back within one heartbeat or the lease counts as lost (kernel.ts), so a test with a heartbeat of a few
// tens of milliseconds fails when a loaded machine, or a Postgres call on a CI runner, is merely slow. These tests state every
// timing at the size that reads well, and `room` stretches all of them by one factor: the ratios, and so what each test proves,
// do not change. Only tests with a heartbeat under 300 ms need it.
const room = (ms: number) => ms * 4;

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

    it('lets go of the lease, and stops renewing it, when a plugin fails to start', async () => {
      const store = await adapter.make();
      let renewals = 0;
      const counted = withLease(store, {
        renewLease: async (h, g, t) => {
          renewals++;
          return store.renewLease(h, g, t);
        },
      });
      const bad: Plugin = {
        manifest: manifest({ name: 'bad', sdk: '1' }),
        register() {
          throw new Error('no thanks');
        },
      };
      const { k } = kernelOn(counted, { plugins: [bad], enabled: ['bad'], leaseHolder: 'kernel-a', leaseTtlMs: 5_000, leaseHeartbeatMs: 100 });
      await expect(k.start()).rejects.toThrow('no thanks');
      await sleep(30);
      const seen = renewals;
      await sleep(450); // four beats of a heartbeat that was left running
      expect(renewals).toBe(seen);
      // and the next kernel need not wait for the lease to run out
      expect((await (await adapter.peek()).acquireLease('kernel-b', 5_000)).generation).toBe(2);
    });

    it('keeps the lease alive while stop() drains the queue, so a clean stop with slow queued work reports no lost lease', async () => {
      const store = await adapter.make();
      const lost: string[] = [];
      const { k, errors } = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: 500, leaseHeartbeatMs: 100, stopWaitMs: 100, storeTimeoutMs: 5_000, onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      // Work that outlasts both the wait in stop() and the lease, and a task behind it that checks the lease only when it starts.
      void k.jobs.atomic(async () => {
        await sleep(1_200);
      });
      const behind = k.jobs.list();
      await k.stop();
      await expect(behind).resolves.toEqual([]);
      expect(lost).toEqual([]); // serve would have exited 1 on this
      expect(errors).toEqual([]);
      expect((await (await adapter.peek()).acquireLease('kernel-b', 5_000)).generation).toBe(2); // and the lease was handed back
    });

    it('does not ask the owner to exit non-zero for a lease lost while stopping', async () => {
      const store = await adapter.make();
      const lost: string[] = [];
      let refuse = false;
      const flaky = withLease(store, { renewLease: async (h, g, t) => (refuse ? false : store.renewLease(h, g, t)) });
      const { k, errors } = kernelOn(flaky, { leaseHolder: 'kernel-a', leaseTtlMs: 1_000, leaseHeartbeatMs: 60, stopWaitMs: 100, onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      k.jobs
        .atomic(async () => {
          await sleep(400);
        })
        .catch(() => {}); // the lease goes while it runs, so the queue gives up on it
      refuse = true;
      await k.stop();
      expect(lost).toEqual([]); // the process is already exiting cleanly
      expect(errors.join('\n')).toMatch(/executor lease was lost/); // but the log still says it
    });

    it('still tells the owner when the lease is lost before stop() began', async () => {
      const store = await adapter.make();
      const lost: string[] = [];
      let refuse = false;
      const flaky = withLease(store, { renewLease: async (h, g, t) => (refuse ? false : store.renewLease(h, g, t)) });
      const { k } = kernelOn(flaky, { leaseHolder: 'kernel-a', leaseTtlMs: 1_000, leaseHeartbeatMs: 60, onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      refuse = true;
      await sleep(250);
      expect(lost).toHaveLength(1);
      await k.stop();
      expect(lost).toHaveLength(1);
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
      const dead = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: room(600), leaseHeartbeatMs: room(120) });
      await dead.k.start();
      await store.close(); // the process is gone: its heartbeat has nothing left to renew with, and nothing was handed back
      const next = kernelOn(await adapter.peek(), { leaseHolder: 'kernel-b', leaseTtlMs: 5_000, leaseHeartbeatMs: 1_000, leaseWaitMs: room(3_000) });
      const began = Date.now();
      await next.k.start();
      expect(Date.now() - began).toBeGreaterThan(room(100)); // it had to wait for the old one to run out
      const probe = await adapter.peek();
      expect((await probe.acquireLease('kernel-b', 5_000)).generation).toBe(3); // a=1, b=2, this re-acquire by the same holder=3
    });

    it('keeps renewing while a long task holds the queue, so the lease does not run out under a healthy kernel', async () => {
      const store = await adapter.make();
      const { k, errors } = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: room(800), leaseHeartbeatMs: room(150), storeTimeoutMs: room(5_000) });
      await k.start();
      // A task that holds the queue for more than twice the length of the lease.
      const slow = k.jobs.atomic(async () => {
        await sleep(room(2_000));
      });
      await sleep(room(1_700)); // twice past the original lease end
      await expect(store.acquireLease('rival', room(300))).rejects.toBeInstanceOf(LeaseHeldError); // the lease is still the kernel's
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
      const { k, errors } = kernelOn(flaky, { leaseHolder: 'kernel-a', leaseTtlMs: room(1_000), leaseHeartbeatMs: room(60), onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      await k.jobs.create({ repo: 'r', title: 'before' });
      refuse = true;
      await sleep(room(200));
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
        const { k } = kernelOn(bad, { leaseHolder: 'kernel-a', leaseTtlMs: room(1_000), leaseHeartbeatMs: room(60), onLeaseLost: (r) => void lost.push(r) });
        await k.start();
        await sleep(room(250));
        await expect(k.jobs.create({ repo: 'r', title: 'after' })).rejects.toBeInstanceOf(StoreBrokenError);
        expect(lost[0]).toMatch(how === 'throws' ? /connection reset/ : /did not come back/);
      }
    });

    it('refuses the next task, and writes nothing, when the lease was taken while a renewal still claimed to work', async () => {
      const store = await adapter.make();
      // The heartbeat is told "renewed" but nothing is renewed, so the lease runs out for real and a rival takes it.
      const liar = withLease(store, { renewLease: async () => true });
      const lost: string[] = [];
      const { k, errors } = kernelOn(liar, { leaseHolder: 'kernel-a', leaseTtlMs: room(400), leaseHeartbeatMs: room(80), onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      await sleep(room(600));
      const rival = await adapter.peek();
      const taken = await rival.acquireLease('rival', 60_000);
      expect(taken.generation).toBe(2);
      await expect(k.jobs.create({ repo: 'r', title: 'late write' })).rejects.toBeInstanceOf(StoreBrokenError);
      await expect(k.jobs.create({ repo: 'r', title: 'and again' })).rejects.toBeInstanceOf(StoreBrokenError);
      expect(await rival.listJobs()).toEqual([]);
      expect(errors.join('\n')).toMatch(/executor lease was lost/);
      // The task noticed, not the heartbeat. The owner (serve) must still be told, once, so the process stops.
      expect(lost).toHaveLength(1);
    });

    it('tells the owner exactly once when the heartbeat and a task both find the lease gone', async () => {
      const store = await adapter.make();
      let mode: 'ok' | 'late-refusal' = 'ok';
      let renewalInFlight = false;
      const bothSee = withLease(store, {
        renewLease: (h, g, t) => {
          if (mode === 'ok') return Promise.resolve(true);
          renewalInFlight = true;
          return new Promise<boolean>((r) => setTimeout(() => r(false), room(40)));
        },
      });
      const lost: string[] = [];
      const { k } = kernelOn(bothSee, { leaseHolder: 'kernel-a', leaseTtlMs: room(400), leaseHeartbeatMs: room(80), onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      await sleep(room(600)); // the lease runs out behind a renewal that claimed to work
      const rival = await adapter.peek();
      await rival.acquireLease('rival', 60_000);
      mode = 'late-refusal';
      // Wait until a renewal is in flight, then let a task reach its own check before that renewal answers.
      for (let i = 0; i < 100 && !renewalInFlight; i++) await sleep(room(5));
      expect(renewalInFlight).toBe(true);
      await expect(k.jobs.create({ repo: 'r', title: 'late write' })).rejects.toBeInstanceOf(StoreBrokenError);
      await sleep(room(150)); // the renewal now answers "refused" as well
      expect(lost).toHaveLength(1);
    });

    it('stops renewing the lease once the queue is broken for another reason (a store call that never returns)', async () => {
      const real = await adapter.make();
      let stuck = false;
      let renewals = 0;
      const store = slowStore(real, { hang: (m) => stuck && m === 'getJob' });
      store.renewLease = (h, g, t) => {
        renewals++;
        return real.renewLease(h, g, t);
      };
      const lost: string[] = [];
      const { k, errors } = kernelOn(store, { leaseHolder: 'kernel-a', leaseTtlMs: room(2_000), leaseHeartbeatMs: room(200), storeTimeoutMs: room(160), storeBrokenMs: room(320), onLeaseLost: (r) => void lost.push(r) });
      await k.start();
      await sleep(room(720));
      expect(renewals).toBeGreaterThan(1); // it is beating
      stuck = true;
      await expect(k.jobs.get('nope')).rejects.toThrow();
      await sleep(room(1_000));
      expect(errors.join('\n')).toMatch(/Nothing more will be written/);
      const after = renewals;
      await sleep(room(1_600));
      expect(renewals).toBe(after); // the beat stopped with the queue
      expect(lost).toEqual([]); // and this was not a lost lease
    });

    it('refuses a heartbeat that is not well inside the lease', () => {
      expect(() => createKernel({ dbPath: tempDb(), plugins: [], enabled: [], leaseTtlMs: 1_000, leaseHeartbeatMs: 600 })).toThrow(/less than half/);
    });
  });
}

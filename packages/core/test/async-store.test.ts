import { describe, expect, it } from 'vitest';
import { CapabilityDeniedError, definePlugin, type PluginContext } from '@bulig/plugin-sdk';
import { SqliteStore, StoreTimeoutError } from '../src/index.ts';
import { kernelWith, manifest, probe, tempDb } from './helpers.ts';
import { slowStore } from './slow-store.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const types = (events: { type: string }[], prefix: string) => events.map((e) => e.type).filter((t) => t.startsWith(prefix));

// Calls that take uneven time, so a call that was made earlier can easily finish later. Anything that
// relies on "the store answers at once" shows up here.
const UNEVEN_BEFORE = [9, 1, 6, 2, 8, 1, 4, 0];
const UNEVEN_AFTER = [1, 7, 0, 5, 2, 6, 0, 3];

describe('events with a slow store (ADR 0002)', () => {
  it('are delivered in log order, only after they are in the log, and the log is in the order they were emitted', async () => {
    const store = slowStore(new SqliteStore(tempDb()), {
      before: (_m, n) => UNEVEN_BEFORE[n % 8]!,
      after: (_m, n) => UNEVEN_AFTER[n % 8]!,
    });
    const delivered: string[] = [];
    const early: string[] = [];
    const box: { ctx?: PluginContext } = {};
    const plugin = definePlugin({
      manifest: manifest({ name: 'a', subscribes: ['x.*'], emits: ['x.1', 'x.2', 'x.3', 'x.4', 'x.5', 'x.6', 'x.inner'] }),
      register(ctx) {
        box.ctx = ctx;
        ctx.on('x.*', (e) => {
          delivered.push(e.type);
          // The store reports an event as logged the moment it has it. A handler must never be ahead of that.
          if (!store.logged.has(e.id)) early.push(e.type);
          if (e.type === 'x.2') ctx.emit('x.inner', null);
        });
      },
    });
    const k = kernelWith({ plugins: [plugin], store });
    await k.start();
    for (const t of ['x.1', 'x.2', 'x.3', 'x.4', 'x.5', 'x.6']) box.ctx!.emit(t, null);
    await k.bus.idle();

    // x.inner was emitted while x.2 was being delivered, so it is queued behind x.3 to x.6, which were already waiting.
    const expected = ['x.1', 'x.2', 'x.3', 'x.4', 'x.5', 'x.6', 'x.inner'];
    expect(types(await k.bus.replay(), 'x.')).toEqual(expected);
    expect(delivered).toEqual(expected);
    expect(early).toEqual([]);
    const seqs = (await k.bus.replay()).map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('do not wait for a handler that is still working', async () => {
    const store = slowStore(new SqliteStore(tempDb()), { before: 2, after: 2 });
    const order: string[] = [];
    const box: { ctx?: PluginContext } = {};
    const plugin = definePlugin({
      manifest: manifest({ name: 'a', subscribes: ['x.*'], emits: ['x.slow', 'x.fast'] }),
      register(ctx) {
        box.ctx = ctx;
        ctx.on('x.slow', async () => {
          order.push('slow starts');
          await sleep(150);
          order.push('slow ends');
        });
        ctx.on('x.fast', () => void order.push('fast'));
      },
    });
    const k = kernelWith({ plugins: [plugin], store });
    await k.start();
    box.ctx!.emit('x.slow', null);
    box.ctx!.emit('x.fast', null);
    await k.bus.idle();
    expect(order).toEqual(['slow starts', 'fast', 'slow ends']);
  });

  it('an undeclared event or a denied capability still throws in the caller, before anything is written', async () => {
    const { plugin, box } = probe({ emits: ['demo.ok', 'approval.granted'] });
    const store = slowStore(new SqliteStore(tempDb()), { before: 3 });
    const k = kernelWith({ plugins: [plugin], store });
    await k.start();
    const before = (await k.bus.replay()).length;
    expect(() => box.ctx!.emit('demo.nope', null)).toThrow(/did not declare/);
    expect(() => box.ctx!.emit('approval.granted', null)).toThrow(CapabilityDeniedError);
    await k.bus.idle();
    expect((await k.bus.replay()).length).toBe(before);
  });
});

describe('capability checks with a slow store (ADR 0003)', () => {
  it('a cancel and a status change that race on one job leave the job cancelled', async () => {
    const { plugin, box } = probe({ needs: ['jobs.write'] });
    const store = slowStore(new SqliteStore(tempDb()), { before: 3, after: 3 });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['jobs.write'] }, store });
    await k.start();
    const job = await k.jobs.create({ repo: '/r', title: 't' });

    // Both calls are made before either has finished. If the second one read the job before the first one wrote,
    // it would see "queued", pass the check, and undo the cancel.
    const cancel = box.ctx!.jobs.setStatus(job.id, 'cancelled');
    const reopen = box.ctx!.jobs.setStatus(job.id, 'running');
    const [a, b] = await Promise.allSettled([cancel, reopen]);

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(CapabilityDeniedError);
    expect((b as PromiseRejectedResult).reason.message).toMatch(/cancelled is final/);
    expect((await k.jobs.get(job.id))!.status).toBe('cancelled');
    // And the log tells the same story: one change, no second one.
    const changes = (await k.history(job.id)).filter((e) => e.type === 'job.status').map((e) => (e.payload as { to: string }).to);
    expect(changes).toEqual(['cancelled']);
  });
});

describe('a store call that never finishes (R1)', () => {
  it('times out with a clear error, and the next call goes through', async () => {
    const { plugin, box } = probe();
    let hung = 0;
    const store = slowStore(new SqliteStore(tempDb()), { hang: (m) => m === 'getJob' && hung++ === 0 });
    const k = kernelWith({ plugins: [plugin], store, storeTimeoutMs: 60 });
    await k.start();
    const job = await k.jobs.create({ repo: '/r', title: 't' });

    const stuck = box.ctx!.jobs.get(job.id);
    const behind = box.ctx!.jobs.list(); // queued behind the stuck call
    const outcome = await Promise.race([Promise.allSettled([stuck, behind]), sleep(2000).then(() => 'stalled' as const)]);

    expect(outcome).not.toBe('stalled');
    const [a, b] = outcome as PromiseSettledResult<unknown>[];
    expect(a!.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(StoreTimeoutError);
    expect((a as PromiseRejectedResult).reason.message).toMatch(/did not finish within 60 ms/);
    expect(b!.status).toBe('fulfilled');
    expect((await box.ctx!.jobs.get(job.id))?.id).toBe(job.id);
  });

  it('a task that was given up on cannot write afterwards', async () => {
    const { plugin } = probe();
    // The read takes longer than the deadline, then answers. The task would write next.
    let slowOnce = false;
    const store = slowStore(new SqliteStore(tempDb()), { before: (m) => (m === 'getJob' && slowOnce ? ((slowOnce = false), 150) : 0) });
    const k = kernelWith({ plugins: [plugin], store, storeTimeoutMs: 40 });
    await k.start();
    const job = await k.jobs.create({ repo: '/r', title: 't' });
    slowOnce = true;

    await expect(
      k.jobs.atomic(async (tx) => {
        await tx.get(job.id);
        await tx.setStatus(job.id, 'failed');
      }),
    ).rejects.toBeInstanceOf(StoreTimeoutError);
    await sleep(300);
    expect((await k.jobs.get(job.id))!.status).toBe('queued');
  });

  it('an event that could not be written is reported, and nothing is delivered for it', async () => {
    const errors: string[] = [];
    const delivered: string[] = [];
    const box: { ctx?: PluginContext } = {};
    const plugin = definePlugin({
      manifest: manifest({ name: 'a', subscribes: ['x.*'], emits: ['x.lost', 'x.kept'] }),
      register(ctx) {
        box.ctx = ctx;
        ctx.on('x.*', (e) => void delivered.push(e.type));
      },
    });
    const store = slowStore(new SqliteStore(tempDb()), { hang: (m, args) => m === 'appendEvent' && (args[0] as { type: string }).type === 'x.lost' });
    const k = kernelWith({ plugins: [plugin], store, storeTimeoutMs: 50, logger: { debug() {}, info() {}, warn() {}, error: (m) => void errors.push(m) } });
    await k.start();
    box.ctx!.emit('x.lost', null);
    box.ctx!.emit('x.kept', null);
    await k.bus.idle();
    expect(delivered).toEqual(['x.kept']);
    expect(errors.join('\n')).toMatch(/Could not write event "x.lost"/);
  });
});

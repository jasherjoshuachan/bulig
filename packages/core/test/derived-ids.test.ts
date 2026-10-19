import { describe, expect, it } from 'vitest';
import type { BuligEvent, Job, Plugin, PluginContext } from '@bulig/plugin-sdk';
import { createKernel, derivedEventId, type Store } from '../src/index.ts';
import { manifest } from './helpers.ts';
import { useKernelAdapters } from './kernel-adapters.ts';

// ADR 0010, addendum of 18 Oct 2026: an event a handler writes gets an id derived from the event it was handling, so a handler
// run twice for one event writes each event once. Each rule runs on every adapter there is.

const { adapters, cleanups } = useKernelAdapters();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Make the kernel hear an event again, as if its handlers were run a second time (a restart that replays it, or a bug that dispatches twice). */
const redeliver = (k: ReturnType<typeof createKernel>, e: BuligEvent) => (k.bus as unknown as { dispatch(e: BuligEvent): void }).dispatch(e);

describe('derivedEventId', () => {
  it('is a UUID, the same for the same inputs, and different when any one input differs', () => {
    const id = derivedEventId('evt-1', 'demo#0', 0, 'demo.one');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedEventId('evt-1', 'demo#0', 0, 'demo.one')).toBe(id);
    for (const other of [
      derivedEventId('evt-2', 'demo#0', 0, 'demo.one'),
      derivedEventId('evt-1', 'demo#1', 0, 'demo.one'),
      derivedEventId('evt-1', 'demo#0', 1, 'demo.one'),
      derivedEventId('evt-1', 'demo#0', 0, 'demo.two'),
    ]) {
      expect(other).not.toBe(id);
    }
  });
});

for (const adapter of adapters) {
  describe.skipIf(adapter.skip)(`events caused by a handler, with ${adapter.name}`, () => {
    /** A plugin whose handler for demo.go writes two events, makes a job, and moves it on. `runs` records what each run was told. */
    function setup(store: Store, extra: Plugin[] = [], before: Plugin[] = []) {
      const runs: { job: Job; moved: Job }[] = [];
      const heard: string[] = [];
      const errors: string[] = [];
      const demo: Plugin = {
        manifest: manifest({ name: 'demo', sdk: '1', subscribes: ['demo.go', 'demo.one', 'demo.two', 'plugin.error'], emits: ['demo.one', 'demo.two'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.go', async () => {
            await ctx.emitCommitted('demo.one', { n: 1 });
            await ctx.emitCommitted('demo.two', { n: 2 });
            await ctx.emitCommitted('demo.one', { n: 3 });
            const job = await ctx.jobs.create({ repo: 'r', title: 'made by a handler' });
            const moved = await ctx.jobs.setStatus(job.id, 'running');
            runs.push({ job, moved });
          });
          ctx.on('demo.one', (e) => void heard.push(`${e.type}:${JSON.stringify(e.payload)}`));
          ctx.on('demo.two', (e) => void heard.push(`${e.type}:${JSON.stringify(e.payload)}`));
          ctx.on('plugin.error', (e) => void errors.push(JSON.stringify(e.payload)));
        },
      };
      const k = createKernel({ store, plugins: [...before, demo, ...extra], enabled: [...before, demo, ...extra].map((p) => p.manifest.name), logger: quiet });
      cleanups.push(() => k.stop());
      return { k, runs, heard, errors };
    }
    const typesOf = (events: BuligEvent[]) => events.map((e) => e.type).filter((t) => t !== 'kernel.started');

    it('writes each event once when a handler runs twice for the same event, and delivers nothing twice', async () => {
      const store = await adapter.make();
      const { k, runs, heard, errors } = setup(store);
      await k.start();
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.settle();
      await k.bus.idle();
      const first = await k.bus.replay();
      expect(typesOf(first)).toEqual(['demo.go', 'demo.one', 'demo.two', 'demo.one', 'job.created', 'job.status']);
      expect(heard).toHaveLength(3);

      redeliver(k, first.find((e) => e.type === 'demo.go')!);
      await k.bus.idle();
      const second = await k.bus.replay();
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id)); // not one event more, same ids
      expect(heard).toHaveLength(3); // and no handler heard anything a second time
      expect(errors).toEqual([]); // the second run carried on and did not fail
      expect(runs).toHaveLength(2); // it ran to the end
    });

    it('commits nothing extra on a replay: the job a rolled-back task made is gone, and the call answers with the first one', async () => {
      const store = await adapter.make();
      const { k, runs } = setup(store);
      await k.start();
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.idle();
      const go = (await k.bus.replay()).find((e) => e.type === 'demo.go')!;
      redeliver(k, go);
      await k.bus.idle();
      const peek = await adapter.peek();
      expect(await peek.listJobs()).toHaveLength(1);
      expect(runs).toHaveLength(2);
      expect(runs[1]!.job.id).toBe(runs[0]!.job.id); // the replayed create answers with the job the first run made
      expect(runs[1]!.moved.id).toBe(runs[0]!.job.id);
      expect(runs[1]!.moved.status).toBe('running');
    });

    it('never gives two different emits the same id: same type twice, two plugins, two handlers of one plugin', async () => {
      const store = await adapter.make();
      const twin: Plugin = {
        manifest: manifest({ name: 'twin', sdk: '1', subscribes: ['demo.go'], emits: ['demo.one'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.go', () => ctx.emitCommitted('demo.one', { from: 'twin first' }));
          ctx.on('demo.go', () => ctx.emitCommitted('demo.one', { from: 'twin second' }));
        },
      };
      const { k, heard } = setup(store, [twin]);
      await k.start();
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.idle();
      const all = await k.bus.replay();
      const ids = all.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(all.filter((e) => e.type === 'demo.one')).toHaveLength(4); // 2 from demo, 2 from twin
      expect(heard.filter((h) => h.startsWith('demo.one'))).toHaveLength(4);
    });

    it('gives two handler runs on two different events different ids, even with the same position and type', async () => {
      const store = await adapter.make();
      const { k } = setup(store);
      await k.start();
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.idle();
      const all = await k.bus.replay();
      expect(all.filter((e) => e.type === 'demo.one')).toHaveLength(4);
      expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    });

    it('records a failing subscriber as the kernel and not as the handler that emitted: no cause, no ordinal taken, and a redelivery changes nothing', async () => {
      const store = await adapter.make();
      const a: Plugin = {
        manifest: manifest({ name: 'a', sdk: '1', subscribes: ['demo.go'], emits: ['demo.one', 'demo.two'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.go', async () => {
            await ctx.emitCommitted('demo.one', { n: 1 });
            await ctx.emitCommitted('demo.two', { n: 2 });
          });
        },
      };
      const b: Plugin = {
        manifest: manifest({ name: 'b', sdk: '1', subscribes: ['demo.one'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.one', () => {
            throw new Error('b broke');
          });
        },
      };
      const k = createKernel({ store, plugins: [a, b], enabled: ['a', 'b'], logger: quiet });
      cleanups.push(() => k.stop());
      // Watch the cause that is current when the kernel asks for a plugin.error: it must be none.
      const causeAtFail: unknown[] = [];
      const realEmit = k.bus.emit.bind(k.bus);
      k.bus.emit = ((input, options) => {
        if (input.type === 'plugin.error') causeAtFail.push(k.bus.currentCause());
        return realEmit(input, options);
      }) as typeof k.bus.emit;
      await k.start();
      await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.idle();
      const first = await k.bus.replay();
      const go = first.find((e) => e.type === 'demo.go')!;
      const one = first.find((e) => e.type === 'demo.one')!;
      const two = first.find((e) => e.type === 'demo.two')!;
      const error = first.find((e) => e.type === 'plugin.error')!;
      expect(causeAtFail).toEqual([undefined]);
      expect(one.id).toBe(derivedEventId(go.id, 'a#0', 0, 'demo.one'));
      expect(two.id).toBe(derivedEventId(go.id, 'a#0', 1, 'demo.two')); // the failure did not take ordinal 1 from a
      expect(error.id).not.toBe(derivedEventId(go.id, 'a#0', 1, 'demo.two'));
      expect(error.payload).toMatchObject({ plugin: 'b', eventId: one.id, message: 'b broke' });

      redeliver(k, go);
      await k.bus.idle();
      const second = await k.bus.replay();
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id)); // same ids, no second demo.two, no second plugin.error
      expect(second.filter((e) => e.type === 'demo.two')).toHaveLength(1);

      // The same subscriber failing on the same event again is the same plugin.error, and is written once.
      redeliver(k, one);
      await k.bus.idle();
      expect((await k.bus.replay()).map((e) => e.id)).toEqual(first.map((e) => e.id));
      expect(causeAtFail).toEqual([undefined, undefined]);
    });

    it('keeps a plugin\'s handler keys when another plugin is enabled, so ids written before a restart still match after it', async () => {
      const idsWith = async (before: Plugin[]) => {
        const store = await adapter.make();
        const { k } = setup(store, [], before);
        await k.start();
        const go = await k.bus.emit({ type: 'demo.go', source: 'test' });
        await k.bus.idle();
        const events = await k.bus.replay();
        await k.stop();
        return { go, ids: events.filter((e) => e.type.startsWith('demo.') && e.type !== 'demo.go').map((e) => e.id) };
      };
      const first = await idsWith([]);
      const early: Plugin = {
        manifest: manifest({ name: 'early', sdk: '1', subscribes: ['demo.go', 'demo.one'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.go', () => {});
          ctx.on('demo.one', () => {});
        },
      };
      // Registered ahead of demo, so under the old global numbering demo's handlers would have moved from #0 to #2.
      const second = await idsWith([early]);
      // Ids derive from the go event's id, which is random, so compare against the derivation for each run's own go event.
      for (const run of [first, second]) {
        const expected = [0, 1, 2].map((n) => derivedEventId(run.go.id, 'demo#0', n, ['demo.one', 'demo.two', 'demo.one'][n]!));
        expect(run.ids).toEqual(expected);
      }
    });

    it('leaves events with no cause on random ids', async () => {
      const store = await adapter.make();
      const { k } = setup(store);
      await k.start();
      const a = await k.bus.emit({ type: 'demo.go', source: 'test' });
      const b = await k.bus.emit({ type: 'demo.go', source: 'test' });
      await k.bus.idle();
      expect(a.id).not.toBe(b.id);
      const started = (await k.bus.replay()).find((e) => e.type === 'kernel.started')!;
      for (const e of [a, b, started]) expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/); // v4, not the derived v8
    });

    it('treats an event written under an id the source gave as already done when that id is in the log', async () => {
      const store = await adapter.make();
      const { k, heard } = setup(store);
      await k.start();
      const one = await k.bus.emit({ type: 'demo.one', source: 'test', id: 'external-1', payload: { n: 'a' } });
      const again = await k.bus.emit({ type: 'demo.one', source: 'test', id: 'external-1', payload: { n: 'b' } });
      await k.bus.idle();
      expect(again.id).toBe(one.id);
      expect(again.payload).toEqual({ n: 'a' }); // the first stays
      expect(heard).toEqual(['demo.one:{"n":"a"}']);
      expect((await k.bus.replay()).filter((e) => e.type === 'demo.one')).toHaveLength(1);
    });
  });
}

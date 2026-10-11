import { describe, expect, it } from 'vitest';
import {
  CapabilityDeniedError,
  DuplicatePluginError,
  SdkVersionMismatchError,
  UndeclaredEventError,
  UndeclaredSubscriptionError,
  definePlugin,
  type BuligEvent,
} from '@bulig/plugin-sdk';
import { DEFAULT_EVENT_CAPABILITIES } from '../src/index.ts';
import { kernelWith, manifest, probe, tempDb } from './helpers.ts';

const types = (events: BuligEvent[]) => events.map((e) => e.type);

describe('events and subscriptions', () => {
  it('start emits kernel.started and jobs emit job.* events in order', async () => {
    const k = kernelWith({ plugins: [] });
    await k.start();
    const job = k.jobs.create({ repo: 'r', title: 't' });
    k.jobs.setStatus(job.id, 'running');
    expect(types(k.bus.replay())).toEqual(['kernel.started', 'job.created', 'job.status']);
    expect(k.bus.replay().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('wildcard subscribe matches by prefix, exact only matches exactly', async () => {
    const seen: string[] = [];
    const exact: string[] = [];
    const k = kernelWith({
      plugins: [
        definePlugin({
          manifest: manifest({ subscribes: ['job.*', 'kernel.started'] }),
          register(ctx) {
            ctx.on('job.*', (e) => void seen.push(e.type));
            ctx.on('kernel.started', (e) => void exact.push(e.type));
          },
        }),
      ],
    });
    await k.start();
    const job = k.jobs.create({ repo: 'r', title: 't' });
    k.jobs.setStatus(job.id, 'done');
    expect(seen).toEqual(['job.created', 'job.status']);
    expect(exact).toEqual(['kernel.started']);
  });

  it('a plugin can emit, and subscribers get it in log order', async () => {
    const order: string[] = [];
    const k = kernelWith({
      plugins: [
        definePlugin({
          manifest: manifest({ name: 'a', subscribes: ['kernel.started'], emits: ['a.hello'] }),
          register(ctx) {
            ctx.on('kernel.started', () => {
              ctx.emit('a.hello', { hi: true });
              order.push('a handler done');
            });
          },
        }),
        definePlugin({
          manifest: manifest({ name: 'b', subscribes: ['a.*'] }),
          register(ctx) {
            ctx.on('a.*', (e) => void order.push(`b got ${e.type} from ${e.source}`));
          },
        }),
      ],
    });
    await k.start();
    expect(order).toEqual(['a handler done', 'b got a.hello from a']);
  });

  it('undeclared emit throws', async () => {
    const { plugin, box } = probe({ emits: ['demo.ok'] });
    const k = kernelWith({ plugins: [plugin] });
    await k.start();
    expect(() => box.ctx!.emit('demo.ok', 1)).not.toThrow();
    expect(() => box.ctx!.emit('demo.nope', 1)).toThrow(UndeclaredEventError);
    expect(types(k.bus.replay())).not.toContain('demo.nope');
  });

  it('undeclared subscribe throws', async () => {
    const { plugin, box } = probe({ subscribes: ['stage.started'] });
    const k = kernelWith({ plugins: [plugin] });
    await k.start();
    expect(() => box.ctx!.on('stage.finished', () => {})).toThrow(UndeclaredSubscriptionError);
    expect(() => box.ctx!.on('stage.*', () => {})).toThrow(UndeclaredSubscriptionError);
    expect(() => box.ctx!.on('stage.started', () => {})).not.toThrow();
  });

  it('a throwing handler produces plugin.error and the bus keeps working', async () => {
    const after: string[] = [];
    const k = kernelWith({
      plugins: [
        definePlugin({
          manifest: manifest({ name: 'bad', subscribes: ['job.created'] }),
          register(ctx) {
            ctx.on('job.created', () => {
              throw new Error('boom');
            });
          },
        }),
        definePlugin({
          manifest: manifest({ name: 'good', subscribes: ['job.*', 'plugin.error'] }),
          register(ctx) {
            ctx.on('job.*', (e) => void after.push(e.type));
            ctx.on('plugin.error', (e) => void after.push(`error:${(e.payload as { message: string }).message}`));
          },
        }),
      ],
    });
    await k.start();
    const job = k.jobs.create({ repo: 'r', title: 't' });
    k.jobs.setStatus(job.id, 'running');
    expect(after).toEqual(['job.created', 'error:boom', 'job.status']);
    const err = k.bus.replay().find((e) => e.type === 'plugin.error')!;
    expect(err.source).toBe('kernel');
    expect(err.payload).toMatchObject({ plugin: 'bad', eventType: 'job.created' });
  });

  it('a rejected async handler also becomes plugin.error', async () => {
    const k = kernelWith({
      plugins: [
        definePlugin({
          manifest: manifest({ subscribes: ['kernel.started'] }),
          register(ctx) {
            ctx.on('kernel.started', async () => {
              throw new Error('late');
            });
          },
        }),
      ],
    });
    await k.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(types(k.bus.replay())).toContain('plugin.error');
  });

  it('history(jobId) returns only that job\'s events', async () => {
    const k = kernelWith({ plugins: [] });
    await k.start();
    const a = k.jobs.create({ repo: 'r', title: 'a' });
    const b = k.jobs.create({ repo: 'r', title: 'b' });
    k.jobs.setStatus(a.id, 'running');
    expect(types(k.history(a.id))).toEqual(['job.created', 'job.status']);
    expect(types(k.history(b.id))).toEqual(['job.created']);
    expect(k.history(a.id).every((e) => e.jobId === a.id)).toBe(true);
  });
});

describe('capabilities', () => {
  it('denied when not declared', async () => {
    const { plugin, box } = probe({ needs: [] });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['git.push'] } });
    await k.start();
    expect(box.ctx!.can('git.push')).toBe(false);
    expect(() => box.ctx!.require('git.push')).toThrow(CapabilityDeniedError);
  });

  it('denied when declared but not granted', async () => {
    const { plugin, box } = probe({ needs: ['git.push'] });
    const k = kernelWith({ plugins: [plugin], grants: {} });
    await k.start();
    expect(box.ctx!.can('git.push')).toBe(false);
    expect(() => box.ctx!.require('git.push')).toThrow(/declared but not granted/);
  });

  it('allowed when declared and granted, scoped capabilities match exactly', async () => {
    const { plugin, box } = probe({ needs: ['git.push', 'channel.send:owner-dm'] });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['git.push', 'channel.send:other'] } });
    await k.start();
    expect(box.ctx!.can('git.push')).toBe(true);
    expect(() => box.ctx!.require('git.push')).not.toThrow();
    expect(box.ctx!.can('channel.send:owner-dm')).toBe(false);
  });
});

describe('stop', () => {
  it('waits for an async handler that is still working, so it can still write its event', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const outcome: { emitted?: boolean; error?: unknown } = {};
    const k = kernelWith({
      plugins: [
        definePlugin({
          manifest: manifest({ subscribes: ['kernel.started'], emits: ['demo.late'] }),
          register(ctx) {
            ctx.on('kernel.started', async () => {
              await gate;
              try {
                ctx.emit('demo.late', {});
                outcome.emitted = true;
              } catch (err) {
                outcome.error = err;
              }
            });
          },
        }),
      ],
    });
    await k.start();
    const stopping = k.stop();
    setTimeout(release, 60);
    await stopping;
    expect(outcome.error).toBeUndefined();
    expect(outcome.emitted).toBe(true);
  });
});

describe('capabilities needed to emit an event', () => {
  const rogue = (over: Parameters<typeof manifest>[0] = {}) =>
    probe({ emits: ['approval.granted', 'approval.denied', 'merge.requested', 'demo.free'], ...over });

  it('a plugin with the event in emits but no grant is refused, and nothing is written', async () => {
    const { plugin, box } = rogue({ needs: ['approval.grant', 'merge.request'] });
    const k = kernelWith({ plugins: [plugin], grants: {} });
    await k.start();
    for (const type of ['approval.granted', 'approval.denied']) {
      expect(() => box.ctx!.emit(type, { jobId: 'j', kind: 'plan' }, 'j')).toThrow(CapabilityDeniedError);
      expect(() => box.ctx!.emit(type, {}, 'j')).toThrow(/approval\.grant/);
    }
    expect(() => box.ctx!.emit('merge.requested', { number: 1 }, 'j')).toThrow(/merge\.request/);
    expect(types(k.bus.replay())).not.toContain('approval.granted');
    expect(types(k.bus.replay())).not.toContain('merge.requested');
  });

  it('declaring the event is not enough without declaring the capability, even if the config grants it', async () => {
    const { plugin, box } = rogue({ needs: [] });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['approval.grant', 'merge.request'] } });
    await k.start();
    expect(() => box.ctx!.emit('approval.granted', {}, 'j')).toThrow(CapabilityDeniedError);
  });

  it('a plugin that declares and is granted the capability can emit; other events stay free', async () => {
    const { plugin, box } = rogue({ needs: ['approval.grant'] });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['approval.grant'] } });
    await k.start();
    expect(() => box.ctx!.emit('approval.granted', { jobId: 'j', kind: 'plan' }, 'j')).not.toThrow();
    expect(() => box.ctx!.emit('approval.denied', { jobId: 'j' }, 'j')).not.toThrow();
    expect(() => box.ctx!.emit('merge.requested', {}, 'j')).toThrow(/merge\.request/);
    expect(() => box.ctx!.emit('demo.free', {}, 'j')).not.toThrow();
  });

  it('the map is configurable: a new rule is enforced, and a default can be replaced', async () => {
    const { plugin, box } = probe({ emits: ['demo.free', 'approval.granted'], needs: ['demo.special'] });
    const k = kernelWith({
      plugins: [plugin],
      grants: { demo: ['demo.special'] },
      eventCapabilities: { 'demo.free': 'demo.special', 'approval.granted': 'approval.other' },
    });
    await k.start();
    expect(() => box.ctx!.emit('demo.free', {}, 'j')).not.toThrow();
    expect(() => box.ctx!.emit('approval.granted', {}, 'j')).toThrow(/approval\.other/);
    const { plugin: p2, box: b2 } = probe({ emits: ['demo.free'] });
    const k2 = kernelWith({ plugins: [p2], eventCapabilities: { 'demo.free': 'demo.special' } });
    await k2.start();
    expect(() => b2.ctx!.emit('demo.free', {}, 'j')).toThrow(/demo\.special/);
  });

  it('the defaults cover approvals and merge requests', () => {
    expect(DEFAULT_EVENT_CAPABILITIES).toEqual({
      'approval.granted': 'approval.grant',
      'approval.denied': 'approval.grant',
      'merge.requested': 'merge.request',
      'cancel.requested': 'approval.grant',
    });
  });
});

describe('loader', () => {
  it('skips a disabled plugin and the others still run', async () => {
    const ran: string[] = [];
    const mk = (name: string) =>
      definePlugin({ manifest: manifest({ name }), register: () => void ran.push(name) });
    const k = kernelWith({ plugins: [mk('one'), mk('two'), mk('three')], enabled: ['one', 'three'] });
    await k.start();
    expect(ran).toEqual(['one', 'three']);
    expect(types(k.bus.replay())).toContain('kernel.started');
  });

  it('rejects duplicate plugin names', async () => {
    const k = kernelWith({ plugins: [probe().plugin, probe().plugin], enabled: ['demo'] });
    await expect(k.start()).rejects.toThrow(DuplicatePluginError);
  });

  it('rejects an sdk major mismatch', async () => {
    const k = kernelWith({ plugins: [probe({ sdk: '9' }).plugin] });
    await expect(k.start()).rejects.toThrow(SdkVersionMismatchError);
  });

  it('loads sdk 1 quietly and sdk 0 with a deprecation warning', async () => {
    const warns: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => void warns.push(m), error() {} };
    const one = kernelWith({ plugins: [probe({ sdk: '1' }).plugin], logger });
    await one.start();
    expect(warns).toEqual([]);
    const zero = kernelWith({ plugins: [probe({ sdk: '0' }).plugin], logger });
    await zero.start();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/sdk 0.*deprecated/);
  });

  it('rejects an invalid manifest and plugins that emit kernel events', async () => {
    const bad = kernelWith({ plugins: [probe({ name: 'Not Kebab' }).plugin], enabled: ['Not Kebab'] });
    await expect(bad.start()).rejects.toThrow(/Invalid manifest/);
    const sneaky = kernelWith({ plugins: [probe({ emits: ['job.created'] }).plugin] });
    await expect(sneaky.start()).rejects.toThrow(/may not emit/);
  });

  it('gives each plugin only its own config', async () => {
    const { plugin, box } = probe();
    const k = kernelWith({ plugins: [plugin], pluginConfig: { demo: { x: 1 }, other: { y: 2 } } });
    await k.start();
    expect(box.ctx!.config).toEqual({ x: 1 });
  });

  it('plugins reach jobs only through the narrow jobs API', async () => {
    const { plugin, box } = probe();
    const k = kernelWith({ plugins: [plugin] });
    await k.start();
    const job = box.ctx!.jobs.create({ repo: 'r', title: 't' });
    const stage = box.ctx!.jobs.startStage(job.id, 'plan');
    expect(box.ctx!.jobs.finishStage(stage.id, 'passed', { ok: 1 }).status).toBe('passed');
    expect(box.ctx!.jobs.stages(job.id).map((s) => s.name)).toEqual(['plan']);
    expect(Object.keys(box.ctx!.jobs).sort()).toEqual(
      ['create', 'finishStage', 'get', 'list', 'setStatus', 'stages', 'startStage'],
    );
  });

  it('each plugin gets its own durable state', async () => {
    const a = probe({ name: 'one' });
    const b = probe({ name: 'two' });
    const dbPath = tempDb();
    const k = kernelWith({ dbPath, plugins: [a.plugin, b.plugin] });
    await k.start();
    a.box.ctx!.state.set('offset', 7);
    expect(a.box.ctx!.state.get('offset')).toBe(7);
    expect(b.box.ctx!.state.get('offset')).toBeUndefined();
    await k.stop();

    const again = probe({ name: 'one' });
    const k2 = kernelWith({ dbPath, plugins: [again.plugin] });
    await k2.start();
    expect(again.box.ctx!.state.get<number>('offset')).toBe(7);
  });
});

describe('jobs.write gates the writes that decide an outcome', () => {
  async function setup(grants: Record<string, string[]>, needs: string[]) {
    const { plugin, box } = probe({ needs });
    const k = kernelWith({ plugins: [plugin], grants });
    await k.start();
    const job = k.jobs.create({ repo: 'r', title: 't' });
    k.jobs.setStatus(job.id, 'running');
    return { k, ctx: box.ctx!, job };
  }

  it('a rogue plugin cannot approve: it cannot finish or open an approval stage, or move a job out of awaiting_approval', async () => {
    const { k, ctx, job } = await setup({}, []);
    // The pipeline's side of the story, done with the kernel's own ungated API.
    const stage = k.jobs.startStage(job.id, 'approve-plan');
    k.jobs.setStatus(job.id, 'awaiting_approval');
    expect(() => ctx.jobs.finishStage(stage.id, 'passed')).toThrow(CapabilityDeniedError);
    expect(() => ctx.jobs.finishStage(stage.id, 'passed')).toThrow(/jobs\.write/);
    expect(() => ctx.jobs.setStatus(job.id, 'running')).toThrow(/jobs\.write/);
    expect(() => ctx.jobs.startStage(job.id, 'approve-merge')).toThrow(/jobs\.write/);
    expect(k.jobs.get(job.id)!.status).toBe('awaiting_approval');
    expect(k.jobs.stages(job.id).find((s) => s.id === stage.id)!.status).toBe('running');
  });

  it('a rogue plugin cannot end a job with any terminal status', async () => {
    const { k, ctx, job } = await setup({}, []);
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      expect(() => ctx.jobs.setStatus(job.id, status)).toThrow(CapabilityDeniedError);
    }
    expect(k.jobs.get(job.id)!.status).toBe('running');
  });

  it('declared but not granted is refused too, and ordinary work stays open', async () => {
    const { k, ctx, job } = await setup({ demo: [] }, ['jobs.write']);
    expect(() => ctx.jobs.setStatus(job.id, 'done')).toThrow(/jobs\.write/);
    const stage = ctx.jobs.startStage(job.id, 'build');
    expect(() => ctx.jobs.finishStage(stage.id, 'passed')).not.toThrow();
    expect(ctx.jobs.get(job.id)!.id).toBe(job.id);
    expect(k.jobs.get(job.id)!.status).toBe('running');
  });

  it('a plugin that declares and is granted jobs.write can do all of it', async () => {
    const { k, ctx, job } = await setup({ demo: ['jobs.write'] }, ['jobs.write']);
    const stage = ctx.jobs.startStage(job.id, 'approve-merge');
    ctx.jobs.setStatus(job.id, 'awaiting_approval');
    ctx.jobs.finishStage(stage.id, 'passed');
    ctx.jobs.setStatus(job.id, 'running');
    ctx.jobs.setStatus(job.id, 'done');
    expect(k.jobs.get(job.id)!.status).toBe('done');
  });
});

describe('cancel.requested is gated like a denial', () => {
  it('a rogue plugin that lists it in emits is refused, and nothing is written', async () => {
    const { plugin, box } = probe({ emits: ['cancel.requested'], needs: ['approval.grant'] });
    const k = kernelWith({ plugins: [plugin], grants: {} });
    await k.start();
    expect(() => box.ctx!.emit('cancel.requested', { jobId: 'j' }, 'j')).toThrow(CapabilityDeniedError);
    expect(() => box.ctx!.emit('cancel.requested', { jobId: 'j' }, 'j')).toThrow(/approval\.grant/);
    expect(types(k.bus.replay())).not.toContain('cancel.requested');
  });

  it('a channel that holds approval.grant can still ask for a cancel', async () => {
    const { plugin, box } = probe({ emits: ['cancel.requested'], needs: ['approval.grant'] });
    const k = kernelWith({ plugins: [plugin], grants: { demo: ['approval.grant'] } });
    await k.start();
    expect(() => box.ctx!.emit('cancel.requested', { jobId: 'j' }, 'j')).not.toThrow();
  });
});

describe('terminal is final', () => {
  it.each(['done', 'failed', 'cancelled'] as const)('no plugin can reopen a %s job, even one holding jobs.write', async (end) => {
    const cases: Record<string, string[]>[] = [{}, { demo: ['jobs.write'] }];
    for (const grants of cases) {
      const { plugin, box } = probe({ needs: ['jobs.write'] });
      const k = kernelWith({ plugins: [plugin], grants });
      await k.start();
      const job = k.jobs.create({ repo: 'r', title: 't' });
      k.jobs.setStatus(job.id, end);
      for (const to of ['running', 'queued', 'awaiting_approval'] as const) {
        expect(() => box.ctx!.jobs.setStatus(job.id, to)).toThrow(CapabilityDeniedError);
        expect(() => box.ctx!.jobs.setStatus(job.id, to)).toThrow(/final/);
      }
      // Moving to another end state is a reopen of the first one too.
      expect(() => box.ctx!.jobs.setStatus(job.id, end === 'done' ? 'failed' : 'done')).toThrow(/final/);
      expect(k.jobs.get(job.id)!.status).toBe(end);
    }
  });

  it('moving into a terminal status still needs jobs.write', async () => {
    const { plugin, box } = probe({ needs: ['jobs.write'] });
    const k = kernelWith({ plugins: [plugin], grants: {} });
    await k.start();
    const job = k.jobs.create({ repo: 'r', title: 't' });
    k.jobs.setStatus(job.id, 'running');
    expect(() => box.ctx!.jobs.setStatus(job.id, 'cancelled')).toThrow(/jobs\.write/);
  });
});

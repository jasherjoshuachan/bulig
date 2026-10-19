import { describe, expect, it } from 'vitest';
import type { BuligEvent, Plugin, PluginContext, Stage } from '@bulig/plugin-sdk';
import { createKernel, type Store } from '../src/index.ts';
import { manifest } from './helpers.ts';
import { useKernelAdapters } from './kernel-adapters.ts';

// ADR 0010, addendum of 19 Oct 2026: a replayed handler run never opens a second stage attempt, and a replayed run that branches
// differently does not lose its new content without a word. Each rule runs on every adapter there is.

const { adapters, cleanups } = useKernelAdapters();

/** Make the kernel hear an event again, as if its handlers were run a second time, inside the same kernel (a redelivery). A standby takeover is not covered: see ADR 0010 Known limits. */
const redeliver = (k: ReturnType<typeof createKernel>, e: BuligEvent) => (k.bus as unknown as { dispatch(e: BuligEvent): void }).dispatch(e);

for (const adapter of adapters) {
  describe.skipIf(adapter.skip)(`a replayed run, with ${adapter.name}`, () => {
    /**
     * A plugin whose handler for demo.go opens the `build` stage and asks for it with demo.request, the way pipeline-dev does.
     * `die` makes the run throw after the stage is open and before the request is written (a crash between the two).
     */
    function setup(store: Store) {
      const logs: string[] = [];
      const errors: string[] = [];
      const answers: Stage[] = [];
      const flags = { die: false, branch: false, twice: false, otherJob: undefined as string | undefined };
      const logger = {
        debug() {},
        info: (m: string) => void logs.push(m),
        warn: (m: string) => void logs.push(m),
        error: (m: string) => void logs.push(m),
      };
      const demo: Plugin = {
        manifest: manifest({ name: 'demo', sdk: '1', subscribes: ['demo.go', 'plugin.error'], emits: ['demo.request', 'demo.other', 'demo.extra'] }),
        register(ctx: PluginContext) {
          ctx.on('demo.go', async (e) => {
            const stage = await ctx.jobs.startStage(e.jobId!, 'build');
            answers.push(stage);
            if (flags.twice) {
              // The same stage of the same job, opened a second time by the one run (after the first attempt is closed).
              if (stage.status === 'running') await ctx.jobs.finishStage(stage.id, 'passed'); // a replay is handed it already closed
              answers.push(await ctx.jobs.startStage(e.jobId!, 'build'));
            }
            if (flags.die) throw new Error('died between opening the stage and asking for it');
            await ctx.emitCommitted('demo.request', { stageId: stage.id, n: flags.branch ? 2 : 1 }, flags.otherJob ?? e.jobId);
            if (flags.branch) await ctx.emitCommitted('demo.extra', { fresh: true }, e.jobId);
          });
          ctx.on('plugin.error', (e) => void errors.push(JSON.stringify(e.payload)));
        },
      };
      const k = createKernel({ store, plugins: [demo], enabled: ['demo'], logger: logger as never });
      cleanups.push(() => k.stop());
      return { k, logs, errors, answers, flags };
    }
    const requests = (events: BuligEvent[]) => events.filter((e) => e.type === 'demo.request');

    it('does not open a second attempt when the run is redelivered, whether the first attempt is still running or has finished', async () => {
      const store = await adapter.make();
      const { k, errors, answers, logs } = setup(store);
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      const go = await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      const first = (await k.jobs.stages(job.id))[0]!;
      expect(first.status).toBe('running');

      // Redelivered while the attempt is still running: not an error, not a second attempt.
      redeliver(k, go);
      await k.bus.idle();
      expect(await k.jobs.stages(job.id)).toHaveLength(1);
      expect(errors).toEqual([]);

      // Redelivered after the attempt finished: this is the case that used to open attempt 2, whose request was then dropped as done.
      await k.jobs.finishStage(first.id, 'passed', { ok: true });
      redeliver(k, go);
      await k.bus.idle();
      const stages = await k.jobs.stages(job.id);
      expect(stages).toHaveLength(1);
      expect(stages[0]!.status).toBe('passed'); // the replay did not reopen it
      expect(answers.map((s) => s.id)).toEqual([first.id, first.id, first.id]); // every run was handed the one attempt
      expect(errors).toEqual([]);

      // No stage is running without a request that names it, and nothing was asked for twice.
      const asked = requests(await k.bus.replay());
      expect(asked).toHaveLength(1);
      expect(asked[0]!.payload).toMatchObject({ stageId: first.id });
      expect(stages.filter((s) => s.status === 'running' && !asked.some((r) => (r.payload as { stageId: string }).stageId === s.id))).toEqual([]);
      expect(logs.filter((l) => /diverged|different content/.test(l))).toEqual([]); // an identical replay says nothing alarming
    });

    it('asks for the attempt a run opened and then died on, when the run is delivered again', async () => {
      const store = await adapter.make();
      const { k, flags, errors, answers } = setup(store);
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      flags.die = true;
      const go = await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      expect(errors).toHaveLength(1); // the first run failed, as a handler can
      const opened = (await k.jobs.stages(job.id))[0]!;
      expect(requests(await k.bus.replay())).toHaveLength(0); // the stage is running and nobody was asked to do it

      flags.die = false;
      redeliver(k, go);
      await k.bus.idle();
      expect(await k.jobs.stages(job.id)).toHaveLength(1); // not attempt 2
      const asked = requests(await k.bus.replay());
      expect(asked).toHaveLength(1); // written now, because the first run never wrote it
      expect(asked[0]!.payload).toMatchObject({ stageId: opened.id });
      expect(answers.map((s) => s.id)).toEqual([opened.id, opened.id]);
    });

    it('keeps the first content and says so out loud when a replay writes different content into a filled place, and writes what is new', async () => {
      const store = await adapter.make();
      const { k, flags, logs } = setup(store);
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      const go = await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      expect(requests(await k.bus.replay())[0]!.payload).toMatchObject({ n: 1 });

      // The same run again, but the handler now branches on something that changed: other content in the first place, and one more event.
      flags.branch = true;
      redeliver(k, go);
      await k.bus.idle();
      const events = await k.bus.replay();
      const asked = requests(events);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.payload).toMatchObject({ n: 1 }); // refused: the first content is what was delivered
      const said = logs.filter((l) => l.includes('different content'));
      expect(said).toHaveLength(1); // loud, and once
      expect(said[0]).toContain(asked[0]!.id);
      // A genuinely new place is written, as it would be for a first run.
      expect(events.filter((e) => e.type === 'demo.extra')).toHaveLength(1);
      expect(await k.jobs.stages(job.id)).toHaveLength(1);
    });

    it('hands a run that opens the same stage of the same job twice two different attempts, and the same two back on a replay', async () => {
      const store = await adapter.make();
      const { k, flags, answers, errors } = setup(store);
      flags.twice = true;
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      const go = await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      const [one, two] = answers;
      expect(one!.id).not.toBe(two!.id);
      expect([one!.attempt, two!.attempt]).toEqual([1, 2]);
      redeliver(k, go);
      await k.bus.idle();
      expect(answers.map((s) => s.id)).toEqual([one!.id, two!.id, one!.id, two!.id]);
      expect((await k.jobs.stages(job.id)).map((s) => s.attempt)).toEqual([1, 2]); // the replay opened nothing
      expect(errors).toEqual([]);
    });

    it('calls a replay that asks for the same payload on another job a different content', async () => {
      const store = await adapter.make();
      const { k, flags, logs } = setup(store);
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      const other = await k.jobs.create({ repo: 'r', title: 'u' });
      const go = await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      flags.otherJob = other.id;
      redeliver(k, go);
      await k.bus.idle();
      expect(logs.filter((l) => l.includes('different content'))).toHaveLength(1);
      expect(requests(await k.bus.replay())[0]!.jobId).toBe(job.id); // the first stays
    });

    it('opens a stage as usual for a run with no cause, and for a different event', async () => {
      const store = await adapter.make();
      const { k } = setup(store);
      await k.start();
      const job = await k.jobs.create({ repo: 'r', title: 't' });
      const a = await k.jobs.startStage(job.id, 'plan'); // not inside a handler: no key, nothing to match
      await k.jobs.finishStage(a.id, 'passed');
      const b = await k.jobs.startStage(job.id, 'plan');
      expect(b.attempt).toBe(2);
      // Two different go events are two causes: each opens its own attempt of build.
      await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      const first = (await k.jobs.stages(job.id)).find((s) => s.name === 'build')!;
      await k.jobs.finishStage(first.id, 'passed');
      await k.bus.emit({ type: 'demo.go', source: 'test', jobId: job.id });
      await k.bus.idle();
      expect((await k.jobs.stages(job.id)).filter((s) => s.name === 'build').map((s) => s.attempt)).toEqual([1, 2]);
    });
  });
}

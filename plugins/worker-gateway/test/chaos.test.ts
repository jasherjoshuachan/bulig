import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Whole jobs on a loaded machine: give each test room.
vi.setConfig({ testTimeout: 240_000 });
import { ADAPTERS, bootPipeline, FAKE_CLAUDE_SLOW, git, prCreates, waitFor, type PipelineRig } from './support.ts';

// Chaos for the worker protocol (ADR 0011): a remote worker dies, or goes quiet but lives, in the middle of a build. The kernel takes
// the stage back after the heartbeat timeout and offers it again once. The job must still finish with exactly one PR, one commit for the
// build, and one build result in the log. Timings: heartbeat 300 ms, loss at 3 s (ten beats), so a busy machine can stall a beat or two.

const HANG = '600000';
const marks = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`chaos: a remote worker is lost mid-build, ${adapter.name}`, () => {
    const setup = async () => {
      const rig = await bootPipeline(await adapter.open());
      const mark = join(rig.world.root, 'builds.txt');
      writeFileSync(mark, '');
      return { rig, mark };
    };
    /** A worker whose build takes `delay` ms. Its other stages run normally. */
    const slowBuild = (rig: PipelineRig, id: 'mac' | 'pi', mark: string, delay: string, extra = {}) =>
      rig.remote(id, { claudeBin: FAKE_CLAUDE_SLOW, passEnv: ['FAKE_BUILD_DELAY_MS', 'FAKE_MARK'], env: { ...process.env, FAKE_BUILD_DELAY_MS: delay, FAKE_MARK: mark }, ...extra });

    /** What must hold however the build was lost. Called when the job waits for the merge approval, while the branch is still on origin. */
    const assertOneOfEverything = async (rig: PipelineRig, jobId: string) => {
      const stages = await rig.k.jobs.stages(jobId);
      const builds = stages.filter((s) => s.name === 'build');
      expect(builds.map((s) => `${s.attempt}:${s.status}`)).toEqual(['1:failed', '2:passed']);
      expect(builds[0]!.output).toMatchObject({ interrupted: true, reason: 'worker-lost' });
      // the build was asked for exactly twice, under two different attempts, the second marked as the one re-offer
      const asked = rig.events.filter((e) => e.type === 'stage.requested' && (e.payload as { stage: string }).stage === 'build').map((e) => e.payload as { stageId: string; reoffers?: number });
      expect(asked.map((p) => p.stageId)).toEqual(builds.map((s) => s.id));
      expect(asked.map((p) => p.reoffers ?? 0)).toEqual([0, 1]);
      // one build result in the log, from the worker that finished it
      const results = rig.events.filter((e) => e.type === 'stage.completed' && (e.payload as { stage: string }).stage === 'build');
      expect(results.map((e) => (e.payload as { workerId: string }).workerId)).toEqual(['pi']);
      // one commit for the build, one PR
      const branch = git(rig.world.origin, 'branch', '--list', 'bulig/*').replace(/^[* ]+/, '');
      const subjects = git(rig.world.origin, 'log', '--format=%s', `main..${branch}`).split('\n');
      expect(subjects.filter((s) => s.endsWith('(build)'))).toHaveLength(1);
      // the only commit carries the trailer of the attempt that finished, never the lost one's (test and docs changed nothing)
      expect(git(rig.world.origin, 'log', '--format=%B', `main..${branch}`).split('\n').filter((l) => l.startsWith('Bulig-Stage:'))).toEqual([`Bulig-Stage: ${builds[1]!.id}`]);
      expect(prCreates(rig.world.ghLog)).toBe(1);
    };

    it('the worker dies mid-build: its heartbeats stop, the stage is offered again once, another worker finishes the job, one PR', async () => {
      const { rig, mark } = await setup();
      const mac = slowBuild(rig, 'mac', mark, HANG);
      const job = await rig.startJob();
      rig.human.grant(job.id, 'plan');
      await waitFor(() => marks(mark).length === 1, 90_000, 'the build to start on mac');
      await mac.stop(); // dies: no result, no goodbye
      const pi = rig.remote('pi');
      await waitFor(async () => rig.human.asking(job.id, 'merge'), 120_000, 'the job to reach the merge question after the re-offer');
      await assertOneOfEverything(rig, job.id);
      rig.human.grant(job.id, 'merge');
      await waitFor(async () => (await rig.k.jobs.get(job.id))!.status === 'done', 60_000, 'done');
      expect(prCreates(rig.world.ghLog)).toBe(1);
      expect(pi.running()).toBe(0);
    });

    it('the worker is alive but cut off: its late result bounces off the fence, and nothing is applied or committed twice', async () => {
      const { rig, mark } = await setup();
      let cut = false;
      // mac's build takes 7 s; its heartbeats stop getting through from the start of the build, and it never gives up by itself.
      slowBuild(rig, 'mac', mark, '7000', { dropHeartbeats: () => cut, lossMs: 10 * 60_000 });
      const job = await rig.startJob();
      rig.human.grant(job.id, 'plan');
      await waitFor(() => marks(mark).length === 1, 90_000, 'the build to start on mac');
      cut = true;
      // mac is the only worker, so the stage waits for a free one; pi joins and takes the re-offered stage.
      rig.remote('pi');
      await waitFor(async () => rig.human.asking(job.id, 'merge'), 120_000, 'the merge question');
      // by now mac's build has long finished and its result was sent and refused
      await waitFor(() => rig.events.filter((e) => e.type === 'stage.requested').length >= 2, 10_000, 'the re-offer');
      await assertOneOfEverything(rig, job.id);
      rig.human.grant(job.id, 'merge');
      await waitFor(async () => (await rig.k.jobs.get(job.id))!.status === 'done', 60_000, 'done');
      expect(prCreates(rig.world.ghLog)).toBe(1);
    });

    it('lost twice: the second loss fails the job instead of a third offer, and no PR is made', async () => {
      const { rig, mark } = await setup();
      const mac = slowBuild(rig, 'mac', mark, HANG);
      const job = await rig.startJob();
      rig.human.grant(job.id, 'plan');
      await waitFor(() => marks(mark).length === 1, 90_000, 'the first build');
      await mac.stop();
      const pi = slowBuild(rig, 'pi', mark, HANG);
      await waitFor(() => marks(mark).length === 2, 60_000, 'the re-offered build');
      await pi.stop();
      await waitFor(async () => (await rig.k.jobs.get(job.id))!.status === 'failed', 60_000, 'the job to fail');
      const asked = rig.events.filter((e) => e.type === 'stage.requested' && (e.payload as { stage: string }).stage === 'build');
      expect(asked).toHaveLength(2);
      expect(prCreates(rig.world.ghLog)).toBe(0);
      const last = (await rig.k.jobs.stages(job.id)).filter((s) => s.name === 'build').at(-1)!;
      expect(last.status).toBe('failed');
      expect(JSON.stringify(last.output)).toContain('went silent');
    });
  });
}

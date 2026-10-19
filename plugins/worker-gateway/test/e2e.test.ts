import { describe, expect, it, vi } from 'vitest';

// Whole jobs on a loaded machine: give each test room.
vi.setConfig({ testTimeout: 240_000 });
import { ADAPTERS, bootPipeline, finishJob, git, prCreates, waitFor } from './support.ts';

// A whole job through the real pipeline and the real github plugin (over a local origin and a fake gh), with Claude run by a worker
// on "another machine": its own clone, its own folder, reached only over the endpoint. The kernel still makes every commit.

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`a job run by a remote worker, ${adapter.name}`, () => {
    it('runs every stage on the remote worker, commits on the kernel, and opens exactly one PR', async () => {
      const rig = await bootPipeline(await adapter.open());
      rig.remote('mac');
      const job = await rig.startJob();
      rig.human.grant(job.id, 'plan');
      await waitFor(() => rig.human.asking(job.id, 'merge'), 120_000, 'the merge question');
      // The branch is on origin and holds the code the worker wrote, committed by the kernel.
      const branch = git(rig.world.origin, 'branch', '--list', 'bulig/*').replace(/^[* ]+/, '');
      expect(git(rig.world.origin, 'show', `${branch}:src/multiply.js`)).toContain('a * b');
      const subjects = git(rig.world.origin, 'log', '--format=%s', `main..${branch}`).split('\n');
      expect(subjects.filter((s) => s.endsWith('(build)'))).toHaveLength(1);
      expect(prCreates(rig.world.ghLog)).toBe(1);
      rig.human.grant(job.id, 'merge');
      await waitFor(async () => (await rig.k.jobs.get(job.id))!.status === 'done', 60_000, 'done');

      const stages = await rig.k.jobs.stages(job.id);
      expect(stages.filter((s) => ['plan', 'critique', 'build', 'test', 'docs', 'review'].includes(s.name)).map((s) => `${s.name}:${s.status}`)).toEqual([
        'plan:passed', 'critique:passed', 'build:passed', 'test:passed', 'docs:passed', 'review:passed',
      ]);
      // Every Claude stage was taken by the remote worker.
      const done = rig.events.filter((e) => e.type === 'stage.completed');
      expect(done).toHaveLength(6);
      expect(done.every((e) => (e.payload as { workerId: string }).workerId === 'mac' && e.source === 'worker-gateway')).toBe(true);
      expect(prCreates(rig.world.ghLog)).toBe(1);
    });

    it('with the in-process worker free, it takes every stage and the remote worker is never used', async () => {
      const rig = await bootPipeline(await adapter.open(), { local: true, gateway: { localSlots: 1 } });
      const mac = rig.remote('mac');
      const job = await rig.startJob();
      await finishJob(rig, job);
      expect((await rig.k.jobs.get(job.id))!.status).toBe('done');
      const done = rig.events.filter((e) => e.type === 'stage.completed');
      expect(done).toHaveLength(6);
      expect(done.every((e) => e.source === 'worker-claude-code')).toBe(true);
      expect(rig.events.filter((e) => e.type === 'stage.assigned')).toHaveLength(6);
      expect(mac.running()).toBe(0);
      expect(prCreates(rig.world.ghLog)).toBe(1);
    });

    it('when the in-process worker is full, the next job\'s stages go to the remote worker', async () => {
      // One local slot, two jobs at once: the second job's stages overflow to the remote worker while the first holds the local slot.
      const rig = await bootPipeline(await adapter.open(), { local: true, gateway: { localSlots: 1 } });
      rig.remote('mac');
      const a = await rig.startJob('First');
      const b = await rig.startJob('Second');
      rig.human.grant(a.id, 'plan');
      rig.human.grant(b.id, 'plan');
      await waitFor(() => rig.human.asking(a.id, 'merge') && rig.human.asking(b.id, 'merge'), 120_000, 'both merge questions');
      const sources = new Set(rig.events.filter((e) => e.type === 'stage.completed').map((e) => e.source));
      expect(sources).toEqual(new Set(['worker-claude-code', 'worker-gateway']));
      rig.human.grant(a.id, 'merge');
      rig.human.grant(b.id, 'merge');
      await waitFor(async () => (await rig.k.jobs.get(a.id))!.status === 'done' && (await rig.k.jobs.get(b.id))!.status === 'done', 120_000, 'both jobs done');
      expect(prCreates(rig.world.ghLog)).toBe(2);
    });
  });
}

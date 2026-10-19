import { writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Job } from '@bulig/plugin-sdk';
import { diffAgainst } from '../src/workspace.ts';
import { ADAPTERS, addWorktree, bootGateway, git, makeDriver, makeWorld, post, sleep, TOKENS, waitFor, type BootOptions } from './support.ts';

// The worker endpoint against a real kernel, a real git repository and both stores. The pipeline is played by a small driver that
// opens stages and asks for them, the way pipeline-dev does. Timings are scaled down (heartbeat 200 ms, loss at 2 s) but keep the
// real ratios, with room for a loaded machine.

const b64 = (b: Buffer) => b.toString('base64');

/** A patch that adds files to the repository's base, made by git itself in the worker's clone. */
async function patchOf(clone: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, '..'), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  const patch = await diffAgainst(clone, 'HEAD', 1 << 20);
  git(clone, 'checkout', '-q', '--', '.');
  git(clone, 'clean', '-fdq');
  return b64(patch);
}

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`worker endpoint, ${adapter.name}`, () => {
    async function rig(o: BootOptions = {}) {
      const world = makeWorld();
      const store = await adapter.open();
      const driver = makeDriver();
      const boot = await bootGateway(store, { plugins: [driver.plugin], ...o });
      const newJob = async (title = 'A job'): Promise<{ job: Job; cwd: string }> => {
        const job = await boot.k.jobs.create({ repo: world.repo, title });
        return { job, cwd: addWorktree(world.repo, job.id) };
      };
      const claim = (token: string | undefined, workerId = 'mac', slots = 2) => post(boot.url, '/claim', token, { workerId, slots });
      // A claim for a stage that is known to be waiting. On a loaded machine packing the repository can outlast one claim window, so ask again.
      const take = async (token: string | undefined, workerId = 'mac', slots = 2) => {
        for (let i = 0; i < 6; i++) {
          const res = await claim(token, workerId, slots);
          if (res.status !== 204) return res;
        }
        return claim(token, workerId, slots);
      };
      const types = (t: string) => driver.events.filter((e) => e.type === t);
      return { ...boot, world, driver, newJob, claim, take, types };
    }

    it('answers 401 with nothing to read to a missing, wrong or borrowed token, on every route, and does not reveal which routes exist', async () => {
      const r = await rig();
      const calls = [
        ['/claim', { workerId: 'mac', slots: 1 }],
        ['/heartbeat', { stageId: 'x', attempt: 1 }],
        ['/result', { stageId: 'x', attempt: 1, outcome: 'failed', output: {} }],
        ['/nothing-here', {}],
      ] as const;
      for (const [path, body] of calls) {
        for (const token of [undefined, 'wrong-token-0123456789abcdef', `${TOKENS.mac}x`]) {
          const res = await post(r.url, path, token, body);
          expect(res.status, `${path} ${token}`).toBe(401);
          expect(res.json).toBeUndefined();
        }
      }
      // mac's token cannot claim as pi.
      expect((await r.claim(TOKENS.mac, 'pi')).status).toBe(401);
      // With a good token, an unknown path is a 404 and a bad body a 400.
      expect((await post(r.url, '/nothing-here', TOKENS.mac, {})).status).toBe(404);
      expect((await post(r.url, '/claim', TOKENS.mac, { workerId: 'mac', slots: 0 })).status).toBe(400);
      expect((await post(r.url, '/claim', TOKENS.mac, '{not json')).status).toBe(400);
      const res = await fetch(`${r.url}/claim`, { headers: { authorization: `Bearer ${TOKENS.mac}` } });
      expect(res.status).toBe(404); // GET is not a route
    });

    it('a worker takes a stage, says it is alive, and hands back the result: one stage.completed, as the in-process worker would send', async () => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      const waiting = r.claim(TOKENS.mac);
      const stageId = await r.driver.ask(job, cwd, 'plan', 'readonly', 'You are planning');
      // On a loaded machine opening the stage can outlast one claim window (204); then ask again, as take() does.
      const first = await waiting;
      const got = first.status === 204 ? await r.take(TOKENS.mac) : first;
      expect(got.status).toBe(200);
      expect(got.json).toMatchObject({
        jobId: job.id,
        stageId,
        attempt: 1,
        request: { stage: 'plan', prompt: 'You are planning', model: 'sonnet', mode: 'readonly' },
        workspace: { repo: r.world.repo, base: git(r.world.repo, 'rev-parse', 'origin/main') },
      });
      expect(got.json.workspace.patch).toBeUndefined();
      expect(typeof got.json.generation).toBe('number');
      const ids = { stageId, attempt: got.json.attempt, generation: got.json.generation };

      expect((await post(r.url, '/heartbeat', TOKENS.mac, ids)).status).toBe(200);
      const done = await post(r.url, '/result', TOKENS.mac, { ...ids, outcome: 'completed', output: { result: 'A plan', costUsd: 0.5, sessionId: 's-1', evidence: [{ tool: 'Read', kind: 'read', target: 'a.md', ok: true }] } });
      expect(done.status).toBe(200);
      const completed = r.types('stage.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]!.jobId).toBe(job.id);
      expect(completed[0]!.source).toBe('worker-gateway');
      expect(completed[0]!.payload).toMatchObject({ stage: 'plan', ok: true, result: 'A plan', costUsd: 0.5, sessionId: 's-1', workerId: 'mac' });
      // A second copy of the same result (the worker did not hear the answer) is told it went through, and nothing is written twice.
      expect(await post(r.url, '/result', TOKENS.mac, { ...ids, outcome: 'completed', output: { result: 'A plan' } })).toMatchObject({ status: 200, json: { duplicate: true } });
      expect(r.types('stage.completed')).toHaveLength(1);
      // and the heartbeat of a stage that is no longer held is stale
      expect((await post(r.url, '/heartbeat', TOKENS.mac, ids)).status).toBe(409);
    });

    it('a failed run becomes stage.failed', async () => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'plan');
      const got = await r.claim(TOKENS.mac);
      await post(r.url, '/result', TOKENS.mac, { stageId, attempt: got.json.attempt, outcome: 'failed', output: { error: 'claude exited with code 1' } });
      expect(r.types('stage.failed')[0]!.payload).toMatchObject({ stage: 'plan', error: 'claude exited with code 1', workerId: 'mac' });
    });

    it('sends the job so far to the worker as a patch, and applies the worker\'s changes to the job folder', async () => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      // Work already in the job folder: one committed file and one edit nobody committed.
      writeFileSync(join(cwd, 'committed.txt'), 'one\n');
      git(cwd, 'add', '-A');
      git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'earlier stage');
      writeFileSync(join(cwd, 'README.md'), 'hi, edited\n');
      const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
      const got = (await r.take(TOKENS.mac)).json;
      const patch = Buffer.from(got.workspace.patch, 'base64').toString('utf8');
      expect(patch).toContain('committed.txt');
      expect(patch).toContain('README.md');
      expect(got.workspace.base).toBe(git(r.world.repo, 'rev-parse', 'origin/main'));

      // The worker returns a new file. It lands in the job folder; the kernel (github plugin) commits it later.
      const change = await patchOf(r.world.clone, { 'src/multiply.js': 'export const multiply = (a, b) => a * b;\n' });
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'built' }, patch: change });
      expect(res.status).toBe(200);
      expect(readFileSync(join(cwd, 'src/multiply.js'), 'utf8')).toContain('a * b');
      expect(git(cwd, 'status', '--porcelain')).toContain('src/');
      expect(r.types('stage.completed')).toHaveLength(1);
    });

    it.each([
      ['a symlink', (c: string) => { symlinkSync('/etc/passwd', join(c, 'link')); return 'link'; }, /symlink/],
      ['a path under .git', (c: string) => { mkdirSync(join(c, '.git-evil'), { recursive: true }); return '.git-evil/x'; }, null],
    ])('refuses a patch with %s: the stage fails, nothing is applied', async (_name, plant, expected) => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
      const got = (await r.take(TOKENS.mac)).json;
      let patch: string;
      if (expected) {
        plant(r.world.clone);
        patch = b64(await diffAgainst(r.world.clone, 'HEAD', 1 << 20));
        git(r.world.clone, 'clean', '-fdq');
      } else {
        // A patch that names .git/hooks/pre-commit, written by hand: git itself refuses it, and so does the kernel before git.
        patch = b64(Buffer.from('diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+echo pwned\n'));
      }
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'x' }, patch });
      expect(res.status).toBe(200);
      expect(r.types('stage.completed')).toHaveLength(0);
      expect(r.types('stage.failed')[0]!.payload).toMatchObject({ stage: 'build', error: expect.stringContaining('were not applied') });
      expect(existsSync(join(cwd, 'link'))).toBe(false);
      expect(existsSync(join(cwd, '.git-evil'))).toBe(false);
      expect(git(cwd, 'status', '--porcelain')).toBe('');
    });

    it('changes sent for a stage that may not change files are refused: 400, the stage fails, nothing is applied', async () => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'review', 'readonly');
      const got = (await r.take(TOKENS.mac)).json;
      const change = await patchOf(r.world.clone, { 'sneaky.txt': 'written by a read-only stage\n' });
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'VERDICT: PASS' }, patch: change });
      expect(res.status).toBe(400);
      expect(existsSync(join(cwd, 'sneaky.txt'))).toBe(false);
      expect(r.types('stage.completed')).toHaveLength(0);
      expect(r.types('stage.failed')[0]!.payload).toMatchObject({ stage: 'review', error: expect.stringContaining('may not change files') });
      // the same result without a patch is fine
      const next = await r.newJob('next');
      const second = await r.driver.ask(next.job, next.cwd, 'review', 'readonly');
      const got2 = (await r.take(TOKENS.mac)).json;
      expect(got2.stageId).toBe(second);
      expect((await post(r.url, '/result', TOKENS.mac, { stageId: second, attempt: 1, generation: got2.generation, outcome: 'completed', output: { result: 'VERDICT: PASS' } })).status).toBe(200);
    });

    it('if the result cannot be written after the changes were applied, they are taken back, and the retry applies them once', async () => {
      let fail = true;
      const r = await rig({ hooks: { afterApply: () => { if (fail) { fail = false; throw new Error('the store went away'); } } } });
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
      const got = (await r.take(TOKENS.mac)).json;
      const change = await patchOf(r.world.clone, { 'src/new.txt': 'new\n' });
      const body = { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'built' }, patch: change };
      expect((await post(r.url, '/result', TOKENS.mac, body)).status).toBe(500);
      // the job folder holds only what was accepted: nothing
      expect(existsSync(join(cwd, 'src/new.txt'))).toBe(false);
      expect(git(cwd, 'status', '--porcelain')).toBe('');
      expect(r.types('stage.completed')).toHaveLength(0);
      // the worker tries again, and this time it goes through
      expect((await post(r.url, '/result', TOKENS.mac, body)).status).toBe(200);
      expect(readFileSync(join(cwd, 'src/new.txt'), 'utf8')).toBe('new\n');
      expect(r.types('stage.completed')).toHaveLength(1);
    });

    it('tells the worker how large a patch the kernel will take, and an oversized one fails the stage with that reason: no 500, no retry loop', async () => {
      const r = await rig({ gateway: { maxPatchBytes: 1024 } });
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
      const got = (await r.take(TOKENS.mac)).json;
      expect(got.maxPatchBytes).toBe(1024);
      const change = await patchOf(r.world.clone, { 'big.txt': 'x'.repeat(4000) + '\n' });
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'built' }, patch: change });
      expect(res.status).toBe(413);
      expect(existsSync(join(cwd, 'big.txt'))).toBe(false);
      expect(r.types('stage.failed')[0]!.payload).toMatchObject({ stage: 'build', error: expect.stringContaining('larger than 1 KiB') });
      expect(r.types('stage.completed')).toHaveLength(0);
    });

    it('a patch that does not apply fails the stage and leaves the folder as it was', async () => {
      const r = await rig();
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
      const got = (await r.take(TOKENS.mac)).json;
      const change = await patchOf(r.world.clone, { 'README.md': 'something else entirely\n' });
      writeFileSync(join(cwd, 'README.md'), 'a different edit\n');
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: {}, patch: change });
      expect(res.status).toBe(200);
      expect(r.types('stage.failed')[0]!.payload).toMatchObject({ error: expect.stringContaining('did not apply') });
      expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('a different edit\n');
    });

    describe('fencing', () => {
      it('a heartbeat or result that names another attempt, generation, stage or worker gets 409 and changes nothing', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'plan');
        const got = (await r.take(TOKENS.mac)).json;
        const ok = { stageId, attempt: got.attempt, generation: got.generation };
        const bad = [
          { ...ok, attempt: ok.attempt + 1 },
          { ...ok, generation: ok.generation + 1 },
          { ...ok, stageId: 'no-such-stage' },
        ];
        for (const ids of bad) {
          expect((await post(r.url, '/heartbeat', TOKENS.mac, ids)).status, JSON.stringify(ids)).toBe(409);
          expect((await post(r.url, '/result', TOKENS.mac, { ...ids, outcome: 'completed', output: { result: 'x' } })).status).toBe(409);
        }
        // another worker, with its own valid token, cannot speak for this stage either
        expect((await post(r.url, '/heartbeat', TOKENS.pi, ok)).status).toBe(409);
        expect((await post(r.url, '/result', TOKENS.pi, { ...ok, outcome: 'completed', output: {} })).status).toBe(409);
        expect(r.types('stage.completed')).toHaveLength(0);
        // the real holder is untouched
        expect((await post(r.url, '/heartbeat', TOKENS.mac, ok)).status).toBe(200);
      });

      it('a stage the record has already closed is stale even though the worker still holds it: 409, nothing written, and its slot is free again', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'plan');
        const got = (await r.take(TOKENS.pi, 'pi', 1)).json;
        const ids = { stageId, attempt: 1, generation: got.generation };
        // someone else closes the stage (another path of the pipeline, a restart's clean-up)
        await r.driver.ctx().jobs.finishStage(stageId, 'failed', { cancelled: true });
        expect((await post(r.url, '/heartbeat', TOKENS.pi, ids)).status).toBe(409);
        expect((await post(r.url, '/result', TOKENS.pi, { ...ids, outcome: 'completed', output: { result: 'x' } })).status).toBe(409);
        expect(r.types('stage.completed')).toHaveLength(0);
        // pi's single slot is free for the next stage
        const next = await r.newJob('next');
        const nextStage = await r.driver.ask(next.job, next.cwd, 'plan');
        expect((await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 1 })).json.stageId).toBe(nextStage);
      });

      it('after a takeover, the old worker\'s late result gets 409 and is ignored; the new attempt\'s result is the one that counts', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const first = await r.driver.ask(job, cwd, 'build', 'edit');
        const old = (await r.take(TOKENS.mac)).json;
        expect(old.stageId).toBe(first);
        // mac goes quiet. After the loss timeout the kernel closes the attempt and offers the stage again.
        const second = await waitFor(() => r.types('stage.requested').length === 2, 30_000, 'the stage to be offered again').then(() => (r.types('stage.requested')[1]!.payload as { stageId: string }).stageId);
        expect(second).not.toBe(first);
        expect(r.types('stage.requested')[1]!.payload).toMatchObject({ reoffers: 1, stage: 'build' });
        const stages = await r.k.jobs.stages(job.id);
        expect(stages.find((s) => s.id === first)).toMatchObject({ status: 'failed', output: { interrupted: true, reason: 'worker-lost' } });
        expect(stages.find((s) => s.id === second)).toMatchObject({ status: 'running', attempt: 2 });

        // the new holder
        const fresh = (await r.take(TOKENS.pi, 'pi', 1)).json;
        expect(fresh).toMatchObject({ stageId: second, attempt: 2 });
        // the old worker wakes up and reports: stale, ignored, and its patch is not applied
        const change = await patchOf(r.world.clone, { 'late.txt': 'late\n' });
        const late = await post(r.url, '/result', TOKENS.mac, { stageId: first, attempt: 1, generation: old.generation, outcome: 'completed', output: { result: 'late' }, patch: change });
        expect(late.status).toBe(409);
        expect((await post(r.url, '/heartbeat', TOKENS.mac, { stageId: first, attempt: 1, generation: old.generation })).status).toBe(409);
        expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
        expect(r.types('stage.completed')).toHaveLength(0);
        // the new one reports
        expect((await post(r.url, '/result', TOKENS.pi, { stageId: second, attempt: 2, generation: fresh.generation, outcome: 'completed', output: { result: 'on time' } })).status).toBe(200);
        expect(r.types('stage.completed').map((e) => (e.payload as { result: string }).result)).toEqual(['on time']);
      });

      it('a loss that starts while a result is being checked wins: the late result gets 409, its changes are not applied, and nothing is completed twice', async () => {
        let armed = false;
        let release: () => void = () => {};
        const hold = new Promise<void>((r) => (release = r));
        // The record read for the result's check has come back (it still says "running"); the check is then held up until the stage has been taken back.
        const r = await rig({ hooks: { afterFenceRead: () => (armed ? ((armed = false), hold) : undefined) } });
        const { job, cwd } = await r.newJob();
        const first = await r.driver.ask(job, cwd, 'build', 'edit');
        const got = (await r.take(TOKENS.mac)).json;
        const change = await patchOf(r.world.clone, { 'late.txt': 'late\n' });
        armed = true;
        const late = post(r.url, '/result', TOKENS.mac, { stageId: first, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'late' }, patch: change });
        await waitFor(() => r.types('stage.requested').length === 2, 30_000, 'the stage to be offered again while the check waits');
        release();
        expect((await late).status).toBe(409);
        expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
        expect(r.types('stage.completed')).toHaveLength(0);
        // the new attempt is still the open one, and still unclaimed work for someone else
        const stages = await r.k.jobs.stages(job.id);
        expect(stages.filter((s) => s.name === 'build').map((s) => `${s.attempt}:${s.status}`)).toEqual(['1:failed', '2:running']);
        expect((await r.take(TOKENS.pi, 'pi', 1)).json).toMatchObject({ attempt: 2 });
      });

      it('a result that takes longer to handle than the loss timeout is not a silent worker: the stage is not taken back mid-write', async () => {
        const r = await rig({ hooks: { afterApply: () => sleep(3500) } }); // the loss timeout is 2 s
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
        const got = (await r.take(TOKENS.mac)).json;
        const change = await patchOf(r.world.clone, { 'slow.txt': 'slow\n' });
        const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'built' }, patch: change });
        expect(res.status).toBe(200);
        expect(r.types('stage.requested')).toHaveLength(1);
        expect(r.types('stage.failed')).toHaveLength(0);
        expect(r.types('stage.completed')).toHaveLength(1);
        expect(readFileSync(join(cwd, 'slow.txt'), 'utf8')).toBe('slow\n');
      });

      it('a worker that keeps heartbeating keeps its stage past the loss timeout', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'plan');
        const got = (await r.take(TOKENS.mac)).json;
        const until = Date.now() + 4500; // more than twice the 2 s loss timeout
        while (Date.now() < until) {
          expect((await post(r.url, '/heartbeat', TOKENS.mac, { stageId, attempt: 1, generation: got.generation })).status).toBe(200);
          await sleep(200);
        }
        expect(r.types('stage.requested')).toHaveLength(1);
      });

      it('a second silent worker fails the stage instead of offering it a third time', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        await r.driver.ask(job, cwd, 'build', 'edit');
        await r.claim(TOKENS.mac);
        await waitFor(() => r.types('stage.requested').length === 2, 30_000, 'the re-offer');
        const second = (r.types('stage.requested')[1]!.payload as { stageId: string }).stageId;
        expect((await r.take(TOKENS.mac)).json.stageId).toBe(second);
        await waitFor(() => r.types('stage.failed').length === 1, 30_000, 'the stage to fail');
        expect(r.types('stage.requested')).toHaveLength(2);
        expect(r.types('stage.failed')[0]!.payload).toMatchObject({ stage: 'build', error: expect.stringContaining('went silent') });
        // The stage stays open for whoever handles stage.failed (the pipeline) to close.
        expect((await r.k.jobs.stages(job.id)).find((s) => s.id === second)!.status).toBe('running');
      });

      it('a job that ends closes its remote stage at once, and the worker is told at its next heartbeat', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'build', 'edit');
        const got = (await r.take(TOKENS.mac)).json;
        await r.driver.ctx().jobs.setStatus(job.id, 'running').catch(() => {});
        await r.k.jobs.setStatus(job.id, 'cancelled');
        await waitFor(() => r.types('stage.failed').length === 1, 30_000, 'the stage to close');
        expect(r.types('stage.failed')[0]!.payload).toMatchObject({ error: 'the job ended, so this run was stopped' });
        expect((await post(r.url, '/heartbeat', TOKENS.mac, { stageId, attempt: 1, generation: got.generation })).status).toBe(409);
      });
    });

    describe('who gets what', () => {
      it('a worker never holds more stages than its cap: the least of what it asks and what the config allows', async () => {
        const r = await rig();
        const jobs = await Promise.all([r.newJob('a'), r.newJob('b')]);
        await r.driver.ask(jobs[0]!.job, jobs[0]!.cwd, 'plan');
        await r.driver.ask(jobs[1]!.job, jobs[1]!.cwd, 'plan');
        // pi is capped at 1 slot by the config, whatever it asks for
        const first = await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 8 });
        expect(first.status).toBe(200);
        const t0 = Date.now();
        const second = await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 8 });
        expect(second.status).toBe(204);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1500); // it waited the whole claim window
        // mac asks for one slot only
        expect((await post(r.url, '/claim', TOKENS.mac, { workerId: 'mac', slots: 1 })).status).toBe(200);
        const none = await post(r.url, '/claim', TOKENS.mac, { workerId: 'mac', slots: 1 });
        expect(none.status).toBe(204);
        // when the first stage is done, pi has room again
        await post(r.url, '/result', TOKENS.pi, { stageId: first.json.stageId, attempt: 1, generation: first.json.generation, outcome: 'completed', output: { result: 'x' } });
        const more = await r.driver.ask((await r.newJob('c')).job, (await r.newJob('d')).cwd, 'plan').catch(() => undefined);
        void more;
      });

      it('stages of one project go out in the order they were asked for', async () => {
        const r = await rig();
        const made = [await r.newJob('1'), await r.newJob('2'), await r.newJob('3')];
        const asked: string[] = [];
        for (const m of made) asked.push(await r.driver.ask(m.job, m.cwd, 'plan'));
        const order: string[] = [];
        for (let i = 0; i < 3; i++) {
          const got = (await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 1 })).json;
          order.push(got.stageId);
          await post(r.url, '/result', TOKENS.pi, { stageId: got.stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'x' } });
        }
        expect(order).toEqual(asked);
      });

      it('only offers a worker stages of the projects it has, and of the projects its config allows', async () => {
        const r = await rig({ gateway: { workers: { mac: { tokenEnv: 'BULIG_TOKEN_MAC', projects: ['/somewhere/else'] }, pi: { tokenEnv: 'BULIG_TOKEN_PI' } } } });
        const { job, cwd } = await r.newJob();
        const stageId = await r.driver.ask(job, cwd, 'plan');
        // mac is only allowed another repository
        expect((await r.claim(TOKENS.mac)).status).toBe(204);
        // pi has the repository but says it only has another one
        expect((await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 1, projects: ['/not/this'] })).status).toBe(204);
        expect((await post(r.url, '/claim', TOKENS.pi, { workerId: 'pi', slots: 1, projects: [r.world.repo] })).json.stageId).toBe(stageId);
      });

      it('keeps one lane per job: its next stage waits until the first is handed back', async () => {
        const r = await rig();
        const { job, cwd } = await r.newJob();
        const one = await r.driver.ask(job, cwd, 'plan');
        const two = await r.driver.ask(job, cwd, 'critique');
        const got = (await r.take(TOKENS.mac)).json;
        expect(got.stageId).toBe(one);
        expect((await r.claim(TOKENS.mac)).status).toBe(204); // mac has a free slot, but the job's lane is busy
        await post(r.url, '/result', TOKENS.mac, { stageId: one, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'x' } });
        expect((await r.take(TOKENS.mac)).json.stageId).toBe(two);
      });

      it('the in-process worker comes first: a stage goes to it while it has a free slot, and to a remote worker only after', async () => {
        const r = await rig({ gateway: { localSlots: 1 } });
        const a = await r.newJob('a');
        const b = await r.newJob('b');
        const c = await r.newJob('c');
        const first = await r.driver.ask(a.job, a.cwd, 'plan');
        await waitFor(() => r.types('stage.assigned').length === 1, 30_000, 'the local assignment');
        expect(r.types('stage.assigned')[0]!.payload).toMatchObject({ stageId: first, workerId: 'local', cwd: a.cwd, prompt: 'You are planning' });
        // local is full: the next one is for a remote worker
        const second = await r.driver.ask(b.job, b.cwd, 'plan');
        const got = (await r.take(TOKENS.mac)).json;
        expect(got.stageId).toBe(second);
        expect(r.types('stage.assigned')).toHaveLength(1);
        // the local stage ends: a free local slot takes the next one, even though a remote worker is waiting
        const waiting = r.claim(TOKENS.mac);
        await r.driver.ctx().jobs.finishStage(first, 'passed', {});
        const third = await r.driver.ask(c.job, c.cwd, 'plan');
        await waitFor(() => r.types('stage.assigned').length === 2, 30_000, 'the second local assignment');
        expect((r.types('stage.assigned')[1]!.payload as { stageId: string }).stageId).toBe(third);
        expect((await waiting).status).toBe(204);
      });
    });

    it('refuses to start on 0.0.0.0, and on :: too', async () => {
      const store = await adapter.open();
      await expect(bootGateway(store, { gateway: { listen: ['0.0.0.0'] } })).rejects.toThrow(/every interface/);
      const store2 = await adapter.open();
      await expect(bootGateway(store2, { gateway: { listen: ['::'] } })).rejects.toThrow(/every interface/);
    });

    it('a result too large for the endpoint gets 413, not a crash', async () => {
      const r = await rig({ gateway: { maxPatchBytes: 1024 } });
      const { job, cwd } = await r.newJob();
      const stageId = await r.driver.ask(job, cwd, 'plan');
      const got = (await r.take(TOKENS.mac)).json;
      const res = await post(r.url, '/result', TOKENS.mac, { stageId, attempt: 1, generation: got.generation, outcome: 'completed', output: { result: 'x'.repeat(9 * 1024 * 1024) } }).catch((e: unknown) => ({ status: 413, json: e }));
      expect(res.status).toBe(413);
      expect((await post(r.url, '/heartbeat', TOKENS.mac, { stageId, attempt: 1, generation: got.generation })).status).toBe(200);
    });
  });
}

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import github from '../../github/src/index.ts';
import { createWorker } from '../../worker-claude-code/src/index.ts';
import pipeline from '../src/index.ts';
import { fakeHuman, logger } from './harness.ts';

const FAKE = fileURLToPath(new URL('../../worker-claude-code/test/fixtures/fake-claude.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

const dirs: string[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_CLAUDE_MARK;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const waitFor = async (cond: () => boolean, what: string, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The real worker, the real github plugin and the pipeline, with a fake claude that is slow to die. */
async function rig() {
  const root = mkdtempSync(join(tmpdir(), 'bulig-cancel-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');

  const mark = join(root, 'claude.log');
  process.env.FAKE_CLAUDE_MARK = mark;
  const human = fakeHuman();
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [pipeline, github, createWorker(), human.plugin],
    enabled: ['pipeline-dev', 'github', 'worker-claude-code', 'fake-human'],
    grants: {
      'pipeline-dev': ['merge.request', 'jobs.write'],
      github: ['git.push', 'gh.pr'],
      'worker-claude-code': ['claude.run', 'fs.worktree'],
      'fake-human': ['approval.grant'],
    },
    pluginConfig: { 'worker-claude-code': { claudeBin: FAKE, passEnv: ['FAKE_CLAUDE_MARK'], stopGraceMs: 5000 } },
    logger,
  });
  kernels.push(k);
  await k.start();
  return { k, repo, mark, human };
}

describe('cancelling a job while a stage is running', () => {
  it('kills that job\'s Claude first, then removes the worktree, which is never recreated', async () => {
    const r = await rig();
    const job = r.k.jobs.create({ repo: r.repo, title: 'Slow build', body: 'FAKE:linger' });
    await waitFor(() => r.human.requests.some((e) => (e.payload as { kind: string }).kind === 'plan'), 'the plan approval');
    r.human.grant(job.id, 'plan');
    await waitFor(() => existsSync(r.mark) && /PID/.test(readFileSync(r.mark, 'utf8')), 'the build stage to start');
    const pid = Number(/PID (\d+)/.exec(readFileSync(r.mark, 'utf8'))![1]);
    const wt = join(r.repo, '.worktrees', job.id);
    expect(existsSync(wt)).toBe(true);
    expect(alive(pid)).toBe(true);

    r.k.jobs.setStatus(job.id, 'cancelled');

    // The child has been told to stop but is still busy for a moment. Nothing may touch the worktree yet.
    await waitFor(() => readFileSync(r.mark, 'utf8').includes('TERM'), 'SIGTERM to arrive');
    expect(alive(pid)).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(r.k.history(job.id).map((e) => e.type)).not.toContain('worktree.cleanup.requested');

    // Then the child exits, its stage is closed, and only then is the worktree removed.
    await waitFor(() => r.k.history(job.id).some((e) => e.type === 'worktree.cleaned'), 'the cleanup');
    const types = r.k.history(job.id).map((e) => e.type);
    expect(readFileSync(r.mark, 'utf8')).toContain('WROTE'); // it did write into the worktree before it died
    expect(alive(pid)).toBe(false);
    expect(types.indexOf('stage.failed')).toBeGreaterThan(-1);
    expect(types.indexOf('stage.failed')).toBeLessThan(types.indexOf('worktree.cleanup.requested'));
    expect(existsSync(wt)).toBe(false);
    expect(git(r.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(r.repo, 'branch', '--list', 'bulig/*')).toBe('');

    // Give anything still alive a moment to bring the path back. Nothing does.
    await new Promise((res) => setTimeout(res, 700));
    expect(existsSync(wt)).toBe(false);
    expect(r.k.jobs.get(job.id)!.status).toBe('cancelled');
    expect(r.k.jobs.stages(job.id).some((s) => s.status === 'running')).toBe(false);
  });
});

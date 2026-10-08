import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { definePlugin } from '@bulig/plugin-sdk';
import github from '../../github/src/index.ts';
import pipeline from '../src/index.ts';
import { fakeHuman, logger } from './harness.ts';

// The real pipeline and the real github plugin on a real git repo. Only the worker is fake: it edits files in the
// job worktree the way Claude and the tools it runs would, including the file a test runner leaves behind.
const FAKE_GH = fileURLToPath(new URL('../../github/test/fixtures/fake-gh.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE_GH, 0o755));

const dirs: string[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_GH_STATE;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const JUNK = 'test-results/.last-run.json';

type Act = (stage: string, attempt: number, cwd: string) => string;

function rig(act: Act) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-scope-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'README.md'), '# project\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  const state = join(root, 'gh-state.json');
  writeFileSync(state, JSON.stringify({}));
  process.env.FAKE_GH_STATE = state;

  const counts: Record<string, number> = {};
  const seenStages: string[] = [];
  const worker = definePlugin({
    manifest: { name: 'fake-worker', version: '0.1.0', sdk: '0', description: 'edits files', subscribes: ['stage.requested'], emits: ['stage.completed'] },
    register(ctx) {
      ctx.on('stage.requested', (e) => {
        const p = e.payload as { stage: string; cwd: string };
        const attempt = (counts[p.stage] = (counts[p.stage] ?? 0) + 1);
        seenStages.push(p.stage);
        ctx.emit('stage.completed', { stage: p.stage, result: act(p.stage, attempt, p.cwd), sessionId: `s${seenStages.length}` }, e.jobId);
      });
    },
  });
  const human = fakeHuman();
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [pipeline, github, worker, human.plugin],
    enabled: ['pipeline-dev', 'github', 'fake-worker', 'fake-human'],
    grants: { 'pipeline-dev': ['merge.request', 'jobs.write'], github: ['git.push', 'gh.pr'], 'fake-human': ['approval.grant'] },
    pluginConfig: { github: { ghBin: FAKE_GH }, 'pipeline-dev': { keepFailedWorktrees: true } },
    logger,
  });
  kernels.push(k);
  return { k, repo, origin, human, seenStages };
}

const write = (cwd: string, rel: string, text: string) => {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};
const PLAN = 'Change the README.\n\nSCOPE:\n- README.md\n';
const PASS = 'ok\nVERDICT: PASS';

describe('scope guard end to end: a job told "README only"', () => {
  it('the test run leaves a results file; the next build removes it; the PR carries only README.md', async () => {
    const r = rig((stage, attempt, cwd) => {
      if (stage === 'plan') return PLAN;
      if (stage === 'build') {
        write(cwd, 'README.md', `# project\n\nedit ${attempt}\n`);
        rmSync(join(cwd, 'test-results'), { recursive: true, force: true }); // the feedback said to
        return 'built';
      }
      if (stage === 'test') {
        if (attempt === 1) write(cwd, JUNK, '{"status":"passed"}\n'); // what Playwright does
        return PASS;
      }
      if (stage === 'review') return PASS;
      return 'ok';
    });
    await r.k.start();
    const job = r.k.jobs.create({ repo: r.repo, title: 'Update the README', body: 'README only' });
    await waitUntil(() => r.human.requests.some((e) => (e.payload as { kind: string }).kind === 'plan'));
    r.human.grant(job.id, 'plan');
    await waitUntil(() => r.k.jobs.get(job.id)!.status === 'awaiting_approval' && r.human.requests.some((e) => (e.payload as { kind: string }).kind === 'merge'));

    expect(r.seenStages).toEqual(['plan', 'critique', 'build', 'test', 'build', 'test', 'docs', 'review']);
    const branch = git(r.repo, 'branch', '--list', 'bulig/*').replace(/^[*+ ]+/, '');
    const files = git(r.repo, 'diff', '--name-only', `main...${branch}`).split('\n');
    expect(files).toEqual(['README.md']);
    expect(git(r.origin, 'ls-tree', '-r', '--name-only', branch)).not.toContain('test-results');
  });

  it('a results file that comes back every time fails the job, and the files are named in the reason', async () => {
    const r = rig((stage, _attempt, cwd) => {
      if (stage === 'plan') return PLAN;
      if (stage === 'build') write(cwd, 'README.md', '# edited\n');
      if (stage === 'test') {
        write(cwd, JUNK, '{}\n');
        return PASS;
      }
      return stage === 'review' ? PASS : 'ok';
    });
    await r.k.start();
    const job = r.k.jobs.create({ repo: r.repo, title: 'Update the README', body: 'README only' });
    await waitUntil(() => r.human.requests.some((e) => (e.payload as { kind: string }).kind === 'plan'));
    r.human.grant(job.id, 'plan');
    await waitUntil(() => r.k.jobs.get(job.id)!.status === 'failed');
    const failed = r.k.history(job.id).find((e) => e.type === 'pipeline.failed')!.payload as { reason: string; outOfScope: string[] };
    expect(failed.outOfScope).toEqual([JUNK]);
    expect(failed.reason).toContain(JUNK);
    expect(r.k.history(job.id).map((e) => e.type)).not.toContain('pr.requested');
    // The refused commit never touched the branch with the junk in it.
    const branch = git(r.repo, 'branch', '--list', 'bulig/*').replace(/^[*+ ]+/, '');
    expect(git(r.repo, 'ls-tree', '-r', '--name-only', branch)).not.toContain('test-results');
    expect(existsSync(join(r.repo, '.worktrees', job.id, JUNK))).toBe(true);
  });
});

async function waitUntil(cond: () => boolean, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}

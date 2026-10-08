import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import github, { judgeChecks } from '../src/index.ts';

/** The scope the older tests commit under: every file they write is a .txt file. */
const SCOPE_TXT = ['*.txt'];
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_GH_STATE;
  delete process.env.TEST_GH_TOKEN;
});
beforeAll(() => chmodSync(FAKE_GH, 0o755));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare "origin" and a working clone of it with one commit on main. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'bulig-gh-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  return { root, origin, repo };
}

async function setup(config: Record<string, unknown> = {}, grants = ['git.push', 'gh.pr']) {
  const { root, origin, repo } = repos();
  const log = join(root, 'gh.log');
  const statePath = join(root, 'gh-state.json');
  const setState = (s: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ log, ...s }));
  setState({});
  process.env.FAKE_GH_STATE = statePath;

  const seen: BuligEvent[] = [];
  let fire: (type: string, payload: unknown, jobId?: string) => void = () => {};
  const driver = definePlugin({
    manifest: {
      name: 'driver',
      version: '0.1.0',
      sdk: '0',
      description: 'test driver',
      subscribes: ['worktree.ready', 'worktree.failed', 'worktree.cleaned', 'worktree.cleanup.failed', 'worktree.reset.done', 'worktree.reset.failed', 'commit.done', 'commit.failed', 'pr.opened', 'pr.failed', 'pr.merged', 'merge.refused', 'merge.failed'],
      emits: ['worktree.requested', 'worktree.cleanup.requested', 'worktree.reset.requested', 'commit.requested', 'pr.requested', 'merge.requested'],
      needs: ['merge.request'],
    },
    register(ctx) {
      for (const t of ['worktree.ready', 'worktree.failed', 'worktree.cleaned', 'worktree.cleanup.failed', 'worktree.reset.done', 'worktree.reset.failed', 'commit.done', 'commit.failed', 'pr.opened', 'pr.failed', 'pr.merged', 'merge.refused', 'merge.failed']) {
        ctx.on(t, (e) => void seen.push(e));
      }
      fire = (type, payload, jobId) => ctx.emit(type, payload, jobId);
    },
  });
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [github, driver],
    enabled: ['github', 'driver'],
    grants: { github: grants, driver: ['merge.request'] },
    pluginConfig: { github: { ghBin: FAKE_GH, ...config } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await k.start();
  const job = k.jobs.create({ repo, title: 'x' });
  const waitFor = async (type: string) => {
    const end = Date.now() + 10000;
    for (;;) {
      const hit = seen.find((e) => e.type === type);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${type}; saw ${seen.map((e) => e.type)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; token: string | null }) : [];
  return { k, job, repo, origin, root, seen, fire: (t: string, p: unknown) => fire(t, p, job.id), waitFor, setState, calls };
}

/** Request a worktree, add a file, open a PR. Returns the opened event payload. */
async function openPr(h: Awaited<ReturnType<typeof setup>>, branch = 'bulig/x-1') {
  h.fire('worktree.requested', { repoPath: h.repo, branch });
  const ready = (await h.waitFor('worktree.ready')).payload as { cwd: string };
  writeFileSync(join(ready.cwd, 'new.txt'), 'hello\n');
  h.fire('commit.requested', { cwd: ready.cwd, message: 'Add new.txt', scope: SCOPE_TXT });
  const { sha } = (await h.waitFor('commit.done')).payload as { sha: string };
  h.fire('pr.requested', { cwd: ready.cwd, branch, title: 'Add new.txt', body: 'because', expectSha: sha });
  const opened = (await h.waitFor('pr.opened')).payload as { url: string; number: number; headSha: string };
  return { cwd: ready.cwd, branch, ...opened };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('judgeChecks', () => {
  it('sorts passing, failing and pending', () => {
    expect(judgeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }])).toEqual({ failing: [], pending: [] });
    expect(judgeChecks([{ name: 'a', bucket: 'fail' }, { name: 'b', bucket: 'pending' }, { name: 'c', bucket: 'cancel' }])).toEqual({
      failing: ['a', 'c'],
      pending: ['b'],
    });
    expect(judgeChecks([{ name: 'odd', bucket: 'mystery' }]).pending).toEqual(['odd']);
  });
});

describe('worktree start point', () => {
  const ready = async (h: Awaited<ReturnType<typeof setup>>, branch: string) => {
    h.fire('worktree.requested', { repoPath: h.repo, branch });
    return (await h.waitFor('worktree.ready')).payload as { cwd: string; branch: string; base?: string };
  };

  it('starts at the base tip even when the checkout sits on a feature branch with extra commits', async () => {
    const h = await setup();
    git(h.repo, 'checkout', '-b', 'feature');
    writeFileSync(join(h.repo, 'feature.txt'), 'unrelated\n');
    git(h.repo, 'add', '-A');
    git(h.repo, 'commit', '-m', 'unrelated feature work');
    const { cwd, base } = await ready(h, 'bulig/s-1');
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('0');
    expect(git(cwd, 'merge-base', 'HEAD', 'main')).toBe(git(h.repo, 'rev-parse', 'main'));
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(h.repo, 'rev-parse', 'main'));
    expect(existsSync(join(cwd, 'feature.txt'))).toBe(false);
    expect(base).toMatch(/^origin\//);
  });

  it('starts from origin/main when the local main is behind it', async () => {
    const h = await setup();
    const other = join(h.root, 'other');
    execFileSync('git', ['clone', h.origin, other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(join(other, 'newer.txt'), 'newer\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'newer on origin');
    git(other, 'push', 'origin', 'main');
    const staleLocal = git(h.repo, 'rev-parse', 'main');
    const { cwd, base } = await ready(h, 'bulig/s-2');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(staleLocal);
    expect(existsSync(join(cwd, 'newer.txt'))).toBe(true);
    expect(base).toMatch(/^origin\//);
    expect(() => git(cwd, 'config', '--get', 'branch.bulig/s-2.remote')).toThrow(); // --no-track
  });

  it('falls back to the local base when there is no remote', async () => {
    const h = await setup();
    git(h.repo, 'remote', 'remove', 'origin');
    git(h.repo, 'checkout', '-b', 'feature');
    writeFileSync(join(h.repo, 'feature.txt'), 'unrelated\n');
    git(h.repo, 'add', '-A');
    git(h.repo, 'commit', '-m', 'unrelated feature work');
    const { cwd, base } = await ready(h, 'bulig/s-3');
    expect(base).toBe('main');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(h.repo, 'rev-parse', 'main'));
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('0');
  });

  it('fails the request when the fetch fails for a reason that will not pass', async () => {
    const h = await setup();
    git(h.repo, 'remote', 'set-url', 'origin', join(h.root, 'does-not-exist.git'));
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/s-4' });
    const failed = (await h.waitFor('worktree.failed')).payload as { error: string };
    expect(failed.error).toMatch(/git fetch failed/);
    expect(existsSync(join(h.repo, '.worktrees'))).toBe(false);
  });
  it('uses one base for the worktree start and the commit base, even when the configured base is stale locally', async () => {
    const h = await setup({ baseBranch: 'develop' });
    git(h.repo, 'branch', 'develop');
    git(h.repo, 'push', 'origin', 'develop');
    const other = join(h.root, 'other-dev');
    execFileSync('git', ['clone', '-b', 'develop', h.origin, other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(join(other, 'dev.txt'), 'dev\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'develop moves on');
    git(other, 'push', 'origin', 'develop');
    const tip = git(other, 'rev-parse', 'HEAD');
    expect(git(h.repo, 'rev-parse', 'develop')).not.toBe(tip); // the local copy lags
    const { cwd } = await ready(h, 'bulig/s-5');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(tip);
    writeFileSync(join(cwd, 'job.txt'), 'job\n');
    h.fire('commit.requested', { cwd, message: 'job work', scope: SCOPE_TXT });
    const { base } = (await h.waitFor('commit.done')).payload as { base: string };
    expect(base).toBe(tip);
    expect(git(cwd, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
  });

  it('fails the request when the configured baseBranch exists nowhere', async () => {
    const h = await setup({ baseBranch: 'no-such-branch' });
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/s-6' });
    const failed = (await h.waitFor('worktree.failed')).payload as { error: string };
    expect(failed.error).toMatch(/baseBranch "no-such-branch" was not found/);
    expect(existsSync(join(h.repo, '.worktrees'))).toBe(false);
  });
});

describe('github config', () => {
  it('refuses to start when only one of authorName and authorEmail is set', async () => {
    await expect(setup({ authorName: 'Bot' })).rejects.toThrow(/authorName and authorEmail/);
    await expect(setup({ authorEmail: 'bot@example.com' })).rejects.toThrow(/authorName and authorEmail/);
  });
});

describe('worktree.cleanup.requested', () => {
  it('removes the worktree and the local branch, but not the branch on origin', async () => {
    const h = await setup();
    const pr = await openPr(h, 'bulig/k-1'); // pushed, so origin has the branch
    expect(git(h.origin, 'branch', '--list', 'bulig/k-1')).not.toBe('');
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/k-1' });
    await h.waitFor('worktree.cleaned');
    expect(existsSync(pr.cwd)).toBe(false);
    expect(git(h.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(h.repo, 'branch', '--list', 'bulig/k-1')).toBe('');
    expect(git(h.origin, 'branch', '--list', 'bulig/k-1')).not.toBe('');
  });

  it('removes a worktree that has uncommitted work in it', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/k-2' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'unsaved.txt'), 'x\n');
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/k-2' });
    await h.waitFor('worktree.cleaned');
    expect(existsSync(cwd)).toBe(false);
    expect(git(h.repo, 'branch', '--list', 'bulig/k-2')).toBe('');
  });

  it('is safe to ask twice, and when nothing was ever created', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/k-3' });
    await h.waitFor('worktree.ready');
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/k-3' });
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/k-3' });
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/never-made' });
    for (let end = Date.now() + 10_000; h.seen.filter((e) => e.type === 'worktree.cleaned').length < 3 && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.seen.filter((e) => e.type === 'worktree.cleaned')).toHaveLength(3);
    expect(h.seen.some((e) => e.type === 'worktree.cleanup.failed')).toBe(false);
  });

  it('only ever removes the job\'s own worktree and never the base branch', async () => {
    const h = await setup();
    const elsewhere = join(h.root, 'precious');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'f.txt'), 'x\n');
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/k-4' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    // A request cannot point the cleanup at another path, and cannot name main.
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'main', cwd: elsewhere });
    await h.waitFor('worktree.cleaned');
    expect(existsSync(join(elsewhere, 'f.txt'))).toBe(true);
    expect(existsSync(cwd)).toBe(false); // the job's own worktree went
    expect(git(h.repo, 'branch', '--list', 'main')).not.toBe('');
    expect(git(h.repo, 'branch', '--list', 'bulig/k-4')).not.toBe(''); // a different branch name was asked for, so it stays
  });
});

describe('worktree.reset.requested', () => {
  it('puts the job worktree back to its last commit and removes new files', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/r-1' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'kept.txt'), 'committed work\n');
    h.fire('commit.requested', { cwd, message: 'checkpoint', scope: SCOPE_TXT });
    await h.waitFor('commit.done');
    // What a cut-off stage leaves: an edited tracked file, a staged new file, an untracked file and folder.
    writeFileSync(join(cwd, 'kept.txt'), 'half written\n');
    writeFileSync(join(cwd, 'a.txt'), 'changed\n');
    writeFileSync(join(cwd, 'staged.txt'), 's\n');
    git(cwd, 'add', 'staged.txt');
    writeFileSync(join(cwd, 'stray.txt'), 'x\n');
    mkdirSync(join(cwd, 'newdir'));
    writeFileSync(join(cwd, 'newdir', 'f.txt'), 'x\n');

    h.fire('worktree.reset.requested', { cwd });
    await h.waitFor('worktree.reset.done');
    expect(readFileSync(join(cwd, 'kept.txt'), 'utf8')).toBe('committed work\n');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\n');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(cwd, 'stray.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'newdir'))).toBe(false);
  });

  it('touches nothing but the job worktree: not the main checkout, not a lookalike folder, not a subfolder', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/r-2' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    // Work the main checkout has that must survive.
    writeFileSync(join(h.repo, 'a.txt'), 'my own edit\n');
    writeFileSync(join(h.repo, 'mine.txt'), 'untracked and precious\n');
    // A folder that has the right name but is not a git worktree: git would act on the main repo from there.
    const lookalike = join(h.repo, '.worktrees', h.job.id + '-x');
    mkdirSync(lookalike);
    const disguised = join(h.repo, '.worktrees');

    const tries = [h.repo, join(cwd, 'sub'), lookalike, disguised, join(h.root, 'elsewhere')];
    mkdirSync(join(cwd, 'sub'));
    mkdirSync(join(h.root, 'elsewhere'));
    for (const t of tries) {
      h.seen.length = 0;
      h.fire('worktree.reset.requested', { cwd: t });
      const failed = await h.waitFor('worktree.reset.failed');
      expect((failed.payload as { error: string }).error, t).toMatch(/refusing|gone/);
    }
    // Same name as the job, same parent folder name, but a plain directory inside the main repo.
    const plain = join(h.root, 'fake', '.worktrees', h.job.id);
    mkdirSync(plain, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(h.root, 'fake') });
    writeFileSync(join(h.root, 'fake', 'precious.txt'), 'x\n');
    h.seen.length = 0;
    h.fire('worktree.reset.requested', { cwd: plain });
    await h.waitFor('worktree.reset.failed');

    expect(readFileSync(join(h.repo, 'a.txt'), 'utf8')).toBe('my own edit\n');
    expect(readFileSync(join(h.repo, 'mine.txt'), 'utf8')).toBe('untracked and precious\n');
    expect(existsSync(join(h.root, 'fake', 'precious.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'sub'))).toBe(true);
  });
});

describe('commit.requested', () => {
  it('commits what the stages left, reports the commit and where the branch left main', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/c-1' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'c.txt'), 'c\n');
    h.fire('commit.requested', { cwd, message: 'Do the thing', scope: SCOPE_TXT });
    const done = (await h.waitFor('commit.done')).payload as { sha: string; base: string };
    expect(done.sha).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(done.base).toBe(git(h.repo, 'rev-parse', 'main'));
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('Do the thing');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('signs the commit with the configured author, not git\'s own identity', async () => {
    const h = await setup({ authorName: 'Bulig Bot', authorEmail: '1+buligbot@users.noreply.github.com' });
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/c-id' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'c.txt'), 'c\n');
    h.fire('commit.requested', { cwd, message: 'signed', scope: SCOPE_TXT });
    await h.waitFor('commit.done');
    expect(git(cwd, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      'Bulig Bot <1+buligbot@users.noreply.github.com>|Bulig Bot <1+buligbot@users.noreply.github.com>',
    );
  });

  it('is safe to ask twice: a clean tree gives the same commit and makes no new one', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/c-2' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'c.txt'), 'c\n');
    h.fire('commit.requested', { cwd, message: 'once', scope: SCOPE_TXT });
    const first = (await h.waitFor('commit.done')).payload as { sha: string };
    h.seen.length = 0;
    h.fire('commit.requested', { cwd, message: 'twice', scope: SCOPE_TXT });
    const second = (await h.waitFor('commit.done')).payload as { sha: string };
    expect(second.sha).toBe(first.sha);
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('1');
  });

  it('emits commit.failed when the directory is not a repo', async () => {
    const h = await setup();
    h.fire('commit.requested', { cwd: h.root, message: 'x', scope: SCOPE_TXT });
    const failed = await h.waitFor('commit.failed');
    expect((failed.payload as { error: string }).error).toMatch(/git/);
  });
});

describe('worktree.requested', () => {
  it('adds a worktree on a new branch under .worktrees/<jobId> and says where', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-1' });
    const ready = (await h.waitFor('worktree.ready')).payload as { cwd: string; branch: string };
    expect(ready.cwd).toBe(join(h.repo, '.worktrees', h.job.id));
    expect(ready.branch).toBe('bulig/x-1');
    expect(git(ready.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('bulig/x-1');
    // The repo's own status does not show the worktree folder.
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });

  it('is safe to ask twice for the same job', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/again' });
    await h.waitFor('worktree.ready');
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/again' });
    // Poll instead of sleeping a fixed time: a loaded machine can take longer than that.
    for (let end = Date.now() + 10_000; h.seen.filter((e) => e.type === 'worktree.ready').length < 2 && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.seen.filter((e) => e.type === 'worktree.ready')).toHaveLength(2);
    expect(h.seen.some((e) => e.type === 'worktree.failed')).toBe(false);
  });

  it('emits worktree.failed when the branch already exists', async () => {
    const h = await setup();
    git(h.repo, 'branch', 'bulig/dup');
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/dup' });
    const failed = await h.waitFor('worktree.failed');
    expect((failed.payload as { error: string }).error).toMatch(/git worktree add failed/);
  });
});

describe('pr.requested', () => {
  it('commits leftovers, pushes, opens the PR and reports number and head sha', async () => {
    const h = await setup();
    const pr = await openPr(h);
    expect(pr.url).toBe('https://github.com/example/repo/pull/7');
    expect(pr.number).toBe(7);
    // The head sha is the pushed commit, and the file went in.
    expect(git(h.origin, 'rev-parse', 'bulig/x-1')).toBe(pr.headSha);
    expect(git(h.origin, 'show', 'bulig/x-1:new.txt')).toBe('hello');
    expect(git(h.origin, 'log', '-1', '--format=%s', 'bulig/x-1')).toBe('Add new.txt');
    const create = h.calls().find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(expect.arrayContaining(['--title', 'Add new.txt', '--head', 'bulig/x-1']));
  });

  it('refuses to open the PR when HEAD is not the commit that was reviewed', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-4' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'r.txt'), 'reviewed\n');
    h.fire('commit.requested', { cwd, message: 'work', scope: SCOPE_TXT });
    const { sha } = (await h.waitFor('commit.done')).payload as { sha: string };
    // Something commits again after the review.
    writeFileSync(join(cwd, 'sneaky.txt'), 'late change\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'late');
    h.fire('pr.requested', { cwd, branch: 'bulig/x-4', title: 'T', body: '', expectSha: sha });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/HEAD is [0-9a-f]{7} but the reviewed commit is [0-9a-f]{7}/);
    expect(h.seen.some((e) => e.type === 'pr.opened')).toBe(false);
    expect(h.calls().some((c) => c.args[1] === 'create')).toBe(false);
    expect(git(h.origin, 'branch', '--list', 'bulig/x-4')).toBe('');
  });

  it('refuses to open the PR when files changed after the review and were never committed', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-5' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'r.txt'), 'reviewed\n');
    h.fire('commit.requested', { cwd, message: 'work', scope: SCOPE_TXT });
    const { sha } = (await h.waitFor('commit.done')).payload as { sha: string };
    writeFileSync(join(cwd, 'r.txt'), 'edited after review\n');
    h.fire('pr.requested', { cwd, branch: 'bulig/x-5', title: 'T', body: '', expectSha: sha });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/never committed or reviewed/);
    expect(h.seen.some((e) => e.type === 'pr.opened')).toBe(false);
    expect(git(h.origin, 'branch', '--list', 'bulig/x-5')).toBe('');
  });

  it('refuses a PR request that names no reviewed commit', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-6' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    h.fire('pr.requested', { cwd, branch: 'bulig/x-6', title: 'T', body: '' });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/expectSha/);
  });

  it('does not make an empty commit when the work is already committed', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-2' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'b.txt'), 'b\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'claude made this');
    h.fire('pr.requested', { cwd, branch: 'bulig/x-2', title: 'T', body: '', expectSha: git(cwd, 'rev-parse', 'HEAD') });
    await h.waitFor('pr.opened');
    expect(git(h.origin, 'log', '--format=%s', 'main..bulig/x-2')).toBe('claude made this');
  });

  it('emits pr.failed when the push fails', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-3' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    git(cwd, 'remote', 'set-url', 'origin', join(h.root, 'missing.git'));
    h.fire('pr.requested', { cwd, branch: 'bulig/x-3', title: 'T', body: '', expectSha: git(cwd, 'rev-parse', 'HEAD') });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/git push failed/);
  });
});

describe('merge.requested', () => {
  it('merges when the head matches and checks pass, then removes the worktree', async () => {
    const h = await setup();
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pass' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const merged = await h.waitFor('pr.merged');
    expect(merged.payload).toEqual({ number: 7 });
    expect(h.calls().some((c) => c.args[1] === 'merge' && c.args.includes('--squash') && c.args.includes('--delete-branch'))).toBe(true);
    expect(existsSync(pr.cwd)).toBe(false);
    expect(git(h.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(h.repo, 'branch', '--list', 'bulig/x-1')).toBe('');
  });

  it('pins the merge to the approved commit', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    const merge = h.calls().find((c) => c.args[1] === 'merge')!;
    const at = merge.args.indexOf('--match-head-commit');
    expect(at).toBeGreaterThan(-1);
    expect(merge.args[at + 1]).toBe(pr.headSha);
  });

  it('fails closed when a push lands between the head check and the merge', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    // The pre-merge view still shows the approved head; by the time gh merges, the branch has moved.
    h.setState({ log: join(h.root, 'gh.log'), mergeHead: 'e'.repeat(40) });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const refused = await h.waitFor('merge.refused');
    expect((refused.payload as { reason: string }).reason).toMatch(/gh pr merge failed.*Head branch was modified/s);
    expect(h.seen.some((e) => e.type === 'pr.merged')).toBe(false);
    expect(existsSync(pr.cwd)).toBe(true);
  });

  it('gives up (no re-ask) when the PR head moved since approval', async () => {
    const h = await setup();
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pass' }], headRefOid: 'f'.repeat(40) });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/head moved/);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(existsSync(pr.cwd)).toBe(true);
  });

  it('fails for good on a failing check, names it, and never calls merge', async () => {
    const h = await setup();
    const pr = await openPr(h);
    h.setState({
      log: join(h.root, 'gh.log'),
      checks: [{ name: 'Typecheck & build', bucket: 'fail', link: 'https://example.test/runs/9' }, { name: 'lint', bucket: 'pass' }],
    });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect(failed.payload).toEqual({
      reason: 'checks failing: Typecheck & build. Fix the failing check, then run the job again.',
      checks: [{ name: 'Typecheck & build', link: 'https://example.test/runs/9' }],
    });
    expect(h.seen.some((e) => e.type === 'merge.refused')).toBe(false);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('waits for pending checks and merges when they turn green, on the one approval', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 10_000 });
    const pr = await openPr(h);
    const pending = [{ name: 'ci', bucket: 'pending' }];
    h.setState({ log: join(h.root, 'gh.log'), checksSequence: [pending, pending, pending, [{ name: 'ci', bucket: 'pass' }]] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(4);
    expect(h.calls().filter((c) => c.args[1] === 'merge')).toHaveLength(1);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
  });

  it('waits for pending checks and fails with their names when they turn red', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 10_000 });
    const pr = await openPr(h);
    h.setState({
      log: join(h.root, 'gh.log'),
      checksSequence: [[{ name: 'unit', bucket: 'pending' }, { name: 'e2e', bucket: 'pending' }], [{ name: 'unit', bucket: 'fail' }, { name: 'e2e', bucket: 'fail' }]],
    });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/^checks failing: unit, e2e\. Fix the failing check, then run the job again\.$/);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('fails with a timeout message when checks stay pending past checksWaitMs', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 800 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pending' }] });
    const t0 = Date.now();
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/^checks still pending after 0 minutes: ci/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(790); // it really waited the whole time before giving up
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'merge.refused')).toBe(false);
  });

  it('stops waiting at once when the job is cancelled, and never calls merge', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 60_000 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pending' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => h.calls().filter((c) => c.args[1] === 'checks').length >= 2);
    h.k.jobs.setStatus(h.job.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 150));
    const polls = h.calls().filter((c) => c.args[1] === 'checks').length;
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(polls); // no more looking
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed' || e.type === 'pr.merged')).toBe(false);
  });

  it('does not merge if the job was cancelled just as the checks turned green', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 60_000 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pass' }] });
    h.k.jobs.setStatus(h.job.id, 'running');
    h.k.jobs.setStatus(h.job.id, 'cancelled');
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'pr.merged')).toBe(false);
  });

  it('does not merge when the job is cancelled during the last read of the checks', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 60_000 });
    const pr = await openPr(h);
    // gh answers green, but slowly, and does not stop when asked, so the answer still arrives after the cancel.
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pass' }], checksDelayMs: 700, ignoreTerm: true });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => h.calls().some((c) => c.args[1] === 'checks'));
    h.k.jobs.setStatus(h.job.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'pr.merged' || e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
  });

  it('kills a hung gh call after ghTimeoutMs, tries it again as a temporary failure, and then merges', async () => {
    const h = await setup({ ghTimeoutMs: 2500, tries: 3, retryDelayMs: 5 });
    const pr = await openPr(h);
    const pidFile = join(h.root, 'pids');
    h.setState({ log: join(h.root, 'gh.log'), pidFile, hangChecksFirst: 1, checks: [{ name: 'ci', bucket: 'pass' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(2);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(false);
  });

  it('fails for good when gh keeps hanging', async () => {
    const h = await setup({ ghTimeoutMs: 2500, tries: 2, retryDelayMs: 5 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), pidFile: join(h.root, 'pids'), hangChecksFirst: 99 });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/^could not read checks: timed out after 2500ms/);
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(2);
  });

  it('cancel ends a running gh call at once, instead of waiting for its timeout', async () => {
    const h = await setup({ ghTimeoutMs: 60_000 });
    const pr = await openPr(h);
    const pidFile = join(h.root, 'pids');
    h.setState({ log: join(h.root, 'gh.log'), pidFile, hangChecksFirst: 99 });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8').trim().split('\n')[0]);
    h.k.jobs.setStatus(h.job.id, 'cancelled');
    await until(() => !alive(pid), 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed' || e.type === 'pr.merged')).toBe(false);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('stop ends a running gh call at once', async () => {
    const h = await setup({ ghTimeoutMs: 60_000 });
    const pr = await openPr(h);
    const pidFile = join(h.root, 'pids');
    h.setState({ log: join(h.root, 'gh.log'), pidFile, hangChecksFirst: 99 });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8').trim().split('\n')[0]);
    await h.k.stop();
    await until(() => !alive(pid), 5000);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed' || e.type === 'pr.merged')).toBe(false);
  });

  it('stops waiting when the plugin stops, and never calls merge', async () => {
    const h = await setup({ checksPollMs: 20, checksWaitMs: 60_000 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket: 'pending' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => h.calls().filter((c) => c.args[1] === 'checks').length >= 2);
    await h.k.stop();
    await new Promise((r) => setTimeout(r, 100));
    const polls = h.calls().filter((c) => c.args[1] === 'checks').length;
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(polls);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
  });

  it('still retries a temporary failure to read checks, then merges', async () => {
    const h = await setup({ tries: 3, retryDelayMs: 5 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checksErrorFirst: 2, checks: [{ name: 'ci', bucket: 'pass' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(3);
  });

  it('cancel ends the wait between retries at once, instead of sleeping out the delay', async () => {
    const h = await setup({ tries: 3, retryDelayMs: 60_000 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checksErrorFirst: 99, checks: [{ name: 'ci', bucket: 'pass' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await until(() => h.calls().filter((c) => c.args[1] === 'checks').length === 1);
    h.k.jobs.setStatus(h.job.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 300));
    // No second try after the cancel, and nothing reported or merged.
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(1);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed' || e.type === 'pr.merged')).toBe(false);
  });

  it('fails for good when checks still cannot be read after the retries', async () => {
    const h = await setup({ tries: 3, retryDelayMs: 5 });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), checksErrorFirst: 99, checks: [{ name: 'ci', bucket: 'pass' }] });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/^could not read checks: .*502/);
    expect(h.calls().filter((c) => c.args[1] === 'checks').length).toBe(3);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('treats no checks as a permanent failure unless allowNoChecks is on', async () => {
    const strict = await setup();
    const a = await openPr(strict);
    strict.fire('merge.requested', { cwd: a.cwd, number: a.number, headSha: a.headSha });
    expect(((await strict.waitFor('merge.failed')).payload as { reason: string }).reason).toMatch(/no checks/);
    expect(strict.seen.some((e) => e.type === 'merge.refused')).toBe(false);

    const relaxed = await setup({ allowNoChecks: true });
    const b = await openPr(relaxed);
    relaxed.fire('merge.requested', { cwd: b.cwd, number: b.number, headSha: b.headSha });
    await relaxed.waitFor('pr.merged');
  });

  it('counts the PR as merged when gh merges but then fails to tidy up locally', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), mergeExit: 1, mergeAnyway: true, mergeError: "'main' is already checked out" });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    expect(existsSync(pr.cwd)).toBe(false);
  });

  it('fails for good when the PR cannot be merged because of a conflict', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), mergeExit: 1, mergeError: 'merge conflict' });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/merge conflict/);
    expect(h.seen.some((e) => e.type === 'merge.refused')).toBe(false);
    expect(existsSync(pr.cwd)).toBe(true);
  });

  it('fails for good when branch protection wants a review or a required check', async () => {
    for (const msg of [
      'GraphQL: Repository rule violations found: base branch policy prohibits the merge',
      'X Pull request is not mergeable: the base branch policy prohibits the merge. Required reviews are missing.',
      'GraphQL: 2 of 2 required status checks are expected.',
      'At least 1 approving review is required by reviewers with write access.',
    ]) {
      const h = await setup({ allowNoChecks: true });
      const pr = await openPr(h);
      h.setState({ log: join(h.root, 'gh.log'), mergeExit: 1, mergeError: msg });
      h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
      const failed = await h.waitFor('merge.failed');
      expect((failed.payload as { reason: string }).reason).toContain(msg);
      expect(h.seen.some((e) => e.type === 'merge.refused')).toBe(false);
    }
  });

  it('refuses (may be asked again) when gh fails to merge for a reason that can pass by itself', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), mergeExit: 1, mergeError: 'GraphQL: GraphQL: Something went wrong while executing your query. Please try again.' });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const refused = await h.waitFor('merge.refused');
    expect((refused.payload as { reason: string }).reason).toMatch(/Something went wrong/);
    expect(existsSync(pr.cwd)).toBe(true);
  });

  it('a merge that already landed at the approved commit counts as merged, without merging again', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), prState: 'MERGED' });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const merged = await h.waitFor('pr.merged');
    expect(merged.payload).toEqual({ number: 7 });
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
    expect(existsSync(pr.cwd)).toBe(false);
    expect(git(h.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(h.repo, 'branch', '--list', 'bulig/x-1')).toBe('');
  });

  it('resumes a crash that happened after the merge and after the cleanup too', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    // The first attempt merged and tidied up, then the process died before it said so.
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    await h.waitFor('pr.merged');
    expect(existsSync(pr.cwd)).toBe(false);
    h.seen.length = 0;
    h.setState({ log: join(h.root, 'gh.log'), prState: 'MERGED', headRefOid: pr.headSha });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha, branch: pr.branch });
    const again = await h.waitFor('pr.merged');
    expect(again.payload).toEqual({ number: 7 });
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
  });

  it('a PR merged at some other commit than the approved one is a hard failure, not a retry', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), prState: 'MERGED', headRefOid: 'd'.repeat(40) });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/merged at ddddddd, not the approved/);
    expect(h.seen.some((e) => e.type === 'pr.merged' || e.type === 'merge.refused')).toBe(false);
  });

  it('a PR closed without merging fails the merge for good', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), prState: 'CLOSED' });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const failed = await h.waitFor('merge.failed');
    expect((failed.payload as { reason: string }).reason).toMatch(/PR #7 was closed without being merged/);
    expect(h.seen.some((e) => e.type === 'merge.refused' || e.type === 'pr.merged')).toBe(false);
    expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
  });
});

const FLAKY_GIT = fileURLToPath(new URL('./fixtures/flaky-git.mjs', import.meta.url));

describe('temporary failures', () => {
  const flaky = async (failFirst: number, message?: string) => {
    chmodSync(FLAKY_GIT, 0o755);
    const counter = join(mkdtempSync(join(tmpdir(), 'bulig-flaky-')), 'n');
    dirs.push(join(counter, '..'));
    process.env.FLAKY_COUNTER = counter;
    process.env.FLAKY_FAIL_FIRST = String(failFirst);
    if (message) process.env.FLAKY_MESSAGE = message;
    const h = await setup({ gitBin: FLAKY_GIT, tries: 3, retryDelayMs: 5 });
    const pushes = () => Number(existsSync(counter) ? readFileSync(counter, 'utf8') : 0);
    return { h, pushes };
  };
  afterEach(() => {
    delete process.env.FLAKY_COUNTER;
    delete process.env.FLAKY_FAIL_FIRST;
    delete process.env.FLAKY_MESSAGE;
  });

  it('tries a push again after a GitHub 500 and then opens the PR', async () => {
    const { h, pushes } = await flaky(2);
    await openPr(h);
    expect(pushes()).toBe(3);
  });

  it('gives up after the allowed tries and reports the last error', async () => {
    const { h, pushes } = await flaky(99);
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-5' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    h.fire('pr.requested', { cwd, branch: 'bulig/x-5', title: 'T', body: '', expectSha: git(cwd, 'rev-parse', 'HEAD') });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/Internal Server Error/);
    expect(pushes()).toBe(3);
  });

  it('does not retry an error that will not pass, such as a permission failure', async () => {
    const { h, pushes } = await flaky(99, 'remote: Permission to x.git denied to someone');
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-6' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    h.fire('pr.requested', { cwd, branch: 'bulig/x-6', title: 'T', body: '', expectSha: git(cwd, 'rev-parse', 'HEAD') });
    await h.waitFor('pr.failed');
    expect(pushes()).toBe(1);
  });

  it('uses the existing PR when gh says one already exists', async () => {
    const h = await setup();
    h.setState({ log: join(h.root, 'gh.log'), createExists: true });
    const pr = await openPr(h);
    expect(pr.url).toBe('https://github.com/example/repo/pull/7');
  });
});

describe('token and grants', () => {
  it('passes the token named by tokenEnv to gh as GH_TOKEN', async () => {
    process.env.TEST_GH_TOKEN = 'tok-123';
    const h = await setup({ tokenEnv: 'TEST_GH_TOKEN' });
    await openPr(h);
    expect(h.calls().length).toBeGreaterThan(0);
    expect(h.calls().every((c) => c.token === 'tok-123')).toBe(true);
  });

  it('uses ambient auth when tokenEnv is not set', async () => {
    const before = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const h = await setup();
      await openPr(h);
      expect(h.calls().every((c) => c.token === null)).toBe(true);
    } finally {
      if (before !== undefined) process.env.GH_TOKEN = before;
    }
  });

  it('fails the step with a clear message when tokenEnv points at nothing', async () => {
    const h = await setup({ tokenEnv: 'TEST_GH_TOKEN_MISSING' });
    // The worktree step fetches from origin, so it needs the token and says so.
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-9' });
    const refused = await h.waitFor('worktree.failed');
    expect((refused.payload as { error: string }).error).toMatch(/TEST_GH_TOKEN_MISSING.*not set/);
    // Local git work needs no token. The step that talks to GitHub is the one that fails.
    const cwd = join(h.root, 'manual-wt');
    git(h.repo, 'worktree', 'add', cwd, '-b', 'bulig/x-9');
    h.fire('pr.requested', { cwd, branch: 'bulig/x-9', title: 'T', body: '', expectSha: git(cwd, 'rev-parse', 'HEAD') });
    const failed = await h.waitFor('pr.failed');
    expect((failed.payload as { error: string }).error).toMatch(/TEST_GH_TOKEN_MISSING.*not set/);
  });

  it('will not start without both grants', async () => {
    await expect(setup({}, ['git.push'])).rejects.toThrow(/gh\.pr/);
  });
});

describe('a planted symlink never redirects a reset or a cleanup', () => {
  /** A second repo with uncommitted work that must survive. `home` is where the job-id folder sits in it. */
  function victim(root: string) {
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init', '-b', 'main');
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(join(other, 'precious.txt'), 'committed\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'init');
    writeFileSync(join(other, 'precious.txt'), 'uncommitted work\n');
    writeFileSync(join(other, 'untracked.txt'), 'also precious\n');
    return other;
  }
  const intact = (other: string) => {
    expect(readFileSync(join(other, 'precious.txt'), 'utf8')).toBe('uncommitted work\n');
    expect(readFileSync(join(other, 'untracked.txt'), 'utf8')).toBe('also precious\n');
  };
  const errorOf = (e: BuligEvent) => (e.payload as { error: string }).error;

  it('.worktrees itself is a symlink to another place that holds a repo named after the job', async () => {
    const h = await setup();
    const store = join(h.root, 'store');
    mkdirSync(store);
    const other = victim(h.root);
    // <store>/<jobId> is a whole repo with uncommitted work, so git itself sees a valid worktree root there.
    execFileSync('mv', [other, join(store, h.job.id)]);
    symlinkSync(store, join(h.repo, '.worktrees'));
    const cwd = join(h.repo, '.worktrees', h.job.id);
    const real = join(store, h.job.id);

    h.fire('worktree.reset.requested', { cwd });
    expect(errorOf(await h.waitFor('worktree.reset.failed'))).toMatch(/symlink/);
    intact(real);

    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/x' });
    expect(errorOf(await h.waitFor('worktree.cleanup.failed'))).toMatch(/symlink/);
    expect(existsSync(real)).toBe(true);
    intact(real);

    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/y' });
    expect(errorOf(await h.waitFor('worktree.failed'))).toMatch(/symlink/);
    expect(existsSync(join(store, h.job.id, '.git'))).toBe(true);
  });

  it('.worktrees/<jobId> is a symlink to another repo', async () => {
    const h = await setup();
    const other = victim(h.root);
    mkdirSync(join(h.repo, '.worktrees'));
    symlinkSync(other, join(h.repo, '.worktrees', h.job.id));
    const cwd = join(h.repo, '.worktrees', h.job.id);

    h.fire('worktree.reset.requested', { cwd });
    expect(errorOf(await h.waitFor('worktree.reset.failed'))).toMatch(/symlink/);
    intact(other);

    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/x' });
    expect(errorOf(await h.waitFor('worktree.cleanup.failed'))).toMatch(/symlink/);
    expect(existsSync(other)).toBe(true);
    intact(other);
  });

  it('a real worktree still resets and cleans up as before', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/ok-1' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'stray.txt'), 'x\n');
    h.fire('worktree.reset.requested', { cwd });
    await h.waitFor('worktree.reset.done');
    expect(existsSync(join(cwd, 'stray.txt'))).toBe(false);
    h.fire('worktree.cleanup.requested', { repoPath: h.repo, branch: 'bulig/ok-1' });
    await h.waitFor('worktree.cleaned');
    expect(existsSync(cwd)).toBe(false);
  });
});

describe('hooks planted in a job worktree', () => {
  const HOOK = (out: string) => `#!/bin/sh\necho "RAN token=$GH_TOKEN" >> "${out}"\nexit 0\n`;

  /** A git wrapper that records, for every call, whether GH_TOKEN was in its environment, then runs the real git. */
  function gitWrapper(root: string) {
    const log = join(root, 'git-calls.log');
    const bin = join(root, 'git-wrapper.sh');
    writeFileSync(bin, `#!/bin/sh\nif [ -n "$GH_TOKEN" ]; then t=TOKEN; else t=NOTOKEN; fi\necho "$t $*" >> "${log}"\nexec git "$@"\n`);
    chmodSync(bin, 0o755);
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  it('a .husky or .git/hooks hook does not run on commit or on the push, and never sees the token', async () => {
    process.env.TEST_GH_TOKEN = 'tok-secret-9';
    const h = await setup({ tokenEnv: 'TEST_GH_TOKEN' });
    const out = join(h.root, 'hook-ran.log');
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/hook-1' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    // Hooks a stage could plant: husky style (core.hooksPath into the tree) and the shared .git/hooks.
    mkdirSync(join(cwd, '.husky'));
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
      writeFileSync(join(cwd, '.husky', name), HOOK(out));
      chmodSync(join(cwd, '.husky', name), 0o755);
      writeFileSync(join(h.repo, '.git', 'hooks', name), HOOK(out));
      chmodSync(join(h.repo, '.git', 'hooks', name), 0o755);
    }
    git(h.repo, 'config', 'core.hooksPath', join(cwd, '.husky'));
    writeFileSync(join(cwd, 'new.txt'), 'hello\n');
    h.fire('commit.requested', { cwd, message: 'Add new.txt', scope: [...SCOPE_TXT, '.husky/*'] });
    const { sha } = (await h.waitFor('commit.done')).payload as { sha: string };
    expect(existsSync(out)).toBe(false);
    h.fire('pr.requested', { cwd, branch: 'bulig/hook-1', title: 't', body: 'b', expectSha: sha });
    await h.waitFor('pr.opened');
    expect(existsSync(out)).toBe(false);
    expect(git(h.origin, 'branch', '--list', 'bulig/hook-1')).not.toBe(''); // the push itself did happen
  });

  it('GH_TOKEN reaches git push and gh, and no commit, reset or status', async () => {
    process.env.TEST_GH_TOKEN = 'tok-secret-9';
    const wrapRoot = mkdtempSync(join(tmpdir(), 'bulig-wrap-'));
    dirs.push(wrapRoot);
    const w = gitWrapper(wrapRoot);
    const h = await setup({ tokenEnv: 'TEST_GH_TOKEN', gitBin: w.bin });
    await openPr(h, 'bulig/tok-1');
    h.fire('worktree.reset.requested', { cwd: join(h.repo, '.worktrees', h.job.id) });
    await h.waitFor('worktree.reset.done');
    const calls = w.calls();
    const withToken = calls.filter((c) => c.startsWith('TOKEN '));
    expect(withToken.length).toBeGreaterThan(0);
    for (const c of withToken) expect(c, c).toMatch(/ (push|fetch) /);
    for (const verb of ['commit', 'reset', 'status', 'add', 'clean']) {
      expect(calls.some((c) => c.startsWith('NOTOKEN ') && c.includes(` ${verb} `)), verb).toBe(true);
      expect(withToken.some((c) => c.includes(` ${verb} `)), verb).toBe(false);
    }
    expect(h.calls().every((c) => c.token === 'tok-secret-9')).toBe(true); // gh still gets it
  });

  it('every git call carries core.hooksPath=/dev/null', async () => {
    const wrapRoot = mkdtempSync(join(tmpdir(), 'bulig-wrap-'));
    dirs.push(wrapRoot);
    const w = gitWrapper(wrapRoot);
    const h = await setup({ gitBin: w.bin });
    await openPr(h, 'bulig/hp-1');
    const calls = w.calls();
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) expect(c, c).toContain('-c core.hooksPath=/dev/null');
    expect(calls.some((c) => c.includes(' commit -m '))).toBe(true);
  });
});

describe('scope guard on commit.requested', () => {
  type H = Awaited<ReturnType<typeof setup>>;
  const worktree = async (h: H, branch: string) => {
    h.fire('worktree.requested', { repoPath: h.repo, branch });
    return ((await h.waitFor('worktree.ready')).payload as { cwd: string }).cwd;
  };
  /** Ask for a commit and wait for whichever answer comes first. */
  const commit = async (h: H, cwd: string, extra: Record<string, unknown>) => {
    h.seen.length = 0;
    h.fire('commit.requested', { cwd, message: 'job work', ...extra });
    const end = Date.now() + 10000;
    for (;;) {
      const hit = h.seen.find((e) => e.type === 'commit.done' || e.type === 'commit.failed');
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no answer to commit.requested; saw ${h.seen.map((e) => e.type)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const write = (cwd: string, rel: string, text = 'x\n') => {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  };
  const committed = (cwd: string) => git(cwd, '-c', 'core.quotepath=off', 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  const failure = (e: BuligEvent) => e.payload as { error: string; outOfScope?: string[] };

  it('the incident: a test run writes test-results/.last-run.json while the job was told README only', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-1');
    const before = git(cwd, 'rev-parse', 'HEAD');
    write(cwd, 'README.md', '# hi\n');
    write(cwd, 'test-results/.last-run.json', '{"status":"passed"}\n');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type).toBe('commit.failed');
    expect(failure(r).outOfScope).toEqual(['test-results/.last-run.json']);
    expect(failure(r).error).toContain('test-results/.last-run.json');
    // Nothing was committed or staged, and nothing was deleted.
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('');
    expect(existsSync(join(cwd, 'test-results/.last-run.json'))).toBe(true);
  });

  it('takes a scope of exactly 100 entries and refuses 101, committing nothing', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-cap');
    const before = git(cwd, 'rev-parse', 'HEAD');
    write(cwd, 'README.md', '# hi\n');
    const entry = (i: number) => `docs/f${i}.md`;
    const hundred = ['README.md', ...Array.from({ length: 99 }, (_, i) => entry(i))];
    const tooMany = [...hundred, entry(99)];
    const refused = await commit(h, cwd, { scope: tooMany });
    expect(refused.type).toBe('commit.failed');
    expect(failure(refused).error).toContain('101 entries, the most is 100');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
    const ok = await commit(h, cwd, { scope: hundred });
    expect(ok.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md']);
  });

  it('commits only the in-scope paths: an ignored file and an in-scope file give a commit with exactly one file', async () => {
    const h = await setup();
    writeFileSync(join(h.repo, '.gitignore'), '*.log\n');
    git(h.repo, 'add', '.gitignore');
    git(h.repo, 'commit', '-m', 'ignore logs');
    git(h.repo, 'push', 'origin', 'main');
    const cwd = await worktree(h, 'bulig/s-2');
    write(cwd, 'debug.log', 'noise\n');
    write(cwd, 'README.md', '# hi\n');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md']);
    expect(git(cwd, 'ls-files', 'debug.log')).toBe('');
    expect(existsSync(join(cwd, 'debug.log'))).toBe(true);
  });

  it('a clean tree commits nothing and still answers', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-3');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type).toBe('commit.done');
    expect((r.payload as { sha: string }).sha).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('0');
  });

  it('after the junk is removed, asking again commits', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-4');
    write(cwd, 'README.md', '# hi\n');
    write(cwd, 'junk.tmp');
    expect((await commit(h, cwd, { scope: ['README.md'] })).type).toBe('commit.failed');
    rmSync(join(cwd, 'junk.tmp'));
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md']);
  });

  it('lists every out-of-scope file, not just the first', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-5');
    write(cwd, 'README.md');
    write(cwd, 'b.tmp');
    write(cwd, 'sub/c.tmp');
    write(cwd, 'a.tmp');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(failure(r).outOfScope).toEqual(['a.tmp', 'b.tmp', 'sub/c.tmp']);
  });

  it('a file the stage already staged is still checked', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-6');
    write(cwd, 'README.md');
    write(cwd, 'sneaky.txt');
    git(cwd, 'add', 'sneaky.txt');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type).toBe('commit.failed');
    expect(failure(r).outOfScope).toEqual(['sneaky.txt']);
  });

  it('a modified tracked file outside the scope is refused too', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-7');
    write(cwd, 'a.txt', 'changed\n');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(failure(r).outOfScope).toEqual(['a.txt']);
  });

  it('a deleted tracked file in scope is committed as a deletion', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-8');
    rmSync(join(cwd, 'a.txt'));
    const r = await commit(h, cwd, { scope: ['a.txt'] });
    expect(r.type).toBe('commit.done');
    expect(git(cwd, 'show', '--name-status', '--format=', 'HEAD')).toBe('D\ta.txt');
  });

  it('a deleted tracked file outside the scope is refused', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-9');
    rmSync(join(cwd, 'a.txt'));
    write(cwd, 'b.txt');
    const r = await commit(h, cwd, { scope: ['b.txt'] });
    expect(r.type).toBe('commit.failed');
    expect(failure(r).outOfScope).toEqual(['a.txt']);
  });

  it('a rename with both paths in scope commits, whether or not it was staged', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-10');
    git(cwd, 'mv', 'a.txt', 'c.txt');
    const staged = await commit(h, cwd, { scope: ['a.txt', 'c.txt'] });
    expect(staged.payload, JSON.stringify(staged.payload)).toMatchObject({ sha: expect.any(String) });
    expect(staged.type).toBe('commit.done');
    expect(git(cwd, 'show', '--name-status', '-M', '--format=', 'HEAD')).toMatch(/^R\d+\ta\.txt\tc\.txt$/);

    renameSync(join(cwd, 'c.txt'), join(cwd, 'd.txt'));
    const plain = await commit(h, cwd, { scope: ['c.txt', 'd.txt'] });
    expect(plain.type).toBe('commit.done');
    expect(git(cwd, 'show', '--name-status', '-M', '--format=', 'HEAD')).toMatch(/^R\d+\tc\.txt\td\.txt$/);
  });

  it('a rename whose old path is outside the scope is refused and names the old path', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-11');
    git(cwd, 'mv', 'a.txt', 'c.txt');
    const r = await commit(h, cwd, { scope: ['c.txt'] });
    expect(r.type).toBe('commit.failed');
    expect(failure(r).outOfScope).toEqual(['a.txt']);
  });

  it('handles spaces and unicode in names, and reports them as written, not escaped', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-12');
    write(cwd, 'docs/my notes.md');
    write(cwd, 'docs/日本語.md');
    const ok = await commit(h, cwd, { scope: ['docs/*.md'] });
    expect(ok.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['docs/my notes.md', 'docs/日本語.md']);

    write(cwd, 'naïve file.txt');
    const bad = await commit(h, cwd, { scope: ['docs/*.md'] });
    expect(failure(bad).outOfScope).toEqual(['naïve file.txt']);
  });

  it('a scope entry is a name, never a git pathspec: a bracket in it does not pull in other files', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-13');
    write(cwd, 'lit[1].txt');
    write(cwd, 'lit1.txt');
    const bad = await commit(h, cwd, { scope: ['lit[1].txt'] });
    expect(failure(bad).outOfScope).toEqual(['lit1.txt']);
    rmSync(join(cwd, 'lit1.txt'));
    const ok = await commit(h, cwd, { scope: ['lit[1].txt'] });
    expect(ok.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['lit[1].txt']);
  });

  it('stages named paths, never a bare add -A: a file that appears after the scope check is not committed', async () => {
    const wrapRoot = mkdtempSync(join(tmpdir(), 'bulig-wrap-'));
    dirs.push(wrapRoot);
    const log = join(wrapRoot, 'calls.log');
    const bin = join(wrapRoot, 'git-wrapper.sh');
    // Like a stage that is still writing: when git is asked to add, a new file lands first.
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in *" add "*) echo late > late-junk.tmp;; esac\nexec git "$@"\n`,
    );
    chmodSync(bin, 0o755);
    const h = await setup({ gitBin: bin });
    const cwd = await worktree(h, 'bulig/s-23');
    write(cwd, 'README.md');
    const r = await commit(h, cwd, { scope: ['README.md'] });
    expect(r.type, JSON.stringify(r.payload)).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md']);
    expect(git(cwd, 'status', '--porcelain', '--untracked-files=all')).toBe('?? late-junk.tmp');
    const adds = readFileSync(log, 'utf8').split('\n').filter((l) => / add /.test(` ${l} `) && !/worktree add/.test(l));
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/add -A -- README\.md$/);
  });

  it('refuses a request with no approved scope', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-14');
    write(cwd, 'README.md');
    for (const extra of [{}, { scope: [] }, { scope: 'README.md' }, { scope: [3] }]) {
      const r = await commit(h, cwd, extra);
      expect(r.type).toBe('commit.failed');
      expect(failure(r).error).toMatch(/approved scope/);
    }
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('0');
  });

  it('refuses a scope that climbs out, is absolute, is .git, or is too broad', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-15');
    write(cwd, 'README.md');
    for (const bad of ['../README.md', '/etc/passwd', '.git/config', '**', '*']) {
      const r = await commit(h, cwd, { scope: ['README.md', bad] });
      expect(r.type, bad).toBe('commit.failed');
      expect(failure(r).error, bad).toMatch(/invalid scope/i);
    }
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('0');
  });

  it('allowBroadScope lets ** through', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-16');
    write(cwd, 'README.md');
    write(cwd, 'deep/er/file.md');
    const r = await commit(h, cwd, { scope: ['**'], allowBroadScope: true });
    expect(r.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md', 'deep/er/file.md']);
  });

  it('refuses a scope entry that is a symlink in the worktree, and one that sits behind a symlinked folder', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-17');
    const outside = join(h.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, 'link-dir'));
    symlinkSync(join(outside, 'x'), join(cwd, 'link.txt'));
    write(cwd, 'README.md');
    for (const entry of ['link.txt', 'link-dir/file.txt']) {
      const r = await commit(h, cwd, { scope: ['README.md', entry] });
      expect(r.type, entry).toBe('commit.failed');
      expect(failure(r).error, entry).toMatch(/symlink/);
    }
  });

  it('a symlink the stage created is not committed even when a glob would match it', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-18');
    symlinkSync('/etc/hosts', join(cwd, 'hosts.txt'));
    const r = await commit(h, cwd, { scope: ['*.txt'] });
    expect(r.type).toBe('commit.failed');
    expect(failure(r).outOfScope).toEqual(['hosts.txt']);
    expect(failure(r).error).toMatch(/symlink/);
  });

  it('scopeAllow paths are always allowed, but ordinary out-of-scope files still are not', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-19');
    write(cwd, 'README.md');
    write(cwd, 'test-results/.last-run.json');
    write(cwd, 'other.tmp');
    const r = await commit(h, cwd, { scope: ['README.md'], scopeAllow: ['test-results/.last-run.json'] });
    expect(failure(r).outOfScope).toEqual(['other.tmp']);
    rmSync(join(cwd, 'other.tmp'));
    const ok = await commit(h, cwd, { scope: ['README.md'], scopeAllow: ['test-results/.last-run.json'] });
    expect(ok.type).toBe('commit.done');
    expect(committed(cwd)).toEqual(['README.md', 'test-results/.last-run.json']);
  });

  it('warn mode commits everything and reports the out-of-scope files', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-20');
    write(cwd, 'README.md');
    write(cwd, 'test-results/.last-run.json');
    const r = await commit(h, cwd, { scope: ['README.md'], scopeMode: 'warn' });
    expect(r.type).toBe('commit.done');
    expect((r.payload as { outOfScope?: string[] }).outOfScope).toEqual(['test-results/.last-run.json']);
    expect(committed(cwd)).toEqual(['README.md', 'test-results/.last-run.json']);
  });

  it('warn mode still refuses an invalid scope and still never follows a symlink', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-21');
    write(cwd, 'README.md');
    expect((await commit(h, cwd, { scope: ['../x'], scopeMode: 'warn' })).type).toBe('commit.failed');
    symlinkSync('/etc/hosts', join(cwd, 'hosts.lnk'));
    const r = await commit(h, cwd, { scope: ['README.md'], scopeMode: 'warn' });
    expect(r.type).toBe('commit.failed');
  });

  it('an unknown scopeMode is refused instead of guessed', async () => {
    const h = await setup();
    const cwd = await worktree(h, 'bulig/s-22');
    write(cwd, 'README.md');
    const r = await commit(h, cwd, { scope: ['README.md'], scopeMode: 'off' });
    expect(r.type).toBe('commit.failed');
  });
});

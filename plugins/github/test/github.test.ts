import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import github, { judgeChecks } from '../src/index.ts';

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
  h.fire('commit.requested', { cwd: ready.cwd, message: 'Add new.txt' });
  const { sha } = (await h.waitFor('commit.done')).payload as { sha: string };
  h.fire('pr.requested', { cwd: ready.cwd, branch, title: 'Add new.txt', body: 'because', expectSha: sha });
  const opened = (await h.waitFor('pr.opened')).payload as { url: string; number: number; headSha: string };
  return { cwd: ready.cwd, branch, ...opened };
}

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
    h.fire('commit.requested', { cwd, message: 'checkpoint' });
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
    h.fire('commit.requested', { cwd, message: 'Do the thing' });
    const done = (await h.waitFor('commit.done')).payload as { sha: string; base: string };
    expect(done.sha).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(done.base).toBe(git(h.repo, 'rev-parse', 'main'));
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('Do the thing');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('is safe to ask twice: a clean tree gives the same commit and makes no new one', async () => {
    const h = await setup();
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/c-2' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
    writeFileSync(join(cwd, 'c.txt'), 'c\n');
    h.fire('commit.requested', { cwd, message: 'once' });
    const first = (await h.waitFor('commit.done')).payload as { sha: string };
    h.seen.length = 0;
    h.fire('commit.requested', { cwd, message: 'twice' });
    const second = (await h.waitFor('commit.done')).payload as { sha: string };
    expect(second.sha).toBe(first.sha);
    expect(git(cwd, 'rev-list', '--count', 'main..HEAD')).toBe('1');
  });

  it('emits commit.failed when the directory is not a repo', async () => {
    const h = await setup();
    h.fire('commit.requested', { cwd: h.root, message: 'x' });
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
    h.fire('commit.requested', { cwd, message: 'work' });
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
    h.fire('commit.requested', { cwd, message: 'work' });
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

  it('refuses on a failing check and on a pending check', async () => {
    for (const [bucket, word] of [['fail', 'failing'], ['pending', 'pending']] as const) {
      const h = await setup();
      const pr = await openPr(h);
      h.setState({ log: join(h.root, 'gh.log'), checks: [{ name: 'ci', bucket }] });
      h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
      const refused = await h.waitFor('merge.refused');
      expect((refused.payload as { reason: string }).reason).toMatch(new RegExp(`checks ${word}: ci`));
      expect(h.calls().some((c) => c.args[1] === 'merge')).toBe(false);
    }
  });

  it('treats no checks as a refusal unless allowNoChecks is on', async () => {
    const strict = await setup();
    const a = await openPr(strict);
    strict.fire('merge.requested', { cwd: a.cwd, number: a.number, headSha: a.headSha });
    expect(((await strict.waitFor('merge.refused')).payload as { reason: string }).reason).toMatch(/no checks/);

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

  it('refuses when the merge really fails', async () => {
    const h = await setup({ allowNoChecks: true });
    const pr = await openPr(h);
    h.setState({ log: join(h.root, 'gh.log'), mergeExit: 1, mergeError: 'merge conflict' });
    h.fire('merge.requested', { cwd: pr.cwd, number: pr.number, headSha: pr.headSha });
    const refused = await h.waitFor('merge.refused');
    expect((refused.payload as { reason: string }).reason).toMatch(/merge conflict/);
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
    // Local git work needs no token, so it still works. The step that talks to GitHub is the one that fails.
    h.fire('worktree.requested', { repoPath: h.repo, branch: 'bulig/x-9' });
    const { cwd } = (await h.waitFor('worktree.ready')).payload as { cwd: string };
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
    h.fire('commit.requested', { cwd, message: 'Add new.txt' });
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

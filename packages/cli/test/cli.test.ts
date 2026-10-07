import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireLock, loadConfig, runCli, type Io } from '../src/index.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-dev.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('../../../plugins/github/test/fixtures/fake-gh.mjs', import.meta.url));
const dirs: string[] = [];
beforeAll(() => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_GH, 0o755);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_GH_STATE;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function world(configOverride: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-cli-'));
  dirs.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');

  writeFileSync(join(root, 'gh-state.json'), '{}');
  process.env.FAKE_GH_STATE = join(root, 'gh-state.json');

  const config = {
    dbPath: join(root, 'db', 'bulig.sqlite'),
    grants: {
      'channel-cli': ['channel.send:terminal', 'approval.grant'],
      'pipeline-dev': ['merge.request'],
      'worker-claude-code': ['claude.run', 'fs.worktree'],
      github: ['git.push', 'gh.pr'],
    },
    pluginConfig: {
      'worker-claude-code': { claudeBin: FAKE_CLAUDE },
      github: { ghBin: FAKE_GH, allowNoChecks: true },
    },
    ...configOverride,
  };
  writeFileSync(join(cwd, 'bulig.config.json'), JSON.stringify(config));

  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd, home, pollMs: 15 };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await runCli(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { root, home, cwd, repo, origin, config, io, run };
}

const jobIdFrom = (text: string) => /started job ([0-9a-f-]{36})/.exec(text)![1]!;

describe('a whole job through the CLI', () => {
  it('run, approve plan, approve merge, then history shows every stage', async () => {
    const w = world();

    const run = await w.run('run', '--repo', w.repo, '--title', 'Add multiply function', '--issue', 'Add src/multiply.js exporting multiply(a,b)');
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    const id = jobIdFrom(run.out);
    expect(run.out).toContain('plan: started (opus, readonly)');
    expect(run.out).toContain('approval needed: plan');
    expect(run.out).toContain(`bulig approve ${id} plan`);
    expect(run.out).toContain('is awaiting approval');
    expect(run.out).not.toContain('build: started');

    const status = await w.run('status');
    expect(status.out).toContain(`${id.slice(0, 8)}  awaiting_approval`);
    expect(status.out).toContain('Add multiply function');

    // A short id works, and the second process continues from the stored state.
    const plan = await w.run('approve', id.slice(0, 8), 'plan');
    expect(plan.err).toBe('');
    expect(plan.code).toBe(0);
    for (const s of ['build: started (sonnet, edit)', 'test: started', 'docs: started', 'review: started (opus, readonly)', 'PR opened:', 'approval needed: merge']) {
      expect(plan.out).toContain(s);
    }
    expect(git(w.origin, 'show', `${git(w.origin, 'branch', '--list', 'bulig/*').replace(/^[* ]+/, '')}:src/multiply.js`)).toContain('a * b');

    const merge = await w.run('approve', id, 'merge');
    expect(merge.code).toBe(0);
    expect(merge.out).toContain('PR merged');
    expect(merge.out).toContain('is done');

    const history = await w.run('history', id);
    expect(history.code).toBe(0);
    const stageRows = history.out.split('\n').filter((l) => /^(worktree|plan|critique|approve-plan|build|test|review|docs|pr|approve-merge|merge)\s/.test(l));
    expect(stageRows.map((l) => l.split(/\s+/)[0])).toEqual([
      'worktree', 'plan', 'critique', 'approve-plan', 'build', 'test', 'docs', 'review', 'pr', 'approve-merge', 'merge',
    ]);
    const sessionOf = (name: string) => stageRows.find((l) => l.startsWith(name + ' '))!.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
    expect(sessionOf('build')).toBeTruthy();
    expect(sessionOf('review')).toBeTruthy();
    expect(sessionOf('review')).not.toBe(sessionOf('build'));
    expect(history.out).toContain('events');
    expect(history.out).toContain('pr.merged');

    const detail = await w.run('status', id);
    expect(detail.out).toContain('status   done');
  });

  it('deny cancels the job', async () => {
    const w = world();
    const run = await w.run('run', '--repo', w.repo, '--title', 'Try it');
    const id = jobIdFrom(run.out);
    const deny = await w.run('deny', id);
    expect(deny.code).toBe(0);
    expect(deny.out).toContain('is cancelled');
    expect((await w.run('status', id)).out).toContain('status   cancelled');
    // Nothing is left behind: no worktree folder, no local branch.
    expect(existsSync(join(w.repo, '.worktrees', id))).toBe(false);
    expect(git(w.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(w.repo, 'branch', '--list', 'bulig/*')).toBe('');
  });

  it('approving the wrong kind, or a finished job, is refused before anything starts', async () => {
    const w = world();
    const id = jobIdFrom((await w.run('run', '--repo', w.repo, '--title', 'T')).out);
    const wrong = await w.run('approve', id, 'merge');
    expect(wrong.code).toBe(2);
    expect(wrong.err).toMatch(/waiting for the plan approval, not merge/);
    await w.run('deny', id);
    const late = await w.run('approve', id, 'plan');
    expect(late.err).toMatch(/cancelled, not waiting/);
  });

  it('a worker failure leaves the job failed and the exit code 1', async () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'bulig-bad-')), 'claude');
    dirs.push(join(bad, '..'));
    writeFileSync(bad, '#!/bin/sh\necho oops >&2\nexit 9\n');
    chmodSync(bad, 0o755);
    const w = world({ pluginConfig: { 'worker-claude-code': { claudeBin: bad }, github: { ghBin: FAKE_GH, allowNoChecks: true } } });
    const run = await w.run('run', '--repo', w.repo, '--title', 'T');
    expect(run.code).toBe(1);
    expect(run.out).toContain('job failed: plan failed: claude exited with code 9');
    const id = jobIdFrom(run.out);
    expect(existsSync(join(w.repo, '.worktrees', id))).toBe(false);
    expect(git(w.repo, 'branch', '--list', 'bulig/*')).toBe('');
  });

  it('keepFailedWorktrees keeps the worktree and branch of a failed job', async () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'bulig-bad-')), 'claude');
    dirs.push(join(bad, '..'));
    writeFileSync(bad, '#!/bin/sh\nexit 9\n');
    chmodSync(bad, 0o755);
    const w = world({
      pluginConfig: {
        'worker-claude-code': { claudeBin: bad },
        github: { ghBin: FAKE_GH, allowNoChecks: true },
        'pipeline-dev': { keepFailedWorktrees: true },
      },
    });
    const run = await w.run('run', '--repo', w.repo, '--title', 'T');
    expect(run.code).toBe(1);
    const id = jobIdFrom(run.out);
    expect(existsSync(join(w.repo, '.worktrees', id))).toBe(true);
    expect(git(w.repo, 'branch', '--list', 'bulig/*')).not.toBe('');
  });
});

describe('arguments and errors', () => {
  it('run needs a repo that is a git repo', async () => {
    const w = world();
    expect((await w.run('run', '--title', 't')).err).toMatch(/needs --repo/);
    expect((await w.run('run', '--repo', w.cwd, '--title', 't')).err).toMatch(/not a git repository/);
  });

  it('unknown commands and no command print usage', async () => {
    const w = world();
    const bad = await w.run('frobnicate');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/unknown command/);
    const none = await w.run();
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/bulig run --repo/);
  });

  it('status and history say so when there is no database or no such job', async () => {
    const w = world();
    expect((await w.run('status')).err).toMatch(/no database/);
    await w.run('run', '--repo', w.repo, '--title', 'T');
    expect((await w.run('history', 'zzzz')).err).toMatch(/no job starts with "zzzz"/);
    expect((await w.run('history')).err).toMatch(/usage/);
  });

  it('run without a config file explains where it looked', async () => {
    const w = world();
    rmSync(join(w.cwd, 'bulig.config.json'));
    const r = await w.run('run', '--repo', w.repo, '--title', 't');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/No config found/);
  });

  it('a plugin that was not granted what it needs stops the run with the reason', async () => {
    const w = world({ grants: { 'channel-cli': ['channel.send:terminal', 'approval.grant'], 'pipeline-dev': ['merge.request'] } });
    const r = await w.run('run', '--repo', w.repo, '--title', 't');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/claude\.run/);
  });

  it('two processes cannot share one database', async () => {
    const w = world();
    mkdirSync(join(w.config.dbPath, '..'), { recursive: true });
    const first = acquireLock(w.config.dbPath);
    expect(() => acquireLock(w.config.dbPath)).toThrow(/Another bulig process/);
    first();
    expect(existsSync(`${w.config.dbPath}.lock`)).toBe(false);
    // A lock left by a dead process is taken over.
    writeFileSync(`${w.config.dbPath}.lock`, '999999');
    acquireLock(w.config.dbPath)();
  });
});

describe('config', () => {
  it('prefers the working folder over ~/.bulig and expands ~ in dbPath', () => {
    const w = world({ dbPath: '~/data/b.sqlite' });
    mkdirSync(join(w.home, '.bulig'));
    writeFileSync(join(w.home, '.bulig', 'config.json'), JSON.stringify({ dbPath: '/elsewhere.sqlite' }));
    expect(loadConfig(w.cwd, w.home).config.dbPath).toBe(join(w.home, 'data', 'b.sqlite'));
    rmSync(join(w.cwd, 'bulig.config.json'));
    expect(loadConfig(w.cwd, w.home).config.dbPath).toBe('/elsewhere.sqlite');
  });

  it('defaults the database to ~/.bulig/bulig.sqlite and enables the four plugins and the channel', () => {
    const w = world();
    writeFileSync(join(w.cwd, 'bulig.config.json'), '{}');
    const { config } = loadConfig(w.cwd, w.home);
    expect(config.dbPath).toBe(join(w.home, '.bulig', 'bulig.sqlite'));
    expect(config.enabled).toEqual(['channel-cli', 'worker-claude-code', 'github', 'pipeline-dev']);
  });

  it('rejects bad JSON, bad shapes and unknown plugins', () => {
    const w = world();
    const put = (s: string) => writeFileSync(join(w.cwd, 'bulig.config.json'), s);
    put('{nope');
    expect(() => loadConfig(w.cwd, w.home)).toThrow(/Could not read/);
    put('{"grants": {"a": "b"}}');
    expect(() => loadConfig(w.cwd, w.home)).toThrow(/Bad config/);
    put('{"enabled": ["mystery"]}');
    expect(() => loadConfig(w.cwd, w.home)).toThrow(/mystery/);
  });
});

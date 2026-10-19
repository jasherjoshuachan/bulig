import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import github from '../src/index.ts';

// Where the GitHub token comes from: a systemd credential on a server, an environment variable on the Mac. It reaches the child that
// talks to GitHub as GH_TOKEN and nowhere else. The test sees it through a git wrapper that writes down the GH_TOKEN it was started with.

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-ghtok-'));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const ENV_TOKEN = 'env-token-aaaaaaaa';
const FILE_TOKEN = 'file-token-bbbbbbbb';

function world(config: Record<string, unknown>) {
  const root = tmp();
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  const log = join(root, 'tokens.log');
  const bin = join(root, 'git-wrapper.sh');
  writeFileSync(bin, `#!/bin/sh\necho "GH_TOKEN=$GH_TOKEN :: $*" >> "${log}"\nexec git "$@"\n`);
  chmodSync(bin, 0o755);
  const seen: BuligEvent[] = [];
  let fire: (type: string, payload: unknown, jobId?: string) => void = () => {};
  const driver = definePlugin({
    manifest: { name: 'driver', version: '0.1.0', sdk: '1', description: 'test driver', subscribes: ['worktree.ready', 'worktree.failed'], emits: ['worktree.requested'] },
    register(ctx) {
      ctx.on('worktree.ready', (e) => void seen.push(e));
      ctx.on('worktree.failed', (e) => void seen.push(e));
      fire = (type, payload, jobId) => ctx.emit(type, payload, jobId);
    },
  });
  const logged: string[] = [];
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [github, driver],
    enabled: ['github', 'driver'],
    grants: { github: ['git.push', 'gh.pr'] },
    pluginConfig: { github: { gitBin: bin, ...config } },
    logger: { debug: (m: string) => void logged.push(m), info: (m: string) => void logged.push(m), warn: (m: string) => void logged.push(m), error: (m: string) => void logged.push(m) },
  });
  /** Ask for a worktree (which fetches from origin with the token) and say what GH_TOKEN the fetch had. */
  const fetchToken = async (): Promise<string | undefined> => {
    await k.start();
    const job = await k.jobs.create({ repo, title: 'x' });
    fire('worktree.requested', { repoPath: repo, branch: 'bulig/t-1' }, job.id);
    const until = Date.now() + 30_000;
    while (!seen.length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    const line = readFileSync(log, 'utf8').split('\n').find((l) => / fetch /.test(l));
    return line?.match(/^GH_TOKEN=(.*) ::/)?.[1];
  };
  return { k, fetchToken, logged, seen, root };
}

function credentials(files: Record<string, string>) {
  const d = tmp();
  for (const [name, value] of Object.entries(files)) writeFileSync(join(d, name), value + '\n', { mode: 0o400 });
  process.env.CREDENTIALS_DIRECTORY = d;
  return d;
}

describe('the GitHub token', () => {
  it('a credential file wins over the environment variable', async () => {
    credentials({ 'gh-token': FILE_TOKEN });
    process.env.TEST_GH_TOKEN = ENV_TOKEN;
    const w = world({ tokenEnv: 'TEST_GH_TOKEN' });
    try {
      expect(await w.fetchToken()).toBe(FILE_TOKEN);
      // it reached the child only: this process's environment does not hold it, and nothing logged it
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(w.logged.join('\n')).not.toContain(FILE_TOKEN);
      expect(w.logged.join('\n')).not.toContain(ENV_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('a credential under another name is used when tokenCredential names it', async () => {
    credentials({ 'bot-github': FILE_TOKEN, 'gh-token': 'not-this-one' });
    const w = world({ tokenCredential: 'bot-github' });
    try {
      expect(await w.fetchToken()).toBe(FILE_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('the default credential is used with no config at all, when the file is there', async () => {
    credentials({ 'gh-token': FILE_TOKEN });
    const w = world({});
    try {
      expect(await w.fetchToken()).toBe(FILE_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('on the Mac (no credentials directory) the environment variable still works', async () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    process.env.TEST_GH_TOKEN = ENV_TOKEN;
    const w = world({ tokenEnv: 'TEST_GH_TOKEN' });
    try {
      expect(await w.fetchToken()).toBe(ENV_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('with a credentials directory that has no gh-token, the variable is used', async () => {
    credentials({ 'something-else': 'x' });
    process.env.TEST_GH_TOKEN = ENV_TOKEN;
    const w = world({ tokenEnv: 'TEST_GH_TOKEN' });
    try {
      expect(await w.fetchToken()).toBe(ENV_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('only a regular file counts: a link or a folder named gh-token is ignored', async () => {
    const d = credentials({ real: FILE_TOKEN });
    symlinkSync(join(d, 'real'), join(d, 'gh-token'));
    process.env.TEST_GH_TOKEN = ENV_TOKEN;
    const w = world({ tokenEnv: 'TEST_GH_TOKEN' });
    try {
      expect(await w.fetchToken()).toBe(ENV_TOKEN);
    } finally {
      await w.k.stop();
    }
  });

  it('naming a credential that is not there, with no variable to fall back on, stops the plugin at start with a clear message', async () => {
    credentials({ 'something-else': 'x' });
    delete process.env.TEST_GH_TOKEN_MISSING;
    for (const config of [{ tokenCredential: 'gh-token' }, { tokenCredential: 'gh-token', tokenEnv: 'TEST_GH_TOKEN_MISSING' }]) {
      const w = world(config);
      await expect(w.k.start()).rejects.toThrow(/tokenCredential "gh-token" is not a file in \$CREDENTIALS_DIRECTORY/);
      await w.k.stop().catch(() => {});
    }
  });

  it('naming a credential that is not there is fine when the variable is set', async () => {
    credentials({});
    process.env.TEST_GH_TOKEN = ENV_TOKEN;
    const w = world({ tokenCredential: 'gh-token', tokenEnv: 'TEST_GH_TOKEN' });
    try {
      expect(await w.fetchToken()).toBe(ENV_TOKEN);
    } finally {
      await w.k.stop();
    }
  });
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type Io } from '../src/index.ts';
import { kernelPluginConfig } from '../src/commands.ts';
import type { BuligConfig } from '../src/config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = (over: Partial<BuligConfig> = {}): BuligConfig => ({
  store: { kind: 'sqlite' },
  dbPath: '/x/bulig.sqlite',
  enabled: ['channel-cli', 'worker-claude-code', 'gate-evidence', 'github', 'pipeline-dev', 'worker-gateway'],
  grants: {},
  pluginConfig: {},
  eventCapabilities: {},
  ...over,
});

describe('the gateway changes nothing unless it is on', () => {
  it('without the gateway the plugin config is exactly what it was: no "via", no extra evidence source', () => {
    const c = cfg({ pluginConfig: { 'worker-claude-code': { claudeBin: 'claude' }, 'gate-evidence': { mode: 'warn' } } });
    const out = kernelPluginConfig(c, 'all');
    expect(out['worker-claude-code']).toEqual({ claudeBin: 'claude' });
    expect(out['gate-evidence']).toEqual({ mode: 'warn' });
    expect(kernelPluginConfig(c, 'all', false)).toEqual(out);
  });

  it('with the gateway on, the in-process worker listens behind it and the evidence gate trusts the gateway as a source', () => {
    const c = cfg({ pluginConfig: { 'worker-claude-code': { claudeBin: 'claude' }, 'gate-evidence': { mode: 'enforce' } } });
    const out = kernelPluginConfig(c, 'all', true);
    expect(out['worker-claude-code']).toEqual({ claudeBin: 'claude', via: 'gateway' });
    expect(out['gate-evidence']).toEqual({ mode: 'enforce', evidenceSources: ['worker-claude-code', 'worker-gateway'] });
    // a source list the user wrote is kept and added to, once
    const own = cfg({ pluginConfig: { 'gate-evidence': { evidenceSources: ['worker-claude-code', 'worker-gateway'] } } });
    expect(kernelPluginConfig(own, 'all', true)['gate-evidence']!.evidenceSources).toEqual(['worker-claude-code', 'worker-gateway']);
  });
});

function world(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-wk-'));
  dirs.push(root);
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  writeFileSync(join(cwd, 'bulig.config.json'), JSON.stringify({ dbPath: join(root, 'db', 'bulig.sqlite'), ...config }));
  const out: string[] = [];
  const err: string[] = [];
  const stops: (() => void)[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd, home, pollMs: 15, env: {}, onStop: (s) => (stops.push(s), () => {}) };
  return { root, cwd, io, out, err, stops };
}

describe('bulig worker, arguments', () => {
  const good = ['worker', '--kernel', 'http://127.0.0.1:7431', '--id', 'mac', '--token-env', 'TOK', '--repo', '/srv/repo=/Users/me/repo'];
  const without = (flag: string) => {
    const i = good.indexOf(flag);
    return [...good.slice(0, i), ...good.slice(i + 2)];
  };
  it.each([
    ['no kernel', without('--kernel'), /usage: bulig worker/],
    ['no id', without('--id'), /usage: bulig worker/],
    ['no token variable', without('--token-env'), /usage: bulig worker/],
    ['no repository', without('--repo'), /at least one repository/],
    ['a bad id', good.map((a) => (a === 'mac' ? 'Mac Book' : a)), /--id must be/],
    ['a token instead of a variable name', good.map((a) => (a === 'TOK' ? 'abc-123-def' : a)), /NAME of an environment variable/],
    ['a repository pair with no equals sign', good.map((a) => (a.includes('=') ? '/srv/repo' : a)), /must be <absolute path/],
    ['a relative kernel path', good.map((a) => (a.includes('=') ? 'repo=/Users/me/repo' : a)), /must be <absolute path/],
    ['slots out of range', [...good, '--slots', '99'], /--slots must be/],
    ['a tiny patch limit', [...good, '--max-patch-bytes', '10'], /--max-patch-bytes must be/],
    ['a patch limit that is not a number', [...good, '--max-patch-bytes', 'lots'], /--max-patch-bytes must be/],
  ])('refuses %s with exit 2', async (_name, argv, message) => {
    const w = world();
    w.io.env = { TOK: 'a-token-long-enough-0123' };
    const code = await runCli(argv, w.io);
    expect(code).toBe(2);
    expect(w.err.join('\n')).toMatch(message);
  });

  it('takes the token from a file, from exactly one of --token-env and --token-file, and refuses a file anyone can read', async () => {
    const w = world();
    const f = join(w.root, 'worker-token');
    writeFileSync(f, 'file-token-0123456789abc\n');
    chmodSync(f, 0o644);
    const viaFile = good.filter((a) => a !== '--token-env' && a !== 'TOK');
    let code = await runCli([...viaFile, '--token-file', f], w.io);
    expect(code).toBe(2);
    expect(w.err.join('\n')).toMatch(/group or by anyone/);
    expect(w.err.join('\n')).not.toContain('file-token');
    w.err.length = 0;
    for (const mode of [0o640, 0o660, 0o604]) {
      chmodSync(f, mode);
      w.err.length = 0;
      expect(await runCli([...viaFile, '--token-file', f], w.io), mode.toString(8)).toBe(2);
      expect(w.err.join('\n')).toMatch(/group or by anyone/);
    }
    w.err.length = 0;
    chmodSync(f, 0o600);
    code = await runCli([...good, '--token-file', f], w.io); // both given
    expect(code).toBe(2);
    expect(w.err.join('\n')).toMatch(/usage: bulig worker/);
    w.err.length = 0;
    code = await runCli([...viaFile, '--token-file', join(w.root, 'nope')], w.io);
    expect(code).toBe(2);
    expect(w.err.join('\n')).toMatch(/does not exist/);
    w.err.length = 0;
    code = await runCli([...viaFile, '--token-file', f, '--claude-token-file', join(w.root, 'nope')], w.io);
    expect(w.err.join('\n')).toMatch(/--claude-token-file .* does not exist/);
    expect(code).toBe(2);
  });

  it('says so when the token variable is not set, without printing anything secret', async () => {
    const w = world();
    expect(await runCli(good, w.io)).toBe(2);
    expect(w.err.join('\n')).toMatch(/TOK is not set.*worker-with-keychain/);
  });

  it('will not send a token in the clear to a host that is not this machine or Tailscale', async () => {
    const w = world();
    w.io.env = { TOK: 'a-token-long-enough-0123' };
    const argv = good.map((a) => (a.startsWith('http') ? 'http://example.com:7431' : a));
    const stop = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      w.stops.forEach((s) => s());
    })();
    const code = await runCli(argv, w.io).catch((e: Error) => e);
    await stop;
    expect(String(code instanceof Error ? code.message : w.err.join('\n'))).toMatch(/plain http|in the clear/);
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe('bulig serve with the worker gateway', () => {
  const base = (port: number, listen: string[]) => ({
    enabled: ['channel-cli', 'worker-claude-code', 'worker-gateway', 'github', 'pipeline-dev'],
    grants: {
      'channel-cli': ['channel.send:terminal', 'approval.grant'],
      'pipeline-dev': ['merge.request', 'jobs.write'],
      'worker-claude-code': ['claude.run', 'fs.worktree'],
      github: ['git.push', 'gh.pr'],
      'worker-gateway': ['net.listen', 'git.apply', 'fs.worktree'],
    },
    pluginConfig: { 'worker-gateway': { listen, port, workers: { mac: { tokenEnv: 'BULIG_WORKER_TOKEN_MAC' } } } },
  });

  it('refuses to start when the config listens on 0.0.0.0', async () => {
    const w = world(base(await freePort(), ['0.0.0.0']));
    w.io.env = { BULIG_WORKER_TOKEN_MAC: 'a-token-long-enough-0123' };
    const code = await runCli(['serve'], w.io);
    expect(code).toBe(2);
    expect(w.err.join('\n')).toMatch(/every interface/);
  });

  it('serves the endpoint on the named address, answers 401 to a stranger, and takes a worker that has the token', async () => {
    const port = await freePort();
    const w = world(base(port, ['127.0.0.1']));
    w.io.env = { BULIG_WORKER_TOKEN_MAC: 'a-token-long-enough-0123' };
    process.env.BULIG_WORKER_TOKEN_MAC = 'a-token-long-enough-0123';
    try {
      const serving = runCli(['serve'], w.io);
      const url = `http://127.0.0.1:${port}/claim`;
      let status = 0;
      for (let i = 0; i < 200 && status === 0; i++) {
        status = await fetch(url, { method: 'POST', body: '{}' }).then((r) => r.status, () => 0);
        if (status === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe(401);
      const claim = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer a-token-long-enough-0123' }, body: JSON.stringify({ workerId: 'mac', slots: 1 }), signal: AbortSignal.timeout(60_000) });
      expect(claim.status).toBe(204); // nothing to do yet
      w.stops.forEach((s) => s());
      expect(await serving).toBe(0);
    } finally {
      delete process.env.BULIG_WORKER_TOKEN_MAC;
    }
  }, 120_000);
});

describe('the Postgres URL from a systemd credential', () => {
  const pgWorld = (urlCredential: string | undefined) =>
    world({ store: { kind: 'postgres', urlEnv: 'BULIG_DATABASE_URL', ...(urlCredential && { urlCredential }) } });

  it('a pg-url credential file wins over the environment variable', async () => {
    const w = pgWorld('pg-url');
    const creds = join(w.root, 'creds');
    mkdirSync(creds);
    writeFileSync(join(creds, 'pg-url'), 'not-a-url\n'); // unusable on purpose: the error proves which source was read
    w.io.env = { CREDENTIALS_DIRECTORY: creds, BULIG_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' };
    expect(await runCli(['status'], w.io)).toBe(2);
    expect(w.err.join('\n')).toMatch(/does not hold a usable Postgres connection string/);
    expect(w.err.join('\n')).not.toContain('not-a-url');
  });

  it('with no credential file the environment variable is used, as on the Mac', async () => {
    const w = pgWorld('pg-url');
    w.io.env = { BULIG_DATABASE_URL: 'not-a-url' };
    expect(await runCli(['status'], w.io)).toBe(2);
    expect(w.err.join('\n')).toMatch(/does not hold a usable Postgres connection string/);
    const w2 = pgWorld(undefined);
    w2.io.env = {};
    expect(await runCli(['status'], w2.io)).toBe(2);
    expect(w2.err.join('\n')).toMatch(/BULIG_DATABASE_URL.*not set/);
  });

  it('urlCredential must be a file name, not a path', async () => {
    const w = pgWorld('../pg-url');
    expect(await runCli(['status'], w.io)).toBe(2);
    expect(w.err.join('\n')).toMatch(/urlCredential is a file name/);
  });
});

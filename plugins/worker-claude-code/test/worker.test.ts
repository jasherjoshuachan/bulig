import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent, type Plugin } from '@bulig/plugin-sdk';
import worker, { createWorker, EDIT_DENIED_TOOLS, EDIT_TOOLS, READONLY_TOOLS, buildArgs, buildEnv, parseClaudeOutput } from '../src/index.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-worker-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeAll(() => chmodSync(FAKE, 0o755));

/** A plugin that fires stage.requested and records what comes back. */
function driver() {
  const seen: BuligEvent[] = [];
  let fire: (payload: unknown) => void = () => {};
  const plugin: Plugin = definePlugin({
    manifest: {
      name: 'driver',
      version: '0.1.0',
      sdk: '0',
      description: 'test driver',
      subscribes: ['stage.completed', 'stage.failed'],
      emits: ['stage.requested'],
    },
    register(ctx) {
      ctx.on('stage.completed', (e) => void seen.push(e));
      ctx.on('stage.failed', (e) => void seen.push(e));
      fire = (payload) => ctx.emit('stage.requested', payload, 'job-1');
    },
  });
  return { plugin, seen, fire: (p: unknown) => fire(p) };
}

async function setup(config: Record<string, unknown> = {}, grants?: string[], plugin: Plugin = worker) {
  const d = driver();
  const dir = tmp();
  const k = createKernel({
    dbPath: join(dir, 'db.sqlite'),
    plugins: [plugin, d.plugin],
    enabled: ['worker-claude-code', 'driver'],
    grants: { 'worker-claude-code': grants ?? ['claude.run', 'fs.worktree'] },
    pluginConfig: { 'worker-claude-code': { claudeBin: FAKE, ...config } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await k.start();
  return { ...d, k, dir };
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const req = (over: Record<string, unknown> = {}) => ({
  stage: 'plan',
  prompt: 'plan the thing',
  model: 'opus',
  mode: 'readonly',
  cwd: tmp(),
  ...over,
});

describe('buildArgs', () => {
  it('readonly uses plan mode and the read-only tool list', () => {
    const args = buildArgs({ stage: 'plan', prompt: 'p', model: 'opus', mode: 'readonly', cwd: '/x' });
    expect(args.slice(0, 6)).toEqual(['-p', 'p', '--output-format', 'json', '--model', 'opus']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(READONLY_TOOLS.join(','));
  });

  it('edit uses acceptEdits and a conservative tool list with no push', () => {
    const args = buildArgs({ stage: 'build', prompt: 'p', model: 'sonnet', mode: 'edit', cwd: '/x' });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(EDIT_TOOLS).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(pnpm *)']));
    expect(EDIT_TOOLS.some((t) => t.includes('push'))).toBe(false);
    expect(EDIT_TOOLS).not.toContain('Bash(*)');
  });

  it('edit stages deny push, gh and curl outright', () => {
    const args = buildArgs({ stage: 'build', prompt: 'p', model: 'sonnet', mode: 'edit', cwd: '/x' });
    expect(EDIT_DENIED_TOOLS).toEqual(['Bash(git push*)', 'Bash(gh *)', 'Bash(curl *)']);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash(git push*),Bash(gh *),Bash(curl *)');
    const ro = buildArgs({ stage: 'plan', prompt: 'p', model: 'opus', mode: 'readonly', cwd: '/x' });
    expect(ro).not.toContain('--disallowedTools');
  });

  it('never resumes or continues a session', () => {
    for (const mode of ['readonly', 'edit'] as const) {
      const args = buildArgs({ stage: 's', prompt: 'p', model: 'm', mode, cwd: '/x' });
      expect(args.join(' ')).not.toMatch(/--resume|--continue|\s-c\s|\s-r\s/);
    }
  });

  it('appends extra args', () => {
    const args = buildArgs({ stage: 's', prompt: 'p', model: 'm', mode: 'edit', cwd: '/x' }, ['--setting-sources', 'project']);
    expect(args.slice(-2)).toEqual(['--setting-sources', 'project']);
  });
});

describe('buildEnv', () => {
  const source = {
    PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', TERM: 'xterm', TMPDIR: '/t', SHELL: '/bin/zsh', LC_ALL: 'C',
    GH_TOKEN: 'gh-1', GITHUB_TOKEN: 'gh-2', BULIG_TELEGRAM_TOKEN: 'tg', BULIG_GH_TOKEN: 'gh-3', BULIG_ANYTHING: 'x',
    AWS_SECRET_ACCESS_KEY: 'aws', DB_PASSWORD: 'pw', MY_API_KEY: 'k', RANDOM_THING: 'r',
    ANTHROPIC_API_KEY: 'a-key', ANTHROPIC_BASE_URL: 'https://example.test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/c',
    CLAUDE_CODE_MESSAGING_TOKEN: 'host-internal', ANTHROPIC_SOMETHING_SECRET: 's',
  };

  it('keeps the basics and the ways Claude Code logs in', () => {
    const env = buildEnv(source);
    expect(env).toMatchObject({
      PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'en_US.UTF-8', TERM: 'xterm', TMPDIR: '/t', SHELL: '/bin/zsh', LC_ALL: 'C',
      ANTHROPIC_API_KEY: 'a-key', ANTHROPIC_BASE_URL: 'https://example.test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/c',
    });
  });

  it('strips the GitHub token, every BULIG_ variable and anything secret-looking', () => {
    const env = buildEnv(source);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'BULIG_TELEGRAM_TOKEN', 'BULIG_GH_TOKEN', 'BULIG_ANYTHING', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'MY_API_KEY']) {
      expect(env, name).not.toHaveProperty(name);
    }
    // Secret-looking Claude-prefixed names are not a free pass; only the known login variables are.
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_SOMETHING_SECRET');
    // Unknown names are not passed either: it is an allowlist.
    expect(env).not.toHaveProperty('RANDOM_THING');
  });

  it('passEnv lets a named variable through, but never the GitHub token or BULIG_*', () => {
    const env = buildEnv(source, ['MY_API_KEY', 'RANDOM_THING', 'GH_TOKEN', 'GITHUB_TOKEN', 'BULIG_ANYTHING']);
    expect(env.MY_API_KEY).toBe('k');
    expect(env.RANDOM_THING).toBe('r');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('BULIG_ANYTHING');
  });
});

describe('parseClaudeOutput', () => {
  it('reads result, session and cost', () => {
    expect(parseClaudeOutput('{"result":"hi","session_id":"s1","total_cost_usd":0.5,"is_error":false}')).toEqual({
      ok: true, result: 'hi', sessionId: 's1', costUsd: 0.5,
    });
  });
  it('flags is_error and non-JSON', () => {
    expect(parseClaudeOutput('{"is_error":true,"result":"nope"}')).toMatchObject({ ok: false, error: 'nope' });
    expect(parseClaudeOutput('hello')).toMatchObject({ ok: false });
  });
});

describe('worker-claude-code plugin', () => {
  it('runs claude in cwd and emits stage.completed with session and cost', async () => {
    const log = join(tmp(), 'calls.log');
    process.env.FAKE_CLAUDE_LOG = log;
    const { fire, seen } = await setup({ passEnv: ['FAKE_CLAUDE_LOG'] });
    const r = req({ mode: 'edit', stage: 'build' });
    fire(r);
    await waitFor(() => seen.length > 0);
    delete process.env.FAKE_CLAUDE_LOG;
    expect(seen[0]!.type).toBe('stage.completed');
    expect(seen[0]!.jobId).toBe('job-1');
    expect(seen[0]!.payload).toMatchObject({ stage: 'build', ok: true, costUsd: 0.0123 });
    expect((seen[0]!.payload as { sessionId: string }).sessionId).toMatch(/^session-/);
    const call = JSON.parse(readFileSync(log, 'utf8').trim()) as { args: string[]; cwd: string };
    expect(call.cwd).toBe(realpathOf(r.cwd as string));
    expect(call.args).toContain('acceptEdits');
  });

  it('the child never sees the GitHub token or Bulig secrets, only what is allowed', async () => {
    const dump = join(tmp(), 'env.json');
    const saved = { ...process.env };
    Object.assign(process.env, {
      GH_TOKEN: 'ghp_leak_check_1', GITHUB_TOKEN: 'ghp_leak_check_2', BULIG_GH_TOKEN: 'ghp_leak_check_3',
      BULIG_TELEGRAM_TOKEN: 'tg_leak_check', DB_PASSWORD: 'pw_leak_check', ANTHROPIC_API_KEY: 'sk-ant-test', FAKE_CLAUDE_ENV_DUMP: dump,
    });
    try {
      // The dump path itself is a test variable, so it is passed on purpose.
      const { fire, seen } = await setup({ passEnv: ['FAKE_CLAUDE_ENV_DUMP'] });
      fire(req({ mode: 'edit', stage: 'build' }));
      await waitFor(() => seen.length > 0);
      expect(seen[0]!.type).toBe('stage.completed');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const raw = readFileSync(dump, 'utf8');
    const env = JSON.parse(raw) as Record<string, string>;
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'BULIG_GH_TOKEN', 'BULIG_TELEGRAM_TOKEN', 'DB_PASSWORD']) expect(env, name).not.toHaveProperty(name);
    expect(raw).not.toContain('leak_check');
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('every run is its own session', async () => {
    const { fire, seen } = await setup();
    fire(req());
    fire(req({ stage: 'review' }));
    await waitFor(() => seen.length === 2);
    const ids = seen.map((e) => (e.payload as { sessionId: string }).sessionId);
    expect(new Set(ids).size).toBe(2);
  });

  it('emits stage.failed on a nonzero exit, bad output and is_error', async () => {
    const { fire, seen } = await setup();
    fire(req({ stage: 'a', prompt: 'FAKE:crash' }));
    fire(req({ stage: 'b', prompt: 'FAKE:garbage' }));
    fire(req({ stage: 'c', prompt: 'FAKE:iserror' }));
    await waitFor(() => seen.length === 3);
    expect(seen.every((e) => e.type === 'stage.failed')).toBe(true);
    const byStage = Object.fromEntries(seen.map((e) => [(e.payload as { stage: string }).stage, (e.payload as { error: string }).error]));
    expect(byStage.a).toMatch(/code 3.*segfault/);
    expect(byStage.b).toMatch(/not JSON/);
    expect(byStage.c).toBe('rate limited');
  });

  it('kills a run that goes past the timeout', async () => {
    const { fire, seen } = await setup({ timeoutMs: 300 });
    fire(req({ prompt: 'FAKE:sleep' }));
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.type).toBe('stage.failed');
    expect((seen[0]!.payload as { error: string }).error).toMatch(/timed out/);
  });

  it('fails the stage when the binary does not exist', async () => {
    const { fire, seen } = await setup({ claudeBin: join(tmp(), 'nope') });
    fire(req());
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.type).toBe('stage.failed');
    expect((seen[0]!.payload as { error: string }).error).toMatch(/could not start/);
  });

  it('rejects a malformed request', async () => {
    const { fire, seen } = await setup();
    fire({ stage: 'x' });
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.type).toBe('stage.failed');
  });

  it('refuses to start without its grants', async () => {
    await expect(setup({}, ['claude.run'])).rejects.toThrow(/fs\.worktree/);
  });
});

describe('stop()', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidFrom = (mark: string) => Number(/PID (\d+)/.exec(readFileSync(mark, 'utf8'))![1]);
  const withMark = async (prompt: string, config: Record<string, unknown>) => {
    const mark = join(tmp(), 'mark.log');
    const saved = process.env.FAKE_CLAUDE_MARK;
    process.env.FAKE_CLAUDE_MARK = mark;
    try {
      const h = await setup({ passEnv: ['FAKE_CLAUDE_MARK'], ...config }, undefined, createWorker());
      h.fire(req({ prompt }));
      await waitFor(() => existsSync(mark) && /PID/.test(readFileSync(mark, 'utf8')));
      return { ...h, mark };
    } finally {
      if (saved === undefined) delete process.env.FAKE_CLAUDE_MARK;
      else process.env.FAKE_CLAUDE_MARK = saved;
    }
  };

  it('sends SIGTERM to a running Claude and waits for it, without reporting the stage as failed', async () => {
    const h = await withMark('FAKE:term', { stopGraceMs: 5000 });
    const pid = pidFrom(h.mark);
    expect(alive(pid)).toBe(true);
    const started = Date.now();
    await h.k.stop();
    expect(readFileSync(h.mark, 'utf8')).toContain('TERM');
    expect(alive(pid)).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000); // it did not sit out the grace period
    // The run was cut off by a shutdown, so the stage is left running for the next start to mark interrupted.
    expect(h.seen).toHaveLength(0);
  });

  it('follows SIGTERM with SIGKILL when Claude ignores it', async () => {
    const h = await withMark('FAKE:ignoreterm', { stopGraceMs: 400 });
    const pid = pidFrom(h.mark);
    const started = Date.now();
    await h.k.stop();
    const took = Date.now() - started;
    expect(readFileSync(h.mark, 'utf8')).toContain('TERM'); // it was asked nicely first
    expect(alive(pid)).toBe(false);
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(5000);
    expect(h.seen).toHaveLength(0);
  });

  it('stops every run it has, and nothing else', async () => {
    const mark = join(tmp(), 'two.log');
    process.env.FAKE_CLAUDE_MARK = mark;
    try {
      const h = await setup({ passEnv: ['FAKE_CLAUDE_MARK'], stopGraceMs: 400 }, undefined, createWorker());
      h.fire(req({ prompt: 'FAKE:ignoreterm', stage: 'a' }));
      h.fire(req({ prompt: 'FAKE:term', stage: 'b' }));
      await waitFor(() => existsSync(mark) && (readFileSync(mark, 'utf8').match(/PID/g) ?? []).length === 2);
      const pids = [...readFileSync(mark, 'utf8').matchAll(/PID (\d+)/g)].map((m) => Number(m[1]));
      await h.k.stop();
      expect(pids.map(alive)).toEqual([false, false]);
      expect(alive(process.pid)).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_MARK;
    }
  });

  it('returns at once when nothing is running', async () => {
    const h = await setup({}, undefined, createWorker());
    const started = Date.now();
    await h.k.stop();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

function realpathOf(p: string): string {
  // macOS tmp dirs resolve through /private
  return existsSync(`/private${p}`) ? `/private${p}` : p;
}

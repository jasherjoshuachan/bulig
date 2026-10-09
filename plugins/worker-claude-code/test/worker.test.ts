import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent, type Plugin } from '@bulig/plugin-sdk';
import worker, {
  BASE_ALLOWED_DOMAINS,
  GITHUB_HOSTS,
  createWorker,
  EDIT_DENIED_TOOLS,
  EDIT_TOOLS,
  READONLY_TOOLS,
  buildArgs,
  buildEnv,
  hardenEnv,
  evidenceFrom,
  parseClaudeOutput,
  OutputParser,
  MAX_LINE_BYTES,
  MAX_SINGLE_OBJECT_BYTES,
  sandboxSettings,
} from '../src/index.ts';

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
  let fire: (payload: unknown, jobId?: string) => void = () => {};
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
      fire = (payload, jobId = 'job-1') => ctx.emit('stage.requested', payload, jobId);
    },
  });
  return { plugin, seen, fire: (p: unknown, jobId?: string) => fire(p, jobId) };
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
    expect(args.slice(0, 7)).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose', '--model', 'opus']);
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

describe('the OS sandbox (layer 1)', () => {
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as { sandbox: Record<string, any> };

  it('every stage, edit or readonly, carries the sandbox settings on --settings', () => {
    for (const mode of ['readonly', 'edit'] as const) {
      const args = buildArgs({ stage: 's', prompt: 'p', model: 'm', mode, cwd: '/x' });
      expect(args.filter((a) => a === '--settings')).toHaveLength(1);
      expect(settingsOf(args)).toEqual(sandboxSettings());
    }
  });

  it('switches every Claude Code hook off, because hooks run outside the sandbox', () => {
    expect(sandboxSettings()).toMatchObject({ disableAllHooks: true });
    for (const mode of ['readonly', 'edit'] as const) {
      const args = buildArgs({ stage: 's', prompt: 'p', model: 'm', mode, cwd: '/x' });
      expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({ disableAllHooks: true });
    }
  });

  it('turns the sandbox on, cannot start without it, and lets nothing run outside it', () => {
    const { sandbox } = sandboxSettings() as { sandbox: Record<string, any> };
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.excludedCommands).toEqual([]);
    // The tool allow list, not the sandbox, decides which commands may run at all.
    expect(sandbox.autoAllowBashIfSandboxed).toBe(false);
  });

  it('allows Claude and the npm registry, refuses every other host, and names GitHub as denied', () => {
    const { sandbox } = sandboxSettings() as { sandbox: Record<string, any> };
    expect(sandbox.network.strictAllowlist).toBe(true);
    expect(sandbox.network.allowedDomains).toEqual(expect.arrayContaining(['api.anthropic.com', 'registry.npmjs.org']));
    expect(sandbox.network.allowedDomains).toEqual(BASE_ALLOWED_DOMAINS);
    expect(sandbox.network.deniedDomains).toEqual(GITHUB_HOSTS);
    for (const host of ['github.com', 'api.github.com', '*.githubusercontent.com']) expect(sandbox.network.deniedDomains).toContain(host);
    for (const d of sandbox.network.allowedDomains as string[]) expect(d).not.toMatch(/github/i);
  });

  it('allowDomains adds hosts but can never add a GitHub one', () => {
    const { sandbox } = sandboxSettings(['pypi.org', 'github.com', 'codeload.github.com', 'raw.githubusercontent.com', '*.githubusercontent.com']) as {
      sandbox: Record<string, any>;
    };
    expect(sandbox.network.allowedDomains).toEqual([...BASE_ALLOWED_DOMAINS, 'pypi.org']);
    const args = buildArgs({ stage: 's', prompt: 'p', model: 'm', mode: 'edit', cwd: '/x' }, [], ['pypi.org', 'github.com']);
    expect(settingsOf(args).sandbox.network.allowedDomains).toEqual([...BASE_ALLOWED_DOMAINS, 'pypi.org']);
  });

  it('hides the places gh and git keep their logins from sandboxed reads', () => {
    const { sandbox } = sandboxSettings() as { sandbox: Record<string, any> };
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.config/gh', '~/.ssh', '~/.git-credentials']));
  });
});

describe('hardenEnv (layer 2)', () => {
  const base = buildEnv({ PATH: '/bin', HOME: '/h', USER: 'u' });
  const env = hardenEnv({ ...base, SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: '/usr/bin/real-askpass', GIT_DIR: '/x', GH_HOST: 'h', GH_CONFIG_DIR: '/h/.config/gh' }, '/tmp/gh-empty');

  it('points gh at the empty dir it was given', () => {
    expect(env.GH_CONFIG_DIR).toBe('/tmp/gh-empty');
  });
  it('gives git no global or system config, no prompt and no password helper', () => {
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' });
  });
  it('clears the credential helper the way git -c credential.helper= does', () => {
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
    expect('GIT_CONFIG_VALUE_0' in env).toBe(true); // empty, not missing: missing would leave the helper alone
  });
  it('drops the ssh agent and any other git or gh setting that came in', () => {
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env).not.toHaveProperty('GIT_DIR');
    expect(env).not.toHaveProperty('GH_HOST');
  });
  it('keeps HOME, because Claude needs it to log in', () => {
    expect(env.HOME).toBe('/h');
    expect(env.PATH).toBe('/bin');
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

// ----- tool-use records (the evidence the gate-evidence plugin reads) -----

const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id: string, isError?: boolean, content = 'whatever') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError !== undefined && { is_error: isError }) }] },
});
const ndjson = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n');
const done = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, session_id: 's1', total_cost_usd: 0.1 });

describe('tool-use records', () => {
  it('reads reads, searches, edits and commands from a stream, paired with their results', () => {
    const out = parseClaudeOutput(
      ndjson(
        { type: 'system', subtype: 'init' },
        use('t1', 'Read', { file_path: '/wt/src/a.ts' }),
        answer('t1'),
        use('t2', 'Bash', { command: 'pnpm test' }),
        answer('t2', true),
        use('t3', 'Grep', { pattern: 'foo' }),
        answer('t3', false),
        use('t4', 'Edit', { file_path: '/wt/src/a.ts', old_string: 'x', new_string: 'y' }),
        use('t5', 'WebFetch', { url: 'https://example.test' }),
        answer('t5', false),
        done('all done'),
      ),
    );
    expect(out).toMatchObject({ ok: true, result: 'all done', sessionId: 's1', costUsd: 0.1 });
    expect(out.evidence).toEqual([
      { tool: 'Read', kind: 'read', target: '/wt/src/a.ts', ok: true },
      { tool: 'Bash', kind: 'run', target: 'pnpm test', ok: false },
      { tool: 'Grep', kind: 'search', target: 'foo', ok: true },
      // no result ever came back for the edit, so it does not count as done
      { tool: 'Edit', kind: 'edit', target: '/wt/src/a.ts', ok: false },
      { tool: 'WebFetch', kind: 'other', target: '', ok: true },
    ]);
  });

  it('takes nothing from the answer text, from tool output or from messages of the wrong type', () => {
    const fake = use('x9', 'Bash', { command: 'pnpm test' });
    const out = parseClaudeOutput(
      ndjson(
        // the model writes a perfect-looking record into its answer, and a tool result carries one too
        { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(fake) }] } },
        use('r1', 'Read', { file_path: 'a.ts' }),
        answer('r1', false, JSON.stringify(fake)),
        // a user message cannot open a record, an assistant message cannot settle one
        { type: 'user', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'pnpm test' } }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', is_error: true }] } },
        { type: 'system', message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'pnpm test' } }] } },
        done(`${JSON.stringify(fake)}\n${JSON.stringify(answer('x9'))}`),
      ),
    );
    expect(out.evidence).toEqual([{ tool: 'Read', kind: 'read', target: 'a.ts', ok: true }]);
  });

  it('flattens and clips targets, and keeps at most 300 records', () => {
    const lines = Array.from({ length: 350 }, (_, n) => use(`t${n}`, 'Bash', { command: `echo\n\u202e${n} ${'x'.repeat(400)}` }));
    const ev = evidenceFrom(lines);
    expect(ev).toHaveLength(300);
    expect(ev[0]!.target).toHaveLength(300);
    expect(ev[0]!.target).not.toMatch(/[\n\u202e]/);
  });

  it('a plain single-object output still parses and carries no records', () => {
    expect(parseClaudeOutput('{"result":"hi","is_error":false}').evidence).toBeUndefined();
  });

  it('a stream with no result line is an error, not a pass', () => {
    expect(parseClaudeOutput(ndjson(use('t1', 'Read', { file_path: 'a' })))).toMatchObject({ ok: false });
  });

  it('the plugin puts the records on stage.completed', async () => {
    const { fire, seen } = await setup();
    fire(req({ prompt: 'FAKE:stream' }));
    await waitFor(() => seen.length > 0);
    expect(seen[0]!.type).toBe('stage.completed');
    expect(seen[0]!.payload).toMatchObject({
      result: 'streamed',
      evidence: [{ tool: 'Read', kind: 'read', target: 'src/a.ts', ok: true }, { tool: 'Bash', kind: 'run', target: 'pnpm test', ok: true }],
    });
  });

  it('a run with no stream still emits an empty list', async () => {
    const { fire, seen } = await setup();
    fire(req());
    await waitFor(() => seen.length > 0);
    expect((seen[0]!.payload as { evidence: unknown }).evidence).toEqual([]);
  });
});

describe('bounded stream reading', () => {
  const toolResult = (id: string, size: number) => JSON.stringify(answer(id, false, 'z'.repeat(size))) + '\n';
  /** Feed text to the parser in 64 KiB pieces, like a pipe would. */
  const feed = (p: OutputParser, text: string) => {
    const b = Buffer.from(text);
    for (let i = 0; i < b.length; i += 65536) p.write(b.subarray(i, i + 65536));
  };

  it('many MB of tool results then a result: the stage parses and memory stays bounded', () => {
    const p = new OutputParser();
    feed(p, JSON.stringify(use('t1', 'Read', { file_path: 'a.ts' })) + '\n');
    let total = 0;
    for (let n = 0; n < 300; n++) {
      const l = toolResult(n === 0 ? 't1' : `n${n}`, 100_000);
      total += l.length;
      feed(p, l);
    }
    feed(p, JSON.stringify(done('fine')));
    const out = p.finish();
    expect(total).toBeGreaterThan(30_000_000);
    expect(out).toMatchObject({ ok: true, result: 'fine', evidence: [{ tool: 'Read', kind: 'read', target: 'a.ts', ok: true }] });
    expect(p.peakRetained).toBeLessThan(200_000);
  });

  it('one over-long line is skipped and the lines after it are still read', () => {
    const p = new OutputParser();
    feed(p, ndjson({ type: 'system', subtype: 'init' }) + '\n');
    feed(p, JSON.stringify(use('t1', 'Read', { file_path: 'a.ts' })) + '\n');
    feed(p, toolResult('t1', MAX_LINE_BYTES + 10));
    feed(p, JSON.stringify(use('t2', 'Bash', { command: 'ls' })) + '\n');
    feed(p, JSON.stringify(answer('t2')) + '\n' + JSON.stringify(done('after')));
    const out = p.finish();
    expect(out).toMatchObject({ ok: true, result: 'after' });
    // the skipped line was t1's answer, so t1 never settled; t2 did
    expect(out.evidence).toEqual([
      { tool: 'Read', kind: 'read', target: 'a.ts', ok: false },
      { tool: 'Bash', kind: 'run', target: 'ls', ok: true },
    ]);
    expect(p.peakRetained).toBeLessThanOrEqual(MAX_LINE_BYTES + 70_000);
  });

  it('a stream with no result line says so, and says what was skipped', () => {
    const p = new OutputParser();
    feed(p, ndjson({ type: 'system', subtype: 'init' }) + '\n' + toolResult('t1', MAX_LINE_BYTES + 10));
    expect(p.finish()).toMatchObject({ ok: false, error: expect.stringMatching(/no result line \(1 line over 1 MiB skipped\)/) });
  });

  it('an old single-object output under the cap parses; over the cap it fails clearly', () => {
    const big = JSON.stringify({ type: 'result', is_error: false, result: 'r'.repeat(MAX_LINE_BYTES * 2) });
    expect(parseClaudeOutput(big)).toMatchObject({ ok: true });
    expect(parseClaudeOutput(big).evidence).toBeUndefined();
    const huge = JSON.stringify({ is_error: false, result: 'r'.repeat(MAX_SINGLE_OBJECT_BYTES + 10) });
    expect(parseClaudeOutput(huge)).toMatchObject({ ok: false, error: expect.stringMatching(/over 8 MiB/) });
  });

  it('a result line without a trailing newline and split across chunks is read', () => {
    const p = new OutputParser();
    const b = Buffer.from(JSON.stringify(done('split')));
    p.write(b.subarray(0, 20));
    p.write(b.subarray(20));
    expect(p.finish()).toMatchObject({ ok: true, result: 'split' });
  });

  it('through the plugin: a 24 MB verbose run still completes with its records', async () => {
    const { fire, seen } = await setup();
    fire(req({ prompt: 'FAKE:flood' }));
    await waitFor(() => seen.length > 0, 20000);
    expect(seen[0]!.type).toBe('stage.completed');
    expect(seen[0]!.payload).toMatchObject({ result: 'flooded', evidence: [{ tool: 'Read', kind: 'read', target: 'big.txt', ok: true }] });
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

  it('the child gets a fresh empty GH_CONFIG_DIR per stage, hardened git env, no ssh agent, and the dir is removed afterwards', async () => {
    const dumpA = join(tmp(), 'a.json');
    const dumpB = join(tmp(), 'b.json');
    const saved = { ...process.env };
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.GIT_ASKPASS = '/usr/bin/real-askpass';
    try {
      const dirsSeen: string[] = [];
      for (const dump of [dumpA, dumpB]) {
        process.env.FAKE_CLAUDE_ENV_DUMP = dump;
        const { fire, seen } = await setup({ passEnv: ['FAKE_CLAUDE_ENV_DUMP', 'SSH_AUTH_SOCK'] });
        fire(req({ mode: 'edit', stage: 'build' }));
        await waitFor(() => seen.length > 0);
        expect(seen[0]!.type).toBe('stage.completed');
        const env = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
        expect(env.GH_CONFIG_DIR).toMatch(/bulig-gh-/);
        expect(existsSync(env.GH_CONFIG_DIR!)).toBe(false); // gone once the run ended
        expect((env as unknown as { __GH_DIR_ENTRIES: string[] }).__GH_DIR_ENTRIES).toEqual([]); // and it was empty while the child ran
        expect(env).toMatchObject({
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        });
        expect(env).not.toHaveProperty('SSH_AUTH_SOCK'); // even passEnv cannot bring it back
        expect(env.HOME).toBe(saved.HOME);
        dirsSeen.push(env.GH_CONFIG_DIR!);
      }
      expect(dirsSeen[0]).not.toBe(dirsSeen[1]); // one per stage
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
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

  it('takes the whole process group down, so a grandchild that ignores SIGTERM dies too', async () => {
    const h = await withMark('FAKE:grandchild', { stopGraceMs: 5000 });
    const leader = pidFrom(h.mark);
    const grandchild = Number(/GRANDCHILD (\d+)/.exec(readFileSync(h.mark, 'utf8'))![1]);
    expect(alive(grandchild)).toBe(true);
    await h.k.stop();
    expect(alive(leader)).toBe(false);
    await waitFor(() => !alive(grandchild), 3000);
  });

  it('returns at once when nothing is running', async () => {
    const h = await setup({}, undefined, createWorker());
    const started = Date.now();
    await h.k.stop();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a job that ends takes its own Claude with it', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidsIn = (mark: string) => (existsSync(mark) ? [...readFileSync(mark, 'utf8').matchAll(/PID (\d+)/g)].map((m) => Number(m[1])) : []);

  async function twoJobs(prompts: [string, string], config: Record<string, unknown> = {}) {
    const mark = join(tmp(), 'jobs.log');
    process.env.FAKE_CLAUDE_MARK = mark;
    const h = await setup({ passEnv: ['FAKE_CLAUDE_MARK'], ...config }, undefined, createWorker());
    delete process.env.FAKE_CLAUDE_MARK;
    const a = h.k.jobs.create({ repo: '/r', title: 'a' });
    const b = h.k.jobs.create({ repo: '/r', title: 'b' });
    process.env.FAKE_CLAUDE_MARK = mark;
    h.fire(req({ prompt: prompts[0], stage: 'build', mode: 'edit' }), a.id);
    await waitFor(() => pidsIn(mark).length === 1);
    h.fire(req({ prompt: prompts[1], stage: 'build', mode: 'edit' }), b.id);
    await waitFor(() => pidsIn(mark).length === 2);
    delete process.env.FAKE_CLAUDE_MARK;
    const [pa, pb] = pidsIn(mark) as [number, number];
    return { ...h, a, b, pa, pb, mark };
  }

  it('cancelling a job SIGTERMs only that job\'s Claude, and the stage is closed as failed', async () => {
    const h = await twoJobs(['FAKE:term', 'FAKE:term']);
    h.k.jobs.setStatus(h.a.id, 'cancelled');
    await waitFor(() => !alive(h.pa));
    expect(alive(h.pb)).toBe(true); // the other job's run is untouched
    await waitFor(() => h.seen.length === 1);
    expect(h.seen[0]).toMatchObject({ type: 'stage.failed', jobId: h.a.id });
    expect((h.seen[0]!.payload as { error: string }).error).toMatch(/job ended/);
    await h.k.stop();
    expect(alive(h.pb)).toBe(false);
  });

  it('a job that fails is treated the same way', async () => {
    const h = await twoJobs(['FAKE:term', 'FAKE:term']);
    h.k.jobs.setStatus(h.b.id, 'failed');
    await waitFor(() => !alive(h.pb));
    expect(alive(h.pa)).toBe(true);
    await h.k.stop();
  });

  it('follows SIGTERM with SIGKILL after the grace period when the run ignores it', async () => {
    const h = await twoJobs(['FAKE:ignoreterm', 'FAKE:term'], { stopGraceMs: 400 });
    const started = Date.now();
    h.k.jobs.setStatus(h.a.id, 'cancelled');
    await waitFor(() => !alive(h.pa));
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(readFileSync(h.mark, 'utf8')).toContain('TERM'); // asked nicely first
    expect(alive(h.pb)).toBe(true);
    await h.k.stop();
  });

  it('a job that ends also takes its Claude\'s grandchildren', async () => {
    const h = await twoJobs(['FAKE:grandchild', 'FAKE:term']);
    const grandchild = Number(/GRANDCHILD (\d+)/.exec(readFileSync(h.mark, 'utf8'))![1]);
    expect(alive(grandchild)).toBe(true);
    h.k.jobs.setStatus(h.a.id, 'cancelled');
    await waitFor(() => !alive(grandchild), 4000);
    expect(alive(h.pb)).toBe(true);
    await h.k.stop();
  });

  it('other status changes leave the run alone', async () => {
    const h = await twoJobs(['FAKE:term', 'FAKE:term']);
    h.k.jobs.setStatus(h.a.id, 'running');
    h.k.jobs.setStatus(h.a.id, 'awaiting_approval');
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(h.pa) && alive(h.pb)).toBe(true);
    expect(h.seen).toHaveLength(0);
    await h.k.stop();
  });

  it('a stage requested for a job that already ended never starts', async () => {
    const mark = join(tmp(), 'never.log');
    process.env.FAKE_CLAUDE_MARK = mark;
    const h = await setup({ passEnv: ['FAKE_CLAUDE_MARK'] }, undefined, createWorker());
    delete process.env.FAKE_CLAUDE_MARK;
    const job = h.k.jobs.create({ repo: '/r', title: 'x' });
    h.k.jobs.setStatus(job.id, 'cancelled');
    h.fire(req({ prompt: 'FAKE:term', stage: 'build', mode: 'edit' }), job.id);
    await waitFor(() => h.seen.length === 1);
    expect(h.seen[0]!.type).toBe('stage.failed');
    expect(existsSync(mark)).toBe(false);
  });
});

function realpathOf(p: string): string {
  // macOS tmp dirs resolve through /private
  return existsSync(`/private${p}`) ? `/private${p}` : p;
}

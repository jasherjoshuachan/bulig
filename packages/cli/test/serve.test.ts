import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramChannel } from '@bulig/channel-telegram';
import { Store } from '@bulig/core';
import pipeline from '@bulig/pipeline-dev';
import { definePlugin, type Plugin } from '@bulig/plugin-sdk';
import { loadConfig, runCli, type Io } from '../src/index.ts';
import { FakeTelegram, until } from '../../../plugins/channel-telegram/test/fake-telegram.ts';

const CHAT = 5150;
const OWNER = 7001;
const TOKEN_ENV = 'TEST_SERVE_TG_TOKEN';
const dirs: string[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[TOKEN_ENV];
});

/** Stands in for worker-claude-code. `hangOn` never answers that stage, like a process that dies mid-stage. */
function fakeWorker(hangOn?: string): Plugin {
  const replies: Record<string, string> = {
    plan: 'The plan\n\nSCOPE:\n- src/multiply.js\n- test/multiply.test.js',
    critique: 'The critique',
    build: 'built',
    test: 'tests ran\nVERDICT: PASS',
    review: 'looks fine\nVERDICT: PASS',
    docs: 'docs done',
  };
  return definePlugin({
    manifest: { name: 'worker-claude-code', version: '0.1.0', sdk: '0', description: 'fake', subscribes: ['stage.requested'], emits: ['stage.completed'] },
    register(ctx) {
      ctx.on('stage.requested', (e) => {
        const stage = (e.payload as { stage: string }).stage;
        if (stage === hangOn) return;
        ctx.emit('stage.completed', { stage, result: replies[stage] ?? 'ok', costUsd: 0.01, sessionId: `s-${stage}` }, e.jobId);
      });
    },
  });
}

function fakeGithub(): Plugin {
  return definePlugin({
    manifest: {
      name: 'github',
      version: '0.1.0',
      sdk: '0',
      description: 'fake',
      subscribes: ['worktree.requested', 'commit.requested', 'pr.requested', 'merge.requested'],
      emits: ['worktree.ready', 'commit.done', 'pr.opened', 'pr.merged'],
    },
    register(ctx) {
      ctx.on('worktree.requested', (e) => ctx.emit('worktree.ready', { cwd: `/fake/wt/${e.jobId}`, branch: (e.payload as { branch: string }).branch }, e.jobId));
      ctx.on('commit.requested', (e) => ctx.emit('commit.done', { sha: 'abc1234', base: 'def5678' }, e.jobId));
      ctx.on('pr.requested', (e) => ctx.emit('pr.opened', { url: 'https://example.test/pull/1', number: 1, headSha: 'abc1234' }, e.jobId));
      ctx.on('merge.requested', (e) => ctx.emit('pr.merged', { number: 1 }, e.jobId));
    },
  });
}

async function world(over: { enabled?: string[]; token?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-serve-'));
  dirs.push(root);
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  for (const d of [cwd, home, repo]) mkdirSync(d);
  const fake = await new FakeTelegram().start();
  fakes.push(fake);
  if (over.token !== false) process.env[TOKEN_ENV] = fake.token;
  const dbPath = join(root, 'db', 'bulig.sqlite');
  writeFileSync(
    join(cwd, 'bulig.config.json'),
    JSON.stringify({
      dbPath,
      enabled: over.enabled ?? ['channel-telegram', 'worker-claude-code', 'github', 'pipeline-dev'],
      grants: { 'channel-telegram': ['channel.send:telegram', 'approval.grant'], 'pipeline-dev': ['merge.request', 'jobs.write'] },
      pluginConfig: { 'channel-telegram': { tokenEnv: TOKEN_ENV, allowedChatIds: [CHAT], allowedUserIds: [OWNER], repos: { app: repo }, apiBase: fake.apiBase, pollTimeoutSec: 0 } },
    }),
  );
  return { root, cwd, home, repo, fake, dbPath };
}

/** Start `bulig serve` and hand back a way to stop it with a signal-like call. */
function serve(w: Awaited<ReturnType<typeof world>>, plugins: Plugin[]) {
  const out: string[] = [];
  const err: string[] = [];
  let stop: () => void = () => {};
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd: w.cwd,
    home: w.home,
    onStop(fn) {
      stop = fn;
      return () => {};
    },
    servePlugins: plugins,
  };
  const done = runCli(['serve'], io);
  return { out, err, done, stop: () => stop() };
}

const approvalMessage = (fake: FakeTelegram, kind: string) =>
  fake.of('sendMessage').find((c) => String(c.params.text).includes(`approval needed: ${kind}`))?.params;

async function tapApprove(fake: FakeTelegram, kind: string) {
  await until(() => approvalMessage(fake, kind) !== undefined, `${kind} approval message`);
  const m = approvalMessage(fake, kind)!;
  const data = m.reply_markup.inline_keyboard[0][0].callback_data as string;
  fake.press(CHAT, m.__id, m.text, data, { id: OWNER, username: 'owner' });
}

describe('bulig serve', () => {
  it('drives one job from /dev to pr.merged purely through Telegram', async () => {
    const w = await world();
    const s = serve(w, [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline]);
    await until(() => s.out.some((l) => l.includes('serving')), 'serve to start');

    w.fake.say(CHAT, '/dev app Add multiply function\nAdd src/multiply.js exporting multiply(a,b).', OWNER);
    await tapApprove(w.fake, 'plan');
    await tapApprove(w.fake, 'merge');
    await until(() => w.fake.texts(CHAT).some((t) => t.endsWith('job done')), 'job done line');

    const texts = w.fake.texts(CHAT);
    const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
    for (const needle of ['started: Add multiply function', 'plan finished', 'approval needed: plan', 'build finished', 'test finished: PASS', 'review finished: PASS', 'PR opened: https://example.test/pull/1', 'approval needed: merge', 'PR merged (#1)', 'job done']) {
      expect(at(needle), needle).toBeGreaterThanOrEqual(0);
    }
    expect(at('PR opened')).toBeLessThan(at('approval needed: merge'));
    expect(at('PR merged')).toBeLessThan(at('job done'));

    const events = new Store(w.dbPath);
    const job = events.listJobs()[0]!;
    expect(job).toMatchObject({ title: 'Add multiply function', body: 'Add src/multiply.js exporting multiply(a,b).', status: 'done' });
    const types = events.eventsForJob(job.id).map((e) => e.type);
    expect(types).toContain('pr.merged');
    expect(types.filter((t) => t === 'approval.granted')).toHaveLength(2);
    events.close();

    s.stop();
    expect(await s.done).toBe(0);
    expect(s.err).toEqual([]);
  });

  it('holds the database lock while it runs and lets go when it stops', async () => {
    const w = await world();
    const s = serve(w, [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline]);
    await until(() => s.out.some((l) => l.includes('serving')), 'serve to start');
    expect(existsSync(`${w.dbPath}.lock`)).toBe(true);

    const second = serve(w, [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline]);
    expect(await second.done).toBe(1);
    expect(second.err.join('\n')).toMatch(/Another bulig process/);

    s.stop();
    expect(await s.done).toBe(0);
    expect(existsSync(`${w.dbPath}.lock`)).toBe(false);
  });

  it('picks up a job that was in flight when the last serve stopped', async () => {
    const w = await world();
    const first = serve(w, [createTelegramChannel(), fakeWorker('critique'), fakeGithub(), pipeline]);
    await until(() => first.out.some((l) => l.includes('serving')), 'first serve');
    w.fake.say(CHAT, '/dev app Survive a restart', OWNER);
    await until(() => w.fake.texts(CHAT).some((t) => t.includes('plan finished')), 'plan finished');
    first.stop();
    expect(await first.done).toBe(0);
    expect(approvalMessage(w.fake, 'plan')).toBeUndefined();

    const second = serve(w, [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline]);
    await until(() => approvalMessage(w.fake, 'plan') !== undefined, 'plan approval after resume');
    second.stop();
    expect(await second.done).toBe(0);
    const store = new Store(w.dbPath);
    expect(store.listJobs()).toHaveLength(1);
    store.close();
  });

  it('exits with a clear message when the token is not in the environment', async () => {
    const w = await world({ token: false });
    const s = serve(w, [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline]);
    expect(await s.done).toBe(2);
    expect(s.err.join('\n')).toContain(`Export it as ${TOKEN_ENV}`);
    expect(existsSync(`${w.dbPath}.lock`)).toBe(false);
  });

  it('refuses to serve with no channel enabled', async () => {
    const w = await world({ enabled: ['worker-claude-code', 'github', 'pipeline-dev'] });
    const s = serve(w, [fakeWorker(), fakeGithub(), pipeline]);
    expect(await s.done).toBe(2);
    expect(s.err.join('\n')).toMatch(/needs a channel/);
  });
});

/** `serve` with its own plugin list (no io.servePlugins): the real worker runs the fake claude, the real github makes a worktree in a real tmp repo. */
describe('bulig serve with its default plugin list', () => {
  const FAKE_CLAUDE = fileURLToPath(new URL('../../../plugins/worker-claude-code/test/fixtures/fake-claude.mjs', import.meta.url));
  const combos: Array<[string, string[]]> = [
    ['neither gate', []],
    ['gate-evidence only', ['gate-evidence']],
    ['gate-promise only', ['gate-promise']],
    ['both gates', ['gate-evidence', 'gate-promise']],
  ];

  it.each(combos)('the first stage reaches the pipeline and the plan approval is requested: %s', async (_name, gates) => {
    const w = await world({ enabled: ['channel-telegram', 'worker-claude-code', 'github', 'pipeline-dev', ...gates] });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: w.repo, stdio: 'ignore' });
    git('init', '-b', 'main');
    writeFileSync(join(w.repo, 'a.txt'), 'x\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'init');
    const cfgPath = join(w.cwd, 'bulig.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.grants['worker-claude-code'] = ['claude.run', 'fs.worktree'];
    cfg.grants.github = ['git.push', 'gh.pr'];
    cfg.pluginConfig['worker-claude-code'] = { claudeBin: FAKE_CLAUDE };
    cfg.pluginConfig['gate-evidence'] = { mode: 'warn' };
    cfg.pluginConfig['gate-promise'] = { mode: 'warn' };
    writeFileSync(cfgPath, JSON.stringify(cfg));

    // The built-in plugins are module singletons that keep state after a stop, so each case gets fresh modules.
    vi.resetModules();
    const { runCli: freshRunCli } = await import('../src/index.ts');
    const out: string[] = [];
    const err: string[] = [];
    let stop: () => void = () => {};
    const done = freshRunCli(['serve'], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: w.cwd, home: w.home, onStop: (fn) => ((stop = fn), () => {}) });
    await until(() => out.some((l) => l.includes('serving')), 'serve to start');
    w.fake.say(CHAT, '/dev app First stage', OWNER);
    await until(() => approvalMessage(w.fake, 'plan') !== undefined, 'plan approval card', 20000);
    stop();
    expect(await done).toBe(0);
    expect(err).toEqual([]);
    const store = new Store(w.dbPath);
    const plan = store.listStages(store.listJobs()[0]!.id).find((st) => st.name === 'plan')!;
    expect(plan.status).toBe('passed');
    store.close();
  }, 30000);

  it('refuses to start when an enabled plugin is not registered, naming it', async () => {
    const w = await world({ enabled: ['channel-telegram', 'worker-claude-code', 'github', 'pipeline-dev', 'gate-promise'] });
    const err: string[] = [];
    // Serving with a plugin list that lacks gate-promise, which the config enables: the old behaviour was to skip it silently.
    expect(await runCli(['serve'], { out() {}, err: (l) => err.push(l), cwd: w.cwd, home: w.home, onStop: () => () => {}, servePlugins: [createTelegramChannel(), fakeWorker(), fakeGithub(), pipeline] })).toBe(2);
    expect(err.join('\n')).toMatch(/not registered.*gate-promise/);
    expect(existsSync(`${w.dbPath}.lock`)).toBe(false);
  });

  it('refuses a pipeline that reads a gate event when that gate is not enabled', async () => {
    const w = await world();
    const cfgPath = join(w.cwd, 'bulig.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.pluginConfig['pipeline-dev'] = { stageResultEvent: 'stage.screened' };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const err: string[] = [];
    expect(await runCli(['serve'], { out() {}, err: (l) => err.push(l), cwd: w.cwd, home: w.home, onStop: () => () => {} })).toBe(2);
    expect(err.join('\n')).toMatch(/stage\.screened.*gate-promise is not enabled/);
  });
});

describe('the shipped example config', () => {
  it('loads, enables the Telegram channel, and grants it what it needs', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulig-example-'));
    dirs.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(root, 'bulig.config.json'), readFileSync(new URL('../../../bulig.config.example.json', import.meta.url)));
    const { config } = loadConfig(root, home);
    expect(config.enabled).toContain('channel-telegram');
    expect(config.enabled).toContain('gate-evidence');
    expect(config.pluginConfig['gate-evidence']).toEqual({ mode: 'warn', enabled: true });
    expect(config.grants['gate-evidence']).toBeUndefined(); // it needs no capability
    expect(config.grants['channel-telegram']).toEqual(['channel.send:telegram', 'approval.grant']);
    // Only the channels and the pipeline hold the approval and merge capabilities.
    const holders = Object.entries(config.grants).filter(([, caps]) => caps.some((c) => c === 'approval.grant' || c === 'merge.request'));
    expect(holders.map(([name]) => name).sort()).toEqual(['channel-cli', 'channel-telegram', 'pipeline-dev']);
    expect(config.grants['pipeline-dev']).toEqual(['merge.request', 'jobs.write']);
    expect(config.pluginConfig['channel-telegram']).toMatchObject({ tokenEnv: 'BULIG_TELEGRAM_TOKEN', allowedChatIds: [123456789] });
  });
});

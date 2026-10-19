import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStore, SqliteStore, createKernel, type Kernel, type Store } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import gateEvidence from '../../../plugins/gate-evidence/src/index.ts';
import gatePromise from '../../../plugins/gate-promise/src/index.ts';
import { describePg, usePgServer, type PgDatabase } from '../../core/test/pg-throwaway.ts';
import { checkBar, verdictOf, SOAK_DAYS } from '../src/gates-record.ts';
import { runCli, type Io } from '../src/index.ts';

const DAY = 86_400_000;
const dirs: string[] = [];
const kernels: Kernel[] = [];
const dbs: PgDatabase[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dbs.splice(0)) await d.drop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The loose shape of the config the tests write; `indent` is how the file is laid out on disk. */
interface World {
  cfgPath: string;
  /** Run a store call against the same record the CLI reads, then close the store. */
  seed<T>(fn: (store: Store) => Promise<T>): Promise<T>;
  run(...argv: string[]): Promise<{ code: number; out: string; err: string }>;
  /** Move the clock the CLI reads, to `ms` after the soak start. */
  clockAt(startAt: string, ms: number): void;
  readConfig(): Record<string, any>;
}

function sqliteWorld(config: Record<string, unknown> = {}, text?: (c: Record<string, unknown>) => string): World {
  const root = mkdtempSync(join(tmpdir(), 'bulig-soak-'));
  dirs.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(home);
  mkdirSync(cwd);
  const dbPath = join(root, 'db', 'bulig.sqlite');
  mkdirSync(join(root, 'db'));
  // The kernel makes the file the first time it runs; a store opened and closed stands in for that.
  void new SqliteStore(dbPath).close();
  return build(cwd, home, { dbPath, ...config }, text, async (fn) => {
    const store = new SqliteStore(dbPath);
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  });
}

function build(cwd: string, home: string, config: Record<string, unknown>, text: ((c: Record<string, unknown>) => string) | undefined, seed: World['seed'], env: Record<string, string> = {}): World {
  const cfgPath = join(cwd, 'bulig.config.json');
  writeFileSync(cfgPath, text ? text(config) : JSON.stringify(config, null, 2) + '\n');
  const out: string[] = [];
  const err: string[] = [];
  const io: Io & { now?: () => Date } = { out: (l) => out.push(l), err: (l) => err.push(l), cwd, home, env };
  return {
    cfgPath,
    seed,
    clockAt: (startAt, ms) => void (io.now = () => new Date(Date.parse(startAt) + ms)),
    readConfig: () => JSON.parse(readFileSync(cfgPath, 'utf8')),
    async run(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await runCli(argv, io);
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
}

// ---- events as the real gates write them ----
const evidence = (s: Store, jobId: string, stage: string, unverified: string[] = []) =>
  s.appendEvent({ type: 'stage.checked', source: 'gate-evidence', jobId, payload: { stage, ok: true, result: 'r', checked: true, unverified } });
const promise = (s: Store, jobId: string, stage: string, promises: string[] = [], carried: string[] = []) =>
  s.appendEvent({ type: 'stage.screened', source: 'gate-promise', jobId, payload: { stage, ok: true, result: 'r', promiseChecked: true, promises, unverified: carried } });

/** n jobs that each pass both gates clean. Returns their ids. */
async function cleanJobs(s: Store, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const job = await s.createJob({ repo: `/repo/${i}`, title: `Job ${i}` });
    await evidence(s, job.id, 'plan');
    await promise(s, job.id, 'plan');
    ids.push(job.id);
  }
  return ids;
}

const startedAt = async (w: World): Promise<string> => (await w.seed((s) => s.eventsAfter(0))).filter((e) => e.type === 'gates.soak.started').at(-1)!.at;
const eventsOf = (w: World, type: string) => w.seed(async (s) => (await s.eventsAfter(0)).filter((e) => e.type === type));

/** Everything that must hold on either engine. */
type Make = (config?: Record<string, unknown>, text?: (c: Record<string, unknown>) => string) => Promise<World>;
function soakSuite(make: Make) {
  it('before the soak starts, status says so and the bar is not met', async () => {
    const w = await make();
    const r = await w.run('gates', 'status');
    expect(r.code).toBe(0);
    expect(r.out).toContain('soak      not started');
    expect(r.out).toContain('bar not met');
    expect(r.out).toContain('bulig gates soak start');
  });

  it('soak start records the clock once; a second start is refused; --restart starts over and drops the earlier record', async () => {
    const w = await make();
    const first = await w.run('gates', 'soak', 'start');
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(await eventsOf(w, 'gates.soak.started')).toHaveLength(1);
    const again = await w.run('gates', 'soak', 'start');
    expect(again.code).toBe(2);
    expect(again.err).toContain('already started');
    expect(await eventsOf(w, 'gates.soak.started')).toHaveLength(1);

    await w.seed((s) => cleanJobs(s, 3));
    w.clockAt(await startedAt(w), 1 * DAY);
    expect((await w.run('gates', 'status')).out).toContain('jobs      3 of 10');
    const restart = await w.run('gates', 'soak', 'start', '--restart');
    expect(restart.code).toBe(0);
    expect(await eventsOf(w, 'gates.soak.started')).toHaveLength(2);
    expect((await w.run('gates', 'status')).out).toContain('jobs      0 of 10');
  });

  it('bar not met by days: enough clean jobs, too little time', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    await w.seed((s) => cleanJobs(s, 12));
    w.clockAt(await startedAt(w), 2.5 * DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).toContain('elapsed   2.5 of 7 days');
    expect(r.out).toContain('jobs      12 of 10 reached a gate');
    expect(r.out).toContain('bar not met: needs 4.5 more days');
    expect(r.out).not.toContain('more job');
    expect(r.out).not.toContain('false warning found');
  });

  it('bar not met by jobs: enough time, too few jobs', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    await w.seed((s) => cleanJobs(s, 4));
    w.clockAt(await startedAt(w), 8 * DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).toContain('bar not met: 6 more jobs');
    expect(r.out).not.toContain('more day');
  });

  it('bar not met by a false warning, even with the time and the jobs', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    const warnId = await w.seed(async (s) => {
      await cleanJobs(s, 10);
      const job = await s.createJob({ repo: '/repo/w', title: 'Warned job' });
      return (await evidence(s, job.id, 'test', ['Unverified: no record of a test run this turn ("All tests pass.")'])).id;
    });
    w.clockAt(await startedAt(w), 8 * DAY);
    const before = await w.run('gates', 'status');
    expect(before.out).toContain('bar met');
    expect(before.out).toContain(warnId);
    const mark = await w.run('gates', 'mark-false', warnId, '--reason', 'the sentence was a quote from the issue');
    expect(mark.err).toBe('');
    const after = await w.run('gates', 'status');
    expect(after.out).toContain('bar not met: 1 false warning found');
    expect(after.out).toContain('marked false: the sentence was a quote from the issue');
    expect(after.out).toMatch(/false\s+1 warning marked false/);
  });

  it('bar met at exactly 7 days and 10 jobs, with a true warning still on the list', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    await w.seed(async (s) => {
      const ids = await cleanJobs(s, 9);
      await evidence(s, ids[0]!, 'test', ['Unverified: no record']);
      const job = await s.createJob({ repo: '/r', title: 'Tenth' });
      await promise(s, job.id, 'plan', ["Unfulfilled promise: no job id (\"I'll follow up\")"]);
    });
    const at = await startedAt(w);
    w.clockAt(at, SOAK_DAYS * DAY - 1);
    expect((await w.run('gates', 'status')).out).toContain('bar not met: needs 0.1 more day');
    w.clockAt(at, SOAK_DAYS * DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).toMatch(/^bar met$/m);
    expect(r.out).toMatch(/gate-evidence\s+9\s+1/);
    expect(r.out).toMatch(/gate-promise\s+9\s+1/);
    expect(r.out).toContain('Job 0');
  });

  it('counts only real verdicts after the start', async () => {
    const w = await make();
    const early = await w.seed(async (s) => {
      const job = await s.createJob({ repo: '/r', title: 'Before' });
      await evidence(s, job.id, 'plan', ['Unverified: x']);
      return job.id;
    });
    await w.run('gates', 'soak', 'start');
    await w.seed(async (s) => {
      const job = await s.createJob({ repo: '/r', title: 'After' });
      // A gate that is off passes results through. A look-alike from another plugin. A promise event that only carries the evidence lines along.
      await s.appendEvent({ type: 'stage.checked', source: 'gate-evidence', jobId: job.id, payload: { stage: 'plan', checked: false } });
      await s.appendEvent({ type: 'stage.screened', source: 'gate-promise', jobId: job.id, payload: { stage: 'plan', promiseChecked: false } });
      await s.appendEvent({ type: 'stage.checked', source: 'someone-else', jobId: job.id, payload: { stage: 'plan', checked: true, unverified: ['x'] } });
      await promise(s, job.id, 'plan', [], ['Unverified: carried from the evidence gate']);
    });
    w.clockAt(await startedAt(w), DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).toContain('jobs      1 of 10');
    expect(r.out).toContain('After');
    expect(r.out).not.toContain('Before');
    expect(r.out).toMatch(/gate-evidence\s+0\s+0/);
    expect(r.out).toMatch(/gate-promise\s+1\s+0/);
    expect(early).toBeTruthy();
  });

  it('an enforce-mode block counts as a warning and can be marked', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    const id = await w.seed(async (s) => {
      const job = await s.createJob({ repo: '/r', title: 'Blocked' });
      return (await s.appendEvent({ type: 'stage.failed', source: 'gate-promise', jobId: job.id, payload: { stage: 'test', error: 'promise gate: x', blocked: true, promises: ['Unfulfilled promise: no job id'] } })).id;
    });
    w.clockAt(await startedAt(w), DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).toContain('BLOCKED');
    expect(r.out).toMatch(/gate-promise\s+0\s+1/);
    expect((await w.run('gates', 'mark-false', id, '--reason', 'wrong')).code).toBe(0);
  });

  it('mark-false is checked: it needs a reason, a started soak and a real gate warning, and writes one event that points at the warning', async () => {
    const w = await make();
    const usage = (r: { code: number; err: string }) => {
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage: bulig gates mark-false');
    };
    usage(await w.run('gates', 'mark-false'));
    usage(await w.run('gates', 'mark-false', 'abc'));
    usage(await w.run('gates', 'mark-false', 'abc', '--reason', '  '));
    usage(await w.run('gates', 'mark-false', 'abc', 'def', '--reason', 'x'));
    expect((await w.run('gates', 'mark-false', 'abc', '--reason', 'x')).err).toContain('soak has not started');

    await w.run('gates', 'soak', 'start');
    const ids = await w.seed(async (s) => {
      const job = await s.createJob({ repo: '/r', title: 'T' });
      const clean = await evidence(s, job.id, 'plan');
      const warned = await evidence(s, job.id, 'test', ['Unverified: a']);
      const other = await promise(s, job.id, 'test', ['Unfulfilled promise: b']);
      const start = (await s.eventsAfter(0)).find((e) => e.type === 'gates.soak.started')!;
      return { job: job.id, clean: clean.id, warned: warned.id, other: other.id, start: start.id };
    });
    const refused = async (arg: string, why: RegExp) => {
      const r = await w.run('gates', 'mark-false', arg, '--reason', 'x');
      expect(r.code).toBe(2);
      expect(r.err).toMatch(why);
    };
    await refused('no-such-event', /not a gate warning/);
    await refused(ids.clean, /not a gate warning/); // a clean verdict
    await refused(ids.start, /not a gate warning/); // some other event
    await refused(ids.job, /not a gate warning/); // a job id
    expect(await eventsOf(w, 'gates.warning.false')).toHaveLength(0);

    const ok = await w.run('gates', 'mark-false', ids.warned, '--reason', '  the claim is in a quote  ');
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    const [mark] = await eventsOf(w, 'gates.warning.false');
    expect(mark).toMatchObject({ jobId: ids.job, source: 'cli', payload: { target: ids.warned, gate: 'gate-evidence', stage: 'test', reason: 'the claim is in a quote' } });
    await refused(ids.warned, /already marked false: the claim is in a quote/);
    expect(await eventsOf(w, 'gates.warning.false')).toHaveLength(1);

    // The other warning can be named by the start of its id.
    const byPrefix = await w.run('gates', 'mark-false', ids.other.slice(0, 12), '--reason', 'y');
    expect(byPrefix.err).toBe('');
    expect((await eventsOf(w, 'gates.warning.false')).map((e) => (e.payload as { target: string }).target)).toContain(ids.other);
  });

  it('a mark from before a restart does not count against the new soak', async () => {
    const w = await make();
    await w.run('gates', 'soak', 'start');
    const id = await w.seed(async (s) => {
      const job = await s.createJob({ repo: '/r', title: 'T' });
      return (await evidence(s, job.id, 'test', ['Unverified: a'])).id;
    });
    await w.run('gates', 'mark-false', id, '--reason', 'x');
    await w.run('gates', 'soak', 'start', '--restart');
    w.clockAt(await startedAt(w), DAY);
    const r = await w.run('gates', 'status');
    expect(r.out).not.toContain('false warning found');
    expect((await w.run('gates', 'mark-false', id, '--reason', 'x')).err).toContain('not a gate warning since the soak started');
  });

  describe('enforce', () => {
    /** A world whose config has a Telegram-free default `enabled`, an odd indent and extra keys that must come through untouched. */
    const configured = () => ({
      grants: { 'channel-cli': ['approval.grant'] },
      pluginConfig: { github: { ghBin: 'gh', allowNoChecks: true }, 'gate-evidence': { evidenceSources: ['worker-claude-code'], mode: 'warn' } },
      eventCapabilities: { 'x.y': 'z' },
    });

    async function meetBar(w: World) {
      await w.run('gates', 'soak', 'start');
      await w.seed((s) => cleanJobs(s, 10));
      w.clockAt(await startedAt(w), 7 * DAY);
    }

    it('refuses until the bar is met, says why, and leaves the file alone', async () => {
      const w = await make(configured());
      const before = readFileSync(w.cfgPath, 'utf8');
      const notStarted = await w.run('gates', 'enforce');
      expect(notStarted.code).toBe(2);
      expect(notStarted.err).toContain('bar not met');
      await w.run('gates', 'soak', 'start');
      await w.seed((s) => cleanJobs(s, 3));
      w.clockAt(await startedAt(w), 2 * DAY);
      const r = await w.run('gates', 'enforce');
      expect(r.code).toBe(2);
      expect(r.err).toContain('bar not met: needs 5 more days / 7 more jobs');
      expect(r.err).toContain('--force');
      expect(readFileSync(w.cfgPath, 'utf8')).toBe(before);
      expect(readdirSync(join(w.cfgPath, '..')).sort()).toEqual(['bulig.config.json']);
    });

    it('with the bar met it changes the two mode keys and nothing else, keeps a .bak and the layout, and tells you to restart serve', async () => {
      const w = await make(configured());
      await meetBar(w);
      const bytes = readFileSync(w.cfgPath, 'utf8');
      const before = w.readConfig();
      const r = await w.run('gates', 'enforce');
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Restart it');

      const after = w.readConfig();
      const expected = structuredClone(before);
      expected.pluginConfig['gate-evidence'].mode = 'enforce';
      expected.pluginConfig['gate-promise'] = { mode: 'enforce' };
      expect(after).toEqual(expected);
      // The same keys in the same order, the two-space layout, the trailing newline.
      expect(Object.keys(after)).toEqual(Object.keys(before));
      expect(Object.keys(after.pluginConfig['gate-evidence'])).toEqual(['evidenceSources', 'mode']);
      const text = readFileSync(w.cfgPath, 'utf8');
      expect(text).toBe(JSON.stringify(after, null, 2) + '\n');
      expect(readFileSync(`${w.cfgPath}.bak`, 'utf8')).toBe(bytes);
      // No temp file left behind.
      expect(readdirSync(join(w.cfgPath, '..')).sort()).toEqual(['bulig.config.json', 'bulig.config.json.bak']);

      // Run again: already there, nothing rewritten and the .bak still holds the original.
      const again = await w.run('gates', 'enforce');
      expect(again.out).toContain('already in enforce mode');
      expect(readFileSync(`${w.cfgPath}.bak`, 'utf8')).toBe(bytes);
    });

    it('--force switches before the bar is met and says it did', async () => {
      const w = await make(configured());
      const r = await w.run('gates', 'enforce', '--force');
      expect(r.code).toBe(0);
      expect(r.out).toContain('--force given');
      expect(w.readConfig().pluginConfig['gate-promise'].mode).toBe('enforce');
      expect(w.readConfig().pluginConfig['gate-evidence'].mode).toBe('enforce');
    });

    it('writes a config that has no pluginConfig yet, and keeps tabs and a missing final newline as they were', async () => {
      const w = await make({}, (c) => JSON.stringify(c, null, '\t'));
      const r = await w.run('gates', 'enforce', '--force');
      expect(r.err).toBe('');
      const text = readFileSync(w.cfgPath, 'utf8');
      expect(text.endsWith('\n')).toBe(false);
      expect(text).toContain('\n\t"pluginConfig": {\n\t\t"gate-evidence": {\n\t\t\t"mode": "enforce"');
      expect(w.readConfig().pluginConfig).toEqual({ 'gate-evidence': { mode: 'enforce' }, 'gate-promise': { mode: 'enforce' } });
    });

    it('says when a gate is left out of `enabled`, because enforce would not protect anything there', async () => {
      const w = await make({ enabled: ['channel-cli', 'worker-claude-code', 'gate-evidence', 'github', 'pipeline-dev'] });
      const r = await w.run('gates', 'enforce', '--force');
      expect(r.out).toContain('gate-promise is not enabled');
      expect(r.out).not.toContain('gate-evidence is not enabled');
    });

    it('rejects a flag it does not know and does not change anything', async () => {
      const w = await make(configured());
      const before = readFileSync(w.cfgPath, 'utf8');
      const r = await w.run('gates', 'enforce', '--yes');
      expect(r.code).not.toBe(0);
      expect(readFileSync(w.cfgPath, 'utf8')).toBe(before);
    });
  });

  it('bulig gates with no or a wrong subcommand prints the usage and exits 2', async () => {
    const w = await make();
    for (const argv of [['gates'], ['gates', 'nope'], ['gates', 'soak'], ['gates', 'status', 'x']]) {
      const r = await w.run(...argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage:');
    }
  });
}

describe('bulig gates on SQLite', () => {
  soakSuite(async (config, text) => sqliteWorld(config, text));
});

describePg('bulig gates on Postgres', () => {
  const server = usePgServer();
  const make: Make = async (config = {}, text) => {
    const db = await server().newDatabase();
    dbs.push(db);
    // The schema is the kernel's to make; a first writer stands in for it.
    await (await PostgresStore.open(db.url)).close();
    const root = mkdtempSync(join(tmpdir(), 'bulig-soak-pg-'));
    dirs.push(root);
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'work'));
    return build(join(root, 'work'), join(root, 'home'), { store: { kind: 'postgres', urlEnv: 'BULIG_TEST_DATABASE_URL' }, ...config }, text, async (fn) => {
      const store = await PostgresStore.open(db.url);
      try {
        return await fn(store);
      } finally {
        await store.close();
      }
    }, { BULIG_TEST_DATABASE_URL: db.url });
  };
  soakSuite(make);

  it('works while a running kernel holds the writer lock', async () => {
    const w = await make();
    const db = dbs.at(-1)!;
    const kernelStore = await PostgresStore.open(db.url);
    try {
      const jobId = (await cleanJobs(kernelStore, 1))[0]!;
      const started = await w.run('gates', 'soak', 'start');
      expect(started.err).toBe('');
      const warn = await evidence(kernelStore, jobId, 'test', ['Unverified: a']);
      w.clockAt(await startedAtFrom(kernelStore), DAY);
      expect((await w.run('gates', 'status')).out).toContain(warn.id);
      const marked = await w.run('gates', 'mark-false', warn.id, '--reason', 'x');
      expect(marked.err).toBe('');
      expect((await w.run('gates', 'status')).out).toContain('marked false: x');
    } finally {
      await kernelStore.close();
    }
  });
});

const startedAtFrom = async (s: Store) => (await s.eventsAfter(0)).filter((e) => e.type === 'gates.soak.started').at(-1)!.at;

describe('the verdicts the counter reads are the ones the real gates write', () => {
  it('both real gates, run in a kernel, leave events that verdictOf reads as one verdict each, warned only when they flagged something', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulig-soak-k-'));
    dirs.push(root);
    const worker = definePlugin({
      manifest: { name: 'worker-claude-code', version: '0.1.0', sdk: '1', description: 'stand-in', subscribes: ['job.created'], emits: ['stage.completed'] },
      register(ctx) {
        ctx.on('job.created', (e) => {
          const title = (e.payload as { title: string }).title;
          // No tool records, so "All tests pass." has nothing behind it; the promise has no job id.
          const result = title === 'bad' ? "All tests pass. I'll follow up on the flaky test tomorrow." : 'Nothing to report.';
          ctx.emit('stage.completed', { stage: 'test', ok: true, result, evidence: [] }, e.jobId);
        });
      },
    });
    const seen: BuligEvent[] = [];
    const recorder = definePlugin({
      manifest: { name: 'recorder', version: '0.1.0', sdk: '1', description: 'records', subscribes: ['stage.*'] },
      register: (ctx) => void ctx.on('stage.*', (e) => void seen.push(e)),
    });
    const k = createKernel({
      dbPath: join(root, 'k.sqlite'),
      plugins: [worker, gateEvidence, gatePromise, recorder],
      enabled: ['worker-claude-code', 'gate-evidence', 'gate-promise', 'recorder'],
      grants: {},
      pluginConfig: { 'gate-promise': { input: 'stage.checked' } },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    kernels.push(k);
    await k.start();
    const good = await k.jobs.create({ repo: '/r', title: 'good', body: '' });
    const bad = await k.jobs.create({ repo: '/r', title: 'bad', body: '' });
    await k.bus.settle();
    await new Promise((r) => setTimeout(r, 100));
    await k.bus.settle();

    const verdicts = (await k.bus.replay(0)).map(verdictOf).filter((v) => v !== undefined);
    const key = (v: (typeof verdicts)[number]) => `${v!.jobId === good.id ? 'good' : 'bad'} ${v!.gate} ${v!.warned ? 'warned' : 'clean'}`;
    expect(verdicts.map(key).sort()).toEqual(['bad gate-evidence warned', 'bad gate-promise warned', 'good gate-evidence clean', 'good gate-promise clean']);
    // The promise gate's event carries the evidence lines along; they must not read as a promise warning.
    const screenedGood = seen.find((e) => e.type === 'stage.screened' && e.jobId === bad.id)!;
    expect((screenedGood.payload as { unverified: string[] }).unverified.length).toBeGreaterThan(0);
  });
});

describe('the bar', () => {
  it('is met only when days, jobs and false warnings are all in order', () => {
    expect(checkBar(7, 10, 0).met).toBe(true);
    expect(checkBar(6.99, 10, 0).met).toBe(false);
    expect(checkBar(7, 9, 0).met).toBe(false);
    expect(checkBar(7, 10, 1).met).toBe(false);
    expect(checkBar(0, 0, 0).line).toBe('bar not met: needs 7 more days / 10 more jobs');
    expect(checkBar(6, 9, 2).line).toBe('bar not met: needs 1 more day / 1 more job / 2 false warnings found');
  });
});

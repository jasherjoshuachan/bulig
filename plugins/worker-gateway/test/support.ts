import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { createKernel, PostgresStore, SqliteStore, type Kernel, type KernelOptions, type Store } from '@bulig/core';
import { definePlugin, type BuligEvent, type Job, type Plugin, type PluginContext } from '@bulig/plugin-sdk';
import { pgSupport, usePgServer, type PgDatabase } from '../../../packages/core/test/pg-throwaway.ts';
import { createGateway } from '../src/index.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/cli/test/fixtures/fake-claude-dev.mjs', import.meta.url));
export const FAKE_CLAUDE_SLOW = fileURLToPath(new URL('./fixtures/fake-claude-slow.mjs', import.meta.url));
export const FAKE_GH = fileURLToPath(new URL('../../github/test/fixtures/fake-gh.mjs', import.meta.url));
for (const f of [FAKE_CLAUDE, FAKE_CLAUDE_SLOW, FAKE_GH]) chmodSync(f, 0o755);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function waitFor(check: () => boolean | Promise<boolean>, ms = 30_000, what = 'the condition'): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
const kernels: Kernel[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Run something at the end of the test, before the kernels stop (workers first, then the kernel). */
export const onCleanup = (fn: () => Promise<void> | void) => void closers.push(fn);
export const tmp = (prefix = 'bulig-gw-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** A repository on the kernel's machine with a remote, and a second clone of that remote standing in for a worker's machine. */
export function makeWorld() {
  const root = tmp();
  const origin = join(root, 'origin.git');
  const repo = join(root, 'kernel', 'repo');
  const clone = join(root, 'mac', 'repo');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, 'mac'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  const ghState = join(root, 'gh-state.json');
  const ghLog = join(root, 'gh-log.jsonl');
  writeFileSync(ghState, JSON.stringify({ log: ghLog }));
  writeFileSync(ghLog, '');
  return { root, origin, repo, clone, ghState, ghLog, workdir: join(root, 'mac', 'work') };
}

/** The `pr create` calls fake gh has seen: one per PR the github plugin opened. */
export const prCreates = (ghLog: string): number =>
  execFileSync('cat', [ghLog], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() && (JSON.parse(l) as { args: string[] }).args.slice(0, 2).join(' ') === 'pr create').length;

/** Add a job folder the way the github plugin does, so the kernel has a real folder to pack and to apply patches to. */
export function addWorktree(repo: string, jobId: string): string {
  const cwd = join(repo, '.worktrees', jobId);
  git(repo, 'worktree', 'add', '--no-track', cwd, '-b', `bulig/${jobId.slice(0, 8)}`, 'origin/main');
  return cwd;
}

// ----- stores -----

export interface Adapter {
  name: string;
  skip: boolean;
  open(): Promise<Store>;
}
const server = usePgServer();
const dbs: PgDatabase[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dbs.splice(0)) await d.drop();
});
export const ADAPTERS: Adapter[] = [
  {
    name: 'SqliteStore',
    skip: false,
    async open() {
      const s = new SqliteStore(join(tmp('bulig-gwdb-'), 'bulig.sqlite'));
      stores.push(s);
      return s;
    },
  },
  {
    name: 'PostgresStore',
    skip: !pgSupport.available,
    async open() {
      const db = await server().newDatabase();
      dbs.push(db);
      const s = await PostgresStore.open(db.url);
      stores.push(s);
      return s;
    },
  },
];

// ----- a pipeline stand-in for the protocol tests -----

export interface Driver {
  plugin: Plugin;
  events: BuligEvent[];
  /** Open a stage and ask for it, as the pipeline does. */
  ask(job: Job, cwd: string, stage: string, mode?: 'readonly' | 'edit', prompt?: string): Promise<string>;
  ctx(): PluginContext;
}
export function makeDriver(): Driver {
  let c: PluginContext | undefined;
  const events: BuligEvent[] = [];
  const plugin = definePlugin({
    manifest: {
      name: 'driver',
      version: '0.1.0',
      sdk: '1',
      description: 'plays the pipeline in tests',
      subscribes: ['stage.*', 'job.status'],
      emits: ['stage.requested'],
    },
    register(ctx) {
      c = ctx;
      ctx.on('stage.*', (e) => void events.push(e));
    },
  });
  return {
    plugin,
    events,
    ctx: () => c!,
    async ask(job, cwd, stage, mode = 'readonly', prompt = 'You are planning') {
      const opened = await c!.jobs.startStage(job.id, stage);
      await c!.emitCommitted('stage.requested', { stage, stageId: opened.id, prompt, model: 'sonnet', mode, cwd }, job.id);
      return opened.id;
    },
  };
}

export const TOKENS = { mac: 'mac-token-0123456789abcdef', pi: 'pi-token-0123456789abcdef-x' } as const;

export interface BootOptions {
  gateway?: Record<string, unknown>;
  plugins?: Plugin[];
  grants?: Record<string, string[]>;
  pluginConfig?: Record<string, Record<string, unknown>>;
  kernel?: Partial<KernelOptions>;
  compare?: (a: Buffer, b: Buffer) => boolean;
  env?: Record<string, string | undefined>;
  enabled?: string[];
}

/** A kernel with the gateway on an OS-chosen port on 127.0.0.1, and the plugins a test adds. */
export async function bootGateway(store: Store, o: BootOptions = {}) {
  const gateway = createGateway({ ...(o.compare && { compare: o.compare }), env: o.env ?? { BULIG_TOKEN_MAC: TOKENS.mac, BULIG_TOKEN_PI: TOKENS.pi } });
  const extra = o.plugins ?? [];
  const k = createKernel({
    store,
    plugins: [gateway, ...extra],
    enabled: ['worker-gateway', ...(o.enabled ?? extra.map((p) => (p.manifest as { name: string }).name))],
    grants: { 'worker-gateway': ['net.listen', 'git.apply', 'fs.worktree'], ...o.grants },
    pluginConfig: {
      'worker-gateway': {
        port: 0,
        localSlots: 0,
        claimWaitMs: 2000,
        heartbeatMs: 200,
        heartbeatTimeoutMs: 2000,
        workers: { mac: { tokenEnv: 'BULIG_TOKEN_MAC' }, pi: { tokenEnv: 'BULIG_TOKEN_PI', slots: 1 } },
        ...o.gateway,
      },
      ...o.pluginConfig,
    },
    logger: process.env.GW_DEBUG ? { debug() {}, info() {}, warn: (m: string) => console.log('WARN', m), error: (m: string) => console.log('ERROR', m) } : { debug() {}, info() {}, warn() {}, error: () => {} },
    leaseHeartbeatMs: 300,
    leaseTtlMs: 1500,
    ...o.kernel,
  });
  kernels.push(k);
  await k.start();
  const at = gateway.addresses()[0]!;
  const url = `http://${at.address}:${at.port}`;
  return { k, gateway, url };
}

export async function post(url: string, path: string, token: string | undefined, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { ...(token !== undefined && { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : undefined };
}

// ----- the whole pipeline over the worker endpoint -----

import pipeline from '../../pipeline-dev/src/index.ts';
import github from '../../github/src/index.ts';
import { createWorker } from '../../worker-claude-code/src/index.ts';
import { startRemoteWorker, type RemoteWorker, type RemoteWorkerOptions } from '../src/client.ts';

/** Plays the person who approves plans and merges. */
export function makeHuman() {
  let ctx: PluginContext | undefined;
  const asked: BuligEvent[] = [];
  const plugin = definePlugin({
    manifest: { name: 'human', version: '0.1.0', sdk: '1', description: 'test channel', subscribes: ['approval.requested'], emits: ['approval.granted'], needs: ['approval.grant'] },
    register(c) {
      ctx = c;
      c.on('approval.requested', (e) => void asked.push(e));
    },
  });
  return {
    plugin,
    asked,
    /** Answer the newest question of this kind for the job. */
    grant(jobId: string, kind: 'plan' | 'merge') {
      const q = asked.filter((e) => e.jobId === jobId && (e.payload as { kind: string }).kind === kind).at(-1);
      if (!q) throw new Error(`no ${kind} question for ${jobId}`);
      ctx!.emit('approval.granted', { jobId, kind, stageId: (q.payload as { stageId: string }).stageId }, jobId);
    },
    asking: (jobId: string, kind: string) => asked.some((e) => e.jobId === jobId && (e.payload as { kind: string }).kind === kind),
  };
}

export interface PipelineRig {
  k: Kernel;
  url: string;
  world: ReturnType<typeof makeWorld>;
  human: ReturnType<typeof makeHuman>;
  events: BuligEvent[];
  remote(id: 'mac' | 'pi', o?: Partial<RemoteWorkerOptions>): RemoteWorker;
  /** Create a job and carry it up to the plan approval. */
  startJob(title?: string): Promise<Job>;
}

/** A kernel with the real pipeline, the real github plugin (over a local origin and fake gh), the gateway, and optionally the in-process worker behind it. */
export async function bootPipeline(store: Store, o: { local?: boolean; gateway?: Record<string, unknown>; kernel?: Partial<KernelOptions> } = {}): Promise<PipelineRig> {
  const world = makeWorld();
  const human = makeHuman();
  const spy = definePlugin({
    manifest: { name: 'spy', version: '0.1.0', sdk: '1', description: 'records stage events', subscribes: ['stage.*', 'job.*'], emits: [] },
    register(ctx) {
      ctx.on('stage.*', (e) => void events.push(e));
      ctx.on('job.*', (e) => void events.push(e));
    },
  });
  const events: BuligEvent[] = [];
  const local = o.local ? [createWorker()] : [];
  const boot = await bootGateway(store, {
    plugins: [pipeline, github, human.plugin, spy, ...local],
    grants: {
      'pipeline-dev': ['merge.request', 'jobs.write'],
      github: ['git.push', 'gh.pr'],
      human: ['approval.grant'],
      'worker-claude-code': ['claude.run', 'fs.worktree'],
    },
    pluginConfig: {
      github: { ghBin: FAKE_GH, allowNoChecks: true },
      'worker-claude-code': { claudeBin: FAKE_CLAUDE, via: 'gateway' },
      'pipeline-dev': { resume: 'all' },
    },
    gateway: { claimWaitMs: 1000, heartbeatMs: 300, heartbeatTimeoutMs: 3000, ...o.gateway },
    kernel: { leaseHeartbeatMs: 500, leaseTtlMs: 3000, ...o.kernel },
  });
  process.env.FAKE_GH_STATE = world.ghState;
  const remote = (id: 'mac' | 'pi', extra: Partial<RemoteWorkerOptions> = {}) => {
    const w = startRemoteWorker({
      kernelUrl: boot.url,
      workerId: id,
      token: TOKENS[id],
      slots: 1,
      repos: { [world.repo]: world.clone },
      workdir: join(world.workdir, id),
      claudeBin: FAKE_CLAUDE,
      retryMs: 100,
      ...extra,
    });
    onCleanup(() => w.stop());
    return w;
  };
  const startJob = async (title = 'Add multiply function') => {
    const job = await boot.k.jobs.create({ repo: world.repo, title, body: 'Add src/multiply.js exporting multiply(a,b)' });
    await waitFor(() => human.asking(job.id, 'plan'), 60_000, 'the plan question');
    return job;
  };
  return { k: boot.k, url: boot.url, world, human, events, remote, startJob };
}

/** Walk a job from the plan approval to the end: approve the plan, wait for the merge question, approve it, wait for done. */
export async function finishJob(rig: PipelineRig, job: Job, ms = 120_000): Promise<void> {
  rig.human.grant(job.id, 'plan');
  await waitFor(async () => rig.human.asking(job.id, 'merge') || ['failed', 'cancelled'].includes((await rig.k.jobs.get(job.id))!.status), ms, 'the merge question or a failure');
  if ((await rig.k.jobs.get(job.id))!.status === 'failed') return;
  rig.human.grant(job.id, 'merge');
  await waitFor(async () => ['done', 'failed'].includes((await rig.k.jobs.get(job.id))!.status), ms, 'the job to finish');
}

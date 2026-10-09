import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createCliChannel, type CliChannel } from '@bulig/channel-cli';
import telegram from '@bulig/channel-telegram';
import { createKernel, Store, type Kernel } from '@bulig/core';
import gate from '@bulig/gate-evidence';
import gatePromise from '@bulig/gate-promise';
import github from '@bulig/github';
import pipeline from '@bulig/pipeline-dev';
import type { Job, JobStatus, Plugin, Stage } from '@bulig/plugin-sdk';
import worker from '@bulig/worker-claude-code';
import { ConfigError, defaultDbPath, loadConfig, type BuligConfig } from './config.ts';
import { acquireLock } from './lock.ts';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  home: string;
  /** How often to look at the job while driving it, in ms. */
  pollMs?: number;
  /** Called with a cleanup function that must run if the process is interrupted. */
  onInterrupt?(cleanup: () => Promise<void> | void): () => void;
  /** `serve` registers here to be told when to stop (SIGINT or SIGTERM). Returns an unregister function. */
  onStop?(stop: () => void): () => void;
  /** Replaces the plugin list `serve` loads. Tests use it to put fakes in place of the worker and GitHub. */
  servePlugins?: Plugin[];
}

const USAGE = `bulig: a small kernel for Claude Code agent work

Usage:
  bulig serve
  bulig run --repo <path> --title <text> [--issue <text>]
  bulig approve <jobId> <plan|merge>
  bulig deny <jobId>
  bulig resume <jobId>
  bulig status [jobId]
  bulig history <jobId>

A job id can be shortened to any unique start of it.
Config: bulig.config.json in the current folder, or ~/.bulig/config.json.`;

/** Where a driven job comes to rest. */
const RESTING: JobStatus[] = ['awaiting_approval', 'done', 'failed', 'cancelled'];

class UserError extends Error {}

export async function runCli(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'serve':
        return await cmdServe(rest, io);
      case 'run':
        return await cmdRun(rest, io);
      case 'approve':
        return await cmdApprove(rest, io);
      case 'deny':
        return await cmdDeny(rest, io);
      case 'resume':
        return await cmdResume(rest, io);
      case 'status':
        return cmdStatus(rest, io);
      case 'history':
        return cmdHistory(rest, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        io.err(`bulig: unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UserError || err instanceof ConfigError) {
      io.err(`bulig: ${err.message}`);
      return 2;
    }
    io.err(`bulig: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---------- running a job ----------

interface Session {
  kernel: Kernel;
  channel: CliChannel;
  close(): Promise<void>;
}

/** The event the pipeline listens to behind the gates that are on. Undefined means no gate: the worker's own stage.completed. */
export const gateResultEvent = (enabled: readonly string[]) => (enabled.includes('gate-promise') ? 'stage.screened' : enabled.includes('gate-evidence') ? 'stage.checked' : undefined);

/** With gate-evidence on, gate-promise reads its stage.checked so the evidence marks travel on and only one event reaches the pipeline. */
export const promiseInput = (enabled: readonly string[]) =>
  enabled.includes('gate-promise') ? (enabled.includes('gate-evidence') ? 'stage.checked' : 'stage.completed') : undefined;

/**
 * The plugin config the kernel gets: the user's, with the gate wiring on top. The wiring is computed from `enabled`
 * and wins over anything the user wrote for it, because a hand-set `input` that nothing feeds would hang every stage.
 */
export function kernelPluginConfig(config: BuligConfig, resume: 'all' | false | string[]): Record<string, Record<string, unknown>> {
  const input = promiseInput(config.enabled);
  const result = gateResultEvent(config.enabled);
  return {
    ...config.pluginConfig,
    // The pipeline takes its results from the last gate of the chain, not straight from the worker:
    // worker -> stage.completed -> gate-evidence -> stage.checked -> gate-promise -> stage.screened -> pipeline.
    // Each gate reads the event the one before it says, so a gate can be on alone or with the other, in any order in `enabled`.
    ...(input && { 'gate-promise': { ...config.pluginConfig['gate-promise'], input } }),
    'pipeline-dev': { ...(result && { stageResultEvent: result }), ...config.pluginConfig['pipeline-dev'], resume },
  };
}

/** The built-in plugins `run` and `serve` share. Each command adds its own channel(s); one list so the two cannot drift apart. */
export const CORE_PLUGINS: Plugin[] = [worker, gate, gatePromise, github, pipeline];

const GATE_FOR_EVENT: Record<string, string> = { 'stage.checked': 'gate-evidence', 'stage.screened': 'gate-promise' };

/**
 * Fail at start, by name, instead of hanging later: the kernel quietly skips an enabled plugin nobody registered,
 * and a pipeline listening to a gate's event that no running gate emits would wait on its first stage forever.
 */
export function assertWiring(plugins: readonly Plugin[], enabled: readonly string[], pluginConfig: Record<string, Record<string, unknown>>): void {
  const registered = new Set(plugins.map((p) => (p.manifest as { name?: string }).name));
  const missing = enabled.filter((n) => !registered.has(n));
  if (missing.length) throw new UserError(`enabled but not registered by this command: ${missing.join(', ')}. Remove it from "enabled" or use a command that loads it.`);
  const event = pluginConfig['pipeline-dev']?.stageResultEvent;
  const gateName = typeof event === 'string' ? GATE_FOR_EVENT[event] : undefined;
  if (gateName && enabled.includes('pipeline-dev') && !enabled.includes(gateName)) {
    throw new UserError(`pipeline-dev reads ${event}, which only ${gateName} emits, but ${gateName} is not enabled. Every job would hang after its first stage.`);
  }
}

async function openSession(
  config: BuligConfig,
  io: Io,
  resume: 'all' | false | string[],
  onlyJob?: string,
  pluginsFor: (channel: CliChannel) => Plugin[] = (channel) => [channel.plugin, ...CORE_PLUGINS],
): Promise<Session> {
  const channel = createCliChannel({ write: (l) => io.out(l), ...(onlyJob && { onlyJob }) });
  const plugins = pluginsFor(channel);
  const pluginConfig = kernelPluginConfig(config, resume);
  assertWiring(plugins, config.enabled, pluginConfig);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const release = acquireLock(config.dbPath);
  const kernel = createKernel({
    dbPath: config.dbPath,
    plugins,
    enabled: config.enabled,
    grants: config.grants,
    eventCapabilities: config.eventCapabilities,
    pluginConfig,
    logger: {
      debug() {},
      info() {},
      warn: (m) => io.err(`warn: ${m}`),
      error: (m) => io.err(`error: ${m}`),
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await kernel.stop();
    } finally {
      release();
    }
  };
  const forget = io.onInterrupt?.(close);
  try {
    await kernel.start();
  } catch (err) {
    await close();
    throw new UserError(err instanceof Error ? err.message : String(err));
  }
  return {
    kernel,
    channel,
    async close() {
      forget?.();
      await close();
    },
  };
}

/** Wait until the job comes to rest. Polls the store, which only this process writes. */
async function drive(kernel: Kernel, jobId: string, io: Io): Promise<Job> {
  for (;;) {
    const job = kernel.jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} vanished`);
    if (RESTING.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, io.pollMs ?? 150));
  }
}

function finish(job: Job, io: Io): number {
  io.out(`bulig: job ${job.id} is ${job.status.replace('_', ' ')}`);
  return job.status === 'failed' ? 1 : 0;
}

async function cmdRun(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { repo: { type: 'string' }, title: { type: 'string' }, issue: { type: 'string' } },
    strict: true,
  });
  if (!values.repo || !values.title) throw new UserError('run needs --repo <path> and --title <text>');
  const repo = resolve(io.cwd, values.repo);
  if (!existsSync(resolve(repo, '.git'))) throw new UserError(`${repo} is not a git repository`);
  const { config } = loadConfig(io.cwd, io.home);

  const session = await openSession(config, io, false);
  try {
    const job = session.channel.submit({ repo, title: values.title, ...(values.issue && { body: values.issue }) });
    io.out(`bulig: started job ${job.id}`);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

async function cmdApprove(args: string[], io: Io): Promise<number> {
  const [idArg, kind, ...extra] = args;
  if (!idArg || (kind !== 'plan' && kind !== 'merge') || extra.length) throw new UserError('usage: bulig approve <jobId> <plan|merge>');
  const { config } = loadConfig(io.cwd, io.home);
  const { job, stages } = lookup(config, idArg);
  const waiting = stages.find((s) => s.name.startsWith('approve-') && s.status === 'running');
  if (job.status !== 'awaiting_approval' || !waiting) {
    throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}, not waiting for an approval`);
  }
  if (waiting.name !== `approve-${kind}`) {
    throw new UserError(`job ${job.id} is waiting for the ${waiting.name.slice(8)} approval, not ${kind}`);
  }

  const session = await openSession(config, io, [job.id], job.id);
  try {
    session.channel.grant(job.id, kind);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

async function cmdDeny(args: string[], io: Io): Promise<number> {
  const [idArg, ...extra] = args;
  if (!idArg || extra.length) throw new UserError('usage: bulig deny <jobId>');
  const { config } = loadConfig(io.cwd, io.home);
  const { job } = lookup(config, idArg);
  if (job.status !== 'awaiting_approval') throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}, not waiting for an approval`);
  const session = await openSession(config, io, false, job.id);
  try {
    session.channel.deny(job.id);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

/** Pick up a job whose process died mid-stage. */
async function cmdResume(args: string[], io: Io): Promise<number> {
  const [idArg, ...extra] = args;
  if (!idArg || extra.length) throw new UserError('usage: bulig resume <jobId>');
  const { config } = loadConfig(io.cwd, io.home);
  const { job } = lookup(config, idArg);
  if (job.status !== 'running' && job.status !== 'queued') throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}; only running jobs resume`);
  const session = await openSession(config, io, [job.id], job.id);
  try {
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

/**
 * Keep the kernel running until told to stop. This is the mode for Telegram: jobs start, wait for
 * approvals and finish while the process stays up. Unfinished jobs are picked up on start.
 */
async function cmdServe(args: string[], io: Io): Promise<number> {
  if (args.length) throw new UserError('usage: bulig serve');
  const { config } = loadConfig(io.cwd, io.home);
  if (!config.enabled.includes('channel-telegram') && !config.enabled.includes('channel-cli')) {
    throw new UserError('serve needs a channel. Enable "channel-telegram" in the config.');
  }
  const session = await openSession(config, io, 'all', undefined, (channel) =>
    io.servePlugins ?? [telegram, channel.plugin, ...CORE_PLUGINS],
  );
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const forget = io.onStop?.(stop);
  io.out(`bulig: serving with ${config.enabled.join(', ')}. Stop with Ctrl-C.`);
  try {
    await stopped;
    io.out('bulig: stopping. Unfinished jobs pick up again on the next serve.');
  } finally {
    forget?.();
    await session.close();
  }
  return 0;
}

// ---------- reading ----------

function dbPathFor(io: Io): string {
  try {
    return loadConfig(io.cwd, io.home).config.dbPath;
  } catch (err) {
    if (err instanceof ConfigError && err.message.startsWith('No config found')) return defaultDbPath(io.home);
    throw err;
  }
}

function readStore<T>(io: Io, fn: (store: Store) => T): T {
  const dbPath = dbPathFor(io);
  if (!existsSync(dbPath)) throw new UserError(`no database at ${dbPath} yet. Run a job first.`);
  const store = new Store(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Find a job by full id or a unique prefix. */
function lookup(config: BuligConfig, idArg: string): { job: Job; stages: Stage[] } {
  if (!existsSync(config.dbPath)) throw new UserError(`no database at ${config.dbPath} yet. Run a job first.`);
  const store = new Store(config.dbPath);
  try {
    const matches = store.listJobs().filter((j) => j.id === idArg || j.id.startsWith(idArg));
    if (matches.length === 0) throw new UserError(`no job starts with "${idArg}"`);
    if (matches.length > 1) throw new UserError(`"${idArg}" matches ${matches.length} jobs; type more of the id`);
    const job = matches[0]!;
    return { job, stages: store.listStages(job.id) };
  } finally {
    store.close();
  }
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const secs = (a: string, b: string | null) => (b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)}s` : '-');
const cell = (v: unknown) => String(v ?? '-');

function cmdStatus(args: string[], io: Io): number {
  const [idArg] = args;
  readStore(io, (store) => {
    if (!idArg) {
      const jobs = store.listJobs().reverse();
      if (jobs.length === 0) return io.out('no jobs yet');
      for (const j of jobs) io.out(`${j.id.slice(0, 8)}  ${pad(j.status, 17)}${pad(j.title, 40)} ${j.repo}`);
      return;
    }
    const matches = store.listJobs().filter((j) => j.id.startsWith(idArg));
    if (matches.length !== 1) throw new UserError(matches.length ? `"${idArg}" matches ${matches.length} jobs` : `no job starts with "${idArg}"`);
    const job = matches[0]!;
    io.out(`job      ${job.id}`);
    io.out(`title    ${job.title}`);
    io.out(`repo     ${job.repo}`);
    io.out(`status   ${job.status}`);
    io.out(`created  ${job.createdAt}`);
    io.out(`updated  ${job.updatedAt}`);
    printStages(store.listStages(job.id), io);
  });
  return 0;
}

function printStages(stages: Stage[], io: Io): void {
  io.out('');
  io.out(`${pad('stage', 15)}${pad('try', 5)}${pad('status', 9)}${pad('time', 9)}${pad('cost', 9)}session`);
  for (const s of stages) {
    const o = (s.output && typeof s.output === 'object' ? s.output : {}) as Record<string, unknown>;
    const cost = typeof o.costUsd === 'number' ? `$${o.costUsd.toFixed(4)}` : '-';
    const session = typeof o.sessionId === 'string' ? o.sessionId : '-';
    const note = o.interrupted ? ' (interrupted)' : typeof o.verdict === 'string' ? ` ${o.verdict}` : '';
    io.out(`${pad(s.name, 15)}${pad(String(s.attempt), 5)}${pad(s.status, 9)}${pad(secs(s.startedAt, s.endedAt), 9)}${pad(cost, 9)}${session}${note}`);
  }
}

function cmdHistory(args: string[], io: Io): number {
  const [idArg] = args;
  if (!idArg) throw new UserError('usage: bulig history <jobId>');
  readStore(io, (store) => {
    const matches = store.listJobs().filter((j) => j.id.startsWith(idArg));
    if (matches.length !== 1) throw new UserError(matches.length ? `"${idArg}" matches ${matches.length} jobs` : `no job starts with "${idArg}"`);
    const job = matches[0]!;
    io.out(`job ${job.id}  ${job.status}  ${job.title}`);
    printStages(store.listStages(job.id), io);
    io.out('');
    io.out('events');
    for (const e of store.eventsForJob(job.id)) {
      io.out(`${pad(String(e.seq), 5)}${pad(e.at.slice(11, 19), 9)}${pad(e.type, 20)}${pad(e.source, 20)}${summary(e.payload)}`);
    }
  });
  return 0;
}

function summary(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return cell(payload);
  const p = payload as Record<string, unknown>;
  const pick = ['stage', 'kind', 'url', 'number', 'headSha', 'branch', 'reason', 'error', 'from', 'to', 'sessionId', 'costUsd'];
  const parts = pick.filter((k) => p[k] !== undefined).map((k) => `${k}=${String(p[k]).replace(/\s+/g, ' ').slice(0, 60)}`);
  return parts.join(' ');
}


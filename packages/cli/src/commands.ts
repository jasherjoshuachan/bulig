import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createCliChannel, type CliChannel } from '@bulig/channel-cli';
import telegram from '@bulig/channel-telegram';
import { assertPostgresUrl, createKernel, PostgresStore, SchemaNotReadyError, SqliteStore, type Kernel, type Store } from '@bulig/core';
import gate from '@bulig/gate-evidence';
import gatePromise from '@bulig/gate-promise';
import github from '@bulig/github';
import pipeline from '@bulig/pipeline-dev';
import type { Job, JobStatus, Plugin, Stage } from '@bulig/plugin-sdk';
import worker, { readCredential } from '@bulig/worker-claude-code';
import gateway from '@bulig/worker-gateway';
import { ConfigError, defaultDbPath, loadConfig, type BuligConfig } from './config.ts';
import { clipText } from '@bulig/text';
import { acquireLock } from './lock.ts';
import { cmdGates, ensureSoakStarted } from './gates.ts';
import { cmdWorker } from './worker-cmd.ts';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  home: string;
  /** Where `store.urlEnv` is looked up. Default process.env. */
  env?: Record<string, string | undefined>;
  /** How often to look at the job while driving it, in ms. */
  pollMs?: number;
  /** Called with a cleanup function that must run if the process is interrupted. */
  onInterrupt?(cleanup: () => Promise<void> | void): () => void;
  /** `serve` registers here to be told when to stop (SIGINT or SIGTERM). Returns an unregister function. */
  onStop?(stop: () => void): () => void;
  /** Opens the store the kernel runs on, in place of SQLite at the configured path. Tests use it to put a slow store under a command. */
  openStore?(dbPath: string): Store;
  /** The longest `drive` waits for the handlers of already-logged events to return before it trusts a resting status. Default 30000. */
  settleMs?: number;
  /** Lease timings for the kernel, in ms. Tests use it to lose the lease in under a second. Default: the kernel's own (30 s lease, renewed every 10 s). */
  lease?: { ttlMs: number; heartbeatMs: number };
  /** Replaces the plugin list `serve` loads. Tests use it to put fakes in place of the worker and GitHub. */
  servePlugins?: Plugin[];
}

const USAGE = `bulig: a small kernel for Claude Code agent work

Usage:
  bulig serve
  bulig run --repo <path> --title <text> [--issue <text>]   (one-off; needs "worker-claude-code" in the config, else use serve)
  bulig approve <jobId> <plan|merge> <stageId>
  bulig deny <jobId> <stageId>
  bulig resume <jobId>
  bulig status [jobId]
  bulig history <jobId>
  bulig worker --kernel <url> --id <workerId> (--token-env <VAR> | --token-file <path>) [--slots 2] --repo <kernelPath>=<localClone> ...

A job id can be shortened to any unique start of it.
Config, first found wins: $CREDENTIALS_DIRECTORY/config, the file $BULIG_CONFIG names, bulig.config.json in the current folder, ~/.bulig/config.json.`;

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
      case 'migrate': return await (await import('./migrate.ts')).cmdMigrate(rest, io);
      case 'status':
        return await cmdStatus(rest, io);
      case 'history':
        return await cmdHistory(rest, io);
      case 'gates':
        return await cmdGates(rest, io, { readStore, withKernel, UserError });
      case 'worker':
        return await cmdWorker(rest, io);
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
export function kernelPluginConfig(config: BuligConfig, resume: 'all' | false | string[], gatewayOn = false): Record<string, Record<string, unknown>> {
  const input = promiseInput(config.enabled);
  const result = gateResultEvent(config.enabled);
  const evidenceFrom = config.pluginConfig['gate-evidence']?.evidenceSources;
  return {
    ...config.pluginConfig,
    // Behind the worker gateway, the in-process worker takes only the stages the gateway gives it, and the gateway's stage.completed
    // carries the evidence a remote worker's Claude run produced, so the evidence gate trusts it as it trusts the in-process worker.
    ...(gatewayOn && {
      'worker-claude-code': { ...config.pluginConfig['worker-claude-code'], via: 'gateway' },
      // A kernel that does not run the in-process worker (gateway only, as on the server where Claude runs as another user) has no
      // local slots, whatever the gateway config says: a stage given to a worker that is not there would wait for ever.
      ...(!config.enabled.includes('worker-claude-code') && { 'worker-gateway': { ...config.pluginConfig['worker-gateway'], localSlots: 0 } }),
      ...(config.enabled.includes('gate-evidence') && {
        'gate-evidence': { ...config.pluginConfig['gate-evidence'], evidenceSources: [...new Set([...(Array.isArray(evidenceFrom) ? evidenceFrom : ['worker-claude-code']), 'worker-gateway'])] },
      }),
    }),
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
 * `mayOmit` names plugins this command legitimately leaves out (run, approve, deny and resume have no Telegram).
 * Fail at start, by name, instead of hanging later: the kernel quietly skips an enabled plugin nobody registered,
 * and a pipeline listening to a gate's event that no running gate emits would wait on its first stage forever.
 */
export function assertWiring(plugins: readonly Plugin[], enabled: readonly string[], pluginConfig: Record<string, Record<string, unknown>>, mayOmit: readonly string[] = []): void {
  const registered = new Set(plugins.map((p) => (p.manifest as { name?: string }).name));
  const missing = enabled.filter((n) => !registered.has(n) && !mayOmit.includes(n));
  if (missing.length) throw new UserError(`enabled but not registered by this command: ${missing.join(', ')}. Remove it from "enabled" or use a command that loads it.`);
  const event = pluginConfig['pipeline-dev']?.stageResultEvent;
  const gateName = typeof event === 'string' ? GATE_FOR_EVENT[event] : undefined;
  if (gateName && enabled.includes('pipeline-dev') && !enabled.includes(gateName)) {
    throw new UserError(`pipeline-dev reads ${event}, which only ${gateName} emits, but ${gateName} is not enabled. Every job would hang after its first stage.`);
  }
}

/** The plugins `run`, `approve`, `deny` and `resume` load: the terminal channel and the core. Telegram belongs to `serve`. */
const terminalPlugins = (channel: CliChannel): Plugin[] => [channel.plugin, ...CORE_PLUGINS];

/**
 * A one-off command (run, approve, resume) loads the in-process worker and never the gateway, so a config without
 * `worker-claude-code` leaves the first stage with nobody to take it: the job would sit queued with no error. Refuse before anything is written.
 */
function assertOneOffHasWorker(config: BuligConfig, command: string): void {
  if (config.enabled.includes('worker-claude-code')) return;
  throw new UserError(
    `bulig ${command} cannot run here: the config has no worker for one-off commands ("worker-claude-code" is not enabled, and a one-off command never starts the worker gateway). ` +
      'Jobs on this machine go through "bulig serve". On a gateway-only server, submit through the channel serve listens on. ' +
      'To run one-off, stop serve first and add "worker-claude-code" to "enabled".',
  );
}

async function openSession(
  config: BuligConfig,
  io: Io,
  resume: 'all' | false | string[],
  onlyJob?: string,
  pluginsFor: (channel: CliChannel) => Plugin[] = terminalPlugins,
  onLeaseLost?: (reason: string) => void,
): Promise<Session> {
  const channel = createCliChannel({ write: (l) => io.out(l), ...(onlyJob && { onlyJob }) });
  const plugins = pluginsFor(channel);
  // The gateway belongs to `serve`: a one-shot command must not open the port or hand its stages to anyone.
  const gatewayOn = config.enabled.includes('worker-gateway') && plugins.includes(gateway);
  const pluginConfig = kernelPluginConfig(config, resume, gatewayOn);
  assertWiring(plugins, config.enabled, pluginConfig, pluginsFor === terminalPlugins ? ['channel-telegram', 'worker-gateway'] : []);
  // Settle the store's URL first: if the variable is missing or malformed, nothing has been locked yet.
  const postgresUrl = !io.openStore && config.store.kind === 'postgres' ? connectionString(config, io) : undefined;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const release = acquireLock(config.dbPath);
  let kernel: Kernel;
  try {
    // The kernel's Postgres store is the writer: it holds the writer lock on the database while it is open (see PostgresStoreOptions).
    const store = io.openStore ? io.openStore(config.dbPath) : postgresUrl ? new PostgresStore(postgresUrl, { mode: 'writer' }) : undefined;
    kernel = createKernel({
      dbPath: config.dbPath,
      ...(store && { store }),
      plugins,
      enabled: config.enabled,
      grants: config.grants,
      eventCapabilities: config.eventCapabilities,
      pluginConfig,
      ...(io.lease && { leaseTtlMs: io.lease.ttlMs, leaseHeartbeatMs: io.lease.heartbeatMs }),
      ...(onLeaseLost && { onLeaseLost }),
      logger: {
        debug() {},
        info() {},
        warn: (m) => io.err(`warn: ${m}`),
        error: (m) => io.err(`error: ${m}`),
      },
    });
  } catch (err) {
    release();
    throw err;
  }
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

/**
 * Wait until the job comes to rest. Polls the kernel's store, which only this process writes.
 *
 * A status read here can predate what the pipeline does with the event the command just emitted (an approval, say):
 * the job still says awaiting_approval because the handler has not run yet. So when the status looks like rest, wait until
 * the bus has delivered everything logged so far and the handlers started for it have returned, then read again.
 * That wait ends when the work is done, not after a set time. `settleMs` only stops a handler that never returns
 * from holding the command up for good.
 */
async function drive(kernel: Kernel, jobId: string, io: Io): Promise<Job> {
  for (;;) {
    let job = await kernel.jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} vanished`);
    if (RESTING.includes(job.status)) {
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([kernel.bus.settle(), new Promise<void>((r) => (giveUp = setTimeout(r, io.settleMs ?? 30_000)))]);
      clearTimeout(giveUp);
      job = await kernel.jobs.get(jobId);
      if (!job) throw new Error(`job ${jobId} vanished`);
      if (RESTING.includes(job.status)) return job;
    }
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
  const { config } = loadConfig(io.cwd, io.home, io.env);
  assertOneOffHasWorker(config, 'run');

  const session = await openSession(config, io, false);
  try {
    const job = await session.channel.submit({ repo, title: values.title, ...(values.issue && { body: values.issue }) });
    io.out(`bulig: started job ${job.id}`);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

async function cmdApprove(args: string[], io: Io): Promise<number> {
  const [idArg, kind, stageArg, ...extra] = args;
  if (!idArg || (kind !== 'plan' && kind !== 'merge') || extra.length) throw new UserError('usage: bulig approve <jobId> <plan|merge> <stageId>');
  const { config } = loadConfig(io.cwd, io.home, io.env);
  assertOneOffHasWorker(config, 'approve');
  const { job, stages } = await lookup(config, io, idArg);
  const waiting = stages.find((s) => s.name.startsWith('approve-') && s.status === 'running');
  if (job.status !== 'awaiting_approval' || !waiting) {
    throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}, not waiting for an approval`);
  }
  if (waiting.name !== `approve-${kind}`) {
    throw new UserError(`job ${job.id} is waiting for the ${waiting.name.slice(8)} approval, not ${kind}`);
  }
  checkStage(job.id, waiting, stageArg);

  const session = await openSession(config, io, [job.id], job.id);
  try {
    session.channel.grant(job.id, kind, waiting.id);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

async function cmdDeny(args: string[], io: Io): Promise<number> {
  const [idArg, stageArg, ...extra] = args;
  if (!idArg || extra.length) throw new UserError('usage: bulig deny <jobId> <stageId>');
  const { config } = loadConfig(io.cwd, io.home, io.env);
  const { job, stages } = await lookup(config, io, idArg);
  const waiting = stages.find((s) => s.name.startsWith('approve-') && s.status === 'running');
  if (job.status !== 'awaiting_approval' || !waiting) throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}, not waiting for an approval`);
  checkStage(job.id, waiting, stageArg);
  const session = await openSession(config, io, false, job.id);
  try {
    session.channel.deny(job.id, waiting.id);
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

/**
 * An approve or deny names the approval stage it answers by its full id, as printed with the question. A command copied
 * from an earlier question of the same kind names another stage, and is refused. No prefixes: stage ids from one store
 * can share their first characters.
 */
function checkStage(jobId: string, waiting: { id: string; name: string }, stageArg: string | undefined): void {
  const what = `the ${waiting.name.slice(8)} approval, stage ${waiting.id}`;
  if (!stageArg) throw new UserError(`name the approval stage you are answering. Job ${jobId} is waiting for ${what}. See the open stage with: bulig history ${jobId}`);
  if (stageArg !== waiting.id) throw new UserError(`stage ${stageArg} is not the open question, so it has expired. Job ${jobId} is waiting for ${what}. See the open stage with: bulig history ${jobId}`);
}

/** Pick up a job whose process died mid-stage. */
async function cmdResume(args: string[], io: Io): Promise<number> {
  const [idArg, ...extra] = args;
  if (!idArg || extra.length) throw new UserError('usage: bulig resume <jobId>');
  const { config } = loadConfig(io.cwd, io.home, io.env);
  assertOneOffHasWorker(config, 'resume');
  const { job } = await lookup(config, io, idArg);
  if (job.status !== 'running' && job.status !== 'queued') throw new UserError(`job ${job.id} is ${job.status.replace('_', ' ')}; only running jobs resume`);
  const session = await openSession(config, io, [job.id], job.id);
  try {
    return finish(await drive(session.kernel, job.id, io), io);
  } finally {
    await session.close();
  }
}

/** A kernel of our own for a command that writes (`bulig gates mark-false`): the same lock and lease as `deny`, refused while `serve` holds the record. */
async function withKernel<T>(io: Io, fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const { config } = loadConfig(io.cwd, io.home);
  const session = await openSession(config, io, false);
  try {
    return await fn(session.kernel);
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
  const { config } = loadConfig(io.cwd, io.home, io.env);
  if (!config.enabled.includes('channel-telegram') && !config.enabled.includes('channel-cli')) {
    throw new UserError('serve needs a channel. Enable "channel-telegram" in the config.');
  }
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let leaseLost = false;
  const session = await openSession(
    config,
    io,
    'all',
    undefined,
    (channel) => io.servePlugins ?? [telegram, gateway, channel.plugin, ...CORE_PLUGINS],
    (reason) => {
      // Lost lease means stop writing at once (ADR 0010). The kernel has already stopped writing. Stop the workers too, and
      // end non-zero so a supervisor restarts serve; the next start resumes from the record.
      leaseLost = true;
      io.err(`bulig: lost the executor lease (${reason}). Stopping the workers and exiting with an error so a supervisor restarts serve. The next start resumes from the record.`);
      stop();
    },
  );
  // The soak clock (step 5) starts the first time a kernel with a gate runs on a record. A failure here must not take serve down.
  await ensureSoakStarted(session.kernel, config).catch((err: unknown) => io.err(`warn: could not record the soak start: ${err instanceof Error ? err.message : String(err)}`));
  const forget = io.onStop?.(stop);
  io.out(`bulig: serving with ${config.enabled.join(', ')}. Stop with Ctrl-C.`);
  try {
    await stopped;
    if (!leaseLost) io.out('bulig: stopping. Unfinished jobs pick up again on the next serve.');
  } finally {
    forget?.();
    // Closing stops every plugin, which ends the running Claude processes. After a lost lease, do not let a stuck close keep the process alive.
    if (leaseLost) {
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([session.close().catch(() => {}), new Promise<void>((r) => (giveUp = setTimeout(r, 20_000)))]);
      clearTimeout(giveUp);
    } else {
      await session.close();
    }
  }
  return leaseLost ? 1 : 0;
}

// ---------- reading ----------

/** The config the read commands need: the store only. With no config file at all they look at the default SQLite file. */
function storeConfigFor(io: Io): Pick<BuligConfig, 'store' | 'dbPath'> {
  try {
    const { config } = loadConfig(io.cwd, io.home, io.env);
    return { store: config.store, dbPath: config.dbPath };
  } catch (err) {
    if (err instanceof ConfigError && err.message.startsWith('No config found')) return { store: { kind: 'sqlite' }, dbPath: defaultDbPath(io.home) };
    throw err;
  }
}

/** The Postgres connection string, from the variable the config names. Never from the config file itself. */
function connectionString(config: Pick<BuligConfig, 'store'>, io: Io): string {
  if (config.store.kind !== 'postgres') throw new Error('connectionString is only for a postgres store');
  const name = config.store.urlEnv;
  const env = io.env ?? process.env;
  // On a server the string is a systemd credential file, which wins; on the Mac it is the environment variable, as before.
  const url = (config.store.urlCredential ? readCredential(config.store.urlCredential, env) : undefined) ?? env[name];
  if (!url) throw new UserError(`store.urlEnv is "${name}", but that environment variable is not set. Set it to the Postgres connection string.`);
  try {
    assertPostgresUrl(url);
  } catch {
    // Never repeat the value: it may hold a password.
    throw new UserError(`The environment variable "${name}" does not hold a usable Postgres connection string. It must start with postgres:// or postgresql:// and name a host (or a host= parameter).`);
  }
  return url;
}

/** Open the store the kernel is configured with, read from it through the port, and close it. These reads do not go through the kernel queue. */
async function withConfiguredStore<T>(config: Pick<BuligConfig, 'store' | 'dbPath'>, io: Io, fn: (store: Store) => Promise<T>): Promise<T> {
  let store: Store;
  if (config.store.kind === 'postgres') {
    // A reader: a short look from outside the kernel. It never takes or waits for the kernel's writer lock.
    store = new PostgresStore(connectionString(config, io), { mode: 'reader' });
  } else {
    if (!existsSync(config.dbPath)) throw new UserError(`no database at ${config.dbPath} yet. Run a job first.`);
    store = new SqliteStore(config.dbPath);
  }
  try {
    return await fn(store);
  } catch (err) {
    // A reader does not create or upgrade the schema; say what to do, the way a missing SQLite file does.
    if (err instanceof SchemaNotReadyError) throw new UserError(err.message);
    throw err;
  } finally {
    await store.close();
  }
}

const readStore = <T>(io: Io, fn: (store: Store) => Promise<T>): Promise<T> => withConfiguredStore(storeConfigFor(io), io, fn);

/** Find a job by full id or a unique prefix. */
function lookup(config: BuligConfig, io: Io, idArg: string): Promise<{ job: Job; stages: Stage[] }> {
  return withConfiguredStore(config, io, async (store) => {
    const matches = (await store.listJobs()).filter((j) => j.id === idArg || j.id.startsWith(idArg));
    if (matches.length === 0) throw new UserError(`no job starts with "${idArg}"`);
    if (matches.length > 1) throw new UserError(`"${idArg}" matches ${matches.length} jobs; type more of the id`);
    const job = matches[0]!;
    return { job, stages: await store.listStages(job.id) };
  });
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const secs = (a: string, b: string | null) => (b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)}s` : '-');
const cell = (v: unknown) => String(v ?? '-');

async function cmdStatus(args: string[], io: Io): Promise<number> {
  const [idArg] = args;
  await readStore(io, async (store) => {
    if (!idArg) {
      const jobs = (await store.listJobs()).reverse();
      if (jobs.length === 0) return io.out('no jobs yet');
      for (const j of jobs) io.out(`${j.id.slice(0, 8)}  ${pad(j.status, 17)}${pad(j.title, 40)} ${j.repo}`);
      return;
    }
    const matches = (await store.listJobs()).filter((j) => j.id.startsWith(idArg));
    if (matches.length !== 1) throw new UserError(matches.length ? `"${idArg}" matches ${matches.length} jobs` : `no job starts with "${idArg}"`);
    const job = matches[0]!;
    io.out(`job      ${job.id}`);
    io.out(`title    ${job.title}`);
    io.out(`repo     ${job.repo}`);
    io.out(`status   ${job.status}`);
    io.out(`created  ${job.createdAt}`);
    io.out(`updated  ${job.updatedAt}`);
    printStages(await store.listStages(job.id), io);
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
    // An approval stage shows its id: `bulig approve` and `bulig deny` name it.
    const note = s.name.startsWith('approve-') ? ` stage ${s.id}` : o.interrupted ? ' (interrupted)' : typeof o.verdict === 'string' ? ` ${o.verdict}` : '';
    io.out(`${pad(s.name, 15)}${pad(String(s.attempt), 5)}${pad(s.status, 9)}${pad(secs(s.startedAt, s.endedAt), 9)}${pad(cost, 9)}${session}${note}`);
  }
}

async function cmdHistory(args: string[], io: Io): Promise<number> {
  const [idArg] = args;
  if (!idArg) throw new UserError('usage: bulig history <jobId>');
  await readStore(io, async (store) => {
    const matches = (await store.listJobs()).filter((j) => j.id.startsWith(idArg));
    if (matches.length !== 1) throw new UserError(matches.length ? `"${idArg}" matches ${matches.length} jobs` : `no job starts with "${idArg}"`);
    const job = matches[0]!;
    io.out(`job ${job.id}  ${job.status}  ${job.title}`);
    printStages(await store.listStages(job.id), io);
    io.out('');
    io.out('events');
    for (const e of await store.eventsForJob(job.id)) {
      io.out(`${pad(String(e.seq), 5)}${pad(e.at.slice(11, 19), 9)}${pad(e.type, 20)}${pad(e.source, 20)}${summary(e.payload)}`);
    }
  });
  return 0;
}

function summary(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return cell(payload);
  const p = payload as Record<string, unknown>;
  const pick = ['stage', 'kind', 'stageId', 'url', 'number', 'headSha', 'branch', 'reason', 'error', 'from', 'to', 'sessionId', 'costUsd'];
  const parts = pick.filter((k) => p[k] !== undefined).map((k) => `${k}=${clipText(String(p[k]).replace(/\s+/g, ' '), 60)}`);
  return parts.join(' ');
}


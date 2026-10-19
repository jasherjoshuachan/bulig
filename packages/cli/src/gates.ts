import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { derivedEventId, type Kernel, type Store } from '@bulig/core';
import { clipText } from '@bulig/text';
import { loadConfig, GATE_PLUGINS, type BuligConfig } from './config.ts';
import { ENFORCED, GATES, SOAK_DAYS, SOAK_JOBS, SOAK_STARTED, WARNING_FALSE, buildReport, findWarning, soakStart, type Report } from './gates-record.ts';
import type { Io } from './commands.ts';

/** What `bulig gates` borrows from commands.ts, so that file gets one registration line and no new exports. */
export interface GatesDeps {
  /** Opens the store the config names, runs `fn`, closes it. Read-only use only: on Postgres this is a reader that takes no writer lock and writes nothing fenced by the lease (ADR 0001, ADR 0010). */
  readStore<T>(io: Io, fn: (store: Store) => Promise<T>): Promise<T>;
  /**
   * Starts a kernel the way `deny` does (the pid lock on SQLite, the writer lock and the executor lease on Postgres), runs `fn`, and stops it.
   * Every write goes through `kernel.bus.emit`, the kernel's fenced queue. It fails while another kernel, such as `serve`, holds the record.
   */
  withKernel<T>(io: Io, fn: (kernel: Kernel) => Promise<T>): Promise<T>;
  /** The error class runCli prints as a plain message and answers with exit code 2. */
  UserError: new (message: string) => Error;
}

const USAGE = `usage:
  bulig gates soak start --restart
  bulig gates status
  bulig gates mark-false <event-id> --reason "<text>"
  bulig gates enforce [--force]`;

/** The operator's own events come from here, not from a plugin. */
const SOURCE = 'cli';

/** Tests set `io.now` to move the clock. Real runs have no such field. */
const nowOf = (io: Io): Date => (io as Io & { now?: () => Date }).now?.() ?? new Date();

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `bulig gates ...`: the step 5 soak counter and the switch to enforce. */
export async function cmdGates(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'soak':
      return soak(rest, io, deps);
    case 'status':
      return status(rest, io, deps);
    case 'mark-false':
      return markFalse(rest, io, deps);
    case 'enforce':
      return enforce(rest, io, deps);
    default:
      throw new deps.UserError(USAGE);
  }
}

/** The report, read from the whole log. The log is read once per command. */
async function report(io: Io, deps: GatesDeps): Promise<Report> {
  return deps.readStore(io, async (store) => buildReport(await store.eventsAfter(0), await store.listJobs(), nowOf(io)));
}

/** The gate is in `enabled` and not switched off in its own config. */
const gateOn = (config: Pick<BuligConfig, 'enabled' | 'pluginConfig'>, g: string): boolean => config.enabled.includes(g) && config.pluginConfig[g]?.enabled !== false;

/** The id of the one `gates.soak.started` a kernel writes by itself. A second try reads the same id, so it can only be written once. */
const AUTO_START_ID = derivedEventId('gates.soak', SOURCE, 0, SOAK_STARTED);

/**
 * `serve` calls this once it is up: the soak clock starts the first time a kernel with a gate runs on a record, and never again by itself.
 * The write is the kernel's own, through its fenced queue. Returns the start event if it wrote one.
 */
export async function ensureSoakStarted(kernel: Kernel, config: Pick<BuligConfig, 'enabled' | 'pluginConfig'>): Promise<{ id: string; at: string } | undefined> {
  // A gate that is listed but switched off passes everything through: it says nothing, so it does not start the clock.
  if (!GATES.some((g) => gateOn(config, g))) return undefined;
  if (soakStart(await kernel.bus.replay(0))) return undefined;
  const e = await kernel.bus.emit({ id: AUTO_START_ID, type: SOAK_STARTED, source: SOURCE, payload: { days: SOAK_DAYS, jobs: SOAK_JOBS, auto: true } });
  return { id: e.id, at: e.at };
}

/**
 * Run `fn` with a kernel of our own. While `serve` (or any other bulig process) holds the record this is refused, and that is intended:
 * one writer, fenced by the lease. Say what to do instead of passing on the lock's bare message.
 */
async function withWriter<T>(io: Io, deps: GatesDeps, what: string, fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  try {
    return await deps.withKernel(io, fn);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/Another bulig process|Another Bulig kernel|executor lease/i.test(m)) {
      throw new deps.UserError(`${what} writes to the record, and only one kernel may do that at a time. A running serve holds it: ${m}\nStop serve, run the command again, then start serve. bulig gates status can be read at any time.`);
    }
    throw err;
  }
}

async function soak(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  const [what, ...rest] = args;
  if (what !== 'start') throw new deps.UserError('usage: bulig gates soak start --restart');
  const { values } = parseArgs({ args: rest, options: { restart: { type: 'boolean' } }, strict: true });
  if (!values.restart) {
    throw new deps.UserError(
      'the soak clock starts by itself the first time serve runs with a gate on, so there is nothing to start. To begin again (after a gate was fixed, or when the record came from another machine): bulig gates soak start --restart',
    );
  }
  await withWriter(io, deps, 'soak start --restart', async (kernel) => {
    const prior = soakStart(await kernel.bus.replay(0));
    const e = await kernel.bus.emit({
      type: SOAK_STARTED,
      source: SOURCE,
      payload: { days: SOAK_DAYS, jobs: SOAK_JOBS, restart: true, ...(prior && { restartOf: prior.id }) },
    });
    io.out(`bulig: the soak started again at ${e.at} (event ${e.id}). The bar: ${SOAK_DAYS} days and ${SOAK_JOBS} jobs with zero false warnings. See bulig gates status.`);
  });
  return 0;
}

async function status(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  if (args.length) throw new deps.UserError('usage: bulig gates status');
  const r = await report(io, deps);
  if (!r.started) {
    io.out('soak      not started');
    io.out('');
    io.out(r.bar.line);
    return 0;
  }
  io.out(`soak      started ${r.start!.at} (event ${r.start!.id})`);
  io.out(`elapsed   ${r.daysElapsed.toFixed(1)} of ${SOAK_DAYS} days`);
  io.out(`jobs      ${r.jobs.length} of ${SOAK_JOBS} reached a gate`);
  if (r.synthetic) io.out(`ignored   ${r.synthetic} test job${r.synthetic === 1 ? '' : 's'} (title starts with [synthetic])`);
  if (r.enforced) io.out(`enforced  ${r.enforced.at}${r.enforced.forced ? ' (FORCED: the bar was not met)' : ''}`);
  io.out(`false     ${r.bar.falseWarnings} warning${r.bar.falseWarnings === 1 ? '' : 's'} marked false`);
  io.out('');
  io.out(`${pad('gate', 16)}${pad('clean', 8)}warned`);
  for (const g of r.gates) io.out(`${pad(g.gate, 16)}${pad(String(g.clean), 8)}${g.warned}`);
  if (r.jobs.length) {
    io.out('');
    io.out(`${pad('job', 10)}${pad('status', 18)}${pad('gates', 7)}${pad('warned', 8)}${pad('pr head', 9)}title (repo)`);
    for (const j of r.jobs) {
      io.out(`${pad(j.jobId.slice(0, 8), 10)}${pad(j.job?.status ?? '-', 18)}${pad(String(j.verdicts), 7)}${pad(String(j.warned), 8)}${pad(j.headSha?.slice(0, 7) ?? '-', 9)}${j.job ? `${clipText(oneLine(j.job.title), 40)} (${j.job.repo})` : '-'}`);
    }
  }
  if (r.warnings.length) {
    io.out('');
    io.out('warnings (mark a wrong one with: bulig gates mark-false <event-id> --reason "<text>")');
    for (const w of r.warnings) {
      io.out(`${w.eventId}  ${w.gate}  job ${w.jobId.slice(0, 8)}  ${w.stage}${w.blocked ? '  BLOCKED' : ''}`);
      for (const line of w.lines) io.out(`    ${clipText(oneLine(line), 160)}`);
      if (w.falseReason !== undefined) io.out(`    marked false: ${clipText(oneLine(w.falseReason), 160)}`);
    }
  }
  io.out('');
  io.out(r.bar.line);
  return 0;
}

async function markFalse(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  const usage = 'usage: bulig gates mark-false <event-id> --reason "<text>"';
  let parsed;
  try {
    parsed = parseArgs({ args, options: { reason: { type: 'string' } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new deps.UserError(`${(err as Error).message}\n${usage}`);
  }
  const [idArg, ...extra] = parsed.positionals;
  const reason = parsed.values.reason?.trim();
  if (!idArg || extra.length || !reason) throw new deps.UserError(usage);
  await withWriter(io, deps, 'mark-false', async (kernel) => {
    const r = buildReport(await kernel.bus.replay(0), await kernel.jobs.list(), nowOf(io));
    if (!r.started) throw new deps.UserError('the soak has not started, so there is no warning to mark. It starts when serve first runs with a gate on.');
    const found = findWarning(r, idArg);
    if (!found.ok) throw new deps.UserError(found.why);
    const w = found.warning;
    if (w.falseReason !== undefined) throw new deps.UserError(`warning ${w.eventId} is already marked false: ${oneLine(w.falseReason)}`);
    const e = await kernel.bus.emit({
      type: WARNING_FALSE,
      source: SOURCE,
      jobId: w.jobId,
      payload: { target: w.eventId, gate: w.gate, stage: w.stage, reason },
    });
    io.out(`bulig: marked ${w.eventId} (${w.gate}, ${w.stage}) as a false warning (event ${e.id}). The bar is not met while any warning is marked false; once the gate is fixed, restart with: bulig gates soak start --restart`);
  });
  return 0;
}

async function enforce(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { force: { type: 'boolean' } }, strict: true });
  const { config, path } = loadConfig(io.cwd, io.home);
  const already = GATES.filter((g) => config.pluginConfig[g]?.mode === 'enforce');
  if (already.length === GATES.length) {
    io.out(`bulig: both gates are already in enforce mode in ${path}. Nothing changed.`);
    return 0;
  }
  const r = await report(io, deps);
  if (!r.bar.met) {
    if (!values.force) throw new deps.UserError(`not switching to enforce: ${r.bar.line}. See bulig gates status. To switch anyway: bulig gates enforce --force`);
    io.out(`bulig: --force given, going on although ${r.bar.line}`);
  }
  const forced = !r.bar.met;
  // The switch is written through a kernel of our own, so a running serve refuses it (it has to be restarted for the change anyway), and the record keeps
  // whether the bar was met. The file is edited first: a record that says "enforced" over an unchanged file would be the worse mistake.
  const backup = await withWriter(io, deps, 'enforce', async (kernel) => {
    const done = setEnforce(path, io, deps);
    try {
      await kernel.bus.emit({
        type: ENFORCED,
        source: SOURCE,
        payload: { forced, bar: { met: r.bar.met, line: r.bar.line, moreDays: r.bar.moreDays, moreJobs: r.bar.moreJobs, falseWarnings: r.bar.falseWarnings }, daysElapsed: r.daysElapsed, jobs: r.jobs.length },
      });
    } catch (err) {
      throw new deps.UserError(`the config was changed (${path}, old file ${done}) but the record could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
    return done;
  });
  for (const note of inactive(config)) io.out(`bulig: note: ${note}`);
  io.out(`bulig: gate-evidence and gate-promise are now "enforce" in ${path} (the old file is ${backup}). Recorded as ${forced ? 'FORCED, the bar was not met' : 'the bar met'}.`);
  io.out('bulig: a running serve does not see this. Restart it to pick it up.');
  return 0;
}

/** A gate that is switched off or left out of `enabled` stays off whatever its mode says. Say so, so "enforce" is not taken for protection. */
function inactive(config: BuligConfig): string[] {
  return GATE_PLUGINS.filter((g) => !gateOn(config, g)).map(
    (g) => `${g} is not enabled, so it will not run in any mode.`,
  );
}

/**
 * Set `pluginConfig["gate-evidence"].mode` and `pluginConfig["gate-promise"].mode` to "enforce" and nothing else. The file is parsed and written
 * back with the indent it already had; JSON has no room for comments, so key order, values and the trailing newline are what carry over.
 * The old file is copied to `<config>.bak` first, the new one is written beside it and renamed over it, and a result the loader
 * refuses is rolled back from the copy.
 */
export function setEnforce(path: string, io: Pick<Io, 'cwd' | 'home'>, deps: Pick<GatesDeps, 'UserError'>): string {
  const original = readFileSync(path, 'utf8');
  const data = JSON.parse(original) as Record<string, unknown>;
  const pluginConfig = (data.pluginConfig && typeof data.pluginConfig === 'object' ? data.pluginConfig : (data.pluginConfig = {})) as Record<string, Record<string, unknown>>;
  for (const g of GATES) pluginConfig[g] = { ...pluginConfig[g], mode: 'enforce' };
  const indent = /^([ \t]+)"/m.exec(original)?.[1];
  const text = JSON.stringify(data, null, indent) + (original.endsWith('\n') ? '\n' : '');

  const backup = `${path}.bak`;
  copyFileSync(path, backup);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: statSync(path).mode & 0o777 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const back = loadConfig(io.cwd, io.home);
    if (back.path !== path) throw new Error(`the loader now reads ${back.path}`);
  } catch (err) {
    copyFileSync(backup, path);
    throw new deps.UserError(`the edited config did not load (${(err as Error).message}); ${path} was put back from ${backup}`);
  }
  return backup;
}


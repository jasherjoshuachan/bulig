import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Store } from '@bulig/core';
import { clipText } from '@bulig/text';
import { loadConfig, GATE_PLUGINS, type BuligConfig } from './config.ts';
import { GATES, SOAK_DAYS, SOAK_JOBS, SOAK_STARTED, WARNING_FALSE, buildReport, findWarning, type Report } from './gates-record.ts';
import type { Io } from './commands.ts';

/** What `bulig gates` borrows from commands.ts, so that file gets one registration line and no new exports. */
export interface GatesDeps {
  /** Opens the store the config names, runs `fn`, closes it. A Postgres store opened this way is a reader: it never takes the kernel's writer lock. */
  readStore<T>(io: Io, fn: (store: Store) => Promise<T>): Promise<T>;
  /** The error class runCli prints as a plain message and answers with exit code 2. */
  UserError: new (message: string) => Error;
}

const USAGE = `usage:
  bulig gates soak start [--restart]
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

async function soak(args: string[], io: Io, deps: GatesDeps): Promise<number> {
  const [what, ...rest] = args;
  if (what !== 'start') throw new deps.UserError('usage: bulig gates soak start [--restart]');
  const { values } = parseArgs({ args: rest, options: { restart: { type: 'boolean' } }, strict: true });
  await deps.readStore(io, async (store) => {
    const events = await store.eventsAfter(0);
    const before = buildReport(events, [], nowOf(io));
    if (before.started && !values.restart) {
      throw new deps.UserError(`the soak already started at ${before.start!.at}. Restarting throws away the record so far; do it only after a gate was fixed: bulig gates soak start --restart`);
    }
    const e = await store.appendEvent({
      type: SOAK_STARTED,
      source: SOURCE,
      payload: { days: SOAK_DAYS, jobs: SOAK_JOBS, ...(before.started && { restartOf: before.start!.id }) },
    });
    io.out(`bulig: the soak started at ${e.at} (event ${e.id}). The bar: ${SOAK_DAYS} days and ${SOAK_JOBS} jobs with zero false warnings. See bulig gates status.`);
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
  io.out(`false     ${r.bar.falseWarnings} warning${r.bar.falseWarnings === 1 ? '' : 's'} marked false`);
  io.out('');
  io.out(`${pad('gate', 16)}${pad('clean', 8)}warned`);
  for (const g of r.gates) io.out(`${pad(g.gate, 16)}${pad(String(g.clean), 8)}${g.warned}`);
  if (r.jobs.length) {
    io.out('');
    io.out(`${pad('job', 10)}${pad('status', 18)}${pad('gates', 7)}${pad('warned', 8)}title (repo)`);
    for (const j of r.jobs) {
      io.out(`${pad(j.jobId.slice(0, 8), 10)}${pad(j.job?.status ?? '-', 18)}${pad(String(j.verdicts), 7)}${pad(String(j.warned), 8)}${j.job ? `${clipText(oneLine(j.job.title), 40)} (${j.job.repo})` : '-'}`);
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
  await deps.readStore(io, async (store) => {
    const r = buildReport(await store.eventsAfter(0), [], nowOf(io));
    if (!r.started) throw new deps.UserError('the soak has not started, so there is no warning to mark. Start it with: bulig gates soak start');
    const found = findWarning(r, idArg);
    if (!found.ok) throw new deps.UserError(found.why);
    const w = found.warning;
    if (w.falseReason !== undefined) throw new deps.UserError(`warning ${w.eventId} is already marked false: ${oneLine(w.falseReason)}`);
    const e = await store.appendEvent({
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
  const backup = setEnforce(path, io, deps);
  for (const note of inactive(config)) io.out(`bulig: note: ${note}`);
  io.out(`bulig: gate-evidence and gate-promise are now "enforce" in ${path} (the old file is ${backup}).`);
  io.out('bulig: a running serve does not see this. Restart it to pick it up.');
  return 0;
}

/** A gate that is switched off or left out of `enabled` stays off whatever its mode says. Say so, so "enforce" is not taken for protection. */
function inactive(config: BuligConfig): string[] {
  return GATE_PLUGINS.filter((g) => !config.enabled.includes(g) || config.pluginConfig[g]?.enabled === false).map(
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


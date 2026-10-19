import type { BuligEvent, Job } from '@bulig/plugin-sdk';

/**
 * Reading the soak out of the event log. Nothing here touches a store: it takes the events and the jobs and says what they add up to.
 *
 * The two gates already leave their verdicts in the log:
 *   gate-evidence  stage.checked   with `checked: true`        and the unverified lines in `unverified`
 *   gate-promise   stage.screened  with `promiseChecked: true` and the unfulfilled lines in `promises`
 *   either gate    stage.failed    with `blocked: true`        (enforce mode: the warning that stopped a stage)
 * A gate that is switched off passes results through with `checked: false` or `promiseChecked: false`. That is not a verdict.
 * The operator adds two events of his own: `gates.soak.started` (the clock) and `gates.warning.false` (a warning he judged wrong).
 */

/** Days the gates must run in warn mode before they may be switched to enforce. */
export const SOAK_DAYS = 7;
/** Jobs that must have reached a gate in that time. */
export const SOAK_JOBS = 10;

export const SOAK_STARTED = 'gates.soak.started';
export const WARNING_FALSE = 'gates.warning.false';

const DAY_MS = 86_400_000;

export type GateName = 'gate-evidence' | 'gate-promise';
export const GATES: readonly GateName[] = ['gate-evidence', 'gate-promise'];

export interface Verdict {
  eventId: string;
  seq: number;
  at: string;
  jobId: string;
  stage: string;
  gate: GateName;
  /** The gate had something to say: an unverified claim or an unfulfilled promise. */
  warned: boolean;
  /** Enforce mode stopped the stage over it. */
  blocked: boolean;
  lines: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The verdict a gate event carries, or undefined if the event is not one. The source must be the gate itself: another plugin's look-alike does not count. */
export function verdictOf(e: BuligEvent): Verdict | undefined {
  if (e.seq === undefined || !e.jobId) return undefined;
  const p = asRecord(e.payload);
  const base = { eventId: e.id, seq: e.seq, at: e.at, jobId: e.jobId, stage: String(p.stage ?? '') };
  if (e.type === 'stage.checked' && e.source === 'gate-evidence' && p.checked === true) {
    const lines = strings(p.unverified);
    return { ...base, gate: 'gate-evidence', warned: lines.length > 0, blocked: false, lines };
  }
  if (e.type === 'stage.screened' && e.source === 'gate-promise' && p.promiseChecked === true) {
    const lines = strings(p.promises);
    return { ...base, gate: 'gate-promise', warned: lines.length > 0, blocked: false, lines };
  }
  if (e.type === 'stage.failed' && (e.source === 'gate-evidence' || e.source === 'gate-promise') && p.blocked === true) {
    const lines = strings(e.source === 'gate-evidence' ? p.unverified : p.promises);
    return { ...base, gate: e.source, warned: true, blocked: true, lines: lines.length ? lines : [String(p.error ?? 'blocked')] };
  }
  return undefined;
}

/** The newest soak start in the log. A restart writes a new one and the newest wins. */
export function soakStart(events: readonly BuligEvent[]): BuligEvent | undefined {
  return events.filter((e) => e.type === SOAK_STARTED && e.seq !== undefined).sort((a, b) => a.seq! - b.seq!).at(-1);
}

export interface Bar {
  met: boolean;
  /** Days still to run, rounded up to a tenth. 0 when the time is up. */
  moreDays: number;
  moreJobs: number;
  falseWarnings: number;
  /** One line: "bar met" or "bar not met: needs 3.8 more days / 6 more jobs / 1 false warning found". */
  line: string;
}

export function checkBar(daysElapsed: number, jobs: number, falseWarnings: number): Bar {
  const moreDays = Math.max(0, Math.ceil((SOAK_DAYS - daysElapsed) * 10) / 10);
  const moreJobs = Math.max(0, SOAK_JOBS - jobs);
  const met = moreDays === 0 && moreJobs === 0 && falseWarnings === 0;
  const parts = [
    moreDays > 0 && `needs ${moreDays} more day${moreDays === 1 ? '' : 's'}`,
    moreJobs > 0 && `${moreJobs} more job${moreJobs === 1 ? '' : 's'}`,
    falseWarnings > 0 && `${falseWarnings} false warning${falseWarnings === 1 ? '' : 's'} found`,
  ].filter(Boolean);
  return { met, moreDays, moreJobs, falseWarnings, line: met ? 'bar met' : `bar not met: ${parts.join(' / ')}` };
}

export interface JobRow {
  job: Job | undefined;
  jobId: string;
  verdicts: number;
  warned: number;
}

export interface GateRow {
  gate: GateName;
  clean: number;
  warned: number;
}

export interface Report {
  started: boolean;
  start?: BuligEvent;
  daysElapsed: number;
  jobs: JobRow[];
  gates: GateRow[];
  /** Every warning since the start, oldest first, with the reason it was marked false (if it was). */
  warnings: Array<Verdict & { falseReason?: string }>;
  bar: Bar;
}

/** What `events` and `jobs` say about the soak at time `now`. Only events after the newest start count. */
export function buildReport(events: readonly BuligEvent[], jobs: readonly Job[], now: Date): Report {
  const start = soakStart(events);
  if (!start) {
    const bar = checkBar(0, 0, 0);
    return { started: false, daysElapsed: 0, jobs: [], gates: GATES.map((gate) => ({ gate, clean: 0, warned: 0 })), warnings: [], bar: { ...bar, line: `${bar.line} (the soak has not started: run bulig gates soak start)` } };
  }
  const since = events.filter((e) => e.seq !== undefined && e.seq > start.seq!).sort((a, b) => a.seq! - b.seq!);
  const verdicts = since.map(verdictOf).filter((v): v is Verdict => v !== undefined);
  const warned = new Map(verdicts.filter((v) => v.warned).map((v) => [v.eventId, v]));
  // A mark counts only if it points at a warning inside the window; the first reason given for a warning is the one shown.
  const marks = new Map<string, string>();
  for (const e of since) {
    if (e.type !== WARNING_FALSE) continue;
    const p = asRecord(e.payload);
    if (typeof p.target === 'string' && warned.has(p.target) && !marks.has(p.target)) marks.set(p.target, String(p.reason ?? ''));
  }
  const byJob = new Map<string, JobRow>();
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  for (const v of verdicts) {
    const row = byJob.get(v.jobId) ?? { job: jobById.get(v.jobId), jobId: v.jobId, verdicts: 0, warned: 0 };
    row.verdicts += 1;
    if (v.warned) row.warned += 1;
    byJob.set(v.jobId, row);
  }
  const daysElapsed = Math.max(0, (now.getTime() - Date.parse(start.at)) / DAY_MS);
  return {
    started: true,
    start,
    daysElapsed,
    jobs: [...byJob.values()],
    gates: GATES.map((gate) => {
      const mine = verdicts.filter((v) => v.gate === gate);
      return { gate, clean: mine.filter((v) => !v.warned).length, warned: mine.filter((v) => v.warned).length };
    }),
    warnings: [...warned.values()].map((v) => (marks.has(v.eventId) ? { ...v, falseReason: marks.get(v.eventId)! } : v)),
    bar: checkBar(daysElapsed, byJob.size, marks.size),
  };
}

/** The warning a `mark-false` id names: a full event id, or a start of one that only one warning shares. */
export function findWarning(report: Report, idArg: string): { ok: true; warning: Report['warnings'][number] } | { ok: false; why: string } {
  const hits = report.warnings.filter((w) => w.eventId === idArg || w.eventId.startsWith(idArg));
  const exact = hits.find((w) => w.eventId === idArg);
  if (exact) return { ok: true, warning: exact };
  if (hits.length === 1) return { ok: true, warning: hits[0]! };
  if (hits.length > 1) return { ok: false, why: `"${idArg}" starts ${hits.length} warnings; type more of the id` };
  return { ok: false, why: `${idArg} is not a gate warning since the soak started. See the warnings with: bulig gates status` };
}

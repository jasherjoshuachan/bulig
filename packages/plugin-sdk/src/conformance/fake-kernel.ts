import { realClearTimeout, realSetTimeout } from './effects.ts';
import {
  CapabilityDeniedError,
  DEFAULT_EVENT_CAPABILITIES,
  JOBS_WRITE,
  TERMINAL_STATUSES,
  UndeclaredEventError,
  UndeclaredSubscriptionError,
  isApprovalStage,
  matchesPattern,
  patternCovered,
  type BuligEvent,
  type Job,
  type JobStatus,
  type JobsApi,
  type Manifest,
  type PluginContext,
  type Stage,
} from '../index.ts';

/** The rules the suite checks. Each one is a separate test and has a negative test in the SDK's own suite. */
export type Rule = 'manifest' | 'subscribes' | 'emits' | 'needs' | 'effects' | 'lifecycle' | 'config' | 'state';

export interface Finding {
  rule: Rule;
  message: string;
}

/** What the plugin did while it ran in the fake kernel. */
export interface Recording {
  findings: Finding[];
  notes: string[];
  subscribed: Set<string>;
  emitted: Set<string>;
  /** Capabilities the plugin asked about with require() or can(), or used through the job API. */
  usedCaps: Set<string>;
}

export const newRecording = (): Recording => ({ findings: [], notes: [], subscribed: new Set(), emitted: new Set(), usedCaps: new Set() });

export interface SeedJob {
  repo: string;
  title: string;
  body?: string;
  status?: JobStatus;
  stages?: Array<{ name: string; status?: Stage['status']; output?: unknown }>;
}

/** Ids in the fake store look like the real ones (UUIDs): the first job is fakeJobId(1), the second fakeJobId(2). */
export const fakeJobId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const jsonOk = (v: unknown): boolean => {
  try {
    return v === undefined || JSON.stringify(v) !== undefined;
  } catch {
    return false;
  }
};

/** An in-memory job API with the same permission rules as the kernel. Breaking one is recorded as a finding. */
function fakeJobs(manifest: Manifest, caps: ReadonlySet<string>, rec: Recording): JobsApi & { seed(j: SeedJob): Job } {
  const jobs = new Map<string, Job>();
  const stages: Stage[] = [];
  const now = () => new Date().toISOString();
  const need = (what: string) => {
    rec.usedCaps.add(JOBS_WRITE);
    if (!caps.has(JOBS_WRITE)) {
      rec.findings.push({ rule: 'needs', message: `used "${JOBS_WRITE}" to ${what} without declaring it in needs` });
      throw new CapabilityDeniedError(`Plugin "${manifest.name}" was denied "${JOBS_WRITE}" (needed to ${what})`);
    }
  };
  const mustGet = (id: string): Job => {
    const j = jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  };
  const api: JobsApi & { seed(j: SeedJob): Job } = {
    create(input) {
      const t = now();
      const job: Job = { id: fakeJobId(jobs.size + 1), repo: input.repo, title: input.title, body: input.body ?? '', status: 'queued', createdAt: t, updatedAt: t };
      jobs.set(job.id, job);
      return { ...job };
    },
    get: (id) => (jobs.has(id) ? { ...mustGet(id) } : undefined),
    list: (filter) => [...jobs.values()].filter((j) => !filter?.status || j.status === filter.status).map((j) => ({ ...j })),
    setStatus(id, status) {
      const job = mustGet(id);
      if (TERMINAL_STATUSES.includes(job.status) && job.status !== status) {
        throw new CapabilityDeniedError(`Plugin "${manifest.name}" may not move a job out of ${job.status}: ${job.status} is final`);
      }
      if (TERMINAL_STATUSES.includes(status)) need(`set a job ${status}`);
      else if (job.status === 'awaiting_approval') need('move a job out of awaiting_approval');
      job.status = status;
      job.updatedAt = now();
      return { ...job };
    },
    stages: (jobId) => stages.filter((s) => s.jobId === jobId).map((s) => ({ ...s })),
    startStage(jobId, name) {
      mustGet(jobId);
      if (isApprovalStage(name)) need(`open the "${name}" stage`);
      const attempt = stages.filter((s) => s.jobId === jobId && s.name === name).length + 1;
      const stage: Stage = { id: `00000000-0000-4000-9000-${String(stages.length + 1).padStart(12, '0')}`, jobId, name, status: 'running', attempt, startedAt: now(), endedAt: null, output: null };
      stages.push(stage);
      return { ...stage };
    },
    finishStage(stageId, status, output) {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) throw new Error(`no stage ${stageId}`);
      if (isApprovalStage(stage.name)) need(`finish the "${stage.name}" stage`);
      stage.status = status;
      stage.endedAt = now();
      stage.output = output ?? null;
      return { ...stage };
    },
    seed(j) {
      const job = api.create({ repo: j.repo, title: j.title, ...(j.body !== undefined && { body: j.body }) });
      const raw = mustGet(job.id);
      raw.status = j.status ?? 'queued';
      for (const s of j.stages ?? []) {
        const st: Stage = { id: `00000000-0000-4000-9000-${String(stages.length + 1).padStart(12, '0')}`, jobId: job.id, name: s.name, status: s.status ?? 'passed', attempt: 1, startedAt: now(), endedAt: now(), output: s.output ?? null };
        stages.push(st);
      }
      return { ...raw };
    },
  };
  return api;
}

/** The kernel, minus SQLite: one plugin, in memory, strict about everything its manifest does not say. */
export function createFakeKernel(manifest: Manifest, config: Record<string, unknown>, rec: Recording) {
  // Everything the plugin declared is granted, so a failure here is the plugin's own doing, not a missing grant.
  const caps = new Set(manifest.needs);
  const subs: Array<{ pattern: string; handler: (e: BuligEvent) => void | Promise<void> }> = [];
  const state = new Map<string, unknown>();
  const jobs = fakeJobs(manifest, caps, rec);
  let seq = 0;

  const ctx: PluginContext = {
    on(pattern, handler) {
      rec.subscribed.add(pattern);
      if (!patternCovered(manifest.subscribes, pattern)) {
        rec.findings.push({ rule: 'subscribes', message: `subscribed to "${pattern}" but did not declare it in subscribes` });
        throw new UndeclaredSubscriptionError(`Plugin "${manifest.name}" did not declare a subscription to "${pattern}"`);
      }
      subs.push({ pattern, handler });
    },
    emit(type, payload, jobId) {
      if (!manifest.emits.includes(type)) {
        rec.findings.push({ rule: 'emits', message: `emitted "${type}" but did not declare it in emits` });
        throw new UndeclaredEventError(`Plugin "${manifest.name}" did not declare emitting "${type}"`);
      }
      const needed = Object.hasOwn(DEFAULT_EVENT_CAPABILITIES, type) ? DEFAULT_EVENT_CAPABILITIES[type] : undefined;
      if (needed) rec.usedCaps.add(needed);
      if (needed && !caps.has(needed)) {
        rec.findings.push({ rule: 'needs', message: `emitted "${type}", which needs "${needed}", without declaring it in needs` });
        throw new CapabilityDeniedError(`Plugin "${manifest.name}" was denied "${needed}" (needed to emit "${type}")`);
      }
      if (!jsonOk(payload)) rec.findings.push({ rule: 'emits', message: `the payload of "${type}" is not JSON: events are stored as JSON` });
      rec.emitted.add(type);
      emitted.push({ type, payload, jobId });
    },
    can(cap) {
      rec.usedCaps.add(cap);
      return caps.has(cap);
    },
    require(cap) {
      rec.usedCaps.add(cap);
      if (!caps.has(cap)) {
        rec.findings.push({ rule: 'needs', message: `required "${cap}" but did not declare it in needs` });
        throw new CapabilityDeniedError(`Plugin "${manifest.name}" was denied "${cap}" (not declared in needs)`);
      }
    },
    jobs,
    state: {
      get: (key) => (state.has(key) ? (JSON.parse(JSON.stringify(state.get(key))) as never) : undefined),
      set(key, value) {
        if (!jsonOk(value) || value === undefined) rec.findings.push({ rule: 'state', message: `state.set("${key}") was given a value that is not JSON` });
        else state.set(key, JSON.parse(JSON.stringify(value)));
      },
    },
    log: {
      debug() {},
      info() {},
      warn: (m) => void rec.notes.push(`log.warn: ${m}`),
      error: (m) => void rec.notes.push(`log.error: ${m}`),
    },
    config,
  };

  const emitted: Array<{ type: string; payload: unknown; jobId: string | undefined }> = [];

  /** Hand an event to the plugin's matching subscriptions, as the bus would, and wait (a little) for async work. */
  async function deliver(input: { type: string; payload?: unknown; jobId?: string; source?: string }, waitMs = 3000): Promise<void> {
    const event: BuligEvent = { id: `evt-${++seq}`, seq, type: input.type, source: input.source ?? 'conformance', payload: input.payload ?? null, at: new Date().toISOString(), ...(input.jobId !== undefined && { jobId: input.jobId }) };
    for (const sub of subs) {
      if (!matchesPattern(sub.pattern, event.type)) continue;
      let timer: NodeJS.Timeout | undefined;
      try {
        const run = Promise.resolve(sub.handler(event));
        const late = new Promise<'late'>((r) => (timer = realSetTimeout(() => r('late'), waitMs)));
        if ((await Promise.race([run.then(() => 'done' as const), late])) === 'late') {
          rec.notes.push(`the handler for "${event.type}" was still running after ${waitMs} ms`);
        }
      } catch (err) {
        // A handler that throws becomes a plugin.error in the real kernel. Not a rule break by itself.
        rec.notes.push(`the handler for "${event.type}" threw: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        realClearTimeout(timer);
      }
    }
  }

  return { ctx, deliver, jobs, emitted };
}

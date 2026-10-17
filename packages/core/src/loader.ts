import {
  CapabilityDeniedError,
  DuplicatePluginError,
  ManifestError,
  validateManifest,
  SUPPORTED_SDK_MAJORS,
  SdkVersionMismatchError,
  UndeclaredEventError,
  UndeclaredSubscriptionError,
  isReservedEvent,
  patternCovered,
  type EventHandler,
  type JobsApi,
  type Logger,
  type Manifest,
  type Plugin,
  type PluginContext,
  type StateApi,
} from '@bulig/plugin-sdk';
import type { Bus } from './bus.ts';
import { JOBS_WRITE, TERMINAL_STATUSES, effectiveCapabilities, isApprovalStage } from './capabilities.ts';

/**
 * What a task on the kernel's store queue sees of the jobs: the same calls as the plugin API, run directly on the task.
 * Each write announces itself (job.created, job.status) inside the same task, so state and event are one step.
 */
export interface JobsTx extends JobsApi {
  /** The name of a stage by id, or undefined if there is none. */
  stageName(stageId: string): Promise<string | undefined>;
}

/**
 * The kernel's own job object. It is the plugin API, plus `atomic`: run a function as one task on the store queue, so
 * nothing else reads or writes between its first call and its last. Plugins never see this object, only the gated view.
 */
export interface KernelJobs extends JobsApi {
  atomic<T>(fn: (tx: JobsTx) => Promise<T>): Promise<T>;
}

export interface LoadOptions {
  plugins: Plugin[];
  /** Names of plugins to run. Anything else is skipped. */
  enabled: string[];
  grants: Record<string, string[]>;
  pluginConfig: Record<string, Record<string, unknown>>;
  bus: Bus;
  jobs: KernelJobs;
  /** Reads and writes one plugin's state. The kernel passes the store. */
  state: { get(plugin: string, key: string): Promise<unknown>; set(plugin: string, key: string, value: unknown): Promise<void> };
  logger: Logger;
}

export interface LoadedPlugin {
  plugin: Plugin;
  manifest: Manifest;
}

export function parseManifest(plugin: Plugin): Manifest {
  const parsed = validateManifest(plugin.manifest);
  const name = (plugin.manifest as { name?: unknown } | undefined)?.name;
  if (!parsed.ok) {
    const issues = parsed.issues.map((i) => `${i.path || 'manifest'}: ${i.message}`).join('; ');
    throw new ManifestError(`Invalid manifest for plugin "${String(name)}": ${issues}`);
  }
  const m = parsed.manifest;
  if (!SUPPORTED_SDK_MAJORS.includes(m.sdk)) {
    throw new SdkVersionMismatchError(`Plugin "${m.name}" targets sdk ${m.sdk}, this kernel runs sdk ${SUPPORTED_SDK_MAJORS.join(' and ')}`);
  }
  const reserved = m.emits.find(isReservedEvent);
  if (reserved) throw new ManifestError(`Plugin "${m.name}" may not emit kernel event "${reserved}"`);
  return m;
}

/** Validate and select the plugins to run. Does not call register(). */
export function selectPlugins(plugins: Plugin[], enabled: string[]): LoadedPlugin[] {
  const seen = new Set<string>();
  for (const p of plugins) {
    const name = (p.manifest as { name?: string } | undefined)?.name;
    if (name === undefined) continue;
    if (seen.has(name)) throw new DuplicatePluginError(`Duplicate plugin name: ${name}`);
    seen.add(name);
  }
  return plugins
    .filter((p) => enabled.includes((p.manifest as { name?: string }).name ?? ''))
    .map((plugin) => ({ plugin, manifest: parseManifest(plugin) }));
}

/**
 * The job API one plugin gets. Reading and ordinary stage work are open. Writes that decide an outcome need
 * jobs.write: opening or closing an approval stage, ending a job, or moving a job out of awaiting_approval.
 * A plugin without it cannot approve, cancel or finish work, even though it holds the API.
 *
 * A check that has to read before it decides runs together with its write as one task on the kernel's store queue
 * (`atomic`), so no other write can land between the read and the write. A check that needs no read is made before
 * anything is queued. A denied call rejects and writes nothing.
 */
function gateJobs(name: string, caps: ReadonlySet<string>, jobs: KernelJobs): JobsApi {
  const need = (what: string) => {
    if (!caps.has(JOBS_WRITE)) throw new CapabilityDeniedError(`Plugin "${name}" was denied "${JOBS_WRITE}" (needed to ${what})`);
  };
  return {
    create: (input) => jobs.create(input),
    get: (id) => jobs.get(id),
    list: (filter) => jobs.list(filter),
    stages: (jobId) => jobs.stages(jobId),
    setStatus: (id, status) =>
      jobs.atomic(async (tx) => {
        const current = (await tx.get(id))?.status;
        // Terminal is final: no plugin may reopen a done, failed or cancelled job, because that undoes a person's cancel.
        if (current !== undefined && TERMINAL_STATUSES.includes(current) && current !== status) {
          throw new CapabilityDeniedError(`Plugin "${name}" may not move a job out of ${current}: ${current} is final`);
        }
        if (TERMINAL_STATUSES.includes(status)) need(`set a job ${status}`);
        else if (current === 'awaiting_approval') need('move a job out of awaiting_approval');
        return tx.setStatus(id, status);
      }),
    async startStage(jobId, stage) {
      if (isApprovalStage(stage)) need(`open the "${stage}" stage`);
      return jobs.startStage(jobId, stage);
    },
    finishStage: (stageId, status, output) =>
      jobs.atomic(async (tx) => {
        const stage = await tx.stageName(stageId);
        if (isApprovalStage(stage)) need(`finish the "${stage}" stage`);
        return tx.finishStage(stageId, status, output);
      }),
  };
}

/** A context that can only do what this one manifest declares. */
export function buildContext(manifest: Manifest, opts: Omit<LoadOptions, 'plugins' | 'enabled'>): PluginContext {
  const caps = effectiveCapabilities(manifest, opts.grants);
  const name = manifest.name;
  return {
    on(pattern: string, handler: EventHandler) {
      if (!patternCovered(manifest.subscribes, pattern)) {
        throw new UndeclaredSubscriptionError(`Plugin "${name}" did not declare a subscription to "${pattern}"`);
      }
      opts.bus.subscribe(name, pattern, handler);
    },
    emit(type, payload, jobId) {
      if (!manifest.emits.includes(type)) {
        throw new UndeclaredEventError(`Plugin "${name}" did not declare emitting "${type}"`);
      }
      opts.bus.emitFrom(name, caps, { type, payload, jobId });
    },
    can: (cap) => caps.has(cap),
    require(cap) {
      if (!caps.has(cap)) {
        const why = manifest.needs.includes(cap) ? 'declared but not granted' : 'not declared in needs';
        throw new CapabilityDeniedError(`Plugin "${name}" was denied "${cap}" (${why})`);
      }
    },
    jobs: gateJobs(name, caps, opts.jobs),
    state: {
      get: async (key: string) => opts.state.get(name, key),
      set: async (key: string, value: unknown) => {
        await opts.state.set(name, key, value);
      },
    } as StateApi,
    log: opts.logger,
    config: opts.pluginConfig[name] ?? {},
  };
}

import type { Job, JobsApi, Logger, Plugin } from '@bulig/plugin-sdk';
import { Bus } from './bus.ts';
import { DEFAULT_EVENT_CAPABILITIES } from './capabilities.ts';
import { buildContext, selectPlugins, type LoadedPlugin } from './loader.ts';
import { Store } from './store.ts';

export interface KernelOptions {
  dbPath: string;
  plugins: Plugin[];
  enabled: string[];
  grants?: Record<string, string[]>;
  pluginConfig?: Record<string, Record<string, unknown>>;
  /** Event type to the capability needed to emit it. Merged over the defaults; a later entry wins. */
  eventCapabilities?: Record<string, string>;
  logger?: Logger;
}

const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn: (m, meta) => console.warn(m, meta ?? ''),
  error: (m, meta) => console.error(m, meta ?? ''),
};

export function createKernel(options: KernelOptions) {
  const store = new Store(options.dbPath);
  const bus = new Bus(store, { ...DEFAULT_EVENT_CAPABILITIES, ...options.eventCapabilities });
  const logger = options.logger ?? defaultLogger;

  // Job changes go through here so the kernel always announces them.
  const jobs: JobsApi = {
    create(input) {
      const job = store.createJob(input);
      bus.emit({ type: 'job.created', source: 'kernel', jobId: job.id, payload: job });
      return job;
    },
    get: (id) => store.getJob(id),
    list: (filter) => store.listJobs(filter),
    setStatus(id, status): Job {
      const before = store.getJob(id);
      const job = store.setJobStatus(id, status);
      bus.emit({ type: 'job.status', source: 'kernel', jobId: id, payload: { from: before?.status, to: status } });
      return job;
    },
    stages: (jobId) => store.listStages(jobId),
    startStage: (jobId, name) => store.startStage(jobId, name),
    finishStage: (id, status, output) => store.finishStage(id, status, output),
  };

  let loaded: LoadedPlugin[] = [];

  return {
    jobs,
    bus,
    history: (jobId: string) => bus.history(jobId),

    async start(): Promise<void> {
      // Validate everything before any plugin runs.
      loaded = selectPlugins(options.plugins, options.enabled);
      const base = {
        grants: options.grants ?? {},
        pluginConfig: options.pluginConfig ?? {},
        bus,
        jobs,
        state: { get: (p: string, k: string) => store.getState(p, k), set: (p: string, k: string, v: unknown) => store.setState(p, k, v) },
        logger,
      };
      for (const { plugin, manifest } of loaded) {
        await plugin.register(buildContext(manifest, base));
      }
      bus.emit({
        type: 'kernel.started',
        source: 'kernel',
        payload: { plugins: loaded.map((l) => l.manifest.name) },
      });
    },

    async stop(): Promise<void> {
      for (const { plugin, manifest } of [...loaded].reverse()) {
        try {
          await plugin.stop?.();
        } catch (err) {
          logger.error(`Plugin "${manifest.name}" failed to stop`, err);
        }
      }
      // Let handlers that are still working (a git command, a killed Claude run) finish before the log closes.
      await bus.idle();
      store.close();
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

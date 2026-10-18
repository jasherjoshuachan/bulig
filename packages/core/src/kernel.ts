import { DEPRECATED_SDK_MAJORS, type BuligEvent, type Logger, type Plugin } from '@bulig/plugin-sdk';
import { Bus } from './bus.ts';
import { DEFAULT_EVENT_CAPABILITIES } from './capabilities.ts';
import { buildContext, selectPlugins, type JobsTx, type KernelJobs, type LoadedPlugin } from './loader.ts';
import { StoreBrokenError, StoreQueue, type QueueTx } from './queue.ts';
import { SqliteStore } from './sqlite-store.ts';
import type { Store } from './store.ts';

export interface KernelOptions {
  /** Where the SQLite file lives. Used when no `store` is given. */
  dbPath?: string;
  /** A store to use instead of opening SQLite at `dbPath`: another adapter, or one wrapped for a test. The kernel closes it on stop. */
  store?: Store;
  /** How long one task on the store queue may take before it is given up on and the queue moves on. Default 30000. */
  storeTimeoutMs?: number;
  /**
   * How long a task may be stuck inside one store call before the kernel gives up on the record: it stops writing,
   * refuses every later store call, and logs one error. Default 120000, never less than storeTimeoutMs.
   */
  storeBrokenMs?: number;
  /** How long stop() waits for the store's own close() before it stops waiting and says so. Default 10000. */
  storeCloseMs?: number;
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
  const store = options.store ?? (options.dbPath !== undefined ? new SqliteStore(options.dbPath) : undefined);
  if (!store) throw new Error('createKernel needs a dbPath or a store');
  const logger = options.logger ?? defaultLogger;
  // Every store call in the kernel goes through this one queue (ADR 0001: the kernel is the only writer, one at a time).
  const queue = new StoreQueue(store, {
    timeoutMs: options.storeTimeoutMs ?? 30_000,
    brokenMs: options.storeBrokenMs ?? 120_000,
    closeMs: options.storeCloseMs ?? 10_000,
    onCloseCutShort: (ms) => logger.error(`The store did not close within ${ms} ms, so stop() stopped waiting for it. Its connection may still be open.`),
    onBroken: (err) => logger.error(`${err.message} Nothing more will be written or delivered until it is restarted.`),
  });
  const bus = new Bus(queue, { ...DEFAULT_EVENT_CAPABILITIES, ...options.eventCapabilities }, (err, input) => {
    // Once the queue is broken one error already said so. Every event after it would only repeat it.
    if (err instanceof StoreBrokenError) return;
    logger.error(`Could not write event "${input.type}" to the log: it was not written and not delivered`, err);
  });

  // The job calls as they run on one task of the queue. A change and the event that announces it are written in the same task.
  const inTask = (tx: QueueTx): JobsTx => ({
    async create(input) {
      const job = await tx.createJob(input);
      await bus.record(tx, { type: 'job.created', source: 'kernel', jobId: job.id, payload: job });
      return job;
    },
    get: (id) => tx.getJob(id),
    list: (filter) => tx.listJobs(filter),
    async setStatus(id, status) {
      const before = await tx.getJob(id);
      const job = await tx.setJobStatus(id, status);
      await bus.record(tx, { type: 'job.status', source: 'kernel', jobId: id, payload: { from: before?.status, to: status } });
      return job;
    },
    stages: (jobId) => tx.listStages(jobId),
    startStage: (jobId, name) => tx.startStage(jobId, name),
    finishStage: (id, status, output) => tx.finishStage(id, status, output),
    stageName: async (id) => (await tx.getStage(id))?.name,
  });
  const atomic: KernelJobs['atomic'] = (fn) => queue.run('jobs', (tx) => fn(inTask(tx)));
  const jobs: KernelJobs = {
    atomic,
    create: (input) => atomic((t) => t.create(input)),
    get: (id) => atomic((t) => t.get(id)),
    list: (filter) => atomic((t) => t.list(filter)),
    setStatus: (id, status) => atomic((t) => t.setStatus(id, status)),
    stages: (jobId) => atomic((t) => t.stages(jobId)),
    startStage: (jobId, name) => atomic((t) => t.startStage(jobId, name)),
    finishStage: (id, status, output) => atomic((t) => t.finishStage(id, status, output)),
  };

  let loaded: LoadedPlugin[] = [];

  return {
    jobs,
    bus,
    history: (jobId: string): Promise<BuligEvent[]> => bus.history(jobId),

    async start(): Promise<void> {
      // Validate everything before any plugin runs.
      loaded = selectPlugins(options.plugins, options.enabled);
      const base = {
        grants: options.grants ?? {},
        pluginConfig: options.pluginConfig ?? {},
        bus,
        jobs,
        state: {
          get: (p: string, k: string) => queue.run('state get', (tx) => tx.getState(p, k)),
          set: (p: string, k: string, v: unknown) => queue.run('state set', (tx) => tx.setState(p, k, v)),
        },
        logger,
      };
      for (const { manifest } of loaded) {
        if (DEPRECATED_SDK_MAJORS.includes(manifest.sdk)) {
          logger.warn(`Plugin "${manifest.name}" targets sdk ${manifest.sdk}, which is deprecated. Set "sdk" to "1" after it passes the conformance suite.`);
        }
      }
      for (const { plugin, manifest } of loaded) {
        await plugin.register(buildContext(manifest, base));
      }
      // Wait for it to be written and handed to the handlers, so start() returns with the plugins running, as it always did.
      await bus.emit({
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
      await queue.close();
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

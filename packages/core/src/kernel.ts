import { randomUUID } from 'node:crypto';
import { DEPRECATED_SDK_MAJORS, type BuligEvent, type Logger, type Plugin } from '@bulig/plugin-sdk';
import { Bus, ReplayDivergedError, ReplayedError, derivedEventId, type Cause } from './bus.ts';
import { DEFAULT_EVENT_CAPABILITIES } from './capabilities.ts';
import { buildContext, selectPlugins, type JobsTx, type KernelJobs, type LoadedPlugin } from './loader.ts';
import { StoreBrokenError, StoreQueue, type QueueTx } from './queue.ts';
import { SqliteStore } from './sqlite-store.ts';
import { LeaseHeldError, LeaseLostError, type Store } from './store.ts';

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
  /**
   * How long stop() waits for handlers and queued writes to finish before it stops waiting on them. Default 10000. The lease is
   * kept alive for the whole of stop(), so work that is still queued after this does not lose it.
   */
  stopWaitMs?: number;
  /** How long stop() waits for the store's own close() before it stops waiting and says so. Default 10000. */
  storeCloseMs?: number;
  /**
   * Who this kernel is to the executor lease (ADR 0010). Default: a new name every time a kernel is made, so a restarted kernel is
   * never mistaken for the one that died. Two kernels must not share a name: the lease would treat them as one.
   */
  leaseHolder?: string;
  /** How long the executor lease lasts after each renewal. Default 30000. */
  leaseTtlMs?: number;
  /** How often the lease is renewed. Default 10000. Must be well under leaseTtlMs. */
  leaseHeartbeatMs?: number;
  /**
   * How long start() waits for another kernel's lease to run out before it gives up. Default leaseTtlMs + 5000, which is long
   * enough for a lease that was just renewed by a kernel that then died.
   */
  leaseWaitMs?: number;
  /** Told once, when the lease is lost or cannot be renewed and the kernel has stopped writing. The process should exit and be restarted. */
  onLeaseLost?: (reason: string) => void;
  plugins: Plugin[];
  enabled: string[];
  grants?: Record<string, string[]>;
  pluginConfig?: Record<string, Record<string, unknown>>;
  /** Event type to the capability needed to emit it. Merged over the defaults; a later entry wins. */
  eventCapabilities?: Record<string, string>;
  logger?: Logger;
}

/** The plugin name the kernel keeps its own notes under in plugin state. A plugin name is lower-case kebab, so no plugin can have this one. */
const KERNEL_STATE = '$kernel';

const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn: (m, meta) => console.warn(m, meta ?? ''),
  error: (m, meta) => console.error(m, meta ?? ''),
};

export function createKernel(options: KernelOptions) {
  const store = options.store ?? (options.dbPath !== undefined ? new SqliteStore(options.dbPath) : undefined);
  if (!store) throw new Error('createKernel needs a dbPath or a store');
  const record: Store = store;
  const logger = options.logger ?? defaultLogger;
  // Every store call in the kernel goes through this one queue (ADR 0001: the kernel is the only writer, one at a time).
  const queue = new StoreQueue(store, {
    timeoutMs: options.storeTimeoutMs ?? 30_000,
    brokenMs: options.storeBrokenMs ?? 120_000,
    closeMs: options.storeCloseMs ?? 10_000,
    onCloseCutShort: (ms) => logger.error(`The store did not close within ${ms} ms, so stop() stopped waiting for it. Its connection may still be open.`),
    onBroken: (err) => {
      logger.error(`${err.message} Nothing more will be written or delivered until it is restarted.`);
      // A kernel that has given up on the record must not go on renewing the lease: it would keep a standby out for nothing.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      // A task that found the lease gone before the heartbeat did is a lost lease too: the process must stop, not just the queue.
      if (err.cause instanceof LeaseLostError) tellLeaseLost(err.cause.message);
    },
  });
  const bus = new Bus(queue, { ...DEFAULT_EVENT_CAPABILITIES, ...options.eventCapabilities }, (err, input) => {
    // Once the queue is broken one error already said so. Every event after it would only repeat it.
    if (err instanceof StoreBrokenError) return;
    // Not a failed write: a replayed run wanted different content in a place that was already filled. Said once, in plain words.
    if (err instanceof ReplayDivergedError) return void logger.error(err.message);
    logger.error(`Could not write event "${input.type}" to the log: it was not written and not delivered`, err);
  });

  // The job calls as they run on one task of the queue. A change and the event that announces it are written in the same task.
  // `cause` is the handler run that asked for the change, if one did: the event that announces it gets its id from there.
  // If that event is already in the log the whole task is a replay: it is rolled back and the call answers with the record as it is.
  const inTask = (tx: QueueTx, cause: Cause | undefined): JobsTx => ({
    async create(input) {
      const job = await tx.createJob(input);
      await bus.record(tx, { type: 'job.created', source: 'kernel', jobId: job.id, payload: job }, cause).catch((err: unknown) => {
        // The job the first run made, not the one this rolled-back task just made.
        if (err instanceof ReplayedError) err.result = err.existing.payload;
        throw err;
      });
      return job;
    },
    get: (id) => tx.getJob(id),
    list: (filter) => tx.listJobs(filter),
    async setStatus(id, status) {
      const before = await tx.getJob(id);
      const job = await tx.setJobStatus(id, status);
      await bus.record(tx, { type: 'job.status', source: 'kernel', jobId: id, payload: { from: before?.status, to: status } }, cause).catch((err: unknown) => {
        // The job as the first run left it (or a later change did), not the status this rolled-back task just set.
        if (err instanceof ReplayedError) err.result = before;
        throw err;
      });
      return job;
    },
    stages: (jobId) => tx.listStages(jobId),
    async startStage(jobId, name) {
      // Opening a stage writes no event, so a replay cannot find it by event id. A run that opens a stage leaves its key in the record,
      // in the same task as the stage, so a replay of that run finds the attempt it opened and hands it back instead of opening another.
      const key = cause ? `open:${derivedEventId(cause.eventId, cause.handler, cause.nextOpen++, `stage.open:${jobId}:${name}`)}` : undefined;
      if (key) {
        const known = await tx.getState(KERNEL_STATE, key);
        const stage = typeof known === 'string' ? await tx.getStage(known) : undefined;
        if (stage) {
          logger.info(`A replayed run asked to open "${name}" for job ${jobId}: attempt ${stage.attempt} is the one this run opened, so no new attempt was opened.`);
          return stage;
        }
      }
      const stage = await tx.startStage(jobId, name);
      if (key) await tx.setState(KERNEL_STATE, key, stage.id);
      return stage;
    },
    finishStage: (id, status, output) => tx.finishStage(id, status, output),
    stageName: async (id) => (await tx.getStage(id))?.name,
  });
  const atomic: KernelJobs['atomic'] = (fn) => {
    const cause = bus.currentCause();
    return queue.run('jobs', (tx) => fn(inTask(tx, cause))).catch((err: unknown) => {
      if (err instanceof ReplayedError && err.result !== undefined) return err.result as Awaited<ReturnType<typeof fn>>;
      throw err;
    });
  };
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

  // ----- the executor lease (ADR 0010) -----
  const holder = options.leaseHolder ?? `kernel-${randomUUID()}`;
  const ttlMs = options.leaseTtlMs ?? 30_000;
  const heartbeatMs = options.leaseHeartbeatMs ?? 10_000;
  const waitMs = options.leaseWaitMs ?? ttlMs + 5_000;
  if (heartbeatMs * 2 > ttlMs) throw new Error(`leaseHeartbeatMs (${heartbeatMs}) must be less than half of leaseTtlMs (${ttlMs}), so one missed beat does not lose the lease`);
  let generation: number | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let beating = false;

  /** Take the lease, waiting for an old one to run out if its holder died. */
  async function takeLease(): Promise<number> {
    const giveUpAt = Date.now() + waitMs;
    let told = false;
    for (;;) {
      try {
        return (await record.acquireLease(holder, ttlMs)).generation;
      } catch (err) {
        if (!(err instanceof LeaseHeldError) || Date.now() >= giveUpAt) throw err;
        if (!told) {
          told = true;
          logger.warn(`${err.message} Waiting for it to run out (at most ${waitMs} ms).`);
        }
        const until = err.expiresAt ? err.expiresAt.getTime() - Date.now() : 0;
        await new Promise((r) => setTimeout(r, Math.min(Math.max(until + 20, 50), 1_000)));
      }
    }
  }

  /** Set once stop() has begun, or a start has failed. From then on the process is on its way out, so a lost lease is logged but does not ask the owner to exit non-zero. */
  let ending = false;

  /** Tell the owner the lease is gone, once, whichever path (the heartbeat or a task's own check) noticed first. */
  let leaseLostTold = false;
  function tellLeaseLost(reason: string): void {
    if (leaseLostTold || ending) return;
    leaseLostTold = true;
    options.onLeaseLost?.(reason);
  }

  /** Stop writing at once: a kernel that cannot show it holds the lease must not change the record. */
  function loseLease(reason: string): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    // The queue's onBroken says it loudly, once, in the log.
    queue.breakNow(`The executor lease was lost: ${reason}.`, 'heartbeat', 'renewLease');
    tellLeaseLost(reason);
  }

  function startHeartbeat(gen: number): void {
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = true;
      // The renewal goes straight to the store, not through the queue: a long task must not be able to hold it up. A renewal
      // that has not come back by the next beat counts as failed, because the lease would soon run out behind it.
      let timer: NodeJS.Timeout | undefined;
      const stuck = new Promise<'stuck'>((resolve) => (timer = setTimeout(() => resolve('stuck'), heartbeatMs)));
      Promise.race([record.renewLease(holder, gen, ttlMs), stuck])
        .then(
          (ok) => {
            if (ok === 'stuck') loseLease(`the renewal did not come back within ${heartbeatMs} ms`);
            else if (!ok) loseLease('it ran out or another kernel took it, so the renewal was refused');
          },
          (err: unknown) => loseLease(`the renewal failed: ${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(() => {
          clearTimeout(timer);
          beating = false;
        });
    }, heartbeatMs);
    heartbeat.unref();
  }

  return {
    jobs,
    bus,
    history: (jobId: string): Promise<BuligEvent[]> => bus.history(jobId),

    async start(): Promise<void> {
      // A start after a failed one is a new attempt: the process is not on its way out any more.
      ending = false;
      // Validate everything before any plugin runs.
      loaded = selectPlugins(options.plugins, options.enabled);
      const shared = {
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
      // Before any plugin runs: nothing may be changed in the record until this kernel holds the lease.
      generation = await takeLease();
      queue.setFence({ holder, generation });
      startHeartbeat(generation);
      try {
        for (const { manifest } of loaded) {
          if (DEPRECATED_SDK_MAJORS.includes(manifest.sdk)) {
            logger.warn(`Plugin "${manifest.name}" targets sdk ${manifest.sdk}, which is deprecated. Set "sdk" to "1" after it passes the conformance suite.`);
          }
        }
        for (const { plugin, manifest } of loaded) {
          await plugin.register(buildContext(manifest, { ...shared, generation }));
        }
        // Wait for it to be written and handed to the handlers, so start() returns with the plugins running, as it always did.
        await bus.emit({
          type: 'kernel.started',
          source: 'kernel',
          payload: { plugins: loaded.map((l) => l.manifest.name) },
        });
      } catch (err) {
        ending = true;
        // A kernel that did not start must not go on holding the lease: the heartbeat would renew it until the process exits,
        // and the next kernel would wait for it for nothing.
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        await record.releaseLease(holder, generation).catch(() => {});
        throw err;
      }
    },

    async stop(): Promise<void> {
      ending = true;
      for (const { plugin, manifest } of [...loaded].reverse()) {
        try {
          await plugin.stop?.();
        } catch (err) {
          logger.error(`Plugin "${manifest.name}" failed to stop`, err);
        }
      }
      // Let handlers that are still working (a git command, a killed Claude run) finish before the log closes.
      await bus.idle(options.stopWaitMs ?? 10_000);
      // The heartbeat runs until the queue is empty: a task still queued after the wait above must find the lease alive.
      await queue.idle();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      // Hand the lease back once the queued work is done, so the next kernel need not wait for it to run out.
      if (generation !== undefined) await record.releaseLease(holder, generation).catch(() => {});
      await queue.close();
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

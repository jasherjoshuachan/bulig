import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';

/**
 * The Store port (ADR 0007): everything the kernel keeps, behind promises. An adapter implements it for one engine
 * (SqliteStore and PostgresStore). Nothing here names an engine: no file path, no row id, no sync call.
 *
 * Rules every adapter follows, and the shared contract suite in packages/core/test checks:
 * - A call that fails rejects. It never throws before it returns a promise.
 * - Calls made one after another from the same caller take effect in that order. The kernel makes sure of the rest
 *   by sending every call through one queue (see StoreQueue), so an adapter never has to cope with its caller racing itself.
 * - Lists come back oldest first: jobs and stages by creation, events by `seq`.
 * - `seq` only goes up, and an event is readable as soon as `appendEvent` resolves.
 * - Opening a store that already has data runs only the migrations it has not seen.
 * - Values that go in as JSON (event payloads, stage output, plugin state) must have a JSON form. A call with one that
 *   has none rejects and stores nothing.
 * - `transaction` is all or nothing. Calls made on the handle it passes commit together when the function resolves and
 *   are all undone when it rejects. An adapter holds one connection for the whole transaction. The caller does not
 *   start a second one, or use the store outside it, until it has finished (the kernel's queue sees to that).
 */
export interface Store {
  /** How many numbered migrations this store has applied. */
  schemaVersion(): Promise<number>;
  /** Release the engine. No call may follow. */
  close(): Promise<void>;

  /**
   * Stop whatever is in flight so that nothing can commit afterwards. The kernel calls it once, when it gives up on the
   * store because a call never came back. Optional: an adapter whose commit cannot be in flight when this is called (a
   * synchronous one) may leave it out or make it a no-op, and says why.
   */
  abort?(): void | Promise<void>;

  /** Run `fn` as one transaction. Resolves with its result after the commit; rejects, with nothing kept, if `fn` rejects or the commit fails. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;

  // ----- jobs -----
  createJob(input: { repo: string; title: string; body?: string }): Promise<Job>;
  getJob(id: string): Promise<Job | undefined>;
  listJobs(filter?: { status?: JobStatus }): Promise<Job[]>;
  /** Rejects if the job does not exist. */
  setJobStatus(id: string, status: JobStatus): Promise<Job>;

  // ----- stages -----
  /** Rejects if the job does not exist. `attempt` counts the earlier stages of the same name on that job, plus one. */
  startStage(jobId: string, name: string): Promise<Stage>;
  getStage(id: string): Promise<Stage | undefined>;
  listStages(jobId: string): Promise<Stage[]>;
  /** Rejects if the stage does not exist. */
  finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage>;

  // ----- plugin state -----
  getState(plugin: string, key: string): Promise<unknown>;
  /** Rejects if the value has no JSON form. */
  setState(plugin: string, key: string, value: unknown): Promise<void>;

  // ----- events -----
  appendEvent(e: { type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent>;
  /** Events with seq greater than `afterSeq`, oldest first. */
  eventsAfter(afterSeq?: number): Promise<BuligEvent[]>;
  eventsForJob(jobId: string): Promise<BuligEvent[]>;
}

/**
 * An adapter throws this from `transaction` when it can no longer say what the record holds: the rollback, or the
 * commit and then the rollback, failed, so a transaction may be left open. The kernel stops using the store at once.
 */
export class StoreFatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreFatalError';
  }
}

/** The calls available inside a transaction: the store without `close` and without starting another transaction. */
export type StoreTx = Omit<Store, 'close' | 'transaction'>;

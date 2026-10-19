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
 * - The executor lease (ADR 0010) is the exception to "nothing else uses the store during a transaction".
 *   `acquireLease`, `renewLease` and `releaseLease` may be called at any time, including while a transaction is open
 *   and waiting, and must not wait for it. A renewal stuck behind a slow task is how a healthy kernel loses its lease.
 *   An adapter with a second connection (Postgres) uses it. An adapter with one synchronous connection (SQLite) runs the
 *   statement at once and keeps it if the open transaction rolls back.
 * - Time for the lease is the database's own clock, never the caller's, so two kernels on two machines cannot disagree
 *   about whether a lease has run out.
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

  // ----- executor lease (ADR 0010) -----
  /**
   * Take the executor lease for `holder` for `ttlMs`, and return the new generation. Succeeds when there is no lease yet,
   * the last one has run out, or the caller already holds it. The generation goes up by one on every success. Rejects with
   * LeaseHeldError when another holder's lease is still running. May be called while a transaction is open.
   */
  acquireLease(holder: string, ttlMs: number): Promise<{ generation: number }>;
  /**
   * Push the lease's end to now + `ttlMs`. Resolves true if `holder` still holds `generation` and it had not run out; false
   * otherwise, and then nothing was changed. May be called while a transaction is open.
   */
  renewLease(holder: string, generation: number, ttlMs: number): Promise<boolean>;
  /** Give the lease back now so the next holder need not wait for it to run out. Does nothing if `holder` and `generation` are not the current ones. */
  releaseLease(holder: string, generation: number): Promise<void>;
  /**
   * Inside a transaction: reject with LeaseLostError unless `holder` holds `generation` and the lease has not run out. When
   * it resolves, the rest of the transaction is fenced with that generation: claims it takes are recorded under it, and an
   * adapter with row locks (Postgres) keeps a takeover from landing until the transaction ends.
   */
  assertLease(holder: string, generation: number): Promise<void>;

  /** Run `fn` as one transaction. Resolves with its result after the commit; rejects, with nothing kept, if `fn` rejects or the commit fails. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;

  // ----- jobs -----
  createJob(input: { repo: string; title: string; body?: string }): Promise<Job>;
  getJob(id: string): Promise<Job | undefined>;
  listJobs(filter?: { status?: JobStatus }): Promise<Job[]>;
  /** Rejects if the job does not exist. */
  setJobStatus(id: string, status: JobStatus): Promise<Job>;

  // ----- stages -----
  /**
   * Rejects if the job does not exist. `attempt` counts the earlier stages of the same name on that job, plus one.
   * Takes the stage's claim in the same transaction (ADR 0010): rejects with StageClaimedError if the claim is held by the
   * generation this transaction is fenced with, or a newer one. A claim held by an older generation belongs to a kernel that
   * lost its lease; it is released with the reason 'lease-lost', its stage is closed as failed and interrupted, and this
   * becomes the next attempt. A transaction that was never fenced counts as generation 0.
   */
  startStage(jobId: string, name: string): Promise<Stage>;
  getStage(id: string): Promise<Stage | undefined>;
  listStages(jobId: string): Promise<Stage[]>;
  /**
   * Rejects if the stage does not exist. Releases the stage's claim. Rejects with StageNotClaimedError if the claim of that
   * attempt was already released (it finished, or another kernel took it over): the attempt number is the fence. A newer
   * generation may finish an older generation's live claim, which is how a restarted kernel closes what the dead one left.
   * A stage from before claims existed has no claim and finishes as it did.
   */
  finishStage(id: string, status: Exclude<StageStatus, 'running'>, output?: unknown): Promise<Stage>;

  // ----- plugin state -----
  getState(plugin: string, key: string): Promise<unknown>;
  /** Rejects if the value has no JSON form. */
  setState(plugin: string, key: string, value: unknown): Promise<void>;

  // ----- events -----
  /** `id` is for an event whose id is known in advance. Rejects with DuplicateEventError if the log already has it. Without one, a new id is made. */
  appendEvent(e: { id?: string; type: string; jobId?: string; source: string; payload: unknown }): Promise<BuligEvent>;
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

/** Another holder has the executor lease and it has not run out. */
export class LeaseHeldError extends Error {
  constructor(
    public readonly holder: string,
    /** When the lease runs out, as the database's clock reads it. */
    public readonly expiresAt: Date | undefined,
  ) {
    super(`The executor lease is held by "${holder}"${expiresAt ? ` until ${expiresAt.toISOString()}` : ''}. Only one kernel may write to a record at a time.`);
    this.name = 'LeaseHeldError';
  }
}

/** The caller no longer holds the executor lease: it ran out, or another holder took it with a newer generation. Nothing was written. */
export class LeaseLostError extends Error {
  constructor(
    public readonly holder: string,
    public readonly generation: number,
    reason: string,
  ) {
    super(`"${holder}" no longer holds the executor lease at generation ${generation}: ${reason}`);
    this.name = 'LeaseLostError';
  }
}

/** The stage is already claimed by a live worker of this generation or a newer one. */
export class StageClaimedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly stage: string,
    public readonly attempt: number,
    public readonly generation: number,
  ) {
    super(`Stage "${stage}" of job ${jobId} is already claimed (attempt ${attempt}, generation ${generation}), so it was not started a second time`);
    this.name = 'StageClaimedError';
  }
}

/** A stage was finished by an attempt that no longer holds its claim. Nothing was written. */
export class StageNotClaimedError extends Error {
  constructor(
    public readonly stageId: string,
    reason: string,
  ) {
    super(`Stage ${stageId} was not finished: ${reason}`);
    this.name = 'StageNotClaimedError';
  }
}

/** An event with this id is already in the log. */
export class DuplicateEventError extends Error {
  constructor(
    public readonly eventId: string,
    /** The event the log already holds under this id, so a caller that treats the write as already done can hand it back. */
    public readonly existing?: BuligEvent,
  ) {
    super(`Event ${eventId} is already in the log, so it was not written a second time`);
    this.name = 'DuplicateEventError';
  }
}

/** The lease calls are not part of a transaction: the queue and the heartbeat call them on the store itself. */
export type StoreTx = Omit<Store, 'close' | 'transaction' | 'acquireLease' | 'renewLease' | 'releaseLease'>;

/** What a stage was closed with when a newer generation took its claim. pipeline-dev's `interrupted` filter ignores such a stage. */
export const LEASE_LOST_OUTPUT = { interrupted: true, reason: 'lease-lost', error: 'the executor lease was lost, so another kernel took this stage over' } as const;

import type { BuligEvent, Job, JobStatus, Stage, StageStatus } from '@bulig/plugin-sdk';

/**
 * The Store port (ADR 0007): everything the kernel keeps, behind promises. An adapter implements it for one engine
 * (SqliteStore today, Postgres next). Nothing here names an engine: no file path, no row id, no sync call.
 *
 * Rules every adapter follows, and the shared contract suite in packages/core/test checks:
 * - A call that fails rejects. It never throws before it returns a promise.
 * - Calls made one after another from the same caller take effect in that order. The kernel makes sure of the rest
 *   by sending every call through one queue (see StoreQueue), so an adapter never has to cope with its caller racing itself.
 * - Lists come back oldest first: jobs and stages by creation, events by `seq`.
 * - `seq` only goes up, and an event is readable as soon as `appendEvent` resolves.
 * - Opening a store that already has data runs only the migrations it has not seen.
 */
export interface Store {
  /** How many numbered migrations this store has applied. */
  schemaVersion(): Promise<number>;
  /** Release the engine. No call may follow. */
  close(): Promise<void>;

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

// Who gets which stage. Pure bookkeeping: no I/O, no clock, so it can be tested on its own.
//
//  - One queue, in the order stages were asked for. A worker takes the OLDEST stage it is allowed to take, so inside one project
//    stages are served first come, first served.
//  - One lane per job folder: a job's next stage is not handed out while the job still has a stage in someone's hands.
//  - A cap on how many stages each worker holds at once.

/** A stage waiting for a worker. */
export interface Pending {
  /** The stage attempt this request is for. Requests that came without one get a made-up key and can only run on the local worker. */
  key: string;
  stageId: string | undefined;
  jobId: string;
  stage: string;
  attempt: number;
  /** The repository the job works on: the unit of "project". */
  project: string;
  /** The whole stage.requested payload, as the pipeline sent it. */
  payload: Record<string, unknown>;
  /** How many times this stage was already taken away from a lost worker and offered again. */
  reoffers: number;
  seq: number;
}

/** A stage in a worker's hands. */
export interface Active {
  workerId: string;
  pending: Pending;
  generation: number;
  lastBeat: number;
  /** The worker's changes were applied to the job folder. A repeated result must not apply them twice. */
  applied: boolean;
  /** The patch that was applied, kept so it can be taken back if the result cannot be recorded. */
  appliedPatch?: Buffer | undefined;
  /** A result is being handled. The heartbeat check leaves such a stage alone. */
  finishing: boolean;
  lost: boolean;
}

export class Scheduler {
  private queue: Pending[] = [];
  private readonly active = new Map<string, Active>();
  private seq = 0;

  nextSeq(): number {
    return ++this.seq;
  }

  get queued(): number {
    return this.queue.length;
  }

  has(key: string): boolean {
    return this.active.has(key) || this.queue.some((p) => p.key === key);
  }

  /** Add a stage to the queue, in order. A stage already queued or held is not added twice. */
  add(p: Pending): boolean {
    if (this.has(p.key)) return false;
    this.insert(p);
    return true;
  }

  /** Put a stage back where its arrival order says it belongs (a worker went away before it could take it). */
  requeue(p: Pending): void {
    if (!this.has(p.key)) this.insert(p);
  }

  private insert(p: Pending): void {
    const at = this.queue.findIndex((q) => q.seq > p.seq);
    if (at === -1) this.queue.push(p);
    else this.queue.splice(at, 0, p);
  }

  /** Is a stage of this job in someone's hands? */
  jobBusy(jobId: string): boolean {
    for (const a of this.active.values()) if (a.pending.jobId === jobId) return true;
    return false;
  }

  /** Take (remove and return) the oldest queued stage that `accept` allows and whose job has no stage in someone's hands. */
  take(accept: (p: Pending) => boolean): Pending | undefined {
    const at = this.queue.findIndex((p) => !this.jobBusy(p.jobId) && accept(p));
    if (at === -1) return undefined;
    return this.queue.splice(at, 1)[0];
  }

  drop(key: string): void {
    this.queue = this.queue.filter((p) => p.key !== key);
  }

  dropJob(jobId: string): Pending[] {
    const gone = this.queue.filter((p) => p.jobId === jobId);
    this.queue = this.queue.filter((p) => p.jobId !== jobId);
    return gone;
  }

  hold(a: Active): void {
    this.active.set(a.pending.key, a);
  }

  release(key: string): Active | undefined {
    const a = this.active.get(key);
    this.active.delete(key);
    return a;
  }

  held(key: string): Active | undefined {
    return this.active.get(key);
  }

  heldBy(workerId: string): number {
    let n = 0;
    for (const a of this.active.values()) if (a.workerId === workerId) n++;
    return n;
  }

  allHeld(): Active[] {
    return [...this.active.values()];
  }
}

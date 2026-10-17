import type { Store } from './store.ts';

/** What a task on the queue may call: the store without `close`, which only the kernel does. */
export type StoreTx = Omit<Store, 'close'>;

/** A store call, or the task it belonged to, did not finish in time. */
export class StoreTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Store call "${label}" did not finish within ${ms} ms, so it was given up on. The store may be down or stuck.`);
    this.name = 'StoreTimeoutError';
  }
}

/** A call came in after the kernel closed its store. */
export class StoreClosedError extends Error {
  constructor(label: string) {
    super(`Store call "${label}" came after the kernel stopped`);
    this.name = 'StoreClosedError';
  }
}

const METHODS = [
  'schemaVersion',
  'createJob', 'getJob', 'listJobs', 'setJobStatus',
  'startStage', 'getStage', 'listStages', 'finishStage',
  'getState', 'setState',
  'appendEvent', 'eventsAfter', 'eventsForJob',
] as const satisfies readonly (keyof StoreTx)[];

/**
 * The one door to the store (ADR 0001 in async form). Every read and write the kernel makes is a task on this queue.
 * Tasks run one at a time, in the order they were queued, and a task starts only when the one before it has settled.
 * So writes land in call order, and a read sees every write queued before it.
 *
 * A task may make several store calls. Nothing else touches the store until it returns, which is how a check and the
 * write behind it stay one step (ADR 0003). A task must not wait on another task: that would wait on itself.
 *
 * Each task has a deadline. When it passes, the task's promise rejects with StoreTimeoutError, the task's handle stops
 * working (its later calls reject, so an abandoned task cannot write after the queue moved on), and the next task starts.
 * One stuck call therefore fails the one operation that made it and nothing else.
 */
export class StoreQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private closed = false;

  constructor(
    private store: Store,
    private timeoutMs = 30_000,
  ) {}

  /** Tasks queued or running. */
  get pending(): number {
    return this.waiting;
  }

  run<T>(label: string, task: (tx: StoreTx) => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new StoreClosedError(label));
    this.waiting++;
    const result = this.tail.then(() => this.execute(label, task));
    const settled = () => void this.waiting--;
    result.then(settled, settled);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Resolve when every queued task has settled, including ones queued while waiting. */
  async idle(): Promise<void> {
    while (this.waiting > 0) await this.tail;
  }

  /** Stop taking tasks, let the queued ones settle, close the store. */
  async close(): Promise<void> {
    await this.idle();
    this.closed = true;
    await this.store.close();
  }

  private execute<T>(label: string, task: (tx: StoreTx) => Promise<T> | T): Promise<T> {
    const lease = { expired: false };
    const tx = {} as Record<string, unknown>;
    for (const name of METHODS) {
      tx[name] = (...args: unknown[]) => {
        if (lease.expired) return Promise.reject(new StoreTimeoutError(label, this.timeoutMs));
        try {
          return Promise.resolve((this.store[name] as (...a: unknown[]) => Promise<unknown>)(...args));
        } catch (err) {
          return Promise.reject(err);
        }
      };
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        lease.expired = true;
        reject(new StoreTimeoutError(label, this.timeoutMs));
      }, this.timeoutMs);
      let running: Promise<T>;
      try {
        running = Promise.resolve(task(tx as unknown as StoreTx));
      } catch (err) {
        running = Promise.reject(err);
      }
      running.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

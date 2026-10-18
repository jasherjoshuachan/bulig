import { StoreFatalError, type Store, type StoreTx } from './store.ts';

export type { StoreTx };

/** What a task on the queue may call: the store's calls, plus a way to run something once the task has committed. */
export interface QueueTx extends StoreTx {
  /** Run `fn` after this task has committed, in commit order, before the next task starts. Dropped if the task does not commit. */
  afterCommit(fn: () => void): void;
}

/** A task did not finish in time. It is rolled back once the call it was inside comes back; if that never happens the queue breaks. */
export class StoreTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Store call "${label}" did not finish within ${ms} ms, so it was given up on and is being rolled back. The store may be down or stuck.`);
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

/**
 * The kernel gave up on the store: a call never came back, or a rollback failed. It no longer knows what the record
 * holds and has stopped using it. `task` is the queue task that was running, `call` the store call it was inside.
 */
export class StoreBrokenError extends Error {
  constructor(
    message: string,
    public readonly task: string,
    public readonly call: string,
    /** The task that was refused because of this, when the error is the answer to one. */
    public readonly refused?: string,
  ) {
    super(refused === undefined ? message : `Store call "${refused}" was not made: ${message}`);
    this.name = 'StoreBrokenError';
  }
}

const METHODS = [
  'schemaVersion',
  'createJob', 'getJob', 'listJobs', 'setJobStatus',
  'startStage', 'getStage', 'listStages', 'finishStage',
  'getState', 'setState',
  'appendEvent', 'eventsAfter', 'eventsForJob',
] as const satisfies readonly (keyof StoreTx)[];

export interface QueueOptions {
  /** How long a task may take before its caller is given the timeout and the task is rolled back. Default 30000. */
  timeoutMs?: number;
  /**
   * How long a task may take before the queue gives up on the store altogether. A task that has timed out is rolled
   * back only once the call it was inside comes back, and the next task waits for that. If the call never comes back,
   * this is when the queue breaks. Default 120000. Never less than timeoutMs.
   */
  brokenMs?: number;
  /** Told once, when the queue breaks. */
  onBroken?: (err: StoreBrokenError) => void;
  /** How long close() waits for the store's own close() before it stops waiting. Default 10000. */
  closeMs?: number;
  /** Told when close() stopped waiting for the store. */
  onCloseCutShort?: (ms: number) => void;
}

interface Started {
  outcome: Promise<unknown>;
  /** Settles when the task is over: its calls have come back and it has committed or rolled back. */
  finished: Promise<void>;
}

/**
 * The one door to the store (ADR 0001 in async form). Every read and write the kernel makes is a task on this queue.
 *
 * - One at a time, in the order queued. A task starts only when the one before it is completely over, so writes land
 *   in call order and a read sees every write queued before it.
 * - Each task is one transaction. Its writes, and the events it announces, commit together or not at all. Events are
 *   handed to subscribers (afterCommit) only once the task has committed, in commit order.
 * - A task has a deadline. When it passes, the caller is told at once (StoreTimeoutError) and the task is marked
 *   expired: a store call it makes after that is refused, and the check is made again when a call returns, so a call
 *   that was already inside the store when the deadline passed cannot get the task any further. The task then rolls
 *   back. The queue waits for the call to come back and the rollback to finish before it starts the next task, so a
 *   late write can never land after a later one.
 * - If a call never comes back, the queue breaks at the second bound (brokenMs): every task waiting, and every task
 *   after, is refused with StoreBrokenError and nothing more is written or delivered. A kernel that cannot tell what
 *   its record holds stops changing it.
 *
 * A task must not wait on another task: that would wait on itself.
 */
export class StoreQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private closed = false;
  private broken: StoreBrokenError | undefined;
  private readonly timeoutMs: number;
  private readonly brokenMs: number;
  private readonly closeMs: number;

  constructor(
    private store: Store,
    private options: QueueOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.brokenMs = Math.max(options.brokenMs ?? 120_000, this.timeoutMs);
    this.closeMs = options.closeMs ?? 10_000;
  }

  /** Tasks queued or running. */
  get pending(): number {
    return this.waiting;
  }

  /** Set once the queue has given up on the store. */
  get brokenError(): StoreBrokenError | undefined {
    return this.broken;
  }

  run<T>(label: string, task: (tx: QueueTx) => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new StoreClosedError(label));
    if (this.broken) return Promise.reject(this.refusal(label));
    this.waiting++;
    const started = this.tail.then(() => this.start(label, task));
    const done = started.then((s) => s.finished);
    const over = () => void this.waiting--;
    done.then(over, over);
    this.tail = done.then(
      () => {},
      () => {},
    );
    return started.then((s) => s.outcome as Promise<T>);
  }

  /** Resolve when every queued task is over, including ones queued while waiting. */
  async idle(): Promise<void> {
    while (this.waiting > 0) await this.tail;
  }

  /** Refuse new tasks, let the queued ones finish, close the store. */
  async close(): Promise<void> {
    this.closed = true;
    await this.idle();
    // A hanging pool must not hang the kernel's stop(). Wait for the store a while, then say so and go on.
    let timer: NodeJS.Timeout | undefined;
    const cut = new Promise<'cut'>((resolve) => (timer = setTimeout(() => resolve('cut'), this.closeMs)));
    const closing = this.store.close().then(
      () => 'closed' as const,
      (err: unknown) => {
        if (!this.broken) throw err;
        return 'closed' as const;
      },
    );
    closing.catch(() => {});
    try {
      if ((await Promise.race([closing, cut])) === 'cut') this.options.onCloseCutShort?.(this.closeMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private refusal(label: string): StoreBrokenError {
    const b = this.broken!;
    return new StoreBrokenError(b.message, b.task, b.call, label);
  }

  /** Give up on the store: refuse everything from now on, ask the adapter to stop what is in flight, say so once. */
  private breakWith(err: StoreBrokenError): void {
    if (this.broken) return;
    this.broken = err;
    try {
      void Promise.resolve(this.store.abort?.()).catch(() => {});
    } catch {
      // the adapter could not stop it either; the record is already marked unusable
    }
    this.options.onBroken?.(err);
  }

  private start(label: string, task: (tx: QueueTx) => unknown): Started {
    if (this.broken) {
      return { outcome: Promise.reject(this.refusal(label)), finished: Promise.resolve() };
    }
    const lease = { expired: false };
    const hooks: (() => void)[] = [];
    let settleOutcome!: { resolve(v: unknown): void; reject(e: unknown): void };
    const outcome = new Promise<unknown>((resolve, reject) => (settleOutcome = { resolve, reject }));
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    // Whatever happens, the caller hears at most once, and nothing is left unhandled if it does not listen.
    outcome.catch(() => {});

    const timeout = new StoreTimeoutError(label, this.timeoutMs);
    // The store call the task is inside, for the error that names it.
    let call = 'none';
    const check = () => {
      if (lease.expired) {
        call = 'rollback';
        throw timeout;
      }
    };
    // Past this point the transaction is committing. The caller waits for the commit's answer instead of the clock.
    let committing = false;
    let abandoned = false;
    const shortTimer = setTimeout(() => {
      if (committing) return;
      lease.expired = true;
      settleOutcome.reject(timeout);
    }, this.timeoutMs);
    const longTimer = setTimeout(() => {
      lease.expired = true;
      abandoned = true;
      const err = new StoreBrokenError(
        `The record is unusable: store call "${call}" (inside task "${label}") did not come back within ${this.brokenMs} ms. The kernel has stopped writing. What that task changed may or may not have been kept; the in-flight work was told to stop.`,
        label,
        call,
      );
      settleOutcome.reject(err);
      release();
      this.breakWith(err);
    }, this.brokenMs);
    const clear = () => {
      clearTimeout(shortTimer);
      clearTimeout(longTimer);
    };

    const guard = (raw: StoreTx): QueueTx => {
      const tx = { afterCommit: (fn: () => void) => void hooks.push(fn) } as Record<string, unknown>;
      for (const name of METHODS) {
        tx[name] = async (...args: unknown[]) => {
          check();
          call = name;
          try {
            const result = await (raw[name] as (...a: unknown[]) => Promise<unknown>)(...args);
            check(); // a call that was inside the store when the deadline passed gets the task no further
            return result;
          } catch (err) {
            check();
            throw err;
          }
        };
      }
      return tx as unknown as QueueTx;
    };

    let running: Promise<unknown>;
    try {
      running = this.store.transaction(async (raw) => {
        const value = await task(guard(raw));
        check();
        call = 'commit';
        committing = true;
        clearTimeout(shortTimer);
        return value;
      });
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(
      (value) => {
        clear();
        if (!abandoned) {
          // Committed: now the subscribers may hear, in commit order, before the next task starts.
          for (const fn of hooks) {
            try {
              fn();
            } catch {
              // a hook must not stop the queue
            }
          }
          settleOutcome.resolve(value);
        }
        release();
      },
      (err: unknown) => {
        clear();
        if (err instanceof StoreFatalError && !abandoned) {
          // Rollback or commit failed: a transaction may be open. Stop at once, not at the next task's BEGIN.
          abandoned = true;
          const broken = new StoreBrokenError(
            `The record is unusable: ${err.message}. The kernel has stopped writing. What the task "${label}" changed may or may not have been kept.`,
            label,
            call,
          );
          settleOutcome.reject(broken);
          release();
          this.breakWith(broken);
          return;
        }
        settleOutcome.reject(err);
        release();
      },
    );
    return { outcome, finished };
  }
}

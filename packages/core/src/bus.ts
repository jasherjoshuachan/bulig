import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { CapabilityDeniedError, matchesPattern, type BuligEvent, type EventHandler } from '@bulig/plugin-sdk';
import type { QueueTx, StoreQueue } from './queue.ts';
import { DuplicateEventError } from './store.ts';

interface Subscription {
  plugin: string;
  /** The plugin's name and the order of this subscription: two handlers of one plugin on one event must not share ids. */
  key: string;
  pattern: string;
  handler: EventHandler;
}

/** One run of one handler on one event: what an event it emits is derived from (ADR 0010, addendum of 18 Oct 2026). */
export interface Cause {
  eventId: string;
  handler: string;
  /** Events this run has written so far. The next one takes this number, so two emits of one type in one run get different ids. */
  next: number;
}

/**
 * An event with a derived or given id was already in the log, so the whole task that met it is a replay: it was rolled back,
 * nothing was delivered, and `existing` is what the log holds under that id.
 */
export class ReplayedError extends Error {
  /** What the call that wrote the event should answer, set by the kernel for a job call: the job as the record holds it. */
  result?: unknown;

  constructor(public readonly existing: BuligEvent) {
    super(`Event ${existing.id} (${existing.type}) was already written, so this task was a replay and wrote nothing`);
    this.name = 'ReplayedError';
  }
}

/**
 * The id of an event that a handler's run caused: a hash of the event it was handling, the handler, the number of events the
 * run had written before this one, and the type. Same inputs, same id, so a handler run twice for one event asks for the same ids.
 * Shaped as a UUID (version 8, the custom one) so it fits wherever a random id does.
 */
export function derivedEventId(causeId: string, handler: string, ordinal: number, type: string): string {
  const h = createHash('sha256').update(['bulig.event.v1', causeId, handler, String(ordinal), type].join('\0')).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface EmitInput {
  type: string;
  source: string;
  payload?: unknown;
  jobId?: string | undefined;
  /** An id the source already knows (kernel-internal; plugins cannot pass one). Without it the id is derived from the cause, or random. */
  id?: string | undefined;
}

/**
 * ADR 0002 with an async store: write to the log first, then deliver, in log order.
 *
 * Every event is written by a task on the kernel's store queue, inside the task's transaction. Subscribers hear it
 * only after that transaction has committed, and before the next task starts. The queue runs one task at a time in the
 * order they were queued, so delivery order is commit order is log order, and a handler never sees an event that is
 * not in the log. An event whose task rolled back (a timeout, a failed write) is never delivered. An event emitted from inside a handler is queued behind the task that is
 * delivering the current one, so it is written and delivered after it.
 *
 * Handlers are started, not awaited. The worker's handler runs a Claude process for up to 20 minutes, and the next
 * event must not wait for it.
 */
export class Bus {
  private subs: Subscription[] = [];
  /** Async handlers that have not finished yet, with the seq of the event each one is working on. */
  private inflight = new Map<Promise<void>, number>();
  private lastDelivered = 0;
  /** The handler run the current code is inside, so an emit knows which event caused it. */
  private causes = new AsyncLocalStorage<Cause>();

  constructor(
    private queue: StoreQueue,
    /** Event type -> the capability a plugin needs to emit it. */
    private eventCapabilities: Readonly<Record<string, string>> = {},
    /** Told when an event was not written (the store timed out or failed, and the task rolled back). Nothing was delivered for it. */
    private onError: (err: unknown, input: EmitInput) => void = () => {},
  ) {}

  subscribe(plugin: string, pattern: string, handler: EventHandler): void {
    this.subs.push({ plugin, key: `${plugin}#${this.subs.length}`, pattern, handler });
  }

  /** The handler run this call is inside, if any. Taken when a write is asked for, so it is the caller's and not the queue's. */
  currentCause(): Cause | undefined {
    return this.causes.getStore();
  }

  /**
   * Queue an event. The promise settles with the event once it is committed to the log and delivered, or rejects if it
   * was not written. Nobody has to wait on it: a failed write is also reported to `onError`.
   */
  emit(input: EmitInput, options: { report?: boolean } = {}): Promise<BuligEvent> {
    const cause = this.currentCause();
    const written = this.queue.run(`emit ${input.type}`, (tx) => this.record(tx, input, cause)).catch((err: unknown) => {
      // A replay is not a failure: the event is already in the log and was delivered then.
      if (err instanceof ReplayedError) return err.existing;
      throw err;
    });
    // A caller that waits for the answer (emitCommitted) hears the failure itself; no need to log it as well.
    if (options.report !== false) written.catch((err: unknown) => this.onError(err, input));
    else written.catch(() => {});
    return written;
  }

  /**
   * Emit on behalf of a plugin. If the event type needs a capability, the plugin must hold it
   * (declared in needs and granted in config), or nothing is written and nothing is dispatched.
   * That check throws here, in the caller's own call, before anything is queued.
   */
  emitFrom(plugin: string, caps: ReadonlySet<string>, input: Omit<EmitInput, 'source'>, options: { report?: boolean } = {}): Promise<BuligEvent> {
    const needed = Object.hasOwn(this.eventCapabilities, input.type) ? this.eventCapabilities[input.type] : undefined;
    if (needed && !caps.has(needed)) {
      throw new CapabilityDeniedError(`Plugin "${plugin}" was denied "${needed}" (needed to emit "${input.type}")`);
    }
    return this.emit({ ...input, source: plugin }, options);
  }

  /**
   * Write an event from inside a task that is already running on the queue, and deliver it once that task commits. The
   * kernel uses this when a state change and its event must be one step: they commit together or not at all.
   */
  async record(tx: QueueTx, input: EmitInput, cause?: Cause): Promise<BuligEvent> {
    // An event a handler causes gets an id derived from its cause. One with no cause (kernel.started, input from outside)
    // gets a random one, unless its source gave a stable id.
    const id = input.id ?? (cause ? derivedEventId(cause.eventId, cause.handler, cause.next++, input.type) : undefined);
    let event: BuligEvent;
    try {
      event = await tx.appendEvent({
        ...(id !== undefined && { id }),
        type: input.type,
        source: input.source,
        payload: input.payload ?? null,
        ...(input.jobId !== undefined && { jobId: input.jobId }),
      });
    } catch (err) {
      // Already written, so this task is a replay. Throwing rolls the whole task back (a change that went with the event is
      // undone with it) and drops the delivery, so nothing is done or announced twice.
      if (err instanceof DuplicateEventError && err.existing) throw new ReplayedError(err.existing);
      throw err;
    }
    tx.afterCommit(() => this.dispatch(event));
    return event;
  }

  /**
   * Resolve when nothing is left to write or deliver and no handler is still running, or after `timeoutMs`. The kernel
   * waits on this before it closes the store, so a handler that is mid-way through a git command can still write its answer.
   */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.queue.pending === 0 && this.inflight.size === 0) return;
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.queue.idle().then(() => Promise.allSettled([...this.inflight.keys()])),
        new Promise<void>((r) => (timer = setTimeout(r, left))),
      ]);
      clearTimeout(timer);
    }
  }

  /**
   * Resolve when every event written so far has been delivered and the handlers started for them have returned.
   * Handlers started later, for events those handlers emit, are not waited for: a Claude run that a handler starts
   * does not hold this up. This is how a caller knows that whoever listens has acted on what it just emitted.
   */
  async settle(): Promise<void> {
    await this.queue.idle();
    const upTo = this.lastDelivered;
    for (;;) {
      const mine = [...this.inflight].filter(([, seq]) => seq <= upTo).map(([p]) => p);
      if (mine.length === 0) return;
      await Promise.allSettled(mine);
    }
  }

  /** All events after `afterSeq` (default: everything), oldest first. */
  replay(afterSeq = 0): Promise<BuligEvent[]> {
    return this.queue.run('replay', (tx) => tx.eventsAfter(afterSeq));
  }

  history(jobId: string): Promise<BuligEvent[]> {
    return this.queue.run('history', (tx) => tx.eventsForJob(jobId));
  }

  private dispatch(event: BuligEvent): void {
    const seq = event.seq ?? this.lastDelivered;
    this.lastDelivered = seq;
    for (const sub of this.subs) {
      if (!matchesPattern(sub.pattern, event.type)) continue;
      try {
        const cause: Cause = { eventId: event.id, handler: sub.key, next: 0 };
        const result = this.causes.run(cause, () => sub.handler(event));
        if (result) {
          const tracked: Promise<void> = result.catch((err: unknown) => this.fail(sub, event, err));
          const forget = () => void this.inflight.delete(tracked);
          this.inflight.set(tracked, seq);
          tracked.then(forget, forget);
        }
      } catch (err) {
        this.fail(sub, event, err);
      }
    }
  }

  private fail(sub: Subscription, event: BuligEvent, err: unknown): void {
    // A broken plugin.error handler must not loop forever.
    if (event.type === 'plugin.error') return;
    void this.emit({
      type: 'plugin.error',
      source: 'kernel',
      jobId: event.jobId,
      payload: {
        plugin: sub.plugin,
        eventId: event.id,
        eventType: event.type,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

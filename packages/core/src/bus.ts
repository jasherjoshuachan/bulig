import { CapabilityDeniedError, matchesPattern, type BuligEvent, type EventHandler } from '@bulig/plugin-sdk';
import type { Store } from './store.ts';

interface Subscription {
  plugin: string;
  pattern: string;
  handler: EventHandler;
}

export interface EmitInput {
  type: string;
  source: string;
  payload?: unknown;
  jobId?: string | undefined;
}

/**
 * Persist first, then dispatch to matching subscribers in subscription order.
 * Events emitted from inside a handler are queued, so dispatch order equals log order.
 */
export class Bus {
  private subs: Subscription[] = [];
  private queue: BuligEvent[] = [];
  private draining = false;
  /** Async handlers that have not finished yet. */
  private inflight = new Set<Promise<void>>();

  constructor(
    private store: Store,
    /** Event type -> the capability a plugin needs to emit it. */
    private eventCapabilities: Readonly<Record<string, string>> = {},
  ) {}

  subscribe(plugin: string, pattern: string, handler: EventHandler): void {
    this.subs.push({ plugin, pattern, handler });
  }

  emit(input: EmitInput): BuligEvent {
    const event = this.store.appendEvent({
      type: input.type,
      source: input.source,
      payload: input.payload ?? null,
      ...(input.jobId !== undefined && { jobId: input.jobId }),
    });
    this.queue.push(event);
    this.drain();
    return event;
  }

  /**
   * Emit on behalf of a plugin. If the event type needs a capability, the plugin must hold it
   * (declared in needs and granted in config), or nothing is written and nothing is dispatched.
   */
  emitFrom(plugin: string, caps: ReadonlySet<string>, input: Omit<EmitInput, 'source'>): BuligEvent {
    const needed = Object.hasOwn(this.eventCapabilities, input.type) ? this.eventCapabilities[input.type] : undefined;
    if (needed && !caps.has(needed)) {
      throw new CapabilityDeniedError(`Plugin "${plugin}" was denied "${needed}" (needed to emit "${input.type}")`);
    }
    return this.emit({ ...input, source: plugin });
  }

  /**
   * Resolve when no async handler is still running, or after `timeoutMs`. The kernel waits on this before it
   * closes the store, so a handler that is mid-way through a git command can still write its answer.
   */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise<void>((r) => (timer = setTimeout(r, left))),
      ]);
      clearTimeout(timer);
    }
  }

  /** All events after `afterSeq` (default: everything), oldest first. */
  replay(afterSeq = 0): BuligEvent[] {
    return this.store.eventsAfter(afterSeq);
  }

  history(jobId: string): BuligEvent[] {
    return this.store.eventsForJob(jobId);
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let e = this.queue.shift(); e; e = this.queue.shift()) this.dispatch(e);
    } finally {
      this.draining = false;
    }
  }

  private dispatch(event: BuligEvent): void {
    for (const sub of this.subs) {
      if (!matchesPattern(sub.pattern, event.type)) continue;
      try {
        const result = sub.handler(event);
        if (result) {
          const tracked: Promise<void> = result.catch((err: unknown) => this.fail(sub, event, err));
          const forget = () => void this.inflight.delete(tracked);
          this.inflight.add(tracked);
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
    this.emit({
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

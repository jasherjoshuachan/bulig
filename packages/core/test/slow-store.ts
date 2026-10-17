import type { Store } from '../src/index.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SlowOptions {
  /** Milliseconds a call waits before it reaches the real store. A function sees the method and the call number (from 1). */
  before?: number | ((method: string, n: number) => number);
  /** Milliseconds the answer waits after the real store has done the work, as a slow network would. */
  after?: number | ((method: string, n: number) => number);
  /** Return true to make this call never settle. */
  hang?: (method: string, args: unknown[], n: number) => boolean;
}

export type SlowStore = Store & {
  /** Every call that reached the real store, as "method" in the order the store did them. */
  applied: string[];
  /** Events once the real store has them (before the answer goes back), by id. */
  logged: Set<string>;
};

const METHODS = [
  'schemaVersion', 'createJob', 'getJob', 'listJobs', 'setJobStatus', 'startStage', 'getStage', 'listStages', 'finishStage',
  'getState', 'setState', 'appendEvent', 'eventsAfter', 'eventsForJob',
] as const;

const at = (v: number | ((m: string, n: number) => number) | undefined, m: string, n: number) => (typeof v === 'function' ? v(m, n) : (v ?? 0));

/** Wrap any adapter so every call takes time, or never ends. Used to find the places that only worked because the store was instant. */
export function slowStore(inner: Store, options: SlowOptions = {}): SlowStore {
  let n = 0;
  const wrapped = { applied: [] as string[], logged: new Set<string>() } as unknown as Record<string, unknown> & SlowStore;
  const methods = wrapped as Record<string, unknown>;
  for (const name of METHODS) {
    methods[name] = async (...args: unknown[]) => {
      const call = ++n;
      const wait = at(options.before, name, call);
      if (wait > 0) await sleep(wait);
      if (options.hang?.(name, args, call)) return new Promise(() => {});
      wrapped.applied.push(name);
      const result = await (inner[name] as (...a: unknown[]) => Promise<unknown>)(...args);
      if (name === 'appendEvent') wrapped.logged.add((result as { id: string }).id);
      const later = at(options.after, name, call);
      if (later > 0) await sleep(later);
      return result;
    };
  }
  methods.close = () => inner.close();
  return wrapped;
}

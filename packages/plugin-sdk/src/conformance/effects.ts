import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { Recording } from './fake-kernel.ts';

/**
 * Side effects the harness can see: network, child processes and file writes. While a plugin runs, those calls are
 * recorded and refused, so a conformance run never touches the machine. Reads are not watched. This is a tripwire
 * for plugins that call the standard APIs, not a sandbox: a plugin that loads a native addon, or keeps a reference
 * to an API from before the harness started, is not seen. docs/sdk-v1.md says so.
 */
export type EffectKind = 'network' | 'process' | 'fs-write';

/** Which declared capabilities cover each kind of effect. A plugin that does one needs at least one of these in `needs`. */
export const EFFECT_CAPABILITIES: Readonly<Record<EffectKind, RegExp>> = {
  network: /^(net\.|channel\.send:)/,
  process: /^(claude\.run$|git\.|gh\.|proc\.)/,
  'fs-write': /^(fs\.|git\.|gh\.)/,
};

const CP = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const FS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'symlinkSync', 'createWriteStream',
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'symlink',
];

/**
 * Answers a plugin's fetch with JSON, so a plugin that talks to an API can be driven through its emits. Return
 * undefined to leave the request hanging until the plugin aborts it. Which requests the plugin may make is still
 * decided by its declared needs: this only supplies the replies.
 */
export type FetchResponder = (url: string, init: { body?: unknown } | undefined, callNumber: number) => unknown;

export class EffectBlockedError extends Error {
  constructor(kind: EffectKind, what: string) {
    super(`conformance harness: ${kind} access (${what}) is blocked while a plugin runs`);
    this.name = 'EffectBlockedError';
  }
}

/** Is the call coming from plugin code, and not from vitest or Node itself? */
function fromPlugin(): boolean {
  // Only the synchronous frames: the async ones above them can name the test file that started the run.
  const frames: string[] = [];
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    if (line.trim().startsWith('at async ')) break;
    frames.push(line);
  }
  return frames.some((f) => !f.includes('node:') && !f.includes('node_modules') && !f.includes('/plugin-sdk/src/conformance/'));
}

type Fn = (...args: unknown[]) => unknown;

/** The real timers, kept from before any patching, so the harness never counts its own. */
export const realSetTimeout = globalThis.setTimeout;
export const realClearTimeout = globalThis.clearTimeout;

/**
 * Run `fn` with the watched APIs patched. Everything seen is added to `seen`. Timers the plugin starts with the
 * global setTimeout or setInterval are tracked in `timers` until they fire (setTimeout) or are cleared.
 */
export async function withEffectsRecorded<T>(
  seen: Set<EffectKind>,
  timers: Set<NodeJS.Timeout>,
  fn: () => Promise<T>,
  respond?: FetchResponder,
  /** Effect kinds that are recorded but let through, for a plugin whose path to the next effect runs through a safe one. */
  allow: readonly EffectKind[] = [],
): Promise<T> {
  const require = createRequire(import.meta.url);
  const restore: Array<() => void> = [];
  const hit = (kind: EffectKind, what: string): void => {
    if (!fromPlugin()) return;
    seen.add(kind);
    if (!allow.includes(kind)) throw new EffectBlockedError(kind, what);
  };
  const wrap = (obj: Record<string, unknown>, names: string[], kind: EffectKind, label: string) => {
    for (const name of names) {
      const orig = obj[name];
      if (typeof orig !== 'function') continue;
      obj[name] = function (this: unknown, ...args: unknown[]) {
        hit(kind, `${label}.${name}`);
        return (orig as Fn).apply(this, args);
      };
      restore.push(() => void (obj[name] = orig));
    }
  };
  wrap(require('node:child_process'), CP, 'process', 'child_process');
  wrap(require('node:fs'), FS, 'fs-write', 'fs');
  wrap(require('node:fs').promises, FS, 'fs-write', 'fs.promises');
  const net = require('node:net') as { Socket: { prototype: Record<string, unknown> } };
  wrap(net.Socket.prototype, ['connect'], 'network', 'net.Socket');

  // fetch: record, then wait for the caller to abort, like a very slow server. A plugin that polls then stops cleanly.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal | null; body?: unknown }) => {
    if (fromPlugin()) {
      seen.add('network');
      const body = respond?.(String(input), init, ++calls);
      if (body !== undefined) return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return new Promise((_, reject) => {
      const signal = init?.signal ?? undefined;
      const stop = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
      if (!signal) reject(new EffectBlockedError('network', `fetch ${String(input)}`));
    });
  }) as typeof fetch;
  restore.push(() => void (globalThis.fetch = realFetch));
  const realSet = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = ((cb: unknown, ms?: number, ...args: unknown[]) => {
    if (typeof cb !== 'function' || !fromPlugin()) return (realSet as Fn)(cb, ms, ...args);
    const t: NodeJS.Timeout = (realSet as Fn)(() => {
      timers.delete(t);
      return (cb as Fn)(...args);
    }, ms) as NodeJS.Timeout;
    timers.add(t);
    return t;
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((cb: unknown, ms?: number, ...args: unknown[]) => {
    const t = (realInterval as Fn)(cb, ms, ...args) as NodeJS.Timeout;
    if (typeof cb === 'function' && fromPlugin()) timers.add(t);
    return t;
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = ((t: NodeJS.Timeout) => (timers.delete(t), (realClear as Fn)(t))) as typeof clearTimeout;
  globalThis.clearInterval = ((t: NodeJS.Timeout) => (timers.delete(t), (realClearInterval as Fn)(t))) as typeof clearInterval;
  restore.push(() => {
    globalThis.setTimeout = realSet;
    globalThis.setInterval = realInterval;
    globalThis.clearTimeout = realClear;
    globalThis.clearInterval = realClearInterval;
  });
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
  }
}

/** Does `needs` contain a capability that covers this kind of effect? */
export const coveredBy = (kind: EffectKind, needs: readonly string[]): boolean => needs.some((n) => EFFECT_CAPABILITIES[kind].test(n));

/** Names of the OS handles, other than timers, that would keep the process alive: sockets, child processes, watchers. */
export function liveHandles(): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) {
    if (!/^(TCP|UDP|ChildProcess|Process|Signal|FSWatcher|StatWatcher)/.test(name)) continue;
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

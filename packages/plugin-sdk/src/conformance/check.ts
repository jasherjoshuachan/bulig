import {
  DEPRECATED_SDK_MAJORS,
  ManifestSchema,
  SUPPORTED_SDK_MAJORS,
  isReservedEvent,
  type Manifest,
  type Plugin,
} from '../index.ts';
import { coveredBy, liveHandles, realSetTimeout, withEffectsRecorded, type EffectKind, type FetchResponder } from './effects.ts';
import { createFakeKernel, newRecording, type Finding, type Recording, type Rule, type SeedJob } from './fake-kernel.ts';

export type { Finding, Rule } from './fake-kernel.ts';

/** One run of the plugin in the fake kernel: a config, some jobs, and the events to deliver. */
export interface Scenario {
  name: string;
  /** Config for this run. Default: ConformanceOptions.config. */
  config?: Record<string, unknown>;
  /** Jobs the fake store holds before the first event. The first is fakeJobId(1), the next fakeJobId(2). */
  jobs?: SeedJob[];
  events: Array<{ type: string; payload?: unknown; jobId?: string; source?: string }>;
  /** Called after the events, for a plugin whose entry point is not an event (a channel's grant() or submit()). */
  act?: () => void | Promise<void>;
  /** Wait this long (ms) after the last event, for a plugin that acts on a timer or a poll. Default 0. */
  waitMs?: number;
}

export interface ConformanceOptions {
  /**
   * Returns a fresh plugin each call. A plugin that keeps state in its module or its factory must be built new
   * for every run, so pass `() => createX()` and not the shared default export when you have the choice.
   */
  load: () => Plugin | Promise<Plugin>;
  /** A config the plugin accepts. Default {}. */
  config?: Record<string, unknown>;
  /** Configs the plugin must refuse at register(), each with the reason it is wrong. The error must name the plugin. */
  invalidConfigs?: Array<{ config: Record<string, unknown>; reason: string }>;
  /** Events to feed the plugin so its emits can be observed. Without any, only what register() does is checked. */
  scenarios?: Scenario[];
  /**
   * Effect kinds to let through for real (they are still recorded and still need a covering capability). Default none:
   * every network call, child process and file write is refused. Allow only what is harmless on a scratch machine,
   * such as a plugin's own temp directory, when the code path you want to watch runs through it.
   */
  allowEffects?: EffectKind[];
  /** Replies to the plugin's fetch calls, for a plugin that polls an API. See FetchResponder. Default: every request hangs until aborted. */
  respondToFetch?: FetchResponder;
  /** Fail when a declared `emits` event was never seen in any scenario. Default false: it is listed in `unexercised`. */
  strictEmits?: boolean;
}

export interface Report {
  plugin: string;
  findings: Finding[];
  /** Things worth reading that are not failures. */
  notes: string[];
  /** Declared emits that no scenario made the plugin emit. The suite cannot vouch for these. */
  unexercised: string[];
  /** What the plugin was seen doing, over all scenarios. */
  observed: { subscribed: string[]; emitted: string[]; capabilities: string[]; effects: EffectKind[] };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const settle = async (ms = 20) => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  await pause(ms);
};

/** Sockets, child processes and watchers that exist now and did not exist before. Waits briefly for a closing one. */
async function leakedSince(before: Map<string, number>): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    const extra = [...liveHandles()].filter(([name, n]) => n > (before.get(name) ?? 0));
    if (extra.length === 0 || i === 9) return extra.map(([name, n]) => `${n - (before.get(name) ?? 0)} x ${name}`);
    await pause(50);
  }
  return [];
}

/** Rule: the manifest is valid for this SDK. */
export function checkManifest(plugin: Plugin): { manifest?: Manifest; findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const parsed = ManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success) {
    for (const i of parsed.error.issues) findings.push({ rule: 'manifest', message: `${i.path.join('.') || 'manifest'}: ${i.message}` });
    return { findings, notes };
  }
  const m = parsed.data;
  if (!SUPPORTED_SDK_MAJORS.includes(m.sdk)) findings.push({ rule: 'manifest', message: `sdk "${m.sdk}" is not supported (supported: ${SUPPORTED_SDK_MAJORS.join(', ')})` });
  else if (DEPRECATED_SDK_MAJORS.includes(m.sdk)) notes.push(`sdk "${m.sdk}" is deprecated: set it to the current major once this suite passes`);
  for (const type of m.emits.filter(isReservedEvent)) findings.push({ rule: 'manifest', message: `emits "${type}", which only the kernel may emit` });
  return { manifest: m, findings, notes };
}

interface RunOutcome {
  rec: Recording;
  effects: Set<EffectKind>;
  registered: boolean;
  registerError?: unknown;
}

/**
 * Load a fresh plugin, register it in a fake kernel, deliver the scenario's events, stop it twice, and report what it did.
 * `expectRegister: false` is for the invalid-config runs, where register() is supposed to throw.
 */
async function run(opts: ConformanceOptions, manifest: Manifest, plugin: Plugin, config: Record<string, unknown>, sc?: Scenario, tag = 'register'): Promise<RunOutcome> {
  const rec = newRecording();
  const effects = new Set<EffectKind>();
  const timers = new Set<NodeJS.Timeout>();
  const before = liveHandles();
  const kernel = createFakeKernel(manifest, config, rec);
  for (const j of sc?.jobs ?? []) kernel.jobs.seed(j);
  let registered = false;
  let registerError: unknown;

  await withEffectsRecorded(effects, timers, async () => {
    try {
      await plugin.register(kernel.ctx);
      registered = true;
    } catch (err) {
      registerError = err;
    }
    if (registered) for (const ev of sc?.events ?? []) await kernel.deliver(ev);
    if (registered && sc?.act) {
      try {
        await sc.act();
      } catch (err) {
        rec.notes.push(`the scenario's act() threw: ${errText(err)}`);
      }
    }
    if (registered && sc?.waitMs) await pause(sc.waitMs);
    // stop() twice: the second call must be harmless. A plugin that never registered must also stop cleanly.
    for (const n of [1, 2]) {
      try {
        await plugin.stop?.();
      } catch (err) {
        rec.findings.push({ rule: 'lifecycle', message: `${tag}: stop() threw on call ${n}: ${errText(err)}` });
      }
    }
    await settle();
  }, opts.respondToFetch, opts.allowEffects);

  // A timer that is still pending and keeps the process alive. Unref'd timers do not count.
  const pending = [...timers].filter((t) => t.hasRef());
  pending.forEach((t) => clearTimeout(t)); // the harness cleans up after a plugin that did not
  const leaked = [...(pending.length ? [`${pending.length} x Timeout`] : []), ...(await leakedSince(before))];
  if (leaked.length) rec.findings.push({ rule: 'lifecycle', message: `${tag}: after stop(), these handles are still open: ${leaked.join(', ')}` });
  return { rec, effects, registered, registerError };
}

/** Run every rule against one plugin and return what was found. Never throws for a rule break. */
export async function checkPlugin(opts: ConformanceOptions): Promise<Report> {
  const first = await opts.load();
  const name = String((first.manifest as { name?: unknown } | undefined)?.name ?? '(unnamed)');
  const { manifest, findings, notes } = checkManifest(first);
  const report: Report = { plugin: name, findings: [...findings], notes: [...notes], unexercised: [], observed: { subscribed: [], emitted: [], capabilities: [], effects: [] } };
  if (!manifest) return report;

  const baseConfig = opts.config ?? {};
  const scenarios: Scenario[] = [{ name: 'register only', events: [] }, ...(opts.scenarios ?? [])];
  const emitted = new Set<string>();
  const subscribed = new Set<string>();
  const usedCaps = new Set<string>();
  const effects = new Set<EffectKind>();
  const add = (f: Finding[], tag: string) => report.findings.push(...f.map((x) => ({ ...x, message: `[${tag}] ${x.message}` })));

  // stop() before register() must not throw either.
  {
    const fresh = await opts.load();
    try {
      await fresh.stop?.();
      await fresh.stop?.();
    } catch (err) {
      report.findings.push({ rule: 'lifecycle', message: `stop() before register() threw: ${errText(err)}` });
    }
  }

  for (const [i, sc] of scenarios.entries()) {
    const plugin = i === 0 ? first : await opts.load();
    const out = await run(opts, manifest, plugin, sc.config ?? baseConfig, sc, sc.name);
    if (!out.registered) {
      report.findings.push({ rule: 'lifecycle', message: `[${sc.name}] register() threw with a config that should be valid: ${errText(out.registerError)}` });
    }
    add(out.rec.findings, sc.name);
    for (const n of out.rec.notes) report.notes.push(`[${sc.name}] ${n}`);
    out.rec.emitted.forEach((t) => emitted.add(t));
    out.rec.subscribed.forEach((t) => subscribed.add(t));
    out.rec.usedCaps.forEach((c) => usedCaps.add(c));
    out.effects.forEach((e) => effects.add(e));
  }
  // The manifest lists every event the plugin can listen for. A setting may choose between two, so the check is
  // against the union over all scenarios: each declared pattern must be subscribed to in at least one of them.
  for (const declared of manifest.subscribes) {
    if (!subscribed.has(declared)) {
      report.findings.push({ rule: 'subscribes', message: `declared subscription "${declared}" but register() never subscribed to it (in any scenario's config)` });
    }
  }

  for (const kind of effects) {
    if (!coveredBy(kind, manifest.needs)) {
      report.findings.push({ rule: 'effects', message: `the plugin used ${kind} but none of its declared needs covers it (needs: ${manifest.needs.join(', ') || 'none'})` });
    }
  }
  for (const need of manifest.needs) {
    if (!usedCaps.has(need)) report.findings.push({ rule: 'needs', message: `declared need "${need}" but the plugin never required or used it` });
  }

  report.observed = { subscribed: [...subscribed].sort(), emitted: [...emitted].sort(), capabilities: [...usedCaps].sort(), effects: [...effects].sort() };
  report.unexercised = manifest.emits.filter((t) => !emitted.has(t));
  if (opts.strictEmits) {
    for (const t of report.unexercised) report.findings.push({ rule: 'emits', message: `declared emit "${t}" was never emitted in any scenario (strictEmits)` });
  }

  for (const bad of opts.invalidConfigs ?? []) {
    const plugin = await opts.load();
    const out = await run(opts, manifest, plugin, bad.config, undefined, `invalid config (${bad.reason})`);
    if (out.registered) {
      report.findings.push({ rule: 'config', message: `accepted an invalid config: ${bad.reason}` });
    } else if (!(out.registerError instanceof Error) || !out.registerError.message.includes(manifest.name)) {
      report.findings.push({ rule: 'config', message: `refused an invalid config (${bad.reason}) without naming the plugin in the error: ${errText(out.registerError)}` });
    }
    // An invalid config that fails halfway must still leave nothing running.
    report.findings.push(...out.rec.findings.filter((f) => f.rule === 'lifecycle').map((f) => ({ ...f, message: `[invalid config] ${f.message}` })));
  }

  return report;
}

import {
  CapabilityDeniedError,
  DuplicatePluginError,
  ManifestError,
  ManifestSchema,
  SDK_VERSION,
  SdkVersionMismatchError,
  UndeclaredEventError,
  UndeclaredSubscriptionError,
  matchesPattern,
  patternCovered,
  type EventHandler,
  type JobsApi,
  type Logger,
  type Manifest,
  type Plugin,
  type PluginContext,
  type StateApi,
} from '@bulig/plugin-sdk';
import type { Bus } from './bus.ts';
import { effectiveCapabilities } from './capabilities.ts';

export interface LoadOptions {
  plugins: Plugin[];
  /** Names of plugins to run. Anything else is skipped. */
  enabled: string[];
  grants: Record<string, string[]>;
  pluginConfig: Record<string, Record<string, unknown>>;
  bus: Bus;
  jobs: JobsApi;
  /** Reads and writes one plugin's state. The kernel passes the store. */
  state: { get(plugin: string, key: string): unknown; set(plugin: string, key: string, value: unknown): void };
  logger: Logger;
}

export interface LoadedPlugin {
  plugin: Plugin;
  manifest: Manifest;
}

// Only the kernel may emit these.
const RESERVED = (type: string) => matchesPattern('kernel.*', type) || matchesPattern('job.*', type) || type === 'plugin.error';

export function parseManifest(plugin: Plugin): Manifest {
  const parsed = ManifestSchema.safeParse(plugin.manifest);
  const name = (plugin.manifest as { name?: unknown } | undefined)?.name;
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ');
    throw new ManifestError(`Invalid manifest for plugin "${String(name)}": ${issues}`);
  }
  const m = parsed.data;
  if (m.sdk !== SDK_VERSION) {
    throw new SdkVersionMismatchError(`Plugin "${m.name}" targets sdk ${m.sdk}, this kernel runs sdk ${SDK_VERSION}`);
  }
  const reserved = m.emits.find(RESERVED);
  if (reserved) throw new ManifestError(`Plugin "${m.name}" may not emit kernel event "${reserved}"`);
  return m;
}

/** Validate and select the plugins to run. Does not call register(). */
export function selectPlugins(plugins: Plugin[], enabled: string[]): LoadedPlugin[] {
  const seen = new Set<string>();
  for (const p of plugins) {
    const name = (p.manifest as { name?: string } | undefined)?.name;
    if (name === undefined) continue;
    if (seen.has(name)) throw new DuplicatePluginError(`Duplicate plugin name: ${name}`);
    seen.add(name);
  }
  return plugins
    .filter((p) => enabled.includes((p.manifest as { name?: string }).name ?? ''))
    .map((plugin) => ({ plugin, manifest: parseManifest(plugin) }));
}

/** A context that can only do what this one manifest declares. */
export function buildContext(manifest: Manifest, opts: Omit<LoadOptions, 'plugins' | 'enabled'>): PluginContext {
  const caps = effectiveCapabilities(manifest, opts.grants);
  const name = manifest.name;
  return {
    on(pattern: string, handler: EventHandler) {
      if (!patternCovered(manifest.subscribes, pattern)) {
        throw new UndeclaredSubscriptionError(`Plugin "${name}" did not declare a subscription to "${pattern}"`);
      }
      opts.bus.subscribe(name, pattern, handler);
    },
    emit(type, payload, jobId) {
      if (!manifest.emits.includes(type)) {
        throw new UndeclaredEventError(`Plugin "${name}" did not declare emitting "${type}"`);
      }
      opts.bus.emitFrom(name, caps, { type, payload, jobId });
    },
    can: (cap) => caps.has(cap),
    require(cap) {
      if (!caps.has(cap)) {
        const why = manifest.needs.includes(cap) ? 'declared but not granted' : 'not declared in needs';
        throw new CapabilityDeniedError(`Plugin "${name}" was denied "${cap}" (${why})`);
      }
    },
    jobs: opts.jobs,
    state: {
      get: (key) => opts.state.get(name, key),
      set: (key, value) => opts.state.set(name, key, value),
    } as StateApi,
    log: opts.logger,
    config: opts.pluginConfig[name] ?? {},
  };
}

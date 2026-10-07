import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

export const BUILTIN_PLUGINS = ['channel-cli', 'worker-claude-code', 'github', 'pipeline-dev'] as const;
/** Plugins the CLI ships but leaves off until the config turns them on, because they need setup. */
export const OPT_IN_PLUGINS = ['channel-telegram'] as const;

const ConfigSchema = z.object({
  dbPath: z.string().optional(),
  enabled: z.array(z.string()).optional(),
  grants: z.record(z.string(), z.array(z.string())).optional(),
  pluginConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  eventCapabilities: z.record(z.string(), z.string()).optional(),
});

export interface BuligConfig {
  dbPath: string;
  enabled: string[];
  grants: Record<string, string[]>;
  pluginConfig: Record<string, Record<string, unknown>>;
  /** Extra or changed event-to-capability rules, merged over the kernel defaults. */
  eventCapabilities: Record<string, string>;
}

export class ConfigError extends Error {}

export const defaultDbPath = (home: string) => join(home, '.bulig', 'bulig.sqlite');

const expand = (p: string, home: string, base: string) => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
};

/** Look for bulig.config.json in the working directory, then ~/.bulig/config.json. */
export function findConfigFile(cwd: string, home: string): string | undefined {
  return [join(cwd, 'bulig.config.json'), join(home, '.bulig', 'config.json')].find((p) => existsSync(p));
}

export function loadConfig(cwd: string, home: string): { config: BuligConfig; path: string } {
  const path = findConfigFile(cwd, home);
  if (!path) {
    throw new ConfigError(
      `No config found. Looked for ${join(cwd, 'bulig.config.json')} and ${join(home, '.bulig', 'config.json')}. ` +
        'Copy bulig.config.example.json and edit it.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
    throw new ConfigError(`Bad config ${path}: ${issues}`);
  }
  const c = parsed.data;
  const enabled = c.enabled ?? [...BUILTIN_PLUGINS];
  const shipped: readonly string[] = [...BUILTIN_PLUGINS, ...OPT_IN_PLUGINS];
  const unknown = enabled.filter((n) => !shipped.includes(n));
  if (unknown.length) throw new ConfigError(`Config enables plugins this CLI does not ship: ${unknown.join(', ')}`);
  return {
    path,
    config: {
      dbPath: expand(c.dbPath ?? defaultDbPath(home), home, dirname(path)),
      enabled,
      grants: c.grants ?? {},
      pluginConfig: c.pluginConfig ?? {},
      eventCapabilities: c.eventCapabilities ?? {},
    },
  };
}

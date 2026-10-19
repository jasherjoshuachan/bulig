import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** The two checks that sit between the worker and the pipeline. Both are on by default, in `warn` mode. */
export const GATE_PLUGINS = ['gate-evidence', 'gate-promise'] as const;
/** What runs when the config has no `enabled` list. The gates are in it; see `defaultEnabled` for how to leave one out. */
export const BUILTIN_PLUGINS = ['channel-cli', 'worker-claude-code', ...GATE_PLUGINS, 'github', 'pipeline-dev'] as const;
/** Plugins the CLI ships but leaves off until the config turns them on, because they need setup. */
export const OPT_IN_PLUGINS = ['channel-telegram'] as const;
/** Plugins only `serve` loads, off until the config enables them: the endpoint for workers on other machines (ADR 0011). */
export const SERVER_PLUGINS = ['worker-gateway'] as const;

/**
 * Where the kernel keeps its record. SQLite at `dbPath` is the default. For Postgres the config holds only the NAME of the
 * environment variable that carries the connection string, so a password never lands in a file that gets committed or copied.
 */
const StoreSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sqlite') }),
  z.strictObject({
    kind: z.literal('postgres'),
    urlEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'urlEnv is the name of an environment variable, such as BULIG_DATABASE_URL, not the connection string'),
    /** A file in $CREDENTIALS_DIRECTORY (systemd LoadCredential=) that holds the connection string, for a server. When the file is there it wins over `urlEnv`. */
    urlCredential: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'urlCredential is a file name such as pg-url, not a path or the connection string')
      .optional(),
  }),
]);
export type StoreConfig = z.infer<typeof StoreSchema>;

const ConfigSchema = z.object({
  store: StoreSchema.optional(),
  dbPath: z.string().optional(),
  enabled: z.array(z.string()).optional(),
  grants: z.record(z.string(), z.array(z.string())).optional(),
  pluginConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  eventCapabilities: z.record(z.string(), z.string()).optional(),
});

export interface BuligConfig {
  /** Which store the kernel runs on. `sqlite` (the default) uses the file at `dbPath`; `postgres` reads its connection string from the variable `urlEnv` names. */
  store: StoreConfig;
  dbPath: string;
  enabled: string[];
  grants: Record<string, string[]>;
  pluginConfig: Record<string, Record<string, unknown>>;
  /** Extra or changed event-to-capability rules, merged over the kernel defaults. */
  eventCapabilities: Record<string, string>;
}

export class ConfigError extends Error {}

export const defaultDbPath = (home: string) => join(home, '.bulig', 'bulig.sqlite');

/**
 * The `enabled` list when the config does not write one: the built-ins, gates included. A gate leaves the default list when
 * its own config says `"enabled": false`, so that line is the one switch for "this gate off". A config that does write `enabled`
 * is taken exactly as written: a gate it does not list stays off, whatever `pluginConfig` says.
 */
export function defaultEnabled(pluginConfig: Record<string, Record<string, unknown>>): string[] {
  return BUILTIN_PLUGINS.filter((n) => !(GATE_PLUGINS as readonly string[]).includes(n) || pluginConfig[n]?.enabled !== false);
}

const expand = (p: string, home: string, base: string) => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
};

type Env = Record<string, string | undefined>;

/**
 * Where the config comes from, first match wins:
 *  1. `$CREDENTIALS_DIRECTORY/config`: a systemd credential (LoadCredential=config:/etc/bulig/config.json). The directory is made
 *     by systemd and private to the unit, so its mode is not checked.
 *  2. The file `$BULIG_CONFIG` names. It must be a regular file that only its owner can read or write, like a token file, because
 *     the config says where the secrets are. A path that is set but missing is an error, not a reason to look elsewhere.
 *  3. bulig.config.json in the working directory.
 *  4. ~/.bulig/config.json.
 * Nothing set: 3 and 4, as before.
 */
export function findConfigFile(cwd: string, home: string, env: Env = process.env): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (dir) {
    const credential = join(dir, 'config');
    try {
      if (lstatSync(credential).isFile()) return credential;
    } catch {
      // no such credential: look further
    }
  }
  if (env.BULIG_CONFIG) {
    const file = resolve(cwd, env.BULIG_CONFIG);
    let st;
    try {
      st = lstatSync(file);
    } catch {
      throw new ConfigError(`BULIG_CONFIG names ${file}, which does not exist.`);
    }
    if (!st.isFile()) throw new ConfigError(`BULIG_CONFIG names ${file}, which is not a regular file.`);
    if (st.mode & 0o077) throw new ConfigError(`BULIG_CONFIG names ${file}, which can be read or written by its group or by anyone. Make it readable by its owner only (chmod 600).`);
    return file;
  }
  return [join(cwd, 'bulig.config.json'), join(home, '.bulig', 'config.json')].find((p) => existsSync(p));
}

export function loadConfig(cwd: string, home: string, env: Env = process.env): { config: BuligConfig; path: string } {
  const path = findConfigFile(cwd, home, env);
  if (!path) {
    throw new ConfigError(
      `No config found. Looked for ${env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'config') : '$CREDENTIALS_DIRECTORY/config'}, $BULIG_CONFIG, ${join(cwd, 'bulig.config.json')} and ${join(home, '.bulig', 'config.json')}. ` +
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
  const enabled = c.enabled ?? defaultEnabled(c.pluginConfig ?? {});
  const shipped: readonly string[] = [...BUILTIN_PLUGINS, ...OPT_IN_PLUGINS, ...SERVER_PLUGINS];
  const unknown = enabled.filter((n) => !shipped.includes(n));
  if (unknown.length) throw new ConfigError(`Config enables plugins this CLI does not ship: ${unknown.join(', ')}`);
  return {
    path,
    config: {
      store: c.store ?? { kind: 'sqlite' },
      dbPath: expand(c.dbPath ?? defaultDbPath(home), home, dirname(path)),
      enabled,
      grants: c.grants ?? {},
      pluginConfig: c.pluginConfig ?? {},
      eventCapabilities: c.eventCapabilities ?? {},
    },
  };
}

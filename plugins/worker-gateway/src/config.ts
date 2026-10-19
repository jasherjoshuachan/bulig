import { lstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { isLoopbackOrTailnet, isWildcard } from './address.ts';
import { readCredential } from '@bulig/worker-claude-code';
import { z } from 'zod';

/** The default port for the worker endpoint. */
export const DEFAULT_PORT = 7431;
/** The id the in-process worker answers to. A remote worker may not use it. */
export const LOCAL_WORKER = 'local';

const WORKER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Shorter than this and a token is not a token. */
export const MIN_TOKEN_LENGTH = 16;

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(`worker-gateway: ${message}`);
    this.name = 'GatewayConfigError';
  }
}

/**
 * Throws for an address the endpoint must not bind. Only the places a token may safely travel are accepted: this machine (127.0.0.0/8,
 * ::1) and the Tailscale tunnel (100.64.0.0/10, fd7a:115c:a1e0::/48). Everything else is refused: "every interface" (0.0.0.0, ::),
 * a public or LAN address, a name. IPv4 written as ::ffff:a.b.c.d is refused too: spell it as IPv4.
 */
export function assertBindable(address: string): string {
  const bare = address.replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (isIP(bare) === 0) throw new GatewayConfigError(`listen address ${JSON.stringify(address)} is not an IP address. Use 127.0.0.1 or the Tailscale address, not a name.`);
  if (isWildcard(bare)) {
    throw new GatewayConfigError(`listen address ${JSON.stringify(address)} would accept connections on every interface. Name the address to listen on (127.0.0.1, or the Tailscale address).`);
  }
  if (!isLoopbackOrTailnet(bare)) {
    throw new GatewayConfigError(`listen address ${JSON.stringify(address)} is neither this machine nor the Tailscale tunnel (127.0.0.0/8, ::1, 100.64.0.0/10, fd7a:115c:a1e0::/48), so a worker token could cross an open network. Use one of those.`);
  }
  return bare;
}

const Worker = z.strictObject({
  /**
   * Where the worker's token comes from. Name at least one. When more than one is given and found, a file wins over the environment:
   * the server keeps tokens in files (systemd LoadCredential=) and the Mac keeps them in environment variables.
   *  - credential: a file name in $CREDENTIALS_DIRECTORY holding one `id=token` line per worker (the unit's "worker-tokens").
   *  - tokenFile: an absolute path to a file that holds just this worker's token.
   *  - tokenEnv: the NAME of an environment variable that holds the token.
   */
  credential: z.string().min(1).optional(),
  tokenFile: z.string().min(1).optional(),
  tokenEnv: z.string().regex(ENV_NAME, 'tokenEnv is the NAME of an environment variable that holds the token, not the token').optional(),
  /** Most stages this worker may hold at once. Capped further by what the worker itself asks for. */
  slots: z.number().int().min(1).max(16).optional(),
  /** Only offer this worker stages of these repositories (the repo path on the kernel's machine). */
  projects: z.array(z.string().min(1)).optional(),
});

const Schema = z.strictObject({
  listen: z.array(z.string()).min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  workers: z.record(z.string(), Worker).optional(),
  /** Stages the in-process worker may run at once. 0 sends every stage to a remote worker. Default 2. */
  localSlots: z.number().int().min(0).max(16).optional(),
  /** Default most stages one remote worker may hold at once. Default 2. */
  workerSlots: z.number().int().min(1).max(16).optional(),
  /** How long one claim waits for a stage before it answers 204. Default 25000. */
  claimWaitMs: z.number().int().min(0).max(60_000).optional(),
  /** How often a worker should heartbeat. Default 10000. */
  heartbeatMs: z.number().int().min(20).max(60_000).optional(),
  /** A worker that has not been heard from for this long loses its stage. Default 30000. */
  heartbeatTimeoutMs: z.number().int().min(100).max(600_000).optional(),
  /** The most a patch (the repository state sent to a worker, or the changes it sends back) may weigh. Default 8 MiB. */
  maxPatchBytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
  /** The branch the job worktree started from, when it is not origin's default. */
  baseBranch: z.string().min(1).optional(),
});

function readTokenFile(path: string): string | undefined {
  if (!isAbsolute(path)) throw new GatewayConfigError(`tokenFile ${JSON.stringify(path)} must be an absolute path`);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!st.isFile()) throw new GatewayConfigError(`tokenFile ${JSON.stringify(path)} is not a regular file`);
  if (st.mode & 0o077) throw new GatewayConfigError(`tokenFile ${JSON.stringify(path)} can be read or written by its group or by anyone. Make it readable by its owner only (chmod 600).`);
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '') || undefined;
}

/** `id=token` lines. Blank lines and lines starting with # are skipped. */
export function parseTokenMap(textValue: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of textValue.split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9_-]*)=(.+)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** A worker's token, from its first source that has one: a credential file, a token file, then the environment. Errors name the source, never the value. */
function resolveToken(id: string, w: z.infer<typeof Worker>, env: Record<string, string | undefined>): string | undefined {
  if (w.credential) {
    const file = readCredential(w.credential, env);
    const t = file === undefined ? undefined : parseTokenMap(file).get(id);
    if (t) return t;
  }
  if (w.tokenFile) {
    const t = readTokenFile(w.tokenFile);
    if (t) return t;
  }
  return w.tokenEnv ? env[w.tokenEnv] : undefined;
}

export interface WorkerEntry {
  id: string;
  token: string;
  slots: number;
  projects: string[] | undefined;
}

export interface GatewayConfig {
  listen: string[];
  port: number;
  workers: WorkerEntry[];
  localSlots: number;
  claimWaitMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  maxPatchBytes: number;
  baseBranch: string | undefined;
}

/** Check the config and read the tokens from the environment. Any problem throws a GatewayConfigError that names the setting, never a token. */
export function parseGatewayConfig(raw: Record<string, unknown>, env: Record<string, string | undefined> = process.env): GatewayConfig {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    throw new GatewayConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '));
  }
  const c = parsed.data;
  const listen = (c.listen ?? ['127.0.0.1']).map(assertBindable);
  if (new Set(listen).size !== listen.length) throw new GatewayConfigError('listen names the same address twice');
  const heartbeatMs = c.heartbeatMs ?? 10_000;
  const heartbeatTimeoutMs = c.heartbeatTimeoutMs ?? 30_000;
  // The same rule as the executor lease: one missed beat must not lose the stage.
  if (heartbeatMs * 2 > heartbeatTimeoutMs) {
    throw new GatewayConfigError(`heartbeatMs (${heartbeatMs}) must be less than half of heartbeatTimeoutMs (${heartbeatTimeoutMs}), so one missed beat does not lose the stage`);
  }
  const defaultSlots = c.workerSlots ?? 2;
  const seen = new Map<string, string>();
  const workers: WorkerEntry[] = [];
  for (const [id, w] of Object.entries(c.workers ?? {})) {
    if (!WORKER_ID.test(id) || id === LOCAL_WORKER) throw new GatewayConfigError(`worker id ${JSON.stringify(id)} must be lowercase letters, digits, - or _ (at most 32), and not "${LOCAL_WORKER}"`);
    const where = [w.credential && `credential ${w.credential}`, w.tokenFile && `tokenFile ${w.tokenFile}`, w.tokenEnv && `variable ${w.tokenEnv}`].filter(Boolean).join(', ');
    if (!where) throw new GatewayConfigError(`worker "${id}": name where its token comes from (credential, tokenFile or tokenEnv)`);
    const token = resolveToken(id, w, env);
    if (!token) throw new GatewayConfigError(`worker "${id}": no token found (looked at ${where})`);
    if (token.length < MIN_TOKEN_LENGTH) throw new GatewayConfigError(`worker "${id}": its token is shorter than ${MIN_TOKEN_LENGTH} characters`);
    const twin = seen.get(token);
    if (twin) throw new GatewayConfigError(`workers "${twin}" and "${id}" share one token. Each worker needs its own.`);
    seen.set(token, id);
    workers.push({ id, token, slots: w.slots ?? defaultSlots, projects: w.projects });
  }
  return {
    listen,
    port: c.port ?? DEFAULT_PORT,
    workers,
    localSlots: c.localSlots ?? 2,
    claimWaitMs: c.claimWaitMs ?? 25_000,
    heartbeatMs,
    heartbeatTimeoutMs,
    maxPatchBytes: c.maxPatchBytes ?? 8 * 1024 * 1024,
    baseBranch: c.baseBranch,
  };
}

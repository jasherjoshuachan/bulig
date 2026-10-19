import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Names systemd's LoadCredential= may hand the kernel: the Postgres URL, the worker tokens, and Claude's login token. */
export const CREDENTIAL_NAMES = ['pg-url', 'worker-tokens', 'claude-token'] as const;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A secret from `$CREDENTIALS_DIRECTORY/<name>`, the place systemd puts a unit's LoadCredential= files (root-owned source, a private
 * in-memory copy for the unit). Undefined when there is no such directory or file, so the same code runs on the Mac, where secrets
 * come from environment variables set by a wrapper script. The name is a plain file name: no slashes, no "..". Only a regular file
 * is read, never a link. The value is returned and never stored in process.env, so it cannot reach a child by inheritance.
 */
export function readCredential(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir || !SAFE_NAME.test(name)) return undefined;
  const path = join(dir, name);
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

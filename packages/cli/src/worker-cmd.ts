import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startRemoteWorker } from '@bulig/worker-gateway/client';
import { ConfigError, loadConfig } from './config.ts';
import type { Io } from './commands.ts';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A secret kept in a file (a systemd credential on the server). Errors name the flag and the path, never the value. */
function readSecretFile(flag: string, path: string, cwd: string): string {
  const file = resolve(cwd, path);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    throw new ConfigError(`${flag} ${file} does not exist`);
  }
  if (!st.isFile()) throw new ConfigError(`${flag} ${file} is not a regular file`);
  if (st.mode & 0o077) throw new ConfigError(`${flag} ${file} can be read or written by its group or by anyone. Make it readable by its owner only (chmod 600).`);
  const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw new ConfigError(`${flag} ${file} is empty`);
  return value;
}

/**
 * `bulig worker`: run the same Claude stages the in-process worker runs, for a kernel on another machine (ADR 0011). The worker has
 * its own clone of each repository, a token for the kernel, and no access to the database.
 */
export async function cmdWorker(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      kernel: { type: 'string' },
      id: { type: 'string' },
      'token-env': { type: 'string' },
      'token-file': { type: 'string' },
      'claude-token-file': { type: 'string' },
      slots: { type: 'string' },
      repo: { type: 'string', multiple: true },
      'allow-http-host': { type: 'string', multiple: true },
      'work-dir': { type: 'string' },
      workdir: { type: 'string' },
      'claude-bin': { type: 'string' },
    },
    strict: true,
  });
  const usage =
    'usage: bulig worker --kernel <url> --id <workerId> (--token-env <VAR> | --token-file <path>) [--slots 2] --repo <kernelPath>=<localClone> [--repo ...] [--work-dir <dir>] [--claude-token-file <path>]';
  const tokenEnv = values['token-env'];
  const tokenFile = values['token-file'];
  if (!values.kernel || !values.id || (tokenEnv === undefined) === (tokenFile === undefined)) throw new ConfigError(usage);
  if (!ID.test(values.id)) throw new ConfigError(`--id must be lowercase letters, digits, - or _ (at most 32), not ${JSON.stringify(values.id)}`);
  let token: string | undefined;
  if (tokenFile !== undefined) {
    token = readSecretFile('--token-file', tokenFile, io.cwd);
  } else {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv!)) throw new ConfigError('--token-env is the NAME of an environment variable, not the token');
    token = (io.env ?? process.env)[tokenEnv!];
    if (!token) throw new ConfigError(`the environment variable ${tokenEnv} is not set. On the Mac, start the worker with scripts/worker-with-keychain.sh.`);
  }
  if (token.length < 16) throw new ConfigError('the worker token is shorter than 16 characters');
  const claudeToken = values['claude-token-file'] ? readSecretFile('--claude-token-file', values['claude-token-file'], io.cwd) : undefined;
  if (values['work-dir'] && values.workdir) throw new ConfigError('give --work-dir or --workdir, not both');
  const workDir = values['work-dir'] ?? values.workdir;
  const slots = values.slots === undefined ? 2 : Number(values.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 16) throw new ConfigError('--slots must be a whole number from 1 to 16');
  if (!values.repo?.length) throw new ConfigError(`name at least one repository this machine has a clone of. ${usage}`);
  const repos: Record<string, string> = {};
  for (const pair of values.repo) {
    const at = pair.indexOf('=');
    const kernelPath = at > 0 ? pair.slice(0, at) : '';
    const local = at > 0 ? pair.slice(at + 1) : '';
    if (!kernelPath || !local || !isAbsolute(kernelPath)) throw new ConfigError(`--repo ${JSON.stringify(pair)} must be <absolute path on the kernel's machine>=<clone on this machine>`);
    repos[kernelPath] = resolve(io.cwd, local);
  }

  // Claude's own settings come from the same config file the in-process worker reads, when there is one.
  let claude: Record<string, unknown> = {};
  try {
    claude = loadConfig(io.cwd, io.home).config.pluginConfig['worker-claude-code'] ?? {};
  } catch (err) {
    if (!(err instanceof ConfigError && err.message.startsWith('No config found'))) throw err;
  }
  const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

  let stop: () => void = () => {};
  const stopped = new Promise<void>((r) => (stop = r));
  const worker = startRemoteWorker({
    kernelUrl: values.kernel,
    workerId: values.id,
    token,
    slots,
    repos,
    workdir: workDir ? resolve(io.cwd, workDir) : join(io.home, '.bulig', 'worker', values.id),
    claudeToken,
    allowHttpHosts: values['allow-http-host'],
    claudeBin: values['claude-bin'] ?? (typeof claude.claudeBin === 'string' ? claude.claudeBin : undefined),
    timeoutMs: typeof claude.timeoutMs === 'number' ? claude.timeoutMs : undefined,
    extraArgs: strs(claude.extraArgs),
    passEnv: strs(claude.passEnv),
    allowDomains: strs(claude.allowDomains),
    env: io.env as NodeJS.ProcessEnv | undefined,
    log: (line) => io.err(`bulig worker: ${line}`),
  });
  const forget = io.onStop?.(stop);
  io.out(`bulig: worker ${values.id} is asking ${values.kernel} for stages (${slots} slot${slots === 1 ? '' : 's'}). Stop with Ctrl-C.`);
  try {
    await stopped;
    io.out('bulig: worker stopping. Stages in flight are offered again by the kernel.');
  } finally {
    forget?.();
    await worker.stop();
  }
  return 0;
}

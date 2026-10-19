import { spawn } from 'node:child_process';

// THE way the kernel runs git. Every git command the kernel's plugins run (the github plugin's worktrees, commits, pushes; the worker
// gateway's patches) is built here, so one list says what a repository's own config and the environment may not change. This module
// must stay the only place that builds a git command line for the kernel: a git call made some other way would run a repository's
// fsmonitor, pager, editor, external diff or hook outside every sandbox. (Claude's own git calls run inside Claude's sandbox and are
// not the kernel's.)
//
// The kernel's repositories are kernel-only on the server (no folder is shared with a worker), so their own config is trusted no
// further than this list: anything below that a repo config could set is overridden on the command line, and the command line wins.

/** `-c key=value` pairs put in front of every kernel git command. */
export const HARDENING: readonly string[] = [
  'core.hooksPath=/dev/null', // no hook runs: a job folder is written by a Claude stage
  'core.fsmonitor=false', // fsmonitor is a program git runs on status/add
  'core.sshCommand=ssh', // not a program named by a config file
  'core.pager=cat',
  'core.editor=true',
  'gpg.program=gpg',
  'commit.gpgsign=false',
  'protocol.ext.allow=never', // ext:: remotes run commands
];

/**
 * Commands that can run an external diff program named by diff.external or GIT_EXTERNAL_DIFF. An empty `-c diff.external=` does not
 * switch it off (git then tries to run a program called ""), so these get `--no-ext-diff` instead, which does.
 */
const MAY_RUN_EXTERNAL_DIFF = new Set(['diff', 'log', 'show', 'diff-tree', 'diff-files', 'diff-index', 'format-patch']);

/** Environment variables that change what git runs or where. Dropped from the inherited environment on every call. */
const DROPPED_ENV = /^(GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_SYSTEM|GIT_CONFIG_GLOBAL|GIT_PROXY_COMMAND)$/;
/** Dropped as well when the call does not talk to a remote. */
const DROPPED_LOCAL_ENV = /^(GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS)$/;

export interface KernelGitOptions {
  /**
   * The call talks to a remote (a push or a fetch), or must use the machine user's own identity: the user's global git config is
   * kept, because it holds the credential helper and the author. Everything else runs with no global config at all.
   */
  ambientConfig?: boolean;
  /** Variables added after the inherited ones are cleaned, for example a GIT_INDEX_FILE the caller chose. */
  env?: NodeJS.ProcessEnv;
  /** The environment to start from. Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** The full argument list and environment for one kernel git command. Use with any spawner. */
export function kernelGit(args: readonly string[], opts: KernelGitOptions = {}): { args: string[]; env: NodeJS.ProcessEnv } {
  const ambient = opts.ambientConfig === true;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) {
    if (v === undefined || DROPPED_ENV.test(k) || (!ambient && DROPPED_LOCAL_ENV.test(k))) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  if (!ambient) env.GIT_CONFIG_GLOBAL = '/dev/null';
  const config = ambient ? HARDENING : [...HARDENING, 'credential.helper='];
  // The command name is the first word that is not an option or the value of a `-c`.
  const verb = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
  const command = verb !== -1 && MAY_RUN_EXTERNAL_DIFF.has(args[verb]!) ? [...args.slice(0, verb + 1), '--no-ext-diff', ...args.slice(verb + 1)] : [...args];
  return { args: [...config.flatMap((c) => ['-c', c]), ...command], env: { ...env, ...opts.env } };
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** True when the output went past `maxOut` and the command was stopped. */
  truncated: boolean;
}

/** Run git for the kernel: no shell, the hardening above, at most `maxOut` bytes of output kept. */
export function git(cwd: string, args: string[], opts: KernelGitOptions & { input?: Buffer; maxOut?: number; bin?: string } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const maxOut = opts.maxOut ?? 16 * 1024 * 1024;
    const cmd = kernelGit(['-c', 'core.quotepath=false', ...args], opts);
    const child = spawn(opts.bin ?? 'git', cmd.args, { cwd, env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxOut) {
        if (!truncated) {
          truncated = true;
          child.kill('SIGKILL');
        }
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', reject);
    // 'close', not 'exit': the output is all in by then.
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: stderr.trim(), truncated }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  });
}

export const gitText = (r: GitResult): string => (r.stderr || r.stdout.toString('utf8')).trim().slice(0, 500);

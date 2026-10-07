import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';

export type StageMode = 'readonly' | 'edit';

export interface StageRequest {
  stage: string;
  prompt: string;
  model: string;
  mode: StageMode;
  cwd: string;
}

export interface WorkerConfig {
  claudeBin?: string;
  timeoutMs?: number;
  /** Extra flags added to every run, for example ["--setting-sources", "project,local"]. */
  extraArgs?: string[];
  /**
   * Names of environment variables to hand to Claude on top of the built-in list. This is how a
   * secret-looking variable (for example a cloud key for a Bedrock setup) is let through on purpose.
   * GH_TOKEN, GITHUB_TOKEN and BULIG_* can never be passed, even from here.
   */
  passEnv?: string[];
  /**
   * Extra hosts a sandboxed command may reach, on top of the npm registry. GitHub hosts are refused here:
   * an entry that names one is dropped.
   */
  allowDomains?: string[];
  /** On stop, how long a run gets after SIGTERM before it is killed with SIGKILL, in ms. Default 10000. */
  stopGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 3000;
const STOP_GRACE_MS = 10_000;

/** Tools a read-only stage may use. It can look at the code and the git history, nothing else. */
export const READONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(ls *)',
];

/** Tools an edit stage may use. Edits plus git (no push) and the common test runners. */
export const EDIT_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(pnpm *)',
  'Bash(npm *)',
  'Bash(node *)',
  'Bash(npx vitest *)',
  'Bash(npx jest *)',
  'Bash(pytest *)',
  'Bash(python -m pytest *)',
  'Bash(bash scripts/verify.sh)',
  'Bash(ls *)',
];

/** Commands an edit stage must never run, even when a broader allow rule would cover them. */
export const EDIT_DENIED_TOOLS = ['Bash(git push*)', 'Bash(gh *)', 'Bash(curl *)'];

// ----- the environment Claude runs in -----

/** Variables every run gets, when they are set. */
const ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'SHELL']);
const ENV_ALLOW_PREFIXES = ['LC_'];
/** Claude Code's own settings travel by these prefixes. */
const CLAUDE_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
/** The only secret-looking Claude variables that pass: the ways Claude Code logs in from the environment. */
const CLAUDE_AUTH = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const SECRET_LOOKING = /TOKEN|SECRET|PASSWORD|KEY/i;
/** Never reach a Claude session, whatever passEnv says. */
const NEVER_PASS = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|BULIG_.*)$/;

/**
 * The environment for a Claude child. It starts empty and takes only what is allowed: a short list of
 * basics, Claude Code's own settings and login variables, and whatever the config names in passEnv.
 * The GitHub token and anything Bulig itself holds never go in.
 */
export function buildEnv(source: NodeJS.ProcessEnv, passEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const extra = new Set(passEnv);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || NEVER_PASS.test(name)) continue;
    const basic = ENV_ALLOW.has(name) || ENV_ALLOW_PREFIXES.some((p) => name.startsWith(p));
    const claude = CLAUDE_PREFIXES.some((p) => name.startsWith(p)) && (!SECRET_LOOKING.test(name) || CLAUDE_AUTH.has(name));
    if (basic || claude || extra.has(name)) out[name] = value;
  }
  return out;
}

/**
 * Layer 2 of keeping an edit stage away from GitHub: the ambient credentials. HOME stays, because Claude Code
 * needs it to log in, and the signed-in gh and git's credential helper live under it. So gh gets an empty
 * config dir, git gets no global or system config and no credential helper, and nothing can prompt or ask
 * an agent for a password. `ghConfigDir` must be a fresh empty directory made for this one run.
 */
export function hardenEnv(env: NodeJS.ProcessEnv, ghConfigDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(GIT_|GH_|GITHUB_|SSH_|SSH$)/.test(name)) continue;
    out[name] = value;
  }
  return {
    ...out,
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    // Same as `git -c credential.helper=`: an empty value clears every helper set at any other level.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/** Hosts a sandboxed command may never reach, whatever the config says. */
export const GITHUB_HOSTS = ['github.com', '*.github.com', 'api.github.com', 'githubusercontent.com', '*.githubusercontent.com'];
/** Hosts a sandboxed command may reach: Claude's own API and the npm registry. Everything else is refused. */
export const BASE_ALLOWED_DOMAINS = ['api.anthropic.com', 'registry.npmjs.org'];
/** Credential files a sandboxed command may not even read. */
export const DENY_READ = ['~/.config/gh', '~/.ssh', '~/.git-credentials', '~/.netrc', '~/.gitconfig', '~/.config/git'];

const isGithubHost = (d: string) => /(^|\.)(github\.com|githubusercontent\.com)$/i.test(d.replace(/^\*\./, ''));

/**
 * Layer 1: Claude Code's own OS sandbox (Seatbelt on macOS, bubblewrap on Linux) around every Bash command of
 * every stage, so `node`, `npm` and `pnpm` are fenced in too, not just the commands named in a deny list.
 * It is passed with --settings, so no project or user file can turn it off.
 *  - strictAllowlist: a host outside allowedDomains is refused, never prompted for.
 *  - allowUnsandboxedCommands false and no excludedCommands: nothing runs outside the sandbox.
 *  - failIfUnavailable: if the sandbox cannot start, Claude exits instead of running unfenced.
 *  - disableAllHooks: Claude Code hooks run outside the sandbox, so a hook in a repo's settings could reach GitHub.
 *  - autoAllowBashIfSandboxed false: the allowed-tools list still decides which commands run at all.
 */
export function sandboxSettings(extraDomains: readonly string[] = []): Record<string, unknown> {
  const allowed = [...new Set([...BASE_ALLOWED_DOMAINS, ...extraDomains.filter((d) => !isGithubHost(d))])];
  return {
    // Hooks from user or project settings run outside the sandbox, so none may run in a stage.
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      network: { allowedDomains: allowed, deniedDomains: GITHUB_HOSTS, strictAllowlist: true },
      filesystem: { denyRead: DENY_READ },
    },
  };
}

/**
 * The argument list for one run. Every run is a fresh session: there is no resume or continue flag,
 * so a reviewer never sees the build session's context.
 */
export function buildArgs(req: StageRequest, extra: string[] = [], allowDomains: readonly string[] = []): string[] {
  const args = ['-p', req.prompt, '--output-format', 'json', '--model', req.model, '--settings', JSON.stringify(sandboxSettings(allowDomains))];
  if (req.mode === 'edit') {
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', EDIT_TOOLS.join(','), '--disallowedTools', EDIT_DENIED_TOOLS.join(','));
  } else {
    args.push('--permission-mode', 'plan', '--allowedTools', READONLY_TOOLS.join(','));
  }
  return [...args, ...extra];
}

export interface RunResult {
  ok: boolean;
  result: string;
  costUsd?: number;
  sessionId?: string;
  error?: string;
}

/** Parse the single JSON object `claude -p --output-format json` prints. */
export function parseClaudeOutput(stdout: string): RunResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return { ok: false, result: '', error: `claude printed output that is not JSON: ${stdout.trim().slice(0, 300)}` };
  }
  const result = typeof data.result === 'string' ? data.result : '';
  const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
  const costUsd = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined;
  if (data.is_error === true) {
    return { ok: false, result, error: result || 'claude reported an error', ...(sessionId && { sessionId }) };
  }
  return { ok: true, result, ...(sessionId && { sessionId }), ...(costUsd !== undefined && { costUsd }) };
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  children: Set<ChildProcess>,
  onSpawn: (child: ChildProcess) => () => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // A fresh, empty gh config dir for this one run, so no signed-in gh state can be found under HOME.
    let ghDir: string;
    try {
      ghDir = mkdtempSync(join(tmpdir(), 'bulig-gh-'));
    } catch (err) {
      resolve({ ok: false, result: '', error: `could not make a temp dir: ${(err as Error).message}` });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: hardenEnv(env, ghDir), detached: true });
    } catch (err) {
      rmSync(ghDir, { recursive: true, force: true });
      resolve({ ok: false, result: '', error: `could not start ${bin}: ${(err as Error).message}` });
      return;
    }
    children.add(child);
    const untrack = onSpawn(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      untrack();
      rmSync(ghDir, { recursive: true, force: true });
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, 'SIGTERM');
      setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => done({ ok: false, result: '', error: `could not start ${bin}: ${err.message}` }));
    child.on('close', (code) => {
      if (timedOut) return done({ ok: false, result: '', error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      const parsed = parseClaudeOutput(stdout);
      if (code !== 0) {
        const why = stderr.trim().slice(0, 300) || parsed.error || 'no output';
        return done({ ok: false, result: parsed.result, error: `claude exited with code ${code}: ${why}` });
      }
      done(parsed);
    });
  });
}

function isRequest(p: unknown): p is StageRequest {
  if (typeof p !== 'object' || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.stage === 'string' &&
    typeof r.prompt === 'string' &&
    typeof r.model === 'string' &&
    typeof r.cwd === 'string' &&
    (r.mode === 'readonly' || r.mode === 'edit')
  );
}

/** SIGTERM now, SIGKILL after `graceMs` if it is still alive. */
function terminate(child: ChildProcess, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, 'SIGTERM');
  child.once('exit', () => signalGroup(child, 'SIGKILL')); // sweep anything the run left behind
  setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs).unref();
}

/**
 * Signal the whole process group. Claude is started in its own group (detached), so its Bash children, and
 * what they start, get the signal too and cannot outlive it to write into a removed worktree.
 */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/**
 * A worker. Each one tracks its own Claude processes, so stop() ends exactly those and nothing else.
 * The default export is one shared instance for normal use.
 */
export function createWorker() {
  const children = new Set<ChildProcess>();
  /** The running Claude processes of each job, so cancelling one job ends only its own. */
  const byJob = new Map<string, Set<ChildProcess>>();
  /** Children that were ended because their job was cancelled or failed. */
  const ended = new WeakSet<ChildProcess>();
  let stopping = false;
  let graceMs = STOP_GRACE_MS;

  return definePlugin({
    manifest: {
      name: 'worker-claude-code',
      version: '0.1.0',
      sdk: '0',
      description: 'Runs one fresh Claude Code session per stage, inside the job worktree.',
      provides: { stages: ['*'] },
      subscribes: ['stage.requested', 'job.status'],
      emits: ['stage.completed', 'stage.failed'],
      needs: ['claude.run', 'fs.worktree'],
    },
    register(ctx) {
      ctx.require('claude.run');
      ctx.require('fs.worktree');
      const cfg = ctx.config as WorkerConfig;
      const bin = cfg.claudeBin ?? 'claude';
      const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      graceMs = cfg.stopGraceMs ?? STOP_GRACE_MS;
      stopping = false;

      // A job that was cancelled or failed must not keep a Claude running in its worktree: the worktree is removed
      // when the job ends, and a live child would write into it, or recreate it, after that.
      ctx.on('job.status', (event: BuligEvent) => {
        const to = (event.payload as { to?: string } | null)?.to;
        if (!event.jobId || (to !== 'cancelled' && to !== 'failed')) return;
        for (const child of byJob.get(event.jobId) ?? []) {
          ended.add(child);
          terminate(child, graceMs);
        }
      });

      ctx.on('stage.requested', async (event: BuligEvent) => {
        const req = event.payload;
        if (!isRequest(req)) {
          ctx.emit('stage.failed', { stage: 'unknown', error: 'stage.requested payload is missing a field' }, event.jobId);
          return;
        }
        if (stopping) return; // shutting down: start nothing. The stage stays running and is picked up on resume.
        const jobId = event.jobId;
        const state = jobId ? ctx.jobs.get(jobId)?.status : undefined;
        if (state === 'cancelled' || state === 'failed') {
          ctx.emit('stage.failed', { stage: req.stage, error: `the job is ${state}, so the stage did not start` }, jobId);
          return;
        }
        let spawned: ChildProcess | undefined;
        const out = await run(bin, buildArgs(req, cfg.extraArgs, cfg.allowDomains), req.cwd, timeoutMs, buildEnv(process.env, cfg.passEnv), children, (child) => {
          spawned = child;
          if (!jobId) return () => {};
          const set = byJob.get(jobId) ?? new Set<ChildProcess>();
          set.add(child);
          byJob.set(jobId, set);
          return () => {
            set.delete(child);
            if (set.size === 0 && byJob.get(jobId) === set) byJob.delete(jobId);
          };
        });
        // A run that was ended by stop() says nothing. The stage stays running, and the next start marks it interrupted.
        if (stopping) return;
        if (spawned && ended.has(spawned)) {
          // Killed because its job ended. Say so, so the stage is closed and cleanup can go ahead.
          ctx.emit('stage.failed', { stage: req.stage, error: 'the job ended, so this run was stopped' }, jobId);
          return;
        }
        if (out.ok) {
          ctx.emit(
            'stage.completed',
            { stage: req.stage, ok: true, result: out.result, costUsd: out.costUsd, sessionId: out.sessionId },
            event.jobId,
          );
        } else {
          ctx.emit('stage.failed', { stage: req.stage, error: out.error ?? 'unknown failure' }, event.jobId);
        }
      });
    },

    /** SIGTERM every running Claude, then SIGKILL whatever is still alive after stopGraceMs. */
    async stop() {
      stopping = true;
      const alive = [...children].filter((c) => c.exitCode === null && c.signalCode === null);
      if (alive.length === 0) return;
      await new Promise<void>((resolve) => {
        let left = alive.length;
        const finished = () => {
          if (--left === 0) {
            for (const c of alive) signalGroup(c, 'SIGKILL'); // sweep anything the runs left behind
            clearTimeout(killTimer);
            clearTimeout(giveUp);
            resolve();
          }
        };
        const killTimer = setTimeout(() => {
          for (const c of alive) signalGroup(c, 'SIGKILL');
        }, graceMs);
        // SIGKILL cannot be ignored, so this only matters if the OS never reports the exit.
        const giveUp = setTimeout(resolve, graceMs + 5000);
        for (const c of alive) {
          c.once('exit', finished);
          signalGroup(c, 'SIGTERM');
        }
      });
    },
  });
}

export default createWorker();

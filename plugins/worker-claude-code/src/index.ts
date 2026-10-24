import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import { clipText } from '@bulig/text';
import { readCredential } from '@bulig/credentials';

export { CREDENTIAL_NAMES, readCredential } from '@bulig/credentials';

export type StageMode = 'readonly' | 'edit';

export interface StageRequest {
  stage: string;
  prompt: string;
  model: string;
  mode: StageMode;
  cwd: string;
  /** The stage attempt this run is for (ADR 0010). When present, the run starts only while that attempt is the running one. */
  stageId?: string;
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
  /**
   * Where stages come from. "direct" (the default) runs every stage.requested, as always. "gateway" is set by the CLI when worker-gateway
   * is on: the gateway decides which worker takes a stage, and this one runs only the stage.assigned events addressed to "local".
   */
  via?: 'direct' | 'gateway';
}

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
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
 * `buildEnv` plus the Claude login from systemd's credentials, for a host (the server) that keeps it in a file and not in the
 * environment. The token is read from `$CREDENTIALS_DIRECTORY/claude-token` into the child's environment only, and only when the
 * environment has no login of its own. `CREDENTIALS_DIRECTORY` itself is not on the allowlist, so the child never learns where
 * the other credentials (the database URL, the worker tokens) are.
 */
export function buildClaudeEnv(source: NodeJS.ProcessEnv, passEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const env = buildEnv(source, passEnv);
  if (![...CLAUDE_AUTH].some((n) => env[n])) {
    const token = readCredential('claude-token', source);
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
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
export const DENY_READ = ['~/.config/gh', '~/.ssh', '~/.git-credentials', '~/.netrc', '~/.gitconfig', '~/.config/git', '/run/credentials'];

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
      // No allowWrite here: `run` adds the one run's own npm cache to it (withRunWritable, NPM_CACHE_PREFIX).
      filesystem: { denyRead: DENY_READ },
    },
  };
}

/**
 * NPM'S CACHE INSIDE CLAUDE'S SANDBOX (found on the server, job 9628d02c, 24 Oct 2026). On the server (Linux, bubblewrap) Claude Code's
 * Bash sandbox lets a command write only to the stage's folder and to Claude's own temp folder, so npm's default cache (~/.npm, under
 * the worker's HOME) is read-only there, and every stage that used npm wasted 4 to 6 commands: `npm install` with the default cache failed, `echo $TMPDIR` showed
 * nothing the agent could use, `mkdir -p /tmp/claude/npm-cache` failed, and only `--cache /tmp/claude-<uid>/npm-cache` (Claude's own
 * temp folder, whose name is Claude Code's business, not ours) worked.
 *
 * So each run gets a cache of its own: an empty folder made by `run` next to the gh one, named to the child as `npm_config_cache` and
 * added to the sandbox's allowWrite for that run only, then removed with the run. It is the only path added, it lives where the worker
 * already keeps its per-run folders (on the server, the unit's private /tmp; never HOME or a host path), and it is per run on purpose:
 * one cache shared by every job would let a prompt in one job plant a package that npm hands to the next. npm keeps its own temp files
 * and logs under the cache (`_cacache/tmp`, `_logs`), so this is enough for npm with no flags. TMPDIR is left alone: Claude Code sets
 * it for every sandboxed command itself, and on Linux it also uses TMPDIR as its own temp root, which this must not move.
 */
export const NPM_CACHE_PREFIX = 'bulig-npm-';

/** The child's environment with npm's cache set to `cacheDir`. Any other spelling of the variable (npm reads it in any case) goes. */
export function withNpmCache(env: NodeJS.ProcessEnv, cacheDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (name.toLowerCase() !== 'npm_config_cache') out[name] = value;
  return { ...out, npm_config_cache: cacheDir };
}

/**
 * The argument list with `dir` added to the sandbox's allowWrite in the --settings that buildArgs put in (the first one). Nothing
 * else in the settings changes. A list with no --settings, or one whose value is not sandbox settings, is returned as it is.
 */
export function withRunWritable(args: readonly string[], dir: string): string[] {
  const at = args.indexOf('--settings');
  if (at === -1 || at + 1 >= args.length) return [...args];
  let settings: { sandbox?: { filesystem?: { allowWrite?: unknown } } };
  try {
    settings = JSON.parse(args[at + 1]!) as typeof settings;
  } catch {
    return [...args];
  }
  const fs = settings?.sandbox?.filesystem;
  if (typeof fs !== 'object' || fs === null) return [...args];
  const before = Array.isArray(fs.allowWrite) ? (fs.allowWrite as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  fs.allowWrite = [...new Set([...before, dir])];
  const out = [...args];
  out[at + 1] = JSON.stringify(settings);
  return out;
}

/**
 * The argument list for one run. Every run is a fresh session: there is no resume or continue flag,
 * so a reviewer never sees the build session's context.
 */
export function buildArgs(req: StageRequest, extra: string[] = [], allowDomains: readonly string[] = []): string[] {
  const args = ['-p', req.prompt, '--output-format', 'stream-json', '--verbose', '--model', req.model, '--settings', JSON.stringify(sandboxSettings(allowDomains))];
  if (req.mode === 'edit') {
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', EDIT_TOOLS.join(','), '--disallowedTools', EDIT_DENIED_TOOLS.join(','));
  } else {
    args.push('--permission-mode', 'plan', '--allowedTools', READONLY_TOOLS.join(','));
  }
  return [...args, ...extra];
}

/**
 * One thing Claude did in a run, taken from the tool-use records in its stream, never from its text.
 * `ok` is false when the tool reported an error or never reported back.
 */
export interface EvidenceRecord {
  tool: string;
  kind: 'read' | 'search' | 'edit' | 'run' | 'other';
  /** The file path, search pattern or shell command, flattened and cut at 300 characters. */
  target: string;
  ok: boolean;
  /** For a successful Bash call: the files named by `diff --git a/<path> b/<path>` headers in its output, so a `git diff` counts as reading them. */
  diffPaths?: string[];
}

const MAX_RECORDS = 300;
const MAX_TARGET = 300;
const MAX_DIFF_PATHS = 200;
/** Most diff paths kept from a whole run, so the records stay small however many diffs Claude prints. */
const MAX_DIFF_PATHS_RUN = 1000;
const KINDS: Record<string, EvidenceRecord['kind']> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
};

const flat = (v: unknown): string =>
  clipText(
    (typeof v === 'string' ? v : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
    MAX_TARGET,
  );

function recordOf(tool: string, input: unknown): EvidenceRecord {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const kind = Object.hasOwn(KINDS, tool) ? KINDS[tool]! : 'other';
  const target =
    kind === 'run' ? flat(i.command) : kind === 'search' ? flat(i.pattern) : kind === 'other' ? '' : flat(i.file_path) || flat(i.notebook_path);
  return { tool: clipText(flat(tool), 60), kind, target, ok: false };
}

/** The text of a tool_result: a string, or a list of blocks of which only the text ones are read. */
const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
      : '';

const DIFF_HEADER = /^diff --git (a\/.+ b\/.+)$/gm;

/**
 * The files a diff showed, from its `diff --git a/<path> b/<path>` header lines. A quoted header (a path with odd
 * characters) or one without the a/ and b/ prefixes is left out: a missed file only costs a warning. A rename names both.
 * `git diff --stat` and `--name-only` print no headers, so they give nothing.
 */
export function diffPathsOf(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(DIFF_HEADER)) {
    if (out.size >= MAX_DIFF_PATHS) break;
    const rest = m[1]!;
    const n = (rest.length - 5) / 2;
    const same = rest.slice(2, 2 + n);
    if (Number.isInteger(n) && rest === `a/${same} b/${same}`) out.add(same);
    else if (rest.split(' b/').length === 2) for (const p of [rest.slice(2, rest.indexOf(' b/')), rest.slice(rest.indexOf(' b/') + 3)]) out.add(p);
  }
  return [...out].map(flat).filter(Boolean);
}

/**
 * Every tool call in a stream-json run, paired with its result. Only `assistant` messages can start a record
 * (a tool_use block) and only `user` messages can settle one (a tool_result block with the same id). The text
 * the model wrote is never read, so nothing the model says can add a record. Of a tool result only two things are
 * read: whether it is an error, and for a successful Bash call the `diff --git` header lines (see diffPathsOf). The
 * gate counts those only when the command was a git diff or show.
 */
export function evidenceFrom(lines: readonly unknown[]): EvidenceRecord[] {
  const c = new EvidenceCollector();
  for (const line of lines) c.add(line);
  return c.records;
}

/** The same pairing, one message at a time, so a stream can be read as it arrives. Holds at most MAX_RECORDS records. */
class EvidenceCollector {
  readonly records: EvidenceRecord[] = [];
  private readonly open = new Map<string, EvidenceRecord>();
  private diffBudget = MAX_DIFF_PATHS_RUN;

  /** Settle calls from a line that was too long to parse: `failed` is true if the line said any of its results was an error. */
  settleSkipped(ids: Iterable<string>, failed: boolean): void {
    for (const id of ids) {
      const rec = this.open.get(id);
      if (rec) {
        rec.ok = !failed;
        this.open.delete(id);
      }
    }
  }

  add(line: unknown): void {
    const msg = (line as { type?: unknown; message?: { content?: unknown } } | null) ?? {};
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      if (typeof block !== 'object' || block === null) continue;
      if (msg.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (this.records.length >= MAX_RECORDS) continue;
        const rec = recordOf(block.name, block.input);
        this.open.set(block.id, rec);
        this.records.push(rec);
      } else if (msg.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const rec = this.open.get(block.tool_use_id);
        if (rec) {
          rec.ok = block.is_error !== true;
          if (rec.ok && rec.kind === 'run') {
            const shown = this.diffBudget > 0 ? diffPathsOf(resultText(block.content)).slice(0, this.diffBudget) : [];
            this.diffBudget -= shown.length;
            if (shown.length) rec.diffPaths = shown;
          }
          this.open.delete(block.tool_use_id);
        }
      }
    }
  }
}

export interface RunResult {
  ok: boolean;
  result: string;
  costUsd?: number;
  sessionId?: string;
  error?: string;
  /** What Claude did in this run. Set only when the output was a stream. */
  evidence?: EvidenceRecord[];
}

/** The longest stream line that is parsed. A longer one (a huge tool result) is skipped, never held whole; a skipped tool result still settles its call (see LineSkim). */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The old single-object output is one line, so the first line of the output may be this long. */
export const MAX_SINGLE_OBJECT_BYTES = 8 * 1024 * 1024;
const HEAD_CHARS = 300;
const STDERR_KEEP = 4096;

/** Characters kept from the end of one piece to the start of the next, so a key split across two pipe reads is still found. */
const SKIM_CARRY = 320;
const SKIM_MAX_IDS = 64;
const SKIM_ID = /"tool_use_id"\s*:\s*"([^"\\]{1,200})"/g;
const SKIM_ERROR = /"is_error"\s*:\s*true\b/;
const SKIM_USER = /^\s*\{\s*"type"\s*:\s*"user"/;

/**
 * Reads the outline of a line that is too long to parse, without keeping it. Only the unescaped keys `tool_use_id`
 * and `is_error` are looked for: text inside a tool's output has its quotes escaped, so it cannot spell either key.
 * It tells whether the line is a user message, which ids it names, and whether any result on it was an error.
 */
class LineSkim {
  private carry = '';
  private head = '';
  private ids = new Set<string>();
  private failed = false;

  feed(piece: Buffer): void {
    if (piece.length === 0) return;
    const text = this.carry + piece.toString('latin1');
    if (this.head.length < 64) this.head += text.slice(this.carry.length, this.carry.length + 64 - this.head.length);
    if (!this.failed && SKIM_ERROR.test(text)) this.failed = true;
    for (const m of text.matchAll(SKIM_ID)) if (this.ids.size < SKIM_MAX_IDS) this.ids.add(m[1]!);
    this.carry = text.slice(-SKIM_CARRY);
  }

  /** Settle what the line named, then forget it. Only a line that starts as a user message can settle a call. */
  settle(into: EvidenceCollector): void {
    if (SKIM_USER.test(this.head)) into.settleSkipped(this.ids, this.failed);
    this.carry = '';
    this.head = '';
    this.ids = new Set();
    this.failed = false;
  }
}

/**
 * Reads what `claude -p --output-format stream-json --verbose` prints, as it arrives: one JSON object per line, the
 * last one of type "result". Only the evidence records, the result line and a short head of the output are kept,
 * so memory does not grow with what the tools printed. The older single-object output (one line, no records) is
 * still understood, up to MAX_SINGLE_OBJECT_BYTES.
 */
export class OutputParser {
  /** The most bytes held at any moment (the unfinished line, the result, the head). For tests and diagnostics. */
  peakRetained = 0;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private skipping = false;
  private lines = 0;
  private objects = 0;
  private skipped = 0;
  private oversizeFirst = false;
  private resultLen = 0;
  private result: Record<string, unknown> | undefined;
  private single: Record<string, unknown> | undefined;
  private head = '';
  private readonly evidence = new EvidenceCollector();
  private readonly skim = new LineSkim();

  write(chunk: Buffer): void {
    if (this.head.length < HEAD_CHARS) this.head += clipText(chunk.toString('utf8', 0, HEAD_CHARS * 4), HEAD_CHARS - this.head.length);
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(10, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (!this.skipping) {
        this.pending.push(chunk.subarray(pos, end));
        this.pendingLen += end - pos;
        this.track();
        if (this.pendingLen > (this.lines === 0 ? MAX_SINGLE_OBJECT_BYTES : MAX_LINE_BYTES)) {
          if (this.lines === 0) this.oversizeFirst = true;
          // The content is dropped, but its outline is kept: a long tool result still says which call it answers and whether it failed.
          for (const piece of this.pending) this.skim.feed(piece);
          this.pending = [];
          this.pendingLen = 0;
          this.skipping = true;
          this.skipped++;
        }
      } else {
        this.skim.feed(chunk.subarray(pos, end));
      }
      if (nl === -1) break;
      if (this.skipping) this.skim.settle(this.evidence);
      else this.line();
      this.skipping = false;
      this.lines++;
      pos = nl + 1;
    }
  }

  private track(): void {
    this.peakRetained = Math.max(this.peakRetained, this.pendingLen + this.resultLen + this.head.length);
  }

  private line(): void {
    const text = Buffer.concat(this.pending, this.pendingLen).toString('utf8').trim();
    this.pending = [];
    this.pendingLen = 0;
    if (!text) return;
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      return; // a line that is not JSON is not a record
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return;
    const obj = o as Record<string, unknown>;
    if (this.objects++ === 0 && typeof obj.type !== 'string') this.single = obj;
    this.evidence.add(obj);
    if (obj.type === 'result') {
      this.result = obj;
      this.resultLen = text.length;
      this.track();
    }
  }

  finish(): RunResult {
    if (this.skipping) this.skim.settle(this.evidence);
    else if (this.pendingLen > 0) this.line(); // the last line may have no newline
    const data = this.result ?? this.single;
    if (!data) {
      if (this.oversizeFirst) {
        return { ok: false, result: '', error: `claude printed a single JSON object over ${MAX_SINGLE_OBJECT_BYTES / 1024 / 1024} MiB, which is too large to read` };
      }
      if (this.objects > 0 || this.skipped > 0) {
        const skipped = this.skipped > 0 ? ` (${this.skipped} line${this.skipped === 1 ? '' : 's'} over ${MAX_LINE_BYTES / 1024 / 1024} MiB skipped)` : '';
        return { ok: false, result: '', error: `claude printed no result line${skipped}: ${this.head}` };
      }
      return { ok: false, result: '', error: `claude printed output that is not JSON: ${this.head.trim()}` };
    }
    // A single object that is not a result (a stream that stopped early) is not an answer.
    if (typeof data.type === 'string' && data.type !== 'result') {
      return { ok: false, result: '', error: `claude printed no result: ${this.head}` };
    }
    const result = typeof data.result === 'string' ? data.result : '';
    const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
    const costUsd = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined;
    if (data.is_error === true) {
      return { ok: false, result, error: result || 'claude reported an error', ...(sessionId && { sessionId }) };
    }
    const evidence = this.objects > 1 ? this.evidence.records : undefined;
    return { ok: true, result, ...(sessionId && { sessionId }), ...(costUsd !== undefined && { costUsd }), ...(evidence && { evidence }) };
  }
}

/** Parse the whole output of a run held in memory. The plugin itself uses OutputParser on the live pipe. */
export function parseClaudeOutput(stdout: string): RunResult {
  const p = new OutputParser();
  p.write(Buffer.from(stdout, 'utf8'));
  return p.finish();
}

/** Where `run` says what it could not clean up, when the caller gives no logger. */
const stderrWarn = (line: string) => void process.stderr.write(`${line}\n`);

/**
 * Give the owner back read, write and search on every folder under `root`, and read and write on every file, so the tree can be
 * removed. A sandboxed command can write in the run's npm cache, so it can leave a folder there that the worker cannot empty
 * (`chmod 500` on a folder with a file in it makes rmSync throw EACCES). Symlinks are never followed (lstat, and a link is skipped):
 * chmod would change the target, which can be anywhere. Only owner bits are ever added, and only on what this user owns, so a
 * link swapped in between the lstat and the chmod gains nothing this user could not already do. Errors are ignored: the retried
 * rmSync says what is left.
 */
export function unlockTree(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop()!;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    try {
      chmodSync(path, (st.mode & 0o7777) | (st.isDirectory() ? 0o700 : 0o600));
    } catch {
      // fall through: the retry reports what could not go
    }
    if (!st.isDirectory()) continue;
    let names: string[] = [];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of names) stack.push(join(path, name));
  }
}

/**
 * Remove a per-run folder and never throw. If the first try fails (a sandboxed command locked part of it), unlock the tree and try
 * once more; if that fails too, say so in one line (the path and the error code) and move on. A cleanup that threw would escape the
 * child's 'close' listener and end the whole worker process, taking every other slot's run with it (review of #71, 24 Oct 2026).
 */
export function removeRunDir(dir: string, warn: (line: string) => void = stderrWarn): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // locked by the run: unlock and try once more
  }
  try {
    unlockTree(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));
    try {
      warn(`worker-claude-code: could not remove ${dir}: ${code}`);
    } catch {
      // a logger that throws must not undo the point of this function
    }
  }
}

/** Start one Claude run and wait for it. Exported so `bulig worker` runs exactly the same process, in the same sandbox, as the in-process worker. */
export function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  children: Set<ChildProcess>,
  onSpawn: (child: ChildProcess) => () => void,
  /** Where a folder that could not be removed is reported, one line each. Defaults to stderr. */
  warn: (line: string) => void = stderrWarn,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // A fresh, empty gh config dir for this one run, so no signed-in gh state can be found under HOME.
    // And npm's cache for this one run, writable inside the sandbox (see NPM_CACHE_PREFIX for why). The real path, because the
    // sandbox matches paths after symlinks are resolved (macOS's temp folder is a symlink).
    let ghDir: string;
    let npmDir = '';
    try {
      ghDir = mkdtempSync(join(tmpdir(), 'bulig-gh-'));
    } catch (err) {
      resolve({ ok: false, result: '', error: `could not make a temp dir: ${(err as Error).message}` });
      return;
    }
    // Never throws (removeRunDir), so no caller below needs to guard it.
    const cleanup = () => {
      removeRunDir(ghDir, warn);
      if (npmDir) removeRunDir(npmDir, warn);
    };
    try {
      npmDir = mkdtempSync(join(tmpdir(), NPM_CACHE_PREFIX));
      npmDir = realpathSync(npmDir);
    } catch (err) {
      cleanup();
      resolve({ ok: false, result: '', error: `could not make a temp dir: ${(err as Error).message}` });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, withRunWritable(args, npmDir), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: withNpmCache(hardenEnv(env, ghDir), npmDir), detached: true });
    } catch (err) {
      cleanup();
      resolve({ ok: false, result: '', error: `could not start ${bin}: ${(err as Error).message}` });
      return;
    }
    children.add(child);
    const untrack = onSpawn(child);
    const parser = new OutputParser();
    let stderr = '';
    let timedOut = false;
    let settled = false;
    // The run always resolves, whatever the bookkeeping or the cleanup does: `settled` is set first, so a run whose resolve was
    // skipped would hang for good. And nothing may escape: this runs in the child's 'close' listener, where a throw ends the process.
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      try {
        try {
          clearTimeout(timer);
          children.delete(child);
          cleanup();
          untrack();
        } finally {
          resolve(r);
        }
      } catch (err) {
        try {
          warn(`worker-claude-code: after a run: ${err instanceof Error ? err.message : String(err)}`);
        } catch {
          // nothing more to do
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, 'SIGTERM');
      setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => parser.write(d));
    // Only the start of stderr is ever shown, so only that is kept.
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += d.toString('utf8', 0, STDERR_KEEP);
    });
    child.on('error', (err) => done({ ok: false, result: '', error: `could not start ${bin}: ${err.message}` }));
    child.on('close', (code) => {
      if (timedOut) return done({ ok: false, result: '', error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      const parsed = parser.finish();
      if (code !== 0) {
        const why = clipText(stderr.trim(), 300) || parsed.error || 'no output';
        return done({ ok: false, result: parsed.result, error: `claude exited with code ${code}: ${why}` });
      }
      done(parsed);
    });
  });
}

export function isRequest(p: unknown): p is StageRequest {
  if (typeof p !== 'object' || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.stage === 'string' &&
    typeof r.prompt === 'string' &&
    typeof r.model === 'string' &&
    typeof r.cwd === 'string' &&
    (r.mode === 'readonly' || r.mode === 'edit') &&
    (r.stageId === undefined || typeof r.stageId === 'string')
  );
}

/** SIGTERM now, SIGKILL after `graceMs` if it is still alive. */
export function terminate(child: ChildProcess, graceMs: number): void {
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
  /**
   * Stages that have been asked for and have no Claude process yet, per job. A cancel that arrives in this gap finds no
   * child to stop, and the status the stage handler read just before may be older than the cancel, so the cancel is noted here.
   */
  const starting = new Map<string, number>();
  /** Jobs that were cancelled or failed while one of their stages was starting. Cleared when the last starting stage is through. */
  const endedWhileStarting = new Set<string>();
  let stopping = false;
  let graceMs = STOP_GRACE_MS;

  return definePlugin({
    manifest: {
      name: 'worker-claude-code',
      version: '0.1.0',
      sdk: '1',
      description: 'Runs one fresh Claude Code session per stage, inside the job worktree.',
      provides: { stages: ['*'] },
      subscribes: ['stage.requested', 'stage.assigned', 'job.status'],
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
        if (starting.has(event.jobId)) endedWhileStarting.add(event.jobId);
        for (const child of byJob.get(event.jobId) ?? []) {
          ended.add(child);
          terminate(child, graceMs);
        }
      });

      // Both are subscribed either way (the manifest says so); which one counts depends on where stages come from.
      const behindGateway = cfg.via === 'gateway';
      const onStage = async (event: BuligEvent) => {
        const req = event.payload;
        // Behind the gateway, a stage that went to a remote worker is not this worker's.
        if (behindGateway && (req as { workerId?: unknown } | null)?.workerId !== 'local') return;
        if (!isRequest(req)) {
          ctx.emit('stage.failed', { stage: 'unknown', error: 'stage.requested payload is missing a field' }, event.jobId);
          return;
        }
        if (stopping) return; // shutting down: start nothing. The stage stays running and is picked up on resume.
        const jobId = event.jobId;
        // Note that this stage is starting before reading the job: the read takes time, and a cancel that comes in
        // during it must be able to tell this handler (the job.status handler above sets the flag).
        if (jobId) starting.set(jobId, (starting.get(jobId) ?? 0) + 1);
        let left = false;
        const leave = () => {
          if (!jobId || left) return;
          left = true;
          const n = (starting.get(jobId) ?? 1) - 1;
          if (n > 0) starting.set(jobId, n);
          else {
            starting.delete(jobId);
            endedWhileStarting.delete(jobId);
          }
        };
        try {
          let state: string | undefined;
          try {
            state = jobId ? (await ctx.jobs.get(jobId))?.status : undefined;
          } catch (err) {
            // Shutting down: the stage stays running and is picked up on resume, as for any stage that was cut off.
            if (stopping) return;
            // The store did not answer. Say so and fail the stage, so the pipeline can fail the job instead of waiting on a stage that will never report.
            ctx.emit('stage.failed', { stage: req.stage, error: `could not read the job, so the stage did not start: ${err instanceof Error ? err.message : String(err)}` }, jobId);
            return;
          }
          if (stopping) return; // stop() may have come in while the job was being read
          if (state === 'cancelled' || state === 'failed' || (jobId && endedWhileStarting.has(jobId))) {
            ctx.emit('stage.failed', { stage: req.stage, error: `the job is ${state === 'cancelled' || state === 'failed' ? state : 'ending'}, so the stage did not start` }, jobId);
            return;
          }
          // A request for an attempt that is no longer the running one (the stage finished, or another kernel took it over) is a
          // repeat. Running Claude again would do the same work twice in the same worktree, so nothing starts and nothing is said.
          if (req.stageId !== undefined && jobId) {
            let live: boolean;
            try {
              live = (await ctx.jobs.stages(jobId)).some((s) => s.id === req.stageId && s.status === 'running');
            } catch (err) {
              if (stopping) return;
              ctx.emit('stage.failed', { stage: req.stage, error: `could not read the stages, so the stage did not start: ${err instanceof Error ? err.message : String(err)}` }, jobId);
              return;
            }
            if (stopping) return;
            if (!live) {
              ctx.log.warn(`worker-claude-code: stage ${req.stage} (${req.stageId}) of job ${jobId} is not the running attempt, so no Claude was started`);
              return;
            }
          }
          let spawned: ChildProcess | undefined;
          const out = await run(bin, buildArgs(req, cfg.extraArgs, cfg.allowDomains), req.cwd, timeoutMs, buildClaudeEnv(process.env, cfg.passEnv), children, (child) => {
            spawned = child;
            if (!jobId) return () => {};
            const set = byJob.get(jobId) ?? new Set<ChildProcess>();
            set.add(child);
            byJob.set(jobId, set);
            // From here the child is in byJob, where a cancel finds it. Nothing runs between the check above and this line.
            leave();
            return () => {
              set.delete(child);
              if (set.size === 0 && byJob.get(jobId) === set) byJob.delete(jobId);
            };
          }, (line) => ctx.log.warn(line));
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
              { stage: req.stage, ok: true, result: out.result, costUsd: out.costUsd, sessionId: out.sessionId, evidence: out.evidence ?? [] },
              event.jobId,
            );
          } else {
            ctx.emit('stage.failed', { stage: req.stage, error: out.error ?? 'unknown failure' }, event.jobId);
          }
        } finally {
          leave();
        }
      };
      ctx.on(behindGateway ? 'stage.assigned' : 'stage.requested', onStage);
      // The other one is subscribed too, and ignored.
      ctx.on(behindGateway ? 'stage.requested' : 'stage.assigned', () => {});
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

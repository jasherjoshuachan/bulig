import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { definePlugin, isRepoPath, matchesScope, normalizeScopeEntry, type BuligEvent, type PluginContext } from '@bulig/plugin-sdk';
import { exec, type ExecResult } from './exec.ts';

export interface GithubConfig {
  /** The gh binary. Default "gh". */
  ghBin?: string;
  /** The git binary. Default "git". */
  gitBin?: string;
  /** Name of an environment variable that holds a GitHub token. It is passed on as GH_TOKEN. */
  tokenEnv?: string;
  /** Name and email put on the commits this plugin makes. Without them, git's own identity is used. */
  authorName?: string;
  authorEmail?: string;
  /** Treat a PR with no checks at all as allowed to merge. Default false. */
  allowNoChecks?: boolean;
  /** Base branch for new PRs. Default is the repo's default branch. */
  baseBranch?: string;
  /** How many times to try a push or a PR call that fails in a way that looks temporary. Default 3. */
  tries?: number;
  /** Wait before the second try, in ms. It doubles each time. Default 2000. */
  retryDelayMs?: number;
}

class StepError extends Error {}

const str = (p: unknown, key: string): string => {
  const v = (p as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || v === '') throw new StepError(`payload is missing "${key}"`);
  return v;
};
const num = (p: unknown, key: string): number => {
  const v = (p as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'number') throw new StepError(`payload is missing "${key}"`);
  return v;
};

/** Errors that usually pass if you try again: GitHub hiccups and network drops. */
export const TRANSIENT = /internal server error|bad gateway|service unavailable|gateway time-?out|HTTP 5\d\d|\b50[0-4]\b|timed out|connection (reset|refused|closed)|could not resolve host|temporarily unavailable|early EOF|RPC failed|unexpected disconnect/i;

/**
 * Refuse to touch a job worktree that is reached through a symlink. `<repo>/.worktrees` and
 * `<repo>/.worktrees/<jobId>` must be real directories (checked with lstat, which does not follow links), and
 * what `cwd` resolves to must lie inside the resolved repo. A link planted there could otherwise point a
 * reset or a removal at some other repo. A path that does not exist yet passes: nothing can be reached through it.
 */
export function assertPlainWorktree(repoPath: string, cwd: string): void {
  for (const p of [join(repoPath, '.worktrees'), cwd]) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new StepError(`refusing: cannot inspect ${p}: ${(err as Error).message}`);
    }
    if (st.isSymbolicLink()) throw new StepError(`refusing: ${p} is a symlink`);
  }
  if (!existsSync(cwd)) return;
  const rel = relative(realpathSync(repoPath), realpathSync(cwd));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new StepError(`refusing: ${cwd} resolves outside the repo`);
}


/** Every path git would put in a commit if the whole tree were added: tracked changes, staged changes, new files, both ends of a rename. Ignored files are left out. */
export function parseStatusZ(out: string): string[] {
  const parts = out.split('\0');
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    seen.add(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) {
      const from = parts[++i];
      if (from) seen.add(from);
    }
  }
  return [...seen].sort();
}

/** The first part of this path (from the repo root down) that is a symlink, or undefined. A part that does not exist is fine. */
export function symlinkOnPath(root: string, rel: string): string | undefined {
  const parts = rel.split('/');
  for (let n = 1; n <= parts.length; n++) {
    const sub = parts.slice(0, n).join('/');
    try {
      if (lstatSync(join(root, sub)).isSymbolicLink()) return sub;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw err;
    }
  }
  return undefined;
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const hasWildcard = (pattern: string) => /[*?]/.test(pattern);
const MAX_LISTED = 20;
const listed = (paths: string[]) => (paths.length > MAX_LISTED ? `${paths.slice(0, MAX_LISTED).join(', ')} and ${paths.length - MAX_LISTED} more` : paths.join(', '));

export interface ScopeRules {
  scope: string[];
  allow: string[];
  mode: 'enforce' | 'warn';
}

/**
 * Read and check the scope that came with a commit request. This is the enforcement point, so it trusts nothing:
 * a missing, empty, malformed, absolute, ".." or too broad scope is refused, and so is a scope line that names a
 * symlink (or a path behind one) in this worktree.
 */
export function readScopeRules(payload: unknown, cwd: string): ScopeRules {
  const p = (payload ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);
  const given = strings(p.scope);
  if (!given || given.length === 0) throw new StepError('no approved scope was given with the commit request, so nothing was committed');
  const allowGiven = p.scopeAllow === undefined ? [] : strings(p.scopeAllow);
  if (!allowGiven) throw new StepError('invalid scope: scopeAllow must be a list of paths');
  const mode = p.scopeMode === undefined ? 'enforce' : p.scopeMode;
  if (mode !== 'enforce' && mode !== 'warn') throw new StepError(`invalid scope: scopeMode must be "enforce" or "warn", not ${JSON.stringify(mode)}`);
  const allowBroad = p.allowBroadScope === true;

  const clean = (list: string[]): string[] => {
    const out: string[] = [];
    const problems: string[] = [];
    for (const raw of list) {
      const r = normalizeScopeEntry(raw, { allowBroad });
      if (!r.ok) {
        problems.push(r.error);
        continue;
      }
      if (!hasWildcard(r.pattern)) {
        const link = symlinkOnPath(cwd, r.pattern);
        if (link) problems.push(`${JSON.stringify(raw)}: ${JSON.stringify(link)} is a symlink, and a symlink is never part of the scope`);
      }
      out.push(r.pattern);
    }
    if (problems.length) throw new StepError(`invalid scope: ${problems.join('; ')}`);
    return out;
  };
  return { scope: clean(given), allow: clean(allowGiven), mode };
}

export type Check = { name?: string; bucket?: string; state?: string };

/** Sort checks into failing and pending. Unknown buckets count as pending, to stay on the safe side. */
export function judgeChecks(checks: Check[]): { failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of checks) {
    const name = c.name ?? '(unnamed)';
    const bucket = c.bucket ?? '';
    if (bucket === 'pass' || bucket === 'skipping') continue;
    if (bucket === 'fail' || bucket === 'cancel') failing.push(name);
    else pending.push(name);
  }
  return { failing, pending };
}

export default definePlugin({
  manifest: {
    name: 'github',
    version: '0.1.0',
    sdk: '0',
    description: 'Branches, pull requests, checks and merging, through git and the gh CLI.',
    provides: { stages: ['worktree', 'commit', 'pr', 'merge'] },
    subscribes: [
      'worktree.requested',
      'worktree.reset.requested',
      'worktree.cleanup.requested',
      'commit.requested',
      'pr.requested',
      'merge.requested',
    ],
    emits: [
      'worktree.ready',
      'worktree.failed',
      'worktree.reset.done',
      'worktree.reset.failed',
      'worktree.cleaned',
      'worktree.cleanup.failed',
      'commit.done',
      'commit.failed',
      'pr.opened',
      'pr.failed',
      'pr.merged',
      'merge.refused',
      'merge.failed',
    ],
    needs: ['git.push', 'gh.pr'],
  },
  register(ctx: PluginContext) {
    ctx.require('git.push');
    ctx.require('gh.pr');
    const cfg = ctx.config as GithubConfig;
    const gh = cfg.ghBin ?? 'gh';
    const git = cfg.gitBin ?? 'git';

    // The token goes only to calls that talk to GitHub: gh, and the git commands that push or fetch. Commits,
    // resets and status never get it. Without a tokenEnv, the ambient login is used, as before.
    const env = (withToken: boolean): NodeJS.ProcessEnv => {
      if (!withToken || !cfg.tokenEnv) return process.env;
      const token = process.env[cfg.tokenEnv];
      if (!token) throw new StepError(`config tokenEnv is "${cfg.tokenEnv}" but that environment variable is not set`);
      return { ...process.env, GH_TOKEN: token };
    };
    // Every git call runs with hooks switched off. A job worktree is written by a Claude stage, so a hook it plants
    // (.husky, .git/hooks, lefthook) would otherwise run here, outside the stage sandbox.
    const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
    // The bot signs its own commits, so the history shows who did the work and your identity is never borrowed.
    if (Boolean(cfg.authorName) !== Boolean(cfg.authorEmail)) {
      throw new Error('github: set both authorName and authorEmail, or neither (only one of them is set)');
    }
    const IDENTITY = cfg.authorName && cfg.authorEmail ? ['-c', `user.name=${cfg.authorName}`, '-c', `user.email=${cfg.authorEmail}`] : [];
    const runGit = (cwd: string, args: string[], withToken = false) => exec(git, [...NO_HOOKS, ...args], { cwd, env: env(withToken) });
    const runGh = (cwd: string, args: string[]) => exec(gh, args, { cwd, env: env(true) });
    // For calls that talk to GitHub. A temporary failure is tried again; any other failure is returned at once.
    const tries = cfg.tries ?? 3;
    const delay = cfg.retryDelayMs ?? 2000;
    const again = async (call: () => Promise<ExecResult>): Promise<ExecResult> => {
      let r = await call();
      for (let n = 1; n < tries && r.code !== 0 && TRANSIENT.test(r.stderr + r.stdout); n++) {
        ctx.log.warn(`github: temporary failure, trying again (${n}/${tries - 1})`, (r.stderr || r.stdout).trim().slice(0, 200));
        await new Promise((res) => setTimeout(res, delay * 2 ** (n - 1)));
        r = await call();
      }
      return r;
    };
    const must = (what: string, r: ExecResult): string => {
      if (r.code !== 0) throw new StepError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
      return r.stdout.trim();
    };
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

    // The one place that decides what "the base branch" is, so the worktree start and the reviewer's diff agree.
    // With an origin, origin's copy wins over the local one (the local copy may be stale). A configured
    // baseBranch that resolves nowhere is an error: the PR would still target it.
    const hasOrigin = async (dir: string): Promise<boolean> => (await runGit(dir, ['remote', 'get-url', 'origin'])).code === 0;
    const resolveBase = async (dir: string, remote: boolean): Promise<string | undefined> => {
      const candidates = cfg.baseBranch
        ? remote ? [`origin/${cfg.baseBranch}`, cfg.baseBranch] : [cfg.baseBranch]
        : remote ? ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'] : ['main', 'master'];
      for (const c of candidates) {
        if ((await runGit(dir, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])).code === 0) return c;
      }
      if (cfg.baseBranch) throw new StepError(`the configured baseBranch "${cfg.baseBranch}" was not found (tried ${candidates.join(', ')})`);
      return undefined;
    };

    ctx.on('worktree.requested', async (event: BuligEvent) => {
      try {
        const repoPath = resolve(str(event.payload, 'repoPath'));
        const branch = str(event.payload, 'branch');
        if (!event.jobId) throw new StepError('worktree.requested needs a job');
        const cwd = join(repoPath, '.worktrees', event.jobId);
        assertPlainWorktree(repoPath, cwd);
        // A restart can ask twice. If the worktree is already there on this branch, that is the answer.
        const there = existsSync(cwd) ? await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : undefined;
        let base: string | undefined;
        if (!there || there.code !== 0 || there.stdout.trim() !== branch) {
          // Start from the base branch, not from whatever the checkout happens to have open, so the PR carries
          // only this job's work. With a remote, fetch first and prefer origin's copy over a stale local one.
          const remote = await hasOrigin(repoPath);
          if (remote) must('git fetch', await again(() => runGit(repoPath, ['fetch', 'origin'], true)));
          base = await resolveBase(repoPath, remote);
          if (!base) throw new StepError('could not find a base branch (tried origin/HEAD, origin/main, origin/master, main, master)');
          must('git worktree add', await runGit(repoPath, ['worktree', 'add', '--no-track', cwd, '-b', branch, base]));
        }
        ignoreWorktrees(repoPath, await runGit(repoPath, ['rev-parse', '--git-path', 'info/exclude']));
        ctx.emit('worktree.ready', base ? { cwd, branch, base } : { cwd, branch }, event.jobId);
      } catch (err) {
        ctx.emit('worktree.failed', { error: message(err) }, event.jobId);
      }
    });

    // Put a job worktree back to its last commit after a crash. It touches the job's own worktree and nothing else:
    // the path must be <repo>/.worktrees/<jobId> and git must say that directory is itself a worktree root.
    ctx.on('worktree.reset.requested', async (event: BuligEvent) => {
      try {
        const cwd = resolve(str(event.payload, 'cwd'));
        if (!event.jobId || basename(cwd) !== event.jobId || basename(dirname(cwd)) !== '.worktrees') {
          throw new StepError('refusing to reset a directory that is not this job\'s worktree');
        }
        assertPlainWorktree(dirname(dirname(cwd)), cwd);
        if (!existsSync(cwd)) throw new StepError('the job worktree is gone');
        const top = must('git rev-parse', await runGit(cwd, ['rev-parse', '--show-toplevel']));
        if (realpathSync(top) !== realpathSync(cwd)) throw new StepError('refusing to reset: that directory is not a worktree root');
        must('git reset', await runGit(cwd, ['reset', '--hard']));
        must('git clean', await runGit(cwd, ['clean', '-fd']));
        ctx.emit('worktree.reset.done', { cwd }, event.jobId);
      } catch (err) {
        ctx.emit('worktree.reset.failed', { error: message(err) }, event.jobId);
      }
    });

    // Remove a job's worktree and its local branch when the job ends without merging. The path is rebuilt from the
    // repo and the job id, never taken from the request, and the remote branch is left alone.
    // One at a time: two cleanups racing over the same worktree would trip over each other's git locks.
    let cleaning: Promise<unknown> = Promise.resolve();
    ctx.on('worktree.cleanup.requested', (event: BuligEvent) => {
      const turn = cleaning.then(() => cleanup(event));
      cleaning = turn.catch(() => {});
      return turn;
    });
    const cleanup = async (event: BuligEvent): Promise<void> => {
      try {
        const repoPath = resolve(str(event.payload, 'repoPath'));
        const branch = str(event.payload, 'branch');
        if (!event.jobId) throw new StepError('worktree.cleanup.requested needs a job');
        const cwd = join(repoPath, '.worktrees', event.jobId);
        assertPlainWorktree(repoPath, cwd);
        if (existsSync(cwd)) must('git worktree remove', await runGit(repoPath, ['worktree', 'remove', '--force', cwd]));
        else await runGit(repoPath, ['worktree', 'prune']);
        if (!['main', 'master', 'HEAD'].includes(branch)) await runGit(repoPath, ['branch', '-D', branch]); // already gone is fine
        ctx.emit('worktree.cleaned', { cwd, branch }, event.jobId);
      } catch (err) {
        ctx.emit('worktree.cleanup.failed', { error: message(err) }, event.jobId);
      }
    };

    // Where this branch left the base branch. The reviewer diffs against it.
    const baseOf = async (cwd: string): Promise<string> => {
      const ref = await resolveBase(cwd, await hasOrigin(cwd));
      if (ref) {
        const r = await runGit(cwd, ['merge-base', 'HEAD', ref]);
        if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
      }
      return '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree: the diff is then everything
    };

    // Everything the stages left on disk goes into commits now, before the independent review, so the
    // reviewer judges a fixed commit and the PR can be checked against it.
    //
    // Only files the approved plan named may go in. The check is here, in the github plugin, which runs outside
    // the Claude sandbox, so no stage can talk its way past it. Files are staged by name, never with `add -A`.
    ctx.on('commit.requested', async (event: BuligEvent) => {
      try {
        const cwd = str(event.payload, 'cwd');
        const message = str(event.payload, 'message');
        const rules = readScopeRules(event.payload, cwd);
        const status = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (status.code !== 0) throw new StepError(`git status failed (exit ${status.code}): ${(status.stderr || status.stdout).trim().slice(0, 500)}`);
        const changed = parseStatusZ(status.stdout);

        const outside: string[] = [];
        const links: string[] = [];
        for (const path of changed) {
          const link = isRepoPath(path) ? symlinkOnPath(cwd, path) : undefined;
          if (link) links.push(path);
          else if (!isRepoPath(path) || !(matchesScope(path, rules.scope) || matchesScope(path, rules.allow))) outside.push(path);
        }
        if (links.length) {
          throw Object.assign(new StepError(`a symlink is never committed: ${listed(links)}`), { outOfScope: [...new Set([...links, ...outside])].sort() });
        }
        if (outside.length && rules.mode === 'enforce') {
          throw Object.assign(new StepError(`files outside the approved scope, so nothing was committed: ${listed(outside)}`), { outOfScope: outside });
        }
        if (outside.length) ctx.log.warn(`github: scopeMode is warn; committing files outside the approved scope: ${listed(outside)}`);

        if (changed.length) {
          // Paths still on disk are added. Paths that are gone (a deletion, or the old end of a rename) are
          // removed from the index; `add` would refuse a name that no longer exists anywhere.
          const present = changed.filter((x) => lstatOrNull(join(cwd, x)));
          const gone = changed.filter((x) => !present.includes(x));
          for (let i = 0; i < present.length; i += 500) {
            must('git add', await runGit(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...present.slice(i, i + 500)]));
          }
          for (let i = 0; i < gone.length; i += 500) {
            must('git rm', await runGit(cwd, ['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--', ...gone.slice(i, i + 500)]));
          }
          // Belt and braces: the index must hold exactly what was checked.
          const cached = await runGit(cwd, ['diff', '--cached', '--name-only', '-z']);
          const extra = cached.stdout.split('\0').filter((x) => x && !changed.includes(x));
          if (cached.code !== 0 || extra.length) {
            await runGit(cwd, ['reset', '-q']);
            throw new StepError(`the index held files that were never checked (${listed(extra)}), so nothing was committed`);
          }
          must('git commit', await runGit(cwd, [...IDENTITY, 'commit', '-m', message]));
        }
        const sha = must('git rev-parse', await runGit(cwd, ['rev-parse', 'HEAD']));
        ctx.emit('commit.done', { sha, base: await baseOf(cwd), ...(outside.length && { outOfScope: outside }) }, event.jobId);
      } catch (err) {
        const outOfScope = (err as { outOfScope?: string[] }).outOfScope;
        ctx.emit('commit.failed', { error: message(err), ...(outOfScope && { outOfScope }) }, event.jobId);
      }
    });

    ctx.on('pr.requested', async (event: BuligEvent) => {
      try {
        const cwd = str(event.payload, 'cwd');
        const branch = str(event.payload, 'branch');
        const title = str(event.payload, 'title');
        const body = (event.payload as { body?: unknown }).body;
        // Only the commit the reviewer saw may go out. Anything else means the code changed after the review.
        const reviewed = str(event.payload, 'expectSha');
        const short = (sha: string) => sha.slice(0, 7);
        const head = must('git rev-parse', await runGit(cwd, ['rev-parse', 'HEAD']));
        if (head !== reviewed) {
          throw new StepError(`HEAD is ${short(head)} but the reviewed commit is ${short(reviewed)}, so no PR was opened`);
        }
        const dirty = must('git status', await runGit(cwd, ['status', '--porcelain']));
        if (dirty) throw new StepError('the worktree has changes that were never committed or reviewed, so no PR was opened');
        must('git push', await again(() => runGit(cwd, ['push', '-u', 'origin', branch], true)));
        const create = ['pr', 'create', '--title', title, '--body', typeof body === 'string' ? body : '', '--head', branch];
        if (cfg.baseBranch) create.push('--base', cfg.baseBranch);
        const made = await again(() => runGh(cwd, create));
        // If an earlier try actually made the PR, gh says so and prints its URL. Use that one.
        const out = made.code !== 0 && /already exists/i.test(made.stderr + made.stdout) ? made.stderr + made.stdout : must('gh pr create', made);
        const url = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop();
        if (!url) throw new StepError(`gh pr create did not print a PR URL: ${out.slice(0, 200)}`);
        const view = JSON.parse(must('gh pr view', await again(() => runGh(cwd, ['pr', 'view', url, '--json', 'number,headRefOid,url'])))) as {
          number: number;
          headRefOid: string;
          url: string;
        };
        if (view.headRefOid !== reviewed) {
          throw new StepError(`the PR head is ${short(view.headRefOid)} but the reviewed commit is ${short(reviewed)}`);
        }
        ctx.emit('pr.opened', { url: view.url || url, number: view.number, headSha: view.headRefOid }, event.jobId);
      } catch (err) {
        ctx.emit('pr.failed', { error: message(err) }, event.jobId);
      }
    });

    /** After a merge: drop the worktree and the branch, locally and on origin. Missing pieces are fine. */
    const tidy = async (cwd: string, worktree: string, branch: string | undefined, base: string | undefined): Promise<void> => {
      const common = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const repoPath = common.code === 0 ? dirname(common.stdout.trim()) : undefined;
      if (!repoPath || !existsSync(repoPath)) return;
      try {
        assertPlainWorktree(repoPath, worktree);
        await runGit(repoPath, ['worktree', 'remove', '--force', worktree]);
      } catch (err) {
        ctx.log.warn(`github: left the worktree alone: ${message(err)}`);
      }
      // Never delete the branch the PR merged into, whatever the worktree says it is on.
      if (branch && branch !== 'HEAD' && branch !== base) {
        await runGit(repoPath, ['branch', '-D', branch]);
        await runGit(repoPath, ['push', 'origin', '--delete', branch], true); // already gone is fine
      }
      await runGit(repoPath, ['fetch', '--prune'], true);
    };

    ctx.on('merge.requested', async (event: BuligEvent) => {
      // Refused: the merge did not happen but asking again may work. Failed: it never will, so do not ask again.
      const refuse = (reason: string) => ctx.emit('merge.refused', { reason }, event.jobId);
      const giveUp = (reason: string) => ctx.emit('merge.failed', { reason }, event.jobId);
      try {
        const worktree = str(event.payload, 'cwd');
        const number = num(event.payload, 'number');
        const headSha = str(event.payload, 'headSha');
        const n = String(number);
        const short = (sha: string) => sha.slice(0, 7);
        // After a crash the worktree may already be gone. Ask GitHub from the repo it hung off instead.
        const cwd = existsSync(worktree) ? worktree : basename(dirname(worktree)) === '.worktrees' ? dirname(dirname(worktree)) : worktree;

        const head = JSON.parse(must('gh pr view', await runGh(cwd, ['pr', 'view', n, '--json', 'headRefOid,state,baseRefName']))) as {
          headRefOid: string;
          state: string;
          baseRefName?: string;
        };
        // Read the branch now, before anything changes it. The worktree may already be gone after a crash.
        const branchOut = existsSync(worktree) ? await runGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) : undefined;
        const given = (event.payload as { branch?: unknown }).branch;
        const branch = typeof given === 'string' && given ? given : branchOut && branchOut.code === 0 ? branchOut.stdout.trim() : undefined;
        // A merge that already landed (a crash between the merge and our bookkeeping) is a success, not a new request.
        if (head.state === 'MERGED') {
          if (head.headRefOid !== headSha) {
            return giveUp(`PR #${number} was merged at ${short(head.headRefOid)}, not the approved ${short(headSha)}`);
          }
          await tidy(cwd, worktree, branch, head.baseRefName);
          return void ctx.emit('pr.merged', { number }, event.jobId);
        }
        if (head.state === 'CLOSED') return giveUp(`PR #${number} was closed without being merged`);
        if (head.state !== 'OPEN') return refuse(`PR #${number} is ${head.state}, not open`);
        if (head.headRefOid !== headSha) {
          // New commits landed after the review. They were never reviewed, so this job can't merge them.
          return giveUp(`PR head moved: approved ${headSha.slice(0, 7)} but it is now ${head.headRefOid.slice(0, 7)}`);
        }

        const checks = await runGh(cwd, ['pr', 'checks', n, '--json', 'name,bucket,state']);
        let list: Check[] | undefined;
        try {
          list = JSON.parse(checks.stdout) as Check[];
        } catch {
          list = undefined;
        }
        if (list === undefined) {
          if (/no checks reported/i.test(checks.stderr + checks.stdout)) list = [];
          else return refuse(`could not read checks: ${(checks.stderr || checks.stdout).trim().slice(0, 300)}`);
        }
        if (list.length === 0) {
          if (!cfg.allowNoChecks) return refuse('the PR has no checks and allowNoChecks is off');
        } else {
          const { failing, pending } = judgeChecks(list);
          if (failing.length) return refuse(`checks failing: ${failing.join(', ')}`);
          if (pending.length) return refuse(`checks pending: ${pending.join(', ')}`);
        }

        // From a worktree, gh can merge and then fail to switch branches. Trust the PR state, not the exit code.
        // --match-head-commit pins the merge to the approved commit: a push that races the merge makes gh refuse.
        const merge = await runGh(cwd, ['pr', 'merge', n, '--squash', '--delete-branch', '--match-head-commit', headSha]);
        if (merge.code !== 0) {
          const state = await runGh(cwd, ['pr', 'view', n, '--json', 'state']);
          const merged = state.code === 0 && (JSON.parse(state.stdout) as { state: string }).state === 'MERGED';
          if (!merged) return refuse(`gh pr merge failed (exit ${merge.code}): ${(merge.stderr || merge.stdout).trim().slice(0, 400)}`);
        }

        await tidy(cwd, worktree, branch, head.baseRefName);
        ctx.emit('pr.merged', { number }, event.jobId);
      } catch (err) {
        refuse(message(err));
      }
    });
  },
});

/** Keep .worktrees out of the repo's own `git status`, without editing a tracked file. */
function ignoreWorktrees(repoPath: string, r: ExecResult): void {
  if (r.code !== 0) return;
  const p = isAbsolute(r.stdout.trim()) ? r.stdout.trim() : join(repoPath, r.stdout.trim());
  const have = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (!have.split('\n').includes('.worktrees/')) appendFileSync(p, `${have && !have.endsWith('\n') ? '\n' : ''}.worktrees/\n`);
}

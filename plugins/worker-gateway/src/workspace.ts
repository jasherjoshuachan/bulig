import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, text } from './git.ts';

// Moving work between the kernel's job folder and a remote worker's folder. Code travels as a git patch against a commit both
// sides have (the commit the job branch grew from, which is on the remote). The kernel is the only side that commits: a worker's
// changes arrive as a patch, are applied to the job folder, and the github plugin commits them under the approved scope as usual.

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const IDENTITY = ['-c', 'user.name=bulig-worker', '-c', 'user.email=worker@bulig.invalid', '-c', 'commit.gpgsign=false'];

/** A symlink in a patch. Nothing Bulig commits is ever a symlink, and a link planted by one patch could be written through by the next. */
const SYMLINK_MODE = /^(?:(?:new file|deleted file|new|old) mode 120000|index [0-9a-f]+\.\.[0-9a-f]+ 120000)$/m;

/** The most paths one patch may name; a patch with more is not a stage's work. */
const MAX_PATHS = 20_000;

/**
 * The commit a job folder's branch grew from: where HEAD leaves the base branch. It uses the same candidates as the github plugin
 * (origin's default branch first), so a worker and the PR agree on what "the base" is. A repository with no remote has no commit a
 * worker could fetch, so it cannot be worked on remotely.
 */
export async function resolveBase(cwd: string, baseBranch?: string): Promise<string> {
  const remote = (await git(cwd, ['remote', 'get-url', 'origin'])).code === 0;
  if (!remote) throw new WorkspaceError('the repository has no origin, so a remote worker has nothing to fetch the code from');
  const candidates = baseBranch ? [`origin/${baseBranch}`, baseBranch] : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  for (const c of candidates) {
    if ((await git(cwd, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])).code !== 0) continue;
    const mb = await git(cwd, ['merge-base', 'HEAD', c]);
    const sha = mb.stdout.toString('utf8').trim();
    if (mb.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  throw new WorkspaceError(`could not find the commit the job branch grew from (tried ${candidates.join(', ')})`);
}

/** Everything the folder holds on top of `base`: committed work, edits, and new files. Ignored files stay out. The folder's own index is not touched. */
export async function diffAgainst(dir: string, base: string, maxBytes: number): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), 'bulig-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    const read = await git(dir, ['read-tree', 'HEAD'], { env });
    if (read.code !== 0) throw new WorkspaceError(`git read-tree failed: ${text(read)}`);
    const add = await git(dir, ['add', '-A'], { env });
    if (add.code !== 0) throw new WorkspaceError(`git add failed: ${text(add)}`);
    const diff = await git(dir, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', base], { env, maxOut: maxBytes });
    if (diff.truncated) throw new WorkspaceError(`the changes are larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
    if (diff.code !== 0) throw new WorkspaceError(`git diff failed: ${text(diff)}`);
    return diff.stdout;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Paths a patch names, read by git itself (so quoting and odd names are git's problem, not a regex's). */
async function pathsOf(dir: string, patch: Buffer): Promise<string[]> {
  const r = await git(dir, ['apply', '--numstat', '-z', '-'], { input: patch });
  if (r.code !== 0) throw new WorkspaceError(`the patch is not valid: ${text(r)}`);
  const parts = r.stdout.toString('utf8').split('\0').filter(Boolean);
  // Each entry is "added<TAB>deleted<TAB>path".
  return parts.map((p) => p.split('\t').slice(2).join('\t'));
}

/** Apply a patch to a folder, all or nothing. It refuses symlinks, anything under .git, and paths that climb out of the folder. */
export async function applyPatch(dir: string, patch: Buffer): Promise<void> {
  if (patch.length === 0) return;
  if (SYMLINK_MODE.test(patch.toString('latin1'))) throw new WorkspaceError('the patch contains a symlink');
  const paths = await pathsOf(dir, patch);
  if (paths.length > MAX_PATHS) throw new WorkspaceError(`the patch changes ${paths.length} files`);
  for (const p of paths) {
    const parts = p.split('/');
    if (p.startsWith('/') || parts.some((x) => x === '..' || x.toLowerCase() === '.git' || x === '')) {
      throw new WorkspaceError(`the patch names a path it may not touch: ${JSON.stringify(p.slice(0, 200))}`);
    }
  }
  const r = await git(dir, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
  if (r.code !== 0) throw new WorkspaceError(`the patch did not apply: ${text(r)}`);
}

// ----- the worker's side -----

/**
 * A folder for one stage on the worker's machine: a detached checkout of `base` from the worker's own clone, with the job's work so far
 * applied and committed as a baseline, so what the stage changes is exactly what `collectChanges` finds afterwards.
 */
export async function prepareWorkspace(clone: string, dir: string, base: string, patch: Buffer | undefined): Promise<void> {
  if ((await git(clone, ['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
    // Not here yet: ask the remote. A worker that cannot reach it says so, and the stage fails with that reason.
    const f = await git(clone, ['fetch', '--quiet', 'origin']);
    if (f.code !== 0) throw new WorkspaceError(`could not fetch from origin: ${text(f)}`);
    if ((await git(clone, ['cat-file', '-e', `${base}^{commit}`])).code !== 0) throw new WorkspaceError(`commit ${base.slice(0, 12)} is not in this clone even after a fetch`);
  }
  const add = await git(clone, ['worktree', 'add', '--detach', dir, base]);
  if (add.code !== 0) throw new WorkspaceError(`git worktree add failed: ${text(add)}`);
  if (patch && patch.length > 0) {
    await applyPatch(dir, patch);
    const staged = await git(dir, ['add', '-A']);
    if (staged.code !== 0) throw new WorkspaceError(`git add failed: ${text(staged)}`);
    const commit = await git(dir, [...IDENTITY, 'commit', '--no-verify', '-q', '-m', 'bulig: the job so far']);
    if (commit.code !== 0) throw new WorkspaceError(`git commit failed: ${text(commit)}`);
  }
}

/** What a stage changed in the worker's folder since `prepareWorkspace`, as a patch. Empty when nothing changed. */
export async function collectChanges(dir: string, maxBytes: number): Promise<Buffer> {
  return diffAgainst(dir, 'HEAD', maxBytes);
}

export async function removeWorkspace(clone: string, dir: string): Promise<void> {
  await git(clone, ['worktree', 'remove', '--force', dir]);
  await git(clone, ['worktree', 'prune']);
  await rm(dir, { recursive: true, force: true });
}

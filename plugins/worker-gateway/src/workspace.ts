import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitText as text } from '@bulig/git';

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

/** File modes a patch may never create: a symlink, and a gitlink (submodule). Compared as git reports them in an index, not as a patch spells them. */
const REFUSED_MODES = new Set(['120000', '160000']);

/** The entries of an index as "mode sha stage<TAB>path" lines, keyed by path. */
async function indexEntries(dir: string, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const r = await git(dir, ['ls-files', '-s', '-z'], { env, maxOut: 256 * 1024 * 1024 });
  if (r.code !== 0) throw new WorkspaceError(`git ls-files failed: ${text(r)}`);
  const out = new Map<string, string>();
  for (const entry of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    out.set(entry.slice(tab + 1), entry.slice(0, tab));
  }
  return out;
}

/**
 * Ask git what the patch would do, without doing it: apply it to a scratch copy of the folder's index and look at the entries it
 * created or changed. git has parsed the patch by then (modes are octal, so "0120000" and "120000" are the same thing to git and
 * different to a regex), and what is checked is the mode git will write. Throws if any entry would be a symlink or a gitlink.
 */
async function assertNoSpecialFiles(dir: string, patch: Buffer): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'bulig-apply-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    // The folder as it is now (including edits nobody committed), so a patch made against it applies.
    for (const args of [['read-tree', 'HEAD'], ['add', '-A']]) {
      const r = await git(dir, args, { env });
      if (r.code !== 0) throw new WorkspaceError(`git ${args[0]} failed: ${text(r)}`);
    }
    const before = await indexEntries(dir, env);
    const applied = await git(dir, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { env, input: patch });
    if (applied.code !== 0) throw new WorkspaceError(`the patch did not apply: ${text(applied)}`);
    for (const [path, entry] of await indexEntries(dir, env)) {
      if (before.get(path) === entry) continue;
      const mode = entry.split(' ')[0]!;
      if (REFUSED_MODES.has(mode)) throw new WorkspaceError(`the patch makes ${JSON.stringify(path.slice(0, 200))} a ${mode === '120000' ? 'symlink' : 'submodule'}, which is never allowed`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Apply a patch to a folder, all or nothing. It refuses symlinks and submodules (judged by git's own reading of the patch, see
 * assertNoSpecialFiles), anything under .git, and paths that climb out of the folder. The real apply also runs with
 * core.symlinks=false, so a link that somehow got past the checks would be written as a plain file.
 */
export async function applyPatch(dir: string, patch: Buffer): Promise<void> {
  if (patch.length === 0) return;
  const paths = await pathsOf(dir, patch);
  if (paths.length > MAX_PATHS) throw new WorkspaceError(`the patch changes ${paths.length} files`);
  for (const p of paths) {
    const parts = p.split('/');
    if (p.startsWith('/') || parts.some((x) => x === '..' || x.toLowerCase() === '.git' || x === '')) {
      throw new WorkspaceError(`the patch names a path it may not touch: ${JSON.stringify(p.slice(0, 200))}`);
    }
  }
  await assertNoSpecialFiles(dir, patch);
  const r = await git(dir, ['-c', 'core.symlinks=false', 'apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
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
    const f = await git(clone, ['fetch', '--quiet', 'origin'], { ambientConfig: true });
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

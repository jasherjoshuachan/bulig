/**
 * Scope: the list of repo paths a job is allowed to change.
 *
 * A plan ends with a SCOPE block, one path or glob per line. The pipeline stores the approved list, and the
 * github plugin refuses to commit a file that no line covers. Both sides use the code in this file, so a line
 * means the same thing when it is read and when it is enforced.
 *
 * The glob syntax is small on purpose. Only three characters are special:
 *   *   any run of characters inside one folder name (never a slash)
 *   **  as a whole path part: any number of folders
 *   ?   exactly one character (never a slash)
 * Everything else, including [ ] { } ( ) and spaces, is an ordinary character. Matching is case sensitive.
 * A wildcard never matches a name that starts with a dot (.env, .github); write the dot in the pattern to
 * cover one. There is no regular expression behind it, so a hostile pattern cannot make it slow.
 */

/** The most entries a SCOPE block may have. */
export const MAX_SCOPE_ENTRIES = 200;

export type ScopeEntry = { ok: true; pattern: string } | { ok: false; error: string };
export type ScopeParse = { ok: true; scope: string[] } | { ok: false; error: string };

const nfc = (s: string): string => s.normalize('NFC');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Clean one SCOPE line into a pattern, or say why it can't be one. */
export function normalizeScopeEntry(raw: string, opts: { allowBroad?: boolean } = {}): ScopeEntry {
  const shown = JSON.stringify(raw.length > 80 ? `${raw.slice(0, 80)}...` : raw);
  const bad = (why: string): ScopeEntry => ({ ok: false, error: `${shown}: ${why}` });
  let p = raw.trim();
  if (!p) return bad('empty');
  if (CONTROL.test(p)) return bad('contains a control character');
  if (p.includes('\\')) return bad('uses a backslash; write paths with /');
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return bad('absolute paths are not allowed; use a path relative to the repo root');
  if (/\s\([^)]*\)$/.test(p)) return bad('put only the path on the line, with no note after it');

  const folder = p.endsWith('/');
  const parts = nfc(p).split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return bad('".." is not allowed; paths stay inside the repo');
  if (parts.some((part) => part.toLowerCase() === '.git')) return bad('.git is not part of the work and can never be in scope');
  if (folder && parts.length > 0) parts.push('**');
  if (parts.length === 0) return bad('empty');
  const pattern = parts.join('/');
  if (!opts.allowBroad && parts.every((part) => part === '*' || part === '**')) {
    return bad('too broad: it matches every file. Name the files or folders the job will change (or set allowBroadScope)');
  }
  return { ok: true, pattern };
}

/**
 * Read the SCOPE block at the end of a plan. The block is a line that says `SCOPE:` (bold, bulleted or fenced
 * is fine) followed by bullet lines, one path or glob each. The last such block wins. It ends at the first line
 * that is not a bullet. Any bad line fails the whole block, so the plan is asked for again.
 */
export function parseScopeBlock(text: string, opts: { allowBroad?: boolean } = {}): ScopeParse {
  const lines = text.split(/\r?\n/);
  let head = -1;
  for (let i = 0; i < lines.length; i++) if (/^[\s>#*_`-]*SCOPE:[\s*_`]*$/.test(lines[i]!)) head = i;
  if (head < 0) return { ok: false, error: 'the plan has no SCOPE block (a line "SCOPE:" followed by one path or glob per line)' };

  const entries: string[] = [];
  for (let i = head + 1; i < lines.length; i++) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m) break;
    let entry = m[1]!;
    const wrapped = /^`([^`]+)`$/.exec(entry);
    if (wrapped) entry = wrapped[1]!;
    entries.push(entry);
  }
  if (entries.length === 0) return { ok: false, error: 'the SCOPE block is empty: it has no paths' };

  const scope: string[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const r = normalizeScopeEntry(entry, opts);
    if (!r.ok) problems.push(r.error);
    else if (!scope.includes(r.pattern)) scope.push(r.pattern);
  }
  if (problems.length) return { ok: false, error: `bad SCOPE lines: ${problems.join('; ')}` };
  if (scope.length > MAX_SCOPE_ENTRIES) return { ok: false, error: `too many SCOPE lines (${scope.length}, the most is ${MAX_SCOPE_ENTRIES}); group them with folders or globs` };
  return { ok: true, scope };
}

/** One path part against one pattern part. Works on whole characters, so an emoji counts as one for `?`. */
function matchPart(pattern: string, name: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.')) return false;
  const p = Array.from(pattern);
  const n = Array.from(name);
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === n[ni]))) {
      pi++;
      ni++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ni;
    } else if (star >= 0) {
      pi = star + 1;
      ni = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

function matchParts(pat: string[], pi: number, parts: string[], si: number): boolean {
  if (pi === pat.length) return si === parts.length;
  if (pat[pi] === '**') {
    if (pi === pat.length - 1) {
      // A trailing ** needs at least one more part, and none of them may be hidden.
      return si < parts.length && parts.slice(si).every((x) => !x.startsWith('.'));
    }
    for (let k = si; k <= parts.length; k++) {
      if (matchParts(pat, pi + 1, parts, k)) return true;
      if (k < parts.length && parts[k]!.startsWith('.')) return false;
    }
    return false;
  }
  return si < parts.length && matchPart(pat[pi]!, parts[si]!) && matchParts(pat, pi + 1, parts, si + 1);
}

/** True for a path that stays inside the repo: relative, no empty parts, no "." or ".." parts. */
export function isRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || CONTROL.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Does this repo-relative path match this scope pattern? A path that leaves the repo never matches. */
export function matchesGlob(path: string, pattern: string): boolean {
  if (!isRepoPath(path)) return false;
  const pat = nfc(pattern).split('/');
  return matchParts(pat, 0, nfc(path).split('/'), 0);
}

/** Does any pattern in the scope cover this path? */
export function matchesScope(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

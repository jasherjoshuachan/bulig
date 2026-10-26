/**
 * Scope: the list of repo paths a job is allowed to change.
 *
 * A plan ends with a SCOPE block: the line `SCOPE:` and then one path or glob per line, nothing else on the line.
 * A `- ` in front of each path is optional. The block goes in the reply itself, not in a plan file or any other
 * file. For example:
 *
 *   SCOPE:
 *   - README.md
 *   - src/lib/*.ts
 *
 * The pipeline stores the approved list, and the github plugin refuses to commit a file that no line covers. Both
 * sides use the code in this file, so a line means the same thing when it is read and when it is enforced. The
 * plan prompt, the retry message and ADR 0005 use the same wording and example (SCOPE_BLOCK_RULE and
 * SCOPE_BLOCK_EXAMPLE below; a test checks they agree).
 *
 * The glob syntax is small on purpose. Only three characters are special:
 *   *   any run of characters inside one folder name (never a slash)
 *   **  as a whole path part: any number of folders
 *   ?   exactly one character (never a slash)
 * Everything else, including [ ] { } ( ) and spaces, is an ordinary character. Matching is case sensitive.
 * A wildcard never matches a name that starts with a dot (.env, .github); write the dot in the pattern to
 * cover one. There is no regular expression behind it. Matching remembers the places it has already tried, so
 * the work grows with (pattern parts x path parts squared) at worst, and patterns are capped in length and in
 * number of parts, so it stays small.
 *
 * Too broad: a scope line is rejected unless allowBroad is set when (1) no part of it has a literal character
 * other than dots and wildcards, or (2) it has several parts and its first part is not a plain folder or file
 * name (no * or ?). So docs/** and src/**\/*.ts pass; **, *?, **\/?*, **\/*.md, *\/docs/** and .*\/** do not.
 */
import { clipText } from '@bulig/text';

/** How a SCOPE block is written, in the words the plan prompt, the retry message and ADR 0005 all use. */
export const SCOPE_BLOCK_RULE = 'the line `SCOPE:` and then one path or glob per line, nothing else on the line. A `- ` in front of each path is optional';
/** Where the block goes. A plan stage runs in Claude Code's plan mode, which asks for a plan file; the pipeline only reads the reply. */
export const SCOPE_BLOCK_IN_REPLY = 'Put the block in your reply itself, not in a plan file or any other file';
/** The one example every description of the block shows. */
export const SCOPE_BLOCK_EXAMPLE = 'SCOPE:\n- README.md\n- src/lib/*.ts';

/** The most entries a SCOPE block may have. */
export const MAX_SCOPE_ENTRIES = 100;
/** The longest scope line, in characters, and the most path parts in one line. */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_PATTERN_PARTS = 32;
/** The deepest path (in parts) a scope will ever cover. A deeper path never matches, so it counts as out of scope. */
export const MAX_PATH_PARTS = 32;

export type ScopeEntry = { ok: true; pattern: string } | { ok: false; error: string };
export type ScopeParse = { ok: true; scope: string[] } | { ok: false; error: string };

const nfc = (s: string): string => s.normalize('NFC');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Clean one SCOPE line into a pattern, or say why it can't be one. */
export function normalizeScopeEntry(raw: string, opts: { allowBroad?: boolean } = {}): ScopeEntry {
  const shown = JSON.stringify(raw.length > 80 ? `${clipText(raw, 80)}...` : raw);
  const bad = (why: string): ScopeEntry => ({ ok: false, error: `${shown}: ${why}` });
  let p = raw.trim();
  if (!p) return bad('empty');
  if (CONTROL.test(p)) return bad('contains a control character');
  if (p.includes('\\')) return bad('uses a backslash; write paths with /');
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return bad('absolute paths are not allowed; use a path relative to the repo root');
  // The length check comes before the note check: that regex is quadratic on a long line, so it only ever sees 200 characters.
  if (p.length > MAX_PATTERN_LENGTH) return bad(`too long (${p.length} characters, the most is ${MAX_PATTERN_LENGTH})`);
  if (/\s\([^)]*\)$/.test(p)) return bad('put only the path on the line, with no note after it');

  const folder = p.endsWith('/');
  const parts = collapseStars(nfc(p).split('/').filter((part) => part !== '' && part !== '.'));
  if (parts.includes('..')) return bad('".." is not allowed; paths stay inside the repo');
  if (parts.some((part) => part.toLowerCase() === '.git')) return bad('.git is not part of the work and can never be in scope');
  if (folder && parts.length > 0 && parts.at(-1) !== '**') parts.push('**');
  if (parts.length === 0) return bad('empty');
  if (parts.length > MAX_PATTERN_PARTS) return bad(`too many parts (${parts.length}, the most is ${MAX_PATTERN_PARTS})`);
  const pattern = parts.join('/');
  if (!opts.allowBroad && isBroad(parts)) {
    return bad('too broad: it can match files all over the repo. Start with a folder or file name (docs/**, src/**/*.ts, README.md), or set allowBroadScope');
  }
  return { ok: true, pattern };
}

/** Replace a run of ** parts with one. */
const collapseStars = (parts: string[]): string[] => parts.filter((part, i) => !(part === '**' && parts[i - 1] === '**'));

/** True when a literal character other than a dot is in the part. */
const hasLiteral = (part: string) => /[^*?.]/.test(part);

function isBroad(parts: string[]): boolean {
  if (!parts.some(hasLiteral)) return true;
  if (parts.length === 1) return false;
  return /[*?]/.test(parts[0]!);
}

/** A bullet: optional indent, `-` or `*`, then at least one space. What follows is the entry. */
const BULLET = /^\s*[-*]\s+/;
/** The characters a bare path line may use: letters, marks and digits of any script, and . _ - / * ? @ + ~ ( ) [ ] { }. */
const PATH_CHARS = /^[\p{L}\p{M}\p{N}._\-/*?@+~()[\]{}]+$/u;
/** At least one letter, mark, digit or wildcard, so a line of only dots, dashes or slashes is not a path. */
const PATH_SUBSTANCE = /[\p{L}\p{M}\p{N}*?]/u;
/** A Markdown rule written with no spaces: ---, *** or ___. */
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/;
/** A code fence line, which closes a block that sits inside one. */
const FENCE = /^\s*(?:```|~~~)/;
const BACKTICKED = /^`([^`]+)`$/;

/** A word in Markdown emphasis, like **Notes** or _note_: the same * or _ marker at both ends, a letter or digit, and no slash. */
function isEmphasis(s: string): boolean {
  const mark = /^(?:\*\*|__|\*|_)/.exec(s)?.[0];
  if (!mark) return false;
  return s.length > 2 * mark.length && s.endsWith(mark) && !s.includes('/') && /[\p{L}\p{N}]/u.test(s);
}

/** The entry on a bare (unbulleted) line, or undefined when the line is not a path line. See parseScopeBlock. */
function bareEntry(line: string): string | undefined {
  let s = line.trim();
  const wrapped = BACKTICKED.exec(s);
  if (wrapped) s = wrapped[1]!;
  if (!PATH_CHARS.test(s) || !PATH_SUBSTANCE.test(s)) return undefined;
  if (s.endsWith('.') || RULE_LINE.test(s) || isEmphasis(s)) return undefined;
  return s;
}

/**
 * Read the SCOPE block at the end of a plan.
 *
 * The block starts at a line that says `SCOPE:` (bold, bulleted, quoted or inside a code fence is fine). The last
 * such line wins. The lines right after it are its entries, one path or glob each, written either way:
 *  - a bullet line: `-` or `*`, a space, then the entry (anything; a bad one fails the block below), or
 *  - a bare path line. After trimming and taking off one pair of backticks around the whole line, it counts as a
 *    path only when (1) it is one token: no spaces, tabs or backticks inside; (2) every character is a letter, mark
 *    or digit of any script, or one of . _ - / * ? @ + ~ ( ) [ ] { }; (3) it has at least one letter, digit or
 *    wildcard; (4) it does not end with a dot; and (5) it is not Markdown decoration (a rule like --- or ***, or a
 *    word in emphasis like **Notes**).
 * Bullet and bare lines can be mixed, and either may be wrapped in backticks.
 *
 * The block ends at the first blank line, at a code fence line (```), or at any line that is neither a bullet nor
 * a path line. So prose written straight after a bare block, with no blank line between, ends the block: a
 * sentence has spaces in it, and a one-word line such as "Notes:", "Done." or **Notes** breaks rule 2, 4 or 5.
 * The rules lean towards ending the block: a path they do not recognise is left out of the scope, so a commit that
 * needs it is refused and names the file. They never let a sentence in as a path.
 *
 * Every entry then goes through normalizeScopeEntry, and any bad entry (`..`, `.git`, absolute, too broad, too
 * long) fails the whole block, so the plan is asked for again. A bare `../x`, `.git/x` or `**` is a path line by
 * the rules above, so it fails the block rather than ending it.
 *
 * The text is model output and can be large. Every regex here is anchored and linear, and normalizeScopeEntry
 * checks the length before anything else that could cost more.
 */
export function parseScopeBlock(text: string, opts: { allowBroad?: boolean } = {}): ScopeParse {
  const lines = text.split(/\r?\n/);
  let head = -1;
  for (let i = 0; i < lines.length; i++) if (/^[\s>#*_`-]*SCOPE:[\s*_`]*$/.test(lines[i]!)) head = i;
  if (head < 0) return { ok: false, error: `the reply has no SCOPE block (${SCOPE_BLOCK_RULE}). ${SCOPE_BLOCK_IN_REPLY}` };

  const entries: string[] = [];
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || FENCE.test(line)) break;
    const bullet = BULLET.exec(line);
    let entry = bullet ? line.slice(bullet[0].length).trim() : bareEntry(line);
    if (!entry) break;
    if (bullet) {
      const wrapped = BACKTICKED.exec(entry);
      if (wrapped) entry = wrapped[1]!;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return { ok: false, error: `the SCOPE block is empty: it has no paths. Put one path or glob on each line right after "SCOPE:", with no blank line between. ${SCOPE_BLOCK_IN_REPLY}` };

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

function matchParts(pat: string[], parts: string[]): boolean {
  // Remember (pattern part, path part) pairs already tried, so repeated ** parts cannot multiply the work.
  const failed = new Set<number>();
  const width = parts.length + 1;
  const go = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === parts.length;
    const key = pi * width + si;
    if (failed.has(key)) return false;
    let ok = false;
    if (pat[pi] === '**') {
      if (pi === pat.length - 1) {
        // A trailing ** needs at least one more part, and none of them may be hidden.
        ok = si < parts.length && parts.slice(si).every((x) => !x.startsWith('.'));
      } else {
        for (let k = si; k <= parts.length && !ok; k++) {
          ok = go(pi + 1, k);
          if (!ok && k < parts.length && parts[k]!.startsWith('.')) break;
        }
      }
    } else {
      ok = si < parts.length && matchPart(pat[pi]!, parts[si]!) && go(pi + 1, si + 1);
    }
    if (!ok) failed.add(key);
    return ok;
  };
  return go(0, 0);
}

/** True for a well-formed path inside the repo: relative, no empty parts, no "." or ".." parts. Any depth. */
export function isPlainRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || CONTROL.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A plain repo path that is also at most MAX_PATH_PARTS deep. */
export function isRepoPath(path: string): boolean {
  return isPlainRepoPath(path) && path.split('/').length <= MAX_PATH_PARTS;
}

/** Does this repo-relative path match this scope pattern? A path that leaves the repo never matches. */
export function matchesGlob(path: string, pattern: string): boolean {
  if (!isRepoPath(path)) return false;
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  return matchParts(collapseStars(nfc(pattern).split('/')), nfc(path).split('/'));
}

/** Does any pattern in the scope cover this path? */
export function matchesScope(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

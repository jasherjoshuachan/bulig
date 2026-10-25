/**
 * Claim detection and matching. Everything here is a short, explicit list so a person can read it in one sitting.
 * It finds sentences that assert a result and asks whether the tool-use records of the same turn back them up.
 * It does not understand language: see the README for what it cannot catch.
 */
import { clipText } from '@bulig/text';

/** One thing Claude did in a turn. Built by the worker from the tool-use stream, never from the model's text. */
export interface EvidenceRecord {
  tool: string;
  kind: 'read' | 'search' | 'edit' | 'run' | 'other';
  target: string;
  ok: boolean;
  /** For a Bash run: the files its output showed in full, from the `diff --git a/<path> b/<path>` headers. Counted only for a git diff or show (see touches). */
  diffPaths?: string[];
}

export type ClaimKind = 'test' | 'build' | 'file' | 'changed' | 'looked';

export interface Claim {
  kind: ClaimKind;
  /** The sentence, flattened and clipped. */
  text: string;
  /** For a file claim: the paths the sentence names. */
  paths: string[];
  /**
   * For a file claim: the paths written bare every time (no `./`, `../` or `/` in front), so they could be a package import
   * specifier rather than a file. Always empty when the sentence says it read, opened or checked a file.
   */
  bare?: string[];
  /** For a file claim: the bare paths that sit, quoted, in an `import ... from`, `export ... from`, `import(...)` or `require(...)` in the sentence. */
  imported?: string[];
}

/**
 * What the worktree looked like when the run ended. Built by the worker from the disk, never from the model's text, and
 * used only from a trusted evidence source. See RepoFacts in worker-claude-code.
 */
export interface RepoFacts {
  /** Every folder and symlink name in the worktree (outside node_modules and .git), lowercased. */
  dirs: readonly string[];
  /** The worktree package.json's dependency and devDependency names. Missing when they could not be read. */
  deps?: readonly string[];
}

export interface Finding {
  claim: Claim;
  /** Why nothing backs it, in words for the person reading the card. */
  reason: string;
}

// ---------- text for people ----------

/** Control characters, zero-width characters and the bidi marks that can make text read as something else. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠⁦-⁩﻿]+/g;

/** One line, no hidden characters, cut at `n` characters. Everything shown to a person goes through this. */
export const clean = (s: unknown, n = 160): string => {
  const t = String(s ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${clipText(t, n - 1)}…` : t;
};

// ---------- the claim patterns (the documented list) ----------

/** A sentence with one of these is a plan, a condition or a wish, not a report. It is skipped. */
export const SKIP_WORDS =
  /\b(should|must|shall|will|would|could|might|may|can|cannot|needs?(?:ed)? to|has to|have to|to make|make sure|ensure|verify|check that|until|unless|if|whether|once|so that|expect(?:s|ed)?|wants?)\b/i;
/** A pass claim in a sentence like this is a report of failure. */
const NEGATION = /\b(not|never|fail(?:s|ed|ing|ure)?|broken|without|no longer)\b|n't/i;

/**
 * Phrases where a failure word says the opposite: "0 failed", "none failed", "not a single test failed", "without
 * warnings". They are blanked before NEGATION is tested, so a clean report is not read as a failure report. A phrase
 * that is not on this list ("3 failed", "without running the migration") still skips the sentence.
 */
const NO_FAILURE: readonly RegExp[] = [
  /\b(?:0|zero|no|none)\s+(?:(?:tests?|specs?|checks?)\s+)?fail(?:s|ed|ing|ures?)?\b/gi,
  /\bnot\s+(?:a\s+single|one|any)\s+(?:(?:tests?|specs?|checks?)\s+)?fail(?:s|ed|ing|ures?)?\b/gi,
  /\bwithout\s+(?:any\s+|a\s+single\s+)?(?:new\s+)?(?:(?:type|lint)\s+)?(?:errors?|fail(?:s|ing|ures?)|warnings?|issues?|problems?)\b/gi,
];
/**
 * Words from SKIP_WORDS in a sense that is not a plan: "I can confirm" reports, and "once I fixed it" is a past
 * event (a condition would say "once I fix it"). The word is blanked before SKIP_WORDS is tested.
 */
const NOT_A_PLAN: readonly RegExp[] = [
  /\b(I|we)\s+can(?=\s+(?:confirm|see|say|report|tell)\b)/gi,
  /\bonce(?=\s+(?:I|we)\s+(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|wrote|changed|edited|modified|rewrote|replaced|patched|resolved)\b)/gi,
];
/** Replace each match with a space, keeping the first capture group when there is one ("I can" -> "I "). */
const blank = (s: string, res: readonly RegExp[]) => res.reduce((t, re) => t.replace(re, (_m, g1: unknown) => (typeof g1 === 'string' ? `${g1} ` : ' ')), s);

interface Pattern {
  kind: ClaimKind;
  re: RegExp;
  /** Skip the sentence when it is negated ("tests do not pass"). */
  negatable?: boolean;
}

/** Test, build and change claims. File claims are handled separately because they need a path. */
export const CLAIM_PATTERNS: readonly Pattern[] = [
  {
    kind: 'test',
    negatable: true,
    re: /\b(?:tests?|specs?|test suite|suite)\s+(?:(?:are|were|is|now|all|still|also)\s+)*(?:pass(?:ed|es|ing)?|green|succe(?:ed|eded|eds|ssful)|ok)\b/i,
  },
  { kind: 'test', negatable: true, re: /\b\d+\s+(?:tests?\s+|specs?\s+)?passed\b/i },
  { kind: 'test', re: /\b(?:tests?|suite)\s+(?:run|ran)\s+(?:clean|green|successfully)\b/i },
  { kind: 'test', negatable: true, re: /\bverify\.sh\b[^.]{0,30}\b(?:pass(?:ed|es)?|ok|succe\w+)\b/i },
  {
    kind: 'build',
    negatable: true,
    re: /\b(?:build|typecheck|type-check|type check|lint(?:ing)?|compil(?:e|es|ed|ation)|tsc)\s+(?:(?:is|are|was|were|now|still|also)\s+)*(?:pass(?:ed|es|ing)?|clean|green|succe(?:ed|eded|eds|ssful(?:ly)?)|ok)\b/i,
  },
  { kind: 'build', re: /\bno\s+(?:type|lint|compile|compilation|typescript|build)\s+errors?\b/i },
  { kind: 'build', re: /\b(?:builds?|compiles?|typechecks?|type-checks?)\s+(?:cleanly|successfully|without errors)\b/i },
  {
    kind: 'changed',
    re: /\b(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|also\s+)?(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|wrote|written|changed|edited|modified|rewrote|replaced|patched|resolved)\b/i,
  },
  {
    kind: 'changed',
    re: /\b(?:has|have)\s+(?:now\s+|already\s+)?been\s+(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|changed|edited|modified|patched|resolved)\b|\b(?:is|are)\s+now\s+(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|changed|edited|modified|patched|resolved)\b/i,
  },
];

/** A clause that starts with the verb, with the "I" left out: "I added no tests but edited README.md". */
const BARE_CHANGE =
  /^(?:(?:just|now|also|then)\s+)*(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|wrote|written|changed|edited|modified|rewrote|replaced|patched|resolved)\b/i;
const FIRST_PERSON = /\b(?:I|we)\b|\b(?:I|we)['\u2019](?:ve|d)\b/i;
/** Where a sentence splits into parts that can each say something different. */
const CLAUSE_BREAK = /[,;:]|\b(?:but|and|so|then|although|though|while|however|yet|after|since|because|when|before|once|until|unless|if)\b/i;
/** A word before the verb that turns the clause into "none of this happened". */
const NEGATOR_BEFORE = /\b(?:no|not|never|none|nothing|nobody|without|zero|hardly|barely)\b|n['’]t/i;
/** How many words before "has been changed" can hold the "nothing" it is about: the nearest four ("No one noticed it has been updated." reads clean, a fifth word back does not). */
const NEGATOR_REACH = 4;
/** "I added no tests", "I changed nothing": the verb is followed straight away by a word that says there was none. */
const NEGATOR_AFTER = /^\s+(?:no|nothing|none|zero|nobody|neither)\b/i;

/**
 * Does the sentence say something was changed? "I added no tests" and "nothing has been changed" say the opposite
 * and are not a claim. The sentence is cut into clauses first, so a negation in one ("I added no tests") does not
 * hide an affirmative claim in another ("but edited README.md"). Every step is a pass over the text with no
 * nested repeats, so the time grows with the length of the sentence and no more.
 */
export function claimsChange(sentence: string, res: readonly RegExp[]): boolean {
  const globals = res.map((re) => new RegExp(re.source, 'gi'));
  // A clause with no subject only counts when an earlier clause of the sentence is the author's own ("I added no tests but edited ...").
  let firstPerson = false;
  for (const raw of sentence.split(CLAUSE_BREAK)) {
    const clause = raw.trim();
    if (!clause) continue;
    const bare = firstPerson && BARE_CHANGE.exec(clause);
    if (bare && !NEGATOR_AFTER.test(clause.slice(bare[0].length))) return true;
    for (const re of globals) {
      for (const m of clause.matchAll(re)) {
        const at = m.index ?? 0;
        if (NEGATOR_AFTER.test(clause.slice(at + m[0].length))) continue;
        // "I added ..." names its own subject, so a "no" before it is about something else ("no failures after I fixed it").
        // "has been changed" takes its subject from the words just before it ("nothing has been changed"), so look at the last few only.
        if (!/^(?:I|we)\b/i.test(m[0]) && NEGATOR_BEFORE.test(clause.slice(Math.max(0, at - 60), at).split(/\s+/).filter(Boolean).slice(-NEGATOR_REACH).join(' '))) continue;
        return true;
      }
    }
    if (!firstPerson) firstPerson = FIRST_PERSON.test(clause);
  }
  return false;
}

const CHANGE_PATTERNS = CLAIM_PATTERNS.filter((p) => p.kind === 'changed').map((p) => p.re);

/** A path in a sentence: a name with one of these extensions, with or without folders. */
const PATH = /(?<![\w@./-])(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml|toml|sh|py|css|html|sql|txt|lock|env)(?![\w/-])/gi;
/** What a sentence says about a file that a read would show. */
const FILE_VERB =
  /\b(?:contains?|defines?|exports?|imports?|declares?|implements?|already\s+(?:has|uses|contains)|currently\s+(?:has|uses|contains|exports|defines)|is\s+(?:present|missing|empty)|exists?|does(?:n't| not)\s+(?:contain|have|exist))\b/i;
/** "I read src/a.ts". */
const READ_SAID = /\b(?:I|we)(?:'ve| have)?\s+(?:just\s+)?(?:read|opened|checked|inspected|reviewed|looked at|examined|verified)\b/i;
/** A sentence about a file that does not exist yet is a plan. */
const NEW_FILE = /\b(?:new|create[sd]?|creating|add(?:s|ed|ing)?|introduc\w+|from scratch|write|writing)\b/i;

/** Text outside code fences, split into sentences. Fenced code is quoted material, not a statement. */
export function sentences(text: string): string[] {
  const noCode = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  return noCode
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const stripPath = (p: string) => p.replace(/^(?:\.\/)+/, '').replace(/[.,;:)]+$/, '');

/**
 * A quoted module specifier in code the sentence quotes: `import chunk from 'lodash/chunk.js'`, `import 'x'`,
 * `export { a } from 'x'`, `import('x')`, `require('x')`. The second, fourth or sixth group is the specifier. Every repeat has a
 * small fixed bound, so a run of a million spaces after `import` costs a few hundred steps, not a scan per space.
 */
const SPECIFIER =
  /\b(?:import|export)\s(?:[\w$*{},\s]{0,200}?\s)?from\s{0,10}(['"])([^'"\s]{1,300})\1|\bimport\s{0,10}(['"])([^'"\s]{1,300})\3|\b(?:require|import)\s{0,10}\(\s{0,10}(['"])([^'"\s]{1,300})\5\s{0,10}\)/g;

/** Every claim in a piece of stage text. `stage` matters only for the VERDICT line, which means different things in test and review. */
export function findClaims(text: string, stage: string): Claim[] {
  const found: Claim[] = [];
  for (const s of sentences(text)) {
    const show = clean(s, 120);
    const isVerdict = /\bVERDICT:\s*PASS\b/i.test(s);
    if (isVerdict) {
      // The pipeline's own pass line. On a test stage it says "tests pass", on a review stage "I looked at the change".
      if (stage === 'test') found.push({ kind: 'test', text: show, paths: [] });
      else if (stage === 'review') found.push({ kind: 'looked', text: show, paths: [] });
      continue;
    }
    if (SKIP_WORDS.test(blank(s, NOT_A_PLAN))) continue;
    const failureText = blank(s, NO_FAILURE);
    const seen = new Set<ClaimKind>();
    for (const p of CLAIM_PATTERNS) {
      if (p.kind === 'changed' || seen.has(p.kind) || !p.re.test(s)) continue;
      if (p.negatable && NEGATION.test(failureText)) continue;
      seen.add(p.kind);
      found.push({ kind: p.kind, text: show, paths: [] });
    }
    if (claimsChange(s, CHANGE_PATTERNS)) found.push({ kind: 'changed', text: show, paths: [] });
    const saysRead = READ_SAID.test(s);
    if (!NEW_FILE.test(s) && (FILE_VERB.test(s) || saysRead)) {
      const raw = [...s.matchAll(PATH)].map((m) => m[0]).filter((p) => !/^https?:/i.test(p));
      const paths = [...new Set(raw.map(stripPath))].slice(0, 5);
      if (paths.length) {
        // A path counts as bare only if no mention of it had a ./ in front (stripPath drops that, so look at the raw text).
        const bare = saysRead ? [] : paths.filter((p) => raw.every((r) => stripPath(r) !== p || !/^[./]/.test(r)));
        const quoted = new Set([...s.matchAll(SPECIFIER)].map((m) => m[2] ?? m[4] ?? m[6] ?? ''));
        found.push({ kind: 'file', text: show, paths, bare, imported: bare.filter((p) => quoted.has(p)) });
      }
    }
  }
  return found;
}

// ---------- matching claims to records ----------

/** The first word of each shell segment, after `cd`, env assignments and `time`. `echo pnpm test` is not a test run. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^(?:time|sudo)\s+/, ''))
    .filter((seg) => seg && !/^cd\s/.test(seg));
}

const PACKAGE_RUNNER = /^(?:pnpm|npm|yarn|bun)\s+(.*)$/;
const words = (s: string) => s.split(/\s+/);

/** Does this shell command run the project's tests? */
export function isTestCommand(command: string): boolean {
  return segments(command).some((seg) => {
    const pkg = PACKAGE_RUNNER.exec(seg);
    if (pkg) return words(pkg[1]!).some((w) => /^(?:test|vitest|jest)$/.test(w));
    return /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:vitest|jest|mocha|pytest)\b/.test(seg) || /^(?:python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|node\s+--test)\b/.test(seg) || isVerify(seg);
  });
}

const isVerify = (seg: string) => /^(?:bash\s+|sh\s+)?(?:\.\/)?scripts\/verify\.sh\b/.test(seg);

/** Does this shell command build, typecheck or lint? */
export function isBuildCommand(command: string): boolean {
  return segments(command).some((seg) => {
    const pkg = PACKAGE_RUNNER.exec(seg);
    if (pkg) return words(pkg[1]!).some((w) => /^(?:build|typecheck|type-check|lint|check|tsc)$/.test(w));
    return /^(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|eslint|biome)\b/.test(seg) || /^(?:cargo\s+(?:build|check)|go\s+build)\b/.test(seg) || isVerify(seg);
  });
}

/** Does this command show the person a diff or a commit? Counts as looking at the change. */
const isDiffCommand = (command: string) => segments(command).some((seg) => /^git\s+(?:diff|show|log)\b/.test(seg));

const normal = (p: string) => p.replace(/^(?:\.\/)+/, '').replace(/\\/g, '/');

/** `git diff` or `git show`, after git's own options. `-c` is left out: it can set an alias or an external diff program. */
const GIT_DIFF = /^git(?:\s+(?:-C\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+))*\s+(?:diff|show)\b/;
/** A pager-like filter with options only (`head -200`, `tail -n 50`): it can cut git's output, not add to it. */
const FILTER = /^(?:head|tail)(?:\s+-[\w-]+)*(?:\s+\d+)?$/;
/**
 * Options that print lines without the diff's own prefix, so file or message text can start a line with `diff --git`:
 * word diffs, changed indicators or prefixes, an output file, an external diff or textconv, and a commit format (`%B`).
 */
const UNPREFIXED = /^(?:--word-diff|--color-words|--output|--line-prefix|--src-prefix|--dst-prefix|--ext-diff|--textconv|--format|--pretty)/;
/** The worker cuts a command at 300 characters (one less before an emoji), so a target this long may have lost its end. */
const CUT_AT = 299;

/** Is this shell text one that segments() reads as written? A lone `&`, `$(..)`, backticks or `<(..)` hide a second command. */
const plainShell = (command: string) => {
  const rest = command.replace(/\d*>&\d+|&>/g, ' ').replace(/&&/g, ' ');
  return !/[&`]|\$\(|[<>]\(/.test(rest);
};

/**
 * Was all the output of this command a diff printed by git? Only then are its diff headers taken as files the person
 * saw. Every segment must be `git diff` or `git show` (or a head/tail filter), with no option that prints lines
 * without a prefix and no `<rev>:<path>` (which prints the file itself). `cat notes.md`, `echo ...; git diff --stat`,
 * `git show HEAD:notes.md`, `git log --format=%B` and `git -c alias.x='!cat f' x` all count for nothing.
 */
const printedByGitDiff = (command: string) => {
  if (command.length >= CUT_AT || !plainShell(command)) return false;
  // segments() drops `VAR=...` in front of a command, and GIT_EXTERNAL_DIFF=cat would print the file as is.
  if (command.split(/&&|\|\||;|\||\n/).some((seg) => /^\s*\w+=/.test(seg))) return false;
  const segs = segments(command);
  const gitDiff = (seg: string) =>
    GIT_DIFF.test(seg) && words(seg).every((w) => {
      const word = w.replace(/^["']+|["']+$/g, '');
      return !UNPREFIXED.test(word) && (word.startsWith('-') || !word.includes(':'));
    });
  return segs.some(gitDiff) && segs.every((seg) => gitDiff(seg) || FILTER.test(seg));
};

const samePath = (have: string, want: string) => have === want || have.endsWith(`/${want}`);

/** `lodash` from `lodash/chunk.js`, `@scope/pkg` from `@scope/pkg/file.js`, by npm's rules for names. A path with no file after the package name gives nothing. */
export function packageOf(path: string): string | undefined {
  const m = /^((?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*)\/(.+)$/.exec(path);
  if (!m || m[1]!.length > 214) return undefined;
  // `lodash/../src/a.js` and `x/node_modules/y.js` are paths into the tree, not a specifier.
  if (path.split('/').some((seg) => seg === '.' || seg === '..' || seg === '' || seg === 'node_modules')) return undefined;
  return m[1];
}

/**
 * Is this path of a file claim a package import specifier, not a file? Only when all of these hold:
 * - it was written bare in the sentence, and the sentence does not say it read or opened a file (Claim.bare);
 * - its first part is a package name (`lodash`, `@scope/pkg`) followed by a file;
 * - no folder or symlink with that first name exists anywhere in the worktree, so the path cannot be a repo file;
 * - and either the sentence quotes it in an import, export-from or require, or the package is in the worktree's package.json.
 * With no facts from the worker, nothing is a specifier and every path needs a record, as before.
 */
export function isModuleRef(path: string, claim: Claim, repo: RepoFacts | undefined): boolean {
  if (!repo || !claim.bare?.includes(path)) return false;
  const pkg = packageOf(path);
  if (!pkg) return false;
  const first = pkg.split('/')[0]!;
  if (repo.dirs.some((d) => d.toLowerCase() === first)) return false;
  return !!claim.imported?.includes(path) || !!repo.deps?.includes(pkg);
}

/** Is `path` the file of this record, or named by the command of a run/search record? */
function touches(rec: EvidenceRecord, path: string): boolean {
  const want = normal(path);
  const have = normal(rec.target);
  if (rec.kind === 'read' || rec.kind === 'edit') return samePath(have, want);
  if (rec.kind !== 'run' || !rec.ok) return false;
  if (words(have).some((w) => normal(w.replace(/^["'`]|["'`]$/g, '')) === want || normal(w).endsWith(`/${want}`))) return true;
  // A successful `git diff <base> HEAD` showed every file it printed a header for. A `--stat` prints no headers, so it shows none.
  return !!rec.diffPaths?.length && printedByGitDiff(rec.target) && rec.diffPaths.some((p) => samePath(normal(p), want));
}

/** Which claims have no record behind them. A claim with a record is not listed. `repo` is what the worker read from the worktree, if anything. */
export function checkClaims(claims: readonly Claim[], records: readonly EvidenceRecord[], repo?: RepoFacts): Finding[] {
  const runs = records.filter((r) => r.kind === 'run');
  const all: Finding[] = [];
  const out = { push: (f: Finding) => void (all.some((x) => x.reason === f.reason) || all.push(f)) };
  for (const claim of claims) {
    switch (claim.kind) {
      case 'test': {
        const tests = runs.filter((r) => isTestCommand(r.target));
        if (tests.some((r) => r.ok)) break;
        out.push({ claim, reason: tests.length ? 'the only test run this turn failed' : 'no record of a test run this turn' });
        break;
      }
      case 'build': {
        const builds = runs.filter((r) => isBuildCommand(r.target));
        if (builds.some((r) => r.ok)) break;
        out.push({ claim, reason: builds.length ? 'the only build or check run this turn failed' : 'no record of a build, typecheck or lint run this turn' });
        break;
      }
      case 'changed':
        if (!records.some((r) => r.kind === 'edit' && r.ok)) out.push({ claim, reason: 'no record of a file edit this turn' });
        break;
      case 'looked':
        if (!records.some((r) => (r.kind === 'read' && r.ok) || (r.kind === 'run' && r.ok && isDiffCommand(r.target)))) {
          out.push({ claim, reason: 'no record of reading a file or a diff this turn' });
        }
        break;
      case 'file':
        for (const path of claim.paths) {
          if (isModuleRef(path, claim, repo)) continue;
          if (!records.some((r) => touches(r, path))) out.push({ claim: { ...claim, paths: [path] }, reason: `no record of reading ${clean(path, 80)} this turn` });
        }
        break;
    }
  }
  // "All tests pass" and "VERDICT: PASS" with no test run are one problem, so they are one line.
  return all;
}

// ---------- what the person sees ----------

/** Most diff paths kept from one record. The worker keeps the same number. */
const MAX_DIFF_PATHS = 200;

/** Check the shape of what arrived as records. Anything that is not exactly a record is dropped. */
export function parseRecords(raw: unknown): EvidenceRecord[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(['read', 'search', 'edit', 'run', 'other']);
  const out: EvidenceRecord[] = [];
  for (const r of raw.slice(0, 300) as Record<string, unknown>[]) {
    if (typeof r !== 'object' || r === null) continue;
    if (typeof r.tool !== 'string' || typeof r.kind !== 'string' || !kinds.has(r.kind) || typeof r.target !== 'string' || typeof r.ok !== 'boolean') continue;
    const rec: EvidenceRecord = { tool: r.tool, kind: r.kind as EvidenceRecord['kind'], target: r.target, ok: r.ok };
    // A list that is not all strings is dropped, not the record: the record still counts for what it is, and the list for nothing.
    if (Array.isArray(r.diffPaths) && r.diffPaths.length && r.diffPaths.every((p) => typeof p === 'string')) rec.diffPaths = (r.diffPaths as string[]).slice(0, MAX_DIFF_PATHS);
    out.push(rec);
  }
  return out;
}

/** Most names believed from one fact list, and the longest name: the worker's REPO_FACT_LIMITS, which the gateway's schema also enforces. */
const MAX_FACT_NAMES = 2000;
const MAX_FACT_NAME_LENGTH = 214;

/** Check the shape of the worker's worktree facts. Anything that is not exactly that shape gives undefined, and the gate then works without them. */
export function parseRepoFacts(raw: unknown): RepoFacts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const names = (v: unknown) =>
    Array.isArray(v) && v.length <= MAX_FACT_NAMES && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_FACT_NAME_LENGTH) ? (v as string[]) : undefined;
  const dirs = names(r.dirs);
  if (!dirs) return undefined;
  if (r.deps === undefined) return { dirs };
  const deps = names(r.deps);
  return deps ? { dirs, deps } : undefined;
}

const VERB: Record<EvidenceRecord['kind'], string> = { read: 'read', search: 'searched', edit: 'edited', run: 'ran', other: 'used' };

/** One line per distinct record, for the PR and the card. */
export function evidenceLines(records: readonly EvidenceRecord[], max = 12): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const what = r.kind === 'other' ? clean(r.tool, 40) : clean(r.target, 140);
    const line = `${VERB[r.kind]} ${what}${r.kind === 'run' ? (r.ok ? ' (ok)' : ' (failed)') : r.ok ? '' : ' (no result)'}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.length > max ? [...lines.slice(0, max), `... and ${lines.length - max} more`] : lines;
}

/** One line of counts. "nothing" is a real answer and the person should see it. */
export function evidenceSummary(records: readonly EvidenceRecord[]): string {
  if (records.length === 0) return 'Evidence this turn: no tool calls recorded';
  const n = (k: EvidenceRecord['kind']) => records.filter((r) => r.kind === k).length;
  const failed = records.filter((r) => !r.ok).length;
  const parts = [`${n('read')} read`, `${n('search')} searched`, `${n('edit')} edited`, `${n('run')} commands run`, `${n('other')} other`].filter((x) => !x.startsWith('0 '));
  return `Evidence this turn: ${parts.join(', ')}${failed ? ` (${failed} failed or without a result)` : ''}`;
}

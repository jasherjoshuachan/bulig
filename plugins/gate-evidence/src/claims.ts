/**
 * Claim detection and matching. Everything here is a short, explicit list so a person can read it in one sitting.
 * It finds sentences that assert a result and asks whether the tool-use records of the same turn back them up.
 * It does not understand language: see the README for what it cannot catch.
 */

/** One thing Claude did in a turn. Built by the worker from the tool-use stream, never from the model's text. */
export interface EvidenceRecord {
  tool: string;
  kind: 'read' | 'search' | 'edit' | 'run' | 'other';
  target: string;
  ok: boolean;
}

export type ClaimKind = 'test' | 'build' | 'file' | 'changed' | 'looked';

export interface Claim {
  kind: ClaimKind;
  /** The sentence, flattened and clipped. */
  text: string;
  /** For a file claim: the paths the sentence names. */
  paths: string[];
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
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------- the claim patterns (the documented list) ----------

/** A sentence with one of these is a plan, a condition or a wish, not a report. It is skipped. */
export const SKIP_WORDS =
  /\b(should|must|shall|will|would|could|might|may|can|cannot|needs?(?:ed)? to|has to|have to|to make|make sure|ensure|verify|check that|until|unless|if|whether|once|so that|expect(?:s|ed)?|wants?)\b/i;
/** A pass claim in a sentence like this is a report of failure. */
const NEGATION = /\b(not|never|fail(?:s|ed|ing|ure)?|broken|without|no longer)\b|n't/i;

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
    re: /\b(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|also\s+)?(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|wrote|written|changed|rewrote|replaced|patched|resolved)\b/i,
  },
  {
    kind: 'changed',
    re: /\b(?:has|have)\s+(?:now\s+|already\s+)?been\s+(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|changed|patched|resolved)\b|\b(?:is|are)\s+now\s+(?:fixed|implemented|added|updated|removed|deleted|refactored|renamed|created|changed|patched|resolved)\b/i,
  },
];

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
    if (SKIP_WORDS.test(s)) continue;
    const seen = new Set<ClaimKind>();
    for (const p of CLAIM_PATTERNS) {
      if (seen.has(p.kind) || !p.re.test(s)) continue;
      if (p.negatable && NEGATION.test(s)) continue;
      seen.add(p.kind);
      found.push({ kind: p.kind, text: show, paths: [] });
    }
    if (!NEW_FILE.test(s) && (FILE_VERB.test(s) || READ_SAID.test(s))) {
      const paths = [...new Set([...s.matchAll(PATH)].map((m) => stripPath(m[0])).filter((p) => !/^https?:/i.test(p)))].slice(0, 5);
      if (paths.length) found.push({ kind: 'file', text: show, paths });
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

/** Is `path` the file of this record, or named by the command of a run/search record? */
function touches(rec: EvidenceRecord, path: string): boolean {
  const want = normal(path);
  const have = normal(rec.target);
  if (rec.kind === 'read' || rec.kind === 'edit') return have === want || have.endsWith(`/${want}`);
  if (rec.kind === 'run') return rec.ok && words(have).some((w) => normal(w.replace(/^["'`]|["'`]$/g, '')) === want || normal(w).endsWith(`/${want}`));
  return false;
}

/** Which claims have no record behind them. A claim with a record is not listed. */
export function checkClaims(claims: readonly Claim[], records: readonly EvidenceRecord[]): Finding[] {
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
          if (!records.some((r) => touches(r, path))) out.push({ claim: { ...claim, paths: [path] }, reason: `no record of reading ${clean(path, 80)} this turn` });
        }
        break;
    }
  }
  // "All tests pass" and "VERDICT: PASS" with no test run are one problem, so they are one line.
  return all;
}

// ---------- what the person sees ----------

/** Check the shape of what arrived as records. Anything that is not exactly a record is dropped. */
export function parseRecords(raw: unknown): EvidenceRecord[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(['read', 'search', 'edit', 'run', 'other']);
  const out: EvidenceRecord[] = [];
  for (const r of raw.slice(0, 300) as Record<string, unknown>[]) {
    if (typeof r !== 'object' || r === null) continue;
    if (typeof r.tool !== 'string' || typeof r.kind !== 'string' || !kinds.has(r.kind) || typeof r.target !== 'string' || typeof r.ok !== 'boolean') continue;
    out.push({ tool: r.tool, kind: r.kind as EvidenceRecord['kind'], target: r.target, ok: r.ok });
  }
  return out;
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

/**
 * Promise detection and job-id matching. Everything here is a short, explicit list so a person can read it in one sitting.
 * It finds sentences that commit to work later ("I'll follow up") and asks whether the same message cites a job that
 * Bulig will actually run. It does not understand language: see the README for what it cannot catch.
 */

export interface PromiseClaim {
  /** The sentence, flattened and clipped. */
  text: string;
}

/** The slice of a job this module needs. */
export interface JobRef {
  id: string;
  status: string;
}

// ---------- text for people ----------

/** Control characters, zero-width characters and the bidi marks that can make text read as something else. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠⁦-⁩﻿]+/g;

/** One line, no hidden characters, cut at `n` characters. Everything shown to a person goes through this. */
export const clean = (s: unknown, n = 160): string => {
  const t = String(s ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------- the promise patterns (the documented list) ----------

const WE = String.raw`\b(?:I|we)(?:'ll|’ll| will| shall)`;
/** Up to two filler words between "I'll" and the verb: "I'll also", "I'll then quickly". */
const FILL = String.raw`(?:\s+(?:also|then|soon|definitely|certainly|just|quickly|gladly|personally)){0,2}`;

/** A future commitment to later work. Each one needs "I" or "we" as the subject. */
export const PROMISE_PATTERNS: readonly RegExp[] = [
  // "I'll follow up", "we will circle back", "I'll get back to you", "I'll check back", "I'll report back", "I'll loop back"
  new RegExp(`${WE}${FILL}\\s+(?:follow[\\s-]?up|circle back|get back|come back|check back|report back|loop back|revisit|touch base)\\b`, 'i'),
  // "I'll look into this", "we will dig into it", "I'll take a look at that"
  new RegExp(`${WE}${FILL}\\s+(?:look|dig|take a look)\\s+(?:into|at)\\s+(?:this|that|it|these|those|them)\\b`, 'i'),
  // "I'll let you know", "I'll keep you posted", "I'll update you", "I'll ping you", "I'll notify you", "I'll message you"
  new RegExp(`${WE}${FILL}\\s+(?:let you know|keep you (?:posted|updated|in the loop)|update you|ping you|notify you|message you|send you|tell you|share (?:it|this|that) with you)\\b`, 'i'),
  // "I'll be in touch", "we will be back"
  new RegExp(`${WE}${FILL}\\s+be\\s+(?:in touch|back)\\b`, 'i'),
  // "Next I will ...", "Next, we'll ..."
  new RegExp(String.raw`\bnext,?\s+(?:I|we)(?:'ll|’ll| will| shall)\b`, 'i'),
  // Any "I will ..." with a deferral word: "I'll do it tomorrow", "we will fix that later", "I will get to it next week"
  new RegExp(
    `${WE}\\b[^.!?\\n]*\\b(?:later|tomorrow|tonight|afterwards?|in a (?:bit|while|day|few \\w+)|next (?:week|time|session|sprint|month)|when I (?:get|have) (?:a chance|time)|at a later (?:time|date))\\b`,
    'i',
  ),
];

/** A sentence with one of these is a condition, a question or an offer, not a promise. It is skipped. */
export const SKIP_WORDS = /\b(?:if|unless|should|would|could|might|may|whether|in case|want me to|shall I|do you want|would you like|let me know|provided that|assuming|suppose|imagine|for example|e\.g\.)\b/i;
/** "I won't follow up" is a refusal. */
const NEGATION = /\b(?:not|never|no need|don't|do not|cannot|can't)\b|n['’]t\b/i;
/** Already done or in the past. */
const DONE = /\b(?:already|previously|earlier|yesterday|last (?:time|week))\b/i;
/** The built-in flow described as it is: "the next stage will ...", "the pipeline will ...". */
const PIPELINE_TALK = /\b(?:next stage|(?:plan|critique|build|test|docs|review|merge|commit) (?:stage|step)|pipeline|approval (?:card|gate)|pull request|the PR)\b/i;

/** Sentences outside code, quotes and block quotes. Fenced code, inline code, "double quoted" text and `>` lines are material, not statements. */
export function sentences(text: string): string[] {
  const stripped = text
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return stripped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The text with fenced and inline code removed. Job ids only count when they are written in the open. */
export function plainText(text: string): string {
  return text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n').replace(/`[^`\n]*`/g, ' ');
}

/** Every promise in a piece of stage text. */
export function findPromises(text: string): PromiseClaim[] {
  const found: PromiseClaim[] = [];
  for (const s of sentences(text)) {
    if (s.endsWith('?')) continue;
    if (SKIP_WORDS.test(s) || NEGATION.test(s) || DONE.test(s) || PIPELINE_TALK.test(s)) continue;
    if (PROMISE_PATTERNS.some((re) => re.test(s))) found.push({ text: clean(s, 120) });
  }
  return found;
}

// ---------- job ids ----------

/** A job id as Bulig prints it: the full UUID, or the first eight characters that every card shows in brackets. */
const ID_TOKEN = /(?<![\w-])[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![\w-])/gi;
/** A job that Bulig will still run something for. A job that is done, failed or cancelled will not. */
export const LIVE = new Set(['queued', 'running', 'awaiting_approval']);

export interface Cited {
  /** The first id-shaped token that is a live job other than this one. */
  live?: string;
  /** The first id-shaped token that is not, and why. Only for the card. */
  rejected?: { token: string; why: string };
}

/**
 * Which job ids does the text cite, judged against `jobs`, the list Bulig actually holds? An id counts only when it
 * names exactly one job, that job is live, and it is not the job whose stage wrote the text (a stage cannot promise
 * itself). An id-shaped token that names no job is not an id.
 */
export function citedJobs(text: string, jobs: readonly JobRef[], ownJobId: string | undefined): Cited {
  const result: Cited = {};
  for (const m of plainText(text).matchAll(ID_TOKEN)) {
    const token = m[0].toLowerCase();
    const named = token.length === 36 ? jobs.filter((j) => j.id === token) : jobs.filter((j) => j.id.startsWith(token));
    if (named.length !== 1) {
      result.rejected ??= { token, why: named.length ? 'matches more than one job' : 'is not a job' };
      continue;
    }
    const job = named[0]!;
    if (job.id === ownJobId) result.rejected ??= { token, why: 'is the job that is already running this stage' };
    else if (!LIVE.has(job.status)) result.rejected ??= { token, why: `is a job that is ${job.status.replace('_', ' ')}` };
    else {
      result.live = job.id;
      return result;
    }
  }
  return result;
}

/** The mark for a promise, for the cards. */
export function promiseLine(p: PromiseClaim, cited: Cited): string {
  const why = cited.rejected ? `no live job id (${clean(cited.rejected.token, 40)} ${cited.rejected.why})` : 'no job id';
  return `Unfulfilled promise: ${why} ("${clean(p.text, 100)}")`;
}

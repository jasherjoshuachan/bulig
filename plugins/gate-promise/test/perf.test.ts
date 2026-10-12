import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SCAN, PROMISE_PATTERNS, citedJobs, findPromises } from '../src/index.ts';
import { findClaims } from '../../gate-evidence/src/claims.ts';

// The gate runs on the kernel's single event loop, so a slow regex freezes everything, in warn mode too.
// Each input is built to make a backtracking regex rescan to the end of its line.
//
// No test here has a wall-clock limit. A fixed number of milliseconds fails on a busy machine (load average 26 to 69 was
// seen) and passes a slow algorithm on a quiet one. Each test asks instead how the cost grows: the same function runs on
// an input of size N and on one of size 4N, in the same process, alternating, and the cost of the large one may be at
// most SCALE_LIMIT times the cost of the small one. A linear scan costs about 4 times as much, a quadratic one about 16.

const MB = 1024 * 1024;
const rep = (unit: string, n = MB) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const took = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

/** CPU time (user + system) this process spent running `fn` `reps` times, in ms. Other processes taking the cores do not add to it, which wall-clock time does. */
const cpuMs = (fn: () => unknown, reps: number): number => {
  const start = process.cpuUsage();
  for (let i = 0; i < reps; i++) fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
};

/** Linear is about 4, quadratic about 16. Measured on every input below with the machine at load average 100 to 200: 3.6 to 4.6. */
const SCALE_LIMIT = 9;
const MIN_PAIRS = 5;
const MAX_PAIRS = 40;
/** CPU budget for one measurement. Once it is spent (and 2 pairs are in) the ratio is final, so a function that really is quadratic fails in seconds, not minutes. A linear one uses a few percent of it. */
const GIVE_UP_CPU_MS = 1500;

/**
 * Cost of `fn(large)` divided by cost of `fn(small)`: the best (lowest) CPU time of each over alternating samples, so a
 * pause that hits one sample does not count. Sampling stops as soon as the ratio is under `limit` (more samples can only
 * lower it, and a function that really is quadratic never gets there). A sample is repeated until the small input costs
 * about 0.5 ms, so CPU timer granularity (1 microsecond) is under 0.2 percent of it.
 */
function costRatio(fn: (text: string) => unknown, small: string, large: string, limit = SCALE_LIMIT): number {
  fn(small);
  fn(large);
  const probe = cpuMs(() => fn(small), 1);
  const reps = Math.min(200, Math.max(1, Math.ceil(0.5 / Math.max(probe, 0.005))));
  let spent = 0;
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let pair = 1; pair <= MAX_PAIRS; pair++) {
    const s = cpuMs(() => fn(small), reps);
    const l = cpuMs(() => fn(large), reps);
    spent += s + l;
    bestSmall = Math.min(bestSmall, s);
    bestLarge = Math.min(bestLarge, l);
    if ((pair >= MIN_PAIRS && bestLarge / bestSmall < limit) || (pair >= 2 && spent > GIVE_UP_CPU_MS)) break;
  }
  return bestLarge / bestSmall;
}

/** Every hostile input as a function of its length. */
const HOSTILE: Record<string, (n: number) => string> = {
  "repeated I'll ": (n) => rep("I'll ", n),
  'repeated unclosed curly quote': (n) => rep('“a', n),
  'repeated unclosed straight quote': (n) => rep('"a', n),
  'repeated unclosed backtick': (n) => rep('`a', n),
  'repeated unclosed fence': (n) => rep('```a', n),
  'repeated unclosed tilde fence': (n) => rep('~~~a', n),
  'near match: I will x (deferral word never comes)': (n) => rep('I will x ', n),
  'near match: fillers without a verb': (n) => rep("I'll also then ", n),
  'near match: follow without up': (n) => rep("I'll follow ", n),
  'near match: look into without an object': (n) => rep('we will look into ', n),
  'near match: let you without know': (n) => rep("I'll let you ", n),
  'near match: be in without touch': (n) => rep("I'll be in ", n),
  'near match: next without a subject': (n) => rep('next, ', n),
  'near match: deferral word with no subject': (n) => rep('later tomorrow ', n),
  'near match: I will, then a long sentence, then the deferral word': (n) => `I will ${'word '.repeat(n / 5 - 4)}later`,
  'one line, no newline, no full stop': (n) => rep('word ', n),
  'long run of full stops': (n) => rep('.', n),
  'long run of punctuation': (n) => rep('.!?', n),
  'long run of newlines': (n) => rep('\n', n),
  'long run of spaces': (n) => rep(' ', n),
  'long run of angle brackets': (n) => rep('>', n),
  'long run of id-like tokens': (n) => rep('1111111 ', n),
  // Seven characters is not an id. This one is: eight hex characters, so every token is looked up against the job list.
  'long run of real id tokens': (n) => rep('deadbeef ', n),
  'long run of hex': (n) => rep('a', n),
};

const JOBS = [{ id: '11111111-aaaa-4bbb-8ccc-222222222222', status: 'queued' }];

/**
 * gate-promise reads at most MAX_SCAN characters, so its large input is MAX_SCAN itself and the small one a quarter of it.
 * The second check is the cap: a 1 MB input must cost what its first MAX_SCAN characters cost (about 1; with the cap
 * removed it is about 20).
 */
const SMALL_SCAN = MAX_SCAN / 4;
/** gate-evidence has no cap, so its large input is a quarter of a megabyte. Large enough that a quadratic term dominates, small enough that GC pauses on 1 MB strings do not. */
const SMALL_CLAIMS = 32_768;
const CAP_LIMIT = 4;

describe('a 1 MB input cannot freeze the loop', () => {
  // Every test here is synchronous, so without a turn of the event loop between them the runner cannot read its worker's
  // replies, and on a loaded machine it gives up waiting ("Timeout calling onTaskUpdate") and fails the whole run.
  beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  for (const [name, build] of Object.entries(HOSTILE)) {
    it(`promises: ${name}`, () => {
      const small = build(SMALL_SCAN);
      const large = build(MAX_SCAN);
      const huge = build(MB);
      const cited = (text: string) => citedJobs(text, JOBS, 'x');
      // Cost grows no faster than the input.
      expect(costRatio(findPromises, small, large)).toBeLessThan(SCALE_LIMIT);
      expect(costRatio(cited, small, large)).toBeLessThan(SCALE_LIMIT);
      // Past MAX_SCAN it does not grow at all.
      expect(costRatio(findPromises, huge.slice(0, MAX_SCAN), huge, CAP_LIMIT)).toBeLessThan(CAP_LIMIT);
      expect(costRatio(cited, huge.slice(0, MAX_SCAN), huge, CAP_LIMIT)).toBeLessThan(CAP_LIMIT);
    });
  }

  it('the scan stops at MAX_SCAN characters: a promise beyond it is not read, one before it is', () => {
    expect(MAX_SCAN).toBe(50_000);
    const filler = 'Nothing to see here. '.repeat(Math.ceil(MAX_SCAN / 21));
    expect(findPromises(`${filler}I'll follow up tomorrow.`)).toEqual([]);
    expect(findPromises(`I'll follow up tomorrow. ${filler}`)).toHaveLength(1);
  });

  // The deferral pattern ("I will ... later") reads at most 200 characters between "will" and the deferral word. The bound
  // is what keeps it linear: every "I will" in a long line would otherwise rescan to the end of the line. Two pins, because
  // the scaling tests above cannot see a bound of 2000: that scan is still linear, only about ten times dearer per character
  // (about 700 ms here for 1 MB, against 70 ms at 200).
  describe('the 200 character bound on the deferral pattern', () => {
    const DEFERRAL = PROMISE_PATTERNS.at(-1)!;
    /** "I will", `gap` characters, then "later". The gap starts and ends with a space. */
    const withGap = (gap: number) => `I will ${'a'.repeat(gap - 2)} later`;

    it('a deferral word 200 characters after "will" is found, 201 is not', () => {
      expect(DEFERRAL.test(withGap(200))).toBe(true);
      expect(DEFERRAL.test(withGap(201))).toBe(false);
      expect(findPromises(`${withGap(200)}.`)).toHaveLength(1);
      expect(findPromises(`${withGap(201)}.`)).toEqual([]);
    });

    // Not a wall-clock limit: the real pattern is timed against a reference written here with the same shape and a bound of
    // 200 (one deferral word instead of the list), on the same hostile text, in the same process, one after the other, taking
    // the best of 40 of each. Load slows both alike. Measured on a quiet machine, 4 runs each: the ratio is 1.0 to 1.2 with
    // the bound at 200 and 10.9 to 11.9 with it at 2000. The limit, 4, sits between.
    it('64 KB of "I will x " costs less than 4 times what the same scan costs with a reference bound of 200 (best of 40, same process)', () => {
      const reference = /\b(?:I|we)(?:'ll|’ll| will| shall)\b[^.!?\n]{0,200}\b(?:later)\b/i;
      const hostile = rep('I will x ').slice(0, 65536);
      let real = Infinity;
      let ref = Infinity;
      for (let i = 0; i < 40; i++) {
        real = Math.min(real, took(() => DEFERRAL.test(hostile)));
        ref = Math.min(ref, took(() => reference.test(hostile)));
      }
      expect(real / ref).toBeLessThan(4);
    });
  });

  it('a quote or code span longer than 300 characters is not stripped, which flags rather than hides', () => {
    expect(findPromises(`"I'll follow up tomorrow."`)).toEqual([]);
    expect(findPromises(`"${'x'.repeat(400)} I'll follow up tomorrow."`)).toHaveLength(1);
  });

  // The same inputs against gate-evidence's claim patterns, so a slow one shows up here too.
  const claims = (text: string) => findClaims(text, 'test');
  for (const [name, build] of Object.entries(HOSTILE)) {
    it(`evidence claims: ${name}`, () => {
      expect(costRatio(claims, build(SMALL_CLAIMS), build(4 * SMALL_CLAIMS))).toBeLessThan(SCALE_LIMIT);
    });
  }
  for (const [name, unit] of Object.entries({
    'tests are': 'tests are ',
    'typecheck is now': 'typecheck is now ',
    'I have just': 'I have just ',
    'path with dots': 'a/b/c.',
    'exports without a path': 'it exports ',
    'verify.sh near match': 'verify.sh ',
    'N passed near match': '12 tests ',
  })) {
    it(`evidence claims: near match ${name}`, () => {
      expect(costRatio(claims, rep(unit, SMALL_CLAIMS), rep(unit, 4 * SMALL_CLAIMS))).toBeLessThan(SCALE_LIMIT);
    });
  }
});

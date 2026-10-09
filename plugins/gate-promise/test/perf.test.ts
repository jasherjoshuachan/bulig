import { describe, expect, it } from 'vitest';
import { MAX_SCAN, citedJobs, findPromises } from '../src/index.ts';
import { findClaims } from '../../gate-evidence/src/claims.ts';

// The gate runs on the kernel's single event loop, so a slow regex freezes everything, in warn mode too.
// Each input is 1 MB of something built to make a backtracking regex rescan to the end of its line.

const MB = 1024 * 1024;
const rep = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
/** Wall-clock budget. The real cost is a few milliseconds; the margin is for a loaded CI box. */
const BUDGET_MS = 1000;
const took = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

const HOSTILE: Record<string, string> = {
  "repeated I'll ": rep("I'll "),
  'repeated unclosed curly quote': rep('“a'),
  'repeated unclosed straight quote': rep('"a'),
  'repeated unclosed backtick': rep('`a'),
  'repeated unclosed fence': rep('```a'),
  'repeated unclosed tilde fence': rep('~~~a'),
  'near match: I will x (deferral word never comes)': rep('I will x '),
  'near match: fillers without a verb': rep("I'll also then "),
  'near match: follow without up': rep("I'll follow "),
  'near match: look into without an object': rep("we will look into "),
  'near match: let you without know': rep("I'll let you "),
  'near match: be in without touch': rep("I'll be in "),
  'near match: next without a subject': rep('next, '),
  'near match: deferral word with no subject': rep('later tomorrow '),
  'near match: I will, then a long sentence, then the deferral word': `I will ${'word '.repeat(MB / 5 - 4)}later`,
  'one line, no newline, no full stop': rep('word '),
  'long run of full stops': rep('.'),
  'long run of punctuation': rep('.!?'),
  'long run of newlines': rep('\n'),
  'long run of spaces': rep(' '),
  'long run of angle brackets': rep('>'),
  'long run of id-like tokens': rep('1111111 '),
  'long run of hex': rep('a'),
};

describe('a 1 MB input cannot freeze the loop', () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    it(`promises: ${name}`, () => {
      expect(took(() => findPromises(text))).toBeLessThan(BUDGET_MS);
      expect(took(() => citedJobs(text, [{ id: '11111111-aaaa-4bbb-8ccc-222222222222', status: 'queued' }], 'x'))).toBeLessThan(BUDGET_MS);
    });
  }

  it('the scan stops at MAX_SCAN characters: a promise beyond it is not read, one before it is', () => {
    expect(MAX_SCAN).toBe(50_000);
    const filler = 'Nothing to see here. '.repeat(Math.ceil(MAX_SCAN / 21));
    expect(findPromises(`${filler}I'll follow up tomorrow.`)).toEqual([]);
    expect(findPromises(`I'll follow up tomorrow. ${filler}`)).toHaveLength(1);
  });

  it('a quote or code span longer than 300 characters is not stripped, which flags rather than hides', () => {
    expect(findPromises(`"I'll follow up tomorrow."`)).toEqual([]);
    expect(findPromises(`"${'x'.repeat(400)} I'll follow up tomorrow."`)).toHaveLength(1);
  });

  // The same inputs against gate-evidence's claim patterns, so a slow one shows up here too.
  for (const [name, text] of Object.entries(HOSTILE)) {
    it(`evidence claims: ${name}`, () => {
      expect(took(() => findClaims(text, 'test'))).toBeLessThan(BUDGET_MS);
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
      expect(took(() => findClaims(rep(unit), 'test'))).toBeLessThan(BUDGET_MS);
    });
  }
});

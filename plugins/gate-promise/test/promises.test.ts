import { describe, expect, it } from 'vitest';
import { citedJobs, findPromises, promiseLine } from '../src/index.ts';

const A = '11111111-aaaa-4bbb-8ccc-222222222222';
const B = '33333333-aaaa-4bbb-8ccc-444444444444';
const jobs = [
  { id: A, status: 'queued' },
  { id: B, status: 'done' },
];
const texts = (s: string) => findPromises(s).map((p) => p.text);

describe('promise phrases', () => {
  it.each([
    "I'll follow up on this.",
    'We will circle back once the data is in.'.replace('once the data is in', 'on the cache'),
    "I'll get back to you with the numbers.",
    'I will look into this later.',
    "I'll look into it.",
    "I'll let you know.",
    "I'll keep you posted.",
    "I'll update you when it lands.".replace(' when it lands', ''),
    'I will do it tomorrow.',
    "We'll fix that next week.",
    'Next I will rewrite the parser.',
    'Next, we’ll handle the retries.',
    "I'll be in touch.",
    "I'll also quickly check back.",
  ])('flags: %s', (s) => {
    expect(findPromises(s)).toHaveLength(1);
  });

  it('keeps only the sentence, flattened and clipped', () => {
    const [p] = findPromises(`Done with the parser.\n\n${"I'll follow up ".repeat(20)}now.`);
    expect(p!.text.length).toBeLessThanOrEqual(120);
    expect(p!.text).not.toMatch(/\n/);
  });
});

describe('what is not a promise', () => {
  it.each([
    ["conditional", "If the tests fail I'll follow up."],
    ["offer", "I can follow up if you want."],
    ["question", "Shall I follow up tomorrow?"],
    ["hypothetical", "I would circle back later, but it is not needed."],
    ["suggestion", "You should look into this later."],
    ["refusal", "I won't follow up on this."],
    ["already done", "I already followed up, and I'll let you know nothing changed."],
    ["past tense", "I followed up yesterday."],
    ["someone else", "The maintainers will follow up."],
    ["a plan step with no deferral", "I'll add the multiply function to src/math.ts."],
    ["the pipeline described", "The next stage will build the change, then the review stage will check it."],
    ["the pipeline, first person", "Next I will describe what the build stage does, and the pipeline then opens a pull request."],
    ["fenced code", "Here is the draft:\n```\nI'll follow up tomorrow.\n```\nThat is all."],
    ["unclosed fence", "Draft:\n```\nI'll follow up tomorrow."],
    ["tilde fence", "~~~\nI'll let you know\n~~~"],
    ["inline code", "The string `I'll follow up` is in the fixture."],
    ["double quoted", 'The commit says "I\'ll follow up later" and nothing else.'],
    ["curly quoted", 'The commit says “I will do it tomorrow”.'],
    ["block quote", "> I'll follow up tomorrow.\nThe reviewer wrote that."],
  ])('%s', (_name, text) => {
    expect(texts(text as string)).toEqual([]);
  });
});

describe('job ids', () => {
  it('a full id or the eight-character id of a live job counts', () => {
    expect(citedJobs(`I'll follow up in job ${A}.`, jobs, 'other').live).toBe(A);
    expect(citedJobs(`I'll follow up in job 11111111.`, jobs, 'other').live).toBe(A);
    expect(citedJobs(`Tracked as [11111111].`, jobs, 'other').live).toBe(A);
    expect(citedJobs(`Tracked as 11111111-AAAA-4BBB-8CCC-222222222222.`, jobs, 'other').live).toBe(A);
  });

  it('an id-shaped token that names no job is not an id', () => {
    const c = citedJobs("I'll follow up in job deadbeef (the real one is 99999999).", jobs, 'other');
    expect(c.live).toBeUndefined();
    expect(c.rejected).toMatchObject({ token: 'deadbeef', why: 'is not a job' });
  });

  it('a finished job, or the job whose stage wrote the text, does not count', () => {
    expect(citedJobs(`See ${B}.`, jobs, 'other')).toMatchObject({ rejected: { why: 'is a job that is done' } });
    expect(citedJobs(`See ${A}.`, jobs, A)).toMatchObject({ rejected: { why: 'is the job that is already running this stage' } });
  });

  it('an id inside code, glued to other characters or hidden by invisible ones does not count', () => {
    expect(citedJobs('```\n11111111\n```', jobs, 'o').live).toBeUndefined();
    expect(citedJobs('`11111111`', jobs, 'o').live).toBeUndefined();
    expect(citedJobs('x11111111 and 11111111x and 1111111111', jobs, 'o').live).toBeUndefined();
    expect(citedJobs('1111​1111 and 1111 1111', jobs, 'o').live).toBeUndefined();
  });

  it('an eight-character prefix shared by two jobs names neither', () => {
    const twins = [{ id: '11111111-0000-4000-8000-000000000001', status: 'queued' }, { id: '11111111-0000-4000-8000-000000000002', status: 'queued' }];
    expect(citedJobs('11111111', twins, 'o')).toMatchObject({ rejected: { why: 'matches more than one job' } });
  });

  it('the first live id wins even after a bad one', () => {
    expect(citedJobs(`deadbeef then ${A}`, jobs, 'o').live).toBe(A);
  });
});

describe('the mark', () => {
  it('says no job id, or which id was refused', () => {
    const [p] = findPromises("I'll follow up.");
    expect(promiseLine(p!, {})).toBe('Unfulfilled promise: no job id ("I\'ll follow up.")');
    expect(promiseLine(p!, { rejected: { token: 'deadbeef', why: 'is not a job' } })).toBe('Unfulfilled promise: no live job id (deadbeef is not a job) ("I\'ll follow up.")');
  });
});

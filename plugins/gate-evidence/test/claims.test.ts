import { describe, expect, it } from 'vitest';
import { checkClaims, clean, evidenceLines, evidenceSummary, findClaims, isBuildCommand, isTestCommand, parseRecords, type EvidenceRecord } from '../src/claims.ts';

const run = (target: string, ok = true): EvidenceRecord => ({ tool: 'Bash', kind: 'run', target, ok });
const read = (target: string, ok = true): EvidenceRecord => ({ tool: 'Read', kind: 'read', target, ok });
const edit = (target: string, ok = true): EvidenceRecord => ({ tool: 'Edit', kind: 'edit', target, ok });
const kinds = (text: string, stage = 'build') => findClaims(text, stage).map((c) => c.kind);

describe('findClaims', () => {
  it('finds test, build, file and change claims', () => {
    expect(kinds('All tests pass.')).toEqual(['test']);
    expect(kinds('The test suite is green.')).toEqual(['test']);
    expect(kinds('42 tests passed')).toEqual(['test']);
    expect(kinds('The typecheck passes and lint is clean.')).toEqual(['build']);
    expect(kinds('It compiles without errors.')).toEqual(['build']);
    expect(kinds('There are no type errors.')).toEqual(['build']);
    expect(kinds('I fixed the off-by-one in the parser.')).toEqual(['changed']);
    expect(kinds('The bug has been fixed.')).toEqual(['changed']);
    expect(kinds('`src/a.ts` exports multiply.')).toEqual(['file']);
    expect(kinds('I read src/a.ts and README.md.')).toEqual(['file']);
  });

  it('a file claim names its paths', () => {
    const [c] = findClaims('`./src/a.ts` defines the router, and packages/core/src/bus.ts exports Bus.', 'plan');
    expect(c!.paths).toEqual(['src/a.ts', 'packages/core/src/bus.ts']);
  });

  it('VERDICT: PASS is a test claim on the test stage and a looked-at-it claim on review', () => {
    expect(kinds('Done.\nVERDICT: PASS', 'test')).toEqual(['test']);
    expect(kinds('Fine.\nVERDICT: PASS', 'review')).toEqual(['looked']);
    expect(kinds('Fine.\nVERDICT: PASS', 'build')).toEqual([]);
    expect(kinds('Broken.\nVERDICT: FAIL', 'test')).toEqual([]);
  });

  it('skips plans, conditions and wishes', () => {
    for (const t of [
      'The tests should pass when this is done.',
      'Make sure all tests pass.',
      'We will add a test and the suite will be green.',
      'If the typecheck passes, merge.',
      'Verify that the tests pass.',
      'Add `src/multiply.js` that exports multiply.',
      'Create a new file `src/new.ts` which exports helper.',
    ]) {
      expect(kinds(t), t).toEqual([]);
    }
  });

  it('skips a pass claim that is really a failure report', () => {
    expect(kinds('The tests do not pass.')).toEqual([]);
    expect(kinds('Tests passed before, now they fail.')).toEqual([]);
    expect(kinds('The build is not clean.')).toEqual([]);
  });

  it('ignores code fences, URLs and plain prose', () => {
    expect(kinds('Here is the test:\n```ts\nexpect(run()).toBe("tests pass");\n// I fixed it\n```\nThat is all.')).toEqual([]);
    expect(kinds('See https://example.test/index.html contains docs.')).toEqual([]);
    expect(kinds('The function takes two numbers and returns their product.')).toEqual([]);
    expect(kinds('')).toEqual([]);
  });
});

describe('what counts as a test or build command', () => {
  it('knows real runners and package scripts', () => {
    for (const c of ['pnpm test', 'pnpm -r test', 'pnpm --filter @bulig/cli test', 'npm run test', 'npx vitest run', 'cd x && pnpm vitest run a.test.ts', 'FOO=1 pytest -q', 'python -m pytest', 'bash scripts/verify.sh', 'node --test']) {
      expect(isTestCommand(c), c).toBe(true);
    }
  });
  it('does not take a command that only mentions a runner', () => {
    for (const c of ['echo pnpm test', 'cat test.md', 'grep -r "vitest" .', 'ls tests', 'pnpm add test-utils', 'git log --grep test', 'echo "pnpm test"; ls']) {
      expect(isTestCommand(c), c).toBe(false);
    }
  });
  it('knows builds, typechecks and lints', () => {
    for (const c of ['pnpm build', 'pnpm typecheck', 'npm run lint', 'npx tsc --noEmit', 'tsc -p .', 'eslint .', 'bash scripts/verify.sh']) expect(isBuildCommand(c), c).toBe(true);
    for (const c of ['echo tsc', 'pnpm test', 'ls']) expect(isBuildCommand(c), c).toBe(false);
  });
});

describe('checkClaims', () => {
  const claims = (t: string, stage = 'build') => findClaims(t, stage);

  it('a test claim needs a test run that worked', () => {
    expect(checkClaims(claims('Tests pass.'), [run('pnpm test')])).toEqual([]);
    expect(checkClaims(claims('Tests pass.'), [])[0]!.reason).toBe('no record of a test run this turn');
    expect(checkClaims(claims('Tests pass.'), [run('pnpm test', false)])[0]!.reason).toBe('the only test run this turn failed');
    expect(checkClaims(claims('Tests pass.'), [run('echo pnpm test'), read('a.ts')])).toHaveLength(1);
  });

  it('a build claim needs a build, typecheck or lint run that worked', () => {
    expect(checkClaims(claims('Typecheck passes.'), [run('pnpm typecheck')])).toEqual([]);
    expect(checkClaims(claims('Typecheck passes.'), [run('pnpm test')])[0]!.reason).toMatch(/no record of a build/);
  });

  it('a change claim needs an edit that worked', () => {
    expect(checkClaims(claims('I fixed it.'), [edit('src/a.ts')])).toEqual([]);
    expect(checkClaims(claims('I fixed it.'), [read('src/a.ts'), edit('src/a.ts', false)])[0]!.reason).toBe('no record of a file edit this turn');
  });

  it('a file claim needs that file read or edited, by full path, relative path or a command naming it', () => {
    const c = claims('`src/a.ts` exports multiply.', 'plan');
    expect(checkClaims(c, [read('/work/wt/src/a.ts')])).toEqual([]);
    expect(checkClaims(c, [read('src/a.ts')])).toEqual([]);
    expect(checkClaims(c, [run('cat src/a.ts')])).toEqual([]);
    expect(checkClaims(c, [read('src/b.ts')])[0]!.reason).toBe('no record of reading src/a.ts this turn');
    expect(checkClaims(c, [read('/work/wt/xsrc/a.ts')])).toHaveLength(1); // a different folder with the same ending
    expect(checkClaims(c, [run('cat src/a.ts', false)])).toHaveLength(1);
  });

  it('each unbacked path of one sentence is its own finding', () => {
    const c = claims('`a.ts` and `b.ts` both define Foo.', 'plan');
    expect(checkClaims(c, [read('a.ts')]).map((f) => f.reason)).toEqual(['no record of reading b.ts this turn']);
  });

  it('a review pass needs a read or a diff', () => {
    const c = claims('Looks right.\nVERDICT: PASS', 'review');
    expect(checkClaims(c, [read('src/a.ts')])).toEqual([]);
    expect(checkClaims(c, [run('git diff main...HEAD')])).toEqual([]);
    expect(checkClaims(c, [run('ls src')])).toHaveLength(1);
    expect(checkClaims(c, [])).toHaveLength(1);
  });
});

describe('what is shown', () => {
  it('flattens and clips text for people, and drops hidden characters', () => {
    const t = clean(`a\n\n\tb‮c​d ${'x'.repeat(500)}`, 50);
    expect(t).toHaveLength(50);
    expect(t).not.toMatch(/[\n\t‮​]/);
  });

  it('lists distinct records and counts the rest', () => {
    const recs = [read('a.ts'), read('a.ts'), run('pnpm test', false), ...Array.from({ length: 20 }, (_, n) => read(`f${n}.ts`))];
    const lines = evidenceLines(recs);
    expect(lines.slice(0, 3)).toEqual(['read a.ts', 'ran pnpm test (failed)', 'read f0.ts']);
    expect(lines).toHaveLength(13);
    expect(lines.at(-1)).toMatch(/^\.\.\. and \d+ more$/);
    expect(evidenceSummary([])).toBe('Evidence this turn: no tool calls recorded');
    expect(evidenceSummary(recs)).toBe('Evidence this turn: 22 read, 1 commands run (1 failed or without a result)');
  });

  it('parseRecords keeps only well-formed records', () => {
    expect(parseRecords('nope')).toEqual([]);
    expect(parseRecords([read('a'), { tool: 'Bash', kind: 'run', target: 'x' }, null, 7, { tool: 'T', kind: 'bogus', target: '', ok: true }, { ...run('ls'), extra: 1 }])).toEqual([read('a'), run('ls')]);
  });
});

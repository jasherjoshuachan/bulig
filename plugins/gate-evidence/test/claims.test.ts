import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeOutput, repoFactsOf } from '../../worker-claude-code/src/index.ts';
import {
  checkClaims,
  clean,
  evidenceLines,
  evidenceSummary,
  findClaims,
  isBuildCommand,
  isTestCommand,
  packageOf,
  parseRecords,
  parseRepoFacts,
  type EvidenceRecord,
  type RepoFacts,
} from '../src/claims.ts';

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

  it('does not take a statement that nothing was changed for a claim of a change', () => {
    for (const t of [
      'The change is docs-only, so I added no tests.',
      'I added no tests.',
      'I have added no new files.',
      "I've changed nothing in src.",
      'I did not add any tests.',
      "I didn't add a test for it.",
      'I have not edited any files.',
      "I haven't edited anything.",
      'No files were edited.',
      'No files have been changed.',
      'Nothing has been changed.',
      'Nothing was changed.',
      'This was done without editing any file.',
      'Nothing has been updated, and no file has been removed.',
      'I made no edits, so I fixed nothing.',
    ]) {
      expect(kinds(t), t).toEqual([]);
    }
  });

  it('still takes a plain claim of a change, with a negation that is about something else', () => {
    for (const t of ['I edited README.md.', 'I added a test.', 'I modified the parser.', "We've updated the docs.", 'The parser has now been fixed.', 'I fixed the no-results bug.', 'I added tests, not docs.']) {
      expect(kinds(t), t).toEqual(['changed']);
    }
  });

  it('a negation in one clause does not hide a claim in another clause of the same sentence', () => {
    for (const t of [
      'I added no tests but edited README.md.',
      'I added no tests, and updated README.md.',
      'I changed nothing in src; I fixed the docs.',
      'Nothing has been removed, but I added a test.',
      'I added no tests, then fixed the typo.',
    ]) {
      expect(kinds(t), t).toEqual(['changed']);
    }
  });

  it('a negator earlier in the sentence does not hide a later claim of a change', () => {
    for (const t of [
      'There were no failures after I fixed it.',
      'Not a single test failed after I fixed the parser.',
      'No one complained after I updated the config.',
      'Since nothing else was needed I updated README.md.',
      'Nothing else was needed when I edited README.md.',
      'No errors appeared before I added the check.',
      'There was no delay because I fixed the bug.',
      'No one asked, and the parser has now been fixed.',
      'Since nothing else was needed the bug has been fixed.',
    ]) {
      expect(kinds(t), t).toEqual(['changed']);
    }
  });

  describe('a skip or failure word in its other sense does not hide the claim', () => {
    it('"failed" and "without" in a clean report: zero failures is a pass claim', () => {
      for (const [t, k] of [
        ['Tests: 12 passed, 0 failed.', 'test'],
        ['All tests passed, none failed.', 'test'],
        ['All tests pass and no tests failed.', 'test'],
        ['Not a single test failed, and the suite is green.', 'test'],
        ['The build passes without warnings.', 'build'],
        ['Typecheck passes without any errors.', 'build'],
        ['The suite passes without a single failure.', 'test'],
        ['Lint is clean without new issues.', 'build'],
      ] as const) {
        expect(kinds(t), t).toEqual([k]);
      }
    });

    it('but a failure that is real still skips the sentence', () => {
      for (const t of [
        '12 passed, 3 failed.',
        '0 passed 12 failed.',
        'The tests failed.',
        'All 12 passed, 0 failed in unit, 2 failed in e2e.',
        'The tests pass without running the migration.',
        'The build did not pass without errors.',
        'Tests pass, but 1 failed earlier.',
      ]) {
        expect(kinds(t), t).toEqual([]);
      }
    });

    it('"can" as a report ("I can confirm") is a claim; "can" as an offer or instruction is not', () => {
      expect(kinds('I can confirm all tests pass.')).toEqual(['test']);
      expect(kinds('We can see that the suite is green.')).toEqual(['test']);
      for (const t of ['You can run the tests; they pass.', 'The tests can pass if the cache is warm.', 'I can add a test for it.', "Tests can't pass yet."]) {
        expect(kinds(t), t).toEqual([]);
      }
    });

    it('"once" before a past-tense change ("once I fixed it") is a report; "once" as a condition is not', () => {
      expect(kinds('Once I fixed the import, all tests passed.')).toEqual(['test', 'changed']);
      expect(kinds('I fixed the parser once I edited the lexer.')).toEqual(['changed']);
      for (const t of ['The tests pass once the cache is warm.', 'Tests pass once that is done.', 'Once I fix the import the tests pass.', 'Once I have fixed the import the tests pass.']) {
        expect(kinds(t), t).toEqual([]);
      }
    });
  });

  describe('how far back "has been changed" looks for the word that says nothing was', () => {
    // The window is four words, not five: the words just before "has been ...", the nearest four.
    it('a negator up to four words before reads as "nothing was changed"', () => {
      expect(kinds('Nothing has been updated.')).toEqual([]);
      expect(kinds('Nothing one two three has been updated.')).toEqual([]);
    });
    it('a negator five words before does not, which is the trade-off: "No one noticed it has been updated." reads clean', () => {
      expect(kinds('Nothing one two three four has been updated.')).toEqual(['changed']);
      expect(kinds('No one noticed it has been updated.')).toEqual([]);
    });
  });

  it('stays fast on 1 MB of text built to keep a negation scan busy', () => {
    const MB = 1024 * 1024;
    for (const unit of [
      'no I added ', 'I added no ', 'nothing has been changed ', 'I added no tests, ', 'I added no tests but edited ', 'I did not ',
      'tests pass not a single ', 'tests pass without any ', 'tests pass no tests ', 'I can ', 'once I ',
    ]) {
      const t0 = performance.now();
      findClaims(unit.repeat(Math.ceil(MB / unit.length)), 'test');
      expect(performance.now() - t0, unit).toBeLessThan(3000);
    }
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

  it('a stage that says it edited nothing is not flagged, and one that says it edited something is', () => {
    const t = 'The change is docs-only, so I added no tests.';
    expect(checkClaims(claims(t, 'test'), [])).toEqual([]);
    expect(checkClaims(claims(t, 'test'), [read('README.md')])).toEqual([]);
    expect(checkClaims(claims('I edited README.md.'), [])[0]!.reason).toBe('no record of a file edit this turn');
    expect(checkClaims(claims('I added a test.'), [read('a.ts')])[0]!.reason).toBe('no record of a file edit this turn');
    expect(checkClaims(claims('I edited README.md.'), [edit('README.md')])).toEqual([]);
    expect(checkClaims(claims('I added a test.'), [edit('test/a.test.ts')])).toEqual([]);
    expect(checkClaims(claims('I added no tests but edited README.md.'), [])[0]!.reason).toBe('no record of a file edit this turn');
    expect(checkClaims(claims('I added no tests but edited README.md.'), [edit('README.md')])).toEqual([]);
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

// A reviewer that runs `git diff <base> HEAD` has seen every file the diff prints. The worker keeps the
// `diff --git a/<path> b/<path>` headers of a successful Bash result as `diffPaths`; the gate counts them
// only when the command itself is a git diff or show.
describe('a file shown by a git diff counts as read', () => {
  const claims = (t: string, stage = 'build') => findClaims(t, stage);
  const diff = (target: string, diffPaths: string[], ok = true): EvidenceRecord => ({ ...run(target, ok), diffPaths });
  // What the review stage of job 9628d02c ran: the full diff, then the log and the stat.
  const REVIEW = [
    diff('git diff 0f9c2565 HEAD', ['package-lock.json', 'src/chunk.js', 'test/chunk.test.js']),
    run('git log --oneline 0f9c2565..HEAD && git diff --stat 0f9c2565..HEAD'),
  ];

  it('job 9628d02c review: src/chunk.js, shown by the full diff, is not "no record of reading"', () => {
    const c = claims('`src/chunk.js` exports chunk and throws on a size below 1.\nVERDICT: PASS', 'review');
    expect(c.map((x) => x.kind)).toEqual(['file', 'looked']);
    expect(checkClaims(c, REVIEW)).toEqual([]);
  });

  it('job 9628d02c review: package-lock.json, shown by the full diff, is not "no record of reading"', () => {
    const c = claims('package-lock.json contains only the lockfile entries for chunk.\nVERDICT: PASS', 'review');
    expect(c.map((x) => x.kind)).toEqual(['file', 'looked']);
    expect(checkClaims(c, REVIEW)).toEqual([]);
  });

  it('a git diff --stat alone does not count as reading a file, so the claim still warns', () => {
    const c = claims('`src/chunk.js` exports chunk.', 'review');
    expect(checkClaims(c, [run('git diff --stat 0f9c2565 HEAD')]).map((f) => f.reason)).toEqual(['no record of reading src/chunk.js this turn']);
    expect(checkClaims(c, [run('git log --oneline 0f9c2565..HEAD && git diff --stat 0f9c2565..HEAD')])).toHaveLength(1);
    // the stat prints no diff headers, so the worker gives it no diffPaths
    expect(checkClaims(c, [diff('git diff --stat 0f9c2565 HEAD', [])])).toHaveLength(1);
  });

  it('only a successful git diff or show that printed that file counts', () => {
    const c = claims('`src/chunk.js` exports chunk.', 'review');
    expect(checkClaims(c, [diff('git diff 0f9c2565 HEAD', ['src/chunk.js'], false)])).toHaveLength(1); // failed
    expect(checkClaims(c, [diff('git diff 0f9c2565 HEAD', ['src/other.js'])])).toHaveLength(1); // another file
    expect(checkClaims(c, [diff('git diff 0f9c2565 HEAD', ['xsrc/chunk.js'])])).toHaveLength(1); // same ending, other folder
    expect(checkClaims(c, [diff('cat notes.md', ['src/chunk.js'])])).toHaveLength(1); // headers printed by something that is not git
    expect(checkClaims(c, [diff('echo x; git diff --stat', ['src/chunk.js'])])).toHaveLength(1); // a non-git segment could have printed them
    expect(checkClaims(c, [diff('git diff --stat && cat review.md', ['src/chunk.js'])])).toHaveLength(1);
    expect(checkClaims(c, [diff('git status', ['src/chunk.js'])])).toHaveLength(1); // git, but not a diff or show
    expect(checkClaims(c, [{ ...read('notes.md'), diffPaths: ['src/chunk.js'] }])).toHaveLength(1); // only a command's output counts
    expect(checkClaims(c, [diff('git show HEAD', ['src/chunk.js'])])).toEqual([]);
    expect(checkClaims(c, [diff('cd /work/wt && git --no-pager diff main...HEAD | head -400', ['src/chunk.js'])])).toEqual([]);
    expect(checkClaims(c, [diff('git -C /work/wt diff HEAD~1', ['/work/wt/src/chunk.js'])])).toEqual([]);
    expect(checkClaims(claims('`chunk.js` exports chunk.', 'review'), [diff('git diff HEAD~1', ['src/chunk.js'])])).toEqual([]);
  });

  it('a git command that can print file or message text at the start of a line counts for nothing', () => {
    const c = claims('`src/chunk.js` exports chunk.', 'review');
    const counts = (cmd: string) => checkClaims(c, [diff(cmd, ['src/chunk.js'])]).length === 0;
    for (const cmd of [
      'git diff --word-diff HEAD~1', // context lines are not prefixed
      'git diff --word-diff=plain HEAD~1',
      'git diff --color-words HEAD~1',
      "git diff --output-indicator-context='' HEAD~1",
      'git diff --output=/tmp/d HEAD~1',
      "git diff --line-prefix='' HEAD~1",
      'git diff --src-prefix=a/ --dst-prefix=b/ HEAD~1',
      'git diff --ext-diff HEAD~1',
      'git diff --textconv HEAD~1',
      'git show HEAD:notes.md', // the file itself
      "git show 'HEAD:notes.md'",
      'git diff HEAD:a.md HEAD:b.md',
      'git show --format=%B HEAD', // the commit message, not indented
      'git show --pretty=format:%B HEAD',
      'git cat-file -p HEAD:notes.md',
      'git log --format=%B -1',
      'git log -p -1',
      'git status && git diff HEAD~1', // any other git command in the chain
      "git -c alias.x='!cat notes.md' x",
      'git -c diff.external=cat diff HEAD~1',
      'GIT_EXTERNAL_DIFF=cat git diff HEAD~1',
      'cd /work/wt && GIT_EXTERNAL_DIFF=cat git diff HEAD~1',
      'cat notes.md & git diff HEAD~1', // a lone & is not split by segments()
      'git diff $(cat notes.md)',
      'git diff `cat notes.md`',
      'git diff HEAD~1 <(cat notes.md)',
      `git diff ${'x'.repeat(290)} ; cat notes.md`.slice(0, 300), // cut by the worker: the end is unknown
      `git diff ${'x'.repeat(295)}`,
    ]) expect(counts(cmd), cmd).toBe(false);
    for (const cmd of ['git diff HEAD~1', 'git diff 0f9c2565 HEAD 2>&1 | head -400', 'git diff --stat -p HEAD~1', 'git show --stat -p HEAD', 'git diff --no-textconv HEAD~1', 'git diff -- src/chunk.js']) {
      expect(counts(cmd), cmd).toBe(true);
    }
  });

  it('build attempt 2 of the same job: divide.js was never read, shown or edited, so that warning is true', () => {
    const records = [
      read('/work/wt/src/chunk.js'),
      read('/work/wt/test/chunk.test.js'),
      read('/work/wt/package-lock.json'),
      read('/work/wt/src/multiply.js'),
      read('/work/wt/test/multiply.test.js'),
      run('cat package.json'),
      run('cat .github/workflows/ci.yml'),
    ];
    const c = claims('Like multiply.js, divide.js exports one function and its test lives next to it.', 'build');
    expect(checkClaims(c, records).map((f) => f.reason)).toEqual(['no record of reading divide.js this turn']);
  });

  it('parseRecords keeps diffPaths only as a list of strings, and drops a bad one without dropping the record', () => {
    expect(parseRecords([diff('git diff', ['a.ts', 'b.ts'])])).toEqual([diff('git diff', ['a.ts', 'b.ts'])]);
    expect(parseRecords([{ ...run('git diff'), diffPaths: 'a.ts' }, { ...run('git show'), diffPaths: ['a.ts', 7] }])).toEqual([run('git diff'), run('git show')]);
    expect(parseRecords([diff('git diff', Array.from({ length: 300 }, (_, n) => `f${n}.ts`))])[0]!.diffPaths).toHaveLength(200);
  });
});

describe('from the real worker stream to the gate', () => {
  it('job 9628d02c review: the full git diff backs src/chunk.js and package-lock.json, the stat alone does not', () => {
    const line = (o: unknown) => JSON.stringify(o);
    const use = (id: string, command: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const answer = (id: string, content: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
    const diffOut = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\ndiff --git a/src/chunk.js b/src/chunk.js\n+export function chunk() {}';
    const statOut = 'abc123 add chunk\n src/chunk.js      | 12 ++++++\n package-lock.json |  4 ++';
    const text = '`src/chunk.js` exports chunk. package-lock.json contains only the lockfile entries for chunk.\nVERDICT: PASS';
    const stream = (...lines: string[]) => [...lines, line({ type: 'result', is_error: false, result: text, session_id: 's' })].join('\n');
    const stat = [use('t2', 'git log --oneline 0f9c2565..HEAD && git diff --stat 0f9c2565..HEAD'), answer('t2', statOut)];

    const full = parseRecords(parseClaudeOutput(stream(use('t1', 'git diff 0f9c2565 HEAD'), answer('t1', diffOut), ...stat)).evidence);
    expect(checkClaims(findClaims(text, 'review'), full)).toEqual([]);

    const statOnly = parseRecords(parseClaudeOutput(stream(...stat)).evidence);
    expect(checkClaims(findClaims(text, 'review'), statOnly).map((f) => f.reason)).toEqual([
      'no record of reading src/chunk.js this turn',
      'no record of reading package-lock.json this turn',
    ]);
  });
});

// Job 99507748 (a lodash-based chunk helper): three stages named `lodash/chunk.js`, a package import specifier that resolves
// into node_modules. It is not a file in the repo and no stage said it read it, yet each got "no record of reading".
describe('a package import specifier is not a file claim', () => {
  const claims = (t: string, stage = 'build') => findClaims(t, stage);
  const reasons = (t: string, records: EvidenceRecord[], repo?: RepoFacts, stage = 'build') => checkClaims(claims(t, stage), records, repo).map((f) => f.reason);
  const CRITIQUE = "**Change before building:** Specify the lodash import style (prefer `import chunk from 'lodash/chunk.js'` over a named import).";
  const BUILD = '- `src/chunk.js` — `chunk` helper re-exporting `lodash/chunk.js` (avoids the ESM/CJS named-export interop problem).';
  const REVIEW = '- `src/chunk.js` — delegates to `lodash/chunk.js`, matching the one-function-per-file export style of lodash.';
  const BUILT = [run('npm install lodash'), edit('package.json'), edit('src/chunk.js')];
  const REVIEWED = [{ ...run('git diff 0f9c2565 HEAD'), diffPaths: ['package.json', 'src/chunk.js'] }];
  // What the worker read from that worktree: lodash in package.json, no `lodash` folder outside node_modules.
  const REPO: RepoFacts = { dirs: ['src', 'test'], deps: ['lodash'] };
  const LODASH = 'no record of reading lodash/chunk.js this turn';

  it('without worktree facts the three sentences warn, as before (fail closed)', () => {
    expect(reasons(CRITIQUE, [], undefined, 'critique')).toEqual([LODASH]);
    expect(reasons(BUILD, BUILT)).toEqual([LODASH]);
    expect(reasons(REVIEW, REVIEWED, undefined, 'review')).toEqual([LODASH]);
  });

  it('job 99507748: with lodash a dependency and no lodash folder in the repo, none of the three warns', () => {
    expect(reasons(CRITIQUE, [], REPO, 'critique')).toEqual([]);
    expect(reasons(BUILD, BUILT, REPO)).toEqual([]);
    expect(reasons(REVIEW, REVIEWED, REPO, 'review')).toEqual([]);
  });

  it('a quoted import in the sentence is enough when lodash is not (yet) a dependency; a bare mention is not', () => {
    const noDeps: RepoFacts = { dirs: ['src', 'test'], deps: [] };
    expect(reasons(CRITIQUE, [], noDeps, 'critique')).toEqual([]);
    expect(reasons(CRITIQUE, [], { dirs: ['src'] }, 'critique')).toEqual([]); // package.json unreadable: the quote still counts
    expect(reasons(BUILD, BUILT, noDeps)).toEqual([LODASH]);
    expect(reasons(BUILD, BUILT, { dirs: ['src'] })).toEqual([LODASH]);
    expect(reasons("`src/chunk.js` imports `lodash/chunk.js` via `require('lodash/chunk.js')`.", [edit('src/chunk.js')], noDeps)).toEqual([]);
    expect(reasons("`src/chunk.js` contains `export { default } from 'lodash/chunk.js'`.", [edit('src/chunk.js')], noDeps)).toEqual([]);
    // A quote of something else does not make this path a specifier.
    expect(reasons("`src/chunk.js` contains `import x from 'lodash'` and `lodash/chunk.js`.", [edit('src/chunk.js')], noDeps)).toEqual([LODASH]);
  });

  it('a repo file still needs a record, whatever the dependencies or quotes say', () => {
    const t = "`src/chunk.js` exports chunk, as in `import chunk from 'src/chunk.js'`.";
    expect(reasons(t, [], { dirs: ['src'], deps: ['src'] })).toEqual(['no record of reading src/chunk.js this turn']);
    expect(reasons(BUILD, [], REPO)).toEqual(['no record of reading src/chunk.js this turn']);
  });

  it('a path written with ./, ../ or / is a path, not a specifier', () => {
    const imp = (p: string) => `\`src/chunk.js\` contains \`import chunk from '${p}'\`.`;
    expect(reasons(imp('./lodash/chunk.js'), [edit('src/chunk.js')], REPO)).toEqual([LODASH]);
    expect(reasons('`./lodash/chunk.js` exports chunk.', [], REPO)).toEqual([LODASH]);
    expect(reasons(imp('../lodash/chunk.js'), [edit('src/chunk.js')], REPO)).toEqual(['no record of reading ../lodash/chunk.js this turn']);
    expect(reasons('`/lodash/chunk.js` exports chunk.', [], REPO)).toEqual(['no record of reading /lodash/chunk.js this turn']);
    // The same path once with ./ and once bare: the ./ wins.
    expect(reasons('`./lodash/chunk.js` exports chunk, like `lodash/chunk.js`.', [], REPO)).toEqual([LODASH]);
    expect(reasons('`lodash/../src/a.js` exports a.', [], REPO)).toEqual(['no record of reading lodash/../src/a.js this turn']);
  });

  it('a folder in the repo with the package name makes it a repo path, so it still warns', () => {
    const t = '`lib/util.js` exports util.';
    expect(reasons(t, [], { dirs: ['lib', 'src'], deps: [] })).toEqual(['no record of reading lib/util.js this turn']);
    expect(reasons(t, [], { dirs: ['lib', 'src'], deps: ['lib'] })).toEqual(['no record of reading lib/util.js this turn']);
    expect(reasons("`lib/util.js` contains `import u from 'lib/util.js'`.", [], { dirs: ['lib'], deps: [] })).toEqual(['no record of reading lib/util.js this turn']);
    expect(reasons(t, [], { dirs: ['src'], deps: [] })).toEqual(['no record of reading lib/util.js this turn']); // no folder, but no signal either
    expect(reasons(t, [read('lib/util.js')], { dirs: ['lib'], deps: [] })).toEqual([]);
    expect(reasons(REVIEW, REVIEWED, { dirs: ['lodash', 'src'], deps: ['lodash'] }, 'review')).toEqual([LODASH]); // a lodash/ folder of the repo's own
    expect(reasons(REVIEW, REVIEWED, { dirs: ['Lodash', 'src'], deps: ['lodash'] }, 'review')).toEqual([LODASH]); // in any case, for a case-insensitive disk
  });

  it('a scoped package is handled like lodash', () => {
    const t = '`src/a.js` re-exports `@scope/pkg/file.js` (the named-export path).';
    const S = 'no record of reading @scope/pkg/file.js this turn';
    expect(reasons(t, [edit('src/a.js')], { dirs: ['src'], deps: ['@scope/pkg'] })).toEqual([]);
    expect(reasons("`src/a.js` contains `import f from '@scope/pkg/file.js'`.", [edit('src/a.js')], { dirs: ['src'], deps: [] })).toEqual([]);
    expect(reasons(t, [edit('src/a.js')], { dirs: ['src'], deps: ['@scope/other'] })).toEqual([S]);
    expect(reasons(t, [edit('src/a.js')], { dirs: ['src', '@scope'], deps: ['@scope/pkg'] })).toEqual([S]);
    expect(reasons(t, [edit('src/a.js')])).toEqual([S]);
  });

  it('node_modules/ written out stays a file path, and a read of it still backs the claim', () => {
    const t = '`node_modules/lodash/chunk.js` exports chunk.';
    expect(reasons(t, [], REPO)).toEqual(['no record of reading node_modules/lodash/chunk.js this turn']);
    expect(reasons(t, [read('/work/wt/node_modules/lodash/chunk.js')], REPO)).toEqual([]);
  });

  it('a sentence that says it read or opened the file still needs the read', () => {
    expect(reasons('I read `lodash/chunk.js` and it exports chunk.', [], REPO)).toEqual([LODASH]);
    expect(reasons("I opened `lodash/chunk.js`, which `import chunk from 'lodash/chunk.js'` loads.", [], REPO)).toEqual([LODASH]);
    expect(reasons('I read `lodash/chunk.js`.', [read('node_modules/lodash/chunk.js')], REPO)).toEqual([]);
  });

  it('a package name with no file after it is not a specifier: the gate cannot tell it from a repo file', () => {
    expect(packageOf('lodash/chunk.js')).toBe('lodash');
    expect(packageOf('@scope/pkg/file.js')).toBe('@scope/pkg');
    for (const p of ['chunk.js', 'Lodash/chunk.js', '_x/a.js', '.bin/a.js', 'node_modules/lodash/chunk.js', 'a/node_modules/b.js', 'a/./b.js', 'a//b.js', '@scope/pkg.js']) expect(packageOf(p)).toBeUndefined();
    expect(reasons("`chart.js` is what `import Chart from 'chart.js'` loads, and it exports Chart.", [], { dirs: [], deps: ['chart.js'] })).toEqual(['no record of reading chart.js this turn']);
  });

  it('stays fast on 1 MB of import, require and from built to keep the specifier scan busy', () => {
    const repo: RepoFacts = { dirs: [], deps: [] };
    for (const t of [
      `\`a.ts\` imports ${'import '.repeat(1)}${' '.repeat(1_000_000)}x`,
      `\`a.ts\` imports ${'import {a, '.repeat(90_000)}`,
      `\`a.ts\` imports ${'require ( '.repeat(100_000)}`,
      `\`a.ts\` imports ${'import x from '.repeat(70_000)}`,
    ]) {
      const t0 = performance.now();
      checkClaims(findClaims(t, 'build'), [], repo);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  it('parseRepoFacts takes only the exact shape, and a bad one is no facts', () => {
    expect(parseRepoFacts({ dirs: ['src'], deps: ['lodash'] })).toEqual({ dirs: ['src'], deps: ['lodash'] });
    expect(parseRepoFacts({ dirs: ['src'] })).toEqual({ dirs: ['src'] });
    for (const bad of [undefined, null, 'src', [], { deps: ['lodash'] }, { dirs: 'src' }, { dirs: ['src', 1] }, { dirs: ['src'], deps: 'lodash' }, { dirs: ['src'], deps: [null] }, { dirs: [''] }, { dirs: ['a'.repeat(215)] }, { dirs: ['src'], deps: ['a'.repeat(215)] }, { dirs: Array.from({ length: 2001 }, (_, n) => `d${n}`) }]) {
      expect(parseRepoFacts(bad)).toBeUndefined();
    }
  });
});

describe('from the real worktree facts to the gate', () => {
  it('job 99507748: a worktree with lodash installed and src/chunk.js importing it', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'bulig-facts-'));
    try {
      mkdirSync(join(wt, 'src'));
      mkdirSync(join(wt, 'node_modules', 'lodash'), { recursive: true });
      writeFileSync(join(wt, 'node_modules', 'lodash', 'chunk.js'), 'module.exports = function chunk() {};\n');
      writeFileSync(join(wt, 'src', 'chunk.js'), "import chunk from 'lodash/chunk.js';\nexport default chunk;\n");
      writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'chunky', dependencies: { lodash: '^4.17.21' } }));
      const repo = parseRepoFacts(await repoFactsOf(wt));
      expect(repo).toEqual({ dirs: ['src'], deps: ['lodash'] });
      const review = '- `src/chunk.js` — delegates to `lodash/chunk.js`, matching the one-function-per-file export style of lodash.';
      expect(checkClaims(findClaims(review, 'review'), [read('src/chunk.js')], repo)).toEqual([]);
      expect(checkClaims(findClaims(review, 'review'), [], repo).map((f) => f.reason)).toEqual(['no record of reading src/chunk.js this turn']);
      // A lodash folder of the repo's own, or a symlink with that name, makes lodash/chunk.js a repo path again.
      symlinkSync(join(wt, 'node_modules', 'lodash'), join(wt, 'src', 'lodash'));
      const linked = parseRepoFacts(await repoFactsOf(wt));
      expect(linked?.dirs).toEqual(['lodash', 'src']);
      expect(checkClaims(findClaims(review, 'review'), [read('src/chunk.js')], linked).map((f) => f.reason)).toEqual(['no record of reading lodash/chunk.js this turn']);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

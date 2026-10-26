import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isRepoPath, matchesGlob, matchesScope, normalizeScopeEntry, parseScopeBlock, SCOPE_BLOCK_EXAMPLE, SCOPE_BLOCK_IN_REPLY, SCOPE_BLOCK_RULE } from '../src/index.ts';

describe('path depth cap', () => {
  const deep = (n: number) => `${Array.from({ length: n - 1 }, (_, i) => `d${i}`).join('/')}/f.txt`;
  it('covers a path 32 parts deep and refuses one 33 deep, even under **', () => {
    expect(isRepoPath(deep(32))).toBe(true);
    expect(isRepoPath(deep(33))).toBe(false);
    expect(matchesGlob(deep(32), 'd0/**')).toBe(true);
    expect(matchesGlob(deep(33), 'd0/**')).toBe(false);
    expect(matchesScope(deep(33), ['d0/**'])).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('matches a literal path exactly', () => {
    expect(matchesGlob('README.md', 'README.md')).toBe(true);
    expect(matchesGlob('docs/README.md', 'README.md')).toBe(false);
    expect(matchesGlob('README.md.bak', 'README.md')).toBe(false);
  });

  it('is case sensitive', () => {
    expect(matchesGlob('readme.md', 'README.md')).toBe(false);
  });

  it('* stays inside one folder', () => {
    expect(matchesGlob('src/lib/a.ts', 'src/lib/*.ts')).toBe(true);
    expect(matchesGlob('src/lib/deep/a.ts', 'src/lib/*.ts')).toBe(false);
    expect(matchesGlob('src/lib/a.js', 'src/lib/*.ts')).toBe(false);
    expect(matchesGlob('src/lib/.ts', 'src/lib/*.ts')).toBe(false);
  });

  it('* can match an empty run inside a name', () => {
    expect(matchesGlob('src/ab.ts', 'src/a*b.ts')).toBe(true);
    expect(matchesGlob('src/ab.ts', 'src/a*b*.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/a*b.ts')).toBe(false);
    expect(matchesGlob('src/axxb.ts', 'src/a*b.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/a*.ts')).toBe(true);
  });

  it('? matches exactly one character, never a slash', () => {
    expect(matchesGlob('v1.txt', 'v?.txt')).toBe(true);
    expect(matchesGlob('v12.txt', 'v?.txt')).toBe(false);
    expect(matchesGlob('v.txt', 'v?.txt')).toBe(false);
    expect(matchesGlob('a/b', 'a?b')).toBe(false);
  });

  it('** crosses folders', () => {
    expect(matchesGlob('docs/a.md', 'docs/**')).toBe(true);
    expect(matchesGlob('docs/x/y/z.md', 'docs/**')).toBe(true);
    expect(matchesGlob('doc/a.md', 'docs/**')).toBe(false);
    expect(matchesGlob('docs', 'docs/**')).toBe(false);
    expect(matchesGlob('src/a.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(matchesGlob('src/x/y/a.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/**/*.test.ts')).toBe(false);
  });

  it('wildcards do not match dotfiles or dot folders unless the pattern says the dot', () => {
    expect(matchesGlob('src/.env', 'src/*')).toBe(false);
    expect(matchesGlob('src/.hidden/a.ts', 'src/**')).toBe(false);
    expect(matchesGlob('.github/workflows/ci.yml', '**/*.yml')).toBe(false);
    expect(matchesGlob('.github/workflows/ci.yml', '.github/**')).toBe(true);
    expect(matchesGlob('.gitignore', '.gitignore')).toBe(true);
    expect(matchesGlob('.gitignore', '.git*')).toBe(true);
    expect(matchesGlob('test-results/.last-run.json', 'test-results/*.json')).toBe(false);
  });

  it('handles spaces and brackets as plain characters', () => {
    expect(matchesGlob('docs/my notes.md', 'docs/my notes.md')).toBe(true);
    expect(matchesGlob('docs/my notes.md', 'docs/*.md')).toBe(true);
    expect(matchesGlob('app/[id]/page.tsx', 'app/[id]/page.tsx')).toBe(true);
    expect(matchesGlob('app/i/page.tsx', 'app/[id]/page.tsx')).toBe(false);
  });

  it('handles unicode, and treats ? as one character', () => {
    expect(matchesGlob('docs/日本語.md', 'docs/*.md')).toBe(true);
    expect(matchesGlob('docs/日.md', 'docs/?.md')).toBe(true);
    expect(matchesGlob('docs/😀.md', 'docs/?.md')).toBe(true);
    // composed and decomposed forms of the same name are the same file to a person
    expect(matchesGlob('docs/caf\u0065\u0301.md', 'docs/caf\u00e9.md')).toBe(true);
  });

  it('never matches a path that climbs out of the repo or is absolute', () => {
    expect(matchesGlob('../secret', '**')).toBe(false);
    expect(matchesGlob('a/../../b', '**')).toBe(false);
    expect(matchesGlob('/etc/passwd', '**')).toBe(false);
    expect(matchesGlob('', '**')).toBe(false);
  });

  it('repeated ** parts take no longer than one', () => {
    const deep = Array.from({ length: 28 }, () => 'x').join('/');
    const started = performance.now();
    expect(matchesGlob(`${deep}/end.md`, `${Array.from({ length: 28 }, () => '**').join('/')}/nope.md`)).toBe(false);
    expect(matchesGlob(`${deep}/end.md`, `${Array.from({ length: 28 }, () => '**').join('/')}/end.md`)).toBe(true);
    // parts that cannot be collapsed must not blow up either
    expect(matchesGlob(`${deep}/end.md`, `${Array.from({ length: 28 }, () => '**/x').join('/')}/nope.md`)).toBe(false);
    // Measured 19 Oct 2026: about 0.2 ms (0.9 ms worst of 20). Without the memo in matchParts it runs for minutes,
    // so 1000 ms still catches that while a loaded machine cannot trip it (50 ms did, under parallel test runs).
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('is not slow on a hostile pattern', () => {
    const started = Date.now();
    matchesGlob(`${'a'.repeat(60)}b`, `${'a*'.repeat(30)}c`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('matchesScope', () => {
  it('is true when any pattern matches', () => {
    expect(matchesScope('README.md', ['src/**', 'README.md'])).toBe(true);
    expect(matchesScope('other.md', ['src/**', 'README.md'])).toBe(false);
    expect(matchesScope('x', [])).toBe(false);
  });
});

describe('normalizeScopeEntry', () => {
  const ok = (raw: string, allowBroad = false) => {
    const r = normalizeScopeEntry(raw, { allowBroad });
    return r.ok ? r.pattern : `ERR: ${r.error}`;
  };

  it('accepts plain paths and globs', () => {
    expect(ok('README.md')).toBe('README.md');
    expect(ok('src/lib/*.ts')).toBe('src/lib/*.ts');
    expect(ok('  docs/**  ')).toBe('docs/**');
    expect(ok('src/**/*.test.ts')).toBe('src/**/*.test.ts');
    expect(ok('docs/my notes.md')).toBe('docs/my notes.md');
    expect(ok('docs/日本語.md')).toBe('docs/日本語.md');
  });

  it('cleans up ./ and double slashes, and turns a trailing slash into a folder glob', () => {
    expect(ok('./README.md')).toBe('README.md');
    expect(ok('src//a.ts')).toBe('src/a.ts');
    expect(ok('src/./a.ts')).toBe('src/a.ts');
    expect(ok('docs/')).toBe('docs/**');
  });

  it('rejects parent traversal', () => {
    expect(ok('../x')).toMatch(/^ERR:.*\.\./);
    expect(ok('src/../../x')).toMatch(/^ERR:/);
    expect(ok('src/..')).toMatch(/^ERR:/);
  });

  it('rejects absolute paths, home paths and drive letters', () => {
    expect(ok('/etc/passwd')).toMatch(/^ERR:.*absolute/);
    expect(ok('~/notes.md')).toMatch(/^ERR:/);
    expect(ok('C:\\work\\a.ts')).toMatch(/^ERR:/);
    expect(ok('C:/work/a.ts')).toMatch(/^ERR:/);
  });

  it('rejects backslashes, control characters and empty entries', () => {
    expect(ok('src\\a.ts')).toMatch(/^ERR:/);
    expect(ok('src/a\u0000.ts')).toMatch(/^ERR:/);
    expect(ok('src/a\nb.ts')).toMatch(/^ERR:/);
    expect(ok('')).toMatch(/^ERR:/);
    expect(ok('   ')).toMatch(/^ERR:/);
    expect(ok('.')).toMatch(/^ERR:/);
    expect(ok('./')).toMatch(/^ERR:/);
  });

  it('rejects anything inside .git', () => {
    expect(ok('.git/hooks/pre-commit')).toMatch(/^ERR:.*\.git/);
    expect(ok('sub/.git/config')).toMatch(/^ERR:/);
  });

  it('rejects patterns that match everything, unless broad scope is allowed', () => {
    for (const broad of ['**', '*', '**/*', '*/*', '**/**', '*/**', './**']) {
      expect(ok(broad), broad).toMatch(/^ERR:.*broad/);
      expect(ok(broad, true), broad).not.toMatch(/^ERR:/);
    }
    // a pattern anchored by a fixed folder or file name is not broad
    expect(ok('*.md')).toBe('*.md');
    expect(ok('src/**')).toBe('src/**');
  });

  it('rejects the sneaky broad patterns too: no literal character, or no fixed folder up front', () => {
    for (const broad of ['**/?*', '?*/**', '*?', '?', '**/*.*', '*.*', '.*/**', '.*', '**/*.md', '**/*.ts', '*/docs/**', 'src*/**', '?rc/**', '**/README.md']) {
      expect(ok(broad), broad).toMatch(/^ERR:.*broad/);
      expect(ok(broad, true), broad).not.toMatch(/^ERR:/);
    }
  });

  it('still accepts sensible, anchored scopes', () => {
    for (const fine of ['README.md', 'docs/**', 'src/**/*.ts', '.gitignore', '.github/workflows/ci.yml', 'src/*', 'src/lib/?.ts', 'docs/**/?*', '*.md', 'package.json']) {
      expect(ok(fine), fine).toBe(fine);
    }
  });

  it('collapses repeated ** parts', () => {
    expect(ok('docs/**/**/**/a.md')).toBe('docs/**/a.md');
  });

  it('rejects a pattern that is too long or has too many parts', () => {
    expect(ok(`docs/${'a'.repeat(200)}`)).toMatch(/^ERR:.*too long/);
    expect(ok(`docs/${'a'.repeat(190)}`)).toBe(`docs/${'a'.repeat(190)}`);
    expect(ok(Array.from({ length: 33 }, (_, i) => `d${i}`).join('/'))).toMatch(/^ERR:.*too many/);
    expect(ok(Array.from({ length: 32 }, (_, i) => `d${i}`).join('/'))).not.toMatch(/^ERR:/);
  });

  it('still rejects traversal and absolute paths when broad scope is allowed', () => {
    expect(ok('../x', true)).toMatch(/^ERR:/);
    expect(ok('/x', true)).toMatch(/^ERR:/);
  });
});

describe('parseScopeBlock', () => {
  const plan = (scope: string) => `1. Files\n- edit README.md\n\n2. Tests\nnone\n\n${scope}`;

  it('reads a valid block at the end of a plan', () => {
    const r = parseScopeBlock(plan('SCOPE:\n- README.md\n- src/lib/*.ts\n'));
    expect(r).toEqual({ ok: true, scope: ['README.md', 'src/lib/*.ts'] });
  });

  it('accepts star bullets, backticks, bold and a code fence', () => {
    expect(parseScopeBlock('**SCOPE:**\n* `README.md`\n* `docs/**`')).toEqual({ ok: true, scope: ['README.md', 'docs/**'] });
    expect(parseScopeBlock('```\nSCOPE:\n- a.txt\n```')).toEqual({ ok: true, scope: ['a.txt'] });
  });

  it('uses the last SCOPE block and stops at the first line that is not a bullet', () => {
    const text = 'SCOPE:\n- old.txt\n\nChanged my mind.\n\nSCOPE:\n- new.txt\n- other/*.txt\n\nNotes after.\n- not scope';
    expect(parseScopeBlock(text)).toEqual({ ok: true, scope: ['new.txt', 'other/*.txt'] });
  });

  it('removes duplicates and cleans each entry', () => {
    expect(parseScopeBlock('SCOPE:\n- ./a.txt\n- a.txt\n- docs/')).toEqual({ ok: true, scope: ['a.txt', 'docs/**'] });
  });

  it('fails when the block is missing', () => {
    const r = parseScopeBlock('A plan with no scope at all.\n- README.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no SCOPE/i);
  });

  it('fails when the block is empty', () => {
    const r = parseScopeBlock('SCOPE:\n\nsomething else');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty|no paths/i);
  });

  it('fails when a line is too broad, and says which', () => {
    const r = parseScopeBlock('SCOPE:\n- README.md\n- **');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\*\*.*broad/s);
    expect(parseScopeBlock('SCOPE:\n- **', { allowBroad: true })).toEqual({ ok: true, scope: ['**'] });
  });

  it('fails on an absolute path and on ..', () => {
    const abs = parseScopeBlock('SCOPE:\n- /etc/passwd');
    expect(abs.ok).toBe(false);
    if (!abs.ok) expect(abs.error).toMatch(/\/etc\/passwd/);
    const up = parseScopeBlock('SCOPE:\n- ../outside.txt');
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.error).toMatch(/outside\.txt/);
  });

  it('fails when a line has more on it than a path', () => {
    // "(new)" would become part of the file name and match nothing, so ask for a clean line instead
    const r = parseScopeBlock('SCOPE:\n- README.md (edit)');
    expect(r.ok).toBe(false);
  });

  it('caps the number of entries at 100', () => {
    const lines = (n: number) => `SCOPE:\n${Array.from({ length: n }, (_, i) => `- f${i}.txt`).join('\n')}`;
    expect(parseScopeBlock(lines(100)).ok).toBe(true);
    const many = lines(101);
    const r = parseScopeBlock(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too many/i);
  });
});

// Job 3c70469d ("Add a range(start, end, step) helper", 25 Oct 2026). Its two plan replies, as the server got them.
const ATTEMPT_1 = [
  'I read src/ and test/ and wrote the plan.',
  '',
  'The plan is written to the plan file and presented above. Note: `ExitPlanMode` isn\'t available as a tool in this environment, so I could not hand it over that way; the scope block lists exactly the three files',
].join('\n');
const ATTEMPT_2 = [
  '1. Add `src/range.js` exporting `range(start, end, step)`.',
  '2. Add `test/range.test.js` covering a positive step, a negative step and a zero step.',
  '3. Risk: floating point steps. Not handled beyond what the tests cover.',
  '',
  '```',
  'SCOPE:',
  'src/range.js',
  'test/range.test.js',
  '```',
].join('\n');

describe('parseScopeBlock: bare path lines', () => {
  it('reads job 3c70469d attempt 2: bare paths inside a code fence', () => {
    expect(parseScopeBlock(ATTEMPT_2)).toEqual({ ok: true, scope: ['src/range.js', 'test/range.test.js'] });
  });

  it('still fails job 3c70469d attempt 1, and tells the model to put the block in its reply', () => {
    const r = parseScopeBlock(ATTEMPT_1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no SCOPE block/);
      expect(r.error).toMatch(/in your reply itself, not in a plan file/);
    }
  });

  it('an empty block says where the paths go and that the block belongs in the reply', () => {
    const r = parseScopeBlock('SCOPE:\n\nsrc/a.js');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/empty/);
      expect(r.error).toMatch(/right after "SCOPE:"/);
      expect(r.error).toMatch(/not in a plan file/);
    }
  });

  it('bullets still work, and bullets and bare lines can be mixed', () => {
    expect(parseScopeBlock('SCOPE:\n- README.md\n* src/lib/*.ts')).toEqual({ ok: true, scope: ['README.md', 'src/lib/*.ts'] });
    expect(parseScopeBlock('SCOPE:\n- README.md\nsrc/a.js\n  * `docs/**`\ntest/a.test.js')).toEqual({ ok: true, scope: ['README.md', 'src/a.js', 'docs/**', 'test/a.test.js'] });
  });

  it('takes bare lines wrapped in backticks, and indented bare lines', () => {
    expect(parseScopeBlock('SCOPE:\n`src/a.js`\n  `docs/**`\n  test/a.test.js  ')).toEqual({ ok: true, scope: ['src/a.js', 'docs/**', 'test/a.test.js'] });
  });

  it('a code fence line closes the block', () => {
    expect(parseScopeBlock('```\nSCOPE:\nsrc/a.js\n```\nsrc/after-the-fence.js')).toEqual({ ok: true, scope: ['src/a.js'] });
    expect(parseScopeBlock('~~~\nSCOPE:\nsrc/a.js\n~~~\nsrc/b.js')).toEqual({ ok: true, scope: ['src/a.js'] });
    // A fence that opens the next code block, language and all, ends the block too. Without the fence rule ~~~sh would be read as a path.
    expect(parseScopeBlock('SCOPE:\nsrc/a.js\n~~~sh\nnpm test\n~~~')).toEqual({ ok: true, scope: ['src/a.js'] });
  });

  it('a blank line ends the block', () => {
    expect(parseScopeBlock('SCOPE:\nsrc/a.js\n\nsrc/b.js')).toEqual({ ok: true, scope: ['src/a.js'] });
  });

  it('prose straight after a bare block, with no blank line, ends the block and is never read as a path', () => {
    const text = "SCOPE:\nsrc/range.js\ntest/range.test.js\nThe `ExitPlanMode` tool isn't available here, so this reply is the plan.";
    expect(parseScopeBlock(text)).toEqual({ ok: true, scope: ['src/range.js', 'test/range.test.js'] });
  });

  it('a one-word line after a bare block ends it too: a colon, a final dot, emphasis, a rule, a lone dash', () => {
    for (const after of ['Notes:', 'Done.', '...', '**Notes**', '*note*', '__Notes__', '_note_', '---', '***', '___', '-', '/', 'src/a.js:12', 'a,b', 'x;y', '"src/b.js"', "it's", '<details>', '|', '1.']) {
      expect(parseScopeBlock(`SCOPE:\nsrc/a.js\n${after}\nsrc/b.js`), after).toEqual({ ok: true, scope: ['src/a.js'] });
    }
  });

  it('reads the ordinary path characters on a bare line, in any script', () => {
    const paths = ['Makefile', '.gitignore', '.github/workflows/ci.yml', 'app/[id]/page.tsx', 'app/(group)/@slot/+page.svelte', 'src/{a}/b-c_d.ts', 'docs/', 'src/lib/?.ts', '*.md', 'docs/café.md', 'docs/日本語.md', '_config.yml'];
    const r = parseScopeBlock(`SCOPE:\n${paths.join('\n')}`);
    expect(r).toEqual({ ok: true, scope: ['Makefile', '.gitignore', '.github/workflows/ci.yml', 'app/[id]/page.tsx', 'app/(group)/@slot/+page.svelte', 'src/{a}/b-c_d.ts', 'docs/**', 'src/lib/?.ts', '*.md', 'docs/café.md', 'docs/日本語.md', '_config.yml'] });
  });

  it('a bad bare line fails the whole block, it does not just end it', () => {
    // **/docs/** looks like emphasis at both ends, but it has a slash, so it is a path line and fails as too broad.
    for (const bad of ['../x', '.git/x', '**', '*', '/etc/passwd', '~/x', 'src/../../x', '**/*.md', '**/docs/**', `docs/${'a'.repeat(200)}`]) {
      const r = parseScopeBlock(`SCOPE:\nsrc/a.js\n${bad}`);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error, bad).toMatch(/bad SCOPE lines/);
    }
    expect(parseScopeBlock('SCOPE:\nsrc/a.js\n`../x`').ok).toBe(false);
    expect(parseScopeBlock('SCOPE:\n**', { allowBroad: true })).toEqual({ ok: true, scope: ['**'] });
  });

  it('an empty bullet ends the block', () => {
    expect(parseScopeBlock('SCOPE:\n- a.txt\n- \n- b.txt')).toEqual({ ok: true, scope: ['a.txt'] });
  });

  it('the last block still wins with bare lines', () => {
    expect(parseScopeBlock('SCOPE:\nold.txt\n\nChanged my mind.\n\nSCOPE:\nnew.txt\n')).toEqual({ ok: true, scope: ['new.txt'] });
  });

  it('the 100-entry cap counts bare lines', () => {
    const lines = (n: number) => `SCOPE:\n${Array.from({ length: n }, (_, i) => `f${i}.txt`).join('\n')}`;
    expect(parseScopeBlock(lines(100)).ok).toBe(true);
    expect(parseScopeBlock(lines(101)).ok).toBe(false);
  });

  it('NFC still applies to bare lines', () => {
    expect(parseScopeBlock('SCOPE:\ndocs/café.md')).toEqual({ ok: true, scope: ['docs/café.md'] });
  });
});

describe('parseScopeBlock on large model text', () => {
  const MB = 1 << 20;
  const fast = (text: string) => {
    const t = performance.now();
    const r = parseScopeBlock(text);
    return { r, ms: performance.now() - t };
  };
  // Each case was quadratic or worse before (a 64 KB bullet line with spaces took 3.6 s), so 1 MB would take minutes.
  // The bound is loose so a loaded machine does not fail it.
  it('reads a block after 1 MB of plan text quickly', () => {
    const { r, ms } = fast(`${'word '.repeat(MB / 5)}\n${'line\n'.repeat(MB / 5)}SCOPE:\nsrc/a.js\n- src/b.js\n`);
    expect(r).toEqual({ ok: true, scope: ['src/a.js', 'src/b.js'] });
    expect(ms).toBeLessThan(3000);
  });

  it('a 1 MB bullet line full of spaces fails quickly', () => {
    const { r, ms } = fast(`SCOPE:\n- a${' '.repeat(MB)}b`);
    expect(r.ok).toBe(false);
    expect(ms).toBeLessThan(3000);
  });

  it('a 1 MB bullet line of " (" fails quickly (the note check sees only short lines)', () => {
    const { r, ms } = fast(`SCOPE:\n- ${' ('.repeat(MB / 2)}x`);
    expect(r.ok).toBe(false);
    expect(ms).toBeLessThan(3000);
  });

  it('a 1 MB bare line fails quickly, and so does a 1 MB line of stars before the head', () => {
    const bare = fast(`SCOPE:\nsrc/a.js\n${'a/'.repeat(MB / 2)}`);
    expect(bare.r.ok).toBe(false);
    expect(bare.ms).toBeLessThan(3000);
    const stars = fast(`${'*'.repeat(MB)}x\nno block`);
    expect(stars.r.ok).toBe(false);
    expect(stars.ms).toBeLessThan(3000);
  });

  it('a 1 MB backtick-wrapped bare line and a 1 MB emphasis-looking line end or fail quickly', () => {
    for (const line of [`\`${'a'.repeat(MB)}\``, `**${'a'.repeat(MB)}`, `${'_'.repeat(MB)}a_`]) {
      const { ms } = fast(`SCOPE:\nsrc/a.js\n${line}`);
      expect(ms).toBeLessThan(3000);
    }
  });
});

describe('one description of the SCOPE block', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const sources = {
    header: read('../src/index.ts').split('*/')[0]!.replace(/^ \* ?/gm, ''),
    planPrompt: read('../../../plugins/pipeline-dev/prompts/plan.md'),
    adr: read('../../../docs/adr/0005-scope-guard.md'),
  };

  it('the header comment, the plan prompt and ADR 0005 use the same rule, the same example, and say the block goes in the reply', () => {
    const example = SCOPE_BLOCK_EXAMPLE.split('\n');
    for (const [name, text] of Object.entries(sources)) {
      const flat = text.replace(/\s+/g, ' ').toLowerCase();
      expect(flat, name).toContain(SCOPE_BLOCK_RULE.toLowerCase());
      expect(flat, name).toContain(SCOPE_BLOCK_IN_REPLY.replace(/^Put the block in your /, '').toLowerCase());
      const lines = text.split('\n').map((l) => l.trim());
      const at = lines.indexOf(example[0]!);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at, at + example.length), name).toEqual(example);
    }
  });

  it('the example parses', () => {
    expect(parseScopeBlock(SCOPE_BLOCK_EXAMPLE)).toEqual({ ok: true, scope: ['README.md', 'src/lib/*.ts'] });
  });
});

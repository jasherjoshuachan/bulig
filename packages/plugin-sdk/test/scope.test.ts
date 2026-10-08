import { describe, expect, it } from 'vitest';
import { matchesGlob, matchesScope, normalizeScopeEntry, parseScopeBlock } from '../src/index.ts';

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
    expect(ok('**/*.test.ts')).toBe('**/*.test.ts');
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
    // a pattern with a fixed part is not broad
    expect(ok('**/*.ts')).toBe('**/*.ts');
    expect(ok('*.md')).toBe('*.md');
    expect(ok('src/**')).toBe('src/**');
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

  it('caps the number of entries', () => {
    const many = `SCOPE:\n${Array.from({ length: 300 }, (_, i) => `- f${i}.txt`).join('\n')}`;
    const r = parseScopeBlock(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too many/i);
  });
});

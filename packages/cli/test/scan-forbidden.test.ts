import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/scan-forbidden.sh', import.meta.url));
const VERIFY = fileURLToPath(new URL('../../../scripts/verify.sh', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PATTERN = 'zq-banned-[0-9]+';

/** A throwaway git repo holding one tracked file, plus an empty config home. */
function world(fileText: string) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-scan-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), fileText);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  return { repo, home };
}

function scan(w: { repo: string; home: string }, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: w.home, SCAN_ROOT: w.repo, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('forbidden terms scan', () => {
  it('verify.sh no longer carries a term list of its own', () => {
    const src = execFileSync('cat', [VERIFY], { encoding: 'utf8' });
    expect(src).toMatch(/scan-forbidden\.sh/);
    expect(src).not.toMatch(/grep -InEi/);
  });

  it('reports file and line only, never the matched text or the pattern', () => {
    const w = world('fine\nhas zq-banned-42 here\n');
    const r = scan(w, { BULIG_FORBIDDEN_TERMS: PATTERN });
    expect(r.code).toBe(1);
    expect(r.out).toContain('a.txt:2');
    expect(r.out).not.toContain('zq-banned');
    expect(r.out).not.toContain(PATTERN);
    expect(r.out).not.toContain('has ');
  });

  it('passes when nothing matches', () => {
    const w = world('all clean\n');
    expect(scan(w, { BULIG_FORBIDDEN_TERMS: PATTERN }).code).toBe(0);
  });

  it('reads the pattern from the config file, first line only', () => {
    const w = world('x zq-banned-7\n');
    mkdirSync(join(w.home, '.config', 'bulig'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'bulig', 'forbidden-terms'), `${PATTERN}\nnever-used\n`);
    const r = scan(w);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a.txt:1');
    expect(r.out).not.toContain('zq-banned');
  });

  it('honours XDG_CONFIG_HOME', () => {
    const w = world('x zq-banned-7\n');
    const xdg = join(dirname(w.repo), 'xdg');
    mkdirSync(join(xdg, 'bulig'), { recursive: true });
    writeFileSync(join(xdg, 'bulig', 'forbidden-terms'), `${PATTERN}\n`);
    expect(scan(w, { XDG_CONFIG_HOME: xdg }).code).toBe(1);
  });

  it('with no pattern anywhere: CI prints a notice and skips', () => {
    const w = world('x zq-banned-7\n');
    const r = scan(w, { CI: 'true' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/notice/i);
    expect(r.out).toMatch(/skipped/i);
  });

  it('with no pattern anywhere: local run skips with a visible warning', () => {
    const w = world('x zq-banned-7\n');
    const r = scan(w);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning/i);
    expect(r.out).toMatch(/skipped/i);
  });

  it('a pattern that is not a valid regex fails without echoing it', () => {
    const w = world('x\n');
    const r = scan(w, { BULIG_FORBIDDEN_TERMS: 'secret-(unclosed' });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('secret-');
  });

  it('CI workflow passes the secret in as env', () => {
    const ci = execFileSync('cat', [fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url))], { encoding: 'utf8' });
    expect(ci).toMatch(/BULIG_FORBIDDEN_TERMS:\s*\$\{\{\s*secrets\.BULIG_FORBIDDEN_TERMS\s*\}\}/);
  });

  it('the example capability scope is owner-dm everywhere, not a personal name', () => {
    const old = ['jasher', 'dm'].join('-');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const r = spawnSync('git', ['grep', '-nIi', '-e', old], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(1);
  });
});

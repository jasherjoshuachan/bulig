import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, HARDENING, kernelGit } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-git-'));
  dirs.push(d);
  return d;
};
const plain = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

/** A repo whose own config names programs for git to run, each of which writes its name to a marker file. */
function boobyTrapped() {
  const root = tmp();
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  plain(repo, 'config', 'user.email', 't@example.com');
  plain(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  plain(repo, 'add', '-A');
  plain(repo, 'commit', '-qm', 'init');
  const marker = join(root, 'marker');
  const script = (name: string, exit = 1) => {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> "${marker}"\nexit ${exit}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  plain(repo, 'config', 'core.fsmonitor', script('fsmonitor'));
  plain(repo, 'config', 'diff.external', script('external-diff', 0));
  plain(repo, 'config', 'core.hooksPath', join(root, 'hooks'));
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  return { repo, marker, root };
}
const marks = (marker: string) => (existsSync(marker) ? execFileSync('cat', [marker], { encoding: 'utf8' }).split('\n').filter(Boolean) : []);

describe('kernelGit', () => {
  it('puts every hardening setting on the command line, in front of the command', () => {
    const { args } = kernelGit(['status']);
    for (const c of HARDENING) expect(args).toContain(c);
    for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.sshCommand=ssh', 'core.pager=cat', 'core.editor=true', 'gpg.program=gpg', 'commit.gpgsign=false', 'protocol.ext.allow=never', 'credential.helper=']) {
      expect(args.join(' '), c).toContain(`-c ${c}`);
    }
    expect(args.at(-1)).toBe('status');
    expect(args.indexOf('status')).toBeGreaterThan(args.lastIndexOf('-c'));
  });

  it('commands that can run an external diff get --no-ext-diff right after the command name, and others do not', () => {
    expect(kernelGit(['diff', '--cached', '--name-only']).args.slice(-4)).toEqual(['diff', '--no-ext-diff', '--cached', '--name-only']);
    expect(kernelGit(['--literal-pathspecs', 'diff-tree', '-r', 'HEAD']).args.slice(-5)).toEqual(['--literal-pathspecs', 'diff-tree', '--no-ext-diff', '-r', 'HEAD']);
    expect(kernelGit(['-c', 'core.quotepath=false', 'diff']).args.slice(-4)).toEqual(['-c', 'core.quotepath=false', 'diff', '--no-ext-diff']);
    for (const v of ['log', 'show']) expect(kernelGit([v]).args).toContain('--no-ext-diff');
    expect(kernelGit(['status']).args).not.toContain('--no-ext-diff');
    expect(kernelGit(['commit', '-m', 'diff']).args).not.toContain('--no-ext-diff');
  });

  it('local calls read no global config and drop the variables that name programs; a call to a remote keeps the user\'s config and ssh', () => {
    const base = { PATH: '/bin', HOME: '/h', GIT_EXTERNAL_DIFF: 'x', GIT_PAGER: 'x', GIT_EDITOR: 'x', GIT_DIR: '/x', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig', GIT_CONFIG_COUNT: '1', GIT_SSH_COMMAND: 'ssh -i k', GIT_ASKPASS: '/a' };
    const local = kernelGit(['status'], { baseEnv: base });
    expect(local.env).toMatchObject({ PATH: '/bin', HOME: '/h', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' });
    for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND', 'GIT_ASKPASS']) expect(local.env, k).not.toHaveProperty(k);
    const net = kernelGit(['push'], { baseEnv: base, ambientConfig: true });
    expect(net.env).not.toHaveProperty('GIT_CONFIG_GLOBAL');
    expect(net.env).toMatchObject({ GIT_SSH_COMMAND: 'ssh -i k', GIT_ASKPASS: '/a', GIT_CONFIG_NOSYSTEM: '1' });
    expect(net.env).not.toHaveProperty('GIT_EXTERNAL_DIFF');
    expect(net.args.join(' ')).not.toContain('credential.helper=');
    // a variable the caller adds on purpose survives the clean-up
    expect(kernelGit(['status'], { baseEnv: base, env: { GIT_INDEX_FILE: '/scratch/index' } }).env.GIT_INDEX_FILE).toBe('/scratch/index');
  });
});

describe('what a repository\'s own config cannot make the kernel run', () => {
  it('control: plain git does run the repo\'s fsmonitor, its external diff and, on commit, its hooks path', () => {
    const t = boobyTrapped();
    execFileSync('git', ['status'], { cwd: t.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    execFileSync('git', ['diff'], { cwd: t.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(marks(t.marker)).toEqual(expect.arrayContaining(['fsmonitor', 'external-diff']));
  });

  it('kernel git runs neither, for status, add, diff, commit and log', async () => {
    const t = boobyTrapped();
    for (const args of [['status', '--porcelain'], ['add', '-A'], ['diff', '--cached'], ['diff'], ['commit', '-qm', 'two'], ['log', '--format=%s'], ['diff-tree', '--root', '-r', 'HEAD']]) {
      const r = await git(t.repo, args);
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
    }
    expect(marks(t.marker)).toEqual([]);
    // and it still did the work
    expect(plain(t.repo, 'log', '--format=%s')).toBe('two\ninit');
  });
});

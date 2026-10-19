import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeKernelUrl } from '../src/client.ts';
import { applyPatch, collectChanges, prepareWorkspace, removeWorkspace, resolveBase, WorkspaceError } from '../src/workspace.ts';
import { git as gitSync, makeWorld, tmp } from './support.ts';
import { git } from '@bulig/git';

describe('assertSafeKernelUrl', () => {
  it.each(['http://127.0.0.1:7431', 'http://localhost:7431', 'http://[::1]:7431', 'http://100.101.102.103:7431', 'http://100.64.0.1', 'http://100.127.255.255', 'http://[fd7a:115c:a1e0::1]:7431', 'https://kernel.example.com'])('allows %s', (url) => {
    expect(() => assertSafeKernelUrl(url)).not.toThrow();
  });

  it.each(['http://example.com', 'http://203.0.113.5:7431', 'http://100.128.0.1', 'http://100.63.0.1', 'http://192.168.1.10:7431', 'http://box.tail1234.ts.net:7431', 'http://[::ffff:127.0.0.1]:7431', 'ftp://127.0.0.1', 'nonsense'])('refuses %s: a token must not cross an open network in the clear', (url) => {
    expect(() => assertSafeKernelUrl(url)).toThrow();
  });
});

describe('assertSafeKernelUrl, named hosts', () => {
  it('a name is accepted over plain http only when it is listed', () => {
    expect(() => assertSafeKernelUrl('http://box.tail1234.ts.net:7431')).toThrow(/--allow-http-host/);
    expect(() => assertSafeKernelUrl('http://box.tail1234.ts.net:7431', ['other.ts.net'])).toThrow();
    expect(() => assertSafeKernelUrl('http://Box.Tail1234.ts.net:7431', ['box.tail1234.ts.net'])).not.toThrow();
  });
});

describe('workspace transfer', () => {
  const header = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

  it('refuses paths that climb out, start at the root, or reach .git', async () => {
    const w = makeWorld();
    for (const path of ['../escape.txt', 'a/../../escape.txt', '.git/hooks/pre-commit', 'sub/.GIT/config']) {
      await expect(applyPatch(w.clone, Buffer.from(header(path))), path).rejects.toThrow(WorkspaceError);
    }
    expect(existsSync(join(w.clone, '..', 'escape.txt'))).toBe(false);
  });

  describe('symlinks and submodules, however the patch spells them', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567';
    const blob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    const link = (mode: string) => `diff --git a/evil b/evil\nnew file mode ${mode}\nindex 0000000..${blob}\n--- /dev/null\n+++ b/evil\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n`;
    const patches: [string, string][] = [
      ['plain 120000', link('120000')],
      ['octal with a leading zero (0120000), which git reads as the same mode', link('0120000')],
      ['extra spaces (new file mode  120000)', link(' 120000')],
      ['more leading zeros', link('00120000')],
      ['a mode change of a tracked file to a symlink', 'diff --git a/README.md b/README.md\nold mode 100644\nnew mode 120000\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hi\n+/etc/passwd\n\\ No newline at end of file\n'],
      ['a gitlink (submodule)', `diff --git a/sub b/sub\nnew file mode 160000\nindex 0000000..${SHA}\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+Subproject commit ${SHA}\n`],
      ['a gitlink with a leading zero', `diff --git a/sub b/sub\nnew file mode 0160000\nindex 0000000..${SHA}\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+Subproject commit ${SHA}\n`],
    ];

    it.each(patches)('refuses %s and writes nothing', async (_name, patch) => {
      const w = makeWorld();
      await expect(applyPatch(w.clone, Buffer.from(patch))).rejects.toThrow(WorkspaceError);
      expect(() => lstatSync(join(w.clone, 'evil'))).toThrow();
      expect(() => lstatSync(join(w.clone, 'sub'))).toThrow();
      expect(gitSync(w.clone, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(w.clone, 'README.md'), 'utf8')).toBe('hi\n');
    });

    it('a symlink that is already in the repository does not stop an ordinary patch', async () => {
      const w = makeWorld();
      symlinkSync('README.md', join(w.clone, 'existing-link'));
      gitSync(w.clone, 'add', '-A');
      gitSync(w.clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a link that was already here');
      await applyPatch(w.clone, Buffer.from(header('src/ok.txt')));
      expect(existsSync(join(w.clone, 'src/ok.txt'))).toBe(true);
      expect(lstatSync(join(w.clone, 'existing-link')).isSymbolicLink()).toBe(true);
    });

    it('even if a link got past the checks, the real apply writes a plain file, never a link (core.symlinks=false)', async () => {
      // Drives git the way applyPatch's last step does, with a patch the checks above would have stopped.
      const w = makeWorld();
      const r = await git(w.clone, ['-c', 'core.symlinks=false', 'apply', '--binary', '-'], { input: Buffer.from(link('120000')) });
      expect(r.code).toBe(0);
      expect(lstatSync(join(w.clone, 'evil')).isSymbolicLink()).toBe(false);
    });
  });

  it('applies a good patch, all or nothing', async () => {
    const w = makeWorld();
    const good = header('src/a.txt');
    await applyPatch(w.clone, Buffer.from(good));
    expect(existsSync(join(w.clone, 'src/a.txt'))).toBe(true);
    gitSync(w.clone, 'clean', '-fdq');
    // second file fails to apply, so the first must not appear either
    const mixed = good + 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-nothing like this line\n+y\n';
    await expect(applyPatch(w.clone, Buffer.from(mixed))).rejects.toThrow(/did not apply/);
    expect(existsSync(join(w.clone, 'src/a.txt'))).toBe(false);
  });

  it('a worker folder starts from the base, carries the job so far, and returns only what the stage changed', async () => {
    const w = makeWorld();
    const base = await resolveBase(w.repo);
    expect(base).toBe(gitSync(w.repo, 'rev-parse', 'origin/main'));
    const dir = join(tmp(), 'stage');
    await prepareWorkspace(w.clone, dir, base, Buffer.from(header('earlier.txt')));
    expect(existsSync(join(dir, 'earlier.txt'))).toBe(true);
    expect(await collectChanges(dir, 1 << 20)).toHaveLength(0); // the job so far is the baseline, not a change
    writeFileSync(join(dir, 'now.txt'), 'new\n');
    const changes = (await collectChanges(dir, 1 << 20)).toString('utf8');
    expect(changes).toContain('now.txt');
    expect(changes).not.toContain('earlier.txt');
    await removeWorkspace(w.clone, dir);
    expect(existsSync(dir)).toBe(false);
    expect(gitSync(w.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a repository with no origin cannot be worked on remotely, and says why', async () => {
    const w = makeWorld();
    gitSync(w.repo, 'remote', 'remove', 'origin');
    await expect(resolveBase(w.repo)).rejects.toThrow(/no origin/);
  });
});

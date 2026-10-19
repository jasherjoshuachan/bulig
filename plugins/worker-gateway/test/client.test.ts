import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeKernelUrl } from '../src/client.ts';
import { applyPatch, collectChanges, prepareWorkspace, removeWorkspace, resolveBase, WorkspaceError } from '../src/workspace.ts';
import { git, makeWorld, tmp } from './support.ts';

describe('assertSafeKernelUrl', () => {
  it.each(['http://127.0.0.1:7431', 'http://localhost:7431', 'http://[::1]:7431', 'http://100.101.102.103:7431', 'http://100.64.0.1', 'http://100.127.255.255', 'http://box.tail1234.ts.net:7431', 'http://[fd7a:115c:a1e0::1]:7431', 'https://kernel.example.com'])('allows %s', (url) => {
    expect(() => assertSafeKernelUrl(url)).not.toThrow();
  });

  it.each(['http://example.com', 'http://203.0.113.5:7431', 'http://100.128.0.1', 'http://100.63.0.1', 'http://192.168.1.10:7431', 'ftp://127.0.0.1', 'nonsense'])('refuses %s: a token must not cross an open network in the clear', (url) => {
    expect(() => assertSafeKernelUrl(url)).toThrow();
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

  it('applies a good patch, all or nothing', async () => {
    const w = makeWorld();
    const good = header('src/a.txt');
    await applyPatch(w.clone, Buffer.from(good));
    expect(existsSync(join(w.clone, 'src/a.txt'))).toBe(true);
    git(w.clone, 'clean', '-fdq');
    // second file fails to apply, so the first must not appear either
    const mixed = good + 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-nothing like this line\n+y\n';
    await expect(applyPatch(w.clone, Buffer.from(mixed))).rejects.toThrow(/did not apply/);
    expect(existsSync(join(w.clone, 'src/a.txt'))).toBe(false);
  });

  it('a worker folder starts from the base, carries the job so far, and returns only what the stage changed', async () => {
    const w = makeWorld();
    const base = await resolveBase(w.repo);
    expect(base).toBe(git(w.repo, 'rev-parse', 'origin/main'));
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
    expect(git(w.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a repository with no origin cannot be worked on remotely, and says why', async () => {
    const w = makeWorld();
    git(w.repo, 'remote', 'remove', 'origin');
    await expect(resolveBase(w.repo)).rejects.toThrow(/no origin/);
  });
});

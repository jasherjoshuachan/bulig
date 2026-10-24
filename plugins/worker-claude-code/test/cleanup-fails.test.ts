import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// rmSync throws for the run's npm cache while `failing` is on, every time it is called, so the unlock-and-retry cannot help either.
const state = vi.hoisted(() => ({ failing: false, calls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const rmSync = ((path: Parameters<typeof real.rmSync>[0], opts?: Parameters<typeof real.rmSync>[1]) => {
    if (state.failing && String(path).includes('bulig-npm-')) {
      state.calls++;
      throw Object.assign(new Error(`EPERM: operation not permitted, rm '${String(path)}'`), { code: 'EPERM' });
    }
    return real.rmSync(path, opts);
  }) as typeof real.rmSync;
  return { ...real, default: { ...real, rmSync }, rmSync };
});

const { buildArgs, run } = await import('../src/index.ts');

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'bulig-cleanup-'));
beforeAll(() => chmodSync(FAKE, 0o755));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a run whose npm cache cannot be removed at all (review of #71)', () => {
  it('still resolves, removes the gh folder, and logs one line with the path and the code', async () => {
    const dump = join(root, 'env.json');
    const warnings: string[] = [];
    state.failing = true;
    let out;
    try {
      out = await run(
        FAKE,
        buildArgs({ stage: 'build', prompt: 'plain', model: 'm', mode: 'edit', cwd: root }),
        root,
        10_000,
        { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_ENV_DUMP: dump },
        new Set<ChildProcess>(),
        () => () => {},
        (line) => void warnings.push(line),
      );
    } finally {
      state.failing = false;
    }
    const env = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    const npmDir = env.npm_config_cache!;
    try {
      expect(out.ok).toBe(true);
      expect(state.calls).toBe(2); // tried, unlocked, tried once more, then gave up
      expect(warnings).toEqual([`worker-claude-code: could not remove ${npmDir}: EPERM`]);
      expect(existsSync(env.GH_CONFIG_DIR!)).toBe(false); // the other folder is still cleaned up
      expect(existsSync(npmDir)).toBe(true); // left behind, and said so
    } finally {
      rmSync(npmDir, { recursive: true, force: true });
    }
  });
});

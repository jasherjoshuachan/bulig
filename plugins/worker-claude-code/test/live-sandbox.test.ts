import { describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.ts';

/**
 * A live check with the real claude CLI. It is skipped unless BULIG_LIVE_REPO names a throwaway git repo whose
 * origin is a private repo you own. It runs an edit-mode stage that is asked to reach GitHub through node, and
 * the stage must find no signed-in gh, no git credentials and no route to GitHub.
 *
 *   BULIG_LIVE_REPO=/path/to/throwaway pnpm vitest run plugins/worker-claude-code/test/live-sandbox.test.ts
 */
const repo = process.env.BULIG_LIVE_REPO;

const PROMPT = [
  'Run exactly this one command with the Bash tool, once, and do not run anything else:',
  `node -e "console.log(require('child_process').execSync('gh auth status 2>&1; git ls-remote origin 2>&1').toString())"`,
  'If the command fails, run it as it is anyway and report what it printed. Then reply with the output, copied word for word, and nothing else.',
  'Do not try to work around any error.',
].join('\n');

describe.skipIf(!repo)('live: an edit stage cannot reach GitHub through node', () => {
  it('gh is not signed in and git ls-remote fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulig-live-'));
    const seen: BuligEvent[] = [];
    let fire: (p: unknown) => void = () => {};
    const driver = definePlugin({
      manifest: { name: 'driver', version: '0.1.0', sdk: '0', description: 'live driver', subscribes: ['stage.completed', 'stage.failed'], emits: ['stage.requested'] },
      register(ctx) {
        ctx.on('stage.completed', (e) => void seen.push(e));
        ctx.on('stage.failed', (e) => void seen.push(e));
        fire = (p) => ctx.emit('stage.requested', p, 'live-1');
      },
    });
    const k = createKernel({
      dbPath: join(dir, 'db.sqlite'),
      plugins: [worker, driver],
      enabled: ['worker-claude-code', 'driver'],
      grants: { 'worker-claude-code': ['claude.run', 'fs.worktree'] },
      pluginConfig: { 'worker-claude-code': { timeoutMs: 240_000 } },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await k.start();
    try {
      fire({ stage: 'build', prompt: PROMPT, model: 'haiku', mode: 'edit', cwd: repo });
      const end = Date.now() + 250_000;
      while (seen.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      expect(seen[0]?.type).toBe('stage.completed');
      const text = String((seen[0]!.payload as { result: string }).result);
      console.log(`LIVE RESULT FROM CLAUDE:\n${text}`);
      expect(text).toMatch(/not logged in|no (github )?hosts|not authenticated/i);
      expect(text).not.toMatch(/Logged in to github\.com/i);
      expect(text).not.toMatch(/\brefs\/heads\//); // ls-remote printed no refs
      expect(text).toMatch(/fatal|could not|unable|denied|failed|terminal prompts disabled|resolve host/i);
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 280_000);
});

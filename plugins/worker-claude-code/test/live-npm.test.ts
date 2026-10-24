import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { buildArgs, buildClaudeEnv, run } from '../src/index.ts';

/**
 * A live check with the real claude CLI, in its real Bash sandbox (Seatbelt on macOS, bubblewrap on Linux). It is skipped unless
 * BULIG_LIVE_NPM=1. An edit stage runs `npm install` with no flags in a throwaway folder, and the package must land in node_modules:
 * the proof is the file on disk, not what the model says. Job 9628d02c is why (npm's default cache is not writable in the sandbox).
 *
 *   BULIG_LIVE_NPM=1 pnpm vitest run plugins/worker-claude-code/test/live-npm.test.ts
 */
const live = process.env.BULIG_LIVE_NPM === '1';

const PROMPT = [
  'Run exactly this one command with the Bash tool, once, and do not run anything else: npm install is-number',
  'If it fails, do not retry and do not try to work around the error. Reply with what it printed, word for word, and nothing else.',
].join('\n');

describe.skipIf(!live)('live: npm works with no flags inside the sandbox', () => {
  it('npm install puts the package in node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulig-live-npm-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'live-npm', version: '0.0.0', private: true }));
    try {
      const out = await run(
        'claude',
        buildArgs({ stage: 'build', prompt: PROMPT, model: 'haiku', mode: 'edit', cwd: dir }),
        dir,
        240_000,
        buildClaudeEnv(process.env),
        new Set<ChildProcess>(),
        () => () => {},
      );
      console.log(`LIVE RESULT FROM CLAUDE:\n${out.result || out.error}`);
      expect(out.ok).toBe(true);
      expect(out.evidence?.filter((e) => e.kind === 'run').map((e) => e.target)).toEqual(['npm install is-number']);
      expect(existsSync(join(dir, 'node_modules', 'is-number', 'package.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 280_000);
});

#!/usr/bin/env node
// The dev stand-in for claude, but a build can be slowed down or made to hang, for the worker chaos tests.
// FAKE_BUILD_DELAY_MS: wait this long before a build stage runs. FAKE_MARK: a file that gets a line when a build starts.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
if (prompt.includes('You are building')) {
  if (process.env.FAKE_MARK) appendFileSync(process.env.FAKE_MARK, `build ${process.pid} ${process.cwd()}\n`);
  const delay = Number(process.env.FAKE_BUILD_DELAY_MS ?? 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}
const dev = fileURLToPath(new URL('../../../../packages/cli/test/fixtures/fake-claude-dev.mjs', import.meta.url));
const r = spawnSync(process.execPath, [dev, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);

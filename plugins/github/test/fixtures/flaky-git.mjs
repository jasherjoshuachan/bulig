#!/usr/bin/env node
// Runs the real git, except that `git push` fails with a GitHub-style 500 the first N times.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const counter = process.env.FLAKY_COUNTER;
if (args[0] === 'push' && counter) {
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  const failFirst = Number(process.env.FLAKY_FAIL_FIRST ?? 0);
  if (n < failFirst) {
    const msg = process.env.FLAKY_MESSAGE ?? 'remote: Internal Server Error';
    process.stderr.write(`${msg}\n ! [remote rejected] (failure)\n`);
    process.exit(1);
  }
}
const r = spawnSync('git', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);

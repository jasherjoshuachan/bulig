#!/usr/bin/env node
// The dev stand-in for claude, plus a probe: it writes down what environment and folder it was started in.
// FAKE_PROBE is the file to append to (one JSON line per run).
import { appendFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.FAKE_PROBE) {
  const secretish = Object.keys(process.env).filter((k) => /^(BULIG_|GH_TOKEN|GITHUB_TOKEN|DATABASE_URL|CREDENTIALS_DIRECTORY)/.test(k));
  appendFileSync(
    process.env.FAKE_PROBE,
    JSON.stringify({ oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, leaked: secretish, cwdMode: statSync(process.cwd()).mode & 0o777, readmeMode: statSync('README.md').mode & 0o777 }) + '\n',
  );
}
const dev = fileURLToPath(new URL('./fake-claude-dev.mjs', import.meta.url));
const r = spawnSync(process.execPath, [dev, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);

#!/usr/bin/env node
// A stand-in for the claude CLI. It records how it was called and prints canned JSON.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mark = (text) => process.env.FAKE_CLAUDE_MARK && appendFileSync(process.env.FAKE_CLAUDE_MARK, text + '\n');

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
}

// Dump the whole environment this process was given, so a test can see exactly what reached it.
if (process.env.FAKE_CLAUDE_ENV_DUMP) {
  const ghEntries = process.env.GH_CONFIG_DIR ? readdirSync(process.env.GH_CONFIG_DIR) : null;
  writeFileSync(process.env.FAKE_CLAUDE_ENV_DUMP, JSON.stringify({ ...process.env, __GH_DIR_ENTRIES: ghEntries }));
}

if (prompt.includes('FAKE:linger') && args.includes('acceptEdits')) {
  // An edit stage that is slow to die: after SIGTERM it keeps going for a moment and then writes into its own
  // folder, recreating it if it was removed in the meantime, and only then exits.
  const here = process.cwd();
  mark(`PID ${process.pid}`);
  process.on('SIGTERM', () => {
    mark('TERM');
    setTimeout(() => {
      mkdirSync(here, { recursive: true });
      writeFileSync(join(here, 'late.txt'), 'written after SIGTERM\n');
      mark('WROTE');
      process.exit(0);
    }, 400);
  });
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAKE:term') || prompt.includes('FAKE:ignoreterm')) {
  // Report the pid, then wait to be told to stop. "ignoreterm" refuses SIGTERM, so only SIGKILL ends it.
  mark(`PID ${process.pid}`);
  process.on('SIGTERM', () => {
    mark('TERM');
    if (prompt.includes('FAKE:term')) process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAKE:sleep')) {
  setTimeout(() => {}, 60_000);
} else if (prompt.includes('FAKE:crash')) {
  process.stderr.write('segfault, sort of\n');
  process.exit(3);
} else if (prompt.includes('FAKE:garbage')) {
  process.stdout.write('this is not json');
} else if (prompt.includes('FAKE:iserror')) {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited', session_id: 's-err' }));
} else {
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `done: ${prompt.slice(0, 40)}`,
      session_id: `session-${process.pid}`,
      total_cost_usd: 0.0123,
    }),
  );
}

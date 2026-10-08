#!/usr/bin/env node
// A stand-in for the claude CLI. It records how it was called and prints canned JSON.
import { spawn } from 'node:child_process';
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

if (prompt.includes('FAKE:grandchild')) {
  // Like a Bash tool child: a grandchild that ignores SIGTERM. The leader exits on SIGTERM and leaves it behind.
  // The grandchild says "ready" only once its SIGTERM handler is in, and the leader marks nothing before that, so a
  // test that sees the PID mark knows both processes are set up and the GRANDCHILD line is already there.
  const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  g.stdout.once('data', () => {
    process.on('SIGTERM', () => process.exit(0));
    mark(`GRANDCHILD ${g.pid}`);
    mark(`PID ${process.pid}`);
  });
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAKE:linger') && args.includes('acceptEdits')) {
  // An edit stage that is slow to die: after SIGTERM it keeps going for a moment and then writes into its own
  // folder, recreating it if it was removed in the meantime, and only then exits.
  const here = process.cwd();
  process.on('SIGTERM', () => {
    mark('TERM');
    setTimeout(() => {
      mkdirSync(here, { recursive: true });
      writeFileSync(join(here, 'late.txt'), 'written after SIGTERM\n');
      mark('WROTE');
      process.exit(0);
    }, 400);
  });
  mark(`PID ${process.pid}`);
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAKE:term') || prompt.includes('FAKE:ignoreterm')) {
  // Report the pid, then wait to be told to stop. "ignoreterm" refuses SIGTERM, so only SIGKILL ends it.
  // The handler goes in before the PID mark: a test reads the mark as "ready to be stopped".
  process.on('SIGTERM', () => {
    mark('TERM');
    if (prompt.includes('FAKE:term')) process.exit(0);
  });
  mark(`PID ${process.pid}`);
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
  // A planning prompt must get a plan that ends with a SCOPE block, like the real thing.
  const scope = prompt.includes('You are planning') ? '\n\nSCOPE:\n- *.txt' : '';
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `done: ${prompt.slice(0, 40)}${scope}`,
      session_id: `session-${process.pid}`,
      total_cost_usd: 0.0123,
    }),
  );
}

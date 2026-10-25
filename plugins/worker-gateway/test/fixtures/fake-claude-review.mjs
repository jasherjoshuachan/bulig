#!/usr/bin/env node
// A stand-in for claude on the review stage of job 99507748 (a lodash-based chunk helper): a stream with one shell call that reads
// no file, then the review line that named both src/chunk.js (a repo file) and lodash/chunk.js (a package import specifier).
import { randomUUID } from 'node:crypto';

const text = '- `src/chunk.js` — delegates to `lodash/chunk.js`, matching the one-function-per-file export style of lodash.';
const lines = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status --short' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }] } },
  { type: 'result', is_error: false, result: text, session_id: randomUUID(), total_cost_usd: 0.01 },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

#!/usr/bin/env node
// A stand-in for claude that behaves well enough to run the whole dev pipeline.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
let result = 'ok';

if (prompt.includes('You are planning')) result = '1. Add src/multiply.js\n2. Add test/multiply.test.js\n\nSCOPE:\n- src/multiply.js\n- test/multiply.test.js';
else if (prompt.includes('You are checking a plan')) result = 'The plan is fine.';
else if (prompt.includes('You are building')) {
  mkdirSync('src', { recursive: true });
  writeFileSync('src/multiply.js', 'export const multiply = (a, b) => a * b;\n');
  result = 'Added src/multiply.js';
} else if (prompt.includes('You are the test stage')) result = 'ran npm test, 2 passed\nVERDICT: PASS';
else if (prompt.includes('You are an independent reviewer')) result = 'Reads correctly.\nVERDICT: PASS';
else if (prompt.includes('You are the docs stage')) result = 'Nothing needed updating.';

process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, session_id: randomUUID(), total_cost_usd: 0.01 }));

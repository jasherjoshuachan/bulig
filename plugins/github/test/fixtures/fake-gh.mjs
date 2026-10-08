#!/usr/bin/env node
// A stand-in for the gh CLI. State comes from the JSON file named by FAKE_GH_STATE.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
if (state.log) appendFileSync(state.log, JSON.stringify({ args, token: process.env.GH_TOKEN ?? null, cwd: process.cwd() }) + '\n');

const head = () => state.headRefOid ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const [group, sub] = args;

if (group === 'pr' && sub === 'create' && state.createExists) {
  console.error('a pull request for branch "x" into branch "main" already exists:');
  console.error('https://github.com/example/repo/pull/7');
  process.exit(1);
} else if (group === 'pr' && sub === 'create') {
  console.log('Creating pull request...');
  console.log('https://github.com/example/repo/pull/7');
} else if (group === 'pr' && sub === 'view') {
  const json = args[args.indexOf('--json') + 1] ?? '';
  const all = { number: 7, url: 'https://github.com/example/repo/pull/7', headRefOid: head(), baseRefName: 'main', state: state.prState ?? 'OPEN' };
  const out = {};
  for (const k of json.split(',')) out[k] = all[k];
  console.log(JSON.stringify(out));
} else if (group === 'pr' && sub === 'checks') {
  // Calls are counted in the state file, so a test can change what gh says as checks "finish".
  const call = state.checkCalls ?? 0;
  if (statePath) writeFileSync(statePath, JSON.stringify({ ...state, checkCalls: call + 1 }));
  if (call < (state.checksErrorFirst ?? 0)) {
    console.error('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
    process.exit(1);
  }
  // checksSequence: one answer per call after the errors; the last answer repeats.
  if (state.checksSequence) state.checks = state.checksSequence[Math.min(call - (state.checksErrorFirst ?? 0), state.checksSequence.length - 1)];
  if (state.checksGarbage) {
    console.error('something went wrong reading checks');
    process.exit(1);
  }
  if (state.checks === undefined) {
    console.error("no checks reported on the 'bulig' branch");
    process.exit(1);
  }
  console.log(JSON.stringify(state.checks));
  process.exit(state.checks.some((c) => c.bucket === 'fail') ? 1 : state.checks.some((c) => c.bucket === 'pending') ? 8 : 0);
} else if (group === 'pr' && sub === 'merge') {
  // A push that lands between the approval and the merge: the PR head is no longer the pinned one.
  const pinned = args[args.indexOf('--match-head-commit') + 1];
  if (state.mergeHead && args.includes('--match-head-commit') && pinned !== state.mergeHead) {
    console.error('Head branch was modified. Review and try the merge again.');
    process.exit(1);
  }
  // Merging flips the PR to MERGED, even when gh then fails to tidy up locally.
  if (statePath && (!state.mergeExit || state.mergeAnyway)) writeFileSync(statePath, JSON.stringify({ ...state, prState: 'MERGED' }));
  if (state.mergeExit) {
    console.error(state.mergeError ?? 'merge failed');
    process.exit(state.mergeExit);
  }
  console.log('merged');
} else {
  console.error(`fake gh: unhandled ${args.join(' ')}`);
  process.exit(2);
}

#!/usr/bin/env node
// A stand-in for the gh CLI. State comes from the JSON file named by FAKE_GH_STATE.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
if (state.log) appendFileSync(state.log, JSON.stringify({ args, token: process.env.GH_TOKEN ?? null, cwd: process.cwd() }) + '\n');

// Two jobs can run gh at the same moment. A write in place truncates the file first, so a gh that reads in that instant
// gets empty JSON and crashes, and the job's merge is refused or failed. Write a whole new file and rename it over the old one.
const save = (next) => {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, statePath);
};

const head = () => state.headRefOid ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const [group, sub] = args;

if (group === 'pr' && sub === 'create' && state.createExists) {
  console.error('a pull request for branch "x" into branch "main" already exists:');
  console.error('https://github.com/example/repo/pull/7');
  process.exit(1);
} else if (group === 'pr' && sub === 'create') {
  console.log('Creating pull request...');
  console.log('https://github.com/example/repo/pull/7');
} else if (group === 'pr' && sub === 'checks' && args.includes('--json')) {
  // gh 2.45 (Ubuntu 24.04) has no --json on `pr checks`. The plugin must not depend on it.
  console.error('unknown flag: --json');
  process.exit(1);
} else if (group === 'api' && /\/commits\/[^/]+\/status\?/.test(args.find((a) => a.startsWith('repos/')) ?? '')) {
  // The commit statuses (prow, Vercel and the like). statuses: raw REST entries; default none.
  // One line per page, as `gh api --paginate --jq '[.total_count, [.statuses[] | {...}]]'` prints it.
  const statuses = state.statuses ?? [];
  console.log(JSON.stringify([statuses.length, statuses]));
} else if (group === 'api' && /\/commits\/[^/]+\/check-runs\?/.test(args.find((a) => a.startsWith('repos/')) ?? '')) {
  // The checks read. Calls are counted in the state file, so a test can change what gh says as checks "finish".
  const call = state.checkCalls ?? 0;
  if (statePath) save({ ...state, checkCalls: call + 1 });
  // hangChecksFirst: the first N calls never answer. The pid is written down so a test can see the process die.
  if (call < (state.hangChecksFirst ?? 0)) {
    if (state.pidFile) appendFileSync(state.pidFile, `${process.pid}\n`);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  // checksDelayMs: answer slowly. ignoreTerm: keep going when asked to stop, as a gh stuck in a network call might.
  if (state.ignoreTerm) process.on('SIGTERM', () => {});
  if (state.checksDelayMs) await new Promise((r) => setTimeout(r, state.checksDelayMs));
  if (call < (state.checksErrorFirst ?? 0)) {
    console.error('HTTP 502: Bad Gateway (https://api.github.com/repos/example/repo/commits/x/check-runs)');
    process.exit(1);
  }
  // checksSequence: one answer per call after the errors; the last answer repeats.
  if (state.checksSequence) state.checks = state.checksSequence[Math.min(call - (state.checksErrorFirst ?? 0), state.checksSequence.length - 1)];
  if (state.checksGarbage) {
    console.error('something went wrong reading checks');
    process.exit(1);
  }
  // runs: raw REST check runs. Otherwise `checks` (in the bucket shape the tests read best) is written out as check
  // runs.
  const run = { pass: ['completed', 'success'], fail: ['completed', 'failure'], cancel: ['completed', 'cancelled'], skipping: ['completed', 'skipped'] };
  const runs =
    state.runs ??
    (state.checks ?? []).map((c) => {
      const [status, conclusion] = run[c.bucket] ?? ['in_progress', null];
      return { name: c.name, status, conclusion, details_url: c.link ?? null };
    });
  // One line per page of 100 (as `gh api --paginate --jq '[.total_count, [.check_runs[] | {...}]]'` prints it).
  // runsTotal: the total_count GitHub reports; dropPage: a page index that never arrives.
  const total = state.runsTotal ?? runs.length;
  const pages = [];
  for (let i = 0; i < Math.max(runs.length, 1); i += 100) pages.push(runs.slice(i, i + 100));
  pages.forEach((p, i) => {
    if (i !== state.dropPage) console.log(JSON.stringify([total, p]));
  });
} else if (group === 'pr' && sub === 'view') {
  const json = args[args.indexOf('--json') + 1] ?? '';
  const all = { number: 7, url: 'https://github.com/example/repo/pull/7', headRefOid: head(), baseRefName: 'main', state: state.prState ?? 'OPEN' };
  const out = {};
  for (const k of json.split(',')) out[k] = all[k];
  console.log(JSON.stringify(out));
} else if (group === 'pr' && sub === 'merge') {
  // A push that lands between the approval and the merge: the PR head is no longer the pinned one.
  const pinned = args[args.indexOf('--match-head-commit') + 1];
  if (state.mergeHead && args.includes('--match-head-commit') && pinned !== state.mergeHead) {
    console.error('Head branch was modified. Review and try the merge again.');
    process.exit(1);
  }
  // Merging flips the PR to MERGED, even when gh then fails to tidy up locally.
  if (statePath && (!state.mergeExit || state.mergeAnyway)) save({ ...state, prState: 'MERGED' });
  if (state.mergeExit) {
    console.error(state.mergeError ?? 'merge failed');
    process.exit(state.mergeExit);
  }
  console.log('merged');
} else {
  console.error(`fake gh: unhandled ${args.join(' ')}`);
  process.exit(2);
}

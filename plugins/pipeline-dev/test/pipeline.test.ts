import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Stage } from '@bulig/plugin-sdk';
import { SqliteStore, type Store, type StoreTx } from '@bulig/core';
import { decide, parseVerdict, renderPrompt } from '../src/index.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, newDb, openApproval, raw, stageNames, types, type Script, type Sent, settle } from './harness.ts';

// better-sqlite3 belongs to @bulig/core, not to this plugin: load it the way core does.
const Database = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('better-sqlite3') as typeof import('better-sqlite3');

const PASS = 'All good.\nVERDICT: PASS';
const FAIL = (why: string) => `${why}\nVERDICT: FAIL`;

function rig(script: Script = {}, gh: Parameters<typeof fakeGithub>[1] = {}, config = {}, db = newDb()) {
  const worker: Sent[] = [];
  const github: { type: string; payload: unknown }[] = [];
  const human = fakeHuman();
  const k = boot(db, [fakeWorker({ test: PASS, review: PASS, ...script }, worker), fakeGithub(github, gh), human.plugin], config);
  return { k, worker, github, human, db };
}

const jobOf = (k: ReturnType<typeof rig>['k'], title = 'Add multiply', body = 'Add src/multiply.js') => k.jobs.create({ repo: '/repo', title, body });

describe('happy path', () => {
  it('runs the whole graph, stopping at both approvals', async () => {
    const r = rig({ plan: 'PLAN TEXT', critique: 'CRITIQUE TEXT' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);

    // Plan and critique run, then the job waits for a human.
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ jobId: job.id, kind: 'plan' });
    expect(String((r.human.requests.at(-1)!.payload as { summary: string }).summary)).toContain('PLAN TEXT');
    expect(r.github.map((g) => g.type)).toEqual(['worktree.requested']);

    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'test', 'docs', 'review']);
    expect(r.github.map((g) => g.type)).toEqual(['worktree.requested', 'commit.requested', 'commit.requested', 'commit.requested', 'pr.requested']);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ kind: 'merge', url: 'https://example.test/pull/1', headSha: 'abc1234' });

    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect(r.github.map((g) => g.type)).toEqual([
      'worktree.requested', 'commit.requested', 'commit.requested', 'commit.requested', 'pr.requested', 'merge.requested',
    ]);
    expect(r.github.at(-1)!.payload).toMatchObject({ number: 1, headSha: 'abc1234', cwd: `/fake/wt/${job.id}` });
    expect((await r.k.jobs.get(job.id))!.status).toBe('done');

    expect((await stageNames(r.k, job.id))).toEqual([
      'worktree:passed', 'plan:passed', 'critique:passed', 'approve-plan:passed', 'build:passed',
      'test:passed', 'docs:passed', 'review:passed', 'pr:passed', 'approve-merge:passed', 'merge:passed',
    ]);
  });

  it('every commit request carries the stageId of the stage attempt that is running, so the github plugin can make one commit per attempt', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const commits = r.github.filter((g) => g.type === 'commit.requested').map((g) => g.payload as { stageId?: unknown });
    expect(commits).toHaveLength(3);
    for (const c of commits) expect(typeof c.stageId).toBe('string');
    // the id is the one the worker was asked to run, and the one the stage row has
    const edits = (await r.k.jobs.stages(job.id)).filter((s) => ['build', 'test', 'docs'].includes(s.name));
    expect(commits.map((c) => c.stageId)).toEqual(edits.map((s) => s.id));
    expect(commits.map((c) => c.stageId)).toEqual(r.worker.filter((w) => ['build', 'test', 'docs'].includes(w.stage)).map((w) => w.stageId));
    expect(new Set(commits.map((c) => c.stageId)).size).toBe(3);
  });

  it('uses the strong model for plan, critique and review and the standard one for the rest', async () => {
    const r = rig({}, {}, { models: { strong: 'big', standard: 'mid' } });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const by = Object.fromEntries(r.worker.map((s) => [s.stage, [s.model, s.mode]]));
    expect(by).toEqual({
      plan: ['big', 'readonly'],
      critique: ['big', 'readonly'],
      build: ['mid', 'edit'],
      test: ['mid', 'edit'],
      review: ['big', 'readonly'],
      docs: ['mid', 'edit'],
    });
  });

  it('defaults to opus and sonnet', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.find((s) => s.stage === 'plan')!.model).toBe('opus');
    expect(r.worker.find((s) => s.stage === 'build')!.model).toBe('sonnet');
  });

  it('runs every stage in the worktree and feeds the plan forward', async () => {
    const r = rig({ plan: 'PLAN-MARKER', critique: 'CRIT-MARKER' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k, 'Add multiply', 'ISSUE-MARKER');
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.every((s) => s.cwd === `/fake/wt/${job.id}`)).toBe(true);
    const build = r.worker.find((s) => s.stage === 'build')!.prompt;
    expect(build).toContain('PLAN-MARKER');
    expect(build).toContain('CRIT-MARKER');
    expect(build).toContain('ISSUE-MARKER');
    expect(r.worker.find((s) => s.stage === 'plan')!.prompt).toContain('ISSUE-MARKER');
  });

  it('the review prompt says independent, never saw the build, and asks for a verdict line', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const review = r.worker.find((s) => s.stage === 'review')!.prompt;
    expect(review).toMatch(/independent reviewer/);
    expect(review).toMatch(/never saw the session/);
    expect(review).toMatch(/VERDICT: PASS/);
    expect(review).toMatch(/VERDICT: FAIL/);
  });

  it('the build and the review run in different sessions, and the stage table says so', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const session = async (name: string) => ((await r.k.jobs.stages(job.id)).find((s) => s.name === name)!.output as { sessionId: string }).sessionId;
    expect(await session('build')).toBeTruthy();
    expect(await session('review')).toBeTruthy();
    expect(await session('review')).not.toBe(session('build'));
  });

  it('the PR carries the title, the task, the plan and the review', async () => {
    const r = rig({ plan: 'PLAN-MARKER', review: 'Looks right.\nVERDICT: PASS' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k, 'Add multiply', 'ISSUE-MARKER');
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const pr = r.github.find((g) => g.type === 'pr.requested')!.payload as { title: string; body: string; cwd: string; branch: string };
    expect(pr.title).toBe('Add multiply');
    expect(pr.body).toContain('ISSUE-MARKER');
    expect(pr.body).toContain('PLAN-MARKER');
    expect(pr.body).toContain('Looks right.');
    expect(pr.branch).toMatch(/^bulig\/add-multiply-/);
  });

  it('nothing past the plan runs until the plan is approved', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    await jobOf(r.k);
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).not.toContain('build');
  });

  it('an approval for the wrong kind does nothing', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).not.toContain('build');
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('a second grant for the same approval is ignored', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(1);
  });
});

describe('loops and failures', () => {
  it('a review FAIL sends the text back to build once, then the job continues', async () => {
    const r = rig({ review: [FAIL('multiply ignores negative numbers'), PASS] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'test', 'docs', 'review', 'build', 'test', 'docs', 'review']);
    const secondBuild = r.worker.filter((s) => s.stage === 'build')[1]!.prompt;
    expect(secondBuild).toContain('multiply ignores negative numbers');
    expect(secondBuild).toMatch(/retry/);
    expect(r.worker.filter((s) => s.stage === 'build')[0]!.prompt).not.toMatch(/retry/);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect((await stageNames(r.k, job.id))).toContain('review:failed');
    expect((await stageNames(r.k, job.id)).filter((s) => s.startsWith('build'))).toEqual(['build:passed', 'build:passed']);
  });

  it('a test FAIL loops back to build too, and skips review for that round', async () => {
    const r = rig({ test: [FAIL('1 failing: sum'), PASS] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'test', 'build', 'test', 'docs', 'review']);
    expect(r.worker.filter((s) => s.stage === 'build')[1]!.prompt).toContain('1 failing: sum');
  });

  it('fails the job after the second build also fails review', async () => {
    const r = rig({ review: FAIL('still wrong') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(2);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.github.map((g) => g.type)).not.toContain('pr.requested');
    const failed = (await r.k.history(job.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failed.payload as { reason: string }).reason).toMatch(/review still failing after 2 build attempts/);
  });

  it('respects maxBuildAttempts from config', async () => {
    const r = rig({ test: FAIL('nope') }, {}, { maxBuildAttempts: 3 });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(3);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
  });

  it('a review with no verdict line counts as a fail', async () => {
    const r = rig({ review: ['Seems fine to me.', PASS] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(2);
    expect(r.worker.filter((s) => s.stage === 'build')[1]!.prompt).toMatch(/did not end with a VERDICT line/);
  });

  it('a worker error fails the job at once, with no retry', async () => {
    const r = rig({ build: { fail: 'claude exited with code 1' } as never });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(1);
    expect((await stageNames(r.k, job.id))).toContain('build:failed');
    const failed = (await r.k.history(job.id)).find((e) => e.type === 'pipeline.failed')!;
    expect((failed.payload as { reason: string }).reason).toMatch(/build failed: claude exited/);
  });

  it('a failed worktree fails the job', async () => {
    const r = rig({}, { failWorktree: 'branch exists' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.worker).toHaveLength(0);
  });

  it('a failed PR fails the job', async () => {
    const r = rig({}, { failPr: 'push rejected' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
  });

  it('denying cancels the job and nothing else runs', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.deny(job.id);
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('cancelled');
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect((await stageNames(r.k, job.id))).toContain('approve-plan:failed');
  });

  it('a refused merge asks again, and the second approval can merge', async () => {
    const r = rig({}, { refuseMerge: ['checks pending: ci'] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(String((r.human.requests.at(-1)!.payload as { summary: string }).summary)).toMatch(/refused/);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('done');
    expect(r.github.filter((g) => g.type === 'merge.requested')).toHaveLength(2);
  });
});

describe('nothing changes the code after the independent review', () => {
  it('runs docs before review, commits after every edit stage, and review is the last stage before the PR', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const names = (await stageNames(r.k, job.id)).map((s) => s.split(':')[0]);
    expect(names.slice(names.indexOf('build'))).toEqual(['build', 'test', 'docs', 'review', 'pr', 'approve-merge']);
    // After the review verdict the only thing that happens is the PR request. No worker stage runs again.
    const lastReview = r.worker.map((s) => s.stage).lastIndexOf('review');
    expect(r.worker.slice(lastReview + 1)).toHaveLength(0);
    expect(r.github.map((g) => g.type).slice(-2)).toEqual(['commit.requested', 'pr.requested']);
    expect(r.github.filter((g) => g.type === 'commit.requested')).toHaveLength(3);
  });

  it('the reviewer is told which commit it is judging, and the PR is opened only for that commit', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const review = r.worker.find((s) => s.stage === 'review')!;
    // build, test and docs each commit; review judges the last one, which is also the only one the PR may use.
    expect(review.prompt).toContain('c0ffee3');
    expect(review.prompt).toContain('ba5e000');
    const pr = r.github.find((g) => g.type === 'pr.requested')!;
    expect(pr.payload).toMatchObject({ expectSha: 'c0ffee3' });
  });

  it('after a failed review the rebuild is committed again and the PR expects the new commit', async () => {
    const r = rig({ review: [FAIL('missing a case'), PASS] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const reviews = r.worker.filter((s) => s.stage === 'review');
    expect(reviews[0]!.prompt).toContain('c0ffee3');
    expect(reviews[1]!.prompt).toContain('c0ffee6');
    expect(r.github.filter((g) => g.type === 'commit.requested')).toHaveLength(6);
    expect(r.github.find((g) => g.type === 'pr.requested')!.payload).toMatchObject({ expectSha: 'c0ffee6' });
  });

  it('a failed commit fails the job before any later stage', async () => {
    const r = rig({}, { failCommit: 'nothing to commit, hook rejected' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build']);
    expect(r.github.map((g) => g.type)).not.toContain('pr.requested');
    expect((await stageNames(r.k, job.id)).at(-1)).toBe('build:failed');
  });

  it('a crash while an edit stage is being committed reruns that stage on resume', async () => {
    const db = newDb();
    const first = rig({}, { hangCommit: true }, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    expect((await first.k.jobs.stages(job.id)).at(-1)).toMatchObject({ name: 'build', status: 'running' });
    expect(first.worker.map((w) => w.stage)).toEqual(['plan', 'critique', 'build']);
    await first.k.stop();

    const second = rig({}, {}, {}, db);
    await second.k.start();
    await settle(second.k);
    expect(second.worker.map((w) => w.stage)).toEqual(['build', 'test', 'docs', 'review']);
    expect(second.github.map((g) => g.type)).toEqual([
      'worktree.reset.requested', 'commit.requested', 'commit.requested', 'commit.requested', 'pr.requested',
    ]);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });
});

describe('worktrees are removed when a job ends without merging', () => {
  const cleanups = (r: ReturnType<typeof rig>) => r.github.filter((g) => g.type === 'worktree.cleanup.requested');

  it('a failed job asks for its worktree and local branch to be removed', async () => {
    const r = rig({ review: FAIL('still wrong') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    const worktree = r.github.find((g) => g.type === 'worktree.requested')!.payload as { branch: string };
    expect(cleanups(r)).toEqual([{ type: 'worktree.cleanup.requested', payload: { repoPath: '/repo', branch: worktree.branch } }]);
  });

  it('a denied job does the same', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.deny(job.id);
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('cancelled');
    expect(cleanups(r)).toHaveLength(1);
  });

  it('a cancelled job does the same, whoever cancelled it', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    (await r.k.jobs.setStatus(job.id, 'cancelled'));
    await settle(r.k);
    expect(cleanups(r)).toHaveLength(1);
    expect(cleanups(r)[0]!.payload).toMatchObject({ repoPath: '/repo' });
  });

  it('a job whose merge can never go through is cleaned up too', async () => {
    const r = rig({}, { failMerge: 'PR #1 was closed without being merged' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(cleanups(r)).toHaveLength(1);
  });

  it('keepFailedWorktrees: true leaves them for a look', async () => {
    const r = rig({ review: FAIL('still wrong') }, {}, { keepFailedWorktrees: true });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(cleanups(r)).toHaveLength(0);
    const second = rig({}, {}, { keepFailedWorktrees: true });
    await second.k.start();
    await settle(second.k);
    const j2 = await jobOf(second.k);
    await settle(second.k);
    second.human.deny(j2.id);
    await settle(second.k);
    expect(cleanups(second)).toHaveLength(0);
  });

  it('a merged job is not cleaned up here (the merge already removed its worktree), and a job with no worktree has nothing to remove', async () => {
    const done = rig();
    await done.k.start();
    await settle(done.k);
    const job = await jobOf(done.k);
    await settle(done.k);
    done.human.grant(job.id, 'plan');
    await settle(done.k);
    done.human.grant(job.id, 'merge');
    await settle(done.k);
    expect((await done.k.jobs.get(job.id))!.status).toBe('done');
    expect(cleanups(done)).toHaveLength(0);

    const none = rig({}, { failWorktree: 'branch already exists' });
    await none.k.start();
    await settle(none.k);
    const j = await jobOf(none.k);
    await settle(none.k);
    expect((await none.k.jobs.get(j.id))!.status).toBe('failed');
    expect(cleanups(none)).toHaveLength(0);
  });
});

describe('a merge that can never go through', () => {
  it('fails the job with the reason and does not ask for approval again', async () => {
    const r = rig({}, { failMerge: 'PR #1 was closed without being merged' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const asked = r.human.requests.length;
    r.human.grant(job.id, 'merge');
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.github.filter((g) => g.type === 'merge.requested')).toHaveLength(1);
    expect(r.human.requests).toHaveLength(asked);
    expect((await stageNames(r.k, job.id)).at(-1)).toBe('merge:failed');
    const failure = (await r.k.history(job.id)).find((e) => e.type === 'pipeline.failed');
    expect(String((failure!.payload as { reason: string }).reason)).toMatch(/closed without being merged/);
  });

  it('decide() ends the job on a hard merge failure instead of asking again', () => {
    const at = (name: string, status: Stage['status'], output: unknown = null, n: number): Stage => ({
      id: `${n}`, jobId: 'j', name, status, attempt: 1, startedAt: '', endedAt: null, output,
    });
    const stages: Stage[] = [
      at('worktree', 'passed', { cwd: '/w', branch: 'b' }, 1), at('plan', 'passed', { result: 'p' }, 2), at('critique', 'passed', { result: 'c' }, 3),
      at('approve-plan', 'passed', null, 4), at('build', 'passed', { result: 'b' }, 5), at('test', 'passed', { verdict: 'PASS' }, 6),
      at('docs', 'passed', { result: 'd' }, 7), at('commit', 'passed', { sha: 'c1', base: 'b0' }, 7.5), at('review', 'passed', { verdict: 'PASS' }, 8),
      at('pr', 'passed', { number: 1, headSha: 'abc' }, 9), at('approve-merge', 'passed', null, 10),
    ];
    const refused = [...stages, at('merge', 'failed', { refused: 'checks pending: ci' }, 11)];
    expect(decide({ status: 'running' }, refused, 2)).toMatchObject({ kind: 'approve', which: 'merge', renewed: true });
    const hard = [...stages, at('merge', 'failed', { error: 'PR #1 was closed without being merged' }, 11)];
    expect(decide({ status: 'running' }, hard, 2)).toEqual({ kind: 'fail', reason: 'merge failed: PR #1 was closed without being merged' });
  });
});

describe('resume after a restart', () => {
  it('a crash after the merge went out resumes into one more merge request, not a new approval', async () => {
    const db = newDb();
    const first = rig({}, { hangMerge: true }, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    first.human.grant(job.id, 'merge');
    await settle(first.k);
    expect((await first.k.jobs.stages(job.id)).at(-1)).toMatchObject({ name: 'merge', status: 'running' });
    await first.k.stop();

    // The new process finds the PR already merged at the approved commit, so github answers with pr.merged.
    const second = rig({}, {}, {}, db);
    await second.k.start();
    await settle(second.k);
    expect(second.github.map((g) => g.type)).toEqual(['merge.requested']);
    expect(second.human.requests).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('done');
    expect((await stageNames(second.k, job.id)).filter((s) => s.startsWith('approve-merge'))).toEqual(['approve-merge:passed']);
  });

  it('a stage this kernel is already running is not closed and run a second time when kernel.started comes (a live claim is left alone)', async () => {
    const r = rig({ build: () => 'hang' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const running = (await r.k.jobs.stages(job.id)).filter((s) => s.name === 'build');
    expect(running.map((s) => s.status)).toEqual(['running']);
    // Resume looks at a stage that began after this kernel started. That is a live claim, not the leftovers of a dead kernel.
    await r.k.bus.emit({ type: 'kernel.started', source: 'kernel', payload: { plugins: [] } });
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(1);
    expect((await r.k.jobs.stages(job.id)).filter((s) => s.name === 'build').map((s) => `${s.attempt}:${s.status}`)).toEqual(['1:running']);
    expect((await r.k.jobs.get(job.id))!.status).not.toBe('failed');
  });

  it('a start that finds its stage already claimed (a rival got in between the read and the write) is a duplicate, not a failure: the job carries on', async () => {
    // A rival kernel opens plan after this one has read that the job is ready for it and before its own startStage lands.
    const inner = new SqliteStore(newDb());
    let armed: string | undefined;
    let rivalled = false;
    const store = Object.create(inner) as Store;
    Object.assign(store, {
      close: inner.close.bind(inner),
      abort: inner.abort?.bind(inner),
      schemaVersion: inner.schemaVersion.bind(inner),
      acquireLease: inner.acquireLease.bind(inner),
      renewLease: inner.renewLease.bind(inner),
      releaseLease: inner.releaseLease.bind(inner),
      transaction: async <T,>(fn: (tx: StoreTx) => Promise<T>) => {
        if (armed && !rivalled) {
          rivalled = true;
          const jobId = armed;
          // The rival holds the same generation (a stalled twin of this kernel), so its claim is live, not a leftover to take over.
          await inner.transaction(async (tx) => {
            await tx.assertLease('kernel-under-test', 1);
            await tx.startStage(jobId, 'plan');
          });
        }
        return inner.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop) {
                if (prop === 'listStages') {
                  return async (jobId: string) => {
                    const stages = await target.listStages(jobId);
                    if (stages.some((s) => s.name === 'worktree' && s.status === 'passed') && !stages.some((s) => s.name === 'plan')) armed = jobId;
                    return stages;
                  };
                }
                const v = (target as unknown as Record<string | symbol, unknown>)[prop];
                return typeof v === 'function' ? v.bind(target) : v;
              },
            }),
          ),
        );
      },
    });
    const warnings: string[] = [];
    const worker: Sent[] = [];
    const k = boot('unused', [fakeWorker({}, worker), fakeGithub([]), fakeHuman().plugin], {}, { store, leaseHolder: 'kernel-under-test', logger: { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} } });
    await k.start();
    await settle(k);
    const job = await jobOf(k);
    await settle(k);
    expect(rivalled).toBe(true);
    expect(warnings.join('\n')).toMatch(/already claimed/);
    expect(worker).toEqual([]); // nothing was asked for twice
    expect((await k.jobs.get(job.id))!.status).toBe('running'); // and the job was not failed for it
    expect((await k.jobs.stages(job.id)).map((s) => `${s.name}:${s.status}`)).toEqual(['worktree:passed', 'plan:running']);
  });

  it('a new process continues from the plan approval', async () => {
    const db = newDb();
    const first = rig({}, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    expect((await first.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    await first.k.stop();

    const second = rig({}, {}, {}, db);
    await second.k.start();
    await settle(second.k);
    // Starting up alone must not run anything: the job is waiting on a person.
    expect(second.worker).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    // The card was sent by the first process; the person answers it, so the grant names its stage.
    second.human.grant(job.id, 'plan', await openApproval(second.k, job.id));
    await settle(second.k);
    expect(second.worker.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
    expect(second.worker[0]!.cwd).toBe(`/fake/wt/${job.id}`);
    expect(second.worker[0]!.prompt).toContain('Add src/multiply.js');
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    await second.k.stop();

    const third = rig({}, {}, {}, db);
    await third.k.start();
    await settle(third.k);
    expect(third.github).toHaveLength(0);
    third.human.grant(job.id, 'merge', await openApproval(third.k, job.id));
    await settle(third.k);
    expect(third.github.map((g) => g.type)).toEqual(['merge.requested']);
    expect(third.github[0]!.payload).toMatchObject({ number: 1, headSha: 'abc1234' });
    expect((await third.k.jobs.get(job.id))!.status).toBe('done');
  });

  it('a stage cut off by a crash is marked interrupted and runs again', async () => {
    const db = newDb();
    const first = rig({ build: () => 'hang' }, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    expect((await first.k.jobs.stages(job.id)).at(-1)).toMatchObject({ name: 'build', status: 'running' });
    await first.k.stop();

    const second = rig({}, {}, {}, db);
    await second.k.start();
    await settle(second.k);
    expect(second.worker.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
    const stages = (await second.k.jobs.stages(job.id));
    expect(stages.filter((s) => s.name === 'build').map((s) => s.status)).toEqual(['failed', 'passed']);
    expect((stages.find((s) => s.name === 'build')!.output as { interrupted: boolean }).interrupted).toBe(true);
    // The cut-off attempt does not use up one of the two build attempts.
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('marks the cut-off stage failed with reason interrupted, and resets the worktree before it runs again', async () => {
    const db = newDb();
    const first = rig({ build: () => 'hang' }, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    await first.k.stop();

    const second = rig({}, {}, {}, db);
    await second.k.start();
    await settle(second.k);
    const stages = (await second.k.jobs.stages(job.id));
    const cut = stages.find((s) => s.name === 'build' && s.status === 'failed')!;
    expect(cut.output).toMatchObject({ interrupted: true, reason: 'interrupted' });
    expect(second.github[0]).toEqual({ type: 'worktree.reset.requested', payload: { cwd: `/fake/wt/${job.id}` } });
    // History order: the reset finished before the second build began.
    const names = (await stageNames(second.k, job.id));
    expect(names.slice(names.indexOf('build:failed'))).toEqual([
      'build:failed', 'reset:passed', 'build:passed', 'test:passed', 'docs:passed', 'review:passed', 'pr:passed', 'approve-merge:running',
    ]);
  });

  it('does not reset when the cut-off stage only reads (plan, critique, review)', async () => {
    for (const stage of ['plan', 'critique', 'review']) {
      const db = newDb();
      const first = rig({ [stage]: () => 'hang' }, {}, {}, db);
      await first.k.start();
      await settle(first.k);
      const job = await jobOf(first.k);
      await settle(first.k);
      if (stage !== 'plan') first.human.grant(job.id, 'plan');
      if (stage === 'critique') first.human.grant(job.id, 'plan');
      await first.k.stop();
      const second = rig({}, {}, {}, db);
      await second.k.start();
      await settle(second.k);
      expect(second.github.map((g) => g.type), stage).not.toContain('worktree.reset.requested');
    }
  });

  it('fails the job when the reset fails, instead of running on a dirty worktree', async () => {
    const db = newDb();
    const first = rig({ test: () => 'hang' }, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    await first.k.stop();

    const second = rig({}, { failReset: 'the job worktree is gone' }, {}, db);
    await second.k.start();
    await settle(second.k);
    expect((await second.k.jobs.get(job.id))!.status).toBe('failed');
    expect(second.worker).toHaveLength(0);
    const failure = (await second.k.history(job.id)).filter((e) => e.type === 'pipeline.failed').at(-1)!;
    expect(String((failure.payload as { reason: string }).reason)).toMatch(/could not reset the worktree.*worktree is gone/);
  });

  it('a crash in the middle of the reset itself triggers another reset next time', async () => {
    const db = newDb();
    const first = rig({ docs: () => 'hang' }, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const job = await jobOf(first.k);
    await settle(first.k);
    first.human.grant(job.id, 'plan');
    await settle(first.k);
    await first.k.stop();

    const second = rig({}, { hangReset: true }, {}, db);
    await second.k.start();
    await settle(second.k);
    expect(second.github.map((g) => g.type)).toEqual(['worktree.reset.requested']);
    expect(second.worker).toHaveLength(0);
    await second.k.stop();

    const third = rig({}, {}, {}, db);
    await third.k.start();
    await settle(third.k);
    expect(third.github[0]!.type).toBe('worktree.reset.requested');
    expect(third.worker.map((w) => w.stage)).toEqual(['docs', 'review']);
    expect((await third.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('resume can be turned off or limited to chosen jobs', async () => {
    const db = newDb();
    const first = rig({ plan: () => 'hang' }, {}, {}, db);
    await first.k.start();
    await settle(first.k);
    const a = await jobOf(first.k, 'a');
    await settle(first.k);
    const b = await jobOf(first.k, 'b');
    await settle(first.k);
    await first.k.stop();

    const off = rig({}, {}, { resume: false }, db);
    await off.k.start();
    await settle(off.k);
    expect(off.worker).toHaveLength(0);
    await off.k.stop();

    const only = rig({}, {}, { resume: [b.id] }, db);
    await only.k.start();
    await settle(only.k);
    expect(only.worker.map((s) => s.jobId)).toEqual([b.id, b.id]);
    expect((await only.k.jobs.stages(a.id)).at(-1)!.status).toBe('running');
  });
});

describe('decide', () => {
  const st = (name: string, status: Stage['status'], output: unknown = null): Stage => ({
    id: `${name}-${Math.random()}`, jobId: 'j', name, status, attempt: 1, startedAt: '', endedAt: null, output,
  });
  const run = { status: 'running' as const };

  it('is a pure read of the stage list', () => {
    expect(decide(run, [], 2)).toEqual({ kind: 'worktree' });
    expect(decide(run, [st('worktree', 'passed', { cwd: '/x' })], 2)).toEqual({ kind: 'stage', name: 'plan' });
    expect(decide(run, [st('worktree', 'running')], 2)).toEqual({ kind: 'wait' });
  });

  it('leaves finished jobs alone', () => {
    expect(decide({ status: 'failed' }, [], 2)).toEqual({ kind: 'wait' });
    expect(decide({ status: 'cancelled' }, [], 2)).toEqual({ kind: 'wait' });
  });

  it('ignores interrupted stages', () => {
    const stages = [st('worktree', 'passed'), st('plan', 'failed', { interrupted: true })];
    expect(decide(run, stages, 2)).toEqual({ kind: 'stage', name: 'plan' });
  });
});

describe('parseVerdict and prompts', () => {
  it('takes the last verdict line and tolerates markdown', () => {
    expect(parseVerdict('x\nVERDICT: PASS')).toBe('PASS');
    expect(parseVerdict('VERDICT: PASS\nthen I changed my mind\nVERDICT: FAIL')).toBe('FAIL');
    expect(parseVerdict('**VERDICT: PASS**')).toBe('PASS');
    expect(parseVerdict('verdict: fail')).toBe('FAIL');
    expect(parseVerdict('no verdict here')).toBeUndefined();
    expect(parseVerdict('it was a VERDICT: PASS in the middle of a line')).toBeUndefined();
  });

  it('fills slots and leaves no braces behind', () => {
    for (const name of ['plan', 'critique', 'build', 'test', 'review', 'docs']) {
      const out = renderPrompt(name, { title: 'T', issue: 'I', plan: 'P', critique: 'C', feedback: '' });
      expect(out).not.toMatch(/\{\{/);
      expect(out).toContain('T');
    }
  });

  it('keeps prompts free of marketing words', () => {
    for (const name of ['plan', 'critique', 'build', 'test', 'review', 'docs']) {
      expect(renderPrompt(name, {})).not.toMatch(/—|leverage|seamless|robust|comprehensive|ensure/i);
    }
  });
});

describe('scope guard: the plan declares its scope', () => {
  const PLAN_WITH = (lines: string) => raw(`The plan.\n\nSCOPE:\n${lines}\n`);
  const planPrompts = (r: ReturnType<typeof rig>) => r.worker.filter((s) => s.stage === 'plan').map((s) => s.prompt);
  const commits = (r: ReturnType<typeof rig>) => r.github.filter((g) => g.type === 'commit.requested').map((g) => g.payload as Record<string, unknown>);
  const failedReason = async (r: ReturnType<typeof rig>, id: string) =>
    ((await r.k.history(id)).find((e) => e.type === 'pipeline.failed')!.payload as { reason: string }).reason;

  it('stores the scope with the plan stage and puts it on the plan approval', async () => {
    const r = rig({ plan: PLAN_WITH('- README.md\n- src/lib/*.ts') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ kind: 'plan', scope: ['README.md', 'src/lib/*.ts'] });
    const plan = (await r.k.jobs.stages(job.id)).find((s) => s.name === 'plan')!;
    expect((plan.output as { scope: string[] }).scope).toEqual(['README.md', 'src/lib/*.ts']);
  });

  it('every commit request carries the approved scope and the settings', async () => {
    const r = rig({ plan: PLAN_WITH('- README.md') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const all = commits(r);
    expect(all).toHaveLength(3);
    for (const c of all) expect(c).toMatchObject({ scope: ['README.md'], scopeMode: 'enforce', scopeAllow: [], allowBroadScope: false });
  });

  it('forwards scopeAlwaysAllow, scopeMode and allowBroadScope from the config', async () => {
    const r = rig({ plan: PLAN_WITH('- README.md') }, {}, { scopeAlwaysAllow: ['test-results/.last-run.json'], scopeMode: 'warn', allowBroadScope: true });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(commits(r)[0]).toMatchObject({ scopeAllow: ['test-results/.last-run.json'], scopeMode: 'warn', allowBroadScope: true });
  });

  it('tells the build, test and docs stages which files they may change', async () => {
    const r = rig({ plan: PLAN_WITH('- README.md\n- src/lib/*.ts') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    for (const stage of ['build', 'test', 'docs']) {
      const prompt = r.worker.find((s) => s.stage === stage)!.prompt;
      expect(prompt, stage).toContain('- README.md');
      expect(prompt, stage).toContain('- src/lib/*.ts');
    }
  });

  it('a plan with no SCOPE block is asked for again, once, with a clear instruction', async () => {
    const r = rig({ plan: [raw('A plan with no scope.'), PLAN_WITH('- README.md')] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'plan', 'critique']);
    const [first, second] = planPrompts(r);
    expect(first).not.toMatch(/retry/);
    expect(second).toMatch(/retry/);
    expect(second).toMatch(/no SCOPE/i);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ scope: ['README.md'] });
    expect((await stageNames(r.k, job.id)).filter((n) => n.startsWith('plan'))).toEqual(['plan:failed', 'plan:passed']);
  });

  it('fails the job when the second plan has no SCOPE block either, and never builds', async () => {
    const r = rig({ plan: raw('Still no scope.') });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'plan']);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(await failedReason(r, job.id)).toMatch(/SCOPE/);
    expect(await failedReason(r, job.id)).toMatch(/2 tries|twice|2 attempts/);
    expect(r.human.requests).toHaveLength(0);
    expect(r.worker.map((s) => s.stage)).not.toContain('build');
  });

  it('a too-broad scope is rejected and the retry says which line', async () => {
    const r = rig({ plan: [PLAN_WITH('- README.md\n- **'), PLAN_WITH('- README.md')] });
    await r.k.start();
    await settle(r.k);
    await jobOf(r.k);
    await settle(r.k);
    expect(planPrompts(r)[1]).toMatch(/broad/);
    expect(planPrompts(r)[1]).toContain('**');
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ scope: ['README.md'] });
  });

  it('allowBroadScope lets a broad scope stand', async () => {
    const r = rig({ plan: PLAN_WITH('- **') }, {}, { allowBroadScope: true });
    await r.k.start();
    await settle(r.k);
    await jobOf(r.k);
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'plan')).toHaveLength(1);
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ scope: ['**'] });
  });

  it('an absolute path or .. in the scope is rejected, and the retry names it', async () => {
    const r = rig({ plan: [PLAN_WITH('- /etc/passwd'), PLAN_WITH('- ../outside.txt'), PLAN_WITH('- README.md')] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    // Two tries only: the second one is also bad, so the job fails.
    expect(planPrompts(r)[1]).toContain('/etc/passwd');
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(await failedReason(r, job.id)).toContain('outside.txt');
  });

  it('a scope with more than 100 entries is rejected at plan time', async () => {
    const lines = (n: number) => PLAN_WITH(Array.from({ length: n }, (_, i) => `- src/f${i}.ts`).join('\n'));
    const r = rig({ plan: lines(101) });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'plan']);
    expect(await failedReason(r, job.id)).toMatch(/too many SCOPE lines/);
    const ok = rig({ plan: lines(100) });
    await ok.k.start();
    await settle(ok.k);
    await jobOf(ok.k);
    await settle(ok.k);
    expect(ok.human.requests.at(-1)!.payload).toMatchObject({ kind: 'plan' });
  });

  it('a worker error in the plan stage still fails at once, with no scope retry', async () => {
    const r = rig({ plan: { fail: 'claude exited with code 1' } as never });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'plan')).toHaveLength(1);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
  });

  it('a job whose approved plan has no recorded scope (an older job) fails instead of building', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    const plan = (await r.k.jobs.stages(job.id)).find((s) => s.name === 'plan')!;
    // An older job's plan was written before scopes existed. Write it that way into the file, under the kernel: the store itself
    // (rightly) refuses to finish a stage twice, so the kernel's API cannot make an old record.
    const file = new Database(r.db);
    file.prepare('UPDATE stages SET output = ? WHERE id = ?').run(JSON.stringify({ result: 'An old plan with no scope recorded' }), plan.id);
    file.close();
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique']);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    expect(await failedReason(r, job.id)).toMatch(/no recorded SCOPE/);
  });

  it('the plan prompt asks for the SCOPE block and the critique prompt checks it', () => {
    const plan = renderPrompt('plan', { title: 't', issue: 'i', feedback: '' });
    expect(plan).toContain('SCOPE:');
    expect(plan).toMatch(/test files/i);
    const critique = renderPrompt('critique', { title: 't', issue: 'i', plan: 'p' });
    expect(critique).toContain('SCOPE');
    expect(critique).toMatch(/too broad|tight/i);
  });
});

describe('scope guard: the commit step refuses files outside the scope', () => {
  const reasonOf = async (r: ReturnType<typeof rig>, id: string) =>
    (await r.k.history(id)).find((e) => e.type === 'pipeline.failed')!.payload as { reason: string; outOfScope?: string[] };
  const JUNK = 'test-results/.last-run.json';

  it('feeds the files back to the build stage and the job passes on the second attempt', async () => {
    const r = rig({}, { outOfScope: [[JUNK]] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'build', 'test', 'docs', 'review']);
    const [first, second] = r.worker.filter((s) => s.stage === 'build');
    expect(first!.prompt).not.toContain(JUNK);
    expect(second!.prompt).toContain(JUNK);
    expect(second!.prompt).toMatch(/outside the approved scope/);
    expect(second!.prompt).toMatch(/remove them or revert them/);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.human.requests.at(-1)!.payload).toMatchObject({ kind: 'merge' });
    expect((await stageNames(r.k, job.id)).filter((n) => n.startsWith('build'))).toEqual(['build:failed', 'build:passed']);
  });

  it('the incident: junk written by the test stage sends the job back to build, then it passes', async () => {
    const r = rig({}, { outOfScope: [undefined, [JUNK]] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.map((s) => s.stage)).toEqual(['plan', 'critique', 'build', 'test', 'build', 'test', 'docs', 'review']);
    expect(r.worker.filter((s) => s.stage === 'build')[1]!.prompt).toContain(JUNK);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(r.github.map((g) => g.type)).toContain('pr.requested');
  });

  it('files left by the docs stage are handled the same way', async () => {
    const r = rig({}, { outOfScope: [undefined, undefined, ['notes.tmp']] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')[1]!.prompt).toContain('notes.tmp');
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('fails the job with the file list when the retry budget runs out', async () => {
    const r = rig({}, { outOfScope: [[JUNK], [JUNK, 'other.tmp']] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(2);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
    const failed = await reasonOf(r, job.id);
    expect(failed.reason).toMatch(/outside the approved scope/);
    expect(failed.reason).toMatch(/2 build attempts/);
    expect(failed.reason).toContain(JUNK);
    expect(failed.reason).toContain('other.tmp');
    expect(failed.outOfScope).toEqual([JUNK, 'other.tmp']);
    expect(r.github.map((g) => g.type)).not.toContain('pr.requested');
  });

  it('respects maxBuildAttempts for scope failures too', async () => {
    const r = rig({}, { outOfScope: [[JUNK], [JUNK], undefined] }, { maxBuildAttempts: 3 });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(3);
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('a long list is cut in the failure reason but kept whole in the payload', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `junk/f${i}.tmp`);
    const r = rig({}, { outOfScope: [many, many] });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const failed = await reasonOf(r, job.id);
    expect(failed.reason).toContain('junk/f0.tmp');
    expect(failed.reason).toMatch(/and 22 more/);
    expect(failed.outOfScope).toHaveLength(30);
  });

  it('a commit failure that is not about scope still fails the job at once', async () => {
    const r = rig({}, { failCommit: 'disk full' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(1);
    expect((await r.k.jobs.get(job.id))!.status).toBe('failed');
  });

  it('warn mode: the PR body lists the files that were outside the scope', async () => {
    const r = rig({}, { warnOutOfScope: [[JUNK]] }, { scopeMode: 'warn' });
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const pr = r.github.find((g) => g.type === 'pr.requested')!.payload as { body: string };
    expect(pr.body).toMatch(/outside the approved scope/);
    expect(pr.body).toContain(JUNK);
    expect(r.worker.filter((s) => s.stage === 'build')).toHaveLength(1);
  });

  it('a PR with nothing outside the scope has no such section', async () => {
    const r = rig();
    await r.k.start();
    await settle(r.k);
    const job = await jobOf(r.k);
    await settle(r.k);
    r.human.grant(job.id, 'plan');
    await settle(r.k);
    const pr = r.github.find((g) => g.type === 'pr.requested')!.payload as { body: string };
    expect(pr.body).not.toMatch(/outside the approved scope/);
  });

  it('decide() retries build on a scope failure and gives up at the budget', () => {
    const stage = (name: string, status: Stage['status'], output: unknown): Stage =>
      ({ id: name + status + Math.random(), jobId: 'j', name, status, attempt: 1, startedAt: '', endedAt: null, output }) as unknown as Stage;
    const base = [stage('worktree', 'passed', { cwd: '/w' }), stage('plan', 'passed', { result: 'p', scope: ['a'] }), stage('critique', 'passed', {}), stage('approve-plan', 'passed', {})];
    const bad = stage('build', 'failed', { result: 'done', outOfScope: ['x.tmp'] });
    const retry = decide({ status: 'running' }, [...base, bad], 2);
    expect(retry).toMatchObject({ kind: 'stage', name: 'build' });
    expect((retry as { feedback: string }).feedback).toContain('x.tmp');
    const spent = decide({ status: 'running' }, [...base, bad, stage('build', 'failed', { outOfScope: ['x.tmp'] })], 2);
    expect(spent).toMatchObject({ kind: 'fail' });
    expect((spent as { reason: string }).reason).toContain('x.tmp');
  });

  it('decide() retries a plan with a scope error once and then fails', () => {
    const stage = (name: string, status: Stage['status'], output: unknown): Stage =>
      ({ id: name + status + Math.random(), jobId: 'j', name, status, attempt: 1, startedAt: '', endedAt: null, output }) as unknown as Stage;
    const wt = stage('worktree', 'passed', { cwd: '/w' });
    const bad = stage('plan', 'failed', { result: 'p', scopeError: 'no SCOPE block' });
    expect(decide({ status: 'running' }, [wt, bad], 2)).toMatchObject({ kind: 'stage', name: 'plan' });
    expect(decide({ status: 'running' }, [wt, bad, stage('plan', 'failed', { scopeError: 'still none' })], 2)).toMatchObject({ kind: 'fail' });
  });
});

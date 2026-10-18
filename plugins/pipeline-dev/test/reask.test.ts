import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, SqliteStore, type Kernel } from '@bulig/core';
import { createTelegramChannel } from '../../channel-telegram/src/index.ts';
import { FakeTelegram, until } from '../../channel-telegram/test/fake-telegram.ts';
import { slowStore } from '../../../packages/core/test/slow-store.ts';
import pipeline from '../src/index.ts';
import { boot, fakeGithub, fakeHuman, fakeWorker, logger, newDb, openApproval, settle, type Sent } from './harness.ts';

// ADR 0009: on start, a job waiting on a question that was never noted as sent is asked again, under a new stage.

const PASS = 'All good.\nVERDICT: PASS';

function rig(db: string, config = {}, kernelExtra = {}) {
  const worker: Sent[] = [];
  const github: { type: string; payload: unknown }[] = [];
  const human = fakeHuman();
  const k = boot(db, [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub(github), human.plugin], config, kernelExtra);
  return { k, worker, github, human };
}

const stageIdOf = (e: { payload: unknown }) => (e.payload as { stageId: string }).stageId;

/** Change the record between two processes, as a lost write would have left it. */
async function tamper(db: string, edit: (s: SqliteStore) => Promise<void>): Promise<void> {
  const s = new SqliteStore(db);
  try {
    await edit(s);
  } finally {
    await s.close();
  }
}

describe('re-asking a lost question on start', () => {
  it('a lost merge question: the restart sends exactly one new card, it can approve, and the never-sent stage cannot', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    first.human.grant(job.id, 'plan');
    await until(async () => (await first.k.jobs.get(job.id))!.status === 'awaiting_approval' && (await openApproval(first.k, job.id)) !== undefined && first.human.requests.length === 2, 'the merge question');
    await first.k.stop();

    // The merge question's stage and status were saved, but the question itself was never written: what the record holds
    // after a crash, or a store that broke, between startStage and the event (store-timeout.test.ts makes it happen for real).
    let lost = '';
    await tamper(db, async (s) => {
      const open = (await s.listStages(job.id)).find((x) => x.name === 'approve-merge' && x.status === 'running')!;
      await s.finishStage(open.id, 'failed', { interrupted: true });
      lost = (await s.startStage(job.id, 'approve-merge')).id;
    });

    const second = rig(db);
    await second.k.start();
    await until(() => second.human.requests.length === 1, 'the merge question, asked again');
    await settle(second.k);
    expect(second.human.requests).toHaveLength(1);
    const asked = stageIdOf(second.human.requests[0]!);
    expect((second.human.requests[0]!.payload as { kind: string }).kind).toBe('merge');
    expect(asked).not.toBe(lost);
    expect(await openApproval(second.k, job.id)).toBe(asked);
    const closed = (await second.k.jobs.stages(job.id)).find((s) => s.id === lost)!;
    expect(closed.status).toBe('failed');
    expect(closed.output).toMatchObject({ interrupted: true, reason: 'not asked' });

    // An answer that names the stage nobody was asked about changes nothing.
    second.human.grant(job.id, 'merge', lost);
    await settle(second.k);
    expect(second.github).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');

    // The new card does.
    second.human.grant(job.id, 'merge', asked);
    await until(async () => (await second.k.jobs.get(job.id))!.status === 'done', 'the job to merge');
    expect(second.github.map((g) => g.type)).toEqual(['merge.requested']);
  });

  it('a question that was sent but whose note was lost: the restart asks again, and the card already sent expires', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    const oldCard = stageIdOf(first.human.requests[0]!);
    await first.k.stop();
    await tamper(db, (s) => s.setState('pipeline-dev', `asked:${job.id}`, 'some-earlier-stage'));

    const second = rig(db);
    await second.k.start();
    await until(() => second.human.requests.length === 1, 'the plan question, asked again');
    await settle(second.k);
    const newCard = stageIdOf(second.human.requests[0]!);
    expect(newCard).not.toBe(oldCard);

    // Two cards exist. Only one can approve: the old one, tapped now, changes nothing.
    second.human.grant(job.id, 'plan', oldCard);
    second.human.deny(job.id, oldCard);
    await settle(second.k);
    expect(second.worker).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(await openApproval(second.k, job.id)).toBe(newCard);

    second.human.grant(job.id, 'plan', newCard);
    await settle(second.k);
    expect(second.worker.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
  });

  it('a normal restart asks nothing again, at either question, however many times it restarts', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    const planStage = await openApproval(first.k, job.id);
    await first.k.stop();

    for (let i = 0; i < 2; i++) {
      const again = rig(db);
      await again.k.start();
      await settle(again.k);
      expect(again.human.requests).toHaveLength(0);
      expect(again.worker).toHaveLength(0);
      expect(await openApproval(again.k, job.id)).toBe(planStage);
      await again.k.stop();
    }

    const answer = rig(db);
    await answer.k.start();
    answer.human.grant(job.id, 'plan', planStage);
    await until(() => answer.human.requests.length === 1, 'the merge question');
    await settle(answer.k);
    const mergeStage = await openApproval(answer.k, job.id);
    await answer.k.stop();

    const last = rig(db);
    await last.k.start();
    await settle(last.k);
    expect(last.human.requests).toHaveLength(0);
    expect(await openApproval(last.k, job.id)).toBe(mergeStage);
    expect((await last.k.jobs.stages(job.id)).filter((s) => s.name.startsWith('approve-')).map((s) => `${s.name}:${s.status}`)).toEqual(['approve-plan:passed', 'approve-merge:running']);
  });

  it('a job marked waiting whose answer was saved but whose status was not carries on from the answer, and asks nothing', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    await first.k.stop();
    await tamper(db, async (s) => {
      const open = (await s.listStages(job.id)).find((x) => x.name === 'approve-plan' && x.status === 'running')!;
      await s.finishStage(open.id, 'passed', { grantedBy: 'fake-human' });
    });

    const second = rig(db);
    await second.k.start();
    await settle(second.k);
    expect(second.human.requests.filter((e) => (e.payload as { kind: string }).kind === 'plan')).toHaveLength(0);
    expect(second.worker.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
  });

  it('resume: false, or a list without the job, leaves a waiting job alone, even one whose question was lost', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    await first.k.stop();
    await tamper(db, (s) => s.setState('pipeline-dev', `asked:${job.id}`, 'some-earlier-stage'));

    const second = rig(db, { resume: false });
    await second.k.start();
    await settle(second.k);
    expect(second.human.requests).toHaveLength(0);
    await second.k.stop();

    // A resume list re-asks only the jobs it names.
    const listed = rig(db, { resume: ['some-other-job'] });
    await listed.k.start();
    await settle(listed.k);
    expect(listed.human.requests).toHaveLength(0);
    await listed.k.stop();
    const named = rig(db, { resume: [job.id] });
    await named.k.start();
    await until(() => named.human.requests.length === 1, 'the named job to be asked again');
  });

  it('a note that cannot be read on start leaves the job waiting as it was, not failed and not re-asked', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    const planStage = await openApproval(first.k, job.id);
    await first.k.stop();

    const store = slowStore(new SqliteStore(db), { after: (m, _n, args) => (m === 'getState' && args[0] === 'pipeline-dev' ? 300 : 0) });
    const second = rig(newDb(), {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await second.k.start();
    await new Promise((res) => setTimeout(res, 500));
    expect(second.human.requests).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(await openApproval(second.k, job.id)).toBe(planStage);
  });

  it('a stage list that cannot be read on start leaves the job waiting too', async () => {
    const db = newDb();
    const first = rig(db);
    await first.k.start();
    const job = await first.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => first.human.requests.length === 1, 'the plan question');
    await settle(first.k);
    const planStage = await openApproval(first.k, job.id);
    await first.k.stop();

    // Only the first stage read is late: the one the start-up check makes.
    let late = true;
    const store = slowStore(new SqliteStore(db), { after: (m) => (m === 'listStages' && late ? ((late = false), 300) : 0) });
    const second = rig(newDb(), {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await second.k.start();
    await new Promise((res) => setTimeout(res, 500));
    expect(second.human.requests).toHaveLength(0);
    expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect((await second.k.history(job.id)).some((e) => e.type === 'pipeline.failed')).toBe(false);
    expect(await openApproval(second.k, job.id)).toBe(planStage);
  });

  it('a note that cannot be written does not fail the job: the question is out, and the person can answer it', async () => {
    const db = newDb();
    // The note answers late, so the kernel gives up on it and rolls it back.
    const store = slowStore(new SqliteStore(db), { after: (m, _n, args) => (m === 'setState' && args[0] === 'pipeline-dev' ? 300 : 0) });
    const r = rig(newDb(), {}, { store, storeTimeoutMs: 100, storeBrokenMs: 5000 });
    await r.k.start();
    const job = await r.k.jobs.create({ repo: '/repo', title: 'T', body: 'x' });
    await until(() => r.human.requests.length === 1, 'the plan question');
    await new Promise((res) => setTimeout(res, 500));
    expect((await r.k.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect((await r.k.history(job.id)).some((e) => e.type === 'pipeline.failed')).toBe(false);
    r.human.grant(job.id, 'plan');
    await until(() => r.worker.length === 6, 'build, test, docs and review to run');
    expect(r.worker.map((w) => w.stage)).toEqual(['plan', 'critique', 'build', 'test', 'docs', 'review']);
  });
});

// The same, through the real Telegram channel: the card a person can see is what counts.
const CHAT = 5201;
const TOKEN_ENV = 'TEST_REASK_TG_TOKEN';
const dirs: string[] = [];
const kernels: Kernel[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[TOKEN_ENV];
});

describe('re-asking through Telegram', () => {
  it('after a restart there are two cards, and only the new one can approve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bulig-reask-'));
    dirs.push(root);
    const db = join(root, 'db.sqlite');
    const fake = await new FakeTelegram().start();
    fakes.push(fake);
    process.env[TOKEN_ENV] = fake.token;
    const worker: Sent[] = [];
    const start = async () => {
      const k = createKernel({
        dbPath: db,
        plugins: [pipeline, fakeGithub([]), fakeWorker({ test: PASS, review: PASS }, worker), createTelegramChannel({ sleep: async () => {} })],
        enabled: ['pipeline-dev', 'fake-github', 'fake-worker', 'channel-telegram'],
        grants: { 'pipeline-dev': ['merge.request', 'jobs.write'], 'channel-telegram': ['channel.send:telegram', 'approval.grant'] },
        pluginConfig: { 'channel-telegram': { tokenEnv: TOKEN_ENV, allowedChatIds: [CHAT], apiBase: fake.apiBase, pollTimeoutSec: 0 } },
        logger,
      });
      kernels.push(k);
      await k.start();
      return k;
    };
    const cards = () =>
      fake
        .of('sendMessage')
        .filter((c) => String(c.params.text).includes('approval needed: plan') && c.params.reply_markup)
        .map((c) => ({ id: c.params.__id as number, text: String(c.params.text), approve: (c.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data }));

    const k1 = await start();
    const job = await k1.jobs.create({ repo: '/fake/repo', title: 'Add a thing' });
    await until(() => cards().length === 1, 'the plan card', 15000);
    await settle(k1);
    await k1.stop();
    kernels.splice(kernels.indexOf(k1), 1);
    await tamper(db, (s) => s.setState('pipeline-dev', `asked:${job.id}`, 'some-earlier-stage'));

    const ranBefore = worker.length;
    const k2 = await start();
    await until(() => cards().length === 2, 'the plan card, sent again', 15000);
    await settle(k2);
    expect(cards()).toHaveLength(2);
    const [oldCard, newCard] = cards() as [ReturnType<typeof cards>[0], ReturnType<typeof cards>[0]];
    expect(newCard.approve).not.toBe(oldCard.approve);

    const answers = fake.of('answerCallbackQuery').length;
    fake.press(CHAT, oldCard.id, oldCard.text, oldCard.approve);
    await until(() => fake.of('answerCallbackQuery').length === answers + 1, 'the old tap is answered', 15000);
    expect(fake.of('answerCallbackQuery').at(-1)!.params.text).toBe('That approval is no longer open.');
    await settle(k2);
    expect(worker.slice(ranBefore)).toHaveLength(0);

    fake.press(CHAT, newCard.id, newCard.text, newCard.approve);
    await until(() => worker.length === ranBefore + 4, 'build, test, docs and review to run', 15000);
    expect(worker.slice(ranBefore).map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
  });
});

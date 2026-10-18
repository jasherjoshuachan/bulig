import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { createTelegramChannel } from '../../channel-telegram/src/index.ts';
import { FakeTelegram, until } from '../../channel-telegram/test/fake-telegram.ts';
import pipeline from '../src/index.ts';
import { fakeGithub, fakeHuman, fakeWorker, logger, openApproval, settle } from './harness.ts';

// Two allowed chats: a job that came from neither gets its cards in both, and Telegram only edits the card that was tapped.
const CHAT_A = 5101;
const CHAT_B = 5102;
const TOKEN_ENV = 'TEST_STALE_CARD_TG_TOKEN';
const dirs: string[] = [];
const kernels: Kernel[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[TOKEN_ENV];
});

interface Card { chat: number; id: number; text: string; approve: string; deny: string }

/** The real pipeline and the real Telegram channel (fake Bot API). The first merge is refused, as when the PR head moved. */
async function rig() {
  const root = mkdtempSync(join(tmpdir(), 'bulig-stale-card-'));
  dirs.push(root);
  const fake = await new FakeTelegram().start();
  fakes.push(fake);
  process.env[TOKEN_ENV] = fake.token;
  const github: { type: string; payload: unknown }[] = [];
  // A second channel that emits grants directly, standing in for any channel that does not check the stage itself.
  const human = fakeHuman();
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [pipeline, fakeGithub(github, { refuseMerge: ['the PR head moved'] }), fakeWorker({ test: 'ok\nVERDICT: PASS', review: 'ok\nVERDICT: PASS' }, []), createTelegramChannel({ sleep: async () => {} }), human.plugin],
    enabled: ['pipeline-dev', 'fake-github', 'fake-worker', 'channel-telegram', 'fake-human'],
    grants: {
      'pipeline-dev': ['merge.request', 'jobs.write'],
      'channel-telegram': ['channel.send:telegram', 'approval.grant'],
      'fake-human': ['approval.grant'],
    },
    pluginConfig: { 'channel-telegram': { tokenEnv: TOKEN_ENV, allowedChatIds: [CHAT_A, CHAT_B], apiBase: fake.apiBase, pollTimeoutSec: 0 } },
    logger,
  });
  kernels.push(k);
  await k.start();
  await settle(k);

  /** Every card with buttons for one kind, oldest first. */
  const cards = (kind: 'plan' | 'merge'): Card[] =>
    fake
      .of('sendMessage')
      .filter((c) => String(c.params.text).includes(`approval needed: ${kind}`) && c.params.reply_markup)
      .map((c) => {
        const row = (c.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
        return { chat: c.params.chat_id as number, id: c.params.__id as number, text: String(c.params.text), approve: row[0]!.callback_data, deny: row[1]!.callback_data };
      });
  const tap = (card: Card, data: string) => fake.press(card.chat, card.id, card.text, data);
  const merges = () => github.filter((g) => g.type === 'merge.requested').length;
  return { k, fake, human, cards, tap, merges };
}

describe('a card left over from an earlier question', () => {
  it('cannot approve the merge question that opens again after a refusal', async () => {
    const r = await rig();
    const job = r.k.jobs.create({ repo: '/fake/repo', title: 'Add a thing' });
    await settle(r.k);

    // The plan card reaches both chats. Approve it in A.
    await until(() => r.cards('plan').length === 2, 'two plan cards', 15000);
    r.tap(r.cards('plan')[0]!, r.cards('plan')[0]!.approve);

    // Two live merge cards, one per chat, for the same stage. Approve in A: the merge is refused.
    await until(() => r.cards('merge').length === 2, 'two merge cards', 15000);
    const [mergeA, staleB] = r.cards('merge') as [Card, Card];
    expect(mergeA.chat).toBe(CHAT_A);
    expect(staleB.chat).toBe(CHAT_B);
    expect(staleB.approve).toBe(mergeA.approve);
    expect(Buffer.byteLength(mergeA.approve)).toBeLessThanOrEqual(64);
    const firstStage = openApproval(r.k, job.id)!;
    r.tap(mergeA, mergeA.approve);

    // The refusal opens a new approve-merge stage, and a new pair of cards with new button data.
    await until(() => r.cards('merge').length === 4, 'the renewed merge cards', 15000);
    await settle(r.k);
    const renewedStage = openApproval(r.k, job.id)!;
    expect(renewedStage).not.toBe(firstStage);
    expect(r.merges()).toBe(1);
    const renewed = r.cards('merge')[2]!;
    expect(renewed.text).toContain('The last merge was refused');
    expect(renewed.approve).not.toBe(staleB.approve);

    // The person in chat B never saw the refusal and taps the old card. It has expired: nothing is granted.
    const answersBefore = r.fake.of('answerCallbackQuery').length;
    const editsBefore = r.fake.of('editMessageText').length;
    r.tap(staleB, staleB.approve);
    // The channel answers the tap first and edits the card after, so wait for both.
    await until(() => r.fake.of('answerCallbackQuery').length === answersBefore + 1 && r.fake.of('editMessageText').length === editsBefore + 1, 'the stale tap is answered and the card edited', 15000);
    expect(r.fake.of('answerCallbackQuery').at(-1)!.params.text).toBe('That approval is no longer open.');
    expect(String(r.fake.of('editMessageText').at(-1)!.params.text)).toContain('Expired');
    // Deny on the old card has expired too: the job is not cancelled.
    r.tap(staleB, staleB.deny);
    await until(() => r.fake.of('answerCallbackQuery').length === answersBefore + 2, 'the stale deny is answered', 15000);
    await settle(r.k);
    expect(r.k.history(job.id).filter((e) => e.source === 'channel-telegram' && e.type.startsWith('approval.'))).toHaveLength(2);

    // A channel that passes the old stage id, or none (a card from before stage ids), straight to the pipeline is ignored there too.
    r.human.grant(job.id, 'merge', firstStage);
    r.human.grant(job.id, 'merge', null);
    r.human.deny(job.id, firstStage);
    r.human.deny(job.id, null);
    await settle(r.k);
    expect(r.k.jobs.get(job.id)!.status).toBe('awaiting_approval');
    expect(openApproval(r.k, job.id)).toBe(renewedStage);
    expect(r.merges()).toBe(1);
    expect(r.k.history(job.id).some((e) => e.type === 'pr.merged')).toBe(false);

    // Only the renewed card, which says the merge was refused, can approve it.
    r.tap(renewed, renewed.approve);
    await until(() => r.k.jobs.get(job.id)!.status === 'done', 'the job to finish', 15000);
    expect(r.merges()).toBe(2);
    expect(r.k.history(job.id).filter((e) => e.type === 'pr.merged')).toHaveLength(1);
    expect(r.k.jobs.stages(job.id).filter((s) => s.name === 'approve-merge').map((s) => s.status)).toEqual(['passed', 'passed']);
  });

  it('a grant that names the open stage of the other kind does nothing', async () => {
    const r = await rig();
    const job = r.k.jobs.create({ repo: '/fake/repo', title: 'Add a thing' });
    await settle(r.k);
    await until(() => r.cards('plan').length === 2, 'two plan cards', 15000);
    const planStage = openApproval(r.k, job.id)!;
    // Right stage id, wrong kind: the pipeline looks for an open approve-merge stage and finds none.
    r.human.grant(job.id, 'merge', planStage);
    await settle(r.k);
    expect(r.k.jobs.get(job.id)!.status).toBe('awaiting_approval');
    expect(openApproval(r.k, job.id)).toBe(planStage);
  });
});

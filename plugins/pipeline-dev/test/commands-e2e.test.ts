import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { createTelegramChannel } from '../../channel-telegram/src/index.ts';
import { FakeTelegram, until } from '../../channel-telegram/test/fake-telegram.ts';
import pipeline from '../src/index.ts';
import { fakeGithub, fakeWorker, logger, type Script } from './harness.ts';

const CHAT = 4242;
const TOKEN_ENV = 'TEST_COMMANDS_E2E_TG_TOKEN';
const dirs: string[] = [];
const kernels: Kernel[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[TOKEN_ENV];
});

/** The real pipeline and the real Telegram channel (fake Bot API), with a fake worker and a fake github. */
async function rig(script: Script) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-cmds-'));
  dirs.push(root);
  const fake = await new FakeTelegram().start();
  fakes.push(fake);
  process.env[TOKEN_ENV] = fake.token;
  const sent: { type: string; payload: unknown }[] = [];
  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [pipeline, fakeGithub(sent), fakeWorker(script, []), createTelegramChannel({ sleep: async () => {} })],
    enabled: ['pipeline-dev', 'fake-github', 'fake-worker', 'channel-telegram'],
    grants: { 'pipeline-dev': ['merge.request', 'jobs.write'], 'channel-telegram': ['channel.send:telegram', 'approval.grant'] },
    pluginConfig: { 'channel-telegram': { tokenEnv: TOKEN_ENV, allowedChatIds: [CHAT], apiBase: fake.apiBase, pollTimeoutSec: 0, repos: { app: root } } },
    logger,
  });
  kernels.push(k);
  await k.start();
  return { k, fake, root, sent };
}

describe('/cancel and /retry with the real pipeline', () => {
  it('/cancel with no id stops the one job whose stage is running, and nothing starts after it', async () => {
    const r = await rig({ plan: 'hang' });
    r.fake.say(CHAT, '/dev app Slow job');
    await until(() => r.k.jobs.list().length === 1, 'job');
    const job = r.k.jobs.list()[0]!;
    await until(() => r.k.jobs.stages(job.id).some((s) => s.name === 'plan' && s.status === 'running'), 'plan running');
    r.fake.say(CHAT, '/cancel');
    await until(() => r.k.jobs.get(job.id)!.status === 'cancelled', 'cancelled', 15000);
    expect(r.k.jobs.stages(job.id).map((s) => s.name)).not.toContain('build');
  });

  it('/retry of a failed job plans again and asks for a new plan approval; the old approval is not reused', async () => {
    // First job: the plan is approved, then the build fails twice, so the job fails.
    const r = await rig({ build: { fail: 'boom' } as never });
    r.fake.say(CHAT, '/dev app Add a thing\nDo it well');
    await until(() => r.k.jobs.list().length === 1, 'job');
    const old = r.k.jobs.list()[0]!;
    await until(() => r.fake.texts(CHAT).some((t) => t.includes('approval needed: plan')), 'plan card', 15000);
    r.fake.press(CHAT, 1, 'card', `ap:${old.id}:plan`);
    await until(() => r.k.jobs.get(old.id)!.status === 'failed', 'the job to fail', 15000);
    const oldStages = r.k.jobs.stages(old.id).map((s) => `${s.name}:${s.status}`);
    expect(oldStages).toContain('approve-plan:passed');

    r.fake.say(CHAT, `/retry ${old.id.slice(0, 8)}`);
    await until(() => r.k.jobs.list().length === 2, 'retried job');
    const fresh = r.k.jobs.list()[1]!;
    await until(() => r.k.jobs.get(fresh.id)!.status === 'awaiting_approval', 'new job waits for plan approval', 15000);
    const freshStages = r.k.jobs.stages(fresh.id).map((s) => `${s.name}:${s.status}`);
    expect(freshStages).toContain('approve-plan:running');
    expect(freshStages.some((s) => s.startsWith('build') || s === 'approve-plan:passed')).toBe(false);
    expect({ repo: fresh.repo, title: fresh.title, body: fresh.body }).toEqual({ repo: old.repo, title: old.title, body: old.body });
    // A second plan card exists, with buttons for the NEW job id only.
    await until(() => r.fake.of('sendMessage').filter((c) => String(c.params.text).includes('approval needed: plan')).length === 2, 'second plan card', 15000);
    const card = r.fake.of('sendMessage').filter((c) => String(c.params.text).includes('approval needed: plan'))[1]!;
    expect(JSON.stringify(card.params.reply_markup)).toContain(`ap:${fresh.id}:plan`);
    expect(JSON.stringify(card.params.reply_markup)).not.toContain(old.id);
    // The old job stays failed and its record is untouched.
    expect(r.k.jobs.get(old.id)!.status).toBe('failed');
    expect(r.k.jobs.stages(old.id).map((s) => `${s.name}:${s.status}`)).toEqual(oldStages);
  });
});

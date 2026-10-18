import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@bulig/core';
import { progressLine, safeLink } from '../src/index.ts';
import { boot, CHAT, shutdown, startFake, tempDir, TOKEN_ENV } from './harness.ts';
import { until } from './fake-telegram.ts';

const STRANGER = 999;
/** What the bot said in reply to commands: the progress lines of job.status changes ("[id] job failed") are left out. */
const replies = (fake: { texts(chat?: number): string[] }, chat = CHAT) => fake.texts(chat).filter((t) => !/^\[[0-9a-f-]{8}\] job (done|failed|cancelled)$/.test(t));


describe('starting up', () => {
  it('refuses to start without a token in the environment', async () => {
    const fake = await startFake();
    delete process.env[TOKEN_ENV];
    await expect(boot(fake)).rejects.toThrow(new RegExp(`Export it as ${TOKEN_ENV}`));
  });

  it('refuses an empty allowlist', async () => {
    const fake = await startFake();
    await expect(boot(fake, { allowedChatIds: [] })).rejects.toThrow(/allowedChatIds/);
  });

  it('is denied without the grant', async () => {
    const fake = await startFake();
    await expect(boot(fake, {}, { grants: false })).rejects.toThrow(/channel\.send:telegram/);
  });

  it('answers /help', async () => {
    const fake = await startFake();
    await boot(fake);
    fake.say(CHAT, '/help');
    await until(() => fake.texts(CHAT).length === 1, 'help text');
    expect(fake.texts(CHAT)[0]).toMatch(/\/dev <repo> <title>/);
  });
});

describe('who may talk to it', () => {
  it('ignores a stranger completely: no reply, no job, one warning', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo } });
    fake.say(STRANGER, `/dev app Take over`);
    fake.say(STRANGER, '/status');
    fake.say(CHAT, '/help'); // the allowed chat is answered, which proves both strangers were already handled
    await until(() => fake.texts().length === 1, 'help for the allowed chat');
    expect(fake.texts(STRANGER)).toEqual([]);
    expect(await b.d.ctx.jobs.list()).toEqual([]);
    expect(b.warnings.filter((w) => w.includes(`chat ${STRANGER}`))).toHaveLength(2);
  });

  it('ignores button presses from a stranger', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    fake.press(STRANGER, 1, 'x', `ap:${job.id}:plan`);
    fake.say(CHAT, '/help');
    await until(() => fake.texts().length === 2, 'help');
    expect(fake.of('answerCallbackQuery')).toEqual([]);
    expect(b.d.seen).toEqual([]);
  });
});

describe('/dev', () => {
  it('creates a job from the alias, title and issue text', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo } });
    fake.say(CHAT, '/dev app Add multiply\nAdd src/multiply.js.\nWith tests.');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job created');
    const [job] = await b.d.ctx.jobs.list();
    expect(job).toMatchObject({ repo, title: 'Add multiply', body: 'Add src/multiply.js.\nWith tests.' });
    await until(() => fake.texts(CHAT).some((t) => t.includes('started: Add multiply')), 'started reply');
    expect(fake.texts(CHAT).join('\n')).toContain(job!.id.slice(0, 8));
  });

  it('accepts the @botname form that groups use', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo } });
    fake.say(CHAT, '/dev@bulig_bot app Group style');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job created');
    expect((await b.d.ctx.jobs.list())[0]!.title).toBe('Group style');
  });

  it('lists the known aliases when the alias is unknown, and creates nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir(), site: tempDir() } });
    fake.say(CHAT, '/dev nope Do something');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('"nope"');
    expect(fake.texts(CHAT)[0]).toContain('Known repos: app, site');
    expect(await b.d.ctx.jobs.list()).toEqual([]);
  });

  it('does not treat built-in object names as aliases', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir() } });
    fake.say(CHAT, '/dev constructor Sneaky');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('Known repos: app');
    expect(await b.d.ctx.jobs.list()).toEqual([]);
  });

  it('explains usage when the title is missing', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir() } });
    fake.say(CHAT, '/dev app');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toMatch(/Usage: \/dev app <title>/);
    expect(await b.d.ctx.jobs.list()).toEqual([]);
  });

  it('says so when the repo path is not on this machine', async () => {
    const fake = await startFake();
    const gone = join(tempDir(), 'missing');
    const b = await boot(fake, { repos: { app: gone } });
    fake.say(CHAT, '/dev app Do it');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('does not exist');
    expect(await b.d.ctx.jobs.list()).toEqual([]);
  });
});

describe('news about a new job while its chat link is still being saved', () => {
  afterEach(() => vi.restoreAllMocks());

  it('goes to the chat that started the job, not to every allowed chat', async () => {
    const OTHER = 777;
    const fake = await startFake();
    const repo = tempDir();
    // A slow save, as a database server would be: the value is written 300 ms after set is called.
    const original = SqliteStore.prototype.setState;
    vi.spyOn(SqliteStore.prototype, 'setState').mockImplementation(function (this: SqliteStore, plugin: string, key: string, value: unknown) {
      if (!key.startsWith('chat:')) return original.call(this, plugin, key, value);
      return new Promise<void>((resolve) => setTimeout(() => resolve(original.call(this, plugin, key, value)), 300));
    });
    const b = await boot(fake, { repos: { app: repo }, allowedChatIds: [CHAT, OTHER] });
    fake.say(CHAT, '/dev app Add multiply');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job created');
    const job = (await b.d.ctx.jobs.list())[0]!;
    // News about the job arrives while the link is not written yet.
    b.d.ctx.emit('stage.completed', { stage: 'plan', result: 'x' }, job.id);
    const line = `[${job.id.slice(0, 8)}] plan finished`;
    await until(() => fake.texts(CHAT).some((t) => t.startsWith(line)), 'progress line in the starting chat');
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.texts(OTHER).filter((t) => t.startsWith(line))).toEqual([]);
  });

  it('goes to the starting chat even when the news is ready before the job call has returned', async () => {
    const OTHER = 777;
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo }, allowedChatIds: [CHAT, OTHER] });
    // The kernel announces job.created inside the create call. Anything emitted then is sent before the call returns.
    b.d.hooks.created = (e) => b.d.ctx.emit('stage.completed', { stage: 'plan', result: 'x' }, e.jobId);
    fake.say(CHAT, '/dev app Add multiply');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job created');
    const job = (await b.d.ctx.jobs.list())[0]!;
    const line = `[${job.id.slice(0, 8)}] plan finished`;
    await until(() => fake.texts(CHAT).some((t) => t.startsWith(line)), 'progress line in the starting chat');
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.texts(OTHER).filter((t) => t.startsWith(line))).toEqual([]);
  });

  it('does the same for a job started by /retry', async () => {
    const OTHER = 777;
    const fake = await startFake();
    const repo = tempDir();
    const original = SqliteStore.prototype.setState;
    vi.spyOn(SqliteStore.prototype, 'setState').mockImplementation(function (this: SqliteStore, plugin: string, key: string, value: unknown) {
      if (!key.startsWith('chat:')) return original.call(this, plugin, key, value);
      return new Promise<void>((resolve) => setTimeout(() => resolve(original.call(this, plugin, key, value)), 300));
    });
    const b = await boot(fake, { repos: { app: repo }, allowedChatIds: [CHAT, OTHER] });
    fake.say(CHAT, '/dev app Add multiply');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job created');
    const old = (await b.d.ctx.jobs.list())[0]!;
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job created');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    b.d.ctx.emit('stage.completed', { stage: 'plan', result: 'x' }, fresh.id);
    const line = `[${fresh.id.slice(0, 8)}] plan finished`;
    await until(() => fake.texts(CHAT).some((t) => t.startsWith(line)), 'progress line in the retrying chat');
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.texts(OTHER).filter((t) => t.startsWith(line))).toEqual([]);
  });
});

describe('safeLink', () => {
  it('drops user@host links and bidi control characters, keeps plain https', () => {
    expect(safeLink('https://example.test/runs/1')).toBe(true);
    expect(safeLink('https://example.test/runs/1?to=a@b.test')).toBe(true);
    expect(safeLink('https://github.com@evil.test/')).toBe(false);
    expect(safeLink('https://user@example.test/')).toBe(false);
    expect(safeLink('https://:pass@example.test/')).toBe(false);
    for (const ch of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) {
      expect(safeLink(`https://example.test/a${ch}b`)).toBe(false);
    }
  });
});

describe('approvals', () => {
  it('the plan card lists the files the job may change', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    await b.d.waitForApproval('plan', { scope: ['README.md', 'src/lib/*.ts', 'docs/my notes.md'] });
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const text = String(fake.of('sendMessage')[0]!.params.text);
    expect(text).toContain('Files this job may change:');
    expect(text).toContain('- README.md');
    expect(text).toContain('- src/lib/*.ts');
    expect(text).toContain('- docs/my notes.md');
  });

  it('shows every scope entry, in full, even when there are many and they are long', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const scope = Array.from({ length: 100 }, (_, i) => `src/${String(i).padStart(3, '0')}/${'d'.repeat(170)}/file.ts`);
    await b.d.waitForApproval('plan', { scope });
    await until(() => fake.of('sendMessage').some((m) => m.params.reply_markup), 'the last approval message, with the buttons');
    const sent = fake.of('sendMessage').map((m) => m.params);
    expect(sent.length).toBeGreaterThan(2);
    for (const m of sent) expect(String(m.text).length).toBeLessThanOrEqual(4096);
    // the approver can't tap before seeing the whole list: buttons only on the last message
    expect(sent.slice(0, -1).every((m) => m.reply_markup === undefined)).toBe(true);
    expect(sent.at(-1)!.reply_markup.inline_keyboard[0]).toHaveLength(2);
    const all = sent.map((m) => String(m.text)).join('\n');
    for (const entry of scope) expect(all).toContain(`- ${entry}`);
    expect(all.indexOf(`- ${scope[99]}`)).toBeGreaterThan(all.indexOf(`- ${scope[0]}`));
    expect(all).not.toMatch(/and \d+ more/);
  });

  it('withholds the Approve buttons when a piece of the scope list fails to send', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const scope = Array.from({ length: 100 }, (_, i) => `src/${String(i).padStart(3, '0')}/${'d'.repeat(170)}/file.ts`);
    fake.fail('sendMessage', { kind: 'status', status: 400, body: { ok: false, error_code: 400, description: 'Bad Request' } });
    await b.d.waitForApproval('plan', { scope });
    await until(() => fake.texts().some((t) => /no buttons/.test(t)), 'the notice that the buttons were withheld');
    const sent = fake.of('sendMessage').map((m) => m.params);
    expect(sent.some((m) => m.reply_markup !== undefined)).toBe(false);
    expect(sent.some((m) => String(m.text).includes('plan text, after the list above'))).toBe(false);
  });

  it('a merge card does not show a scope list', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    await b.d.waitForApproval('merge', { url: 'https://example.test/pull/7', scope: ['README.md'] });
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    expect(String(fake.of('sendMessage')[0]!.params.text)).not.toContain('Files this job may change');
  });

  it('shows Approve and Deny buttons carrying the job and the kind', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('merge', { url: 'https://example.test/pull/7' });
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    expect(sent.text).toContain('approval needed: merge');
    expect(sent.text).toContain('https://example.test/pull/7');
    const [row] = sent.reply_markup.inline_keyboard;
    expect(row.map((x: any) => x.callback_data)).toEqual([`ap:${job.id}:merge`, `dn:${job.id}:merge`]);
    expect(row.map((x: any) => x.text)).toEqual(['✅ Approve', '❌ Deny']);
  });

  it('Approve answers the tap, edits the message and emits approval.granted', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`);
    await until(() => fake.of('editMessageText').length === 1, 'edit');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toBe('Approved');
    const edit = fake.of('editMessageText')[0]!.params;
    expect(edit).toMatchObject({ chat_id: CHAT, message_id: sent.__id, reply_markup: { inline_keyboard: [] } });
    expect(edit.text).toContain('Approved by @jasher');
    expect(b.d.seen.map((e) => [e.type, e.jobId, e.source, e.payload])).toEqual([
      ['approval.granted', job.id, 'channel-telegram', { jobId: job.id, kind: 'plan' }],
    ]);
  });

  it('Deny emits approval.denied', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('merge');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `dn:${job.id}:merge`);
    await until(() => fake.of('editMessageText').length === 1, 'edit');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toBe('Denied');
    expect(fake.of('editMessageText')[0]!.params.text).toContain('Denied by @jasher');
    expect(b.d.seen.map((e) => e.type)).toEqual(['approval.denied']);
  });

  it('a second tap, or a tap after the job moved on, is expired and emits nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    // The pipeline has moved on: the approval stage is closed and the job is running again.
    for (const s of await b.d.ctx.jobs.stages(job.id)) await b.d.ctx.jobs.finishStage(s.id, 'passed');
    await b.d.ctx.jobs.setStatus(job.id, 'running');
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`);
    await until(() => fake.of('editMessageText').length === 1, 'edit');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toMatch(/no longer open/);
    expect(fake.of('editMessageText')[0]!.params.text).toContain('Expired');
    expect(b.d.seen).toEqual([]);
  });

  it('ignores a button with data it does not understand', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    fake.press(CHAT, 1, 'x', 'zz:nonsense');
    await until(() => fake.of('answerCallbackQuery').length === 1, 'answer');
    expect(fake.of('editMessageText')).toEqual([]);
    expect(b.d.seen).toEqual([]);
  });
});

describe('progress', () => {
  it('sends one short line per stage, the PR url, and the end of the job; stays quiet on noise', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    const tag = `[${job.id.slice(0, 8)}]`;
    await b.d.ctx.jobs.setStatus(job.id, 'running'); // silent
    b.d.ctx.emit('stage.completed', { stage: 'plan', costUsd: 0.1234, result: 'x' }, job.id);
    b.d.ctx.emit('stage.completed', { stage: 'test', result: 'all green\nVERDICT: PASS' }, job.id);
    b.d.ctx.emit('stage.failed', { stage: 'build', error: 'boom' }, job.id);
    b.d.ctx.emit('pr.opened', { url: 'https://example.test/pull/9', number: 9, headSha: 'abc' }, job.id);
    b.d.ctx.emit('merge.refused', { reason: 'checks pending' }, job.id);
    b.d.ctx.emit('pr.merged', { number: 9 }, job.id);
    await b.d.ctx.jobs.setStatus(job.id, 'done');
    await until(() => fake.texts().length === 7, 'seven lines');
    expect(fake.texts()).toEqual([
      `${tag} plan finished ($0.12)`,
      `${tag} test finished: PASS`,
      `${tag} build FAILED: boom`,
      `${tag} PR opened: https://example.test/pull/9`,
      `${tag} merge refused: checks pending`,
      `${tag} PR merged (#9)`,
      `${tag} job done`,
    ]);
  });

  it('reports a failed pipeline', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    b.d.ctx.emit('pipeline.failed', { reason: 'review failed twice' }, job.id);
    await until(() => fake.texts().length === 1, 'line');
    expect(fake.texts()[0]).toContain('job failed: review failed twice');
  });

  it('names the out-of-scope files when a job fails because of them', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    b.d.ctx.emit(
      'pipeline.failed',
      { reason: 'build still left files outside the approved scope after 2 attempts', outOfScope: ['test-results/.last-run.json', 'naive file.txt'] },
      job.id,
    );
    await until(() => fake.texts().length === 1, 'line');
    const text = fake.texts()[0]!;
    expect(text).toContain('job failed: build still left files outside the approved scope');
    expect(text).toContain('- test-results/.last-run.json');
    expect(text).toContain('- naive file.txt');
  });

  it('says why a merge failed, with the check names and links, and does not repeat it as a generic job failure', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    const tag = `[${job.id.slice(0, 8)}]`;
    b.d.ctx.emit(
      'merge.failed',
      {
        reason: 'checks failing: Typecheck & build. Fix the failing check, then run the job again.',
        checks: [{ name: 'Typecheck & build', link: 'https://example.test/runs/1' }],
      },
      job.id,
    );
    b.d.ctx.emit('pipeline.failed', { reason: 'merge failed: checks failing: Typecheck & build. Fix the failing check, then run the job again.' }, job.id);
    b.d.ctx.emit('merge.failed', { reason: 'PR #3 was closed without being merged' }, job.id);
    await until(() => fake.texts().length === 2, 'two lines');
    expect(fake.texts()).toEqual([
      `${tag} merge failed: checks failing: Typecheck & build. Fix the failing check, then run the job again.\nTypecheck & build: https://example.test/runs/1`,
      `${tag} merge failed: PR #3 was closed without being merged`,
    ]);
  });

  it('shows only plain https links of failing checks', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    const tag = `[${job.id.slice(0, 8)}]`;
    const bad: unknown[] = [
      'http://example.test/runs/1',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'https://example.test/runs/1\nhttps://evil.test/',
      'https://example.test/a b',
      'https://example.test/\u0007x',
      'https://github.com@evil.test/runs/1',
      'https://user:pass@example.test/runs/1',
      'https://example.test@/runs/1',
      'https://example.test/runs/\u202Egpj.1',
      'https://example.test/\u200Fruns/1',
      'https://example.test/\u2066runs/1',
      'not a url',
      42,
      null,
      { href: 'https://example.test/' },
    ];
    const checks = [...bad.map((link, i) => ({ name: `bad${i}`, link })), { name: 'good', link: 'https://example.test/runs/2' }];
    b.d.ctx.emit('merge.failed', { reason: 'checks failing: x', checks }, job.id);
    await until(() => fake.texts().length === 1, 'line');
    expect(fake.texts()[0]).toBe(`${tag} merge failed: checks failing: x\ngood: https://example.test/runs/2`);
  });

  it('sends a job started here back to the chat that started it', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo }, allowedChatIds: [CHAT, 77] });
    fake.say(77, '/dev app From the second chat');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job');
    const job = (await b.d.ctx.jobs.list())[0]!;
    await until(() => fake.texts(77).length === 1, 'started reply');
    b.d.ctx.emit('pr.opened', { url: 'https://example.test/pull/2' }, job.id);
    await until(() => fake.texts(77).length === 2, 'pr line');
    expect(fake.texts(CHAT)).toEqual([]);
  });
});

describe('/status, /history, /cancel', () => {
  it('/status lists the newest jobs first, with repo alias, state and age', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const clock = { t: Date.now() };
    const b = await boot(fake, { repos: { app: repo } }, { now: () => clock.t });
    const a = await b.d.ctx.jobs.create({ repo, title: 'First job' });
    const c = await b.d.ctx.jobs.create({ repo, title: 'Second job' });
    await b.d.ctx.jobs.setStatus(c.id, 'running');
    clock.t += 125_000;
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 1, 'status');
    expect(fake.texts(CHAT)[0]!.split('\n')).toEqual([`${c.id.slice(0, 8)}  app  running  2m  Second job`, `${a.id.slice(0, 8)}  app  queued  2m  First job`]);
  });

  it('/status says what a job waiting on you waits for', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const plan = await b.d.waitForApproval('plan');
    const merge = await b.d.waitForApproval('merge');
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 3, 'two cards and status');
    const text = fake.texts(CHAT)[2]!;
    expect(text).toContain(`${merge.id.slice(0, 8)}  `);
    expect(text).toContain('waiting for your merge approval');
    expect(text.indexOf('merge approval')).toBeLessThan(text.indexOf(plan.id.slice(0, 8)));
    expect(text).toContain('waiting for your plan approval');
  });

  it('/status shows at most 10 jobs and counts the rest', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    for (let i = 1; i <= 13; i++) await b.d.ctx.jobs.create({ repo: '/r', title: `Job ${i}` });
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 1, 'status');
    const lines = fake.texts(CHAT)[0]!.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain('Job 13');
    expect(lines[9]).toContain('Job 4');
    expect(lines[10]).toBe('... and 3 more');
  });

  it('/status clips a long title and flattens line breaks', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    await b.d.ctx.jobs.create({ repo: '/r', title: `${'x'.repeat(300)}\n/cancel everything` });
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 1, 'status');
    const lines = fake.texts(CHAT)[0]!.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(140);
  });

  it('/status, /cancel and /retry only see jobs of the chat that asked', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const OTHER = 5151;
    const b = await boot(fake, { allowedChatIds: [CHAT, OTHER], repos: { app: repo } });
    fake.say(CHAT, '/dev app Mine');
    fake.say(OTHER, '/dev app Theirs');
    await until(() => fake.texts().length === 2, 'two jobs started');
    const [mine, theirs] = await b.d.ctx.jobs.list();
    fake.say(CHAT, '/status');
    fake.say(CHAT, `/cancel ${theirs!.id}`);
    fake.say(CHAT, `/retry ${theirs!.id}`);
    await until(() => fake.texts(CHAT).length === 4, 'three replies');
    const [, status, cancel, retry] = fake.texts(CHAT);
    expect(status).toContain('Mine');
    expect(status).not.toContain('Theirs');
    expect(cancel).toContain('No job starts with');
    expect(retry).toContain('No job starts with');
    expect((await b.d.ctx.jobs.get(theirs!.id))!.status).toBe('queued');
    expect(await b.d.ctx.jobs.list()).toHaveLength(2);
    expect(mine!.title).toBe('Mine');
  });

  it('/status <id> shows one job and what it waits for; a short id works', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('merge');
    fake.say(CHAT, `/status ${job.id.slice(0, 6)}`);
    await until(() => fake.texts(CHAT).length === 2, 'approval + status');
    const text = fake.texts(CHAT)[1]!;
    expect(text).toContain('awaiting approval');
    expect(text).toContain('Fix the thing');
    expect(text).toContain('Waiting for your merge approval.');
  });

  it('/status says so for an unknown id and for no jobs', async () => {
    const fake = await startFake();
    await boot(fake);
    fake.say(CHAT, '/status');
    fake.say(CHAT, '/status deadbeef');
    await until(() => fake.texts(CHAT).length === 2, 'two replies');
    expect(fake.texts(CHAT)).toEqual(['No jobs yet. Try /dev.', 'No job starts with "deadbeef".']);
  });

  it('/history shows the stages of a job', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 'Hist' });
    const s = await b.d.ctx.jobs.startStage(job.id, 'plan');
    await b.d.ctx.jobs.finishStage(s.id, 'passed', {});
    await b.d.ctx.jobs.startStage(job.id, 'critique');
    fake.say(CHAT, `/history ${job.id}`);
    await until(() => fake.texts(CHAT).length === 1, 'history');
    const lines = fake.texts(CHAT)[0]!.split('\n');
    expect(lines[0]).toBe(`${job.id.slice(0, 8)}  queued  Hist`);
    expect(lines[1]).toMatch(/^plan #1  passed  \d+s$/);
    expect(lines[2]).toBe('critique #1  running  ...');
  });

  it('/cancel stops a running job', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 'Stop me' });
    await b.d.ctx.jobs.setStatus(job.id, 'running');
    fake.say(CHAT, `/cancel ${job.id.slice(0, 8)}`);
    await until(async () => (await b.d.ctx.jobs.get(job.id))!.status === 'cancelled', 'cancelled');
    await until(() => fake.texts(CHAT).some((t) => t.includes('cancelled. A stage')), 'reply');
  });

  it('/cancel on a job waiting for approval takes the deny path', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('plan');
    fake.say(CHAT, `/cancel ${job.id}`);
    await until(() => b.d.seen.length === 1, 'denied event');
    expect(b.d.seen[0]).toMatchObject({ type: 'approval.denied', payload: { jobId: job.id, kind: 'plan' } });
  });

  it('/cancel on a finished job changes nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 'Done' });
    await b.d.ctx.jobs.setStatus(job.id, 'done');
    fake.say(CHAT, `/cancel ${job.id}`);
    await until(() => fake.texts(CHAT).some((t) => t.includes('already done')), 'reply');
    expect((await b.d.ctx.jobs.get(job.id))!.status).toBe('done');
  });

  it('/cancel with no id stops the only active job', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const old = await b.d.ctx.jobs.create({ repo: '/r', title: 'Old' });
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    const job = await b.d.ctx.jobs.create({ repo: '/r', title: 'Active' });
    await b.d.ctx.jobs.setStatus(job.id, 'running');
    fake.say(CHAT, '/cancel');
    await until(async () => (await b.d.ctx.jobs.get(job.id))!.status === 'cancelled', 'cancelled');
    expect((await b.d.ctx.jobs.get(old.id))!.status).toBe('failed');
    await until(() => replies(fake).some((t) => t.includes(`Job ${job.id.slice(0, 8)} cancelled`)), 'reply');
  });

  it('/cancel with no id and no active job says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const j = await b.d.ctx.jobs.create({ repo: '/r', title: 'Old' });
    await b.d.ctx.jobs.setStatus(j.id, 'done');
    fake.say(CHAT, '/cancel');
    await until(() => replies(fake).length === 1, 'reply');
    expect(replies(fake)[0]).toBe('No active jobs to cancel.');
  });

  it('/cancel with no id and several active jobs lists them and cancels none', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const x = await b.d.ctx.jobs.create({ repo: '/r', title: 'Ex' });
    const y = await b.d.ctx.jobs.create({ repo: '/r', title: 'Why' });
    await b.d.ctx.jobs.setStatus(x.id, 'running');
    fake.say(CHAT, '/cancel');
    await until(() => replies(fake).length === 1, 'reply');
    const lines = replies(fake)[0]!.split('\n');
    expect(lines[0]).toBe('2 jobs are active. Send /cancel <jobId> with one of these:');
    expect(lines[1]).toContain(`${y.id.slice(0, 8)}`);
    expect(lines[2]).toContain(`${x.id.slice(0, 8)}`);
    expect((await b.d.ctx.jobs.get(x.id))!.status).toBe('running');
    expect((await b.d.ctx.jobs.get(y.id))!.status).toBe('queued');
  });

  it('/cancel with an unknown or ambiguous id changes nothing and says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    // 17 ids and 16 possible first characters: two of them share one.
    const ids = await Promise.all(Array.from({ length: 17 }, async (_, i) => (await b.d.ctx.jobs.create({ repo: '/r', title: `J${i}` })).id));
    const first = ids.map((id) => id[0]!).find((c, i, all) => all.indexOf(c) !== i)!;
    const shared = ids.filter((id) => id.startsWith(first)).length;
    fake.say(CHAT, '/cancel nope');
    fake.say(CHAT, `/cancel ${first}`);
    await until(() => replies(fake).length === 2, 'two replies');
    expect(replies(fake)[0]).toBe('No job starts with "nope".');
    expect(replies(fake)[1]).toBe(`"${first}" matches ${shared} jobs. Send more of the id.`);
    expect((await b.d.ctx.jobs.list()).every((j) => j.status === 'queued')).toBe(true);
  });

  it('/cancel on a cancelled or failed job says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const c = await b.d.ctx.jobs.create({ repo: '/r', title: 'C' });
    await b.d.ctx.jobs.setStatus(c.id, 'cancelled');
    const f = await b.d.ctx.jobs.create({ repo: '/r', title: 'F' });
    await b.d.ctx.jobs.setStatus(f.id, 'failed');
    fake.say(CHAT, `/cancel ${c.id}`);
    fake.say(CHAT, `/cancel ${f.id.slice(0, 8)}`);
    await until(() => replies(fake).length === 2, 'replies');
    expect(replies(fake)).toEqual([`Job ${c.id.slice(0, 8)} is already cancelled.`, `Job ${f.id.slice(0, 8)} is already failed.`]);
  });

  it('/retry starts a new job from a failed job: same repo, title and issue text, with a new id', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo } });
    fake.say(CHAT, '/dev app Add multiply\nWrite src/multiply.js');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job');
    const old = (await b.d.ctx.jobs.list())[0]!;
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(CHAT, `/retry ${old.id.slice(0, 8)}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    expect(fresh.id).not.toBe(old.id);
    expect({ repo: fresh.repo, title: fresh.title, body: fresh.body }).toEqual({ repo, title: 'Add multiply', body: 'Write src/multiply.js' });
    expect((await b.d.ctx.jobs.get(old.id))!.status).toBe('failed');
    expect(await b.d.ctx.jobs.stages(fresh.id)).toEqual([]);
    await until(() => replies(fake).length === 2, 'reply');
    const reply = replies(fake)[1]!;
    expect(reply).toContain(`Job ${fresh.id.slice(0, 8)} started from ${old.id.slice(0, 8)}`);
    expect(reply).toContain('Repo app.');
    expect(reply).toContain('plan approval');
  });

  it('/retry works on a cancelled job too', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake);
    const old = await b.d.ctx.jobs.create({ repo, title: 'Stopped' });
    await b.d.ctx.jobs.setStatus(old.id, 'cancelled');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    expect((await b.d.ctx.jobs.list())[1]).toMatchObject({ repo, title: 'Stopped', status: 'queued' });
  });

  it('/retry refuses a done job, and a job that is still running, queued or waiting for approval', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake);
    const done = await b.d.ctx.jobs.create({ repo, title: 'D' });
    await b.d.ctx.jobs.setStatus(done.id, 'done');
    const running = await b.d.ctx.jobs.create({ repo, title: 'R' });
    await b.d.ctx.jobs.setStatus(running.id, 'running');
    const queued = await b.d.ctx.jobs.create({ repo, title: 'Q' });
    const waiting = await b.d.waitForApproval('plan');
    fake.say(CHAT, `/retry ${done.id}`);
    fake.say(CHAT, `/retry ${running.id}`);
    fake.say(CHAT, `/retry ${queued.id}`);
    fake.say(CHAT, `/retry ${waiting.id}`);
    await until(() => replies(fake).length === 5, 'four refusals and a card');
    const texts = replies(fake).filter((t) => !t.includes('approval needed'));
    expect(texts[0]).toContain('is done, so there is nothing to retry');
    expect(texts[1]).toContain('is still running');
    expect(texts[2]).toContain('is still queued');
    expect(texts[3]).toContain('is still awaiting approval');
    expect(texts[3]).toContain(`/cancel ${waiting.id.slice(0, 8)}`);
    expect(await b.d.ctx.jobs.list()).toHaveLength(4);
  });

  it('/retry with no id, an unknown id, or a repo that is gone creates nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const gone = await b.d.ctx.jobs.create({ repo: '/no/such/folder', title: 'Gone' });
    await b.d.ctx.jobs.setStatus(gone.id, 'failed');
    fake.say(CHAT, '/retry');
    fake.say(CHAT, '/retry deadbeef');
    fake.say(CHAT, `/retry ${gone.id}`);
    await until(() => replies(fake).length === 3, 'replies');
    expect(replies(fake)[0]).toBe('Usage: /retry <jobId>');
    expect(replies(fake)[1]).toBe('No job starts with "deadbeef".');
    expect(replies(fake)[2]).toContain('is not on this machine any more');
    expect(await b.d.ctx.jobs.list()).toHaveLength(1);
  });

  it('/retry is ignored from a stranger and from a chat member who is not allowed', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { allowedUserIds: [1] });
    const old = await b.d.ctx.jobs.create({ repo, title: 'F' });
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(STRANGER, `/retry ${old.id}`);
    fake.say(STRANGER, `/cancel ${old.id}`);
    fake.say(CHAT, `/retry ${old.id}`, 2);
    fake.say(CHAT, '/help', 1);
    await until(() => replies(fake).length === 1, 'help only');
    expect(fake.texts(STRANGER)).toEqual([]);
    expect(await b.d.ctx.jobs.list()).toHaveLength(1);
  });

  it('/help lists /retry and /cancel with its optional id', async () => {
    const fake = await startFake();
    await boot(fake);
    fake.say(CHAT, '/help');
    await until(() => replies(fake).length === 1, 'help');
    expect(replies(fake)[0]).toContain('/retry <jobId>');
    expect(replies(fake)[0]).toContain('/cancel [jobId]');
  });

  it('answers an unknown command and plain text with a pointer to /help', async () => {
    const fake = await startFake();
    await boot(fake);
    fake.say(CHAT, '/frobnicate');
    fake.say(CHAT, 'hello there');
    await until(() => fake.texts(CHAT).length === 2, 'two replies');
    expect(fake.texts(CHAT)[0]).toContain("I don't know /frobnicate");
    expect(fake.texts(CHAT)[1]).toContain('/help');
  });
});

describe('when Telegram misbehaves', () => {
  it('waits as long as Telegram says after a 429, then carries on', async () => {
    const fake = await startFake();
    const waits: number[] = [];
    fake.fail('sendMessage', { kind: 'status', status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } } });
    await boot(fake, {}, { sleep: async (ms) => void waits.push(ms) });
    fake.say(CHAT, '/help');
    await until(() => fake.of('sendMessage').length === 2, 'retry');
    expect(waits).toEqual([3000]);
    expect(fake.of('sendMessage')[1]!.params.text).toMatch(/Commands/);
  });

  it('backs off and retries after a network error, doubling the wait', async () => {
    const fake = await startFake();
    const waits: number[] = [];
    fake.fail('getUpdates', { kind: 'drop' });
    fake.fail('getUpdates', { kind: 'drop' });
    const b = await boot(fake, {}, { sleep: async (ms) => void waits.push(ms) });
    fake.say(CHAT, '/help');
    await until(() => fake.texts(CHAT).length === 1, 'help after recovery');
    expect(waits).toEqual([1000, 2000]);
    expect(b.errors).toEqual([]);
  });

  it('retries a 5xx from sendMessage', async () => {
    const fake = await startFake();
    fake.fail('sendMessage', { kind: 'status', status: 502, body: { ok: false, description: 'Bad Gateway' } });
    await boot(fake);
    fake.say(CHAT, '/help');
    await until(() => fake.of('sendMessage').length === 2, 'retry');
  });

  it('stops polling and says so when Telegram rejects the token', async () => {
    const fake = await startFake();
    process.env[TOKEN_ENV] = 'wrong-token-xyz';
    const b = await boot(fake);
    await until(() => b.errors.length >= 2, 'errors');
    expect(b.errors.join('\n')).toMatch(/rejected the token/);
    const polls = fake.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.length).toBe(polls);
  });

  it('never puts the token in a log, even when the failure text carries it', async () => {
    const fake = await startFake();
    const failing = (async () => {
      throw new Error(`connect refused at ${fake.apiBase}/bot${fake.token}/getUpdates`);
    }) as unknown as typeof fetch;
    const b = await boot(fake, {}, { fetch: failing, sleep: async () => {} });
    await until(() => b.warnings.length >= 2, 'warnings');
    const all = [...b.warnings, ...b.errors].join('\n');
    expect(all).toContain('<token>');
    expect(all).not.toContain(fake.token);
  });
});

describe('restarts', () => {
  it('remembers the last update, so a restart does not replay old commands', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const dbPath = join(tempDir(), 'bulig.sqlite');
    const first = await boot(fake, { repos: { app: repo } }, { dbPath });
    fake.say(CHAT, '/dev app Only once');
    await until(async () => (await first.d.ctx.jobs.list()).length === 1, 'job');
    await until(() => fake.of('getUpdates').some((c) => c.params.offset !== undefined), 'offset sent');
    const lastSeen = Math.max(...fake.of('getUpdates').map((c) => c.params.offset ?? 0));
    await shutdown(first);
    expect(await new SqliteStore(dbPath).getState('channel-telegram', 'offset')).toBe(lastSeen);

    const before = fake.of('getUpdates').length;
    const second = await boot(fake, { repos: { app: repo } }, { dbPath });
    await until(() => fake.of('getUpdates').length > before, 'poll after restart');
    expect(fake.of('getUpdates')[before]!.params.offset).toBe(lastSeen);
    expect(await second.d.ctx.jobs.list()).toHaveLength(1);
  });

  it('does not run a command twice when the process died before Telegram heard the offset', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const dbPath = join(tempDir(), 'bulig.sqlite');
    // Simulate the crash: Telegram still holds update 100 unacknowledged, but our store already moved on.
    fake.say(CHAT, '/dev app Crash window');
    const seed = new SqliteStore(dbPath);
    await seed.setState('channel-telegram', 'offset', 101);
    await seed.close();
    const b = await boot(fake, { repos: { app: repo } }, { dbPath });
    fake.say(CHAT, '/help');
    await until(() => fake.texts(CHAT).length === 1, 'help');
    expect(await b.d.ctx.jobs.list()).toEqual([]);
  });
});

describe('per-user approvals in a group chat', () => {
  const MEMBER = 222; // in the chat, not in allowedUserIds
  const OWNER = 111;

  it('warns at start when allowedUserIds is not set', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    expect(b.warnings.some((w) => /allowedUserIds is not set/.test(w))).toBe(true);
  });

  it('does not warn when allowedUserIds is set, and rejects an empty list', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    expect(b.warnings.some((w) => /allowedUserIds/.test(w))).toBe(false);
    await expect(boot(fake, { allowedUserIds: [] })).rejects.toThrow(/allowedUserIds/);
  });

  it('a chat member who is not allowed taps Approve: rejected with a message, nothing emitted, buttons left alone', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`, { id: MEMBER, username: 'member' });
    await until(() => fake.of('answerCallbackQuery').length === 1, 'answer');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toMatch(/not allowed/);
    expect(fake.of('editMessageText')).toEqual([]);
    expect(b.d.seen).toEqual([]);
    expect((await b.d.ctx.jobs.get(job.id))!.status).toBe('awaiting_approval');
    expect(b.warnings.some((w) => w.includes(`user ${MEMBER}`))).toBe(true);
  });

  it('Deny from a member who is not allowed is rejected the same way', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    const job = await b.d.waitForApproval('merge');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `dn:${job.id}:merge`, { id: MEMBER });
    await until(() => fake.of('answerCallbackQuery').length === 1, 'answer');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toMatch(/not allowed/);
    expect(b.d.seen).toEqual([]);
  });

  it('an allowed user can still approve in the same chat', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`, { id: OWNER, username: 'owner' });
    await until(() => fake.of('editMessageText').length === 1, 'edit');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toBe('Approved');
    expect(b.d.seen.map((e) => e.type)).toEqual(['approval.granted']);
  });

  it('commands from a member who is not allowed are ignored, including /cancel', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    fake.say(CHAT, `/cancel ${job.id}`, MEMBER);
    fake.say(CHAT, '/help', OWNER);
    await until(() => fake.texts().length === 2, 'help for the owner');
    expect(b.d.seen).toEqual([]);
    expect((await b.d.ctx.jobs.get(job.id))!.status).toBe('awaiting_approval');
  });

  it('without allowedUserIds, any member of an allowed chat can still approve (the fallback)', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = await b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`, { id: MEMBER });
    await until(() => fake.of('editMessageText').length === 1, 'edit');
    expect(b.d.seen.map((e) => e.type)).toEqual(['approval.granted']);
  });
});

describe('stage.checked lines', () => {
  const ev = (payload: unknown) => ({ id: 'e', type: 'stage.checked', payload, jobId: 'abcdef1234567890', source: 'test', at: '2026-01-01T00:00:00Z' });

  it('shows unverified claims, flattened and clipped, and is silent when there are none', () => {
    expect(progressLine(ev({ stage: 'build', unverified: [], evidenceSummary: 'Evidence this turn: 2 read' }))).toBeUndefined();
    const text = progressLine(ev({ stage: 'build', unverified: [`Unverified: no record of a test run this turn\n\n("${'x'.repeat(500)}")`], evidenceSummary: 'Evidence this turn: no tool calls recorded' }))!;
    expect(text).toContain('[abcdef12] build has claims with no evidence:');
    expect(text).toContain('- Unverified: no record of a test run this turn ("xxx');
    expect(text.split('\n')).toHaveLength(3);
    expect(text.length).toBeLessThan(500);
  });
});

describe('/retry does not start a second job for the same one', () => {
  const failedJob = async (title = 'Add multiply', now?: () => number) => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo }, allowedChatIds: [CHAT, 5151] }, now ? { now } : {});
    const old = await b.d.ctx.jobs.create({ repo, title });
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    return { fake, repo, b, old };
  };

  it('a second /retry is refused, naming the job that already retried it and its state', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    await b.d.ctx.jobs.setStatus(fresh.id, 'running');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 2, 'refusal');
    expect(replies(fake)[1]).toBe(`Job ${fresh.id.slice(0, 8)} already retried this one and is running. Use /status ${fresh.id.slice(0, 8)}.`);
    expect(await b.d.ctx.jobs.list()).toHaveLength(2);
  });

  it('is refused while the retry is queued or waiting for approval', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 2, 'queued refusal');
    expect(replies(fake)[1]).toContain('already retried this one and is queued');
    await b.d.ctx.jobs.setStatus(fresh.id, 'running');
    await b.d.ctx.jobs.startStage(fresh.id, 'approve-plan');
    await b.d.ctx.jobs.setStatus(fresh.id, 'awaiting_approval');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 3, 'approval refusal');
    expect(replies(fake)[2]).toContain('already retried this one and is awaiting approval');
    expect(await b.d.ctx.jobs.list()).toHaveLength(2);
  });

  it('is refused after the retry is done', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    await b.d.ctx.jobs.setStatus((await b.d.ctx.jobs.list())[1]!.id, 'done');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 2, 'refusal');
    expect(replies(fake)[1]).toContain('already retried this one and is done');
    expect(await b.d.ctx.jobs.list()).toHaveLength(2);
  });

  it('is allowed again once every earlier retry failed, and once it was cancelled', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'first retry');
    await b.d.ctx.jobs.setStatus((await b.d.ctx.jobs.list())[1]!.id, 'failed');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 3, 'second retry');
    await b.d.ctx.jobs.setStatus((await b.d.ctx.jobs.list())[2]!.id, 'cancelled');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 4, 'third retry');
    // The third is live, so a fourth is refused and names the third, not an earlier ended one.
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 4, 'refusal');
    expect(replies(fake)[3]).toContain(`Job ${(await b.d.ctx.jobs.list())[3]!.id.slice(0, 8)} already retried this one and is queued`);
    expect(await b.d.ctx.jobs.list()).toHaveLength(4);
  });

  it('a retry of a failed retry links to the retry (a chain), and the original is still guarded', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'first retry');
    const first = (await b.d.ctx.jobs.list())[1]!;
    await b.d.ctx.jobs.setStatus(first.id, 'failed');
    fake.say(CHAT, `/retry ${first.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 3, 'chained retry');
    const second = (await b.d.ctx.jobs.list())[2]!;
    // The job exists before the reply is sent, so wait for the reply itself.
    await until(() => replies(fake).length === 2, 'chained reply');
    expect(replies(fake)[1]).toContain(`Job ${second.id.slice(0, 8)} started from ${first.id.slice(0, 8)}`);
    fake.say(CHAT, `/retry ${first.id}`);
    await until(() => replies(fake).length === 3, 'refusal');
    expect(replies(fake)[2]).toContain(`Job ${second.id.slice(0, 8)} already retried this one`);
    expect(await b.d.ctx.jobs.list()).toHaveLength(3);
  });

  it('the link is kept in plugin state and survives a restart', async () => {
    const { fake, b, old } = await failedJob();
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retried job');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    await shutdown(b);
    const b2 = await boot(fake, {}, { dbPath: b.dbPath });
    await b2.d.ctx.jobs.setStatus(fresh.id, 'running');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => replies(fake).length === 2, 'refusal after restart');
    expect(replies(fake)[1]).toContain('already retried this one and is running');
    expect(await b2.d.ctx.jobs.list()).toHaveLength(2);
    expect(await new SqliteStore(b.dbPath).getState('channel-telegram', `retry-of:${fresh.id}`)).toBe(old.id);
  });

  it('another chat cannot see the retry, and /status is unchanged', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const OTHER = 5151;
    const b = await boot(fake, { allowedChatIds: [CHAT, OTHER], repos: { app: repo } });
    fake.say(CHAT, '/dev app Mine');
    await until(async () => (await b.d.ctx.jobs.list()).length === 1, 'job');
    const old = (await b.d.ctx.jobs.list())[0]!;
    await b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retry');
    const fresh = (await b.d.ctx.jobs.list())[1]!;
    fake.say(OTHER, `/retry ${old.id}`);
    fake.say(OTHER, `/retry ${fresh.id}`);
    await until(() => fake.texts(OTHER).length === 2, 'other chat replies');
    for (const t of fake.texts(OTHER)) {
      expect(t).toContain('No job starts with');
      expect(t).not.toContain('already retried');
    }
    fake.say(CHAT, `/status ${old.id.slice(0, 8)}`);
    await until(() => replies(fake).length === 3, 'status');
    expect(replies(fake)[2]).toMatch(new RegExp(`^${old.id.slice(0, 8)}  failed  \\d+s\nMine\n`));
    expect(await b.d.ctx.jobs.list()).toHaveLength(2);
  });

  describe('a failure between creating the retry and saving its link', () => {
    /** Make the first write of a link fail (`retry-of:` by default), the way a crash or a full disk between the steps would. */
    const breakLinkOnce = (prefix = 'retry-of:') => {
      const original = SqliteStore.prototype.setState;
      let armed = true;
      const spy = vi.spyOn(SqliteStore.prototype, 'setState').mockImplementation(function (this: SqliteStore, plugin: string, key: string, value: unknown) {
        if (armed && key.startsWith(prefix)) {
          armed = false;
          throw new Error('simulated crash before the link was saved');
        }
        return original.call(this, plugin, key, value);
      });
      return spy;
    };
    afterEach(() => vi.restoreAllMocks());
    /**
     * Wait for the millisecond clock to move on. Job times and the retry-pending mark are ISO strings to the millisecond,
     * and a job made in the same millisecond as the mark counts as made after it. A same-title job made just before a
     * /retry must be strictly older than the mark, or the plugin may adopt it as the retry.
     */
    const nextMs = async () => {
      const start = new Date().toISOString();
      while (new Date().toISOString() === start) await new Promise((r) => setTimeout(r, 1));
    };

    it('the next /retry finds the job that was already created and refuses', async () => {
      const { fake, b, old } = await failedJob();
      breakLinkOnce();
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      expect(replies(fake)[0]).toContain('Could not start the job');
      expect(await b.d.ctx.jobs.list()).toHaveLength(2); // the job exists, with no link
      const orphan = (await b.d.ctx.jobs.list())[1]!;
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 2, 'refusal');
      expect(replies(fake)[1]).toContain(`Job ${orphan.id.slice(0, 8)} already retried this one and is queued`);
      expect(await b.d.ctx.jobs.list()).toHaveLength(2);
    });

    it('also after a restart, and the job gets the links it missed', async () => {
      const { fake, b, old } = await failedJob();
      breakLinkOnce();
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      const orphan = (await b.d.ctx.jobs.list())[1]!;
      await shutdown(b);
      const b2 = await boot(fake, {}, { dbPath: b.dbPath });
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 2, 'refusal after restart');
      expect(replies(fake)[1]).toContain(`Job ${orphan.id.slice(0, 8)} already retried this one`);
      expect(await b2.d.ctx.jobs.list()).toHaveLength(2);
      const store = new SqliteStore(b.dbPath);
      expect(await store.getState('channel-telegram', `retry-of:${orphan.id}`)).toBe(old.id);
      expect(await store.getState('channel-telegram', `chat:${orphan.id}`)).toBe(CHAT);
    });

    it('a failure before the job was created blocks nothing: the next /retry starts one', async () => {
      const { fake, b, old } = await failedJob();
      const original = SqliteStore.prototype.createJob;
      let armed = true;
      vi.spyOn(SqliteStore.prototype, 'createJob').mockImplementation(function (this: SqliteStore, input) {
        if (armed) {
          armed = false;
          throw new Error('simulated crash before the job was created');
        }
        return original.call(this, input);
      });
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      expect(await b.d.ctx.jobs.list()).toHaveLength(1);
      fake.say(CHAT, `/retry ${old.id}`);
      await until(async () => (await b.d.ctx.jobs.list()).length === 2, 'retry after the failure');
      await until(() => replies(fake).length === 2, 'started reply');
      expect(replies(fake)[1]).toContain('started from');
    });

    it('a failure on any one of the link writes still leaves the second /retry refused', async () => {
      for (const prefix of ['retries:', 'retry-of:', 'chat:']) {
        const { fake, b, old } = await failedJob(`Add ${prefix}`);
        breakLinkOnce(prefix);
        fake.say(CHAT, `/retry ${old.id}`);
        await until(() => replies(fake).length === 1, `failure reply (${prefix})`);
        expect(await b.d.ctx.jobs.list(), prefix).toHaveLength(2);
        const orphan = (await b.d.ctx.jobs.list())[1]!;
        fake.say(CHAT, `/retry ${old.id}`);
        await until(() => replies(fake).length === 2, `refusal (${prefix})`);
        expect(replies(fake)[1], prefix).toContain(`Job ${orphan.id.slice(0, 8)} already retried this one`);
        expect(await b.d.ctx.jobs.list(), prefix).toHaveLength(2);
        vi.restoreAllMocks();
      }
    });

    it('a handled failure of the create itself leaves no mark, so a lookalike job made later is not taken for the retry', async () => {
      const { fake, b, old } = await failedJob();
      const original = SqliteStore.prototype.createJob;
      let armed = true;
      vi.spyOn(SqliteStore.prototype, 'createJob').mockImplementation(function (this: SqliteStore, input) {
        if (armed) {
          armed = false;
          throw new Error('simulated handled failure of create');
        }
        return original.call(this, input);
      });
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      const lookalike = await b.d.ctx.jobs.create({ repo: old.repo, title: old.title });
      await b.d.ctx.jobs.setStatus(lookalike.id, 'running');
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 2, 'second reply');
      expect(replies(fake)[1]).toContain('started from');
      expect(replies(fake)[1]).not.toContain('already retried');
      expect(await b.d.ctx.jobs.list()).toHaveLength(3);
    });

    // Every point where the first attempt can fail, then a second /retry after some time, in the same process or after a restart.
    // The clock is moved to show that age changes nothing: a job that may be an orphan is never answered with a second job.
    type Point = { name: string; setState?: { prefix: string; nth: number }; create?: boolean; orphan: boolean };
    const POINTS: Point[] = [
      { name: 'the mark write fails (no job)', setState: { prefix: 'retry-pending:', nth: 1 }, orphan: false },
      { name: 'create throws (no job)', create: true, orphan: false },
      { name: 'create throws and clearing the mark fails (no job, mark left)', create: true, setState: { prefix: 'retry-pending:', nth: 2 }, orphan: false },
      { name: 'the retries write fails (job, nothing linked)', setState: { prefix: 'retries:', nth: 1 }, orphan: true },
      { name: 'the retry-of write fails (job, listed)', setState: { prefix: 'retry-of:', nth: 1 }, orphan: true },
      { name: 'the chat write fails (job, listed and linked)', setState: { prefix: 'chat:', nth: 1 }, orphan: true },
      { name: 'clearing the mark fails after linking (job, linked, mark left)', setState: { prefix: 'retry-pending:', nth: 2 }, orphan: true },
    ];
    const ELAPSED: [string, number][] = [['1 s', 1000], ['10 min', 10 * 60_000], ['10 min + 1 ms', 10 * 60_000 + 1], ['3 h', 3 * 3600_000]];
    for (const point of POINTS) {
      for (const [label, ms] of ELAPSED) {
        for (const restart of [false, true]) {
          it(`${point.name}; second /retry after ${label}${restart ? ' and a restart' : ''}: ${point.orphan ? 'refused, no second job' : 'starts the one job'}`, async () => {
            const clock = { t: Date.now() };
            const { fake, b, old } = await failedJob('Add multiply', () => clock.t);
            const originalSet = SqliteStore.prototype.setState;
            const originalCreate = SqliteStore.prototype.createJob;
            let seen = 0;
            vi.spyOn(SqliteStore.prototype, 'setState').mockImplementation(function (this: SqliteStore, plugin: string, key: string, value: unknown) {
              if (point.setState && key.startsWith(point.setState.prefix) && ++seen === point.setState.nth) throw new Error('simulated failure');
              return originalSet.call(this, plugin, key, value);
            });
            let createArmed = !!point.create;
            vi.spyOn(SqliteStore.prototype, 'createJob').mockImplementation(function (this: SqliteStore, input) {
              if (createArmed) {
                createArmed = false;
                throw new Error('simulated failure of create');
              }
              return originalCreate.call(this, input);
            });
            fake.say(CHAT, `/retry ${old.id}`);
            await until(() => replies(fake).length === 1, 'failure reply');
            expect(replies(fake)[0]).toContain('Could not start the job');
            const afterFirst = await b.d.ctx.jobs.list();
            expect(afterFirst).toHaveLength(point.orphan ? 2 : 1);
            clock.t += ms;
            let live = b;
            if (restart) {
              await shutdown(b);
              live = await boot(fake, {}, { dbPath: b.dbPath, now: () => clock.t });
            }
            fake.say(CHAT, `/retry ${old.id}`);
            await until(() => replies(fake).length === 2, 'second reply');
            expect(await live.d.ctx.jobs.list()).toHaveLength(2);
            if (point.orphan) expect(replies(fake)[1]).toContain(`Job ${afterFirst[1]!.id.slice(0, 8)} already retried this one`);
            else expect(replies(fake)[1]).toContain('started from');
          });
        }
      }
    }

    it('if the check for an earlier attempt itself fails, it refuses and says to look at /status, and creates nothing', async () => {
      const { fake, b, old } = await failedJob();
      const original = SqliteStore.prototype.setState;
      let fails = 2; // the first attempt's links write, then the check's own write
      vi.spyOn(SqliteStore.prototype, 'setState').mockImplementation(function (this: SqliteStore, plugin: string, key: string, value: unknown) {
        if (key.startsWith('retries:') && fails-- > 0) throw new Error('simulated failure');
        return original.call(this, plugin, key, value);
      });
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 2, 'refusal');
      expect(replies(fake)[1]).toContain('/status');
      expect(await b.d.ctx.jobs.list()).toHaveLength(2);
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 3, 'healed refusal');
      expect(replies(fake)[2]).toContain('already retried this one');
      expect(await b.d.ctx.jobs.list()).toHaveLength(2);
    });

    it('a retry still pending for one job does not get in the way of another job with the same title, and is not mixed up with it', async () => {
      const { fake, b, old } = await failedJob();
      const other = await b.d.ctx.jobs.create({ repo: old.repo, title: old.title });
      await b.d.ctx.jobs.setStatus(other.id, 'failed');
      await nextMs();
      breakLinkOnce('retries:');
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      const orphan = (await b.d.ctx.jobs.list()).find((j) => j.id !== old.id && j.id !== other.id)!;
      fake.say(CHAT, `/retry ${other.id}`);
      await until(() => replies(fake).length === 2, 'retry of the other job');
      expect(replies(fake)[1]).toContain(`started from ${other.id.slice(0, 8)}`);
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 3, 'retry of the first again');
      expect(replies(fake)[2]).toContain(`Job ${orphan.id.slice(0, 8)} already retried this one`);
      expect(await b.d.ctx.jobs.list()).toHaveLength(4);
    });

    it('an unrelated job with the same title, made before the failed attempt, is not taken for the retry', async () => {
      const { fake, b, old } = await failedJob();
      const lookalike = await b.d.ctx.jobs.create({ repo: old.repo, title: old.title });
      await b.d.ctx.jobs.setStatus(lookalike.id, 'running');
      await nextMs();
      breakLinkOnce();
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 1, 'failure reply');
      const orphan = (await b.d.ctx.jobs.list()).find((j) => j.id !== old.id && j.id !== lookalike.id)!;
      fake.say(CHAT, `/retry ${old.id}`);
      await until(() => replies(fake).length === 2, 'refusal');
      expect(replies(fake)[1]).toContain(`Job ${orphan.id.slice(0, 8)} already retried this one`);
      expect(replies(fake)[1]).not.toContain(lookalike.id.slice(0, 8));
    });
  });
});

describe('chunkLines', () => {
  const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
  it('breaks between lines, and inside a long line without splitting an emoji, wherever the limit falls', async () => {
    const { chunkLines } = await import('../src/index.ts');
    expect(chunkLines(['aaa', 'bbb', 'cc'], 7)).toEqual(['aaa\nbbb', 'cc']);
    expect(chunkLines([''], 5)).toEqual([]);
    const robot = '\u{1F916}';
    for (const max of [3, 4, 5, 6, 7, 10]) {
      const lines = [`ab${robot}cd${robot}${robot}ef${robot}`, 'x'];
      const pieces = chunkLines(lines, max);
      expect(pieces.every((p) => !lone(p))).toBe(true);
      expect(pieces.join('\n').replace(/\n/g, '')).toBe(lines.join(''));
    }
    // A limit smaller than one emoji still makes progress.
    expect(chunkLines([robot + robot], 1).join('')).toBe(robot + robot);
  });
});

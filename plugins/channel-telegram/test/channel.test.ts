import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@bulig/core';
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
    expect(b.d.ctx.jobs.list()).toEqual([]);
    expect(b.warnings.filter((w) => w.includes(`chat ${STRANGER}`))).toHaveLength(2);
  });

  it('ignores button presses from a stranger', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.waitForApproval('plan');
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
    await until(() => b.d.ctx.jobs.list().length === 1, 'job created');
    const [job] = b.d.ctx.jobs.list();
    expect(job).toMatchObject({ repo, title: 'Add multiply', body: 'Add src/multiply.js.\nWith tests.' });
    await until(() => fake.texts(CHAT).some((t) => t.includes('started: Add multiply')), 'started reply');
    expect(fake.texts(CHAT).join('\n')).toContain(job!.id.slice(0, 8));
  });

  it('accepts the @botname form that groups use', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { repos: { app: repo } });
    fake.say(CHAT, '/dev@bulig_bot app Group style');
    await until(() => b.d.ctx.jobs.list().length === 1, 'job created');
    expect(b.d.ctx.jobs.list()[0]!.title).toBe('Group style');
  });

  it('lists the known aliases when the alias is unknown, and creates nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir(), site: tempDir() } });
    fake.say(CHAT, '/dev nope Do something');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('"nope"');
    expect(fake.texts(CHAT)[0]).toContain('Known repos: app, site');
    expect(b.d.ctx.jobs.list()).toEqual([]);
  });

  it('does not treat built-in object names as aliases', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir() } });
    fake.say(CHAT, '/dev constructor Sneaky');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('Known repos: app');
    expect(b.d.ctx.jobs.list()).toEqual([]);
  });

  it('explains usage when the title is missing', async () => {
    const fake = await startFake();
    const b = await boot(fake, { repos: { app: tempDir() } });
    fake.say(CHAT, '/dev app');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toMatch(/Usage: \/dev app <title>/);
    expect(b.d.ctx.jobs.list()).toEqual([]);
  });

  it('says so when the repo path is not on this machine', async () => {
    const fake = await startFake();
    const gone = join(tempDir(), 'missing');
    const b = await boot(fake, { repos: { app: gone } });
    fake.say(CHAT, '/dev app Do it');
    await until(() => fake.texts(CHAT).length === 1, 'reply');
    expect(fake.texts(CHAT)[0]).toContain('does not exist');
    expect(b.d.ctx.jobs.list()).toEqual([]);
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
    b.d.waitForApproval('plan', { scope: ['README.md', 'src/lib/*.ts', 'docs/my notes.md'] });
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
    b.d.waitForApproval('plan', { scope });
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
    b.d.waitForApproval('plan', { scope });
    await until(() => fake.texts().some((t) => /no buttons/.test(t)), 'the notice that the buttons were withheld');
    const sent = fake.of('sendMessage').map((m) => m.params);
    expect(sent.some((m) => m.reply_markup !== undefined)).toBe(false);
    expect(sent.some((m) => String(m.text).includes('plan text, after the list above'))).toBe(false);
  });

  it('a merge card does not show a scope list', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    b.d.waitForApproval('merge', { url: 'https://example.test/pull/7', scope: ['README.md'] });
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    expect(String(fake.of('sendMessage')[0]!.params.text)).not.toContain('Files this job may change');
  });

  it('shows Approve and Deny buttons carrying the job and the kind', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.waitForApproval('merge', { url: 'https://example.test/pull/7' });
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
    const job = b.d.waitForApproval('plan');
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
    const job = b.d.waitForApproval('merge');
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
    const job = b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    // The pipeline has moved on: the approval stage is closed and the job is running again.
    for (const s of b.d.ctx.jobs.stages(job.id)) b.d.ctx.jobs.finishStage(s.id, 'passed');
    b.d.ctx.jobs.setStatus(job.id, 'running');
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    const tag = `[${job.id.slice(0, 8)}]`;
    b.d.ctx.jobs.setStatus(job.id, 'running'); // silent
    b.d.ctx.emit('stage.completed', { stage: 'plan', costUsd: 0.1234, result: 'x' }, job.id);
    b.d.ctx.emit('stage.completed', { stage: 'test', result: 'all green\nVERDICT: PASS' }, job.id);
    b.d.ctx.emit('stage.failed', { stage: 'build', error: 'boom' }, job.id);
    b.d.ctx.emit('pr.opened', { url: 'https://example.test/pull/9', number: 9, headSha: 'abc' }, job.id);
    b.d.ctx.emit('merge.refused', { reason: 'checks pending' }, job.id);
    b.d.ctx.emit('pr.merged', { number: 9 }, job.id);
    b.d.ctx.jobs.setStatus(job.id, 'done');
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 't' });
    b.d.ctx.emit('pipeline.failed', { reason: 'review failed twice' }, job.id);
    await until(() => fake.texts().length === 1, 'line');
    expect(fake.texts()[0]).toContain('job failed: review failed twice');
  });

  it('names the out-of-scope files when a job fails because of them', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 't' });
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 't' });
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 't' });
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
    await until(() => b.d.ctx.jobs.list().length === 1, 'job');
    const job = b.d.ctx.jobs.list()[0]!;
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
    const a = b.d.ctx.jobs.create({ repo, title: 'First job' });
    const c = b.d.ctx.jobs.create({ repo, title: 'Second job' });
    b.d.ctx.jobs.setStatus(c.id, 'running');
    clock.t += 125_000;
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 1, 'status');
    expect(fake.texts(CHAT)[0]!.split('\n')).toEqual([`${c.id.slice(0, 8)}  app  running  2m  Second job`, `${a.id.slice(0, 8)}  app  queued  2m  First job`]);
  });

  it('/status says what a job waiting on you waits for', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const plan = b.d.waitForApproval('plan');
    const merge = b.d.waitForApproval('merge');
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
    for (let i = 1; i <= 13; i++) b.d.ctx.jobs.create({ repo: '/r', title: `Job ${i}` });
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
    b.d.ctx.jobs.create({ repo: '/r', title: `${'x'.repeat(300)}\n/cancel everything` });
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
    const [mine, theirs] = b.d.ctx.jobs.list();
    fake.say(CHAT, '/status');
    fake.say(CHAT, `/cancel ${theirs!.id}`);
    fake.say(CHAT, `/retry ${theirs!.id}`);
    await until(() => fake.texts(CHAT).length === 4, 'three replies');
    const [, status, cancel, retry] = fake.texts(CHAT);
    expect(status).toContain('Mine');
    expect(status).not.toContain('Theirs');
    expect(cancel).toContain('No job starts with');
    expect(retry).toContain('No job starts with');
    expect(b.d.ctx.jobs.get(theirs!.id)!.status).toBe('queued');
    expect(b.d.ctx.jobs.list()).toHaveLength(2);
    expect(mine!.title).toBe('Mine');
  });

  it('/status <id> shows one job and what it waits for; a short id works', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.waitForApproval('merge');
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 'Hist' });
    const s = b.d.ctx.jobs.startStage(job.id, 'plan');
    b.d.ctx.jobs.finishStage(s.id, 'passed', {});
    b.d.ctx.jobs.startStage(job.id, 'critique');
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
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 'Stop me' });
    b.d.ctx.jobs.setStatus(job.id, 'running');
    fake.say(CHAT, `/cancel ${job.id.slice(0, 8)}`);
    await until(() => b.d.ctx.jobs.get(job.id)!.status === 'cancelled', 'cancelled');
    await until(() => fake.texts(CHAT).some((t) => t.includes('cancelled. A stage')), 'reply');
  });

  it('/cancel on a job waiting for approval takes the deny path', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.waitForApproval('plan');
    fake.say(CHAT, `/cancel ${job.id}`);
    await until(() => b.d.seen.length === 1, 'denied event');
    expect(b.d.seen[0]).toMatchObject({ type: 'approval.denied', payload: { jobId: job.id, kind: 'plan' } });
  });

  it('/cancel on a finished job changes nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 'Done' });
    b.d.ctx.jobs.setStatus(job.id, 'done');
    fake.say(CHAT, `/cancel ${job.id}`);
    await until(() => fake.texts(CHAT).some((t) => t.includes('already done')), 'reply');
    expect(b.d.ctx.jobs.get(job.id)!.status).toBe('done');
  });

  it('/cancel with no id stops the only active job', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const old = b.d.ctx.jobs.create({ repo: '/r', title: 'Old' });
    b.d.ctx.jobs.setStatus(old.id, 'failed');
    const job = b.d.ctx.jobs.create({ repo: '/r', title: 'Active' });
    b.d.ctx.jobs.setStatus(job.id, 'running');
    fake.say(CHAT, '/cancel');
    await until(() => b.d.ctx.jobs.get(job.id)!.status === 'cancelled', 'cancelled');
    expect(b.d.ctx.jobs.get(old.id)!.status).toBe('failed');
    await until(() => replies(fake).some((t) => t.includes(`Job ${job.id.slice(0, 8)} cancelled`)), 'reply');
  });

  it('/cancel with no id and no active job says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const j = b.d.ctx.jobs.create({ repo: '/r', title: 'Old' });
    b.d.ctx.jobs.setStatus(j.id, 'done');
    fake.say(CHAT, '/cancel');
    await until(() => replies(fake).length === 1, 'reply');
    expect(replies(fake)[0]).toBe('No active jobs to cancel.');
  });

  it('/cancel with no id and several active jobs lists them and cancels none', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const x = b.d.ctx.jobs.create({ repo: '/r', title: 'Ex' });
    const y = b.d.ctx.jobs.create({ repo: '/r', title: 'Why' });
    b.d.ctx.jobs.setStatus(x.id, 'running');
    fake.say(CHAT, '/cancel');
    await until(() => replies(fake).length === 1, 'reply');
    const lines = replies(fake)[0]!.split('\n');
    expect(lines[0]).toBe('2 jobs are active. Send /cancel <jobId> with one of these:');
    expect(lines[1]).toContain(`${y.id.slice(0, 8)}`);
    expect(lines[2]).toContain(`${x.id.slice(0, 8)}`);
    expect(b.d.ctx.jobs.get(x.id)!.status).toBe('running');
    expect(b.d.ctx.jobs.get(y.id)!.status).toBe('queued');
  });

  it('/cancel with an unknown or ambiguous id changes nothing and says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    // 17 ids and 16 possible first characters: two of them share one.
    const ids = Array.from({ length: 17 }, (_, i) => b.d.ctx.jobs.create({ repo: '/r', title: `J${i}` }).id);
    const first = ids.map((id) => id[0]!).find((c, i, all) => all.indexOf(c) !== i)!;
    const shared = ids.filter((id) => id.startsWith(first)).length;
    fake.say(CHAT, '/cancel nope');
    fake.say(CHAT, `/cancel ${first}`);
    await until(() => replies(fake).length === 2, 'two replies');
    expect(replies(fake)[0]).toBe('No job starts with "nope".');
    expect(replies(fake)[1]).toBe(`"${first}" matches ${shared} jobs. Send more of the id.`);
    expect(b.d.ctx.jobs.list().every((j) => j.status === 'queued')).toBe(true);
  });

  it('/cancel on a cancelled or failed job says so', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const c = b.d.ctx.jobs.create({ repo: '/r', title: 'C' });
    b.d.ctx.jobs.setStatus(c.id, 'cancelled');
    const f = b.d.ctx.jobs.create({ repo: '/r', title: 'F' });
    b.d.ctx.jobs.setStatus(f.id, 'failed');
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
    await until(() => b.d.ctx.jobs.list().length === 1, 'job');
    const old = b.d.ctx.jobs.list()[0]!;
    b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(CHAT, `/retry ${old.id.slice(0, 8)}`);
    await until(() => b.d.ctx.jobs.list().length === 2, 'retried job');
    const fresh = b.d.ctx.jobs.list()[1]!;
    expect(fresh.id).not.toBe(old.id);
    expect({ repo: fresh.repo, title: fresh.title, body: fresh.body }).toEqual({ repo, title: 'Add multiply', body: 'Write src/multiply.js' });
    expect(b.d.ctx.jobs.get(old.id)!.status).toBe('failed');
    expect(b.d.ctx.jobs.stages(fresh.id)).toEqual([]);
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
    const old = b.d.ctx.jobs.create({ repo, title: 'Stopped' });
    b.d.ctx.jobs.setStatus(old.id, 'cancelled');
    fake.say(CHAT, `/retry ${old.id}`);
    await until(() => b.d.ctx.jobs.list().length === 2, 'retried job');
    expect(b.d.ctx.jobs.list()[1]).toMatchObject({ repo, title: 'Stopped', status: 'queued' });
  });

  it('/retry refuses a done job, and a job that is still running, queued or waiting for approval', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake);
    const done = b.d.ctx.jobs.create({ repo, title: 'D' });
    b.d.ctx.jobs.setStatus(done.id, 'done');
    const running = b.d.ctx.jobs.create({ repo, title: 'R' });
    b.d.ctx.jobs.setStatus(running.id, 'running');
    const queued = b.d.ctx.jobs.create({ repo, title: 'Q' });
    const waiting = b.d.waitForApproval('plan');
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
    expect(b.d.ctx.jobs.list()).toHaveLength(4);
  });

  it('/retry with no id, an unknown id, or a repo that is gone creates nothing', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const gone = b.d.ctx.jobs.create({ repo: '/no/such/folder', title: 'Gone' });
    b.d.ctx.jobs.setStatus(gone.id, 'failed');
    fake.say(CHAT, '/retry');
    fake.say(CHAT, '/retry deadbeef');
    fake.say(CHAT, `/retry ${gone.id}`);
    await until(() => replies(fake).length === 3, 'replies');
    expect(replies(fake)[0]).toBe('Usage: /retry <jobId>');
    expect(replies(fake)[1]).toBe('No job starts with "deadbeef".');
    expect(replies(fake)[2]).toContain('is not on this machine any more');
    expect(b.d.ctx.jobs.list()).toHaveLength(1);
  });

  it('/retry is ignored from a stranger and from a chat member who is not allowed', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const b = await boot(fake, { allowedUserIds: [1] });
    const old = b.d.ctx.jobs.create({ repo, title: 'F' });
    b.d.ctx.jobs.setStatus(old.id, 'failed');
    fake.say(STRANGER, `/retry ${old.id}`);
    fake.say(STRANGER, `/cancel ${old.id}`);
    fake.say(CHAT, `/retry ${old.id}`, 2);
    fake.say(CHAT, '/help', 1);
    await until(() => replies(fake).length === 1, 'help only');
    expect(fake.texts(STRANGER)).toEqual([]);
    expect(b.d.ctx.jobs.list()).toHaveLength(1);
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
    await until(() => first.d.ctx.jobs.list().length === 1, 'job');
    await until(() => fake.of('getUpdates').some((c) => c.params.offset !== undefined), 'offset sent');
    const lastSeen = Math.max(...fake.of('getUpdates').map((c) => c.params.offset ?? 0));
    await shutdown(first);
    expect(new Store(dbPath).getState('channel-telegram', 'offset')).toBe(lastSeen);

    const before = fake.of('getUpdates').length;
    const second = await boot(fake, { repos: { app: repo } }, { dbPath });
    await until(() => fake.of('getUpdates').length > before, 'poll after restart');
    expect(fake.of('getUpdates')[before]!.params.offset).toBe(lastSeen);
    expect(second.d.ctx.jobs.list()).toHaveLength(1);
  });

  it('does not run a command twice when the process died before Telegram heard the offset', async () => {
    const fake = await startFake();
    const repo = tempDir();
    const dbPath = join(tempDir(), 'bulig.sqlite');
    // Simulate the crash: Telegram still holds update 100 unacknowledged, but our store already moved on.
    fake.say(CHAT, '/dev app Crash window');
    const seed = new Store(dbPath);
    seed.setState('channel-telegram', 'offset', 101);
    seed.close();
    const b = await boot(fake, { repos: { app: repo } }, { dbPath });
    fake.say(CHAT, '/help');
    await until(() => fake.texts(CHAT).length === 1, 'help');
    expect(b.d.ctx.jobs.list()).toEqual([]);
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
    const job = b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const sent = fake.of('sendMessage')[0]!.params;
    fake.press(CHAT, sent.__id, sent.text, `ap:${job.id}:plan`, { id: MEMBER, username: 'member' });
    await until(() => fake.of('answerCallbackQuery').length === 1, 'answer');
    expect(fake.of('answerCallbackQuery')[0]!.params.text).toMatch(/not allowed/);
    expect(fake.of('editMessageText')).toEqual([]);
    expect(b.d.seen).toEqual([]);
    expect(b.d.ctx.jobs.get(job.id)!.status).toBe('awaiting_approval');
    expect(b.warnings.some((w) => w.includes(`user ${MEMBER}`))).toBe(true);
  });

  it('Deny from a member who is not allowed is rejected the same way', async () => {
    const fake = await startFake();
    const b = await boot(fake, { allowedUserIds: [OWNER] });
    const job = b.d.waitForApproval('merge');
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
    const job = b.d.waitForApproval('plan');
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
    const job = b.d.waitForApproval('plan');
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    fake.say(CHAT, `/cancel ${job.id}`, MEMBER);
    fake.say(CHAT, '/help', OWNER);
    await until(() => fake.texts().length === 2, 'help for the owner');
    expect(b.d.seen).toEqual([]);
    expect(b.d.ctx.jobs.get(job.id)!.status).toBe('awaiting_approval');
  });

  it('without allowedUserIds, any member of an allowed chat can still approve (the fallback)', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const job = b.d.waitForApproval('plan');
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

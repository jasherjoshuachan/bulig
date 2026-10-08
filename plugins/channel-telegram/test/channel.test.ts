import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@bulig/core';
import { boot, CHAT, shutdown, startFake, tempDir, TOKEN_ENV } from './harness.ts';
import { until } from './fake-telegram.ts';

const STRANGER = 999;

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

  it('a long scope is shortened on the card but says how many more there are', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    b.d.waitForApproval('plan', { scope: Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`) });
    await until(() => fake.of('sendMessage').length === 1, 'approval message');
    const text = String(fake.of('sendMessage')[0]!.params.text);
    expect(text).toContain('- src/f0.ts');
    expect(text).toMatch(/and 15 more/);
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
  it('/status lists the newest jobs first', async () => {
    const fake = await startFake();
    const b = await boot(fake);
    const a = b.d.ctx.jobs.create({ repo: '/r', title: 'First job' });
    const c = b.d.ctx.jobs.create({ repo: '/r', title: 'Second job' });
    b.d.ctx.jobs.setStatus(c.id, 'running');
    fake.say(CHAT, '/status');
    await until(() => fake.texts(CHAT).length === 1, 'status');
    expect(fake.texts(CHAT)[0]!.split('\n')).toEqual([`${c.id.slice(0, 8)}  running  Second job`, `${a.id.slice(0, 8)}  queued  First job`]);
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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import { createCliChannel, format } from '../src/index.ts';

const dirs: string[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ev = (type: string, payload: unknown, jobId = 'abcdef1234567890'): BuligEvent => ({
  id: 'e', type, payload, jobId, source: 'test', at: '2026-01-01T00:00:00Z',
});

describe('format', () => {
  it('prints short, one-line messages with the job tag', () => {
    expect(format(ev('job.status', { from: 'running', to: 'awaiting_approval' }))).toEqual(['[abcdef12] job awaiting approval']);
    expect(format(ev('stage.requested', { stage: 'build', model: 'sonnet', mode: 'edit' }))).toEqual([
      '[abcdef12] build: started (sonnet, edit)',
    ]);
    expect(format(ev('stage.completed', { stage: 'review', costUsd: 0.1234, sessionId: 'sess-123456789' }))).toEqual([
      '[abcdef12] review: done $0.1234 session sess-123',
    ]);
    expect(format(ev('stage.failed', { stage: 'build', error: 'boom' }))).toEqual(['[abcdef12] build: FAILED boom']);
    expect(format(ev('pr.opened', { url: 'https://x/pull/3', number: 3, headSha: '1234567890' }))).toEqual([
      '[abcdef12] PR opened: https://x/pull/3 (head 12345678)',
    ]);
    expect(format(ev('pr.merged', { number: 3 }))).toEqual(['[abcdef12] PR merged (#3)']);
    expect(format(ev('merge.refused', { reason: 'checks pending: ci' }))).toEqual(['[abcdef12] merge refused: checks pending: ci']);
    expect(format(ev('pipeline.failed', { reason: 'review still failing' }))).toEqual(['[abcdef12] job failed: review still failing']);
  });

  it('a plan approval lists the files the job may change, and a failure names the files outside the scope', () => {
    const card = format(ev('approval.requested', { jobId: 'abcdef1234567890', kind: 'plan', summary: 'PLAN\nstep one', scope: ['README.md', 'src/*.ts'] }))!;
    const text = card.join('\n');
    expect(text).toContain('files this job may change');
    expect(text).toContain('- README.md');
    expect(text).toContain('- src/*.ts');
    const failed = format(ev('pipeline.failed', { reason: 'build left files outside the approved scope', outOfScope: ['test-results/.last-run.json'] }))!;
    expect(failed.join('\n')).toContain('outside the approved scope: test-results/.last-run.json');
  });

  it('an approval request shows the summary and the exact commands', () => {
    const lines = format(ev('approval.requested', { jobId: 'abcdef1234567890', kind: 'plan', summary: 'PLAN\nstep one' }))!;
    expect(lines[0]).toBe('[abcdef12] approval needed: plan');
    expect(lines.join('\n')).toContain('| step one');
    expect(lines.join('\n')).toContain('bulig approve abcdef1234567890 plan');
    expect(lines.join('\n')).toContain('bulig deny abcdef1234567890');
  });

  it('says nothing for events it does not know', () => {
    expect(format(ev('job.created', {}))).toBeUndefined();
  });
});

function boot(grants: string[], channel = createCliChannel({ write: () => {} }), extra: ReturnType<typeof definePlugin>[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'bulig-cli-ch-'));
  dirs.push(dir);
  const k = createKernel({
    dbPath: join(dir, 'db.sqlite'),
    plugins: [channel.plugin, ...extra],
    enabled: ['channel-cli', ...extra.map((p) => p.manifest.name)],
    grants: { 'channel-cli': grants },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  kernels.push(k);
  return { k, channel };
}

describe('channel-cli plugin', () => {
  it('prints what the kernel and other plugins announce', async () => {
    const lines: string[] = [];
    const src = definePlugin({
      manifest: { name: 'src', version: '0.1.0', sdk: '0', description: 's', subscribes: ['kernel.started'], emits: ['stage.requested', 'pr.opened'] },
      register(ctx) {
        ctx.on('kernel.started', () => void 0);
        (src as unknown as { emit: typeof ctx.emit }).emit = ctx.emit;
      },
    });
    const { k, channel } = boot(['channel.send:terminal', 'approval.grant'], createCliChannel({ write: (l) => lines.push(l) }), [src]);
    await k.start();
    const job = channel.submit({ repo: '/r', title: 'Add multiply', body: 'details' });
    expect(k.jobs.get(job.id)!.body).toBe('details');
    k.jobs.setStatus(job.id, 'running');
    (src as unknown as { emit: (t: string, p: unknown, j: string) => void }).emit('stage.requested', { stage: 'plan', model: 'opus', mode: 'readonly' }, job.id);
    expect(lines).toEqual([`[${job.id.slice(0, 8)}] job running`, `[${job.id.slice(0, 8)}] plan: started (opus, readonly)`]);
  });

  it('only prints the chosen job when asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulig-cli-ch-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    const make = (channel: ReturnType<typeof createCliChannel>) =>
      createKernel({
        dbPath,
        plugins: [channel.plugin],
        enabled: ['channel-cli'],
        grants: { 'channel-cli': ['channel.send:terminal', 'approval.grant'] },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
    const first = make(createCliChannel({ write: () => {} }));
    await first.start();
    const a = first.jobs.create({ repo: '/r', title: 'a' });
    const b = first.jobs.create({ repo: '/r', title: 'b' });
    await first.stop();

    const lines: string[] = [];
    const second = make(createCliChannel({ write: (l) => lines.push(l), onlyJob: b.id }));
    kernels.push(second);
    await second.start();
    second.jobs.setStatus(a.id, 'running');
    second.jobs.setStatus(b.id, 'running');
    expect(lines).toEqual([`[${b.id.slice(0, 8)}] job running`]);
  });

  it('grant and deny become approval events for the job', async () => {
    const { k, channel } = boot(['channel.send:terminal', 'approval.grant']);
    await k.start();
    const job = channel.submit({ repo: '/r', title: 't' });
    channel.grant(job.id, 'plan');
    channel.deny(job.id);
    const mine = k.history(job.id).filter((e) => e.source === 'channel-cli');
    expect(mine.map((e) => e.type)).toEqual(['approval.granted', 'approval.denied']);
    expect(mine[0]!.payload).toEqual({ jobId: job.id, kind: 'plan' });
  });

  it('will not start without approval.grant, because it emits approvals', async () => {
    const { k } = boot(['channel.send:terminal']);
    await expect(k.start()).rejects.toThrow(/approval\.grant/);
  });

  it('will not start without channel.send:terminal granted', async () => {
    const { k } = boot([]);
    await expect(k.start()).rejects.toThrow(/channel\.send:terminal/);
  });

  it('refuses submit before it is started', () => {
    expect(() => createCliChannel().submit({ repo: '/r', title: 't' })).toThrow(/not started/);
  });
});

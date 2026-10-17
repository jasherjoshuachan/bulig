import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { definePlugin, type BuligEvent, type Plugin, type PluginContext } from '@bulig/plugin-sdk';
import { createTelegramChannel, type TelegramChannelOptions, type TelegramConfig } from '../src/index.ts';
import { FakeTelegram } from './fake-telegram.ts';

export const CHAT = 4242;
export const TOKEN_ENV = 'TEST_BULIG_TG_TOKEN';

const dirs: string[] = [];
const kernels: Kernel[] = [];
const fakes: FakeTelegram[] = [];

beforeEach(() => {
  delete process.env[TOKEN_ENV];
});
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[TOKEN_ENV];
});

export const tempDir = (prefix = 'bulig-tg-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

export async function startFake(): Promise<FakeTelegram> {
  const f = await new FakeTelegram().start();
  fakes.push(f);
  process.env[TOKEN_ENV] = f.token;
  return f;
}

/** A plugin that plays the rest of Bulig: it announces events and records approvals. */
export function driver() {
  const box: { ctx?: PluginContext } = {};
  const seen: BuligEvent[] = [];
  /** Set by a test to act the moment the kernel announces a new job, before the call that created it has returned. */
  const hooks: { created?: (e: BuligEvent) => void } = {};
  const plugin: Plugin = definePlugin({
    manifest: {
      name: 'driver',
      version: '0.1.0',
      sdk: '1',
      description: 'test driver',
      subscribes: ['approval.granted', 'approval.denied', 'cancel.requested', 'job.created'],
      needs: ['jobs.write'],
      emits: ['approval.requested', 'stage.completed', 'stage.failed', 'pr.opened', 'pr.merged', 'merge.refused', 'merge.failed', 'pipeline.failed'],
    },
    register(ctx) {
      box.ctx = ctx;
      ctx.on('job.created', (e) => hooks.created?.(e));
      ctx.on('approval.granted', (e) => void seen.push(e));
      ctx.on('approval.denied', (e) => void seen.push(e));
      // Plays the pipeline, which is the one plugin allowed to end a job.
      ctx.on('cancel.requested', async (e) => {
        if (e.jobId) await ctx.jobs.setStatus(e.jobId, 'cancelled');
      });
    },
  });
  return {
    plugin,
    seen,
    hooks,
    get ctx(): PluginContext {
      return box.ctx!;
    },
    /** Put a job into the state the pipeline leaves it in when it asks for an approval. */
    async waitForApproval(kind: 'plan' | 'merge', extra: Record<string, unknown> = {}) {
      const job = await box.ctx!.jobs.create({ repo: '/r', title: 'Fix the thing' });
      await box.ctx!.jobs.setStatus(job.id, 'running');
      await box.ctx!.jobs.startStage(job.id, `approve-${kind}`);
      await box.ctx!.jobs.setStatus(job.id, 'awaiting_approval');
      box.ctx!.emit('approval.requested', { jobId: job.id, kind, summary: 'PLAN\nDo it', ...extra }, job.id);
      return job;
    },
  };
}

export interface Booted {
  kernel: Kernel;
  d: ReturnType<typeof driver>;
  warnings: string[];
  errors: string[];
  dbPath: string;
}

export async function boot(
  fake: FakeTelegram,
  over: Partial<TelegramConfig> = {},
  opts: TelegramChannelOptions & { dbPath?: string; grants?: boolean } = {},
): Promise<Booted> {
  const d = driver();
  const warnings: string[] = [];
  const errors: string[] = [];
  const dbPath = opts.dbPath ?? join(tempDir(), 'bulig.sqlite');
  const plugin = createTelegramChannel({ ...(opts.fetch && { fetch: opts.fetch }), sleep: opts.sleep ?? (async () => {}), ...(opts.now && { now: opts.now }) });
  const kernel = createKernel({
    dbPath,
    plugins: [d.plugin, plugin],
    enabled: ['driver', 'channel-telegram'],
    grants: opts.grants === false ? {} : { 'channel-telegram': ['channel.send:telegram', 'approval.grant'], driver: ['jobs.write'] },
    pluginConfig: {
      'channel-telegram': {
        tokenEnv: TOKEN_ENV,
        allowedChatIds: [CHAT],
        apiBase: fake.apiBase,
        pollTimeoutSec: 0,
        ...over,
      },
    },
    logger: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error: (m) => void errors.push(m) },
  });
  kernels.push(kernel);
  await kernel.start();
  return { kernel, d, warnings, errors, dbPath };
}

export async function shutdown(b: Booted): Promise<void> {
  await b.kernel.stop();
}

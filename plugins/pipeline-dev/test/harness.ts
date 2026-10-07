import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { definePlugin, type BuligEvent, type Plugin } from '@bulig/plugin-sdk';
import pipeline, { type PipelineConfig } from '../src/index.ts';

const dirs: string[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const newDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-pipe-'));
  dirs.push(d);
  return join(d, 'bulig.sqlite');
};

/** What the fake worker says for a stage. A function sees the prompt and the attempt number for that stage. */
export type Reply = string | ((prompt: string, attempt: number) => string | { fail: string } | 'hang');
export type Script = Record<string, Reply | Reply[]>;

export interface Sent {
  stage: string;
  prompt: string;
  model: string;
  mode: string;
  cwd: string;
  jobId?: string;
}

/** Stands in for worker-claude-code. Every reply gets its own session id. */
export function fakeWorker(script: Script, sent: Sent[]): Plugin {
  const counts: Record<string, number> = {};
  let session = 0;
  return definePlugin({
    manifest: {
      name: 'fake-worker',
      version: '0.1.0',
      sdk: '0',
      description: 'test worker',
      subscribes: ['stage.requested'],
      emits: ['stage.completed', 'stage.failed'],
    },
    register(ctx) {
      ctx.on('stage.requested', (e) => {
        const p = e.payload as Sent;
        sent.push({ ...p, ...(e.jobId && { jobId: e.jobId }) });
        const attempt = (counts[p.stage] = (counts[p.stage] ?? 0) + 1);
        let reply = script[p.stage] ?? 'ok';
        if (Array.isArray(reply)) reply = reply[Math.min(attempt, reply.length) - 1] ?? 'ok';
        const out = typeof reply === 'function' ? reply(p.prompt, attempt) : reply;
        if (out === 'hang') return;
        if (typeof out === 'object') return ctx.emit('stage.failed', { stage: p.stage, error: out.fail }, e.jobId);
        ctx.emit('stage.completed', { stage: p.stage, ok: true, result: out, costUsd: 0.01, sessionId: `s${++session}` }, e.jobId);
      });
    },
  });
}

export interface GithubBehaviour {
  refuseMerge?: (string | undefined)[];
  failWorktree?: string;
  failPr?: string;
  failCommit?: string;
  failReset?: string;
  /** The process dies while the worktree is being reset after a restart. */
  hangReset?: boolean;
  /** The process dies while an edit stage's commit is being made. */
  hangCommit?: boolean;
  /** The merge can never go through, so the job should fail instead of asking again. */
  failMerge?: string;
  /** The process dies after asking for the merge: no answer ever comes back. */
  hangMerge?: boolean;
}

/** Stands in for the github plugin. */
export function fakeGithub(sent: { type: string; payload: unknown }[], b: GithubBehaviour = {}): Plugin {
  let merges = 0;
  let commits = 0;
  return definePlugin({
    manifest: {
      name: 'fake-github',
      version: '0.1.0',
      sdk: '0',
      description: 'test github',
      subscribes: ['worktree.requested', 'worktree.reset.requested', 'worktree.cleanup.requested', 'commit.requested', 'pr.requested', 'merge.requested'],
      emits: ['worktree.ready', 'worktree.failed', 'worktree.reset.done', 'worktree.reset.failed', 'worktree.cleaned', 'commit.done', 'commit.failed', 'pr.opened', 'pr.failed', 'pr.merged', 'merge.refused', 'merge.failed'],
    },
    register(ctx) {
      ctx.on('worktree.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        if (b.failWorktree) return ctx.emit('worktree.failed', { error: b.failWorktree }, e.jobId);
        const p = e.payload as { branch: string };
        ctx.emit('worktree.ready', { cwd: `/fake/wt/${e.jobId}`, branch: p.branch }, e.jobId);
      });
      ctx.on('worktree.cleanup.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        ctx.emit('worktree.cleaned', e.payload, e.jobId);
      });
      ctx.on('worktree.reset.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        if (b.hangReset) return;
        if (b.failReset) return ctx.emit('worktree.reset.failed', { error: b.failReset }, e.jobId);
        ctx.emit('worktree.reset.done', e.payload, e.jobId);
      });
      ctx.on('commit.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        if (b.hangCommit) return;
        if (b.failCommit) return ctx.emit('commit.failed', { error: b.failCommit }, e.jobId);
        ctx.emit('commit.done', { sha: `c0ffee${++commits}`, base: 'ba5e000' }, e.jobId);
      });
      ctx.on('pr.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        if (b.failPr) return ctx.emit('pr.failed', { error: b.failPr }, e.jobId);
        ctx.emit('pr.opened', { url: 'https://example.test/pull/1', number: 1, headSha: 'abc1234' }, e.jobId);
      });
      ctx.on('merge.requested', (e) => {
        sent.push({ type: e.type, payload: e.payload });
        if (b.hangMerge) return;
        if (b.failMerge) return ctx.emit('merge.failed', { reason: b.failMerge }, e.jobId);
        const refusal = b.refuseMerge?.[merges++];
        if (refusal) return ctx.emit('merge.refused', { reason: refusal }, e.jobId);
        ctx.emit('pr.merged', { number: 1 }, e.jobId);
      });
    },
  });
}

/** Lets a test play the human: grant, deny. */
export function fakeHuman() {
  let granted: (jobId: string, kind: string) => void = () => {};
  let denied: (jobId: string) => void = () => {};
  const requests: BuligEvent[] = [];
  const plugin = definePlugin({
    manifest: {
      name: 'fake-human',
      version: '0.1.0',
      sdk: '0',
      description: 'test channel',
      subscribes: ['approval.requested'],
      emits: ['approval.granted', 'approval.denied'],
      needs: ['approval.grant'],
    },
    register(ctx) {
      ctx.on('approval.requested', (e) => void requests.push(e));
      granted = (jobId, kind) => ctx.emit('approval.granted', { jobId, kind }, jobId);
      denied = (jobId) => ctx.emit('approval.denied', { jobId }, jobId);
    },
  });
  return { plugin, requests, grant: (j: string, k: string) => granted(j, k), deny: (j: string) => denied(j) };
}

export const logger = { debug() {}, info() {}, warn() {}, error() {} };

export function boot(dbPath: string, plugins: Plugin[], config: PipelineConfig = {}) {
  const k = createKernel({
    dbPath,
    plugins: [pipeline, ...plugins],
    enabled: ['pipeline-dev', ...plugins.map((p) => p.manifest.name)],
    grants: { 'pipeline-dev': ['merge.request', 'jobs.write'], 'fake-human': ['approval.grant'] },
    pluginConfig: { 'pipeline-dev': config as Record<string, unknown> },
    logger,
  });
  kernels.push(k);
  return k;
}

export const types = (k: Kernel, jobId: string) => k.history(jobId).map((e) => e.type);
export const stageNames = (k: Kernel, jobId: string) => k.jobs.stages(jobId).map((s) => `${s.name}:${s.status}`);

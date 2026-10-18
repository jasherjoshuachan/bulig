import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStore, SqliteStore, type Kernel, type Store } from '@bulig/core';
import { definePlugin, type Plugin } from '@bulig/plugin-sdk';
import { pgSupport, usePgServer, type PgDatabase } from '../../../packages/core/test/pg-throwaway.ts';
import { boot, fakeHuman, newDb, SCOPE_BLOCK, settle, type Sent } from './harness.ts';

// Chaos test for claims and the executor lease (ADR 0010, spec section 11): kill a kernel in the middle of a build, start another
// on the same record, and the job must finish with exactly one PR on GitHub, no lost event, and no stage asked for or reported twice. It runs on every
// adapter there is. Each rule has its own scenario:
//   crash:  the first kernel dies (its store is gone, nothing is handed back). The next one waits for the lease to run out.
//   zombie: the first kernel is alive but its heartbeat stopped working, so its lease ran out and another kernel took it. When its
//           stalled build finally reports, that report must bounce.

const PASS = 'All good.\nVERDICT: PASS';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A short lease keeps the test quick, but not so short that a busy machine stalling the process for a moment loses it by accident.
const LEASE = { leaseTtlMs: 1_500, leaseHeartbeatMs: 300, leaseWaitMs: 10_000 };

/** What GitHub knows, shared by every kernel in a scenario, like the real one is. Creating a PR twice for a branch makes no second PR, as gh would say "already exists", but is counted. */
class FakeGithubServer {
  readonly prs = new Map<string, number>();
  createCalls = 0;
  commits = 0;
  create(branch: string): number {
    this.createCalls++;
    if (!this.prs.has(branch)) this.prs.set(branch, this.prs.size + 1);
    return this.prs.get(branch)!;
  }
}

/** The fake GitHub plugin one kernel talks to. Every kernel gets its own copy of the plugin over the one server. */
function githubPlugin(server: FakeGithubServer): Plugin {
  return definePlugin({
    manifest: {
      name: 'fake-github',
      version: '0.1.0',
      sdk: '1',
      description: 'test github',
      subscribes: ['worktree.requested', 'worktree.reset.requested', 'worktree.cleanup.requested', 'commit.requested', 'pr.requested', 'merge.requested'],
      emits: ['worktree.ready', 'worktree.reset.done', 'worktree.cleaned', 'commit.done', 'pr.opened', 'pr.merged'],
    },
    register(ctx) {
      ctx.on('worktree.requested', (e) => ctx.emit('worktree.ready', { cwd: `/fake/wt/${e.jobId}`, branch: (e.payload as { branch: string }).branch }, e.jobId));
      ctx.on('worktree.reset.requested', (e) => ctx.emit('worktree.reset.done', e.payload, e.jobId));
      ctx.on('worktree.cleanup.requested', (e) => ctx.emit('worktree.cleaned', e.payload, e.jobId));
      ctx.on('commit.requested', (e) => {
        server.commits++;
        ctx.emit('commit.done', { sha: `c0ffee${server.commits}`, base: 'ba5e000' }, e.jobId);
      });
      ctx.on('pr.requested', (e) => {
        const number = server.create((e.payload as { branch: string }).branch);
        ctx.emit('pr.opened', { url: `https://example.test/pull/${number}`, number, headSha: 'abc1234' }, e.jobId);
      });
      ctx.on('merge.requested', (e) => ctx.emit('pr.merged', { number: (e.payload as { number: number }).number }, e.jobId));
    },
  });
}

/** A worker whose first build never reports (the kernel dies, or stalls, mid-build). `release()` lets that stalled build report, late. */
function workerPlugin(sent: Sent[], stall: { build: boolean; release?: () => void }): Plugin {
  return definePlugin({
    manifest: { name: 'fake-worker', version: '0.1.0', sdk: '1', description: 'test worker', subscribes: ['stage.requested'], emits: ['stage.completed', 'stage.failed'] },
    register(ctx) {
      ctx.on('stage.requested', (e) => {
        const p = e.payload as Sent;
        sent.push({ ...p, ...(e.jobId && { jobId: e.jobId }) });
        const text = p.stage === 'plan' ? `A plan.\n\n${SCOPE_BLOCK}` : p.stage === 'test' || p.stage === 'review' ? PASS : 'ok';
        const report = () => ctx.emit('stage.completed', { stage: p.stage, ok: true, result: text, costUsd: 0.01, sessionId: `s-${p.stageId}` }, e.jobId);
        if (p.stage === 'build' && stall.build) {
          stall.build = false;
          stall.release = report;
          return;
        }
        report();
      });
    },
  });
}

interface Adapter {
  name: string;
  skip: boolean;
  /** A new record, and a way to open a store on it. `second` is the store of a kernel that runs while the first is still alive. */
  record(): Promise<{ open(): Promise<Store>; openAlongside(): Promise<Store> }>;
}
const server = usePgServer();
const dbs: PgDatabase[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  for (const d of dbs.splice(0)) await d.drop();
});
const ADAPTERS: Adapter[] = [
  {
    name: 'SqliteStore',
    skip: false,
    async record() {
      const path = newDb();
      const open = async () => {
        const s = new SqliteStore(path);
        stores.push(s);
        return s;
      };
      return { open, openAlongside: open };
    },
  },
  {
    name: 'PostgresStore',
    skip: !pgSupport.available,
    async record() {
      const db = await server().newDatabase();
      dbs.push(db);
      const open = async () => {
        // The old writer's connection goes away when it dies, but the server notices a moment later: try again for a short while.
        for (let i = 0; ; i++) {
          try {
            const s = await PostgresStore.open(db.url);
            stores.push(s);
            return s;
          } catch (err) {
            if (i >= 40 || !(err instanceof Error) || err.name !== 'OtherWriterError') throw err;
            await sleep(50);
          }
        }
      };
      // The writer lock keeps a second kernel out while the first lives, which is the point of it. To play "a second kernel that
      // has the lease", this test opens its store as a reader: it may write, and the lease is the only thing that fences it.
      const openAlongside = async () => {
        const s = await PostgresStore.open(db.url, { mode: 'reader' });
        stores.push(s);
        return s;
      };
      return { open, openAlongside };
    },
  },
];

const story = async (k: Kernel, jobId: string) => (await k.history(jobId)).map((e) => e.type);

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`chaos: a kernel dies or stalls mid-build, with ${adapter.name}`, () => {
    const rigFor = async (holder: string, store: Store, github: FakeGithubServer, stall: { build: boolean; release?: () => void }) => {
      const sent: Sent[] = [];
      const errors: string[] = [];
      const human = fakeHuman();
      const logger = { debug() {}, info() {}, warn() {}, error: (m: string) => void errors.push(m) };
      const k = boot('unused', [workerPlugin(sent, stall), githubPlugin(github), human.plugin], {}, { store, leaseHolder: holder, logger, ...LEASE });
      return { k, sent, human, errors };
    };

    /** Everything the log must satisfy once the job is over, whatever happened on the way. */
    const assertClean = async (k: Kernel, jobId: string, github: FakeGithubServer, before: { id: string; seq: number }[]) => {
      const log = await k.bus.replay();
      // no event lost: everything written before the failure is still there, in place
      expect(log.slice(0, before.length).map((e) => ({ id: e.id, seq: e.seq! }))).toEqual(before);
      // seq only goes up and is never reused
      const seqs = log.map((e) => e.seq!);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      // exactly one stage.requested per stage attempt
      const asked = log.filter((e) => e.type === 'stage.requested').map((e) => (e.payload as { stageId?: string }).stageId);
      expect(asked.every((id) => typeof id === 'string')).toBe(true);
      expect(new Set(asked).size).toBe(asked.length);
      // exactly one stage.completed per build attempt that finished: the cut-off or stalled build never counts, and neither does a late report
      const stages = await k.jobs.stages(jobId);
      const finishedBuilds = stages.filter((s) => s.name === 'build' && s.status === 'passed');
      const builds = log.filter((e) => e.type === 'stage.completed' && (e.payload as { stage: string }).stage === 'build');
      expect(finishedBuilds).toHaveLength(1);
      expect(builds.map((e) => (e.payload as { sessionId: string }).sessionId)).toEqual(finishedBuilds.map((s) => `s-${s.id}`));
      const reports = log.filter((e) => e.type === 'stage.completed').map((e) => (e.payload as { sessionId: string }).sessionId);
      expect(new Set(reports).size).toBe(reports.length);
      const types = await story(k, jobId);
      expect(types.filter((t) => t === 'pr.requested')).toHaveLength(1);
      expect(types.filter((t) => t === 'pr.opened')).toHaveLength(1);
      // exactly one PR on GitHub, and GitHub was asked once
      expect(github.prs.size).toBe(1);
      expect(github.createCalls).toBe(1);
      expect((await k.jobs.get(jobId))!.status).toBe('done');
    };

    it('crash: the first kernel dies mid-build; the next one waits out the lease, resumes from the record, and one PR is made', async () => {
      const record = await adapter.record();
      const github = new FakeGithubServer();
      const stall = { build: true };

      const store1 = await record.open();
      const first = await rigFor('kernel-1', store1, github, stall);
      await first.k.start();
      await settle(first.k);
      const job = await first.k.jobs.create({ repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js' });
      await settle(first.k);
      first.human.grant(job.id, 'plan');
      await settle(first.k);
      expect((await first.k.jobs.stages(job.id)).at(-1)).toMatchObject({ name: 'build', status: 'running' });
      const before = (await first.k.bus.replay()).map((e) => ({ id: e.id, seq: e.seq! }));

      // kill -9: the connection is gone and nothing is handed back. The lease is still its own until it runs out.
      await store1.close();

      const second = await rigFor('kernel-2', await record.open(), github, stall);
      const began = Date.now();
      await second.k.start();
      expect(Date.now() - began).toBeGreaterThan(50); // it had to wait for the dead kernel's lease
      await settle(second.k);
      // resumed from the last committed event: the cut-off build is closed as interrupted, and build runs again
      const stages = await second.k.jobs.stages(job.id);
      expect(stages.filter((s) => s.name === 'build').map((s) => s.status)).toEqual(['failed', 'passed']);
      expect(second.sent.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);
      expect((await second.k.jobs.get(job.id))!.status).toBe('awaiting_approval');

      second.human.grant(job.id, 'merge', (await second.k.jobs.stages(job.id)).find((s) => s.name === 'approve-merge' && s.status === 'running')!.id);
      await settle(second.k);
      await assertClean(second.k, job.id, github, before);
    });

    it('zombie: the first kernel is alive but lost its lease; its stalled build reports late and is refused; one PR is made', async () => {
      const record = await adapter.record();
      const github = new FakeGithubServer();
      const stall = { build: true, release: undefined as (() => void) | undefined };

      const store1 = await record.open();
      // Once `stalled` is set, its heartbeat says "renewed" and renews nothing, as when a kernel stalls and cannot tell.
      let stalled = false;
      const lying = Object.create(store1) as Store;
      Object.assign(lying, {
        transaction: store1.transaction.bind(store1),
        close: store1.close.bind(store1),
        abort: store1.abort?.bind(store1),
        schemaVersion: store1.schemaVersion.bind(store1),
        acquireLease: store1.acquireLease.bind(store1),
        releaseLease: store1.releaseLease.bind(store1),
        renewLease: (h: string, g: number, t: number) => (stalled ? Promise.resolve(true) : store1.renewLease(h, g, t)),
      });
      const first = await rigFor('kernel-1', lying, github, stall);
      await first.k.start();
      await settle(first.k);
      const job = await first.k.jobs.create({ repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js' });
      await settle(first.k);
      first.human.grant(job.id, 'plan');
      await settle(first.k);
      expect((await first.k.jobs.stages(job.id)).at(-1)).toMatchObject({ name: 'build', status: 'running' });
      const before = (await first.k.bus.replay()).map((e) => ({ id: e.id, seq: e.seq! }));
      stalled = true;
      await sleep(LEASE.leaseTtlMs + 250); // the lease runs out

      const second = await rigFor('kernel-2', await record.openAlongside(), github, stall);
      await second.k.start(); // takes the lease at once: it has run out
      await settle(second.k);
      expect(second.sent.map((s) => s.stage)).toEqual(['build', 'test', 'docs', 'review']);

      // The first kernel's stalled build now reports. It must change nothing.
      const logBefore = (await second.k.bus.replay()).length;
      stall.release!();
      await sleep(300);
      await settle(second.k);
      expect((await second.k.bus.replay()).length).toBe(logBefore);
      // The first kernel found out it was no longer the writer, and said so, once.
      expect(first.errors.filter((m) => /executor lease was lost/.test(m))).toHaveLength(1);

      second.human.grant(job.id, 'merge', (await second.k.jobs.stages(job.id)).find((s) => s.name === 'approve-merge' && s.status === 'running')!.id);
      await settle(second.k);
      await assertClean(second.k, job.id, github, before);
      // and the build was reported by the second kernel only
      const builds = (await second.k.history(job.id)).filter((e) => e.type === 'stage.completed' && (e.payload as { stage: string }).stage === 'build');
      expect(builds).toHaveLength(1);
    });
  });
}

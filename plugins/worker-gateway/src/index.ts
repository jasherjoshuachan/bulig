import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAllowedPeer } from './address.ts';
import { definePlugin, type BuligEvent, type Plugin, type PluginContext, type Stage } from '@bulig/plugin-sdk';
import { isRequest } from '@bulig/worker-claude-code';
import { TokenAuth, type Compare } from './auth.ts';
import { LOCAL_WORKER, parseGatewayConfig, type GatewayConfig } from './config.ts';
import { ClaimRequest, CLAIM_PATH, HEARTBEAT_PATH, HeartbeatRequest, RESULT_PATH, ResultRequest, type Assignment } from './protocol.ts';
import { Scheduler, type Active, type Pending } from './scheduler.ts';
import { applyPatch, diffAgainst, resolveBase, revertPatch, sizeText, WorkspaceError } from './workspace.ts';

export { GatewayConfigError, assertBindable, parseGatewayConfig, DEFAULT_PORT, type GatewayConfig } from './config.ts';
export { TokenAuth } from './auth.ts';
export { isAllowedPeer } from './address.ts';
export { Scheduler } from './scheduler.ts';
export * from './protocol.ts';

/**
 * The gateway's HTTP server. Every connection is checked by its source address first (isAllowedPeer): one from anywhere but this machine or the
 * Tailscale tunnel is closed before a byte of it is read, so the token is never even looked at. This is what keeps a machine on the same
 * network segment away from an address on lo such as 198.18.74.1 (deploy/RUNBOOK.md, Known limits).
 */
export function gatewayServer(handler: (req: IncomingMessage, res: ServerResponse) => void, log: { warn(message: string): void }): Server {
  const server = createServer(handler);
  server.on('connection', (socket) => {
    if (isAllowedPeer(socket.remoteAddress)) return;
    log.warn(`worker-gateway: refused a connection from ${socket.remoteAddress ?? 'an unknown address'}: not this machine or the Tailscale tunnel`);
    socket.destroy();
  });
  return server;
}

export interface GatewayOptions {
  /** The comparison used for tokens. Default crypto.timingSafeEqual. A test passes a spy to see that every check goes through it. */
  compare?: Compare;
  /** Environment the worker tokens are read from. Default process.env. */
  env?: Record<string, string | undefined>;
  /** For tests: called after the record has been read in a heartbeat or result check and before the answer is used. Lets a test make the read slow. */
  afterFenceRead?: (stageId: string) => Promise<void> | void;
  /** For tests: called after a worker's changes were applied and before the result is written. Throwing makes the write fail. */
  afterApply?: (stageId: string) => Promise<void> | void;
}

interface Waiter {
  workerId: string;
  /** How many stages this worker may hold at once: the smaller of what it asked and what the config allows. */
  cap: number;
  projects: Set<string> | undefined;
  res: ServerResponse;
  timer: NodeJS.Timeout;
  done: boolean;
}

const ENDED = new Set(['cancelled', 'failed']);
const DONE_KEEP = 2000;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The worker endpoint (ADR 0011). The kernel is the only writer; a worker on another machine never sees the database. It asks this
 * plugin for a stage (POST /claim, held open up to claimWaitMs), says it is alive (POST /heartbeat), and hands back what Claude
 * did (POST /result). The plugin turns that into the same events the in-process worker emits, so the rest of the pipeline cannot
 * tell the difference.
 *
 * Every heartbeat and result is checked against the record: the stage must still be running, as the same attempt, under the same
 * lease generation, and held by the worker that says so. Anything else gets 409 and changes nothing. A worker that is silent for
 * heartbeatTimeoutMs loses the stage, which is offered again once; a second loss fails the stage.
 *
 * Stages go to the in-process worker first (up to localSlots at once), and to remote workers when it is full.
 */
export function createGateway(options: GatewayOptions = {}): Plugin & { addresses(): { address: string; port: number }[] } {
  let servers: Server[] = [];
  let teardown: (() => Promise<void>) | undefined;

  const plugin = definePlugin({
    manifest: {
      name: 'worker-gateway',
      version: '0.1.0',
      sdk: '1',
      description: 'Lets workers on other machines take stages over HTTP, with a token each, heartbeats and fencing.',
      subscribes: ['stage.requested', 'job.status'],
      emits: ['stage.assigned', 'stage.requested', 'stage.completed', 'stage.failed'],
      needs: ['net.listen', 'git.apply', 'fs.worktree'],
    },

    async register(ctx: PluginContext) {
      ctx.require('net.listen');
      ctx.require('git.apply');
      ctx.require('fs.worktree');
      const cfg = parseGatewayConfig(ctx.config, options.env ?? process.env);
      const auth = new TokenAuth(
        cfg.workers.map((w) => ({ id: w.id, token: w.token })),
        options.compare,
      );
      const workers = new Map(cfg.workers.map((w) => [w.id, w]));
      const sched = new Scheduler();
      const waiters: Waiter[] = [];
      /** Results already accepted, so a worker that did not hear the answer and sends again is told it went through. */
      const accepted = new Map<string, string>();
      let stopped = false;

      // ----- reading the record -----

      const stageRow = async (jobId: string, stageId: string): Promise<Stage | undefined> => (await ctx.jobs.stages(jobId)).find((s) => s.id === stageId);

      /** The stage is the running attempt it was handed out as, under this kernel's lease generation. */
      const stillTheirs = (row: Stage | undefined, a: Active): boolean =>
        row !== undefined && row.status === 'running' && row.attempt === a.pending.attempt && row.claimGeneration === a.generation;

      /**
       * Who holds this stage, if the message is from them and matches the record. Anything else is stale.
       *
       * The record is read with an await, and the watcher can take the stage back while that read is in flight. So every check that
       * depends on the held state is made again after the read, with no await between the last check and the return. With
       * `finish`, the holder is also marked as finishing in that same step, so a loss cannot start between "accepted" and "finishing".
       */
      async function fence(workerId: string, body: { stageId: string; attempt: number; generation?: number | undefined }, opts: { finish?: boolean } = {}): Promise<Active | undefined> {
        const a = sched.held(body.stageId);
        if (!a || a.lost || a.workerId !== workerId || a.pending.attempt !== body.attempt) return undefined;
        if (body.generation !== undefined && body.generation !== a.generation) return undefined;
        if (a.generation !== ctx.generation) return undefined;
        const row = await stageRow(a.pending.jobId, a.pending.key);
        await options.afterFenceRead?.(body.stageId);
        // The stage may have been taken back, or handed on, while the record was being read. The row above may be from before that.
        if (a.lost || sched.held(body.stageId) !== a) return undefined;
        if (!stillTheirs(row, a)) {
          // The record has moved on (the stage was closed, or the job ended). The worker's slot is free again.
          sched.release(a.pending.key);
          return undefined;
        }
        if (opts.finish) {
          if (a.finishing) return undefined;
          a.finishing = true;
        }
        return a;
      }

      // ----- events out -----

      const say = async (type: string, payload: unknown, jobId: string): Promise<boolean> => {
        try {
          await ctx.emitCommitted(type, payload, jobId);
          return true;
        } catch (err) {
          ctx.log.error(`worker-gateway: could not write ${type} for job ${jobId}: ${msg(err)}`);
          return false;
        }
      };
      const failStage = (p: Pending, error: string) => say('stage.failed', { stage: p.stage, error }, p.jobId);

      // ----- scheduling -----

      const localFree = () => cfg.localSlots - sched.heldBy(LOCAL_WORKER);

      /** Take the oldest allowed stage that is still worth running. A stage whose job has ended is closed here, the way the in-process worker closes it. */
      async function takeLive(accept: (p: Pending) => boolean): Promise<Pending | undefined> {
        for (;;) {
          const p = sched.take(accept);
          if (!p) return undefined;
          let job;
          let row: Stage | undefined;
          try {
            job = await ctx.jobs.get(p.jobId);
            row = p.stageId ? await stageRow(p.jobId, p.stageId) : undefined;
          } catch (err) {
            sched.requeue(p);
            ctx.log.warn(`worker-gateway: could not read job ${p.jobId}, so its ${p.stage} stage waits: ${msg(err)}`);
            return undefined;
          }
          if (!job || ENDED.has(job.status)) {
            await failStage(p, `the job is ${job?.status ?? 'gone'}, so the stage did not start`);
            continue;
          }
          if (p.stageId && (!row || row.status !== 'running' || row.attempt !== p.attempt)) {
            ctx.log.warn(`worker-gateway: stage ${p.stage} (${p.stageId}) of job ${p.jobId} is not the running attempt any more, so it was not offered`);
            continue;
          }
          return p;
        }
      }

      /** Free the local slot of a stage the record no longer shows as running (it finished, failed, or was taken over). */
      async function reapLocal(): Promise<void> {
        for (const a of sched.allHeld()) {
          if (a.workerId !== LOCAL_WORKER) continue;
          try {
            if (!stillTheirs(await stageRow(a.pending.jobId, a.pending.key), a)) sched.release(a.pending.key);
          } catch {
            // Cannot tell right now. Keep the slot; the next pass looks again.
          }
        }
      }

      async function assignLocal(p: Pending): Promise<void> {
        sched.hold({ workerId: LOCAL_WORKER, pending: p, generation: ctx.generation, lastBeat: Date.now(), applied: false, finishing: false, lost: false });
        if (!(await say('stage.assigned', { ...p.payload, workerId: LOCAL_WORKER }, p.jobId))) {
          sched.release(p.key);
          sched.requeue(p);
        }
      }

      /** Reads the job folder and packs what a worker needs to work on it: the base commit and everything on top of it. */
      async function workspaceFor(p: Pending): Promise<Assignment['workspace']> {
        const cwd = String(p.payload.cwd);
        const base = await resolveBase(cwd, cfg.baseBranch);
        const patch = await diffAgainst(cwd, base, cfg.maxPatchBytes);
        return { repo: p.project, base, ...(patch.length > 0 && { patch: patch.toString('base64') }) };
      }

      async function assignRemote(p: Pending, w: Waiter): Promise<void> {
        let workspace: Assignment['workspace'];
        try {
          workspace = await workspaceFor(p);
        } catch (err) {
          await failStage(p, `could not pack the repository for a remote worker: ${msg(err)}`);
          return;
        }
        // The worker may have hung up while the repository was being packed.
        if (w.done || w.res.destroyed) {
          sched.requeue(p);
          return;
        }
        const row = await stageRow(p.jobId, p.key).catch(() => undefined);
        if (!row || row.status !== 'running' || row.attempt !== p.attempt || row.claimGeneration === undefined) {
          ctx.log.warn(`worker-gateway: stage ${p.stage} (${p.key}) of job ${p.jobId} closed while it was being packed, so it was not offered`);
          return;
        }
        // The claim may have run out while the record was read. No await from here to the reply: a stage must never be held for a
        // worker that is not going to hear about it.
        if (w.done || w.res.destroyed) {
          sched.requeue(p);
          return;
        }
        const a: Active = { workerId: w.workerId, pending: p, generation: row.claimGeneration, lastBeat: Date.now(), applied: false, finishing: false, lost: false };
        sched.hold(a);
        const assignment: Assignment = {
          jobId: p.jobId,
          stageId: p.key,
          attempt: p.attempt,
          generation: a.generation,
          heartbeatMs: cfg.heartbeatMs,
          maxPatchBytes: cfg.maxPatchBytes,
          request: { stage: p.stage, prompt: String(p.payload.prompt), model: String(p.payload.model), mode: p.payload.mode === 'edit' ? 'edit' : 'readonly' },
          workspace,
        };
        reply(w, 200, assignment);
      }

      let pumping = false;
      let again = false;
      /** Hand out whatever can be handed out: the local worker first, then the remote workers that are waiting. One pass at a time. */
      async function pump(): Promise<void> {
        if (pumping) {
          again = true;
          return;
        }
        pumping = true;
        try {
          do {
            again = false;
            if (stopped) return;
            await reapLocal();
            while (localFree() > 0) {
              const p = await takeLive(() => true);
              if (!p) break;
              await assignLocal(p);
            }
            for (const w of [...waiters]) {
              if (w.done || sched.heldBy(w.workerId) >= w.cap) continue;
              const p = await takeLive((q) => q.stageId !== undefined && (w.projects === undefined || w.projects.has(q.project)));
              if (p) await assignRemote(p, w);
            }
          } while (again);
        } catch (err) {
          ctx.log.error(`worker-gateway: scheduling failed: ${msg(err)}`);
        } finally {
          pumping = false;
        }
      }

      // ----- a worker that goes quiet -----

      /** The worker stopped heartbeating. Take the stage back: close its attempt, open the next, and offer it again once. */
      async function lose(a: Active): Promise<void> {
        // A result being taken is not a silent worker: it will be accepted or refused on its own.
        if (a.lost || a.finishing) return;
        a.lost = true;
        sched.release(a.pending.key);
        const p = a.pending;
        ctx.log.warn(`worker-gateway: worker "${a.workerId}" stopped heartbeating on ${p.stage} (${p.key}) of job ${p.jobId}`);
        try {
          const job = await ctx.jobs.get(p.jobId);
          if (!job || ENDED.has(job.status)) {
            await failStage(p, 'the job ended, so this run was stopped');
            return;
          }
          if (p.reoffers >= 1) {
            await failStage(p, `worker "${a.workerId}" went silent mid-stage, after the stage had already been offered a second time, so it was not offered again`);
            return;
          }
          if (!stillTheirs(await stageRow(p.jobId, p.key), a)) return;
          // The job folder is only touched when a result is accepted. If a worker's changes were applied and then could not be taken
          // back (see result), the folder holds work nobody accepted, and the next attempt must not start from it: fail the stage.
          if (a.applied) {
            await failStage(p, `worker "${a.workerId}" was lost after its changes were applied to the job folder and they could not be taken back, so the stage was not offered again`);
            return;
          }
          // Closing the attempt lets go of its claim, so the next attempt can take one.
          await ctx.jobs.finishStage(p.key, 'failed', { interrupted: true, reason: 'worker-lost', error: `worker "${a.workerId}" stopped heartbeating`, workerId: a.workerId });
          const next = await ctx.jobs.startStage(p.jobId, p.stage);
          const ok = await say('stage.requested', { ...p.payload, stageId: next.id, reoffers: p.reoffers + 1 }, p.jobId);
          if (!ok) await ctx.jobs.finishStage(next.id, 'failed', { error: 'could not offer the stage again' }).catch(() => {});
        } catch (err) {
          // The job is left with no running stage; the next start picks it up from the record.
          ctx.log.error(`worker-gateway: could not offer ${p.stage} of job ${p.jobId} again after worker "${a.workerId}" went silent: ${msg(err)}`);
        }
      }

      // ----- events in -----

      ctx.on('stage.requested', async (e: BuligEvent) => {
        const req = e.payload;
        // Behind the gateway nothing else reads stage.requested for the worker, so a malformed one is reported here, as the worker would.
        if (!isRequest(req)) {
          ctx.emit('stage.failed', { stage: 'unknown', error: 'stage.requested payload is missing a field' }, e.jobId);
          return;
        }
        if (!e.jobId || stopped) return;
        let attempt = 0;
        let project: string;
        try {
          const job = await ctx.jobs.get(e.jobId);
          if (!job) return;
          project = job.repo;
          if (req.stageId !== undefined) {
            const row = await stageRow(e.jobId, req.stageId);
            if (!row || row.status !== 'running') {
              ctx.log.warn(`worker-gateway: stage ${req.stage} (${req.stageId}) of job ${e.jobId} is not the running attempt, so it was not queued`);
              return;
            }
            attempt = row.attempt;
          }
        } catch (err) {
          ctx.emit('stage.failed', { stage: req.stage, error: `could not read the job, so the stage did not start: ${msg(err)}` }, e.jobId);
          return;
        }
        const seq = sched.nextSeq();
        const askedBefore = (req as { reoffers?: unknown }).reoffers;
        const reoffers = typeof askedBefore === "number" ? askedBefore : 0;
        sched.add({ key: req.stageId ?? `${e.jobId}/${req.stage}/${seq}`, stageId: req.stageId, jobId: e.jobId, stage: req.stage, attempt, project, payload: req as unknown as Record<string, unknown>, reoffers, seq });
        void pump();
      });

      ctx.on('job.status', async (e: BuligEvent) => {
        const to = (e.payload as { to?: string } | null)?.to;
        if (!e.jobId || !to || !ENDED.has(to)) return;
        // A remote stage of a job that ended is closed now, the way the in-process worker closes a run it kills. The worker finds out
        // at its next heartbeat (409) and stops its own Claude.
        for (const a of sched.allHeld()) {
          if (a.pending.jobId !== e.jobId || a.workerId === LOCAL_WORKER) continue;
          sched.release(a.pending.key);
          a.lost = true;
          await failStage(a.pending, 'the job ended, so this run was stopped');
        }
        void pump();
      });

      // ----- the endpoint -----

      function reply(w: Waiter, status: number, body?: unknown): void {
        if (w.done) return;
        w.done = true;
        clearTimeout(w.timer);
        const at = waiters.indexOf(w);
        if (at !== -1) waiters.splice(at, 1);
        send(w.res, status, body);
      }

      function send(res: ServerResponse, status: number, body?: unknown): void {
        if (res.destroyed || res.writableEnded) return;
        if (body === undefined) {
          res.writeHead(status, { 'cache-control': 'no-store' }).end();
          return;
        }
        const json = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' }).end(json);
      }

      /** The request body, or undefined (and a 413 sent) when it is larger than `limit`. */
      function readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<unknown | undefined> {
        return new Promise((resolve) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let over = false;
          req.on('data', (d: Buffer) => {
            size += d.length;
            if (size > limit) {
              if (!over) {
                over = true;
                send(res, 413, { error: 'too large' });
                req.destroy();
              }
              return;
            }
            chunks.push(d);
          });
          req.on('end', () => {
            if (over) return resolve(undefined);
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              send(res, 400, { error: 'bad json' });
              resolve(undefined);
            }
          });
          req.on('error', () => resolve(undefined));
          req.on('close', () => resolve(undefined));
        });
      }

      const bodyLimit = cfg.maxPatchBytes * 2 + 8 * 1024 * 1024;

      async function claim(workerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
        const json = await readJson(req, res, 64 * 1024);
        if (json === undefined) return;
        const body = ClaimRequest.safeParse(json);
        if (!body.success) return send(res, 400, { error: 'bad request' });
        // A token speaks for one worker id only.
        if (body.data.workerId !== workerId) return send(res, 401);
        const w = workers.get(workerId)!;
        const cap = Math.min(body.data.slots, w.slots);
        if (waiters.filter((x) => x.workerId === workerId).length >= cap * 2 + 2) return send(res, 429, { error: 'too many open claims' });
        const allowed = w.projects ? new Set(w.projects) : undefined;
        const asked = body.data.projects ? new Set(body.data.projects) : undefined;
        const projects = allowed && asked ? new Set([...asked].filter((x) => allowed.has(x))) : (allowed ?? asked);
        const waiter: Waiter = { workerId, cap, projects, res, done: false, timer: setTimeout(() => reply(waiter, 204), cfg.claimWaitMs) };
        waiter.timer.unref();
        waiters.push(waiter);
        res.on('close', () => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timer);
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
        });
        void pump();
      }

      async function heartbeat(workerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
        const json = await readJson(req, res, 16 * 1024);
        if (json === undefined) return;
        const body = HeartbeatRequest.safeParse(json);
        if (!body.success) return send(res, 400, { error: 'bad request' });
        const a = await fence(workerId, body.data);
        if (!a) return send(res, 409, { error: 'stale' });
        a.lastBeat = Date.now();
        send(res, 200, { ok: true });
      }

      async function result(workerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
        const json = await readJson(req, res, bodyLimit);
        if (json === undefined) return;
        const body = ResultRequest.safeParse(json);
        if (!body.success) return send(res, 400, { error: 'bad request' });
        const r = body.data;
        // A worker that did not hear the answer sends again. If the first one went through, say so.
        if (accepted.get(r.stageId) === `${workerId}:${r.attempt}`) return send(res, 200, { ok: true, duplicate: true });
        const a = await fence(workerId, r, { finish: true });
        if (!a) return send(res, 409, { error: 'stale' });
        a.lastBeat = Date.now();
        const p = a.pending;
        try {
          if (r.outcome === 'completed') {
            // Only an edit stage changes files. A read-only stage that sends changes is wrong or hostile: fail it, and nothing is applied.
            if (r.patch && p.payload.mode !== 'edit') {
              if (!(await failStage(p, `worker "${workerId}" sent changes for a ${p.stage} stage, which may not change files, so they were not applied`))) throw new Error('could not record the failure');
              finish(a, workerId);
              return send(res, 400, { error: 'this stage may not send changes' });
            }
            if (r.patch && !a.applied) {
              let tooBig = false;
              try {
                const patch = Buffer.from(r.patch, 'base64');
                if (patch.length > cfg.maxPatchBytes) {
                  tooBig = true;
                  throw new WorkspaceError(`the changes are larger than ${sizeText(cfg.maxPatchBytes)}`);
                }
                await applyPatch(String(p.payload.cwd), patch);
                a.applied = true;
                a.appliedPatch = patch;
              } catch (err) {
                if (!(err instanceof WorkspaceError)) throw err;
                // The worker's work cannot be used. That is a failed stage, and the answer to the worker is that it was received.
                if (!(await failStage(p, `the changes from worker "${workerId}" were not applied: ${err.message}`))) throw new Error('could not record the failure');
                finish(a, workerId);
                return send(res, tooBig ? 413 : 200, tooBig ? { error: 'too large' } : { ok: true });
              }
              await options.afterApply?.(r.stageId);
            }
            const o = r.output;
            await ctx.emitCommitted(
              'stage.completed',
              { stage: p.stage, ok: true, result: o.result ?? '', costUsd: o.costUsd, sessionId: o.sessionId, evidence: o.evidence ?? [], ...(o.repoFacts && { repoFacts: o.repoFacts }), workerId },
              p.jobId,
            );
          } else {
            await ctx.emitCommitted('stage.failed', { stage: p.stage, error: r.output.error || 'unknown failure', workerId }, p.jobId);
          }
          finish(a, workerId);
          send(res, 200, { ok: true });
        } catch (err) {
          // Nothing was written, or it could not be confirmed. The worker sends the result again. Changes already applied to the job
          // folder are taken back first: the folder must hold only what was accepted, and the retry applies them again.
          if (a.appliedPatch) {
            try {
              await revertPatch(String(p.payload.cwd), a.appliedPatch);
              a.applied = false;
              a.appliedPatch = undefined;
            } catch (undo) {
              ctx.log.error(`worker-gateway: could not take back the changes of ${p.stage} (${p.key}) after the result failed: ${msg(undo)}`);
            }
          }
          a.finishing = false;
          ctx.log.error(`worker-gateway: could not take the result of ${p.stage} (${p.key}) from worker "${workerId}": ${msg(err)}`);
          send(res, 500, { error: 'try again' });
        }
      }

      function finish(a: Active, workerId: string): void {
        sched.release(a.pending.key);
        accepted.set(a.pending.key, `${workerId}:${a.pending.attempt}`);
        if (accepted.size > DONE_KEEP) accepted.delete(accepted.keys().next().value!);
        void pump();
      }

      async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Who is asking comes first. Nothing else about the endpoint, not even which paths exist, is told to someone without a token.
        const workerId = auth.authenticate(req.headers.authorization);
        if (!workerId) return send(res, 401);
        const path = (req.url ?? '').split('?')[0];
        if (req.method !== 'POST' || (path !== CLAIM_PATH && path !== HEARTBEAT_PATH && path !== RESULT_PATH)) return send(res, 404);
        if (stopped) return send(res, 503);
        if (path === CLAIM_PATH) return claim(workerId, req, res);
        if (path === HEARTBEAT_PATH) return heartbeat(workerId, req, res);
        return result(workerId, req, res);
      }

      // ----- timers and sockets -----

      const checkMs = Math.max(20, Math.min(1000, Math.floor(cfg.heartbeatTimeoutMs / 6)));
      const watcher = setInterval(() => {
        const now = Date.now();
        for (const a of sched.allHeld()) {
          if (a.workerId !== LOCAL_WORKER && !a.finishing && now - a.lastBeat > cfg.heartbeatTimeoutMs) void lose(a);
        }
      }, checkMs);
      watcher.unref();
      // Wakes the scheduler when a local slot frees up or a stage is waiting; the record is the source of truth for both.
      const ticker = setInterval(() => {
        if (sched.queued > 0 || sched.heldBy(LOCAL_WORKER) > 0) void pump();
      }, 250);
      ticker.unref();

      servers = cfg.listen.map(() =>
        gatewayServer((req, res) => {
          handle(req, res).catch((err: unknown) => {
            ctx.log.error(`worker-gateway: request failed: ${msg(err)}`);
            send(res, 500, { error: 'internal' });
          });
        }, ctx.log),
      );
      try {
        await Promise.all(
          servers.map(
            (server, i) =>
              new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen({ host: cfg.listen[i]!, port: cfg.port }, () => {
                  server.off('error', reject);
                  resolve();
                });
              }),
          ),
        );
      } catch (err) {
        clearInterval(watcher);
        clearInterval(ticker);
        await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
        servers = [];
        throw new Error(`worker-gateway: could not listen on ${cfg.listen.join(', ')}:${cfg.port}: ${msg(err)}`);
      }
      for (const s of servers) {
        const at = s.address() as AddressInfo;
        ctx.log.info(`worker-gateway: listening on ${at.address}:${at.port}`);
      }

      teardown = async () => {
        stopped = true;
        clearInterval(watcher);
        clearInterval(ticker);
        for (const w of [...waiters]) reply(w, 204);
        await Promise.all(
          servers.map(
            (s) =>
              new Promise<void>((resolve) => {
                s.close(() => resolve());
                s.closeAllConnections();
              }),
          ),
        );
      };
    },

    async stop() {
      await teardown?.();
      teardown = undefined;
    },
  });

  return Object.assign(plugin, {
    addresses: () => servers.map((s) => s.address() as AddressInfo).filter(Boolean).map((a) => ({ address: a.address, port: a.port })),
  });
}

export type { GatewayConfig as Config };
export default createGateway();

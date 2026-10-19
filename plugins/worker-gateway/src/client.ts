import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildArgs, buildClaudeEnv, DEFAULT_TIMEOUT_MS, run, terminate, type StageRequest } from '@bulig/worker-claude-code';
import { isLoopbackOrTailnet } from './address.ts';
import { CLIENT_CLAIM_TIMEOUT_MS } from './config.ts';
import { CLAIM_PATH, HEARTBEAT_PATH, RESULT_PATH, type Assignment, type ClaimRequest, type HeartbeatRequest, type ResultRequest } from './protocol.ts';
import { collectChanges, prepareWorkspace, removeWorkspace } from './workspace.ts';

// The other end of the worker endpoint: what `bulig worker` runs. It asks the kernel for a stage, makes a folder for it from its own
// clone of the repository, runs the very same Claude process the in-process worker runs, says it is alive every few seconds, and
// hands back the answer. It never touches the database and never commits or pushes.

export interface RemoteWorkerOptions {
  kernelUrl: string;
  workerId: string;
  token: string;
  /** How many stages this worker runs at once. The kernel may allow fewer. */
  slots: number;
  /** The kernel's name for a repository (a path on its machine) to this machine's clone of it. Only these repositories are asked for. */
  repos: Record<string, string>;
  /** Where stage folders are made. */
  workdir: string;
  claudeBin?: string | undefined;
  timeoutMs?: number | undefined;
  extraArgs?: string[] | undefined;
  passEnv?: string[] | undefined;
  allowDomains?: string[] | undefined;
  /**
   * Claude's login token, when it comes from a file and not from the environment. It is put in Claude's environment as
   * CLAUDE_CODE_OAUTH_TOKEN, after the allowlist, and nowhere else.
   */
  claudeToken?: string | undefined;
  /** The environment Claude's own is built from. Default process.env. Only the allowlist in the worker plugin reaches it. */
  env?: NodeJS.ProcessEnv | undefined;
  /** A stage is given up on (Claude is stopped, nothing is sent) when the kernel has not answered a heartbeat for this long. Default 30000. */
  lossMs?: number | undefined;
  /** Largest patch a stage may send back, if smaller than what the kernel allows (it says so with each stage). Default: the kernel's. */
  maxPatchBytes?: number | undefined;
  /** First wait after a failed call, in ms; it doubles up to 5 s. Default 1000. */
  retryMs?: number | undefined;
  /** Host names (not addresses) the kernel may be reached at over plain http, such as a MagicDNS name on the tailnet. */
  allowHttpHosts?: string[] | undefined;
  fetch?: typeof fetch | undefined;
  log?: ((line: string) => void) | undefined;
  /** For tests: act as a worker whose heartbeats do not get through while its Claude carries on. */
  dropHeartbeats?: (() => boolean) | undefined;
}

export interface RemoteWorker {
  /** Stop asking for work, stop every Claude run, and send nothing for stages in flight. The kernel notices the silence and offers them again. */
  stop(): Promise<void>;
  /** Stages in flight right now. */
  running(): number;
}

/**
 * The token travels in a header, so the road must be private. Allowed without TLS: this machine and a Tailscale address (WireGuard
 * encrypts the tunnel), written as an IP address or as `localhost`. A name is allowed only when it is listed in `allowHttpHosts`
 * (for example a MagicDNS name such as box.tailnet.ts.net): a name is not proof of where it points. Anything else must be https.
 */
export function assertSafeKernelUrl(raw: string, allowHttpHosts: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--kernel ${JSON.stringify(raw)} is not a URL`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') throw new Error('--kernel must start with http:// or https://');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || isLoopbackOrTailnet(host) || allowHttpHosts.map((h) => h.toLowerCase()).includes(host)) return url;
  throw new Error(`--kernel ${url.origin} is plain http to a host that is not this machine or a Tailscale address, which would send the token in the clear. Use https, the Tailscale address, or name the host with --allow-http-host.`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function startRemoteWorker(opts: RemoteWorkerOptions): RemoteWorker {
  const base = assertSafeKernelUrl(opts.kernelUrl, opts.allowHttpHosts);
  // Made with the process's umask and never chmod-ed, so a shared group's access (umask 0002) is whatever the unit asked for.
  mkdirSync(opts.workdir, { recursive: true });
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const lossMs = opts.lossMs ?? 30_000;
    const retryMs = opts.retryMs ?? 1000;
  const children = new Set<ChildProcess>();
  const claudeEnv = (): NodeJS.ProcessEnv => {
    const env = buildClaudeEnv(opts.env ?? process.env, opts.passEnv);
    if (opts.claudeToken) env.CLAUDE_CODE_OAUTH_TOKEN = opts.claudeToken;
    return env;
  };
  const aborts = new Set<(why: string) => void>();
  const stopper = new AbortController();
  let inFlight = 0;

  const call = async (path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> => {
    const res = await doFetch(new URL(path, base), {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([stopper.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const raw = await res.text();
    let json: unknown;
    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  };

  async function claim(): Promise<Assignment | undefined> {
    const body: ClaimRequest = { workerId: opts.workerId, slots: opts.slots, projects: Object.keys(opts.repos) };
    const r = await call(CLAIM_PATH, body, CLIENT_CLAIM_TIMEOUT_MS);
    if (r.status === 204) return undefined;
    if (r.status === 200) return r.json as Assignment;
    throw new Error(r.status === 401 ? 'the kernel refused the token' : `claim answered ${r.status}`);
  }

  async function execute(a: Assignment): Promise<void> {
    inFlight++;
    let aborted: string | undefined;
    let current: ChildProcess | undefined;
    let lastOk = Date.now();
    const abort = (why: string) => {
      if (aborted) return;
      aborted = why;
      log(`stage ${a.request.stage} (${a.stageId}) stopped: ${why}`);
      if (current) terminate(current, 3000);
    };
    aborts.add(abort);
    const ids = { stageId: a.stageId, attempt: a.attempt, generation: a.generation };
    let beating = false;
    const beat = setInterval(() => {
      if (beating || aborted) return;
      if (opts.dropHeartbeats?.()) return;
      beating = true;
      const hb: HeartbeatRequest = ids;
      call(HEARTBEAT_PATH, hb, Math.max(1000, a.heartbeatMs * 2))
        .then((r) => {
          if (r.status === 200) lastOk = Date.now();
          else if (r.status === 409) abort('the kernel no longer has this stage with us');
          else if (r.status === 401) abort('the kernel refused the token');
        })
        .catch(() => {
          if (Date.now() - lastOk > lossMs) abort('lost contact with the kernel');
        })
        .finally(() => {
          beating = false;
        });
    }, a.heartbeatMs);

    const post = async (body: ResultRequest): Promise<void> => {
      const since = Date.now();
      for (;;) {
        if (aborted) return;
        try {
          const r = await call(RESULT_PATH, body, 120_000);
          if (r.status === 200) return;
          if (r.status === 409 || r.status === 401 || r.status === 400 || r.status === 413) {
            log(`the kernel did not take the result of ${a.request.stage} (${r.status})`);
            return;
          }
        } catch {
          // fall through and try again
        }
        if (Date.now() - since > lossMs) return;
        await sleep(Math.min(1000, retryMs));
      }
    };
    const failed = (error: string): ResultRequest => ({ ...ids, outcome: 'failed', output: { error } });

    const clone = opts.repos[a.workspace.repo];
    const dir = join(opts.workdir, a.stageId);
    // Set before the folder is made: a prepare that fails half way (the worktree was added, the patch did not apply) leaves a folder to remove.
    let prepared = false;
    try {
      if (!clone || !SAFE_ID.test(a.stageId)) {
        await post(failed(`worker "${opts.workerId}" has no copy of ${a.workspace.repo}`));
        return;
      }
      try {
        prepared = true;
        await prepareWorkspace(clone, dir, a.workspace.base, a.workspace.patch ? Buffer.from(a.workspace.patch, 'base64') : undefined);
      } catch (err) {
        await post(failed(`could not prepare the workspace on worker "${opts.workerId}": ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (aborted) return;
      const req: StageRequest = { ...a.request, cwd: dir };
      const out = await run(
        opts.claudeBin ?? 'claude',
        buildArgs(req, opts.extraArgs, opts.allowDomains),
        dir,
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        claudeEnv(),
        children,
        (child) => {
          current = child;
          if (aborted) terminate(child, 3000);
          return () => {
            if (current === child) current = undefined;
          };
        },
      );
      // A stage the kernel took back, or a worker being stopped, says nothing: the kernel has already moved on, or will.
      if (aborted) return;
      if (!out.ok) {
        await post(failed(out.error ?? 'unknown failure'));
        return;
      }
      let patch: Buffer = Buffer.alloc(0);
      if (a.request.mode === 'edit') {
        try {
          patch = await collectChanges(dir, Math.min(opts.maxPatchBytes ?? Infinity, a.maxPatchBytes ?? 8 * 1024 * 1024));
        } catch (err) {
          await post(failed(`could not collect the changes: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
      }
      await post({
        ...ids,
        outcome: 'completed',
        output: { result: out.result, ...(out.costUsd !== undefined && { costUsd: out.costUsd }), ...(out.sessionId && { sessionId: out.sessionId }), ...(out.evidence && { evidence: out.evidence }) },
        ...(patch.length > 0 && { patch: patch.toString('base64') }),
      });
    } finally {
      clearInterval(beat);
      aborts.delete(abort);
      if (prepared) await removeWorkspace(clone!, dir).catch(() => {});
      inFlight--;
    }
  }

  async function loop(): Promise<void> {
    let wait = retryMs;
    while (!stopper.signal.aborted) {
      try {
        const a = await claim();
        wait = retryMs;
        if (a) await execute(a);
      } catch (err) {
        if (stopper.signal.aborted) return;
        log(`${err instanceof Error ? err.message : String(err)}; trying again in ${wait} ms`);
        await sleep(wait);
        wait = Math.min(wait * 2, 5000);
      }
    }
  }

  const loops = Array.from({ length: opts.slots }, () => loop());
  return {
    running: () => inFlight,
    async stop() {
      stopper.abort();
      for (const abort of [...aborts]) abort('worker stopping');
      for (const c of children) terminate(c, 3000);
      await Promise.allSettled(loops);
    },
  };
}

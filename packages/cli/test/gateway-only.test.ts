import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import github from '@bulig/github';
import pipeline from '@bulig/pipeline-dev';
import { definePlugin } from '@bulig/plugin-sdk';
import gateway from '@bulig/worker-gateway';
import { runCli, type Io } from '../src/index.ts';
import { makeWorld, prCreates, sleep, waitFor, FAKE_GH, tmp } from '../../../plugins/worker-gateway/test/support.ts';

vi.setConfig({ testTimeout: 240_000 });

const PROBE = fileURLToPath(new URL('./fixtures/fake-claude-probe.mjs', import.meta.url));
chmodSync(PROBE, 0o755);
const TOKEN = 'kernel-worker-token-0123456789';
const CLAUDE_TOKEN = 'sk-ant-oat-from-a-file-0123';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe('a kernel with no in-process worker, and one `bulig worker` process', () => {
  it('finishes a job with exactly one PR; the worker\'s token and Claude token come from files, Claude sees no secret, and its folders follow the umask', async () => {
    const world = makeWorld();
    const port = await freePort();
    const root = tmp('bulig-gwonly-');
    const cwd = join(root, 'kernel');
    const wcwd = join(root, 'worker');
    const creds = join(root, 'creds');
    for (const d of [cwd, wcwd, creds, join(root, 'home')]) mkdirSync(d);
    writeFileSync(join(creds, 'worker-token'), TOKEN + '\n', { mode: 0o400 });
    writeFileSync(join(creds, 'claude-login'), CLAUDE_TOKEN + '\n', { mode: 0o400 });
    const probe = join(root, 'probe.jsonl');
    writeFileSync(probe, '');
    process.env.FAKE_GH_STATE = world.ghState;
    process.env.BULIG_WORKER_TOKEN_MAC = TOKEN;

    // The channel plays the person: it submits one job when the kernel starts and says yes to every question.
    let finished: () => void = () => {};
    const done = new Promise<void>((r) => (finished = r));
    const channel = definePlugin({
      manifest: { name: 'channel-cli', version: '0.1.0', sdk: '1', description: 'test channel', subscribes: ['kernel.started', 'approval.requested', 'job.status'], emits: ['approval.granted'], needs: ['approval.grant'] },
      register(ctx) {
        ctx.on('kernel.started', async () => {
          await ctx.jobs.create({ repo: world.repo, title: 'Add multiply function', body: 'Add src/multiply.js exporting multiply(a,b)' });
        });
        ctx.on('approval.requested', (e) => {
          const p = e.payload as { jobId: string; kind: string; stageId: string };
          ctx.emit('approval.granted', { jobId: p.jobId, kind: p.kind, stageId: p.stageId }, e.jobId);
        });
        ctx.on('job.status', (e) => {
          if ((e.payload as { to?: string }).to === 'done') finished();
        });
      },
    });

    // enabled has no worker-claude-code: the kernel runs gateway-only. localSlots says 2 on purpose; with no in-process worker it must act as 0.
    writeFileSync(
      join(cwd, 'bulig.config.json'),
      JSON.stringify({
        dbPath: join(root, 'db', 'bulig.sqlite'),
        enabled: ['channel-cli', 'worker-gateway', 'github', 'pipeline-dev'],
        grants: {
          'channel-cli': ['approval.grant'],
          'pipeline-dev': ['merge.request', 'jobs.write'],
          github: ['git.push', 'gh.pr'],
          'worker-gateway': ['net.listen', 'git.apply', 'fs.worktree'],
        },
        pluginConfig: {
          github: { ghBin: FAKE_GH, allowNoChecks: true },
          'worker-gateway': { listen: ['127.0.0.1'], port, localSlots: 2, claimWaitMs: 1000, heartbeatMs: 300, heartbeatTimeoutMs: 3000, workers: { mac: { tokenEnv: 'BULIG_WORKER_TOKEN_MAC' } } },
        },
      }),
    );
    const serverOut: string[] = [];
    const serverErr: string[] = [];
    const serverStops: (() => void)[] = [];
    const serverIo: Io = { out: (l) => serverOut.push(l), err: (l) => serverErr.push(l), cwd, home: join(root, 'home'), pollMs: 15, servePlugins: [channel, gateway, github, pipeline], onStop: (s) => (serverStops.push(s), () => {}) };

    // The worker's own config names Claude and what may pass through to it. Its secrets are only in files.
    writeFileSync(join(wcwd, 'bulig.config.json'), JSON.stringify({ dbPath: join(root, 'wdb', 'x.sqlite'), pluginConfig: { 'worker-claude-code': { claudeBin: PROBE, passEnv: ['FAKE_PROBE'] } } }));
    const workerOut: string[] = [];
    const workerErr: string[] = [];
    const workerStops: (() => void)[] = [];
    const parentEnv = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_PROBE: probe, BULIG_DATABASE_URL: 'postgres://u:pw_leak_check@127.0.0.1/db', DATABASE_URL: 'postgres://x', GH_TOKEN: 'ghp_leak_check', CREDENTIALS_DIRECTORY: creds };
    const workerIo: Io = { out: (l) => workerOut.push(l), err: (l) => workerErr.push(l), cwd: wcwd, home: join(root, 'home'), env: parentEnv, onStop: (s) => (workerStops.push(s), () => {}) };

    const oldUmask = process.umask(0o002);
    const serving = runCli(['serve'], serverIo);
    try {
      await waitFor(() => serverOut.some((l) => l.includes('serving with')), 60_000, 'serve to start');
      const working = runCli(
        ['worker', '--kernel', `http://127.0.0.1:${port}`, '--id', 'mac', '--token-file', join(creds, 'worker-token'), '--claude-token-file', join(creds, 'claude-login'), '--repo', `${world.repo}=${world.clone}`, '--work-dir', world.workdir, '--slots', '1'],
        workerIo,
      );
      await Promise.race([done, sleep(200_000).then(() => Promise.reject(new Error('the job did not finish'))), serving.then((c) => Promise.reject(new Error(`serve exited ${c}: ${serverErr.join(' | ')}`)))]);
      await sleep(300);
      workerStops.forEach((s) => s());
      serverStops.forEach((s) => s());
      expect(await working).toBe(0);
      expect(await serving).toBe(0);
    } finally {
      process.umask(oldUmask);
      delete process.env.BULIG_WORKER_TOKEN_MAC;
    }

    expect(prCreates(world.ghLog)).toBe(1);
    expect(serverErr.join('\n')).toBe('');
    // Every stage ran on the worker: six Claude runs, each started with the login from the file and no secret of Bulig's.
    const runs = readFileSync(probe, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { oauth: string | null; leaked: string[]; cwdMode: number; readmeMode: number });
    expect(runs).toHaveLength(6);
    for (const r of runs) {
      expect(r.oauth).toBe(CLAUDE_TOKEN);
      expect(r.leaked).toEqual([]);
      // The folders git made follow the umask: with 0002 the group can write, and nothing stripped it.
      expect(r.cwdMode & 0o020).toBe(0o020);
      expect(r.readmeMode & 0o020).toBe(0o020);
    }
    expect(workerErr.join('\n')).not.toContain(TOKEN);
    expect(workerOut.join('\n')).not.toContain(TOKEN);
    expect(workerOut.join('\n')).not.toContain(CLAUDE_TOKEN);
  });
});

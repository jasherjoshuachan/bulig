import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { createTelegramChannel } from '../../channel-telegram/src/index.ts';
import { FakeTelegram, until } from '../../channel-telegram/test/fake-telegram.ts';
import github from '../../github/src/index.ts';
import pipeline from '../src/index.ts';
import { fakeWorker, logger } from './harness.ts';

const FAKE_GH = fileURLToPath(new URL('../../github/test/fixtures/fake-gh.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE_GH, 0o755));

const CHAT = 4242;
const TOKEN_ENV = 'TEST_MERGE_REFUSAL_TG_TOKEN';
const dirs: string[] = [];
const kernels: Kernel[] = [];
const fakes: FakeTelegram[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_GH_STATE;
  delete process.env[TOKEN_ENV];
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The real pipeline, the real github plugin (with a fake gh), the real Telegram channel (with a fake Bot API). */
async function rig(ghConfig: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bulig-refusal-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');

  const log = join(root, 'gh.log');
  const statePath = join(root, 'gh-state.json');
  const setState = (s: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ log, ...s }));
  setState({});
  process.env.FAKE_GH_STATE = statePath;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }) : []);

  const fake = await new FakeTelegram().start();
  fakes.push(fake);
  process.env[TOKEN_ENV] = fake.token;

  const k = createKernel({
    dbPath: join(root, 'db.sqlite'),
    plugins: [pipeline, github, fakeWorker({ test: 'ok\nVERDICT: PASS', review: 'ok\nVERDICT: PASS' }, []), createTelegramChannel({ sleep: async () => {} })],
    enabled: ['pipeline-dev', 'github', 'fake-worker', 'channel-telegram'],
    grants: {
      'pipeline-dev': ['merge.request', 'jobs.write'],
      github: ['git.push', 'gh.pr'],
      'channel-telegram': ['channel.send:telegram', 'approval.grant'],
    },
    pluginConfig: {
      github: { ghBin: FAKE_GH, ...ghConfig },
      'channel-telegram': { tokenEnv: TOKEN_ENV, allowedChatIds: [CHAT], apiBase: fake.apiBase, pollTimeoutSec: 0 },
    },
    logger,
  });
  kernels.push(k);
  await k.start();

  const cards = (kind: string) => fake.texts(CHAT).filter((t) => t.includes(`approval needed: ${kind}`));
  const approve = async (jobId: string, kind: 'plan' | 'merge', nth: number) => {
    await until(() => cards(kind).length >= nth, `${kind} card ${nth}`, 15000);
    fake.press(CHAT, 1, 'card', `ap:${jobId}:${kind}`);
  };
  return { k, repo, fake, setState, calls, cards, approve };
}

const mergeCalls = (r: Awaited<ReturnType<typeof rig>>) => r.calls().filter((c) => c.args[1] === 'merge');

describe('a merge that cannot go through', () => {
  it('failing checks end the job with the reason, send one merge card, and show the check name in Telegram', async () => {
    const r = await rig();
    r.setState({ log: join(r.repo, '..', 'gh.log'), checks: [{ name: 'Typecheck & build', bucket: 'fail', link: 'https://example.test/runs/9' }] });
    const job = r.k.jobs.create({ repo: r.repo, title: 'Add a thing' });

    await r.approve(job.id, 'plan', 1);
    await r.approve(job.id, 'merge', 1);
    await until(() => r.k.jobs.get(job.id)!.status === 'failed', 'the job to fail', 15000);

    // The user is not asked again, however long we wait, and nothing was merged.
    await new Promise((res) => setTimeout(res, 300));
    expect(r.cards('merge')).toHaveLength(1);
    expect(r.k.history(job.id).filter((e) => e.type === 'merge.requested')).toHaveLength(1);
    expect(r.k.history(job.id).some((e) => e.type === 'merge.refused')).toBe(false);
    expect(mergeCalls(r)).toHaveLength(0);

    // The reason reached Telegram, with the check name, the link and what to do.
    const said = r.fake.texts(CHAT).filter((t) => t.includes('Typecheck & build') && !t.includes('approval needed'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('merge failed: checks failing: Typecheck & build. Fix the failing check, then run the job again.');
    expect(said[0]).toContain('https://example.test/runs/9');

    // The job failed with that reason, and its worktree and branch are gone.
    const stages = r.k.jobs.stages(job.id);
    expect(stages.filter((s) => s.name === 'approve-merge')).toHaveLength(1);
    expect(stages.at(-1)).toMatchObject({ name: 'merge', status: 'failed' });
    expect(JSON.stringify(stages.at(-1)!.output)).toContain('checks failing: Typecheck & build');
    await until(() => r.k.history(job.id).some((e) => e.type === 'worktree.cleaned'), 'the cleanup', 15000);
    expect(existsSync(join(r.repo, '.worktrees', job.id))).toBe(false);
    expect(git(r.repo, 'branch', '--list', 'bulig/*')).toBe('');
  });

  it('pending checks that turn green merge on the one approval', async () => {
    const r = await rig({ checksPollMs: 20, checksWaitMs: 20_000 });
    const pending = [{ name: 'ci', bucket: 'pending' }];
    r.setState({ log: join(r.repo, '..', 'gh.log'), checksSequence: [pending, pending, [{ name: 'ci', bucket: 'pass' }]] });
    const job = r.k.jobs.create({ repo: r.repo, title: 'Add a thing' });

    await r.approve(job.id, 'plan', 1);
    await r.approve(job.id, 'merge', 1);
    await until(() => r.k.jobs.get(job.id)!.status === 'done', 'the job to finish', 15000);
    expect(r.cards('merge')).toHaveLength(1);
    expect(mergeCalls(r)).toHaveLength(1);
    expect(r.k.history(job.id).some((e) => e.type === 'merge.refused' || e.type === 'merge.failed')).toBe(false);
  });
});

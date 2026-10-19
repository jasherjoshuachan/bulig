import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS, addWorktree, bootGateway, makeDriver, makeWorld, TOKENS, tmp, waitFor, onCleanup } from './support.ts';
import { startRemoteWorker } from '../src/client.ts';

// The worker process holds a token for the kernel, and on a server it also has credential files. None of that may reach the Claude
// session it starts: Claude runs model-written commands.

const FAKE = fileURLToPath(new URL('../../worker-claude-code/test/fixtures/fake-claude.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const SECRETS = {
  BULIG_WORKER_TOKEN: 'worker-token-leak-check',
  BULIG_DATABASE_URL: 'postgres://u:pw_leak_check@127.0.0.1/db',
  DATABASE_URL: 'postgres://u:pw_leak_check@127.0.0.1/db',
  BULIG_TELEGRAM_TOKEN: 'tg_leak_check',
  BULIG_GH_TOKEN: 'ghp_leak_check',
  GH_TOKEN: 'ghp_leak_check_2',
  GITHUB_TOKEN: 'ghp_leak_check_3',
  AWS_SECRET_ACCESS_KEY: 'aws_leak_check',
  CREDENTIALS_DIRECTORY: '/run/credentials/bulig.service',
};
const saved = { ...process.env };
beforeEach(() => Object.assign(process.env, SECRETS));
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe.each(ADAPTERS.filter((a) => !a.skip).slice(0, 1))('a remote worker, $name', (adapter) => {
  it('a secret set in the worker process\'s environment is absent from the Claude it starts', async () => {
    const world = makeWorld();
    const store = await adapter.open();
    const driver = makeDriver();
    const { k, url } = await bootGateway(store, { plugins: [driver.plugin] });
    const job = await k.jobs.create({ repo: world.repo, title: 'x' });
    const cwd = addWorktree(world.repo, job.id);
    const dump = join(tmp(), 'env.json');
    // The dump path is a test variable, passed on purpose, as in the in-process worker's own leak test.
    process.env.FAKE_CLAUDE_ENV_DUMP = dump;
    const w = startRemoteWorker({ kernelUrl: url, workerId: 'mac', token: TOKENS.mac, slots: 1, repos: { [world.repo]: world.clone }, workdir: world.workdir, claudeBin: FAKE, passEnv: ['FAKE_CLAUDE_ENV_DUMP'], retryMs: 100 });
    onCleanup(() => w.stop());
    await driver.ask(job, cwd, 'plan');
    await waitFor(() => driver.events.some((e) => e.type === 'stage.completed'), 60_000, 'the stage to finish');

    const raw = readFileSync(dump, 'utf8');
    const env = JSON.parse(raw) as Record<string, string>;
    for (const name of Object.keys(SECRETS)) expect(env, name).not.toHaveProperty(name);
    expect(raw).not.toContain('leak_check');
    expect(raw).not.toContain(TOKENS.mac);
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
  });
});

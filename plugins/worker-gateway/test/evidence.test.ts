import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import gate from '../../gate-evidence/src/index.ts';
import { startRemoteWorker } from '../src/client.ts';
import { ADAPTERS, addWorktree, bootGateway, git, makeDriver, makeWorld, TOKENS, waitFor } from './support.ts';

// Job 99507748 ran on the server's remote worker, so its stage results reached the evidence gate through this gateway. The worktree
// facts must survive that road: a real remote worker, the real endpoint, the real gate, on both stores.

const REVIEW_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-review.mjs', import.meta.url));
chmodSync(REVIEW_CLAUDE, 0o755);

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`worktree facts from a remote worker reach the evidence gate, ${adapter.name}`, () => {
    it('job 99507748 review: lodash/chunk.js does not warn, src/chunk.js still does', async () => {
      const world = makeWorld();
      // The job's repository: lodash is a dependency, src/chunk.js imports it.
      mkdirSync(join(world.repo, 'src'));
      writeFileSync(join(world.repo, 'package.json'), JSON.stringify({ name: 'chunky', dependencies: { lodash: '^4.17.21' } }));
      writeFileSync(join(world.repo, 'src', 'chunk.js'), "import chunk from 'lodash/chunk.js';\nexport default chunk;\n");
      git(world.repo, 'add', '-A');
      git(world.repo, 'commit', '-qm', 'chunk helper');
      git(world.repo, 'push', '-q', 'origin', 'main');

      const driver = makeDriver();
      const boot = await bootGateway(await adapter.open(), {
        plugins: [driver.plugin, gate],
        // What the CLI sets when the gateway is on: its results count as evidence.
        pluginConfig: { 'gate-evidence': { evidenceSources: ['worker-claude-code', 'worker-gateway'] } },
      });
      const job = await boot.k.jobs.create({ repo: world.repo, title: 'A lodash-based chunk helper' });
      const cwd = addWorktree(world.repo, job.id);
      const worker = startRemoteWorker({
        kernelUrl: boot.url, workerId: 'mac', token: TOKENS.mac, slots: 1, repos: { [world.repo]: world.clone }, workdir: world.workdir,
        claudeBin: REVIEW_CLAUDE, retryMs: 50,
      });
      try {
        await driver.ask(job, cwd, 'review', 'readonly', 'You are an independent reviewer');
        await waitFor(() => driver.events.some((e) => e.type === 'stage.checked'), 60_000, 'the checked review');
        const completed = driver.events.find((e) => e.type === 'stage.completed')!;
        expect(completed.source).toBe('worker-gateway');
        expect((completed.payload as { repoFacts: unknown }).repoFacts).toEqual({ dirs: ['src'], deps: ['lodash'] });
        const unverified = (driver.events.find((e) => e.type === 'stage.checked')!.payload as { unverified: string[] }).unverified;
        expect(unverified).toEqual([expect.stringMatching(/^Unverified: no record of reading src\/chunk\.js this turn/)]);
      } finally {
        await worker.stop();
      }
    }, 120_000);
  });
}

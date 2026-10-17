import { describe, expect, it } from 'vitest';
import { createKernel } from '@bulig/core';
import { definePlugin, type JobsApi, type Plugin } from '@bulig/plugin-sdk';
import pipeline from '../src/index.ts';
import { fakeGithub, fakeHuman, fakeWorker, logger, newDb, settle, stageNames, types, type Sent } from './harness.ts';

const PASS = 'All good.\nVERDICT: PASS';

/** The pipeline with every job call made slow, as a database server would make it: a wait before the call and one after. */
function slowPipeline(ms: number): Plugin {
  const sleep = () => new Promise<void>((r) => setTimeout(r, ms));
  return definePlugin({
    manifest: pipeline.manifest,
    register(ctx) {
      const slow = Object.fromEntries(
        (['create', 'get', 'list', 'setStatus', 'stages', 'startStage', 'finishStage'] as const).map((name) => [
          name,
          async (...args: unknown[]) => {
            await sleep();
            const out = await (ctx.jobs[name] as (...a: unknown[]) => Promise<unknown>)(...args);
            await sleep();
            return out;
          },
        ]),
      ) as unknown as JobsApi;
      return pipeline.register({ ...ctx, jobs: slow });
    },
  });
}

/** Runs a job to the end. Each approval is given twice, back to back, the way a double tap on a button does. */
async function scenario(slowMs: number | undefined) {
  const worker: Sent[] = [];
  const github: { type: string; payload: unknown }[] = [];
  const human = fakeHuman();
  const plugins = [fakeWorker({ test: PASS, review: PASS }, worker), fakeGithub(github), human.plugin];
  const k = bootWith(slowMs === undefined ? pipeline : slowPipeline(slowMs), plugins);
  await k.start();
  await settle(k);
  const job = k.jobs.create({ repo: '/repo', title: 'Add multiply', body: 'Add src/multiply.js' });
  await settle(k);
  human.grant(job.id, 'plan');
  human.grant(job.id, 'plan');
  await settle(k);
  human.grant(job.id, 'merge');
  human.grant(job.id, 'merge');
  await settle(k);
  return {
    status: k.jobs.get(job.id)!.status,
    stages: stageNames(k, job.id),
    events: types(k, job.id),
    worker: worker.map((s) => s.stage),
    github: github.map((g) => g.type),
  };
}

function bootWith(pipelinePlugin: Plugin, plugins: Plugin[]) {
  return createKernel({
    dbPath: newDb(),
    plugins: [pipelinePlugin, ...plugins],
    enabled: ['pipeline-dev', ...plugins.map((p) => p.manifest.name)],
    grants: { 'pipeline-dev': ['merge.request', 'jobs.write'], 'fake-human': ['approval.grant'] },
    logger,
  });
}

describe('the pipeline handles one event at a time, in the order the bus delivered them', () => {
  it('slow job calls give the same stages, events and end state as instant ones, with each approval acted on once', async () => {
    const fast = await scenario(undefined);
    expect(fast.status).toBe('done');
    expect(fast.worker).toEqual(['plan', 'critique', 'build', 'test', 'docs', 'review']);

    const slow = await scenario(4);
    expect(slow.worker).toEqual(fast.worker);
    expect(slow.stages).toEqual(fast.stages);
    expect(slow.github).toEqual(fast.github);
    expect(slow.events).toEqual(fast.events);
    expect(slow.status).toBe('done');
  });
});

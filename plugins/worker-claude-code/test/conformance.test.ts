import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import { createWorker } from '../src/index.ts';

const J1 = fakeJobId(1);

describeConformance('worker-claude-code', {
  load: () => createWorker(),
  // stopGraceMs keeps stop() quick if a run were ever alive. The harness refuses to start a process, so none is.
  config: { stopGraceMs: 50 },
  // The worker makes a temp directory for each run before it starts claude. Let that through so the run reaches spawn(), which stays refused.
  allowEffects: ['fs-write'],
  scenarios: [
    {
      name: 'a stage request and a cancelled job',
      jobs: [{ repo: '/tmp/none', title: 'a job', status: 'running' }],
      events: [
        { type: 'stage.requested', jobId: J1, payload: { stage: 'plan', prompt: 'p', model: 'opus', mode: 'readonly', cwd: '/tmp/none' } },
        { type: 'stage.requested', jobId: J1, payload: { stage: 'plan' } },
        { type: 'job.status', jobId: J1, payload: { from: 'running', to: 'cancelled' } },
      ],
    },
  ],
});

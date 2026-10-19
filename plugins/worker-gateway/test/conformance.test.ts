import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import { createGateway } from '../src/index.ts';

const J1 = fakeJobId(1);
// A test value for this file only. The harness refuses to open a port, so nothing listens.
process.env.CONFORMANCE_GATEWAY_TOKEN = 'conformance-test-token-0123';

describeConformance('worker-gateway', {
  load: () => createGateway(),
  config: { port: 0, workers: { mac: { tokenEnv: 'CONFORMANCE_GATEWAY_TOKEN' } } },
  invalidConfigs: [
    { config: { listen: ['0.0.0.0'], workers: {} }, reason: 'listens on every interface' },
    { config: { listen: ['::'], workers: {} }, reason: 'listens on every interface (IPv6)' },
    { config: { workers: { mac: { tokenEnv: 'CONFORMANCE_GATEWAY_UNSET' } } }, reason: 'the token variable is not set' },
    { config: { heartbeatMs: 10_000, heartbeatTimeoutMs: 12_000, workers: {} }, reason: 'one missed beat would lose a stage' },
  ],
  allowEffects: ['network', 'process', 'fs-write'],
  scenarios: [
    {
      name: 'a stage request and a job that ends',
      jobs: [{ repo: '/tmp/none', title: 'a job', status: 'running' }],
      events: [
        { type: 'stage.requested', jobId: J1, payload: { stage: 'plan', prompt: 'p', model: 'opus', mode: 'readonly', cwd: '/tmp/none' } },
        { type: 'stage.requested', jobId: J1, payload: { stage: 'plan' } },
        { type: 'job.status', jobId: J1, payload: { from: 'running', to: 'cancelled' } },
      ],
    },
  ],
});

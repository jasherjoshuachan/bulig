import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import plugin from '../src/index.ts';

const J1 = fakeJobId(1);
const J2 = fakeJobId(2);
const done = (result: string) => ({ type: 'stage.completed', jobId: J1, source: 'worker-claude-code', payload: { stage: 'test', ok: true, result, evidence: [] } });

describeConformance('gate-evidence', {
  load: () => plugin,
  invalidConfigs: [{ config: { mode: 'strict' }, reason: 'mode is neither warn nor enforce' }],
  scenarios: [
    { name: 'warn', events: [done('All tests pass.')] },
    { name: 'enforce', config: { mode: 'enforce' }, events: [done('All tests pass.')] },
    { name: 'off', config: { enabled: false }, events: [done('All tests pass.')] },
  ],
  strictEmits: true,
});

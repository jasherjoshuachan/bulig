import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import plugin from '../src/index.ts';

const J1 = fakeJobId(1);
const J2 = fakeJobId(2);
const done = (type: 'stage.completed' | 'stage.checked', result: string) => ({ type, jobId: J1, payload: { stage: 'plan', ok: true, result } });

describeConformance('gate-promise', {
  load: () => plugin,
  invalidConfigs: [
    { config: { mode: 'strict' }, reason: 'mode is neither warn nor enforce' },
    { config: { input: 'stage.screened' }, reason: 'input is neither stage.completed nor stage.checked' },
  ],
  scenarios: [
    { name: 'warn', events: [done('stage.completed', "I'll follow up on this later.")] },
    { name: 'enforce', config: { mode: 'enforce' }, events: [done('stage.completed', "I'll follow up on this later.")] },
    { name: 'behind the evidence gate', config: { input: 'stage.checked' }, events: [done('stage.checked', 'Nothing to promise.')] },
  ],
  strictEmits: true,
});

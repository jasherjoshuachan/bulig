import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import { createCliChannel, type CliChannel } from '../src/index.ts';

const J1 = fakeJobId(1);

let channel: CliChannel;

describeConformance('channel-cli', {
  load: () => (channel = createCliChannel({ write: () => {} })).plugin,
  scenarios: [
    {
      name: 'shows events and takes an approval',
      jobs: [{ repo: '/tmp/r', title: 'a job' }],
      events: [
        { type: 'approval.requested', jobId: J1, payload: { jobId: J1, kind: 'plan', summary: 'PLAN', scope: ['README.md'] } },
        { type: 'job.status', jobId: J1, payload: { from: 'running', to: 'awaiting_approval' } },
        { type: 'stage.completed', jobId: J1, payload: { stage: 'plan' } },
        { type: 'pr.opened', jobId: J1, payload: { url: 'https://example.test/pr/1', number: 1, headSha: 'abc' } },
      ],
      act: () => {
        channel.grant(J1, 'plan');
        channel.deny(J1);
      },
    },
  ],
  strictEmits: true,
});

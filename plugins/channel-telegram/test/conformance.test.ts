import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import { createTelegramChannel } from '../src/index.ts';

// A test value for this file only. The harness never lets a request leave the machine.
process.env.CONFORMANCE_TELEGRAM_TOKEN = 'conformance-test-token';
const J1 = fakeJobId(1);
const J2 = fakeJobId(2);
const config = { tokenEnv: 'CONFORMANCE_TELEGRAM_TOKEN', allowedChatIds: [1], allowedUserIds: [7], repos: { demo: '/tmp' } };

let id = 10;
const button = (data: string) => ({ update_id: id++, callback_query: { id: 'q1', data, from: { id: 7, first_name: 'T' }, message: { message_id: 5, text: 'approval needed', chat: { id: 1 } } } });
const say = (id: number, text: string) => ({ update_id: id, message: { message_id: id, text, chat: { id: 1 }, from: { id: 7 } } });

// Telegram answers the first getUpdates with the taps and commands below, and holds every later poll open.
const updates = [button(`ap:${J1}:plan`), button(`dn:${J1}:plan`), say(11, '/dev demo Add a thing'), say(12, `/cancel ${J2}`)];
const respondToFetch = (url: string, _init: unknown, n: number) => {
  if (url.endsWith('/getUpdates')) return n === 1 ? { ok: true, result: updates } : undefined;
  return { ok: true, result: { message_id: 1 } };
};

const seeded = [
  { repo: '/tmp', title: 'waiting', status: 'awaiting_approval' as const, stages: [{ name: 'approve-plan', status: 'running' as const }] },
  { repo: '/tmp', title: 'busy', status: 'running' as const },
];

describeConformance('channel-telegram', {
  load: () => createTelegramChannel(),
  config,
  invalidConfigs: [
    { config: { ...config, allowedChatIds: [] }, reason: 'no allowed chat' },
    { config: { ...config, allowedUserIds: ['x'] }, reason: 'allowedUserIds are not numbers' },
    { config: { ...config, tokenEnv: 'CONFORMANCE_TELEGRAM_UNSET' }, reason: 'the token variable is not set' },
  ],
  respondToFetch,
  scenarios: [
    {
      name: 'taps, commands and progress',
      jobs: seeded,
      events: [
        { type: 'approval.requested', jobId: J1, payload: { jobId: J1, kind: 'plan', summary: 'PLAN', scope: ['a.md'] } },
        { type: 'stage.completed', jobId: J1, payload: { stage: 'test', result: 'VERDICT: PASS' } },
        { type: 'stage.failed', jobId: J1, payload: { stage: 'build', error: 'x' } },
        { type: 'pr.opened', jobId: J1, payload: { url: 'https://example.test/1' } },
        { type: 'merge.failed', jobId: J1, payload: { reason: 'checks failed', checks: [{ name: 'ci', link: 'https://example.test/ci' }] } },
      ],
      waitMs: 300,
    },
  ],
  strictEmits: true,
});

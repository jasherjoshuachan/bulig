import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import plugin from '../src/index.ts';

const J1 = fakeJobId(1);
const ev = (type: string, payload: unknown = {}) => ({ type, jobId: J1, payload });
const done = (stage: string, result: string) => ev('stage.completed', { stage, ok: true, result });
const SCOPE = 'PLAN\nSCOPE:\n- README.md';

describeConformance('pipeline-dev', {
  strictEmits: true,
  load: () => plugin,
  invalidConfigs: [
    { config: { scopeMode: 'loose' }, reason: 'scopeMode is neither enforce nor warn' },
    { config: { stageResultEvent: 'stage.done' }, reason: 'stageResultEvent is not one of the three events' },
  ],
  scenarios: [
    {
      name: 'a whole job, plan to merge',
      jobs: [{ repo: '/tmp/none', title: 'Add a thing' }],
      events: [
        ev('kernel.started', { plugins: ['pipeline-dev'] }),
        ev('worktree.ready', { cwd: '/tmp/none/.worktrees/x', branch: 'bulig/add-a-thing' }),
        done('plan', SCOPE),
        done('critique', 'fine'),
        ev('approval.granted', { jobId: J1, kind: 'plan' }),
        done('build', 'built'),
        ev('commit.done', { sha: 'a1', base: 'b0' }),
        done('test', 'VERDICT: PASS'),
        ev('commit.done', { sha: 'a2', base: 'b0' }),
        done('docs', 'documented'),
        ev('commit.done', { sha: 'a3', base: 'b0' }),
        done('review', 'VERDICT: PASS'),
        ev('pr.opened', { url: 'https://example.test/pr/1', number: 1, headSha: 'a3' }),
        ev('approval.granted', { jobId: J1, kind: 'merge' }),
        ev('pr.merged', { number: 1 }),
      ],
    },
    {
      name: 'a job that starts, is reset after a restart, then fails and is cleaned up',
      jobs: [{ repo: '/tmp/none', title: 'Restarted', status: 'running', stages: [{ name: 'worktree', output: { cwd: '/tmp/none/.worktrees/x', branch: 'bulig/r' } }, { name: 'build', status: 'running' }] }],
      events: [ev('kernel.started'), ev('worktree.reset.done', { cwd: '/tmp/none/.worktrees/x' }), ev('worktree.failed', { error: 'no' })],
    },
    {
      name: 'the worktree cannot be made',
      jobs: [{ repo: '/tmp/none', title: 'Broken', status: 'running', stages: [{ name: 'worktree', status: 'running' }] }],
      events: [ev('worktree.failed', { error: 'not a git repo' })],
    },
    {
      name: 'a person cancels a job',
      jobs: [{ repo: '/tmp/none', title: 'Cancelled', status: 'running', stages: [{ name: 'worktree', output: { cwd: '/tmp/none/.worktrees/x', branch: 'bulig/c' } }] }],
      events: [ev('cancel.requested', { jobId: J1 }), ev('job.status', { from: 'running', to: 'cancelled' })],
    },
    {
      name: 'a gate sits in front of the pipeline',
      config: { stageResultEvent: 'stage.screened' },
      jobs: [{ repo: '/tmp/none', title: 'Gated' }],
      events: [ev('job.created'), ev('stage.screened', { stage: 'plan', ok: true, result: SCOPE, promises: [] }), ev('stage.checked', { stage: 'plan' })],
    },
  ],
});

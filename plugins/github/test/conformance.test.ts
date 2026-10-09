import { describeConformance, fakeJobId } from '@bulig/plugin-sdk/conformance';
import githubPlugin from '../src/index.ts';

const J1 = fakeJobId(1);
const gone = '/tmp/bulig-conformance-does-not-exist';

describeConformance('github', {
  // The default export keeps module state (one stopper per registered copy), so each run gets the same object on purpose:
  // stop() must still leave nothing behind.
  load: () => githubPlugin,
  config: { tries: 1, retryDelayMs: 1 },
  invalidConfigs: [{ config: { authorName: 'Bot' }, reason: 'authorName without authorEmail' }],
  scenarios: [
    {
      name: 'every request fails because the harness refuses to start git or gh',
      jobs: [{ repo: gone, title: 'a job', status: 'running' }],
      events: [
        { type: 'worktree.requested', jobId: J1, payload: { repoPath: gone, branch: 'bulig/x' } },
        { type: 'worktree.reset.requested', jobId: J1, payload: { cwd: `${gone}/.worktrees/${J1}` } },
        { type: 'worktree.cleanup.requested', jobId: J1, payload: { repoPath: gone, branch: 'bulig/x' } },
        { type: 'commit.requested', jobId: J1, payload: { cwd: gone, message: 'm', scope: ['a.md'] } },
        { type: 'pr.requested', jobId: J1, payload: { cwd: gone, branch: 'b', title: 't', body: '', expectSha: 'abc' } },
        { type: 'merge.requested', jobId: J1, payload: { cwd: gone, branch: 'b', number: 1, headSha: 'abc' } },
        { type: 'job.status', jobId: J1, payload: { from: 'running', to: 'cancelled' } },
      ],
    },
  ],
});

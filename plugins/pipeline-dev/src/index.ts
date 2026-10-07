import { definePlugin, type BuligEvent, type Job, type PluginContext, type Stage } from '@bulig/plugin-sdk';
import { CLAUDE_STAGES, decide, outputOf, parseVerdict, type Action, type ClaudeStage, type StageOutput } from './decide.ts';
import { renderPrompt } from './prompts.ts';

export { decide, parseVerdict, type Action } from './decide.ts';
export { renderPrompt } from './prompts.ts';

export interface PipelineConfig {
  models?: { strong?: string; standard?: string };
  /** Most times the build stage may run for one job. Default 2. */
  maxBuildAttempts?: number;
  /** Branch name prefix. Default "bulig". */
  branchPrefix?: string;
  /** Which unfinished jobs to pick up when the kernel starts: all of them, none, or a list of job ids. Default all. */
  resume?: 'all' | false | string[];
  /** Keep the worktree and branch of a job that failed or was cancelled, for a look. Default false: they are removed. */
  keepFailedWorktrees?: boolean;
}

const READONLY = new Set<ClaudeStage>(['plan', 'critique', 'review']);
/** Stages that can leave half-written files behind if the process dies in them. */
const EDITING = new Set(['build', 'test', 'docs', 'reset']);
const STRONG = new Set<ClaudeStage>(['plan', 'critique', 'review']);
const MAX_PROMPT_TEXT = 12_000;

const clip = (s: string, n = MAX_PROMPT_TEXT) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'job';

export default definePlugin({
  manifest: {
    name: 'pipeline-dev',
    version: '0.1.0',
    sdk: '0',
    description: 'The dev pipeline: plan, critique, approve, build, test, docs, commit, review, PR, approve, merge.',
    provides: { stages: ['plan', 'critique', 'build', 'test', 'review', 'docs'] },
    subscribes: [
      'kernel.started',
      'job.created',
      'worktree.ready',
      'worktree.failed',
      'worktree.reset.done',
      'worktree.reset.failed',
      'commit.done',
      'commit.failed',
      'job.status',
      'stage.completed',
      'stage.failed',
      'approval.granted',
      'approval.denied',
      'pr.opened',
      'pr.failed',
      'pr.merged',
      'merge.refused',
      'merge.failed',
    ],
    emits: ['worktree.requested', 'worktree.reset.requested', 'worktree.cleanup.requested', 'commit.requested', 'stage.requested', 'approval.requested', 'pr.requested', 'merge.requested', 'pipeline.failed'],
    needs: ['merge.request'],
  },
  register(ctx: PluginContext) {
    ctx.require('merge.request');
    const cfg = ctx.config as PipelineConfig;
    const strong = cfg.models?.strong ?? 'opus';
    const standard = cfg.models?.standard ?? 'sonnet';
    const maxBuilds = cfg.maxBuildAttempts ?? 2;
    const prefix = cfg.branchPrefix ?? 'bulig';

    /** Edit stages whose Claude run is done and whose commit is still being made. Lost on a restart, which just reruns the stage. */
    const committing = new Map<string, { stage: string; status: 'passed' | 'failed'; out: StageOutput }>();
    const stagesOf = (jobId: string) => ctx.jobs.stages(jobId).filter((s) => !outputOf(s).interrupted);
    const lastOf = (stages: Stage[], name: string) => [...stages].reverse().find((s) => s.name === name);
    const runningStage = (jobId: string, name: string) => ctx.jobs.stages(jobId).find((s) => s.name === name && s.status === 'running');
    const textOf = (stages: Stage[], name: string) => outputOf(lastOf(stages, name) ?? ({ output: null } as Stage)).result ?? '';

    function fail(jobId: string, reason: string): void {
      const job = ctx.jobs.get(jobId);
      if (!job || job.status === 'failed' || job.status === 'done' || job.status === 'cancelled') return;
      ctx.jobs.setStatus(jobId, 'failed');
      ctx.emit('pipeline.failed', { reason }, jobId);
    }

    /** Run a handler's body; if it throws, the job fails with the reason instead of hanging. */
    function guard(jobId: string | undefined, body: () => void): void {
      try {
        body();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.log.error(`pipeline-dev: ${reason}`);
        if (jobId) fail(jobId, reason);
      }
    }

    function advance(jobId: string): void {
      const job = ctx.jobs.get(jobId);
      if (!job) return;
      const action = decide(job, stagesOf(jobId), maxBuilds);
      perform(job, action);
    }

    function perform(job: Job, action: Action): void {
      const stages = stagesOf(job.id);
      switch (action.kind) {
        case 'wait':
          return;
        case 'done':
          if (job.status !== 'done') ctx.jobs.setStatus(job.id, 'done');
          return;
        case 'cancelled':
          if (job.status !== 'cancelled') ctx.jobs.setStatus(job.id, 'cancelled');
          return;
        case 'fail':
          return fail(job.id, action.reason);
        case 'worktree': {
          ctx.jobs.startStage(job.id, 'worktree');
          const branch = `${prefix}/${slug(job.title)}-${job.id.slice(0, 8)}`;
          ctx.emit('worktree.requested', { repoPath: job.repo, branch }, job.id);
          return;
        }
        case 'stage': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const name = action.name;
          const prompt = renderPrompt(name, {
            title: job.title,
            issue: job.body || '(no extra details were given)',
            plan: clip(textOf(stages, 'plan')),
            critique: clip(textOf(stages, 'critique')),
            base: String(outputOf(lastOf(stages, 'docs') ?? ({ output: null } as Stage)).base ?? ''),
            sha: String(outputOf(lastOf(stages, 'docs') ?? ({ output: null } as Stage)).sha ?? ''),
            feedback: action.feedback ? `\nThis is a retry. Fix these problems first:\n\n${clip(action.feedback)}\n` : '',
          });
          ctx.jobs.startStage(job.id, name);
          ctx.emit(
            'stage.requested',
            {
              stage: name,
              prompt,
              model: STRONG.has(name) ? strong : standard,
              mode: READONLY.has(name) ? 'readonly' : 'edit',
              cwd: String(wt.cwd),
            },
            job.id,
          );
          return;
        }
        case 'approve': {
          const stageName = `approve-${action.which}`;
          ctx.jobs.startStage(job.id, stageName);
          ctx.jobs.setStatus(job.id, 'awaiting_approval');
          if (action.which === 'plan') {
            const summary = `PLAN\n${textOf(stages, 'plan')}\n\nCRITIQUE\n${textOf(stages, 'critique')}`;
            ctx.emit('approval.requested', { jobId: job.id, kind: 'plan', summary: clip(summary, 4000) }, job.id);
          } else {
            const pr = outputOf(lastOf(stages, 'pr')!);
            const review = textOf(stages, 'review');
            ctx.emit(
              'approval.requested',
              {
                jobId: job.id,
                kind: 'merge',
                url: pr.url,
                headSha: pr.headSha,
                summary: clip(`${action.renewed ? 'The last merge was refused. Approve again to retry.\n\n' : ''}REVIEW\n${review}`, 4000),
              },
              job.id,
            );
          }
          return;
        }
        case 'pr': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const reviewed = outputOf(lastOf(stages, 'docs')!);
          ctx.jobs.startStage(job.id, 'pr');
          const body = [
            job.body ? `## Task\n\n${job.body}` : `## Task\n\n${job.title}`,
            `## Plan\n\n${clip(textOf(stages, 'plan'), 3000)}`,
            `## Independent review\n\n${clip(textOf(stages, 'review'), 3000)}`,
            `Opened by Bulig, job ${job.id}.`,
          ].join('\n\n');
          // expectSha is the commit the reviewer saw. The github plugin opens the PR only if HEAD is exactly that.
          ctx.emit('pr.requested', { cwd: String(wt.cwd), branch: String(wt.branch), title: job.title, body, expectSha: String(reviewed.sha) }, job.id);
          return;
        }
        case 'merge': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const pr = outputOf(lastOf(stages, 'pr')!);
          ctx.jobs.startStage(job.id, 'merge');
          ctx.emit('merge.requested', { cwd: String(wt.cwd), branch: String(wt.branch), number: pr.number, headSha: pr.headSha }, job.id);
          return;
        }
      }
    }

    // ----- resume -----

    ctx.on('kernel.started', () => {
      if (cfg.resume === false) return;
      for (const job of ctx.jobs.list()) {
        if (Array.isArray(cfg.resume) && !cfg.resume.includes(job.id)) continue;
        if (job.status !== 'queued' && job.status !== 'running') continue;
        guard(job.id, () => {
          // A stage still marked running belongs to a process that is gone. Mark it, and it runs again.
          let mayHaveHalfDoneEdits = false;
          for (const s of ctx.jobs.stages(job.id)) {
            if (s.status !== 'running') continue;
            ctx.jobs.finishStage(s.id, 'failed', { interrupted: true, reason: 'interrupted', error: 'process stopped mid-stage' });
            if (EDITING.has(s.name)) mayHaveHalfDoneEdits = true;
          }
          if (job.status === 'queued') ctx.jobs.setStatus(job.id, 'running');
          // Throw away what the dead stage left on disk. Finished edit stages were committed, so this only costs the cut-off one.
          const wt = lastOf(stagesOf(job.id), 'worktree');
          if (mayHaveHalfDoneEdits && wt?.status === 'passed' && outputOf(wt).cwd) {
            ctx.jobs.startStage(job.id, 'reset');
            ctx.emit('worktree.reset.requested', { cwd: String(outputOf(wt).cwd) }, job.id);
            return;
          }
          advance(job.id);
        });
      }
    });

    // ----- the graph -----

    ctx.on('job.created', (e: BuligEvent) => {
      guard(e.jobId, () => {
        if (!e.jobId) return;
        ctx.jobs.setStatus(e.jobId, 'running');
        advance(e.jobId);
      });
    });

    ctx.on('worktree.ready', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'worktree');
        if (!e.jobId || !s) return;
        const p = e.payload as { cwd: string; branch: string };
        ctx.jobs.finishStage(s.id, 'passed', { cwd: p.cwd, branch: p.branch });
        advance(e.jobId);
      });
    });

    ctx.on('worktree.failed', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'worktree');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error });
        fail(e.jobId, `worktree failed: ${error}`);
      });
    });

    // An edit stage is not finished until its work is committed. That commit is the checkpoint a restart
    // resets to, and after the last one (docs) it is the commit the reviewer judges and the PR must match.
    ctx.on('worktree.reset.done', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'reset');
        if (!e.jobId || !s) return;
        ctx.jobs.finishStage(s.id, 'passed', e.payload);
        advance(e.jobId);
      });
    });

    ctx.on('worktree.reset.failed', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'reset');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error });
        fail(e.jobId, `could not reset the worktree after the restart: ${error}`);
      });
    });

    // A job that ends without merging leaves nothing behind, unless the config says to keep it.
    ctx.on('job.status', (e) => {
      const to = (e.payload as { to?: string } | null)?.to;
      if (!e.jobId || (to !== 'failed' && to !== 'cancelled') || cfg.keepFailedWorktrees) return;
      guard(e.jobId, () => {
        const job = ctx.jobs.get(e.jobId!);
        const wt = lastOf(stagesOf(e.jobId!), 'worktree');
        const branch = wt?.status === 'passed' ? outputOf(wt).branch : undefined;
        if (job && typeof branch === 'string' && branch) ctx.emit('worktree.cleanup.requested', { repoPath: job.repo, branch }, e.jobId);
      });
    });

    ctx.on('commit.done', (e) => {
      guard(e.jobId, () => {
        const wait = e.jobId ? committing.get(e.jobId) : undefined;
        const s = e.jobId && wait && runningStage(e.jobId, wait.stage);
        if (!e.jobId || !wait || !s) return;
        committing.delete(e.jobId);
        const p = e.payload as { sha: string; base: string };
        ctx.jobs.finishStage(s.id, wait.status, { ...wait.out, sha: p.sha, base: p.base });
        advance(e.jobId);
      });
    });

    ctx.on('commit.failed', (e) => {
      guard(e.jobId, () => {
        const wait = e.jobId ? committing.get(e.jobId) : undefined;
        const s = e.jobId && wait && runningStage(e.jobId, wait.stage);
        if (!e.jobId || !wait || !s) return;
        committing.delete(e.jobId);
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error: `commit failed: ${error}` });
        fail(e.jobId, `${wait.stage} could not be committed: ${error}`);
      });
    });

    ctx.on('stage.completed', (e) => {
      guard(e.jobId, () => {
        const p = e.payload as { stage: string; result?: string; sessionId?: string; costUsd?: number };
        const s = e.jobId && runningStage(e.jobId, p.stage);
        if (!e.jobId || !s) return;
        const result = p.result ?? '';
        const out: StageOutput = { result, sessionId: p.sessionId, costUsd: p.costUsd };
        let status: 'passed' | 'failed' = 'passed';
        if (p.stage === 'test' || p.stage === 'review') {
          const verdict = parseVerdict(result);
          out.verdict = verdict ?? 'FAIL';
          if (verdict !== 'PASS') {
            status = 'failed';
            if (!verdict) out.result = `${result}\n\n(The ${p.stage} stage did not end with a VERDICT line, so it counts as a fail.)`;
          }
        }
        const live = ctx.jobs.get(e.jobId);
        const ended = live?.status === 'failed' || live?.status === 'cancelled';
        if (!READONLY.has(p.stage as ClaudeStage) && !ended) {
          // Hold the result until the work is committed.
          const wt = outputOf(lastOf(stagesOf(e.jobId), 'worktree')!);
          committing.set(e.jobId, { stage: p.stage, status, out });
          const job = ctx.jobs.get(e.jobId);
          ctx.emit('commit.requested', { cwd: String(wt.cwd), message: `${job?.title ?? 'work'} (${p.stage})` }, e.jobId);
          return;
        }
        ctx.jobs.finishStage(s.id, status, out);
        advance(e.jobId);
      });
    });

    ctx.on('stage.failed', (e) => {
      guard(e.jobId, () => {
        const p = e.payload as { stage: string; error?: string };
        const s = e.jobId && runningStage(e.jobId, p.stage);
        if (!e.jobId || !s) return;
        const error = p.error ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error });
        fail(e.jobId, `${p.stage} failed: ${error}`);
      });
    });

    ctx.on('approval.granted', (e) => {
      guard(e.jobId, () => {
        const p = e.payload as { jobId?: string; kind?: string };
        const jobId = e.jobId ?? p.jobId;
        const s = jobId && p.kind && runningStage(jobId, `approve-${p.kind}`);
        if (!jobId || !s) return;
        ctx.jobs.finishStage(s.id, 'passed', { grantedBy: e.source });
        ctx.jobs.setStatus(jobId, 'running');
        advance(jobId);
      });
    });

    ctx.on('approval.denied', (e) => {
      guard(e.jobId, () => {
        const p = e.payload as { jobId?: string };
        const jobId = e.jobId ?? p.jobId;
        const s = jobId && ctx.jobs.stages(jobId).find((x) => x.name.startsWith('approve-') && x.status === 'running');
        if (!jobId || !s) return;
        ctx.jobs.finishStage(s.id, 'failed', { deniedBy: e.source });
        ctx.jobs.setStatus(jobId, 'cancelled');
      });
    });

    ctx.on('pr.opened', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'pr');
        if (!e.jobId || !s) return;
        const p = e.payload as { url: string; number: number; headSha: string };
        ctx.jobs.finishStage(s.id, 'passed', { url: p.url, number: p.number, headSha: p.headSha });
        advance(e.jobId);
      });
    });

    ctx.on('pr.failed', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'pr');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error });
        fail(e.jobId, `pr failed: ${error}`);
      });
    });

    ctx.on('merge.refused', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        const reason = (e.payload as { reason?: string }).reason ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { refused: reason });
        advance(e.jobId);
      });
    });

    // The merge can never go through (the PR was closed, or merged at a different commit). Do not ask again.
    ctx.on('merge.failed', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        const reason = (e.payload as { reason?: string }).reason ?? 'unknown';
        ctx.jobs.finishStage(s.id, 'failed', { error: reason });
        fail(e.jobId, `merge failed: ${reason}`);
      });
    });

    ctx.on('pr.merged', (e) => {
      guard(e.jobId, () => {
        const s = e.jobId && runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        ctx.jobs.finishStage(s.id, 'passed', e.payload);
        advance(e.jobId);
      });
    });
  },
});

export { CLAUDE_STAGES };

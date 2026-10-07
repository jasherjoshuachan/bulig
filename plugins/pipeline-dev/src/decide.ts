import type { Job, Stage } from '@bulig/plugin-sdk';

/** The stages that run Claude, in graph order. */
export const CLAUDE_STAGES = ['plan', 'critique', 'build', 'test', 'review', 'docs'] as const;
export type ClaudeStage = (typeof CLAUDE_STAGES)[number];

export type Action =
  | { kind: 'wait' }
  | { kind: 'worktree' }
  | { kind: 'stage'; name: ClaudeStage; feedback?: string }
  | { kind: 'approve'; which: 'plan' | 'merge'; renewed?: boolean }
  | { kind: 'pr' }
  | { kind: 'merge' }
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fail'; reason: string };

export interface StageOutput {
  result?: string;
  error?: string;
  verdict?: 'PASS' | 'FAIL';
  interrupted?: boolean;
  /** The commit made when an edit stage finished, and where the branch left the base branch. */
  sha?: string;
  base?: string;
  [key: string]: unknown;
}

export const outputOf = (s: Stage): StageOutput => (s.output && typeof s.output === 'object' ? (s.output as StageOutput) : {});

/** The last `VERDICT: PASS|FAIL` line in a stage's text. Undefined when there is none. */
export function parseVerdict(text: string): 'PASS' | 'FAIL' | undefined {
  const all = [...text.matchAll(/^[\s>*_`#-]*VERDICT:\s*(PASS|FAIL)\b/gim)];
  const last = all[all.length - 1];
  return last ? (last[1]!.toUpperCase() as 'PASS' | 'FAIL') : undefined;
}

/**
 * Work out what should happen next from a job's recorded stages alone. It reads no memory and no
 * events, so a fresh process can call it after a restart and land on the same answer.
 *
 * Stages whose run was cut short by a restart are marked `interrupted` and ignored, so they run again.
 */
export function decide(job: Pick<Job, 'status'>, allStages: Stage[], maxBuilds: number): Action {
  if (job.status === 'done') return { kind: 'done' };
  if (job.status === 'failed' || job.status === 'cancelled') return { kind: 'wait' };

  const live = allStages.filter((s) => !outputOf(s).interrupted);
  const last = (name: string): Stage | undefined => [...live].reverse().find((s) => s.name === name);
  const at = (s: Stage) => live.indexOf(s);
  const broke = (s: Stage) => (outputOf(s).error ? ({ kind: 'fail', reason: `${s.name} failed: ${outputOf(s).error}` } as const) : undefined);

  const worktree = last('worktree');
  if (!worktree) return { kind: 'worktree' };
  if (worktree.status === 'running') return { kind: 'wait' };
  if (worktree.status === 'failed') return broke(worktree) ?? { kind: 'fail', reason: 'worktree failed' };

  // A restart is putting the worktree back to its last commit. Nothing runs until that is done.
  if (last('reset')?.status === 'running') return { kind: 'wait' };

  for (const name of ['plan', 'critique'] as const) {
    const s = last(name);
    if (!s) return { kind: 'stage', name };
    if (s.status === 'running') return { kind: 'wait' };
    if (s.status === 'failed') return broke(s) ?? { kind: 'fail', reason: `${name} failed` };
  }

  const planOk = last('approve-plan');
  if (!planOk) return { kind: 'approve', which: 'plan' };
  if (planOk.status === 'running') return { kind: 'wait' };
  if (planOk.status === 'failed') return { kind: 'cancelled' };

  const builds = live.filter((s) => s.name === 'build').length;
  const build = last('build');
  if (!build) return { kind: 'stage', name: 'build' };
  if (build.status === 'running') return { kind: 'wait' };
  if (build.status === 'failed') return broke(build) ?? { kind: 'fail', reason: 'build failed' };

  const after = (name: string) => live.filter((s) => s.name === name && at(s) > at(build)).pop();
  // Order: build, test, docs, review. Each edit stage ends in a commit, so review judges the last one and nothing edits the code after it.
  const judged = (name: 'test' | 'review'): Action | undefined => {
    const s = after(name);
    if (!s) return { kind: 'stage', name };
    if (s.status === 'running') return { kind: 'wait' };
    if (s.status === 'failed') {
      const hard = broke(s);
      if (hard) return hard;
      const why = outputOf(s).result?.trim() || `the ${name} stage failed with no detail`;
      if (builds >= maxBuilds) return { kind: 'fail', reason: `${name} still failing after ${builds} build attempts` };
      return { kind: 'stage', name: 'build', feedback: `The ${name} stage rejected your last build:\n\n${why}` };
    }
    return undefined;
  };
  const tested = judged('test');
  if (tested) return tested;

  const docs = after('docs');
  if (!docs) return { kind: 'stage', name: 'docs' };
  if (docs.status === 'running') return { kind: 'wait' };
  if (docs.status === 'failed') return broke(docs) ?? { kind: 'fail', reason: 'docs failed' };

  const reviewed = judged('review');
  if (reviewed) return reviewed;

  const pr = last('pr');
  if (!pr) return { kind: 'pr' };
  if (pr.status === 'running') return { kind: 'wait' };
  if (pr.status === 'failed') return broke(pr) ?? { kind: 'fail', reason: 'pr failed' };

  const ok = last('approve-merge');
  const merge = last('merge');
  const refusedSince = (since: Stage) => merge !== undefined && at(merge) > at(since) && merge.status === 'failed';
  if (!ok) return { kind: 'approve', which: 'merge' };
  if (ok.status === 'running') return { kind: 'wait' };
  if (ok.status === 'failed') return { kind: 'cancelled' };
  if (merge && at(merge) > at(ok)) {
    if (merge.status === 'running') return { kind: 'wait' };
    if (merge.status === 'passed') return { kind: 'done' };
    // A merge that failed for good (not just refused) ends the job. Asking again would loop on the same commit.
    const hard = broke(merge);
    if (hard) return hard;
    // The merge was refused. Ask again, because the person may have fixed what was wrong.
    return refusedSince(ok) ? { kind: 'approve', which: 'merge', renewed: true } : { kind: 'wait' };
  }
  return { kind: 'merge' };
}

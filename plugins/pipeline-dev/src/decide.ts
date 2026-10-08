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
  | { kind: 'fail'; reason: string; outOfScope?: string[] };

export interface StageOutput {
  result?: string;
  error?: string;
  verdict?: 'PASS' | 'FAIL';
  interrupted?: boolean;
  /** The commit made when an edit stage finished, and where the branch left the base branch. */
  sha?: string;
  base?: string;
  /** On a plan stage: the approved scope, one path or glob per entry. */
  scope?: string[];
  /** On a plan stage that failed only because its SCOPE block was missing or bad: why. */
  scopeError?: string;
  /** On an edit stage whose commit was refused: the files outside the approved scope. */
  outOfScope?: string[];
  /** On an edit stage that was committed in warn mode: the files that were outside the approved scope. */
  scopeWarning?: string[];
  [key: string]: unknown;
}

/** How many tries the plan gets to produce a usable SCOPE block. */
export const MAX_PLAN_TRIES = 2;
const MAX_NAMED = 8;
const MAX_FEEDBACK_FILES = 60;

/** A list of files for a short message: the first few, then how many more. */
export function namedFiles(files: string[], n = MAX_NAMED): string {
  return files.length > n ? `${files.slice(0, n).join(', ')} and ${files.length - n} more` : files.join(', ');
}

/** The scope as a bullet list, for a prompt. */
export const scopeLines = (scope: string[] | undefined): string => (scope?.length ? scope.map((x) => `- ${x}`).join('\n') : '(none)');

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
    if (s.status === 'failed') {
      // A plan without a usable SCOPE block is asked for again once. Nothing is built without an approved scope.
      const why = name === 'plan' ? outputOf(s).scopeError : undefined;
      if (why) {
        const tries = live.filter((x) => x.name === 'plan').length;
        if (tries < MAX_PLAN_TRIES) {
          return {
            kind: 'stage',
            name: 'plan',
            feedback: `Your last plan was rejected: ${why}.\nWrite the whole plan again. It must end with the block described above: the line "SCOPE:" and then one path or glob per line, nothing else on the line.`,
          };
        }
        return { kind: 'fail', reason: `the plan still had no usable SCOPE block after ${tries} tries: ${why}` };
      }
      return broke(s) ?? { kind: 'fail', reason: `${name} failed` };
    }
  }

  const planOk = last('approve-plan');
  if (!planOk) return { kind: 'approve', which: 'plan' };
  if (planOk.status === 'running') return { kind: 'wait' };
  if (planOk.status === 'failed') return { kind: 'cancelled' };

  const builds = live.filter((s) => s.name === 'build').length;
  // An edit stage whose commit was refused for files outside the approved scope counts as a failed attempt:
  // the files go back to the build stage, until the build budget is spent.
  const scopeRetry = (s: Stage): Action | undefined => {
    const files = outputOf(s).outOfScope;
    if (!Array.isArray(files) || files.length === 0) return undefined;
    if (builds >= maxBuilds) {
      return { kind: 'fail', reason: `${s.name} left files outside the approved scope after ${builds} build attempts: ${namedFiles(files)}`, outOfScope: files };
    }
    const also = outputOf(s).verdict === 'FAIL' && outputOf(s).result?.trim() ? `\n\nThe ${s.name} stage also failed:\n\n${outputOf(s).result!.trim()}` : '';
    const shown = files.slice(0, MAX_FEEDBACK_FILES);
    const more = files.length > shown.length ? `\n(and ${files.length - shown.length} more)` : '';
    return {
      kind: 'stage',
      name: 'build',
      feedback: `These files are outside the approved scope; remove them or revert them:\n${shown.map((f) => `- ${f}`).join('\n')}${more}\n\nThe ${s.name} stage left them behind. Do not create or change any file that the scope does not list.${also}`,
    };
  };
  const build = last('build');
  if (!build) return { kind: 'stage', name: 'build' };
  if (build.status === 'running') return { kind: 'wait' };
  if (build.status === 'failed') return scopeRetry(build) ?? broke(build) ?? { kind: 'fail', reason: 'build failed' };

  const after = (name: string) => live.filter((s) => s.name === name && at(s) > at(build)).pop();
  // Order: build, test, docs, review. Each edit stage ends in a commit, so review judges the last one and nothing edits the code after it.
  const judged = (name: 'test' | 'review'): Action | undefined => {
    const s = after(name);
    if (!s) return { kind: 'stage', name };
    if (s.status === 'running') return { kind: 'wait' };
    if (s.status === 'failed') {
      const hard = broke(s);
      if (hard) return hard;
      const scoped = scopeRetry(s);
      if (scoped) return scoped;
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
  if (docs.status === 'failed') return scopeRetry(docs) ?? broke(docs) ?? { kind: 'fail', reason: 'docs failed' };

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

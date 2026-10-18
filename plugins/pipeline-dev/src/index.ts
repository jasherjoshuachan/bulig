import { definePlugin, type BuligEvent, type Job, type PluginContext, type Stage } from '@bulig/plugin-sdk';
import { parseScopeBlock } from '@bulig/scope';
import { CLAUDE_STAGES, decide, outputOf, parseVerdict, scopeLines, type Action, type ClaudeStage, type StageOutput } from './decide.ts';
import { renderPrompt } from './prompts.ts';

export { decide, namedFiles, parseVerdict, type Action } from './decide.ts';
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
  /** Globs that are always allowed to change, whatever the plan says (for example a test runner's results file). Default none. */
  scopeAlwaysAllow?: string[];
  /** "enforce" refuses a commit with files outside the approved scope. "warn" commits them and lists them in the PR. Default "enforce". */
  scopeMode?: 'enforce' | 'warn';
  /** Accept a plan whose scope matches every file (such as **). Default false. */
  allowBroadScope?: boolean;
  /**
   * The event that carries a finished Claude run. "stage.completed" is the worker's own. A gate plugin such as
   * gate-evidence sits between the two: it listens for stage.completed and says "stage.checked", and then this must
   * be "stage.checked". gate-promise ends the chain with "stage.screened" (it reads gate-evidence's stage.checked when both
   * are on, so only one event reaches this plugin). The CLI sets it for you. Default "stage.completed".
   */
  stageResultEvent?: 'stage.completed' | 'stage.checked' | 'stage.screened';
}

const READONLY = new Set<ClaudeStage>(['plan', 'critique', 'review']);
/** Stages that can leave half-written files behind if the process dies in them. */
const EDITING = new Set(['build', 'test', 'docs', 'reset']);
const STRONG = new Set<ClaudeStage>(['plan', 'critique', 'review']);
const MAX_PROMPT_TEXT = 12_000;

const clip = (s: string, n = MAX_PROMPT_TEXT) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);
/** One line, no hidden characters, cut at n. */
const shortLine = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** The strings in a list, as short lines: at most `max` of them, each cut at n. */
const lines = (v: unknown, max: number, n: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => shortLine(x, n)) : [];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'job';

export default definePlugin({
  manifest: {
    name: 'pipeline-dev',
    version: '0.1.0',
    sdk: '1',
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
      'cancel.requested',
      'stage.completed',
      'stage.checked',
      'stage.screened',
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
    needs: ['merge.request', 'jobs.write'],
  },
  register(ctx: PluginContext) {
    ctx.require('merge.request');
    ctx.require('jobs.write');
    const cfg = ctx.config as PipelineConfig;
    const strong = cfg.models?.strong ?? 'opus';
    const standard = cfg.models?.standard ?? 'sonnet';
    const maxBuilds = cfg.maxBuildAttempts ?? 2;
    const prefix = cfg.branchPrefix ?? 'bulig';
    const scopeMode = cfg.scopeMode ?? 'enforce';
    if (scopeMode !== 'enforce' && scopeMode !== 'warn') throw new Error(`pipeline-dev: scopeMode must be "enforce" or "warn", not ${JSON.stringify(scopeMode)}`);
    const scopeAllow = cfg.scopeAlwaysAllow ?? [];
    const allowBroad = cfg.allowBroadScope === true;
    const resultEvent = cfg.stageResultEvent ?? 'stage.completed';
    if (resultEvent !== 'stage.completed' && resultEvent !== 'stage.checked' && resultEvent !== 'stage.screened') {
      throw new Error(`pipeline-dev: stageResultEvent must be "stage.completed", "stage.checked" or "stage.screened", not ${JSON.stringify(resultEvent)}`);
    }

    /** Edit stages whose Claude run is done and whose commit is still being made. Lost on a restart, which just reruns the stage. */
    const committing = new Map<string, { stage: string; status: 'passed' | 'failed'; out: StageOutput }>();
    const stagesOf = async (jobId: string) => (await ctx.jobs.stages(jobId)).filter((s) => !outputOf(s).interrupted);
    const lastOf = (stages: Stage[], name: string) => [...stages].reverse().find((s) => s.name === name);
    const runningStage = async (jobId: string, name: string) => (await ctx.jobs.stages(jobId)).find((s) => s.name === name && s.status === 'running');
    const textOf = (stages: Stage[], name: string) => outputOf(lastOf(stages, name) ?? ({ output: null } as Stage)).result ?? '';

    /**
     * What a gate found out about the latest run of each named stage: the one-line count of tool calls and any
     * unverified claims. Empty when no gate ran. It goes above the model's own text on a card, so a long plan cannot push it out.
     */
    const evidenceBlock = (stages: Stage[], names: string[]): string => {
      const rows = names.flatMap((name) => {
        const out = outputOf(lastOf(stages, name) ?? ({ output: null } as Stage));
        if (typeof out.evidenceSummary !== 'string') return [];
        return [`${name}: ${out.evidenceSummary}`, ...(out.unverified ?? []).map((u) => `  ${u}`)];
      });
      const evidence = rows.length ? clip(`EVIDENCE (from the tool-use records of each stage, not from the model's text)\n${rows.join('\n')}`, 1500) : '';
      // gate-promise: promises with no live job id behind them. Its own block, so it shows with or without gate-evidence.
      const promised = names.flatMap((name) => (outputOf(lastOf(stages, name) ?? ({ output: null } as Stage)).promises ?? []).map((u) => `${name}: ${u}`));
      const promises = promised.length ? clip(`PROMISES (stage text that promises later work with no live job id)\n${promised.join('\n')}`, 1000) : '';
      return [evidence, promises].filter(Boolean).join('\n\n');
    };
    const withEvidence = (block: string, text: string) => (block ? `${block}\n\n${text}` : text);

    /** Jobs whose worktree cleanup was already asked for, so it is asked for once. */
    const cleanupAsked = new Set<string>();

    /**
     * A job that ends without merging leaves nothing behind, unless the config says to keep it. But the cleanup
     * waits until no stage of the job is still running: a Claude that is being stopped would otherwise write into,
     * or recreate, a worktree that was just removed. Every stage that closes calls this again.
     */
    async function cleanupIfIdle(jobId: string): Promise<void> {
      if (cfg.keepFailedWorktrees || cleanupAsked.has(jobId)) return;
      const job = await ctx.jobs.get(jobId);
      if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return;
      const stages = await ctx.jobs.stages(jobId);
      // A stage waiting for a person has no process behind it, so it does not hold the cleanup up.
      if (stages.some((s) => s.status === 'running' && !s.name.startsWith('approve-'))) return;
      const wt = lastOf(stages.filter((s) => !outputOf(s).interrupted), 'worktree');
      const branch = wt?.status === 'passed' ? outputOf(wt).branch : undefined;
      if (typeof branch !== 'string' || !branch) return;
      cleanupAsked.add(jobId);
      for (const s of stages) if (s.status === 'running') await ctx.jobs.finishStage(s.id, 'failed', { cancelled: true });
      await announce('worktree.cleanup.requested', { repoPath: job.repo, branch }, jobId);
    }

    /** Close a stage, then see whether that was the last thing holding up a cleanup. */
    async function finish(s: Stage, status: 'passed' | 'failed', output?: unknown): Promise<void> {
      await ctx.jobs.finishStage(s.id, status, output);
      await cleanupIfIdle(s.jobId);
    }

    /**
     * Write an event and wait until it is committed. A state change is saved first and the event that tells someone to
     * act on it second; if the second write is lost, nobody is told, and the job would wait for ever. So a lost event
     * is an error here, and the handler's guard turns it into a failed job with this reason. If failing the job cannot be
     * written either, the job stays as it is until the next start, where resume handles a running job. A job that is
     * waiting for an approval nobody was asked for is not picked up again. Approvals are now bound to the exact stage
     * they were asked for (ADR 0008), so asking again on start would be safe, but it is not done yet.
     */
    async function announce(type: string, payload: unknown, jobId: string): Promise<void> {
      try {
        await ctx.emitCommitted(type, payload, jobId);
      } catch (err) {
        throw new Error(`could not announce ${type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /** `announce` for the event that follows startStage: if it is lost, close the stage that was just opened, so a job that fails because of it can be cleaned up. */
    async function announceStage(stage: Stage, type: string, payload: unknown, jobId: string): Promise<void> {
      try {
        await announce(type, payload, jobId);
      } catch (err) {
        await finish(stage, 'failed', { error: err instanceof Error ? err.message : String(err) }).catch(() => {});
        throw err;
      }
    }

    async function fail(jobId: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
      const job = await ctx.jobs.get(jobId);
      if (!job || job.status === 'failed' || job.status === 'done' || job.status === 'cancelled') return;
      await ctx.jobs.setStatus(jobId, 'failed');
      try {
        await ctx.emitCommitted('pipeline.failed', { reason, ...extra }, jobId);
      } catch (err) {
        // The job is failed and that is on record. Only the announcement was lost, and there is no one left to tell.
        ctx.log.error(`pipeline-dev: job ${jobId} failed ("${reason}") but pipeline.failed could not be written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /** The scope the person approved with the plan. Undefined if the plan on record has none. */
    const scopeOf = (stages: Stage[]): string[] | undefined => {
      const plan = [...stages].reverse().find((s) => s.name === 'plan' && s.status === 'passed');
      const scope = plan ? outputOf(plan).scope : undefined;
      return Array.isArray(scope) && scope.length > 0 ? scope : undefined;
    };

    /**
     * Every handler body runs through this one queue, so a handler runs to completion before the next one starts, in the
     * order the bus delivered the events. Job calls are async, so without it two events for one job could be worked on
     * at once, and the state machine below (stage records, decide, advance) was never built for that. A failure is
     * passed on to whoever waits for the run, and never stops the queue.
     */
    let queue: Promise<unknown> = Promise.resolve();
    function serial<T>(body: () => T | Promise<T>): Promise<T> {
      const run = queue.then(body);
      queue = run.catch(() => undefined);
      return run;
    }

    /** Run a body now; if it throws, the job fails with the reason instead of hanging. */
    async function attempt(jobId: string | undefined, body: () => void | Promise<void>): Promise<void> {
      try {
        await body();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.log.error(`pipeline-dev: ${reason}`);
        if (jobId) await fail(jobId, reason);
      }
    }

    /** A handler's body, in its turn on the queue, with a failure turned into a failed job. */
    const guard = (jobId: string | undefined, body: () => void | Promise<void>): Promise<void> => serial(() => attempt(jobId, body));

    /** The PR's record of what each stage did and which claims had no record behind them. Nothing when no gate ran. */
    function evidenceSection(stages: Stage[]): string[] {
      const rows = ['plan', 'critique', 'build', 'test', 'docs', 'review'].flatMap((name) => {
        const out = outputOf(lastOf(stages, name) ?? ({ output: null } as Stage));
        if (typeof out.evidenceSummary !== 'string') return [];
        return [`**${name}**: ${out.evidenceSummary}`, ...(out.evidenceLines ?? []).map((l) => `- ${l}`), ...(out.unverified ?? []).map((u) => `- **${u}**`)];
      });
      const promised = ['plan', 'critique', 'build', 'test', 'docs', 'review'].flatMap((name) => (outputOf(lastOf(stages, name) ?? ({ output: null } as Stage)).promises ?? []).map((u) => `- **${name}**: ${u}`));
      return [
        ...(rows.length ? [`## Evidence\n\nTaken from the tool-use records of each stage, not from what the model wrote.\n\n${clip(rows.join('\n'), 6000)}`] : []),
        ...(promised.length ? [`## Unfulfilled promises\n\nStage text that promises later work with no live job id behind it.\n\n${clip(promised.join('\n'), 3000)}`] : []),
      ];
    }

    async function advance(jobId: string): Promise<void> {
      const job = await ctx.jobs.get(jobId);
      if (!job) return;
      const action = decide(job, await stagesOf(jobId), maxBuilds);
      await perform(job, action);
    }

    async function perform(job: Job, action: Action): Promise<void> {
      const stages = await stagesOf(job.id);
      switch (action.kind) {
        case 'wait':
          return;
        case 'done':
          if (job.status !== 'done') await ctx.jobs.setStatus(job.id, 'done');
          return;
        case 'cancelled':
          if (job.status !== 'cancelled') await ctx.jobs.setStatus(job.id, 'cancelled');
          return;
        case 'fail':
          return await fail(job.id, action.reason, action.outOfScope ? { outOfScope: action.outOfScope } : {});
        case 'worktree': {
          const opened = await ctx.jobs.startStage(job.id, 'worktree');
          const branch = `${prefix}/${slug(job.title)}-${job.id.slice(0, 8)}`;
          await announceStage(opened, 'worktree.requested', { repoPath: job.repo, branch }, job.id);
          return;
        }
        case 'stage': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const name = action.name;
          const scope = scopeOf(stages);
          // Nothing that edits files runs without an approved scope on record.
          if (!READONLY.has(name) && !scope) return await fail(job.id, `the approved plan has no recorded SCOPE, so ${name} was not run`);
          const prompt = renderPrompt(name, {
            scope: scopeLines(scope),
            title: job.title,
            issue: job.body || '(no extra details were given)',
            plan: clip(textOf(stages, 'plan')),
            critique: clip(textOf(stages, 'critique')),
            base: String(outputOf(lastOf(stages, 'docs') ?? ({ output: null } as Stage)).base ?? ''),
            sha: String(outputOf(lastOf(stages, 'docs') ?? ({ output: null } as Stage)).sha ?? ''),
            feedback: action.feedback ? `\nThis is a retry. Fix these problems first:\n\n${clip(action.feedback)}\n` : '',
          });
          const opened = await ctx.jobs.startStage(job.id, name);
          await announceStage(
            opened,
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
          const asked = await ctx.jobs.startStage(job.id, stageName);
          await ctx.jobs.setStatus(job.id, 'awaiting_approval');
          if (action.which === 'plan') {
            const summary = withEvidence(evidenceBlock(stages, ['plan', 'critique']), `PLAN\n${textOf(stages, 'plan')}\n\nCRITIQUE\n${textOf(stages, 'critique')}`);
            await announce('approval.requested', { jobId: job.id, kind: 'plan', stageId: asked.id, summary: clip(summary, 4000), scope: scopeOf(stages) ?? [] }, job.id);
          } else {
            const pr = outputOf(lastOf(stages, 'pr')!);
            const review = textOf(stages, 'review');
            await announce(
              'approval.requested',
              {
                jobId: job.id,
                kind: 'merge',
                stageId: asked.id,
                url: pr.url,
                headSha: pr.headSha,
                summary: clip(
                  `${action.renewed ? 'The last merge was refused. Approve again to retry.\n\n' : ''}${withEvidence(evidenceBlock(stages, ['build', 'test', 'docs', 'review']), `REVIEW\n${review}`)}`,
                  4000,
                ),
              },
              job.id,
            );
          }
          return;
        }
        case 'pr': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const reviewed = outputOf(lastOf(stages, 'docs')!);
          const opened = await ctx.jobs.startStage(job.id, 'pr');
          const warned = [...new Set(stages.flatMap((st) => outputOf(st).scopeWarning ?? []))];
          const body = [
            job.body ? `## Task\n\n${job.body}` : `## Task\n\n${job.title}`,
            `## Plan\n\n${clip(textOf(stages, 'plan'), 3000)}`,
            `## Approved scope\n\n${scopeLines(scopeOf(stages))}`,
            ...(warned.length
              ? [`## Files outside the approved scope\n\nscopeMode is "warn", so these were committed anyway. Check each one:\n\n${warned.map((f) => `- ${f}`).join('\n')}`]
              : []),
            `## Independent review\n\n${clip(textOf(stages, 'review'), 3000)}`,
            ...evidenceSection(stages),
            `Opened by Bulig, job ${job.id}.`,
          ].join('\n\n');
          // expectSha is the commit the reviewer saw. The github plugin opens the PR only if HEAD is exactly that.
          await announceStage(opened, 'pr.requested', { cwd: String(wt.cwd), branch: String(wt.branch), title: job.title, body, expectSha: String(reviewed.sha) }, job.id);
          return;
        }
        case 'merge': {
          const wt = outputOf(lastOf(stages, 'worktree')!);
          const pr = outputOf(lastOf(stages, 'pr')!);
          const opened = await ctx.jobs.startStage(job.id, 'merge');
          await announceStage(opened, 'merge.requested', { cwd: String(wt.cwd), branch: String(wt.branch), number: pr.number, headSha: pr.headSha }, job.id);
          return;
        }
      }
    }

    // ----- resume -----

    ctx.on('kernel.started', () =>
      serial(async () => {
        if (cfg.resume === false) return;
        for (const job of await ctx.jobs.list()) {
          if (Array.isArray(cfg.resume) && !cfg.resume.includes(job.id)) continue;
          if (job.status === 'failed' || job.status === 'cancelled') {
            // The job ended while a stage was running and the process died before the stage closed. Close it, and
            // the cleanup that was waiting for it can go ahead.
            await attempt(job.id, async () => {
              for (const s of await ctx.jobs.stages(job.id)) {
                if (s.status === 'running') await finish(s, 'failed', { interrupted: true, reason: 'interrupted', error: 'process stopped mid-stage' });
              }
            });
            continue;
          }
          if (job.status !== 'queued' && job.status !== 'running') continue;
          await attempt(job.id, async () => {
            // A stage still marked running belongs to a process that is gone. Mark it, and it runs again.
            let mayHaveHalfDoneEdits = false;
            for (const s of await ctx.jobs.stages(job.id)) {
              if (s.status !== 'running') continue;
              await finish(s, 'failed', { interrupted: true, reason: 'interrupted', error: 'process stopped mid-stage' });
              if (EDITING.has(s.name)) mayHaveHalfDoneEdits = true;
            }
            if (job.status === 'queued') await ctx.jobs.setStatus(job.id, 'running');
            // Throw away what the dead stage left on disk. Finished edit stages were committed, so this only costs the cut-off one.
            const wt = lastOf(await stagesOf(job.id), 'worktree');
            if (mayHaveHalfDoneEdits && wt?.status === 'passed' && outputOf(wt).cwd) {
              const opened = await ctx.jobs.startStage(job.id, 'reset');
              await announceStage(opened, 'worktree.reset.requested', { cwd: String(outputOf(wt).cwd) }, job.id);
              return;
            }
            await advance(job.id);
          });
        }
      }),
    );

    // ----- the graph -----

    ctx.on('job.created', (e: BuligEvent) => {
      return guard(e.jobId, async () => {
        if (!e.jobId) return;
        await ctx.jobs.setStatus(e.jobId, 'running');
        await advance(e.jobId);
      });
    });

    ctx.on('worktree.ready', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'worktree');
        if (!e.jobId || !s) return;
        const p = e.payload as { cwd: string; branch: string };
        await finish(s, 'passed', { cwd: p.cwd, branch: p.branch });
        await advance(e.jobId);
      });
    });

    ctx.on('worktree.failed', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'worktree');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        await finish(s, 'failed', { error });
        await fail(e.jobId, `worktree failed: ${error}`);
      });
    });

    // An edit stage is not finished until its work is committed. That commit is the checkpoint a restart
    // resets to, and after the last one (docs) it is the commit the reviewer judges and the PR must match.
    ctx.on('worktree.reset.done', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'reset');
        if (!e.jobId || !s) return;
        await finish(s, 'passed', e.payload);
        await advance(e.jobId);
      });
    });

    ctx.on('worktree.reset.failed', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'reset');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        await finish(s, 'failed', { error });
        await fail(e.jobId, `could not reset the worktree after the restart: ${error}`);
      });
    });

    // The job ended. If nothing is running for it, clean up now; otherwise the last stage to close does it.
    ctx.on('job.status', (e) => {
      const to = (e.payload as { to?: string } | null)?.to;
      if (!e.jobId || (to !== 'failed' && to !== 'cancelled')) return;
      return guard(e.jobId, () => cleanupIfIdle(e.jobId!));
    });

    // A channel asks to stop a job. Ending a job needs jobs.write, which only this plugin holds.
    ctx.on('cancel.requested', (e) => {
      return guard(e.jobId, async () => {
        const job = e.jobId ? await ctx.jobs.get(e.jobId) : undefined;
        if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return;
        // A stage waiting for a person is closed here. A running Claude is stopped by the worker, which also hears job.status.
        for (const s of await ctx.jobs.stages(job.id)) if (s.status === 'running' && s.name.startsWith('approve-')) await finish(s, 'failed', { cancelled: true });
        await ctx.jobs.setStatus(job.id, 'cancelled');
      });
    });

    ctx.on('commit.done', (e) => {
      return guard(e.jobId, async () => {
        const wait = e.jobId ? committing.get(e.jobId) : undefined;
        const s = e.jobId && wait && await runningStage(e.jobId, wait.stage);
        if (!e.jobId || !wait || !s) return;
        committing.delete(e.jobId);
        const p = e.payload as { sha: string; base: string; outOfScope?: unknown };
        const warned = Array.isArray(p.outOfScope) ? p.outOfScope.filter((x): x is string => typeof x === 'string') : [];
        await finish(s, wait.status, { ...wait.out, sha: p.sha, base: p.base, ...(warned.length && { scopeWarning: warned }) });
        await advance(e.jobId);
      });
    });

    ctx.on('commit.failed', (e) => {
      return guard(e.jobId, async () => {
        const wait = e.jobId ? committing.get(e.jobId) : undefined;
        const s = e.jobId && wait && await runningStage(e.jobId, wait.stage);
        if (!e.jobId || !wait || !s) return;
        committing.delete(e.jobId);
        const p = e.payload as { error?: string; outOfScope?: unknown };
        // Files outside the approved scope are not a crash: it counts as a failed attempt, and the build stage is told which files.
        const files = Array.isArray(p.outOfScope) ? p.outOfScope.filter((x): x is string => typeof x === 'string') : [];
        if (files.length) {
          await finish(s, 'failed', { ...wait.out, outOfScope: files });
          await advance(e.jobId);
          return;
        }
        const error = p.error ?? 'unknown';
        await finish(s, 'failed', { error: `commit failed: ${error}` });
        await fail(e.jobId, `${wait.stage} could not be committed: ${error}`);
      });
    });

    // A gate whose event this does not listen to has no effect. Say so once, loudly.
    // gate-evidence says stage.checked and gate-promise says stage.screened, which is the last event of the chain.
    const ignored = resultEvent === 'stage.completed' ? ['stage.checked', 'stage.screened'] : resultEvent === 'stage.checked' ? ['stage.screened'] : [];
    let told = false;
    for (const type of ignored) {
      ctx.on(type, () => {
        if (told) return;
        told = true;
        ctx.log.warn(`pipeline-dev: a gate is emitting ${type}, but stageResultEvent is "${resultEvent}", so the gate has no effect. Set stageResultEvent to "${type}".`);
      });
    }

    ctx.on(resultEvent, (e) => {
      return guard(e.jobId, async () => {
        const p = e.payload as { stage: string; result?: string; sessionId?: string; costUsd?: number; evidenceSummary?: unknown; evidenceLines?: unknown; unverified?: unknown; promises?: unknown };
        const s = e.jobId && await runningStage(e.jobId, p.stage);
        if (!e.jobId || !s) return;
        const result = p.result ?? '';
        const out: StageOutput = { result, sessionId: p.sessionId, costUsd: p.costUsd };
        // What a gate found. Kept as short lines of text, whatever shape arrived.
        if (typeof p.evidenceSummary === 'string') {
          out.evidenceSummary = shortLine(p.evidenceSummary, 300);
          out.evidenceLines = lines(p.evidenceLines, 14, 200);
          out.unverified = lines(p.unverified, 8, 300);
        }
        // What gate-promise found. Kept apart from the evidence lines so the two gates cannot overwrite each other.
        const promises = lines(p.promises, 8, 300);
        if (promises.length) out.promises = promises;
        let status: 'passed' | 'failed' = 'passed';
        if (p.stage === 'plan') {
          // The plan must declare every file the job will touch. A plan without a usable SCOPE block is not a plan.
          const parsed = parseScopeBlock(result, { allowBroad });
          if (parsed.ok) out.scope = parsed.scope;
          else {
            status = 'failed';
            out.scopeError = parsed.error;
          }
        }
        if (p.stage === 'test' || p.stage === 'review') {
          const verdict = parseVerdict(result);
          out.verdict = verdict ?? 'FAIL';
          if (verdict !== 'PASS') {
            status = 'failed';
            if (!verdict) out.result = `${result}\n\n(The ${p.stage} stage did not end with a VERDICT line, so it counts as a fail.)`;
          }
        }
        const live = await ctx.jobs.get(e.jobId);
        const ended = live?.status === 'failed' || live?.status === 'cancelled';
        if (!READONLY.has(p.stage as ClaudeStage) && !ended) {
          // Hold the result until the work is committed.
          const wt = outputOf(lastOf(await stagesOf(e.jobId), 'worktree')!);
          committing.set(e.jobId, { stage: p.stage, status, out });
          const job = await ctx.jobs.get(e.jobId);
          try {
            await announce(
              'commit.requested',
              {
                cwd: String(wt.cwd),
                message: `${job?.title ?? 'work'} (${p.stage})`,
                scope: scopeOf(await stagesOf(e.jobId)) ?? [],
                scopeAllow,
                scopeMode,
                allowBroadScope: allowBroad,
              },
              e.jobId,
            );
          } catch (err) {
            // Nothing will answer, so nothing will close this stage. Close it here, or the cleanup that waits for it never runs.
            committing.delete(e.jobId);
            await finish(s, 'failed', { error: err instanceof Error ? err.message : String(err) }).catch(() => {});
            throw err;
          }
          return;
        }
        await finish(s, status, out);
        await advance(e.jobId);
      });
    });

    ctx.on('stage.failed', (e) => {
      return guard(e.jobId, async () => {
        const p = e.payload as { stage: string; error?: string };
        const s = e.jobId && await runningStage(e.jobId, p.stage);
        if (!e.jobId || !s) return;
        const error = p.error ?? 'unknown';
        await finish(s, 'failed', { error });
        await fail(e.jobId, `${p.stage} failed: ${error}`);
      });
    });

    ctx.on('approval.granted', (e) => {
      return guard(e.jobId, async () => {
        const p = e.payload as { jobId?: string; kind?: string; stageId?: unknown };
        const jobId = e.jobId ?? p.jobId;
        const s = jobId && p.kind && await runningStage(jobId, `approve-${p.kind}`);
        if (!jobId || !s) return;
        if (p.stageId !== s.id) return void ignoreStale('grant', jobId, s, p.stageId, e.source);
        await finish(s, 'passed', { grantedBy: e.source });
        await ctx.jobs.setStatus(jobId, 'running');
        await advance(jobId);
      });
    });

    ctx.on('approval.denied', (e) => {
      return guard(e.jobId, async () => {
        const p = e.payload as { jobId?: string; stageId?: unknown };
        const jobId = e.jobId ?? p.jobId;
        const s = jobId && (await ctx.jobs.stages(jobId)).find((x) => x.name.startsWith('approve-') && x.status === 'running');
        if (!jobId || !s) return;
        if (p.stageId !== s.id) return void ignoreStale('deny', jobId, s, p.stageId, e.source);
        await finish(s, 'failed', { deniedBy: e.source });
        await ctx.jobs.setStatus(jobId, 'cancelled');
      });
    });

    /**
     * A grant or deny must carry the id of the approval stage that is open now. One that names another stage, or none
     * (a card sent before stage ids existed), was meant for an earlier question. It changes nothing.
     */
    function ignoreStale(what: string, jobId: string, s: Stage, ref: unknown, source: string): void {
      const named = typeof ref === 'string' && ref !== '' ? `stage ${ref.slice(0, 36)}` : 'no stage';
      ctx.log.warn(`pipeline-dev: ignored a ${what} from ${source} for job ${jobId}: it names ${named}, but the open question is ${s.name} ${s.id}. The card has expired.`);
    }

    ctx.on('pr.opened', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'pr');
        if (!e.jobId || !s) return;
        const p = e.payload as { url: string; number: number; headSha: string };
        await finish(s, 'passed', { url: p.url, number: p.number, headSha: p.headSha });
        await advance(e.jobId);
      });
    });

    ctx.on('pr.failed', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'pr');
        if (!e.jobId || !s) return;
        const error = (e.payload as { error?: string }).error ?? 'unknown';
        await finish(s, 'failed', { error });
        await fail(e.jobId, `pr failed: ${error}`);
      });
    });

    ctx.on('merge.refused', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        const reason = (e.payload as { reason?: string }).reason ?? 'unknown';
        await finish(s, 'failed', { refused: reason });
        await advance(e.jobId);
      });
    });

    // The merge can never go through (the PR was closed, or merged at a different commit). Do not ask again.
    ctx.on('merge.failed', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        const reason = (e.payload as { reason?: string }).reason ?? 'unknown';
        await finish(s, 'failed', { error: reason });
        await fail(e.jobId, `merge failed: ${reason}`);
      });
    });

    ctx.on('pr.merged', (e) => {
      return guard(e.jobId, async () => {
        const s = e.jobId && await runningStage(e.jobId, 'merge');
        if (!e.jobId || !s) return;
        await finish(s, 'passed', e.payload);
        await advance(e.jobId);
      });
    });
  },
});

export { CLAUDE_STAGES };

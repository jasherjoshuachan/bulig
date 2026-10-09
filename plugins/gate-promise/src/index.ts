import { definePlugin, type BuligEvent, type PluginContext } from '@bulig/plugin-sdk';
import { citedJobs, findPromises, promiseLine, clean } from './promises.ts';

export { PROMISE_PATTERNS, SKIP_WORDS, LIVE, citedJobs, findPromises, promiseLine, sentences } from './promises.ts';

export interface GatePromiseConfig {
  /** "warn" marks an unfulfilled promise and carries on. "enforce" fails the stage. Default "warn". */
  mode?: 'warn' | 'enforce';
  /** false passes every result through unchecked. The plugin stays loaded so the pipeline keeps getting its events. Default true. */
  enabled?: boolean;
  /**
   * The event this gate reads. "stage.completed" is the worker's own. With gate-evidence on, this is "stage.checked",
   * so the evidence marks travel on and one event, not two, reaches the pipeline. The CLI sets it. Default "stage.completed".
   */
  input?: 'stage.completed' | 'stage.checked';
}

/** Most promise lines put on a card. */
const MAX_SHOWN = 5;

/**
 * The promise gate. A stage that says "I'll follow up" has promised work that nothing will do, unless the same message
 * cites a live job that Bulig will run. This plugin reads the stage text for promise phrases and the job list Bulig
 * holds for the ids.
 *
 *   warn     -> `stage.screened` with the unfulfilled lines in `promises`, which the cards and the PR then show
 *   enforce  -> `stage.failed`, so the pipeline fails the stage the way it fails any other
 *   none     -> `stage.screened` with no lines
 *
 * `stage.screened` is the last event of the gate chain, and the pipeline listens to it (stageResultEvent) when this
 * gate is on. Everything the event it read carried (evidence marks included) is forwarded as it came.
 */
export default definePlugin({
  manifest: {
    name: 'gate-promise',
    version: '0.1.0',
    sdk: '0',
    description: 'Marks a stage that promises later work ("I\'ll follow up") with no live job id behind the promise.',
    subscribes: ['stage.completed', 'stage.checked'],
    emits: ['stage.screened', 'stage.failed'],
    needs: [],
  },
  register(ctx: PluginContext) {
    const cfg = ctx.config as GatePromiseConfig;
    const mode = cfg.mode ?? 'warn';
    if (mode !== 'warn' && mode !== 'enforce') throw new Error(`gate-promise: mode must be "warn" or "enforce", not ${JSON.stringify(mode)}`);
    const input = cfg.input ?? 'stage.completed';
    if (input !== 'stage.completed' && input !== 'stage.checked') throw new Error(`gate-promise: input must be "stage.completed" or "stage.checked", not ${JSON.stringify(input)}`);
    const on = cfg.enabled !== false;

    ctx.on(input, (e: BuligEvent) => {
      const raw = (e.payload ?? {}) as Record<string, unknown>;
      const stage = String(raw.stage ?? '');
      const result = typeof raw.result === 'string' ? raw.result : '';
      // Forward what arrived, but never the raw tool-use records: those are for the evidence gate only.
      const { evidence: _records, promises: _own, ...rest } = raw;
      const pass = { ...rest, stage, ok: true, result };

      if (!on) return ctx.emit('stage.screened', { ...pass, promiseChecked: false }, e.jobId);

      const promises = findPromises(result);
      let shown: string[] = [];
      if (promises.length) {
        const cited = citedJobs(result, ctx.jobs.list(), e.jobId);
        if (!cited.live) {
          shown = promises.slice(0, MAX_SHOWN).map((p) => promiseLine(p, cited));
          if (promises.length > MAX_SHOWN) shown.push(`Unfulfilled promise: ... and ${promises.length - MAX_SHOWN} more with no job id`);
        }
      }

      if (shown.length && mode === 'enforce') {
        return ctx.emit('stage.failed', { stage, error: `promise gate: ${clean(shown.join('; '), 400)}`, blocked: true, promises: shown }, e.jobId);
      }
      ctx.emit('stage.screened', { ...pass, promiseChecked: true, promiseMode: mode, promises: shown }, e.jobId);
    });
  },
});

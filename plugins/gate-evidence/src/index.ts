import { definePlugin, type BuligEvent, type PluginContext } from '@bulig/plugin-sdk';
import { checkClaims, clean, evidenceLines, evidenceSummary, findClaims, parseRecords, type EvidenceRecord, type Finding } from './claims.ts';

export {
  CLAIM_PATTERNS,
  SKIP_WORDS,
  checkClaims,
  evidenceLines,
  evidenceSummary,
  findClaims,
  isBuildCommand,
  isTestCommand,
  parseRecords,
  type Claim,
  type EvidenceRecord,
  type Finding,
} from './claims.ts';

export interface GateEvidenceConfig {
  /** "warn" marks an unbacked claim as UNVERIFIED and carries on. "enforce" fails the stage. Default "warn". */
  mode?: 'warn' | 'enforce';
  /** false passes every result through unchecked. The plugin stays loaded so the pipeline keeps getting its events. Default true. */
  enabled?: boolean;
  /** Plugins whose tool-use records count as evidence. A stage.completed from anyone else is checked as if it had none. Default ["worker-claude-code"]. */
  evidenceSources?: string[];
}

/** Most unverified lines put on a card. */
const MAX_SHOWN = 5;

/** The finding as one line for the card: the reason, then the sentence it is about. */
const line = (f: Finding): string => `Unverified: ${f.reason} ("${clean(f.claim.text, 100)}")`;

/**
 * The evidence gate. The worker says `stage.completed` with the tool-use records of that one run. This plugin
 * reads the stage text, finds sentences that claim a test, build, file or change, and looks for a record that
 * backs each one. The pipeline listens for `stage.checked` instead of `stage.completed` when this plugin is on.
 *
 *   warn     -> `stage.checked` with the unverified lines, which the cards and the PR then show
 *   enforce  -> `stage.failed`, so the pipeline fails the stage the way it fails any other
 *   no claim -> `stage.checked` with no unverified lines
 *
 * Evidence comes only from the `evidence` field the worker built from its stream. Text in `result` is only ever
 * read for claims, so nothing the model writes can add a record.
 */
export default definePlugin({
  manifest: {
    name: 'gate-evidence',
    version: '0.1.0',
    sdk: '1',
    description: 'Checks that a stage which claims a result has a tool-use record from the same turn to back it.',
    subscribes: ['stage.completed'],
    emits: ['stage.checked', 'stage.failed'],
    needs: [],
  },
  register(ctx: PluginContext) {
    const cfg = ctx.config as GateEvidenceConfig;
    const mode = cfg.mode ?? 'warn';
    if (mode !== 'warn' && mode !== 'enforce') throw new Error(`gate-evidence: mode must be "warn" or "enforce", not ${JSON.stringify(mode)}`);
    const on = cfg.enabled !== false;
    const sources = new Set(cfg.evidenceSources ?? ['worker-claude-code']);

    ctx.on('stage.completed', (e: BuligEvent) => {
      const p = (e.payload ?? {}) as { stage?: unknown; result?: unknown; sessionId?: unknown; costUsd?: unknown; evidence?: unknown };
      const stage = String(p.stage ?? '');
      const result = typeof p.result === 'string' ? p.result : '';
      // The same fields the pipeline reads from stage.completed, and nothing it does not need.
      const pass = { stage, ok: true, result, sessionId: p.sessionId, costUsd: p.costUsd };

      if (!on) return ctx.emit('stage.checked', { ...pass, checked: false }, e.jobId);

      const trusted = sources.has(e.source);
      if (!trusted) ctx.log.warn(`gate-evidence: stage.completed from "${e.source}" is not an evidence source, so its records are ignored`);
      const records: EvidenceRecord[] = trusted ? parseRecords(p.evidence) : [];
      const findings = checkClaims(findClaims(result, stage), records);
      const shown = findings.slice(0, MAX_SHOWN).map(line);
      if (findings.length > MAX_SHOWN) shown.push(`Unverified: ... and ${findings.length - MAX_SHOWN} more claims with no record`);
      const summary = evidenceSummary(records);

      if (findings.length && mode === 'enforce') {
        return ctx.emit('stage.failed', { stage, error: `evidence gate: ${clean(shown.join('; '), 400)}`, blocked: true, unverified: shown, evidenceSummary: summary }, e.jobId);
      }
      ctx.emit('stage.checked', { ...pass, checked: true, mode, evidenceSummary: summary, evidenceLines: evidenceLines(records), unverified: shown }, e.jobId);
    });
  },
});

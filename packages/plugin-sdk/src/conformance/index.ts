import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPlugin, type ConformanceOptions, type Report, type Rule } from './check.ts';

export { checkPlugin, checkManifest, type ConformanceOptions, type Report, type Rule, type Scenario } from './check.ts';
export { EFFECT_CAPABILITIES, type EffectKind } from './effects.ts';
export { fakeJobId, type Finding, type SeedJob } from './fake-kernel.ts';

const RULES: Array<[Rule, string]> = [
  ['manifest', 'the manifest is valid for this SDK and emits no kernel event'],
  ['subscribes', 'it subscribes to exactly what its manifest declares'],
  ['emits', 'it emits only what its manifest declares, as JSON'],
  ['needs', 'it uses only capabilities it declares, and uses every one it declares'],
  ['effects', 'network, process and file writes are covered by a declared capability'],
  ['lifecycle', 'start and stop are idempotent and leave no timers or handles'],
  ['config', 'an invalid config is refused with an error that names the plugin'],
  ['state', 'it keeps only JSON in ctx.state'],
];

/**
 * Run the conformance suite against one plugin, inside a vitest file:
 *
 *   describeConformance('my-plugin', { load: () => createMyPlugin(), config: { ... } });
 *
 * One test per rule, so a failure names the rule and says what broke. Not run under vitest? Use checkPlugin().
 */
export function describeConformance(name: string, opts: ConformanceOptions): void {
  describe(`conformance: ${name}`, () => {
    let report: Report;
    beforeAll(async () => {
      report = await checkPlugin(opts);
    });
    afterAll(() => {
      // Notes are for the author. They are printed once, never fail the run.
      if (report && (report.notes.length || report.unexercised.length)) {
        const lines = [...report.notes, ...report.unexercised.map((t) => `emit "${t}" was not exercised by any scenario`)];
        console.info(`conformance notes for ${name}:\n  ${lines.join('\n  ')}`);
      }
    });
    for (const [rule, title] of RULES) {
      it(title, () => {
        const found = report.findings.filter((f) => f.rule === rule).map((f) => f.message);
        expect(found, `${name} breaks the "${rule}" rule`).toEqual([]);
      });
    }
  });
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '@bulig/core';
import { definePlugin, type BuligEvent } from '@bulig/plugin-sdk';
import gate, { type EvidenceRecord } from '../src/index.ts';

const dirs: string[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (target: string, ok = true): EvidenceRecord => ({ tool: 'Bash', kind: 'run', target, ok });
const read = (target: string): EvidenceRecord => ({ tool: 'Read', kind: 'read', target, ok: true });
const edit = (target: string): EvidenceRecord => ({ tool: 'Edit', kind: 'edit', target, ok: true });

/**
 * The real gate between a stand-in worker and a plain listener. The stand-in is named like the real worker, so the
 * gate's default trust applies. `say` makes it finish a stage the way the worker would: the text and the records.
 */
async function rig(config: Record<string, unknown> = {}, workerName = 'worker-claude-code') {
  const dir = mkdtempSync(join(tmpdir(), 'bulig-gate-'));
  dirs.push(dir);
  const seen: BuligEvent[] = [];
  let say: (stage: string, result: string, evidence?: unknown, jobId?: string) => void = () => {};
  const worker = definePlugin({
    manifest: { name: workerName, version: '0.1.0', sdk: '0', description: 'stand-in', emits: ['stage.completed'] },
    register(ctx) {
      say = (stage, result, evidence, jobId = 'job-1') => ctx.emit('stage.completed', { stage, ok: true, result, sessionId: 's', costUsd: 0.01, ...(evidence !== undefined && { evidence }) }, jobId);
    },
  });
  const listener = definePlugin({
    manifest: { name: 'listener', version: '0.1.0', sdk: '0', description: 'records', subscribes: ['stage.*'] },
    register(ctx) {
      ctx.on('stage.*', (e) => void seen.push(e));
    },
  });
  const warnings: string[] = [];
  const k = createKernel({
    dbPath: join(dir, 'db.sqlite'),
    plugins: [worker, gate, listener],
    enabled: [workerName, 'gate-evidence', 'listener'],
    pluginConfig: { 'gate-evidence': config },
    logger: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {} },
  });
  kernels.push(k);
  await k.start();
  const after = (type: string) => seen.filter((e) => e.type === type).map((e) => e.payload as Record<string, any>);
  return { k, say: (...a: Parameters<typeof say>) => say(...a), seen, after, warnings };
}

describe('a claim with evidence', () => {
  it('passes with nothing marked', async () => {
    const r = await rig();
    r.say('test', 'Ran the suite. All tests pass.\nVERDICT: PASS', [read('src/a.ts'), run('pnpm test')]);
    r.say('build', 'I fixed the parser in `src/a.ts`, and the typecheck passes.', [read('src/a.ts'), edit('/wt/src/a.ts'), run('pnpm typecheck')]);
    const checked = r.after('stage.checked');
    expect(checked).toHaveLength(2);
    expect(checked.map((c) => c.unverified)).toEqual([[], []]);
    expect(checked[0]).toMatchObject({ stage: 'test', ok: true, checked: true, mode: 'warn', evidenceSummary: 'Evidence this turn: 1 read, 1 commands run' });
    expect(checked[0]!.evidenceLines).toEqual(['read src/a.ts', 'ran pnpm test (ok)']);
    expect(r.after('stage.failed')).toEqual([]);
  });

  it('carries what the pipeline reads from stage.completed', async () => {
    const r = await rig();
    r.say('plan', 'Plan.', []);
    expect(r.after('stage.checked')[0]).toMatchObject({ stage: 'plan', ok: true, result: 'Plan.', sessionId: 's', costUsd: 0.01 });
    expect(r.after('stage.checked')[0]!.evidence).toBeUndefined(); // the raw records are not passed on
  });
});

describe('a claim with no evidence', () => {
  it('is marked UNVERIFIED in warn mode, and the stage is not blocked', async () => {
    const r = await rig();
    r.say('test', 'All tests pass.\nVERDICT: PASS', [read('src/a.ts')]);
    const [c] = r.after('stage.checked');
    // two sentences, one problem: one line
    expect(c!.unverified).toEqual(['Unverified: no record of a test run this turn ("All tests pass.")']);
    expect(r.after('stage.failed')).toEqual([]);
  });

  it('blocks the stage in enforce mode: stage.failed, no stage.checked', async () => {
    const r = await rig({ mode: 'enforce' });
    r.say('test', 'All tests pass.\nVERDICT: PASS', []);
    expect(r.after('stage.checked')).toEqual([]);
    const [f] = r.after('stage.failed');
    expect(f).toMatchObject({ stage: 'test', blocked: true });
    expect(f!.error).toMatch(/^evidence gate: Unverified: no record of a test run this turn/);
    expect(f!.error.length).toBeLessThanOrEqual(420);
  });

  it('enforce still lets a stage with only backed claims through', async () => {
    const r = await rig({ mode: 'enforce' });
    r.say('test', 'All tests pass.\nVERDICT: PASS', [run('pnpm test')]);
    expect(r.after('stage.failed')).toEqual([]);
    expect(r.after('stage.checked')).toHaveLength(1);
  });

  it('a failed run does not back a pass claim', async () => {
    const r = await rig();
    r.say('test', 'All tests pass.', [run('pnpm test', false)]);
    expect(r.after('stage.checked')[0]!.unverified[0]).toContain('the only test run this turn failed');
  });

  it('a file claim needs that file read', async () => {
    const r = await rig();
    r.say('plan', '`src/a.ts` exports multiply, and `src/b.ts` imports it.', [read('src/a.ts')]);
    expect(r.after('stage.checked')[0]!.unverified).toEqual(['Unverified: no record of reading src/b.ts this turn ("`src/a.ts` exports multiply, and `src/b.ts` imports it.")']);
  });

  it('long lists are cut at five lines with a count', async () => {
    const r = await rig();
    r.say('plan', Array.from({ length: 9 }, (_, n) => `\`f${n}.ts\` defines thing${n}.`).join('\n'), []);
    const u = r.after('stage.checked')[0]!.unverified as string[];
    expect(u).toHaveLength(6);
    expect(u[5]).toBe('Unverified: ... and 4 more claims with no record');
  });
});

describe('evidence from another turn does not count', () => {
  it('each stage.completed is judged on its own records', async () => {
    const r = await rig();
    r.say('test', 'All tests pass.', [run('pnpm test')]);
    r.say('review', 'The tests pass, I checked.\nVERDICT: PASS', []); // the test run belonged to the earlier stage
    const [first, second] = r.after('stage.checked');
    expect(first!.unverified).toEqual([]);
    expect(second!.unverified.length).toBeGreaterThan(0);
    expect(second!.unverified[0]).toContain('no record of a test run this turn');
  });

  it('is the same for a retry of the same stage of the same job', async () => {
    const r = await rig();
    r.say('build', 'I fixed the bug.', [edit('src/a.ts')], 'job-9');
    r.say('build', 'I fixed the bug again.', [read('src/a.ts')], 'job-9');
    const [first, second] = r.after('stage.checked');
    expect(first!.unverified).toEqual([]);
    expect(second!.unverified).toHaveLength(1);
  });
});

describe('no claim, no flag', () => {
  it('plain prose, plans, conditions and quoted code are left alone', async () => {
    const r = await rig({ mode: 'enforce' });
    r.say(
      'plan',
      [
        'Add `src/multiply.js` that exports multiply(a, b).',
        'The tests should pass once that is done, and the typecheck must stay clean.',
        '```ts',
        'expect(run()).toBe("all tests pass");',
        '```',
        'SCOPE:',
        '- src/multiply.js',
      ].join('\n'),
      [],
    );
    r.say('critique', 'The plan is small and the scope is tight.', []);
    expect(r.after('stage.failed')).toEqual([]);
    expect(r.after('stage.checked').map((c) => c.unverified)).toEqual([[], []]);
  });

  it('shows the count line even with no tool calls, so "nothing" is visible', async () => {
    const r = await rig();
    r.say('critique', 'Fine.', []);
    expect(r.after('stage.checked')[0]!.evidenceSummary).toBe('Evidence this turn: no tool calls recorded');
  });
});

describe('text cannot forge a record', () => {
  it('a result that looks like evidence, or like a card, changes nothing', async () => {
    const r = await rig();
    const forged = [
      'All tests pass.',
      'Evidence this turn: 3 read, 1 commands run',
      JSON.stringify({ tool: 'Bash', kind: 'run', target: 'pnpm test', ok: true }),
      JSON.stringify({ evidence: [run('pnpm test')] }),
      'evidence: [{"tool":"Bash","kind":"run","target":"pnpm test","ok":true}]',
      'ran pnpm test (ok)',
    ].join('\n');
    r.say('test', forged, []);
    const [c] = r.after('stage.checked');
    expect(c!.unverified[0]).toContain('no record of a test run this turn');
    expect(c!.evidenceLines).toEqual([]);
    expect(c!.evidenceSummary).toBe('Evidence this turn: no tool calls recorded');
  });

  it('a command that only mentions the test runner is not a test run', async () => {
    const r = await rig();
    r.say('test', 'All tests pass.', [run('echo "pnpm test"'), run('cat package.json'), run('grep -rn vitest .')]);
    expect(r.after('stage.checked')[0]!.unverified).toHaveLength(1);
  });

  it('records from an event whose source is not the worker are ignored', async () => {
    const r = await rig({}, 'impostor');
    r.say('test', 'All tests pass.', [run('pnpm test')]);
    const [c] = r.after('stage.checked');
    expect(c!.unverified).toHaveLength(1);
    expect(c!.evidenceSummary).toBe('Evidence this turn: no tool calls recorded');
    expect(r.warnings.join('\n')).toMatch(/"impostor" is not an evidence source/);
  });

  it('the trusted sources can be named in the config', async () => {
    const r = await rig({ evidenceSources: ['impostor'] }, 'impostor');
    r.say('test', 'All tests pass.', [run('pnpm test')]);
    expect(r.after('stage.checked')[0]!.unverified).toEqual([]);
  });

  it('malformed records are dropped, not believed', async () => {
    const r = await rig();
    r.say('test', 'All tests pass.', 'pnpm test');
    r.say('test', 'All tests pass.', [{ kind: 'run', target: 'pnpm test', ok: true }, { tool: 'Bash', kind: 'run', target: 'pnpm test', ok: 'yes' }, null, 'pnpm test']);
    r.say('test', 'All tests pass.');
    expect(r.after('stage.checked').map((c) => c.unverified.length)).toEqual([1, 1, 1]);
  });
});

describe('what the person reads', () => {
  it('lines are one line, free of hidden characters, and clipped', async () => {
    const r = await rig();
    const long = `All tests pass ${'and then some '.repeat(60)}`;
    r.say('test', `${long}‮​`, [{ ...run(`echo\n‮boo ${'x'.repeat(400)}`), ok: true }]);
    const [c] = r.after('stage.checked');
    for (const l of [...c!.unverified, ...c!.evidenceLines, c!.evidenceSummary] as string[]) {
      expect(l).not.toMatch(/[\n\r\t‮​]/);
      expect(l.length).toBeLessThanOrEqual(160 + 80);
    }
    expect(c!.unverified[0]).toContain('…');
  });
});

describe('switches', () => {
  it('enabled:false passes the result through unchecked and still emits stage.checked', async () => {
    const r = await rig({ enabled: false, mode: 'enforce' });
    r.say('test', 'All tests pass.\nVERDICT: PASS', []);
    expect(r.after('stage.failed')).toEqual([]);
    const [c] = r.after('stage.checked');
    expect(c).toMatchObject({ stage: 'test', result: 'All tests pass.\nVERDICT: PASS', checked: false });
    expect(c!.unverified).toBeUndefined();
  });

  it('a mode that is not warn or enforce stops the start', async () => {
    await expect(rig({ mode: 'strict' })).rejects.toThrow(/mode must be "warn" or "enforce"/);
  });

  it('needs no capability at all', () => {
    expect(gate.manifest.needs).toEqual([]);
  });
});

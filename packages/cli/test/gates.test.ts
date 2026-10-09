import { describe, expect, it } from 'vitest';
import { gateResultEvent, kernelPluginConfig, promiseInput } from '../src/commands.ts';
import type { BuligConfig } from '../src/config.ts';
import { OPT_IN_PLUGINS } from '../src/config.ts';

describe('gate wiring', () => {
  it('the pipeline listens to the last gate of the chain, whatever the order of `enabled`', () => {
    expect(gateResultEvent(['pipeline-dev'])).toBeUndefined();
    expect(gateResultEvent(['gate-evidence', 'pipeline-dev'])).toBe('stage.checked');
    expect(gateResultEvent(['gate-promise', 'pipeline-dev'])).toBe('stage.screened');
    expect(gateResultEvent(['gate-promise', 'gate-evidence'])).toBe('stage.screened');
    expect(gateResultEvent(['gate-evidence', 'gate-promise'])).toBe('stage.screened');
  });

  it('gate-promise reads gate-evidence only when both are on, the worker otherwise', () => {
    expect(promiseInput(['gate-promise'])).toBe('stage.completed');
    expect(promiseInput(['gate-evidence'])).toBeUndefined();
    expect(promiseInput(['gate-promise', 'gate-evidence'])).toBe('stage.checked');
    expect(promiseInput(['gate-evidence', 'gate-promise'])).toBe('stage.checked');
  });

  it('gate-promise is opt-in', () => {
    expect(OPT_IN_PLUGINS).toContain('gate-promise');
  });
});

const cfg = (enabled: string[], pluginConfig: Record<string, Record<string, unknown>> = {}): BuligConfig => ({ dbPath: '/x', enabled, grants: {}, pluginConfig, eventCapabilities: {} });

describe('the plugin config the kernel gets', () => {
  it('gate-promise alone reads stage.completed even when the user config says stage.checked, which nothing would emit', () => {
    const out = kernelPluginConfig(cfg(['pipeline-dev', 'gate-promise'], { 'gate-promise': { input: 'stage.checked', mode: 'enforce' } }), false);
    expect(out['gate-promise']).toEqual({ mode: 'enforce', input: 'stage.completed' });
    expect(out['pipeline-dev']).toMatchObject({ stageResultEvent: 'stage.screened', resume: false });
  });

  it('with both gates on, the computed input wins over a user value in the other direction too', () => {
    const out = kernelPluginConfig(cfg(['gate-promise', 'gate-evidence', 'pipeline-dev'], { 'gate-promise': { input: 'stage.completed', enabled: true } }), 'all');
    expect(out['gate-promise']).toEqual({ enabled: true, input: 'stage.checked' });
    expect(out['pipeline-dev']).toMatchObject({ stageResultEvent: 'stage.screened', resume: 'all' });
  });

  it('with the gate off, the user config is left alone and nothing is added', () => {
    const out = kernelPluginConfig(cfg(['pipeline-dev'], { 'gate-promise': { input: 'stage.checked' } }), false);
    expect(out['gate-promise']).toEqual({ input: 'stage.checked' });
    expect(out['pipeline-dev']).toEqual({ resume: false });
  });

  it('the user can still set the pipeline event (an existing escape hatch), and the rest of the config passes through', () => {
    const out = kernelPluginConfig(cfg(['gate-evidence', 'pipeline-dev'], { 'pipeline-dev': { stageResultEvent: 'stage.completed' }, github: { x: 1 } }), false);
    expect(out['pipeline-dev']).toMatchObject({ stageResultEvent: 'stage.completed' });
    expect(out.github).toEqual({ x: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import { CORE_PLUGINS, assertWiring, gateResultEvent, kernelPluginConfig, promiseInput } from '../src/commands.ts';
import type { BuligConfig } from '../src/config.ts';
import { BUILTIN_PLUGINS, OPT_IN_PLUGINS, defaultEnabled } from '../src/config.ts';

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

  it('the gates are on by default, Telegram is still opt-in', () => {
    expect(BUILTIN_PLUGINS).toEqual(expect.arrayContaining(['gate-evidence', 'gate-promise']));
    expect(OPT_IN_PLUGINS).toEqual(['channel-telegram']);
  });

  it('the default list wires the pipeline to stage.screened and chains the gates, and every opt-out combination stays wired', () => {
    const wired = (pluginConfig: Record<string, Record<string, unknown>>) => {
      const enabled = defaultEnabled(pluginConfig);
      const out = kernelPluginConfig(cfg(enabled, pluginConfig), false);
      expect(() => assertWiring(CORE_PLUGINS, enabled, out, ['channel-cli'])).not.toThrow();
      return { enabled, result: out['pipeline-dev']!.stageResultEvent, promiseIn: out['gate-promise']?.input };
    };
    const off = { enabled: false };
    expect(wired({})).toMatchObject({ result: 'stage.screened', promiseIn: 'stage.checked' });
    expect(wired({ 'gate-promise': off })).toMatchObject({ result: 'stage.checked', promiseIn: undefined });
    expect(wired({ 'gate-evidence': off })).toMatchObject({ result: 'stage.screened', promiseIn: 'stage.completed' });
    const none = wired({ 'gate-evidence': off, 'gate-promise': off });
    expect(none).toMatchObject({ result: undefined, promiseIn: undefined });
    expect(none.enabled).not.toContain('gate-evidence');
    expect(none.enabled).not.toContain('gate-promise');
  });

  it('the default gates run in warn mode: nothing sets enforce', () => {
    const out = kernelPluginConfig(cfg(defaultEnabled({}), {}), false);
    expect(out['gate-evidence']).toBeUndefined();
    expect(out['gate-promise']).toEqual({ input: 'stage.checked' });
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

describe('start-up wiring checks', () => {
  it('the shared built-in list holds both gates, so run and serve cannot drift apart', () => {
    const names = CORE_PLUGINS.map((p) => (p.manifest as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['gate-evidence', 'gate-promise', 'worker-claude-code', 'github', 'pipeline-dev']));
  });

  it('names an enabled plugin that nothing registered', () => {
    const without = CORE_PLUGINS.filter((p) => (p.manifest as { name: string }).name !== 'gate-promise');
    expect(() => assertWiring(without, ['pipeline-dev', 'gate-promise'], {})).toThrow(/not registered.*gate-promise/);
    expect(() => assertWiring(CORE_PLUGINS, ['pipeline-dev', 'gate-promise'], {})).not.toThrow();
  });

  it('refuses a pipeline reading a gate event when that gate is not enabled', () => {
    expect(() => assertWiring(CORE_PLUGINS, ['pipeline-dev'], { 'pipeline-dev': { stageResultEvent: 'stage.checked' } })).toThrow(/gate-evidence is not enabled/);
    expect(() => assertWiring(CORE_PLUGINS, ['pipeline-dev', 'gate-evidence'], { 'pipeline-dev': { stageResultEvent: 'stage.checked' } })).not.toThrow();
  });

  it('a command that leaves Telegram out may be given a config that enables it, but still not a missing core plugin', () => {
    const live = ['channel-telegram', 'worker-claude-code', 'gate-evidence', 'gate-promise', 'github', 'pipeline-dev'];
    const terminal = [...CORE_PLUGINS];
    expect(() => assertWiring(terminal, live, {}, ['channel-telegram'])).not.toThrow();
    const noPromise = terminal.filter((p) => (p.manifest as { name: string }).name !== 'gate-promise');
    expect(() => assertWiring(noPromise, live, {}, ['channel-telegram'])).toThrow(/gate-promise/);
    // Without the allowance (serve), a missing Telegram is refused.
    expect(() => assertWiring(terminal, live, {})).toThrow(/channel-telegram/);
  });
});

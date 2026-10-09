import { describe, expect, it } from 'vitest';
import { gateResultEvent, promiseInput } from '../src/commands.ts';
import { OPT_IN_PLUGINS } from '../src/config.ts';

describe('gate wiring', () => {
  it('the pipeline listens to the last gate of the chain, whatever the order of `enabled`', () => {
    expect(gateResultEvent(['pipeline-dev'])).toBeUndefined();
    expect(gateResultEvent(['gate-evidence', 'pipeline-dev'])).toBe('stage.checked');
    expect(gateResultEvent(['gate-promise', 'pipeline-dev'])).toBe('stage.screened');
    expect(gateResultEvent(['gate-promise', 'gate-evidence'])).toBe('stage.screened');
    expect(gateResultEvent(['gate-evidence', 'gate-promise'])).toBe('stage.screened');
  });

  it('gate-promise reads gate-evidence only when both are on', () => {
    expect(promiseInput(['gate-promise'])).toBeUndefined();
    expect(promiseInput(['gate-evidence'])).toBeUndefined();
    expect(promiseInput(['gate-promise', 'gate-evidence'])).toBe('stage.checked');
    expect(promiseInput(['gate-evidence', 'gate-promise'])).toBe('stage.checked');
  });

  it('gate-promise is opt-in', () => {
    expect(OPT_IN_PLUGINS).toContain('gate-promise');
  });
});

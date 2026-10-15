import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.ts';

describe('what the SDK no longer exports', () => {
  it('leaves the grant logic to the kernel', () => {
    expect('effectiveCapabilities' in sdk).toBe(false);
  });

  it('leaves the scope guard helpers to @bulig/scope', () => {
    for (const name of ['parseScopeBlock', 'normalizeScopeEntry', 'matchesScope', 'matchesGlob', 'isRepoPath', 'isPlainRepoPath', 'MAX_SCOPE_ENTRIES']) {
      expect(name in sdk, name).toBe(false);
    }
  });

  it('still exports the permission rules the conformance suite shares with the kernel', () => {
    expect(sdk.JOBS_WRITE).toBe('jobs.write');
    expect(Object.keys(sdk.DEFAULT_EVENT_CAPABILITIES).length).toBeGreaterThan(0);
  });
});

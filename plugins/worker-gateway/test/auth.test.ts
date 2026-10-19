import { timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenAuth } from '../src/auth.ts';

const tokens = [
  { id: 'mac', token: 'mac-token-0123456789abcdef' },
  { id: 'pi', token: 'pi-token-0123456789abcdef-x' },
];

describe('TokenAuth', () => {
  it('compares with crypto.timingSafeEqual unless a test says otherwise', () => {
    expect(new TokenAuth(tokens).compare).toBe(timingSafeEqual);
  });

  it('knows a worker by its own token, and nobody else', () => {
    const auth = new TokenAuth(tokens);
    expect(auth.authenticate(`Bearer ${tokens[0]!.token}`)).toBe('mac');
    expect(auth.authenticate(`bearer ${tokens[1]!.token}`)).toBe('pi');
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', `Bearer ${tokens[0]!.token}x`, `Bearer ${tokens[0]!.token.slice(1)}`, `Bearer  ${tokens[0]!.token}`, tokens[0]!.token]) {
      expect(auth.authenticate(bad), String(bad)).toBeUndefined();
    }
  });

  it('every check goes through timingSafeEqual on two equal-length hashes, for every worker, with no early exit', () => {
    const calls: [number, number][] = [];
    const auth = new TokenAuth(tokens, (a, b) => {
      calls.push([a.length, b.length]);
      return timingSafeEqual(a, b);
    });
    // A right token for the first worker still checks the second, so the time does not say which worker matched.
    expect(auth.authenticate(`Bearer ${tokens[0]!.token}`)).toBe('mac');
    expect(calls).toHaveLength(2);
    calls.length = 0;
    // Tokens of very different lengths cost the same: both sides are hashed first.
    for (const header of ['Bearer x', `Bearer ${'y'.repeat(500)}`, undefined]) {
      expect(auth.authenticate(header)).toBeUndefined();
    }
    expect(calls).toHaveLength(6);
    expect(calls.every(([a, b]) => a === 32 && b === 32)).toBe(true);
  });
});

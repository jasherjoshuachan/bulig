import { describe, expect, it } from 'vitest';
import { clipText, storableJson, wellFormed } from '../src/index.ts';

const robot = '🤖'; // two UTF-16 units

describe('clipText', () => {
  it('cuts at the limit when that does not split a pair', () => {
    expect(clipText('abcdef', 3)).toBe('abc');
    expect(clipText('abc', 10)).toBe('abc');
    expect(clipText('abc', 0)).toBe('');
  });
  it('never leaves half an emoji: it cuts one unit sooner instead', () => {
    const s = `${'x'.repeat(299)}${robot}tail`;
    const cut = clipText(s, 300);
    expect(cut).toBe('x'.repeat(299));
    expect(/[\ud800-\udfff]/.test(cut)).toBe(false);
    expect(clipText(`${'x'.repeat(298)}${robot}`, 300)).toBe(`${'x'.repeat(298)}${robot}`);
  });
  it('whatever the cut, the result has no lone surrogate', () => {
    const s = `a${robot}b${robot}${robot}c`;
    for (let n = 0; n <= s.length + 1; n++) expect(wellFormed(clipText(s, n))).toBe(clipText(s, n));
  });
});

describe('wellFormed', () => {
  it('replaces a lone high or low surrogate and keeps pairs', () => {
    expect(wellFormed(`a\ud83eb`)).toBe('a�b');
    expect(wellFormed(`a\udd16b`)).toBe('a�b');
    expect(wellFormed(`${robot}x\ud83e`)).toBe(`${robot}x�`);
    expect(wellFormed('plain')).toBe('plain');
  });
});

describe('storableJson', () => {
  it('writes a lone surrogate or a NUL as U+FFFD, anywhere in the value, and keeps pairs and literal backslash text', () => {
    expect(JSON.parse(storableJson({ a: ['x\ud83e', { 'k\udd16': 'y' }], n: 'a\u0000b', ok: robot })!)).toEqual({ a: ['x�', { 'k�': 'y' }], n: 'a�b', ok: robot });
    expect(JSON.parse(storableJson('literal \\ud83e and \\u0000 text')!)).toBe('literal \\ud83e and \\u0000 text');
    expect(JSON.parse(storableJson('\\\ud83e')!)).toBe('\\�');
  });
  it('is undefined for what has no JSON form', () => {
    expect(storableJson(undefined)).toBeUndefined();
    expect(storableJson(() => 1)).toBeUndefined();
    expect(storableJson(null)).toBe('null');
  });
});

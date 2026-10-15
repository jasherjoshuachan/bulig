import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.ts';
import { validateManifest } from '../src/index.ts';

const good = { name: 'my-plugin', version: '0.1.0', sdk: '1', description: 'does a thing' };

describe('validateManifest', () => {
  it('accepts a valid manifest and fills in the defaults', () => {
    const r = validateManifest(good);
    expect(r).toEqual({
      ok: true,
      manifest: { ...good, provides: { stages: [], commands: [] }, subscribes: [], emits: [], needs: [] },
    });
  });

  it('lists every problem with the field and the message', () => {
    const r = validateManifest({ ...good, name: 'My Plugin', sdk: 'one', needs: ['nonsense'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const byPath = Object.fromEntries(r.issues.map((i) => [i.path, i.message]));
    expect(byPath['name']).toBe('name must be kebab-case');
    expect(byPath['sdk']).toContain('major version');
    expect(byPath['needs.0']).toContain('capabilities look like');
  });

  it('gives an empty path when the manifest as a whole is wrong', () => {
    const r = validateManifest('not an object');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toEqual(['']);
  });

  it('does not export the schema library object any more', () => {
    expect('ManifestSchema' in sdk).toBe(false);
  });
});

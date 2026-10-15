import { describe, expect, it } from 'vitest';
import { effectiveCapabilities } from '../src/index.ts';

const manifest = { name: 'worker', needs: ['claude.run', 'fs.worktree', 'channel.send:terminal'] };

describe('effectiveCapabilities', () => {
  it('gives the capabilities that are both declared and granted', () => {
    const caps = effectiveCapabilities(manifest, { worker: ['claude.run', 'channel.send:terminal'] });
    expect([...caps].sort()).toEqual(['channel.send:terminal', 'claude.run']);
  });

  it('does not give a capability that was granted but never declared', () => {
    const caps = effectiveCapabilities(manifest, { worker: ['claude.run', 'git.push'] });
    expect(caps.has('git.push')).toBe(false);
  });

  it('gives nothing when the config has no entry for the plugin', () => {
    expect(effectiveCapabilities(manifest, { other: ['claude.run'] }).size).toBe(0);
  });

  it('matches a scoped capability exactly', () => {
    const caps = effectiveCapabilities({ name: 'chat', needs: ['channel.send:chat'] }, { chat: ['channel.send:terminal'] });
    expect(caps.size).toBe(0);
  });
});

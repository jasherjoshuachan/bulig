import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createKernel, type KernelOptions } from '../src/index.ts';
import type { ManifestInput, Plugin, PluginContext } from '@bulig/plugin-sdk';

const dirs: string[] = [];
const kernels: ReturnType<typeof createKernel>[] = [];

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bulig-'));
  dirs.push(dir);
  return join(dir, 'bulig.sqlite');
}

export function kernelWith(opts: Partial<KernelOptions> & { plugins: Plugin[] }) {
  const k = createKernel({
    dbPath: tempDb(),
    enabled: opts.plugins.map((p) => p.manifest.name),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...opts,
  });
  kernels.push(k);
  return k;
}

export const manifest = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  name: 'demo',
  version: '0.1.0',
  sdk: '0',
  description: 'test plugin',
  ...over,
});

/** A plugin that hands its context to the test. */
export function probe(over: Partial<ManifestInput> = {}) {
  const box: { ctx?: PluginContext } = {};
  const plugin: Plugin = {
    manifest: manifest(over),
    register(ctx) {
      box.ctx = ctx;
    },
  };
  return { plugin, box };
}

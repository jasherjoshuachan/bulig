import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sweepStaleClusters } from './pg-cluster.ts';
import { bins } from './pg-support.ts';
import { startPgServer } from './pg-throwaway.ts';

// What takes a throwaway cluster down (see pg-cluster.ts): the signals that can be handled, and the sweep for the one that cannot.
// These run only where initdb and pg_ctl exist (they make real clusters in a child process).
const CHILD = new URL('./fixtures/pg-cluster-child.ts', import.meta.url).pathname;
const canRun = !!bins('initdb') && !!bins('pg_ctl');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

interface Child {
  proc: ChildProcess;
  dir: string;
  postmaster: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function startChild(): Promise<Child> {
  const proc = spawn(process.execPath, ['--no-warnings', CHILD], { env: { ...process.env, BULIG_PG_TEST_URL: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const dir = await new Promise<string>((resolve, reject) => {
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve((JSON.parse(line) as { dir: string }).dir);
    });
    exited.then(() => reject(new Error('the child exited before it was ready')));
  });
  const postmaster = Number.parseInt(readFileSync(join(dir, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]!, 10);
  return { proc, dir, postmaster, exited };
}

describe.skipIf(!canRun)('a throwaway cluster is taken down', () => {
  const children: Child[] = [];
  afterEach(() => {
    // Never leave one behind, whatever a test did.
    for (const c of children.splice(0)) {
      c.proc.kill('SIGKILL');
      try {
        process.kill(c.postmaster, 'SIGQUIT');
      } catch {
        // gone already
      }
    }
    sweepStaleClusters();
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`when its process gets ${sig}: the postmaster is stopped, the folder is gone, and the process still ends by that signal`, async () => {
      const c = await startChild();
      children.push(c);
      expect(existsSync(c.dir)).toBe(true);
      expect(alive(c.postmaster)).toBe(true);
      c.proc.kill(sig);
      const result = await c.exited;
      expect(result.signal).toBe(sig);
      expect(await until(() => !alive(c.postmaster))).toBe(true);
      expect(existsSync(c.dir)).toBe(false);
    });
  }

  it('when its process is killed with SIGKILL it cannot clean up, and the next run sweeps it: postmaster stopped, folder deleted', async () => {
    const c = await startChild();
    children.push(c);
    c.proc.kill('SIGKILL');
    await c.exited;
    // Nothing could run in the child, so both are still there (unless a parallel run already swept it).
    sweepStaleClusters();
    expect(existsSync(c.dir)).toBe(false);
    expect(await until(() => !alive(c.postmaster))).toBe(true);
  });

  it('the sweep leaves a cluster whose owner is alive alone, and a folder with no owner.pid alone', async () => {
    const mine = await startPgServer();
    try {
      sweepStaleClusters();
      expect(existsSync(mine.dir!)).toBe(true);
      const db = await mine.newDatabase();
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      expect((await c.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      await c.end();
      await db.drop();
    } finally {
      await mine.stop();
    }
    expect(existsSync(mine.dir!)).toBe(false);
  });
});

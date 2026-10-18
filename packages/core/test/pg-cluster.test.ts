import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isPostmasterOf, sweepStaleClusters } from './pg-cluster.ts';
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
      // Signal the recorded postmaster only if it is still that cluster's postmaster: by now it is usually gone, and its
      // pid could belong to another process. Anything left is the sweep's job, which runs the same check.
      if (isPostmasterOf(c.postmaster, join(c.dir, 'data'))) {
        try {
          process.kill(c.postmaster, 'SIGQUIT');
        } catch {
          // gone already
        }
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
    const orphan = mkdtempSync(join(tmpdir(), 'bulig-pg-'));
    mkdirSync(join(orphan, 'data'));
    writeFileSync(join(orphan, 'data', 'keep.txt'), 'x');
    const mine = await startPgServer();
    try {
      const swept = sweepStaleClusters();
      expect(swept).not.toContain(orphan);
      expect(existsSync(join(orphan, 'data', 'keep.txt'))).toBe(true); // no owner.pid: not ours to judge, so not touched
      expect(existsSync(mine.dir!)).toBe(true);
      const db = await mine.newDatabase();
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      expect((await c.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      await c.end();
      await db.drop();
    } finally {
      await mine.stop();
      rmSync(orphan, { recursive: true, force: true });
    }
    expect(existsSync(mine.dir!)).toBe(false);
  });

  it('the sweep never signals a process that merely has the pid in postmaster.pid: an unrelated live process is left alone, nothing waits, the folder stays', async () => {
    // What a leftover folder looks like after a SIGKILLed run plus a reboot or crash: the owner is dead, and the pid in
    // postmaster.pid now belongs to some other program. That program here records any signal it gets, and ignores SIGQUIT.
    const work = mkdtempSync(join(tmpdir(), 'bulig-sweep-test-'));
    const log = join(work, 'signals.log');
    const bystander = spawn(process.execPath, ['-e', `const fs=require('fs');for(const s of ['SIGQUIT','SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>fs.appendFileSync(${JSON.stringify(log)},s+'\\n'));console.log('up');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => bystander.stdout!.once('data', () => r()));
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => dead.on('exit', r));
    const folder = mkdtempSync(join(tmpdir(), 'bulig-pg-'));
    try {
      mkdirSync(join(folder, 'data'));
      writeFileSync(join(folder, 'owner.pid'), String(dead.pid));
      writeFileSync(join(folder, 'data', 'postmaster.pid'), `${bystander.pid}\n${join(folder, 'data')}\n`);
      const t0 = Date.now();
      const swept = sweepStaleClusters();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(swept).not.toContain(folder);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(bystander.pid!)).toBe(true);
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe(''); // not one signal
      expect(existsSync(folder)).toBe(true);
    } finally {
      bystander.kill('SIGKILL');
      rmSync(folder, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { bins, pgSupport } from './pg-support.ts';

// No vitest in this file: a plain node process can import it (see fixtures/pg-cluster-child.ts).

/**
 * A throwaway Postgres for the tests (ADR 0007, step 3).
 *
 * Two ways to get one, tried in this order:
 * 1. BULIG_PG_TEST_URL names a server to use (CI points it at a service container). The tests only create and drop
 *    databases of their own on it, named bulig_test_<random>. The role in the URL needs CREATEDB.
 * 2. `initdb` and `pg_ctl` are found on PATH (or in the folder BULIG_PG_BIN names). Then a brand new cluster is made in a
 *    fresh temp folder `bulig-pg-*`, listening on a unix socket in that folder only (no TCP), trust auth for the local user.
 *    No other cluster is ever opened, stopped or read.
 *
 * What takes the cluster down, and what does not:
 * - A normal finish: `stop()` runs `pg_ctl stop -m immediate` and deletes the folder.
 * - The process exits any other way that runs JavaScript (process.exit, an uncaught error), or gets SIGINT, SIGTERM or
 *   SIGHUP: the same cleanup runs, then a signal is passed on so the process still ends the way it would have.
 * - SIGKILL (and a power cut) cannot be caught. The cluster and its folder stay behind. Each folder holds `owner.pid`, the
 *   pid of the process that made it, so the next run that makes a cluster calls `sweepStaleClusters()` first. It signals a
 *   process only when it passes a check that it is the postmaster of that very folder (name and arguments), and otherwise signals nothing (rules
 *   on `sweepStaleClusters`). Folders without `owner.pid`, and folders whose owner is alive, are never touched.
 */

export interface PgDatabase {
  /** A connection string for this database alone. */
  url: string;
  drop(): Promise<void>;
}

export interface PgServer {
  newDatabase(): Promise<PgDatabase>;
  stop(): Promise<void>;
  /** The folder of the cluster this server made. Absent when the server was given by BULIG_PG_TEST_URL. */
  dir?: string;
}

const withClient = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
};

/** Run one query on a database and hand back the rows. For looking at what a test left behind. */
export const queryRows = <T = Record<string, unknown>>(url: string, sql: string): Promise<T[]> => withClient(url, async (c) => (await c.query(sql)).rows as T[]);

function serverOn(adminUrl: string, onStop: () => Promise<void>, dir?: string): PgServer {
  return {
    ...(dir && { dir }),
    async newDatabase() {
      const name = `bulig_test_${randomBytes(6).toString('hex')}`;
      await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${name}`));
      const u = new URL(adminUrl);
      u.pathname = `/${name}`;
      return {
        url: u.toString(),
        drop: () => withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => {}),
      };
    },
    stop: onStop,
  };
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // it exists but is not ours
  }
};

const PREFIX = 'bulig-pg-';
const FOLDERS = () => [...new Set([tmpdir(), '/tmp'])];

/** The command line of a process, or undefined when it cannot be read. */
const commandOf = (pid: number): string | undefined => {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  const out = r.status === 0 ? r.stdout.trim() : '';
  return out || undefined;
};

/**
 * True only when `pid` is a live postgres process started with exactly `-D <data>`. A pid in a leftover postmaster.pid proves
 * nothing by itself: after a crash or a reboot it can belong to any process, including another cluster's postmaster.
 */
export function isPostmasterOf(pid: number, data: string): boolean {
  const command = commandOf(pid);
  if (!command) return false;
  const exe = command.split(/\s+/)[0] ?? '';
  if (exe.split('/').pop() !== 'postgres') return false;
  const dirs = new Set([data]);
  try {
    dirs.add(realpathSync(data));
  } catch {
    // gone
  }
  return [...dirs].some((d) => command.endsWith(` -D ${d}`) || command.includes(` -D ${d} `));
}

const warned = new Set<string>();

/**
 * Delete clusters that an earlier run left behind (it was killed with SIGKILL). Only folders this helper made (`bulig-pg-*`
 * with an `owner.pid`), and only when that owner process is gone. Then, per folder:
 * - postmaster.pid names a live process that is provably this folder's postmaster (a postgres whose command line has
 *   `-D <folder>/data`): ask it to quit (SIGQUIT, what `pg_ctl stop -m immediate` sends), wait up to 10 s, delete the folder;
 * - it names no live process (or there is no postmaster.pid): delete the folder;
 * - it names a live process that is NOT that postmaster (the pid was reused): signal nothing, never wait, leave the folder, say so once.
 * pg_ctl is not used: it signals whatever pid the file holds.
 */
export function sweepStaleClusters(): string[] {
  const swept: string[] = [];
  for (const base of FOLDERS()) {
    let names: string[] = [];
    try {
      names = readdirSync(base).filter((n) => n.startsWith(PREFIX));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(base, name);
      try {
        const owner = Number.parseInt(readFileSync(join(dir, 'owner.pid'), 'utf8'), 10);
        if (!Number.isInteger(owner) || owner <= 0 || alive(owner)) continue;
        const data = join(dir, 'data');
        let pid = 0;
        try {
          pid = Number.parseInt(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0] ?? '', 10);
        } catch {
          // no postmaster.pid
        }
        if (Number.isInteger(pid) && pid > 1 && alive(pid)) {
          if (!isPostmasterOf(pid, data)) {
            if (!warned.has(dir)) {
              warned.add(dir);
              console.warn(`[bulig] left ${dir}: its postmaster.pid names process ${pid}, which is not that cluster's postmaster. Delete the folder by hand.`);
            }
            continue;
          }
          process.kill(pid, 'SIGQUIT');
          const end = Date.now() + 10_000;
          while (alive(pid) && Date.now() < end) spawnSync('sleep', ['0.1']);
          if (alive(pid)) continue;
        }
        rmSync(dir, { recursive: true, force: true });
        swept.push(dir);
      } catch {
        // not ours, or already gone
      }
    }
  }
  return swept;
}

// Clusters this process has running, and the signal handlers that take them down.
const live = new Set<() => void>();
let handlersInstalled = false;
function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = () => {
      for (const cleanup of [...live]) cleanup();
      for (const [s, h] of handlers) process.off(s, h);
      handlers.clear();
      handlersInstalled = false;
      // Someone else listens for this signal (a test runner, say) and has already been told once. Otherwise end the way the
      // signal would have ended us.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
}

/** Start a server for one test file. Call `stop` when the file is done. */
export async function startPgServer(): Promise<PgServer> {
  const given = process.env.BULIG_PG_TEST_URL;
  if (given) {
    if (!/^postgres(?:ql)?:\/\//i.test(given)) throw new Error('BULIG_PG_TEST_URL must start with postgres:// or postgresql://');
    return serverOn(given, async () => {});
  }

  const initdb = bins('initdb');
  const pgCtl = bins('pg_ctl');
  if (!initdb || !pgCtl) throw new Error(pgSupport.reason);

  sweepStaleClusters();
  const port = await freePort();
  // A unix socket path must stay under about 100 characters. The default temp folder on macOS is close; use /tmp if it is too long.
  let dir = mkdtempSync(join(tmpdir(), PREFIX));
  if (`${dir}/.s.PGSQL.${port}`.length > 100) {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(`/tmp/${PREFIX}`);
  }
  writeFileSync(join(dir, 'owner.pid'), String(process.pid));
  const data = join(dir, 'data');
  let started = false;
  const cleanup = () => {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    started = false;
    rmSync(dir, { recursive: true, force: true });
    live.delete(cleanup);
  };
  live.add(cleanup);
  installSignalHandlers();
  process.on('exit', cleanup);
  const forget = () => {
    live.delete(cleanup);
    process.off('exit', cleanup);
  };

  try {
    run(initdb, ['-D', data, '-U', 'bulig_test', '--auth-local=trust', '--auth-host=reject', '-E', 'UTF8', '--no-locale']);
    appendFileSync(
      data + '/postgresql.conf',
      [
        `listen_addresses = ''`, // no TCP at all
        `unix_socket_directories = '${dir}'`,
        `unix_socket_permissions = 0700`,
        `port = ${port}`,
        `fsync = off`, // a throwaway database: speed over durability
        `synchronous_commit = off`,
        `full_page_writes = off`,
        `shared_buffers = 16MB`,
        `max_connections = 60`,
        `log_min_messages = warning`,
        '',
      ].join('\n'),
    );
    started = true; // from here a cleanup also stops the postmaster, even if start fails halfway
    run(pgCtl, ['-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60', 'start']);
  } catch (err) {
    cleanup();
    forget();
    throw err;
  }

  const adminUrl = `postgresql://bulig_test@localhost/postgres?host=${encodeURIComponent(dir)}&port=${port}`;
  return serverOn(
    adminUrl,
    async () => {
      cleanup();
      forget();
    },
    dir,
  );
}

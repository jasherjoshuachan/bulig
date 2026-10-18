import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { bins, pgSupport } from './pg-support.ts';

export { pgSupport };

/**
 * A throwaway Postgres for the tests (ADR 0007, step 3).
 *
 * Two ways to get one, tried in this order:
 * 1. BULIG_PG_TEST_URL names a server to use (CI points it at a service container). The tests only create and drop
 *    databases of their own on it, named bulig_test_<random>. The role in the URL needs CREATEDB.
 * 2. `initdb` and `pg_ctl` are found on PATH (or in the folder BULIG_PG_BIN names). Then a brand new cluster is made in a
 *    fresh temp folder, listening on a unix socket in that folder only (no TCP), trust auth for the local user, and it is
 *    stopped and deleted afterwards. No other cluster is ever opened, stopped or read.
 *
 * With neither, the Postgres suites skip and say why (see pg-support.ts, `describePg`, and the note pg-notice.ts prints).
 */


/** `describe` for a suite that needs Postgres: skipped, not failed, where there is none. */
export const describePg: typeof describe = pgSupport.available ? describe : (describe.skip as typeof describe);

export interface PgDatabase {
  /** A connection string for this database alone. */
  url: string;
  drop(): Promise<void>;
}

export interface PgServer {
  newDatabase(): Promise<PgDatabase>;
  stop(): Promise<void>;
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

function serverOn(adminUrl: string, onStop: () => Promise<void>): PgServer {
  return {
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

/** Start a server for one test file. Call `stop` when the file is done. */
export async function startPgServer(): Promise<PgServer> {
  const given = process.env.BULIG_PG_TEST_URL;
  if (given) return serverOn(given, async () => {});

  const initdb = bins('initdb');
  const pgCtl = bins('pg_ctl');
  if (!initdb || !pgCtl) throw new Error(pgSupport.reason);

  const port = await freePort();
  // A unix socket path must stay under about 100 characters. The default temp folder on macOS is close; use /tmp if it is too long.
  let dir = mkdtempSync(join(tmpdir(), 'bulig-pg-'));
  if (`${dir}/.s.PGSQL.${port}`.length > 100) {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync('/tmp/bulig-pg-');
  }
  const data = join(dir, 'data');
  let started = false;
  const cleanup = () => {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    started = false;
    rmSync(dir, { recursive: true, force: true });
  };
  // If a test run is killed or crashes, still take this cluster (and only this one) down with it.
  process.on('exit', cleanup);

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
    run(pgCtl, ['-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60', 'start']);
    started = true;
  } catch (err) {
    cleanup();
    process.off('exit', cleanup);
    throw err;
  }

  const adminUrl = `postgresql://bulig_test@localhost/postgres?host=${encodeURIComponent(dir)}&port=${port}`;
  return serverOn(adminUrl, async () => {
    cleanup();
    process.off('exit', cleanup);
  });
}

/** Start a server before the tests in the calling describe block and stop it after. Returns a getter for the running server. */
export function usePgServer(): () => PgServer {
  if (!pgSupport.available) {
    return () => {
      throw new Error(pgSupport.reason);
    };
  }
  let server: PgServer | undefined;
  beforeAll(async () => {
    server = await startPgServer();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  }, 60_000);
  return () => {
    if (!server) throw new Error('the Postgres server is not running yet');
    return server;
  };
}

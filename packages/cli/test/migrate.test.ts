import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '@bulig/core';
import { buildPopulatedV6, setUserVersion } from '../../core/test/populated-v6.ts';
import { describePg, queryRows, usePgServer, type PgDatabase } from '../../core/test/pg-throwaway.ts';
import { runCli, type Io } from '../src/index.ts';

const dirs: string[] = [];
const dbs: PgDatabase[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const d of dbs.splice(0)) await d.drop();
});

describePg('bulig migrate sqlite-to-postgres', () => {
  const server = usePgServer();

  async function world() {
    const dir = mkdtempSync(join(tmpdir(), 'bulig-migrate-'));
    dirs.push(dir);
    const from = join(dir, 'bulig.sqlite');
    const record = await buildPopulatedV6(from);
    const db = await server().newDatabase();
    dbs.push(db);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd: dir, home: dir, env: { TARGET_URL: db.url } };
    const run = async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await runCli(argv, io);
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    return { dir, from, record, db, io, run };
  }
  const rowsIn = async (url: string) => (await queryRows<{ n: string }>(url, 'SELECT (SELECT count(*) FROM jobs) + (SELECT count(*) FROM events) AS n'))[0]!.n;

  it('a dry run prints the comparison table and keeps nothing', async () => {
    const w = await world();
    const r = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry run');
    expect(r.out).toMatch(/table\s+sqlite\s+postgres\s+sqlite sha256\s+postgres sha256\s+result/);
    for (const t of ['jobs', 'stages', 'claims', 'events', 'plugin_state', 'executor_lease']) expect(r.out).toMatch(new RegExp(`^${t}\\s+\\d+\\s+\\d+\\s+[0-9a-f]{16}\\s+[0-9a-f]{16}\\s+same$`, 'm'));
    expect(r.out).not.toContain('DIFFERENT');
    expect(r.out).toContain('Nothing was kept');
    expect(r.err).toMatch(/lease is still live/);
    expect(await rowsIn(w.db.url)).toBe('0');
  });

  it('copies for real, prints the same table, and says what generation the next kernel takes', async () => {
    const w = await world();
    const r = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL');
    expect(r.code).toBe(0);
    expect(r.out).toContain('every table matches');
    expect(r.out).toContain('already released at generation 3');
    expect(r.out).toContain('takes 4');
    expect(Number(await rowsIn(w.db.url))).toBeGreaterThan(0);
    // the CLI reads the copy through the configured store
    const store = await PostgresStore.open(w.db.url);
    expect((await store.listJobs()).map((j) => j.status).sort()).toEqual(['awaiting_approval', 'cancelled', 'done', 'failed', 'queued', 'running']);
    await store.close();
  });

  it('a second copy into the same database is refused with exit 2 and changes nothing', async () => {
    const w = await world();
    await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL');
    const before = await rowsIn(w.db.url);
    const r = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^bulig: The Postgres record is not empty \(jobs: 6 rows/);
    expect(await rowsIn(w.db.url)).toBe(before);
  });

  it('refuses a SQLite file at the wrong schema version, and says how to fix it', async () => {
    const w = await world();
    setUserVersion(w.from, 5);
    const r = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL');
    expect(r.code).toBe(2);
    expect(r.err).toContain('schema version 5');
    expect(r.err).toContain('Nothing was written');
  });

  it('says plainly what is wrong with the arguments and the variable, without printing the connection string', async () => {
    const w = await world();
    expect((await w.run('migrate')).code).toBe(2);
    const noFrom = await w.run('migrate', 'sqlite-to-postgres', '--to-env', 'TARGET_URL');
    expect(noFrom).toMatchObject({ code: 2 });
    expect(noFrom.err).toContain('needs --from and exactly one of --to-env and --to-credential');
    const both = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL', '--to-credential', 'pg-url');
    expect(both.code).toBe(2);
    expect(both.err).toContain('exactly one of --to-env and --to-credential');
    expect((await w.run('migrate', 'sqlite-to-postgres', '--from', w.from)).code).toBe(2);
    const unset = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'NOT_SET_ANYWHERE');
    expect(unset.code).toBe(2);
    expect(unset.err).toContain('NOT_SET_ANYWHERE is not set');
    w.io.env = { TARGET_URL: 'postgresql:///bulig?password=hunter2' };
    const noHost = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-env', 'TARGET_URL');
    expect(noHost.code).toBe(2);
    expect(noHost.err).toContain('name a host');
    expect(noHost.err + noHost.out).not.toContain('hunter2');
    w.io.env = { TARGET_URL: w.db.url };
    const missing = await w.run('migrate', 'sqlite-to-postgres', '--from', join(w.dir, 'nope.sqlite'), '--to-env', 'TARGET_URL');
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no SQLite file');
  });

  // On the server, bulig-cli.sh --as kernel gives the one-off unit the pg-url credential (systemd LoadCredential=). The URL holds the
  // password, so it is read from that file and never passed through an environment variable or an argument.
  const credentialDir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'bulig-migrate-cred-'));
    dirs.push(d);
    for (const [n, v] of Object.entries(files)) {
      writeFileSync(join(d, n), v + '\n');
      chmodSync(join(d, n), 0o400);
    }
    return d;
  };

  it('--to-credential reads the URL from $CREDENTIALS_DIRECTORY and copies, with no URL in the environment', async () => {
    const w = await world();
    w.io.env = { CREDENTIALS_DIRECTORY: credentialDir({ 'pg-url': w.db.url }) };
    const dry = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', 'pg-url', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Nothing was kept');
    expect(await rowsIn(w.db.url)).toBe('0');
    const r = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', 'pg-url');
    expect(r.code).toBe(0);
    expect(r.out).toContain('every table matches');
    expect(r.out).toContain('named by credential pg-url');
    expect(r.out + r.err).not.toContain(w.db.url);
    expect(Number(await rowsIn(w.db.url))).toBeGreaterThan(0);
  });

  it('--to-credential says plainly what is missing or wrong, without printing the connection string', async () => {
    const w = await world();
    w.io.env = {};
    const noDir = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', 'pg-url');
    expect(noDir.code).toBe(2);
    expect(noDir.err).toMatch(/credential pg-url is not there.*CREDENTIALS_DIRECTORY, which is not set/);
    w.io.env = { CREDENTIALS_DIRECTORY: credentialDir({ 'other': w.db.url }) };
    const noFile = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', 'pg-url');
    expect(noFile.code).toBe(2);
    expect(noFile.err).toContain('no file pg-url in $CREDENTIALS_DIRECTORY');
    w.io.env = { CREDENTIALS_DIRECTORY: credentialDir({ 'pg-url': 'postgresql:///bulig?password=hunter2' }) };
    const noHost = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', 'pg-url');
    expect(noHost.code).toBe(2);
    expect(noHost.err).toContain('the credential pg-url does not hold a usable Postgres connection string');
    expect(noHost.err + noHost.out).not.toContain('hunter2');
    w.io.env = { CREDENTIALS_DIRECTORY: credentialDir({ 'pg-url': w.db.url }) };
    const pathLike = await w.run('migrate', 'sqlite-to-postgres', '--from', w.from, '--to-credential', '../pg-url');
    expect(pathLike.code).toBe(2);
    expect(pathLike.err).toContain('credential ../pg-url is not there');
  });
});

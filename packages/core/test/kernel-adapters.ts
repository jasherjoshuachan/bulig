import { afterEach } from 'vitest';
import { PostgresStore, SqliteStore, type Store } from '../src/index.ts';
import { tempDb } from './helpers.ts';
import { pgSupport, usePgServer, type PgDatabase } from './pg-throwaway.ts';

/** One engine a kernel test runs on. `make` opens a fresh record; `peek` opens a second handle on that same record, for reading it. */
export interface KernelAdapter {
  name: string;
  skip: boolean;
  make(): Promise<Store>;
  peek(): Promise<Store>;
}

/**
 * The adapters a kernel-level test runs on, SQLite and (where there is a server) Postgres. Call it once at the top of the test
 * file: it starts the throwaway server and closes every store it handed out after each test. `cleanups` is for the test's own teardown.
 */
export function useKernelAdapters(): { adapters: KernelAdapter[]; cleanups: (() => Promise<unknown>)[] } {
  const server = usePgServer();
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });
  let sqlitePath = '';
  let pgDb: PgDatabase | undefined;
  const adapters: KernelAdapter[] = [
    {
      name: 'SqliteStore',
      skip: false,
      async make() {
        sqlitePath = tempDb();
        const s = new SqliteStore(sqlitePath);
        cleanups.push(() => s.close());
        return s;
      },
      async peek() {
        const s = new SqliteStore(sqlitePath);
        cleanups.push(() => s.close());
        return s;
      },
    },
    {
      name: 'PostgresStore',
      skip: !pgSupport.available,
      async make() {
        const db = (pgDb = await server().newDatabase());
        const s = await PostgresStore.open(db.url);
        cleanups.push(async () => {
          await s.close();
          await db.drop();
        });
        return s;
      },
      async peek() {
        const s = await PostgresStore.open(pgDb!.url, { mode: 'reader' });
        cleanups.push(() => s.close());
        return s;
      },
    },
  ];
  return { adapters, cleanups };
}

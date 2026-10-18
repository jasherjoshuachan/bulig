import { afterAll, beforeAll, describe } from 'vitest';
import { startPgServer, type PgDatabase, type PgServer } from './pg-cluster.ts';
import { pgSupport } from './pg-support.ts';

export { pgSupport, startPgServer, type PgDatabase, type PgServer };

/** `describe` for a suite that needs Postgres: skipped, not failed, where there is none. See pg-cluster.ts for how the server is made and taken down. */
export const describePg: typeof describe = pgSupport.available ? describe : (describe.skip as typeof describe);

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

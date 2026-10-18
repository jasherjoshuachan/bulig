import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Is there a Postgres to test against? Plain node, so both the test helper and the vitest global setup can ask.

export const bins = (name: string): string | undefined => {
  const dirs = [process.env.BULIG_PG_BIN, ...(process.env.PATH ?? '').split(delimiter)].filter((d): d is string => !!d);
  for (const dir of dirs) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
};

export interface PgSupport {
  available: boolean;
  /** Why the suites run or skip, in a sentence. */
  reason: string;
}

function detect(): PgSupport {
  if (process.env.BULIG_PG_TEST_URL) return { available: true, reason: 'using the server in BULIG_PG_TEST_URL' };
  if (bins('initdb') && bins('pg_ctl')) return { available: true, reason: 'making a throwaway cluster with initdb and pg_ctl' };
  return {
    available: false,
    reason: 'Postgres suites skipped: initdb and pg_ctl are not on PATH (set BULIG_PG_BIN to the folder that has them) and BULIG_PG_TEST_URL is not set',
  };
}

export const pgSupport = detect();

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertPostgresUrl, copySqliteToPostgres, CopyRefusedError, COPY_SCHEMA_VERSION, type CopyReport } from '@bulig/core';
import { readCredential } from '@bulig/worker-claude-code';
import type { Io } from './commands.ts';

const USAGE = `usage: bulig migrate sqlite-to-postgres --from <sqlite-file> (--to-env <ENV_VAR> | --to-credential <NAME>) [--dry-run]

Copies a Bulig SQLite record (schema version ${COPY_SCHEMA_VERSION}) into an empty Postgres database, once.
  --from           the SQLite file. It is opened read-only. Copy the file first if a Bulig is still writing to it.
  --to-env         the name of the environment variable that holds the Postgres connection string (it must name a host)
  --to-credential  the name of a file in $CREDENTIALS_DIRECTORY (systemd LoadCredential=) that holds it, for example pg-url.
                   On a server use this one: the URL and its password never go into an environment variable or an argument.
                   Give exactly one of the two.
  --dry-run        do everything, print the comparison, then undo it. The database keeps its tables (the schema is
                   set up first, as the kernel would) but no rows.`;

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function printReport(r: CopyReport, io: Io): void {
  io.out('');
  io.out(`${pad('table', 15)}${pad('sqlite', 8)}${pad('postgres', 10)}${pad('sqlite sha256', 18)}${pad('postgres sha256', 18)}result`);
  for (const t of r.tables) {
    io.out(`${pad(t.table, 15)}${pad(String(t.sqliteRows), 8)}${pad(String(t.postgresRows), 10)}${pad(t.sqliteChecksum.slice(0, 16), 18)}${pad(t.postgresChecksum.slice(0, 16), 18)}${t.match ? 'same' : 'DIFFERENT'}`);
  }
  io.out('(checksums are sha256 over each table\'s rows in primary key order; the first 16 characters are shown)');
  io.out('');
}

/** `bulig migrate <what> ...`. Returns the exit code: 0 copied and matching, 1 the two sides differ, 2 refused before writing anything. */
export async function cmdMigrate(args: string[], io: Io): Promise<number> {
  const [what, ...rest] = args;
  if (what !== 'sqlite-to-postgres') {
    io.err(`bulig: ${what ? `unknown migration "${what}"\n\n` : ''}${USAGE}`);
    return 2;
  }
  let values: { from?: string; 'to-env'?: string; 'to-credential'?: string; 'dry-run'?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { from: { type: 'string' }, 'to-env': { type: 'string' }, 'to-credential': { type: 'string' }, 'dry-run': { type: 'boolean' } },
      strict: true,
    }));
  } catch (err) {
    io.err(`bulig: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const envName = values['to-env'];
  const credName = values['to-credential'];
  if (!values.from || (envName === undefined) === (credName === undefined)) {
    io.err(`bulig: migrate sqlite-to-postgres needs --from and exactly one of --to-env and --to-credential\n\n${USAGE}`);
    return 2;
  }
  const env = io.env ?? process.env;
  // What the target is called in messages. The value itself is never printed: it may hold a password.
  const name = credName !== undefined ? `credential ${credName}` : (envName as string);
  const where = credName !== undefined ? `the credential ${credName}` : `the environment variable ${envName}`;
  const url = credName !== undefined ? readCredential(credName, env) : env[envName as string];
  if (!url) {
    io.err(
      credName !== undefined
        ? `bulig: ${where} is not there (no file ${credName} in $CREDENTIALS_DIRECTORY${env.CREDENTIALS_DIRECTORY ? '' : ', which is not set'}). Give the unit that credential (bulig-cli.sh --as kernel loads pg-url).`
        : `bulig: ${where} is not set. Set it to the Postgres connection string of the empty database.`,
    );
    return 2;
  }
  try {
    assertPostgresUrl(url);
  } catch {
    io.err(`bulig: ${where} does not hold a usable Postgres connection string. It must start with postgres:// or postgresql:// and name a host.`);
    return 2;
  }
  const dryRun = values['dry-run'] === true;
  const from = resolve(io.cwd, values.from);

  let report: CopyReport;
  try {
    report = await copySqliteToPostgres({ from, postgresUrl: url, dryRun });
  } catch (err) {
    if (err instanceof CopyRefusedError) {
      io.err(`bulig: ${err.message}`);
      return 2;
    }
    throw err;
  }

  for (const w of report.warnings) io.err(`warn: ${w}`);
  io.out(dryRun ? `bulig: dry run of the copy from ${from}. Everything below was written and then undone.` : `bulig: copied ${from} into the Postgres record named by ${name}.`);
  printReport(report, io);
  if (!report.ok) {
    io.err(
      report.committed
        ? 'bulig: the rows now in Postgres do NOT match the SQLite file (see DIFFERENT above). The copy was kept. Do not use this database: drop it, make a new empty one, and copy again.'
        : 'bulig: the rows written to Postgres do NOT match the SQLite file (see DIFFERENT above). Nothing was kept.',
    );
    return 1;
  }
  if (dryRun) {
    io.out('bulig: the dry run matches. Nothing was kept. Run again without --dry-run to copy for real.');
  } else {
    io.out(`bulig: every table matches. ${report.leaseGeneration !== undefined ? `The lease was copied already released at generation ${report.leaseGeneration}; the next kernel on this record takes ${report.leaseGeneration + 1}.` : 'The source had no lease, so the next kernel starts at generation 1.'}`);
    io.out('bulig: the SQLite file was not changed. Keep it as the backup.');
  }
  return 0;
}

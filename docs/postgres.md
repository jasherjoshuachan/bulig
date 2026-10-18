# Running Bulig on Postgres

Bulig keeps its record (jobs, stages, events, plugin state) behind one `Store` port. SQLite is the default. Postgres is the second adapter, `PostgresStore` in `packages/core/src/postgres-store.ts`. Both pass the same contract suite. The reasons are in [ADR 0007](adr/0007-postgres-async-store.md).

## Point Bulig at a Postgres database

1. Make a database and a role for Bulig (Postgres 16 is what the tests run on). The role needs to create tables in it. Nothing else.
2. Put the connection string in an environment variable. Keep it out of the config file and out of git.

```bash
export BULIG_DATABASE_URL='postgresql://bulig_role@db-host:5432/bulig'
```

3. Tell the config which variable to read:

```json
{ "store": { "kind": "postgres", "urlEnv": "BULIG_DATABASE_URL" } }
```

The config refuses a connection string in `urlEnv`, and refuses a `url` key, so a password cannot end up in the file by mistake. `dbPath` is still used for one thing: the lock file next to it, which stops two Bulig processes on the same machine from running the same record. No SQLite file is made.

On the first call Bulig connects, then runs any migrations the database has not seen. They run in one transaction, behind an advisory lock, so two processes starting at once cannot both build the tables. The version is kept in the table `bulig_schema`. A database that is newer than the Bulig you run is refused.

## How the adapter behaves

- **One connection.** A single `pg.Client`, not a pool. The kernel queue sends one task at a time and a transaction has to stay on one connection. Statements go out one at a time, in the order the calls were made.
- **Transactions.** `BEGIN`, the task's calls, `COMMIT`. If the task fails, `ROLLBACK`. If the `COMMIT` or the `ROLLBACK` fails, the adapter throws `StoreFatalError` and the kernel stops using the store, because it can no longer say what the record holds.
- **A database error abandons the transaction.** That is how Postgres works. The adapter checks the cases the port rejects on (a missing job or stage, a value with no JSON form) before it sends anything, so those do not abandon it. A real database error does, and if the task carries on after one, `transaction` rejects instead of reporting a commit.
- **Give up (`abort`).** When a store call never comes back, the kernel calls `abort()`. The adapter destroys the connection. This process sends nothing more on it, every later call is refused, and the server rolls back whatever transaction was open when the connection went away. A `COMMIT` that was already on the wire cannot be recalled, and the kernel's error says so ("may or may not have been kept").
- **JSON.** Values go into `JSONB`. JSONB cannot hold a NUL character (`\u0000`), which a SQLite text column can. The adapter rejects such a value with a clear message before the server sees it.
- **Order.** Jobs and stages are ordered by their time, then by an identity column, as SQLite orders by time then rowid. Events are ordered by `seq`, an identity column. Postgres does not give a sequence value back on rollback, so `seq` can skip numbers. It never goes down.
- **No reconnect.** If the connection drops, every later call rejects until Bulig is restarted.

## Run the Postgres tests

The tests make their own throwaway cluster. They need `initdb` and `pg_ctl` on `PATH`.

```bash
brew install postgresql@16
export BULIG_PG_BIN=/opt/homebrew/opt/postgresql@16/bin   # only if initdb is not already on PATH
pnpm test
```

For each test file that needs Postgres, the helper `packages/core/test/pg-throwaway.ts` runs `initdb` in a fresh temp folder, starts the cluster on a unix socket in that folder (no TCP, trust auth for your user), makes one database per test, and at the end runs `pg_ctl stop -m immediate` and deletes the folder. It never touches another cluster or a Homebrew service.

To use a server that already runs, set `BULIG_PG_TEST_URL` to a connection string whose role can create databases. The tests then create and drop databases named `bulig_test_<random>` on it and nothing else. CI does this with a `postgres:16` service container.

```bash
BULIG_PG_TEST_URL='postgresql://postgres:secret@127.0.0.1:5432/postgres' pnpm test
```

With neither `initdb` and `pg_ctl` nor `BULIG_PG_TEST_URL`, the Postgres suites skip and print `Postgres suites skipped: ...`. `scripts/verify.sh` notes the skip, and fails on it when `CI` is set.

What runs on Postgres: the shared store contract suite, the Postgres-specific tests (migrations, COMMIT and ROLLBACK failures, abort, closing, NUL), the queue rules with a real slow call (a table lock held by another connection, and `pg_sleep`), the async-store tests, a whole pipeline job, and the CLI.

## Not done yet

- No data migration from SQLite. A Postgres record starts empty.
- No server setup: no cluster, role, port, limits or backups on ths-prod-01. Nothing live depends on this adapter, and nothing should until a restore has been tested (ADR 0007).
- No standby or second kernel. One kernel writes. The lock file only guards one machine.
- No reconnect, no pool, no TLS settings beyond what the connection string carries.

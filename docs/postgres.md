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

The config refuses a connection string in `urlEnv`, and refuses a `url` key, so a password cannot end up in the file by mistake. The variable's value must start with `postgres://` or `postgresql://` and name a host (or give a `host=` parameter in the query string, which can be a socket folder); anything else is refused with an error that does not repeat it. A string with no host would make the driver dial localhost on the default port, so it is refused rather than guessed. No SQLite file is made.

## One writer

ADR 0001's rule (one kernel writes the record) is enforced on the database itself, not by a file. When the kernel's store connects, it takes a session-level advisory lock (`pg_try_advisory_lock`, on a key derived from the fixed string `bulig.kernel.writer`) on its one connection and keeps it as long as the connection is open. If another kernel already holds it, opening fails with "Another Bulig kernel is already writing to this database". The server releases the lock when the connection closes, however it closes (a clean `close()` gives it back first). Advisory locks belong to one database, so this means one writer per database, on any machine.

Which paths take it:

- **Writer** (the default for `PostgresStore`): the kernel behind `serve`, `run`, `approve`, `deny` and `resume`.
- **Reader** (`{ mode: 'reader' }`): `status`, `history`, and the job lookup that `approve`, `deny` and `resume` do before they start a kernel. A reader never takes or waits for the lock, so it is never refused, even while a kernel is running.

The lock file next to `dbPath` still exists, and still stops two processes that share one config from starting together. It is not what keeps the record single-writer: two configs with different `dbPath` values and the same database are stopped by the advisory lock. If a stuck statement is holding up a kernel that gave up on its store (`abort()`), the server frees the lock once that statement ends and the connection is gone, so a restart straight after may be refused for a moment. A connection pooler in transaction mode (pgbouncer) would break session locks; connect directly.

On the first call Bulig connects, then runs any migrations the database has not seen. They run in one transaction, behind an advisory lock, so two processes starting at once cannot both build the tables. The version is kept in the table `bulig_schema`. A database that is newer than the Bulig you run is refused.

## How the adapter behaves

- **One connection, and one more for the lease.** A single `pg.Client` serves every call, not a pool. The kernel queue sends one task at a time and a transaction has to stay on one connection. Statements go out one at a time, in the order the calls were made. The executor lease (ADR 0010) has a second connection of its own, opened the first time the lease is used, that takes no advisory lock: the heartbeat that renews the lease must not wait behind a slow task. A transaction that asserts the lease reads its row `FOR KEY SHARE`, so a takeover (a new generation) waits for it to end, and a renewal (only `expires_at` changes) does not. The second connection is dropped by `abort()` and `close()` with the first.
- **Transactions.** `BEGIN`, the task's calls, `COMMIT`. If the task fails, `ROLLBACK`. If the `COMMIT` or the `ROLLBACK` fails, the adapter throws `StoreFatalError` and the kernel stops using the store, because it can no longer say what the record holds.
- **A database error abandons the transaction.** That is how Postgres works. The adapter checks the cases the port rejects on (a missing job or stage, a value with no JSON form) before it sends anything, so those do not abandon it. A real database error does, and if the task carries on after one, `transaction` rejects instead of reporting a commit.
- **Give up (`abort`).** When a store call never comes back, the kernel calls `abort()`. The adapter destroys the connection. This process sends nothing more on it, every later call is refused, and the server rolls back whatever transaction was open when the connection went away. A `COMMIT` that was already on the wire cannot be recalled, and the kernel's error says so ("may or may not have been kept").
- **Text that an engine would refuse.** Both adapters apply the same rules (`packages/core/src/store-text.ts`), so they store the same thing. In JSON values (state, event payloads, stage output) a lone UTF-16 surrogate (half an emoji, for example from cutting a string at a length) and a NUL character become U+FFFD, so a stray half-character never costs a write. In plain text columns and identifiers (repo, title, body, ids, names, keys, event types, sources) a NUL character is refused with a clear error before the database, because quietly changing a key or a name could make two of them collide. A lone surrogate there becomes U+FFFD too. The cause is also fixed at the source: every place that cuts text to a length and sends the result into the record, an event or a message uses `clipText` from `@bulig/text`, which never splits a pair (the Telegram message chunker is built on it). The slices left alone cannot split a pair: ids, SHAs and fixed ASCII prefixes (`approve-`, git status codes), array slices, slugs (ASCII only), text matched but never kept (the evidence gate's clause scans), and bytes read as latin1 (the worker's line skim).
- **Key order.** JSONB does not keep the order of an object's keys; SQLite does. No caller depends on it.
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

If the test run gets SIGINT, SIGTERM or SIGHUP, or exits any way that runs JavaScript, the cluster is stopped and its folder deleted. SIGKILL cannot be caught, so a cluster can be left behind; each folder holds `owner.pid`, and the next run that makes a cluster sweeps any `bulig-pg-*` folder whose owner process is gone (`sweepStaleClusters` in `packages/core/test/pg-cluster.ts`). The sweep sends a signal only to a process that passes a check: its executable is named `postgres` and its command line has exactly `-D <folder>/data`. That is a check of the name and arguments, not proof of identity, but only something started on that random folder can match it. Then it deletes the folder. If `postmaster.pid` names a live process that fails the check, it signals nothing, waits for nothing, leaves the folder and says so once. It never uses `pg_ctl` on a leftover folder, and never touches a folder without `owner.pid` or with a live owner.

With neither `initdb` and `pg_ctl` nor `BULIG_PG_TEST_URL`, the Postgres suites skip and print `Postgres suites skipped: ...`. `scripts/verify.sh` notes the skip, and fails on it when `CI` is set.

What runs on Postgres: the shared store contract suite, the Postgres-specific tests (migrations, COMMIT and ROLLBACK failures, abort, closing, NUL), the queue rules with a real slow call (a table lock held by another connection, and `pg_sleep`), the async-store tests, a whole pipeline job, and the CLI.

## Not done yet

- No data migration from SQLite. A Postgres record starts empty.
- No server setup: no cluster, role, port, limits or backups on ths-prod-01. Nothing live depends on this adapter, and nothing should until a restore has been tested (ADR 0007).
- No standby or second kernel. One kernel writes; a second is refused, not queued. The lease and its generation number are what a standby will use (ADR 0010); the writer lock above still keeps a second one out until then.
- No reconnect, no pool, no TLS settings beyond what the connection string carries.

# 0001. SQLite with a single writer

## Context

Bulig needs to keep jobs, stages and an event log, and read them back after a crash or restart. It runs on one machine at first, as one process. A separate database server would be more to run than the thing it stores for. Several processes writing at once would need locking rules we don't need yet.

## Decision

Use SQLite through better-sqlite3. The kernel owns the only connection and is the only writer. It runs in WAL mode so reads stay fast. The schema changes through numbered migrations tracked with `PRAGMA user_version`. Plugins never get the database. They get a narrow jobs API and the event bus.

## Consequences

- Nothing to install or host. The whole state is one file you can copy.
- Writes are synchronous and ordered, which keeps the event log in a clear order.
- Plugins can't corrupt the schema because they can't reach it.
- One machine, one process. Multi-machine workers will need a different design, and that is a later ADR.
- Every schema change needs a new migration entry. Old entries are never edited.

## In my words (Jasher)

SQLite was the right start. Bulig ran on one machine as one process, and a database server would have been more to look after than the data it held. I wanted nothing to install and a log in a clear order, and this gave me both.

The rule I care about most is that the kernel is the only writer and plugins never get the database. That protects the data from every plugin I'll ever add, and it stays when the engine changes. Moving to Postgres changes what sits underneath. It doesn't change who is allowed to write.

The record is moving to Postgres on ths-prod-01, in its own cluster, behind an async Store port. SQLite doesn't go away. It stays as the default for tests and for anyone trying Bulig for the first time, and both adapters have to pass the same test suite. I'd rather keep that honest than let the SQLite path rot.

Status: the storage choice in this ADR is being replaced. The single-writer rule is not.

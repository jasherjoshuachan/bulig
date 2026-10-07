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

_To be written by Jasher before v0.1 is tagged._

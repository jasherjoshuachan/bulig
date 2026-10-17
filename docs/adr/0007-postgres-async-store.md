# 0007. Postgres is the record, behind an async Store port

## Context

ADR 0001 chose SQLite with a single writer, for one machine and one process. That was right for v0.1 and it is still how Bulig runs on the Mac. The plan now is one kernel on the server ths-prod-01, with work that needs a real database server: claims with leases, a fenced executor, wake-ups, and backups that can be restored on a schedule. SQLite behind a synchronous `Store` does not give those.

The kernel's `Store` has 14 public methods, all synchronous. The plugin-facing `JobsApi` has 7 methods, also synchronous, called in 45 places across six plugins (31 in `pipeline-dev`, 10 in `channel-telegram`, one each in four others). `ctx.state` was made async in the SDK release candidate (ADR 0004) to prepare for this.

## Decision

- **Postgres 16 becomes the record on ths-prod-01**, in a new cluster of its own, on its own port, with its own database and role. A Postgres already runs on that server (seen on 14 Oct 2026, contents not inspected). It is left alone.
- **The kernel stays the only writer.** Plugins never see the database. This is ADR 0001's rule, and it does not change with the engine.
- **`Store` becomes an async port.** Two adapters sit behind it: Postgres, and SQLite for tests and for anyone trying Bulig with nothing to install. Both pass one shared test suite.
- **`JobsApi` becomes async**, the same way `ctx.state` did, while the SDK is still a release candidate and before any outside plugin exists.
- **Schema changes** stay numbered migrations on both adapters. Upgrades follow expand, migrate, contract: a new format beside the old, a one-time migration, then the old path removed after the ADR 0006 window.

## Consequences

- All 45 call sites become async. That is a breaking change for plugins and is allowed because the SDK is still a release candidate and nothing is frozen. `pipeline-dev` is the largest piece, because it runs as a synchronous state machine today.
- Events keep the ADR 0002 rule: written to the log first, delivered in log order. With an async store this needs one ordered queue, and a test that fails when the order breaks.
- One more service to run, limit and back up on a server shared with client production. It needs its own unix user and CPU and memory limits. Backups (a dump or an archived log, sent to object storage) must have a tested restore before anything live depends on it.
- Two adapters have to be kept in step by one test suite.
- Not decided here: how the existing Mac database moves over, claims and leases, a standby kernel, wake-ups. Each gets its own ADR when it is built.

## In my words (Jasher)

I'm moving the record to Postgres for what a desk drawer can't do. More than one worker needs to use it at once, a file needs a lock while someone is working on it, and I need backups I can restore from. Running on the server comes with that. It isn't the reason by itself.

It costs something and I'm paying it now. Every call to the jobs API becomes async, 45 places across six plugins, and `pipeline-dev` is the biggest rewrite. I would rather do that while the SDK is a release candidate than keep a synchronous API with a copy in memory, because a crash can lose that copy. I made the same choice for `ctx.state`.

SQLite stays as the second adapter, for tests and for anyone trying Bulig with nothing to install. One test suite has to pass on both.

The new database lives next to client production files, and Bulig must never put those at risk. So it gets its own cluster, its own role and its own limits. Nothing live depends on it until a restore has been tested.

This ADR is only about the record. Claims and leases, approvals, identity and the rest each get their own ADR when they are built. How the existing Mac database moves over is not decided here.

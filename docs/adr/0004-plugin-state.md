# 0004. A small key-value store per plugin

## Context

The Telegram channel polls a remote service. After a restart it must know which update it handled last, or it would read old commands again and start jobs twice. Plugins have no database access (ADR 0001), and the event log is the wrong place for a cursor: it is append-only and replaying it to find the latest value is slow and awkward.

## Decision

The kernel keeps one table, `plugin_state(plugin, key, value)`, added as schema migration 3. Each plugin gets `ctx.state` with two calls, `get(key)` and `set(key, value)`. Values are JSON. The kernel fills in the plugin name, so a plugin can only read and write its own keys. The writes go through the same single connection as everything else.

## Consequences

- A plugin can keep a cursor, a cache key or a counter without touching the schema.
- State is not part of the event log, so it is not replayed. Plugins that need history should emit events.
- There is no delete and no listing yet. Add them when a plugin needs them.
- One plugin cannot see another's keys. Sharing data still goes through events.
- The Telegram channel stores `offset` (the next update id) and `chat:<jobId>` (which chat started a job). It saves the offset before it runs a command, so a crash skips a command instead of running it twice.

## In my words (Jasher)

State is for "where I am now" and the event log is for history. I keep them apart. A plugin can only see its own keys, and anything shared goes through events.

The Telegram bot saves its position before it runs a command. If it crashes mid-command, that command is skipped and I send it again. I would rather resend than start a paid job twice.

State is moving from synchronous to async when the record moves to Postgres. I'm doing it before the SDK freeze, while only one plugin uses it, so nobody has to carry two versions. Whatever the API looks like, a state write is durable when the call returns. A plugin that awaits `set` can trust it.

There is no delete and no listing, and state grows with every job. I'm leaving that for now. Adding a method later breaks nobody.

# 0010. Claims and an executor lease

## Context

ADR 0001 made the kernel the only writer, and ADR 0007 moved the record behind an async Store with one fail-closed queue. Two things are still missing for a kernel that can be killed and started again, or one day replaced by a standby, without doing work twice.

- **Nothing says who is working on a stage.** When a kernel dies mid-build, the next one finds a stage marked `running` and runs it again. That is right when the first kernel is really gone. It is wrong when the first one is only stalled and wakes up later: two Claude sessions in one worktree, two commits, two PRs.
- **Nothing stops an old kernel's late write.** The advisory writer lock (ADR 0007) keeps a second kernel out of the database while the first is connected. It says nothing about a first kernel that is still connected and has been replaced in every other way.

Event ids were also random and unchecked. Nothing in the record could refuse an id that was written twice.

## Decision

Three pieces, all in the record, none of them in plugins.

- **A claim per job stage.** A table `claims(job_id, stage, generation, attempt, claimed_at, released_at, release_reason)`. A claim with no `released_at` is live, and a partial unique index on `(job_id, stage) WHERE released_at IS NULL` lets only one claim be live. `startStage` takes the claim in the same transaction that writes the stage, so there is no stage without a claim and no claim without a stage. If a live claim of the current generation (or a newer one) exists, `startStage` rejects with `StageClaimedError`. If the live claim belongs to an older generation, it is released with the reason `lease-lost`, its stage is closed as failed with `{ interrupted: true, reason: 'lease-lost' }`, and the new claim is the next attempt. `finishStage` releases the claim. The attempt number is the fence: a `finishStage` for an attempt whose claim is already released is refused with `StageNotClaimedError`. On Postgres the takeover reads the claim row with `FOR UPDATE SKIP LOCKED`, so it never waits for a row another transaction is changing.
- **An executor lease with a generation.** One row, `executor_lease(holder, generation, expires_at)`. `acquireLease(holder, ttlMs)` succeeds when there is no row, the row has run out, or the caller already holds it, and always raises the generation by one. Otherwise it rejects with `LeaseHeldError`. `renewLease(holder, generation, ttlMs)` answers true or false. `assertLease(holder, generation)` runs inside a transaction and rejects with `LeaseLostError` if the holder or generation differ or the lease has run out. Time is the database's: `clock_timestamp()` on Postgres, SQLite's own `julianday('now')` on SQLite, read in SQL and never in JavaScript. The lease lasts 30 s and is renewed every 10 s. Both are options (`leaseTtlMs`, `leaseHeartbeatMs`), and the heartbeat must be under half the lease so one missed beat does not lose it.
- **Every write carries the fence.** The queue is given the kernel's `{ holder, generation }` once the kernel has the lease. Every task, reads included, calls `assertLease` first, inside its own transaction. Reads are fenced too because it is the simplest rule to hold. If the lease is gone, the task writes nothing and the queue breaks with the existing `StoreBrokenError` (fail-closed, no new error family for the queue). The kernel takes the lease before any plugin runs, renews it from a path of its own, and breaks the queue if a renewal is refused, throws, or has not come back by the next beat.
- **Event ids are keys.** A unique index on `events.id`: an id is stored once. `appendEvent` accepts an `id`, and a second event with an id already in the log rejects with `DuplicateEventError` and writes nothing. This is a guard for later, not dedup today: the kernel's `bus.record` never passes an id, so every event still gets a fresh random one and `DuplicateEventError` does not fire in production. What keeps a handler that runs twice from doing the work twice is the `stageId` guards described below.

The heartbeat never goes through the queue. A task may run for 30 s (the queue's own timeout), as long as the lease, so a renewal queued behind it would let a healthy kernel lose its lease. The Store contract says so: `renewLease` may be called while a transaction is open and must not wait for it. Postgres uses a second connection for it. SQLite has one synchronous connection, runs the statement at once, and runs it again if the open transaction rolls back, so a rollback cannot undo a renewal.

On Postgres the fence is also a lock. `assertLease` reads the row `FOR KEY SHARE`, and the unique index on `(id, generation)` makes `generation` a key column. A takeover changes the generation, so it waits until every transaction of the old holder has ended. A renewal changes only `expires_at`, so it does not. The old holder's open transactions finish, and any it starts afterwards finds the new generation.

Effects outside the record are guarded where they happen, because the fence only covers the record:

- `worker-claude-code` starts Claude for a `stage.requested` only if the stage named in `stageId` is the running attempt. Otherwise it does nothing and says nothing.
- `github` makes one commit per stage attempt. The commit carries a `Bulig-Stage: <stageId>` trailer, and a request whose attempt already has a commit gets that commit back, with the files it holds outside the approved scope reported as a new commit's answer would (addendum of 18 Oct 2026).
- `pipeline-dev` sends `stageId` with `stage.requested` and `commit.requested`, treats `StageClaimedError` as a duplicate and not as a failed job, and on resume leaves alone any running stage that holds a claim of this kernel's generation.

## Jasher's words (18 Oct 2026)

- Claim unit: per job stage. One worker per stage. Stages of different jobs run in parallel.
- Lease: 30 s, heartbeat every 10 s.
- Lost lease: stop writing at once. The next holder resumes that stage from the last committed event, so no duplicate PR.

## The house analogy

A claim is the key to one room. Only one key per room can be out at a time, and the key says which attempt took it. The lease is the ring of master keys: whoever holds it can hand out room keys, and has to check in every 10 s or the ring is taken back at 30 s. The generation number is rekeying the locks when the standby takes over: the old kernel still holds a key, but the lock it fits is gone.

## Consequences

- A kernel that dies mid-build costs up to 30 s before the next one can start, unless the first one shut down cleanly, in which case `stop()` hands the lease back and the next one starts at once. Until a standby exists, the supervisor's restart delay (launchd ThrottleInterval 30 s on the Mac, systemd on a server) hides most of that.
- A kernel that loses its lease stops writing and logs one loud error. It does not matter which part notices first: the heartbeat (a refused, failed or late renewal) or a queued task whose own lease check fails (a laptop that slept past the 30 s). Both end in `onLeaseLost`, which fires exactly once, and not at all once `stop()` has begun or a start has failed (addendum of 18 Oct 2026). Jasher's rule is "stop writing at once", so `bulig serve` uses `onLeaseLost`: it logs one clear line, stops the plugins (which ends every running Claude process, the same path as Ctrl-C), and exits non-zero so a supervisor restarts it. The next start resumes from the record. The fence still covers the gap: a report that arrives before the processes are gone bounces off it.
- The fence covers the record. It cannot recall a `git push` or a `gh pr create` already sent. That is why those effects are guarded where they happen (above), and why `gh` answering "already exists" is still handled.
- `finishStage` on a stage that is already finished now rejects. Before, it overwrote the output. No plugin did it on purpose. One pipeline test did, to fake an old record, and now writes the file directly.
- A stage that was running before this change has no claim row. It finishes as it used to, and a restart closes it. There is no backfill, because a backfill would fail on a record that already has two running stages with one name.
- Two kernels on one SQLite file are still kept apart by the file lock (ADR 0001), not by row locks. The lease works on SQLite inside one process and across restarts, but a takeover does not wait for the other process's open transaction, as it does on Postgres. SQLite is for tests and for trying Bulig, so this is accepted.
- Tests: the contract suite runs every lease, claim and event-id case on both adapters. A kernel suite covers the heartbeat, including one that a slow task must not starve. A chaos test kills a kernel mid-build and starts another on the same record, with a kernel that is alive but stalled as the second case, and expects one PR, no lost event, exactly one `stage.requested` per stage attempt, and exactly one `stage.completed` per build attempt that finished.
- SDK `1.0.0-rc.6`. Plugins can now see a rejection named `StageClaimedError` or `StageNotClaimedError` from `startStage` and `finishStage`, and `stage.requested` carries an optional `stageId`.
- Event ids from their cause: decided in the addendum of 18 Oct 2026, below.
- Not decided here: a standby kernel that watches and takes over, wake-ups, and what a plugin does when it learns it lost the lease.

## Known limits

- **Resume compares wall-clock time.** Fixed in the addendum of 18 Oct 2026: it now compares claim generations.
- A non-lease break of the queue (a store call stuck past `storeBrokenMs`) stops writing and now stops the heartbeat, but `serve` does not exit for it. Only a lost lease does. A lost lease ends `serve` whichever path found it: the queue marks the break with the `LeaseLostError` as its `cause`, and the kernel passes that on to `onLeaseLost`, guarded so it fires once.
- **A replay rolls back one queue task, not the whole handler run.** Fixed in the addendum of 19 Oct 2026: a stage open is keyed to the run that made it, and a replay that writes other content into a filled place is logged.

## Assumed (to confirm)

These were outside the three answers above. Each has the cautious default, and each is easy to change.

1. **The holder name is new for each kernel start** (`kernel-<uuid>`), never the host name. A restarted kernel is then never mistaken for the one that died. The cost is the wait above when the first one did not shut down cleanly.
2. **`stop()` hands the lease back** (`releaseLease`, not in the three answers) after the queued work is done, so a clean restart does not wait 30 s.
3. **`start()` waits for another holder's lease to run out**, at most the lease plus 5 s, then fails with `LeaseHeldError`. It does not steal.
4. **Any failed renewal breaks the queue.** A refusal, an error, or an answer that has not come back by the next beat. There is no retry inside the 30 s. One network blip restarts the kernel. The alternative is retrying for a few beats, which keeps a stalled kernel writing for longer.
5. **Every task asserts the lease, reads too.** One extra read per task.
6. **A takeover closes the old stage without an event.** The stage row says failed and interrupted; the log says nothing, because the kernel that took over is not the one that knows why.
7. **Writes with no fence count as generation 0.** The CLI's read-only paths and tests that use a Store directly keep working, and any fenced kernel takes over a claim they left.
8. **Resume leaves alone any running stage whose claim is of this kernel's generation.** (Was: any stage that began after the plugin registered. Replaced in the addendum of 18 Oct 2026.)
9. **A missing `stageId` means the old behaviour** in `worker-claude-code` and `github`, so another pipeline that does not send it still works. It also means a pipeline that forgets it gets no protection.
10. **The Postgres takeover waits at most 10 s** for the old holder's open transactions (`lock_timeout`). After that, `acquireLease` fails and the kernel does not start.
11. **No `claimStage`, `releaseClaim` or `expireClaims` on the Store.** `startStage` and `finishStage` do it in the same transaction, which is what "atomically" asked for. A claim whose job never resumes (a cancelled job whose stage was left running) stays live until something finishes that stage.

## Addendum, 18 Oct 2026: step 1 close-out

### Decided: event ids come from their cause

Until now `bus.record` never passed an id, so the unique index on `events.id` never fired. Now an event written while a handler is handling event E gets the id `sha256(E.id, handler, ordinal, type)`, shaped as a UUID (version 8, so it cannot be mistaken for a random v4).

- **handler** is the plugin's name and the order of the subscription within that plugin (`demo#0`, `demo#1`), so two plugins, or two handlers of one plugin, that react to E and emit the same type get different ids. The order counts within the plugin, not across the bus, so enabling another plugin (or a change in how many handlers another plugin has) does not move this plugin's keys across a restart.
- **ordinal** counts only the events the run has written so far (a job event the kernel writes for a handler's `jobs.create` or `jobs.setStatus` counts too), so a run that emits the same type twice gets two ids. A `plugin.error` for a failing subscriber is not part of the emitting run and takes no ordinal: dispatch leaves the emitter's context before it calls any handler, so the failure path has no cause.
- The run is known from an `AsyncLocalStorage` set around the handler. It is read when the write is asked for, so a continuation inside the handler (an `await`, a timer the handler started) still belongs to that run.
- An event with no cause keeps a random id: `kernel.started`, input from outside the kernel, anything emitted outside a handler. The one exception is the kernel's `plugin.error`, whose id is derived from the event that failed and the subscriber that failed on it, so the same subscriber failing again on the same event (a redelivery) is a duplicate and is dropped, not logged twice. The cost: if the second failure has a different message, only the first is recorded. `bus.emit` takes an optional `id` for a source that has a stable one. No plugin can pass it.
- **A duplicate id means the write is already done.** `appendEvent` still rejects with `DuplicateEventError` (which now carries the event the log holds). The bus turns that into a `ReplayedError`, and the whole task that met it is rolled back: nothing it wrote stays and nothing is delivered. This is the rule for every task, not only for the first event. The call that asked answers as a success: `emit` and `emitCommitted` with the stored event, `jobs.create` with the job the first run made, `jobs.setStatus` with the job as it is now. The handler carries on with the next line.
- Nothing replays events today, so in production this changes no result yet: ids are different and nothing collides. It is the base for a standby that re-delivers an event, and the tests deliver one twice to prove it.
- Plugin-visible: ids of handler-caused events are no longer random. No type changed, so the SDK version is unchanged for this item.

### Decided: resume compares claim generations, not clocks

`pipeline-dev` used to call a running stage "left by an old kernel" when its `startedAt` was not after the moment the plugin registered. With two machines that compares one clock with another. Now the record answers it.

- `Stage.claimGeneration` is the generation under which the attempt's claim was taken, read from the claims table (a join on job, stage and attempt). It stays after the claim is released. A stage from before claims existed has none.
- `ctx.generation` is the generation this kernel holds. The kernel takes the lease before any plugin registers, so it is known by then.
- A running stage is left by an old kernel when `(claimGeneration ?? 0) < ctx.generation`. A stage with no claim counts as old, because every stage started since claims existed has one. A stage of this generation is live work and resume leaves it alone, whatever its `startedAt` says.
- Every kernel start raises the generation by one, so a restarted kernel is always newer than the one it replaces, and a standby that takes over is newer than the kernel that stalled.
- This is a plugin-visible addition, so the SDK is `1.0.0-rc.7`. The conformance suite's fake kernel runs at generation 1, claims the stages it starts under it, and seeds stages as generation 0.

## Assumed (to confirm), added 18 Oct 2026

12. **A replay rolls back the whole task, not only the event.** The alternative (keep the rest of the task, skip the event) would let a replayed `jobs.create` make a second job.
13. **Ordinals depend on the order a handler's emits reach the queue.** A handler that fires emits in parallel without awaiting still gets the same ids on a replay, because the queue keeps call order. A handler whose emits happen in a different order on a second run gets different ids for them and writes them again. That is the safe side: a missed dedup, never a lost event.
14. **channel-telegram does not use `update_id` as an event id.** It would need a way for a plugin to name an id, which is an SDK change, and the channel already saves the offset before it handles an update, so an update is handled at most once. Left alone.

### Decided: three fixes from review

- **A failed start lets go.** If a plugin throws in `register`, or `kernel.started` cannot be written, `start()` stops the heartbeat and hands the lease back before it rejects. Before, the heartbeat renewed a lease nothing was using until the process exited.
- **`stop()` keeps the lease alive until the queue is empty.** The heartbeat is stopped after `queue.idle()`, not before. `bus.idle()` gives up after `stopWaitMs` (default 10000, a new kernel option so a test need not wait 10 s), and work still queued after that used to run with no renewals; a task that started after the lease ran out found it gone, and a clean Ctrl-C printed the lost-lease line and exited 1.
- **No lost-lease exit while ending.** Once `stop()` has begun or a start has failed, `onLeaseLost` is not called. A later `start()` clears that, so a retried start that holds the lease is reported again if it loses it. The log still says the lease was lost, loudly. The process is leaving either way, and a clean stop must not exit non-zero for it.
- **`commit.done` for an existing commit carries `outOfScope`.** A repeated `commit.requested` for a stage attempt that already has a commit used to answer with the sha and base only, so a warn-mode run lost the list that goes into the PR body. It now reads the files the commit holds (`git diff-tree`) and judges them with the same rule as a new commit.

## Assumed (to confirm), added 18 Oct 2026, continued

15. **In enforce mode, a repeated request is refused if the commit it finds holds files outside the scope the request carries** (`commit.failed` with `outOfScope`, as a new commit would be). The alternative is to hand the commit back and report the files, which would let enforce mode pass out-of-scope files. It also means a repeated request without a valid scope is now refused, where before it got the commit back.
16. **A lost lease while stopping is logged but not reported to the owner.** The alternative is to keep exit code 1 for it. A real loss during a clean stop (a rival took over while the queue drained) then exits 0 with the error in the log.
17. **A failed start does not undo what registered.** Plugins that registered before the failure stay subscribed, and the queue keeps its fence, so a late write from one is refused (the lease is gone) and logged, not applied. `serve` exits on the rejected `start()` anyway.

## Addendum, 19 Oct 2026: a replayed run never opens a stage

This closes the known limit "a replay rolls back one queue task, not the whole handler run". It had to be closed before step 4, because the remote worker will redeliver events.

### The problem

A replay (a duplicate derived event id) rolls back the one task that met it. The rest of the handler run goes on. `startStage` is its own task and writes no event, so a replayed run could open a new attempt of a stage, and the `stage.requested` that followed was then dropped as already done. The attempt stayed running with no worker until the next start. A handler that branches on the record could also write other content into a (type, ordinal) slot that was already filled, and that write was dropped without a word.

### Decided: a stage open is keyed to the run that made it

- Inside a handler run, `startStage` takes a key: a hash of the event being handled, the handler, the number of stages this run has opened so far, and the job and stage name. The kernel saves the key and the id of the attempt it opened in the same task, under the plugin name `$kernel` in plugin state. A plugin name is lower-case kebab, so no plugin can read or write that name.
- If the key is already there and the attempt exists, `startStage` hands that attempt back and opens nothing. This holds whether the attempt is still running or has since finished. It also holds when the first run died after opening the stage and before asking for it: the replay is handed the same attempt, and its `stage.requested` is not a duplicate, so it is written and a worker starts. Nothing is left running without a request.
- The count of opened stages is kept apart from the event ordinal, so opening a stage moves no event id. Ids written before this change stay valid.
- A call outside a handler run (the CLI, a test, anything with no cause) has no key and opens a stage as before.
- The kernel is still the only writer, and the key rides in the same transaction as the stage, so the two commit together or not at all. No SDK change: the SDK stays at `1.0.0-rc.7`. No schema change: the stores are untouched, and the record format the copy-over tool (step 4) has to read is unchanged.

### Why not "the rest of a replayed run is a replay"

That was the first idea: once a run meets a duplicate, refuse every later write in it. Two things against it.
- A run only learns it is a replay when an event write meets a duplicate. `startStage` is often the first write of a run, before any event, so the rule would not have seen the case that caused the bug.
- Refusing means throwing, and `pipeline-dev` turns a thrown error in a handler into a failed job. A harmless redelivery would have failed real jobs.

### Decided: other content in a filled place is kept as it was, and logged

If a replayed run emits the same type at the same position with other content (payload or job), the first content stays, because that is what was delivered. It is not written. Before, this was dropped without a word. Now the kernel logs one error line that names the event ("... wrote ... with different content than the first run did, so the first was kept and this was not written"). Events written at a position the first run never used are written, as for any first run: a replay that branches is not blocked from writing what is new. The handler is told the stored event, as for any replay, so it carries on.

### Known limits (what is still true)

- A replay that branches to a different stage name or type opens or writes that new thing. It is new content, and the run cannot tell it from a first run.
- `finishStage` and `setStatus` without a changed status are not keyed. Closing a stage twice, or setting a status twice, ends in the same record.
- One plugin-state row stays per stage open, for the life of the record. It is a few dozen bytes per stage.
- A worker that is handed a request twice still has to refuse the second one. That is the worker's attempt fence, not the kernel's.

## Assumed (to confirm), added 19 Oct 2026

18. **The key is kept in plugin state, not in a new column.** A `cause_key` column on `stages` would be tidier, but it changes the record that the copy-over tool (PR-E) reads, and it needs a migration on both stores. Moving it later is a one-off copy.
19. **A replay that writes other content is logged as an error and not written, not written over the first.** The first content is what the subscribers heard. Overwriting it would make the log say something nobody was told.
20. **The comparison is on payload and job id.** The source is the plugin's name either way, and the type is part of the id. Content that differs only by a lone surrogate or a NUL (the stores rewrite those) may be logged as different when it is not. That costs a log line and nothing else.

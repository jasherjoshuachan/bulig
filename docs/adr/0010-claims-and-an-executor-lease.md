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
- `github` makes one commit per stage attempt. The commit carries a `Bulig-Stage: <stageId>` trailer, and a request whose attempt already has a commit gets that commit back.
- `pipeline-dev` sends `stageId` with `stage.requested` and `commit.requested`, treats `StageClaimedError` as a duplicate and not as a failed job, and on resume leaves alone any running stage that began after this kernel started.

## Jasher's words (18 Oct 2026)

- Claim unit: per job stage. One worker per stage. Stages of different jobs run in parallel.
- Lease: 30 s, heartbeat every 10 s.
- Lost lease: stop writing at once. The next holder resumes that stage from the last committed event, so no duplicate PR.

## The house analogy

A claim is the key to one room. Only one key per room can be out at a time, and the key says which attempt took it. The lease is the ring of master keys: whoever holds it can hand out room keys, and has to check in every 10 s or the ring is taken back at 30 s. The generation number is rekeying the locks when the standby takes over: the old kernel still holds a key, but the lock it fits is gone.

## Consequences

- A kernel that dies mid-build costs up to 30 s before the next one can start, unless the first one shut down cleanly, in which case `stop()` hands the lease back and the next one starts at once. Until a standby exists, systemd's restart delay hides most of that.
- A kernel that loses its lease stops writing and logs one loud error. Jasher's rule is "stop writing at once", so `bulig serve` uses `onLeaseLost`: it logs one clear line, stops the plugins (which ends every running Claude process, the same path as Ctrl-C), and exits non-zero so a supervisor restarts it. The next start resumes from the record. The fence still covers the gap: a report that arrives before the processes are gone bounces off it.
- The fence covers the record. It cannot recall a `git push` or a `gh pr create` already sent. That is why those effects are guarded where they happen (above), and why `gh` answering "already exists" is still handled.
- `finishStage` on a stage that is already finished now rejects. Before, it overwrote the output. No plugin did it on purpose. One pipeline test did, to fake an old record, and now writes the file directly.
- A stage that was running before this change has no claim row. It finishes as it used to, and a restart closes it. There is no backfill, because a backfill would fail on a record that already has two running stages with one name.
- Two kernels on one SQLite file are still kept apart by the file lock (ADR 0001), not by row locks. The lease works on SQLite inside one process and across restarts, but a takeover does not wait for the other process's open transaction, as it does on Postgres. SQLite is for tests and for trying Bulig, so this is accepted.
- Tests: the contract suite runs every lease, claim and event-id case on both adapters. A kernel suite covers the heartbeat, including one that a slow task must not starve. A chaos test kills a kernel mid-build and starts another on the same record, with a kernel that is alive but stalled as the second case, and expects one PR, no lost event, exactly one `stage.requested` per stage attempt, and exactly one `stage.completed` per build attempt that finished.
- SDK `1.0.0-rc.6`. Plugins can now see a rejection named `StageClaimedError` or `StageNotClaimedError` from `startStage` and `finishStage`, and `stage.requested` carries an optional `stageId`.
- Not yet: derive event ids from their cause (the event or stage attempt that led to them) so a handler run twice writes one event. Until then the unique index never fires.
- Not decided here: a standby kernel that watches and takes over, wake-ups, and what a plugin does when it learns it lost the lease.

## Known limits

- **Resume compares wall-clock time.** `pipeline-dev`'s `leftByOldKernel` compares a stage's `startedAt` with `Date.now()` taken when the plugin registered. That is safe on one machine, which is today. Before a second machine runs a kernel (build-order step 4) it must compare claim generations instead, because two machines' clocks can disagree.
- A non-lease break of the queue (a store call stuck past `storeBrokenMs`) stops writing and now stops the heartbeat, but `serve` does not exit for it. Only a lost lease does.

## Assumed (to confirm)

These were outside the three answers above. Each has the cautious default, and each is easy to change.

1. **The holder name is new for each kernel start** (`kernel-<uuid>`), never the host name. A restarted kernel is then never mistaken for the one that died. The cost is the wait above when the first one did not shut down cleanly.
2. **`stop()` hands the lease back** (`releaseLease`, not in the three answers) after the queued work is done, so a clean restart does not wait 30 s.
3. **`start()` waits for another holder's lease to run out**, at most the lease plus 5 s, then fails with `LeaseHeldError`. It does not steal.
4. **Any failed renewal breaks the queue.** A refusal, an error, or an answer that has not come back by the next beat. There is no retry inside the 30 s. One network blip restarts the kernel. The alternative is retrying for a few beats, which keeps a stalled kernel writing for longer.
5. **Every task asserts the lease, reads too.** One extra read per task.
6. **A takeover closes the old stage without an event.** The stage row says failed and interrupted; the log says nothing, because the kernel that took over is not the one that knows why.
7. **Writes with no fence count as generation 0.** The CLI's read-only paths and tests that use a Store directly keep working, and any fenced kernel takes over a claim they left.
8. **Resume leaves alone any running stage that began after the plugin registered.** `pipeline-dev` cannot see claims, and this stands in for "a live claim of this generation".
9. **A missing `stageId` means the old behaviour** in `worker-claude-code` and `github`, so another pipeline that does not send it still works. It also means a pipeline that forgets it gets no protection.
10. **The Postgres takeover waits at most 10 s** for the old holder's open transactions (`lock_timeout`). After that, `acquireLease` fails and the kernel does not start.
11. **No `claimStage`, `releaseClaim` or `expireClaims` on the Store.** `startStage` and `finishStage` do it in the same transaction, which is what "atomically" asked for. A claim whose job never resumes (a cancelled job whose stage was left running) stays live until something finishes that stage.

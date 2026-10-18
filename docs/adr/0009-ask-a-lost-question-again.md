# 0009. A question that never went out is asked again on start, under a new stage

## Context

To ask for an approval, `pipeline-dev` writes three things in order: it opens an `approve-<kind>` stage, sets the job to `awaiting_approval`, and writes `approval.requested`. If the third write is lost, the pipeline fails the job with the reason (ADR 0007, step 2). But if failing the job cannot be written either (the store broke, or the process died between the writes), the job is left waiting on a question nobody was asked. Until now nothing picked it up. It waited until someone found it and ran `/cancel` and `/retry`.

Asking again was held back on purpose. A grant named only `{ jobId, kind }`, so a second card could answer a later question of the same kind. ADR 0008 fixed that: every question carries the id of the stage it opened, and an answer acts only if it names the stage that is open now. So asking again is safe now, as long as the new question cannot be confused with an old one.

Two things had to be decided: how the pipeline knows a question went out, and whether the new question reuses the open stage or opens a new one.

## Decision

On `kernel.started`, for each job in `awaiting_approval` (within the `resume` setting), `pipeline-dev` checks whether the question for its open approval stage was sent. If not, it asks again under a new stage.

- **The pipeline notes each question it sends.** Right after `approval.requested` is written, it saves `asked:<jobId>` = the stage id in its own plugin state. One key per job, overwritten by the next question, so the state grows by one small key per job, not per question. The note is written after the event, never before: a note for a question that was lost would hide it.
- **A lost note does not fail the job.** The question is already out, and the person can answer it. The pipeline logs a warning. The next start then sees no note and asks again, which costs one extra card (below).
- **On start, a waiting job is re-asked when its open approval stage is not the one noted.** The open stage is closed as `failed` with `{ interrupted: true, reason: 'not asked' }`, the job goes back to `running`, and `decide()` runs. It ignores interrupted stages, so it lands on the same approval again, and the normal path opens a new stage, sets `awaiting_approval`, writes `approval.requested` with the new stage id, and notes it. A job whose open stage matches the note is left alone: a normal restart asks nothing.
- **A new stage, not the same one.** Reusing the open stage id would have been simpler, but it is not always safe. When only the note was lost, the first card is real and still on someone's screen. With the same id, two live cards would answer one question, in two chats, and Telegram edits only the card that was tapped. With a new id, the old stage is closed, so the old card names a stage that is not open. Telegram answers it "That approval is no longer open." and the pipeline ignores it if any channel passes it on (ADR 0008). Exactly one card can approve, whichever write was lost. A new stage also means the question is built by the same code that built the first one, from the same record, so the summary, the evidence block and the "last merge was refused" line come out the same.
- **A waiting job with no approval stage open carries on.** That happens when an answer was saved and the status change after it was lost. The job goes back to `running` and `decide()` continues from the answer on record: the next step after a grant, or `cancelled` after a deny. Nothing is asked.
- **A note or stage list that cannot be read leaves the job waiting.** It may well have a live card, and failing it would be worse than one more restart.
- **`resume: false` leaves waiting jobs alone**, as it leaves every other unfinished job. A list of job ids re-asks only those jobs.

## Consequences

- A job no longer waits for ever on a question that was never sent. A restart asks it, once. `plugins/pipeline-dev/test/reask.test.ts` covers a lost question, a lost note, a normal restart, a waiting job with no open stage, `resume: false`, a note that cannot be written, a note or stage list that cannot be read, and replays the lost-note case through the Telegram channel. It was checked by breaking the fix six ways (no re-ask on start, no note, re-ask under the same stage id, a lost note that fails the job, an unreadable note that fails the job, an unreadable stage list that fails the job); each break fails at least one of these tests.
- A job that was waiting when this ships has no note, so the first start after the upgrade asks its question once more, under a new stage. The card already sent expires. For a job waiting on a card from before ADR 0008, which cannot be answered at all, this replaces the `/cancel` and `/retry` that ADR 0008 asked for.
- The re-asked stage stays in the job's stage list as `approve-<kind>: failed` with the reason `not asked`, so `bulig history` shows what happened.
- A channel must not assume an approval stage stays open across a restart. One that answers by stage id, as ADR 0008 requires, needs no change.
- Known gap: Telegram starts polling before `kernel.started`. A tap on the old card that was queued while Bulig was down can be handled before the re-ask closes the old stage. The channel then replies "Approved" and edits the card, but the pipeline ignores the grant as stale and a new card follows. Nothing wrong is approved; the person is told something that did not happen. It only affects a job that is being re-asked. A fix belongs in the channel (re-check the stage after the pipeline acts), in its own change.
- If the event and the note are both written but the process dies before a channel delivers the card, nothing is re-asked: the event is on record and a channel is expected to deliver what is on record. That is a channel's concern, not this ADR's.

# 0008. An approval names the question it answers

## Context

A grant or deny carried only `{ jobId, kind }`. The Telegram buttons were `ap:<jobId>:<kind>` and `dn:<jobId>:<kind>`, and `pipeline-dev` matched a grant to whichever `approve-<kind>` stage was open. So any card still on screen could answer a later question of the same kind.

A review on 18 Oct 2026 showed it with a real run. A job with no origin chat sends its cards to every allowed chat, and Telegram only edits the card that was tapped. The merge was approved in one chat and refused (the PR head moved). The pipeline opened a new `approve-merge` stage, whose card says the last merge was refused. The untouched card in the other chat, from before the refusal, then granted the new stage, and the job merged. The person who tapped it never saw the refusal.

## Decision

Every approval question names its stage, and an answer acts only if it names the stage that is open now.

- **The question carries the stage id.** `approval.requested` has `stageId`: the id of the `approve-*` stage it opened. `pipeline-dev` always sets it.
- **The answer carries it back.** `approval.granted` and `approval.denied` have `stageId`. Channels copy it from the question they showed, never from the job's current stages.
- **The pipeline checks it.** A grant acts only when `stageId` equals the id of the open `approve-<kind>` stage; a deny only when it equals the id of the open approval stage. Anything else is ignored with a warning in the log. A full-id match only, no prefixes: stage ids from one store may share their first characters (the conformance fake numbers them), and a later store might too.
- **Telegram uses a short reference.** Button data is at most 64 bytes, and a job id plus a whole stage id does not fit. The button is `ap:<jobId>:<kind>:<ref>`, where `ref` is the first 12 characters of the base64url SHA-256 of the stage id (58 bytes for a merge card). On a tap the channel finds the open stage, checks that its hash matches, and emits the full id. A hash rather than a prefix, for the reason above. A card whose reference does not match is answered "That approval is no longer open." and marked expired.
- **The terminal names the stage in full.** The terminal channel prints `bulig approve <jobId> <kind> <stageId>` and `bulig deny <jobId> <stageId>`. The CLI requires the stage id, refuses a missing or different one before starting the kernel, and says which stage is open.
- **Answers with no stage id are refused.** A Telegram card sent before this change has no reference. Its taps are treated as expired, and a grant or deny with no `stageId` from any channel changes nothing. This is the safe default: we cannot tell which question an old card belonged to. A job waiting on such a card gets a new answer by `/cancel` and `/retry`, or from the terminal.

## Consequences

- The run above cannot repeat. The stale card is refused by the channel, and a channel that skipped the check would still be refused by the pipeline. `plugins/pipeline-dev/test/stale-card.test.ts` replays it, and fails if either check is removed.
- `stageId` is optional in the payload, so the change adds a field (section 7 of `docs/sdk-v1.md`). But `pipeline-dev` ignores an answer without it, which in practice makes it required for any channel that wants its answers to count. That is allowed while the SDK is a release candidate, and this ADR is the record of it. A third-party channel must now copy `stageId` from the question.
- `bulig approve` and `bulig deny` take one more argument. Scripts that called them with two or one need the stage id, which the question prints.
- A job that was waiting at the upgrade cannot be approved from its old card. Ask the question again (`/cancel`, `/retry`) or approve from the terminal with the stage id from `bulig history`.

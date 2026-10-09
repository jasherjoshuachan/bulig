# gate-promise

A stage that says "I'll follow up" has promised work that nothing will do, unless the same message cites a job that Bulig will run. This plugin finds those promises and marks the ones with no job behind them.

## What it checks

It reads the stage text (the plan, the build report, the review) one sentence at a time. A sentence is a promise when "I" or "we" commits to later work in one of these shapes:

| Shape | Examples |
|---|---|
| follow up, circle back, get back, come back, check back, report back, loop back, revisit, touch base | "I'll follow up", "we will circle back", "I'll get back to you" |
| look or dig into it | "I'll look into this", "we will take a look at that" |
| tell you later | "I'll let you know", "I'll keep you posted", "I'll update you", "I'll ping you" |
| be in touch, be back | "I'll be in touch" |
| "next I will" | "Next I will rewrite the parser", "Next, we'll handle the retries" |
| any "I will ..." with a deferral word (later, tomorrow, tonight, afterwards, next week, in a while, when I get a chance) | "I'll do it tomorrow", "we will fix that next week" |

The patterns are in `src/promises.ts` (`PROMISE_PATTERNS`), one line each.

A sentence is skipped when it is a condition, a question, an offer, a refusal, something already done, or a description of the built-in flow: it has `if`, `unless`, `should`, `would`, `could`, `might`, `may`, `whether`, `want me to`, `let me know`, `not`, `never`, `n't`, `already`, `earlier`, `yesterday`, or it ends in `?`, or it talks about the next stage, a stage by name, the pipeline, an approval card or the pull request. Anything inside a fenced block, in `inline code`, in "double quotes" or in a `>` quote is material, not a statement, and is not read.

A promise passes when the same message cites a job id that is real and live. The gate asks Bulig for its job list and accepts:

- the full id of a job, or the eight-character id that every card prints in brackets
- only if that job is `queued`, `running` or `awaiting_approval` (a job that is done, failed or cancelled will not do anything)
- only if it is not the job whose stage wrote the text (a stage cannot promise itself)
- only if the eight characters name exactly one job

Anything that merely looks like an id (`job 12345678`, `#4242`, an id inside code, one with a hidden character in the middle) is not an id. The model's text never adds a job. One real id in a message covers every promise in that message.

## What happens to a promise with no job id

`mode` decides:

- `warn` (default): the result goes on with `Unfulfilled promise: no job id ("I'll follow up tomorrow.")` in the stage output (`promises`). The plan card and the merge card open with a `PROMISES` block, the PR body gets an `## Unfulfilled promises` section, and Telegram and the terminal print the lines when the stage ends. When an id was cited but did not count, the line says which one and why: `no live job id (deadbeef is not a job)`.
- `enforce`: the stage fails (`stage.failed` with `blocked: true`) and the pipeline fails the job with the reason, for example `test failed: promise gate: Unfulfilled promise: no job id ("I'll circle back later.")`. No PR is opened.

Every line a person sees is flattened to one line, stripped of control and bidi characters, and clipped (100 characters of the sentence, five lines per stage).

## Config

```
"gate-promise": {
  "mode": "warn",
  "enabled": true
}
```

| Setting | Default | |
|---|---|---|
| `mode` | `warn` | `warn` marks, `enforce` fails the stage. Anything else stops the start. |
| `enabled` | `true` | `false` passes every result through unchecked. The plugin stays in the chain, so the pipeline keeps working. To remove it, take it out of `enabled` in the main config. |
| `input` | `stage.completed` | The event it reads. With `gate-evidence` on it is `stage.checked`. The CLI sets it; set it yourself only when you build a kernel by hand. |

It needs no capability. It reads jobs through the same `ctx.jobs` every plugin has.

## Wiring

Plugins never call each other, so the gates sit in the event path, one after the other:

```
worker  --stage.completed-->  gate-evidence  --stage.checked-->  gate-promise  --stage.screened-->  pipeline-dev
                                    \--stage.failed (enforce)-->        \--stage.failed (enforce)-->
```

Alone, `gate-promise` reads `stage.completed` straight from the worker. With `gate-evidence` on, it reads that gate's `stage.checked` and forwards everything on it (the evidence marks included), so one event reaches the pipeline and neither gate drops the other's marks. The order of the two names in `enabled` does not matter. The CLI sets `stageResultEvent: "stage.screened"` on the pipeline and `input: "stage.checked"` on this gate. If you build a kernel yourself, set both, or the gate has no effect (the pipeline logs one warning when it sees a `stage.screened` it is not listening for). `gate-promise` is opt-in: it is not in the default `enabled` list.

## What it cannot catch

- **Meaning.** It matches phrases. "Leave it with me", "this will be handled shortly", "someone should look at that", a promise in another language, or "I'll" written as "I shall" are not on the list or read as no promise.
- **Promises without "I" or "we".** "A follow-up will be sent", "the team will look into it", "this will be revisited" have no subject it knows.
- **Promises in sentences it skips on purpose.** "If you like, I'll follow up" (offer) and "I'll follow up, I already told them" (contains `already`) are skipped. So is any promise in a sentence that also says `pipeline`, `pull request`, `not` or `should`, and any promise inside quotes or code. A model can hide a promise there.
- **A job id that is real but unrelated.** One live job id anywhere in the message passes every promise in it. The gate does not check that the job is about the promise, that it belongs to the same repo, or that it was created by this stage. A model that cites some other queued job gets through.
- **A job that will not be run.** `queued` and `awaiting_approval` are live, but a job waiting for an approval nobody gives is still a promise nothing performs.
- **A command that makes a job.** "Run `bulig run ...` to track this" does not count, because the gate cannot know that anyone will run it. Only an id of a job that exists counts.
- **The message boundary.** It reads one stage's text. A promise made in a PR comment, a channel reply, a commit message or a card the model did not write is out of its sight.
- **False alarms.** "I'll look into it" in a plan that means the build stage will do it, or a note such as "we'll revisit this in the docs" are flagged. In `warn` mode that is one extra line; in `enforce` mode it fails a stage.
- **The model imitating the card.** The model can write a line that looks like `PROMISES` or `Unfulfilled promise` in its own text. That text changes no verdict, and the real block is placed above the model's text on the cards, but a reader skimming a PR body can be fooled.
- **Another plugin lying.** Plugins share one process. A plugin that emits `stage.checked` or `stage.screened` itself can say anything.
- **Old jobs.** Stage output saved before the gate was on has no `promises` and shows no block.

## Tests

`pnpm vitest run plugins/gate-promise` (the patterns, job-id matching, the gate in both modes, hostile text, a full job through the real pipeline with a stand-in worker, and both gates together in either order). `packages/cli/test/gates.test.ts` covers the CLI wiring.

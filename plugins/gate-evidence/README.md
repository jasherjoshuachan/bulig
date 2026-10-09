# gate-evidence

A stage that says "tests pass" or "`src/a.ts` exports multiply" must have a record from the same Claude run that backs it. This plugin checks that and marks what it cannot back.

## What it checks

The worker (`worker-claude-code`) runs Claude with `--output-format stream-json` and builds a list of tool-use records from the stream: each `Read`, `Glob`, `Grep`, `Edit`, `Write` and `Bash` call, its file or command, and whether the tool reported success. That list travels on `stage.completed` as `evidence`. The model's own text is never used to build it.

This plugin reads the stage text, finds claims, and looks for a record of that run behind each one:

| Claim in the text | Backed only by |
|---|---|
| tests pass: "all tests pass", "the suite is green", "12 passed", `verify.sh` passes, or `VERDICT: PASS` on the test stage | a successful `Bash` run that starts with a test runner (`pnpm test`, `npm run test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `node --test`, `scripts/verify.sh`) |
| build is clean: "the typecheck passes", "lint is clean", "compiles without errors", "no type errors" | a successful run of `build`, `typecheck`, `lint`, `check`, `tsc`, `eslint`, `cargo build`, `go build` or `scripts/verify.sh` |
| a file says something: "`src/a.ts` exports X", "`b.json` contains Y", "I read `c.md`" | a `Read` or `Edit` of that file in this run, or a successful command that names it (`cat src/a.ts`) |
| a change was made: "I fixed", "I added", "has been implemented" | a successful `Edit` or `Write` in this run |
| `VERDICT: PASS` on the review stage | a successful `Read`, or a successful `git diff`, `git show` or `git log` |

A command counts only when the runner is the first word of a shell segment (after `cd`, `VAR=1` and `time`). `echo pnpm test`, `cat test.md` and `grep vitest .` are not test runs. A failed run does not back a "pass" claim.

Sentences with a modal, a condition or a purpose (`should`, `will`, `must`, `if`, `make sure`, `ensure`, `to make`, `once`, ...) are skipped, as are sentences that talk about creating a new file, sentences that say something does not pass, and anything inside a code fence. A plan that says "the tests should pass" makes no claim.

Evidence is judged per turn. Each `stage.completed` is a fresh Claude session, so a test run in `test` never backs a sentence in `review`.

## What happens to a claim with no record

`mode` decides:

- `warn` (default): the result goes on, and the stage output carries the unverified lines. The plan card and the merge card start with an `EVIDENCE` block that shows the count of tool calls per stage and lines such as `Unverified: no record of a test run this turn ("All tests pass.")`. The PR body gets an `## Evidence` section with every distinct record and the unverified lines. Telegram and the terminal print the lines when the stage ends. The model's `VERDICT` still counts: the gate marks, it does not judge.
- `enforce`: the stage fails (`stage.failed` with `blocked: true`), and the pipeline fails the job with the reason, for example `test failed: evidence gate: Unverified: no record of a test run this turn ("All tests pass.")`. No PR is opened.

Every line a person sees is flattened to one line, stripped of control and bidi characters, and clipped (160 characters for a record, 100 for a quoted sentence).

## Config

```
"gate-evidence": {
  "mode": "warn",
  "enabled": true,
  "evidenceSources": ["worker-claude-code"]
}
```

| Setting | Default | |
|---|---|---|
| `mode` | `warn` | `warn` marks, `enforce` fails the stage. Anything else stops the start. |
| `enabled` | `true` | `false` passes every result through unchecked. The plugin stays in the chain, so the pipeline keeps working. To remove it, take it out of `enabled` in the main config. |
| `evidenceSources` | `["worker-claude-code"]` | Plugins whose `evidence` counts. A `stage.completed` from any other source is checked as if it had no records, and a warning is logged. |

It needs no capability.

## Wiring

Plugins never call each other, so the gate sits in the event path:

```
worker-claude-code  --stage.completed {result, evidence}-->  gate-evidence  --stage.checked-->  pipeline-dev
                                                                  \--stage.failed (enforce)-->
```

`pipeline-dev` listens to `stage.checked` instead of `stage.completed` when its config says `"stageResultEvent": "stage.checked"`. The CLI sets that for you when `gate-evidence` is in `enabled`. If you build a kernel yourself, set it, or the gate has no effect (the pipeline logs one warning when it sees a `stage.checked` it is not listening for). `gate-evidence` is opt-in: it is not in the default `enabled` list.

## What it cannot catch

- **Meaning.** It matches phrases. "Everything checks out" or "the suite looks healthy" is a claim it does not see. A claim in other words, or in another language, passes as no claim.
- **A real record with the wrong content.** It checks that a test command ran and succeeded, not that it ran the right tests or that the output says what the model says. A passing `pnpm test` backs "the new feature works" only because nothing checks that claim at all.
- **What a file contains.** A file claim is backed by a read of that file, not by what the read returned. "`a.ts` exports foo" passes if `a.ts` was read, even when it does not export foo.
- **Other claims.** Anything not on the list above: "no other callers", "the PR is open", "the API returns 200", claims about git history, numbers, who wrote what.
- **A command that hides the real work.** `node -e "..."` or `pnpm exec x` wrapping a script that fakes success is not a test run, but `pnpm test` that runs a script that exits 0 is. The gate trusts the exit status the tool reported.
- **Sentences it skips on purpose.** A claim in a sentence that also contains `will`, `if`, `should` and so on is skipped, as is a "pass" sentence that also says `not`, `fail` or `without`. "The tests pass, and I will add more" slips through.
- **False alarms.** "The bug has been fixed in v2" (a history note) or "`a.ts` exports foo" about a file the plan means to create are flagged. In `warn` mode that is one extra line; in `enforce` mode it fails a stage.
- **The model imitating the card.** The model can write a line that looks like `EVIDENCE` or `Unverified` in its own text. That text does not change any verdict, and the real block is placed above the model's text on the cards, but a reader skimming a PR body can be fooled by a line they did not notice came from the model.
- **Another plugin lying.** Plugins share one process. A plugin that is listed in `evidenceSources` can emit any records it likes. Only the worker builds records from a real stream.
- **Records from runs that do not stream.** If `claude` prints the older single-object output, there are no records, and every claim is flagged.
- **Events before the gate is on.** Old jobs have no evidence in their stage output, and show no block.

## Tests

`pnpm vitest run plugins/gate-evidence` (claim patterns, matching, the gate in both modes, forged text, and a full job through the real pipeline with a stand-in worker). The worker's stream parsing is tested in `plugins/worker-claude-code/test/worker.test.ts`.

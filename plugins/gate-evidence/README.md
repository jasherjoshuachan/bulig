# gate-evidence

A stage that says "tests pass" or "`src/a.ts` exports multiply" must have a record from the same Claude run that backs it. This plugin checks that and marks what it cannot back.

## What it checks

The worker (`worker-claude-code`) runs Claude with `--output-format stream-json` and builds a list of tool-use records from the stream: each `Read`, `Glob`, `Grep`, `Edit`, `Write` and `Bash` call, its file or command, and whether the tool reported success. That list travels on `stage.completed` as `evidence`. The model's own text is never used to build it. Of a tool's output only two things are kept: whether it was an error, and for a successful `Bash` call the paths in its `diff --git` header lines (`diffPaths`). The gate counts those paths only when every shell segment of the command is `git diff` or `git show` (with `head` or `tail` allowed as a filter). It refuses the forms that can print file or commit-message text at the start of a line: `--word-diff`, `--color-words`, `--output*` (including `--output-indicator-*`), `--line-prefix`, `--src-prefix`, `--dst-prefix`, `--ext-diff`, `--textconv`, `--format`, `--pretty`, a `<rev>:<path>` argument, git's `-c`, any other git command (`git log`, `git cat-file`), a `VAR=` in front of a command, and shell text it does not split (a lone `&`, `$(..)`, backticks, `<(..)`). A command the worker had to cut at 300 characters counts for nothing either.

This plugin reads the stage text, finds claims, and looks for a record of that run behind each one:

| Claim in the text | Backed only by |
|---|---|
| tests pass: "all tests pass", "the suite is green", "12 passed", `verify.sh` passes, or `VERDICT: PASS` on the test stage | a successful `Bash` run that starts with a test runner (`pnpm test`, `npm run test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `node --test`, `scripts/verify.sh`) |
| build is clean: "the typecheck passes", "lint is clean", "compiles without errors", "no type errors" | a successful run of `build`, `typecheck`, `lint`, `check`, `tsc`, `eslint`, `cargo build`, `go build` or `scripts/verify.sh` |
| a file says something: "`src/a.ts` exports X", "`b.json` contains Y", "I read `c.md`" | a `Read` or `Edit` of that file in this run, a successful command that names it (`cat src/a.ts`), or a successful `git diff` or `git show` whose output printed a `diff --git a/<path> b/<path>` header for it (`git diff --stat` prints none, so it does not count) |
| a change was made: "I fixed", "I added", "I edited README.md", "has been implemented" | a successful `Edit` or `Write` in this run |
| `VERDICT: PASS` on the review stage | a successful `Read`, or a successful `git diff`, `git show` or `git log` |

A package import specifier is not a file claim. "`src/chunk.js` re-exports `lodash/chunk.js`" names `src/chunk.js`, a repo file that needs a record, and `lodash/chunk.js`, which an import resolves into `node_modules` and which nobody claimed to have read. The gate cannot see the repo itself, so the worker sends what it read from the worktree's disk after the run, as `repo` on `stage.completed`: the name of every folder and symlink at any depth (outside `node_modules` and `.git`, lowercased) and the `dependencies` and `devDependencies` names of the worktree's own `package.json`. A path in a file claim is skipped as a specifier only when all of these hold:

- it is written bare every time it appears (`lodash/chunk.js`, `@scope/pkg/file.js`); a path with `./`, `../` or `/` in front, or with a `.`, `..` or `node_modules` part, is a path;
- the sentence does not say it read, opened, checked, inspected, reviewed, examined or verified a file ("I read `lodash/chunk.js`" still needs that read);
- its first part is a package name by npm's rules (lowercase, or `@scope/name`) with a file after it (a bare `chart.js` is never skipped: the gate cannot tell it from a repo file);
- no folder or symlink with that first name (`lodash`, or `@scope`) exists anywhere in the worktree, so the path cannot be a repo file (`src/chunk.js` always needs its record, whatever `package.json` says);
- and either the same sentence quotes it in code as `import ... from '<path>'`, `export ... from '<path>'`, `import('<path>')` or `require('<path>')`, or the package is a dependency or devDependency in `package.json`.

The facts count only from a trusted evidence source and only in the exact shape. A stage with no facts (an older worker, a remote worker through `worker-gateway`, a worktree with more than 50,000 entries or 2,000 folder names, a folder it cannot read) is checked as before: every path needs a record. An unreadable `package.json` drops only the dependency signal.

A command counts only when the runner is the first word of a shell segment (after `cd`, `VAR=1` and `time`). `echo pnpm test`, `cat test.md` and `grep vitest .` are not test runs. A failed run does not back a "pass" claim.

Sentences with a modal, a condition or a purpose (`should`, `will`, `must`, `if`, `make sure`, `ensure`, `to make`, `once`, ...) are skipped, as are sentences that talk about creating a new file, sentences that say something does not pass, and anything inside a code fence. A plan that says "the tests should pass" makes no claim.

A sentence that says nothing was changed makes no change claim: "so I added no tests", "I changed nothing", "nothing has been updated", "I did not edit any file". The sentence is cut into clauses at commas, semicolons and words like `but`, `and`, `so`, `then`, `after`, `since`, `because`, `when` and `before`. "I added ..." is a negation only when `no`, `nothing` or `none` follows the verb. "has been changed" is a negation when one of those words, or `not`, `never` or `without`, sits in the four words just before it. So "there were no failures after I fixed it" is still a claim, and so is a negator five words back; the cost is that "No one noticed it has been updated." reads as no claim. A negation in one clause does not hide a claim in another: "I added no tests but edited README.md" still needs a record of an edit.

A few of those words are read in their other sense. A clean report is still a claim: "12 passed, 0 failed", "none failed", "not a single test failed", "passes without warnings" (not "3 failed", not "without running the migration"). "I can confirm all tests pass" is a report, and "once I fixed it" (past tense, after a change verb) is a past event, not a condition ("once I fix it" still skips).

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
| `enabled` | `true` | `false` turns the gate off. With no `enabled` list in the main config it then leaves the default set. If it is listed in `enabled`, it stays in the chain and passes every result through unchecked, so the pipeline keeps working. To remove it, take it out of `enabled`. |
| `evidenceSources` | `["worker-claude-code"]` | Plugins whose `evidence` counts. A `stage.completed` from any other source is checked as if it had no records, and a warning is logged. |

It needs no capability.

## Wiring

Plugins never call each other, so the gate sits in the event path:

```
worker-claude-code  --stage.completed {result, evidence}-->  gate-evidence  --stage.checked-->  pipeline-dev
                                                                  \--stage.failed (enforce)-->
```

`pipeline-dev` listens to `stage.checked` instead of `stage.completed` when its config says `"stageResultEvent": "stage.checked"`. The CLI sets that for you when `gate-evidence` is in `enabled`. If you build a kernel yourself, set it, or the gate has no effect (the pipeline logs one warning when it sees a `stage.checked` it is not listening for). `gate-evidence` is on by default, in `warn` mode: it is in the default `enabled` list, which applies when the main config has no `enabled` of its own. A config that lists `enabled` is used as written.

## What it cannot catch

- **Meaning.** It matches phrases. "Everything checks out" or "the suite looks healthy" is a claim it does not see. A claim in other words, or in another language, passes as no claim.
- **A real record with the wrong content.** It checks that a test command ran and succeeded, not that it ran the right tests or that the output says what the model says. A passing `pnpm test` backs "the new feature works" only because nothing checks that claim at all.
- **A diff too large to read.** A tool result line over 1 MiB is skimmed, not parsed, so a huge `git diff` keeps its ok value but no `diffPaths`, and a claim about a file only that diff showed is still flagged. Headers that git quotes (paths with odd characters) or prints without the `a/` and `b/` prefixes are skipped the same way.
- **A git object that is not a commit.** `git show <blob id>` prints the file as it is, and `git show <tag>` prints an annotated tag's message without indenting it. Neither can be told from a commit by the command alone, so a header-shaped line in that text would count. The model would have to write that line into the file or tag itself.
- **A specifier that is also a file somewhere else.** A path skipped as a specifier is one whose first folder exists nowhere in the worktree, so it cannot name a repo file. It could still name a file outside the worktree, or a package file the stage never opened: "`lodash/chunk.js` exports chunk" passes when lodash is a dependency, read or not. The same holds for a package the stage added to `package.json` itself.
- **What a file contains.** A file claim is backed by a read of that file, not by what the read returned. "`a.ts` exports foo" passes if `a.ts` was read, even when it does not export foo.
- **Other claims.** Anything not on the list above: "no other callers", "the PR is open", "the API returns 200", claims about git history, numbers, who wrote what.
- **A command that hides the real work.** `node -e "..."` or `pnpm exec x` wrapping a script that fakes success is not a test run, but `pnpm test` that runs a script that exits 0 is. The gate trusts the exit status the tool reported.
- **Sentences it skips on purpose.** A claim in a sentence that also contains `will`, `if`, `should` and so on is skipped, as is a "pass" sentence that also says `not`, `fail` or `without` (outside the clean-report phrases above). "The tests pass, and I will add more" slips through, and so does "The tests pass, and you can run them again".
- **False alarms.** "The bug has been fixed in v2" (a history note) or "`a.ts` exports foo" about a file the plan means to create are flagged. In `warn` mode that is one extra line; in `enforce` mode it fails a stage.
- **The model imitating the card.** The model can write a line that looks like `EVIDENCE` or `Unverified` in its own text. That text does not change any verdict, and the real block is placed above the model's text on the cards, but a reader skimming a PR body can be fooled by a line they did not notice came from the model.
- **Another plugin lying.** Plugins share one process. A plugin that is listed in `evidenceSources` can emit any records it likes. Only the worker builds records from a real stream.
- **Records from runs that do not stream.** If `claude` prints the older single-object output, there are no records, and every claim is flagged.
- **Events before the gate is on.** Old jobs have no evidence in their stage output, and show no block.

## Tests

`pnpm vitest run plugins/gate-evidence` (claim patterns, matching, the gate in both modes, forged text, and a full job through the real pipeline with a stand-in worker). The worker's stream parsing is tested in `plugins/worker-claude-code/test/worker.test.ts`.

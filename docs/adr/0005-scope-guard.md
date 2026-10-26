# 0005. The plan declares its scope, and the commit step enforces it

## Context

A job was told "README only". Its test stage ran Playwright, which wrote `test-results/.last-run.json`. The commit step ran `git add -A`, so that file went into the commit. The independent reviewer happened to notice it, and the job failed. Nothing in the pipeline would have stopped it otherwise.

The cause is that "what this job may change" lived only in the issue text and in Claude's judgment. Every stage runs tools that write files, and the commit step took whatever was on disk. A job must never commit a file that the approved plan did not say it would change.

## Decision

The plan names its files, and the commit step refuses everything else.

- **The plan declares its scope.** The plan prompt asks for a final block: the line `SCOPE:` and then one path or glob per line, nothing else on the line. A `- ` in front of each path is optional. The paths are relative to the repo root and cover every file the work will create, edit or delete, test files included. The block goes in the reply itself, not in a plan file or any other file. The prompt, the retry message and this ADR show the same example:

  ```
  SCOPE:
  - README.md
  - src/lib/*.ts
  ```

  The critique prompt checks that the block is there and tight.
- **How the block is read.** The last `SCOPE:` line starts it (bold, quoted or inside a code fence is fine). The lines after it are bullet lines (`- ` or `* ` and the entry) or bare path lines, mixed as you like, either one optionally in backticks. A bare line is a path only when, after trimming and taking off the backticks, it has no spaces or backticks inside, uses only letters, marks and digits of any script and `. _ - / * ? @ + ~ ( ) [ ] { }`, has a letter, digit or wildcard, does not end with a dot, and is not Markdown decoration (`---`, `***`, `**Notes**`). The block ends at the first blank line, a code fence line, or any line that is neither. So a sentence written straight after a bare block ends it and is never read as a path. A path line that breaks the entry rules below (`../x`, `.git/x`, `**`) still fails the whole block. This came from job 3c70469d (25 Oct 2026), whose second plan wrote bare paths inside a code fence while the parser read only bullets.
- **The pipeline stores and shows it.** `pipeline-dev` parses the block when the plan stage finishes and keeps it in that stage's output. The plan approval request carries it as `scope`, and the Telegram and terminal channels list every entry, in full, as "Files this job may change". If the Telegram card is longer than one message, the list goes out in several messages in order and the Approve and Deny buttons are on the last one only. A plan with no usable block (missing, empty, a bad line, or too broad) fails the plan stage. The plan is asked for once more with the reason. If the second plan is also unusable, the job fails. Nothing that edits files runs without an approved scope on record.
- **The commit step enforces it.** Every `commit.requested` carries `scope`, `scopeAllow`, `scopeMode` and `allowBroadScope`. The github plugin lists what a commit would contain (`git status` with untracked files, which honors `.gitignore`, and both ends of a rename) and matches each path against the scope. If every path is covered, it stages exactly those paths by name with `git add -A -- <paths>` and commits. It never runs a bare `git add -A`. If any path is not covered, it commits nothing and emits `commit.failed` with `{ error, outOfScope }`.
- **A refused commit is a failed attempt.** The pipeline hands the list to the build stage ("these files are outside the approved scope; remove them or revert them") and runs again, within the normal `maxBuildAttempts`. When the budget is spent, the job fails and the reason and the Telegram message name the files.
- **The check cannot be talked around by a stage.** It runs in the github plugin, which is outside the Claude sandbox. A stage can only change files on disk, and the files on disk are what is checked. The glob matcher lives in its own small package, `@bulig/scope`, which `pipeline-dev` and `github` both depend on, so reading a scope and enforcing it use the same code. It started in the plugin SDK and moved out in the SDK release candidate (ADR 0006).
- **Scope lines are validated twice**, once in the pipeline and again in the github plugin. Absolute paths, `~`, drive letters, backslashes, control characters, `..`, anything inside `.git`, a line over 200 characters or with more than 32 parts, and a line that is too broad (rule below) are rejected. A scope has at most 100 entries, so the approval card stays readable. `allowBroadScope: true` allows broad lines. A scope line that names a symlink, or a path behind one, is rejected, and a symlink among the changed files is never committed.
- **What "too broad" means.** After tidying (`./` removed, repeated `**` collapsed to one), a line is too broad when any of these holds:
  1. No part of it has a literal character other than dots and wildcards. That catches `**`, `*`, `?`, `*?`, `**/*`, `**/?*`, `?*/**`, `**/*.*`, `*.*` and `.*/**`.
  2. It has more than one part and its first part is not a plain folder or file name, meaning it contains `*` or `?`. That catches `**/*.md`, `**/*.ts`, `**/README.md`, `*/docs/**` and `src*/**`.

  Passing: `README.md`, `.gitignore`, `.github/workflows/ci.yml`, `docs/**`, `src/**/*.ts`, `src/lib/?.ts`, `src/*` and a single-part glob with a real name in it such as `*.md`. The idea is that every line must start from something fixed, so a plan cannot reach the whole repo by wildcard. A project that really wants that sets `allowBroadScope`.
- **The glob syntax is small.** `*` stays inside one folder, `**` crosses folders, `?` is one character. Every other character is literal, so `app/[id]/page.tsx` means that file. A wildcard does not match a name that starts with a dot; to cover `.github/**` the line must say so. Matching uses whole characters and Unicode NFC, with no regular expression. It remembers the pattern and path positions it has tried, so repeated `**` parts cannot make it slow.
- **Config** in `pipeline-dev`: `scopeAlwaysAllow` (globs that are always allowed, default none), `scopeMode` (`enforce`, the default, or `warn`), and `allowBroadScope` (default false). In `warn` mode the commit goes ahead, the files are logged, and the PR body lists them. A bad scope or a symlink is still refused in `warn` mode.

## Consequences

- The incident cannot repeat: a file the test runner leaves behind blocks the commit and names itself, and the build stage is told to remove it. The stage prompts also tell the test and docs stages to delete what they create outside the scope.
- A plan now costs a little more to write, and a plan that forgets a file (a test, a lockfile) makes a build attempt fail. The critique stage is the place to catch that. If it keeps happening for one kind of file, add it to `scopeAlwaysAllow`.
- Jobs that were in flight before this change have no recorded scope. They fail at the next edit stage with a clear reason, and can be started again.
- `commit.requested` has a new required field. A commit request with no scope is refused, so a new pipeline cannot forget it.
- The scope is a list of names. It does not look at file contents, so it cannot tell whether an in-scope file was changed in a harmful way. The independent review still does that.
- A renamed file needs both the old and the new path in the scope.

## In my words (Jasher)

A job never commits a file the approved plan didn't name. That is the one thing this ADR has to guarantee. It came from a real slip: a job told "README only" committed a test runner's leftover file, and only the reviewer's luck caught it.

The check runs in the github plugin, outside Claude's sandbox. A stage can only change files on disk, and the files on disk are what get checked. I want the enforcer to sit outside the thing it enforces.

I can't approve what I can't see. The plan card lists every file the job may change, in full, before any Approve button. Telegram withholds the buttons if the list fails to send, and the terminal prints the list before it asks.

It costs something. A plan that forgets a file makes a build attempt fail, and the critique stage is there to catch that. If one kind of file keeps getting forgotten, it goes into `scopeAlwaysAllow`. I'll take that friction over a smooth path that commits the wrong thing.

`allowBroadScope` and `scopeMode: warn` stay off. I switch them on per project, myself, when I have a reason. A bad scope or a symlink is refused either way.

Scope is a list of names. It can't tell whether a file the plan named was changed in a harmful way. The independent review reads the content. Scope is a fence, not a guarantee that the changes are safe.

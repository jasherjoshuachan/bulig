# 0005. The plan declares its scope, and the commit step enforces it

## Context

A job was told "README only". Its test stage ran Playwright, which wrote `test-results/.last-run.json`. The commit step ran `git add -A`, so that file went into the commit. The independent reviewer happened to notice it, and the job failed. Nothing in the pipeline would have stopped it otherwise.

The cause is that "what this job may change" lived only in the issue text and in Claude's judgment. Every stage runs tools that write files, and the commit step took whatever was on disk. A job must never commit a file that the approved plan did not say it would change.

## Decision

The plan names its files, and the commit step refuses everything else.

- **The plan declares its scope.** The plan prompt asks for a final block: a line `SCOPE:` followed by one path or glob per line, relative to the repo root, covering every file the work will create, edit or delete, test files included. The critique prompt checks that the block is there and tight.
- **The pipeline stores and shows it.** `pipeline-dev` parses the block when the plan stage finishes and keeps it in that stage's output. The plan approval request carries it as `scope`, and the Telegram and terminal channels list it as "Files this job may change". A plan with no usable block (missing, empty, a bad line, or too broad) fails the plan stage. The plan is asked for once more with the reason. If the second plan is also unusable, the job fails. Nothing that edits files runs without an approved scope on record.
- **The commit step enforces it.** Every `commit.requested` carries `scope`, `scopeAllow`, `scopeMode` and `allowBroadScope`. The github plugin lists what a commit would contain (`git status` with untracked files, which honors `.gitignore`, and both ends of a rename) and matches each path against the scope. If every path is covered, it stages exactly those paths by name with `git add -A -- <paths>` and commits. It never runs a bare `git add -A`. If any path is not covered, it commits nothing and emits `commit.failed` with `{ error, outOfScope }`.
- **A refused commit is a failed attempt.** The pipeline hands the list to the build stage ("these files are outside the approved scope; remove them or revert them") and runs again, within the normal `maxBuildAttempts`. When the budget is spent, the job fails and the reason and the Telegram message name the files.
- **The check cannot be talked around by a stage.** It runs in the github plugin, which is outside the Claude sandbox. A stage can only change files on disk, and the files on disk are what is checked. The glob matcher lives in the plugin SDK so reading a scope and enforcing it use the same code.
- **Scope lines are validated twice**, once in the pipeline and again in the github plugin. Absolute paths, `~`, drive letters, backslashes, control characters, `..`, anything inside `.git`, and a line that matches every file (`**`, `*`, `**/*`) are rejected. `allowBroadScope: true` allows the last one. A scope line that names a symlink, or a path behind one, is rejected, and a symlink among the changed files is never committed.
- **The glob syntax is small.** `*` stays inside one folder, `**` crosses folders, `?` is one character. Every other character is literal, so `app/[id]/page.tsx` means that file. A wildcard does not match a name that starts with a dot; to cover `.github/**` the line must say so. Matching uses whole characters and Unicode NFC, with no regular expression, so a bad pattern cannot make it slow.
- **Config** in `pipeline-dev`: `scopeAlwaysAllow` (globs that are always allowed, default none), `scopeMode` (`enforce`, the default, or `warn`), and `allowBroadScope` (default false). In `warn` mode the commit goes ahead, the files are logged, and the PR body lists them. A bad scope or a symlink is still refused in `warn` mode.

## Consequences

- The incident cannot repeat: a file the test runner leaves behind blocks the commit and names itself, and the build stage is told to remove it. The stage prompts also tell the test and docs stages to delete what they create outside the scope.
- A plan now costs a little more to write, and a plan that forgets a file (a test, a lockfile) makes a build attempt fail. The critique stage is the place to catch that. If it keeps happening for one kind of file, add it to `scopeAlwaysAllow`.
- Jobs that were in flight before this change have no recorded scope. They fail at the next edit stage with a clear reason, and can be started again.
- `commit.requested` has a new required field. A commit request with no scope is refused, so a new pipeline cannot forget it.
- The scope is a list of names. It does not look at file contents, so it cannot tell whether an in-scope file was changed in a harmful way. The independent review still does that.
- A renamed file needs both the old and the new path in the scope.

## In my words (Jasher)

_To be written by Jasher before this is tagged._

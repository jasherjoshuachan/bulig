# Bulig

Bulig (Hiligaynon for "help, lend a hand") is a small kernel for agent work on Claude Code. The kernel is tiny and dull on purpose. Every feature is a plugin.

## The LEGO idea

- The kernel is the baseplate. It stays small and rarely changes.
- Each plugin is a brick. Its manifest is the studs: what it provides, what it listens for, what it emits and which capabilities it needs.
- Bricks never call each other. They publish and subscribe to events through the kernel.
- The kernel refuses anything a manifest doesn't declare, so a plugin can't touch what it didn't ask for.
- Add a plugin and the others get more useful without being edited.

## Architecture

```
bulig/ (pnpm workspaces, TypeScript, vitest)
  packages/core        KERNEL: job + stage engine, SQLite single writer, event bus, plugin loader,
                       capability enforcer (a plugin gets only what its manifest declares and the config grants)
  packages/plugin-sdk  THE STUDS: manifest schema (zod), plugin interface, error types
  plugins/
    channel-telegram   chat in and out
    worker-claude-code runs `claude -p` in a git worktree, one fresh session per stage
    github             branches, PRs, checks, merge
    pipeline-dev       plan, critique, build, test, docs, review, approve, merge
    gate-promise       blocks "I'll follow up" without a job ID
    gate-evidence      replies must cite what was read that turn
    memory             lessons that fade, per repo
    live-check         browser check after deploy
    self-diagnosis     one draft fix at a time, never merges
    scorecard          public page of how the system is doing
```

In v0.1 these exist: `packages/core`, `packages/plugin-sdk`, `packages/cli`, and the plugins `channel-cli` (a terminal channel), `channel-telegram`, `worker-claude-code`, `github` and `pipeline-dev`. The others are planned.

## Roadmap

| Version | Ships |
|---|---|
| v0.1 Hands | core (jobs, stages, store, event bus), channel, Claude Code worker, GitHub, dev pipeline |
| v0.2 Trust | receipts, one-use approvals, promise and evidence gates, status/retry/cancel |
| v0.3 SDK v1 | freeze the plugin SDK: manifest, permissions, conformance tests |
| v0.4 Memory | memory plugin, no changes to the others |
| v0.5 Eyes | live check after deploy, revert offer |
| v0.6 Ops pack | private pack on the same SDK |
| v1.0 Growth | self-diagnosis, scorecard, prompt experiments with a promotion gate |
| v2 Crew | multi-machine workers, multi-tenant config |

## Try it

```
pnpm install
bash scripts/verify.sh
```

Needs Node 22 and pnpm 10.

## Run it

You need `claude` (Claude Code, signed in) and `gh` (signed in, with a token that can push and open PRs on the repo) on your PATH.

```
cp bulig.config.example.json bulig.config.json     # then edit it
pnpm bulig run --repo ../my-project --title "Add multiply function" \
  --issue "Add src/multiply.js exporting multiply(a,b) with tests"
pnpm bulig approve <jobId> plan      # after you have read the plan
pnpm bulig approve <jobId> merge     # after you have read the PR
pnpm bulig deny <jobId>              # to stop at either gate
pnpm bulig status [jobId]
pnpm bulig history <jobId>
```

A job id can be shortened to any unique start of it. If a process dies mid-stage, `pnpm bulig resume <jobId>` picks the job up again. The cut-off stage is marked failed with the reason `interrupted`, the job worktree is put back to its last commit (`git reset --hard` and `git clean -fd`, inside that job's worktree only), and the stage runs again. Edit stages end in a commit, so only the work of the stage that was cut off is lost. When Bulig stops, it sends SIGTERM to the Claude sessions it started and SIGKILL to any that are still alive 10 seconds later (`stopGraceMs` in the worker config).

Every Claude stage runs inside Claude Code's own Bash sandbox, switched on with `--settings`. A command a stage runs, and anything that command starts (`node`, `npm`, `pnpm`), can reach only the Anthropic API and the npm registry; GitHub is refused. If the sandbox cannot start (on Linux it needs `bubblewrap` and `socat`), the stage fails rather than running without it. Add more hosts with `allowDomains` in the `worker-claude-code` config (a GitHub host there is ignored). Each stage also gets an empty `GH_CONFIG_DIR` and no git credentials. When a job is cancelled or fails, the Claude process running for that job is stopped first, and its worktree is removed only after that stage has ended. [ADR 0003](docs/adr/0003-capability-manifest.md) lists what the OS enforces and what is only a name.

`run` and `approve` start the kernel, drive the job until it needs you (`awaiting_approval`) or ends (`done`, `failed`), then exit. Everything is saved in SQLite, so the next command carries on from the stored state. Only one Bulig process may use a database at a time; a lock file next to it enforces that.

The config is searched in the current folder (`bulig.config.json`), then `~/.bulig/config.json`. It holds `enabled` (which plugins run), `grants` (what each plugin may do, see [ADR 0003](docs/adr/0003-capability-manifest.md); channels need `approval.grant`, and `pipeline-dev` needs `merge.request` and `jobs.write`), `eventCapabilities` (optional extra rules for which capability an event type needs), `pluginConfig` (per plugin settings) and `dbPath` (default `~/.bulig/bulig.sqlite`). Set `tokenEnv` on the github plugin to the name of an environment variable that holds a GitHub token, for example `BULIG_GH_TOKEN`, and `authorName` and `authorEmail` to the identity the bot signs its commits with (`scripts/serve-with-keychain.sh` loads the token from the Keychain item `bulig-github-bot`). The token is read from the environment only and is never written to a file. A job that fails, is denied or is cancelled has its worktree and local branch removed (the branch on origin is left alone). Set `keepFailedWorktrees: true` in the `pipeline-dev` config to keep them for a look. Plugins can keep a little state of their own between runs; see [ADR 0004](docs/adr/0004-plugin-state.md).

### What one job produces

```
you          bulig run --repo R --title T --issue I
kernel       job.created
pipeline     worktree.requested
github       worktree.ready                      a git worktree at R/.worktrees/<jobId>, on a new branch
pipeline     stage.requested plan (opus, readonly)
worker       stage.completed plan                a fresh claude session
pipeline     stage.requested critique (opus, readonly)
worker       stage.completed critique            another fresh session
pipeline     approval.requested plan             job -> awaiting_approval, the process exits
you          bulig approve <jobId> plan
channel      approval.granted
pipeline     stage.requested build (sonnet, edit)
worker       stage.completed build
pipeline     stage.requested test (sonnet, edit)      ends with VERDICT: PASS or FAIL
worker       stage.completed test
pipeline     stage.requested docs (sonnet, edit)
worker       stage.completed docs
pipeline     commit.requested                    after build, after test, after docs: the work on disk is committed
github       commit.done { sha, base }           the docs commit is the one the reviewer will judge
pipeline     stage.requested review (opus, readonly)  an independent session, ends with a VERDICT
worker       stage.completed review              a FAIL here loops back to build, once. Nothing edits the code after this.
pipeline     pr.requested { expectSha }
github       pr.opened { url, number, headSha }  pushes the branch and opens the PR, but only if HEAD is the reviewed commit
pipeline     approval.requested merge            job -> awaiting_approval, the process exits
you          bulig approve <jobId> merge
channel      approval.granted
pipeline     merge.requested
github       pr.merged                           only if the head is still headSha and no check is red or pending
kernel       job.status done
```

Pending checks are waited for: the github plugin looks again every `checksPollMs` (default 15000) for up to `checksWaitMs` (default 900000, 15 minutes), on the one approval you gave. The wait ends at once if the job is cancelled or fails, or if the plugin stops. A refusal, `merge.refused { reason }`, is kept for things that can pass by themselves, such as a merge call that gh rejected for a passing reason; the pipeline then asks for the merge approval again. Everything else is `merge.failed { reason }` and the job fails instead of asking again: failing checks (the reason names them, and Telegram shows their links), a PR with no checks while `allowNoChecks` is off, checks still pending when the wait runs out, checks that cannot be read after the retries, a PR that is not open, a head that moved after the review, and a merge that gh says has a conflict or that branch protection blocks (policy, missing reviews or required checks). Each gh call is killed after `ghTimeoutMs` (default 120000) and tried again like any temporary failure; cancelling the job or stopping the plugin ends a running call at once. Telegram shows a check link only when it is a plain https URL. Telegram sends the reason for every refusal and every failed merge. If the PR was already merged at the approved commit (a crash after the merge), that counts as done. If it was closed without merging, or merged at a different commit, the job fails too.

## Run it from Telegram

`bulig serve` keeps the kernel running. You start jobs, read progress and tap Approve from your phone. The bot has its own token and only answers chats you list.

1. **Create a bot.** In Telegram, message @BotFather, send `/newbot`, and follow the prompts. Use a new bot for Bulig. Telegram lets only one program poll a bot, so never reuse the token of a bot another program already uses.
2. **Store the token** in the macOS Keychain. The command prompts for it, so it never lands in your shell history:
   ```
   security add-generic-password -s bulig-telegram-bot -a bulig -w
   ```
3. **Get your chat id.** Send any message to your new bot, then run:
   ```
   curl -s "https://api.telegram.org/bot$(security find-generic-password -s bulig-telegram-bot -w)/getUpdates"
   ```
   Find `"chat":{"id":123456789` in the answer. That number is your chat id. (If the answer is empty, send the bot another message and run it again.)
4. **Fill in the config.** In `bulig.config.json`, enable `channel-telegram`, grant it `channel.send:telegram` and `approval.grant`, and set its config. See `bulig.config.example.json`:
   ```
   "channel-telegram": {
     "tokenEnv": "BULIG_TELEGRAM_TOKEN",
     "allowedChatIds": [123456789],
     "allowedUserIds": [123456789],
     "repos": { "my-project": "~/Projects/my-project" }
   }
   ```
   `repos` maps a short name to a folder. `allowedChatIds` is the allowlist: updates from any other chat are dropped without a reply, and a warning with that chat id goes to the log. `allowedUserIds` lists the people who may give commands and tap Approve or Deny. In a group chat, being in the chat is not enough. If you leave it out, anyone in an allowed chat can approve, and a warning says so at start. Your user id is the `"from":{"id":...` number in the same `getUpdates` answer.
5. **Run it.**
   ```
   bash scripts/serve-with-keychain.sh
   ```
   The script reads the token from the Keychain into `BULIG_TELEGRAM_TOKEN` and runs `pnpm bulig serve`. To run without the Keychain, export `BULIG_TELEGRAM_TOKEN` yourself and run `pnpm bulig serve`. To keep it running on a Mac, copy `launchd/dev.bulig.serve.plist.example` and follow the steps at the top of the file.

In the chat:

| Send | What happens |
|---|---|
| `/dev my-project Add multiply function` | Starts a job. Put the issue text on the lines after the title. |
| `/status` or `/status <jobId>` | Lists recent jobs, or shows one. |
| `/history <jobId>` | The stages of a job with times. |
| `/cancel <jobId>` | Stops a job. A Claude that is running for it is stopped (SIGTERM, then SIGKILL after the grace period), and the worktree is removed only after that. |
| `/help` | The list above. |

When a job needs you, the bot sends the plan or the PR with **Approve** and **Deny** buttons. Tapping one edits the message to show the decision. A button for an approval that is no longer open answers "expired" and does nothing. A job id can be shortened to any unique start of it.

Only one Bulig process may use a database, so stop `serve` before you use `bulig run` or `bulig approve`. When `serve` stops (Ctrl-C or SIGTERM) it exits cleanly, and the next start picks up unfinished jobs. The bot remembers its place in your chat in the database, so a restart does not replay old commands. If Telegram limits the bot, it waits as long as Telegram asks; on network errors it backs off and tries again.

## License

MIT. See [LICENSE](LICENSE).

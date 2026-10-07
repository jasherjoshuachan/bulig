# 0003. A capability manifest, granted by config

## Context

A plugin that can run `claude`, push to GitHub or write to a chat is powerful. If every plugin could do everything, one bad or buggy plugin could push code, spend money or message people it should never touch. We also want to read a config file and know, in one place, what each plugin is allowed to do.

## Decision

Every plugin manifest has a `needs` list of capabilities, written as `area.action` or `area.action:scope`, for example `git.push`, `gh.pr`, `claude.run` or `channel.send:terminal`. Declaring a need does not give it. The config has a `grants` section that lists, per plugin name, the capabilities that plugin may use. The kernel gives a plugin the intersection: what it declared and what the config granted. A plugin calls `require("claude.run")` before it does the thing, and the call throws `CapabilityDeniedError` if the capability is missing. The message says whether it was not declared or declared but not granted. A scoped capability matches exactly, so `channel.send:terminal` does not cover `channel.send:chat`.

The four plugins in v0.1 use it like this. The worker needs `claude.run` and `fs.worktree`. The github plugin needs `git.push` and `gh.pr`. The terminal channel needs `channel.send:terminal`. The pipeline needs nothing, because it only emits events and moves jobs through their stages. Each plugin checks its needs when it registers, so a config that forgets a grant fails at start with a clear message, not halfway through a job.

Some events are powerful enough that saying them needs a capability too. The kernel keeps a map from event type to the capability required to emit it, and the bus enforces it when a plugin emits. The defaults are `approval.granted` and `approval.denied` (both need `approval.grant`) and `merge.requested` (needs `merge.request`). Listing the event in `emits` is not enough. The plugin must also declare the capability in `needs` and the config must grant it, or the emit throws `CapabilityDeniedError` and nothing is written to the log. Anyone may listen to these events. Only the channels (a person taps approve) and the pipeline (it asks for the merge) get these grants in the example config. A plugin that should not be able to approve its own work, such as a worker or a github plugin, gets neither. Emitting the approval event is only half of an approval, though: the pipeline closes the approval stage and moves the job on by writing to the job store. So the job writes that decide an outcome need a capability too, `jobs.write`: finishing or opening an `approve-` stage, setting a job to `done`, `failed` or `cancelled`, and moving a job out of `awaiting_approval`. The kernel hands each plugin a wrapped job API and refuses those calls without the capability. Only `pipeline-dev` is granted it in the example config. A channel that wants to stop a job emits `cancel.requested` and the pipeline ends the job. Reading jobs and running ordinary stages stay open. The map is configurable: `eventCapabilities` in the config adds rules or changes a default, and is merged over the kernel's defaults.

## What is enforced by the OS, and what is only names

Be exact about the two:

- **Names only (the kernel).** Capabilities, `needs`, `grants`, the event map and `jobs.write` are checks that the kernel makes inside one Node process. They stop a plugin that goes through the plugin API. A plugin is ordinary code in the same process, so it can import `node:child_process`, read files or open sockets without asking. Nothing here sandboxes it. Treat plugins as code you trust, or review before enabling.
- **Names only (the tool list).** The worker passes Claude an allowed list and a deny list (`Bash(git push*)`, `Bash(gh *)`, `Bash(curl *)`). Those are patterns on the command text. `node -e "..."`, `npm run x` or `pnpm exec x` is allowed so tests can run, and a program started that way can do anything the user can, including call `gh` or `git` with the ambient login. The deny list does not stop that.
- **Enforced by the OS (the Claude sandbox).** Every Claude stage, read-only or edit, starts with Claude Code's own Bash sandbox switched on through `--settings` (Seatbelt on macOS, bubblewrap on Linux). It wraps every Bash command and every process that command starts, so `node`, `npm` and `pnpm` are inside it. Network goes through a proxy with `strictAllowlist`: only `api.anthropic.com` and `registry.npmjs.org` (plus any `allowDomains` in the worker config, never a GitHub host) are reachable, and `github.com`, `*.github.com` and `*.githubusercontent.com` are also listed as denied. `allowUnsandboxedCommands` is false, `excludedCommands` is empty and `failIfUnavailable` is true, so Claude cannot retry a command outside the sandbox and refuses to run if the sandbox cannot start. Reads of `~/.config/gh`, `~/.ssh`, `~/.git-credentials`, `~/.netrc` and the git config files are denied.
- **Environment, not OS.** The child also gets a fresh empty `GH_CONFIG_DIR`, no global or system git config, no credential helper, no askpass and no ssh agent. `HOME` stays because Claude needs it to log in. This is a plain environment, so a program that sets its own environment or reads the signed-in state from some other place is not stopped by it. The sandbox is what holds the line.
- **Not covered by the sandbox.** Claude's built-in file tools (Read, Edit, Write) and the Claude process itself run outside it and follow permission rules. The Bulig process, the github plugin and the other plugins run with the user's full access, and the github plugin is the only one meant to push.

Checked live: with the real `claude` (haiku) in a throwaway repo whose origin is a private repo, an edit stage asked to run `gh auth status` and `git ls-remote origin` through `node -e` found no signed-in gh and no route to GitHub, while the same prompt with the sandbox and environment hardening off listed the signed-in accounts and the remote refs.

## Consequences

- One file shows what every plugin may do. Reviewing a config is reviewing the blast radius.
- A new plugin can ship with a long `needs` list and still do nothing until someone grants it.
- Capabilities are names, not sandboxes. The kernel trusts a plugin to call `require` before acting, and a plugin that ignores the API can still run code in the process. Real plugin isolation (separate processes, no shared filesystem) is a later step. The one OS boundary today is the Claude sandbox around stage commands, described above.
- Checking at register time means a missing grant stops the whole start. That is on purpose, but it also means one misconfigured plugin blocks the rest until it is fixed or disabled.
- A plugin that goes through the plugin API cannot approve work, end a job or open a merge request unless it was granted `approval.grant`, `jobs.write` or `merge.request`. That holds for a buggy or careless plugin. It does not hold against a plugin that is deliberately hostile, because that plugin shares the process and the database file (see the first bullet above).
- Scopes keep room to grant narrowly later, such as one chat or one repo, without changing the manifest format.

## In my words (Jasher)

_To be written by Jasher before v0.1 is tagged._

# 0003. A capability manifest, granted by config

## Context

A plugin that can run `claude`, push to GitHub or write to a chat is powerful. If every plugin could do everything, one bad or buggy plugin could push code, spend money or message people it should never touch. We also want to read a config file and know, in one place, what each plugin is allowed to do.

## Decision

Every plugin manifest has a `needs` list of capabilities, written as `area.action` or `area.action:scope`, for example `git.push`, `gh.pr`, `claude.run` or `channel.send:terminal`. Declaring a need does not give it. The config has a `grants` section that lists, per plugin name, the capabilities that plugin may use. The kernel gives a plugin the intersection: what it declared and what the config granted. A plugin calls `require("claude.run")` before it does the thing, and the call throws `CapabilityDeniedError` if the capability is missing. The message says whether it was not declared or declared but not granted. A scoped capability matches exactly, so `channel.send:terminal` does not cover `channel.send:chat`.

The four plugins in v0.1 use it like this. The worker needs `claude.run` and `fs.worktree`. The github plugin needs `git.push` and `gh.pr`. The terminal channel needs `channel.send:terminal`. The pipeline needs nothing, because it only emits events and moves jobs through their stages. Each plugin checks its needs when it registers, so a config that forgets a grant fails at start with a clear message, not halfway through a job.

Some events are powerful enough that saying them needs a capability too. The kernel keeps a map from event type to the capability required to emit it, and the bus enforces it when a plugin emits. The defaults are `approval.granted` and `approval.denied` (both need `approval.grant`) and `merge.requested` (needs `merge.request`). Listing the event in `emits` is not enough. The plugin must also declare the capability in `needs` and the config must grant it, or the emit throws `CapabilityDeniedError` and nothing is written to the log. Anyone may listen to these events. Only the channels (a person taps approve) and the pipeline (it asks for the merge) get these grants in the example config. A plugin that should not be able to approve its own work, such as a worker or a github plugin, gets neither. The map is configurable: `eventCapabilities` in the config adds rules or changes a default, and is merged over the kernel's defaults.

## Consequences

- One file shows what every plugin may do. Reviewing a config is reviewing the blast radius.
- A new plugin can ship with a long `needs` list and still do nothing until someone grants it.
- Capabilities are names, not sandboxes. The kernel trusts a plugin to call `require` before acting. Real isolation (separate processes, no shared filesystem) is a later step.
- Checking at register time means a missing grant stops the whole start. That is on purpose, but it also means one misconfigured plugin blocks the rest until it is fixed or disabled.
- Approvals and merge requests cannot come from a plugin that was not granted them, so one compromised or buggy plugin cannot approve its own pull request.
- Scopes keep room to grant narrowly later, such as one chat or one repo, without changing the manifest format.

## In my words (Jasher)

_To be written by Jasher before v0.1 is tagged._

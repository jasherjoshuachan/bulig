# worker-gateway

The endpoint a worker on another machine talks to (ADR 0011). The kernel is still the only writer: a worker never sees the database. It asks for a stage, says it is alive, and hands back what Claude did. This plugin turns that into the same events the in-process worker sends, so the pipeline cannot tell the difference.

Off by default. Enable it for `bulig serve` only: `"enabled": [..., "worker-gateway"]`, grant it `net.listen`, `git.apply` and `fs.worktree`, and give each worker a token. With it off, nothing changes.

## Config (`pluginConfig["worker-gateway"]`)

| key | default | meaning |
|---|---|---|
| `listen` | `["127.0.0.1"]` | Addresses to bind: IP literals only. `0.0.0.0` and `::` are refused at start. Use the Tailscale address to take a Mac. |
| `port` | `7431` | One port for every address. |
| `workers` | none | `{ "<id>": { tokenEnv, tokenFile, credential, slots, projects } }`. A token comes from a `credential` (a file in `$CREDENTIALS_DIRECTORY` with `id=token` lines, as systemd `LoadCredential=` makes), a `tokenFile` (one token, owner-readable only), or the variable `tokenEnv` names. A file wins over the variable. |
| `localSlots` | `2` | Stages the in-process worker may run at once. `0` sends everything to remote workers. |
| `workerSlots` | `2` | Default cap per remote worker. |
| `claimWaitMs` | `25000` | How long a claim is held open before it answers `204`. |
| `heartbeatMs` / `heartbeatTimeoutMs` | `10000` / `30000` | Workers beat every `heartbeatMs`. Silent for `heartbeatTimeoutMs` and the stage is taken back. |
| `maxPatchBytes` | 8 MiB | Largest patch either way. |

## Protocol

JSON over HTTP, `Authorization: Bearer <token>` on every call. A missing or wrong token gets `401` with no body, whatever the path.

- `POST /claim {workerId, slots, projects?}` is held open up to `claimWaitMs`. `200` returns `{jobId, stageId, attempt, generation, heartbeatMs, request:{stage, prompt, model, mode}, workspace:{repo, base, patch?}}`; `204` means nothing yet.
- `POST /heartbeat {stageId, attempt, generation}` every `heartbeatMs`. `200`, or `409` if the stage is no longer this worker's.
- `POST /result {stageId, attempt, generation, outcome: "completed"|"failed", output, patch?}`. `200` once written. `409` if stale. A repeat of an accepted result answers `200 {duplicate: true}`.

`409` means: stop, throw the work away, ask again. The kernel checks the stage is still running, as the same attempt, under the same lease generation, held by that worker.

## Code travels as a patch

`workspace.base` is the commit the job branch grew from (it is on the remote), and `workspace.patch` is everything the job holds on top of it. The worker checks out `base` from its own clone, applies the patch, runs Claude, and returns what changed as a patch. The kernel applies it to the job folder (refusing symlinks and anything under `.git`) and the github plugin commits it under the approved scope, as for the in-process worker. A worker never commits or pushes.

## Scheduling

Stages go to the in-process worker while it has a free slot, then to remote workers. One queue, oldest first, so each project is first come, first served. One lane per job folder. Each worker holds at most its slot cap.

A worker silent for `heartbeatTimeoutMs` loses the stage: its attempt is closed as interrupted (`worker-lost`), the next attempt is opened and offered again, once. A second loss fails the stage. The duplicate-PR guards of ADR 0010 stay as the backstop.

## A kernel that runs no Claude itself

Leave `worker-claude-code` out of `enabled`. The kernel then has no local slots (the gateway acts as `localSlots: 0`, whatever the config says), and every stage goes to a `bulig worker`. On the server the worker can run as another unix user in its own unit, so the database URL and the GitHub token are never where Claude can read them. The kernel needs nothing from the worker's folders: code travels as patches (above), so no file is shared between the two users.

## Running a worker

```bash
scripts/worker-with-keychain.sh mac --kernel http://100.x.y.z:7431 --repo /srv/bulig/repo=$HOME/Projects/repo
```

Flags: `--token-env <VAR>` or `--token-file <path>` (a systemd credential; owner-readable only), `--claude-token-file <path>` (becomes `CLAUDE_CODE_OAUTH_TOKEN` in Claude's environment only), `--work-dir <dir>` (where stage folders are made; created with the process's umask and never chmod-ed, so a unit with `UMask=0002` makes them group-writable), `--slots`, and one `--repo <kernelPath>=<localClone>` per repository.

`bulig worker` refuses plain `http` to anything that is not this machine or Tailscale. Claude gets an allowlisted environment (PATH, HOME, LANG, TERM, TMPDIR and its own login variables), so the worker's token, the database URL and the GitHub and Telegram tokens never reach it.

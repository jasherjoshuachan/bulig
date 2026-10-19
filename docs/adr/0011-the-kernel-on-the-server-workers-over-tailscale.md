# 0011. The kernel on the server, workers over Tailscale

## Context

Steps 1 and 2 of the build order are done. The record can be Postgres (ADR 0007), a stage has one owner at a time (ADR 0010), and the kernel runs today on the Mac under launchd. Step 4 moves the kernel to ths-prod-01 and lets more than one machine do the work. Step 5 turns the gates from warnings into refusals.

Four things are true today and shape the choices below.

- **The kernel and its worker are one process.** `worker-claude-code` runs inside `bulig serve`, so a stage can only be built on the machine the kernel is on. A second machine has nothing to talk to.
- **ths-prod-01 is shared.** Client production runs there: several Postgres clusters on other ports (5432 is Postgres 16) and many other units. It has 8 CPUs and about 15 GB of RAM, of which about 8 GB is free. Bulig must not be able to slow any of it down, and a Bulig mistake must not be able to reach any of it.
- **The gates only warn.** `gate-evidence` and `gate-promise` run with `mode: "warn"`. Nothing counts the verdicts, so nobody can say whether turning them on would have blocked a good job.
- **ADR 0010 left a known limit.** A replayed run can open a new stage attempt, and nothing replays events yet. Redelivery (a worker that lost its stage, a standby) makes it real.

## Decision

### Where it runs

One kernel runs on ths-prod-01 as a systemd unit, `bulig.service`, as its own unix user `bulig`. Claude workers run in a second unit, `bulig-worker.service`, as a different unix user, `bulig-worker`. The kernel unit runs with its in-process local worker disabled. The worker unit runs `bulig worker` against the kernel gateway on `127.0.0.1:7431`, exactly as the Mac worker does over Tailscale, so the VPS worker is just another worker that happens to be local. The kernel's record is a Postgres 16 cluster made for Bulig, on port 5436 (free when checked on 19 Oct 2026; the setup step refuses to continue if it is taken), bound to `127.0.0.1`, with its own role and database. No existing cluster, unit or file is touched. The Mac keeps its own kernel and its SQLite file until the cutover, and the two run side by side without sharing anything.

Both units are boxed so client production cannot feel them. The worker unit, which runs every Claude session and their children (node test workers, git, `gh`), carries `MemoryMax=3G`, `CPUQuota=250%` (two and a half of the eight CPUs) and `TasksMax=512` (it counts threads, and two Claude sessions running node test workers can pass 256). The kernel unit has its own, lower caps, which the deploy kit sets (assumed, see the list at the end), because it no longer starts Claude. Both use the hardening set already used by the credential broker unit (`NoNewPrivileges`, `ProtectSystem=strict` with named `ReadWritePaths`, `PrivateTmp`, `PrivateDevices`, kernel and cgroup protections, a restricted address family list). The release layout is `/opt/bulig/releases/<sha>` with a `current` symlink, and a deploy swaps the link. The kernel user's home is `/var/lib/bulig`. The worker user, `bulig-worker`, has its own home, `/var/lib/bulig-worker`, which holds the Claude login (`~/.claude*`), git config and its clones in `work/`, and it is listed in that unit's `ReadWritePaths`. Neither unit uses `ProtectHome` to hide its home, because the broker has no home to protect and Bulig does.

Code does not live in a folder both users share. The kernel's repositories and worktrees are under `/var/lib/bulig/repos`, owned by `bulig`, mode `0750`, and the kernel unit runs with `UMask=0077`. The worker's clones are under `/var/lib/bulig-worker/work`, owned by `bulig-worker`, mode `0700`. Neither user can read the other's tree. A stage's code crosses only as a patch: the worker edits in its own clone and sends a patch to the kernel over the gateway (in the `result` call), and the kernel applies it in its own worktree, then commits and pushes as `bulig`. There is no shared group and no shared work folder. `bulig-worker` cannot read `/etc/bulig` or the kernel's credentials, and `bulig` cannot read the worker's Claude login.

The kernel checks every patch before it touches a worktree. It refuses a patch that contains a symlink, a gitlink (submodule), a path into `.git` or a path outside the tree. It applies an accepted patch with hooks and `fsmonitor` off.

**The kernel's git never runs what a worker planted.** The patch path is the main control. This is the second layer, kept as defense in depth, because a mistake in the patch check or a later change must not hand the worker a way to run code as `bulig`. A hook or repo config such as `core.hooksPath`, `core.fsmonitor` or a credential helper, if it ever reached a kernel worktree, would run as `bulig` next to the kernel's credentials. So this ADR decides the following, built by a separate PR ("The kernel's git never runs hooks or config a worker planted in a worktree"):

- Every kernel git call runs with hooks disabled (`core.hooksPath=/dev/null`) and the dangerous config keys overridden on the command line: `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`, `diff.external`, `credential.helper` and `gpg.program`.
- The kernel's git reads no system or global config. It reads a minimal config owned by the kernel (`bulig`).
- The kernel refuses a worktree whose repo config contains any of those keys, or any `include` or `includeIf`.
- The main repository's `.git` directory is owned by `bulig` and no worker user can write to it. Hooks and repo config live there, out of the worker's reach.

### Workers talk to the kernel over HTTP and JSON

The kernel serves a small worker endpoint. It binds to `127.0.0.1` and to the VPS's Tailscale address, and never to `0.0.0.0`. The port is 7431 (assumed). The Mac worker reaches the Tailscale address. The VPS worker uses `127.0.0.1`. No port is opened on the public interface, and the firewall is not changed.

The worker logic stays in `worker-claude-code`. A new `bulig worker` command runs it against a kernel URL instead of in-process, so one code path builds stages on both machines.

### Auth: one bearer token per worker

Each worker has its own token (long, random, made on the machine that owns it). On the Mac the token lives in the macOS Keychain and reaches the process through the wrapper script, as today. On the VPS every secret is a separate root-only file loaded with systemd `LoadCredential=`, and each unit carries only its own. The kernel unit, `bulig.service`, carries `pg-url`, `gh-token` and `worker-tokens`. The worker unit, `bulig-worker.service`, carries `claude-token` and its own worker token, and nothing else. Each process reads its files from its own `$CREDENTIALS_DIRECTORY`. `EnvironmentFile` carries only non-secret settings. Credentials loaded this way stay out of the environment, `ps` and the journal (target spec section 9, rule 5: no secrets in the environment).

What this does not do on its own is hide a secret from another process running as the same unix user. A process running as that user can read the unit's `$CREDENTIALS_DIRECTORY` files and `/proc/<pid>/environ`. A security review of the deploy kit proved this, and it is why the worker is a separate user. With two users, and with the patch path and the git hardening described under Where it runs in place, a Claude session (which runs as `bulig-worker`) cannot read the kernel's credentials: not the Postgres URL, the GitHub token or the other workers' tokens. Without them the claim would be false: a worker that could write into the kernel's worktree could plant a git hook that the kernel then runs as `bulig`. A session can read only what its own unit carries, which is the Claude token and its own worker token. The worker also starts Claude with an explicit allowlisted environment (`PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, the Claude auth variable and the git variables it needs), never the whole environment of the worker process.

On the Mac the worker runs as Jasher's own user. There the isolation is the allowlisted environment only, and a Claude session there can in principle read anything Jasher's user can read. This is a known limit (see below). The kernel compares tokens in constant time, maps a token to a worker id, and refuses everything else with the same answer whatever was wrong. Tokens are never logged, never put in a URL, and never put in the repo. A leaked token is revoked by removing its line from `worker-tokens` and restarting the kernel. Tailscale ACLs and tags come on top, but the token is the control that does not depend on them.

### The protocol

Four calls. All of them are plain requests that a worker repeats safely.

1. **`claim(workerId, slots)`**: a long poll (25 s, assumed). The worker says how many free slots it has. The kernel answers with one stage assignment or an empty answer. An assignment carries the job, the stage, the prompt and scope the stage needs, and a fence made of the claim attempt (ADR 0010) and the lease generation.
2. **`heartbeat`**: every 10 s while a stage runs, naming the stage and the fence. The kernel answers whether the worker still holds the stage.
3. **`result`**: the worker posts the outcome and what it produced, with the fence. Code comes as a patch, which the kernel checks and applies in its own worktree (see Where it runs). The kernel writes through the same `finishStage` as today.
4. **Nothing else.** There is no call for a worker to read the record or write an event.

Losing a stage. The worker's hold on a stage is a lease of 30 s, renewed by its heartbeat, like the executor lease in ADR 0010. If the kernel sees no heartbeat for 30 s, it releases the claim (reason `worker-lost`), closes that attempt as failed and interrupted, and offers the stage again as the next attempt to any worker with a free slot. A stage is resumed once this way. A second loss on the same stage goes to BLOCKED, and Jasher is told. A late `result` or `heartbeat` from the first worker carries an old attempt, so it bounces off the fence (`StageNotClaimedError`) and is dropped.

No duplicate PR comes from the guards ADR 0010 already put where the effects happen: the commit carries a `Bulig-Stage` trailer, a repeated request for an attempt that has a commit gets that commit back, and `gh` answering "already exists" is handled. A killed worker is a chaos test: kill it mid-stage, expect the stage to be resumed once, one PR.

### Slots and order

- The VPS worker has 2 slots. The Mac worker has 2 slots (assumed).
- One code-writing lane per worktree. Two stages never share a worktree.
- Per project, stages are taken first in, first out.
- A free slot on the VPS is offered the stage first. The Mac worker gets a stage only when the VPS slots are full or the VPS worker is not connected. So the VPS goes first and the Mac joins, as Jasher asked.

### Replays never open a stage

The known limit in ADR 0010 is closed by a separate change (the replay fix) that lands before the worker protocol is used. A replayed run must not open a stage: a stage open is tied to the event that caused it, so a repeat finds the stage it already opened. Without this, a worker that loses its stage could leave an attempt running with nobody on it. It is a prerequisite, not a part of this ADR's code.

### Copy-over of the old record

A one-off command, `bulig migrate sqlite-to-postgres --from <file> --to-env <VAR> [--dry-run]`, copies the Mac's SQLite record into the VPS cluster: jobs, stages, claims, events (ids and sequence numbers kept), plugin state and the lease.

- The dry run reads everything and writes nothing. It prints counts per table.
- The real run refuses a target that is not empty.
- After the copy it compares counts and a checksum per table, and fails loudly on any difference.
- The Postgres URL comes from an environment variable and must name its host explicitly. A URL with no host is refused.
- The SQLite file stays on the Mac, untouched, as the backup. The copy is read-only against it.

### Cutover is a separate yes

Running the VPS kernel in parallel is inside the yes Jasher gave, and so are the `bulig-worker` user and `bulig-worker.service`, which he added to the list on 19 Oct 2026 (see the dated addition under Jasher's words). Moving real work to it is not. At cutover, Telegram moves to the VPS and the Mac `serve` stops. Two kernels must never poll one bot, because Telegram refuses the second `getUpdates` and a message can go to the wrong one. So the VPS kernel starts with `channel-telegram` disabled, and it is turned on only when the Mac's is turned off, in that order, with Jasher's yes for that step. Until then the VPS is proven with synthetic jobs through the command line.

### Backups

A systemd timer runs `pg_dump` of the Bulig database every night and uploads it to R2, then checks that the object exists (a head-object check) and that its size is not zero. At backup time it also writes the dump's sha256 to a local index. A restore drill restores the latest dump into a scratch database with `pg_restore`, as a non-superuser role, and only if the dump's sha256 is in that local index. A dump that is not in the index is refused, so a file planted in the bucket is never restored. The drill checks counts every week, so a drill always runs inside the 7-day soak, and the time it took is written down each time. The scorecard asks for exactly that number (section 13 of the target spec). A backup that was never restored is not counted as a backup.

### Step 5: eyes, then enforce

Each gate verdict is recorded: job, stage, verdict and the PR head SHA it was about. A `bulig gates status` command shows the days since the soak began, the real jobs seen, the warnings given, and any warning Jasher marked false with `bulig gates mark-false <event>`.

The bar is **7 days and 10 real jobs with zero false warnings**. A real job is one that ran the full pipeline on a real repo, not a synthetic or sandbox job. The clock starts at deploy, with an explicit `bulig gates soak start` run on the VPS kernel and recorded as an event, so the start time is a fact in the record and not a guess. Jobs that ran on the Mac kernel do not count. When the bar is met, Jasher looks at the record and flips both gates with `bulig gates enforce`. The command refuses before the bar is met unless `--force` is given, and it changes config only. Nobody and nothing flips it on his behalf.

## Jasher's words (19 Oct 2026)

- **Server yes, fixed list.** I may create a `bulig` unix user and a new Postgres 16 cluster on its own port. The existing clusters stay untouched. I may also add a systemd unit with CPU and memory caps and an R2 backup timer, and run Bulig on the VPS in parallel with the Mac. Cutover (Telegram moving to the VPS) waits for him.
- **Workers: both, VPS first.** A worker on the VPS takes jobs by default. The Mac worker joins over Tailscale. One job lane per worktree, with a slot cap on each machine.
- **Old record: copy it over.** One-off SQLite to Postgres copy, with a dry run and a count check first. The SQLite file stays on the Mac as a backup.
- **Enforce bar: 7 days and 10 real jobs with zero false warnings, then he flips it** with one command after I show him the record.

**Addition, 19 Oct 2026 (after the deploy kit security review).** Jasher extended the server yes list to include a second unix user, `bulig-worker`, and a second systemd unit, `bulig-worker.service`. (The design first also named a shared group, `bulig-work`. It is no longer needed, because code crosses as a patch, so the design makes fewer changes than he approved.) This is a later addition to the four answers above. It does not change them.

## The house analogy

We are moving the household into a flat in a shared building. Other families live there too, and some of them are paying clients, so the first rule is that we do not make noise in their rooms. The kernel is the landlord of our flat: it holds the book of who is in which room and keeps it safe. The workers are the people who do the work in the rooms. The VPS worker lives in the flat. The Mac worker comes over from next door by a private corridor (Tailscale), shows its own pass (the token), and works in a room the landlord gave it. If someone stops answering the landlord's knock for 30 seconds, the landlord takes back the key and gives the room to someone else, once. The gates are the house rules. Today they are notices on the wall. After a clean week they become locked doors, and only Jasher turns that key.

## Consequences

- Bulig gets a second home with its own users, cluster and limits. If it misbehaves, it hits its own ceiling (the worker unit, where Claude runs, is capped at 3 GB and 2.5 CPUs) and not the neighbours.
- Two units and two users cost one more thing to deploy and a patch check to keep right. In return, with the patch path and the git hardening in place, the process that runs Claude cannot read the kernel's credentials.
- A worker is one more thing that can die, and that is now a normal event: the stage is resumed once on another worker, and a second failure asks a human.
- The worker endpoint is a new door. It is closed to the public interface by binding, and closed to the tailnet by a token on top of ACLs. Anyone with the Tailscale address and no token gets a refusal.
- The Mac keeps working as it does today until cutover. Nothing on the Mac changes in the meantime except that it can also run a worker.
- The long poll holds a connection open per idle worker. With two workers this is nothing. It would need a second look with dozens.
- Two kernels exist for a while (Mac and VPS), each with its own record. This is safe only because they share nothing and only one has Telegram.
- SQLite stays the default for tests and for trying Bulig. The new command and the protocol have tests on both stores.
- Gate verdicts become data, so "is it safe to enforce" becomes a count and not a feeling.

## Known limits

- **One kernel, no standby.** If ths-prod-01 is down, Bulig is down until systemd or Jasher brings it back. The nightly dump covers disaster recovery, and the drill says how long that takes. A standby is a later step (target spec section 6).
- **Tailscale has no tags or ACLs for Bulig yet.** Both machines are on the tailnet with no tags. Until tags and ACLs are set in the admin console (only Jasher can), the token is the only gate on the worker endpoint.
- **On the Mac, the worker runs as Jasher's own user.** Isolation there is the allowlisted environment only. A Claude session on the Mac can read what Jasher's user can read. The VPS split into two users does not apply to the Mac.
- **The `bulig-worker` user has no Claude login.** Sessions on the VPS need a token made with `claude setup-token`, which is interactive and is Jasher's to do. It is stored as the `claude-token` credential file of the worker unit. Until then the VPS worker cannot run real stages, and the Mac worker takes everything.
- **Claude usage is shared.** Bulig jobs and the other jobs on the server draw on the same Claude quota. The slot caps limit how much Bulig can use at once. They do not cap how much it uses over a day.
- **A kernel crash costs up to 30 s,** as in ADR 0010, and a worker lost mid-stage costs the lease (30 s) plus the stage's work so far, because the second attempt starts the stage again.
- **A worker that is alive but cut off from the kernel keeps running its Claude session** until its next heartbeat is refused. The fence stops its result from being written. It cannot recall a `git push` already sent, which is why the guards sit at the effect.
- **Anything else the kernel runs inside a worktree must follow the same rule.** Today only git does. A new command that runs in a kernel worktree as `bulig` (a build step, a formatter, a hook runner) would execute code from an accepted patch, so it needs the same treatment (no inherited config, nothing a patch can redirect) or it must run as `bulig-worker`.
- **Output is posted at the end of a stage, not streamed.** Progress lines come later.

## Not yet

- **The usage cap and the visible cost meter** (target spec section 3, row 5). The protocol carries nothing about cost today, and a cap needs the worker to report tokens. Left for a later ADR. The slot caps are the only limit for now.
- A standby kernel.
- **An R2 token scoped to `bulig/`.** Until Jasher issues one, the backup key is shared with other personal services.
- **A separate user for the Mac worker.** It runs as Jasher's own user for now.
- Wake-ups through `LISTEN/NOTIFY`. Workers poll by long poll.
- More than two workers, or workers on other machines.
- Moving Telegram. That is the cutover.
- A dashboard for the soak record. `bulig gates status` is the only view.

## Assumed (to confirm)

These were outside Jasher's four answers. Each has the cautious default and is easy to change.

1. **Port 7431** for the worker endpoint, and **5436** for the cluster, 5436 was free on 19 Oct 2026 and the setup step refuses if it is taken. 7431 is checked the same way.
2. **Long poll of 25 s** for `claim`.
3. **Mac worker has 2 slots,** the same as the VPS worker.
4. **One resume, then BLOCKED.** A stage lost twice goes to a human and not to a third worker. The alternative is more retries, which risks burning quota on a stage that kills every worker.
5. **`TasksMax=512`.** Chosen to hold a few Claude sessions and their children, not measured. This ADR owns the number, and the deploy kit copies it.
6. **Backup restore drill weekly** (this ADR owns the cadence, and the deploy kit copies it), and the nightly dump at a quiet hour. Retention of the dumps (30 days, assumed) is a setting.
7. **R2 credentials come from an existing Keychain or VPS item if one covers Bulig.** If none does, Jasher is asked for them. Nothing is created in his name without his yes.
8. **A real job for the soak** means the full pipeline on a real repo. Sandbox and synthetic jobs do not count, even though they run on the same machine.
9. **The soak clock starts at deploy,** with an explicit `bulig gates soak start` recorded as an event. Only real jobs on the VPS kernel count toward the 10, and jobs that run on the Mac kernel before cutover do not count.
10. **`--force` on `bulig gates enforce`** exists as an escape hatch, and it is Jasher's to use. The alternative is no escape hatch at all.
11. **Tailscale tags and ACLs** are set by Jasher in the admin console when he is ready. The design does not wait for them.
12. **Workers are told apart by token only.** The worker id in `claim` is a label and is checked against the token's own id. A worker cannot claim as another.
13. **Kernel unit caps after the split.** The kernel no longer starts Claude, so its `MemoryMax` and `CPUQuota` can be lower than the 4G and 300% that the single unit had when it also ran Claude. The deploy kit (PR #48) builds the units and sets the kernel number, and it is not measured. The worker unit's `MemoryMax=3G`, `CPUQuota=250%` and `TasksMax=512` are this ADR's.
14. **The R2 bucket key is shared with other personal services** until Jasher issues an R2 token scoped to `bulig/`. Until then a Bulig bug or a leaked Bulig credential can reach the other services' objects, and the sha256 index is the guard on what a drill restores. Issuing the scoped token is Jasher's, and it is not yet done.

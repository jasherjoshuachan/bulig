# Running Bulig on ths-prod-01 (ADR 0011)

## The invariant

> **Root never creates, writes, chmods, chowns or deletes any path whose parent directory (at any level) is owned by or writable by `bulig` or `bulig-worker`.**
> Everything root manages lives under root-owned parents: `/etc/bulig` (root 0700), `/usr/local/lib/bulig` (root 0755), `/var/backups/bulig` (root 0700), `/var/lib/bulig-checks` (root 0700), `/opt/bulig` (root 0755).
> Per-user state is created only by systemd (`StateDirectory=`).

Why: a user that owns a folder can swap a link into it, or rename it, at the moment a root script looks at it, and root then writes, chmods or chowns somewhere else. The first deploy kit (PR #48) lost four review rounds to that one class of bug. This kit removes the class instead of patching its cases.

How it is kept:
- `/var/lib/bulig` and `/var/lib/bulig-worker` are the users' homes **and** their `StateDirectory=` (mode 0700). The users are made with `--no-create-home`; systemd makes and owns the folders when a unit starts. No script knows these paths except to refuse them.
- The repos (`/var/lib/bulig/repos`) and the worker's clones (`/var/lib/bulig-worker/work`) are made by the processes themselves, as their own user.
- The kernel's config is a root-owned file, `/etc/bulig/config.json`, handed to the kernel with `LoadCredential=config:` (the kernel reads `$CREDENTIALS_DIRECTORY/config` first, PR #50). Nothing is written into a home.
- Dependency installs run as a throwaway user (`DynamicUser=yes`) in a transient unit whose private `/var/tmp` systemd deletes. The source goes in on stdin and a tar of `node_modules` comes out on stdout. Root never enters a folder that user wrote to.
- Setup scripts refuse to run while any process of either user exists (`pgrep -u`), refuse a link where a root folder belongs, and use `chown -h`. `need_dir` refuses any path inside a user's folder and, as real root, any path whose parents are not root's or are writable by group or others.
- `deploy/test/invariant.sh` parses every script root runs and every unit file and fails the build if one writes, chmods, chowns, removes, installs, copies, moves, links or redirects into either folder (after expanding variables), or runs a recursive write on a parent, or uses `chown` without `-h`, or makes a home, or has a root-privileged `ExecStartPre=`. It runs in `scripts/verify.sh`. It reads text, so `release.sh` and `setup.sh` in the same folder also run the real scripts against fake user folders and check that nothing in them changes.

## What runs where

Bulig runs on the same host as client production. It gets its own two users, its own Postgres cluster (`16 bulig`, port 5436), two systemd units with CPU and memory caps, and its own folders. The snapshot taken by `precheck.sh` and compared by `postcheck.sh` shows that nothing else it lists has changed (clusters, services, timers, unit files, ports, containers, users and groups, cron, and the mode of a few top folders; it says nothing about what it does not list).

- `bulig` runs the kernel (`bulig.service`). Credentials: `config`, `pg-url`, `gh-token`, `worker-tokens`. No Claude token.
- `bulig-worker` runs the worker (`bulig-worker.service`), which runs Claude Code. Credentials: `claude-token`, `worker-token`. No config, no database URL, no GitHub token.
- The two share no folder and no group. The worker has its own clone of a repo and sends the kernel a patch; the kernel applies it in its own worktree (ADR 0011, PR #50). Both homes are 0700.

| What | Path | Made by |
|---|---|---|
| Kernel home, state, repos, worktrees | `/var/lib/bulig` | systemd (`StateDirectory=bulig`), then the kernel |
| Worker home, Claude settings, clones, stage folders | `/var/lib/bulig-worker` | systemd (`StateDirectory=bulig-worker`), then the worker |
| Node code, one folder per release | `/opt/bulig/releases/<sha>`, `/opt/bulig/current` | `release-remote.sh` (root) |
| Root scripts and unit files, one folder per release | `/usr/local/lib/bulig/<sha>`, `/usr/local/lib/bulig/current` | `release-remote.sh` (root) |
| Secrets and the kernel config | `/etc/bulig/` (pg-url, gh-token, worker-tokens, claude-token, worker-token, drill-pw, backup.env, config.json, worker.env) | `set-secret.sh`, `setup-cluster.sh`, `release-remote.sh` (root) |
| Dumps before and after R2, and the index of what was backed up | `/var/backups/bulig` | the backup (root) |
| Snapshots and release work areas | `/var/lib/bulig-checks` | root |
| Units | `/etc/systemd/system/bulig*` | `release-remote.sh` |

Tools must be in system folders (`/usr/bin`, `/usr/local/bin`): neither user has a `~/.local`, and the build runs as a throwaway user. On the host today: node 22, pnpm, git, gh, claude and docker are in `/usr/bin`; there is no `aws` (the pinned aws-cli image is used).

**This kit depends on PR #50** (the remote worker): the kernel reading `$CREDENTIALS_DIRECTORY/config` first, `urlCredential`, the `worker-gateway` plugin, and `bulig worker`. Release a build that contains #50, or `bulig.service` and `bulig-worker.service` will not start.

## Steps

Stop at the first failure and read the message: every script says what it refused and why. Run the scripts as root on the server, from the Mac with `ssh`.

1. **Precheck.** The "before" picture. Read-only. The release is not on the server yet, so copy the kit into the root-owned checks folder first (delete `kit/` after step 5, when the release carries the same files):
   ```bash
   ssh ths-prod-01 'mkdir -p -m 0700 /var/lib/bulig-checks' && rsync -az deploy/ ths-prod-01:/var/lib/bulig-checks/kit/ && ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/precheck.sh'
   ```

2. **Users and root folders.** Makes the two users with no home, and `/opt/bulig`, `/usr/local/lib/bulig`, `/etc/bulig`, `/var/backups/bulig`, `/var/lib/bulig-checks`. It makes nothing for the users: systemd does that at the first start. It refuses while any process of either user exists, so on a rerun stop the services first (`systemctl stop bulig-worker bulig`).
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-user.sh'
   ```
   Read its tool lists. If `node`, `pnpm`, `git`, `gh` (bulig) or `node`, `git`, `claude` (bulig-worker) shows MISSING, install it under `/usr/local` or `/usr`.

3. **Postgres cluster.** Creates `16 bulig` on 5436, the role `bulig` and database `bulig`, a second role `bulig_drill` (can create databases and nothing else; used only by the restore drill), and writes the connection URL (explicit host and port) into `/etc/bulig/pg-url`. It refuses if 5436 is used by anything else, or by something that is not Postgres, and (like step 2) while a Bulig process exists.
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-cluster.sh'
   ```

4. **Secrets and settings.** Each value goes in over stdin, so it never shows in a shell history or `ps`.
   - GitHub bot token (from the Mac Keychain):
     ```bash
     security find-generic-password -s bulig-github-bot -w | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential gh-token'
     ```
   - The VPS worker's token. One command writes the worker's own `worker-token` and its `vps=` line in the kernel's `worker-tokens`:
     ```bash
     openssl rand -hex 32 | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --worker-token vps'
     ```
   - Which repositories the worker may work on (not secret; it needs at least one; kernel path under `/var/lib/bulig/repos`, clone under `/var/lib/bulig-worker/work`):
     ```bash
     echo 'BULIG_WORKER_REPOS=--repo /var/lib/bulig/repos/sandbox=/var/lib/bulig-worker/work/sandbox' | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --worker-env'
     ```
   - Claude token (Jasher only, interactive). It runs as `bulig-worker` in a transient unit, so systemd makes the home the login settings go to. Copy the token it prints, then:
     ```bash
     ssh -t ths-prod-01 'bash /var/lib/bulig-checks/kit/bulig-cli.sh --as worker --tty --exec claude setup-token'
     pbpaste | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential claude-token'
     ```

5. **Release.** From the Mac, inside the bulig checkout, with a ref that contains PR #50:
   ```bash
   bash deploy/release.sh <ref>
   ```
   It streams `git archive` of the ref over ssh into a fresh root-owned folder (`/var/lib/bulig-checks/incoming.XXXXXX`) and runs `deploy/release-remote.sh` from inside it, as root. That script:
   1. builds `node_modules` as a throwaway user (`DynamicUser=yes`, private `/tmp` and `/var/tmp`, `KillMode=control-group`, capped). The source goes in on stdin; a tar comes out on stdout;
   2. unpacks the tar as root in a second sandbox that can write one empty folder only, with no network and no capabilities;
   3. refuses it if it holds anything but files, folders and links, a hard link, a set-id file, a file outside `node_modules`, a `node_modules` where the release has no folder, or a link that leaves the release (absolute, or climbing past the root, or with `..` after a name);
   4. builds the final tree from a fresh copy of the delivered code plus those `node_modules` folders (nothing else from the build is kept, so a build script cannot change a delivered file) and installs it as `/opt/bulig/releases/<sha>`;
   5. installs `deploy/` as `/usr/local/lib/bulig/<sha>` (the scripts root runs and the unit files, root-owned);
   6. swaps both `current` links, installs the unit files, creates `/etc/bulig/config.json` from the template **only if it is missing** (root, 0600; never overwritten), restarts both services, and runs `health.sh`. Any failure puts back both links and the unit files. It refuses a sha that is already live (exit 3).

6. **Health.** Run it any time. It checks both services, and reads the lease twice, 11 seconds apart.
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/health.sh'
   ssh ths-prod-01 'systemctl show bulig.service bulig-worker.service -p Id -p User -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p StateDirectory'
   ```

7. **Repos.** The kernel and the worker each make their own clone, as their own user, inside their own folder (`git clone` makes the missing parent folders as that user; root makes none). For a public sandbox repo:
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec git clone https://github.com/<owner>/sandbox /var/lib/bulig/repos/sandbox'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as worker --exec git clone https://github.com/<owner>/sandbox /var/lib/bulig-worker/work/sandbox'
   ssh ths-prod-01 'systemctl restart bulig-worker'
   ```
   Assumed (to confirm in the server phase): a private repo needs a credential helper for the clone; that is a kernel-side detail, not a root write.

8. **Copy over the old record** (PR-E, `bulig migrate sqlite-to-postgres`). Dry run first, then the real copy. Stop the kernel first (only one writer), run the command in a capped transient unit, start the kernel again, run `health.sh`:
   ```bash
   ssh ths-prod-01 'systemctl stop bulig.service && /usr/local/lib/bulig/current/bulig-cli.sh migrate sqlite-to-postgres --from <file> --to-env BULIG_PG_URL --dry-run'
   ```
   (How PR-E names the target is its own detail. `bulig-cli.sh` runs as user `bulig` with the kernel's credentials.)

9. **Synthetic jobs.** One on the VPS worker, one on the Mac worker over Tailscale. Exactly one PR each, on the sandbox repo. Jobs run through the two services; one-off commands go through `bulig-cli.sh`. For the Mac worker, add its token (`set-secret.sh --worker-token mac`), add the Tailscale address to `listen` in `/etc/bulig/config.json` (root edit), and restart `bulig.service`.

10. **Backup.** Fill the R2 settings, one name at a time, then run one backup by hand and look for the `bulig-backup: ok` line:
    ```bash
    printf '%s' "$R2_ENDPOINT" | ssh ths-prod-01 'bash /usr/local/lib/bulig/current/set-secret.sh --backup-key R2_ENDPOINT'
    ```
    (repeat for `R2_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`; names in `backup.env.example`)
    ```bash
    ssh ths-prod-01 'systemctl start bulig-backup.service && journalctl -u bulig-backup.service -n 5 --no-pager'
    ssh ths-prod-01 'systemctl enable --now bulig-backup.timer bulig-restore-drill.timer'
    ```
    **R2 key (Jasher):** the first run can use the shared bucket key that already exists, but it should be replaced with an R2 token limited to the `bulig/` prefix of the bucket. Only Jasher can create it (Cloudflare dashboard). Restore is safe either way: the drill restores only an object whose sha256 is in the root-owned local index (`/var/backups/bulig/index`), and restores it with `pg_restore` as a role that owns only its scratch database, so a swapped or planted object in R2 is refused or harmless. The R2 key reaches the aws-cli container on stdin, never in its arguments or environment.

11. **Restore drill.** Takes the newest entry of the local index, downloads it, checks the sha256, restores it into a scratch database in the bulig cluster as the `bulig_drill` role, compares tables and row counts with the live database, logs the time, drops the scratch database. It fails if the newest backup is more than 48 hours old. Look for `bulig-restore-drill: ok ... restore_seconds=N`.
    ```bash
    ssh ths-prod-01 'systemctl start bulig-restore-drill.service && journalctl -u bulig-restore-drill.service -n 5 --no-pager'
    ```

12. **Postcheck.** The "after" picture. It must say the snapshot is identical to the precheck (apart from Bulig's own things).
    ```bash
    ssh ths-prod-01 '/usr/local/lib/bulig/current/postcheck.sh'
    ```
    A diff of unrelated services that started or stopped on their own (a nightly job) needs a human read: check it is not Bulig's doing before calling it noise, and add the pattern to `SNAPSHOT_NOISE` in `lib/snapshot.sh` if it is.

## Footprint on ths-prod-01

Everything this kit adds or changes (nothing else is touched):

- Users and groups: `bulig`, `bulig-worker` (system users, `--no-create-home`, nologin).
- Units: `bulig.service`, `bulig-worker.service`, `bulig-backup.service` and `.timer`, `bulig-restore-drill.service` and `.timer` in `/etc/systemd/system`. Short-lived transient units `bulig-build-*`, `bulig-extract-*`, `bulig-cli-*` while a release or a command runs.
- Folders: `/opt/bulig`, `/usr/local/lib/bulig`, `/etc/bulig`, `/var/backups/bulig`, `/var/lib/bulig-checks` (all root), and `/var/lib/bulig`, `/var/lib/bulig-worker` (made by systemd).
- Postgres: cluster `16 bulig` on 127.0.0.1:5436, roles `bulig` and `bulig_drill`, database `bulig`. The existing clusters (5432 and the others) are not touched.
- Ports: 5436 (Postgres) and 7431 (the worker gateway) on 127.0.0.1; the Tailscale address is added at the Mac-worker step. Nothing on a public interface.

## Cutover (Jasher only)

Not part of the steps above, and nobody runs it without his yes. Moving Telegram means two things happen in a fixed order, because two kernels must never poll one bot (Telegram answers the second `getUpdates` with a conflict).

1. Stop the Mac: `launchctl bootout gui/$(id -u)/dev.bulig.serve`.
2. Put the bot token on the server as a credential for the kernel only: add `telegram-token` to `BULIG_CREDENTIALS` in `lib/common.sh` and `LoadCredential=telegram-token:/etc/bulig/telegram-token` to `bulig.service` (a reviewed change, then `release.sh`), then `security find-generic-password -s bulig-telegram-bot -w | ssh ths-prod-01 'bash /usr/local/lib/bulig/current/set-secret.sh --credential telegram-token'`.
3. In `/etc/bulig/config.json` (root) add `"channel-telegram"` to `enabled`, add its grants and its `pluginConfig` block (`allowedChatIds`, `allowedUserIds`, `repos`; copy the shape from `bulig.config.example.json`).
4. `systemctl restart bulig` and run `health.sh`.
5. Send a message to the bot and watch `journalctl -u bulig -f`.

To undo: remove `channel-telegram` from `enabled`, restart, then start the Mac serve again (`launchctl bootstrap ...`). The Mac's SQLite file is still the copy it was before the move, so going back loses anything done on the VPS since cutover; decide that first.

## Rollback

- **A bad release.** `release-remote.sh` already rolls back by itself when the health check fails (links, units). To go back by hand:
  ```bash
  ssh ths-prod-01 'ls -1t /opt/bulig/releases'
  bash deploy/release.sh <older-sha>
  ```
- **Stop Bulig, leave everything else alone.** `systemctl stop bulig-worker bulig`. The cluster keeps running. Jobs resume on the next start.
- **Remove Bulig completely.** Only with Jasher's yes, and in this order: `systemctl disable --now bulig-worker bulig bulig-backup.timer bulig-restore-drill.timer`, remove `/etc/systemd/system/bulig*`, `systemctl daemon-reload`, `pg_dropcluster 16 bulig --stop`, then `userdel bulig`, `userdel bulig-worker`, then `/opt/bulig`, `/etc/bulig`, `/usr/local/lib/bulig`, `/var/lib/bulig`, `/var/lib/bulig-worker`, `/var/backups/bulig`, `/var/lib/bulig-checks` (after the last `postcheck.sh`). Run `postcheck.sh`; it should show nothing changed from the precheck.
- **Restore the database from R2.** The restore drill is the rehearsal. For a real restore: `systemctl stop bulig-worker bulig`, take the newest dump (a custom-format `.dump` under `bulig/postgres/`; check its sha256 against `/var/backups/bulig/index`), create an empty database as `bulig`, `pg_restore --no-owner --role=bulig -h 127.0.0.1 -p 5436 -U bulig -d <db> <dump>`, point the config at it, start the services.

## Things to know

- **Gaps in the kernel that the units cannot paper over (checked against PR #50's head):** the GitHub plugin reads its token only from the environment variable named by `tokenEnv`, not from the `gh-token` credential. Until it can read `$CREDENTIALS_DIRECTORY/gh-token` (the same way `urlCredential` works for the database), the `github` plugin will not start on the server. The unit does not put the token in the environment to get round it: that would undo "no secrets in the environment".
- Both services are `Restart=always`. A lost lease makes `serve` exit non-zero and systemd starts it again within 5 seconds.
- `bulig serve` refuses to start with no channel, so the VPS config enables `channel-cli` and leaves `channel-telegram` out. The config also leaves `worker-claude-code` out of `enabled`: the kernel has no in-process worker here, all work goes through `bulig-worker`.
- `/opt/bulig` is read-only to both services on purpose. A release is built and checked by root and never handed to a Bulig user.
- The kernel unit's caps (1G, 100%, 256 tasks) are assumed in ADR 0011 (item 13), not measured. The worker's (3G, 250%, 512) are the ADR's.
- With no `aws` CLI the R2 calls go through a docker container (image pinned by digest) fed by stdin and stdout: no host mount, and the R2 key travels on stdin, never in docker's arguments or environment.
- Passfiles and downloads live in a 0700 folder under `/var/lib/bulig-checks` (root's), never in the host's `/tmp`, also when you run a script by hand.
- Everything uses a Postgres connection with an explicit host (`127.0.0.1`) and port, and passwords travel in a private PGPASSFILE, never on a command line (any user on this host can read other processes' arguments).

# Running Bulig on ths-prod-01 (ADR 0011)

Bulig runs on the same host as client production. It gets its own two users, its own Postgres cluster (`16 bulig`, port 5436), two
systemd units with CPU and memory caps, and its own folders. The snapshot taken by `precheck.sh` and compared by `postcheck.sh` shows
that nothing else it lists has changed (it lists clusters, services, timers, unit files, ports, containers, users and groups, cron, and
the mode of a few top folders; it says nothing about what it does not list).

The two users, and why:
- `bulig` runs the kernel (`bulig.service`). It holds the database URL, the GitHub token and the table of worker tokens.
- `bulig-worker` runs the worker (`bulig-worker.service`), which runs Claude Code and the commands Claude runs. It holds the Claude token
  and its own worker token, and nothing else. It cannot read `/etc/bulig` or the kernel's credentials, because it is a different user.
- `bulig-work` is a group both belong to, for `/var/lib/bulig/work`: the worker edits worktrees there and the kernel commits them.

| What | Path |
|---|---|
| Code, one folder per release | `/opt/bulig/releases/<sha>`, with `/opt/bulig/current` pointing at the live one (root-owned, read-only to both services) |
| Secrets, one file each | `/etc/bulig/pg-url`, `gh-token`, `worker-tokens`, `claude-token`, `worker-token`, `drill-pw` (root, 0600). systemd hands each unit only its own through `LoadCredential=` (`credentials.example`) |
| R2 settings | `/etc/bulig/backup.env` (root, 0600), loaded by the backup units only |
| Kernel config | `/var/lib/bulig/.bulig/config.json` (root owns it, `bulig` can read it) |
| Repos, clones and worktrees | `/var/lib/bulig/work` (group `bulig-work`, setgid, both units run with umask 0002) |
| The worker's home (Claude sign-in) | `/var/lib/bulig-worker` |
| Dumps waiting for R2, and the index of checksums | `/var/backups/bulig` (root). The index (`/var/backups/bulig/index`) lists every dump this host made with its sha256 |
| Before and after snapshots | `/var/lib/bulig-checks` (root) |

Run every script on the server as root. The Mac only runs `release.sh`. No script takes a free-form path: they write only to the fixed
places above and refuse anything else. Files in `deploy/`: `setup-user.sh`, `setup-cluster.sh`, `set-secret.sh`, `release.sh`, `health.sh`,
`bulig-cli.sh`, `precheck.sh`, `postcheck.sh`, `backup-postgres.sh`, `restore-drill.sh`, `systemd/`, `bulig.config.vps.json`, the
name-only `credentials.example` and `backup.env.example`, and `test/run.sh` (run it on the Mac: `bash deploy/test/run.sh`).

## The order

Stop at the first failure and read the message: every script says what it refused and why.

1. **Precheck.** The "before" picture. Read-only. The release is not on the server yet, so copy the kit to Bulig's own checks folder first
   (delete `kit/` after step 5, when the release carries the same files):
   ```bash
   ssh ths-prod-01 'mkdir -p -m 0700 /var/lib/bulig-checks' && rsync -az deploy/ ths-prod-01:/var/lib/bulig-checks/kit/ && ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/precheck.sh'
   ```

2. **Users and folders.**
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-user.sh'
   ```
   Read its tool lists. If `node`, `pnpm`, `git`, `gh` (for bulig) or `node`, `git`, `claude` (for bulig-worker) shows MISSING, install it
   under `/usr/local` or the user's `~/.local`, not under `/root` or `/home`.

3. **Postgres cluster.** Creates `16 bulig` on 5436, the role `bulig` and database `bulig`, a second role `bulig_drill` (can create
   databases and nothing else; used only by the restore drill), and writes the connection URL (explicit host and port) into
   `/etc/bulig/pg-url`. It refuses if 5436 is used by anything else, or by something that is not Postgres.
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-cluster.sh'
   ```

4. **Secrets only Jasher has.** Each goes in over stdin, so it never shows in a shell history or `ps`.
   - GitHub bot token (from the Mac Keychain):
     ```bash
     security find-generic-password -s bulig-github-bot -w | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential gh-token'
     ```
   - Claude token. It must be made as the worker user, so the token and Claude's sign-in belong to `bulig-worker`. Interactive, Jasher only:
     ```bash
     ssh -t ths-prod-01 'runuser -u bulig-worker -- env HOME=/var/lib/bulig-worker claude setup-token'
     ```
     Then pipe the token it prints into `set-secret.sh --credential claude-token` the same way.

5. **Release.** From the Mac, inside the bulig checkout:
   ```bash
   bash deploy/release.sh <ref>
   ```
   It archives the ref, copies it to a private folder on the server, then (under a lock) installs packages as bulig, hands the folder to
   root, renames it to `/opt/bulig/releases/<sha>`, swaps `current`, installs the units, creates the config on the first run (Telegram
   off, local worker off), restarts both services and runs `health.sh`. It refuses if that sha is already live. A failed health check puts
   the previous release and the previous unit files back.

6. **Health.** Run it any time. It checks both services, and reads the lease twice, 11 seconds apart.
   ```bash
   ssh ths-prod-01 '/opt/bulig/current/deploy/health.sh'
   ssh ths-prod-01 'systemctl show bulig.service bulig-worker.service -p Id -p User -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax'
   ```

7. **Copy over the old record** (PR-E, `bulig migrate sqlite-to-postgres`). Dry run first, then the real copy. Stop the kernel first (only
   one writer), run the command in a capped transient unit, start the kernel again, run `health.sh`:
   ```bash
   ssh ths-prod-01 'systemctl stop bulig.service && /opt/bulig/current/deploy/bulig-cli.sh migrate sqlite-to-postgres --from <file> --to-env BULIG_PG_URL --dry-run'
   ```
   (`bulig-cli.sh` runs as user `bulig` with the same credentials as the kernel unit; how PR-E names the target is its own detail.)

8. **Synthetic jobs.** One on the VPS worker, one on the Mac worker over Tailscale. Exactly one PR each, on the sandbox repo. Repos are
   cloned under `/var/lib/bulig/work`. Jobs run through the two services; one-off commands go through `bulig-cli.sh` (a transient unit
   with caps, never a bare shell). Assumed (to confirm): the exact submit command comes with the worker protocol (PR-C), including the
   gateway on `127.0.0.1:7431` (and the Tailscale address for the Mac).

9. **Backup.** Fill the R2 settings, one name at a time, then run one backup by hand and look for the `bulig-backup: ok` line:
   ```bash
   printf '%s' "$R2_ENDPOINT" | ssh ths-prod-01 'bash /opt/bulig/current/deploy/set-secret.sh --backup-key R2_ENDPOINT'
   ```
   (repeat for `R2_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`; names in `backup.env.example`)
   ```bash
   ssh ths-prod-01 'systemctl start bulig-backup.service && journalctl -u bulig-backup.service -n 5 --no-pager'
   ssh ths-prod-01 'systemctl enable --now bulig-backup.timer bulig-restore-drill.timer'
   ```
   **R2 key (Jasher):** the first run can use the shared bucket key that already exists, but it should be replaced with an R2 token limited
   to the `bulig/` prefix of the bucket. Only Jasher can create it (Cloudflare dashboard). Restore is safe either way: the drill restores only
   an object whose sha256 is in the root-owned local index (`/var/backups/bulig/index`), and restores it with `pg_restore` as a role that
   owns only its scratch database, so a swapped or planted object in R2 is refused or harmless.

10. **Restore drill.** Takes the newest entry of the local index, downloads it, checks the sha256, restores it into a scratch database in
    the bulig cluster as the `bulig_drill` role, compares tables and row counts with the live database, logs the time, drops the scratch
    database. Look for `bulig-restore-drill: ok ... restore_seconds=N`.
    ```bash
    ssh ths-prod-01 'systemctl start bulig-restore-drill.service && journalctl -u bulig-restore-drill.service -n 5 --no-pager'
    ```

11. **Postcheck.** The "after" picture. It must say the snapshot is identical to the precheck (apart from Bulig's own things).
    ```bash
    ssh ths-prod-01 '/opt/bulig/current/deploy/postcheck.sh'
    ```
    A diff of unrelated services that started or stopped on their own (a nightly job) needs a human read: check it is not Bulig's
    doing before calling it noise, and add the pattern to `SNAPSHOT_NOISE` in `lib/snapshot.sh` if it is.

## Cutover (Jasher only)

Not part of the steps above, and nobody runs it without his yes. Moving Telegram means two things happen in a fixed order, because
two kernels must never poll one bot (Telegram answers the second `getUpdates` with a conflict).

1. Stop the Mac: `launchctl bootout gui/$(id -u)/dev.bulig.serve`.
2. Put the bot token on the server as a credential for the kernel only: add `telegram-token` to `BULIG_CREDENTIALS` in `lib/common.sh`
   and `LoadCredential=telegram-token:/etc/bulig/telegram-token` to `bulig.service` (a reviewed change, then `release.sh`), then
   `security find-generic-password -s bulig-telegram-bot -w | ssh ths-prod-01 'bash /opt/bulig/current/deploy/set-secret.sh --credential telegram-token'`.
3. In `/var/lib/bulig/.bulig/config.json` add `"channel-telegram"` to `enabled`, add its grants and its `pluginConfig` block
   (`allowedChatIds`, `allowedUserIds`, `repos`; copy the shape from `bulig.config.example.json`). Keep the file owned by root, group bulig, mode 0640.
4. `systemctl restart bulig` and run `health.sh`.
5. Send a message to the bot and watch `journalctl -u bulig -f`.

To undo: remove `channel-telegram` from `enabled`, restart, then start the Mac serve again (`launchctl bootstrap ...`). The Mac's
SQLite file is still the copy it was before the move, so going back loses anything done on the VPS since cutover; decide that first.

## Rollback

- **A bad release.** `release.sh` already rolls back by itself when the health check fails (code and unit files). To go back by hand:
  ```bash
  ssh ths-prod-01 'ls -1t /opt/bulig/releases'
  bash deploy/release.sh <older-sha>
  ```
- **Stop Bulig, leave everything else alone.** `systemctl stop bulig-worker bulig`. The cluster keeps running. Jobs resume on the next start.
- **Remove Bulig completely.** Only with Jasher's yes, and in this order: `systemctl disable --now bulig-worker bulig bulig-backup.timer bulig-restore-drill.timer`,
  remove `/etc/systemd/system/bulig*`, `systemctl daemon-reload`, `pg_dropcluster 16 bulig --stop`, then `userdel bulig`, `userdel bulig-worker`,
  `groupdel bulig-work`, then `/opt/bulig`, `/etc/bulig`, `/var/lib/bulig`, `/var/lib/bulig-worker`, `/var/backups/bulig`. Run `postcheck.sh`; it should show nothing
  changed from the precheck.
- **Restore the database from R2.** The restore drill is the rehearsal. For a real restore: `systemctl stop bulig-worker bulig`, take the
  newest dump (a custom-format `.dump` under `bulig/postgres/`; check its sha256 against `/var/backups/bulig/index`), create an empty
  database as `bulig`, `pg_restore --no-owner --role=bulig -h 127.0.0.1 -p 5436 -U bulig -d <db> <dump>`, point the config at it, start the services.

## Things to know

- **The programs must read credentials before the units can start.** Today the config says `store.urlEnv: BULIG_PG_URL`, and no unit sets
  that variable on purpose (credentials only reach the units that list them). The worker-protocol change (PR-C, ADR 0011) makes the kernel read `$CREDENTIALS_DIRECTORY`
  and adds `bulig worker`. It has to be in the release, or `bulig.service` stops at start with "environment variable is not set" and
  `bulig-worker.service` fails on an unknown command.
- `bulig serve` refuses to start with no channel, so the VPS config enables `channel-cli` and leaves `channel-telegram` out. The config also
  leaves `worker-claude-code` out of `enabled`: the kernel has no in-process worker here, all work goes through `bulig-worker`.
- Both services are `Restart=always`. A lost lease makes `serve` exit non-zero and systemd starts it again within 5 seconds.
- `/opt/bulig` is read-only to both services on purpose. A release is installed by bulig, then handed back to root.
- Everything uses a Postgres connection with an explicit host (`127.0.0.1`) and port, and passwords travel in a private PGPASSFILE, never on a
  command line (any user on this host can read other processes' arguments).

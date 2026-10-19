# Running Bulig on ths-prod-01 (ADR 0011)

Bulig runs on the same host as client production. It gets its own user, its own Postgres cluster (`16 bulig`, port 5436), its own
systemd unit with CPU and memory caps, and its own folders. Nothing else on the host is touched. `precheck.sh` and `postcheck.sh`
prove that.

Where each thing lives on the server:

| What | Path |
|---|---|
| Code, one folder per release | `/opt/bulig/releases/<sha>`, with `/opt/bulig/current` pointing at the live one |
| Secrets, one file each | `/etc/bulig/pg-url`, `gh-token`, `claude-token`, `worker-tokens` (root, 0600). systemd loads them with `LoadCredential=`; they are not in the unit's environment, so Claude sessions cannot inherit them (`credentials.example`) |
| R2 keys | `/etc/bulig/backup.env` (root, 0600). The kernel never loads it |
| Kernel config | `/var/lib/bulig/.bulig/config.json` (root owns it, bulig can read it) |
| Worktrees, Claude and gh sign-in | `/var/lib/bulig` (the only place the service may write) |
| Dumps waiting for R2 | `/var/backups/bulig` |
| Before and after snapshots | `/var/lib/bulig-checks` |

Run every script on the server as root. The Mac only runs `release.sh`. Files here: `setup-user.sh`, `setup-cluster.sh`, `set-secret.sh`, `release.sh`, `health.sh`, `bulig-cli.sh`, `precheck.sh`, `postcheck.sh`, `backup-postgres.sh`, `restore-drill.sh`, `systemd/`, `bulig.config.vps.json`, `bulig-cli.sh`, and the name-only `credentials.example` and `backup.env.example`.

## The order

Do the steps in this order. Stop at the first failure and read the message: every script says what it refused and why.

1. **Precheck.** The "before" picture. Read-only. The release is not on the server yet, so copy the kit to Bulig's own checks folder first
   (delete `kit/` after step 5, when the release carries the same files):
   ```bash
   ssh ths-prod-01 'install -d -m 0700 /var/lib/bulig-checks' && rsync -az deploy/ ths-prod-01:/var/lib/bulig-checks/kit/ && ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/precheck.sh'
   ```

2. **User and folders.**
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-user.sh'
   ```
   Read its tool list. If `node`, `pnpm`, `git`, `gh` or `claude` shows MISSING, install it under `/usr/local` or
   `/var/lib/bulig/.local`, not under `/root` or `/home` (the unit hides those).

3. **Postgres cluster.** Creates `16 bulig` on 5436, the role and database, and writes the connection URL (explicit host and port) into `/etc/bulig/pg-url`.
   It refuses if 5436 is used by anything else.
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-cluster.sh'
   ```

4. **Secrets only Jasher has.** Each goes in over stdin, so it never shows in a shell history or `ps`.
   - GitHub bot token (from the Mac Keychain):
     ```bash
     security find-generic-password -s bulig-github-bot -w | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential gh-token'
     ```
   - Claude token: Jasher runs `claude setup-token` as the bulig user (it is interactive), then pipes the result into
     `set-secret.sh --credential claude-token` the same way.
   - `gh` and `git` sign-in for the bulig user: the token above is enough for `gh`; git identity comes from the config's author fields.

5. **Release.** From the Mac, inside the bulig checkout:
   ```bash
   bash deploy/release.sh <ref>
   ```
   It archives the ref, copies it to `/opt/bulig/releases/<sha>`, installs packages as bulig, swaps `current`, installs the units,
   creates the config on the first run (Telegram off), restarts `bulig.service` and runs `health.sh`. A failed health check puts
   the previous release back.

6. **Health.** Run it any time. It reads the lease twice, 11 seconds apart, and fails if it is not held and renewing.
   ```bash
   ssh ths-prod-01 '/opt/bulig/current/deploy/health.sh'
   ```
   Also check the caps are active:
   ```bash
   ssh ths-prod-01 'systemctl show bulig.service -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p User'
   ```

7. **Copy over the old record** (PR-E, `bulig migrate sqlite-to-postgres`). Dry run first, then the real copy. Run it with `deploy/bulig-cli.sh migrate sqlite-to-postgres ...` (it runs as bulig with the same credentials the service has)
   while `bulig.service` is stopped (`systemctl stop bulig`), then start the service and run `health.sh`.

8. **Synthetic jobs.** One on the VPS worker through the CLI, one on the Mac worker over Tailscale. Exactly one PR each, on the
   sandbox repo. Only one writer may hold the database, so stop the service around the CLI run:
   ```bash
   ssh ths-prod-01 'systemctl stop bulig && /opt/bulig/current/deploy/bulig-cli.sh run --repo <sandbox-path> --title "synthetic job"; systemctl start bulig && /opt/bulig/current/deploy/health.sh'
   ```

9. **Backup.** Fill `/etc/bulig/backup.env` (names in `deploy/backup.env.example`) with `set-secret.sh NAME /etc/bulig/backup.env` (the backup units load that file as a credential; the kernel never does).
   Then run one backup by hand and look for the `bulig-backup: ok` line:
   ```bash
   ssh ths-prod-01 'systemctl start bulig-backup.service && journalctl -u bulig-backup.service -n 5 --no-pager'
   ssh ths-prod-01 'systemctl enable --now bulig-backup.timer bulig-restore-drill.timer'
   ```

10. **Restore drill.** Restores the newest dump into a scratch database on the same cluster, compares tables and row counts with
    the live database, logs the time, drops the scratch database. Look for `bulig-restore-drill: ok ... restore_seconds=N`.
    ```bash
    ssh ths-prod-01 'systemctl start bulig-restore-drill.service && journalctl -u bulig-restore-drill.service -n 5 --no-pager'
    ```

11. **Postcheck.** The "after" picture. It must say "no change outside Bulig". Anything else is a stop.
    ```bash
    ssh ths-prod-01 '/opt/bulig/current/deploy/postcheck.sh'
    ```
    A diff of unrelated services that started or stopped on their own (a nightly job) needs a human read: check it is not Bulig's
    doing before calling it noise, and add the pattern to `SNAPSHOT_NOISE` in `lib/snapshot.sh` if it is.

## Cutover (Jasher only)

Not part of the steps above, and nobody runs it without his yes. Moving Telegram means two things happen in a fixed order, because
two kernels must never poll one bot (Telegram answers the second `getUpdates` with a conflict).

1. Stop the Mac: `launchctl bootout gui/$(id -u)/dev.bulig.serve`.
2. Put the bot token on the server: `security find-generic-password -s bulig-telegram-bot -w | ssh ths-prod-01 'bash /opt/bulig/current/deploy/set-secret.sh --credential telegram-token'` (add `telegram-token` to the known names in `lib/common.sh` and `LoadCredential=telegram-token:/etc/bulig/telegram-token` to `bulig.service` in the cutover change).
3. In `/var/lib/bulig/.bulig/config.json` add `"channel-telegram"` to `enabled`, add its grants and its `pluginConfig` block
   (`tokenEnv`, `allowedChatIds`, `allowedUserIds`, `repos`; copy the shape from `bulig.config.example.json`). Keep the file owned by root, group bulig, mode 0640.
4. `systemctl restart bulig` and run `health.sh`.
5. Send a message to the bot and watch `journalctl -u bulig -f`.

To undo: remove `channel-telegram` from `enabled`, restart, then start the Mac serve again (`launchctl bootstrap ...`). The Mac's
SQLite file is still the copy it was before the move, so going back loses anything done on the VPS since cutover; decide that first.

## Rollback

- **A bad release.** `release.sh` already rolls back by itself when the health check fails. To go back by hand:
  ```bash
  ssh ths-prod-01 'ls -1t /opt/bulig/releases'
  ssh ths-prod-01 'ln -sfn /opt/bulig/releases/<older-sha> /opt/bulig/current.new && mv -T /opt/bulig/current.new /opt/bulig/current && systemctl restart bulig && /opt/bulig/current/deploy/health.sh'
  ```
- **Stop Bulig, leave everything else alone.** `systemctl stop bulig`. The cluster keeps running. Jobs resume on the next start.
- **Remove Bulig completely.** Only with Jasher's yes, and in this order: `systemctl disable --now bulig bulig-backup.timer bulig-restore-drill.timer`,
  remove `/etc/systemd/system/bulig*`, `systemctl daemon-reload`, `pg_dropcluster 16 bulig --stop`, then `userdel bulig`, then
  `/opt/bulig`, `/etc/bulig`, `/var/lib/bulig`, `/var/backups/bulig`. Run `postcheck.sh`; it should show nothing changed from the precheck.
- **Restore the database from R2.** The restore drill is the rehearsal. For a real restore: `systemctl stop bulig`, take the newest
  dump (`aws s3 ls s3://$R2_BUCKET/bulig/postgres/`), create an empty database, `gunzip -c dump | psql` into it as postgres
  on port 5436, point the role's database at it, start the service.

## Things to know

- **The kernel must read credentials before the unit can start.** Today the config says `store.urlEnv: BULIG_PG_URL`, and this unit deliberately does not set that variable. The change that makes the kernel read `$CREDENTIALS_DIRECTORY` (worker protocol, ADR 0011) has to be in the release, or `serve` stops at start with a clear "environment variable is not set" message.

- `bulig serve` refuses to start with no channel, so the VPS config enables `channel-cli` and leaves `channel-telegram` out.
- The service is `Restart=always`. A lost lease makes `serve` exit non-zero and systemd starts it again within 5 seconds.
- `/opt/bulig` is read-only to the service on purpose. A release is installed by bulig, then handed back to root.
- Everything uses a Postgres URL with an explicit host (`127.0.0.1`) and port. Never use one without a host: it would fall back to the
  default socket and port, which may be another cluster.

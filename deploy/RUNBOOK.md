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
- `deploy/test/invariant.sh` is a text check, and this is exactly what it checks. It reads every script root runs and every unit file. In a script, any command that is not on a short read-only list (`echo`, `test`, `ls`, `cat`, `grep`, `stat`, `id`, `wc`, `sort`, a `find` with no `-exec`/`-delete`, a `sed` without `-i`, and the kit's own helper functions that do not write) counts as able to write. It fails the build if such a command has an argument, or a redirect has a target, that after variables are expanded names `/var/lib/bulig`, `/var/lib/bulig-worker` or `~bulig`; if a recursive command or a `find ... -exec/-delete` names `/`, `/var` or `/var/lib`; if `docker` mounts one of them or a parent; if a script calls `getent` for one user or group, or `eval`; if `chown` has no `-h` or has `-R`; if `useradd` makes a home; if a root unit names one of the folders; or if a Bulig unit has no `StateDirectory=` or has a root-privileged `ExecStartPre=`. Commands run as another user (`systemd-run --uid=bulig*` or `DynamicUser=yes`, `runuser`, `setpriv`) are not root writes and are skipped.
  It does **not** see a path that exists only at run time (built from a file's contents or from command output other than the ones it bans), or a write done by a program it has no rule for, if no argument names the folder. For those, `release.sh` and `setup.sh` in the same folder run the real scripts against fake user folders and check that nothing in them is created, changed or deleted. It runs in `scripts/verify.sh`.

## What runs where

Bulig runs on the same host as client production. It gets its own two users, its own Postgres cluster (`16 bulig`, port 5436), two systemd units with CPU and memory caps, and its own folders. The snapshot taken by `precheck.sh` and compared by `postcheck.sh` shows that nothing else it lists has changed (clusters, services, timers, unit files, ports, containers, users and groups, cron, and the mode of a few top folders; it says nothing about what it does not list).

- `bulig` runs the kernel (`bulig.service`). Credentials: `config`, `pg-url`, `gh-token`, `worker-tokens`. No Claude token.
- `bulig-worker` runs the worker (`bulig-worker.service`), which runs Claude Code. Credentials: `claude-token`, `worker-token`, `github-read-token` (a fine-grained GitHub token with read-only Contents on the one sandbox repo, for the worker's own clone). No config, no database URL, no token that can push.
- The two share no folder and no group. The worker has its own clone of a repo and sends the kernel a patch; the kernel applies it in its own worktree (ADR 0011, PR #50). Both homes are 0700.

| What | Path | Made by |
|---|---|---|
| Kernel home, state, repos, worktrees | `/var/lib/bulig` | systemd (`StateDirectory=bulig`), then the kernel |
| Worker home, Claude settings, clones, stage folders | `/var/lib/bulig-worker` | systemd (`StateDirectory=bulig-worker`), then the worker |
| Node code, one folder per release | `/opt/bulig/releases/<sha>`, `/opt/bulig/current` | `release-remote.sh` (root) |
| Root scripts and unit files, one folder per release | `/usr/local/lib/bulig/<sha>`, `/usr/local/lib/bulig/current` | `release-remote.sh` (root) |
| Secrets and the kernel config | `/etc/bulig/` (pg-url, gh-token, worker-tokens, claude-token, worker-token, github-read-token, drill-pw, backup.env, config.json, worker.env) | `set-secret.sh`, `setup-cluster.sh`, `release-remote.sh` (root) |
| Dumps before and after R2, and the index of what was backed up | `/var/backups/bulig` | the backup (root) |
| Snapshots and release work areas | `/var/lib/bulig-checks` | root |
| Units | `/etc/systemd/system/bulig*` | `release-remote.sh` |

Tools must be in system folders (`/usr/bin`, `/usr/local/bin`): neither user has a `~/.local`, and the build runs as a throwaway user. On the host today: node 22, pnpm, git, gh, claude and docker are in `/usr/bin`; there is no `aws` (the pinned aws-cli image is used).

**This kit depends on PR #50** (the remote worker): the kernel reading `$CREDENTIALS_DIRECTORY/config` first, `urlCredential`, the `worker-gateway` plugin, and `bulig worker`. Release a build that contains #50, or `bulig.service` and `bulig-worker.service` will not start.

## Steps

Stop at the first failure and read the message: every script says what it refused and why. Run the scripts as root on the server, from the Mac with `ssh`.

1. **Precheck.** The "before" picture. Read-only. The release is not on the server yet, so copy the kit into the root-owned checks folder first (delete `kit/` after step 5, when the release carries the same files):
   ```bash
   ssh ths-prod-01 'mkdir -p -m 0700 /var/lib/bulig-checks' && rsync -rlz deploy/ ths-prod-01:/var/lib/bulig-checks/kit/ && ssh ths-prod-01 'test -z "$(find /var/lib/bulig-checks/kit ! -user root)" && bash /var/lib/bulig-checks/kit/precheck.sh'
   ```
   `-rlz`, not `-az`: `-a` includes `-o`, and rsync running as root on the server would keep the Mac user's id as the owner. Without it every file is created by root. (`--chown=root:root` would say it outright, but the Mac's `rsync` is openrsync and does not have it; the `find` above fails the command if anything on the server is not root's.)

2. **Users and root folders.** Makes the two users with no home, and `/opt/bulig`, `/usr/local/lib/bulig`, `/etc/bulig`, `/var/backups/bulig`, `/var/lib/bulig-checks`. It makes nothing for the users: systemd does that at the first start. It refuses while any process of either user exists, so on a rerun stop the services first (`systemctl stop bulig-worker bulig`).
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-user.sh'
   ```
   Read its tool lists. If `node`, `pnpm`, `git`, `gh` (bulig) or `node`, `git`, `claude` (bulig-worker) shows MISSING, install it under `/usr/local` or `/usr`.

3. **Postgres cluster.** Creates `16 bulig` on 5436 with **no TCP listener** (`listen_addresses = ''`), the role `bulig` and database `bulig`, a second role `bulig_drill` (can create databases and nothing else; used only by the restore drill), and writes the connection URL into `/etc/bulig/pg-url`: `postgres://bulig:<password>@%2Fvar%2Frun%2Fpostgresql:5436/bulig`, which the driver reads as the unix socket folder `/var/run/postgresql`, port 5436. The cluster's logins are three unix-socket rules in `bulig_hba.conf` (postgres by peer, `bulig` and `bulig_drill` by password), and there is no rule for TCP. The two config files are written as root-owned files (`install -o root`, then `mv -T`; a link at the target is refused). It refuses if 5436 is used by anything else, or by something that is not Postgres, and (like step 2) while a Bulig process exists.
   ```bash
   ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/setup-cluster.sh'
   ```

4. **Secrets and settings.** Each value goes in over stdin, so it never shows in a shell history or `ps`.
   - GitHub bot token (from the Mac Keychain):
     ```bash
     security find-generic-password -s bulig-github-bot -w | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential gh-token'
     ```
   - The worker's read-only GitHub token (from the Mac Keychain; fine-grained, read-only Contents on the one sandbox repo). The worker unit loads it, so it must be there before the release in step 5:
     ```bash
     security find-generic-password -s bulig-worker-read-token -w | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --credential github-read-token'
     ```
   - The VPS worker's token. One command writes the worker's own `worker-token` and its `vps=` line in the kernel's `worker-tokens`:
     ```bash
     openssl rand -hex 32 | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --worker-token vps'
     ```
   - Which repositories the worker may work on (not secret; it needs at least one; kernel path under `/var/lib/bulig/repos`, clone under `/var/lib/bulig-worker/work`):
     ```bash
     echo 'BULIG_WORKER_REPOS=--repo /var/lib/bulig/repos/sandbox=/var/lib/bulig-worker/work/sandbox' | ssh ths-prod-01 'bash /var/lib/bulig-checks/kit/set-secret.sh --worker-env'
     ```
   - The fence's machine-specific probes (required: `fence-check.sh`, and so `health.sh`, fails without them). Fill in `deploy/fence/extra-probes.template` and install it as described under "The extra probes" below.
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
   2. unpacks the tar as root in a second sandbox that can write one empty folder only, with no network, no capabilities, no unix sockets other than its own, and the kernel's tunables, modules, logs, control groups and clock protected (`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectClock`);
   3. refuses it if it holds anything but files, folders and links, a hard link, a set-id file, a file outside `node_modules`, a `node_modules` where the release has no folder, or a link that leaves the release (absolute, or climbing past the root, or with `..` after a name);
   4. builds the final tree from a fresh copy of the delivered code plus those `node_modules` folders (nothing else from the build is kept, so a build script cannot change a delivered file) and installs it as `/opt/bulig/releases/<sha>`;
   5. installs `deploy/` as `/usr/local/lib/bulig/<sha>` (the scripts root runs and the unit files, root-owned);
   6. swaps both `current` links, installs the unit files, creates `/etc/bulig/config.json` from the template **only if it is missing** (root, 0600; never overwritten), enables and starts `bulig-loopback.service` (the gateway address), restarts both services, and runs `health.sh`. Any failure puts back both links and the unit files. It refuses a sha that is already live (exit 3).

6. **Health.** Run it any time. It checks both services and the gateway-address unit, reads the lease twice, 11 seconds apart, and then runs the fence check (`fence-check.sh`, see "What each unit can reach"): a probe from inside each unit's network and socket properties that must not reach other tenants' services and must still reach DNS, GitHub and (for the worker) the gateway. It also warns when the host's addresses changed or a new service listens on every address. `health.sh --no-fence` skips the probes.
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/health.sh'
   ssh ths-prod-01 'systemctl show bulig.service bulig-worker.service -p Id -p User -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p StateDirectory'
   ```

7. **Repos.** The kernel and the worker each make their own clone, as their own user, inside their own folder (`git clone` makes the missing parent folders as that user; root makes none). The sandbox repo is private, so each user first gets a git credential helper in its own global git config, written by that user (`git config --global` runs as the user in a transient unit, so the file lands in the user's own folder; root writes nothing there). The helper is `git-credential-bulig-read`, a root-owned script in the release. On every `git clone` and `git fetch` to `https://github.com` it reads the token from the unit's `$CREDENTIALS_DIRECTORY` at that moment and hands it to git. The token is never written into a git config, a remote URL, an argument, the environment or a log. The worker's helper reads `github-read-token`, the kernel's reads `gh-token`, and each is only ever in its own unit:
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as worker --exec git config --global credential.https://github.com.helper "/usr/local/lib/bulig/current/git-credential-bulig-read github-read-token"'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec git config --global credential.https://github.com.helper "/usr/local/lib/bulig/current/git-credential-bulig-read gh-token"'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec git clone https://github.com/<owner>/sandbox /var/lib/bulig/repos/sandbox'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as worker --exec git clone https://github.com/<owner>/sandbox /var/lib/bulig-worker/work/sandbox'
   ssh ths-prod-01 'systemctl restart bulig-worker'
   ```
   The worker's own `git fetch origin` (it runs with the worker's global git config) then works the same way. A public repo needs no helper.

8. **Copy over the old record** (PR-E, `bulig migrate sqlite-to-postgres`). Dry run first, then the real copy. The SQLite file goes in through `bulig-cli.sh --exec`, as the `bulig` user, into the kernel's own state folder, over a pipe. **Never `scp` or `rsync` it into `/var/lib/bulig`**: root would be writing inside the user's folder, which is the one thing this kit does not do. Stop the kernel first (only one writer), run the command in a capped transient unit, start the kernel again, run `health.sh`:
   ```bash
   ssh ths-prod-01 'systemctl stop bulig.service'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec sh -c "cat > /var/lib/bulig/state/import.sqlite"' < <path of the Mac's SQLite file>
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh migrate sqlite-to-postgres --from /var/lib/bulig/state/import.sqlite --to-credential pg-url --dry-run'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh migrate sqlite-to-postgres --from /var/lib/bulig/state/import.sqlite --to-credential pg-url'
   ```
   `--to-credential pg-url` reads the connection string from the one-off unit's `$CREDENTIALS_DIRECTORY/pg-url` (`bulig-cli.sh --as kernel` loads it), so the URL and its password never go into an environment variable or an argument. The copy goes only into an empty record: on a database that already holds rows it refuses with exit 2 and writes nothing (the Cutover below makes a fresh one). After the real copy, remove the file again (`bulig-cli.sh --exec rm /var/lib/bulig/state/import.sqlite`) and start the kernel. `bulig-cli.sh` runs as user `bulig` with the kernel's credentials.

9. **Synthetic jobs.** One on the VPS worker, one on the Mac worker over Tailscale. Exactly one PR each, on the sandbox repo. Jobs run through the two services; one-off commands go through `bulig-cli.sh`. For the Mac worker, add its token (`set-secret.sh --worker-token mac`), let that one peer in with its Tailscale address (the kernel allows no Tailscale peer until you do, and then exactly one /32), add the VPS's own Tailscale address (`tailscale ip -4` on the server) next to `127.74.3.1` in `listen` in `/etc/bulig/config.json` (root edit), and restart `bulig.service`:
    ```bash
    ssh ths-prod-01 'bash /usr/local/lib/bulig/current/set-mac-worker.sh <the Mac'"'"'s 100.x address>'
    ssh ths-prod-01 'systemctl restart bulig.service'
    ```
    `set-mac-worker.sh` writes a root-owned drop-in, `/etc/systemd/system/bulig.service.d/20-mac-worker.conf`, with `IPAddressAllow=<that address>/32`; `--remove` takes it away again. Only an IPv4 address in 100.64.0.0/10 is accepted.

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

12. **Postcheck.** The "after" picture. It must say the snapshot matches the precheck (apart from Bulig's own things, and anything it lists as `info` or `warn`).
    ```bash
    ssh ths-prod-01 '/usr/local/lib/bulig/current/postcheck.sh'
    ```
    Two kinds of churn happen on every run and are reported, not compared. First, the run state of a service a timer starts (it is TriggeredBy a `.timer`, a timer in the snapshot starts it, or it is a oneshot with a `.timer` of the same name): "activating" mid-run or "inactive dead" after is an `info` line, and a `failed` one is a `warn` line that names the unit. Read every `warn`: that service's own run failed, which is not Bulig's doing but is still a real failure for its owner. The unit file, its enabled state and the timer itself are still compared. Second, per-session agent containers come and go next to a long-lived one from the same image: a new container from an image that was already running at the precheck is an `info` line, and so is a container that is gone or stopped while its image still runs in another container. A new image, a container whose image no longer runs in any container, or a known container on a new image still fails. Anything else that differs fails. A diff of other unrelated services that started or stopped on their own needs a human read: check it is not Bulig's doing before calling it noise, and add the pattern to `SNAPSHOT_NOISE` in `lib/snapshot.sh` if it is. The comparison reads the snapshot format as it is, so a precheck taken by an older kit still compares.

## What each unit can reach (network and sockets)

Other services on this host listen on loopback and on the container bridges with no login of their own, and another tenant's program can listen on an **abstract unix socket** that no file permission and no `PrivateTmp` hides. Claude (the worker, steered by prompts) and dependency scripts (the build) run code Bulig does not control, so there are two fences:

- **Sockets.** `RestrictAddressFamilies=AF_INET AF_INET6` on the worker, the release build and the worker's one-off commands: they cannot open a unix socket at all, abstract ones included, and no netlink socket. Pipes and `socketpair()` are not affected (`systemd.exec`: "sockets created with socketpair() ... are unaffected"), and node's `child_process` uses `socketpair`, so Claude's tools and `pnpm` build scripts still start children. `InaccessiblePaths=-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock` hides the other sockets as well, on the worker, the build, and the kernel (the `-` ignores a path that is not there).
- **Addresses.** systemd filters every IP packet of each unit in both directions (`IPAddressDeny=`, `IPAddressAllow=`: an Allow match wins, then a Deny match, then the packet is let through, which leaves the public internet). **The filter matches addresses, not ports.**

| Unit | Denied | Let through (Allow) |
|---|---|---|
| `bulig-worker.service`, the worker's `bulig-cli.sh` commands | localhost, link-local, multicast, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`, and this machine's own public addresses | `127.74.3.1/32` (the kernel gateway) |
| the release build (transient `bulig-build-*`) | the same | nothing |
| `bulig.service`, the kernel's `bulig-cli.sh` commands | localhost, link-local, multicast, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7` | `127.74.3.1/32`, plus the Mac worker's one Tailscale `/32` once `set-mac-worker.sh` has run |
| `bulig-backup.service`, `bulig-restore-drill.service` | localhost, link-local, multicast, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7` | nothing |
| `bulig-loopback.service` | everything (`any`) | nothing |

- **The host's own addresses** (the public IPv4 and IPv6 of `eth0`) are read from `ip -o addr` at setup time into a root-owned drop-in, `/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf` (and into the build and one-off units at run time). They are never typed into a unit file. After the host's address changes run `host-addresses.sh` and restart the worker; `health.sh` warns when they differ.
- **Because the filter matches addresses, `127.74.3.1` reaches every service listening on *all* addresses, and such a service sees the request coming from a loopback address, so it may treat it as local and trusted.** That is not "public anyway": the same service sees an outside request as outside. The fence check probes every wildcard listener it finds from the loopback and private addresses, but not from `127.74.3.1` itself, because the worker is meant to reach that address. `health.sh` warns when a new listener on every address appears that was not in the precheck snapshot.
- **DNS.** `/etc/resolv.conf` is the `systemd-resolved` stub on `127.0.0.53`. Allowing that address would also reach every listener on it (a service listening on every address answers there), so no unit allows it. Each unit that needs names gets resolved's upstream list instead, bind-mounted over `/etc/resolv.conf` (`BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf`): public servers, which the deny list leaves alone. (Binding onto the stub's symlink follows the link inside the unit; this is the part of the design that only the first real run can confirm. If names do not resolve, `fence-check.sh` says so on its `dns-lookup` probe.) The bind keeps the file as it was when the unit started: `systemd-resolved` rewrites its upstream list by renaming a new file into place, so **restart the Bulig units (`systemctl restart bulig bulig-worker`) after the upstream DNS servers change**. The four units that have the bind start `After=` and `Wants=` `systemd-resolved.service`, so the file exists when they start.
- **Postgres needs no TCP at all.** The kernel, backup, drill and health reach it over the unix socket, which IP filtering does not touch. The kernel (not the worker) keeps `AF_UNIX` for it.
- **Why `127.74.3.1` is put on `lo`.** `ip route get 127.74.3.1` on this host says `src 127.0.0.1`: a connection to a loopback address that is not assigned as its own address carries source `127.0.0.1`. Then the kernel unit would have to let `127.0.0.1` in and out (the filter checks the peer address: destination on the way out, source on the way in), which is exactly where the other tenants are. With `127.74.3.1/32` on `lo` the route says `src 127.74.3.1`, both ends of the conversation carry it, and each side allows that one address. (For a Tailscale peer the source is the peer's own `100.x` address.)
- **Docker.** With no `aws` CLI the backup runs the pinned image through `docker run`. That container's traffic belongs to dockerd's cgroup, not to the backup unit, so the unit's filter does not cover it. The container gets the R2 key on stdin and the dump, nothing else. The docker client's config folder is `DOCKER_CONFIG=/var/lib/bulig-checks/docker` (root-owned, made by `setup-user.sh`), because `ProtectHome=yes` hides `/root`.
- **The gateway bind.** `bulig serve` binds the gateway to `127.74.3.1` (config `listen`). PR #50 accepts any address in `127.0.0.0/8`, `::1` and the Tailscale ranges and refuses wildcards; `bulig worker` accepts plain `http` to the same set.

### The extra probes (`/etc/bulig/fence-extra-probes.txt`)

The published probes and the derived ones need no names, but the operator knows things the derivation cannot: a listener that only exists some of the time, a socket in a folder the derivation does not read. Those go in a root-owned file that is never committed (the repository is public, and this file describes this machine). `fence-check.sh` **fails when the file is missing or holds no probe**, so the machine-specific probes cannot be skipped by accident.

1. Copy `deploy/fence/extra-probes.template` to a scratch file on the Mac (outside the repository).
2. On the server, list what else is there: `ss -ltnp` (every TCP listener: one `tcp <ADDRESS>:<PORT>` line for each you do not want a Bulig unit to reach) and `ss -xlp | grep '@'` (abstract sockets: one `abstract <NAME>` line for each that is not Bulig's, name without the `@`). Give each line a short name of your own.
3. Replace every `<...>` placeholder; install it:
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/set-secret.sh --fence-extra-probes' < filled-in-file
   ```
   `set-secret.sh` refuses a file with a placeholder left, an unknown set, kind or expectation, or no probe at all, and writes it root-owned, mode 0600.
4. Delete the scratch file.

### The runtime fence check (`fence-check.sh`, run by `health.sh`)

Unit files being right is not the same as the machine enforcing them. `fence-check.sh` starts one short transient unit per set (worker, kernel, build, and the worker and kernel one-off commands) with exactly that set's properties and runs `fence-probe.py` inside it. The worker and kernel sets are read from the installed unit file **and its drop-ins**, so a drop-in that opens a hole is tested too. The probe list is one file, `deploy/fence/probes.txt`.

- **The rule: the kit never completes a connection to anything that is not Bulig's, from any context (the listening check, the known-limit reports, health), and never triggers socket activation of a non-Bulig unit.** A socket that systemd holds for another unit starts that unit on the first connection, so even a harmless "is it there?" connect can start a service that was stopped and disabled. (On 20 Oct 2026 the first real run did exactly that: the check connected to every target to see whether it was listening, one target was another service's socket-activated abstract socket, and the connection started it. The postcheck caught it and it was stopped again.) What connects, and only these: the *allow* probes (Bulig's own gateway and Postgres socket, DNS, `api.github.com`, `api.anthropic.com`), and the *deny* probes, which run inside the fence and must fail before they reach anything (an unix or abstract path: the set has no `AF_UNIX`, so `socket()` fails first; a TCP address: the IP filter drops the SYN). A deny probe that succeeds is a real connection to another service, which is exactly why it is a failure.

- It must FAIL to connect to, from every set: the systemd-resolved stub (`127.0.0.53:53`); `tailscaled`'s, `snapd`'s and docker's sockets; and, **found on the machine at run time** by `fence-probe.py derive` (from `ss` and `ip`, so no other service has to be named in git): every listener on loopback, on a private-range or Tailscale address; every listener-on-all-addresses port, tried from the loopback address, from each of the machine's private addresses (the container bridges), and (worker, build and worker-CLI sets) from each of its own public addresses; and every abstract unix socket (worker, build and worker-CLI sets; a *known limit* for the kernel sets). Any unexpected success fails health. The Postgres socket must not be reachable from the worker and build sets, and must be from the kernel sets. A target that ss does not list is reported as *inconclusive* (a warning), because a failed connection to nothing proves nothing. Whether a target is listening is read from `ss -H -ltn` and `ss -H -xl` as root, **never by connecting**; a target that ss lists and the fence blocks is a pass (*blocked*).
- **Socket-activated targets are never connected to by anything.** `fence-check.sh` reads `systemctl list-sockets` and matches each target by its listen address (TCP address and port, socket path, or `@` abstract name; a wildcard listener matches every address on its port). A match is reported as `activation socket: checked by properties only`: a TCP target is judged by whether `IPAddressDeny` covers the address and `IPAddressAllow` does not, a unix or abstract one by whether the unit has no `AF_UNIX` (or the path is under `InaccessiblePaths`). If `ss` or `systemctl list-sockets` cannot be read, the check stops rather than guess. **Activation detection reads the system manager only:** per-user managers' sockets (under `/run/user/<uid>`, mode 0700) are not in `systemctl list-sockets` and are not probe targets. A per-user unit could still listen on a TCP port or an abstract name, and those would not be recognised as activation sockets; the deny probes for them are still safe, because a deny probe only connects when the fence has to block it (the sets have no `AF_UNIX`, and a TCP probe only runs when `IPAddressDeny` covers the address, otherwise it is a FAIL from the properties without connecting). Only `tcp`, `unix` and `abstract` deny probes are accepted at all; `http`, `https` and `dns` deny lines are refused. The decision is made from each target itself, inside the fenced run too, never by looking a probe up by name; probe names are plain (`[A-Za-z0-9._-]`, 1 to 64) and used once per set, and `fence-check.sh`, `set-secret.sh` and the probe all refuse a repeat, so one probe's result cannot stand in for another's. A TCP deny target that the unit's own `IPAddressDeny`/`IPAddressAllow` already leave open is a FAIL from the properties, without connecting.
- **How long it takes.** A blocked connection is a *dropped* packet (the IP filter discards the SYN), so it ends in a timeout, not an error. Run one after another with a 3 s timeout, about 180 deny probes in each of 5 sets took about 40 minutes. Now: the five sets run at the same time, each in its own transient unit; inside a unit the deny probes run 32 at a time and each waits 1.5 s (an allow probe still waits 3 s, and a timeout on an allow probe is a FAIL). A connection that would leak completes in milliseconds, because everything a deny probe aims at is on this machine, so the shorter wait does not hide a leak (only a listener that cannot accept for more than 1.5 s could look blocked, and at 3 s it already looked blocked too); the rule above is unchanged and no probe is added or dropped. Measured with a stand-in that drops every blocked connection: about 10 s for 5 sets x 180 probes. Settings (environment, for `fence-check.sh`): `BULIG_FENCE_DENY_TIMEOUT` (seconds, 1.5), `BULIG_FENCE_JOBS` (32; 1 is one after another), `BULIG_FENCE_SET_TIMEOUT` (seconds for the whole run, 240). **A set that has not finished when the total time is up is stopped and reported as `FAIL <set> timeout ...`, which fails `health.sh`; it is never a pass.** The report lists the sets in the order asked and each set's probes in the order of `probes.txt`, derived probes and the extra file, whichever finished first.
- **The extra probes** (below) add the targets that are specific to this machine. `fence-check.sh` fails if that file is missing or empty.
- It must SUCCEED at: a DNS lookup and an HTTPS handshake with `api.github.com` (every set); a user lookup for the running uid (the worker, kernel and CLI sets: real users are resolved from `/etc/passwd`); `socketpair()` and running a child process (worker and build sets); for the build, node's `os.homedir()` with the HOME the build sets; for the worker sets, real node doing an HTTPS request to `api.anthropic.com`, and `claude --version`; and the gateway `GET /healthz` (worker sets), a separate, later check run only after the kernel's lease is confirmed, where a miss is a failure (before that it is a warning).
- **Known limits the check reports and does not fail on:** (1) the build's user lookup. The build runs as a `DynamicUser`, which has no passwd entry, and `libnss_systemd` (systemd 255; `nsswitch` is `passwd: files systemd`) resolves dynamic users only over the varlink socket `/run/systemd/userdb/io.systemd.DynamicUser`, which needs `AF_UNIX`. The build has none, on purpose, so `getpwuid` fails there. It does not need it: the build sets `HOME` explicitly (`--setenv=HOME=/var/tmp/home`) and node's `os.homedir()` reads `$HOME`, which the `node-homedir` probe proves. (2) `os.networkInterfaces()` in the worker sets, which needs a netlink socket the worker does not have (it is probed with real node and reported either way; whether Claude Code calls it is not known and is on the server-first list). (3) the abstract X socket from the kernel sets (see Known limits). **A known limit is never tested by connecting.** It is reported from the unit's properties (is `AF_UNIX` allowed, is the address in the IP filter) and from ss, labelled `known limit, not tested by connecting`. Only the non-network known probes (the user lookup, `os.networkInterfaces()`) still run.
- The kernel sets keep `AF_UNIX`, so other tenants' abstract sockets are listed there as *known limits*: reported from the properties and ss, never tested by connecting, never failing. For the same reason a *deny* probe for an abstract socket (or for a socket path that `InaccessiblePaths` does not hide) in a set that has `AF_UNIX` is reported as a known limit and not run: nothing would stop it, so running it would be a real connection.
- If something the worker or the build really needs turns out to need `AF_UNIX`, the check will say which probe failed; do not reopen the family list without Jasher.

## Footprint on ths-prod-01

Everything this kit adds or changes (nothing else is touched):

- Users and groups: `bulig`, `bulig-worker` (system users, `--no-create-home`, nologin).
- Units: `bulig-loopback.service`, `bulig.service`, `bulig-worker.service`, `bulig-backup.service` and `.timer`, `bulig-restore-drill.service` and `.timer` in `/etc/systemd/system`. Short-lived transient units `bulig-build-*`, `bulig-extract-*`, `bulig-cli-*` while a release or a command runs.
- Folders: `/opt/bulig`, `/usr/local/lib/bulig`, `/etc/bulig`, `/var/backups/bulig`, `/var/lib/bulig-checks` and `/var/lib/bulig-checks/docker` (all root), and `/var/lib/bulig`, `/var/lib/bulig-worker` (made by systemd).
- Postgres: cluster `16 bulig`, port 5436, unix socket only (`listen_addresses = ''`), roles `bulig` and `bulig_drill`, database `bulig`. The existing clusters (5432 and the others) are not touched.
- Network: Postgres has no TCP listener (socket `/var/run/postgresql/.s.PGSQL.5436`). The worker gateway listens on `127.74.3.1:7431`, an address that `bulig-loopback.service` puts on `lo` (`ip address replace 127.74.3.1/32 dev lo`, removed when the unit stops); the Tailscale address is added at the Mac-worker step. Nothing on a public interface.
- The one thing added outside the units, users and folders above is that address alias on `lo`. It is a host network change, so it needs Jasher's yes before the server phase.

## Cutover (Jasher only)

Not part of the steps above, and nobody runs it without his yes, **and only after every item in "Must be proven on the server first" has been shown, and `health.sh` and `postcheck.sh` both pass**. Cutover moves two things: Telegram, and the Mac's live record. They happen in a fixed order, because two kernels must never poll one bot (Telegram answers the second `getUpdates` with a conflict) and only one may write the record.

The VPS record already holds rows (the earlier copy in step 8, the synthetic jobs), and `bulig migrate sqlite-to-postgres` only copies into an empty record. So the old VPS record is set aside under another name, kept, and a fresh empty `bulig` takes the Mac's copy. `pg-url` does not change. Jobs that exist only in the old VPS record (the synthetic ones) stay in `bulig_precut` and are not carried over.

1. **Backup first.** One backup by hand; look for `bulig-backup: ok`:
   ```bash
   ssh ths-prod-01 'systemctl start bulig-backup.service && journalctl -u bulig-backup.service -n 5 --no-pager'
   ```
2. **Save the Mac's job list, then stop the Mac**, then take a consistent snapshot of its SQLite file (outside the repository). `bulig status` only reads, so it runs while serve is up. Nothing in the list may be `running`; if a job is, wait for it to finish or park, and save the list again:
   ```bash
   cd <the Mac's bulig checkout> && node packages/cli/bin/bulig.mjs status > <mac jobs file>
   launchctl bootout gui/$(id -u)/dev.bulig.serve
   sqlite3 <path of the Mac's SQLite file> ".backup <snapshot path>"
   ```
3. **Stop the units and the timers** on the server, so nothing writes or reads the record while it moves:
   ```bash
   ssh ths-prod-01 'systemctl stop bulig-worker bulig bulig-backup.timer bulig-restore-drill.timer'
   ```
4. **Set the old record aside and make an empty one**, as the `postgres` superuser over the socket (the same statements `setup-cluster.sh` uses):
   ```bash
   ssh ths-prod-01 "runuser -u postgres -- psql -X -h /var/run/postgresql -p 5436 -d postgres -v ON_ERROR_STOP=1 -c 'ALTER DATABASE bulig RENAME TO bulig_precut' -c 'CREATE DATABASE bulig OWNER bulig' -c 'REVOKE CONNECT ON DATABASE bulig FROM PUBLIC'"
   ```
5. **Copy the snapshot in**, as in step 8: pipe it in, dry run, real copy, remove the file. Both runs must end with every table `same`:
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec sh -c "cat > /var/lib/bulig/state/import.sqlite"' < <snapshot path>
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh migrate sqlite-to-postgres --from /var/lib/bulig/state/import.sqlite --to-credential pg-url --dry-run'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh migrate sqlite-to-postgres --from /var/lib/bulig/state/import.sqlite --to-credential pg-url'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh --as kernel --exec rm /var/lib/bulig/state/import.sqlite'
   ```
6. **Put the bot token on the server** as a credential for the kernel only. The release already carries the wiring: `telegram-token` is a known name in `lib/common.sh`, and `bulig.service` has `LoadCredential=telegram-token:/etc/bulig/telegram-token` with `SetCredential=telegram-token:none` as the default while the file is missing (the worker unit never holds it). channel-telegram reads the token from `$CREDENTIALS_DIRECTORY/telegram-token` (no environment variable; a value of `none` counts as no token, so the plugin stops at start by name instead of sending it to Telegram). It prints the length, never the value:
   ```bash
   security find-generic-password -s bulig-telegram-bot -w | ssh ths-prod-01 'bash /usr/local/lib/bulig/current/set-secret.sh --credential telegram-token'
   ```
7. **Turn the channel on.** In `/etc/bulig/config.json` (root) add `"channel-telegram"` to `enabled`, add its grants and its `pluginConfig` block (`allowedChatIds`, `allowedUserIds`, `repos`; copy the shape from `bulig.config.example.json`). Leave out `tokenCredential` (the default name is `telegram-token`); the example's `tokenEnv` can stay, the credential wins over it.
8. **Start** the units and the timers, then run `health.sh`. If the journal says `channel-telegram: the bot token is not set`, the file from step 6 is missing or empty (the unit got the `none` default).
   ```bash
   ssh ths-prod-01 'systemctl start bulig bulig-worker && systemctl start bulig-backup.timer bulig-restore-drill.timer'
   ssh ths-prod-01 '/usr/local/lib/bulig/current/health.sh'
   ```
9. **Check the record.** `status` on the server must print the same list as the file saved in step 2 (no output from `diff`). Then send a message to the bot and watch `journalctl -u bulig -f`.
   ```bash
   ssh ths-prod-01 '/usr/local/lib/bulig/current/bulig-cli.sh status' | diff <mac jobs file> -
   ```
10. **Keep `bulig_precut`** until the next backup and the next restore drill both pass on the new record (`bulig-backup: ok`, `bulig-restore-drill: ok`). Drop it only with Jasher's yes: `runuser -u postgres -- psql -X -h /var/run/postgresql -p 5436 -d postgres -c 'DROP DATABASE bulig_precut'`.

To undo: stop the units, remove `channel-telegram` from `enabled`, and start the Mac serve again (`launchctl bootstrap ...`). The Mac's SQLite file is still the copy it was before the move, so going back loses anything done on the VPS since cutover; decide that first. To go back to the old VPS record as well, swap the names back (`bulig` to another name, `bulig_precut` to `bulig`) with the units stopped.

## Rollback

- **A bad release.** `release-remote.sh` already rolls back by itself when the health check fails (links, units). To go back by hand:
  ```bash
  ssh ths-prod-01 'ls -1t /opt/bulig/releases'
  bash deploy/release.sh <older-sha>
  ```
- **Stop Bulig, leave everything else alone.** `systemctl stop bulig-worker bulig`. The cluster keeps running. Jobs resume on the next start.
- **Remove Bulig completely.** Only with Jasher's yes, and in this order: `systemctl stop bulig-worker bulig` first, then `systemctl stop bulig-loopback` (it takes `127.74.3.1` off `lo`; stopping it while the services run would cut them off), then `systemctl disable --now bulig-worker bulig bulig-loopback bulig-backup.timer bulig-restore-drill.timer`, remove `/etc/systemd/system/bulig*` (the unit files and the `bulig*.service.d` drop-in folders), `systemctl daemon-reload`, `pg_dropcluster 16 bulig --stop`, then `userdel bulig`, `userdel bulig-worker`, then `/opt/bulig`, `/etc/bulig`, `/usr/local/lib/bulig`, `/var/lib/bulig`, `/var/lib/bulig-worker`, `/var/backups/bulig`. **Run `postcheck.sh` after those and before the last step**; it compares against the precheck snapshot in `/var/lib/bulig-checks` and should show nothing changed. Only then remove `/var/lib/bulig-checks` itself.
- **Restore the database from R2.** The restore drill is the rehearsal. For a real restore: `systemctl stop bulig-worker bulig`, take the newest dump (a custom-format `.dump` under `bulig/postgres/`; check its sha256 against `/var/backups/bulig/index`), create an empty database as `bulig`, `pg_restore --no-owner --role=bulig -h /var/run/postgresql -p 5436 -U bulig -d <db> <dump>`, point the config at it, start the services.

## Known limits

- **The kernel can reach other tenants' abstract unix sockets.** `bulig.service` keeps `AF_UNIX` because it talks to Postgres over a unix socket, and an abstract socket has no file permission to stop it. It runs no worker code (the worker is a separate unit with no `AF_UNIX`), and the fence check lists this as a known limit (from the properties and ss, without connecting). The next hardening is an AppArmor profile for the kernel with `deny unix addr=@**,`; that is a change to the host's security setup and needs Jasher's yes before it is made.
- **`127.74.3.1` reaches every listener on all addresses, with a loopback source** (see above). The filter matches addresses, not ports; a listener on every address that trusts loopback callers trusts the worker.
- **The backup's docker container is outside the unit's IP filter** (see above).
- **The worker's Claude sessions can read the worker's own read-only token.** `github-read-token` is in the worker's `$CREDENTIALS_DIRECTORY`, and Claude runs as the worker with that environment. It grants read on the one sandbox repo and nothing else (no write, no other repo), so this is accepted. The kernel's `gh-token`, which can push, is never in the worker's unit.
- **The fence is untested on a real machine until the server phase.** Everything about it was checked as text and with stand-ins; `fence-check.sh` is the first real test, and `systemd-analyze verify` only checks syntax.

## Must be proven on the server first

Everything above was checked as text, with `systemd-analyze verify` (which reads unit files and does not run anything) and with stand-ins. Before anyone relies on it, the server phase must show each of these, in this order (`health.sh` runs most of them):

1. The transient-unit properties are accepted by `systemd-run` (`IPAddressDeny=`, `IPAddressAllow=`, `RestrictAddressFamilies=`, `InaccessiblePaths=` with its `-` prefix, `BindReadOnlyPaths=`): `verify` does not read transient properties.
2. `systemctl show` output (IPAddress lists, `BindReadOnlyPaths`, `InaccessiblePaths`) passes back into `systemd-run -p` unchanged: that is how `fence-check.sh` copies the worker's and kernel's loaded properties.
3. The `BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf` lands on the stub's symlink and names resolve (the `dns-lookup` probe, in every set).
4. Every deny probe is blocked (and was reachable from outside): the IP filter and the missing `AF_UNIX` really hold, including other tenants' abstract sockets.
5. `127.74.3.1` on `lo` makes the gateway work through the filter (`bulig-loopback.service`, which needs Jasher's yes): the `GET /healthz` probe from the worker sets.
6. Claude Code runs without `AF_UNIX` and `AF_NETLINK`: `claude --version`, the node HTTPS request to `api.anthropic.com`, and one real synthetic job. Whether it calls `os.networkInterfaces()` (the known probe) is not known.
7. node `child_process` (spawning with piped stdio) works under `RestrictAddressFamilies=AF_INET AF_INET6` (the `socketpair` and `spawn` probes), and a real `pnpm install` finishes in the build unit with no passwd entry for its `DynamicUser` (HOME is set; `getpwuid` is a known failure there).
8. `StateDirectory=` makes `/var/lib/bulig` and `/var/lib/bulig-worker` with the right owner and mode; `%d` and `%S` in `ExecStart` expand; `LoadCredential=` files reach each unit.
9. PR #50's kernel reads `$CREDENTIALS_DIRECTORY/config`, and its Postgres driver accepts the socket URL `postgres://bulig:<pw>@%2Fvar%2Frun%2Fpostgresql:5436/bulig`; the cluster accepts the `bulig` and `bulig_drill` logins over the socket with scram.
10. A release rolls back cleanly on a failed health check, a failed FIRST release leaves nothing running or enabled, and a second release succeeds.
11. `/etc/bulig/fence-extra-probes.txt` is filled in from the template ("The extra probes") and `fence-check.sh` runs with it; the check refuses to run without it.
12. PR #50's `github` plugin starts from the `gh-token` credential (no `BULIG_GH_TOKEN` in any environment).
13. Both helpers work inside their units: the worker's clone of the private sandbox repo succeeds with `github-read-token`, a push from the worker is refused by GitHub (the token is read-only), and the kernel's clone and push work with `gh-token`.

## Things to know

- **Depends on PR #50:** the kernel reads `$CREDENTIALS_DIRECTORY/config` first, the `github` plugin reads the `gh-token` credential (`tokenCredential`, default `gh-token`; a credential wins over `tokenEnv`), `urlCredential`, the `worker-gateway` plugin and `bulig worker`. As of #50's head `a567db8` all of these are there. The kit puts no secret in a unit's environment, so a build without them would not start.
- Both services are `Restart=always`. A lost lease makes `serve` exit non-zero and systemd starts it again within 5 seconds.
- `bulig serve` refuses to start with no channel, so the VPS config enables `channel-cli` and leaves `channel-telegram` out. The config also leaves `worker-claude-code` out of `enabled`: the kernel has no in-process worker here, all work goes through `bulig-worker`.
- `/opt/bulig` is read-only to both services on purpose. A release is built and checked by root and never handed to a Bulig user.
- The kernel unit's caps (1G, 100%, 256 tasks) are assumed in ADR 0011 (item 13), not measured. The worker's (3G, 250%, 512) are the ADR's.
- With no `aws` CLI the R2 calls go through a docker container (image pinned by digest) fed by stdin and stdout: no host mount, and the R2 key travels on stdin, never in docker's arguments or environment.
- Passfiles and downloads live in a 0700 folder under `/var/lib/bulig-checks` (root's), never in the host's `/tmp`, also when you run a script by hand.
- Everything uses a Postgres connection with an explicit host (the socket folder `/var/run/postgresql`) and port, and passwords travel in a private PGPASSFILE (host field `localhost`, which is how libpq looks up a socket), never on a command line (any user on this host can read other processes' arguments).

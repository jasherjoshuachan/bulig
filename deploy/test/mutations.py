"""Mutation proof for the deploy kit's tests. NOT part of scripts/verify.sh (it runs the suites dozens of times).

    python3 -I deploy/test/mutations.py <deploy dir> [name filter]

For each entry below: copy the kit to a temp folder, break ONE thing in one file (the text must be found exactly once), run the suite that
is supposed to notice, and expect it to FAIL. A mutation the suite does not notice is reported as SURVIVED and the run exits non-zero.
"""
import concurrent.futures
import os
import shutil
import subprocess
import sys
import tempfile

# (name, suite, file, old text, new text)
M = [
    # ---- release.sh: what the build hands back, the unpack sandbox, rollback, the user folders ----
    ("link rule: absolute targets allowed", "release.sh", "lib/modules.sh", '  case "$target" in /*) return 1 ;; esac\n', ""),
    ("link rule: .. after a name allowed", "release.sh", "lib/modules.sh", 'if [ "$seen_name" -eq 1 ]; then answer=1; fi', ":"),
    ("link rule: climbing past the root allowed", "release.sh", "lib/modules.sh", 'if [ "$depth" -lt 0 ]; then answer=1; fi', ":"),
    ("link rule: empty target allowed", "release.sh", "lib/modules.sh", '  [ -n "$target" ] || return 1\n', ""),
    ("check_modules: links are not checked", "release.sh", "lib/modules.sh", 'safe_link_target "$f" "$t" || die', 'true || die'),
    ("check_modules: hard links allowed", "release.sh", "lib/modules.sh", '-type f -links +1 -print -quit', '-type f -links +99 -print -quit'),
    ("check_modules: special files allowed", "release.sh", "lib/modules.sh", '! -type f ! -type d ! -type l -print -quit', '-name nothing-at-all -print -quit'),
    ("check_modules: files outside node_modules allowed", "release.sh", "lib/modules.sh", '*/node_modules/*) ;; *) die', '*) ;; *) die'),
    ("check_modules: set-uid files allowed", "release.sh", "lib/modules.sh", 'find "$dir" -type f -perm -4000 -print -quit', 'find "$dir" -name nothing-at-all -print -quit'),
    ("check_modules: set-gid files allowed", "release.sh", "lib/modules.sh", 'find "$dir" -type f -perm -2000 -print -quit', 'find "$dir" -name nothing-at-all -print -quit'),
    ("release: a node_modules in a folder the release lacks is moved in anyway", "release.sh", "release-remote.sh",
     '    [ -d "$final/$parent" ] && [ ! -L "$final/$parent" ] || die', '    mkdir -p "$final/$parent"; [ -d "$final/$parent" ] || die'),
    ("release: an empty build output is accepted", "release.sh", "release-remote.sh", '  [ "$size" -gt 0 ] || die "the build produced no node_modules"\n', ""),
    ("release: no size limit", "release.sh", "release-remote.sh", '  [ "$size" -le "$MAX_MODULES_BYTES" ] || die', '  true || die'),
    ("release: the build runs as a named user", "release.sh", "release-remote.sh", "-p DynamicUser=yes", "--uid=bulig"),
    ("release: the build gets no private tmp", "release.sh", "release-remote.sh", "-p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateDevices=yes -p NoNewPrivileges=yes", "-p ProtectSystem=strict -p ProtectHome=yes -p PrivateDevices=yes -p NoNewPrivileges=yes"),
    ("release: the build can leave processes behind", "release.sh", "release-remote.sh", "-p KillMode=control-group -p SendSIGKILL=yes", "-p SendSIGKILL=yes"),
    ("release: the build is given the source by path", "release.sh", "release-remote.sh", '--setenv=CI=true', '--setenv=CI=true --working-directory="$src"'),
    ("release: the unpack has network", "release.sh", "release-remote.sh", "-p PrivateNetwork=yes ", ""),
    ("release: the unpack can write anywhere under the checks folder", "release.sh", "release-remote.sh", '"ReadWritePaths=$dest"', '"ReadWritePaths=$CHK"'),
    ("release: the unpack keeps its capabilities", "release.sh", "release-remote.sh", "-p CapabilityBoundingSet= -p RestrictAddressFamilies=AF_UNIX", "-p RestrictAddressFamilies=AF_UNIX"),
    ("release: the unpack is not sandboxed read-only", "release.sh", "release-remote.sh", "-p ProtectSystem=strict -p \"ReadWritePaths=$dest\"", "-p \"ReadWritePaths=$dest\""),
    ("release: the config goes into the kernel's home (the first kit's bug)", "release.sh", "release-remote.sh",
     'install -m 0600 "$tk_rel/bulig.config.vps.json" "$BULIG_CRED_DIR/config.json"', 'mkdir -p "$R/var/lib/bulig/.bulig"; install -m 0640 "$tk_rel/bulig.config.vps.json" "$R/var/lib/bulig/.bulig/config.json"'),
    ("release: an existing config is overwritten", "release.sh", "release-remote.sh", 'if [ ! -e "$BULIG_CRED_DIR/config.json" ] && [ ! -L "$BULIG_CRED_DIR/config.json" ]; then', "if true; then"),
    ("release: the config is world-readable", "release.sh", "release-remote.sh", 'install -m 0600 "$tk_rel/bulig.config.vps.json"', 'install -m 0644 "$tk_rel/bulig.config.vps.json"'),
    ("release: a rollback leaves the unit files", "release.sh", "release-remote.sh", "  restore_units\n  systemctl daemon-reload\n  systemctl restart", "  systemctl daemon-reload\n  systemctl restart"),
    ("release: a rollback leaves the Node link", "release.sh", "release-remote.sh", '  swap_link "$prev" "$cur"\n', ""),
    ("release: a rollback leaves the tools link", "release.sh", "release-remote.sh", '  if [ -n "$prev_tk" ] && [ -d "$prev_tk" ]; then swap_link "$prev_tk" "$tk_cur"; fi\n', ""),
    ("release: the live sha is not refused", "release.sh", "release-remote.sh", 'if [ "$prev" = "$rel" ]; then', 'if false; then'),
    ("release: the incoming folder is not removed", "release.sh", "release-remote.sh", '  rm -rf "$inc"\n}', "  :\n}"),
    ("release: the work folder is not removed", "release.sh", "release-remote.sh", '  if [ -n "$work" ]; then rm -rf "$work"; fi\n', ""),
    ("release: tools are installed before the build (a refused release leaves them)", "release.sh", "release-remote.sh",
     'chmod -R u=rwX,go=rX "$tools"\n', 'chmod -R u=rwX,go=rX "$tools"\nmkdir -p "$tk_rel" && cp -a "$tools/." "$tk_rel/"\n'),
    ("release: runs from any folder", "release.sh", "release-remote.sh", '[ "$(dirname "$inc")" = "$(cd "$BULIG_CHECKS_DIR" 2>/dev/null && pwd -P || echo none)" ] || die', "true || die"),
    ("release: bad sha accepted", "release.sh", "release-remote.sh", '[[ "$short" =~ ^[0-9a-f]{12}$ ]] || die "odd short sha"', ":"),
    ("release: bad keep count accepted", "release.sh", "release-remote.sh", '[[ "$keep" =~ ^[0-9]+$ ]] || die "odd keep count"', ":"),
    ("release: the Node tree is left unreadable to the service users", "release.sh", "release-remote.sh", 'chmod -R u=rwX,go=rX "$final"', 'chmod -R u=rwX,go-rwx "$final"'),
    ("release: the Node tree is world-writable", "release.sh", "release-remote.sh", 'chmod -R u=rwX,go=rX "$final"', 'chmod -R u=rwX,go=rwX "$final"'),
    ("release: the root tools are left writable by others", "release.sh", "release-remote.sh", 'chmod -R u=rwX,go=rX "$tools"', 'chmod -R u=rwX,go=rwX "$tools"'),
    ("release: the release is built from the build's tree, not a fresh copy", "release.sh", "release-remote.sh",
     '  cp -a "$pristine" "$final"\n', '  mkdir "$final"; tar -x -f "$work/modules.tar" -C "$final"; cp -a "$pristine/." "$final/" 2>/dev/null\n'),
    # ---- setup.sh ----
    ("setup-user: runs while users have processes", "setup.sh", "setup-user.sh", "refuse_if_users_running\n", ""),
    ("setup-cluster: runs while users have processes", "setup.sh", "setup-cluster.sh", "refuse_if_users_running\n", ""),
    ("refuse_if_users_running: ignores the worker", "setup.sh", "lib/common.sh", "for u in $BULIG_USERS; do\n    id", "for u in bulig; do\n    id"),
    ("refuse_if_users_running: ignores the kernel user", "setup.sh", "lib/common.sh", "for u in $BULIG_USERS; do\n    id", "for u in bulig-worker; do\n    id"),
    ("setup-user: creates the homes", "setup.sh", "setup-user.sh", "useradd --system --no-create-home", "useradd --system --create-home"),
    ("setup-user: creates the kernel's home itself", "setup.sh", "setup-user.sh", 'ensure_checks_dir\n', 'ensure_checks_dir\nmkdir -p "$R/var/lib/bulig"\n'),
    ("setup-user: writes a placeholder file", "setup.sh", "setup-user.sh", 'ensure_checks_dir\n', 'ensure_checks_dir\n: >"$BULIG_CRED_DIR/worker-tokens"\n'),
    ("root_dir: chown without -h", "setup.sh", "lib/common.sh", 'chown -h root:root "$path"', 'chown root:root "$path"'),
    ("root_dir: follows a link at the folder", "setup.sh", "lib/common.sh", '  [ ! -L "$path" ] || die "$path is a link. Not touching it."\n', ""),
    ("root_dir: creates a missing parent", "run.sh", "lib/common.sh", '  [ -d "$parent" ] || die "$parent does not exist"\n', '  mkdir -p "$parent"\n'),
    ("root_dir: does not check the parent", "run.sh", "lib/common.sh", '  need_dir "$parent"\n  [ ! -L', '  [ ! -L'),
    ("need_dir: accepts a link", "setup.sh", "lib/common.sh", '[ -d "$d" ] && [ ! -L "$d" ] || die', '[ -d "$d" ] || die'),
    ("need_dir: accepts a user's folder", "run.sh", "lib/common.sh", '  under_user_state "$d" && die', '  false && die'),
    ("need_dir: accepts a parent owned by someone else", "setup.sh", "lib/common.sh", '[ "$owner" = "0" ] || die', 'true || die'),
    ("need_dir: accepts a group-writable parent", "setup.sh", "lib/common.sh", '2 | 3 | 6 | 7) die "$up is writable by its group', '9) die "$up is writable by its group'),
    ("need_dir: accepts a world-writable parent", "setup.sh", "lib/common.sh", '2 | 3 | 6 | 7) die "$up is writable by anyone', '9) die "$up is writable by anyone'),
    ("under_user_state: forgets the worker's home", "run.sh", "lib/common.sh", 'BULIG_USER_STATE_PREFIXES="$R/var/lib/bulig $R/var/lib/bulig-worker"', 'BULIG_USER_STATE_PREFIXES="$R/var/lib/bulig"'),
    ("under_user_state: does not resolve links", "run.sh", "lib/common.sh", '  if [ -d "$p" ]; then resolved="$(cd -P "$p" && pwd)"; fi\n', ""),
    ("cred_write: writes through a link at /etc/bulig", "setup.sh", "lib/common.sh", '  need_dir "$BULIG_CRED_DIR"\n  value="$(cat)"\n  value="${value%$\'\\n\'}"\n  tmp="$(mktemp "$BULIG_CRED_DIR/.${name}', '  value="$(cat)"\n  value="${value%$\'\\n\'}"\n  tmp="$(mktemp "$BULIG_CRED_DIR/.${name}'),
    # ---- run.sh: secrets ----
    ("worker token: the vps worker gets no token of its own", "run.sh", "lib/common.sh", '  if [ "$id" = "vps" ]; then printf', '  if false; then printf'),
    ("worker token: other lines are dropped", "run.sh", "lib/common.sh", 'grep -v "^${id}=" "$file" >"$tmp" || true', ': >"$tmp"'),
    ("worker token: a short token is accepted", "run.sh", "lib/common.sh", "{32,128}", "{1,128}"),
    ("worker token: a worker id with a slash is accepted", "run.sh", "lib/common.sh", "^[a-z][a-z0-9-]{0,31}$", "^[a-z./][a-z0-9./-]{0,31}$"),
    ("worker token: the file is world-readable", "run.sh", "lib/common.sh", '  tmp="$(mktemp "$BULIG_CRED_DIR/.worker-tokens.XXXXXX")"\n  chmod 600 "$tmp"', '  tmp="$(mktemp "$BULIG_CRED_DIR/.worker-tokens.XXXXXX")"\n  chmod 644 "$tmp"'),
    ("worker.env: any variable name accepted", "run.sh", "lib/common.sh", "^BULIG_WORKER_REPOS=--repo", "^[A-Z_]+=--repo"),
    ("worker.env: a clone anywhere accepted", "run.sh", "lib/common.sh", "=/var/lib/bulig-worker/work/[A-Za-z0-9._/-]+(", "=/[A-Za-z0-9._/-]+("),
    ("worker.env: .. accepted", "run.sh", "lib/common.sh", '*..*) die "no .. in a repository path"', '*...*) die "no .. in a repository path"'),
    ("worker.env: more than one line accepted", "run.sh", "lib/common.sh", '  case "$line" in *$\'\\n\'*) die "the value has more than one line" ;; esac\n  [[ "$line"', '  line="${line%%$\'\\n\'*}"\n  [[ "$line"'),
    ("set-secret: a stray argument after --worker-env accepted", "run.sh", "set-secret.sh", 'if [ "$#" -eq 1 ] && [ "$1" = "--worker-env" ]; then', 'if [ "$1" = "--worker-env" ]; then'),
    # ---- cli.sh ----
    ("cli: the folder is not made by systemd", "cli.sh", "bulig-cli.sh", " -p StateDirectory=bulig\n", "\n"),
    ("cli: root writes paths for the user", "cli.sh", "bulig-cli.sh", '-p StateDirectoryMode=0700', '-p StateDirectoryMode=0700 -p ReadWritePaths=/var/lib/bulig'),
    ("cli: the worker gets the database URL", "cli.sh", "bulig-cli.sh", "add_creds claude-token:claude-token worker-token:worker-token", "add_creds claude-token:claude-token worker-token:worker-token pg-url:pg-url"),
    ("cli: the kernel gets the Claude token", "cli.sh", "bulig-cli.sh", "add_creds config:config.json pg-url:pg-url gh-token:gh-token worker-tokens:worker-tokens", "add_creds config:config.json pg-url:pg-url gh-token:gh-token worker-tokens:worker-tokens claude-token:claude-token"),
    ("cli: runs the release's CLI for --exec", "cli.sh", "bulig-cli.sh", '"${spec[@]}" "${creds[@]}" "${common[@]}" -- "$@"', '"${spec[@]}" "${creds[@]}" "${common[@]}" -- /usr/bin/node /opt/bulig/current/packages/cli/bin/bulig.mjs "$@"'),
    ("cli: --tty ignored", "cli.sh", "bulig-cli.sh", "  io_flag=--pty\n", "  io_flag=--pipe\n"),
    ("cli: a missing credential is loaded anyway", "cli.sh", "bulig-cli.sh", 'if [ -e "$BULIG_CRED_DIR/$file" ]; then', "if true; then"),
    ("cli: any role accepted", "cli.sh", "bulig-cli.sh", '  *) die "--as must be kernel or worker" ;;', "  *) spec=() ;;"),
    ("cli: the home is visible", "cli.sh", "bulig-cli.sh", "-p ProtectHome=yes", "-p ProtectHome=no"),
    # ---- units.sh ----
    ("unit: the kernel holds the Claude token", "units.sh", "systemd/bulig.service", "LoadCredential=gh-token:/etc/bulig/gh-token", "LoadCredential=gh-token:/etc/bulig/gh-token\nLoadCredential=claude-token:/etc/bulig/claude-token"),
    ("unit: the worker holds the database URL", "units.sh", "systemd/bulig-worker.service", "LoadCredential=worker-token:/etc/bulig/worker-token", "LoadCredential=worker-token:/etc/bulig/worker-token\nLoadCredential=pg-url:/etc/bulig/pg-url"),
    ("unit: the worker holds the config", "units.sh", "systemd/bulig-worker.service", "LoadCredential=worker-token:/etc/bulig/worker-token", "LoadCredential=worker-token:/etc/bulig/worker-token\nLoadCredential=config:/etc/bulig/config.json"),
    ("unit: the kernel unit lost its config credential", "units.sh", "systemd/bulig.service", "LoadCredential=config:/etc/bulig/config.json\n", ""),
    ("unit: the kernel's memory cap changed", "units.sh", "systemd/bulig.service", "MemoryMax=1G", "MemoryMax=4G"),
    ("unit: the worker's task cap changed", "units.sh", "systemd/bulig-worker.service", "TasksMax=512", "TasksMax=256"),
    ("unit: the worker's CPU cap changed", "units.sh", "systemd/bulig-worker.service", "CPUQuota=250%", "CPUQuota=400%"),
    ("unit: the home is visible to the kernel", "units.sh", "systemd/bulig.service", "ProtectHome=yes", "ProtectHome=no"),
    ("unit: the kernel unit gets a writable path of its own", "units.sh", "systemd/bulig.service", "\nProtectSystem=strict\n", "\nProtectSystem=strict\nReadWritePaths=/var/lib/bulig\n"),
    ("unit: the kernel's folder is not 0700", "units.sh", "systemd/bulig.service", "StateDirectoryMode=0700", "StateDirectoryMode=0750"),
    ("unit: the worker's folder is group-readable", "units.sh", "systemd/bulig-worker.service", "StateDirectoryMode=0700", "StateDirectoryMode=0755"),
    ("unit: a flag the worker CLI does not have", "units.sh", "systemd/bulig-worker.service", "--work-dir %S/bulig-worker/work --slots 2", "--work-dir %S/bulig-worker/work --slots 2 --config /etc/bulig/config.json"),
    ("unit: the worker's repos are not read", "units.sh", "systemd/bulig-worker.service", "--slots 2 $BULIG_WORKER_REPOS\n", "--slots 2\n"),
    ("unit: the worker runs as the kernel user", "units.sh", "systemd/bulig-worker.service", "User=bulig-worker", "User=bulig"),
    ("unit: the backup runs code from the Node release", "units.sh", "systemd/bulig-backup.service", "ExecStart=/usr/local/lib/bulig/current/backup-postgres.sh", "ExecStart=/opt/bulig/current/backup-postgres.sh"),
    ("unit: the config template enables Telegram", "units.sh", "bulig.config.vps.json", '"enabled": [\n    "channel-cli",', '"enabled": [\n    "channel-telegram",\n    "channel-cli",'),
    ("unit: the config template reads the URL from the environment only", "units.sh", "bulig.config.vps.json", '"urlCredential": "pg-url"', '"urlEnv2": "x"'),
    ("unit: the gateway listens on 0.0.0.0", "units.sh", "bulig.config.vps.json", '"127.74.3.1"\n      ]', '"0.0.0.0"\n      ]'),
    # ---- units.sh / release.sh / cli.sh: what each unit can reach ----
    ("net: the kernel unit has no IP filter", "units.sh", "systemd/bulig.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7\n", ""),
    ("net: the kernel unit lets 127.0.0.1 through", "units.sh", "systemd/bulig.service", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32 100.64.0.0/10", "IPAddressAllow=127.74.3.1/32 127.0.0.1/32 127.0.0.53/32 100.64.0.0/10"),
    ("net: the kernel unit denies Tailscale", "units.sh", "systemd/bulig.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"),
    ("net: the kernel unit no longer allows its gateway address", "units.sh", "systemd/bulig.service", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32 100.64.0.0/10", "IPAddressAllow=127.0.0.53/32 100.64.0.0/10"),
    ("net: the kernel unit lets the docker bridge through", "units.sh", "systemd/bulig.service", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32 100.64.0.0/10", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32 100.64.0.0/10 172.17.0.1/32"),
    ("net: the kernel unit does not require the gateway address", "units.sh", "systemd/bulig.service", "Requires=bulig-loopback.service\n", ""),
    ("net: the worker unit has no IP filter", "units.sh", "systemd/bulig-worker.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7\n", ""),
    ("net: the worker unit can reach Tailscale", "units.sh", "systemd/bulig-worker.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7"),
    ("net: the worker unit lets 127.0.0.1 through", "units.sh", "systemd/bulig-worker.service", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32", "IPAddressAllow=127.0.0.1/32 127.0.0.53/32"),
    ("net: the worker unit lets all of localhost through", "units.sh", "systemd/bulig-worker.service", "IPAddressAllow=127.74.3.1/32 127.0.0.53/32", "IPAddressAllow=localhost 127.0.0.53/32"),
    ("net: the worker connects to 127.0.0.1", "units.sh", "systemd/bulig-worker.service", "--kernel http://127.74.3.1:7431", "--kernel http://127.0.0.1:7431"),
    ("net: the backup unit has no IP filter", "units.sh", "systemd/bulig-backup.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7\n", ""),
    ("net: the backup unit lets the docker bridge through", "units.sh", "systemd/bulig-backup.service", "IPAddressAllow=127.0.0.53/32", "IPAddressAllow=127.0.0.53/32 172.17.0.1/32"),
    ("net: the backup unit loses DOCKER_CONFIG", "units.sh", "systemd/bulig-backup.service", "Environment=DOCKER_CONFIG=/var/lib/bulig-checks/docker\n", ""),
    ("net: the drill unit has no IP filter", "units.sh", "systemd/bulig-restore-drill.service", "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7\n", ""),
    ("net: the drill unit lets 127.0.0.1 through", "units.sh", "systemd/bulig-restore-drill.service", "IPAddressAllow=127.0.0.53/32", "IPAddressAllow=127.0.0.53/32 127.0.0.1/32"),
    ("net: the drill unit loses DOCKER_CONFIG", "units.sh", "systemd/bulig-restore-drill.service", "Environment=DOCKER_CONFIG=/var/lib/bulig-checks/docker\n", ""),
    ("net: the loopback unit can send IP packets", "units.sh", "systemd/bulig-loopback.service", "IPAddressDeny=any\n", ""),
    ("net: the loopback unit adds another address", "units.sh", "systemd/bulig-loopback.service", "ExecStart=/usr/bin/ip address replace 127.74.3.1/32 dev lo", "ExecStart=/usr/bin/ip address replace 127.0.0.1/32 dev lo"),
    ("net: the loopback unit leaves the address behind", "units.sh", "systemd/bulig-loopback.service", "ExecStop=/usr/bin/ip address del 127.74.3.1/32 dev lo\n", ""),
    ("net: the template listens on 127.0.0.1", "units.sh", "bulig.config.vps.json", '"127.74.3.1"\n      ]', '"127.0.0.1"\n      ]'),
    ("net: the release build has no IP deny list", "release.sh", "release-remote.sh", '    -p "IPAddressDeny=$BULIG_IP_DENY_PRIVATE" -p "IPAddressAllow=$BULIG_IP_ALLOW_DNS" \\\n', ""),
    ("net: the release build lets 127.0.0.1 through", "release.sh", "release-remote.sh", '-p "IPAddressAllow=$BULIG_IP_ALLOW_DNS"', '-p "IPAddressAllow=$BULIG_IP_ALLOW_DNS 127.0.0.1/32"'),
    ("net: the release build may reach Tailscale", "release.sh", "release-remote.sh", '-p "IPAddressDeny=$BULIG_IP_DENY_PRIVATE"', '-p "IPAddressDeny=$BULIG_IP_DENY_KERNEL"'),
    ("net: the release does not start the gateway address", "release.sh", "release-remote.sh", "  systemctl start bulig-loopback.service || return 1\n", ""),
    ("net: the deny list lost link-local (common.sh)", "release.sh", "lib/common.sh", 'BULIG_IP_DENY_PRIVATE="localhost link-local multicast', 'BULIG_IP_DENY_PRIVATE="localhost multicast'),
    ("net: bulig-cli kernel has no IP filter", "cli.sh", "bulig-cli.sh", '      -p "IPAddressDeny=$BULIG_IP_DENY_KERNEL" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32 $BULIG_IP_ALLOW_DNS 100.64.0.0/10"', ""),
    ("net: bulig-cli worker has no IP filter", "cli.sh", "bulig-cli.sh", '      -p "IPAddressDeny=$BULIG_IP_DENY_PRIVATE" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32 $BULIG_IP_ALLOW_DNS"', ""),
    ("net: bulig-cli worker can reach Tailscale", "cli.sh", "bulig-cli.sh", '-p "IPAddressDeny=$BULIG_IP_DENY_PRIVATE" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32 $BULIG_IP_ALLOW_DNS"', '-p "IPAddressDeny=$BULIG_IP_DENY_KERNEL" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32 $BULIG_IP_ALLOW_DNS"'),
    ("setup: no docker config folder for the backup units", "setup.sh", "setup-user.sh", 'root_dir 0700 "$BULIG_CHECKS_DIR/docker"\n', ""),
    # ---- cluster.sh / run.sh / drill.sh: Postgres over the socket ----
    ("pg: the cluster listens on localhost", "cluster.sh", "setup-cluster.sh", "listen_addresses = ''", "listen_addresses = 'localhost'"),
    ("pg: a TCP rule in the hba file", "cluster.sh", "setup-cluster.sh", "local   all       bulig_drill               scram-sha-256\n", "local   all       bulig_drill               scram-sha-256\nhost    all       all       127.0.0.1/32    scram-sha-256\n"),
    ("pg: the hba file is not used", "cluster.sh", "setup-cluster.sh", "hba_file = '/etc/postgresql/$BULIG_PG_VERSION/$BULIG_PG_CLUSTER/bulig_hba.conf'\n", ""),
    ("pg: bulig logs in by trust", "cluster.sh", "setup-cluster.sh", "local   bulig     bulig                     scram-sha-256", "local   bulig     bulig                     trust"),
    ("pg: the URL has a TCP host", "cluster.sh", "setup-cluster.sh", "'postgres://bulig:%s@%%2Fvar%%2Frun%%2Fpostgresql:%s/bulig'", "'postgres://bulig:%s@127.0.0.1:%s/bulig'"),
    ("pg: the login test goes over TCP", "cluster.sh", "setup-cluster.sh", '-h "$BULIG_PG_HOST" -p "$BULIG_PG_PORT" -U bulig -d bulig -tA -c "SELECT 1"', '-h 127.0.0.1 -p "$BULIG_PG_PORT" -U bulig -d bulig -tA -c "SELECT 1"'),
    ("pg: the config is written straight into the folder", "cluster.sh", "setup-cluster.sh", '  printf \'%s\' "$want_conf" | install_root_file "$conf_d/bulig.conf"', '  printf \'%s\' "$want_conf" >"$conf_d/bulig.conf"'),
    ("pg: install_root_file is not root-owned", "cluster.sh", "lib/common.sh", "install -o root -g root -m 0644", "install -m 0644"),
    ("pg: install_root_file renames with plain mv", "cluster.sh", "lib/common.sh", '  mv -T "$new" "$dest"', '  mv "$new" "$dest"'),
    ("pg: install_root_file follows a link at the target", "cluster.sh", "lib/common.sh", '  [ ! -L "$dest" ] || die "$dest is a link. Not touching it."\n  ensure_checks_dir', "  ensure_checks_dir"),
    ("pg: install_root_file does not look again before the rename", "cluster.sh", "lib/common.sh", '  if [ -L "$dest" ]; then\n    rm -f "$new"', '  if false; then\n    rm -f "$new"'),
    ("pg: install_root_file accepts a link as the folder", "cluster.sh", "lib/common.sh", '  [ -d "$dir" ] && [ ! -L "$dir" ] || die "$dir is missing (or is a link)"\n  under_user_state "$dir" && die "$dir is inside a Bulig user\'s folder. Root never works there."\n  [ ! -L "$dest" ]', '  under_user_state "$dir" && die "$dir is inside a Bulig user\'s folder. Root never works there."\n  [ ! -L "$dest" ]'),
    ("pg: install_root_file works inside a user's folder", "cluster.sh", "lib/common.sh", '  under_user_state "$dir" && die "$dir is inside a Bulig user\'s folder. Root never works there."\n  [ ! -L "$dest" ] || die "$dest is a link', '  [ ! -L "$dest" ] || die "$dest is a link'),
    ("pg: setup-cluster rewrites unchanged config", "cluster.sh", "setup-cluster.sh", 'if [ "$(cat "$hba_file" 2>/dev/null || true)" != "${want_hba%$\'\\n\'}" ]; then', "if true; then"),
    ("pg: the passfile keeps a socket path as the host", "run.sh", "lib/common.sh", "  case \"$host\" in %2[Ff]* | /*) host=localhost ;; esac\n", ""),
    ("pg: the backup connects over 127.0.0.1", "drill.sh", "backup-postgres.sh", '-h "$BULIG_PG_HOST"', "-h 127.0.0.1"),
    ("pg: the drill passfile line is for 127.0.0.1", "drill.sh", "restore-drill.sh", "printf 'localhost:%s:*:bulig_drill:%s\\n'", "printf '127.0.0.1:%s:*:bulig_drill:%s\\n'"),
    ("pg: the drill connects over 127.0.0.1", "drill.sh", "restore-drill.sh", 'pg_args=(-w -h "$BULIG_PG_HOST"', "pg_args=(-w -h 127.0.0.1"),
    ("drill: table names are not quoted by the server", "drill.sh", "restore-drill.sh", "SELECT format('%I.%I', table_schema, table_name) FROM", "SELECT table_name FROM"),
    ("drill: database names are not quoted by the server", "drill.sh", "restore-drill.sh", "SELECT format('%I', d.datname) FROM", "SELECT d.datname FROM"),
    ("drill: a table name with a control character is not refused", "drill.sh", "restore-drill.sh", "table_name ~ '[[:cntrl:]]'", "table_name ~ '^$'"),
    ("drill: tables are split on spaces and globs", "drill.sh", "restore-drill.sh", 'while IFS= read -r t; do\n  [ -n "$t" ] || continue\n', 'for t in $scratch_tables; do\n'),
    ("drill: the scratch table loop ends differently", "drill.sh", "restore-drill.sh", 'done <<<"$scratch_tables"', "done"),
    # ---- setup.sh: no user lookups ----
    ("setup-user: looks the home up again", "setup.sh", "setup-user.sh", '    echo "user $name: already there"', '    echo "user $name: already there ($(getent passwd "$name" | cut -d: -f6))"'),
    # ---- invariant.sh: the checker itself ----
    ("checker: redirects are not looked at", "invariant.sh", "test/invariant.py", "        if hits(r, env):\n            rep.add(path, lineno, \"redirect\"", "        if False:\n            rep.add(path, lineno, \"redirect\""),
    ("checker: variables are not expanded", "invariant.sh", "test/invariant.py", "    for e in expand(token, env):\n        if FORBIDDEN.search(e):\n            return True\n    return False", "    return bool(FORBIDDEN.search(token))"),
    ("checker: chown without -h allowed", "invariant.sh", "test/invariant.py", 'if not any(re.match(r"^-[A-Za-z]*h", a) or a == "--no-dereference" for a in flat):', "if False:"),
    ("checker: useradd --create-home allowed", "invariant.sh", "test/invariant.py", 'if any(a in ("--create-home", "-m") or re.match(r"^-[A-Za-z]*m[A-Za-z]*$", a) for a in args):', "if False:"),
    ("checker: no helper function is known as read-only", "invariant.sh", "test/invariant.py", "analyse_line(path, n, line, env, writer_funcs, rep, frozenset(funcs) - writer_funcs)", "analyse_line(path, n, line, env, writer_funcs, rep, frozenset())"),
    ("checker: unknown commands are treated as read-only", "invariant.sh", "test/invariant.py", "        if cmd in known_funcs or cmd in READ_ONLY:\n            continue\n        checked.append((cmd, args))", "        continue"),
    ("checker: the list piped into xargs is not looked at", "invariant.sh", "test/invariant.py", 'if any(c == "xargs" for c, _ in checked):', "if False:"),
    ("checker: find with -exec is treated as read-only", "invariant.sh", "test/invariant.py", "            if any(a in FIND_WRITES for a in args):", "            if False:"),
    ("checker: find -exec on a parent is allowed", "invariant.sh", "test/invariant.py", "recursive = any(RECURSIVE_FLAGS.match(a) or a in FIND_WRITES for a in args)", "recursive = any(RECURSIVE_FLAGS.match(a) for a in args)"),
    ("checker: docker mounts are not looked at", "invariant.sh", "test/invariant.py", "        if cmd in DOCKER:", "        if False:"),
    ("checker: getent lookups are allowed", "invariant.sh", "test/invariant.py", 'if cmd == "getent" and len(', 'if False and len('),
    ("checker: eval is allowed", "invariant.sh", "test/invariant.py", 'if cmd == "eval":', "if False:"),
    ("checker: ~bulig is not a forbidden name", "invariant.sh", "test/invariant.py", '|~bulig(?:-worker)?(?![A-Za-z0-9_.\\-]))"', ')"'),
    ("checker: for-loop lists are read as commands", "invariant.sh", "test/invariant.py", 'cmd in ("for", "case", "select", "in", "function")', 'cmd in ("case", "select", "in", "function")'),
    ("checker: units are not read", "invariant.sh", "test/invariant.py", "        check_unit(path, text, rep)", "        pass"),
    ("checker: the missing-StateDirectory rule is gone", "invariant.sh", "test/invariant.py", "        if user not in sd:", "        if False:"),
    ("checker: a recursive write on a parent is allowed", "invariant.sh", "test/invariant.py", "        if recursive:\n            for a in args:", "        if False:\n            for a in args:"),
    ("checker: the user folders pattern lost the worker", "invariant.sh", "test/invariant.py", "/var/lib/bulig(?:-worker)?(?![A-Za-z0-9_.\\-])|/home/bulig", "/var/lib/bulig(?![A-Za-z0-9_.\\-])|/home/bulig"),
    ("checker: a transient unit run as root is skipped", "invariant.sh", "test/invariant.py", '            checked.append((cmd, args))\n            continue\n        if cmd == "find":', '            continue\n        if cmd == "find":'),
    ("checker: heredocs are not skipped", "invariant.sh", "test/invariant.py", "        for groups in marker:", "        for groups in []:"),
    ("checker: continuation lines are not joined", "invariant.sh", "test/invariant.py", "        while True:\n            if cur.endswith", "        while False:\n            if cur.endswith"),
]


def run(entry, src):
    name, suite, rel, old, new = entry
    tmp = tempfile.mkdtemp(prefix="bulig-mut-")
    try:
        dst = os.path.join(tmp, "deploy")
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
        path = os.path.join(dst, rel)
        text = open(path).read()
        if text.count(old) != 1:
            return name, "BAD-MUTATION", f"{rel}: the text to change was found {text.count(old)} times"
        open(path, "w").write(text.replace(old, new))
        try:
            r = subprocess.run(["bash", os.path.join(dst, "test", suite)], capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL, env=dict(os.environ, BULIG_TEST_ONLY_THIS_FILE="1"))
        except subprocess.TimeoutExpired:
            return name, "KILLED", "timeout"
        if r.returncode == 0:
            return name, "SURVIVED", ""
        failed = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("FAIL")]
        return name, "KILLED", (failed[0][:110] if failed else r.stdout.strip().splitlines()[-1][:110] if r.stdout.strip() else r.stderr.strip()[:110])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    src = os.path.abspath(sys.argv[1])
    flt = sys.argv[2] if len(sys.argv) > 2 else ""
    todo = [m for m in M if flt in m[0] or flt in m[1]]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for res in ex.map(lambda e: run(e, src), todo):
            results.append(res)
            print(f"{res[1]:13} {res[0]}" + (f"   <- {res[2]}" if res[1] != "KILLED" or "-v" in sys.argv else ""), flush=True)
    killed = sum(1 for r in results if r[1] == "KILLED")
    print(f"\nmutations: {len(results)}, killed {killed}, survived {sum(1 for r in results if r[1] == 'SURVIVED')}, bad {sum(1 for r in results if r[1] == 'BAD-MUTATION')}")
    return 0 if killed == len(results) else 1


sys.exit(main())

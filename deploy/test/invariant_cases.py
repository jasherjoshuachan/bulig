"""Cases for the invariant checker: the real kit must pass; each of these edits, made in memory to ONE file, must be caught (or, for
"fine" cases, must not be). Prints "ok <label>" or "FAIL <label>: <why>" per case, for invariant.sh to count.

    python3 -I deploy/test/invariant_cases.py <deploy dir>
"""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import invariant  # noqa: E402

BAD = [
    # (label, rule the report must name, file, text appended on new lines)
    ("install -d into the kernel's home", "write", "setup-user.sh", "install -d -m 0700 -o bulig -g bulig /var/lib/bulig"),
    ("mkdir in the worker's home", "write", "setup-user.sh", "mkdir -p /var/lib/bulig-worker/work"),
    ("chown -h of a path in the kernel's home", "write", "setup-user.sh", "chown -h bulig:bulig /var/lib/bulig/state"),
    ("chmod of the worker's home", "write", "setup-user.sh", "chmod 0700 /var/lib/bulig-worker"),
    ("a redirect into the kernel's home", "redirect", "release-remote.sh", 'echo "{}" > /var/lib/bulig/.bulig/config.json'),
    ("an append redirect into the worker's home", "redirect", "release-remote.sh", "echo x >> /var/lib/bulig-worker/log"),
    ("install of the config into a user's folder (the first kit's bug), by variable", "write", "release-remote.sh",
     'VAR="$R/var/lib/bulig"\ninstall -m 0640 "$tk_rel/bulig.config.vps.json" "$VAR/.bulig/config.json"'),
    ("a variable with a default naming the folder", "write", "release-remote.sh", 'cp x "${HOME_DIR:-/var/lib/bulig}/f"'),
    ("a variable that goes through two assignments", "write", "release-remote.sh", 'a=/var/lib/bulig-worker\nb="$a/work"\nrm -rf "$b/old"'),
    ("rm -rf in the worker's clones", "write", "release-remote.sh", "rm -rf /var/lib/bulig-worker/work/old"),
    ("mv out of the kernel's home", "write", "release-remote.sh", "mv /var/lib/bulig/state/x /var/lib/bulig-checks/x"),
    ("ln into the kernel's home", "write", "release-remote.sh", "ln -s /opt/bulig/current /var/lib/bulig/current"),
    ("tee into the kernel's home", "write", "release-remote.sh", "echo x | tee /var/lib/bulig/f"),
    ("touch", "write", "release-remote.sh", "touch /var/lib/bulig/state/.ready"),
    ("sed -i", "write", "release-remote.sh", "sed -i s/a/b/ /var/lib/bulig/.bulig/config.json"),
    ("a line continued with a backslash", "write", "release-remote.sh", "install -d \\\n  -m 0700 \\\n  /var/lib/bulig/x"),
    ("a heredoc written into the folder", "redirect", "release-remote.sh", "cat >/var/lib/bulig/x <<EOT\nbody\nEOT"),
    ("find -delete in the kernel's home", "write", "release-remote.sh", 'find /var/lib/bulig -name "*.tmp" -delete'),
    ("xargs rm on a listing of the home", "write", "release-remote.sh", "ls /var/lib/bulig | xargs rm"),
    ("tar -x into the worker's home", "write", "release-remote.sh", "tar -x -f x.tar -C /var/lib/bulig-worker"),
    ("git clone into the worker's home (a root git would run its hooks there)", "write", "release-remote.sh", "git clone https://example.invalid/r /var/lib/bulig-worker/work/r"),
    ("a helper function that writes, called with the folder", "write", "setup-user.sh", "root_dir 0755 /var/lib/bulig-worker/work"),
    ("a helper called with a variable name that used to exist", "write", "setup-user.sh", 'root_dir 0700 "$BULIG_HOME"'),
    ("a recursive chmod on /var/lib", "recursive", "release-remote.sh", "chmod -R go-w /var/lib"),
    ("a recursive rm on /var", "recursive", "release-remote.sh", "rm -rf /var"),
    ("a recursive chown on a parent", "chown-recursive", "release-remote.sh", "chown -hR root:root /var/lib"),
    ("chown without -h", "chown-no-h", "release-remote.sh", 'chown root:root "$final"'),
    ("useradd that creates the home", "create-home", "setup-user.sh", "useradd --system --create-home --home-dir /var/lib/bulig bulig"),
    ("useradd -m", "create-home", "setup-user.sh", "useradd -m --system bulig"),
    ("a root transient unit that can write the folder", "write", "release-remote.sh", "systemd-run --pipe -p ReadWritePaths=/var/lib/bulig -- touch x"),
    ("a new script of its own that writes into the kernel's home", "write", "new-script.sh", "#!/usr/bin/env bash\ncp a /var/lib/bulig/a"),
]

# (label, rule, unit file, old text, new text)
UNITS = [
    ("the kernel unit without its StateDirectory", "state-directory", "systemd/bulig.service", "StateDirectory=bulig\n", ""),
    ("the worker unit without its StateDirectory", "state-directory", "systemd/bulig-worker.service", "StateDirectory=bulig-worker\n", ""),
    ("a root-privileged ExecStartPre in the kernel unit", "privileged-exec", "systemd/bulig.service", "ExecStart=/usr/bin/node",
     "ExecStartPre=+/usr/bin/install -d /var/lib/bulig/x\nExecStart=/usr/bin/node"),
    ("a root-privileged ExecStartPre in the worker unit", "privileged-exec", "systemd/bulig-worker.service", "ExecStart=/usr/bin/node",
     "ExecStartPre=!/bin/true\nExecStart=/usr/bin/node"),
    ("a root unit (the backup) that can write the kernel's home", "root-unit", "systemd/bulig-backup.service",
     "ReadWritePaths=/var/backups/bulig", "ReadWritePaths=/var/backups/bulig /var/lib/bulig"),
    ("a root unit (the drill) that names the worker's home", "root-unit", "systemd/bulig-restore-drill.service",
     "ReadWritePaths=/var/lib/bulig-checks", "ReadWritePaths=/var/lib/bulig-worker"),
]

FINE = [
    ("a write under /var/lib/bulig-checks", "release-remote.sh", "install -d -m 0700 /var/lib/bulig-checks/x"),
    ("rm -rf under /var/lib/bulig-checks", "release-remote.sh", "rm -rf /var/lib/bulig-checks/old"),
    ("a message that names the folder", "release-remote.sh", 'echo "systemd makes /var/lib/bulig" >&2'),
    ("a comment that names the folder", "release-remote.sh", "# root never writes to /var/lib/bulig-worker/work"),
    ("a transient unit that runs AS the user (the user writes, not root)", "release-remote.sh", "systemd-run --uid=bulig -p ReadWritePaths=/var/lib/bulig -- touch /var/lib/bulig/x"),
    ("a command run through runuser", "release-remote.sh", "runuser -u bulig-worker -- mkdir -p /var/lib/bulig-worker/work"),
    ("a read of the folder", "release-remote.sh", "test -d /var/lib/bulig && ls /var/lib/bulig-worker >/dev/null"),
    ("a root-owned path whose name starts like the home", "release-remote.sh", "mkdir -p /var/lib/bulig-checks-extra"),
    ("useradd that only records the home", "setup-user.sh", "useradd --system --no-create-home --home-dir /var/lib/bulig bulig"),
    ("chown -h", "release-remote.sh", 'chown -h root:root "$final"'),
    ("a heredoc whose BODY looks like a write (it is text, not a command)", "release-remote.sh", "cat <<'EOT'\ninstall -d /var/lib/bulig/x\nrm -rf /var/lib/bulig-worker\nEOT"),
    ("a quoted multi-line string that names the folder", "release-remote.sh", 'msg="first line\nsystemd makes /var/lib/bulig"'),
]


def main():
    root = sys.argv[1]
    scripts, units = invariant.load(root)
    base = invariant.analyse(scripts, units)
    print(("ok" if not base.violations else "FAIL") + " the real kit has no violations" + ("" if not base.violations else ": " + "; ".join(base.violations[:3])))
    print(("ok" if base.writers >= 100 else "FAIL") + f" the checker found {base.writers} writing statements and {base.writer_funcs} writing helpers in the real kit")

    def run(new_scripts, new_units):
        return invariant.analyse(new_scripts, new_units)

    for label, rule, fname, text in BAD:
        names = [n for n, _ in scripts]
        if fname in names:
            mutated = [(n, t + "\n" + text + "\n" if n == fname else t) for n, t in scripts]
        else:
            mutated = scripts + [(fname, text + "\n")]
        rep = run(mutated, units)
        got = [v for v in rep.violations if f"[{rule}]" in v]
        print(("ok" if got else "FAIL") + f" caught: {label}" + ("" if got else f" (wanted [{rule}], got {rep.violations[:2]})"))
    for label, rule, fname, old, new in UNITS:
        found = [t for n, t in units if n == fname]
        if not found or old not in found[0]:
            print(f"FAIL caught: {label} (could not find the text to change in {fname})")
            continue
        mutated = [(n, t.replace(old, new, 1) if n == fname else t) for n, t in units]
        rep = run(scripts, mutated)
        got = [v for v in rep.violations if f"[{rule}]" in v]
        print(("ok" if got else "FAIL") + f" caught: {label}" + ("" if got else f" (wanted [{rule}], got {rep.violations[:2]})"))
    for label, fname, text in FINE:
        mutated = [(n, t + "\n" + text + "\n" if n == fname else t) for n, t in scripts]
        rep = run(mutated, units)
        print(("ok" if not rep.violations else "FAIL") + f" not flagged: {label}" + ("" if not rep.violations else f" ({rep.violations[:2]})"))


main()

"""The invariant checker for the Bulig deploy kit.

    python3 -I deploy/test/invariant.py <deploy dir>

THE INVARIANT: root never creates, writes, chmods, chowns or deletes any path whose parent directory (at any level) is owned by or
writable by bulig or bulig-worker. Everything root manages lives under root-owned parents. The folders of the two users,
/var/lib/bulig and /var/lib/bulig-worker, are made only by systemd (StateDirectory=).

This reads every script root runs (every *.sh under the deploy dir except test/) and every unit file, and fails when it finds:
  - a write, chmod, chown, remove, install, mkdir, copy, move, link, tee, sed -i, truncate, rsync, mktemp, touch, tar, git or redirect whose
    target is /var/lib/bulig or /var/lib/bulig-worker (or anything below them), after variables are expanded;
  - a call to one of the scripts' own helper functions that write, with such a path as an argument;
  - a recursive write (-R, -r, -delete) on /, /var or /var/lib, which would reach them;
  - a chown without -h, or with -R (a swapped link would be followed);
  - useradd with --create-home (systemd makes the homes);
  - a systemd-run that runs as root (no --uid=bulig*, no DynamicUser) and names such a path;
  - in a unit: a root unit that names such a path, a Bulig unit without its StateDirectory=, or a root-privileged helper (ExecStartPre=+).
It reads text, so it cannot see a path built at run time. deploy/test/release.sh and setup.sh check the real behaviour against fake
user folders for that.
"""

import functools
import os
import re
import shlex
import sys

FORBIDDEN = re.compile(r"(?:/var/lib/bulig(?:-worker)?(?![A-Za-z0-9_.\-])|/home/bulig(?:-worker)?(?![A-Za-z0-9_.\-])|~bulig(?:-worker)?(?![A-Za-z0-9_.\-]))")
# Variable names that stand for a user's folder. None is defined in the kit; a script that brings one back is caught here.
FORBIDDEN_VARS = re.compile(r"\$\{?(BULIG_HOME|BULIG_WORKER_HOME|BULIG_REPOS_DIR|BULIG_WORKER_WORK_DIR|BULIG_STATE_DIR|BULIG_WORKER_STATE_DIR)\b")
ANCESTORS = {"/", "/var", "/var/lib"}

# Commands that hand the rest of the line to another user: what follows is not a root write.
USER_WRAPPERS = {"runuser", "setpriv", "su"}
PREFIX_WORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "fi", "done", "esac"}
PREFIX_CMDS = {"env", "command", "exec", "sudo", "nice", "ionice", "nohup", "builtin"}
DECL = {"local", "export", "readonly", "declare", "typeset"}
SEPARATORS = re.compile(r"^[;&|()]+$")
REDIRECT = re.compile(r"^(?:[0-9]*|&)>{1,2}[&|]?$")
RECURSIVE_FLAGS = re.compile(r"^-[A-Za-z]*[Rr][A-Za-z]*$|^--recursive$")


class Report:
    def __init__(self):
        self.violations = []
        self.files = 0
        self.writers = 0

    def add(self, path, line, rule, text):
        self.violations.append(f"{path}:{line}: [{rule}] {text.strip()[:200]}")


@functools.lru_cache(maxsize=None)
def _unbalanced(line):
    try:
        shlex.split(line, comments=True)
        return False
    except ValueError:
        return True


@functools.lru_cache(maxsize=None)
def logical_lines(text):
    """Return ((line number, joined text), ...) for each shell statement: continuations and quoted multi-line strings joined, heredoc bodies and comments dropped."""
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        start = i
        cur = lines[i]
        i += 1
        stripped = cur.strip()
        if not stripped or stripped.startswith("#"):
            continue
        while True:
            if cur.endswith("\\") and i < len(lines):
                cur = cur[:-1] + " " + lines[i]
                i += 1
                continue
            if _unbalanced(cur) and i < len(lines) and i - start <= 40:
                cur = cur + "\n" + lines[i]
                i += 1
                continue
            break
        marker = re.findall(r"<<-?\s*(?:'([A-Za-z0-9_]+)'|\"([A-Za-z0-9_]+)\"|([A-Za-z0-9_]+))", cur)
        for groups in marker:
            term = next(g for g in groups if g)
            while i < len(lines) and lines[i].strip() != term:
                i += 1
            i += 1
        out.append((start + 1, cur))
    return tuple(out)


@functools.lru_cache(maxsize=None)
def tokens(line):
    lex = shlex.shlex(line, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    try:
        return tuple(lex)
    except ValueError:
        return tuple(line.split())


def segments(toks):
    """Split a token list into simple commands. Returns a list of (tokens, redirect targets)."""
    out, cur, redirects = [], [], []
    i = 0
    while i < len(toks):
        t = toks[i]
        if REDIRECT.match(t) and ">" in t:
            if i + 1 < len(toks):
                nxt = toks[i + 1]
                if not (t.endswith("&") and (nxt.isdigit() or nxt == "-")):
                    redirects.append(nxt)
                i += 2
                continue
        if t in ("<", "<<", "<<<", "<&") and i + 1 < len(toks):
            i += 2
            continue
        if SEPARATORS.match(t):
            if cur:
                out.append(cur)
            cur = []
            i += 1
            continue
        cur.append(t)
        i += 1
    if cur:
        out.append(cur)
    return out, redirects


ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)


def collect_assignments(files):
    env = {}
    for _, text in files:
        for _, line in logical_lines(text):
            segs, _ = segments(tokens(line))
            for seg in segs:
                k = 0
                while k < len(seg) and (seg[k] in PREFIX_WORDS or seg[k] in DECL):
                    k += 1
                while k < len(seg):
                    m = ASSIGN.match(seg[k])
                    if not m:
                        break
                    env.setdefault(m.group(1), set()).add(m.group(2))
                    k += 1
    return env


VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=+?])([^}]*))?[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def expand(s, env, depth=0):
    """All values a string can take once variables are replaced (unknown variables become empty). Small sets only."""
    results = {s}
    for _ in range(6):
        nxt = set()
        changed = False
        for r in results:
            m = VAR.search(r)
            if not m:
                nxt.add(r)
                continue
            changed = True
            name = m.group(1) or m.group(4)
            options = set(env.get(name, {""})) or {""}
            if m.group(2) and m.group(3) is not None and m.group(2).lstrip(":") in ("-", "="):
                options = options | {m.group(3)}
            for v in list(options)[:8]:
                nxt.add(r[: m.start()] + v + r[m.end():])
        results = set(list(nxt)[:64])
        if not changed:
            break
    return results


def hits(token, env):
    if FORBIDDEN_VARS.search(token):
        return True
    for e in expand(token, env):
        if FORBIDDEN.search(e):
            return True
    return False


def is_ancestor(token, env):
    for e in expand(token, env):
        if e.rstrip("/") in ANCESTORS or e == "/":
            return True
    return False


def command_of(seg):
    """The command name and its arguments, after reserved words, assignments, declarations and wrappers like env."""
    k = 0
    while k < len(seg):
        t = seg[k]
        if t in PREFIX_WORDS or t in DECL or ASSIGN.match(t) or t in PREFIX_CMDS:
            k += 1
            continue
        break
    if k >= len(seg):
        return None, []
    return os.path.basename(seg[k]), seg[k + 1:]


def functions(files):
    """Names of the shell functions defined in the kit, with the lines of their bodies (by matching indent)."""
    funcs = {}
    for path, text in files:
        lines = text.split("\n")
        for idx, l in enumerate(lines):
            m = re.match(r"^(\s*)(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{(.*)$", l)
            if not m:
                continue
            indent, name, rest = m.groups()
            if "}" in rest and not rest.strip().endswith("{"):
                funcs[name] = [rest]
                continue
            body = [rest]
            j = idx + 1
            while j < len(lines) and not re.match(rf"^{indent}\}}\s*$", lines[j]):
                body.append(lines[j])
                j += 1
            funcs[name] = body
    return funcs


READ_ONLY = {
    "echo", "printf", "die", "ok", "bad", "test", "[", "[[", "ls", "cat", "stat", "readlink", "realpath", "grep", "egrep", "fgrep", "head", "tail",
    "wc", "id", "pgrep", "diff", "cmp", "sort", "uniq", "cut", "tr", "basename", "dirname", "date", "sleep", "seq", "true", "false", "exit",
    "return", "cd", "pwd", "read", "shift", "set", "unset", "export", "local", "declare", "trap", "type", "hash", "wait", "sha256sum", "shasum",
    "cksum", "du", "df", ".", "source", ":", "break", "continue", "ss", "pg_lsclusters", "pg_isready", "command",
}
FIND_WRITES = {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"}
DOCKER = {"docker", "podman"}


def mount_sources(args):
    """The host side of every docker -v / --volume / --mount argument."""
    out, i = [], 0
    while i < len(args):
        a = args[i]
        val = None
        if a in ("-v", "--volume", "--mount") and i + 1 < len(args):
            val = args[i + 1]
            i += 1
        elif a.startswith("--volume=") or a.startswith("--mount="):
            val = a.split("=", 1)[1]
        elif re.match(r"^-v.+", a):
            val = a[2:]
        if val is not None:
            m = re.search(r"(?:source|src)=([^,]+)", val)
            out.append(m.group(1) if m else val.split(":")[0])
        i += 1
    return out


def analyse_line(path, lineno, line, env, writer_funcs, rep, known_funcs=frozenset()):
    """Every command that is not on the short read-only list is treated as able to write: if any of its arguments names a Bulig user's
    folder (after variables are expanded), that is a violation. Redirect targets are checked the same way."""
    toks = list(tokens(line))
    if toks and toks[0] == "case" and ")" in toks:
        toks = toks[toks.index(")") + 1:]  # the header and the first pattern are not commands
    segs, redirects = segments(toks)
    checked = []  # (command, args) of every segment that is not read-only and not run as another user
    for seg in segs:
        if seg and seg[0] in DECL:
            continue  # only declarations (local, export, ...); a command in a value is its own segment
        cmd, args = command_of(seg)
        if cmd is None or cmd in USER_WRAPPERS or cmd in ("for", "case", "select", "in", "function"):
            continue
        if not re.match(r"^(\[\[?|[A-Za-z0-9_./:+@%~${}-]+)$", cmd):
            continue  # a case pattern or a fragment of a nested quote, not a command
        if cmd == "systemd-run":
            joined = " ".join(args)
            if re.search(r"--uid=bulig(?:-worker)?\b", joined) or "DynamicUser=yes" in joined:
                continue  # runs as another user: that user writes, not root
            checked.append((cmd, args))
            continue
        if cmd == "find":
            if any(a in FIND_WRITES for a in args):
                checked.append((cmd, args))
            continue
        if cmd == "sed":
            if any(re.match(r"^-[A-Za-z]*i", a) or a.startswith("--in-place") for a in args):
                checked.append((cmd, args))
            continue
        if cmd in ("useradd", "usermod"):
            # --home-dir only records the path in /etc/passwd; --create-home is a separate rule below.
            kept, skip = [], False
            for a in args:
                if skip:
                    skip = False
                    continue
                if a in ("--home-dir", "-d", "--home"):
                    skip = True
                    continue
                if a.startswith("--home-dir=") or a.startswith("--home="):
                    continue
                kept.append(a)
            checked.append((cmd, kept))
            continue
        if cmd in writer_funcs:
            checked.append((cmd, args))
            continue
        if cmd in known_funcs or cmd in READ_ONLY:
            continue
        checked.append((cmd, args))
    if checked or redirects:
        rep.writers += 1
    for r in redirects:
        if r in ("/dev/null", "/dev/stderr", "/dev/stdout"):
            continue
        if hits(r, env):
            rep.add(path, lineno, "redirect", f"writes into a Bulig user's folder: {r} :: {line}")
    if any(c == "xargs" for c, _ in checked):
        # what xargs is fed comes from the other side of the pipe, so every word on the line counts
        for seg in segs:
            c, args = command_of(seg)
            if c is not None and c != "xargs" and any(hits(a, env) for a in args):
                rep.add(path, lineno, "write", f"xargs acts on a list built from a Bulig user's folder :: {line}")
                break
    for cmd, args in checked:
        for a in args:
            if hits(a, env):
                rep.add(path, lineno, "write", f"{cmd} names a Bulig user's folder: {a} :: {line}")
                break
        # a recursive or find-exec command on a parent of the folders
        recursive = any(RECURSIVE_FLAGS.match(a) or a in FIND_WRITES for a in args)
        if recursive:
            for a in args:
                if not a.startswith("-") and is_ancestor(a, env):
                    rep.add(path, lineno, "recursive", f"{cmd} writes recursively under {a}, a parent of the users' folders :: {line}")
                    break
        if cmd in DOCKER:
            for src in mount_sources(args):
                if hits(src, env) or is_ancestor(src, env):
                    rep.add(path, lineno, "docker-mount", f"{cmd} mounts {src}, which is or contains a Bulig user's folder :: {line}")
        if cmd in ("chown", "chgrp"):
            flat = [a for a in args if a.startswith("-")]
            if not any(re.match(r"^-[A-Za-z]*h", a) or a == "--no-dereference" for a in flat):
                rep.add(path, lineno, "chown-no-h", f"{cmd} without -h would follow a swapped link :: {line}")
            if any(re.match(r"^-[A-Za-z]*R", a) or a in ("--recursive",) for a in flat):
                rep.add(path, lineno, "chown-recursive", f"recursive {cmd} is never needed :: {line}")
        if cmd == "useradd":
            if any(a in ("--create-home", "-m") or re.match(r"^-[A-Za-z]*m[A-Za-z]*$", a) for a in args):
                rep.add(path, lineno, "create-home", f"useradd must not create a home; systemd does :: {line}")
        if cmd == "usermod" and any(a in ("-m", "--move-home") for a in args):
            rep.add(path, lineno, "move-home", f"usermod must not move a home :: {line}")
    # Paths worked out at run time from a lookup of the Bulig users are not visible to a text check, so a root script may not make the lookup.
    for seg in segs:
        cmd, args = command_of(seg)
        if cmd == "getent" and len([a for a in args if not a.startswith("-")]) >= 2:
            rep.add(path, lineno, "home-lookup", f"getent looks up a single user or group (the Bulig users' homes must not be looked up by a root script) :: {line}")
        if cmd == "eval":
            rep.add(path, lineno, "eval", f"eval builds a command at run time, which this check cannot read :: {line}")


def check_unit(path, text, rep):
    sections = {}
    cur = None
    lines = {}
    for n, raw in enumerate(text.split("\n"), 1):
        s = raw.strip()
        if not s or s.startswith("#") or s.startswith(";"):
            continue
        m = re.match(r"^\[(.+)\]$", s)
        if m:
            cur = m.group(1)
            continue
        if "=" in s and cur:
            k, v = s.split("=", 1)
            sections.setdefault((cur, k), []).append(v)
            lines.setdefault((cur, k), n)
    if path.endswith(".timer"):
        return
    user = (sections.get(("Service", "User")) or ["root"])[-1]
    allvals = [(k, v) for (sec, k), vs in sections.items() for v in vs]
    if user in ("bulig", "bulig-worker"):
        sd = sections.get(("Service", "StateDirectory")) or []
        if user not in sd:
            rep.add(path, 1, "state-directory", f"the {user} unit has no StateDirectory={user}; systemd must be what makes its folder")
        for k, v in allvals:
            if k.startswith("Exec") and v[:1] in ("+", "!"):
                rep.add(path, lines.get(("Service", k), 1), "privileged-exec", f"{k}={v} runs as root next to a Bulig user's folder")
            if k == "PermissionsStartOnly":
                rep.add(path, lines.get(("Service", k), 1), "privileged-exec", "PermissionsStartOnly runs helpers as root")
    else:
        for k, v in allvals:
            if FORBIDDEN.search(v):
                rep.add(path, lines.get(("Service", k), 1), "root-unit", f"a root unit names a Bulig user's folder: {k}={v}")


def load(root):
    scripts, units = [], []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d != "test"]
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root)
            if fn.endswith(".sh"):
                scripts.append((rel, open(p).read()))
            elif fn.endswith(".service") or fn.endswith(".timer"):
                units.append((rel, open(p).read()))
    return sorted(scripts), sorted(units)


def analyse(scripts, units):
    """scripts and units are lists of (name, text). Returns a Report."""
    rep = Report()
    env = collect_assignments(scripts)
    funcs = functions(scripts)
    # A function is a writer when its body has a write or a redirect.
    writer_funcs = set()
    for _ in range(3):
        for name, body in funcs.items():
            probe = Report()
            for n, line in logical_lines("\n".join(body)):
                analyse_line("<fn>", n, line, env, writer_funcs, probe, frozenset(funcs) - writer_funcs)
            if probe.writers:
                writer_funcs.add(name)
    for path, text in scripts:
        rep.files += 1
        for n, line in logical_lines(text):
            analyse_line(path, n, line, env, writer_funcs, rep, frozenset(funcs) - writer_funcs)
    for path, text in units:
        rep.files += 1
        check_unit(path, text, rep)
    rep.writer_funcs = len(writer_funcs)
    return rep


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    scripts, units = load(argv[1])
    rep = analyse(scripts, units)
    for v in rep.violations:
        print("VIOLATION", v)
    print(f"invariant: checked {len(scripts)} scripts and {len(units)} units, {rep.writers} statements that can write, {rep.writer_funcs} writing helpers, {len(rep.violations)} violations")
    return 1 if rep.violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

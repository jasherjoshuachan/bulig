"""One fence probe run, from inside a Bulig unit (or, in "control" mode, from outside every fence). Used by fence-check.sh; tested offline in
deploy/test/fence.sh against local listeners.

    python3 fence-probe.py control <set> <probes.txt|-> [--host-addrs "a/32 b/128"]
        As root, outside any fence: print "<name>=open|closed" for every deny and known probe of that set. "-" reads the probes from stdin.
    python3 fence-probe.py fenced  <set> <probes.txt|-> [--host-addrs ...] [--control "name=open,..."] [--late-only | --no-late]
        Inside the unit: run the probes of that set and print "ok|FAIL|warn|info <set> <name> <detail>". Exit 1 if anything FAILed.
    python3 fence-probe.py derive <ss -ltn output> <ss -xl output> <ip -o addr output>
        Print deny probes for what is listening on THIS machine (loopback, private-range and tailscale listeners, every wildcard listener port on
        the loopback, private and own addresses, every abstract unix socket), so the list needs no names of other services.

A "deny" probe passes when the connection fails AND the control run found the target open (so the failure is the fence's doing). It FAILs when
the connection works (the fence leaks). If the control found the target closed, or there is no control result, a failure proves nothing, so
it is only a warning ("inconclusive").
"""
import os
import socket
import ssl
import subprocess
import sys
import http.client
import urllib.parse

TIMEOUT = 3.0


def parse_probes(path, set_name, host_addrs):
    out = []
    for raw in (sys.stdin if path == "-" else open(path)):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 4)
        if len(parts) != 5:
            raise SystemExit(f"bad probe line: {line!r}")
        expect, sets, name, kind, target = parts
        if set_name not in sets.split(","):
            continue
        if "@HOST@" in target:
            for a in host_addrs:
                bare = a.split("/")[0]
                t = target.replace("@HOST@", f"[{bare}]" if ":" in bare else bare)
                out.append((expect, f"{name}-{bare}", kind, t))
            continue
        out.append((expect, name, kind, target))
    return out


def split_hostport(target):
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        return host, int(rest.lstrip(":"))
    host, _, port = target.rpartition(":")
    return host, int(port)


def attempt(kind, target):
    """Return (ok, detail). ok means the thing worked."""
    try:
        if kind == "tcp":
            host, port = split_hostport(target)
            s = socket.create_connection((host, port), timeout=TIMEOUT)
            s.close()
            return True, "connected"
        if kind in ("unix", "abstract"):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(TIMEOUT)
            s.connect(("\0" + target) if kind == "abstract" else target)  # abstract: the name starts with a NUL byte, then "/tmp/..." as written
            s.close()
            return True, "connected"
        if kind == "dns":
            socket.setdefaulttimeout(TIMEOUT)
            socket.getaddrinfo(target, 443, type=socket.SOCK_STREAM)
            return True, "resolved"
        if kind == "https":
            ctx = ssl.create_default_context()
            s = socket.create_connection((target, 443), timeout=TIMEOUT)
            t = ctx.wrap_socket(s, server_hostname=target)
            t.close()
            return True, "tls handshake"
        if kind == "http":
            u = urllib.parse.urlparse(target)
            c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=TIMEOUT)
            c.request("GET", u.path or "/")
            r = c.getresponse()
            return True, f"http {r.status}"
        if kind == "node":
            subprocess.run(["node", "-e", target], check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            return True, "node ran it"
        if kind == "exec":
            subprocess.run(target.split(), check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            return True, "exited 0"
        if kind == "pwd":
            import pwd

            return True, "uid " + str(os.getuid()) + " is " + pwd.getpwuid(os.getuid()).pw_name
        if kind == "socketpair":
            a, b = socket.socketpair()
            a.close()
            b.close()
            return True, "socketpair works"
        if kind == "spawn":
            subprocess.run([sys.executable, "-c", "pass"], check=True, timeout=TIMEOUT)
            return True, "child ran"
    except subprocess.CalledProcessError as e:
        return False, "exit " + str(e.returncode) + ": " + (e.stderr or b"").decode("utf8", "replace").strip()[:160]
    except Exception as e:  # any failure is a failure to connect
        return False, f"{type(e).__name__}: {e}"
    raise SystemExit(f"unknown probe kind {kind!r}")


ALL_SETS = "worker,kernel,build,cli-worker,cli-kernel"
WORKERISH = "worker,build,cli-worker"
GATEWAY = ("127.74.3.1", "7431")  # the kernel's own gateway: the worker is meant to reach it
MAX_DERIVED = 400


def classify(addr):
    """loopback | private | tailscale | linklocal | public | wildcard, for an IPv4 or IPv6 address."""
    a = addr.split("%")[0].strip("[]")
    if a in ("0.0.0.0", "*", "::"):
        return "wildcard"
    if ":" in a:
        low = a.lower()
        if low == "::1":
            return "loopback"
        if low.startswith("fe8") or low.startswith("fe9") or low.startswith("fea") or low.startswith("feb"):
            return "linklocal"
        if low.startswith("fc") or low.startswith("fd"):
            return "private"
        return "public"
    try:
        o = [int(x) for x in a.split(".")]
    except ValueError:
        return "public"
    if o[0] == 127:
        return "loopback"
    if o[0] == 10 or (o[0] == 172 and 16 <= o[1] <= 31) or (o[0] == 192 and o[1] == 168):
        return "private"
    if o[0] == 100 and 64 <= o[1] <= 127:
        return "tailscale"
    if o[0] == 169 and o[1] == 254:
        return "linklocal"
    return "public"


def safe_name(s):
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in s)


def split_listener(local):
    """'127.0.0.53%lo:53' -> ('127.0.0.53', '53'); '[::1]:41' -> ('::1', '41'); '*:80' -> ('*', '80')."""
    host, _, port = local.rpartition(":")
    return host.split("%")[0].strip("[]"), port


def derive(ss_tcp, ss_unix, ip_addr):
    listeners = []
    for line in open(ss_tcp):
        f = line.split()
        if len(f) >= 4 and f[0] == "LISTEN":
            host, port = split_listener(f[3])
            if port.isdigit():
                listeners.append((host, port))
    own_public, own_local = [], []
    for line in open(ip_addr):
        f = line.split()
        if len(f) < 4 or f[2] not in ("inet", "inet6"):
            continue
        addr = f[3].split("/")[0]
        kind = classify(addr)
        if kind == "public" and "scope global" in line:
            own_public.append(addr)
        elif kind in ("private", "tailscale"):
            own_local.append(addr)
    out = {}

    def add(expect, sets, name, kind, target):
        out[(expect, name)] = f"{expect} {sets} {safe_name(name)} {kind} {target}"

    def hp(host, port):
        return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"

    wild_v4, wild_v6 = set(), set()
    for host, port in listeners:
        c = classify(host)
        if c == "wildcard":
            if host in ("0.0.0.0", "*"):
                wild_v4.add(port)
            if host in ("::", "*"):
                wild_v6.add(port)
        elif c == "loopback":
            if (host, port) != GATEWAY:
                add("deny", ALL_SETS, f"listener-{host}-{port}", "tcp", hp(host, port))
        elif c in ("private", "tailscale"):
            add("deny", ALL_SETS, f"listener-{host}-{port}", "tcp", hp(host, port))
    for port in sorted(wild_v4, key=int):
        add("deny", ALL_SETS, f"wildcard-127.0.0.1-{port}", "tcp", hp("127.0.0.1", port))
        for a in own_local:
            if ":" not in a:
                add("deny", ALL_SETS, f"wildcard-{a}-{port}", "tcp", hp(a, port))
        for a in own_public:
            if ":" not in a:
                add("deny", WORKERISH, f"wildcard-{a}-{port}", "tcp", hp(a, port))
    for port in sorted(wild_v6, key=int):
        add("deny", ALL_SETS, f"wildcard-::1-{port}", "tcp", hp("::1", port))
        for a in own_local:
            if ":" in a:
                add("deny", ALL_SETS, f"wildcard-{a}-{port}", "tcp", hp(a, port))
        for a in own_public:
            if ":" in a:
                add("deny", WORKERISH, f"wildcard-{a}-{port}", "tcp", hp(a, port))
    names = set()
    for line in open(ss_unix):
        f = line.split()
        if len(f) >= 5 and f[4].startswith("@") and len(f[4]) > 1 and "," not in f[4] and "=" not in f[4]:
            names.add(f[4][1:])
    for n, name in enumerate(sorted(names), 1):  # numbered after sorting, so the order ss printed in does not matter
        add("deny", WORKERISH, f"abstract-{n}", "abstract", name)
        add("known", "kernel,cli-kernel", f"abstract-{n}", "abstract", name)
    lines = [out[k] for k in sorted(out)]
    return lines[:MAX_DERIVED]


def main(argv):
    if len(argv) == 5 and argv[1] == "derive":
        for line in derive(argv[2], argv[3], argv[4]):
            print(line)
        return 0
    if len(argv) < 4 or argv[1] not in ("control", "fenced"):
        print(__doc__)
        return 2
    mode, set_name, probes_file = argv[1], argv[2], argv[3]
    host_addrs, control, late = [], {}, "both"
    i = 4
    while i < len(argv):
        a = argv[i]
        if a == "--host-addrs":
            host_addrs = argv[i + 1].split()
            i += 2
        elif a == "--control":
            control = dict(kv.split("=", 1) for kv in argv[i + 1].split(",") if "=" in kv)
            i += 2
        elif a == "--late-only":
            late = "only"
            i += 1
        elif a == "--no-late":
            late = "no"
            i += 1
        else:
            raise SystemExit(f"unknown argument {a}")
    probes = parse_probes(probes_file, set_name, host_addrs)
    failed = 0
    for expect, name, kind, target in probes:
        if mode == "control":
            if expect in ("deny", "known"):
                ok, _ = attempt(kind, target)
                print(f"{name}={'open' if ok else 'closed'}")
            continue
        is_late = expect == "allow-late"
        if late == "only" and not is_late:
            continue
        if late == "no" and is_late:
            continue
        ok, detail = attempt(kind, target)
        if expect == "deny":
            if ok:
                print(f"FAIL {set_name} {name} UNEXPECTED SUCCESS: {kind} {target} was reachable ({detail})")
                failed += 1
            elif control.get(name) != "open":
                print(f"warn {set_name} {name} inconclusive: {target} was not shown to be listening without the fence ({detail})")
            else:
                print(f"ok {set_name} {name} blocked ({detail})")
        elif expect == "allow":
            if ok:
                print(f"ok {set_name} {name} works ({detail})")
            else:
                print(f"FAIL {set_name} {name} should work but did not: {kind} {target} ({detail})")
                failed += 1
        elif expect == "allow-late":
            if ok:
                print(f"ok {set_name} {name} works ({detail})")
            else:
                print(f"warn {set_name} {name} not reachable yet: {target} ({detail}). Check again once the kernel is up.")
        elif expect == "known":
            print(f"info {set_name} {name} known limit: {kind} {target[:60]} " + ("works" if ok else f"does not work ({detail})"))
        else:
            raise SystemExit(f"unknown expectation {expect!r}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

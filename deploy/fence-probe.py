"""One fence probe run, from inside a Bulig unit (or, in "control" mode, from outside every fence). Used by fence-check.sh; tested offline in
deploy/test/fence.sh against local listeners that count the connections they accept.

THE RULE: this kit never completes a connection to anything that is not Bulig's, from any context, and never wakes a socket-activated unit
that is not Bulig's. The only probes that connect are the "allow" ones (Bulig's own gateway, its Postgres socket, DNS, github, anthropic) and
the "deny" ones, which run inside the fence and must fail before they reach anything. A deny probe that SUCCEEDS is a real connection to
another service: that is exactly why it is a failure, and why the other modes never connect at all.

    python3 fence-probe.py control <set> <probes.txt|-> --ss-tcp <ss -Hltn output> --ss-unix <ss -Hxl output> [--host-addrs "a/32 b/128"]
        As root, outside any fence, WITHOUT CONNECTING to anything: print "<name>=open|closed" for every deny and known probe of that set.
        open = ss lists a listener at that address. closed = ss does not list one (inconclusive). "-" reads the probes from stdin.
        (Socket activation is not decided here: the fenced run decides it from each target.)
    python3 fence-probe.py fenced  <set> <probes.txt|-> --control "name=open,..." --af "<RestrictAddressFamilies>"
                           --activation-text "<systemctl list-sockets output>" [--ip-deny "..."] [--ip-allow "..."] [--inaccessible "..."] [--host-addrs ...] [--late-only | --no-late]
                           [--deny-timeout 1.5] [--jobs 32]
        Inside the unit: run the probes of that set and print "ok|FAIL|warn|info <set> <name> <detail>". Exit 1 if anything FAILed.
        Speed (neither changes a verdict): a deny probe is dropped by the IP filter, so a blocked one ends in a timeout, and that wait used to be
        the whole run (about 180 probes x 5 sets x 3 s, one after another). Deny probes now wait --deny-timeout seconds (default 1.5; allow probes keep
        3 s and a timeout is still a FAIL for them) and run --jobs at a time (default 32; --jobs 1 is the plain one-after-another order). Results
        are always printed in the probe file's order.
        The unit's own properties are passed in, because known limits and activation sockets are judged from them, not by connecting.
        Whether a target is socket-activated is decided from the target itself (against --activation-text), never from its probe name.
        A tcp deny target that the unit's own IPAddressDeny/IPAddressAllow leave open is a FAIL from the properties, without connecting.
        Probe names are plain ([A-Za-z0-9._-], 1 to 64) and used once per set, or the run is refused.
    python3 fence-probe.py derive <ss -ltn output> <ss -xl output> <ip -o addr output>
        Print deny probes for what is listening on THIS machine (loopback, private-range and tailscale listeners, every wildcard listener port on
        the loopback, private and own addresses, every abstract unix socket), so the list needs no names of other services.

A "deny" probe passes when the connection fails AND the control run found the target listed by ss (so the failure is the fence's doing). It FAILs
when the connection works (the fence leaks). If ss did not list the target, a failure proves nothing, so it is only a warning ("inconclusive").
A "known" probe (a documented limit) never connects: it reports the limit from the unit's properties and ss. A target that is socket-activated
is never connected to by any mode: it is judged from the unit's properties only.
"""
import concurrent.futures
import ipaddress
import os
import re
import socket
import ssl
import subprocess
import sys
import http.client
import urllib.parse

TIMEOUT = 3.0  # allow probes (Bulig's own targets): a slow answer is still an answer, a timeout is a FAIL
# A deny probe that is working is DROPPED by the IP filter (the SYN is discarded silently), so it always ends in a timeout. That wait is the whole
# cost of the check, and it buys nothing: a connection that would LEAK completes in milliseconds (loopback, the bridges and the host's own
# addresses are all local), so a short wait tells a drop from a leak just as well. Configurable: --deny-timeout.
DENY_TIMEOUT = 1.5
# Deny probes are independent of each other, so they run this many at a time inside the one fenced unit. --jobs 1 runs everything in order.
JOBS = 32


NAME_OK = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")


def parse_probes(path, set_name, host_addrs):
    out = []
    seen = set()
    for raw in (sys.stdin if path == "-" else open(path)):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 4)
        if len(parts) != 5:
            raise SystemExit(f"bad probe line: {line!r}")
        expect, sets, name, kind, target = parts
        if expect not in ("deny", "known", "allow", "allow-late"):
            raise SystemExit(f"unknown expectation {expect!r}")
        # A deny probe is only ever a tcp address, a unix socket or an abstract socket: those are the kinds whose activation can be checked
        # against systemctl list-sockets, and whose fence (IP filter, no AF_UNIX) stops them first. http, https or dns would connect without that.
        if expect == "deny" and kind not in ("tcp", "unix", "abstract"):
            raise SystemExit(f"a deny probe must be kind tcp, unix or abstract, not {kind!r}: {line!r}")
        # The control result is found by name, so a name is plain (no comma, no equals sign) and used once per set. Two probes with one name
        # would let the later one's result stand in for the earlier one's.
        if not NAME_OK.match(name):
            raise SystemExit(f"bad probe name {name!r}: letters, digits, dot, underscore and dash only (1 to 64): {line!r}")
        for s in sets.split(","):
            if (s, name) in seen:
                raise SystemExit(f"the probe name {name!r} is used twice for the set {s}: {line!r}")
            seen.add((s, name))
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


def attempt(kind, target, timeout=TIMEOUT):
    """Return (ok, detail). ok means the thing worked. A timeout is a failure (ok False), for every kind: it never counts as a pass."""
    try:
        if kind == "tcp":
            host, port = split_hostport(target)
            s = socket.create_connection((host, port), timeout=timeout)
            s.close()
            return True, "connected"
        if kind in ("unix", "abstract"):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(timeout)
            s.connect(("\0" + target) if kind == "abstract" else target)  # abstract: the name starts with a NUL byte, then "/tmp/..." as written
            s.close()
            return True, "connected"
        if kind == "dns":
            socket.setdefaulttimeout(timeout)
            socket.getaddrinfo(target, 443, type=socket.SOCK_STREAM)
            return True, "resolved"
        if kind == "https":
            ctx = ssl.create_default_context()
            s = socket.create_connection((target, 443), timeout=timeout)
            t = ctx.wrap_socket(s, server_hostname=target)
            t.close()
            return True, "tls handshake"
        if kind == "http":
            u = urllib.parse.urlparse(target)
            c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout)
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
            subprocess.run([sys.executable, "-c", "pass"], check=True, timeout=timeout)
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


def unmap(a):
    """An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is the IPv4 address it wraps; the kernel and the IP filter treat it as that."""
    try:
        v = ipaddress.ip_address(a)
    except ValueError:
        return a
    return str(v.ipv4_mapped) if v.version == 6 and v.ipv4_mapped is not None else a


def classify(addr):
    """loopback | private | tailscale | linklocal | public | wildcard, for an IPv4 or IPv6 address."""
    a = unmap(addr.split("%")[0].strip("[]"))
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
                listeners.append((unmap(host), port))
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


# ---- reading the host without connecting to it -------------------------------------------------------------------------------------------------

# Kinds that open a connection to something. A known probe of one of these is never run; a deny probe of one is never run against an
# activation socket.
CONNECT_KINDS = ("tcp", "unix", "abstract", "http", "https", "dns")


def norm_path(p):
    """/var/run is /run; ss and systemd may print either."""
    return "/run/" + p[len("/var/run/"):] if p.startswith("/var/run/") else p


def read_tcp_listeners(path):
    """Listening (host, port) pairs from `ss -H -ltn` output."""
    out = []
    for line in open(path):
        f = line.split()
        if len(f) >= 4 and f[0] == "LISTEN":
            host, port = split_listener(f[3])
            if port.isdigit():
                out.append((host, int(port)))
    return out


def read_unix_listeners(path):
    """Names of listening unix sockets from `ss -H -xl` output: a path, or '@name' for an abstract socket."""
    out = set()
    for line in open(path):
        f = line.split()
        if len(f) >= 5 and f[1] == "LISTEN":
            out.add(f[4] if f[4].startswith("@") else norm_path(f[4]))
    return out


def parse_activation(text):
    """The listen addresses that systemd holds for a socket unit, from `systemctl list-sockets` output: (tcp host, port) pairs, paths, and
    '@name' abstract names. Other lines (netlink and kernel sockets, headers) have none of these forms and are ignored.
    Only the system manager's sockets are listed there; per-user managers' sockets (under /run/user/<uid>, mode 0700) are not, and are not probe targets."""
    tcp, unix = [], set()
    for line in text.splitlines():
        f = line.split()
        if not f:
            continue
        listen = f[0]
        if listen.startswith("@"):
            unix.add(listen)
        elif listen.startswith("/"):
            unix.add(norm_path(listen))
        else:
            host, port = split_listener(listen)
            if port.isdigit() and host:
                tcp.append((host, int(port)))
    return tcp, unix


def _ip(host):
    try:
        return ipaddress.ip_address(unmap(host.split("%")[0].strip("[]")))
    except ValueError:
        return None


def tcp_host_matches(listen_host, host, wildcard_any_family):
    """Does a listener bound to listen_host take connections to host? A wildcard takes any address of its family (any family, when
    wildcard_any_family: used for activation sockets, where a miss would wake a service, so the match is as wide as it can be)."""
    a, b = _ip(listen_host), _ip(host)
    if listen_host in ("*", "0.0.0.0", "::"):
        if wildcard_any_family or listen_host == "*" or b is None:
            return True
        return a is not None and b is not None and a.version == b.version
    if a is None or b is None:
        return listen_host == host
    return a == b


def tcp_listed(host, port, listeners, wildcard_any_family=False):
    return any(lp == port and tcp_host_matches(lh, host, wildcard_any_family) for lh, lp in listeners)


def is_activation(kind, target, activation):
    act_tcp, act_unix = activation
    if kind == "tcp":
        host, port = split_hostport(target)
        return tcp_listed(host, port, act_tcp, wildcard_any_family=True)
    if kind == "unix":
        return norm_path(target) in act_unix
    if kind == "abstract":
        return "@" + target in act_unix
    return False


def control_state(kind, target, tcp_listeners, unix_listeners):
    """open | closed, from ss text only. This never opens a socket."""
    if kind == "tcp":
        host, port = split_hostport(target)
        return "open" if tcp_listed(host, port, tcp_listeners) else "closed"
    if kind == "unix":
        return "open" if norm_path(target) in unix_listeners else "closed"
    if kind == "abstract":
        return "open" if "@" + target in unix_listeners else "closed"
    return "closed"


class UnitProps:
    """What the unit being probed is allowed to do, as systemd reports it. Known limits and activation sockets are judged from this."""

    def __init__(self, af, ip_deny, ip_allow, inaccessible):
        self.af = af.split()
        self.deny = self._nets(ip_deny)
        self.allow = self._nets(ip_allow)
        self.inaccessible = [norm_path(x.lstrip("-+!~")) for x in inaccessible.split()]

    @staticmethod
    def _nets(text):
        named = {
            "any": ["0.0.0.0/0", "::/0"],
            "localhost": ["127.0.0.0/8", "::1/128"],
            "link-local": ["169.254.0.0/16", "fe80::/10"],
            "multicast": ["224.0.0.0/4", "ff00::/8"],
        }
        out = []
        for tok in text.split():
            for item in named.get(tok, [tok]):
                try:
                    out.append(ipaddress.ip_network(item, strict=False))
                except ValueError:
                    pass
        return out

    def has_af_unix(self):
        if self.af and self.af[0].startswith("~"):  # a deny list: ~AF_UNIX AF_NETLINK
            return "AF_UNIX" not in [x.lstrip("~") for x in self.af]
        return "AF_UNIX" in self.af or not self.af  # no list at all means no restriction

    def address_denied(self, host):
        a = _ip(host)
        if a is None:
            return False
        if any(a in n for n in self.allow if n.version == a.version):
            return False
        return any(a in n for n in self.deny if n.version == a.version)

    def path_hidden(self, path):
        p = norm_path(path)
        return any(p == h or p.startswith(h.rstrip("/") + "/") for h in self.inaccessible)


def ss_note(state):
    return {"activation": "an activation socket", "open": "listed by ss", "closed": "not listed by ss"}.get(state, "no ss result")


def properties_verdict(kind, target, props):
    """(ok, text): is the target out of reach of this unit, judged only from the unit's properties?"""
    if kind == "tcp":
        host, _ = split_hostport(target)
        if props.address_denied(host):
            return True, f"{host} is denied by IPAddressDeny"
        return False, f"{host} is NOT denied by the unit's IP filter"
    if kind in ("unix", "abstract"):
        if not props.has_af_unix():
            return True, "the unit has no AF_UNIX, so it cannot open a unix socket"
        if kind == "unix" and props.path_hidden(target):
            return True, "the path is hidden by InaccessiblePaths"
        return False, "the unit has AF_UNIX and nothing hides this socket, so it could connect if it listens"
    return False, "cannot be judged from properties"


def make_job(set_name, expect, name, kind, target, state, deny_timeout):
    """The probe that really attempts something: returns (line, failed). Deny probes get the short timeout, everything else the full one."""
    def job():
        ok, detail = attempt(kind, target, deny_timeout if expect == "deny" else TIMEOUT)
        if expect == "deny":
            if ok:
                return f"FAIL {set_name} {name} UNEXPECTED SUCCESS: {kind} {target} was reachable ({detail})", True
            if state != "open":
                return f"warn {set_name} {name} inconclusive: {target} was not shown to be listening by ss ({detail})", False
            return f"ok {set_name} {name} blocked ({detail})", False
        if expect == "allow":
            if ok:
                return f"ok {set_name} {name} works ({detail})", False
            return f"FAIL {set_name} {name} should work but did not: {kind} {target} ({detail})", True
        if expect == "allow-late":
            if ok:
                return f"ok {set_name} {name} works ({detail})", False
            return f"warn {set_name} {name} not reachable yet: {target} ({detail}). Check again once the kernel is up.", False
        if expect == "known":
            # (kinds that open no connection to another service: a user lookup, node's interface list, a child process)
            return f"info {set_name} {name} known limit: {kind} {target[:60]} " + ("works" if ok else f"does not work ({detail})"), False
        raise SystemExit(f"unknown expectation {expect!r}")
    job.is_deny = expect == "deny"
    return job


def emit(todo, jobs):
    """Run the jobs and print every result line in the order of the probe file. Returns the exit code (1 if anything FAILed).
    jobs == 1: one after another, in order. Otherwise the deny probes (which just wait out a drop) run jobs at a time, and the allow and other
    probes, which talk to Bulig's own things and may start processes, run one at a time beside them. Either way the lines come out the same."""
    failed = 0
    if jobs <= 1:
        for job, line, bad in todo:
            if job is not None:
                line, bad = job()
            print(line, flush=True)
            failed += 1 if bad else 0
        return 1 if failed else 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as deny_pool, concurrent.futures.ThreadPoolExecutor(max_workers=1) as one_by_one:
        waiting = [(None if job is None else (deny_pool if job.is_deny else one_by_one).submit(job), line, bad) for job, line, bad in todo]
        for fut, line, bad in waiting:  # in probe order: a slow probe holds up the printing, never the running
            if fut is not None:
                line, bad = fut.result()
            print(line, flush=True)
            failed += 1 if bad else 0
    return 1 if failed else 0


def main(argv):
    if len(argv) == 5 and argv[1] == "derive":
        for line in derive(argv[2], argv[3], argv[4]):
            print(line)
        return 0
    if len(argv) < 4 or argv[1] not in ("control", "fenced"):
        print(__doc__)
        return 2
    mode, set_name, probes_file = argv[1], argv[2], argv[3]
    opts = {"--host-addrs": "", "--control": None, "--af": None, "--ip-deny": "", "--ip-allow": "", "--inaccessible": "",
            "--ss-tcp": None, "--ss-unix": None, "--activation-text": None,
            "--deny-timeout": str(DENY_TIMEOUT), "--jobs": str(JOBS)}
    late = "both"
    i = 4
    while i < len(argv):
        a = argv[i]
        if a in opts:
            if i + 1 >= len(argv):
                raise SystemExit(f"{a} needs a value")
            opts[a] = argv[i + 1]
            i += 2
        elif a == "--late-only":
            late = "only"
            i += 1
        elif a == "--no-late":
            late = "no"
            i += 1
        else:
            raise SystemExit(f"unknown argument {a}")
    try:
        deny_timeout, jobs = float(opts["--deny-timeout"]), int(opts["--jobs"])
    except ValueError:
        raise SystemExit("--deny-timeout is a number of seconds and --jobs a whole number")
    # (a timeout of nothing would make every blocked probe look instant; one of minutes would bring the 40-minute check back)
    if not 0.05 <= deny_timeout <= 10 or not 1 <= jobs <= 256:
        raise SystemExit("--deny-timeout must be between 0.05 and 10 seconds and --jobs between 1 and 256")
    host_addrs = opts["--host-addrs"].split()
    probes = parse_probes(probes_file, set_name, host_addrs)
    if mode == "control":
        # Text only: ss output that root read before. Nothing here may open a socket.
        for flag in ("--ss-tcp", "--ss-unix"):
            if opts[flag] is None:
                raise SystemExit(f"control needs {flag}: it reads the host from ss, it never connects")
        tcp_l, unix_l = read_tcp_listeners(opts["--ss-tcp"]), read_unix_listeners(opts["--ss-unix"])
        for expect, name, kind, target in probes:
            if expect in ("deny", "known"):
                print(f"{name}={control_state(kind, target, tcp_l, unix_l)}")
        return 0
    # fenced: --control and --af are required, so that a caller that forgot them cannot make a deny probe connect to an activation socket or
    # an abstract socket it could reach.
    if opts["--control"] is None or opts["--af"] is None or opts["--activation-text"] is None:
        raise SystemExit("fenced needs --control (what the control run found), --af (the unit's RestrictAddressFamilies) and --activation-text "
                         "(the systemctl list-sockets output): it decides what is socket-activated from each target itself, never by probe name")
    activation = parse_activation(opts["--activation-text"])
    control = dict(kv.split("=", 1) for kv in opts["--control"].split(",") if "=" in kv)
    props = UnitProps(opts["--af"], opts["--ip-deny"], opts["--ip-allow"], opts["--inaccessible"])
    # Every probe gives exactly one result: (line, failed). Judging a probe from text (properties, ss, activation) is instant and never connects;
    # only the probes that really have to attempt something become a job. The results are printed in the probe file's order, whatever order
    # the jobs finish in, so a run reads the same every time and two modes can be compared line by line.
    todo = []  # (job, line, failed): a job is a function returning (line, failed); without one the result is already known
    for expect, name, kind, target in probes:
        is_late = expect == "allow-late"
        if late == "only" and not is_late:
            continue
        if late == "no" and is_late:
            continue
        state = control.get(name)
        # Socket activation is decided from the TARGET, here, every time. The control result is only a hint about whether ss listed it.
        activated = kind in ("tcp", "unix", "abstract") and is_activation(kind, target, activation)
        if expect == "known" and kind in CONNECT_KINDS:
            # A documented limit is reported from the unit's properties and ss. Connecting to prove it would be a real connection to
            # another service (and could start it), so it is never tested that way.
            _, why = properties_verdict(kind, target, props)
            todo.append((None, f"info {set_name} {name} known limit, not tested by connecting: {kind} {target[:60]} ({ss_note('activation' if activated else state)}; {why})", False))
            continue
        if expect == "deny" and kind in ("tcp", "unix", "abstract"):
            if activated:
                # Systemd listens on this socket for another unit: a connection would start it. Judged from properties only.
                good, why = properties_verdict(kind, target, props)
                if good:
                    todo.append((None, f"ok {set_name} {name} activation socket: checked by properties only ({why})", False))
                elif kind == "tcp":
                    todo.append((None, f"FAIL {set_name} {name} activation socket: checked by properties only, and {kind} {target} is reachable: {why}", True))
                else:
                    todo.append((None, f"info {set_name} {name} activation socket: checked by properties only; known limit, not tested by connecting ({why})", False))
                continue
            if kind == "tcp":
                good, why = properties_verdict(kind, target, props)
                if not good:
                    # The unit's own properties already leave this address open: a connection would simply go through to another service.
                    todo.append((None, f"FAIL {set_name} {name} {kind} {target} is open by the unit's own properties ({why}); not connected to", True))
                    continue
            if kind != "tcp" and props.has_af_unix() and not (kind == "unix" and props.path_hidden(target)):
                # Nothing fences this: the unit may open a unix socket and the path is not hidden, so a connection would simply succeed.
                good, why = properties_verdict(kind, target, props)
                todo.append((None, f"info {set_name} {name} known limit, not tested by connecting: {kind} {target[:60]} ({ss_note(state)}; {why})", False))
                continue
        todo.append((make_job(set_name, expect, name, kind, target, state, deny_timeout), "", False))
    return emit(todo, jobs)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

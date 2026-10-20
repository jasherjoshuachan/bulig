"""A stand-in for "inside a fenced unit", for deploy/test/fence.sh. It runs fence-probe.py's main() in this process with the socket class
replaced by one that behaves like the fence does:
  - opening an AF_UNIX socket fails at socket() (RestrictAddressFamilies has no AF_UNIX), so a unix or abstract probe never reaches anything;
  - a TCP connect fails before the SYN leaves (IPAddressDeny drops it), except to the ports in FENCE_STANDIN_ALLOW_PORTS (Bulig's own gateway).
Optional, for the speed tests (all by env var, none changes what is allowed):
  - FENCE_STANDIN_DROP=1: a connect that the fence blocks does not fail at once; it waits out the socket's timeout and raises TimeoutError("timed out"),
    which is what a silently dropped SYN looks like. Ports in FENCE_STANDIN_FAST still fail at once (EPERM), as some kernels do.
  - FENCE_STANDIN_LOG=<file>: every dropped connect appends "drop <port> <the socket's timeout>" to it (so a test can see which timeout a probe really used).
  - FENCE_STANDIN_SLOW="<port>:<seconds> ...": a connect to that allowed port answers only after that long (or times out, if the socket's timeout is shorter).
Nothing here proves the real fence holds (that is fence-check.sh on the server); it proves the PROBE does not get around one.
usage: python3 -I fenced-standin.py <path to fence-probe.py> <fence-probe.py arguments...>"""
import errno
import importlib.util
import os
import socket
import sys
import time

allowed = {int(x) for x in os.environ.get("FENCE_STANDIN_ALLOW_PORTS", "").split()}
drop = os.environ.get("FENCE_STANDIN_DROP") == "1"
fast = {int(x) for x in os.environ.get("FENCE_STANDIN_FAST", "").split()}
slow = {int(k): float(v) for k, _, v in (x.partition(":") for x in os.environ.get("FENCE_STANDIN_SLOW", "").split())}
Real = socket.socket


class Fenced(Real):
    def __init__(self, family=-1, *a, **k):
        if family == socket.AF_UNIX:
            raise OSError(errno.EAFNOSUPPORT, "Address family not supported by protocol")
        super().__init__(family, *a, **k)

    def connect(self, addr):
        if isinstance(addr, tuple) and addr[1] not in allowed:
            if drop and addr[1] not in fast:
                if os.environ.get("FENCE_STANDIN_LOG"):
                    with open(os.environ["FENCE_STANDIN_LOG"], "a") as f:
                        f.write(f"drop {addr[1]} {self.gettimeout()}\n")
                time.sleep(self.gettimeout() or 0)
                raise TimeoutError("timed out")
            raise OSError(errno.EPERM, "Operation not permitted")
        if isinstance(addr, tuple) and addr[1] in slow:
            limit = self.gettimeout()
            if limit is not None and slow[addr[1]] > limit:
                time.sleep(limit)
                raise TimeoutError("timed out")
            time.sleep(slow[addr[1]])
        return super().connect(addr)


socket.socket = Fenced
spec = importlib.util.spec_from_file_location("fp", sys.argv[1])
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)
sys.exit(fp.main(["fence-probe.py"] + sys.argv[2:]))

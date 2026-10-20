"""A stand-in for "inside a fenced unit", for deploy/test/fence.sh. It runs fence-probe.py's main() in this process with the socket class
replaced by one that behaves like the fence does:
  - opening an AF_UNIX socket fails at socket() (RestrictAddressFamilies has no AF_UNIX), so a unix or abstract probe never reaches anything;
  - a TCP connect fails before the SYN leaves (IPAddressDeny drops it), except to the ports in FENCE_STANDIN_ALLOW_PORTS (Bulig's own gateway).
Nothing here proves the real fence holds (that is fence-check.sh on the server); it proves the PROBE does not get around one.
usage: python3 -I fenced-standin.py <path to fence-probe.py> <fence-probe.py arguments...>"""
import errno
import importlib.util
import os
import socket
import sys

allowed = {int(x) for x in os.environ.get("FENCE_STANDIN_ALLOW_PORTS", "").split()}
Real = socket.socket


class Fenced(Real):
    def __init__(self, family=-1, *a, **k):
        if family == socket.AF_UNIX:
            raise OSError(errno.EAFNOSUPPORT, "Address family not supported by protocol")
        super().__init__(family, *a, **k)

    def connect(self, addr):
        if isinstance(addr, tuple) and addr[1] not in allowed:
            raise OSError(errno.EPERM, "Operation not permitted")
        return super().connect(addr)


socket.socket = Fenced
spec = importlib.util.spec_from_file_location("fp", sys.argv[1])
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)
sys.exit(fp.main(["fence-probe.py"] + sys.argv[2:]))

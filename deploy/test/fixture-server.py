"""Listeners for deploy/test/fence.sh: a TCP port, an HTTP port, a unix socket, and on Linux an abstract unix socket.
Prints "tcp=<port> http=<port> unix=<path> abstract=<name or ->" then serves until killed.  python3 -I fixture-server.py <folder>"""
import http.server
import os
import socket
import sys
import threading

folder = sys.argv[1]
tcp = socket.socket()
tcp.bind(("127.0.0.1", 0))
tcp.listen(5)
upath = os.path.join(folder, "fixture.sock")
if os.path.exists(upath):
    os.unlink(upath)
us = socket.socket(socket.AF_UNIX)
us.bind(upath)
us.listen(5)
abstract = "-"
if sys.platform.startswith("linux"):
    ab = socket.socket(socket.AF_UNIX)
    abstract = "/tmp/.bulig-fixture-%d" % os.getpid()
    ab.bind("\0" + abstract)
    ab.listen(5)
    socks = [ab]
else:
    socks = []


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def accept_loop(s):
    while True:
        try:
            c, _ = s.accept()
            c.close()
        except OSError:
            return


for s in [tcp, us] + socks:
    threading.Thread(target=accept_loop, args=(s,), daemon=True).start()
print("tcp=%d http=%d unix=%s abstract=%s" % (tcp.getsockname()[1], httpd.server_address[1], upath, abstract), flush=True)
threading.Event().wait()

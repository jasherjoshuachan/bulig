#!/usr/bin/env bash
# Scans tracked files for terms that must never appear in this public repo.
# The term list is not stored here. It comes from $BULIG_FORBIDDEN_TERMS (a regex),
# or the first line of ${XDG_CONFIG_HOME:-$HOME/.config}/bulig/forbidden-terms.
# On a hit it prints file:line only. Never the matched text, never the pattern.
set -uo pipefail
root="${SCAN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# --- Built-in checks, always on: no real host detail may be committed to this public repo. ---------------------------------------------------
# A real address of a server, or a note about what else runs on it, does not belong in a public repository. Allowed addresses: loopback
# (127.0.0.0/8, which includes the gateway's 127.74.3.1), 0.0.0.0, the private ranges (10/8, 172.16/12, 192.168/16), the Tailscale range
# (100.64/10) and the documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24; for IPv6 2001:db8::/32). Anything else is a hit. The
# strings below are the ones that identified a real machine and its other tenants once; they are written in pieces so this file does not
# contain them. A hit prints file:line and the rule's name, never the text.
cd "$root" || exit 1
builtin_hits="$(git ls-files -z ':!pnpm-lock.yaml' | python3 -I -c '
import re, sys
files = [f for f in sys.stdin.buffer.read().split(b"\0") if f]
v4 = re.compile(r"(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)")
v6 = re.compile(r"(?<![0-9A-Za-z:])([23][0-9a-fA-F]{3}(?::[0-9a-fA-F]{0,4}){2,7})(?![0-9A-Za-z:])")
words = [
    ("port-1", re.compile(r"(?<!\d)" + "92" + "22" + r"(?!\d)")),
    ("port-2", re.compile(r"(?<!\d)" + "82" + "33" + r"(?!\d)")),
    ("port-3", re.compile(r"(?<!\d)" + "72" + "33" + r"(?!\d)")),
    ("port-4", re.compile(r"(?<!\d)" + "114" + "34" + r"(?!\d)")),
    ("x-" + "display", re.compile("X" + "11-unix|" + r"\bX" + "99" + r"\b", re.I)),
    ("x-" + "server-flag", re.compile(r"(?<![\w-])-" + "a" + "c(?![\w-])")),
]
def allowed4(o):
    a, b, c, d = o
    if max(o) > 255: return True  # not an address (a version string, say)
    if a == 127 or a == 0 or a == 10: return True
    if a == 172 and 16 <= b <= 31: return True
    if a == 192 and b == 168: return True
    if a == 100 and 64 <= b <= 127: return True
    if (a, b, c) in ((192, 0, 2), (198, 51, 100), (203, 0, 113)): return True
    if a == 255: return True  # a netmask
    return False
for f in files:
    path = f.decode()
    try:
        text = open(path, encoding="utf-8").read()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    for n, line in enumerate(text.split("\n"), 1):
        # A test that must name addresses just outside an allowed range marks the line itself; the marker
        # skips only the address rules, never the port or display words.
        addresses_ok = "scan-forbidden: allow-addresses" in line
        for m in ([] if addresses_ok else v4.finditer(line)):
            o = [int(x) for x in m.groups()]
            # The base of a well-known range written as a prefix (link-local 169.254.0.0/16, multicast 224.0.0.0/4)
            # names no host; a host inside it is still caught.
            if o in ([169, 254, 0, 0], [224, 0, 0, 0]) and line[m.end():m.end() + 1] == "/": continue
            if not allowed4(o):
                print(path + ":" + str(n) + " (ipv4-outside-allowed-ranges)")
        for m in ([] if addresses_ok else v6.finditer(line)):
            if not m.group(1).lower().replace("0db8", "db8").startswith("2001:db8"):
                print(path + ":" + str(n) + " (ipv6-global-address)")
        for name, rx in words:
            if rx.search(line):
                print(path + ":" + str(n) + " (" + name + ")")
')" || { echo "verify: the built-in host-detail check did not run (its checker failed), so the tree is not known to be clean" >&2; exit 1; }
if [ -n "$builtin_hits" ]; then
  echo "verify: real host details found at (file:line, rule):" >&2
  echo "$builtin_hits" >&2
  exit 1
fi

pat="${BULIG_FORBIDDEN_TERMS:-}"
if [ -z "$pat" ]; then
  f="${XDG_CONFIG_HOME:-$HOME/.config}/bulig/forbidden-terms"
  if [ -r "$f" ]; then pat="$(head -n 1 "$f")"; fi
fi

if [ -z "$pat" ]; then
  if [ -n "${CI:-}" ]; then
    echo "verify: notice: forbidden-terms scan skipped (BULIG_FORBIDDEN_TERMS is not set)"
  else
    echo "verify: WARNING: forbidden-terms scan skipped. Set BULIG_FORBIDDEN_TERMS or create the bulig/forbidden-terms file in your config dir." >&2
  fi
  exit 0
fi

# An invalid regex is a failure, and grep's own message could echo the pattern, so say it ourselves.
printf '' | grep -E -e "$pat" >/dev/null 2>&1
if [ $? -eq 2 ]; then
  echo "verify: the forbidden-terms pattern is not a valid extended regex" >&2
  exit 1
fi

cd "$root" || exit 1
hits="$(git ls-files -z | xargs -0 grep -HInEi -e "$pat" 2>/dev/null | cut -d: -f1,2)"
if [ -n "$hits" ]; then
  echo "verify: forbidden terms found at (file:line):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "verify: forbidden-terms scan clean"

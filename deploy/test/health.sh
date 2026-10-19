#!/usr/bin/env bash
# Tests for health.sh's fence step and its warnings, with stand-ins for Postgres, systemd, ss and ip, and a stand-in fence-check.sh:
#   - it runs the fence check last (all sets without the late probe, then the worker sets' gateway probe once the lease is confirmed) and a
#     failing fence fails health; --no-fence skips it;
#   - it WARNS (does not fail) when the host's addresses are not in the worker's drop-in, or a new service listens on every address.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

stubs="$work/stubs"
log="$work/log"
mkdir -p "$stubs" "$log"
export STUB_LOG="$log"
root="$work/host"
export BULIG_DEPLOY_TEST_ROOT="$root"

cat >"$stubs/pg_lsclusters" <<'STUB'
#!/usr/bin/env bash
echo "16 bulig 5436 online postgres /x /y"
STUB
cat >"$stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "is-active" ]; then
  unit="${*: -1}"
  for u in ${STUB_INACTIVE:-}; do [ "$u" = "$unit" ] && { echo inactive; exit 3; }; done
  exit 0
fi
exit 0
STUB
cat >"$stubs/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$stubs/psql" <<'STUB'
#!/usr/bin/env bash
n="$(cat "$STUB_LOG/psql-n" 2>/dev/null || echo 0)"
echo $((n + 1)) >"$STUB_LOG/psql-n"
if [ $((n % 2)) -eq 0 ]; then echo "kernel-1|3|t|2026-10-19 10:00:00.000001"; else echo "kernel-1|3|t|2026-10-19 10:00:10.000002"; fi
STUB
cat >"$stubs/ss" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_LOG/ss.txt"
STUB
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in *"scope global"*) cat "$STUB_LOG/ip-data" ;; esac
STUB
chmod +x "$stubs"/*
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

# A copy of the kit whose fence-check.sh only records how it was called.
kit="$work/kit"
mkdir -p "$kit"
cp -R "$deploy/." "$kit/"
rm -rf "$kit/test"
cat >"$kit/fence-check.sh" <<'STUB'
#!/usr/bin/env bash
echo "fence-check $*" >>"$STUB_LOG/fence"
if [ -n "${STUB_FENCE_FAIL:-}" ]; then echo "FAIL worker xorg-abstract-socket UNEXPECTED SUCCESS"; exit 1; fi
exit 0
STUB
chmod +x "$kit/fence-check.sh"

printf '2: eth0    inet 91.98.153.155/32 metric 100 scope global dynamic eth0\n2: eth0    inet6 2a01:4f8:c17:a0b6::1/64 scope global\n' >"$log/ip-data"
rm -rf "$root"
mkdir -p "$root/etc/bulig" "$root/etc/systemd/system/bulig-worker.service.d" "$root/var/lib/bulig-checks"
chmod 700 "$root/etc/bulig" "$root/var/lib/bulig-checks"
printf 'postgres://bulig:pw@%%2Fvar%%2Frun%%2Fpostgresql:5436/bulig' >"$root/etc/bulig/pg-url"
cp "$deploy/systemd/bulig-worker.service" "$root/etc/systemd/system/"
printf '[Service]\nIPAddressDeny=2a01:4f8:c17:a0b6::1/128 91.98.153.155/32\n' >"$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"
cat >"$root/var/lib/bulig-checks/precheck.snapshot" <<'DATA'
## listening tcp sockets (Bulig's ports 5436 and 7431 left out; pids stripped)
0.0.0.0:22 users:(("sshd"))
0.0.0.0:80 users:(("nginx"))
127.0.0.1:5432 users:(("postgres"))
[::]:22 users:(("sshd"))
## docker containers (name, image, state)
DATA
printf 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*\nLISTEN 0 4096 127.0.0.1:9222 0.0.0.0:*\n' >"$log/ss.txt"
h="$kit/health.sh"
# every run starts the lease stand-in again from its first answer
hrun() { echo 0 >"$log/psql-n"; bash "$h" --wait 1 >"$work/out" 2>&1; }

echo "health.sh"
echo 0 >"$log/psql-n"
expect_ok "health passes when everything is as it was" bash "$h" --wait 1
if grep -q "^fence-check all --no-late$" "$log/fence" && grep -q "^fence-check worker cli-worker --late-only --late-strict$" "$log/fence"; then ok "it runs the fence check on all sets, then the worker sets' gateway probe as a strict, late check"; else bad "fence calls: $(cat "$log/fence" 2>&1)"; fi
if [ "$(wc -l <"$log/fence" | tr -d ' ')" = "2" ]; then ok "and only those two calls"; else bad "fence call count"; fi
if ! grep -q "^warn" "$work/out"; then ok "no warnings when the drop-in matches the machine and no new listener appeared"; else bad "unexpected warnings: $(grep '^warn' "$work/out")"; fi
if grep -q "ok    the fence holds" "$work/out"; then ok "and says so"; else bad "output: $(cat "$work/out")"; fi

echo "the fence fails health"
: >"$log/fence"
echo 0 >"$log/psql-n"
expect_fail_msg "a failing fence check fails health" "the fence does not hold" env STUB_FENCE_FAIL=1 bash "$h" --wait 1
if grep -q "FAIL worker xorg-abstract-socket" "$work/out" && grep -q "health: FAILED" "$work/out"; then ok "with the probe's FAIL line shown and health: FAILED"; else bad "output: $(cat "$work/out")"; fi
: >"$log/fence"
echo 0 >"$log/psql-n"
expect_ok "--no-fence skips the fence check" bash "$h" --wait 1 --no-fence
if [ ! -s "$log/fence" ]; then ok "and fence-check is not called"; else bad "fence-check ran with --no-fence"; fi
expect_fail_msg "an unknown argument is refused" "usage: health.sh" bash "$h" --bogus
: >"$log/fence"
echo 0 >"$log/psql-n"
expect_fail_msg "an inactive gateway-address unit fails health" "bulig-loopback.service is" env STUB_INACTIVE=bulig-loopback.service bash "$h" --wait 1
if [ ! -s "$log/fence" ]; then ok "and the fence is not probed while health is already failing"; else bad "fence ran after a failure"; fi

echo "warnings"
printf '2: eth0    inet 91.98.153.155/32 scope global\n2: eth0    inet6 2a01:4f8:c17:a0b6::1/64 scope global\n2: eth0    inet 203.0.113.9/32 scope global\n' >"$log/ip-data"
hrun
rc=$?
if [ "$rc" -eq 0 ]; then ok "health still passes with a new address on the machine"; else bad "health failed: $(cat "$work/out")"; fi
if grep -q "^warn  the host address 203.0.113.9/32 is not in the worker's IPAddressDeny" "$work/out"; then ok "a host address missing from the worker's drop-in is a warning that names the fix"; else bad "address warning: $(grep warn "$work/out")"; fi
if ! grep -q "warn  the host address 91.98.153.155" "$work/out"; then ok "and one that is there is not"; else bad "false warning"; fi
rm -f "$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"
hrun
if [ "$(grep -c '^warn  the host address' "$work/out")" -ge 1 ]; then ok "with no drop-in at all every address is a warning"; else bad "no-drop-in: $(grep warn "$work/out")"; fi
printf '[Service]\nIPAddressDeny=203.0.113.9/32\n' >"$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"
printf '2: eth0    inet 203.0.113.9/32 scope global\n' >"$log/ip-data"
hrun
if ! grep -q "^warn  the host address" "$work/out"; then ok "a drop-in that matches the current addresses gives no warning"; else bad "false address warning: $(grep warn "$work/out")"; fi
printf 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*\nLISTEN 0 128 *:8081 *:*\nLISTEN 0 128 [::]:8082 [::]:*\nLISTEN 0 128 0.0.0.0:9000 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:9222 0.0.0.0:*\n' >"$log/ss.txt"
hrun
rc=$?
if grep -q "^warn  a service listens on every address now (\*:8081)" "$work/out" && grep -q "^warn  a service listens on every address now (0.0.0.0:9000)" "$work/out" && grep -qF "now ([::]:8082)" "$work/out"; then ok "new listeners on every address (0.0.0.0, * and [::]) are warnings"; else bad "listener warnings: $(grep warn "$work/out")"; fi
if ! grep -q "now (0.0.0.0:22)\|now (0.0.0.0:80)\|now (\[::\]:22)" "$work/out"; then ok "listeners that were there at the precheck are not"; else bad "false listener warning"; fi
if ! grep -q "9222" "$work/out"; then ok "a listener on 127.0.0.1 is not a wildcard listener"; else bad "9222 reported"; fi
if [ "$rc" -eq 0 ]; then ok "warnings do not fail health"; else bad "health failed on warnings (rc=$rc)"; fi
rm -f "$root/var/lib/bulig-checks/precheck.snapshot"
hrun
if grep -q "^warn  no precheck snapshot" "$work/out"; then ok "without a precheck snapshot it says new listeners cannot be noticed"; else bad "no-baseline: $(grep warn "$work/out")"; fi

finish

#!/bin/sh
# shellcheck disable=SC2016 # single-quoted bodies are expanded by the inner sh, on purpose
# The ONE install lock shared by `ah-hook integrity`, `ah-hook update` and `ah-hook install`: deterministic interleavings.
# Scratch HOME and state, stub engines; the real ~/.anti-hall is never touched. The interleaving is forced, not timed: a stub
# race point of the integrity check (AH_INTEGRITY_PARK, honoured under AH_WRAPPER_TEST=1) parks it right after it validated the
# damaged binary, until the test lets it go.
# usage: install-lock.sh [PLUGIN_DIR]   (default: this repo's plugins/anti-hall; another dir runs the same cases on other scripts)
# needs the built thin client: AH_HOOK_BIN, else ah-launcher/target/{release,debug}/ah-hook (cargo build there first)
set -u
repo=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
src=${1:-$repo/plugins/anti-hall}
tmp=/tmp/ahu-l.$$ # short: the launcher self-test needs a socket path under 100 bytes
mkdir -p "$tmp"
bg=
reap() { for p in $bg; do kill "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap reap EXIT HUP INT TERM

hookbin=${AH_HOOK_BIN:-}
for c in "$repo/ah-launcher/target/release/ah-hook" "$repo/ah-launcher/target/debug/ah-hook"; do
  [ -n "$hookbin" ] || { [ -x "$c" ] && hookbin=$c; }
done
[ -x "$hookbin" ] || { printf 'FAIL no ah-hook binary: build ah-launcher or set AH_HOOK_BIN\n' >&2; exit 1; }
park=$tmp/park

pass=0; fail=0
check() { # check "name" cmd...
  n=$1; shift
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$n" >&2; fi
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
waitfor() { # waitfor TENTHS CMD...: poll CMD every 0.1 s, at most TENTHS times
  w_n=$1; shift; w_i=0
  while [ "$w_i" -lt "$w_n" ]; do "$@" && return 0; sleep 0.1; w_i=$((w_i + 1)); done
  return 1
}
alive() { kill -0 "$1" 2>/dev/null; }
dead() { ! kill -0 "$1" 2>/dev/null; }

plug=$tmp/plugin
mkdir -p "$plug/hooks" "$plug/engine/defaults"
cp "$src/engine/defaults/engine.toml" "$plug/engine/defaults/"
cp "$src/engine/defaults/messages.toml" "$src/engine/defaults/index.toml" "$src/engine/defaults/dispatch.toml" "$plug/engine/defaults/"

mkeng() { # mkeng FILE VERSION: a stub engine
  printf '#!/bin/sh\n[ "$1" = version ] && echo %s\nexit 0\n' "$2" >"$1"
  chmod 755 "$1"
}
mkeng "$tmp/good" 1.0.0
mkeng "$tmp/damaged" 1.0.0-DAMAGED
mkeng "$tmp/new" 2.0.0
mkeng "$tmp/other" 3.0.0
G=$(sha "$tmp/good"); D=$(sha "$tmp/damaged"); N=$(sha "$tmp/new"); O=$(sha "$tmp/other")

home=; state=; bin=
world() { # world NAME: a fresh HOME whose installed binary is a damaged copy that keeps failing, with a verified known-good copy
  home=$tmp/$1; state=$home/.anti-hall/ah-engine; bin=$state/bin/ah-engine
  mkdir -p "$state/bin"
  cp "$hookbin" "$state/bin/ah-hook"; chmod 755 "$state/bin/ah-hook"
  cp "$tmp/damaged" "$bin"
  cp "$tmp/good" "$bin.good"; printf '%s\n' "$G" >"$bin.good.sha256"
  printf '%s\n' "$G" >"$bin.expected" # the installer put the good one there; the damaged copy is not it
  now=$(date +%s); printf '%s\n%s\n%s\n' "$now" "$now" "$now" >"$state/wrapper.fails"
}
integrity() { HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug "$state/bin/ah-hook" integrity "$@"; }
# the same, held at a race point while $park.<point> exists (it creates $park.<point>.parked on arrival)
parked_integrity() { HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug AH_WRAPPER_TEST=1 AH_INTEGRITY_PARK=$park "$state/bin/ah-hook" integrity "$@"; }
asides_with() { for f in "$bin".rolledback-*; do [ -f "$f" ] && [ "$(sha "$f")" = "$1" ] && return 0; done; return 1; }
no_aside_with() { ! asides_with "$1"; }
logged() { grep -q "$1" "$state/integrity.log" 2>/dev/null; }

# ---- 1. integrity validated the damaged binary, then an update installs the verified new one before the roll-back moves it --------
world race
: >"$park.validated"; rm -f "$park.validated.parked"
parked_integrity check </dev/null >/dev/null 2>&1 &
ipid=$!; bg="$bg $ipid"
check "race: the integrity check parks after validating the damaged binary" waitfor 100 test -f "$park.validated.parked"
HOME=$home AH_WRAPPER_TEST=1 AH_ENGINE_INSTALL_LOCK_WAIT_S=30 "$hookbin" --plugin-root "$plug" update --from "$tmp/new" --sha256 "$N" --no-restart \
  >"$tmp/upd.out" 2>&1 &
upid=$!; bg="$bg $upid"
# the update either finishes (separate locks) or waits on the shared one: either way it has had its chance to act
waitfor 200 sh -c 'grep -q "event=lock_waiting" "$0" 2>/dev/null || ! kill -0 "$1" 2>/dev/null' "$state/integrity.log" "$upid"
rm -f "$park.validated"
wait "$ipid"; wait "$upid"; urc=$?
check "race: the update succeeded" test "$urc" -eq 0
check "race: the verified new binary is installed" test "$(sha "$bin")" = "$N"
check "race: the new binary is the expected one" test "$(sed -n 1p "$bin.expected")" = "$N"
check "race: the new binary was not set aside" no_aside_with "$N"
check "race: the damaged binary was rolled back first and kept" asides_with "$D"
check "race: the lock is released" test ! -e "$state/install.lock"

# ---- 2. record waits for a held lock instead of skipping, and records what is there once it is free --------------------------
world record
sleep 300 & holder=$!; bg="$bg $holder"
tok="$holder $(date +%s)"
integrity lock "$tok" >/dev/null 2>&1
check "record: lock taken by a live holder" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$tok"
AH_ENGINE_INSTALL_LOCK_WAIT_S=30 integrity record </dev/null >/dev/null 2>&1 &
rpid=$!; bg="$bg $rpid"
check "record: waits while the lock is held" waitfor 100 logged "event=lock_waiting"
check "record: still waiting" alive "$rpid"
cp "$tmp/other" "$bin"
integrity unlock "$tok"
wait "$rpid"
check "record: recorded the binary there once the lock was free" test "$(sed -n 1p "$bin.expected")" = "$O"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# ---- 3. a hook-started check fails open on a held lock: it returns quickly and touches nothing --------------------------------
world hook
sleep 300 & holder=$!; bg="$bg $holder"
tok="$holder $(date +%s)"
integrity lock "$tok" >/dev/null 2>&1
t0=$(date +%s)
AH_ENGINE_INSTALL_LOCK_HOOK_WAIT_S=0 integrity fail </dev/null >/dev/null 2>&1; frc=$?
t1=$(date +%s)
check "hook: fail exits 0" test "$frc" -eq 0
check "hook: fail returns without waiting" test $((t1 - t0)) -le 2
check "hook: the damaged binary is left for the next check" test "$(sha "$bin")" = "$D"
check "hook: the failure was still counted" test "$(wc -l <"$state/wrapper.fails" | tr -d ' ')" -eq 4
check "hook: the holder keeps the lock" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$tok"
integrity unlock "$tok"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# ---- 4. a lock whose holder died is broken; an update then holds it, and the updater refuses when it cannot get it -------------
world stale
sh -c 'exit 0' & gone=$!; wait "$gone"
mkdir "$state/install.lock"; printf '%s %s\n' "$gone" "$(date +%s)" >"$state/install.lock/owner"
AH_ENGINE_INSTALL_LOCK_WAIT_S=5 integrity record </dev/null >/dev/null 2>&1
check "stale: a dead holder's lock is broken and the record runs" test "$(sed -n 1p "$bin.expected")" = "$D"
check "stale: the break is logged" logged "event=lock_broke_stale"
sleep 300 & holder=$!; bg="$bg $holder"
integrity lock "$holder $(date +%s)" >/dev/null 2>&1
HOME=$home AH_WRAPPER_TEST=1 AH_ENGINE_INSTALL_LOCK_WAIT_S=1 "$hookbin" --plugin-root "$plug" update --from "$tmp/new" --sha256 "$N" --no-restart \
  >"$tmp/upd2.out" 2>&1; urc=$?
check "held: the update fails while another holder keeps the lock" test "$urc" -eq 1
check "held: the old binary is kept" test "$(sha "$bin")" = "$D"
check "held: the failure names the lock" grep -q "install lock" "$tmp/upd2.out"
integrity unlock "$holder $(date +%s)" # a token that is not the holder's gives nothing back
check "held: unlock with another token leaves the lock" test -e "$state/install.lock"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# ---- 5. a writer that ignores the lock: the roll-back re-verifies what it moved and puts a different binary back ---------------
world bypass
: >"$park.validated"; rm -f "$park.validated.parked"
parked_integrity check </dev/null >/dev/null 2>&1 &
ipid=$!; bg="$bg $ipid"
waitfor 100 test -f "$park.validated.parked"
cp "$tmp/other" "$bin.tmp" && mv -f "$bin.tmp" "$bin"
rm -f "$park.validated"
wait "$ipid"
check "bypass: the binary written behind the check's back stays in place" test "$(sha "$bin")" = "$O"
check "bypass: nothing was set aside" sh -c '! ls "$0".rolledback-* >/dev/null 2>&1' "$bin"

# ---- 6. two breakers of one stale lock: the late one must not move the lock the early one took, nor free it for a third ------
# The late breaker is held at its break points (it has read the dead holder: before_break; it has moved the owner file: after_break).
world reclaim
sh -c 'exit 0' & gone=$!; wait "$gone"
mkdir "$state/install.lock"; printf '%s %s\n' "$gone" "$(date +%s)" >"$state/install.lock/owner"
: >"$park.before_break"; : >"$park.after_break"; rm -f "$park.before_break.parked" "$park.after_break.parked"
AH_ENGINE_INSTALL_LOCK_WAIT_S=1 parked_integrity record </dev/null >/dev/null 2>&1 &
apid=$!; bg="$bg $apid"
check "reclaim: the late breaker parks after reading the dead holder" waitfor 100 test -f "$park.before_break.parked"
sleep 300 & bh=$!; bg="$bg $bh"; btok="$bh $(date +%s)"
AH_ENGINE_INSTALL_LOCK_WAIT_S=1 integrity lock "$btok" >/dev/null 2>&1; brc=$?
check "reclaim: the early breaker takes the lock" test "$brc" -eq 0
check "reclaim: the early breaker owns it" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$btok"
rm -f "$park.before_break"
check "reclaim: the late breaker acts on the lock" waitfor 100 test -f "$park.after_break.parked"
sleep 300 & ch=$!; bg="$bg $ch"; ctok="$ch $(date +%s)"
AH_ENGINE_INSTALL_LOCK_WAIT_S=1 integrity lock "$ctok" >/dev/null 2>&1; crc=$?
check "reclaim: a third taker does not get the lock the early breaker holds" test "$crc" -ne 0
rm -f "$park.after_break"
wait "$apid"
check "reclaim: the early breaker still owns the lock" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$btok"
check "reclaim: the third taker does not own it" test "$(cat "$state/install.lock/owner" 2>/dev/null)" != "$ctok"
integrity unlock "$btok"
check "reclaim: the early breaker gives it back" test ! -e "$state/install.lock"
check "reclaim: the dead holder's lock is set aside, not deleted" sh -c 'ls -d "$0".stale.* >/dev/null 2>&1' "$state/install.lock"
kill "$bh" "$ch" 2>/dev/null; wait "$bh" 2>/dev/null; wait "$ch" 2>/dev/null

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

#!/bin/sh
# shellcheck disable=SC2016 # single-quoted bodies are expanded by the inner sh, on purpose
# The ONE install lock shared by ah-engine-integrity.sh, ah-update.sh and ah-engine-bootstrap.sh: deterministic interleavings.
# Scratch HOME and state, stub engines; the real ~/.anti-hall is never touched. The interleaving is forced, not timed: a stub
# sha256sum on the integrity script's PATH parks it right after it validated the damaged binary (when it hashes the known-good
# copy, its last look before the roll-back), until the test lets it go.
# usage: install-lock.sh [PLUGIN_DIR]   (default: this repo's plugins/anti-hall; another dir runs the same cases on other scripts)
set -u
repo=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
src=${1:-$repo/plugins/anti-hall}
tmp=${TMPDIR:-/tmp}/ah-install-lock-test.$$
mkdir -p "$tmp"
bg=
reap() { for p in $bg; do kill "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap reap EXIT HUP INT TERM

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
cp "$src/hooks/ah-update.sh" "$src/hooks/ah-engine-integrity.sh" "$src/hooks/ah-engine-bootstrap.sh" "$plug/hooks/"
cp "$src/engine/ah-update.toml" "$plug/engine/"
cp "$src/engine/defaults/engine.toml" "$plug/engine/defaults/"
integ=$plug/hooks/ah-engine-integrity.sh

# the stub sha256sum: parks the caller while $tmp/gate exists and it is asked to hash the known-good copy
mkdir -p "$tmp/fakebin"
cat >"$tmp/fakebin/sha256sum" <<EOS
#!/bin/sh
case "\$1" in *.good)
  if [ -f "$tmp/gate" ]; then : >"$tmp/parked"; while [ -f "$tmp/gate" ]; do sleep 0.1; done; fi ;;
esac
exec shasum -a 256 "\$@"
EOS
chmod 755 "$tmp/fakebin/sha256sum"

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
  cp "$tmp/damaged" "$bin"
  cp "$tmp/good" "$bin.good"; printf '%s\n' "$G" >"$bin.good.sha256"
  printf '%s\n' "$G" >"$bin.expected" # the installer put the good one there; the damaged copy is not it
  now=$(date +%s); printf '%s\n%s\n%s\n' "$now" "$now" "$now" >"$state/wrapper.fails"
}
integrity() { HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug sh "$integ" "$@"; }
asides_with() { for f in "$bin".rolledback-*; do [ -f "$f" ] && [ "$(sha "$f")" = "$1" ] && return 0; done; return 1; }
no_aside_with() { ! asides_with "$1"; }
logged() { grep -q "$1" "$state/integrity.log" 2>/dev/null; }

# ---- 1. integrity validated the damaged binary, then an update installs the verified new one before the roll-back moves it --------
world race
: >"$tmp/gate"; rm -f "$tmp/parked"
HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug PATH=$tmp/fakebin:$PATH sh "$integ" check </dev/null >/dev/null 2>&1 &
ipid=$!; bg="$bg $ipid"
check "race: the integrity check parks after validating the damaged binary" waitfor 100 test -f "$tmp/parked"
HOME=$home AH_WRAPPER_TEST=1 AH_ENGINE_INSTALL_LOCK_WAIT_S=30 sh "$plug/hooks/ah-update.sh" --from "$tmp/new" --sha256 "$N" --no-restart \
  >"$tmp/upd.out" 2>&1 &
upid=$!; bg="$bg $upid"
# the update either finishes (separate locks) or waits on the shared one: either way it has had its chance to act
waitfor 200 sh -c 'grep -q "waiting up to" "$0" 2>/dev/null || ! kill -0 "$1" 2>/dev/null' "$state/integrity.log" "$upid"
rm -f "$tmp/gate"
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
check "record: waits while the lock is held" waitfor 100 logged "waiting up to"
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
check "stale: the break is logged" logged "broke a stale install lock"
sleep 300 & holder=$!; bg="$bg $holder"
integrity lock "$holder $(date +%s)" >/dev/null 2>&1
HOME=$home AH_WRAPPER_TEST=1 AH_ENGINE_INSTALL_LOCK_WAIT_S=1 sh "$plug/hooks/ah-update.sh" --from "$tmp/new" --sha256 "$N" --no-restart \
  >"$tmp/upd2.out" 2>&1; urc=$?
check "held: the update fails while another holder keeps the lock" test "$urc" -eq 1
check "held: the old binary is kept" test "$(sha "$bin")" = "$D"
check "held: the failure names the lock" grep -q "install lock" "$tmp/upd2.out"
integrity unlock "$holder $(date +%s)" # a token that is not the holder's gives nothing back
check "held: unlock with another token leaves the lock" test -e "$state/install.lock"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# ---- 5. a writer that ignores the lock: the roll-back re-verifies what it moved and puts a different binary back ---------------
world bypass
: >"$tmp/gate"; rm -f "$tmp/parked"
HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug PATH=$tmp/fakebin:$PATH sh "$integ" check </dev/null >/dev/null 2>&1 &
ipid=$!; bg="$bg $ipid"
waitfor 100 test -f "$tmp/parked"
cp "$tmp/other" "$bin.tmp" && mv -f "$bin.tmp" "$bin"
rm -f "$tmp/gate"
wait "$ipid"
check "bypass: the binary written behind the check's back stays in place" test "$(sha "$bin")" = "$O"
check "bypass: nothing was set aside" sh -c '! ls "$0".rolledback-* >/dev/null 2>&1' "$bin"

# ---- 6. two breakers of one stale lock: the late one must not move the lock the early one took, nor free it for a third ------
# A stub mv on the late breaker's PATH parks it right before its break (it has read the dead holder) and right after it.
mkdir -p "$tmp/parkbin"
cat >"$tmp/parkbin/mv" <<EOS
#!/bin/sh
park() { [ -f "$tmp/gate\$1" ] || return 0; : >"$tmp/parked\$1"; while [ -f "$tmp/gate\$1" ]; do sleep 0.1; done; }
case "\$1" in */install.lock|*/install.lock/owner) park 1; /bin/mv "\$@"; rc=\$?; park 2; exit \$rc ;; esac
exec /bin/mv "\$@"
EOS
chmod 755 "$tmp/parkbin/mv"
world reclaim
sh -c 'exit 0' & gone=$!; wait "$gone"
mkdir "$state/install.lock"; printf '%s %s\n' "$gone" "$(date +%s)" >"$state/install.lock/owner"
: >"$tmp/gate1"; : >"$tmp/gate2"; rm -f "$tmp/parked1" "$tmp/parked2"
HOME=$home AH_ENGINE_DIR=$state AH_ENGINE_PLUGIN_ROOT=$plug AH_ENGINE_INSTALL_LOCK_WAIT_S=1 PATH=$tmp/parkbin:$PATH \
  sh "$integ" record </dev/null >/dev/null 2>&1 &
apid=$!; bg="$bg $apid"
check "reclaim: the late breaker parks after reading the dead holder" waitfor 100 test -f "$tmp/parked1"
sleep 300 & bh=$!; bg="$bg $bh"; btok="$bh $(date +%s)"
AH_ENGINE_INSTALL_LOCK_WAIT_S=1 integrity lock "$btok" >/dev/null 2>&1; brc=$?
check "reclaim: the early breaker takes the lock" test "$brc" -eq 0
check "reclaim: the early breaker owns it" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$btok"
rm -f "$tmp/gate1"
check "reclaim: the late breaker acts on the lock" waitfor 100 test -f "$tmp/parked2"
sleep 300 & ch=$!; bg="$bg $ch"; ctok="$ch $(date +%s)"
AH_ENGINE_INSTALL_LOCK_WAIT_S=1 integrity lock "$ctok" >/dev/null 2>&1; crc=$?
check "reclaim: a third taker does not get the lock the early breaker holds" test "$crc" -ne 0
rm -f "$tmp/gate2"
wait "$apid"
check "reclaim: the early breaker still owns the lock" test "$(cat "$state/install.lock/owner" 2>/dev/null)" = "$btok"
check "reclaim: the third taker does not own it" test "$(cat "$state/install.lock/owner" 2>/dev/null)" != "$ctok"
integrity unlock "$btok"
check "reclaim: the early breaker gives it back" test ! -e "$state/install.lock"
check "reclaim: the dead holder's lock is set aside, not deleted" sh -c 'ls -d "$0".stale.* >/dev/null 2>&1' "$state/install.lock"
kill "$bh" "$ch" 2>/dev/null; wait "$bh" 2>/dev/null; wait "$ch" 2>/dev/null

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

#!/bin/sh
# Sandbox test of the shadow updater's time limits and lock handling (install-shadow-remote.sh -> update.sh). Usage: sh live/test-updater.sh
# Everything runs in a temp HOME with a fake `cargo` that sleeps forever; no network, no engine, no claude; the real home is never touched.
# Covers: per-step timeout (with `timeout` and with the POSIX watchdog fallback), per-run hard limit, lock released, next run proceeds,
# stale-lock takeover (dead holder / holder over the limit), --status WARNING, and --live stopping a stale updater instead of refusing.
SRC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd); IS="$SRC/install-shadow-remote.sh"
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
export HOME=$F; unset AH_SHADOW_D CLAUDE_CONFIG_DIR
D=$F/.anti-hall/ah-engine-shadow2; U=$D/update.sh; LOG=$D/update.log
BIGSLEEP=31337
mkdir -p "$D" "$F/.cargo/bin" "$F/.claude" "$F/fx"
cat > "$F/.cargo/bin/cargo" <<CEOF
#!/bin/sh
exec sleep $BIGSLEEP
CEOF
chmod +x "$F/.cargo/bin/cargo"
( cd "$F/fx" && git init -q -b main . && mkdir ah-engine && echo x > ah-engine/Cargo.toml && git add . && git -c user.email=t@t -c user.name=t commit -q -m one )
git clone -q --depth 1 "file://$F/fx" "$D/src" 2>/dev/null
printf 'file://%s\n' "$F/fx" > "$D/repo.url"; printf 'file://%s\n' "$F/fx" > "$D/repo.https"; echo main > "$D/branch"; echo oldcommit > "$D/commit"
touch "$D/.shadow2-installed"
sh "$IS" --refresh-scripts >/dev/null 2>&1; [ -f "$U" ] && grep -q '^update.timeout_s=' "$D/config"; chk $? "installer wrote update.sh and the update.* time-limit keys into config"
setcfg() { { grep -v "^$1=" "$D/config"; printf '%s=%s\n' "$1" "$2"; } > "$D/config.t" && mv "$D/config.t" "$D/config"; }
setcfg update.build_timeout_s 3; setcfg update.timeout_s 60; setcfg update.warn_s 2
leftover() { ps -A -o args= | grep -c "[s]leep $BIGSLEEP" | tr -d ' '; }
reset_state() { rm -rf "$D/update.lock" "$D/update.state" "$LOG"; echo oldcommit > "$D/commit"; }

# a PATH without `timeout`, to exercise the fallback watchdog
mkdir -p "$F/nopath"; for c in sh git ps awk sed grep cat sleep nice env kill mkdir rm mv cp date head tr tail wc cut dirname mktemp python3 ssh uname; do p=$(command -v "$c") && ln -sf "$p" "$F/nopath/$c"; done

for variant in timeout fallback; do
  if [ $variant = fallback ]; then PTH=$F/nopath; else PTH=$PATH; fi
  echo "== build hang ($variant)"
  reset_state; setcfg update.build_timeout_s 3
  t0=$(date +%s); PATH=$PTH sh "$U" --now >"$F/out" 2>&1; rc=$?; t1=$(date +%s)
  [ $rc = 0 ] && [ $((t1-t0)) -lt 25 ]; chk $? "[$variant] a build that sleeps past update.build_timeout_s is killed (rc=$rc, $((t1-t0))s)"
  grep -q 'build of .* failed' "$LOG"; chk $? "[$variant] failure logged, backoff set"
  [ ! -d "$D/update.lock" ]; chk $? "[$variant] lock released"
  [ "$(leftover)" = 0 ]; chk $? "[$variant] no orphan build process left"
  [ "$(cat "$D/commit")" = oldcommit ]; chk $? "[$variant] installed commit unchanged"
  echo "== next run proceeds ($variant)"
  PATH=$PTH sh "$U" --now >/dev/null 2>&1; [ ! -d "$D/update.lock" ] && [ "$(grep -c 'update available' "$LOG")" -ge 2 ]; chk $? "[$variant] the next --now run took the lock and went through fetch again"
done

echo "== per-run hard limit"
reset_state; setcfg update.build_timeout_s 3600; setcfg update.timeout_s 4
t0=$(date +%s); sh "$U" --now >/dev/null 2>&1; t1=$(date +%s)
[ $((t1-t0)) -lt 25 ]; chk $? "run killed by update.timeout_s ($((t1-t0))s, build limit was 3600)"
grep -q 'exceeded 4s and was killed (stuck in step: build)' "$LOG"; chk $? "log names the step it was stuck in"
[ ! -d "$D/update.lock" ] && [ "$(leftover)" = 0 ]; chk $? "lock released, no orphan"
grep -q '^last_result=failed: update exceeded' "$D/update.state"; chk $? "update.state records the timeout"

echo "== stale lock takeover"
mkdir -p "$F/fake"; printf 'sleep 600\n' > "$F/fake/update.sh"
setcfg update.build_timeout_s 3; setcfg update.timeout_s 2
reset_state; echo "$(cat "$D/src/.git/HEAD" >/dev/null; git -C "$D/src" rev-parse HEAD)" > "$D/commit"   # up to date: the run ends right after the fetch
mkdir "$D/update.lock"; sh "$F/fake/update.sh" & HP=$!; echo $HP > "$D/update.lock/pid"; sleep 3
sh "$U" --now >/dev/null 2>&1
grep -q "stale lock: update pid $HP has run" "$LOG" && ! kill -0 "$HP" 2>/dev/null; chk $? "holder over the limit was killed and logged"
grep -q '^last_check=' "$D/update.state" && [ ! -d "$D/update.lock" ]; chk $? "the run proceeded and released the lock"
reset_state; echo "$(git -C "$D/src" rev-parse HEAD)" > "$D/commit"; mkdir "$D/update.lock"; echo 2999999 > "$D/update.lock/pid"
sh "$U" --now >/dev/null 2>&1; grep -q 'stale lock: holder pid 2999999 is not running' "$LOG" && grep -q '^last_check=' "$D/update.state"; chk $? "dead holder taken over and logged"
reset_state; echo "$(git -C "$D/src" rev-parse HEAD)" > "$D/commit"; setcfg update.timeout_s 600
mkdir "$D/update.lock"; sh "$F/fake/update.sh" & HP=$!; echo $HP > "$D/update.lock/pid"; sleep 1
sh "$U" --now >"$F/out" 2>&1; kill -0 "$HP" 2>/dev/null && grep -q 'another update is running' "$F/out"; chk $? "a young holder is respected (no takeover)"

echo "== --status warns, --live stops instead of refusing"
setcfg update.warn_s 2; sleep 2
sh "$IS" --status >"$F/st" 2>&1; grep -q 'WARNING: an update (pid '"$HP"'.*longer than expected' "$F/st"; chk $? "--status prints a WARNING for a long-running update"
mkdir -p "$F/bin"; printf '#!/bin/sh\nexit 0\n' > "$F/bin/claude"; chmod +x "$F/bin/claude"
PATH="$F/bin:$PATH" sh "$IS" --live --live-repo "file://$F/does-not-exist" >"$F/live.out" 2>&1
! grep -q 'update is running' "$F/live.out" && ! kill -0 "$HP" 2>/dev/null && [ ! -d "$D/update.lock" ]; chk $? "--live stopped the running updater (no 'update is running' refusal; lock gone; pid dead)"
grep -q "STOPPED update pid $HP" "$LOG"; chk $? "stop logged; installed version untouched ($(cat "$D/commit" | cut -c1-8))"
kill "$HP" 2>/dev/null
echo; [ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILED"; rm -rf "$F"
exit "$fails"

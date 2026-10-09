#!/bin/sh
# Tests for install-shadow-remote.sh --live engine acquisition: prebuilt download via gh (verified), sha mismatch refused, no gh -> clear
# message and NO build, --allow-build / AH_LIVE_BUILD=1 -> build path (AH_BUILD_JOBS honoured). Usage: sh live/test-dlbin.sh
# No network, no cargo, no real claude: gh, cargo and claude are stubs on PATH / in the scratch HOME; HOME is a scratch dir.
SRC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd); IS=$SRC/install-shadow-remote.sh
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
trap 'rm -rf "$F"' EXIT
command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1 || { echo "need node and git"; exit 1; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
export HOME=$F/home CLAUDE_CONFIG_DIR=$F/home/.claude TMPDIR=$F/tmp
unset AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT CLAUDE_PLUGIN_ROOT AH_LIVE_BUILD AH_BUILD_JOBS
mkdir -p "$HOME/.claude" "$TMPDIR" "$F/stubs" "$HOME/.cargo/bin"
# fixture engine-proto repo: the minimum cmd_live checks before the binary step
P=$F/proto; mkdir -p "$P/ah-engine" "$P/plugins/anti-hall/hooks" "$P/plugins/anti-hall/engine/defaults" "$P/plugins/anti-hall/.claude-plugin"
: >"$P/ah-engine/Cargo.toml"; : >"$P/plugins/anti-hall/hooks/ah-fallback.map.json"; : >"$P/plugins/anti-hall/engine/defaults/index.toml"
echo '{"version":"9.9.9"}' >"$P/plugins/anti-hall/.claude-plugin/plugin.json"
git init -q "$P" && git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -q -m fx && git -C "$P" branch -M engine-proto
LC=$(git -C "$P" rev-parse HEAD)
# stub engine (what CI would have built) + its shipped sha256
printf '#!/bin/sh\n[ "$1" = version ] && echo 0.202.9\n' >"$F/engine.good"; chmod +x "$F/engine.good"
GOODSHA=$(sha "$F/engine.good")
# stub claude: fails, so go-live stops right after the binary step (everything we assert happens before)
printf '#!/bin/sh\nexit 1\n' >"$F/stubs/claude"; chmod +x "$F/stubs/claude"; export AH_LIVE_CLAUDE=$F/stubs/claude
# stub gh: STUB_RUN (id or empty), STUB_SHA (shipped checksum), records calls
cat >"$F/stubs/gh" <<'GH'
#!/bin/sh
echo "$*" >>"$GH_LOG"
case "$1 $2" in
  "auth status") exit "${STUB_AUTH:-0}" ;;
  "run list") if [ -n "${STUB_RUN:-}" ]; then echo "[{\"databaseId\":$STUB_RUN}]"; else echo "[]"; fi ;;
  "run download") while [ "$#" -gt 0 ]; do [ "$1" = -D ] && d=$2; [ "$1" = -n ] && n=$2; shift; done
    echo "$n" >>"$GH_LOG"; cp "$ENGINE_SRC" "$d/ah-engine"; printf '%s  ah-engine\n' "$STUB_SHA" >"$d/ah-engine.sha256" ;;
esac
GH
chmod +x "$F/stubs/gh"; export GH_LOG=$F/gh.log ENGINE_SRC=$F/engine.good
# stub cargo: records the job count and leaves a good binary where the installer looks
cat >"$HOME/.cargo/bin/cargo" <<'CG'
#!/bin/sh
echo "jobs=$CARGO_BUILD_JOBS" >>"$CARGO_LOG"; mkdir -p "$CARGO_TARGET_DIR/release" && cp "$ENGINE_SRC" "$CARGO_TARGET_DIR/release/ah-engine"
CG
chmod +x "$HOME/.cargo/bin/cargo"; export CARGO_LOG=$F/cargo.log
BASEPATH=$PATH
live() { rm -rf "$HOME/.anti-hall"; : >"$GH_LOG"; : >"$CARGO_LOG"; sh "$IS" --live --live-repo "file://$P" "$@" >"$F/out" 2>&1; echo $? >"$F/rc"; }
echo "== 1. artifact found + verified"
( PATH=$F/stubs:$BASEPATH STUB_RUN=555 STUB_SHA=$GOODSHA live )
grep -q "run list .*--commit $LC" "$GH_LOG"; chk $? "looked the run up by the exact head sha"
grep -q "^ah-engine-.*-$(printf %s "$LC" | cut -c1-8)\$" "$GH_LOG"; chk $? "downloaded the artifact named for triple + shortsha8"
grep -q 'sha256 verified' "$F/out"; chk $? "checksum verified and reported"
[ ! -s "$CARGO_LOG" ] && ! grep -q 'building ah-engine' "$F/out"; chk $? "no build ran"
grep -q 'going live' "$F/out"; chk $? "proceeded to go-live with the downloaded engine"
echo "== 2. sha mismatch -> refuse"
( PATH=$F/stubs:$BASEPATH STUB_RUN=555 STUB_SHA=0000bad live --allow-build )
grep -q 'checksum mismatch' "$F/out" && [ "$(cat "$F/rc")" != 0 ]; chk $? "mismatch refused (non-zero exit)"
[ ! -s "$CARGO_LOG" ] && ! grep -q 'going live' "$F/out"; chk $? "a mismatch never falls back to a build or goes live, even with --allow-build"
echo "== 3. no gh -> clear message, no build"
mkdir -p "$F/nogh"; for t in sh git node uname sed awk cut tr head find cp mv mkdir rm cat chmod date nice sleep printf grep mktemp dirname env sysctl timeout tail ls kill; do p=$(command -v $t) && ln -sf "$p" "$F/nogh/$t"; done
( PATH=$F/nogh live )
grep -q 'gh (GitHub CLI) is not installed' "$F/out" && grep -q -- '--bin PATH' "$F/out" && grep -q -- '--allow-build' "$F/out" && [ "$(cat "$F/rc")" != 0 ]; chk $? "one clear line: why, --bin, --allow-build"
[ ! -s "$CARGO_LOG" ] && ! grep -q 'building ah-engine' "$F/out"; chk $? "no build without --allow-build"
( PATH=$F/stubs:$BASEPATH STUB_AUTH=1 live )
grep -q 'not authenticated' "$F/out" && [ ! -s "$CARGO_LOG" ]; chk $? "unauthenticated gh: clear message, no build"
( PATH=$F/stubs:$BASEPATH STUB_RUN= live )
grep -q 'no successful ah-engine-bins run' "$F/out" && [ ! -s "$CARGO_LOG" ]; chk $? "no CI run for the commit: clear message, no build"
echo "== 4. --allow-build / AH_LIVE_BUILD=1 -> build path"
( PATH=$F/nogh:$HOME/.cargo/bin live --allow-build )
grep -q 'building ah-engine' "$F/out" && grep -q '^jobs=2$' "$CARGO_LOG"; chk $? "--allow-build builds (default 2 jobs)"
( PATH=$F/nogh:$HOME/.cargo/bin AH_LIVE_BUILD=1 AH_BUILD_JOBS=3 live )
grep -q 'building ah-engine' "$F/out" && grep -q '^jobs=3$' "$CARGO_LOG"; chk $? "AH_LIVE_BUILD=1 builds and AH_BUILD_JOBS=3 is honoured"
( PATH=$F/stubs:$BASEPATH STUB_RUN=555 STUB_SHA=$GOODSHA AH_LIVE_BUILD=1 live )
[ ! -s "$CARGO_LOG" ] && grep -q 'sha256 verified' "$F/out"; chk $? "a verified download wins over building even when building is allowed"
echo "== 5. --bin still wins"
( PATH=$F/stubs:$BASEPATH live --bin "$F/engine.good" )
grep -q 'using prebuilt binary' "$F/out" && [ ! -s "$GH_LOG" ]; chk $? "--bin skips gh entirely"
echo; echo "dlbin: $fails failed"
[ "$fails" -eq 0 ]

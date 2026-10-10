#!/bin/sh
# Tests for install-shadow-remote.sh --live --channel / --from delegating to hooks/ah-update.sh (issue #140): already live no longer
# needs --rollback-live first; a not-live install takes the engine (and the plugin commit) from ah-update. Usage: sh live/test-ahupdate.sh
# No network, no real claude/ah-update: the fixture branch ships a stub hooks/ah-update.sh that records its arguments. HOME is a scratch dir.
SRC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd); IS=$SRC/install-shadow-remote.sh
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
trap 'rm -rf "$F"' EXIT
command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1 || { echo "need node and git"; exit 1; }
export HOME=$F/home CLAUDE_CONFIG_DIR=$F/home/.claude TMPDIR=$F/tmp
unset AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT CLAUDE_PLUGIN_ROOT AH_LIVE_BUILD AH_BUILD_JOBS
mkdir -p "$HOME/.claude" "$TMPDIR" "$F/stubs"
P=$F/proto; mkdir -p "$P/ah-engine" "$P/plugins/anti-hall/hooks" "$P/plugins/anti-hall/engine/defaults" "$P/plugins/anti-hall/.claude-plugin"
: >"$P/ah-engine/Cargo.toml"; : >"$P/plugins/anti-hall/hooks/ah-fallback.map.json"; : >"$P/plugins/anti-hall/engine/defaults/index.toml"
echo '{"version":"9.9.9"}' >"$P/plugins/anti-hall/.claude-plugin/plugin.json"
cat >"$P/plugins/anti-hall/hooks/ah-update.sh" <<'AU'
#!/bin/sh
echo "ah-update $*" >>"$AU_LOG"
while [ "$#" -gt 0 ]; do [ "$1" = --extract-to ] && out=$2; shift; done
if [ -n "${out:-}" ]; then printf '#!/bin/sh\n[ "$1" = version ] && echo 0.202.9\n' >"$out"; chmod +x "$out"; [ -z "${AU_COMMIT:-}" ] || echo "$AU_COMMIT" >"$out.commit"; fi
exit "${AU_RC:-0}"
AU
git init -q "$P" && git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -q -m one && git -C "$P" branch -M engine-proto
C1=$(git -C "$P" rev-parse HEAD)
echo two >"$P/plugins/anti-hall/two.txt"; git -C "$P" add -A && git -C "$P" -c user.email=t@t -c user.name=t commit -q -m two
git -C "$P" config uploadpack.allowAnySHA1InWant true
printf '#!/bin/sh\nexit 1\n' >"$F/stubs/claude"; chmod +x "$F/stubs/claude"; export AH_LIVE_CLAUDE=$F/stubs/claude
export AU_LOG=$F/au.log
live() { : >"$AU_LOG"; sh "$IS" --live --live-repo "file://$P" "$@" >"$F/out" 2>&1; echo $? >"$F/rc"; }
mklive() { rm -rf "$HOME/.anti-hall"; mkdir -p "$HOME/.anti-hall/ah-engine-live/state"; echo '{}' >"$HOME/.anti-hall/ah-engine-live/state/live.json"; }

echo "== 1. already live: no rollback needed, delegated to ah-update"
mklive; live
[ "$(cat "$F/rc")" = 0 ] && grep -q '^ah-update --channel dev --live-select all-agreeing' "$AU_LOG"; chk $? "plain --live when live -> ah-update --channel dev"
! grep -q 'already live (' "$F/out"; chk $? "the old 'already live, rollback first' refusal is gone"
mklive; live --channel stable
grep -q '^ah-update --channel stable ' "$AU_LOG"; chk $? "--channel stable passed through"
mklive; echo x >"$F/eng.tgz"; live --from "$F/eng.tgz" --sha256 abc --yes --live-select none
grep -q "^ah-update --from $F/eng.tgz --sha256 abc --yes --live-select none" "$AU_LOG"; chk $? "--from FILE --sha256 --yes --live-select passed through"
mklive; AU_RC=3; export AU_RC; live --channel dev; unset AU_RC
[ "$(cat "$F/rc")" = 3 ]; chk $? "ah-update's exit code is the installer's"

echo "== 2. not live: engine from ah-update --extract-to, plugin at the recorded commit"
rm -rf "$HOME/.anti-hall"; AU_COMMIT=$C1; export AU_COMMIT; live --channel dev; unset AU_COMMIT
grep -q -- '--channel dev --extract-to' "$AU_LOG"; chk $? "ah-update asked to extract the dev engine"
grep -q "source is now $C1" "$F/out"; chk $? "the plugin source moved to the commit the pre-release records"
grep -q 'going live' "$F/out"; chk $? "proceeded to go-live (stopped there by the claude stub)"
rm -rf "$HOME/.anti-hall"; live --channel bogus
grep -q -- '--channel must be stable or dev' "$F/out" && [ "$(cat "$F/rc")" != 0 ]; chk $? "a bad channel is refused"

echo "== $fails failed"
[ "$fails" = 0 ]

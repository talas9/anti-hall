#!/bin/sh
# Tests for plugins/anti-hall/hooks/ah-update.sh. Scratch HOME, fake engines, a LOCAL http server and a local git repo: no real
# network, and the real ~/.anti-hall/ah-engine is never touched (HOME is a scratch directory throughout).
set -u
repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
src=$repo/plugins/anti-hall
tmp=${TMPDIR:-/tmp}/ah-update-test.$$
mkdir -p "$tmp/www"
server_pid=
trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"' EXIT HUP INT TERM

pass=0; fail=0
check() { # check "name" cmd...
  n=$1; shift
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$n" >&2; fi
}

# A scratch plugin: the real script and settings, a controllable lock.
plug=$tmp/plugin
mkdir -p "$plug/hooks" "$plug/engine"
cp "$src/hooks/ah-update.sh" "$src/hooks/ah-engine-bootstrap.sh" "$plug/hooks/"
cp "$src/engine/ah-update.toml" "$plug/engine/"
upd=$plug/hooks/ah-update.sh

home=$tmp/home
mkdir -p "$home"
bin=$home/.anti-hall/ah-engine/bin/ah-engine
triple=x86_64-unknown-linux-gnu

mkeng() { # mkeng DIR VERSION [broken]: a fake engine that records stop/serve in $HOME/.anti-hall/fake-calls
  mkdir -p "$1"
  if [ "${3:-}" = broken ]; then printf '#!/bin/sh\nexit 1\n' >"$1/ah-engine"
  else
    cat >"$1/ah-engine" <<EOS
#!/bin/sh
case "\$1" in
  version) echo $2 ;;
  stop) echo stop >>"\$HOME/.anti-hall/fake-calls" ;;
  serve) echo serve >>"\$HOME/.anti-hall/fake-calls" ;;
  status) echo ok ;;
esac
exit 0
EOS
  fi
  chmod 755 "$1/ah-engine"
}
mktar() { # mktar NAME VERSION [broken] -> $tmp/www/NAME.tar.gz containing NAME/ah-engine
  rm -rf "$tmp/pkg"; mkeng "$tmp/pkg/$1" "$2" "${3:-}"
  tar -czf "$tmp/www/$1.tar.gz" -C "$tmp/pkg" "$1"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
run() { HOME=$home AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE=$triple AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:$port AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:$port/dl sh "$upd" "$@"; }
ver() { "$bin" version; }
calls() { cat "$home/.anti-hall/fake-calls" 2>/dev/null | tr '\n' ' '; }

python3 - "$tmp/www" "$tmp/port" <<'PY' &
import http.server, socketserver, sys, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    open(sys.argv[2], "w").write(str(s.server_address[1]))
    s.serve_forever()
PY
server_pid=$!
i=0; while [ ! -s "$tmp/port" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
port=$(cat "$tmp/port")

# ---- offline: good sha, bad sha, no sha ------------------------------------------------------------------------------------------
mkeng "$tmp/v1" 1.0.0
mkeng "$tmp/v2" 2.0.0
good=$(sha "$tmp/v2/ah-engine")
mkdir -p "$home/.anti-hall/ah-engine/bin"
cp "$tmp/v1/ah-engine" "$bin"                        # an installed 1.0.0
check "bad --sha256 is refused, old binary kept" sh -c '! HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/v2/ah-engine --sha256 '"$(printf 0%.0s $(seq 64))"' >/dev/null 2>&1 && [ "$('"$bin"' version)" = 1.0.0 ]'
check "no sha and no --yes: exit 3, nothing changed" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/v2/ah-engine >/dev/null 2>&1; [ $? -eq 3 ] && [ "$('"$bin"' version)" = 1.0.0 ]'
rm -f "$home/.anti-hall/fake-calls"
check "good --sha256 installs" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/v2/ah-engine --sha256 '"$good"' >/dev/null && [ "$('"$bin"' version)" = 2.0.0 ]'
check ".prev holds the previous binary" sh -c '[ "$('"$bin"'.prev version)" = 1.0.0 ]'
check "daemon restarted via stop then serve" sh -c '[ "$(cat '"$home"'/.anti-hall/fake-calls | tr "\n" " ")" = "stop serve " ]'
rm -f "$home/.anti-hall/fake-calls"
check "idempotent re-run: already current, no restart, .prev untouched" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/v2/ah-engine --sha256 '"$good"' | grep -q "already current" && [ ! -f '"$home"'/.anti-hall/fake-calls ] && [ "$('"$bin"'.prev version)" = 1.0.0 ]'

# ---- rollback toggles --------------------------------------------------------------------------------------------------------------
check "--rollback restores .prev" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --rollback >/dev/null && [ "$('"$bin"' version)" = 1.0.0 ] && [ "$('"$bin"'.prev version)" = 2.0.0 ]'
check "--rollback again toggles forward" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --rollback >/dev/null && [ "$('"$bin"' version)" = 2.0.0 ]'

# ---- offline: SHA256SUMS next to the file, and the lock ----------------------------------------------------------------------------
mkdir -p "$tmp/dl"
mkeng "$tmp/v3" 3.0.0; cp "$tmp/v3/ah-engine" "$tmp/dl/ah-engine-3"
printf '%s  ah-engine-3\n' "$(sha "$tmp/dl/ah-engine-3")" >"$tmp/dl/SHA256SUMS"
check "SHA256SUMS next to the file verifies" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/dl/ah-engine-3 --no-restart >/dev/null && [ "$('"$bin"' version)" = 3.0.0 ]'
printf '%s  ah-engine-3\n' "$(printf 1%.0s $(seq 64))" >"$tmp/dl/SHA256SUMS"
mkeng "$tmp/v4" 4.0.0; cp "$tmp/v4/ah-engine" "$tmp/dl/ah-engine-4"
printf '%s  ah-engine-4\n' "$(printf 1%.0s $(seq 64))" >"$tmp/dl/SHA256SUMS"
check "a wrong SHA256SUMS entry refuses" sh -c '! HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/dl/ah-engine-4 --yes >/dev/null 2>&1 && [ "$('"$bin"' version)" = 3.0.0 ]'
rm -f "$tmp/dl/SHA256SUMS"
printf '{"schema":1,"version":"4.0.0","assets":{"ah-engine-4":"%s"}}\n' "$(sha "$tmp/dl/ah-engine-4")" >"$plug/ah-engine.lock"
check "the lock verifies when nothing else is given" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/dl/ah-engine-4 --no-restart >/dev/null && [ "$('"$bin"' version)" = 4.0.0 ]'
rm -f "$plug/ah-engine.lock"

# ---- a failing smoke test keeps the old binary ------------------------------------------------------------------------------------
mkeng "$tmp/vbad" 9.9.9 broken
rm -f "$home/.anti-hall/fake-calls"
check "failing smoke test: refused, old binary and .prev kept, no restart" sh -c '! HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/vbad/ah-engine --yes >/dev/null 2>&1 && [ "$('"$bin"' version)" = 4.0.0 ] && [ "$('"$bin"'.prev version)" = 3.0.0 ] && [ ! -f '"$home"'/.anti-hall/fake-calls ]'
check "--dry-run installs nothing" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --from '"$tmp"'/v1/ah-engine --yes --dry-run >/dev/null && [ "$('"$bin"' version)" = 4.0.0 ]'

# ---- stable channel (fake release server) ------------------------------------------------------------------------------------------
mkdir -p "$tmp/www/repos/talas9/anti-hall" "$tmp/www/dl/ah-engine-v5.0.0" "$tmp/www/dl/ah-engine-dev-abcd1234"
mktar "ah-engine-v5.0.0-$triple" 5.0.0
mv "$tmp/www/ah-engine-v5.0.0-$triple.tar.gz" "$tmp/www/dl/ah-engine-v5.0.0/"
printf '%s  ah-engine-v5.0.0-%s.tar.gz\n' "$(sha "$tmp/www/dl/ah-engine-v5.0.0/ah-engine-v5.0.0-$triple.tar.gz")" "$triple" >"$tmp/www/dl/ah-engine-v5.0.0/SHA256SUMS"
mktar "ah-engine-dev-abcd1234-$triple" 6.0.0-dev
mv "$tmp/www/ah-engine-dev-abcd1234-$triple.tar.gz" "$tmp/www/dl/ah-engine-dev-abcd1234/"
printf '%s  ah-engine-dev-abcd1234-%s.tar.gz\n' "$(sha "$tmp/www/dl/ah-engine-dev-abcd1234/ah-engine-dev-abcd1234-$triple.tar.gz")" "$triple" >"$tmp/www/dl/ah-engine-dev-abcd1234/SHA256SUMS"
cat >"$tmp/www/repos/talas9/anti-hall/releases" <<'EOS'
[
  {
    "tag_name": "ah-engine-dev-abcd1234",
    "prerelease": true
  },
  {
    "tag_name": "ah-engine-v5.0.0",
    "prerelease": false
  },
  {
    "tag_name": "v0.300.0",
    "prerelease": false
  }
]
EOS
check "--channel stable installs the latest ah-engine-v*" sh -c 'cd '"$tmp"' && HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --channel stable --no-restart >/dev/null && [ "$('"$bin"' version)" = 5.0.0 ]'
# a tampered SHA256SUMS entry
cp "$tmp/www/dl/ah-engine-v5.0.0/SHA256SUMS" "$tmp/sums.good"
printf '%s  ah-engine-v5.0.0-%s.tar.gz\n' "$(printf 2%.0s $(seq 64))" "$triple" >"$tmp/www/dl/ah-engine-v5.0.0/SHA256SUMS"
cp "$tmp/v1/ah-engine" "$bin"
check "stable: release SHA256SUMS mismatch refuses" sh -c '! HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --channel stable >/dev/null 2>&1 && [ "$('"$bin"' version)" = 1.0.0 ]'
cp "$tmp/sums.good" "$tmp/www/dl/ah-engine-v5.0.0/SHA256SUMS"
check "--channel dev (no live kit) installs the latest dev pre-release and says the plugin is not synced" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --channel dev --no-restart | grep -q "plugin: not synced" && [ "$('"$bin"' version)" = 6.0.0-dev ]'
check "an unknown channel is a usage error" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 sh '"$upd"' --channel nightly >/dev/null 2>&1; [ $? -eq 2 ]'

# ---- auto mode -------------------------------------------------------------------------------------------------------------------
cp "$tmp/v1/ah-engine" "$bin"
check "--auto with the setting off does nothing" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --auto >/dev/null && [ "$('"$bin"' version)" = 1.0.0 ]'
printf '{"engine":{"autoUpdate":"stable"}}\n' >"$home/.anti-hall/settings.json"
check "--auto with autoUpdate=stable updates" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --auto --no-restart >/dev/null && [ "$('"$bin"' version)" = 5.0.0 ]'
cp "$tmp/v1/ah-engine" "$bin"
check "--auto is limited to once per interval" sh -c 'HOME='"$home"' AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE='"$triple"' AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:'"$port"' AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:'"$port"'/dl sh '"$upd"' --auto --no-restart >/dev/null && [ "$('"$bin"' version)" = 1.0.0 ]'
rm -f "$home/.anti-hall/settings.json" "$home/.anti-hall/ah-engine/update.checked"

# ---- live kit: dev channel syncs the plugin through the kit, rollback restores the previous bundle ---------------------------------
kit=$tmp/kit
mkdir -p "$kit/state" "$kit/bundle/plugin/engine/defaults"
echo '{}' >"$kit/state/live.json"
mkeng "$kit/bundle" 1.0.0; echo old >"$kit/bundle/plugin/marker.txt"
cat >"$kit/go-live.sh" <<'EOS'
#!/bin/sh
# stub kit: records the engine and plugin marker it was asked to apply, installs the bundle engine like the real one
KIT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
echo "$(cat "$KIT/bundle/plugin/marker.txt" 2>/dev/null) $("$KIT/bundle/ah-engine" version) $1" >>"$KIT/applied"
mkdir -p "$HOME/.anti-hall/ah-engine/bin" && cp "$KIT/bundle/ah-engine" "$HOME/.anti-hall/ah-engine/bin/ah-engine"
[ -e "$KIT/fail" ] && exit 1
exit 0
EOS
# a git repo that "contains the engine-proto commit" the pre-release records
g=$tmp/gitsrc
mkdir -p "$g/plugins/anti-hall/engine/defaults"
(cd "$g" && git init -q && git config user.email t@t && git config user.name t && git config uploadpack.allowAnySHA1InWant true \
  && echo new >plugins/anti-hall/marker.txt && : >plugins/anti-hall/engine/defaults/index.toml && git add -A && git commit -q -m c)
commit=$(git -C "$g" rev-parse HEAD)
printf '%s\n' "$commit" >"$tmp/www/dl/ah-engine-dev-abcd1234/COMMIT"
lrun() { HOME=$home AH_LIVE_KIT=$kit AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE=$triple AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:$port AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:$port/dl AH_UPDATE_GIT_URL=file://$g sh "$upd" "$@"; }
lrun --channel dev --no-restart >"$tmp/live.out" 2>&1
check "live dev: re-applied with the new plugin and engine" sh -c '[ "$(tail -1 '"$kit"'/applied)" = "new 6.0.0-dev all-agreeing" ]'
check "live dev: previous bundle kept as bundle.pre-update-*" sh -c 'ls -d '"$kit"'/bundle.pre-update-* >/dev/null 2>&1 && [ "$(cat '"$kit"'/bundle.pre-update-*/plugin/marker.txt)" = old ]'
lrun --channel dev --no-restart >"$tmp/live1b.out" 2>&1
check "live dev: a repeat with the same engine and plugin changes nothing" sh -c 'grep -q "already current" '"$tmp"'/live1b.out && [ "$(wc -l <'"$kit"'/applied | tr -d " ")" = 1 ]'
lrun --rollback --no-restart >"$tmp/live2.out" 2>&1
check "live rollback: previous bundle re-applied" sh -c '[ "$(tail -1 '"$kit"'/applied)" = "old 1.0.0 all-agreeing" ]'
touch "$kit/fail"
lrun --channel dev --no-restart >"$tmp/live3.out" 2>&1; rc=$?
check "live: a failing go-live puts the previous bundle back and exits 1" sh -c '[ '"$rc"' -eq 1 ] && [ "$(cat '"$kit"'/bundle/plugin/marker.txt)" = old ] && ls -d '"$kit"'/bundle.failed-* >/dev/null 2>&1'
rm -f "$kit/fail"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

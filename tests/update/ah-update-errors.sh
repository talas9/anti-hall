#!/bin/sh
# Failure-message tests for plugins/anti-hall/hooks/ah-update.sh (#143): every failure class says WHAT failed, the STATE it left and
# ONE exact NEXT step (a usage error says what is wrong and prints a usage hint). Scratch HOME, fake engines, a LOCAL http server and
# a stub live kit: no real network, and the real ~/.anti-hall is never touched.
set -u
repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
src=$repo/plugins/anti-hall
tmp=${AH_TEST_SCRATCH:-${TMPDIR:-/tmp}}/ah-update-errors.$$
mkdir -p "$tmp/www"
server_pid=
trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"' EXIT HUP INT TERM

pass=0; fail=0
plug=$tmp/plugin
mkdir -p "$plug/hooks" "$plug/engine"
cp "$src/hooks/ah-update.sh" "$src/hooks/ah-engine-bootstrap.sh" "$plug/hooks/"
cp "$src/engine/ah-update.toml" "$plug/engine/"
upd=$plug/hooks/ah-update.sh
home=$tmp/home
bin=$home/.anti-hall/ah-engine/bin/ah-engine
triple=x86_64-unknown-linux-gnu
mkdir -p "$home/.anti-hall/ah-engine/bin"

mkeng() { # mkeng DIR VERSION [broken]
  mkdir -p "$1"
  if [ "${3:-}" = broken ]; then printf '#!/bin/sh\nexit 1\n' >"$1/ah-engine"
  else printf '#!/bin/sh\ncase "$1" in version) echo %s ;; esac\nexit 0\n' "$2" >"$1/ah-engine"; fi
  chmod 755 "$1/ah-engine"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

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

mkeng "$tmp/v1" 1.0.0
cp "$tmp/v1/ah-engine" "$bin"
env_base="HOME=$home AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE=$triple AH_UPDATE_NO_ATTEST=1 AH_UPDATE_API_BASE=http://127.0.0.1:$port AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:$port/dl"
run() { env $env_base sh "$upd" "$@"; }

# expect NAME CODE KIND WHAT_RE STATE_RE NEXT_RE -- cmd...   (KIND: fail = what/state/next, usage = what/usage)
expect() {
  n=$1; code=$2; kind=$3; wre=$4; sre=$5; nre=$6; shift 7
  out=$("$@" 2>&1); rc=$?
  ok=1
  [ "$rc" -eq "$code" ] || { ok=0; printf 'FAIL %s: exit %s, wanted %s\n' "$n" "$rc" "$code" >&2; }
  first=$(printf '%s\n' "$out" | grep -m1 '^ah-update: ')
  printf '%s\n' "$first" | grep -Eq "^ah-update: .+" || { ok=0; printf 'FAIL %s: no "ah-update: <what failed>" line\n' "$n" >&2; }
  printf '%s\n' "$first" | grep -Eq -e "$wre" || { ok=0; printf 'FAIL %s: what line "%s" lacks /%s/\n' "$n" "$first" "$wre" >&2; }
  if [ "$kind" = usage ]; then
    printf '%s\n' "$out" | grep -Eq '^  usage: .+' || { ok=0; printf 'FAIL %s: no usage hint\n' "$n" >&2; }
    printf '%s\n' "$out" | grep -q 'refusing' && { ok=0; printf 'FAIL %s: a usage error must not say "refusing"\n' "$n" >&2; }
  else
    st=$(printf '%s\n' "$out" | grep -m1 '^  state: ')
    nx=$(printf '%s\n' "$out" | grep -m1 '^  next: ')
    [ -n "$st" ] && [ "${#st}" -gt 12 ] || { ok=0; printf 'FAIL %s: no "  state:" line\n' "$n" >&2; }
    [ -n "$nx" ] && [ "${#nx}" -gt 11 ] || { ok=0; printf 'FAIL %s: no "  next:" line\n' "$n" >&2; }
    printf '%s\n' "$st" | grep -Eq -e "$sre" || { ok=0; printf 'FAIL %s: state line "%s" lacks /%s/\n' "$n" "$st" "$sre" >&2; }
    printf '%s\n' "$nx" | grep -Eq -e "$nre" || { ok=0; printf 'FAIL %s: next line "%s" lacks /%s/\n' "$n" "$nx" "$nre" >&2; }
    [ "$(printf '%s\n' "$out" | grep -c '^  next: ')" -eq 1 ] || { ok=0; printf 'FAIL %s: more than one next step\n' "$n" >&2; }
  fi
  if [ "$ok" -eq 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf '%s\n' "$out" | sed 's/^/    | /' >&2; fi
}
engine_still() { [ "$("$bin" version)" = 1.0.0 ]; }

# ---- usage errors (exit 2): what is wrong + a usage hint, never "refusing" ------------------------------------------------------
expect "no action" 2 usage "nothing to do" "" "" -- run
expect "two actions" 2 usage "exactly one" "" "" -- run --rollback --from "$tmp/v1/ah-engine"
expect "unknown argument" 2 usage "unknown argument '--bogus'" "" "" -- run --bogus
expect "unknown channel" 2 usage "unknown channel 'nightly'" "" "" -- run --channel nightly
expect "bad --sha256" 2 usage "--sha256 must be 64" "" "" -- run --from "$tmp/v1/ah-engine" --sha256 xyz
expect "missing --from file" 2 usage "no such file: $tmp/nope" "" "" -- run --from "$tmp/nope"

# ---- start-up failures (exit 1, stderr) ----------------------------------------------------------------------------------------
expect "settings file missing" 1 fail "settings file is missing" "nothing changed" "claude plugin update anti-hall|--config" -- run --config "$tmp/none.toml" --rollback
expect "HOME unset" 1 fail "HOME is not set" "nothing changed" "HOME=" -- env -u HOME AH_WRAPPER_TEST=1 sh "$upd" --rollback
printf 'repo = "x"\n' >"$tmp/short.toml"
expect "settings missing keys" 1 fail "missing required keys" "nothing changed" "restore the file" -- run --config "$tmp/short.toml" --rollback

# ---- lock held ------------------------------------------------------------------------------------------------------------------
mkdir -p "$home/.anti-hall/ah-engine/update.lock"
expect "another update running" 1 fail "another update is running" "nothing changed.*carries on" "rmdir " -- run --rollback
rmdir "$home/.anti-hall/ah-engine/update.lock"

# ---- rollback ---------------------------------------------------------------------------------------------------------------------
rm -f "$bin.prev"
expect "rollback without .prev" 1 fail "nothing to roll back to" "nothing changed - engine 1.0.0 is still active" "run one first|ah-update.sh --channel" -- run --rollback
mkeng "$tmp/vb" 9.9.9 broken; cp "$tmp/vb/ah-engine" "$bin.prev"
expect "rollback to a .prev that does not run" 1 fail "does not run on this machine" "nothing changed - engine 1.0.0" "ah-update.sh --channel stable" -- run --rollback
engine_still && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL engine changed by a failed rollback" >&2; }
rm -f "$bin.prev"

# ---- offline file -----------------------------------------------------------------------------------------------------------------
mkeng "$tmp/v2" 2.0.0
expect "offline checksum mismatch" 1 fail "checksum of ah-engine does not match" "nothing changed - engine 1.0.0.*not installed" "fresh copy|SHA256SUMS" -- run --from "$tmp/v2/ah-engine" --sha256 "$(printf 0%.0s $(seq 64))"
expect "offline file with nothing to verify it against" 3 fail "cannot be verified" "nothing changed - engine 1.0.0.*not installed" "--sha256 [0-9a-f]{64}" -- run --from "$tmp/v2/ah-engine"
mkeng "$tmp/vbad" 9.9.9 broken
expect "new engine fails its smoke test" 1 fail "does not run on this machine" "nothing changed - engine 1.0.0.*not replaced" "report the platform|--channel stable" -- run --from "$tmp/vbad/ah-engine" --yes
engine_still && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL engine changed by a failed smoke test" >&2; }
printf 'not an archive' >"$tmp/junk.tar.gz"; tar -czf "$tmp/nomember.tar.gz" -C "$tmp" junk.tar.gz
expect "archive without an engine member" 1 fail "has no <dir>/ah-engine member" "nothing changed" "bare binary|release" -- run --from "$tmp/nomember.tar.gz" --yes

# ---- online -----------------------------------------------------------------------------------------------------------------------
expect "network down" 1 fail "cannot reach http://127.0.0.1:1/repos/talas9/anti-hall/releases" "nothing changed - engine 1.0.0" "check the connection.*--channel dev" -- env $env_base AH_UPDATE_API_BASE=http://127.0.0.1:1 sh "$upd" --channel dev
mkdir -p "$tmp/www/repos/talas9/anti-hall"
printf '[\n  {\n    "tag_name": "v0.300.0"\n  }\n]\n' >"$tmp/www/repos/talas9/anti-hall/releases"
expect "dev channel not published yet" 1 fail "no dev build is published yet" "nothing changed - engine 1.0.0" "retry after a build is published|--channel stable" -- run --channel dev
printf '[\n  {\n    "tag_name": "ah-engine-dev-abcd1234"\n  }\n]\n' >"$tmp/www/repos/talas9/anti-hall/releases"
mkdir -p "$tmp/www/dl/ah-engine-dev-abcd1234"
expect "checksum file missing" 1 fail "cannot download the checksum file SHA256SUMS" "nothing changed - engine 1.0.0" "wait a few minutes" -- run --channel dev
asset=ah-engine-dev-abcd1234-$triple.tar.gz
printf '%s  %s\n' "$(printf 3%.0s $(seq 64))" "$asset" >"$tmp/www/dl/ah-engine-dev-abcd1234/SHA256SUMS"
expect "asset missing" 1 fail "cannot download $asset" "nothing changed - engine 1.0.0" "retry later|--from FILE" -- run --channel dev
rm -rf "$tmp/pkg"; mkeng "$tmp/pkg/ah-engine-dev-abcd1234-$triple" 6.0.0-dev
tar -czf "$tmp/www/dl/ah-engine-dev-abcd1234/$asset" -C "$tmp/pkg" "ah-engine-dev-abcd1234-$triple"
expect "release checksum mismatch" 1 fail "checksum of the downloaded $asset does not match" "nothing changed - engine 1.0.0.*discarded" "run the same command again" -- run --channel dev
printf '%s  %s\n' "$(sha "$tmp/www/dl/ah-engine-dev-abcd1234/$asset")" "ah-engine-dev-abcd1234-$triple.tar.gz.other" >"$tmp/www/dl/ah-engine-dev-abcd1234/SHA256SUMS"
expect "checksum file has no entry" 1 fail "has no entry for $asset" "nothing changed - engine 1.0.0" "still being assembled" -- run --channel dev
printf '%s  %s\n' "$(sha "$tmp/www/dl/ah-engine-dev-abcd1234/$asset")" "$asset" >"$tmp/www/dl/ah-engine-dev-abcd1234/SHA256SUMS"
expect "unsupported platform" 1 fail "no ah-engine build is published for this platform" "nothing changed - engine 1.0.0" "--from FILE" -- env $env_base AH_UPDATE_TRIPLE=unsupported sh "$upd" --channel dev
# a gh that is logged in and rejects the attestation
mkdir -p "$tmp/fakebin"
printf '#!/bin/sh\ncase "$1 $2" in "attestation verify") echo "no matching attestation" >&2; exit 1 ;; "auth status") exit 0 ;; esac\nexit 0\n' >"$tmp/fakebin/gh"; chmod 755 "$tmp/fakebin/gh"
expect "attestation rejected" 1 fail "attestation check failed for $asset" "nothing changed - engine 1.0.0.*discarded" "do not install this build" -- env PATH="$tmp/fakebin:$PATH" HOME=$home AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE=$triple AH_UPDATE_API_BASE=http://127.0.0.1:$port AH_UPDATE_DOWNLOAD_BASE=http://127.0.0.1:$port/dl sh "$upd" --channel dev
# no curl or wget on PATH: a farm of just the tools the script needs
mkdir -p "$tmp/tools"
for t in sh sed head tr cat date mkdir rmdir find rm wc tail awk grep ls mv cp tar sort dirname basename shasum sleep kill chmod uname env printf; do
  p=$(command -v "$t" 2>/dev/null) && [ -n "$p" ] && ln -sf "$p" "$tmp/tools/$t"
done
expect "no download tool" 1 fail "neither curl nor wget is installed" "nothing changed - engine 1.0.0" "install curl" -- env -i PATH="$tmp/tools" HOME=$home AH_WRAPPER_TEST=1 AH_UPDATE_TRIPLE=$triple sh "$upd" --channel dev

# ---- live kit ---------------------------------------------------------------------------------------------------------------------
kit=$tmp/kit
mkdir -p "$kit/state" "$kit/bundle/plugin/engine/defaults"
echo '{}' >"$kit/state/live.json"
mkeng "$kit/bundle" 1.0.0; echo old >"$kit/bundle/plugin/marker.txt"
printf '#!/bin/sh\nKIT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)\n[ -e "$KIT/fail" ] && { echo "go-live: boom" >&2; exit 1; }\nexit 0\n' >"$kit/go-live.sh"
lrun() { env $env_base AH_LIVE_KIT=$kit sh "$upd" "$@"; }
expect "live rollback with no earlier bundle" 1 fail "nothing to roll back to" "nothing changed - engine 1.0.0" "update first" -- lrun --rollback
touch "$kit/fail"
expect "live update: go-live fails" 1 fail "live kit could not apply the new bundle" "rolled back: the bundle that was current is back in place" "tail -n 30 .*go-live.sh" -- lrun --from "$tmp/v2/ah-engine" --yes

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

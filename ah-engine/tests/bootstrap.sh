#!/bin/sh
# Tests for plugins/anti-hall/hooks/ah-engine-bootstrap.sh. Isolated HOME; assets come from a LOCAL http server; no real network.
set -eu
AH_WRAPPER_TEST=1
export AH_WRAPPER_TEST

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
boot=$repo/plugins/anti-hall/hooks/ah-engine-bootstrap.sh
wrapper=$repo/plugins/anti-hall/hooks/ah-hook.sh
tmp=${TMPDIR:-/tmp}/ah-bootstrap-test.$$
mkdir -p "$tmp/www"
server_pid=
trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"' EXIT HUP INT TERM

pass=0
fail=0
check() {
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$1" >&2; fi
}

ver=9.8.7
triple=x86_64-unknown-linux-gnu
name=ah-engine-v$ver-$triple

# Fake release asset: a tarball whose ah-engine prints its version.
mkdir -p "$tmp/pkg/$name"
printf '#!/bin/sh\necho %s\n' "$ver" >"$tmp/pkg/$name/ah-engine"
chmod 755 "$tmp/pkg/$name/ah-engine"
tar -czf "$tmp/www/$name.tar.gz" -C "$tmp/pkg" "$name"
# Wrong-content twin served under a second version, to test a hash mismatch.
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
good=$(sha_of "$tmp/www/$name.tar.gz")
mkdir -p "$tmp/www/ah-engine-v$ver"
mv "$tmp/www/$name.tar.gz" "$tmp/www/ah-engine-v$ver/$name.tar.gz"

# Local server on an ephemeral port.
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
n=0
while [ ! -s "$tmp/port" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
port=$(cat "$tmp/port")
AH_ENGINE_RELEASE_BASE=http://127.0.0.1:$port
export AH_ENGINE_RELEASE_BASE

write_lock() { # <file> <version> <triple> <sha>
  printf '{\n  "schema": 1,\n  "version": "%s",\n  "tag": "ah-engine-v%s",\n  "fingerprint": "x",\n  "assets": {\n    "ah-engine-v%s-%s.tar.gz": "%s"\n  }\n}\n' "$2" "$2" "$2" "$3" "$4" >"$1"
}

newhome() { HOME=$tmp/home.$1; export HOME; rm -rf "$HOME"; mkdir -p "$HOME"; }
engine() { printf '%s' "$HOME/.anti-hall/ah-engine/bin/ah-engine"; }
logf() { cat "$HOME/.anti-hall/ah-engine/bootstrap.log" 2>/dev/null || true; }
run() { AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.0 AH_BOOTSTRAP_LIBC=gnu sh "$boot" --lock "$tmp/lock" "$@"; }

t_good() {
  newhome good; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1
  [ -x "$(engine)" ] && [ "$("$(engine)" version)" = "$ver" ] || return 1
  logf | grep -q 'ok: installed' || return 1
  # Idempotent: a second run changes nothing and logs nothing new.
  before=$(logf | wc -l); run
  [ "$before" = "$(logf | wc -l)" ]
}
t_keeps_previous() {
  newhome prev; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1
  # A new lock version (same fake asset served for it) replaces the binary and keeps the old one as .prev.
  mkdir -p "$tmp/www/ah-engine-v9.8.8"
  mkdir -p "$tmp/pkg2/ah-engine-v9.8.8-$triple"
  printf '#!/bin/sh\necho 9.8.8\n' >"$tmp/pkg2/ah-engine-v9.8.8-$triple/ah-engine"; chmod 755 "$tmp/pkg2/ah-engine-v9.8.8-$triple/ah-engine"
  tar -czf "$tmp/www/ah-engine-v9.8.8/ah-engine-v9.8.8-$triple.tar.gz" -C "$tmp/pkg2" "ah-engine-v9.8.8-$triple"
  s2=$(sha_of "$tmp/www/ah-engine-v9.8.8/ah-engine-v9.8.8-$triple.tar.gz")
  write_lock "$tmp/lock" 9.8.8 "$triple" "$s2"
  run || return 1
  [ "$("$(engine)" version)" = 9.8.8 ] && [ "$("$(engine).prev" version)" = "$ver" ]
}
t_wrong_hash() {
  newhome bad; write_lock "$tmp/lock" "$ver" "$triple" "0000000000000000000000000000000000000000000000000000000000000000"
  run || return 1
  [ ! -e "$(engine)" ] || return 1
  logf | grep -q 'sha256 mismatch' || return 1
  # Rate limited: an immediate retry does not hit the network again (no new log line).
  before=$(logf | wc -l); run
  [ "$before" = "$(logf | wc -l)" ] || return 1
  # The wrapper still answers through the Node fallback with no engine: SessionStart with the real list must not fail.
  ls "$tmp/home.bad/.anti-hall/ah-engine/bin" | grep -q . && return 1
  return 0
}
t_offline() {
  newhome off; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_ENGINE_RELEASE_BASE=http://127.0.0.1:1 run || return 1
  [ ! -e "$(engine)" ] || return 1
  logf | grep -q 'download failed' || return 1
  # Within the retry window a retry stays quiet; once it passes (and the network is back) the engine installs.
  before=$(logf | wc -l); run
  [ "$before" = "$(logf | wc -l)" ] && [ ! -e "$(engine)" ] || return 1
  AH_BOOTSTRAP_RETRY_S=0 run || return 1
  # An installed engine is untouched when a later attempt is offline.
  [ -x "$(engine)" ] || return 1
  write_lock "$tmp/lock" 9.8.9 "$triple" "$good"
  AH_BOOTSTRAP_RETRY_S=0 AH_ENGINE_RELEASE_BASE=http://127.0.0.1:1 run || return 1
  [ "$("$(engine)" version)" = "$ver" ]
}
t_unmanaged_untouched() {
  newhome unm; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  mkdir -p "$HOME/.anti-hall/ah-engine/bin"; printf '#!/bin/sh\necho mine\n' >"$(engine)"; chmod 755 "$(engine)"
  run || return 1
  [ "$("$(engine)")" = mine ]
}
t_targets() {
  [ "$(AH_BOOTSTRAP_UNAME_S=Darwin AH_BOOTSTRAP_UNAME_M=arm64 sh "$boot" --print-target)" = aarch64-apple-darwin ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Darwin AH_BOOTSTRAP_UNAME_M=x86_64 sh "$boot" --print-target)" = x86_64-apple-darwin ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu sh "$boot" --print-target)" = x86_64-unknown-linux-gnu ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=musl sh "$boot" --print-target)" = x86_64-unknown-linux-musl ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=aarch64 AH_BOOTSTRAP_LIBC=gnu sh "$boot" --print-target)" = aarch64-unknown-linux-gnu ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=aarch64 AH_BOOTSTRAP_LIBC=musl sh "$boot" --print-target)" = aarch64-unknown-linux-musl ]
}
t_wsl() {
  # WSL2 is Linux with "microsoft" in the kernel release: same Linux targets, noted as wsl in the log.
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.153.1-microsoft-standard-WSL2 AH_BOOTSTRAP_LIBC=gnu sh "$boot" --print-target)" = x86_64-unknown-linux-gnu ] || return 1
  newhome wsl; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_BOOTSTRAP_UNAME_R=5.15.153.1-microsoft-standard-WSL2 AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu sh "$boot" --lock "$tmp/lock" || return 1
  logf | grep -q '(wsl)' && [ -x "$(engine)" ]
}
t_unknown_arch() {
  newhome arch; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=riscv64 sh "$boot" --lock "$tmp/lock" || return 1
  AH_BOOTSTRAP_UNAME_S=FreeBSD AH_BOOTSTRAP_UNAME_M=x86_64 sh "$boot" --lock "$tmp/lock" || return 1
  [ ! -e "$(engine)" ] && [ "$(logf | grep -c 'unsupported platform')" = 2 ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=riscv64 sh "$boot" --print-target)" = unsupported ]
}
t_no_lock_or_bad_lock() {
  newhome nolock
  sh "$boot" --lock "$tmp/does-not-exist" || return 1
  printf 'not json' >"$tmp/lock"
  run || return 1
  [ ! -e "$(engine)" ] && logf | grep -q 'skip: unsupported lock schema'
}
t_opt_out() {
  newhome off2; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_ENGINE_BOOTSTRAP=0 run || return 1
  [ ! -e "$(engine)" ] && [ ! -e "$HOME/.anti-hall" ]
}
t_opt_out_setting() {
  # settings key engine.bootstrap=false opts out; the env var 1 overrides it; true / absent installs.
  newhome offset; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  mkdir -p "$HOME/.anti-hall"
  printf '{\n  "jev": {"enabled": true},\n  "engine": {\n    "bootstrap": false\n  }\n}\n' >"$HOME/.anti-hall/settings.json"
  run || return 1
  [ ! -e "$(engine)" ] || return 1
  AH_ENGINE_BOOTSTRAP=1 run || return 1
  [ -x "$(engine)" ] || return 1
  newhome onset; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  mkdir -p "$HOME/.anti-hall"
  printf '{"engine":{"bootstrap":true},"other":{"bootstrap":false}}' >"$HOME/.anti-hall/settings.json"
  run || return 1
  [ -x "$(engine)" ]
}
t_wrapper_spawns() {
  # SessionStart through the wrapper installs the engine in the background when the plugin ships a lock; a copy of the
  # hooks dir stands in for the plugin so the repo tree is not touched.
  newhome wrap
  mkdir -p "$tmp/plug/hooks"; cp "$wrapper" "$boot" "$repo"/plugins/anti-hall/hooks/ah-fallback.list "$repo"/plugins/anti-hall/hooks/ah-fallback.map.json "$tmp/plug/hooks/"
  write_lock "$tmp/plug/ah-engine.lock" "$ver" "$triple" "$good"
  printf '{}' | AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu sh "$tmp/plug/hooks/ah-hook.sh" SessionStart >/dev/null 2>&1 || true
  n=0
  while [ ! -x "$(engine)" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  [ -x "$(engine)" ] && [ "$("$(engine)" version)" = "$ver" ]
}

t_marker_records_the_binary() {
  newhome mark; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1
  set -- $(cat "$HOME/.anti-hall/ah-engine/bootstrap.installed")
  [ "$1 $2" = "$ver $good" ] && [ "${3:-}" = "$(sha_of "$(engine)")" ]
}
t_hand_built_untouched() {
  # A binary replaced by hand after the bootstrap installed one (a local build) is not overwritten by a newer lock.
  newhome hand; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1
  printf '#!/bin/sh\necho local-build\n' >"$(engine)"; chmod 755 "$(engine)"
  write_lock "$tmp/lock" 9.8.8 "$triple" "$s2"
  AH_BOOTSTRAP_RETRY_S=0 run || return 1
  [ "$("$(engine)")" = local-build ] && logf | grep -q 'not the binary the bootstrap installed'
}
t_version_check_gets_the_plugin_root() {
  # The real engine reads its settings from the plugin before it answers `version`: the check must name the plugin.
  newhome root
  v=9.8.6; n=ah-engine-v$v-$triple
  mkdir -p "$tmp/pkg3/$n" "$tmp/www/ah-engine-v$v"
  printf '#!/bin/sh\n[ -f "$AH_ENGINE_PLUGIN_ROOT/engine/defaults/index.toml" ] || { echo "defaults unavailable" >&2; exit 70; }\necho %s\n' "$v" >"$tmp/pkg3/$n/ah-engine"
  chmod 755 "$tmp/pkg3/$n/ah-engine"
  tar -czf "$tmp/www/ah-engine-v$v/$n.tar.gz" -C "$tmp/pkg3" "$n"
  write_lock "$tmp/lock" "$v" "$triple" "$(sha_of "$tmp/www/ah-engine-v$v/$n.tar.gz")"
  env -u AH_ENGINE_PLUGIN_ROOT -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT sh -c 'AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.0 AH_BOOTSTRAP_LIBC=gnu sh "$1" --lock "$2"' _ "$boot" "$tmp/lock" || return 1
  [ -x "$(engine)" ] && logf | grep -q 'ok: installed ah-engine 9.8.6'
}

# A downloaded binary that hangs and ignores TERM must not hang the bootstrap or hold its lock: it exits 0, logs the failure, installs nothing.
t_hanging_binary_is_bounded() {
  newhome hang; v=9.8.5; n=ah-engine-v$v-$triple
  mkdir -p "$tmp/pkg5/$n" "$tmp/www/ah-engine-v$v"
  printf '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n' >"$tmp/pkg5/$n/ah-engine"; chmod 755 "$tmp/pkg5/$n/ah-engine"
  tar -czf "$tmp/www/ah-engine-v$v/$n.tar.gz" -C "$tmp/pkg5" "$n"
  write_lock "$tmp/lock" "$v" "$triple" "$(sha_of "$tmp/www/ah-engine-v$v/$n.tar.gz")"
  t0=$(date +%s)
  AH_BOOTSTRAP_RUN_S=2 run || return 1
  t1=$(date +%s)
  [ $((t1 - t0)) -le 15 ] && [ ! -e "$(engine)" ] && logf | grep -q "did not answer 'version'" && [ ! -d "$HOME/.anti-hall/ah-engine/bootstrap.lock" ]
}

check t_good
check t_hanging_binary_is_bounded
check t_keeps_previous
check t_marker_records_the_binary
check t_hand_built_untouched
check t_version_check_gets_the_plugin_root
check t_wrong_hash
check t_offline
check t_unmanaged_untouched
check t_targets
check t_wsl
check t_unknown_arch
check t_no_lock_or_bad_lock
check t_opt_out
check t_opt_out_setting
check t_wrapper_spawns

printf 'bootstrap: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

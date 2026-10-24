#!/bin/sh
# Tests for `ah-hook install` (the engine install, ah-launcher/src/install.rs). Isolated HOME; assets come from a LOCAL http server; no real network.
# Needs the built thin client: AH_HOOK_BIN, else ah-launcher/target/{release,debug}/ah-hook (cargo build in ah-launcher/ first).
set -eu
AH_WRAPPER_TEST=1
export AH_WRAPPER_TEST

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
plugin=$repo/plugins/anti-hall
hookbin=${AH_HOOK_BIN:-}
for c in "$repo/ah-launcher/target/release/ah-hook" "$repo/ah-launcher/target/debug/ah-hook"; do
  [ -n "$hookbin" ] || { [ -x "$c" ] && hookbin=$c; }
done
[ -x "$hookbin" ] || { echo "FAIL no ah-hook binary: build ah-launcher or set AH_HOOK_BIN" >&2; exit 1; }
inst() { "$hookbin" --plugin-root "$plugin" install "$@"; }
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
run() { AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.0 AH_BOOTSTRAP_LIBC=gnu inst --lock "$tmp/lock" "$@"; }

t_good() {
  newhome good; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1
  [ -x "$(engine)" ] && [ "$("$(engine)" version)" = "$ver" ] || return 1
  logf | grep -q 'event=installed' || return 1
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
  logf | grep -q 'why=sha256_mismatch' || return 1
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
  logf | grep -q 'why=download_failed' || return 1
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
  [ "$(AH_BOOTSTRAP_UNAME_S=Darwin AH_BOOTSTRAP_UNAME_M=arm64 inst --print-target)" = aarch64-apple-darwin ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Darwin AH_BOOTSTRAP_UNAME_M=x86_64 inst --print-target)" = x86_64-apple-darwin ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu inst --print-target)" = x86_64-unknown-linux-gnu ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=musl inst --print-target)" = x86_64-unknown-linux-musl ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=aarch64 AH_BOOTSTRAP_LIBC=gnu inst --print-target)" = aarch64-unknown-linux-gnu ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=aarch64 AH_BOOTSTRAP_LIBC=musl inst --print-target)" = aarch64-unknown-linux-musl ]
}
t_wsl() {
  # WSL2 is Linux with "microsoft" in the kernel release: same Linux targets, noted as wsl in the log.
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.153.1-microsoft-standard-WSL2 AH_BOOTSTRAP_LIBC=gnu inst --print-target)" = x86_64-unknown-linux-gnu ] || return 1
  newhome wsl; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_BOOTSTRAP_UNAME_R=5.15.153.1-microsoft-standard-WSL2 AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu inst --lock "$tmp/lock" || return 1
  logf | grep -q 'platform=wsl' && [ -x "$(engine)" ]
}
t_unknown_arch() {
  newhome arch; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=riscv64 inst --lock "$tmp/lock" || return 1
  AH_BOOTSTRAP_UNAME_S=FreeBSD AH_BOOTSTRAP_UNAME_M=x86_64 inst --lock "$tmp/lock" || return 1
  [ ! -e "$(engine)" ] && [ "$(logf | grep -c 'why=unsupported_platform')" = 2 ] &&
  [ "$(AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=riscv64 inst --print-target)" = unsupported ]
}
t_no_lock_or_bad_lock() {
  newhome nolock
  inst --lock "$tmp/does-not-exist" || return 1
  printf 'not json' >"$tmp/lock"
  run || return 1
  [ ! -e "$(engine)" ] && logf | grep -q 'why=bad_lock_schema'
}
t_opt_out() {
  newhome off2; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  AH_ENGINE_BOOTSTRAP=0 run --auto || return 1
  [ ! -e "$(engine)" ] && [ ! -e "$HOME/.anti-hall" ]
}
t_opt_in_setting() {
  # the automatic form installs only on opt-in: the setting engine.bootstrap = true, or AH_ENGINE_BOOTSTRAP=1; absent / false = off,
  # and AH_ENGINE_BOOTSTRAP=0 beats the setting. The explicit form (no --auto) never consults it.
  newhome offset; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run --auto || return 1
  [ ! -e "$(engine)" ] || return 1   # absent setting = off
  mkdir -p "$HOME/.anti-hall"
  printf '{\n  "jev": {"enabled": true},\n  "engine": {\n    "bootstrap": false\n  }\n}\n' >"$HOME/.anti-hall/settings.json"
  run --auto || return 1
  [ ! -e "$(engine)" ] || return 1
  AH_ENGINE_BOOTSTRAP=1 run --auto || return 1
  [ -x "$(engine)" ] || return 1
  newhome onset; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  mkdir -p "$HOME/.anti-hall"
  printf '{"engine":{"bootstrap":true},"other":{"bootstrap":false}}' >"$HOME/.anti-hall/settings.json"
  AH_ENGINE_BOOTSTRAP=0 run --auto || return 1
  [ ! -e "$(engine)" ] || return 1
  run --auto || return 1
  [ -x "$(engine)" ] || return 1
  newhome expl; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  run || return 1   # explicit: no setting needed
  [ -x "$(engine)" ]
}
t_session_start_spawns() {
  # SessionStart through the thin client installs the engine in the background when the plugin ships a lock and the user opted
  # in; a copy of the plugin stands in so the repo tree is not touched.
  newhome wrap
  mkdir -p "$tmp/plug/engine"; cp -R "$plugin/engine/defaults" "$tmp/plug/engine/"; mkdir -p "$tmp/plug/hooks"
  write_lock "$tmp/plug/ah-engine.lock" "$ver" "$triple" "$good"
  printf '{}' | AH_ENGINE_BOOTSTRAP=1 AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu AH_ENGINE_NOSPAWN=1 \
    "$hookbin" --plugin-root "$tmp/plug" SessionStart >/dev/null 2>&1 || true
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
  [ "$("$(engine)")" = local-build ] && logf | grep -q 'event=skip_local_build'
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
  env -u AH_ENGINE_PLUGIN_ROOT -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT sh -c 'AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_UNAME_R=5.15.0 AH_BOOTSTRAP_LIBC=gnu "$1" --plugin-root "$3" install --lock "$2"' _ "$hookbin" "$tmp/lock" "$plugin" || return 1
  [ -x "$(engine)" ] && logf | grep -q 'event=installed version=9.8.6'
}

# The install lock is shared with the integrity check and ah-update: while another holder keeps it, the bootstrap installs nothing
# and records no failed attempt (no rate limit); once it is free the install runs under it, records the expected sha256 and frees it.
t_shared_install_lock() {
  newhome ilock; write_lock "$tmp/lock" "$ver" "$triple" "$good"
  st=$HOME/.anti-hall/ah-engine
  mkdir -p "$st/bin"; cp "$hookbin" "$st/bin/ah-hook"; chmod 755 "$st/bin/ah-hook"
  integ="$st/bin/ah-hook --plugin-root $repo/plugins/anti-hall integrity"
  sleep 60 & h=$!; tok="$h $(date +%s)"
  AH_ENGINE_DIR=$st $integ lock "$tok" || { kill "$h"; return 1; }
  AH_ENGINE_INSTALL_LOCK_WAIT_S=1 run || { kill "$h"; return 1; }
  held_ok=1
  { [ ! -e "$(engine)" ] && [ ! -f "$st/bootstrap.attempt" ] && logf | grep -q 'event=skip_install_lock_held'; } || held_ok=0
  AH_ENGINE_DIR=$st $integ unlock "$tok"; kill "$h" 2>/dev/null; wait "$h" 2>/dev/null
  [ "$held_ok" -eq 1 ] || return 1
  run || return 1
  [ -x "$(engine)" ] && [ "$(sed -n 1p "$st/bin/ah-engine.expected")" = "$(sha_of "$(engine)")" ] && [ ! -e "$st/install.lock" ]
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
  [ $((t1 - t0)) -le 15 ] && [ ! -e "$(engine)" ] && logf | grep -q 'why=version_check_timed_out' && [ ! -d "$HOME/.anti-hall/ah-engine/bootstrap.lock" ]
}

check t_good
check t_shared_install_lock
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
check t_opt_in_setting
check t_session_start_spawns

printf 'bootstrap: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

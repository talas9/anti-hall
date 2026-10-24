#!/bin/sh
# Tests for plugins/anti-hall/hooks/install.sh (the plugin's one shell file). Scratch HOME; the release archives are served from a
# scratch directory through file:// (curl, test mode); no real network, the real ~/.anti-hall is never touched.
set -u
repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
src=$repo/plugins/anti-hall
tmp=${TMPDIR:-/tmp}/ah-install-sh-test.$$
mkdir -p "$tmp/www"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
AH_WRAPPER_TEST=1; export AH_WRAPPER_TEST

pass=0; fail=0
check() { n=$1; shift; if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$n" >&2; fi; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# a scratch plugin: the real script and settings, a lock for the fake release below
plug=$tmp/plugin
mkdir -p "$plug/hooks" "$plug/engine"
cp "$src/hooks/install.sh" "$plug/hooks/"
cp -R "$src/engine/defaults" "$plug/engine/"
ver=9.8.7; triple=x86_64-unknown-linux-gnu; name=ah-engine-v$ver-$triple
mkdir -p "$tmp/pkg/$name" "$tmp/www/ah-engine-v$ver"
printf '#!/bin/sh\necho %s\n' "$ver" >"$tmp/pkg/$name/ah-engine"
printf '#!/bin/sh\necho "$@" >>"$HOME/hook-calls"\n' >"$tmp/pkg/$name/ah-hook"
chmod 755 "$tmp/pkg/$name/ah-engine" "$tmp/pkg/$name/ah-hook"
tar -czf "$tmp/www/ah-engine-v$ver/$name.tar.gz" -C "$tmp/pkg" "$name"
good=$(sha "$tmp/www/ah-engine-v$ver/$name.tar.gz")
write_lock() { # write_lock SHA
  printf '{\n  "schema": 1,\n  "version": "%s",\n  "assets": {\n    "%s.tar.gz": "%s"\n  }\n}\n' "$ver" "$name" "$1" >"$plug/ah-engine.lock"
}
newhome() { HOME=$tmp/home.$1; export HOME; rm -rf "$HOME"; mkdir -p "$HOME"; st=$HOME/.anti-hall/ah-engine; }
env_t() { AH_ENGINE_RELEASE_BASE=file://$tmp/www AH_BOOTSTRAP_UNAME_S=Linux AH_BOOTSTRAP_UNAME_M=x86_64 AH_BOOTSTRAP_LIBC=gnu "$@"; }
logf() { cat "$st/bootstrap.log" 2>/dev/null || true; }
hook() { # hook SESSION [EVENT]: one hook call; prints "<stdout-bytes> <rc>", stderr to $tmp/err
  printf '{"session_id":"%s","hook_event_name":"%s"}' "$1" "${2:-PreToolUse}" | sh "$plug/hooks/install.sh" "${2:-PreToolUse}" >"$tmp/out" 2>"$tmp/err"
  rc=$?; printf '%s %s' "$(wc -c <"$tmp/out" | tr -d ' ')" "$rc"
}

t_hook_mode_is_silent_and_notices_once_per_session() {
  newhome hm; write_lock "$good"
  [ "$(hook s1)" = "0 0" ] || return 1
  [ "$(wc -l <"$tmp/err" | tr -d ' ')" = 1 ] && grep -q 'not installed' "$tmp/err" || return 1
  [ "$(hook s1)" = "0 0" ] && [ ! -s "$tmp/err" ] || return 1   # same session: nothing
  [ "$(hook s2)" = "0 0" ] && [ "$(wc -l <"$tmp/err" | tr -d ' ')" = 1 ]   # next session: once more
}
t_hook_mode_downloads_nothing_without_opt_in() {
  newhome noopt; write_lock "$good"
  env_t sh -c 'printf "{\"session_id\":\"s\"}" | sh "$1" SessionStart' _ "$plug/hooks/install.sh" >/dev/null 2>&1
  sleep 1
  [ ! -e "$st/bin/ah-engine" ] && [ ! -e "$st/bootstrap.log" ]
}
t_hook_mode_opt_in_installs_on_session_start() {
  newhome optin; write_lock "$good"
  AH_ENGINE_BOOTSTRAP=1 env_t sh -c 'printf "{\"session_id\":\"s\"}" | sh "$1" SessionStart' _ "$plug/hooks/install.sh" >/dev/null 2>&1
  n=0; while [ ! -x "$st/bin/ah-engine" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  [ -x "$st/bin/ah-engine" ] && [ -x "$st/bin/ah-hook" ]
}
t_hook_mode_setting_opt_in() {
  newhome setting; write_lock "$good"; mkdir -p "$HOME/.anti-hall"
  printf '{"engine":{"bootstrap":true}}' >"$HOME/.anti-hall/settings.json"
  env_t sh -c 'printf "{\"session_id\":\"s\"}" | sh "$1" SessionStart' _ "$plug/hooks/install.sh" >/dev/null 2>&1
  n=0; while [ ! -x "$st/bin/ah-engine" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  [ -x "$st/bin/ah-engine" ]
}
t_hook_mode_hands_the_call_to_an_installed_client() {
  newhome handoff; mkdir -p "$st/bin"; write_lock "$good"
  printf '#!/bin/sh\necho "CLIENT $*" >>"$HOME/hook-calls"\ncat >/dev/null\n' >"$st/bin/ah-hook"; chmod 755 "$st/bin/ah-hook"
  [ "$(hook s1 Stop)" = "0 0" ] && grep -q 'CLIENT Stop' "$HOME/hook-calls" && [ ! -s "$tmp/err" ]
}
t_download_installs_both_binaries() {
  newhome dl; write_lock "$good"
  out=$(env_t sh "$plug/hooks/install.sh" --download 2>&1); rc=$?
  [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "installed ah-engine $ver" || return 1
  [ "$("$st/bin/ah-engine")" = "$ver" ] && [ -x "$st/bin/ah-hook" ] || return 1
  set -- $(cat "$st/bootstrap.installed")
  [ "$1 $2" = "$ver $good" ] && [ "$3" = "$(sha "$st/bin/ah-engine")" ] && [ "$4" = "$(sha "$st/bin/ah-hook")" ] || return 1
  grep -q 'integrity record' "$HOME/hook-calls"   # the new client was asked to record the expected sha256
}
t_download_refuses_a_wrong_sha() {
  newhome bad; write_lock 0000000000000000000000000000000000000000000000000000000000000000
  out=$(env_t sh "$plug/hooks/install.sh" --download 2>&1); rc=$?
  [ "$rc" = 0 ] && [ ! -e "$st/bin/ah-engine" ] && [ ! -e "$st/bin/ah-hook" ] && logf | grep -q 'why=sha256_mismatch' && printf '%s' "$out" | grep -q 'sha256_mismatch' && [ ! -d "$st/tmp.$$" ]
}
t_download_leaves_an_unmanaged_engine_alone() {
  newhome unm; write_lock "$good"; mkdir -p "$st/bin"
  printf '#!/bin/sh\necho mine\n' >"$st/bin/ah-engine"; chmod 755 "$st/bin/ah-engine"
  env_t sh "$plug/hooks/install.sh" --download >/dev/null 2>&1
  [ "$("$st/bin/ah-engine")" = mine ] && [ ! -e "$st/bin/ah-hook" ] && logf | grep -q 'skip why=unmanaged'
}
t_download_hands_over_to_an_installed_client() {
  newhome over; write_lock "$good"; mkdir -p "$st/bin"
  printf '#!/bin/sh\necho "CLIENT $*" >>"$HOME/hook-calls"\n' >"$st/bin/ah-hook"; chmod 755 "$st/bin/ah-hook"
  env_t sh "$plug/hooks/install.sh" --download -v >/dev/null 2>&1
  grep -q "CLIENT --plugin-root .* install --lock .*ah-engine.lock -v" "$HOME/hook-calls" && [ ! -e "$st/bin/ah-engine" ]
}
t_download_without_a_lock_changes_nothing() {
  newhome nolock; rm -f "$plug/ah-engine.lock"
  out=$(env_t sh "$plug/hooks/install.sh" --download 2>&1); rc=$?
  [ "$rc" = 0 ] && [ ! -e "$st/bin/ah-engine" ] && logf | grep -q 'why=no_lock'
}

check t_hook_mode_is_silent_and_notices_once_per_session t_hook_mode_is_silent_and_notices_once_per_session
check t_hook_mode_downloads_nothing_without_opt_in t_hook_mode_downloads_nothing_without_opt_in
check t_hook_mode_opt_in_installs_on_session_start t_hook_mode_opt_in_installs_on_session_start
check t_hook_mode_setting_opt_in t_hook_mode_setting_opt_in
check t_hook_mode_hands_the_call_to_an_installed_client t_hook_mode_hands_the_call_to_an_installed_client
check t_download_installs_both_binaries t_download_installs_both_binaries
check t_download_refuses_a_wrong_sha t_download_refuses_a_wrong_sha
check t_download_leaves_an_unmanaged_engine_alone t_download_leaves_an_unmanaged_engine_alone
check t_download_hands_over_to_an_installed_client t_download_hands_over_to_an_installed_client
check t_download_without_a_lock_changes_nothing t_download_without_a_lock_changes_nothing

printf 'install.sh: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

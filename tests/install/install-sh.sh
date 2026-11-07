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

# a valid JSON check where python3 exists (else the shape checks above must do)
isjson() { if command -v python3 >/dev/null 2>&1; then python3 -I -c 'import json,sys; json.loads(sys.stdin.read())' <"$1" 2>/dev/null; else grep -q '^{.*}$' "$1"; fi; }
fake_client() { # fake_client OUTPUT: an installed client that prints OUTPUT for SessionStart
  mkdir -p "$st/bin"
  printf '#!/bin/sh\ncat >/dev/null\nprintf "%%s" %s\n' "'$1'" >"$st/bin/ah-hook"; chmod 755 "$st/bin/ah-hook"
}
t_sessionstart_not_installed_notice_is_json() {
  newhome sj; write_lock "$good"
  [ "$(hook s1 SessionStart)" != "0 0" ] || return 1
  isjson "$tmp/out" && grep -q '"systemMessage":"anti-hall: the engine is not installed' "$tmp/out" && grep -q '"additionalContext"' "$tmp/out" && grep -q 'not installed' "$tmp/err" || return 1
  [ "$(hook s1 SessionStart)" = "0 0" ] && [ "$(wc -l <"$tmp/out" | tr -d ' ')" = 0 ]   # same session: nothing more
}
t_sessionstart_engine_without_client_has_its_own_text() {
  newhome nc; write_lock "$good"; mkdir -p "$st/bin"
  printf '#!/bin/sh\necho 0.1.0\n' >"$st/bin/ah-engine"; chmod 755 "$st/bin/ah-engine"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q 'hook client (ah-hook) is missing' "$tmp/out"
}
t_stale_engine_notice_joins_the_clients_json() {
  newhome st1; write_lock "$good"
  fake_client '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"X"}}'
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q '"systemMessage":"anti-hall: the installed engine (9.1.0) is older' "$tmp/out" && grep -q '"additionalContext":"X anti-hall' "$tmp/out" || return 1
  grep -q 'ah-hook install -v' "$tmp/out" && grep -q 'bootstrap.log' "$tmp/out" || return 1
}
t_stale_engine_notice_with_a_silent_client_is_the_notice_alone() {
  newhome st2; write_lock "$good"; fake_client ''
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q '"hookEventName":"SessionStart"' "$tmp/out" && grep -q 'older than this plugin expects' "$tmp/out"
}
t_other_events_and_a_current_engine_leave_the_clients_output_alone() {
  newhome st3; write_lock "$good"; fake_client '{"a":1}'
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 PreToolUse >/dev/null; [ "$(cat "$tmp/out")" = '{"a":1}' ] || return 1
  printf '%s aaaa\n' "$ver" >"$st/bootstrap.installed"
  hook s2 SessionStart >/dev/null; [ "$(cat "$tmp/out")" = '{"a":1}' ]
}
t_a_client_that_already_set_a_system_message_gets_the_notice_appended() {
  newhome st4; write_lock "$good"; fake_client '{"systemMessage":"mine"}'
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q '"systemMessage":"mine anti-hall: the installed engine' "$tmp/out" && grep -q '"additionalContext":"anti-hall' "$tmp/out" || return 1
  [ -s "$st/install-json.notice" ]   # shown, so marked
}
t_a_client_with_leading_whitespace_json_still_gets_the_notice() {
  newhome st5; write_lock "$good"; fake_client '
   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"X"}}'
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q '"systemMessage":"anti-hall: the installed engine' "$tmp/out" && grep -q '"additionalContext":"X anti-hall' "$tmp/out"
}
t_plain_text_client_output_is_kept_and_the_notice_is_not_marked_shown() {
  newhome st6; write_lock "$good"; fake_client 'plain context line'
  printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null
  [ "$(cat "$tmp/out")" = 'plain context line' ] && [ ! -e "$st/install-json.notice" ] || return 1
  fake_client '{}'; hook s1 SessionStart >/dev/null   # the same host process: the notice was never delivered, so it comes now
  isjson "$tmp/out" && grep -q 'older than this plugin expects' "$tmp/out"
}
t_codex_keeps_stdout_clean() {
  newhome cx; write_lock "$good"
  printf '{"session_id":"s1"}' | sh "$plug/hooks/install.sh" SessionStart --host codex >"$tmp/out" 2>"$tmp/err"
  [ ! -s "$tmp/out" ] && grep -q 'not installed' "$tmp/err" || return 1
  fake_client '{"a":1}'; printf '9.1.0 aaaa\n' >"$st/bootstrap.installed"
  printf '{"session_id":"s1"}' | sh "$plug/hooks/install.sh" SessionStart --host codex >"$tmp/out" 2>"$tmp/err"
  [ "$(cat "$tmp/out")" = '{"a":1}' ]
}
t_defaults_that_failed_to_load_say_the_guards_are_not_running() {
  newhome df; write_lock "$good"; fake_client ''
  printf '%s aaaa\n' "$ver" >"$st/bootstrap.installed"
  sleep 1; printf '1 ah-engine: defaults unavailable\n' >"$st/defaults.error"
  hook s1 SessionStart >/dev/null
  isjson "$tmp/out" && grep -q 'guards are NOT running' "$tmp/out"
}
fake_engine() { # fake_engine EXIT: an engine whose `config` probe exits EXIT
  mkdir -p "$st/bin"; printf '#!/bin/sh\nexit %s\n' "$1" >"$st/bin/ah-engine"; chmod 755 "$st/bin/ah-engine"
}
t_a_stale_defaults_error_with_a_healthy_engine_says_nothing() {
  newhome df3; write_lock "$good"; fake_client ''
  printf '%s aaaa\n' "$ver" >"$st/bootstrap.installed"
  fake_engine 0; sleep 1; printf '1 ah-engine: defaults unavailable\n' >"$st/defaults.error"
  hook s1 SessionStart >/dev/null; [ ! -s "$tmp/out" ]
}
t_a_defaults_error_with_a_failing_engine_still_warns() {
  newhome df4; write_lock "$good"; fake_client ''
  printf '%s aaaa\n' "$ver" >"$st/bootstrap.installed"
  fake_engine 1; sleep 1; printf '1 ah-engine: defaults unavailable\n' >"$st/defaults.error"
  hook s1 SessionStart >/dev/null; isjson "$tmp/out" && grep -q 'guards are NOT running' "$tmp/out"
}
t_a_defaults_error_older_than_the_engine_is_ignored() {
  newhome df2; write_lock "$good"
  mkdir -p "$st"; printf '1 ah-engine: defaults unavailable\n' >"$st/defaults.error"
  sleep 1; fake_client ''; mkdir -p "$st/bin"; printf '#!/bin/sh\n' >"$st/bin/ah-engine"; chmod 755 "$st/bin/ah-engine"
  printf '%s aaaa\n' "$ver" >"$st/bootstrap.installed"
  hook s1 SessionStart >/dev/null; [ ! -s "$tmp/out" ]
}
t_download_keeps_an_older_managed_engine_and_hands_over() {
  newhome keep; write_lock "$good"; mkdir -p "$st/bin"
  printf '#!/bin/sh\necho 0.1.0\n' >"$st/bin/ah-engine"; chmod 755 "$st/bin/ah-engine"
  esha=$(sha "$st/bin/ah-engine"); printf '0.1.0 %s\n' "$esha" >"$st/bootstrap.installed"
  out=$(env_t sh "$plug/hooks/install.sh" --download 2>&1); rc=$?
  [ "$rc" = 0 ] && ! printf '%s' "$out" | grep -q "installed ah-engine" || return 1
  [ "$("$st/bin/ah-engine")" = 0.1.0 ] && [ -x "$st/bin/ah-hook" ] || return 1
  set -- $(cat "$st/bootstrap.installed")
  [ "$1 $2 $3" = "0.1.0 - $esha" ] && [ "$4" = "$(sha "$st/bin/ah-hook")" ] || return 1
  grep -q "install --lock .*ah-engine.lock" "$HOME/hook-calls" || return 1   # the one implementation does the swap
  [ -z "$(ls "$st" | grep -i tmp)" ]   # the scratch dir is gone although the hand-over exec skips the EXIT trap
}
t_download_creates_a_private_state_dir() {
  newhome priv; write_lock "$good"
  env_t sh "$plug/hooks/install.sh" --download >/dev/null 2>&1
  [ "$(ls -ld "$st" | cut -c1-10)" = "drwx------" ]
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

check t_sessionstart_not_installed_notice_is_json t_sessionstart_not_installed_notice_is_json
check t_sessionstart_engine_without_client_has_its_own_text t_sessionstart_engine_without_client_has_its_own_text
check t_stale_engine_notice_joins_the_clients_json t_stale_engine_notice_joins_the_clients_json
check t_stale_engine_notice_with_a_silent_client_is_the_notice_alone t_stale_engine_notice_with_a_silent_client_is_the_notice_alone
check t_other_events_and_a_current_engine_leave_the_clients_output_alone t_other_events_and_a_current_engine_leave_the_clients_output_alone
check t_a_client_that_already_set_a_system_message_gets_the_notice_appended t_a_client_that_already_set_a_system_message_gets_the_notice_appended
check t_a_client_with_leading_whitespace_json_still_gets_the_notice t_a_client_with_leading_whitespace_json_still_gets_the_notice
check t_plain_text_client_output_is_kept_and_the_notice_is_not_marked_shown t_plain_text_client_output_is_kept_and_the_notice_is_not_marked_shown
check t_codex_keeps_stdout_clean t_codex_keeps_stdout_clean
check t_a_stale_defaults_error_with_a_healthy_engine_says_nothing t_a_stale_defaults_error_with_a_healthy_engine_says_nothing
check t_a_defaults_error_with_a_failing_engine_still_warns t_a_defaults_error_with_a_failing_engine_still_warns
check t_defaults_that_failed_to_load_say_the_guards_are_not_running t_defaults_that_failed_to_load_say_the_guards_are_not_running
check t_a_defaults_error_older_than_the_engine_is_ignored t_a_defaults_error_older_than_the_engine_is_ignored
check t_download_keeps_an_older_managed_engine_and_hands_over t_download_keeps_an_older_managed_engine_and_hands_over
check t_download_creates_a_private_state_dir t_download_creates_a_private_state_dir

printf 'install.sh: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

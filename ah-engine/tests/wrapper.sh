#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
wrapper=$repo/plugins/anti-hall/hooks/ah-hook.sh
tmp=${TMPDIR:-/tmp}/ah-wrapper-test.$$
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

pass=0
fail=0
large_timeout=10
short_timeout=3
long_sleep=30
poll_limit=20

check() {
  name=$1
  shift
  if "$@"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s\n' "$name" >&2
  fi
}

make_engine() {
  p=$tmp/engine-$1.sh
  mode=$2
  {
    printf '#!/bin/sh\n'
    case "$mode" in
      normal) printf 'cat; printf "engine-err\\n" >&2; exit 2\n' ;;
      args) printf 'printf "args:$*\\n"; exit 0\n' ;;
      seventyfive) printf 'cat >/dev/null; exit 75\n' ;;
      signal) printf 'kill -9 $$\n' ;;
      hang) printf 'printf started >"$AH_STARTED"; [ -z "${AH_PIDFILE:-}" ] || printf "%%s\\n" "$$" >"$AH_PIDFILE"; sleep "$AH_SLEEP_S"\n' ;;
      late_marker) printf 'printf started >"$AH_STARTED"; ( sleep "$AH_SLEEP_S"; printf late >"$AH_MARKER" ) & child=$!; ( sleep "$AH_SLEEP_S"; printf grand >"$AH_GRAND_MARKER" ) & grand=$!; printf "%%s %%s\\n" "$child" "$grand" >"$AH_PIDFILE"; wait\n' ;;
    esac
  } >"$p"
  chmod +x "$p"
  printf '%s\n' "$p"
}

hook_script() {
  p=$tmp/$1.sh
  body=$2
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$body"
  } >"$p"
  chmod +x "$p"
  printf '%s\n' "$p"
}

run_case() {
  name=$1
  engine=$2
  list=$3
  input=$4
  out=$tmp/$name.out
  err=$tmp/$name.err
  if [ "$engine" = "-" ]; then
    AH_ENGINE_BIN= AH_FALLBACK_LIST="$list" AH_HOOK_TIMEOUT_S="$large_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$input" >"$out" 2>"$err"
  else
    AH_ENGINE_BIN="$engine" AH_FALLBACK_LIST="$list" AH_HOOK_TIMEOUT_S="$large_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$input" >"$out" 2>"$err"
  fi
}

wait_for_file() {
  path=$1
  limit=${2:-$poll_limit}
  i=0
  while [ "$i" -lt "$limit" ]; do
    [ -e "$path" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

pid_gone() {
  pid=$1
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  return 1
}

wait_for_pids_gone() {
  limit=$1
  shift
  i=0
  while [ "$i" -lt "$limit" ]; do
    all_gone=1
    for pid in "$@"; do
      if ! pid_gone "$pid"; then
        all_gone=0
      fi
    done
    [ "$all_gone" -eq 1 ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

collect_test_descendants() {
  root_pid=$1
  seen=$tmp/test-kill.seen.$root_pid.$$
  new=$tmp/test-kill.new.$root_pid.$$
  desc=$tmp/test-kill.desc.$root_pid.$$
  scan_count=0
  max_scans=64
  printf '%s\n' "$root_pid" >"$seen"
  : >"$desc"
  while [ "$scan_count" -lt "$max_scans" ]; do
    scan_count=$((scan_count + 1))
    ps -Ao pid=,ppid= 2>/dev/null | awk '
      NR == FNR { seen[$1] = 1; next }
      seen[$2] && !seen[$1] { print $1 }
    ' "$seen" - >"$new"
    [ -s "$new" ] || break
    cat "$new" >>"$seen"
    cat "$new" >>"$desc"
  done
  cat "$desc"
  rm -f "$seen" "$new" "$desc"
}

kill_test_tree() {
  root_pid=$1
  descendants=$(collect_test_descendants "$root_pid")
  leaf_first=$(printf '%s\n' "$descendants" | awk 'NF { p[NR] = $1 } END { for (i = NR; i >= 1; i--) print p[i] }')
  for child_pid in $leaf_first "$root_pid"; do
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  wait_for_pids_gone 1 $leaf_first "$root_pid" || true
  for child_pid in $leaf_first "$root_pid"; do
    kill -KILL "$child_pid" 2>/dev/null || true
  done
}

run_with_cap() {
  name=$1
  cap=$2
  out=$3
  err=$4
  shift 4
  rcfile=$tmp/$name.rc
  timed=$tmp/$name.timed
  rm -f "$rcfile" "$timed"
  (
    set +e
    "$@"
    printf '%s\n' "$?" >"$rcfile"
  ) >"$out" 2>"$err" &
  pid=$!
  ( trap - EXIT HUP INT TERM; sleep "$cap"; : >"$timed"; kill_test_tree "$pid" ) &
  watch=$!
  set +e
  wait "$pid" 2>/dev/null
  wait_rc=$?
  set -e
  kill "$watch" 2>/dev/null || true
  wait "$watch" 2>/dev/null || true
  wait_for_pids_gone "$poll_limit" "$pid" || true
  if [ -f "$timed" ]; then
    return 124
  fi
  if [ -r "$rcfile" ]; then
    return "$(cat "$rcfile")"
  fi
  return "$wait_rc"
}

payload=$tmp/payload.json
printf '{"tool_name":"Bash","x":1}' >"$payload"

test_normal_passthrough() {
  e=$(make_engine normal normal)
  : >"$tmp/empty.list"
  out=$tmp/normal.out
  err=$tmp/normal.err
  set +e
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/empty.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && cmp -s "$payload" "$out" && grep -q '^engine-err$' "$err"
}

test_tool_from_payload_reaches_engine() {
  e=$(make_engine args args)
  : >"$tmp/empty-tool.list"
  out=$tmp/tool.out
  err=$tmp/tool.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/empty-tool.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  grep -q -- '--tool Bash' "$out"
}

test_exit_75_fallback() {
  h=$(hook_script h75 'cat; printf "node-err\n" >&2; exit 0')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/75.list"
  e=$(make_engine seventyfive seventyfive)
  out=$tmp/75.out
  err=$tmp/75.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/75.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  cmp -s "$payload" "$out" && grep -q 'engine fallback' "$err" && ! grep -q 'node-err' "$err"
}

test_missing_binary_fallback() {
  h=$(hook_script missing 'printf missing')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/missing.list"
  out=$tmp/missing.out
  err=$tmp/missing.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/missing.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = missing ] && grep -q 'engine fallback' "$err"
}

test_signal_fallback() {
  h=$(hook_script sig 'printf signal')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/sig.list"
  e=$(make_engine signal signal)
  out=$tmp/sig.out
  err=$tmp/sig.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/sig.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = signal ] && grep -q 'engine fallback' "$err"
}

test_timeout_fallback() {
  started=$tmp/timeout.started
  pidfile=$tmp/timeout.pid
  h=$(hook_script timeout 'printf timeout')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$short_timeout" "$large_timeout" "$h" >"$tmp/timeout.list"
  e=$(make_engine hang hang)
  out=$tmp/timeout.out
  err=$tmp/timeout.err
  AH_STARTED="$started" AH_PIDFILE="$pidfile" AH_SLEEP_S="$long_sleep" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/timeout.list" AH_HOOK_TIMEOUT_S="$short_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err" || return 1
  wait_for_file "$started" "$poll_limit" && [ -s "$pidfile" ] || return 1
  pid=$(cat "$pidfile")
  wait_for_pids_gone "$poll_limit" "$pid" &&
    [ "$(cat "$out")" = timeout ] && grep -q 'timed out' "$err"
}

test_timeout_kills_engine_process() {
  started=$tmp/engine-timeout.started
  marker=$tmp/engine-timeout.marker
  grand_marker=$tmp/engine-timeout-grand.marker
  pidfile=$tmp/engine-timeout.pid
  h=$(hook_script timeoutkill 'printf fallback')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$short_timeout" "$large_timeout" "$h" >"$tmp/timeout-kill.list"
  e=$(make_engine late late_marker)
  out=$tmp/timeout-kill.out
  err=$tmp/timeout-kill.err
  run_with_cap timeout-kill 15 "$out" "$err" env AH_STARTED="$started" AH_SLEEP_S="$long_sleep" AH_MARKER="$marker" AH_GRAND_MARKER="$grand_marker" AH_PIDFILE="$pidfile" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/timeout-kill.list" AH_HOOK_TIMEOUT_S="$short_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" || return 1
  wait_for_file "$started" "$poll_limit" && [ -s "$pidfile" ] || return 1
  set -- $(cat "$pidfile")
  wait_for_pids_gone "$poll_limit" "$1" "$2" &&
    [ "$(cat "$out")" = fallback ] && [ ! -e "$marker" ] && [ ! -e "$grand_marker" ] && ! grep -q 'Terminated\|Killed' "$err"
}

test_timeout_kills_fallback_process() {
  started=$tmp/fallback-timeout.started
  marker=$tmp/fallback-timeout.marker
  grand_marker=$tmp/fallback-timeout-grand.marker
  pidfile=$tmp/fallback-timeout.pid
  slow=$(hook_script slow 'printf started >"$AH_STARTED"; ( sleep "$AH_SLEEP_S"; printf late >"$AH_MARKER" ) & child=$!; ( sleep "$AH_SLEEP_S"; printf grand >"$AH_GRAND_MARKER" ) & grand=$!; printf "%s %s\n" "$child" "$grand" >"$AH_PIDFILE"; wait')
  fast=$(hook_script fast 'printf fast')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nBash\t%s\t%s\n' "$short_timeout" "$short_timeout" "$slow" "$large_timeout" "$fast" >"$tmp/fallback-timeout-kill.list"
  e=$(make_engine seventyfive-timeout seventyfive)
  out=$tmp/fallback-timeout-kill.out
  err=$tmp/fallback-timeout-kill.err
  run_with_cap fallback-timeout-kill 15 "$out" "$err" env AH_STARTED="$started" AH_SLEEP_S="$long_sleep" AH_MARKER="$marker" AH_GRAND_MARKER="$grand_marker" AH_PIDFILE="$pidfile" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/fallback-timeout-kill.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" || return 1
  wait_for_file "$started" "$poll_limit" && [ -s "$pidfile" ] || return 1
  set -- $(cat "$pidfile")
  wait_for_pids_gone "$poll_limit" "$1" "$2" &&
    [ "$(cat "$out")" = fast ] && [ ! -e "$marker" ] && [ ! -e "$grand_marker" ] && ! grep -q 'Terminated\|Killed' "$err"
}

test_invalid_bytes_reach_fallback() {
  raw=$tmp/raw.bin
  printf '\377{"tool_name":"Bash"}\000tail' >"$raw"
  expect=$tmp/expect.bin
  cp "$raw" "$expect"
  h=$(hook_script bytes "cmp -s - '$expect' && printf same")
  printf '@PreToolUse\t%s\n*\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/bytes.list"
  e=$(make_engine seventyfive seventyfive)
  out=$tmp/bytes.out
  err=$tmp/bytes.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/bytes.list" sh "$wrapper" PreToolUse --tool-from-payload <"$raw" >"$out" 2>"$err"
  [ "$(cat "$out")" = same ]
}

test_matcher_selection() {
  bash_h=$(hook_script bash 'printf bash')
  edit_h=$(hook_script edit 'printf edit')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nEdit\t%s\t%s\n' "$large_timeout" "$large_timeout" "$bash_h" "$large_timeout" "$edit_h" >"$tmp/match.list"
  e=$(make_engine seventyfive seventyfive)
  out=$tmp/match.out
  err=$tmp/match.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/match.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = bash ]
}

test_first_exit_two_wins() {
  h1=$(hook_script block1 'printf out1; printf first >&2; exit 2')
  h2=$(hook_script block2 'printf out2; printf second >&2; exit 2')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h1" "$large_timeout" "$h2" >"$tmp/block.list"
  e=$(make_engine seventyfive seventyfive)
  out=$tmp/block.out
  err=$tmp/block.err
  set +e
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/block.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ "$(cat "$out")" = out1out2 ] && grep -q 'first' "$err" && ! grep -q 'second' "$err"
}

test_guard_fail_closed_without_engine_or_nodes() {
  out=$tmp/closed.out
  err=$tmp/closed.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ ! -s "$out" ] && grep -q 'fail closed' "$err"
}

test_non_guard_missing_engine_without_nodes_fails_open() {
  out=$tmp/non-guard-open.out
  err=$tmp/non-guard-open.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PostToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && grep -q 'engine fallback' "$err"
}

test_guard_fail_closed_when_selected_hook_cannot_exec() {
  printf '@PreToolUse\t%s\nBash\t%s\t/no/such/node "$0"\n' "$large_timeout" "$large_timeout" >"$tmp/noexec-guard.list"
  out=$tmp/noexec-guard.out
  err=$tmp/noexec-guard.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/noexec-guard.list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ ! -s "$out" ] && grep -q 'fail closed' "$err" && ! grep -q '/no/such/node' "$err"
}

test_non_guard_selected_hook_cannot_exec_fails_open() {
  printf '@PostToolUse\t%s\nBash\t%s\t/no/such/node "$0"\n' "$large_timeout" "$large_timeout" >"$tmp/noexec-nonguard.list"
  out=$tmp/noexec-nonguard.out
  err=$tmp/noexec-nonguard.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/noexec-nonguard.list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PostToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && grep -q 'engine fallback' "$err" && ! grep -q '/no/such/node' "$err"
}

test_selected_exec_failure_does_not_override_runnable_hook() {
  h=$(hook_script runnable 'printf runnable')
  printf '@PreToolUse\t%s\nBash\t%s\t/no/such/node "$0"\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$large_timeout" "$h" >"$tmp/noexec-runnable.list"
  out=$tmp/noexec-runnable.out
  err=$tmp/noexec-runnable.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/noexec-runnable.list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = runnable ] && grep -q 'engine fallback' "$err" && ! grep -q '/no/such/node' "$err"
}

test_engine_lookup_prefers_ah_engine_bin() {
  home=$tmp/lookup-home-bin
  pathdir=$tmp/lookup-path-bin
  mkdir -p "$home/.anti-hall/ah-engine/bin" "$pathdir"
  envbin=$(hook_script env-engine 'printf env-bin')
  homebin=$home/.anti-hall/ah-engine/bin/ah-engine
  pathbin=$pathdir/ah-engine
  cp "$envbin" "$homebin"
  cp "$envbin" "$pathbin"
  chmod +x "$homebin" "$pathbin"
  printf '#!/bin/sh\nprintf home-bin\n' >"$homebin"
  printf '#!/bin/sh\nprintf path-bin\n' >"$pathbin"
  out=$tmp/lookup-env.out
  err=$tmp/lookup-env.err
  : >"$tmp/lookup-empty-env.list"
  AH_ENGINE_BIN="$envbin" AH_FALLBACK_LIST="$tmp/lookup-empty-env.list" HOME="$home" PATH="$pathdir:/usr/bin:/bin:/usr/sbin:/sbin" /bin/sh "$wrapper" PreToolUse <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = env-bin ]
}

test_engine_lookup_prefers_home_install_over_path() {
  home=$tmp/lookup-home
  pathdir=$tmp/lookup-path
  mkdir -p "$home/.anti-hall/ah-engine/bin" "$pathdir"
  homebin=$home/.anti-hall/ah-engine/bin/ah-engine
  pathbin=$pathdir/ah-engine
  printf '#!/bin/sh\nprintf home-bin\n' >"$homebin"
  printf '#!/bin/sh\nprintf path-bin\n' >"$pathbin"
  chmod +x "$homebin" "$pathbin"
  out=$tmp/lookup-home.out
  err=$tmp/lookup-home.err
  : >"$tmp/lookup-empty-home.list"
  AH_FALLBACK_LIST="$tmp/lookup-empty-home.list" HOME="$home" PATH="$pathdir:/usr/bin:/bin:/usr/sbin:/sbin" /bin/sh "$wrapper" PreToolUse <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = home-bin ]
}

test_engine_lookup_uses_path() {
  home=$tmp/lookup-nohome
  pathdir=$tmp/lookup-command
  mkdir -p "$home" "$pathdir"
  pathbin=$pathdir/ah-engine
  printf '#!/bin/sh\nprintf path-bin\n' >"$pathbin"
  chmod +x "$pathbin"
  out=$tmp/lookup-path.out
  err=$tmp/lookup-path.err
  : >"$tmp/lookup-empty-path.list"
  AH_FALLBACK_LIST="$tmp/lookup-empty-path.list" HOME="$home" PATH="$pathdir:/usr/bin:/bin:/usr/sbin:/sbin" /bin/sh "$wrapper" PreToolUse <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = path-bin ]
}

check normal_passthrough test_normal_passthrough
check tool_from_payload_reaches_engine test_tool_from_payload_reaches_engine
check exit_75_fallback test_exit_75_fallback
check missing_binary_fallback test_missing_binary_fallback
check signal_fallback test_signal_fallback
check timeout_fallback test_timeout_fallback
check timeout_kills_engine_process test_timeout_kills_engine_process
check timeout_kills_fallback_process test_timeout_kills_fallback_process
check invalid_bytes_reach_fallback test_invalid_bytes_reach_fallback
check matcher_selection test_matcher_selection
check first_exit_two_wins test_first_exit_two_wins
check guard_fail_closed_without_engine_or_nodes test_guard_fail_closed_without_engine_or_nodes
check non_guard_missing_engine_without_nodes_fails_open test_non_guard_missing_engine_without_nodes_fails_open
check guard_fail_closed_when_selected_hook_cannot_exec test_guard_fail_closed_when_selected_hook_cannot_exec
check non_guard_selected_hook_cannot_exec_fails_open test_non_guard_selected_hook_cannot_exec_fails_open
check selected_exec_failure_does_not_override_runnable_hook test_selected_exec_failure_does_not_override_runnable_hook
check engine_lookup_prefers_ah_engine_bin test_engine_lookup_prefers_ah_engine_bin
check engine_lookup_prefers_home_install_over_path test_engine_lookup_prefers_home_install_over_path
check engine_lookup_uses_path test_engine_lookup_uses_path

printf 'wrapper tests: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

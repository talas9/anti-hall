#!/bin/sh
set -eu
AH_WRAPPER_TEST=1
export AH_WRAPPER_TEST

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
wrapper=$repo/plugins/anti-hall/hooks/ah-hook.sh
tmp=${TMPDIR:-/tmp}/ah-wrapper-test.$$
mkdir -p "$tmp"
: >"$tmp/homefile"
HOME=$tmp/homefile/h
export HOME
unset XDG_RUNTIME_DIR
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

pass=0
fail=0
filter=${1:-}
large_timeout=10
short_timeout=3
long_sleep=30
poll_limit=20

check() {
  name=$1
  shift
  if [ -n "$filter" ] && [ "$filter" != "$name" ]; then
    return 0
  fi
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
      exit1) printf 'cat >/dev/null; exit 1\n' ;;
      exit3) printf 'cat >/dev/null; exit 3\n' ;;
      exit126) printf 'cat >/dev/null; exit 126\n' ;;
      exit127) printf 'cat >/dev/null; exit 127\n' ;;
      seventyfive) printf 'cat >/dev/null; exit 75\n' ;;
      signal) printf 'kill -9 $$\n' ;;
      hang) printf 'printf started >"$AH_STARTED"; [ -z "${AH_PIDFILE:-}" ] || printf "%%s\\n" "$$" >"$AH_PIDFILE"; sleep "$AH_SLEEP_S"\n' ;;
      late_marker) printf 'printf started >"$AH_STARTED"; ( sleep "$AH_SLEEP_S"; printf late >"$AH_MARKER" ) & child=$!; ( sleep "$AH_SLEEP_S"; printf grand >"$AH_GRAND_MARKER" ) & grand=$!; printf "%%s %%s\\n" "$child" "$grand" >"$AH_PIDFILE"; wait\n' ;;
    esac
  } >"$p"
  chmod +x "$p"
  printf '%s\n' "$p"
}

stat_mode() {
  if stat -f '%Lp' "$1" 2>/dev/null; then
    return 0
  fi
  stat -c '%a' "$1" 2>/dev/null
}

stat_uid() {
  if stat -f '%u' "$1" 2>/dev/null; then
    return 0
  fi
  stat -c '%u' "$1" 2>/dev/null
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

test_engine_odd_exits_fallback() {
  for mode in exit1 exit3 exit126 exit127; do
    h=$(hook_script "odd-$mode" "printf $mode")
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/odd-$mode.list"
    e=$(make_engine "$mode" "$mode")
    out=$tmp/odd-$mode.out
    err=$tmp/odd-$mode.err
    AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/odd-$mode.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err" || return 1
    [ "$(cat "$out")" = "$mode" ] && grep -q 'engine fallback' "$err" || return 1
  done
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

run_selection_payload() {
  name=$1
  json=$2
  expected=$3
  input=$tmp/$name.json
  printf '%s' "$json" >"$input"
  bash_h=$(hook_script "$name-bash" 'printf bash')
  edit_h=$(hook_script "$name-edit" 'printf edit')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nEdit\t%s\t%s\n' "$large_timeout" "$large_timeout" "$bash_h" "$large_timeout" "$edit_h" >"$tmp/$name.list"
  e=$(make_engine "$name-engine" seventyfive)
  out=$tmp/$name.out
  err=$tmp/$name.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/$name.list" sh "$wrapper" PreToolUse --tool-from-payload <"$input" >"$out" 2>"$err"
  [ "$(cat "$out")" = "$expected" ]
}

test_tool_name_structural_scanner() {
  run_selection_payload nested_decoy '{"tool_input":{"tool_name":"Edit"},"prompt":"\"tool_name\":\"Write\"","tool_name":"Bash"}' bash || return 1
  run_selection_payload noisy_prefix_1 'x{"tool_name":"Bash"}' bashedit || return 1
  run_selection_payload noisy_prefix_3 'xyz{"tool_name":"Bash"}' bashedit || return 1
  run_selection_payload duplicate_diff '{"tool_name":"Bash","tool_name":"Edit"}' bashedit || return 1
  run_selection_payload root_array '[{"tool_name":"Bash"}]' bashedit || return 1
  run_selection_payload bom "$(printf '\357\273\277{"tool_name":"Bash"}')" bash || return 1
  run_selection_payload unicode '{"tool_name":"\u0042\u0061\u0073\u0068"}' bash || return 1
  run_selection_payload tool_last "$(printf '{"tool_input":{"x":1},"pad":"%05000d","tool_name":"Bash"}' 0)" bash || return 1
}

test_tool_name_invalid_selects_all_non_guard() {
  input=$tmp/nonguard-array.json
  printf '[{"tool_name":"Bash"}]' >"$input"
  bash_h=$(hook_script nonguard-bash 'printf bash')
  edit_h=$(hook_script nonguard-edit 'printf edit')
  printf '@PostToolUse\t%s\nBash\t%s\t%s\nEdit\t%s\t%s\n' "$large_timeout" "$large_timeout" "$bash_h" "$large_timeout" "$edit_h" >"$tmp/nonguard.list"
  out=$tmp/nonguard.out
  err=$tmp/nonguard.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/nonguard.list" sh "$wrapper" PostToolUse --tool-from-payload <"$input" >"$out" 2>"$err"
  [ "$(cat "$out")" = bashedit ]
}

test_tool_name_huge_payload_fast() {
  input=$tmp/huge.json
  {
    printf '{"pad":"'
    head -c 5000000 /dev/zero | tr '\0' a
    printf '","tool_name":"Bash"}'
  } >"$input"
  h=$(hook_script huge 'printf bash')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nEdit\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" "$large_timeout" "$h" >"$tmp/huge.list"
  e=$(make_engine huge-engine seventyfive)
  out=$tmp/huge.out
  err=$tmp/huge.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/huge.list" sh "$wrapper" PreToolUse --tool-from-payload <"$input" >"$out" 2>"$err" || return 1
  [ "$(cat "$out")" = bash ]
}

test_fallback_exit_code_matrix_rows() {
  for rc in 0 1 3 126 127; do
    h=$(hook_script "exit-$rc" "printf rc$rc; exit $rc")
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/exit-$rc.list"
    out=$tmp/exit-$rc.out
    err=$tmp/exit-$rc.err
    set +e
    AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/exit-$rc.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
    got=$?
    set -e
    [ "$got" -eq 0 ] && [ "$(cat "$out")" = "rc$rc" ] || return 1
  done
}

test_fallback_exit1_host_nonblocking_rows() {
  i=0
  for body in 'printf out; exit 1' 'exit 1'; do
    i=$((i + 1))
    h=$(hook_script "exit1-$i" "$body")
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/exit1-row.list"
    out=$tmp/exit1-row.out
    err=$tmp/exit1-row.err
    set +e
    AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/exit1-row.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || return 1
  done
}

test_shell_started_126_127_are_host_nonblocking() {
  missing='command /no/such/command'
  nonexec=$tmp/not-executable-shell
  printf '#!/bin/sh\nprintf nope\n' >"$nonexec"
  chmod 600 "$nonexec"
  for cmd in "$missing" "\"$nonexec\""; do
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$cmd" >"$tmp/shell-126-127.list"
    out=$tmp/shell-126-127.out
    err=$tmp/shell-126-127.err
    set +e
    AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/shell-126-127.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || return 1
  done
}

test_exit0_json_block_wins_verbatim() {
  deny='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'
  block=$(hook_script jsonblock "printf '%s\\n' '$deny'")
  sibling=$(hook_script sibling 'printf sibling')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$block" "$large_timeout" "$sibling" >"$tmp/json-block.list"
  out=$tmp/json-block.out
  err=$tmp/json-block.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/json-block.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = "$deny" ] && ! grep -q sibling "$out"
}

test_first_json_block_wins_verbatim() {
  first='{"decision":"block","reason":"first"}'
  second='{"decision":"block","reason":"second"}'
  h1=$(hook_script firstjson "printf '%s\\n' '$first'")
  h2=$(hook_script secondjson "printf '%s\\n' '$second'")
  printf '@Stop\t%s\n*\t%s\t%s\n*\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h1" "$large_timeout" "$h2" >"$tmp/first-json-block.list"
  input=$tmp/stop-payload.json
  printf '{"hook_event_name":"Stop","stop_hook_active":false}' >"$input"
  out=$tmp/first-json-block.out
  err=$tmp/first-json-block.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/first-json-block.list" sh "$wrapper" Stop <"$input" >"$out" 2>"$err"
  [ "$(cat "$out")" = "$first" ] && ! grep -q second "$out"
}

test_fallback_signal_and_incomplete_fail_closed() {
  sig=$(hook_script sigrow 'kill -9 $$')
  leak=$(hook_script leakrow 'printf partial; (exec sleep 30) & exit 0')
  for name in sig leak; do
    eval "h=\$$name"
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/$name-row.list"
    out=$tmp/$name-row.out
    err=$tmp/$name-row.err
    set +e
    AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/$name-row.list" AH_HOOK_TIMEOUT_S="$short_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
    rc=$?
    set -e
    [ "$rc" -eq 2 ] && [ ! -s "$out" ] || return 1
  done
}

test_fallback_timeout_discard_allows_other_hook() {
  slow=$(hook_script timeoutrow 'exec sleep 60')
  fast=$(hook_script timeoutrowfast 'printf fast')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\nBash\t%s\t%s\n' "$short_timeout" "$short_timeout" "$slow" "$large_timeout" "$fast" >"$tmp/timeout-row.list"
  out=$tmp/timeout-row.out
  err=$tmp/timeout-row.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/timeout-row.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = fast ]
}

test_temp_modes_and_owner() {
  parent=$tmp/private-parent
  mkdir "$parent"
  h=$(hook_script tempmodes 'mode(){ stat -f "%Lp" "$1" 2>/dev/null || stat -c "%a" "$1"; }; owner(){ stat -f "%u" "$1" 2>/dev/null || stat -c "%u" "$1"; }; root="$TMPDIR/ah-hook-$(id -u)"; set -- "$root"/ah-wrapper-run.*/payload; payload=$1; d=$(dirname "$payload"); [ "$(mode "$root")" = 700 ] && [ "$(mode "$d")" = 700 ] && [ "$(mode "$payload")" = 600 ] && [ "$(owner "$root")" = "$(id -u)" ] && printf ok')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/tempmodes.list"
  e=$(make_engine tempmodes-engine seventyfive)
  out=$tmp/tempmodes.out
  err=$tmp/tempmodes.err
  TMPDIR="$parent" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/tempmodes.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ "$(cat "$out")" = ok ]
}

test_temp_refuses_bad_base_and_symlink_parent() {
  uid_now=$(id -u)
  badparent=$tmp/badparent
  mkdir "$badparent" "$badparent/ah-hook-$uid_now"
  chmod 777 "$badparent/ah-hook-$uid_now"
  h=$(hook_script badbase 'printf badbase')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/badbase.list"
  out=$tmp/badbase.out
  err=$tmp/badbase.err
  set +e
  TMPDIR="$badparent" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/badbase.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc1=$?
  set -e
  realparent=$tmp/realparent
  linkparent=$tmp/linkparent
  mkdir "$realparent"
  ln -s "$realparent" "$linkparent"
  set +e
  TMPDIR="$linkparent" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/badbase.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/symlink.out" 2>"$tmp/symlink.err"
  rc2=$?
  hostile=$tmp/hostile
  elsewhere=$tmp/elsewhere
  mkdir -m 700 "$hostile" "$elsewhere"
  ln -s "$elsewhere" "$hostile/ah-hook-$uid_now"
  TMPDIR="$hostile" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/badbase.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/hostile.out" 2>"$tmp/hostile.err"
  rc3=$?
  open_parent=$tmp/openparent
  mkdir "$open_parent"
  chmod 777 "$open_parent"
  TMPDIR="$open_parent" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/badbase.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/open.out" 2>"$tmp/open.err"
  rc4=$?
  sticky_parent=$tmp/stickyparent
  mkdir "$sticky_parent"
  chmod 1777 "$sticky_parent"
  TMPDIR="$sticky_parent" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/badbase.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/sticky.out" 2>"$tmp/sticky.err"
  rc5=$?
  set -e
  # bad base mode refused; symlinked parent is canonicalised and works; symlinked final component refused;
  # world-writable parent without sticky refused; with sticky accepted
  [ "$rc1" -eq 2 ] && [ "$rc2" -eq 0 ] && [ "$(cat "$tmp/symlink.out")" = badbase ] && [ "$rc3" -eq 2 ] && [ "$rc4" -eq 2 ] && [ "$rc5" -eq 0 ]
}

test_temp_sweep_old_keeps_fresh() {
  parent=$tmp/sweepparent
  mkdir "$parent"
  root=$parent/ah-hook-$(id -u)
  mkdir -m 700 "$root" "$root/ah-wrapper-run.old" "$root/ah-wrapper-run.fresh"
  old=$root/ah-wrapper-run.old
  fresh=$root/ah-wrapper-run.fresh
  touch -t 200001010000 "$old"
  h=$(hook_script sweep 'printf sweep')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/sweep.list"
  e=$(make_engine sweep-engine seventyfive)
  TMPDIR="$parent" AH_HOOK_SWEEP_AGE_S=1 AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/sweep.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/sweep.out" 2>"$tmp/sweep.err"
  [ ! -e "$old" ] && [ -d "$fresh" ]
}

test_temp_term_cleanup_kills_child() {
  parent=$tmp/termparent
  mkdir "$parent"
  started=$tmp/term.started
  pidfile=$tmp/term.pid
  h=$(hook_script termfallback 'printf fallback')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/term.list"
  e=$(make_engine term-engine hang)
  out=$tmp/term.out
  err=$tmp/term.err
  TMPDIR="$parent" AH_STARTED="$started" AH_PIDFILE="$pidfile" AH_SLEEP_S="$long_sleep" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/term.list" AH_HOOK_TIMEOUT_S="$large_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err" &
  wrapper_pid=$!
  wait_for_file "$started" "$poll_limit" && [ -s "$pidfile" ] || {
    kill_test_tree "$wrapper_pid"
    return 1
  }
  engine_pid=$(cat "$pidfile")
  kill -TERM "$wrapper_pid" 2>/dev/null || true
  set +e
  wait "$wrapper_pid" 2>/dev/null
  wrapper_rc=$?
  set -e
  wait_for_pids_gone "$poll_limit" "$engine_pid" || return 1
  root=$parent/ah-hook-$(id -u)
  set -- "$root"/ah-wrapper-run.*
  [ "$wrapper_rc" -eq 143 ] && [ "$1" = "$root/ah-wrapper-run.*" ]
}

test_temp_unusable_guard_blocks() {
  parent=$tmp/unusableparent
  mkdir "$parent"
  root=$parent/ah-hook-$(id -u)
  mkdir -m 700 "$root"
  chmod 500 "$root"
  h=$(hook_script unusable 'printf bad')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/unusable.list"
  out=$tmp/unusable.out
  err=$tmp/unusable.err
  set +e
  TMPDIR="$parent" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/unusable.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  chmod 700 "$root"
  [ "$rc" -eq 2 ] && [ ! -s "$out" ] && grep -q 'cannot create private payload temp file' "$err"
}

test_env_timeout_validation_guard_blocks() {
  h=$(hook_script envbad 'printf bad')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/envbad.list"
  out=$tmp/envbad.out
  err=$tmp/envbad.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/envbad.list" AH_HOOK_TIMEOUT_S=0 sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ ! -s "$out" ]
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
  [ "$rc" -eq 2 ] && [ "$(cat "$out")" = out1 ] && grep -q 'first' "$err" && ! grep -q 'second' "$err"
}

test_stop_active_synthetic_fail_closed_opens() {
  input=$tmp/stop-active.json
  printf '{"hook_event_name":"Stop","session_id":"s","stop_hook_active":true}' >"$input"
  out=$tmp/stop-active.out
  err=$tmp/stop-active.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" Stop <"$input" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && grep -q 'stop_hook_active' "$err"
}

test_stop_active_genuine_exit2_remains_verbatim() {
  input=$tmp/stop-active-exit2.json
  printf '{"hook_event_name":"Stop","session_id":"s","stop_hook_active":true}' >"$input"
  h=$(hook_script stopactiveblock 'printf "{\"decision\":\"block\",\"reason\":\"real\"}\n"; printf real >&2; exit 2')
  printf '@Stop\t%s\n*\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/stop-active-exit2.list"
  out=$tmp/stop-active-exit2.out
  err=$tmp/stop-active-exit2.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/stop-active-exit2.list" sh "$wrapper" Stop <"$input" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ "$(cat "$out")" = '{"decision":"block","reason":"real"}' ] && grep -q real "$err"
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

test_guard_fail_closed_when_selected_hook_not_executable() {
  nonexec=$tmp/not-executable-hook
  printf '#!/bin/sh\nprintf bad\n' >"$nonexec"
  chmod 600 "$nonexec"
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$nonexec" >"$tmp/nonexec-file-guard.list"
  out=$tmp/nonexec-file-guard.out
  err=$tmp/nonexec-file-guard.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/nonexec-file-guard.list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ ! -s "$out" ] && grep -q 'fail closed' "$err" && ! grep -q "$nonexec" "$err"
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

fake_node_bin() {
  d=$tmp/fakenode-bin
  mkdir -p "$d"
  cat >"$d/node" <<'NODE'
#!/bin/sh
# Stand-in for node: runs the last argument as a shell script if it exists, else prints node's missing-module error and exits 1.
for last do :; done
if [ ! -f "$last" ]; then
  printf "node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module '%s'\n  code: 'MODULE_NOT_FOUND'\n" "$last" >&2
  exit 1
fi
exec sh "$last"
NODE
  chmod +x "$d/node"
  printf '%s\n' "$d"
}

root_case() {
  # root_case <name> <event> <root-or-UNSET> <tool>; list rows in $tmp/<name>.list; prints rc
  rcn=$1; ev=$2; root=$3
  nb=$(fake_node_bin)
  e=$(make_engine "$rcn" seventyfive)
  if [ "$root" = UNSET ]; then
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/$rcn.list" PATH="$nb:$PATH" sh "$wrapper" "$ev" --tool-from-payload <"$tmp/bashpush.json" >"$tmp/$rcn.out" 2>"$tmp/$rcn.err"
  else
    AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/$rcn.list" CLAUDE_PLUGIN_ROOT="$root" PATH="$nb:$PATH" sh "$wrapper" "$ev" --tool-from-payload <"$tmp/bashpush.json" >"$tmp/$rcn.out" 2>"$tmp/$rcn.err"
  fi
}

test_fallback_unrunnable_plugin_root_fails_closed() {
  printf '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' >"$tmp/bashpush.json"
  printf '@PreToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/git-guard.js"\n@PostToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/audit.js"\n' >"$tmp/rootbad.list"
  sed "s/git-guard.js/no-such-guard.js/" "$tmp/rootbad.list" >"$tmp/rootunset.list"; cp "$tmp/rootbad.list" "$tmp/rootnon.list"
  set +e
  root_case rootbad PreToolUse "$tmp/no-such-root"; rc1=$?
  root_case rootunset PreToolUse UNSET; rc2=$?
  root_case rootnon PostToolUse "$tmp/no-such-root"; rc3=$?
  set -e
  [ "$rc1" -eq 2 ] && [ "$rc2" -eq 2 ] && [ "$rc3" -eq 0 ] && grep -q 'fail closed' "$tmp/rootbad.err" && grep -q "hook script not found" "$tmp/rootunset.err"
}

test_fallback_missing_module_exit1_fails_closed_own_exit1_does_not() {
  printf '{"tool_name":"Bash","tool_input":{"command":"x"}}' >"$tmp/bashpush.json"
  good=$tmp/plugin-root-good
  mkdir -p "$good/hooks"
  printf 'echo own-reason >&2; exit 1\n' >"$good/hooks/own.js"
  printf 'echo blocked-by-guard >&2; exit 2\n' >"$good/hooks/block.js"
  printf '@PreToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/own.js"\n' >"$tmp/rootown.list"
  printf '@PreToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/block.js"\n' >"$tmp/rootblock.list"
  printf '@PreToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/own.js"\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/gone.js"\n' >"$tmp/rootgone.list"
  set +e
  root_case rootown PreToolUse "$good"; rc1=$?
  root_case rootblock PreToolUse "$good"; rc2=$?
  root_case rootgone PreToolUse "$good"; rc3=$?
  set -e
  [ "$rc1" -eq 0 ] && [ "$rc2" -eq 2 ] && grep -q 'blocked-by-guard' "$tmp/rootblock.err" && [ "$rc3" -eq 2 ]
}

test_fallback_node_module_not_found_exit1_guard_only() {
  # script exists (so the target check passes) but node itself reports a missing module and exits 1
  printf '{"tool_name":"Bash","tool_input":{"command":"x"}}' >"$tmp/bashpush.json"
  good=$tmp/plugin-root-mnf
  mkdir -p "$good/hooks"
  printf 'echo "Error: Cannot find module dep" >&2; echo "  code: '"'"'MODULE_NOT_FOUND'"'"'" >&2; exit 1\n' >"$good/hooks/mnf.js"
  printf '@PreToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/mnf.js"\n@PostToolUse\t10\nBash\t10\tnode "${CLAUDE_PLUGIN_ROOT}/hooks/mnf.js"\n' >"$tmp/rootmnf.list"
  cp "$tmp/rootmnf.list" "$tmp/rootmnfpost.list"
  set +e
  root_case rootmnf PreToolUse "$good"; rc1=$?
  root_case rootmnfpost PostToolUse "$good"; rc2=$?
  set -e
  [ "$rc1" -eq 2 ] && [ "$rc2" -eq 0 ]
}

test_ah_knobs_ignored_without_wrapper_test() {
  e=$tmp/engine-marker.sh
  printf '#!/bin/sh\ncat >/dev/null; : >"%s/knob-engine-ran"; exit 0\n' "$tmp" >"$e"
  chmod +x "$e"
  home=$tmp/knob-home
  mkdir -p "$home"
  : >"$tmp/knob-empty.list"
  rm -f "$tmp/knob-engine-ran"
  set +e
  env -u AH_WRAPPER_TEST AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/knob-empty.list" HOME="$home" PATH="/usr/bin:/bin" /bin/sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/knob.out" 2>"$tmp/knob.err"
  set -e
  # production: the knobs are ignored with a one-line note and the planted engine never runs
  [ ! -e "$tmp/knob-engine-ran" ] && grep -q 'ignoring test-only' "$tmp/knob.err"
}

test_ah_knobs_honored_with_wrapper_test() {
  e=$tmp/engine-marker2.sh
  printf '#!/bin/sh\ncat >/dev/null; : >"%s/knob2-engine-ran"; exit 0\n' "$tmp" >"$e"
  chmod +x "$e"
  : >"$tmp/knob2-empty.list"
  rm -f "$tmp/knob2-engine-ran"
  AH_WRAPPER_TEST=1 AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/knob2-empty.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/knob2.out" 2>"$tmp/knob2.err"
  [ -e "$tmp/knob2-engine-ran" ] && ! grep -q 'ignoring test-only' "$tmp/knob2.err"
}

test_temp_base_prefers_home_then_xdg() {
  home=$tmp/prefer-home
  xdg=$tmp/prefer-xdg
  mkdir -p "$home" "$xdg"
  chmod 700 "$xdg"
  h=$(hook_script preferhome 'mode(){ stat -f "%Lp" "$1" 2>/dev/null || stat -c "%a" "$1"; }; d="$HOME/.anti-hall/tmp"; set -- "$d"/ah-wrapper-run.*/payload; [ -f "$1" ] && [ "$(mode "$d")" = 700 ] && printf home-ok')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/preferhome.list"
  e=$(make_engine preferhome-engine seventyfive)
  HOME="$home" TMPDIR="$tmp/never-used" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/preferhome.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/preferhome.out" 2>"$tmp/preferhome.err" || return 1
  [ "$(cat "$tmp/preferhome.out")" = home-ok ] || return 1
  h2=$(hook_script preferxdg 'set -- "$XDG_RUNTIME_DIR"/ah-hook-*/ah-wrapper-run.*/payload; [ -f "$1" ] && printf xdg-ok')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h2" >"$tmp/preferxdg.list"
  HOME="$home" XDG_RUNTIME_DIR="$xdg" TMPDIR="$tmp/never-used" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/preferxdg.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/preferxdg.out" 2>"$tmp/preferxdg.err" || return 1
  [ "$(cat "$tmp/preferxdg.out")" = xdg-ok ]
}

now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

test_healthy_engine_returns_immediately_every_shell() {
  e=$tmp/engine-instant.sh
  printf '#!/bin/sh\ncat >/dev/null; printf ok\nexit 0\n' >"$e"
  chmod +x "$e"
  : >"$tmp/instant.list"
  ran_any=0
  for shname in sh dash bash; do
    command -v "$shname" >/dev/null 2>&1 || continue
    ran_any=1
    i=0
    while [ "$i" -lt 50 ]; do
      t0=$(now_ms)
      AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/instant.list" "$shname" "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/instant.out" 2>"$tmp/instant.err"
      rc=$?
      t1=$(now_ms)
      if [ "$rc" -ne 0 ] || [ "$(cat "$tmp/instant.out")" != ok ] || [ -s "$tmp/instant.err" ] || [ $((t1 - t0)) -ge 500 ]; then
        printf 'instant engine under %s run %s: rc=%s ms=%s out=%s err=%s\n' "$shname" "$i" "$rc" "$((t1 - t0))" "$(cat "$tmp/instant.out")" "$(cat "$tmp/instant.err")" >&2
        return 1
      fi
      i=$((i + 1))
    done
  done
  [ "$ran_any" -eq 1 ]
}

test_hanging_engine_is_cut_at_timeout_not_before() {
  e=$(make_engine cut hang)
  : >"$tmp/cut.list"
  for shname in sh dash bash; do
    command -v "$shname" >/dev/null 2>&1 || continue
    t0=$(now_ms)
    set +e
    AH_STARTED="$tmp/cut.started" AH_SLEEP_S=30 AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/cut.list" AH_HOOK_TIMEOUT_S=2 AH_KILL_GRACE_S=1 "$shname" "$wrapper" Notification --tool-from-payload <"$payload" >"$tmp/cut.out" 2>"$tmp/cut.err"
    set -e
    t1=$(now_ms)
    ms=$((t1 - t0))
    # cut no earlier than the 2 s timeout, and well before the engine's own 30 s sleep
    if [ "$ms" -lt 2000 ] || [ "$ms" -gt 8000 ] || ! grep -q 'engine timed out' "$tmp/cut.err"; then
      printf 'hanging engine under %s: ms=%s err=%s\n' "$shname" "$ms" "$(cat "$tmp/cut.err")" >&2
      return 1
    fi
  done
  return 0
}

test_block_stderr_is_exactly_the_hooks_text_every_shell() {
  slow=$(hook_script blockslow 'sleep 30')
  blocker=$(hook_script blocker 'printf "BLOCK-MSG: no\n" >&2; printf "{\"x\":1}"; exit 2')
  printf '@PreToolUse\t%s\nBash\t1\t%s\nBash\t%s\t%s\n' "$large_timeout" "$slow" "$large_timeout" "$blocker" >"$tmp/blockexact.list"
  e=$(make_engine blockexact-engine seventyfive)
  for shname in sh dash bash; do
    command -v "$shname" >/dev/null 2>&1 || continue
    set +e
    AH_KILL_GRACE_S=0 AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/blockexact.list" "$shname" "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/blockexact.out" 2>"$tmp/blockexact.err"
    rc=$?
    set -e
    printf 'BLOCK-MSG: no\n' >"$tmp/blockexact.want"
    if [ "$rc" -ne 2 ] || ! cmp -s "$tmp/blockexact.want" "$tmp/blockexact.err"; then
      printf 'block stderr under %s: rc=%s err=[%s]\n' "$shname" "$rc" "$(cat "$tmp/blockexact.err")" >&2
      return 1
    fi
  done
  return 0
}

check normal_passthrough test_normal_passthrough
check tool_from_payload_reaches_engine test_tool_from_payload_reaches_engine
check exit_75_fallback test_exit_75_fallback
check missing_binary_fallback test_missing_binary_fallback
check signal_fallback test_signal_fallback
check engine_odd_exits_fallback test_engine_odd_exits_fallback
check timeout_fallback test_timeout_fallback
check timeout_kills_engine_process test_timeout_kills_engine_process
check timeout_kills_fallback_process test_timeout_kills_fallback_process
check invalid_bytes_reach_fallback test_invalid_bytes_reach_fallback
check matcher_selection test_matcher_selection
check tool_name_structural_scanner test_tool_name_structural_scanner
check tool_name_invalid_selects_all_non_guard test_tool_name_invalid_selects_all_non_guard
check tool_name_huge_payload_fast test_tool_name_huge_payload_fast
check fallback_exit_code_matrix_rows test_fallback_exit_code_matrix_rows
check fallback_exit1_host_nonblocking_rows test_fallback_exit1_host_nonblocking_rows
check shell_started_126_127_are_host_nonblocking test_shell_started_126_127_are_host_nonblocking
check exit0_json_block_wins_verbatim test_exit0_json_block_wins_verbatim
check first_json_block_wins_verbatim test_first_json_block_wins_verbatim
check fallback_signal_and_incomplete_fail_closed test_fallback_signal_and_incomplete_fail_closed
check fallback_timeout_discard_allows_other_hook test_fallback_timeout_discard_allows_other_hook
check temp_modes_and_owner test_temp_modes_and_owner
check temp_refuses_bad_base_and_symlink_parent test_temp_refuses_bad_base_and_symlink_parent
check temp_sweep_old_keeps_fresh test_temp_sweep_old_keeps_fresh
check temp_term_cleanup_kills_child test_temp_term_cleanup_kills_child
check temp_unusable_guard_blocks test_temp_unusable_guard_blocks
check env_timeout_validation_guard_blocks test_env_timeout_validation_guard_blocks
check first_exit_two_wins test_first_exit_two_wins
check stop_active_synthetic_fail_closed_opens test_stop_active_synthetic_fail_closed_opens
check stop_active_genuine_exit2_remains_verbatim test_stop_active_genuine_exit2_remains_verbatim
check guard_fail_closed_without_engine_or_nodes test_guard_fail_closed_without_engine_or_nodes
check non_guard_missing_engine_without_nodes_fails_open test_non_guard_missing_engine_without_nodes_fails_open
check guard_fail_closed_when_selected_hook_cannot_exec test_guard_fail_closed_when_selected_hook_cannot_exec
check guard_fail_closed_when_selected_hook_not_executable test_guard_fail_closed_when_selected_hook_not_executable
check non_guard_selected_hook_cannot_exec_fails_open test_non_guard_selected_hook_cannot_exec_fails_open
check selected_exec_failure_does_not_override_runnable_hook test_selected_exec_failure_does_not_override_runnable_hook
check engine_lookup_prefers_ah_engine_bin test_engine_lookup_prefers_ah_engine_bin
check engine_lookup_prefers_home_install_over_path test_engine_lookup_prefers_home_install_over_path
check engine_lookup_uses_path test_engine_lookup_uses_path
check fallback_unrunnable_plugin_root_fails_closed test_fallback_unrunnable_plugin_root_fails_closed
check fallback_missing_module_exit1_fails_closed_own_exit1_does_not test_fallback_missing_module_exit1_fails_closed_own_exit1_does_not
check fallback_node_module_not_found_exit1_guard_only test_fallback_node_module_not_found_exit1_guard_only
check ah_knobs_ignored_without_wrapper_test test_ah_knobs_ignored_without_wrapper_test
check ah_knobs_honored_with_wrapper_test test_ah_knobs_honored_with_wrapper_test
check temp_base_prefers_home_then_xdg test_temp_base_prefers_home_then_xdg
check healthy_engine_returns_immediately_every_shell test_healthy_engine_returns_immediately_every_shell
check hanging_engine_is_cut_at_timeout_not_before test_hanging_engine_is_cut_at_timeout_not_before
check block_stderr_is_exactly_the_hooks_text_every_shell test_block_stderr_is_exactly_the_hooks_text_every_shell

printf 'wrapper tests: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

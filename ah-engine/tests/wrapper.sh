#!/bin/sh
set -eu
AH_WRAPPER_TEST=1
export AH_WRAPPER_TEST

repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
# The suite runs the thin client (ah-hook, via ah-launcher/tests/shim.sh: AH_LAUNCHER_BIN, else the release build); the plugin ships
# no wrapper script. AH_WRAPPER_UNDER_TEST points it at another implementation of the same contract.
wrapper=${AH_WRAPPER_UNDER_TEST:-$repo/ah-launcher/tests/shim.sh}
tmp=${TMPDIR:-/tmp}/ah-wrapper-test.$$
mkdir -p "$tmp"
: >"$tmp/homefile"
HOME=$tmp/homefile/h
export HOME
unset XDG_RUNTIME_DIR
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

# AH_STAT_SHIM=gnu runs the whole suite with a GNU-semantics `stat` first on PATH (real gstat when installed, else a mimic
# whose -f prints filesystem info for its operands and fails, which is what GNU coreutils does).
make_gnu_stat_shim() {
  d=$1
  mkdir -p "$d"
  if command -v gstat >/dev/null 2>&1; then
    printf '#!/bin/sh\nexec %s "$@"\n' "$(command -v gstat)" >"$d/stat"
  elif /usr/bin/stat -c %u / >/dev/null 2>&1; then
    # a GNU host (Linux): the real stat already has GNU semantics, the BSD-based mimic below cannot run there
    printf '#!/bin/sh\nexec /usr/bin/stat "$@"\n' >"$d/stat"
  else
    cat >"$d/stat" <<'SHIM'
#!/bin/sh
fmt=; mode=
case "$1" in
  -c) mode=c; fmt=$2; shift 2 ;;
  -f) mode=f; shift 2>/dev/null; fmt=$1 ;;
esac
if [ "$mode" = f ]; then
  for a in "$@"; do printf '  File: "%s"\n    ID: 0 Namelen: 255 Type: ext2/ext3\n' "$a"; done
  echo "stat: cannot read file system information for '$1': No such file or directory" >&2
  exit 1
fi
[ "$mode" = c ] || exit 1
f=$1
u=$(/usr/bin/stat -f %u "$f") || exit 1
a=$(/usr/bin/stat -f %Lp "$f") || exit 1
m=$(/usr/bin/stat -f %m "$f") || exit 1
out=$(printf '%s' "$fmt" | sed "s/%u/$u/g; s/%a/$a/g; s/%Y/$m/g")
printf '%s\n' "$out"
SHIM
  fi
  chmod +x "$d/stat"
}

pass=0
fail=0
filter=${1:-}
if [ "${AH_STAT_SHIM:-}" = gnu ]; then
  make_gnu_stat_shim "$tmp/gnu-bin"
  PATH=$tmp/gnu-bin:$PATH
  export PATH
fi
large_timeout=10
short_timeout=3
long_sleep=30
poll_limit=20
# Pin a load-proof hook budget for every case: without it the wrapper uses the shipped 560 ms client deadline and a case
# whose stand-in engine is merely slow to start (loaded machine) is killed and fails open, a different case each run.
# Cases that need another budget set AH_HOOK_TIMEOUT_S/_MS on their own command line.
AH_HOOK_TIMEOUT_S=$large_timeout
export AH_HOOK_TIMEOUT_S

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

# only_notice <err-file>: the file is empty, or holds exactly the one engine-unreachable notice line (the wrapper passes the
# call through unchecked and says so once per session; with an unwritable HOME it cannot remember, so it says so every time).
only_notice() {
  [ ! -s "$1" ] && return 0
  [ "$(wc -l <"$1" | tr -d ' ')" -eq 1 ] && grep -q '^anti-hall: the engine did not answer this ' "$1"
}

# engine_script <name> <body>: a stand-in engine that runs <body> (stdin is the hook payload).
engine_script() {
  p=$tmp/engine-$1.sh
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$2"
  } >"$p"
  chmod +x "$p"
  printf '%s\n' "$p"
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
      exit1_done) printf 'cat >/dev/null; : >"$AH_ENGINE_DONE_FILE"; printf "hook-own-error\\n" >&2; printf "hook-own-out"; exit 1\n' ;;
      exit3) printf 'cat >/dev/null; exit 3\n' ;;
      exit126) printf 'cat >/dev/null; exit 126\n' ;;
      exit127) printf 'cat >/dev/null; exit 127\n' ;;
      seventyfive) printf 'cat >/dev/null; exit 75\n' ;;
      signal) printf 'kill -9 $$\n' ;;
      hang) printf 'printf started >"$AH_STARTED"; [ -z "${AH_PID_DELAY_S:-}" ] || sleep "$AH_PID_DELAY_S"; [ -z "${AH_PIDFILE:-}" ] || printf "%%s\\n" "$$" >"$AH_PIDFILE"; sleep "$AH_SLEEP_S"\n' ;;
      late_marker) printf 'printf started >"$AH_STARTED"; ( sleep "$AH_SLEEP_S"; printf late >"$AH_MARKER" ) & child=$!; ( sleep "$AH_SLEEP_S"; printf grand >"$AH_GRAND_MARKER" ) & grand=$!; printf "%%s %%s\\n" "$child" "$grand" >"$AH_PIDFILE"; wait\n' ;;
    esac
  } >"$p"
  chmod +x "$p"
  printf '%s\n' "$p"
}

stat_mode() {
  if stat -c '%a' "$1" 2>/dev/null; then
    return 0
  fi
  stat -f '%Lp' "$1" 2>/dev/null
}

stat_uid() {
  if stat -c '%u' "$1" 2>/dev/null; then
    return 0
  fi
  stat -f '%u' "$1" 2>/dev/null
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

# wait_for_nonempty_file <path> [limit]: the engine stand-ins create a marker file and only then write into it (a pid), so the
# file existing is not the file being complete; under load the gap between the two writes is whole seconds.
wait_for_nonempty_file() {
  path=$1
  limit=${2:-$poll_limit}
  i=0
  while [ "$i" -lt "$limit" ]; do
    [ -s "$path" ] && return 0
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

test_exit_75_fallback() {
  # the engine hands the call back (exit 75): no hook command exists to run, so the call passes through unchecked with the notice
  sentinel=$tmp/75-ran
  rm -f "$sentinel"
  h=$(hook_script h75 "printf ran >\"$sentinel\"")
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/75.list"
  e=$(make_engine seventyfive seventyfive)
  out=$tmp/75.out
  err=$tmp/75.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/75.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && [ ! -e "$sentinel" ] && grep -q '^anti-hall: the engine did not answer this PreToolUse call' "$err"
}

test_a_hooks_own_exit_code_passes_through_once_the_engine_marked_the_dispatch_done() {
  # D87: the engine dispatched the event and a hook exited 1 (a non-blocking error). The wrapper must hand that answer to the
  # host as it is, not run every hook a second time; the same exit code WITHOUT the mark is an engine failure (next test).
  sentinel=$tmp/done-fallback-ran
  rm -f "$sentinel"
  h=$(hook_script doneh "printf ran >\"$sentinel\"")
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/done.list"
  e=$(make_engine exit1done exit1_done)
  set +e
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/done.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/done.out" 2>"$tmp/done.err"
  rc=$?
  set -e
  [ "$rc" -eq 1 ] && [ "$(cat "$tmp/done.out")" = hook-own-out ] && grep -q hook-own-error "$tmp/done.err" && [ ! -e "$sentinel" ]
}

test_an_engine_exit_code_without_the_done_mark_is_an_engine_failure() {
  sentinel=$tmp/nomark-fallback-ran
  rm -f "$sentinel"
  h=$(hook_script nomarkh "printf ran >\"$sentinel\"")
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/nomark.list"
  e=$(make_engine exit1nomark exit1)
  set +e
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/nomark.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/nomark.out" 2>"$tmp/nomark.err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -e "$sentinel" ] && [ ! -s "$tmp/nomark.out" ] && only_notice "$tmp/nomark.err"
}

test_missing_binary_fallback() {
  h=$(hook_script missing 'printf missing')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/missing.list"
  out=$tmp/missing.out
  err=$tmp/missing.err
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/missing.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  [ ! -s "$out" ] && only_notice "$err"
}

test_signal_fallback() {
  h=$(hook_script sig 'printf signal')
  printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/sig.list"
  e=$(make_engine signal signal)
  out=$tmp/sig.out
  err=$tmp/sig.err
  AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/sig.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  # Contract: an engine killed by a signal fails open with the notice (exit 0, no output, no Node handoff).
  if [ -s "$out" ] || ! only_notice "$err"; then
    printf 'signal_fallback: out=[%s] err=[%s]\n' "$(cat "$out")" "$(cat "$err")" >&2
    return 1
  fi
}

test_engine_odd_exits_fallback() {
  for mode in exit1 exit3 exit126 exit127; do
    h=$(hook_script "odd-$mode" "printf $mode")
    printf '@PreToolUse\t%s\nBash\t%s\t%s\n' "$large_timeout" "$large_timeout" "$h" >"$tmp/odd-$mode.list"
    e=$(make_engine "$mode" "$mode")
    out=$tmp/odd-$mode.out
    err=$tmp/odd-$mode.err
    AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/odd-$mode.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err" || return 1
    [ ! -s "$out" ] && only_notice "$err" || return 1
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
  wait_for_file "$started" "$poll_limit" && wait_for_nonempty_file "$pidfile" "$poll_limit" || return 1
  pid=$(cat "$pidfile")
  wait_for_pids_gone "$poll_limit" "$pid" &&
    [ ! -s "$out" ] && only_notice "$err"
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
  wait_for_file "$started" "$poll_limit" && wait_for_nonempty_file "$pidfile" "$poll_limit" || return 1
  set -- $(cat "$pidfile")
  wait_for_pids_gone "$poll_limit" "$1" "$2" &&
    [ ! -s "$out" ] && [ ! -e "$marker" ] && [ ! -e "$grand_marker" ] && only_notice "$err"
}












test_cold_engine_does_not_hold_host_stderr_open() {
  # A host that collects the hook's stderr waits for EOF on that pipe. The wrapper keeps the host's stderr on fd 4 while the
  # engine runs; the engine (and the daemon it detaches) must not inherit it, or EOF only arrives when the daemon exits.
  # the stand-in detaches a sleeper into its own process group, as the daemon does, so the wrapper's group kill cannot reach it
  p=$tmp/leak-engine.sh
  cat >"$p" <<'ENGINE'
#!/bin/sh
cat >/dev/null
( set -m; sleep 8 </dev/null >/dev/null 2>&1 & )
exit 0
ENGINE
  chmod +x "$p"
  start=$(date +%s)
  AH_ENGINE_BIN="$p" AH_HOOK_TIMEOUT_S="$large_timeout" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" 2>&1 >/dev/null | cat >/dev/null
  end=$(date +%s)
  [ $((end - start)) -lt 4 ]
}

test_missing_engine_and_missing_defaults_fail_open() {
  mkdir -p "$tmp/no-defaults-root"
  for ev in PreToolUse Stop; do
    set +e
    AH_ENGINE_PLUGIN_ROOT="$tmp/no-defaults-root" AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" sh "$wrapper" "$ev" --tool-from-payload <"$payload" >"$tmp/nodef.out" 2>"$tmp/nodef.err"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || return 1
  done
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
  wait_for_file "$started" "$poll_limit" && wait_for_nonempty_file "$pidfile" "$poll_limit" || {
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


test_stop_active_synthetic_fail_closed_opens() {
  input=$tmp/stop-active.json
  printf '{"hook_event_name":"Stop","session_id":"s","stop_hook_active":true}' >"$input"
  out=$tmp/stop-active.out
  err=$tmp/stop-active.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" Stop <"$input" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && only_notice "$err"
}


test_guard_fail_closed_without_engine_or_nodes() {
  out=$tmp/closed.out
  err=$tmp/closed.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && only_notice "$err"
}

test_non_guard_missing_engine_without_nodes_fails_open() {
  out=$tmp/non-guard-open.out
  err=$tmp/non-guard-open.err
  set +e
  AH_ENGINE_BIN=/no/such/engine AH_FALLBACK_LIST="$tmp/no-list" HOME="$tmp/no-home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh "$wrapper" PostToolUse --tool-from-payload <"$payload" >"$out" 2>"$err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && [ ! -s "$out" ] && only_notice "$err"
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

# Regression: GNU stat treats `-f` as --file-system. The wrapper must pick the flavour once and never emit the other form's
# output, so the private temp dir is still made and the hooks run under GNU semantics.
test_gnu_stat_flavour_still_makes_private_tmp() {
  shim=$tmp/regr-gnu-bin
  make_gnu_stat_shim "$shim"
  e=$(engine_script gnuregr 'cat >/dev/null; printf gnu-ok')
  PATH=$shim:$PATH AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/gnuregr.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/gnuregr.out" 2>"$tmp/gnuregr.err" || return 1
  [ "$(cat "$tmp/gnuregr.out")" = gnu-ok ] && ! grep -q 'cannot create private\|no private temp' "$tmp/gnuregr.err"
}

# Degraded path: the private base cannot be made (unwritable TMPDIR, no usable HOME). The guard hook still runs and decides.
# Last resort: no temp dir can be made anywhere (mktemp shimmed to fail). Payload goes to each hook through a pipe.
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
    best=999999
    # Correctness is asserted on every run. Speed is asserted on the BEST run: a wrapper that blocks on its
    # watchdog pays the watchdog's 1 s first poll on EVERY run, so best >= 1000 ms; machine load can slow
    # individual runs (measured 500-1000 ms at load ~19) but cannot slow all 50, so an absolute per-run bound
    # would be a load test, not a wrapper test. A run at/over the 5 s timeout means "engine timed out".
    while [ "$i" -lt 50 ]; do
      t0=$(now_ms)
      AH_HOOK_TIMEOUT_S=5 AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/instant.list" "$shname" "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/instant.out" 2>"$tmp/instant.err"
      rc=$?
      t1=$(now_ms)
      if [ "$rc" -ne 0 ] || [ "$(cat "$tmp/instant.out")" != ok ] || [ -s "$tmp/instant.err" ] || [ $((t1 - t0)) -ge 5000 ]; then
        printf 'instant engine under %s run %s: rc=%s ms=%s out=%s err=%s\n' "$shname" "$i" "$rc" "$((t1 - t0))" "$(cat "$tmp/instant.out")" "$(cat "$tmp/instant.err")" >&2
        return 1
      fi
      [ $((t1 - t0)) -lt "$best" ] && best=$((t1 - t0))
      i=$((i + 1))
    done
    if [ "$best" -ge 1000 ]; then
      printf 'instant engine under %s: fastest of 50 runs took %s ms (wrapper waits on its watchdog)\n' "$shname" "$best" >&2
      return 1
    fi
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
    rc=$?
    set -e
    t1=$(now_ms)
    ms=$((t1 - t0))
    # Hung engines now fail open without Node handoff, and still return well before the engine's own 30 s sleep.
    if [ "$rc" -ne 0 ] || [ "$ms" -gt 8000 ] || [ -s "$tmp/cut.out" ] || ! only_notice "$tmp/cut.err"; then
      printf 'hanging engine under %s: rc=%s ms=%s out=%s err=%s\n' "$shname" "$rc" "$ms" "$(cat "$tmp/cut.out")" "$(cat "$tmp/cut.err")" >&2
      return 1
    fi
  done
  return 0
}

test_block_stderr_is_exactly_the_hooks_text_every_shell() {
  e=$(engine_script blockexact-engine 'cat >/dev/null; printf "BLOCK-MSG: no\n" >&2; printf "{\"x\":1}"; exit 2')
  for shname in sh dash bash; do
    command -v "$shname" >/dev/null 2>&1 || continue
    set +e
    AH_KILL_GRACE_S=0 AH_ENGINE_BIN="$e" "$shname" "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/blockexact.out" 2>"$tmp/blockexact.err"
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


test_killed_wrapper_orphans_are_reaped() {
  # Contract: the wrapper has a ~0.5 s fail-open deadline by default; this test needs the engine to outlive it so the wrapper can be
  # SIGKILLed mid-run, hence the explicit AH_HOOK_TIMEOUT_MS. What it guards (orphan reaping) is unchanged.
  parent=$tmp/orphanparent
  mkdir "$parent"
  started=$tmp/orphan.started
  pidfile=$tmp/orphan.pid
  rm -f "$started" "$pidfile"
  : >"$tmp/orphan.list"
  e=$(make_engine orphan-engine hang)
  TMPDIR="$parent" AH_STARTED="$started" AH_PIDFILE="$pidfile" AH_SLEEP_S="$long_sleep" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/orphan.list" AH_HOOK_TIMEOUT_S=60 AH_HOOK_TIMEOUT_MS=60000 sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >"$tmp/orphan.out" 2>"$tmp/orphan.err" &
  wrapper_pid=$!
  wait_for_file "$started" "$poll_limit" && wait_for_nonempty_file "$pidfile" "$poll_limit" || {
    kill_test_tree "$wrapper_pid"
    return 1
  }
  engine_pid=$(cat "$pidfile")
  sleeper_pid=$(pgrep -P "$engine_pid" 2>/dev/null | head -n 1 || true)
  kill -KILL "$wrapper_pid" 2>/dev/null || true
  set +e
  wait "$wrapper_pid" 2>/dev/null
  set -e
  # the watchdog notices the dead wrapper, kills the hook and its children, and removes the payload dir
  if ! wait_for_pids_gone 6 "$engine_pid" ${sleeper_pid:+"$sleeper_pid"}; then
    root=$parent/ah-hook-$(id -u)
    printf 'orphan reaper: engine=%s sleeper=%s engine_alive=' "$engine_pid" "${sleeper_pid:-}" >&2
    kill -0 "$engine_pid" 2>/dev/null && printf yes >&2 || printf no >&2
    printf ' sleeper_alive=' >&2
    [ -n "$sleeper_pid" ] && kill -0 "$sleeper_pid" 2>/dev/null && printf yes >&2 || printf no >&2
    printf ' run_dirs=' >&2
    set -- "$root"/ah-wrapper-run.*
    printf '%s\n' "$*" >&2
    kill -KILL "$engine_pid" ${sleeper_pid:+"$sleeper_pid"} 2>/dev/null || true
    return 1
  fi
  root=$parent/ah-hook-$(id -u)
  i=0
  while [ "$i" -lt 6 ]; do
    set -- "$root"/ah-wrapper-run.*
    [ "$1" = "$root/ah-wrapper-run.*" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

run_signal_cleanup_case() {
  # run_signal_cleanup_case <label> <signal|NONE> <expected-rc>: the private run dir must be gone afterwards
  sc_label=$1; sc_sig=$2; sc_rc=$3
  sc_parent=$tmp/sig-$sc_label
  mkdir "$sc_parent"
  sc_started=$tmp/sig-$sc_label.started
  sc_pidfile=$tmp/sig-$sc_label.pid
  if [ "$sc_sig" = NONE ]; then
    e=$(make_engine "sig-$sc_label" normal)
    set +e
    TMPDIR="$sc_parent" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/empty.list" sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >/dev/null 2>&1
    got=$?
    set -e
  else
    e=$(make_engine "sig-$sc_label" hang)
    # The wrapper's own hook timeout and the stand-in's sleep must outlast the test's polling (20 x 1 s sleeps) on a starved
    # machine: with the 10 s timeout the wrapper gave up first and answered its fail-closed exit 2 instead of the signal's 129/130
    # (seen under load; reproduced with a CPU-saturated host and a nice 19 test run).
    sc_timeout=$((poll_limit * 5)); sc_sleep=$((poll_limit * 6))
    # A non-interactive shell starts a background job with SIGINT ignored, and an ignored signal cannot be reset from a
    # shell. `set -m` fixes that only with a controlling terminal (dash on a CI runner prints "can't access tty" and the INT
    # case then waited out the wrapper's whole hook timeout: exit 2, not 130). perl resets the disposition and execs, so the
    # wrapper is the same pid either way; job control stays the fallback where perl is missing.
    sc_unint=
    if command -v perl >/dev/null 2>&1; then
      printf '$SIG{INT} = "DEFAULT"; exec @ARGV or exit 127;\n' >"$tmp/unint.pl"
      sc_unint="perl $tmp/unint.pl"
    fi
    set -m 2>/dev/null || true
    TMPDIR="$sc_parent" AH_STARTED="$sc_started" AH_PIDFILE="$sc_pidfile" AH_SLEEP_S="$sc_sleep" AH_ENGINE_BIN="$e" AH_FALLBACK_LIST="$tmp/empty.list" AH_HOOK_TIMEOUT_S="$sc_timeout" $sc_unint sh "$wrapper" PreToolUse --tool-from-payload <"$payload" >/dev/null 2>&1 &
    sc_pid=$!
    set +m 2>/dev/null || true
    wait_for_file "$sc_started" "$poll_limit" && wait_for_nonempty_file "$sc_pidfile" "$poll_limit" || {
      kill_test_tree "$sc_pid"
      return 1
    }
    sc_engine=$(cat "$sc_pidfile")
    kill -"$sc_sig" "$sc_pid" 2>/dev/null || true
    set +e
    wait "$sc_pid" 2>/dev/null
    got=$?
    set -e
    wait_for_pids_gone "$poll_limit" "$sc_engine" || { printf 'signal cleanup %s: engine %s still alive\n' "$sc_label" "$sc_engine" >&2; return 1; }
  fi
  sc_root=$sc_parent/ah-hook-$(id -u)
  set -- "$sc_root"/ah-wrapper-run.*
  [ "$got" -eq "$sc_rc" ] && [ "$1" = "$sc_root/ah-wrapper-run.*" ] || {
    printf 'signal cleanup %s: exit %s (want %s), run dir left: %s\n' "$sc_label" "$got" "$sc_rc" "$1" >&2
    return 1
  }
}

test_temp_removed_on_normal_exit() { run_signal_cleanup_case normal NONE 2; }
test_temp_removed_on_hup() { run_signal_cleanup_case hup HUP 129; }
test_temp_removed_on_int() { run_signal_cleanup_case int INT 130; }



check normal_passthrough test_normal_passthrough
check hooks_own_exit_code_passes_through_after_done_mark test_a_hooks_own_exit_code_passes_through_once_the_engine_marked_the_dispatch_done
check engine_exit_without_done_mark_is_a_failure test_an_engine_exit_code_without_the_done_mark_is_an_engine_failure
check exit_75_fallback test_exit_75_fallback
check missing_binary_fallback test_missing_binary_fallback
check signal_fallback test_signal_fallback
check engine_odd_exits_fallback test_engine_odd_exits_fallback
check timeout_fallback test_timeout_fallback
check timeout_kills_engine_process test_timeout_kills_engine_process
check cold_engine_does_not_hold_host_stderr_open test_cold_engine_does_not_hold_host_stderr_open
check missing_engine_and_missing_defaults_fail_open test_missing_engine_and_missing_defaults_fail_open
check temp_term_cleanup_kills_child test_temp_term_cleanup_kills_child
check env_timeout_validation_guard_blocks test_env_timeout_validation_guard_blocks
check stop_active_synthetic_fail_closed_opens test_stop_active_synthetic_fail_closed_opens
check guard_fail_closed_without_engine_or_nodes test_guard_fail_closed_without_engine_or_nodes
check non_guard_missing_engine_without_nodes_fails_open test_non_guard_missing_engine_without_nodes_fails_open
check engine_lookup_prefers_ah_engine_bin test_engine_lookup_prefers_ah_engine_bin
check engine_lookup_prefers_home_install_over_path test_engine_lookup_prefers_home_install_over_path
check engine_lookup_uses_path test_engine_lookup_uses_path
check ah_knobs_ignored_without_wrapper_test test_ah_knobs_ignored_without_wrapper_test
check ah_knobs_honored_with_wrapper_test test_ah_knobs_honored_with_wrapper_test
check healthy_engine_returns_immediately_every_shell test_healthy_engine_returns_immediately_every_shell
check hanging_engine_is_cut_at_timeout_not_before test_hanging_engine_is_cut_at_timeout_not_before
check block_stderr_is_exactly_the_hooks_text_every_shell test_block_stderr_is_exactly_the_hooks_text_every_shell
check killed_wrapper_orphans_are_reaped test_killed_wrapper_orphans_are_reaped
check gnu_stat_flavour_still_makes_private_tmp test_gnu_stat_flavour_still_makes_private_tmp
check temp_removed_on_normal_exit test_temp_removed_on_normal_exit
check temp_removed_on_hup test_temp_removed_on_hup
check temp_removed_on_int test_temp_removed_on_int

# ---- cold start: guard events wait for the daemon (client.cold_guard_wait_ms), everything else stays instant ----
# cg_setup <wait_ms>: a short state dir (the socket path must stay under the socket limit), a plugin root whose defaults carry
# the wait under test, and a stand-in engine. The stand-in logs every call; a kick (the wrapper's empty cold-start request) makes a
# detached "daemon" bind the socket after $AH_COLD_READY_S; with the socket up a PreToolUse is denied, cold it fails open.
cg_setup() {
  cg_wait=$1
  cg_dir=$(mktemp -d /tmp/ahcg.XXXXXX)
  cg_root=$cg_dir/root
  mkdir -p "$cg_root/engine"
  cp -R "$repo/plugins/anti-hall/engine/defaults" "$cg_root/engine/defaults"
  sed "/^\[client.cold_guard_wait_ms\]/,/^\$/s/^value = .*/value = $cg_wait/" "$repo/plugins/anti-hall/engine/defaults/engine.toml" >"$cg_root/engine/defaults/engine.toml"
  cg_state=$cg_dir/s
  mkdir -p "$cg_state"
  cg_log=$cg_dir/calls.log
  : >"$cg_log"
  cg_engine=$cg_dir/engine.sh
  cat >"$cg_engine" <<'ENG'
#!/bin/sh
payload=$(cat)
printf '%s | %s\n' "$*" "$payload" >>"$AH_COLD_LOG"
sock=$AH_ENGINE_DIR/e.sock
case "$payload" in
  *ColdStartKick*)
    [ -z "${AH_COLD_HANG_KICK:-}" ] || sleep 30
    if [ -n "${AH_COLD_READY_S:-}" ] && [ ! -S "$sock" ]; then
      perl -MPOSIX -MIO::Socket::UNIX -e 'exit 0 if fork; POSIX::setsid(); select(undef, undef, undef, $ARGV[1]); unlink $ARGV[0]; $s = IO::Socket::UNIX->new(Local => $ARGV[0], Listen => 1); sleep 4' "$sock" "$AH_COLD_READY_S" </dev/null >/dev/null 2>&1
    fi
    exit 0 ;;
esac
[ -z "${AH_COLD_HANG_ALL:-}" ] || sleep 30
if [ -S "$sock" ]; then
  case "$payload" in
    *PreToolUse*) printf 'denied-by-daemon\n' >&2; exit 2 ;;
  esac
fi
exit 0
ENG
  chmod +x "$cg_engine"
  printf '@PreToolUse\t10\n*\t10\ttrue\n@Stop\t10\n*\t10\ttrue\n@UserPromptSubmit\t10\n*\t10\ttrue\n' >"$cg_dir/list"
}

cg_cleanup() {
  [ -n "${cg_dir:-}" ] && rm -rf "$cg_dir"
  cg_dir=
}

# cg_run <event> <session> [env...]: runs the wrapper against the stand-in; prints "<rc> <ms>"; stdout/stderr land in $cg_dir/out, err
cg_run() {
  cg_ev=$1; cg_sid=$2; shift 2
  printf '{"hook_event_name":"%s","session_id":"%s","tool_name":"Bash"}' "$cg_ev" "$cg_sid" >"$cg_dir/in"
  cg_t0=$(perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000')
  set +e
  env AH_ENGINE_DIR="$cg_state" AH_ENGINE_PLUGIN_ROOT="$cg_root" AH_COLD_LOG="$cg_log" AH_ENGINE_BIN="$cg_engine" AH_FALLBACK_LIST="$cg_dir/list" \
    AH_HOOK_TIMEOUT_S=10 AH_HOOK_TIMEOUT_MS=3000 "$@" sh "$wrapper" "$cg_ev" <"$cg_dir/in" >"$cg_dir/out" 2>"$cg_dir/err"
  cg_rc=$?
  set -e
  cg_t1=$(perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000')
  cg_ms=$((cg_t1 - cg_t0))
}

test_cold_guard_waits_for_a_daemon_that_comes_up() {
  cg_setup 2000
  cg_run PreToolUse sess-a AH_COLD_READY_S=0.5
  ok=1
  # the daemon's real decision (deny) is returned, within the cap (the 2000 ms wait plus the stand-in's own start-up)
  [ "$cg_rc" -eq 2 ] && grep -q denied-by-daemon "$cg_dir/err" || ok=0
  [ "$cg_ms" -lt 2000 ] || ok=0
  [ "$(grep -c ColdStartKick "$cg_log")" -eq 1 ] || ok=0
  [ "$ok" -eq 1 ] || printf 'cold guard ready: rc=%s ms=%s err=%s log=%s\n' "$cg_rc" "$cg_ms" "$(cat "$cg_dir/err")" "$(cat "$cg_log")" >&2
  cg_cleanup
  [ "$ok" -eq 1 ]
}

test_cold_guard_gives_up_at_the_cap_with_one_notice_per_session() {
  cg_setup 600
  ok=1
  cg_run PreToolUse sess-a
  [ "$cg_rc" -eq 0 ] && [ ! -s "$cg_dir/out" ] || ok=0
  grep -q 'was not checked' "$cg_dir/err" || ok=0
  grep -q 'PreToolUse' "$cg_dir/err" || ok=0
  # never past the cap (plus load slack), and not before it
  [ "$cg_ms" -ge 500 ] && [ "$cg_ms" -lt 2500 ] || ok=0
  first_ms=$cg_ms
  # same session: waits again but stays quiet; another session: notice again
  cg_run Stop sess-a
  [ "$cg_rc" -eq 0 ] && ! grep -q 'was not checked' "$cg_dir/err" || ok=0
  cg_run PreToolUse sess-b
  [ "$cg_rc" -eq 0 ] && grep -q 'was not checked' "$cg_dir/err" || ok=0
  [ "$ok" -eq 1 ] || printf 'cold guard cap: first_ms=%s rc=%s err=%s\n' "$first_ms" "$cg_rc" "$(cat "$cg_dir/err")" >&2
  cg_cleanup
  [ "$ok" -eq 1 ]
}

# One absolute cold deadline (Codex delta F2): a kick that hangs, and a kick plus engine that both hang, end within
# client.cold_guard_wait_ms (kick budget plus its kill grace) with the cold-start notice, and run no second engine attempt (Codex
# final Prior-2: the cap plus a real attempt was not the single deadline).
test_cold_guard_hang_ends_within_the_cold_deadline_plus_engine_budget() {
  cg_setup 2000
  ok=1
  eng_ms=560
  slack_ms=800
  bound=$((2000 + slack_ms))
  cg_run PreToolUse sess-a AH_HOOK_TIMEOUT_MS=$eng_ms AH_COLD_HANG_KICK=1 AH_COLD_HANG_ALL=1
  [ "$cg_rc" -eq 0 ] && [ "$cg_ms" -lt "$bound" ] || { ok=0; printf 'kick hang: rc=%s ms=%s bound=%s\n' "$cg_rc" "$cg_ms" "$bound" >&2; }
  grep -q 'was not checked' "$cg_dir/err" || { ok=0; printf 'kick hang: no cold-start notice: %s\n' "$(cat "$cg_dir/err")" >&2; }
  # the hung kick is the only engine call: no real attempt follows it
  [ "$(wc -l <"$cg_log" | tr -d ' ')" -eq 1 ] || { ok=0; printf 'kick hang: engine calls: %s\n' "$(cat "$cg_log")" >&2; }
  printf 'TIMING cold kick hang wall_ms=%s bound=%s\n' "$cg_ms" "$bound" >&2
  cg_cleanup
  [ "$ok" -eq 1 ]
}

test_cold_non_guard_event_never_waits() {
  cg_setup 2000
  cg_run UserPromptSubmit sess-a
  ok=1
  [ "$cg_rc" -eq 0 ] || ok=0
  # no kick and one plain engine call: the cold daemon costs a prompt nothing
  ! grep -q ColdStartKick "$cg_log" || ok=0
  [ "$(wc -l <"$cg_log" | tr -d ' ')" -eq 1 ] || ok=0
  [ ! -s "$cg_dir/err" ] || ok=0
  [ "$ok" -eq 1 ] || printf 'cold prompt: rc=%s ms=%s err=%s log=%s\n' "$cg_rc" "$cg_ms" "$(cat "$cg_dir/err")" "$(cat "$cg_log")" >&2
  cg_cleanup
  [ "$ok" -eq 1 ]
}

test_cold_guard_wait_respects_the_hook_budget_and_a_warm_daemon() {
  cg_setup 2000
  ok=1
  # a hook budget that leaves no room after the engine attempt: no wait, no kick
  printf '@PreToolUse\t1\n*\t1\ttrue\n' >"$cg_dir/list"
  cg_run PreToolUse sess-a AH_HOOK_TIMEOUT_MS=900
  [ "$cg_rc" -eq 0 ] && ! grep -q ColdStartKick "$cg_log" || ok=0
  # a warm daemon (socket already bound): straight to the engine, no kick
  : >"$cg_log"
  printf '@PreToolUse\t10\n*\t10\ttrue\n' >"$cg_dir/list"
  # a daemon that LISTENS (the launcher tells a live socket from a stale socket file by connecting to it)
  perl -MIO::Socket::UNIX -e '$s = IO::Socket::UNIX->new(Local => $ARGV[0], Listen => 5) or exit 1; sleep 60' "$cg_state/e.sock" &
  cg_listener=$!
  n=0
  while [ ! -S "$cg_state/e.sock" ] && [ "$n" -lt 100 ]; do sleep 0.05; n=$((n + 1)); done
  cg_run PreToolUse sess-a
  kill "$cg_listener" 2>/dev/null || true
  wait "$cg_listener" 2>/dev/null || true
  [ "$cg_rc" -eq 2 ] && ! grep -q ColdStartKick "$cg_log" || ok=0
  # the wait is off at 0
  rm -f "$cg_state/e.sock"
  : >"$cg_log"
  sed "/^\[client.cold_guard_wait_ms\]/,/^\$/s/^value = .*/value = 0/" "$repo/plugins/anti-hall/engine/defaults/engine.toml" >"$cg_root/engine/defaults/engine.toml"
  cg_run PreToolUse sess-a
  [ "$cg_rc" -eq 0 ] && ! grep -q ColdStartKick "$cg_log" || ok=0
  [ "$ok" -eq 1 ] || printf 'cold guard budget: rc=%s log=%s\n' "$cg_rc" "$(cat "$cg_log")" >&2
  cg_cleanup
  [ "$ok" -eq 1 ]
}

# The wait is only for a daemon that can actually start: spawning switched off, an engine that is missing or cannot run, and one
# that exits at once (its kick fails) all fail open straight away, not after the 2 s cap.
test_cold_guard_does_not_wait_when_no_daemon_can_start() {
  cg_setup 2000
  ok=1
  # spawn disabled: no kick at all
  cg_run PreToolUse sess-a AH_ENGINE_NOSPAWN=1
  [ "$cg_rc" -eq 0 ] && [ "$cg_ms" -lt 1000 ] && ! grep -q ColdStartKick "$cg_log" || { ok=0; printf 'nospawn: rc=%s ms=%s\n' "$cg_rc" "$cg_ms" >&2; }
  # a missing engine binary
  cg_run PreToolUse sess-b AH_ENGINE_BIN="$cg_dir/no-such-engine"
  [ "$cg_rc" -eq 0 ] && [ "$cg_ms" -lt 1000 ] || { ok=0; printf 'missing: rc=%s ms=%s\n' "$cg_rc" "$cg_ms" >&2; }
  # an engine that cannot run (not executable)
  printf '#!/bin/sh\nexit 0\n' >"$cg_dir/noexec"
  chmod 644 "$cg_dir/noexec"
  cg_run PreToolUse sess-c AH_ENGINE_BIN="$cg_dir/noexec"
  [ "$cg_rc" -eq 0 ] && [ "$cg_ms" -lt 1000 ] || { ok=0; printf 'noexec: rc=%s ms=%s\n' "$cg_rc" "$cg_ms" >&2; }
  # an engine that exits at once: its kick fails, so nothing is coming
  printf '#!/bin/sh\ncat >/dev/null\nprintf "%%s\\n" "$*" >>"$AH_COLD_LOG"\nexit 1\n' >"$cg_dir/crash.sh"
  chmod +x "$cg_dir/crash.sh"
  : >"$cg_log"
  cg_run PreToolUse sess-d AH_ENGINE_BIN="$cg_dir/crash.sh"
  [ "$cg_rc" -eq 0 ] && [ "$cg_ms" -lt 1000 ] && grep -q ColdStartKick "$cg_log" || { ok=0; printf 'crash: rc=%s ms=%s log=%s\n' "$cg_rc" "$cg_ms" "$(cat "$cg_log")" >&2; }
  cg_cleanup
  [ "$ok" -eq 1 ]
}

# Codex final N1: the watchdog's slow-window bound is the EFFECTIVE client.slow_fallback_max_ms (env override included), as the
# engine client computes it. A stand-in that marks itself as waiting on the daemon (the wait file) and denies after 3500 ms is
# killed at the shipped 3000 ms bound (fail open, rc 0) but must block once the override raises the bound past the deny.
sw_setup() {
  cg_setup 0
  cat >"$cg_dir/slowdeny.sh" <<'ENG'
#!/bin/sh
cat >/dev/null
[ -z "${AH_ENGINE_WAIT_FILE:-}" ] || : >"$AH_ENGINE_WAIT_FILE"
sleep 3.5
printf 'denied-after-wait\n' >&2
exit 2
ENG
  chmod +x "$cg_dir/slowdeny.sh"
}

test_slow_window_bound_honours_the_env_override() {
  sw_setup
  ok=1
  # shipped bound (3000 ms): the late deny is outside the window, the call fails open
  cg_run PreToolUse sess-a AH_ENGINE_BIN="$cg_dir/slowdeny.sh" AH_HOOK_TIMEOUT_MS=500
  [ "$cg_rc" -eq 0 ] || { ok=0; printf 'slow control: rc=%s ms=%s\n' "$cg_rc" "$cg_ms" >&2; }
  # raised bound: the deny at 3500 ms is inside the effective window and must block
  cg_run PreToolUse sess-a AH_ENGINE_BIN="$cg_dir/slowdeny.sh" AH_HOOK_TIMEOUT_MS=500 AH_ENGINE_SLOW_FALLBACK_MAX_MS=6000
  [ "$cg_rc" -eq 2 ] && grep -q denied-after-wait "$cg_dir/err" || { ok=0; printf 'slow raised: rc=%s ms=%s err=%s\n' "$cg_rc" "$cg_ms" "$(cat "$cg_dir/err")" >&2; }
  # an unusable override keeps the shipped bound, as the engine does (defaults::num falls back to the default)
  cg_run PreToolUse sess-a AH_ENGINE_BIN="$cg_dir/slowdeny.sh" AH_HOOK_TIMEOUT_MS=500 AH_ENGINE_SLOW_FALLBACK_MAX_MS=junk
  [ "$cg_rc" -eq 0 ] || { ok=0; printf 'slow junk: rc=%s ms=%s\n' "$cg_rc" "$cg_ms" >&2; }
  cg_cleanup
  [ "$ok" -eq 1 ]
}
check slow_window_bound_honours_the_env_override test_slow_window_bound_honours_the_env_override

check cold_guard_waits_for_a_daemon_that_comes_up test_cold_guard_waits_for_a_daemon_that_comes_up
check cold_guard_does_not_wait_when_no_daemon_can_start test_cold_guard_does_not_wait_when_no_daemon_can_start
check cold_guard_gives_up_at_the_cap_with_one_notice_per_session test_cold_guard_gives_up_at_the_cap_with_one_notice_per_session
check cold_guard_hang_ends_within_the_cold_deadline_plus_engine_budget test_cold_guard_hang_ends_within_the_cold_deadline_plus_engine_budget
check cold_non_guard_event_never_waits test_cold_non_guard_event_never_waits
check cold_guard_wait_respects_the_hook_budget_and_a_warm_daemon test_cold_guard_wait_respects_the_hook_budget_and_a_warm_daemon

# The seconds override is a test knob: without AH_WRAPPER_TEST=1 it is dropped and the shipped 560 ms engine budget still applies.
test_timeout_override_needs_the_test_gate() {
  tg=$tmp/tgate-bin
  mkdir -p "$tg"
  printf '#!/bin/sh\ncat >/dev/null; sleep 3; exit 2\n' >"$tg/ah-engine"
  chmod +x "$tg/ah-engine"
  set +e
  AH_WRAPPER_TEST= AH_HOOK_TIMEOUT_S=10 PATH="$tg:$PATH" sh "$wrapper" PreToolUse <"$payload" >"$tmp/tgate.out" 2>"$tmp/tgate.err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || return 1
  # with the gate the same override lets the engine finish and its exit 2 through
  set +e
  AH_HOOK_TIMEOUT_S=10 PATH="$tg:$PATH" sh "$wrapper" PreToolUse <"$payload" >"$tmp/tgate2.out" 2>"$tmp/tgate2.err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ]
}
check timeout_override_needs_the_test_gate test_timeout_override_needs_the_test_gate

# ---- the direct form: the command hooks.json runs (hooks_form.template), tried as the host runs it (`sh -c <command>`) ----------------
# The plugin ships no wrapper: the command runs the installed thin client with exec (so its exit code, a block's 2 included, is the
# hook's), or, while it is missing, hooks/install.sh (one stderr notice, empty stdout, exit 0, nothing downloaded without opt-in).
hook_command_of() { # hook_command_of FILE EVENT: the event's command, JSON-unescaped (the file is the generator's pretty form)
  awk -v ev="\"$2\": [" 'index($0, ev) { f = 1 } f && /"command":/ { sub(/^[^:]*: "/, ""); sub(/",?$/, ""); gsub(/\\"/, "\""); print; exit }' "$1"
}

test_direct_form_execs_the_installed_client_and_keeps_its_exit_code() {
  dh=$tmp/df-home
  mkdir -p "$dh/.anti-hall/ah-engine/bin"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >"%s/df.args"\ncat >/dev/null\nexit 2\n' "$tmp" >"$dh/.anti-hall/ah-engine/bin/ah-hook"
  chmod +x "$dh/.anti-hall/ah-engine/bin/ah-hook"
  cmd=$(hook_command_of "$repo/plugins/anti-hall/hooks/hooks.json" PreToolUse) || return 1
  set +e
  HOME=$dh CLAUDE_PLUGIN_ROOT=$repo/plugins/anti-hall sh -c "$cmd" <"$payload" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || return 1
  [ "$(cat "$tmp/df.args")" = "PreToolUse" ] || return 1
  # Codex: the host argument follows the event
  cmd=$(hook_command_of "$repo/plugins/anti-hall/codex/hooks/hooks.json" PreToolUse) || return 1
  set +e
  HOME=$dh PLUGIN_ROOT=$repo/plugins/anti-hall sh -c "$cmd" <"$payload" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 2 ] && [ "$(cat "$tmp/df.args")" = "PreToolUse --host codex" ]
}
check direct_form_execs_the_installed_client_and_keeps_its_exit_code test_direct_form_execs_the_installed_client_and_keeps_its_exit_code

test_direct_form_without_the_client_runs_the_installer_once_and_fails_open() {
  dh=$tmp/df-none
  mkdir -p "$dh"
  cmd=$(hook_command_of "$repo/plugins/anti-hall/hooks/hooks.json" PreToolUse) || return 1
  for n in 1 2; do
    set +e
    HOME=$dh CLAUDE_PLUGIN_ROOT=$repo/plugins/anti-hall AH_WRAPPER_TEST=1 sh -c "$cmd" <"$payload" >"$tmp/df.out" 2>"$tmp/df.err"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || return 1
    [ ! -s "$tmp/df.out" ] || return 1
    if [ "$n" -eq 1 ]; then [ "$(wc -l <"$tmp/df.err" | tr -d ' ')" -eq 1 ] || return 1; else [ ! -s "$tmp/df.err" ] || return 1; fi
  done
  # nothing was downloaded or installed
  [ ! -e "$dh/.anti-hall/ah-engine/bin/ah-hook" ]
}
check direct_form_without_the_client_runs_the_installer_once_and_fails_open test_direct_form_without_the_client_runs_the_installer_once_and_fails_open

printf 'wrapper tests: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

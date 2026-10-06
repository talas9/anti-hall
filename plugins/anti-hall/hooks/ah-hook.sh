#!/bin/sh
event=$1
shift 1 2>/dev/null || true
tool_from_payload=0
if [ "${1:-}" = "--tool-from-payload" ]; then
  tool_from_payload=1
fi

dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
list=${AH_FALLBACK_LIST:-"$dir/ah-fallback.list"}
fallback_map=${AH_FALLBACK_MAP:-"$dir/ah-fallback.map.json"}
tmp=${TMPDIR:-/tmp}/ah-hook.$$
payload=$tmp/payload
mkdir -p "$tmp" || exit 2
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
cat >"$payload"
case "${AH_KILL_GRACE_S:-1}" in
  0|1|2|3|4|5) kill_grace=${AH_KILL_GRACE_S:-1} ;;
  *) kill_grace=1 ;;
esac

guard_event=0
case "$event" in
  PreToolUse|PermissionRequest|Stop|SubagentStop) guard_event=1 ;;
esac

tool=
if [ "$tool_from_payload" -eq 1 ]; then
  tool=$(sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$payload" | sed -n '1p')
fi

engine=
if [ -n "${AH_ENGINE_BIN:-}" ] && [ -x "$AH_ENGINE_BIN" ]; then
  engine=$AH_ENGINE_BIN
elif [ -x "$HOME/.anti-hall/ah-engine/bin/ah-engine" ]; then
  engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
else
  engine=$(command -v ah-engine 2>/dev/null || true)
fi

fail_closed() {
  printf 'anti-hall: fail closed for %s: %s\n' "$event" "$1" >&2
  exit 2
}

fallback_note() {
  printf 'anti-hall: engine fallback for %s: %s\n' "$event" "$1" >&2
}

event_timeout() {
  awk -F '	' -v ev="$event" '$1 == "@" ev { print $2; found = 1; exit } END { if (!found) print "" }' "$list" 2>/dev/null
}

matches_tool() {
  matcher=$1
  case "$matcher" in
    ""|"*") return 0 ;;
  esac
  if [ -z "$tool" ]; then
    [ "$guard_event" -eq 1 ] && return 0
    return 1
  fi
  if printf '%s\n' "$matcher" | grep -Eq '^[A-Za-z0-9_ ,|-]+$'; then
    old_ifs=$IFS
    IFS='|,'
    set -- $matcher
    IFS=$old_ifs
    for name do
      name=$(printf '%s\n' "$name" | sed 's/^ *//; s/ *$//')
      [ "$name" = "$tool" ] && return 0
    done
    return 1
  fi
  awk -v s="$tool" -v r="$matcher" 'BEGIN { exit !(s ~ r) }'
}

collect_descendants() {
  root_pid=$1
  seen=$tmp/kill.seen.$root_pid.$$
  new=$tmp/kill.new.$root_pid.$$
  desc=$tmp/kill.desc.$root_pid.$$
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

kill_process_tree() {
  root_pid=$1
  descendants=$(collect_descendants "$root_pid")
  leaf_first=$(printf '%s\n' "$descendants" | awk 'NF { p[NR] = $1 } END { for (i = NR; i >= 1; i--) print p[i] }')
  for child_pid in $leaf_first "$root_pid"; do
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  sleep "$kill_grace"
  for child_pid in $leaf_first "$root_pid"; do
    kill -KILL "$child_pid" 2>/dev/null || true
  done
}

terminate_process_group() {
  root_pid=$1
  group_pid=$2
  if [ "$group_pid" -eq 1 ]; then
    kill -TERM "-$root_pid" 2>/dev/null || true
  fi
  kill_process_tree "$root_pid"
  if [ "$group_pid" -eq 1 ]; then
    kill -KILL "-$root_pid" 2>/dev/null || true
  fi
}

launch_shell_group() {
  cmd=$1
  out=$2
  err=$3
  pid_file=$4
  group_file=$5
  if command -v setsid >/dev/null 2>&1; then
    setsid sh -c "$cmd" <"$payload" >"$out" 2>"$err" &
    printf '%s\n' "$!" >"$pid_file"
    printf '1\n' >"$group_file"
    return
  fi
  if ( set -m ) 2>/dev/null; then
    set -m 2>/dev/null || true
    sh -c "$cmd" <"$payload" >"$out" 2>"$err" &
    printf '%s\n' "$!" >"$pid_file"
    printf '1\n' >"$group_file"
    set +m 2>/dev/null || true
    return
  fi
  sh -c "$cmd" <"$payload" >"$out" 2>"$err" &
  printf '%s\n' "$!" >"$pid_file"
  printf '0\n' >"$group_file"
}

launch_argv_group() {
  out=$1
  err=$2
  pid_file=$3
  group_file=$4
  shift 4
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" <"$payload" >"$out" 2>"$err" &
    printf '%s\n' "$!" >"$pid_file"
    printf '1\n' >"$group_file"
    return
  fi
  if ( set -m ) 2>/dev/null; then
    set -m 2>/dev/null || true
    "$@" <"$payload" >"$out" 2>"$err" &
    printf '%s\n' "$!" >"$pid_file"
    printf '1\n' >"$group_file"
    set +m 2>/dev/null || true
    return
  fi
  "$@" <"$payload" >"$out" 2>"$err" &
  printf '%s\n' "$!" >"$pid_file"
  printf '0\n' >"$group_file"
}

run_hook_command() {
  cmd=$1
  timeout=$2
  out=$3
  err=$4
  timed=$5
  : >"$out"
  : >"$err"
  rm -f "$timed"
  pid_file=$tmp/hook.pid.$$
  group_file=$tmp/hook.group.$$
  launch_shell_group "$cmd" "$out" "$err" "$pid_file" "$group_file"
  pid=$(cat "$pid_file")
  group_pid=$(cat "$group_file")
  rm -f "$pid_file" "$group_file"
  ( trap - EXIT HUP INT TERM; sleep "$timeout"; : >"$timed"; terminate_process_group "$pid" "$group_pid" ) &
  watch=$!
  wait "$pid" 2>/dev/null
  wait_rc=$?
  kill "$watch" 2>/dev/null || true
  wait "$watch" 2>/dev/null || true
  if [ -f "$timed" ]; then
    return 124
  fi
  return "$wait_rc"
}

run_fallback() {
  reason=$1
  if [ ! -r "$list" ]; then
    [ "$guard_event" -eq 1 ] && fail_closed "no fallback list"
    fallback_note "$reason"
    exit 0
  fi
  selected=0
  ran=0
  noted=0
  first_block_err=
  code=0
  in_event=0
  timeout_default=$(event_timeout)
  [ -n "$timeout_default" ] || timeout_default=${AH_HOOK_TIMEOUT_S:-10}
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|"#"*) continue ;;
      @*)
        header=${line#@}
        ev=${header%%	*}
        [ "$ev" = "$event" ] && in_event=1 || in_event=0
        continue
        ;;
    esac
    [ "$in_event" -eq 1 ] || continue
    matcher=${line%%	*}
    rest=${line#*	}
    if [ "$rest" = "$line" ]; then
      continue
    fi
    field2=${rest%%	*}
    if [ "$field2" = "$rest" ]; then
      hook_timeout=$timeout_default
      cmd=$field2
    else
      hook_timeout=$field2
      cmd=${rest#*	}
    fi
    matches_tool "$matcher" || continue
    selected=$((selected + 1))
    out=$tmp/fb.out.$selected
    err=$tmp/fb.err.$selected
    timed=$tmp/fb.timed.$selected
    run_hook_command "$cmd" "$hook_timeout" "$out" "$err" "$timed"
    rc=$?
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ] || [ "$rc" -gt 128 ]; then
      continue
    fi
    if [ "$noted" -eq 0 ]; then
      fallback_note "$reason"
      noted=1
    fi
    ran=1
    cat "$out"
    if [ "$rc" -eq 2 ] && [ "$code" -ne 2 ]; then
      code=2
      first_block_err=$err
    fi
  done <"$list"
  if [ "$code" -eq 2 ]; then
    [ -n "$first_block_err" ] && cat "$first_block_err" >&2
    exit 2
  fi
  if [ "$ran" -eq 0 ] && [ "$guard_event" -eq 1 ]; then
    if [ "$selected" -eq 0 ]; then
      fail_closed "no matching fallback hooks"
    fi
    fail_closed "fallback hooks did not run"
  fi
  if [ "$noted" -eq 0 ]; then
    fallback_note "$reason"
  fi
  exit 0
}

if [ -n "$engine" ]; then
  eng_out=$tmp/engine.out
  eng_err=$tmp/engine.err
  eng_timed=$tmp/engine.timed
  timeout=$(event_timeout)
  [ -n "$timeout" ] || timeout=${AH_HOOK_TIMEOUT_S:-10}
  set -- "$engine" hook --event "$event"
  [ -n "$tool" ] && set -- "$@" --tool "$tool"
  set -- "$@" --host claude --fallback-map "$fallback_map"
  pid_file=$tmp/engine.pid
  group_file=$tmp/engine.group
  launch_argv_group "$eng_out" "$eng_err" "$pid_file" "$group_file" "$@"
  pid=$(cat "$pid_file")
  group_pid=$(cat "$group_file")
  rm -f "$pid_file" "$group_file"
  ( trap - EXIT HUP INT TERM; sleep "$timeout"; : >"$eng_timed"; terminate_process_group "$pid" "$group_pid" ) &
  watch=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watch" 2>/dev/null || true
  wait "$watch" 2>/dev/null || true
  if [ -f "$eng_timed" ]; then
    run_fallback "engine timed out"
  fi
  if [ "$rc" -eq 75 ]; then
    run_fallback "engine requested fallback"
  fi
  if [ "$rc" -gt 128 ]; then
    run_fallback "engine died"
  fi
  cat "$eng_out"
  cat "$eng_err" >&2
  exit "$rc"
fi

run_fallback "engine missing"

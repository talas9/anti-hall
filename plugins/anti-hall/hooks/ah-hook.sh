#!/bin/sh
# Reliability wrapper for `ah-engine hook --event <Event>`.
#
# Dispatcher-equivalent fallback outcome table (D74 / dispatch::node):
# - engine exit 0: exact answer, pass stdout/stderr and exit 0.
# - engine exit 2: exact block, pass stdout/stderr and exit 2.
# - any other engine exit after it marked the dispatch done (AH_ENGINE_DONE_FILE): a hook's own exit code (a non-blocking error),
#   passed through with its stdout/stderr; without the mark it is an engine failure and the Node fallback below runs.
# - engine exit 75 (`dispatch.defer_exit`): run this event's Node hooks one by one.
# - engine timeout, signal death, spawn failure, or any other exit: run Node fallback with a one-line note.
# - Node hook exit 2: block; stdout from every ran hook is kept, stderr from the first exit-2 hook wins.
# - Node hook exit 0, 1, 3, 126, 127 or any other normal non-2 exit: host semantics, non-blocking.
# - Node hook timeout: host discards that hook; other hooks still decide the event.
# - Node hook signal death, spawn failure, known-unrunnable command, or incomplete output:
#   fail closed on guard events, ignored on non-guards.
# Arguments: the event, then optionally `--host claude|codex` (default claude: picks the host's table in the engine and its
# fallback list and map) and `--tool-from-payload` (implied on PreToolUse, PostToolUse, PostToolUseFailure and PermissionRequest).
# Tool selection is payload-only: the tool argument is --tool-from-payload, which reads tool_name structurally from
# stdin. There is no --tool X: a caller-named tool could narrow the rows run and skip a guard the payload would select.
# Any other argument is ignored (without --tool-from-payload every row of the event runs, the safe superset).
# Test-only knobs (honored ONLY when AH_WRAPPER_TEST=1 is also set; otherwise ignored with a one-line
# stderr note): AH_ENGINE_BIN, AH_FALLBACK_LIST, AH_FALLBACK_MAP, AH_HOOK_TIMEOUT_S, AH_KILL_GRACE_S,
# AH_HOOK_SWEEP_AGE_S. The engine is otherwise located only at $HOME/.anti-hall/ah-engine/bin/ah-engine
# or on PATH. Honored values are validated so bad values cannot turn a guard into a silent allow.

event=$1
shift 1 2>/dev/null || true

# The test-only knobs are honored only when AH_WRAPPER_TEST=1 is also set (the test suite exports it).
# A stray AH_ENGINE_BIN=/usr/bin/true in a user's shell must not turn the safety net into a silent allow.
if [ "${AH_WRAPPER_TEST:-}" != 1 ]; then
  ignored_knobs=
  for knob in AH_ENGINE_BIN AH_FALLBACK_LIST AH_FALLBACK_MAP AH_HOOK_TIMEOUT_S AH_KILL_GRACE_S AH_HOOK_SWEEP_AGE_S; do
    eval "knob_val=\${$knob:-}"
    if [ -n "$knob_val" ]; then
      ignored_knobs="$ignored_knobs $knob"
    fi
    unset "$knob"
  done
  if [ -n "$ignored_knobs" ]; then
    printf 'anti-hall: ignoring test-only variables (need AH_WRAPPER_TEST=1):%s\n' "$ignored_knobs" >&2
  fi
fi
# D87: the hooks.json of each host runs this wrapper once per event, `ah-hook.sh <Event> [--host codex]`, and the engine (or,
# when it cannot answer, the fallback list) decides which hooks apply. On the events whose hooks are matched by tool name
# the tool is read from the payload structurally, as if --tool-from-payload had been given, so a hook the payload's tool
# does not select is not run by the fallback either; any other event has no matcher the wrapper could read.
tool_from_payload=0
case "$event" in
  PreToolUse|PostToolUse|PostToolUseFailure|PermissionRequest) tool_from_payload=1 ;;
esac
host=claude
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tool-from-payload) tool_from_payload=1 ;;
    --host)
      case "${2:-}" in
        claude|codex) host=$2; shift ;;
        *) printf 'anti-hall: ignoring unknown --host value\n' >&2 ;;
      esac
      ;;
  esac
  shift
done

dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# The engine reads its settings, tables, messages and rules from THIS plugin's engine/ directory at run time (nothing is compiled
# into the binary), so it must be told which plugin is running: the one this wrapper lives in. An explicit
# AH_ENGINE_PLUGIN_ROOT (an operator override) wins.
if [ -z "${AH_ENGINE_PLUGIN_ROOT:-}" ] && [ -f "$dir/../engine/defaults/index.toml" ]; then
  AH_ENGINE_PLUGIN_ROOT=$(CDPATH= cd -- "$dir/.." && pwd)
  export AH_ENGINE_PLUGIN_ROOT
fi
case "$host" in
  codex) list_default=$dir/ah-fallback.codex.list; map_default=$dir/ah-fallback.codex.map.json ;;
  *) list_default=$dir/ah-fallback.list; map_default=$dir/ah-fallback.map.json ;;
esac
list=${AH_FALLBACK_LIST:-"$list_default"}
fallback_map=${AH_FALLBACK_MAP:-"$map_default"}
uid=$(id -u 2>/dev/null || printf '0')
self_pid=$$
tmp=
payload=
children=

guard_event=0
case "$event" in
  PreToolUse|PermissionRequest|Stop|SubagentStop) guard_event=1 ;;
esac

cleanup() {
  trap - 0 HUP INT TERM
  for p in $children; do
    terminate_process_group "$p" 1 2>/dev/null || true
  done
  if [ -n "$tmp" ] && [ -d "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup' 0

fail_closed() {
  if is_stop_active_payload 2>/dev/null; then
    printf 'anti-hall: fail open for %s because stop_hook_active is true: %s\n' "$event" "$1" >&2
    exit 0
  fi
  printf 'anti-hall: fail closed for %s: %s\n' "$event" "$1" >&2
  exit 2
}

fallback_note() {
  printf 'anti-hall: engine fallback for %s: %s\n' "$event" "$1" >&2
}

validate_positive_int() {
  value=$1
  name=$2
  case "$value" in
    ""|*[!0-9]*|0)
      [ "$guard_event" -eq 1 ] && fail_closed "$name must be a positive integer"
      printf 'anti-hall: %s must be a positive integer; skipping non-guard hook\n' "$name" >&2
      exit 0
      ;;
  esac
}

case "${AH_KILL_GRACE_S:-1}" in
  0|1|2|3|4|5) kill_grace=${AH_KILL_GRACE_S:-1} ;;
  *) kill_grace=1 ;;
esac

timeout_env=${AH_HOOK_TIMEOUT_S:-10}
validate_positive_int "$timeout_env" AH_HOOK_TIMEOUT_S
sweep_age=${AH_HOOK_SWEEP_AGE_S:-1800}
validate_positive_int "$sweep_age" AH_HOOK_SWEEP_AGE_S

stat_pair() {
  p=$1
  if stat -f '%u %Mp%Lp' "$p" 2>/dev/null; then
    return 0
  fi
  stat -c '%u %a' "$p" 2>/dev/null
}

stat_mtime() {
  p=$1
  if stat -f '%m' "$p" 2>/dev/null; then
    return 0
  fi
  stat -c '%Y' "$p" 2>/dev/null
}

# Verify and create a private directory: final component not a symlink, owned by us, mode 700.
# $1 = physical parent (already canonical), $2 = final component name.
private_dir_in() {
  pd_parent=$1
  pd_base=$pd_parent/$2
  [ ! -L "$pd_base" ] || return 1
  old_umask=$(umask)
  umask 077
  mkdir -p -m 700 "$pd_base" 2>/dev/null || {
    umask "$old_umask"
    return 1
  }
  umask "$old_umask"
  [ -d "$pd_base" ] && [ ! -L "$pd_base" ] || return 1
  set -- $(stat_pair "$pd_base") || return 1
  [ "${1:-}" = "$uid" ] || return 1
  pd_mode=${2:-}
  [ "$pd_mode" = 700 ] || [ "$pd_mode" = 0700 ] || return 1
  printf '%s\n' "$pd_base"
}

# A shared parent (XDG dir, TMPDIR, /tmp): canonicalise it physically (macOS /tmp is a symlink), then
# refuse a world-writable parent unless it has the sticky bit.
shared_parent_ok() {
  sp_parent=$1
  set -- $(stat_pair "$sp_parent") || return 1
  sp_mode=${2:-}
  case "$sp_mode" in
    *[2367]) ;;
    *) return 0 ;;
  esac
  [ "${#sp_mode}" -eq 4 ] || return 1
  case "$sp_mode" in
    [1357]*) return 0 ;;
  esac
  return 1
}

private_tmp_base() {
  # 1. XDG_RUNTIME_DIR (per-user, private by definition)
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ]; then
    cand=$(CDPATH= cd -- "$XDG_RUNTIME_DIR" 2>/dev/null && pwd -P) || cand=
    if [ -n "$cand" ] && shared_parent_ok "$cand"; then
      private_dir_in "$cand" "ah-hook-$uid" && return 0
    fi
  fi
  # 2. $HOME/.anti-hall/tmp (our own tree, never shared)
  case "${HOME:-}" in
    /*)
      old_umask=$(umask)
      umask 077
      mkdir -p -m 700 "$HOME/.anti-hall" 2>/dev/null || true
      umask "$old_umask"
      cand=$(CDPATH= cd -- "$HOME/.anti-hall" 2>/dev/null && pwd -P) || cand=
      if [ -n "$cand" ]; then
        set -- $(stat_pair "$cand") || set --
        if [ "${1:-}" = "$uid" ]; then
          private_dir_in "$cand" tmp && return 0
        fi
      fi
      ;;
  esac
  # 3. TMPDIR or /tmp: shared parent, so check it carefully
  parent=${TMPDIR:-/tmp}
  cand=$(CDPATH= cd -- "$parent" 2>/dev/null && pwd -P) || return 1
  shared_parent_ok "$cand" || return 1
  private_dir_in "$cand" "ah-hook-$uid"
}

# Remove stale run dirs: older than AH_HOOK_SWEEP_AGE_S, or (name carries the owner pid) whose owning
# wrapper is gone, e.g. SIGKILLed before it could clean up. Bounded: at most 200 dirs are examined.
sweep_old_runs() {
  base=$1
  now=$(date +%s)
  seen_dirs=0
  for d in "$base"/ah-wrapper-run.*; do
    [ -d "$d" ] || continue
    [ ! -L "$d" ] || continue
    seen_dirs=$((seen_dirs + 1))
    [ "$seen_dirs" -le 200 ] || break
    set -- $(stat_pair "$d") || continue
    [ "${1:-}" = "$uid" ] || continue
    owner=${d##*/ah-wrapper-run.}
    owner=${owner%%.*}
    case "$owner" in
      ""|*[!0-9]*) ;;
      *)
        if [ "$owner" != "$self_pid" ] && ! kill -0 "$owner" 2>/dev/null; then
          rm -rf "$d"
          continue
        fi
        ;;
    esac
    mt=$(stat_mtime "$d" 2>/dev/null || printf '')
    case "$mt" in ""|*[!0-9]*) continue ;; esac
    age=$((now - mt))
    if [ "$age" -gt "$sweep_age" ]; then
      rm -rf "$d"
    fi
  done
}

make_payload_file() {
  base=$(private_tmp_base) || return 1
  sweep_old_runs "$base"
  old_umask=$(umask)
  umask 077
  tmp=$(mktemp -d "$base/ah-wrapper-run.$self_pid.XXXXXXXXXX" 2>/dev/null) || {
    umask "$old_umask"
    return 1
  }
  payload=$tmp/payload
  : >"$payload" || {
    umask "$old_umask"
    return 1
  }
  chmod 600 "$payload" 2>/dev/null || true
  cat >"$payload"
  umask "$old_umask"
  return 0
}

if ! make_payload_file; then
  if [ "$guard_event" -eq 1 ]; then
    printf 'anti-hall: cannot create private payload temp file for %s; blocking rather than allowing unguarded\n' "$event" >&2
    exit 2
  fi
  printf 'anti-hall: cannot create private payload temp file for %s; skipping non-guard hook\n' "$event" >&2
  exit 0
fi

json_tool_name() {
  awk '
    function hx(c) { return index("0123456789abcdef", tolower(c)) - 1 }
    function hexnum(h,    i,v,n) { n=0; for(i=1;i<=length(h);i++){ v=hx(substr(h,i,1)); if(v<0) return -1; n=n*16+v } return n }
    function ws(c) { return c==" " || c=="\t" || c=="\r" || c=="\n" }
    function skip_string(    j,k,bs) {
      j=i+1
      while(j<=n) {
        k=index(substr(s,j), "\"")
        if(k==0){ bad=1; i=n+1; return }
        j += k - 1
        bs=0
        while(j-bs-1>=i+1 && substr(s,j-bs-1,1)=="\\") bs++
        if(bs%2==0){ i=j; return }
        j++
      }
      bad=1; i=n+1
    }
    function esc(c,    h,n) {
      if (c=="\"" || c=="\\" || c=="/") return c
      if (c=="b") return "\b"; if (c=="f") return "\f"; if (c=="n") return "\n"; if (c=="r") return "\r"; if (c=="t") return "\t"
      if (c=="u") { h=substr(s,i+1,4); n=hexnum(h); if(length(h)!=4 || n<0){ bad=1; return "" }; i+=4; if(n<128) return sprintf("%c", n); return "?" }
      bad=1; return ""
    }
    { s=s $0 "\n" }
    END {
      sub(/\n$/, "", s); n=length(s); i=1; bad=0
      while(i<=n && ws(substr(s,i,1))) i++
      bom=sprintf("%c%c%c", 239, 187, 191)
      if(substr(s,i,3)==bom) i += 3
      if(substr(s,i,1)!="{"){ print "FAIL"; exit }
      depth=0; expect_key=0; after_key=0; want_value=0; key=""; found=0
      for(; i<=n; i++){
        c=substr(s,i,1)
        if(instr){
          if(back){ str=str esc(c); back=0; continue }
          if(c=="\\"){ back=1; continue }
          if(c=="\""){
            instr=0
            if(depth==1 && expect_key){ key=str; expect_key=0; after_key=1; continue }
            if(depth==1 && want_value){
              if(key=="tool_name"){ if(!found){ val=str; found=1 } else if(val!=str) bad=1 }
              want_value=0; key=""; continue
            }
            continue
          }
          str=str c; continue
        }
        if(ws(c)) continue
        if(c=="\""){
          if(depth==1 && expect_key){ instr=1; str=""; continue }
          if(depth==1 && want_value){
            if(key=="tool_name"){ instr=1; str=""; continue }
            skip_string(); want_value=0; key=""; continue
          }
          skip_string(); continue
        }
        if(c=="{"){ depth++; if(depth==1) expect_key=1; continue }
        if(c=="}"){ depth--; if(depth==0){ i++; break }; if(depth<0) bad=1; continue }
        if(c=="["){ if(depth==1 && want_value && key=="tool_name") bad=1; depth++; continue }
        if(c=="]"){ depth--; if(depth<1) bad=1; continue }
        if(depth==1 && after_key){ if(c!=":"){ bad=1; break }; after_key=0; want_value=1; continue }
        if(depth==1 && want_value){ if(key=="tool_name") bad=1; want_value=0; key="" }
        if(depth==1 && c==","){ expect_key=1; continue }
      }
      while(i<=n && ws(substr(s,i,1))) i++
      if(i<=n || depth!=0 || instr || back || bad || !found) print "FAIL"; else print "OK\t" val
    }
  ' "$payload"
}

is_stop_active_payload() {
  case "$event" in Stop|SubagentStop) ;; *) return 1 ;; esac
  awk '
    function ws(c) { return c==" " || c=="\t" || c=="\r" || c=="\n" }
    function skip_string(    j,k,bs) {
      j=i+1
      while(j<=n) {
        k=index(substr(s,j), "\"")
        if(k==0){ bad=1; i=n+1; return }
        j += k - 1
        bs=0
        while(j-bs-1>=i+1 && substr(s,j-bs-1,1)=="\\") bs++
        if(bs%2==0){ i=j; return }
        j++
      }
      bad=1; i=n+1
    }
    { s=s $0 "\n" }
    END {
      sub(/\n$/, "", s); n=length(s); i=1
      while(i<=n && ws(substr(s,i,1))) i++
      bom=sprintf("%c%c%c", 239, 187, 191)
      if(substr(s,i,3)==bom) i += 3
      if(substr(s,i,1)!="{") exit 1
      depth=0; expect_key=0; after_key=0; want_value=0; key=""
      for(; i<=n; i++){
        c=substr(s,i,1)
        if(instr){
          if(back){ back=0; continue }
          if(c=="\\"){ back=1; continue }
          if(c=="\""){
            instr=0
            if(depth==1 && expect_key){ key=str; expect_key=0; after_key=1; continue }
            if(depth==1 && want_value){ want_value=0; key=""; continue }
          }
          str=str c
          continue
        }
        if(ws(c)) continue
        if(c=="\""){
          if(depth==1 && expect_key){ instr=1; str=""; continue }
          skip_string(); continue
        }
        if(c=="{"){ depth++; if(depth==1) expect_key=1; continue }
        if(c=="}"){ depth--; if(depth==0) break; continue }
        if(c=="[" ){ depth++; continue }
        if(c=="]" ){ depth--; continue }
        if(depth==1 && after_key){ if(c!=":") exit 1; after_key=0; want_value=1; continue }
        if(depth==1 && want_value){
          if(key=="stop_hook_active" && substr(s,i,4)=="true"){ exit 0 }
          want_value=0; key=""
        }
        if(depth==1 && c==","){ expect_key=1; continue }
      }
      exit 1
    }
  ' "$payload"
}

json_blocks_file() {
  awk '
    { s=s $0 "\n" }
    END {
      sub(/\n$/, "", s)
      t=s
      gsub(/^[ \t\r\n]+/, "", t)
      gsub(/[ \t\r\n]+$/, "", t)
      if(substr(t,1,1)!="{" || substr(t,length(t),1)!="}") exit 1
      if(index(t, "\"decision\"") && index(t, "\"block\"")) exit 0
      if(index(t, "\"permissionDecision\"") && index(t, "\"deny\"")) exit 0
      exit 1
    }
  ' "$1"
}

tool=
tool_match_all=0
if [ "$tool_from_payload" -eq 1 ]; then
  extracted=$(json_tool_name 2>/dev/null || printf 'FAIL')
  case "$extracted" in
    OK*) tool=$(printf '%s\n' "$extracted" | sed 's/^OK	//') ;;
    *) tool_match_all=1 ;;
  esac
fi

engine=
if [ -n "${AH_ENGINE_BIN:-}" ]; then
  if [ -x "$AH_ENGINE_BIN" ]; then
    engine=$AH_ENGINE_BIN
  else
    engine=
  fi
elif [ -x "$HOME/.anti-hall/ah-engine/bin/ah-engine" ]; then
  engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
else
  engine=$(command -v ah-engine 2>/dev/null || true)
fi

event_timeout() {
  awk -F '	' -v ev="$event" '$1 == "@" ev { print $2; found = 1; exit } END { if (!found) print "" }' "$list" 2>/dev/null
}

matches_tool() {
  matcher=$1
  [ "$tool_match_all" -eq 1 ] && return 0
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
    # bash-as-sh (macOS) prints "child setpgid: Operation not permitted" from the forked child before its own
    # redirections apply, when parent and child race to create the group (the group still exists; the kill path
    # also walks the process tree). The braces keep that line off the host-visible stderr.
    { sh -c "$cmd" <"$payload" >"$out" 2>"$err" & } 2>/dev/null
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
    { "$@" <"$payload" >"$out" 2>"$err" & } 2>/dev/null
    printf '%s\n' "$!" >"$pid_file"
    printf '1\n' >"$group_file"
    set +m 2>/dev/null || true
    return
  fi
  "$@" <"$payload" >"$out" 2>"$err" &
  printf '%s\n' "$!" >"$pid_file"
  printf '0\n' >"$group_file"
}

remove_child() {
  gone=$1
  children=$(printf '%s\n' "$children" | awk -v p="$gone" '{ for (i=1;i<=NF;i++) if ($i != p) printf "%s%s", sep, $i; print "" }')
}

# Timeout watchdog. It never gets signalled: it polls once a second and leaves when the watched pid is
# gone. (Root cause of the "engine timed out after ~11 s" bug under dash and macOS sh: the old timer was a
# `( sleep N; ... ) &` subshell that the waiter killed. A TERM that lands in the window between the fork and
# the subshell's own `trap -` is swallowed by the parent's inherited handler, the kill is lost, the timer
# sleeps its full timeout, `wait` blocks on it, and a healthy instant engine is then judged timed out.)
# Its stdio is detached so a lingering timer can never hold the host's pipes open.
start_watchdog() {
  w_pid=$1; w_timeout=$2; w_group=$3; w_timed=$4
  (
    trap - 0 HUP INT TERM
    n=0
    while [ "$n" -lt "$w_timeout" ]; do
      sleep 1
      kill -0 "$w_pid" 2>/dev/null || exit 0
      if ! kill -0 "$self_pid" 2>/dev/null; then
        # The wrapper itself is gone (SIGKILL): do not leave the hook running or its payload behind.
        terminate_process_group "$w_pid" "$w_group"
        [ -n "$tmp" ] && rm -rf "$tmp"
        exit 0
      fi
      n=$((n + 1))
    done
    : >"$w_timed"
    terminate_process_group "$w_pid" "$w_group"
  ) </dev/null >/dev/null 2>&1 &
  watch=$!
}

# After the watched pid exited: if the watchdog already fired, let it finish its kill; else just leave it.
settle_watchdog() {
  [ -f "$1" ] && wait "$watch" 2>/dev/null
  return 0
}

run_hook_command() {
  cmd=$1
  timeout=$2
  out=$3
  err=$4
  timed=$5
  validate_positive_int "$timeout" hook_timeout
  : >"$out"; : >"$err"; rm -f "$timed"
  # A row that names ${CLAUDE_PLUGIN_ROOT}/... or ${PLUGIN_ROOT}/... must point at a readable script, or it
  # is unrunnable (node would exit 1, which looks like the hook's own non-blocking failure).
  ref=$(printf '%s\n' "$cmd" | sed -n 's/.*\${\(\(CLAUDE_\)\{0,1\}PLUGIN_ROOT\)}\(\/[^" 	]*\).*/\1 \3/p' | head -n 1)
  if [ -n "$ref" ]; then
    ref_var=${ref%% *}
    ref_rel=${ref#* }
    case "$ref_var" in
      CLAUDE_PLUGIN_ROOT) ref_root=${CLAUDE_PLUGIN_ROOT:-} ;;
      *) ref_root=${PLUGIN_ROOT:-} ;;
    esac
    if [ -z "$ref_root" ]; then
      ref_root=$(CDPATH= cd -- "$dir/.." 2>/dev/null && pwd -P) || return 125
      case "$ref_var" in
        CLAUDE_PLUGIN_ROOT) CLAUDE_PLUGIN_ROOT=$ref_root; export CLAUDE_PLUGIN_ROOT ;;
        *) PLUGIN_ROOT=$ref_root; export PLUGIN_ROOT ;;
      esac
    fi
    if [ ! -f "$ref_root$ref_rel" ] || [ ! -r "$ref_root$ref_rel" ]; then
      printf 'anti-hall: hook script not found: %s%s\n' "$ref_root" "$ref_rel" >&2
      return 125
    fi
  fi
  first_word=${cmd%%[ 	]*}
  case "$first_word" in
    /*)
      if [ ! -e "$first_word" ] || [ ! -x "$first_word" ]; then
        return 125
      fi
      ;;
  esac
  pid_file=$tmp/hook.pid.$$
  group_file=$tmp/hook.group.$$
  launch_shell_group "$cmd" "$out" "$err" "$pid_file" "$group_file" || return 125
  pid=$(cat "$pid_file"); group_pid=$(cat "$group_file")
  children="$children $pid"
  rm -f "$pid_file" "$group_file"
  start_watchdog "$pid" "$timeout" "$group_pid" "$timed"
  wait "$pid" 2>/dev/null
  wait_rc=$?
  settle_watchdog "$timed"
  remove_child "$pid"
  if [ -f "$timed" ]; then
    return 124
  fi
  if [ "$group_pid" -eq 1 ] && kill -0 "-$pid" 2>/dev/null; then
    terminate_process_group "$pid" "$group_pid"
    if [ "$wait_rc" -eq 2 ] || grep -q '"decision"[[:space:]]*:[[:space:]]*"block"\|"permissionDecision"[[:space:]]*:[[:space:]]*"deny"' "$out"; then
      return "$wait_rc"
    fi
    return 125
  fi
  return "$wait_rc"
}

run_fallback() {
  reason=$1
  if [ ! -r "$list" ] || { [ "$guard_event" -eq 1 ] && [ ! -s "$list" ]; }; then
    [ "$guard_event" -eq 1 ] && fail_closed "no fallback list"
    fallback_note "$reason"
    exit 0
  fi
  selected=0; ran=0; first_block_err=; hard_failure=0; code=0; in_event=0; event_seen=0; event_empty=0
  timeout_default=$(event_timeout)
  [ -n "$timeout_default" ] || timeout_default=$timeout_env
  validate_positive_int "$timeout_default" event_timeout
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|"#"*) continue ;;
      @*)
        header=${line#@}; ev=${header%%	*}
        if [ "$ev" = "$event" ]; then
          in_event=1; event_seen=1
          # an event row ending in the word "empty" has no hook of its own: it is only a trigger (D87)
          case "$header" in *"	empty") event_empty=1 ;; esac
        else
          in_event=0
        fi
        continue ;;
    esac
    [ "$in_event" -eq 1 ] || continue
    matcher=${line%%	*}
    rest=${line#*	}
    [ "$rest" != "$line" ] || continue
    field2=${rest%%	*}
    if [ "$field2" = "$rest" ]; then hook_timeout=$timeout_default; cmd=$field2; else hook_timeout=$field2; cmd=${rest#*	}; fi
    matches_tool "$matcher" || continue
    selected=$((selected + 1))
    out=$tmp/fb.out.$selected; err=$tmp/fb.err.$selected; timed=$tmp/fb.timed.$selected
    run_hook_command "$cmd" "$hook_timeout" "$out" "$err" "$timed"
    rc=$?
    # node exits 1 when it cannot load the script or a module: unrunnable, not the hook's own decision.
    if [ "$rc" -eq 1 ] && grep -q "MODULE_NOT_FOUND" "$err" 2>/dev/null && grep -q "Cannot find module" "$err" 2>/dev/null; then
      rc=125
    fi
    case "$rc" in
      124) continue ;;
      125|12[9-9]|13[0-9]|14[0-9]|15[0-9]|16[0-9]|17[0-9]|18[0-9]|19[0-9]|20[0-9]|21[0-9]|22[0-9]|23[0-9]|24[0-9]|25[0-5]) hard_failure=1; continue ;;
    esac
    ran=1
    if [ "$rc" -eq 2 ]; then
      cat "$out"
      cat "$err" >&2
      exit 2
    fi
    if json_blocks_file "$out"; then
      cat "$out"
      cat "$err" >&2
      exit 0
    fi
    cat "$out"
  done <"$list"
  if [ "$code" -eq 2 ]; then
    [ -n "$first_block_err" ] && cat "$first_block_err" >&2
    exit 2
  fi
  if [ "$event_empty" -eq 1 ]; then
    # D87: the table has no hook for this event, so there is nothing to run and nothing to guard: the neutral no-op
    fallback_note "$reason"
    exit 0
  fi
  if [ "$hard_failure" -eq 1 ] && [ "$guard_event" -eq 1 ]; then
    fallback_note "$reason"
    fail_closed "fallback hook failed before producing a complete answer"
  fi
  if [ "$ran" -eq 0 ] && [ "$guard_event" -eq 1 ]; then
    if [ "$selected" -eq 0 ]; then
      # D74: PermissionRequest and SubagentStop are guard events, but hooks.json registers no Node hook for them, so the
      # generated list has no section. Node alone would allow; the section must exist for PreToolUse and Stop (a list
      # missing those means a damaged list, which stays fail-closed).
      case "$event" in
        PermissionRequest|SubagentStop)
          if [ "$event_seen" -eq 0 ]; then
            fallback_note "$reason"
            exit 0
          fi ;;
      esac
      # The tool name was read structurally and no row names it: the host would have run nothing.
      # (a list with no section for the event at all is damaged, whatever the tool: that stays fail-closed)
      if [ "$event_seen" -eq 1 ] && [ "$tool_from_payload" -eq 1 ] && [ "$tool_match_all" -eq 0 ] && [ -n "$tool" ]; then
        fallback_note "$reason"
        exit 0
      fi
      fail_closed "no matching fallback hooks"
    fi
    fail_closed "fallback hooks did not run"
  fi
  fallback_note "$reason"
  exit 0
}

run_engine() {
  eng_out=$tmp/engine.out; eng_err=$tmp/engine.err; eng_timed=$tmp/engine.timed; eng_done=$tmp/engine.done
  rm -f "$eng_done"
  AH_ENGINE_DONE_FILE=$eng_done
  export AH_ENGINE_DONE_FILE
  timeout=$(event_timeout)
  [ -n "$timeout" ] || timeout=$timeout_env
  validate_positive_int "$timeout" engine_timeout
  set -- "$engine" hook --event "$event"
  [ -n "$tool" ] && set -- "$@" --tool "$tool"
  set -- "$@" --host "$host" --fallback-map "$fallback_map"
  pid_file=$tmp/engine.pid; group_file=$tmp/engine.group
  launch_argv_group "$eng_out" "$eng_err" "$pid_file" "$group_file" "$@" || run_fallback "engine could not start"
  pid=$(cat "$pid_file"); group_pid=$(cat "$group_file")
  children="$children $pid"
  rm -f "$pid_file" "$group_file"
  start_watchdog "$pid" "$timeout" "$group_pid" "$eng_timed"
  wait "$pid" 2>/dev/null
  rc=$?
  settle_watchdog "$eng_timed"
  remove_child "$pid"
  if [ -f "$eng_timed" ]; then
    run_fallback "engine timed out"
  fi
  if [ "$group_pid" -eq 1 ] && kill -0 "-$pid" 2>/dev/null; then
    terminate_process_group "$pid" "$group_pid"
    run_fallback "engine left child processes running"
  fi
  case "$rc" in
    0|2) cat "$eng_out"; cat "$eng_err" >&2; exit "$rc" ;;
    75) run_fallback "engine requested fallback" ;;
    *)
      # The engine finished dispatching the event and its exit code is a hook's own (1, 3, ...): the host reads it as a non-blocking
      # hook error with its stderr, exactly as it would from the hook; answering it by running the hooks again would run each twice.
      if [ -e "$eng_done" ]; then
        cat "$eng_out"; cat "$eng_err" >&2; exit "$rc"
      fi
      run_fallback "engine failed with exit $rc" ;;
  esac
}

if [ -n "$engine" ]; then
  run_engine
fi

run_fallback "engine missing"

#!/bin/sh
# install-shadow-remote.sh - install the ah-engine LOG-ONLY shadow with auto-update (macOS, Linux, WSL2).
#
# What it does: builds (or copies) ah-engine into ~/.anti-hall/ah-engine-shadow2/ and wires ONE thin trigger per hook event
# into the user-level Claude Code settings.json (backed up first). The trigger runs the engine's real dispatcher with every
# Node hook mapped to a no-op, appends one line per call to log-calls.ndjson, ALWAYS exits 0, has a hard 3 s bound and never
# prints. It never blocks or changes anything in the session. The shadow keeps itself current from a git branch (default
# `engine-shadow`): at most once per 5 min a detached updater fetches it, builds a changed commit, smoke-tests the new binary
# and swaps it in; any failure keeps the current binary and backs off (5 min doubling, max 1 h). No systemd, no cron.
#
# Usage:
#   sh install-shadow-remote.sh                    install (idempotent)
#   sh install-shadow-remote.sh --bin PATH         install a prebuilt ah-engine instead of building (trusted to match the branch tip)
#   sh install-shadow-remote.sh --status           commit, last update, call counts
#   sh install-shadow-remote.sh --update-now       run the updater now (ignores throttle and backoff)
#   sh install-shadow-remote.sh --rollback         swap back to the previous binary (pins until the branch moves past the rejected commit)
#   sh install-shadow-remote.sh --uninstall [--force]   restore the settings backup, remove the trigger and the binaries (keeps logs)
#   sh install-shadow-remote.sh --detect           print the detected platform and exit
# Options: --repo URL (single source, no HTTPS fallback)  --branch NAME (default engine-shadow)
# Environment: AH_PROC_VERSION (path read for WSL detection, default /proc/version; test knob)
#
# Needs: sh, git, python3 (JSON merge), and for building: cargo (rustup: https://rustup.rs). A first build downloads the pinned
# Rust toolchain and every crate and takes several minutes (about 40 s on a warm macOS cache); updates rebuild incrementally.
# On WSL2 all state stays on the Linux filesystem under $HOME; a $HOME under /mnt/ (DrvFs) is refused.
set -u

REPO_SSH=git@github.com:talas9/anti-hall.git
REPO_HTTPS=https://github.com/talas9/anti-hall.git
BRANCH=engine-shadow
EVENTS="SessionEnd SessionStart PreCompact PostToolUse PreToolUse UserPromptSubmit TaskCreated TaskCompleted SubagentStart Stop PostToolUseFailure Setup UserPromptExpansion PermissionRequest PermissionDenied PostToolBatch Notification MessageDisplay SubagentStop StopFailure TeammateIdle InstructionsLoaded ConfigChange CwdChanged DirectoryAdded FileChanged PostCompact PreModelSwitch PostModelSwitch Elicitation ElicitationResult"
# WorktreeCreate / WorktreeRemove are deliberately NOT triggers: their hook IS the operation, a silent shadow would break worktrees.

ROLLBACK_D=0
die() {
  printf 'install-shadow-remote: refusing: %s\n' "$*" >&2
  [ "$ROLLBACK_D" = 1 ] && [ -n "${D:-}" ] && rm -rf "${D:?}"
  exit 1
}
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- platform
detect_platform() {
  os=$(uname -s 2>/dev/null || echo unknown)
  wsl=
  pv=${AH_PROC_VERSION:-/proc/version}
  if [ -n "${WSL_DISTRO_NAME:-}" ]; then wsl=wsl
  elif [ -r "$pv" ] && tr 'A-Z' 'a-z' < "$pv" 2>/dev/null | grep -q microsoft; then wsl=wsl
  fi
  if [ -n "$wsl" ] && [ -r "$pv" ] && grep -qiE 'wsl2|microsoft-standard' "$pv" 2>/dev/null; then wsl=wsl2; fi
  PLATFORM="$os${wsl:+/$wsl}"
}

case "${1:-}" in
  --detect) detect_platform; say "platform: $PLATFORM"; exit 0 ;;
esac

# ---------------------------------------------------------------- args
MODE=install; BIN=; FORCE=0; REPO=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin) [ "$#" -ge 2 ] || die "--bin needs a path"; BIN=$2; shift ;;
    --repo) [ "$#" -ge 2 ] || die "--repo needs a URL"; REPO=$2; shift ;;
    --branch) [ "$#" -ge 2 ] || die "--branch needs a name"; BRANCH=$2; shift ;;
    --status) MODE=status ;;
    --update-now) MODE=update ;;
    --rollback) MODE=rollback ;;
    --uninstall) MODE=uninstall ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "${HOME:-}" ] || die "HOME is unset"
case "$HOME" in /*) ;; *) die "HOME is not an absolute path" ;; esac
case "$HOME" in /mnt/*) die "HOME ($HOME) is on a Windows drive (DrvFs): Unix sockets and file locks are unreliable there; use a HOME on the Linux filesystem" ;; esac
[ -d "$HOME" ] || die "HOME is not a directory"
detect_platform
D="$HOME/.anti-hall/ah-engine-shadow2"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CFG/settings.json"
MARK="$D/.shadow2-installed"

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/ah-shadow-inst.XXXXXX") || die "cannot create a temp dir"
cleanup_tmp() { [ -n "${TMPD:-}" ] && [ -d "$TMPD" ] && rm -rf "$TMPD"; }
trap cleanup_tmp 0
trap 'cleanup_tmp; exit 130' INT
trap 'cleanup_tmp; exit 143' TERM HUP

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---------------------------------------------------------------- embedded helpers (written to $TMPD, installed to $D)
emit_helpers() {
cat > "$TMPD/jsonedit.py" <<'PYEOF'
import json, os, sys, shutil
MARK = "ah-engine-shadow2/shadow2.sh"
def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)
def ours(g):
    if not isinstance(g, dict) or not isinstance(g.get("hooks"), list):
        return False
    return any(isinstance(h, dict) and MARK in str(h.get("command", "")) for h in g["hooks"])
def count(d):
    hooks = d.get("hooks")
    n = 0
    if isinstance(hooks, dict):
        for ev, groups in hooks.items():
            if isinstance(groups, list):
                n += sum(1 for g in groups if ours(g))
    return n
def write(p, d):
    tmp = p + ".ah-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if os.path.exists(p):
        shutil.copymode(p, tmp)
    os.replace(tmp, p)
op = sys.argv[1]
if op == "check":
    p = sys.argv[2]
    if not os.path.exists(p):
        print("absent 0"); sys.exit(0)
    try:
        d = load(p)
    except Exception as e:
        print("invalid JSON: %s" % e); sys.exit(3)
    if not isinstance(d, dict):
        print("top level is not an object"); sys.exit(3)
    h = d.get("hooks")
    if h is not None and not isinstance(h, dict):
        print("hooks is not an object"); sys.exit(3)
    for ev, g in (h or {}).items():
        if not isinstance(g, list):
            print("hooks.%s is not a list" % ev); sys.exit(3)
    print("ok %d" % count(d))
elif op == "add":
    p, events = sys.argv[2], sys.argv[3].split()
    d = load(p) if os.path.exists(p) else {}
    hooks = d.setdefault("hooks", {})
    for ev in events:
        lst = hooks.setdefault(ev, [])
        if any(ours(g) for g in lst):
            continue
        lst.append({"hooks": [{"type": "command", "command": "$HOME/.anti-hall/ah-engine-shadow2/shadow2.sh " + ev, "timeout": 5}]})
    write(p, d)
elif op == "remove":
    p = sys.argv[2]
    d = load(p)
    hooks = d.get("hooks")
    if isinstance(hooks, dict):
        for ev in list(hooks):
            hooks[ev] = [g for g in hooks[ev] if not ours(g)]
            if not hooks[ev]:
                del hooks[ev]
        if not hooks:
            del d["hooks"]
    write(p, d)
elif op == "noopmap":
    m = load(sys.argv[2])
    out = {ev: {k: "true" for k in v} for ev, v in m.items()}
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2); f.write("\n")
else:
    sys.exit(2)
PYEOF

cat > "$TMPD/shadow2.sh" <<'SHEOF'
#!/bin/sh
# Log-only shadow trigger (one per hook event). Reads the payload on stdin, runs the engine dispatcher with all Node hooks
# mapped to no-ops, appends one line to log-calls.ndjson. Always exits 0, prints nothing, hard 3 s bound.
# Also starts the detached updater at most once per 5 min.
RH="$HOME"
D="$HOME/.anti-hall/ah-engine-shadow2"
[ -x "$D/bin/ah-engine" ] || exit 0
EV="$1"; [ -n "$EV" ] || exit 0
exec 2>/dev/null
IN=$(cat)
INF="$D/state/.in.$$"; ( umask 077; printf '%s' "$IN" > "$INF" ) || exit 0
TOOL=$(printf '%s' "$IN" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
SID=$(printf '%s' "$IN" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
export HOME="$D/home" AH_ENGINE_DIR="$D/state" AH_ENGINE_PLUGIN_ROOT="$D/plugin" CLAUDE_PLUGIN_ROOT="$D/plugin"
unset CLAUDE_CONFIG_DIR AH_ENGINE_FALLBACK
if command -v perl >/dev/null 2>&1; then now_ms() { perl -MTime::HiRes=time -e 'printf "%d",time*1000'; }
else now_ms() { echo $(( $(date +%s) * 1000 )); }; fi
T0=$(now_ms)
OUTF="$D/state/.last-out.$$"; ERRF="$D/state/.last-err.$$"
if [ -n "$TOOL" ]; then
  "$D/bin/ah-engine" hook --event "$EV" --tool "$TOOL" --fallback-map "$D/noop-map.json" >"$OUTF" 2>"$ERRF" <"$INF" &
else
  "$D/bin/ah-engine" hook --event "$EV" --fallback-map "$D/noop-map.json" >"$OUTF" 2>"$ERRF" <"$INF" &
fi
P=$!
( sleep 3; kill "$P" ) >/dev/null 2>&1 &
W=$!
wait "$P"; RC=$?
kill "$W" >/dev/null 2>&1
T1=$(now_ms)
OB=$(wc -c < "$OUTF" | tr -d ' '); EB=$(wc -c < "$ERRF" | tr -d ' ')
BLK=false; [ "$RC" = 2 ] && BLK=true
case "$(head -c 400 "$OUTF")" in *'"decision"'*block*|*permissionDecision*deny*) BLK=true;; esac
ADV=false; [ "$BLK" = false ] && [ "$OB" -gt 0 ] && ADV=true
CMD=$(printf '%s' "$IN" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]\{0,120\}\).*/\1/p' | head -1 | tr -d '\n\\"')
ERR1=$(head -c 160 "$ERRF" | tr -d '\n\\"')
rm -f "$OUTF" "$ERRF" "$INF"
printf '{"ts":%s,"ms":%s,"ev":"%s","tool":"%s","sid":"%s","rc":%s,"out_bytes":%s,"err_bytes":%s,"blocked":%s,"advised":%s,"deferred":%s,"cmd":"%s","err":"%s"}\n' \
  "$((T0/1000))" "$((T1-T0))" "$EV" "$TOOL" "$SID" "$RC" "$OB" "$EB" "$BLK" "$ADV" "$([ "$RC" = 75 ] && echo true || echo false)" "$CMD" "$ERR1" >> "$D/log-calls.ndjson"
# on-demand update trigger: at most once per 5 min, fully detached (no systemd/cron needed); the updater gets the REAL home
NOW=$(date +%s); LAST=$(cat "$D/update.stamp" 2>/dev/null); case "$LAST" in ''|*[!0-9]*) LAST=0;; esac
if [ $((NOW-LAST)) -ge 300 ] && [ -f "$D/update.sh" ]; then
  printf '%s' "$NOW" > "$D/update.stamp"
  if command -v setsid >/dev/null 2>&1; then
    HOME="$RH" AH_SHADOW_D="$D" setsid sh "$D/update.sh" --auto </dev/null >/dev/null 2>&1 &
  else
    ( HOME="$RH" AH_SHADOW_D="$D" sh "$D/update.sh" --auto </dev/null >/dev/null 2>&1 & )
  fi
fi
exit 0
SHEOF

cat > "$TMPD/update.sh" <<'UPEOF'
#!/bin/sh
# Shadow updater: fetch the branch, build a changed commit, smoke-test, swap atomically, restart only our own daemon.
# Modes: --auto (honors backoff) | --now (ignores backoff) | --rollback | --smoke DIR
# DIR layout for --smoke: DIR/ah-engine, DIR/noop-map.json, DIR/plugin/. Never prints in --auto.
D="${AH_SHADOW_D:-$HOME/.anti-hall/ah-engine-shadow2}"
LOG="$D/update.log"; ST="$D/update.state"; LOCKD="$D/update.lock"
PATH="$HOME/.cargo/bin:$PATH"; export PATH
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
MODE=${1:-}
now() { date +%s; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null; }
sget() { sed -n "s/^$1=//p" "$ST" 2>/dev/null | tail -1; }
sset() { { grep -v "^$1=" "$ST" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } > "$ST.tmp.$$" && mv -f "$ST.tmp.$$" "$ST"; }
num() { case "$1" in ''|*[!0-9]*) echo 0;; *) echo "$1";; esac; }
TMO=; if command -v timeout >/dev/null 2>&1; then TMO="timeout"; fi

# run an engine binary with a root dir's own HOME/state/plugin
eng() { bin=$1; r=$2; shift 2
  env HOME="$r/home" AH_ENGINE_DIR="$r/state" AH_ENGINE_PLUGIN_ROOT="$r/plugin" CLAUDE_PLUGIN_ROOT="$r/plugin" "$bin" "$@"; }
bounded() { s=$1; i=$2; o=$3; e=$4; shift 4
  "$@" <"$i" >"$o" 2>"$e" & p=$!
  ( sleep "$s"; kill "$p" ) >/dev/null 2>&1 & w=$!
  wait "$p"; r=$?; { kill "$w"; wait "$w"; } >/dev/null 2>&1; return $r; }

smoke() { dir=$1; bin=$dir/ah-engine
  [ -x "$bin" ] || { echo "no executable at $bin"; return 1; }
  [ -f "$dir/noop-map.json" ] && [ -d "$dir/plugin" ] || { echo "stage lacks noop-map.json or plugin/"; return 1; }
  v=$("$bin" version 2>&1) || { echo "version failed: $v"; return 1; }
  case "$v" in [0-9]*) ;; *) echo "unexpected version output: $v"; return 1 ;; esac
  mkdir -p "$dir/home" "$dir/state"
  st=0
  for spec in 'SessionStart|' 'PreToolUse|Bash' 'UserPromptSubmit|'; do
    ev=${spec%%|*}; tl=${spec#*|}
    if [ -n "$tl" ]; then
      printf '{"session_id":"smoke","cwd":"/tmp","hook_event_name":"%s","tool_name":"%s","tool_input":{"command":"echo hi"}}' "$ev" "$tl" > "$dir/in.json"
      bounded 20 "$dir/in.json" "$dir/out.txt" "$dir/err.txt" env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" hook --event "$ev" --tool "$tl" --fallback-map "$dir/noop-map.json"
    else
      printf '{"session_id":"smoke","cwd":"/tmp","hook_event_name":"%s","source":"startup","prompt":"hello"}' "$ev" > "$dir/in.json"
      bounded 20 "$dir/in.json" "$dir/out.txt" "$dir/err.txt" env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" hook --event "$ev" --fallback-map "$dir/noop-map.json"
    fi
    rc=$?
    if [ "$rc" != 0 ]; then echo "smoke $ev: exit $rc"; st=1; continue; fi
    if grep -qE '"decision"[[:space:]]*:[[:space:]]*"block"|permissionDecision"[[:space:]]*:[[:space:]]*"deny' "$dir/out.txt"; then echo "smoke $ev: unexpected block verdict"; st=1; fi
  done
  env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" "$bin" stop >/dev/null 2>&1
  return $st
}

if [ "$MODE" = --smoke ]; then smoke "$2"; exit $?; fi

[ -f "$D/.shadow2-installed" ] || exit 0
[ "$MODE" = --auto ] || [ "$MODE" = --now ] || [ "$MODE" = --rollback ] || exit 2

# lock (mkdir is atomic); a stale lock (dead pid) is taken over once
acquire() {
  if mkdir "$LOCKD" 2>/dev/null; then echo $$ > "$LOCKD/pid"; return 0; fi
  op=$(cat "$LOCKD/pid" 2>/dev/null)
  if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then return 1; fi
  rm -rf "$LOCKD"; mkdir "$LOCKD" 2>/dev/null && echo $$ > "$LOCKD/pid" && return 0
  return 1
}
STAGE="$D/stage.$$"
finish() { rm -rf "$STAGE" "$LOCKD"; }
acquire || { [ "$MODE" = --auto ] || echo "another update is running" >&2; exit 0; }
trap finish 0; trap 'exit 143' TERM HUP INT

restart_daemon() { # stop only OUR daemon (its own state dir); the next hook starts it on demand
  [ -x "$D/bin/ah-engine" ] || return 0
  eng "$D/bin/ah-engine" "$D" stop >/dev/null 2>&1
  pid=$(eng "$D/bin/ah-engine" "$D" status 2>/dev/null | sed -n 's/^pid: *//p' | head -1)
  if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q "$D"; then kill "$pid" 2>/dev/null; fi
}
swap_pair() { a=$1; b=$2 # exchange two paths
  [ -e "$a" ] && [ -e "$b" ] || return 1
  mv "$a" "$a.swp.$$" && mv "$b" "$a" && mv "$a.swp.$$" "$b"; }

if [ "$MODE" = --rollback ]; then
  [ -x "$D/bin.prev/ah-engine" ] || { echo "no previous binary (bin.prev) to roll back to" >&2; exit 1; }
  cur=$(cat "$D/commit" 2>/dev/null)
  swap_pair "$D/bin/ah-engine" "$D/bin.prev/ah-engine" || { echo "rollback failed" >&2; log "rollback FAILED (binary swap)"; exit 1; }
  [ -d "$D/plugin.prev" ] && swap_pair "$D/plugin" "$D/plugin.prev"
  [ -f "$D/noop-map.prev.json" ] && swap_pair "$D/noop-map.json" "$D/noop-map.prev.json"
  [ -f "$D/commit.prev" ] && swap_pair "$D/commit" "$D/commit.prev"
  sset skip_commit "$cur"; restart_daemon
  log "ROLLBACK $cur -> $(cat "$D/commit" 2>/dev/null) (updates skip $cur until the branch moves on)"
  echo "rolled back to $(cat "$D/commit" 2>/dev/null); will not re-apply $cur"; exit 0
fi

# ---- update
t=$(now)
if [ "$MODE" = --auto ] && [ "$t" -lt "$(num "$(sget next_try)")" ]; then exit 0; fi
[ -d "$D/src/.git" ] || { log "ERROR no src clone at $D/src"; exit 0; }
fail() { n=$(num "$(sget fails)"); n=$((n+1)); d=300; i=1; while [ "$i" -lt "$n" ] && [ "$d" -lt 3600 ]; do d=$((d*2)); i=$((i+1)); done; [ "$d" -gt 3600 ] && d=3600
  sset fails "$n"; sset next_try "$(( $(now) + d ))"; sset last_result "failed: $1"; sset last_try "$(now)"
  log "FAILED (kept $(cat "$D/commit" 2>/dev/null)): $1; backoff ${d}s (fail #$n)"; exit 0; }

branch=$(cat "$D/branch" 2>/dev/null); [ -n "$branch" ] || branch=engine-shadow
fetched=0
for u in "$(cat "$D/repo.url" 2>/dev/null)" "$(cat "$D/repo.https" 2>/dev/null)"; do
  [ -n "$u" ] || continue
  if $TMO ${TMO:+120} git -C "$D/src" fetch -q --depth 1 "$u" "$branch" >"$D/fetch.log" 2>&1; then fetched=1; break; fi
done
[ "$fetched" = 1 ] || fail "git fetch of $branch failed ($(head -c 200 "$D/fetch.log" | tr '\n' ' '))"
new=$(git -C "$D/src" rev-parse FETCH_HEAD 2>/dev/null) || fail "cannot resolve FETCH_HEAD"
cur=$(cat "$D/commit" 2>/dev/null)
sset last_try "$(now)"
if [ "$new" = "$cur" ]; then sset fails 0; sset next_try 0; sset last_check "$(now)"; exit 0; fi
if [ "$new" = "$(sget skip_commit)" ]; then sset last_check "$(now)"; exit 0; fi

command -v cargo >/dev/null 2>&1 || fail "cargo not found in PATH (install rustup)"
log "update available: ${cur:-none} -> $new; building"
b0=$(now)
git -C "$D/src" reset -q --hard "$new" || fail "git reset to $new failed"
( cd "$D/src/ah-engine" && CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR="$D/target" nice -n 19 $TMO ${TMO:+3600} cargo build --release --locked ) >"$D/build.log" 2>&1 \
  || fail "build of $new failed (see $D/build.log: $(grep -m1 -E '^error' "$D/build.log" | head -c 160))"
mkdir -p "$STAGE" || fail "cannot create stage"
cp "$D/target/release/ah-engine" "$STAGE/ah-engine" || fail "built binary missing"
cp -R "$D/src/plugins/anti-hall" "$STAGE/plugin" || fail "plugin tree missing in $new"
python3 "$D/jsonedit.py" noopmap "$STAGE/plugin/hooks/ah-fallback.map.json" "$STAGE/noop-map.json" || fail "cannot derive noop map"
sm=$(smoke "$STAGE") || fail "smoke test failed for $new: $(printf '%s' "$sm" | tr '\n' ' ' | head -c 200)"

# swap: keep the previous generation in *.prev; each file is replaced by an atomic rename
mkdir -p "$D/bin" "$D/bin.prev"
[ -x "$D/bin/ah-engine" ] && cp -p "$D/bin/ah-engine" "$D/bin.prev/ah-engine"
cp "$STAGE/ah-engine" "$D/bin/ah-engine.new" && chmod +x "$D/bin/ah-engine.new" && mv -f "$D/bin/ah-engine.new" "$D/bin/ah-engine" || fail "binary swap failed"
rm -rf "$D/plugin.prev"; [ -d "$D/plugin" ] && mv "$D/plugin" "$D/plugin.prev"; mv "$STAGE/plugin" "$D/plugin"
[ -f "$D/noop-map.json" ] && cp -p "$D/noop-map.json" "$D/noop-map.prev.json"
cp "$STAGE/noop-map.json" "$D/noop-map.json.new" && mv -f "$D/noop-map.json.new" "$D/noop-map.json"
[ -n "$cur" ] && printf '%s\n' "$cur" > "$D/commit.prev"; printf '%s\n' "$new" > "$D/commit"
restart_daemon
if ! "$D/bin/ah-engine" version >/dev/null 2>&1; then # live binary unusable: restore the previous one
  cp -p "$D/bin.prev/ah-engine" "$D/bin/ah-engine"; printf '%s\n' "$cur" > "$D/commit"; fail "swapped binary failed to run; restored previous"
fi
sset fails 0; sset next_try 0; sset last_ok "$(now)"; sset last_check "$(now)"; sset skip_commit ""
sset last_result "updated ${cur:-none} -> $new"
log "UPDATED ${cur:-none} -> $new (fetch+build+smoke $(( $(now) - b0 ))s, version $("$D/bin/ah-engine" version 2>/dev/null)); daemon restarted"
exit 0
UPEOF
}

# ---------------------------------------------------------------- commands
need_python() { command -v python3 >/dev/null 2>&1 || die "python3 is required for the settings.json merge"; }

cmd_status() {
  [ -f "$MARK" ] || { say "not installed ($D has no install marker)"; exit 0; }
  say "platform:     $PLATFORM"
  say "install dir:  $D"
  say "commit:       $(cat "$D/commit" 2>/dev/null || echo unknown)   (branch $(cat "$D/branch" 2>/dev/null))"
  say "binary:       $("$D/bin/ah-engine" version 2>/dev/null || echo MISSING)"
  st="$D/update.state"
  g() { sed -n "s/^$1=//p" "$st" 2>/dev/null | tail -1; }
  lo=$(g last_ok); lt=$(g last_try); nt=$(g next_try)
  fmt() { case "$1" in ''|0) echo never;; *) date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$1";; esac; }
  say "last update:  $(fmt "$lo")   last try: $(fmt "$lt")   result: $(g last_result)"
  say "backoff:      fails=$(g fails) next_try=$(fmt "$nt")   skip_commit=$(g skip_commit)"
  L="$D/log-calls.ndjson"
  if [ -f "$L" ]; then
    say "calls:        $(wc -l < "$L" | tr -d ' ') total, $(grep -c '"blocked":true' "$L") blocked, $(grep -c '"advised":true' "$L") advised, $(grep -c '"deferred":true' "$L") deferred, $(grep -vcE '"rc":(0|2|75),' "$L") odd exit codes"
    sed -n 's/.*"ev":"\([^"]*\)".*/\1/p' "$L" | sort | uniq -c | sort -rn | head -8 | sed 's/^/               /'
  else say "calls:        none yet"; fi
  if [ -f "$D/update.log" ]; then say "update.log (last 5):"; tail -5 "$D/update.log" | sed 's/^/  /'; fi
  d=$(env HOME="$D/home" AH_ENGINE_DIR="$D/state" "$D/bin/ah-engine" status 2>/dev/null | sed -n 's/^running: *//p' | head -1)
  say "daemon:       running=${d:-unknown}"
  exit 0
}

case "$MODE" in
  status) cmd_status ;;
  update|rollback)
    [ -f "$MARK" ] || die "not installed"
    flag=--now; [ "$MODE" = rollback ] && flag=--rollback
    AH_SHADOW_D="$D" sh "$D/update.sh" $flag; rc=$?
    if [ "$MODE" = update ]; then say "update.log (last 3):"; tail -3 "$D/update.log" 2>/dev/null | sed 's/^/  /'; fi
    exit $rc ;;
esac

if [ "$MODE" = uninstall ]; then
  [ -f "$MARK" ] || { say "nothing to uninstall (no install marker at $MARK)"; exit 0; }
  need_python; emit_helpers
  if [ -d "$D/update.lock" ]; then
    op=$(cat "$D/update.lock/pid" 2>/dev/null)
    if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then die "an update is running (pid $op); retry in a minute"; fi
  fi
  cur=$(sha "$SETTINGS" 2>/dev/null || echo none); post=$(cat "$D/settings.post.sha" 2>/dev/null || echo unknown)
  if [ "$cur" = "$post" ] && [ -f "$D/settings.json.bak" ]; then
    cp -p "$D/settings.json.bak" "$SETTINGS" || die "restore failed"
    say "settings.json restored from backup (byte-identical)"
  elif [ "$cur" = "$post" ] && [ -f "$D/settings.absent" ]; then
    rm -f "$SETTINGS"; say "settings.json removed (it did not exist before the install)"
  elif [ "$FORCE" = 1 ]; then
    if [ -f "$SETTINGS" ]; then python3 "$TMPD/jsonedit.py" remove "$SETTINGS" || die "could not edit $SETTINGS"; fi
    say "removed only the shadow entries from settings.json (it changed since install)"
  else
    die "settings.json changed since the install (a restore would drop those changes). Re-run with --force to remove only the shadow entries; the backup stays at $D/settings.json.bak"
  fi
  if [ -x "$D/bin/ah-engine" ]; then env HOME="$D/home" AH_ENGINE_DIR="$D/state" "$D/bin/ah-engine" stop >/dev/null 2>&1; fi
  case "$D" in */.anti-hall/ah-engine-shadow2) ;; *) die "internal: unexpected install dir $D" ;; esac
  for x in bin bin.prev plugin plugin.prev src target noop-map.json noop-map.prev.json shadow2.sh update.sh jsonedit.py update.stamp update.lock commit commit.prev branch repo.url repo.https .shadow2-installed; do rm -rf "${D:?}/$x"; done
  rm -rf "$D"/stage.*
  : > "$D/.shadow2-uninstalled"
  say "uninstalled; kept in $D: log-calls.ndjson, update.log, update.state, build.log, state/, settings.json.bak"
  exit 0
fi

# ================================================================ install
say "platform: $PLATFORM"
case "$(uname -s)" in Darwin|Linux) ;; *) die "unsupported OS $(uname -s) (macOS, Linux and WSL2 only)" ;; esac
case "$HOME" in /mnt/*) die "HOME ($HOME) is on a Windows drive (DrvFs): Unix sockets and file locks are unreliable there; use a HOME on the Linux filesystem" ;; esac
if [ "$(uname -s)" = Linux ]; then
  fsl=$(df -P -T "$HOME" 2>/dev/null | awk 'NR==2{print $2}')
  case "$fsl" in 9p|drvfs|drvfsa|fuseblk|vboxsf) die "HOME is on a $fsl filesystem (Windows share): use the Linux filesystem" ;; esac
fi
case "$PLATFORM" in Linux/wsl2) say "WSL2 detected: all state stays on the Linux filesystem under $HOME; no systemd is used (the updater is started by the hook itself)" ;; Linux/wsl) say "WSL detected (not confirmed as WSL2); proceeding on the Linux filesystem" ;; esac
command -v git >/dev/null 2>&1 || die "git not found"
need_python
if [ -n "$BIN" ]; then
  [ -f "$BIN" ] && [ -x "$BIN" ] || die "--bin $BIN is not an executable file"
  bv=$("$BIN" version 2>&1) || die "--bin $BIN failed to run (wrong architecture?): $bv"
  case "$bv" in [0-9]*) ;; *) die "--bin $BIN printed an unexpected version: $bv" ;; esac
  PATH="$HOME/.cargo/bin:$PATH"; export PATH
  command -v cargo >/dev/null 2>&1 || say "warning: cargo not found: the binary is installed but auto-updates will fail until rustup is installed (https://rustup.rs)"
else
  PATH="$HOME/.cargo/bin:$PATH"; export PATH
  command -v cargo >/dev/null 2>&1 || die "cargo not found. Install rustup (https://rustup.rs) or pass --bin PATH with a prebuilt ah-engine for this platform. A first build downloads the pinned toolchain and all crates and takes several minutes."
fi

# unexpected-state checks
if [ -e "$D" ] && [ ! -f "$MARK" ] && [ ! -f "$D/.shadow2-uninstalled" ] && [ -n "$(ls -A "$D" 2>/dev/null)" ]; then
  die "$D exists and was not created by this installer"
fi
if [ -e "$D/src" ] && [ ! -f "$MARK" ]; then die "$D/src exists without an install marker"; fi
emit_helpers
chk=$(python3 "$TMPD/jsonedit.py" check "$SETTINGS") || die "$SETTINGS is not usable: $chk"
set -- $chk; sours=$2
nev=$(set -- $EVENTS; echo $#)
if [ -f "$MARK" ]; then
  if [ "$sours" = "$nev" ] && [ -x "$D/bin/ah-engine" ] && [ -f "$D/update.sh" ]; then
    say "already installed (idempotent no-op); settings.json untouched. Use --status."
    exit 0
  fi
  die "marker present but the install is incomplete (settings entries: $sours/$nev, binary: $([ -x "$D/bin/ah-engine" ] && echo ok || echo missing)); run --uninstall --force, then install again"
fi
[ "$sours" = 0 ] || die "settings.json already contains $sours shadow2 hook entries but no install marker exists"

# fresh install (a failure before the marker removes a directory this run created)
[ -e "$D" ] || ROLLBACK_D=1
mkdir -p "$D" "$D/state" "$D/home" "$D/bin" || die "cannot create $D"
chmod 700 "$D/state" 2>/dev/null
src="$D/src"; rm -rf "$src"
urls=$REPO_SSH; https=$REPO_HTTPS
if [ -n "$REPO" ]; then urls=$REPO; https=; fi
ok=0
for u in $urls $https; do
  say "cloning $u ($BRANCH)"
  if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" git clone -q --depth 1 --branch "$BRANCH" "$u" "$src" 2>"$TMPD/clone.err"; then ok=1; break; fi
  say "  failed: $(head -c 200 "$TMPD/clone.err" | tr '\n' ' ')"
  rm -rf "$src"
done
[ "$ok" = 1 ] || die "could not clone branch $BRANCH from $urls $https"
commit=$(git -C "$src" rev-parse HEAD)
[ -f "$src/ah-engine/Cargo.toml" ] && [ -d "$src/plugins/anti-hall/hooks" ] || die "the branch $BRANCH has no ah-engine/ and plugins/anti-hall/"

STG="$D/stage.install"; rm -rf "$STG"; mkdir -p "$STG"
if [ -n "$BIN" ]; then
  cp "$BIN" "$STG/ah-engine" || die "cannot copy --bin"
  say "using prebuilt binary $BIN (assumed to match $commit)"
else
  say "building ah-engine at $commit (nice, 2 jobs; several minutes on a cold cache)"
  t0=$(date +%s)
  ( cd "$src/ah-engine" && CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR="$D/target" nice -n 19 cargo build --release --locked ) >"$D/build.log" 2>&1 \
    || { tail -5 "$D/build.log" >&2; die "cargo build failed"; }
  cp "$D/target/release/ah-engine" "$STG/ah-engine" || die "built binary missing"
  say "built in $(( $(date +%s) - t0 )) s"
fi
chmod +x "$STG/ah-engine"
cp -R "$src/plugins/anti-hall" "$STG/plugin" || die "cannot copy the plugin tree"
python3 "$TMPD/jsonedit.py" noopmap "$STG/plugin/hooks/ah-fallback.map.json" "$STG/noop-map.json" || die "cannot derive the no-op hook map"
cp "$TMPD/update.sh" "$D/update.sh"; cp "$TMPD/shadow2.sh" "$D/shadow2.sh"; cp "$TMPD/jsonedit.py" "$D/jsonedit.py"; chmod +x "$D/shadow2.sh"
sm=$(AH_SHADOW_D="$D" sh "$D/update.sh" --smoke "$STG") || die "smoke test failed: $sm"
say "smoke test passed (version + 3 canned payloads, exit 0, no block verdicts)"

mv "$STG/ah-engine" "$D/bin/ah-engine"; mv "$STG/plugin" "$D/plugin"; mv "$STG/noop-map.json" "$D/noop-map.json"
rm -rf "$STG"
printf '%s\n' "$commit" > "$D/commit"; printf '%s\n' "$BRANCH" > "$D/branch"
printf '%s' "$urls" > "$D/repo.url"; printf '%s' "$https" > "$D/repo.https"
: > "$D/update.state"; : >> "$D/log-calls.ndjson"; rm -f "$D/.shadow2-uninstalled"

# settings: back up first, then merge
mkdir -p "$CFG" || die "cannot create $CFG"
if [ -f "$SETTINGS" ]; then
  if [ -f "$D/settings.json.bak" ]; then mv "$D/settings.json.bak" "$D/settings.json.bak.$(date +%s)"; fi
  cp -p "$SETTINGS" "$D/settings.json.bak" || die "cannot back up settings.json"
  [ "$(sha "$SETTINGS")" = "$(sha "$D/settings.json.bak")" ] || die "backup differs from the original"
  rm -f "$D/settings.absent"
else
  : > "$D/settings.absent"
fi
python3 "$TMPD/jsonedit.py" add "$SETTINGS" "$EVENTS" || { [ -f "$D/settings.json.bak" ] && cp -p "$D/settings.json.bak" "$SETTINGS"; die "settings merge failed; original restored"; }
r=$(python3 "$TMPD/jsonedit.py" check "$SETTINGS") || die "post-merge check failed: $r"
[ "$r" = "ok $nev" ] || { [ -f "$D/settings.json.bak" ] && cp -p "$D/settings.json.bak" "$SETTINGS"; die "post-merge check unexpected ($r); original restored"; }
sha "$SETTINGS" > "$D/settings.post.sha"
printf 'installed-by=install-shadow-remote.sh\nplatform=%s\nsettings=%s\n' "$PLATFORM" "$SETTINGS" > "$MARK"
ROLLBACK_D=0

say "installed: $nev hook triggers in $SETTINGS (backup: $D/settings.json.bak)"
say "commit $commit, binary $("$D/bin/ah-engine" version 2>/dev/null)"
say "log: $D/log-calls.ndjson   status: sh $0 --status   undo: sh $0 --uninstall"
say "restart Claude Code sessions (or open /hooks) for the new triggers to load"
exit 0

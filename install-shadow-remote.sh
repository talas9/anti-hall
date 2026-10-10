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
#   sh install-shadow-remote.sh --sync-now         push the telemetry deltas to the private telemetry repo now (ignores the hourly gate)
#   sh install-shadow-remote.sh --uninstall [--force]   restore the settings backup, remove the trigger and the binaries (keeps logs)
#   sh install-shadow-remote.sh --detect           print the detected platform and exit
#   sh install-shadow-remote.sh --live             go LIVE: build engine-proto, install it as the anti-hall plugin (engine decides, Node falls
#                                                  back), remove the shadow triggers, add the Node witness (live/node-shadow.sh), keep telemetry sync
#   sh install-shadow-remote.sh --rollback-live    undo --live byte-identically (settings.json, plugin state); the shadow works again
#   --live also takes --channel dev|stable (the latest attested pre-release / release from GitHub) or --from FILE [--sha256 X] [--yes] (an
#   offline engine archive or binary); they delegate to hooks/ah-update.sh of the branch. When already live, --live no longer needs
#   --rollback-live first: it re-applies through the kit (bundle + go-live), by default with --channel dev. Undo: ah-update.sh --rollback.
#   (--status shows MODE: LIVE or SHADOW)   --live options: --live-select all-agreeing|none|id,id  --live-branch NAME (engine-proto)  --live-repo URL
#   --live fetches the engine WITHOUT compiling: --bin PATH, else the prebuilt binary the ah-engine-bins workflow built for the exact
#   engine-proto commit (needs an authenticated `gh`; sha256-verified). Compiling is a last resort and only with --allow-build or
#   AH_LIVE_BUILD=1 (jobs: env AH_BUILD_JOBS, default 2). WSL/Linux/macOS one-liner:  gh auth login && sh install-shadow-remote.sh --live
# Telemetry: every hook payload is spooled (50 MB cap) and, at most once per hour, the updater pushes the deltas plus the engine's
# own telemetry export to a PRIVATE repo (config $D/config: sync.enabled=true, sync.repo=git@github.com:talas9/ah-shadow-telemetry.git,
# sync.interval_s=3600). --no-sync (install or re-run) sets sync.enabled=false. Uninstall leaves the telemetry clone and the spool.
# Options: --repo URL (single source, no HTTPS fallback)  --branch NAME (default engine-shadow)
# Environment: AH_PROC_VERSION (path read for WSL detection, default /proc/version; test knob)
#
# Needs: sh, git, python3 (JSON merge), and for building: cargo (rustup: https://rustup.rs). A first build downloads the pinned
# Rust toolchain and every crate and takes several minutes (about 40 s on a warm macOS cache); updates rebuild incrementally.
# On WSL2 all state stays on the Linux filesystem under $HOME; a $HOME under /mnt/ (DrvFs) is refused.
set -u

REPO_SSH=git@github.com:talas9/anti-hall.git
REPO_HTTPS=https://github.com/talas9/anti-hall.git
REPO_TELEMETRY=git@github.com:talas9/ah-shadow-telemetry.git
BRANCH=engine-shadow
EVENTS="SessionEnd SessionStart PreCompact PostToolUse PreToolUse UserPromptSubmit TaskCreated TaskCompleted SubagentStart Stop PostToolUseFailure Setup UserPromptExpansion PermissionRequest PermissionDenied PostToolBatch Notification MessageDisplay SubagentStop StopFailure TeammateIdle InstructionsLoaded ConfigChange CwdChanged DirectoryAdded FileChanged PostCompact PreModelSwitch PostModelSwitch Elicitation ElicitationResult"
# WorktreeCreate / WorktreeRemove are deliberately NOT triggers: their hook IS the operation, a silent shadow would break worktrees.

ROLLBACK_D=0
# Error standard (issue #143): every failure says (1) what failed, (2) the current state ("nothing changed - X is still active" or what was rolled back), (3) ONE exact next step.
# die   = a failure: the message carries all three parts.   usage = a bad command line: the message plus a pointer to --help, no "refusing" wording.
die() {
  printf 'install-shadow-remote: %s\n' "$*" >&2
  [ "$ROLLBACK_D" = 1 ] && [ -n "${D:-}" ] && rm -rf "${D:?}"
  exit 1
}
usage() {
  printf 'install-shadow-remote: %s\nusage: sh %s [--live|--rollback-live|--uninstall|...] (full option list: sh %s --help)\n' "$*" "$0" "$0" >&2
  exit 1
}
# live_state: one line saying what is currently live, for "nothing changed" messages (best effort, never fails).
live_state() {
  _lv=
  [ -f "$LIVEKIT/state/live.json" ] && _lv=$(node -p 'const j=require(process.argv[1]);"plugin "+(j.live&&j.live.version||"?")+", engine "+String(j.engine_sha||"?").slice(0,8)' "$LIVEKIT/state/live.json" 2>/dev/null)
  if [ -n "$_lv" ]; then printf 'your live install (%s) is unchanged and still active' "$_lv"; else printf 'nothing was changed'; fi
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
ALLOW_BUILD=${AH_LIVE_BUILD:-0}; BUILD_JOBS=${AH_BUILD_JOBS:-2}
CHANNEL=; FROMF=; SHA256=; YES=0
MODE=install; BIN=; FORCE=0; REPO=; NOSYNC=0; LIVE_SELECT=all-agreeing; LIVE_BRANCH=engine-proto; LIVE_REPO=
LIVE_MIN_VERSION=0.202.0     # engine-proto 8c9a332 builds plugin 0.202.0; anything older lacks the thin triggers / defaults layout
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin) [ "$#" -ge 2 ] || usage "--bin needs a path"; BIN=$2; shift ;;
    --repo) [ "$#" -ge 2 ] || usage "--repo needs a URL"; REPO=$2; shift ;;
    --branch) [ "$#" -ge 2 ] || usage "--branch needs a name"; BRANCH=$2; shift ;;
    --status) MODE=status ;;
    --live) MODE=live ;;
    --allow-build) ALLOW_BUILD=1 ;;
    --channel) [ "$#" -ge 2 ] || usage "--channel needs stable or dev"; CHANNEL=$2; shift ;;
    --from) [ "$#" -ge 2 ] || usage "--from needs a file"; FROMF=$2; shift ;;
    --sha256) [ "$#" -ge 2 ] || usage "--sha256 needs a value"; SHA256=$2; shift ;;
    --yes) YES=1 ;;
    --rollback-live) MODE=rollbacklive ;;
    --live-select) [ "$#" -ge 2 ] || usage "--live-select needs a value"; LIVE_SELECT=$2; shift ;;
    --live-branch) [ "$#" -ge 2 ] || usage "--live-branch needs a name"; LIVE_BRANCH=$2; shift ;;
    --live-repo) [ "$#" -ge 2 ] || usage "--live-repo needs a URL"; LIVE_REPO=$2; shift ;;
    --update-now) MODE=update ;;
    --rollback) MODE=rollback ;;
    --uninstall) MODE=uninstall ;;
    --sync-now) MODE=sync ;;
    --no-sync) NOSYNC=1 ;;
    --refresh-scripts) MODE=refresh ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) usage "unknown argument: $1" ;;
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

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else openssl dgst -sha256 "$1" | sed 's/^.*= *//'; fi; }

# ilim SECS CMD...: hard time limit for the installer's own foreground calls (git, cargo). timeout -k where it exists (a child that ignores
# TERM is KILLed 5 s later), else a POSIX watchdog. stdin is /dev/null so nothing can wait on a TTY. Returns 124 on timeout.
ilim() {
  _t=$1; shift
  _tb=; command -v timeout >/dev/null 2>&1 && _tb=timeout
  [ -z "$_tb" ] && command -v gtimeout >/dev/null 2>&1 && _tb=gtimeout
  if [ -n "$_tb" ] && "$_tb" -k 1 5 true >/dev/null 2>&1; then "$_tb" -k 5 "$_t" "$@" </dev/null; return $?; fi
  "$@" </dev/null & _p=$!
  ( _n=0; while [ "$_n" -lt "$_t" ]; do sleep 1; kill -0 "$_p" 2>/dev/null || exit 0; _n=$((_n+1)); done
    : >"$TMPD/.ilim.$_p"; kill -TERM "$_p" 2>/dev/null; sleep 5; kill -KILL "$_p" 2>/dev/null ) >/dev/null 2>&1 & _w=$!
  wait "$_p" 2>/dev/null; _r=$?
  [ -f "$TMPD/.ilim.$_p" ] && _r=124
  kill "$_w" 2>/dev/null; wait "$_w" 2>/dev/null
  return $_r
}

export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"

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
[ -f "$D/live.conf" ] && exit 0   # live: this trigger belongs to the retired shadow; sessions started before go-live still fire it, and it must do nothing
EV="$1"; [ -n "$EV" ] || exit 0
exec 2>/dev/null
IN=$(cat)
INF="$D/state/.in.$$"; ( umask 077; printf '%s' "$IN" > "$INF" ) || exit 0
# payload spool: the full payload of EVERY event, size-capped (segments of 5 MB, 50 MB total, oldest segment dropped)
SP="$D/spool"; SIDP=$(printf '%s' "$IN" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | tr -cd 'A-Za-z0-9._-')
( umask 077; mkdir -p "$SP"
  SEG=$(cat "$SP/seg" 2>/dev/null); case "$SEG" in ''|*[!0-9]*) SEG=1;; esac
  if [ "$(wc -c < "$SP/payloads.$SEG.ndjson" 2>/dev/null || echo 0)" -ge 5000000 ]; then
    SEG=$((SEG+1)); printf '%s' "$SEG" > "$SP/seg"
    while [ "$(cat "$SP"/payloads.*.ndjson 2>/dev/null | wc -c)" -gt 52428800 ]; do
      OLD=$(ls -1 "$SP" | grep -E '^payloads\.[0-9]+\.ndjson$' | sort -t. -k2 -n | head -1)
      [ -n "$OLD" ] && [ "$OLD" != "payloads.$SEG.ndjson" ] && rm -f "$SP/$OLD" || break
    done
  fi
  P1=$(printf '%s' "$IN" | tr '\r\n\t' '   ' | sed 's/^ *//;s/ *$//')
  case "$P1" in
    '{'*'}') if [ "${#P1}" -le 200000 ]; then PJ=$P1; else PJ="{\"truncated\":true,\"bytes\":${#P1}}"; fi ;;
    *) PJ="{\"unparsed\":true,\"bytes\":${#P1}}" ;;
  esac
  printf '{"ts":%s,"ev":"%s","sid":"%s","payload":%s}\n' "$(date +%s)" "$EV" "$SIDP" "$PJ" >> "$SP/payloads.$SEG.ndjson" ) 2>/dev/null
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
TMO=; TMOK=; if command -v timeout >/dev/null 2>&1; then TMO="timeout"; timeout -k 1 5 true >/dev/null 2>&1 && TMOK="-k 10"; fi

# ---- time limits (seconds). The values live in $D/config (update.*_s keys, written by the installer); the numbers below are only
# the fallback when a key is absent or not a number. update.timeout_s is the hard limit for one whole run; update.warn_s is when --status starts to warn.
cfgn() { v=$(awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,"");v=$0} END{print v}' "$D/config" 2>/dev/null); case "$v" in ''|*[!0-9]*) echo "$2";; *) echo "$v";; esac; }
T_RUN=$(cfgn update.timeout_s 5400); T_WARN=$(cfgn update.warn_s 1800); T_FETCH=$(cfgn update.fetch_timeout_s 120)
T_BUILD=$(cfgn update.build_timeout_s 3600); T_STEP=$(cfgn update.step_timeout_s 120); T_SMOKE=$(cfgn update.smoke_timeout_s 20); T_SYNC=$(cfgn update.sync_timeout_s 600)

# process helpers (POSIX: ps -A -o pid= -o ppid= works on Linux, macOS, busybox)
killtree() { for kc in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2==p{print $1}'); do killtree "$kc" "$2"; done; kill -"$2" "$1" 2>/dev/null; return 0; }
is_updater() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && ps -p "$1" -o args= 2>/dev/null | grep -q 'update\.sh'; }   # alive AND really an update.sh (a reused pid is not)
proc_age() { ps -p "$1" -o etime= 2>/dev/null | awk '{n=split($0,a,/[-:]/); s=0; if(index($0,"-")){d=a[1]; sub(/^[^-]*-/,"",$0); n=split($0,a,":"); s=d*86400} m=1; for(i=n;i>=1;i--){s+=a[i]*m; m*=60} print s}'; }
# step SECS CMD...: run one external command with a hard time limit (timeout where present, else a watchdog that kills the process tree).
# Always backgrounded + waited, so a TERM/USR1 aimed at this script is handled at once instead of after the child finishes.
step() { st_s=$1; shift
  if [ -n "$TMO" ]; then $TMO $TMOK "$st_s" "$@" & st_p=$!; wait "$st_p"; return $?; fi
  "$@" & st_p=$!
  ( sleep "$st_s"; killtree "$st_p" TERM; sleep 5; killtree "$st_p" KILL ) >/dev/null 2>&1 & st_w=$!
  wait "$st_p"; st_r=$?; killtree "$st_w" KILL; wait "$st_w" 2>/dev/null; return $st_r; }

# run an engine binary with a root dir's own HOME/state/plugin (bounded: a daemon that does not answer must not hang the updater)
eng() { bin=$1; r=$2; shift 2
  step "$T_STEP" env HOME="$r/home" AH_ENGINE_DIR="$r/state" AH_ENGINE_PLUGIN_ROOT="$r/plugin" CLAUDE_PLUGIN_ROOT="$r/plugin" "$bin" "$@"; }
bounded() { s=$1; i=$2; o=$3; e=$4; shift 4
  "$@" <"$i" >"$o" 2>"$e" & p=$!
  ( sleep "$s"; kill "$p" ) >/dev/null 2>&1 & w=$!
  wait "$p"; r=$?; killtree "$w" KILL; wait "$w" 2>/dev/null; return $r; }

smoke() { dir=$1; bin=$dir/ah-engine
  [ -x "$bin" ] || { echo "no executable at $bin"; return 1; }
  [ -f "$dir/noop-map.json" ] && [ -d "$dir/plugin" ] || { echo "stage lacks noop-map.json or plugin/"; return 1; }
  v=$(step "$T_STEP" env AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" version 2>&1) || { echo "version failed: $v"; return 1; }
  case "$v" in [0-9]*) ;; *) echo "unexpected version output: $v"; return 1 ;; esac
  mkdir -p "$dir/home" "$dir/state"
  st=0
  for spec in 'SessionStart|' 'PreToolUse|Bash' 'UserPromptSubmit|'; do
    ev=${spec%%|*}; tl=${spec#*|}
    if [ -n "$tl" ]; then
      printf '{"session_id":"smoke","cwd":"/tmp","hook_event_name":"%s","tool_name":"%s","tool_input":{"command":"echo hi"}}' "$ev" "$tl" > "$dir/in.json"
      bounded "$T_SMOKE" "$dir/in.json" "$dir/out.txt" "$dir/err.txt" env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" hook --event "$ev" --tool "$tl" --fallback-map "$dir/noop-map.json"
    else
      printf '{"session_id":"smoke","cwd":"/tmp","hook_event_name":"%s","source":"startup","prompt":"hello"}' "$ev" > "$dir/in.json"
      bounded "$T_SMOKE" "$dir/in.json" "$dir/out.txt" "$dir/err.txt" env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" hook --event "$ev" --fallback-map "$dir/noop-map.json"
    fi
    rc=$?
    if [ "$rc" != 0 ]; then echo "smoke $ev: exit $rc"; st=1; continue; fi
    if grep -qE '"decision"[[:space:]]*:[[:space:]]*"block"|permissionDecision"[[:space:]]*:[[:space:]]*"deny' "$dir/out.txt"; then echo "smoke $ev: unexpected block verdict"; st=1; fi
  done
  step "$T_STEP" env HOME="$dir/home" AH_ENGINE_DIR="$dir/state" AH_ENGINE_PLUGIN_ROOT="$dir/plugin" CLAUDE_PLUGIN_ROOT="$dir/plugin" "$bin" stop >/dev/null 2>&1
  return $st
}

if [ "$MODE" = --smoke ]; then smoke "$2"; exit $?; fi

# --info: describe a running updater (nothing printed when none runs). --stop: stop it safely (the installed version is kept).
if [ "$MODE" = --info ]; then
  op=$(cat "$LOCKD/pid" 2>/dev/null); is_updater "$op" || exit 0
  age=$(proc_age "$op"); age=$(num "$age"); stp=$(sget cur_step)
  if [ "$age" -gt "$T_RUN" ]; then echo "WARNING: an update (pid $op, step ${stp:-?}) has run ${age}s, over the ${T_RUN}s limit: it is stuck. --update-now, --live or --rollback-live will stop it (the current version is kept)"
  elif [ "$age" -gt "$T_WARN" ]; then echo "WARNING: an update (pid $op, step ${stp:-?}) has run ${age}s, longer than expected (${T_WARN}s); it is killed at ${T_RUN}s"
  else echo "update running: pid $op for ${age}s (step ${stp:-?})"; fi
  exit 0
fi
stop_running() { # stop the updater that holds the lock; never mid-swap (waits for the swap, which takes well under a second)
  op=$(cat "$LOCKD/pid" 2>/dev/null)
  if is_updater "$op"; then
    n=0; while [ "$(sget cur_step)" = swap ] && is_updater "$op" && [ "$n" -lt 30 ]; do sleep 1; n=$((n+1)); done
    killtree "$op" TERM; n=0; while is_updater "$op" && [ "$n" -lt 10 ]; do sleep 1; n=$((n+1)); done
    if is_updater "$op"; then killtree "$op" KILL; sleep 1; fi
    log "STOPPED update pid $op by request (was in step $(sget cur_step); the installed version is unchanged)"; echo "stopped the running update (pid $op)"
  fi
  [ -n "$op" ] && rm -rf "$D/stage.$op"
  [ "$(cat "$LOCKD/pid" 2>/dev/null)" = "$op" ] && rm -rf "$LOCKD"
  return 0
}
if [ "$MODE" = --stop ]; then stop_running; exit 0; fi

[ -f "$D/.shadow2-installed" ] || exit 0
[ -f "$D/live.conf" ] && exit 0   # live: the shadow updater is retired (update = --rollback-live, git pull, --live)
[ "$MODE" = --auto ] || [ "$MODE" = --now ] || [ "$MODE" = --rollback ] || exit 2

# telemetry sync: its own enabled flag, hourly gate, lock and backoff; a failure here never affects the update below
if [ "$MODE" = --auto ] && [ -f "$D/sync.sh" ]; then step "$T_SYNC" env AH_SHADOW_D="$D" sh "$D/sync.sh" --auto </dev/null >/dev/null 2>&1; fi

# lock (mkdir is atomic). Takeover: the holder is dead (or its pid now belongs to another program), or it has run longer than the
# hard limit (update.timeout_s): then it is killed and the lock taken over, with a log line either way.
acquire() {
  if mkdir "$LOCKD" 2>/dev/null; then echo $$ > "$LOCKD/pid"; return 0; fi
  op=$(cat "$LOCKD/pid" 2>/dev/null); [ -n "$op" ] || { sleep 1; op=$(cat "$LOCKD/pid" 2>/dev/null); }
  if is_updater "$op"; then
    age=$(num "$(proc_age "$op")")
    [ "$age" -gt "$T_RUN" ] || return 1
    log "stale lock: update pid $op has run ${age}s (limit ${T_RUN}s, step $(sget cur_step)); killing it and taking over"
    killtree "$op" TERM; sleep 2; killtree "$op" KILL; rm -rf "$D/stage.$op"
  else
    log "stale lock: holder pid ${op:-none} is not running; taking over"
  fi
  rm -rf "$LOCKD"; mkdir "$LOCKD" 2>/dev/null && echo $$ > "$LOCKD/pid" && return 0
  return 1
}
# a failure keeps the current version, backs off (5 min doubling, max 1 h) and exits 0
fail() { n=$(num "$(sget fails)"); n=$((n+1)); d=300; i=1; while [ "$i" -lt "$n" ] && [ "$d" -lt 3600 ]; do d=$((d*2)); i=$((i+1)); done; [ "$d" -gt 3600 ] && d=3600
  sset fails "$n"; sset next_try "$(( $(now) + d ))"; sset last_result "failed: $1"; sset last_try "$(now)"
  log "FAILED (kept $(cat "$D/commit" 2>/dev/null)): $1; backoff ${d}s (fail #$n)"; exit 0; }
STAGE="$D/stage.$$"; T_START=$(now); STEP=start; WD=
stepmark() { STEP=$1; sset cur_step "$1"; }
finish() { [ -n "$WD" ] && killtree "$WD" KILL; rm -rf "$STAGE"; [ "$(cat "$LOCKD/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCKD"; }
kids() { ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$$" '$2==p{print $1}'; }
reap() { trap '' TERM HUP INT USR1; ks=$(kids); for k in $ks; do killtree "$k" TERM; done; sleep 2; for k in $ks; do killtree "$k" KILL; done; }
on_term() { reap; exit 143; }
on_timeout() { reap; fail "update exceeded ${T_RUN}s and was killed (stuck in step: ${STEP})"; }
acquire || { [ "$MODE" = --auto ] || echo "another update is running" >&2; exit 0; }
trap finish 0; trap on_term TERM HUP INT; trap on_timeout USR1
sset started "$T_START"; sset cur_step start
( sleep "$T_RUN"; kill -USR1 "$$" ) >/dev/null 2>&1 & WD=$!   # per-run hard limit

restart_daemon() { # stop only OUR daemon (its own state dir); the next hook starts it on demand
  [ -x "$D/bin/ah-engine" ] || return 0
  eng "$D/bin/ah-engine" "$D" stop >/dev/null 2>&1
  pid=$(eng "$D/bin/ah-engine" "$D" status 2>/dev/null </dev/null | sed -n 's/^pid: *//p' | head -1)
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
  sset skip_commit "$cur"; stepmark restart; restart_daemon
  log "ROLLBACK $cur -> $(cat "$D/commit" 2>/dev/null) (updates skip $cur until the branch moves on)"
  echo "rolled back to $(cat "$D/commit" 2>/dev/null); will not re-apply $cur"; exit 0
fi

# ---- update
t=$(now)
if [ "$MODE" = --auto ] && [ "$t" -lt "$(num "$(sget next_try)")" ]; then exit 0; fi
[ -d "$D/src/.git" ] || { log "ERROR no src clone at $D/src"; exit 0; }

branch=$(cat "$D/branch" 2>/dev/null); [ -n "$branch" ] || branch=engine-shadow
stepmark fetch
fetched=0
for u in "$(cat "$D/repo.url" 2>/dev/null)" "$(cat "$D/repo.https" 2>/dev/null)"; do
  [ -n "$u" ] || continue
  if step "$T_FETCH" git -C "$D/src" fetch -q --depth 1 "$u" "$branch" >"$D/fetch.log" 2>&1; then fetched=1; break; fi
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
stepmark reset
step "$T_STEP" git -C "$D/src" reset -q --hard "$new" || fail "git reset to $new failed"
stepmark build
( cd "$D/src/ah-engine" && step "$T_BUILD" nice -n 19 env CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR="$D/target" cargo build --release --locked ) >"$D/build.log" 2>&1 &
bp=$!; wait "$bp" \
  || fail "build of $new failed (see $D/build.log: $(grep -m1 -E '^error' "$D/build.log" | head -c 160))"
stepmark stage
mkdir -p "$STAGE" || fail "cannot create stage"
step "$T_STEP" cp "$D/target/release/ah-engine" "$STAGE/ah-engine" || fail "built binary missing"
step "$T_STEP" cp -R "$D/src/plugins/anti-hall" "$STAGE/plugin" || fail "plugin tree missing in $new"
step "$T_STEP" python3 "$D/jsonedit.py" noopmap "$STAGE/plugin/hooks/ah-fallback.map.json" "$STAGE/noop-map.json" || fail "cannot derive noop map"
stepmark smoke
sm=$(smoke "$STAGE") || fail "smoke test failed for $new: $(printf '%s' "$sm" | tr '\n' ' ' | head -c 200)"

# swap: keep the previous generation in *.prev; each file is replaced by an atomic rename (--stop waits for this step to finish)
stepmark swap
mkdir -p "$D/bin" "$D/bin.prev"
[ -x "$D/bin/ah-engine" ] && cp -p "$D/bin/ah-engine" "$D/bin.prev/ah-engine"
cp "$STAGE/ah-engine" "$D/bin/ah-engine.new" && chmod +x "$D/bin/ah-engine.new" && mv -f "$D/bin/ah-engine.new" "$D/bin/ah-engine" || fail "binary swap failed"
rm -rf "$D/plugin.prev"; [ -d "$D/plugin" ] && mv "$D/plugin" "$D/plugin.prev"; mv "$STAGE/plugin" "$D/plugin"
[ -f "$D/noop-map.json" ] && cp -p "$D/noop-map.json" "$D/noop-map.prev.json"
cp "$STAGE/noop-map.json" "$D/noop-map.json.new" && mv -f "$D/noop-map.json.new" "$D/noop-map.json"
[ -n "$cur" ] && printf '%s\n' "$cur" > "$D/commit.prev"; printf '%s\n' "$new" > "$D/commit"
stepmark restart
restart_daemon
if ! step "$T_STEP" env AH_ENGINE_PLUGIN_ROOT="$D/plugin" CLAUDE_PLUGIN_ROOT="$D/plugin" "$D/bin/ah-engine" version >/dev/null 2>&1; then # live binary unusable: restore the previous one
  cp -p "$D/bin.prev/ah-engine" "$D/bin/ah-engine"; printf '%s\n' "$cur" > "$D/commit"; fail "swapped binary failed to run; restored previous"
fi
sset fails 0; sset next_try 0; sset last_ok "$(now)"; sset last_check "$(now)"; sset skip_commit ""
sset last_result "updated ${cur:-none} -> $new"; sset cur_step done
# pick up new helper scripts (update.sh, shadow2.sh, sync.sh) shipped on the branch; each is syntax-checked before an atomic rename
stepmark refresh
[ -f "$D/src/install-shadow-remote.sh" ] && step "$T_STEP" env AH_SHADOW_D="$D" sh "$D/src/install-shadow-remote.sh" --refresh-scripts >>"$LOG" 2>&1
log "UPDATED ${cur:-none} -> $new (fetch+build+smoke $(( $(now) - b0 ))s, version $(step "$T_STEP" env AH_ENGINE_PLUGIN_ROOT="$D/plugin" "$D/bin/ah-engine" version 2>/dev/null)); daemon restarted"
exit 0
UPEOF

cat > "$TMPD/sync.sh" <<'SYEOF'
#!/bin/sh
# Telemetry sync: at most once per sync.interval_s (default 1 h) commit and push the day's deltas to a PRIVATE telemetry repo.
# Modes: --auto (honors sync.enabled, the interval and the backoff; prints nothing) | --now (ignores interval and backoff; prints)
# Config ($D/config, key=value): sync.enabled (default true), sync.repo, sync.interval_s (default 3600).
# Folder pushed: <hostname>/<YYYY-MM-DD>/ with log-calls.ndjson + payloads.ndjson (deltas, appended), telemetry-summary.json +
# telemetry-events.json (the engine's own `telemetry` export), update.log, status.json. Append-only: plain push, never forced.
D="${AH_SHADOW_D:-$HOME/.anti-hall/ah-engine-shadow2}"
MODE=${1:---auto}
LOG="$D/sync.log"; ST="$D/sync.state"; CFGF="$D/config"; LOCKD="$D/sync.lock"; TR="$D/telemetry-repo"
DEFAULT_REPO=git@github.com:talas9/ah-shadow-telemetry.git
PATH="$HOME/.cargo/bin:$PATH"; export PATH
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
now() { date +%s; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null; }
out() { if [ "$MODE" = --now ]; then printf '%s\n' "$*"; fi; }
sget() { sed -n "s/^$1=//p" "$ST" 2>/dev/null | tail -1; }
sset() { { grep -v "^$1=" "$ST" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } > "$ST.tmp.$$" && mv -f "$ST.tmp.$$" "$ST"; }
num() { case "$1" in ''|*[!0-9]*) echo 0;; *) echo "$1";; esac; }
cfg() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,"");v=$0} END{print v}' "$CFGF" 2>/dev/null; }
TMO=; if command -v timeout >/dev/null 2>&1; then TMO="timeout"; fi
g() { git -C "$TR" "$@"; }
[ -f "$D/live.conf" ] && . "$D/live.conf"   # live mode: LIVE_HOME LIVE_BIN LIVE_STATE LIVE_ROOT LIVE_COMMIT (telemetry comes from the live engine)
NSLOG="$HOME/.anti-hall/ah-node-shadow/node-shadow.ndjson"

[ -f "$D/.shadow2-installed" ] || exit 0
case "$MODE" in --auto|--now) ;; *) exit 2 ;; esac
en=$(cfg sync.enabled)
case "$en" in false|0|off|no) out "sync is disabled (sync.enabled=$en in $CFGF)"; exit 0 ;; esac
repo=$(cfg sync.repo); [ -n "$repo" ] || repo=$DEFAULT_REPO
iv=$(num "$(cfg sync.interval_s)"); [ "$iv" -gt 0 ] || iv=3600
if [ "$MODE" = --auto ] && [ "$(now)" -lt "$(num "$(sget next_sync)")" ]; then exit 0; fi

acquire() {
  if mkdir "$LOCKD" 2>/dev/null; then echo $$ > "$LOCKD/pid"; return 0; fi
  op=$(cat "$LOCKD/pid" 2>/dev/null)
  if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then return 1; fi
  rm -rf "$LOCKD"; mkdir "$LOCKD" 2>/dev/null && echo $$ > "$LOCKD/pid" && return 0
  return 1
}
acquire || { out "another sync is running"; exit 0; }
finish() { rm -rf "$LOCKD" "$D/sync.tmp.$$"; }
trap finish 0; trap 'exit 143' TERM HUP INT
mkdir -p "$D/sync.tmp.$$"; W="$D/sync.tmp.$$"

fail() { n=$(num "$(sget fails)"); n=$((n+1)); d=300; i=1; while [ "$i" -lt "$n" ] && [ "$d" -lt "$iv" ]; do d=$((d*2)); i=$((i+1)); done; [ "$d" -gt "$iv" ] && d=$iv
  sset fails "$n"; sset next_sync "$(( $(now) + d ))"; sset last_result "failed: $1"
  log "FAILED: $1; backoff ${d}s (fail #$n)"; out "sync failed: $1"
  if [ "${noclean:-0}" = 1 ]; then :
  elif g rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then g reset -q --hard origin/main >/dev/null 2>&1; g clean -fdq >/dev/null 2>&1
  elif [ -d "$TR/.git" ]; then rm -rf "$TR"; fi   # nothing was ever pushed from this clone; deltas are re-derived from the offsets
  if [ "$MODE" = --now ]; then exit 1; fi; exit 0; }

# ---- clone + verify the remote BEFORE anything is written or pushed
if [ ! -d "$TR/.git" ]; then
  rm -rf "$TR.tmp"
  $TMO ${TMO:+120} git clone -q "$repo" "$TR.tmp" >"$D/sync-git.log" 2>&1 || fail "clone of $repo failed ($(head -c 200 "$D/sync-git.log" | tr '\n' ' '))"
  mv "$TR.tmp" "$TR" || fail "cannot move the clone into place"
fi
raw=$(g config --get remote.origin.url 2>/dev/null); have=$(g remote get-url origin 2>/dev/null); pu=$(g remote get-url --push origin 2>/dev/null)
if [ "$raw" != "$repo" ] || [ "$have" != "$repo" ] || [ "$pu" != "$repo" ]; then
  noclean=1; fail "remote of $TR is '$have' (push '$pu'), expected '$repo'; refusing to push"
fi
g config user.name "ah-shadow@$(hostname -s 2>/dev/null || echo host)"; g config user.email "ah-shadow@localhost.invalid"; g config commit.gpgsign false
$TMO ${TMO:+120} git -C "$TR" fetch -q origin >"$D/sync-git.log" 2>&1 || fail "fetch failed ($(head -c 200 "$D/sync-git.log" | tr '\n' ' '))"
if g rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then g checkout -q -B main origin/main >/dev/null 2>&1 || fail "cannot check out origin/main"
else g symbolic-ref HEAD refs/heads/main >/dev/null 2>&1 || fail "cannot start branch main"; fi

# ---- deltas (byte offsets in sync.state; advanced only after a successful push)
host=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown); host=$(printf '%s' "$host" | tr -c 'A-Za-z0-9._-' '_')
day=$(date -u +%Y-%m-%d); ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); dir="$TR/$host/$day"; mkdir -p "$dir" || fail "cannot create $dir"
delta() { f=$1; off=$(num "$2"); o=$3
  [ -f "$f" ] || { echo "$off 0"; return; }
  sz=$(wc -c < "$f" | tr -d ' ')
  [ "$sz" -lt "$off" ] && off=0
  [ "$sz" -gt "$off" ] || { echo "$off 0"; return; }
  tail -c +$((off+1)) "$f" | head -c $((sz-off)) > "$W/part"
  nl=$(wc -l < "$W/part" | tr -d ' ')
  head -n "$nl" "$W/part" > "$W/whole"; nb=$(wc -c < "$W/whole" | tr -d ' ')
  cat "$W/whole" >> "$o"; rm -f "$W/part" "$W/whole"
  echo "$((off+nb)) $nl"; }
: > "$W/pending"; lines_log=0; lines_pl=0
r=$(delta "$D/log-calls.ndjson" "$(sget log_off)" "$dir/log-calls.ndjson"); set -- $r; printf 'log_off=%s\n' "$1" >> "$W/pending"; lines_log=$2
if [ -d "$D/spool" ]; then
  for f in $(ls -1 "$D/spool" | grep -E '^payloads\.[0-9]+\.ndjson$' | sort -t. -k2 -n); do
    n=${f#payloads.}; n=${n%.ndjson}
    r=$(delta "$D/spool/$f" "$(sget "poff_$n")" "$dir/payloads.ndjson"); set -- $r; printf 'poff_%s=%s\n' "$n" "$1" >> "$W/pending"; lines_pl=$((lines_pl+$2))
  done
fi
r=$(delta "$NSLOG" "$(sget ns_off)" "$dir/node-shadow.ndjson"); set -- $r; printf 'ns_off=%s\n' "$1" >> "$W/pending"; lines_ns=$2
if [ "$((lines_log+lines_pl+lines_ns))" = 0 ]; then
  sset next_sync "$(( $(now) + iv ))"; sset last_result "nothing new"; log "nothing new to ship"; out "nothing new to ship"
  g reset -q --hard >/dev/null 2>&1; g clean -fdq >/dev/null 2>&1; exit 0
fi

# ---- the engine's own telemetry export (documented: `ah-engine telemetry summary|events`), plus update.log and status.json
eng() {
  if [ -n "${LIVE_BIN:-}" ]; then env HOME="$LIVE_HOME" AH_ENGINE_DIR="$LIVE_STATE" AH_ENGINE_PLUGIN_ROOT="$LIVE_ROOT" CLAUDE_PLUGIN_ROOT="$LIVE_ROOT" $TMO ${TMO:+60} "$LIVE_BIN" "$@"
  else env HOME="$D/home" AH_ENGINE_DIR="$D/state" AH_ENGINE_PLUGIN_ROOT="$D/plugin" CLAUDE_PLUGIN_ROOT="$D/plugin" $TMO ${TMO:+60} "$D/bin/ah-engine" "$@"; fi; }
for spec in 'summary:--window 7d' 'events:--window 7d --limit 2000'; do
  k=${spec%%:*}; a=${spec#*:}
  eng telemetry $k $a --json >"$dir/telemetry-$k.json" 2>"$W/err" </dev/null || printf '{"error":"telemetry %s export failed","detail":"%s"}\n' "$k" "$(head -c 160 "$W/err" | tr -d '\n\\"')" > "$dir/telemetry-$k.json"
done
cp "$D/update.log" "$dir/update.log" 2>/dev/null || : > "$dir/update.log"
if [ -n "${LIVE_BIN:-}" ] && [ -f "$HOME/.anti-hall/ah-node-shadow/node-shadow.sh" ]; then   # Node-vs-engine disagreements, engine-weaker first
  AH_ENGINE_BIN="$LIVE_BIN" $TMO ${TMO:+120} sh "$HOME/.anti-hall/ah-node-shadow/node-shadow.sh" --compare --window 7d --json >"$dir/node-vs-engine.json" 2>/dev/null </dev/null || rm -f "$dir/node-vs-engine.json"
fi
L="$D/log-calls.ndjson"
cnt() { c=$(grep "$@" 2>/dev/null); echo "${c:-0}"; }
jstr() { printf '%s' "$1" | tr -d '\n\r\\"' | head -c 200; }
printf '{"host":"%s","ts":"%s","commit":"%s","branch":"%s","binary_version":"%s","platform":"%s","calls_total":%s,"calls_blocked":%s,"calls_advised":%s,"odd_exit_codes":%s,"delta_log_lines":%s,"delta_payload_lines":%s,"delta_node_shadow_lines":%s,"spool_bytes":%s,"last_update_result":"%s","sync_fails_before":%s}\n' \
  "$host" "$ts" "$(jstr "${LIVE_COMMIT:-$(cat "$D/commit" 2>/dev/null)}")" "$(jstr "$([ -n "${LIVE_BIN:-}" ] && echo LIVE:engine-proto || cat "$D/branch" 2>/dev/null)")" "$(jstr "$(eng version 2>/dev/null </dev/null)")" \
  "$(jstr "$(sed -n 's/^platform=//p' "$D/.shadow2-installed" 2>/dev/null)")" \
  "$(wc -l < "$L" 2>/dev/null | tr -d ' ' || echo 0)" "$(cnt -c '"blocked":true' "$L")" "$(cnt -c '"advised":true' "$L")" \
  "$(cnt -vcE '"rc":(0|2|75),' "$L")" "$lines_log" "$lines_pl" "$lines_ns" "$(cat "$D"/spool/payloads.*.ndjson 2>/dev/null | wc -c | tr -d ' ')" \
  "$(jstr "$(sed -n 's/^last_result=//p' "$D/update.state" 2>/dev/null | tail -1)")" "$(num "$(sget fails)")" > "$dir/status.json"

# ---- commit + push (plain push, never forced; one pull --rebase retry if the remote moved)
g add -A -- "$host/$day" >/dev/null 2>&1
g commit -q -m "sync $host $ts (+$lines_log calls, +$lines_pl payloads, +$lines_ns node-shadow)" >"$D/sync-git.log" 2>&1 || fail "commit failed ($(head -c 200 "$D/sync-git.log" | tr '\n' ' '))"
push() { $TMO ${TMO:+120} git -C "$TR" push -q origin HEAD:refs/heads/main >"$D/sync-git.log" 2>&1; }
if ! push; then
  if $TMO ${TMO:+120} git -C "$TR" fetch -q origin >/dev/null 2>&1 && g rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1 \
     && $TMO ${TMO:+120} git -C "$TR" pull -q --rebase origin main >>"$D/sync-git.log" 2>&1 && push; then :
  else g rebase --abort >/dev/null 2>&1; fail "push failed ($(head -c 200 "$D/sync-git.log" | tr '\n' ' '))"; fi
fi
while IFS== read -r k v; do [ -n "$k" ] && sset "$k" "$v"; done < "$W/pending"
sset fails 0; sset last_ok "$(now)"; sset next_sync "$(( $(now) + iv ))"; sset last_result "pushed +$lines_log calls, +$lines_pl payloads"
log "PUSHED $host/$day +$lines_log calls +$lines_pl payloads to $repo"; out "pushed $host/$day: +$lines_log calls, +$lines_pl payloads"
exit 0
SYEOF
}

# ---------------------------------------------------------------- script install + config
install_scripts() { # atomic per file; a syntax error in a new shell script aborts before anything is replaced
  for f in update.sh shadow2.sh sync.sh; do sh -n "$TMPD/$f" || { say "internal: $f has a syntax error; scripts not refreshed" >&2; return 1; }; done
  for f in update.sh shadow2.sh jsonedit.py sync.sh; do
    cp "$TMPD/$f" "$D/$f.new.$$" && { case "$f" in *.sh) chmod +x "$D/$f.new.$$";; esac; mv -f "$D/$f.new.$$" "$D/$f"; } || return 1
  done
}
cfgset() { # cfgset key value: replace-or-append in $D/config
  { grep -v "^$1=" "$D/config" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } > "$D/config.tmp.$$" && mv -f "$D/config.tmp.$$" "$D/config"; }
init_config() { # defaults are written only when a key is absent; --no-sync forces sync.enabled=false
  grep -q '^sync\.enabled=' "$D/config" 2>/dev/null || cfgset sync.enabled true
  grep -q '^sync\.repo=' "$D/config" 2>/dev/null || cfgset sync.repo "$REPO_TELEMETRY"
  grep -q '^sync\.interval_s=' "$D/config" 2>/dev/null || cfgset sync.interval_s 3600
  # updater time limits, seconds (update.sh reads them on every run): whole run, --status warning, fetch, build, one short step, smoke hook, telemetry sync
  for kv in update.timeout_s=5400 update.warn_s=1800 update.fetch_timeout_s=120 update.build_timeout_s=3600 update.step_timeout_s=120 update.smoke_timeout_s=20 update.sync_timeout_s=600; do
    grep -q "^${kv%%=*}=" "$D/config" 2>/dev/null || cfgset "${kv%%=*}" "${kv#*=}"
  done
  [ "$NOSYNC" = 1 ] && cfgset sync.enabled false
  mkdir -p "$D/spool"; chmod 700 "$D/spool" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------- commands
need_python() { command -v python3 >/dev/null 2>&1 || die "python3 is not installed or not on PATH (needed to edit settings.json). Nothing was changed. Next step: install python3, then re-run"; }

LIVEKIT="$HOME/.anti-hall/ah-engine-live"
updater() { # updater --info|--stop: the embedded update.sh (works before/without a refreshed $D/update.sh; reads $D/config)
  [ -d "$D" ] || return 0
  emit_helpers; AH_SHADOW_D="$D" sh "$TMPD/update.sh" "$1"; }
cmd_status() {
  if [ -f "$LIVEKIT/state/live.json" ]; then
    say "MODE: LIVE (engine decides, Node falls back; --rollback-live to return to the shadow)"
    sh "$LIVEKIT/status.sh"; st=$?
    updater --info
    [ -f "$MARK" ] && say "shadow2 install kept for telemetry sync only: sync $(awk -F= '$1=="sync.enabled"{print $2}' "$D/config" 2>/dev/null), last result: $(sed -n 's/^last_result=//p' "$D/sync.state" 2>/dev/null | tail -1)"
    exit $st
  fi
  [ -f "$MARK" ] || { say "not installed ($D has no install marker)"; exit 0; }
  say "MODE: SHADOW (log-only; --live switches to the engine)"
  say "platform:     $PLATFORM"
  say "install dir:  $D"
  say "commit:       $(cat "$D/commit" 2>/dev/null || echo unknown)   (branch $(cat "$D/branch" 2>/dev/null))"
  say "binary:       $(env AH_ENGINE_PLUGIN_ROOT="$D/plugin" "$D/bin/ah-engine" version 2>/dev/null || echo MISSING)"
  st="$D/update.state"
  g() { sed -n "s/^$1=//p" "$st" 2>/dev/null | tail -1; }
  lo=$(g last_ok); lt=$(g last_try); nt=$(g next_try)
  fmt() { case "$1" in ''|0) echo never;; *) date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$1";; esac; }
  say "last update:  $(fmt "$lo")   last try: $(fmt "$lt")   result: $(g last_result)"
  say "backoff:      fails=$(g fails) next_try=$(fmt "$nt")   skip_commit=$(g skip_commit)"
  updater --info
  L="$D/log-calls.ndjson"
  if [ -f "$L" ]; then
    say "calls:        $(wc -l < "$L" | tr -d ' ') total, $(grep -c '"blocked":true' "$L") blocked, $(grep -c '"advised":true' "$L") advised, $(grep -c '"deferred":true' "$L") deferred, $(grep -vcE '"rc":(0|2|75),' "$L") odd exit codes"
    sed -n 's/.*"ev":"\([^"]*\)".*/\1/p' "$L" | sort | uniq -c | sort -rn | head -8 | sed 's/^/               /'
  else say "calls:        none yet"; fi
  if [ -f "$D/update.log" ]; then say "update.log (last 5):"; tail -5 "$D/update.log" | sed 's/^/  /'; fi
  sg() { sed -n "s/^$1=//p" "$D/sync.state" 2>/dev/null | tail -1; }
  cg() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,"");v=$0} END{print v}' "$D/config" 2>/dev/null; }
  say "sync:         enabled=$(cg sync.enabled) repo=$(cg sync.repo) interval_s=$(cg sync.interval_s) last_ok=$(fmt "$(sg last_ok)") next=$(fmt "$(sg next_sync)") fails=$(sg fails) result: $(sg last_result)"
  say "spool:        $(cat "$D"/spool/payloads.*.ndjson 2>/dev/null | wc -l | tr -d ' ') payload lines, $(cat "$D"/spool/payloads.*.ndjson 2>/dev/null | wc -c | tr -d ' ') bytes"
  d=$(env HOME="$D/home" AH_ENGINE_DIR="$D/state" "$D/bin/ah-engine" status 2>/dev/null | sed -n 's/^running: *//p' | head -1)
  say "daemon:       running=${d:-unknown}"
  exit 0
}

# ---------------------------------------------------------------- live mode
# live_triple: the Rust target triple of this machine (Rosetta: a translated x86_64 shell on Apple Silicon gets the arm64 build).
live_triple() {
  _os=$(uname -s 2>/dev/null); _m=$(uname -m 2>/dev/null)
  case "$_os/$_m" in
    Linux/x86_64|Linux/amd64) echo x86_64-unknown-linux-gnu ;;
    Linux/aarch64|Linux/arm64) echo aarch64-unknown-linux-gnu ;;
    Darwin/arm64) echo aarch64-apple-darwin ;;
    Darwin/x86_64)
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then say "note: running under Rosetta on Apple Silicon, using the arm64 build" >&2; echo aarch64-apple-darwin
      else echo x86_64-apple-darwin; fi ;;
    *) return 1 ;;
  esac
}

# live_download_bin SHA OUT: fetch the ah-engine-bins artifact built for exactly SHA with gh, verify its sha256, smoke-test it, copy to OUT.
# Returns 1 with DL_WHY set when it is simply unavailable (no gh/auth/run/artifact); a checksum mismatch is fatal (die).
live_download_bin() {
  DL_WHY=
  _tr=$(live_triple) || { DL_WHY="no prebuilt engine for this platform ($(uname -s)/$(uname -m))"; return 1; }
  command -v gh >/dev/null 2>&1 || { DL_WHY="gh (GitHub CLI) is not installed"; return 1; }
  ilim 30 gh auth status >/dev/null 2>&1 || { DL_WHY="gh is not authenticated (run: gh auth login)"; return 1; }
  _slug=$(printf '%s' "$REPO_HTTPS" | sed 's#^https://github.com/##; s#\.git$##')
  _rid=$(ilim 60 gh run list -R "$_slug" --workflow ah-engine-bins.yml --commit "$1" --status success --json databaseId -L 1 2>/dev/null | sed -n 's/.*"databaseId": *\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -n "$_rid" ] || { DL_WHY="no successful ah-engine-bins run for commit $1 yet (CI still building, or older than the 14-day retention)"; return 1; }
  _an="ah-engine-$_tr-$(printf '%s' "$1" | cut -c1-8)"; _dd="$TMPD/dl"; rm -rf "$_dd"; mkdir -p "$_dd"
  say "downloading $_an (run $_rid)"
  ilim 300 gh run download "$_rid" -R "$_slug" -n "$_an" -D "$_dd" >"$TMPD/dl.err" 2>&1 || { DL_WHY="artifact download failed: $(head -c 200 "$TMPD/dl.err" | tr '\n' ' ')"; return 1; }
  _f=$(find "$_dd" -type f -name ah-engine | head -1); _c=$(find "$_dd" -type f -name ah-engine.sha256 | head -1)
  [ -n "$_f" ] && [ -n "$_c" ] || { DL_WHY="artifact $_an lacks ah-engine or ah-engine.sha256"; return 1; }
  _want=$(awk '{print $1; exit}' "$_c"); _got=$(sha "$_f")
  [ -n "$_want" ] && [ "$_want" = "$_got" ] || die "checksum mismatch for the downloaded $_an (expected ${_want:-none}, got $_got); the download was discarded. $(live_state). Next step: re-run the same command to download again; if it repeats, pass --bin PATH"
  chmod +x "$_f"
  _v=$("$_f" version 2>&1) && case "$_v" in [0-9]*) ;; *) false ;; esac || { DL_WHY="the downloaded engine does not run here: $_v"; return 1; }
  cp "$_f" "$2" || die "cannot copy the downloaded engine"
  say "using prebuilt $_an (sha256 verified, version $_v)"
}

cmd_live() {
  SRC_KIT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/live
  for t in git node; do command -v "$t" >/dev/null 2>&1 || die "$t not found (--live needs git and node)"; done
  command -v "${AH_LIVE_CLAUDE:-claude}" >/dev/null 2>&1 || die "claude CLI not found on PATH (the plugin is installed through it); set AH_LIVE_CLAUDE if it lives elsewhere"
  [ -f "$SRC_KIT/go-live.sh" ] && [ -f "$SRC_KIT/node-shadow.sh" ] && [ -f "$SRC_KIT/node-shadow.skip" ] && [ -f "$SRC_KIT/reload-notice.sh" ] || die "$SRC_KIT is missing: git pull the $BRANCH branch next to this script"
  ALREADY_LIVE=0; [ -f "$LIVEKIT/state/live.json" ] && ALREADY_LIVE=1   # already live: the engine and plugin are updated through hooks/ah-update.sh (no rollback first)
  case "$CHANNEL" in ""|stable|dev) ;; *) usage "--channel must be stable or dev" ;; esac
  [ -z "$CHANNEL" ] || [ -z "$FROMF" ] || usage "--channel and --from are alternatives; pass only one"
  [ -z "$FROMF" ] || [ -f "$FROMF" ] || die "--from: file not found: $FROMF. Nothing was changed. Check the path and re-run the same command with the right --from FILE"
  [ -d "$D/update.lock" ] && { updater --stop || die "could not stop the running shadow update"; }   # a running/stuck updater is stopped (it keeps the installed version), never a reason to refuse
  if [ -f "$MARK" ]; then emit_helpers; install_scripts || die "could not refresh the shadow helper scripts"; init_config; fi   # sync.sh learns live.conf
  mkdir -p "$LIVEKIT/state" || die "cannot create $LIVEKIT"
  if [ "$ALREADY_LIVE" = 0 ]; then
    for f in lib.sh go-live.sh rollback.sh status.sh node-shadow.sh node-shadow.skip agreed-checks.txt reload-notice.sh; do cp "$SRC_KIT/$f" "$LIVEKIT/$f.new" && mv -f "$LIVEKIT/$f.new" "$LIVEKIT/$f" || die "cannot install $f"; done
    chmod +x "$LIVEKIT"/*.sh
  fi
  # 1 the source: engine-proto (newer or equal to 8c9a332), cloned over SSH then HTTPS like the shadow
  LS="$LIVEKIT/src"; urls=$REPO_SSH; https=$REPO_HTTPS; [ -n "$LIVE_REPO" ] && { urls=$LIVE_REPO; https=; }
  ok=0
  if [ -d "$LS/.git" ]; then
    for u in $urls $https; do
      say "fetching $u ($LIVE_BRANCH)"
      if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" ilim 180 git -C "$LS" fetch -q --depth 1 "$u" "$LIVE_BRANCH" 2>"$TMPD/clone.err" && ilim 60 git -C "$LS" reset -q --hard FETCH_HEAD; then ok=1; break; fi
    done
  else
    rm -rf "$LS"
    for u in $urls $https; do
      say "cloning $u ($LIVE_BRANCH)"
      if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" ilim 300 git clone -q --depth 1 --branch "$LIVE_BRANCH" "$u" "$LS" 2>"$TMPD/clone.err"; then ok=1; break; fi
      say "  failed: $(head -c 200 "$TMPD/clone.err" | tr '\n' ' ')"; rm -rf "$LS"
    done
  fi
  [ "$ok" = 1 ] || die "could not download branch $LIVE_BRANCH from $urls $https (network, access or branch missing). $(live_state). Next step: check the network and retry; if the branch is not published yet, retry later"
  lc=$(git -C "$LS" rev-parse HEAD)
  PR="$LS/plugins/anti-hall"
  [ -f "$LS/ah-engine/Cargo.toml" ] && [ -f "$PR/hooks/ah-fallback.map.json" ] && [ -f "$PR/engine/defaults/index.toml" ] || die "branch $LIVE_BRANCH ($lc) has no ah-engine/ and a plugin with hooks/ah-fallback.map.json + engine/defaults"
  [ ! -e "$PR/ah-engine.lock" ] || die "plugin ships ah-engine.lock (its bootstrap would replace the installed engine)"
  pv=$(node -p 'require(process.argv[1]).version' "$PR/.claude-plugin/plugin.json") || die "cannot read the plugin version"
  node -e 'const a=process.argv[1].split(".").map(Number),b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}' "$pv" "$LIVE_MIN_VERSION" || die "plugin $pv on $LIVE_BRANCH is older than $LIVE_MIN_VERSION (engine-proto 8c9a332)"
  say "source: $LIVE_BRANCH $lc (plugin $pv)"
  # ah-update arguments for --channel / --from / --bin (empty: none given)
  AU="$PR/hooks/ah-update.sh"; AUARGS=
  if [ -n "$FROMF" ]; then AUARGS="--from $FROMF"; [ -z "$SHA256" ] || AUARGS="$AUARGS --sha256 $SHA256"; [ "$YES" = 0 ] || AUARGS="$AUARGS --yes"
  elif [ -n "$CHANNEL" ]; then AUARGS="--channel $CHANNEL"
  elif [ "$ALREADY_LIVE" = 1 ] && [ -n "$BIN" ]; then AUARGS="--from $BIN --yes"   # --bin is trusted to match the branch tip (as without --live)
  elif [ "$ALREADY_LIVE" = 1 ]; then AUARGS="--channel dev"
  fi
  if [ "$ALREADY_LIVE" = 1 ]; then
    [ -f "$AU" ] || die "cannot update: branch $LIVE_BRANCH ($lc) does not ship the updater (hooks/ah-update.sh) yet, so this update channel is not published. $(live_state). Next step: re-run the same command once the branch publishes it, or update now with --from FILE / --bin PATH. (Old way, only if you must: sh $0 --rollback-live, then sh $0 --live)"
    say "already live: updating through hooks/ah-update.sh ($AUARGS)"
    # shellcheck disable=SC2086 # AUARGS is a list of words by construction
    sh "$AU" $AUARGS --live-select "$LIVE_SELECT" </dev/null; rc=$?
    return "$rc"
  fi
  # 2 the engine binary: --bin, else the prebuilt CI artifact for exactly $lc (gh), else build ONLY when allowed (--allow-build / AH_LIVE_BUILD=1)
  STB="$TMPD/live-bin"
  if [ -n "$AUARGS" ]; then
    [ -f "$AU" ] || die "branch $LIVE_BRANCH ($lc) does not ship the updater (hooks/ah-update.sh) yet, so the --channel/--from update path is not available. Nothing was changed. Next step: re-run with --bin PATH (a prebuilt ah-engine), or retry once the branch publishes it"
    # shellcheck disable=SC2086
    sh "$AU" $AUARGS --extract-to "$STB" </dev/null || die "the updater could not fetch or verify an engine ($AUARGS); see its output above. $(live_state). Next step: check the network and retry the same command, or pass --from FILE / --bin PATH"
    if [ -f "$STB.commit" ]; then   # a dev pre-release records the commit it was built from: take the plugin from exactly that commit
      uc=$(tr -d ' \n\r' <"$STB.commit")
      if [ -n "$uc" ] && [ "$uc" != "$lc" ]; then
        say "the engine was built from $uc: fetching that commit for the plugin"
        okc=0
        for u in $urls $https; do
          if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" ilim 180 git -C "$LS" fetch -q --depth 1 "$u" "$uc" 2>"$TMPD/clone.err" && ilim 60 git -C "$LS" reset -q --hard FETCH_HEAD; then okc=1; break; fi
        done
        [ "$okc" = 1 ] || die "cannot fetch commit $uc from $urls $https"
        lc=$(git -C "$LS" rev-parse HEAD); say "source is now $lc"
        pv=$(node -p 'require(process.argv[1]).version' "$PR/.claude-plugin/plugin.json") || die "cannot read the plugin version at $lc"
      fi
    fi
  elif [ -n "$BIN" ]; then cp "$BIN" "$STB" || die "cannot copy --bin"; say "using prebuilt binary $BIN (assumed to match $lc)"
  elif live_download_bin "$lc" "$STB"; then :
  elif [ "$ALLOW_BUILD" != 1 ]; then
    die "no prebuilt engine is available for $lc: $DL_WHY. $(live_state). Next step: retry after the CI build for that commit finishes, or supply one with --bin PATH (built by the ah-engine-bins workflow), or after 'gh auth login' re-run this; to compile locally anyway (slow, heavy) add --allow-build or set AH_LIVE_BUILD=1"
  else
    PATH="$HOME/.cargo/bin:$PATH"; export PATH
    command -v cargo >/dev/null 2>&1 || die "cargo not found. Install rustup (https://rustup.rs) or pass --bin PATH"
    TD="$LIVEKIT/target"; [ -d "$D/target" ] && TD="$D/target"
    say "building ah-engine at $lc (nice, $BUILD_JOBS jobs; minutes on a cold cache; log $LIVEKIT/build.log)"
    ( cd "$LS/ah-engine" && CARGO_BUILD_JOBS="$BUILD_JOBS" CARGO_TARGET_DIR="$TD" ilim 3600 nice -n 19 cargo build --release --locked ) >"$LIVEKIT/build.log" 2>&1 || { tail -5 "$LIVEKIT/build.log" >&2; die "cargo build failed"; }
    cp "$TD/release/ah-engine" "$STB" || die "built binary missing"
  fi
  chmod +x "$STB"
  bv=$(env AH_ENGINE_PLUGIN_ROOT="$PR" CLAUDE_PLUGIN_ROOT="$PR" "$STB" version 2>&1) || die "the engine binary does not run here: $bv"
  case "$bv" in [0-9]*) ;; *) die "unexpected engine version output: $bv" ;; esac
  # 3 the bundle the kit installs from (an existing one is moved aside, never overwritten)
  B="$LIVEKIT/bundle"; [ -e "$B" ] && mv "$B" "$B.$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$B" && cp "$STB" "$B/ah-engine" && cp -R "$PR" "$B/plugin" || die "cannot assemble the bundle"
  printf 'source: branch %s HEAD %s, plugin %s\nengine version: %s\n%s  bundle/ah-engine\nbuilt: %s on %s\n' "$LIVE_BRANCH" "$lc" "$pv" "$bv" "$(sha "$B/ah-engine")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PLATFORM" > "$B/PROVENANCE.txt"
  # 4 switch (go-live.sh validates first, backs settings.json up, rolls itself back on any failure)
  say "going live (select: $LIVE_SELECT)"
  sh "$LIVEKIT/go-live.sh" "$LIVE_SELECT" || die "go-live failed and was rolled back; your previous setup is restored and active (details: $LIVEKIT/state/kit.log). Next step: fix the cause shown above, then re-run sh $0 --live"
  [ -f "$D/live.conf" ] && printf 'LIVE_COMMIT=%s\n' "$lc" >> "$D/live.conf"
  say "LIVE. Restart Claude Code sessions (or /reload-plugins). Check: sh $0 --status   Compare Node vs engine: sh $HOME/.anti-hall/ah-node-shadow/node-shadow.sh --compare   Undo: sh $0 --rollback-live"
  return 0
}

case "$MODE" in
  status) cmd_status ;;
  refresh)
    [ -f "$MARK" ] || exit 0
    emit_helpers; install_scripts || exit 1; init_config; exit 0 ;;
  sync)
    [ -f "$MARK" ] || die "the shadow is not installed, so there is nothing to do. Next step: install it with sh $0"
    [ -f "$D/sync.sh" ] || die "sync.sh missing: re-run this installer once to upgrade the helper scripts"
    AH_SHADOW_D="$D" sh "$D/sync.sh" --now; rc=$?
    say "sync.log (last 3):"; tail -3 "$D/sync.log" 2>/dev/null | sed 's/^/  /'
    exit $rc ;;
  update|rollback)
    [ -f "$MARK" ] || die "the shadow is not installed, so there is nothing to do. Next step: install it with sh $0"
    flag=--now; [ "$MODE" = rollback ] && flag=--rollback
    AH_SHADOW_D="$D" sh "$D/update.sh" $flag; rc=$?
    if [ "$MODE" = update ]; then say "update.log (last 3):"; tail -3 "$D/update.log" 2>/dev/null | sed 's/^/  /'; fi
    exit $rc ;;
esac

if [ "$MODE" = rollbacklive ]; then
  [ -f "$LIVEKIT/state/live.json" ] || die "live mode is not on (no $LIVEKIT/state/live.json), so there is nothing to roll back. Nothing was changed. Next step: sh $0 --live to go live"
  [ -d "$D/update.lock" ] && updater --stop
  # forward --force (and nothing else this mode does not own) to the kit; stdin from /dev/null so nothing can wait on a TTY
  rb_args=; [ "$FORCE" = 1 ] && rb_args=--force
  sh "$LIVEKIT/rollback.sh" $rb_args </dev/null || { say "rollback did not finish cleanly. It is resumable: re-run '$0 --rollback-live' (add --force if it refused over your own edits). Log: $LIVEKIT/state/kit.log"; exit 1; }
  say "back to MODE: SHADOW (settings.json restored byte-identical). Restart Claude Code sessions."; exit 0
fi
if [ "$MODE" = live ]; then cmd_live; exit $?; fi
if [ "$MODE" = uninstall ]; then
  [ ! -f "$LIVEKIT/state/live.json" ] || die "live mode is on, so the shadow cannot be uninstalled yet. Nothing was changed. Next step: sh $0 --rollback-live, then re-run this command"
  [ -f "$MARK" ] || { say "nothing to uninstall (no install marker at $MARK)"; exit 0; }
  need_python; emit_helpers
  if [ -d "$D/update.lock" ]; then
    op=$(cat "$D/update.lock/pid" 2>/dev/null)
    if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then die "a shadow update is running (pid $op), so this was not started. Nothing was changed. Next step: retry in a minute"; fi
  fi
  cur=$(sha "$SETTINGS" 2>/dev/null || echo none); post=$(cat "$D/settings.post.sha" 2>/dev/null || echo unknown)
  if [ "$cur" = "$post" ] && [ -f "$D/settings.json.bak" ]; then
    cp -p "$D/settings.json.bak" "$SETTINGS" || die "restoring settings.json from the backup failed. Next step: copy $D/settings.json.bak over $SETTINGS by hand, then re-run"
    say "settings.json restored from backup (byte-identical)"
  elif [ "$cur" = "$post" ] && [ -f "$D/settings.absent" ]; then
    rm -f "$SETTINGS"; say "settings.json removed (it did not exist before the install)"
  elif [ "$FORCE" = 1 ]; then
    if [ -f "$SETTINGS" ]; then python3 "$TMPD/jsonedit.py" remove "$SETTINGS" || die "could not edit $SETTINGS"; fi
    say "removed only the shadow entries from settings.json (it changed since install)"
  else
    die "settings.json changed since the install, so restoring the backup would drop those changes. Nothing was changed. Next step: re-run with --force to remove only the shadow entries; the backup stays at $D/settings.json.bak"
  fi
  if [ -x "$D/bin/ah-engine" ]; then env HOME="$D/home" AH_ENGINE_DIR="$D/state" "$D/bin/ah-engine" stop >/dev/null 2>&1; fi
  case "$D" in */.anti-hall/ah-engine-shadow2) ;; *) die "internal: unexpected install dir $D" ;; esac
  for x in bin bin.prev plugin plugin.prev src target noop-map.json noop-map.prev.json shadow2.sh update.sh sync.sh jsonedit.py update.stamp update.lock commit commit.prev branch repo.url repo.https .shadow2-installed; do rm -rf "${D:?}/$x"; done
  rm -rf "$D"/stage.*
  : > "$D/.shadow2-uninstalled"
  say "uninstalled; kept in $D: log-calls.ndjson, spool/, telemetry-repo/, config, sync.state, sync.log, update.log, update.state, build.log, state/, settings.json.bak"
  exit 0
fi

# ================================================================ install
[ "$MODE" = install ] || die "internal: unhandled mode $MODE"
say "platform: $PLATFORM"
case "$(uname -s)" in Darwin|Linux) ;; *) die "unsupported OS $(uname -s); this installer supports macOS, Linux and WSL2 only. Nothing was changed" ;; esac
case "$HOME" in /mnt/*) die "HOME ($HOME) is on a Windows drive (DrvFs): Unix sockets and file locks are unreliable there; use a HOME on the Linux filesystem" ;; esac
if [ "$(uname -s)" = Linux ]; then
  fsl=$(df -P -T "$HOME" 2>/dev/null | awk 'NR==2{print $2}')
  case "$fsl" in 9p|drvfs|drvfsa|fuseblk|vboxsf) die "HOME is on a $fsl filesystem (Windows share): use the Linux filesystem" ;; esac
fi
case "$PLATFORM" in Linux/wsl2) say "WSL2 detected: all state stays on the Linux filesystem under $HOME; no systemd is used (the updater is started by the hook itself)" ;; Linux/wsl) say "WSL detected (not confirmed as WSL2); proceeding on the Linux filesystem" ;; esac
command -v git >/dev/null 2>&1 || die "git is not installed or not on PATH. Nothing was changed. Next step: install git, then re-run"
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
    install_scripts || die "could not refresh the helper scripts"; init_config
    say "already installed; settings.json untouched; helper scripts refreshed (telemetry sync $(awk -F= '$1=="sync.enabled"{print $2}' "$D/config")). Use --status."
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
  if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new" ilim 300 git clone -q --depth 1 --branch "$BRANCH" "$u" "$src" 2>"$TMPD/clone.err"; then ok=1; break; fi
  say "  failed: $(head -c 200 "$TMPD/clone.err" | tr '\n' ' ')"
  rm -rf "$src"
done
[ "$ok" = 1 ] || die "could not download branch $BRANCH from $urls $https (network, access or branch missing). Nothing was installed. Next step: check the network and retry; if the branch is not published yet, retry later"
commit=$(git -C "$src" rev-parse HEAD)
[ -f "$src/ah-engine/Cargo.toml" ] && [ -d "$src/plugins/anti-hall/hooks" ] || die "the branch $BRANCH has no ah-engine/ and plugins/anti-hall/"

STG="$D/stage.install"; rm -rf "$STG"; mkdir -p "$STG"
if [ -n "$BIN" ]; then
  cp "$BIN" "$STG/ah-engine" || die "cannot copy --bin"
  say "using prebuilt binary $BIN (assumed to match $commit)"
else
  say "building ah-engine at $commit (nice, 2 jobs; several minutes on a cold cache)"
  t0=$(date +%s)
  ( cd "$src/ah-engine" && CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR="$D/target" ilim 3600 nice -n 19 cargo build --release --locked ) >"$D/build.log" 2>&1 \
    || { tail -5 "$D/build.log" >&2; die "cargo build failed"; }
  cp "$D/target/release/ah-engine" "$STG/ah-engine" || die "built binary missing"
  say "built in $(( $(date +%s) - t0 )) s"
fi
chmod +x "$STG/ah-engine"
cp -R "$src/plugins/anti-hall" "$STG/plugin" || die "cannot copy the plugin tree"
python3 "$TMPD/jsonedit.py" noopmap "$STG/plugin/hooks/ah-fallback.map.json" "$STG/noop-map.json" || die "cannot derive the no-op hook map"
install_scripts || die "cannot install the helper scripts"; init_config
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
say "commit $commit, binary $(env AH_ENGINE_PLUGIN_ROOT="$D/plugin" "$D/bin/ah-engine" version 2>/dev/null)"
say "telemetry: payloads spooled to $D/spool; hourly push to $(awk -F= '$1=="sync.repo"{print $2}' "$D/config") (enabled=$(awk -F= '$1=="sync.enabled"{print $2}' "$D/config"); --no-sync to disable, --sync-now to push now)"
say "log: $D/log-calls.ndjson   status: sh $0 --status   undo: sh $0 --uninstall"
say "restart Claude Code sessions (or open /hooks) for the new triggers to load"
exit 0

#!/bin/sh
# Two forms. (1) Skill launcher: `ah-run.sh <verb> [args...]` runs `ah-engine <verb> ...` when the engine answers, else the verb's Node script.
#   ah-run.sh <verb> [args...]      verbs: settings jev-setup jev-report briefing capability-scan defect harvest
#                                         install-statusline uninstall-statusline update install-codex doctor
# The engine is looked up as ah-hook.sh does: $HOME/.anti-hall/ah-engine/bin/ah-engine, then PATH.
# Node runs instead when the engine is absent or not runnable (126/127), cannot load this plugin's defaults (70),
# or defers the call (75: nothing written). Any other engine exit is the answer and is passed through.
# (2) Generic form below: `ah-run.sh [--stdin] <engine-word>... -- <node-script> [<argument>...]`.
case ${1:-} in
  settings | jev-setup | jev-report | briefing | capability-scan | defect | harvest | install-statusline | uninstall-statusline | update | install-codex | doctor)
    here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || here=.
    root=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd) || root=$here/..
    verb=${1:-}
    [ $# -gt 0 ] && shift
    case $verb in
      settings) js=scripts/settings.js ;;
      jev-setup) js=scripts/jev-setup.js ;;
      jev-report) js=scripts/jev-report.js ;;
      briefing) js=scripts/briefing.js ;;
      capability-scan) js=scripts/capability-scan.js ;;
      defect) js=scripts/defect.js ;;
      harvest) js=scripts/harvest-debt.js ;;
      install-statusline) js=statusline/install-statusline.js ;;
      uninstall-statusline) js=statusline/uninstall-statusline.js ;;
      update) js=skills/update/scripts/update.js ;;
      install-codex) js=codex/install-codex.js ;;
      doctor) js=hooks/doctor.js ;;
    esac
    engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
    [ -x "$engine" ] || engine=$(command -v ah-engine 2>/dev/null || true)
    if [ -n "$engine" ] && [ -x "$engine" ]; then
      AH_ENGINE_PLUGIN_ROOT=${AH_ENGINE_PLUGIN_ROOT:-$root} "$engine" "$verb" "$@"
      rc=$?
      case $rc in 70 | 75 | 126 | 127) ;; *) exit "$rc" ;; esac
    fi
    exec node "$root/$js" "$@"
    ;;
esac

# Thin launcher for a plugin command that has two implementations: the engine (`ah-engine`) and the Node script it replaced.
# The engine runs it when it is installed; the Node script runs it when the engine is absent or answers "leave this to Node".
#
#   ah-run.sh [--stdin] <engine-word>... -- <node-script> [<argument>...]
#
#   --stdin          the command reads the host's JSON on stdin (the status line): it is read once and handed to whichever
#                    implementation runs, so a deferral loses nothing.
#   <engine-word>... the words of `ah-engine` that name the command (`statusline`, `devswarm wake-watch`).
#   <node-script>    the Node script to run instead (an absolute path).
#   <argument>...    given to both: the engine after its words, the Node script after its path.
#
# The engine answers exit 75 ("leave this to Node": nothing was printed or written), 64 (the verb is refused for this role), 70
# (it cannot load its settings), or the shell's 126/127 (not executable, not found): the Node script runs then. Any other
# exit is the command's own and is passed on; a death by signal is never "retried" in Node (a killed command stays killed).
#
# The engine is found where the hook wrapper finds it: $HOME/.anti-hall/ah-engine/bin/ah-engine, then PATH. The test-only
# AH_ENGINE_BIN is honoured only with AH_WRAPPER_TEST=1.

# A word quoted so `eval set --` restores it exactly.
quote() {
  _rest=$1
  _out=
  while :; do
    case $_rest in
      *\'*)
        _out="$_out${_rest%%\'*}'\\''"
        _rest=${_rest#*\'}
        ;;
      *) break ;;
    esac
  done
  printf "'%s'" "$_out$_rest"
}

usage() {
  printf 'ah-run.sh: usage: ah-run.sh [--stdin] <engine-word>... -- <node-script> [<argument>...]\n' >&2
  exit 64
}

stdin_mode=0
if [ "${1:-}" = --stdin ]; then
  stdin_mode=1
  shift
fi
engine_words=
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  engine_words="$engine_words $(quote "$1")"
  shift
done
[ "${1:-}" = -- ] || usage
shift
node_script=${1:-}
[ -n "$node_script" ] || usage
shift
shared=
for a in "$@"; do
  shared="$shared $(quote "$a")"
done
engine_args="$engine_words$shared"

here=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
plugin_root=$(dirname "$here")
AH_ENGINE_PLUGIN_ROOT=$plugin_root
export AH_ENGINE_PLUGIN_ROOT

engine=
if [ "${AH_WRAPPER_TEST:-}" = 1 ] && [ -n "${AH_ENGINE_BIN:-}" ]; then
  [ -x "$AH_ENGINE_BIN" ] && engine=$AH_ENGINE_BIN
elif [ -x "${HOME:-}/.anti-hall/ah-engine/bin/ah-engine" ]; then
  engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
else
  engine=$(command -v ah-engine 2>/dev/null || true)
fi

input=
if [ "$stdin_mode" -eq 1 ]; then
  # the trailing x keeps the final newlines that command substitution would strip
  input=$(cat; printf x)
  input=${input%x}
fi

run_node() {
  if [ "$stdin_mode" -eq 1 ]; then
    printf '%s' "$input" | eval "node \"\$node_script\" $shared"
  else
    eval "exec node \"\$node_script\" $shared"
  fi
  exit $?
}

[ -n "$engine" ] || run_node

eval "set -- $engine_args"
if [ "$stdin_mode" -eq 1 ]; then
  printf '%s' "$input" | "$engine" "$@"
  rc=$?
else
  # Long-running (a Monitor): run the engine as a child so a deferral can still fall back, and pass SIGTERM/SIGINT on to it.
  signalled=0
  "$engine" "$@" </dev/null &
  pid=$!
  trap 'signalled=1; kill -TERM "$pid" 2>/dev/null' TERM
  trap 'signalled=1; kill -INT "$pid" 2>/dev/null' INT
  wait "$pid"
  rc=$?
  if [ "$signalled" -eq 1 ]; then
    wait "$pid" 2>/dev/null
    rc=$?
    exit "$rc"
  fi
fi

case "$rc" in
  75 | 64 | 70 | 126 | 127) run_node ;;
esac
exit "$rc"

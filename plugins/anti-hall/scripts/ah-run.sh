#!/bin/sh
# Launcher for a plugin command that the engine (`ah-engine`) implements. Two forms.
# (1) Skill launcher: `ah-run.sh <verb> [args...]` runs `ah-engine <verb> ...`.
#   verbs: settings jev-setup jev-report briefing capability-scan defect harvest install-statusline uninstall-statusline
#          update install-codex doctor
# (2) Generic form: `ah-run.sh [--stdin] <engine-word>... -- <legacy-script> [<argument>...]`
#   --stdin          the command reads the host's JSON on stdin (the status line): it is handed to the engine unchanged.
#   <engine-word>... the words of `ah-engine` that name the command (`statusline`, `devswarm wake-watch`).
#   <legacy-script>  accepted and ignored: installed settings from earlier versions still name it. Nothing but the engine runs.
#   <argument>...    given to the engine after its words.
# The engine is looked up as ah-hook.sh does: $HOME/.anti-hall/ah-engine/bin/ah-engine, then PATH (the test-only AH_ENGINE_BIN is
# honoured only with AH_WRAPPER_TEST=1). Every engine exit is the command's own and is passed through. When no engine can run
# the command, nothing else runs: one line (msg.run_engine_missing) goes to stderr and the exit is 127; the status line, which
# is cosmetic, stays silent and exits 0.
here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || here=.
root=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd) || root=$here/..

# The text of one [msg.<key>] table of the plugin's messages.toml (empty when absent).
message() {
  awk -v want="[msg.$1]" '
    $0 == want { in_key = 1; next }
    in_key && /^\[/ { exit }
    in_key && $1 == "value" && $2 == "=" {
      v = $0
      sub(/^[^"]*"/, "", v)
      sub(/".*$/, "", v)
      print v
      exit
    }
  ' "$root/engine/defaults/messages.toml" 2>/dev/null
}

engine_missing() {
  mm_text=$(message run_engine_missing)
  [ -z "$mm_text" ] || printf '%s\n' "$mm_text" | sed "s/{what}/$1/g" >&2
  exit 127
}

find_engine() {
  engine=
  if [ "${AH_WRAPPER_TEST:-}" = 1 ] && [ -n "${AH_ENGINE_BIN:-}" ]; then
    [ -x "$AH_ENGINE_BIN" ] && engine=$AH_ENGINE_BIN
  elif [ -x "${HOME:-}/.anti-hall/ah-engine/bin/ah-engine" ]; then
    engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
  else
    engine=$(command -v ah-engine 2>/dev/null || true)
  fi
}

AH_ENGINE_PLUGIN_ROOT=${AH_ENGINE_PLUGIN_ROOT:-$root}
export AH_ENGINE_PLUGIN_ROOT

case ${1:-} in
  settings | jev-setup | jev-report | briefing | capability-scan | defect | harvest | install-statusline | uninstall-statusline | update | install-codex | doctor)
    verb=$1
    shift
    find_engine
    [ -n "$engine" ] || engine_missing "$verb"
    exec "$engine" "$verb" "$@"
    ;;
esac

stdin_mode=0
if [ "${1:-}" = --stdin ]; then
  stdin_mode=1
  shift
fi
# the engine words, up to the `--`
words=
n=0
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  n=$((n + 1))
  words="$words $n"
  eval "w$n=\$1"
  shift
done
if [ "${1:-}" != -- ]; then
  printf 'ah-run.sh: usage: ah-run.sh [--stdin] <engine-word>... -- <legacy-script> [<argument>...]\n' >&2
  exit 64
fi
shift
[ -n "${1:-}" ] || {
  printf 'ah-run.sh: usage: ah-run.sh [--stdin] <engine-word>... -- <legacy-script> [<argument>...]\n' >&2
  exit 64
}
shift # the legacy script path
# rebuild the argument list: the engine words, then the arguments that followed the script
i=0
for a in "$@"; do
  i=$((i + 1))
  eval "a$i=\$a"
done
tail_n=$i
set --
for k in $words; do
  eval "set -- \"\$@\" \"\$w$k\""
done
j=1
while [ "$j" -le "$tail_n" ]; do
  eval "set -- \"\$@\" \"\$a$j\""
  j=$((j + 1))
done

find_engine
if [ -z "$engine" ]; then
  [ "$stdin_mode" -eq 1 ] && exit 0
  engine_missing "$*"
fi
if [ "$stdin_mode" -eq 1 ]; then
  exec "$engine" "$@"
fi
# Long-running (a Monitor): run the engine as a child and pass SIGTERM/SIGINT on to it. The traps go in before the child starts:
# a signal in between would otherwise kill this launcher with its default action and leave the engine running unowned (dash).
# One that comes before the child is started ends the launcher by that signal (nothing started); one that comes while it is
# being started is passed on as soon as its pid is known.
signalled=
pid=
trap 'signalled=TERM; [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null' TERM
trap 'signalled=INT; [ -z "$pid" ] || kill -INT "$pid" 2>/dev/null' INT
if [ -n "$signalled" ]; then
  trap - "$signalled"
  kill -"$signalled" $$
fi
"$engine" "$@" </dev/null &
pid=$!
[ -z "$signalled" ] || kill -"$signalled" "$pid" 2>/dev/null
wait "$pid"
rc=$?
if [ -n "$signalled" ]; then
  wait "$pid" 2>/dev/null
  rc=$?
fi
exit "$rc"

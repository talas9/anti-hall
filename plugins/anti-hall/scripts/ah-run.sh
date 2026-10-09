#!/bin/sh
# Skill launcher: run `ah-engine <verb> ...` when the engine answers, else the verb's Node script.
#   ah-run.sh <verb> [args...]      verbs: settings jev-setup briefing capability-scan defect harvest
#                                         install-statusline uninstall-statusline update install-codex
# The engine is looked up as ah-hook.sh does: $HOME/.anti-hall/ah-engine/bin/ah-engine, then PATH.
# Node runs instead when the engine is absent or not runnable (126/127), cannot load this plugin's defaults (70),
# or defers the call (75: nothing written). Any other engine exit is the answer and is passed through.
here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || here=.
root=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd) || root=$here/..
verb=${1:-}
[ $# -gt 0 ] && shift
case $verb in
  settings) js=scripts/settings.js ;;
  jev-setup) js=scripts/jev-setup.js ;;
  briefing) js=scripts/briefing.js ;;
  capability-scan) js=scripts/capability-scan.js ;;
  defect) js=scripts/defect.js ;;
  harvest) js=scripts/harvest-debt.js ;;
  install-statusline) js=statusline/install-statusline.js ;;
  uninstall-statusline) js=statusline/uninstall-statusline.js ;;
  update) js=skills/update/scripts/update.js ;;
  install-codex) js=codex/install-codex.js ;;
  *) printf 'ah-run.sh: unknown verb %s\n' "$verb" >&2; exit 64 ;;
esac
engine=$HOME/.anti-hall/ah-engine/bin/ah-engine
[ -x "$engine" ] || engine=$(command -v ah-engine 2>/dev/null || true)
if [ -n "$engine" ] && [ -x "$engine" ]; then
  AH_ENGINE_PLUGIN_ROOT=${AH_ENGINE_PLUGIN_ROOT:-$root} "$engine" "$verb" "$@"
  rc=$?
  case $rc in 70 | 75 | 126 | 127) ;; *) exit "$rc" ;; esac
fi
exec node "$root/$js" "$@"

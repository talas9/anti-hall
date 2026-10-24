#!/bin/sh
# engine-deploy.sh: a thin call to the ONE install routine, `ah-engine update --from-local` (src/operator/routine.rs). No logic lives here.
#
#   sh scripts/engine-deploy.sh --check    [<new-engine> [<plugin-root>]] [--dir <build-dir>] [--hook <ah-hook>]
#   sh scripts/engine-deploy.sh --deploy   [<new-engine> [<plugin-root>]] [--dir <build-dir>] [--hook <ah-hook>] [--yes] [--force] [--allow-entry-leftovers]
#   sh scripts/engine-deploy.sh --rollback [--from <saved-copy-dir>] [--yes]
#
# --check = the routine's pre-check only; --deploy = the whole routine (pre-check, rollback copy, install, settle, validate, automatic
# rollback on failure, cleanup, install record; without --yes it only plans); --rollback = restore the saved copy of the last install.
# <build-dir> (default: the repository this script is in) is laid out as routine.engine_candidates / hook_candidates / tree_candidates
# in engine/defaults/routine.toml; <new-engine>, <plugin-root> and --hook name the pieces explicitly. The routine is run by <new-engine>
# when given (its own pre-check and validation), else by the installed engine. Environment: AH_DEPLOY_HOME (HOME), AH_DEPLOY_ENGINE_DIR
# (the state directory), AH_DEPLOY_ROOTS (colon separated plugin roots to install into) - the routine reads the last one itself.
set -u
mode=; dir=; hook=; from=; pos1=; pos2=; flags=
while [ $# -gt 0 ]; do
  case $1 in
    --check|--deploy|--rollback) mode=$1 ;;
    --dir) shift; dir=${1:-} ;;
    --hook) shift; hook=${1:-} ;;
    --from) shift; from=${1:-} ;;
    --yes|--force|--allow-entry-leftovers) flags="$flags $1" ;;
    -*) echo "engine-deploy: unknown option $1 (see the header of $0)" >&2; exit 2 ;;
    *) if [ -z "$pos1" ]; then pos1=$1; else pos2=$1; fi ;;
  esac
  shift
done
[ -n "$mode" ] || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ -n "${AH_DEPLOY_HOME:-}" ] && HOME=$AH_DEPLOY_HOME && export HOME
[ -n "${AH_DEPLOY_ENGINE_DIR:-}" ] && AH_ENGINE_DIR=$AH_DEPLOY_ENGINE_DIR && export AH_ENGINE_DIR
here=$(cd "$(dirname "$0")/.." && pwd)
dir=${dir:-$here}
live=${AH_ENGINE_DIR:-$HOME/.anti-hall/ah-engine}/bin/ah-engine
engine=${pos1:-$live}
[ -n "$pos2" ] && AH_ENGINE_PLUGIN_ROOT=$pos2 && export AH_ENGINE_PLUGIN_ROOT
[ -z "$pos2" ] && [ -z "${AH_ENGINE_PLUGIN_ROOT:-}" ] && [ -f "$dir/plugins/anti-hall/engine/defaults/index.toml" ] && AH_ENGINE_PLUGIN_ROOT=$dir/plugins/anti-hall && export AH_ENGINE_PLUGIN_ROOT
case $mode in
  --rollback) exec "$engine" update --rollback ${from:+--deploy-dir "$from"} $flags ;;
  --check)    exec "$engine" update --from-local "$dir" ${pos1:+--engine-bin "$pos1"} ${pos2:+--tree "$pos2"} ${hook:+--hook-bin "$hook"} --check $flags ;;
  --deploy)   exec "$engine" update --from-local "$dir" ${pos1:+--engine-bin "$pos1"} ${pos2:+--tree "$pos2"} ${hook:+--hook-bin "$hook"} $flags ;;
esac

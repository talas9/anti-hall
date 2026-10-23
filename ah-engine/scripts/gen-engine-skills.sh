#!/bin/sh
# Regenerate the committed anti-hall:engine skill family (Claude and Codex) from the engine's registry.
# Usage: scripts/gen-engine-skills.sh [path to the ah-engine binary]   (run from anywhere; writes under plugins/anti-hall)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root="$here/../plugins/anti-hall"
. "$here/scripts/lib-target.sh"
if [ $# -ge 1 ]; then bin=$1; else
  tdir=$(cargo_target_dir "$here") || { echo "gen-engine-skills.sh: cannot resolve the cargo target directory" >&2; exit 1; }
  bin=$tdir/debug/ah-engine
fi
export AH_ENGINE_PLUGIN_ROOT="$root"
for host in claude codex; do
  "$bin" docs --format skill-list --host "$host" | while IFS= read -r rel; do
    name=$(basename "$(dirname "$rel")")
    case "$host" in codex) name=${name#anti-hall-} ;; esac
    mkdir -p "$root/$(dirname "$rel")"
    "$bin" docs --format skill --host "$host" --name "$rel" --out "$root/$rel"
  done
done

#!/usr/bin/env bash
# Keep the separate debug symbols of a release binary under the state directory, one directory per build id:
#   <state>/symbols/<build id>/ah-engine.dSYM        (macOS; Linux: ah-engine.dwp)
# so a burst dump of the INSTALLED binary (`ah-engine diag burst-dump --symbolize`) can be named later, after the build tree is cleaned.
# The shipped binary is stripped (Cargo.toml: strip = true, split-debuginfo = "packed"); only its symbols make a dump readable.
# usage: keep-symbols.sh <binary>
# <state> is $AH_ENGINE_DIR, else ~/.anti-hall/ah-engine (the engine's own default; the folder name is files.symbols_dir in
# plugins/anti-hall/engine/defaults/diagnostics.toml). A build id that is already kept is left alone: the id names the build, so the
# files are the same; nothing is overwritten or deleted.
set -euo pipefail

[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: keep-symbols.sh <binary>" >&2; exit 2; }
bin="$1"

case "$(uname -s)" in
  Darwin) id="$(dwarfdump --uuid "$bin" 2>/dev/null | awk 'NR==1{print $2}')" ;;
  *)      id="$(readelf -n "$bin" 2>/dev/null | awk '/Build ID:/{print $3; exit}')" ;;
esac
[ -n "${id:-}" ] || { echo "keep-symbols.sh: $bin has no build id (LC_UUID / GNU build-id); symbols not kept" >&2; exit 1; }

syms=()
[ -d "$bin.dSYM" ] && syms+=("$bin.dSYM")
[ -f "$bin.dwp" ] && syms+=("$bin.dwp")
[ ${#syms[@]} -gt 0 ] || { echo "keep-symbols.sh: no $bin.dSYM or $bin.dwp beside the binary (Cargo.toml: split-debuginfo = \"packed\"); symbols not kept" >&2; exit 1; }

# a dSYM must carry the binary's own id, or it would name the wrong functions
if [ -d "$bin.dSYM" ] && [ "$(uname -s)" = Darwin ]; then
  dsym_id="$(dwarfdump --uuid "$bin.dSYM" 2>/dev/null | awk 'NR==1{print $2}')"
  [ "$dsym_id" = "$id" ] || { echo "keep-symbols.sh: $bin.dSYM is id $dsym_id but the binary is $id (stale dSYM); symbols not kept" >&2; exit 1; }
fi

dest="${AH_ENGINE_DIR:-$HOME/.anti-hall/ah-engine}/symbols/$id"
if [ -e "$dest" ]; then
  echo "symbols:  $dest (already kept)"
  exit 0
fi
mkdir -p "$dest"
for s in "${syms[@]}"; do cp -R "$s" "$dest/"; done
echo "symbols:  $dest"

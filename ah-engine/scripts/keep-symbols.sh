#!/usr/bin/env bash
# Keep the separate debug symbols of a release binary under the state directory, one directory per build id:
#   <state>/symbols/<build id>/ah-engine.dSYM        (macOS; Linux: ah-engine.dwp)
# so a burst dump of the INSTALLED binary (`ah-engine diag burst-dump --symbolize`) can be named later, after the build tree is cleaned.
# The shipped binary is stripped (Cargo.toml: strip = true, split-debuginfo = "packed"); only its symbols make a dump readable.
# usage: keep-symbols.sh <binary>
# <state> and the folder name are read from the plugin's defaults, the same files the engine reads, so they cannot drift:
#   state  = $<env.dir> (AH_ENGINE_DIR), else $HOME/<paths.base_dir>/<paths.state_dir>   (engine.toml)
#   folder = files.symbols_dir                                                          (diagnostics.toml)
# The defaults dir is $AH_ENGINE_DEFAULTS_DIR, else plugins/anti-hall/engine/defaults of this checkout. A build id that is already kept is left alone: the id names the build, so the
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

defaults_dir="${AH_ENGINE_DEFAULTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../plugins/anti-hall/engine/defaults" 2>/dev/null && pwd)}"
# value of [<table>] in a defaults file: the `value = "..."` line of that table
toml_value() {
  awk -v t="[$2]" '$0 == t {on=1; next} /^\[/ {on=0} on && /^value[ ]*=/ {sub(/^value[ ]*=[ ]*"/, ""); sub(/"[ ]*$/, ""); print; exit}' "$defaults_dir/$1"
}
[ -n "$defaults_dir" ] && [ -f "$defaults_dir/engine.toml" ] || { echo "keep-symbols.sh: plugin defaults not found (set AH_ENGINE_DEFAULTS_DIR); symbols not kept" >&2; exit 1; }
env_name="$(toml_value engine.toml env.dir)"
sym_dir="$(toml_value diagnostics.toml files.symbols_dir)"
if [ -n "$env_name" ] && [ -n "${!env_name:-}" ]; then
  state="${!env_name}"
else
  base="$(toml_value engine.toml paths.base_dir)"; sdir="$(toml_value engine.toml paths.state_dir)"
  [ -n "$base" ] && [ -n "$sdir" ] || { echo "keep-symbols.sh: paths.base_dir / paths.state_dir missing in $defaults_dir/engine.toml; symbols not kept" >&2; exit 1; }
  state="$HOME/$base/$sdir"
fi
[ -n "$sym_dir" ] || { echo "keep-symbols.sh: files.symbols_dir missing in $defaults_dir/diagnostics.toml; symbols not kept" >&2; exit 1; }
dest="$state/$sym_dir/$id"
if [ -e "$dest" ]; then
  echo "symbols:  $dest (already kept)"
  exit 0
fi
mkdir -p "$dest"
for s in "${syms[@]}"; do cp -R "$s" "$dest/"; done
echo "symbols:  $dest"

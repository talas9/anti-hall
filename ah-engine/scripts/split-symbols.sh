#!/usr/bin/env bash
# Linux: split a release build into the shipped (stripped) binary and its kept symbols.
#   split-symbols.sh <unstripped binary>   ->   <binary>.debug (the unstripped build, byte for byte)  +  <binary> stripped in place
# Why a whole unstripped copy and not a packed .dwp: a .dwp holds only the DWARF pieces, with no symbol table and no code addresses to
# resolve against, so `addr2line -e <dwp>` names nothing. The unstripped copy carries the symbol table, the line tables and the same GNU
# build-id as the stripped binary (strip keeps the note), so the engine's `diag burst-dump --symbolize` can match it by id and name frames.
# build.sh builds Linux targets unstripped (--config profile.release.strip=false, split-debuginfo off) and calls this; macOS keeps a dSYM.
set -euo pipefail

[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: split-symbols.sh <unstripped binary>" >&2; exit 2; }
bin="$1"
id_of() { readelf -n "$1" 2>/dev/null | awk '/Build ID:/{print $3; exit}'; }
before="$(id_of "$bin")"
[ -n "$before" ] || { echo "split-symbols.sh: $bin has no GNU build-id (link with --build-id); symbols not split" >&2; exit 1; }
if [ -e "$bin.debug" ]; then # a rebuild that cargo found fresh: the binary was split by the run before
  [ "$(id_of "$bin.debug")" = "$before" ] && { echo "symbols:  $bin.debug (already split, build id $before)"; exit 0; }
  echo "split-symbols.sh: $bin.debug exists with another build id; not overwritten" >&2; exit 1
fi
cp -p "$bin" "$bin.debug.tmp"
strip --strip-all "$bin"
after="$(id_of "$bin")"
[ "$after" = "$before" ] || { rm -f "$bin.debug.tmp"; echo "split-symbols.sh: stripping changed the build id ($before -> $after)" >&2; exit 1; }
mv "$bin.debug.tmp" "$bin.debug"
echo "symbols:  $bin.debug (build id $before)"

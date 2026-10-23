#!/bin/sh
# Fails when the published plugin tree breaks the Claude plugin directory limits: more git-tracked files than limits.max_files, or a
# non-image file of limits.max_non_image_bytes or more. The limits live in plugin-dir-limits.toml next to this script.
# Usage: sh ah-engine/tests/plugin-dir-limits.sh [repo-root]    (exit 0 = within the limits, 1 = over, 2 = cannot check)
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd) || exit 2
cfg=$here/plugin-dir-limits.toml
root=${1:-$here/../..}
root=$(CDPATH= cd -- "$root" && pwd) || exit 2

val() { # val <key>: the value of `key = ...` in the config, quotes stripped
  sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$cfg" | head -n 1 | sed 's/^"//; s/"[[:space:]]*$//'
}
dir=$(val dir); max_files=$(val max_files); max_bytes=$(val max_non_image_bytes); images=$(val image_extensions)
if [ -z "$dir" ] || [ -z "$max_files" ] || [ -z "$max_bytes" ]; then
  echo "plugin-dir-limits: cannot read the limits from $cfg" >&2
  exit 2
fi

list=$(git -C "$root" ls-files -- "$dir") || { echo "plugin-dir-limits: git ls-files failed in $root" >&2; exit 2; }
count=$(printf '%s\n' "$list" | grep -c . || true)
fail=0
if [ "$count" -gt "$max_files" ]; then
  echo "FAIL: $dir has $count git-tracked files, the limit is $max_files" >&2
  fail=1
fi

is_image() { # is_image <path>
  ext=${1##*.}
  ext=$(printf '%s' "$ext" | tr 'A-Z' 'a-z')
  for i in $images; do [ "$ext" = "$i" ] && return 0; done
  return 1
}
big=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$root/$f" ] || continue
  is_image "$f" && continue
  size=$(wc -c <"$root/$f" | tr -d ' ')
  if [ "$size" -ge "$max_bytes" ]; then
    echo "FAIL: $f is $size bytes, non-image files must be under $max_bytes" >&2
    big=$((big + 1))
  fi
done <<EOF2
$list
EOF2
[ "$big" -eq 0 ] || fail=1

if [ "$fail" -eq 0 ]; then
  echo "ok: $dir has $count files (limit $max_files); no non-image file is $max_bytes bytes or more"
fi
exit "$fail"

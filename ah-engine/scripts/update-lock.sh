#!/usr/bin/env bash
# Write ah-engine.lock (D68) from the assets in <dist-dir>: version, fingerprint, per-asset sha256.
# usage: update-lock.sh <dist-dir> <lock-file> [prepare-run-id]
# Assets are every file in <dist-dir> except *.sha256 and SHA256SUMS. prepare-run-id is omitted for local runs.
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: update-lock.sh <dist-dir> <lock-file> [prepare-run-id]" >&2; exit 2; }
dist="$1"; lock="$2"; run="${3:-}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)"
fp="$("$root/scripts/fingerprint.sh")"

assets="$(cd "$dist" && for f in *; do
  case "$f" in *.sha256|SHA256SUMS) continue ;; esac
  if [ -f "$f" ]; then printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; fi
done | LC_ALL=C sort -k2)"
[ -n "$assets" ] || { echo "update-lock.sh: no assets in $dist" >&2; exit 1; }

printf '%s\n' "$assets" | jq -R -s --arg v "$version" --arg fp "$fp" --arg run "$run" '
  { schema: 1, version: $v, tag: ("ah-engine-v" + $v), fingerprint: $fp }
  + (if $run == "" then {} else { prepare_run: ($run | tonumber) } end)
  + { assets: (split("\n") | map(select(length > 0) | capture("^(?<sha>[0-9a-f]{64})  (?<name>.+)$")) | map({(.name): .sha}) | add) }
' > "$lock"
echo "wrote $lock"

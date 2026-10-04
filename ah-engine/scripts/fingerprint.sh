#!/usr/bin/env bash
# Deterministic build fingerprint of ah-engine (D68). Prints one sha256 hex string.
#
# Inputs covered (paths relative to ah-engine/; a missing input is skipped, not an error):
#   src/**            Rust sources
#   rules.json        embedded into the binary (include_str!)
#   Cargo.toml        manifest and release profile
#   Cargo.lock        resolved dependencies
#   rust-toolchain.toml  pinned toolchain
#   defaults/**       default settings data files
#   targets.json      the target set
#   scripts/build.sh, scripts/package.sh   build flags and archive layout
# Not covered: tests/, docs, README, CI workflows (they do not change the binary).
#
# Method: sha256 of each covered file, listed as "<hash>  <path>" in byte-wise path order,
# then sha256 of that listing. Independent of mtimes, checkout location and OS.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

inputs=(src rules.json Cargo.toml Cargo.lock rust-toolchain.toml defaults targets.json scripts/build.sh scripts/package.sh)
present=()
for p in "${inputs[@]}"; do [ -e "$p" ] && present+=("$p"); done

find "${present[@]}" -type f | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done | shasum -a 256 | cut -d' ' -f1

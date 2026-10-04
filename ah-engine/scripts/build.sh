#!/usr/bin/env bash
# Local release build of ah-engine (D56): host target by default, or --target <triple>.
# Prints the artifact path and its sha256. The release flags live here and are covered by fingerprint.sh (D68).
set -euo pipefail

usage() { echo "usage: build.sh [--target <triple>]" >&2; exit 2; }

target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; target="$2"; shift 2 ;;
    *) usage ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ -z "$target" ]; then
  target="$(rustc -vV | sed -n 's/^host: //p')"
fi

# Build-path independence: strip the checkout and cargo home from embedded paths.
export RUSTFLAGS="--remap-path-prefix=${root}=. --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"

cargo build --release --locked --target "$target"

bin="$root/target/$target/release/ah-engine"
[ -f "$bin" ] || { echo "build.sh: missing artifact $bin" >&2; exit 1; }
echo "artifact: $bin"
echo "sha256:   $(shasum -a 256 "$bin" | cut -d' ' -f1)"

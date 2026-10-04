#!/usr/bin/env bash
# Local release build of ah-engine (D56): host target by default, or --target <triple>.
# --checks first runs the full local checks: fmt --check, clippy -D warnings, doc -D warnings and the tests.
# Prints the artifact path and its sha256. The release flags live here and are covered by fingerprint.sh (D68).
set -euo pipefail

usage() { echo "usage: build.sh [--target <triple>] [--checks]" >&2; exit 2; }

target=""
checks=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; target="$2"; shift 2 ;;
    --checks) checks=1; shift ;;
    *) usage ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ -z "$target" ]; then
  target="$(rustc -vV | sed -n 's/^host: //p')"
fi

if [ "$checks" = 1 ]; then
  cargo fmt --check
  cargo clippy --all-targets --locked -- -D warnings
  RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked
  # The tests build their own binary: keep it out of the release target directory.
  CARGO_TARGET_DIR="$root/target/checks" cargo test --locked
fi

# Build-path independence: strip the checkout and cargo home from embedded paths.
# The logical and the physical checkout path can differ (symlinks), so both are remapped.
root_phys="$(pwd -P)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
flags="--remap-path-prefix=${root}=. --remap-path-prefix=${cargo_home}=/cargo"
[ "$root_phys" = "$root" ] || flags="$flags --remap-path-prefix=${root_phys}=."
export RUSTFLAGS="$flags"

cargo build --release --locked --target "$target"

bin="$root/target/$target/release/ah-engine"
[ -f "$bin" ] || { echo "build.sh: missing artifact $bin" >&2; exit 1; }

# The binary must not contain the checkout or cargo home path.
for p in "$root" "$root_phys" "$cargo_home"; do
  if grep -aqF -- "$p" "$bin"; then
    echo "build.sh: $bin embeds the path $p" >&2
    exit 1
  fi
done

echo "artifact: $bin"
echo "sha256:   $(shasum -a 256 "$bin" | cut -d' ' -f1)"

#!/usr/bin/env bash
# Mutation testing for one src/checks module (cargo-mutants; install: cargo install --locked cargo-mutants).
# Not part of ./test.sh or CI: a run builds once per mutant, so scope it. Config: .cargo/mutants.toml.
#
#   scripts/mutants.sh git                # mutate src/checks/git/**, run only the lib tests under checks::git
#   scripts/mutants.sh emit_dedupe --list # extra arguments go to cargo-mutants (here: list mutants, run nothing)
#
# Output: target/mutants.out/ (missed.txt lists the surviving mutants: each one is a behaviour no test pins, or an equivalent mutant).
set -u
cd "$(dirname "$0")/.." || exit 1
if ! cargo mutants --version >/dev/null 2>&1; then
  echo "cargo-mutants not found: cargo install --locked cargo-mutants" >&2
  exit 2
fi
mod="${1:?usage: scripts/mutants.sh <checks-module> [cargo-mutants args]}"
shift
[ -d "src/checks/$mod" ] || [ -f "src/checks/$mod.rs" ] || { echo "no such module: src/checks/$mod" >&2; exit 2; }
exec cargo mutants --output target --file "src/checks/$mod/**/*.rs" --file "src/checks/$mod.rs" "$@" -- --lib "checks::$mod"

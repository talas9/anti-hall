#!/usr/bin/env bash
# The full ah-engine test suite, plus the suite-level proof that no daemon survives it (D7): any `ah-engine serve`
# process started from this build tree during the run and still alive afterwards fails the run, even when every test
# passed. Extra arguments go to the runner: `cargo nextest run` when cargo-nextest is installed (per-test timeouts from
# .config/nextest.toml, one process per test), else plain `cargo test` (print how to install nextest). Doctests always run
# through `cargo test --doc` (nextest cannot run them).
set -u
cd "$(dirname "$0")" || exit 1
tree="$PWD/target"
daemons() { ps -Ao pid,command | grep -F "$tree" | grep -F "ah-engine serve" | grep -v grep | awk '{print $1}' | sort; }
before="$(daemons)"
# Lint gate: clippy with the `[lints]` table of Cargo.toml (unwrap/expect, discarded results, unsafe comments, dbg/todo) and
# every warning an error. --release shares its build products with the test run below.
cargo clippy --release --all-targets -- -D warnings || exit 1
if cargo nextest --version >/dev/null 2>&1; then
  # The wall-clock budget tests (a p95 in microseconds) measure the machine when the suite's own Node sweeps load every
  # core, so they run after the suite, one at a time, and nothing of the suite runs beside them.
  timed='binary(telemetry_overhead) | binary(script_latency)'
  cargo nextest run --release -E "not ($timed)" "$@"
  rc=$?
  cargo nextest run --release -j 1 --no-tests=pass -E "$timed" "$@" || rc=1
  if [ "$rc" -eq 0 ]; then
    cargo test --release --doc
    rc=$?
  fi
else
  echo "note: cargo-nextest not found, falling back to cargo test (install: cargo install --locked cargo-nextest, or taiki-e/install-action in CI)" >&2
  cargo test --release "$@"
  rc=$?
fi
if [ "$rc" -eq 0 ]; then
  sh tests/wrapper.sh && sh tests/bootstrap.sh
  rc=$?
fi
sleep 0.3
survivors="$(comm -13 <(printf '%s\n' "$before") <(daemons))"
if [ -n "$survivors" ]; then
  echo "FAIL: daemons survived the test run: $(echo "$survivors" | tr '\n' ' ')" >&2
  exit 1
fi
exit $rc

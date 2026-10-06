#!/usr/bin/env bash
# The full ah-engine test suite, plus the suite-level proof that no daemon survives it (D7): any `ah-engine serve`
# process started from this build tree during the run and still alive afterwards fails the run, even when every test
# passed. Extra arguments go to `cargo test`.
set -u
cd "$(dirname "$0")" || exit 1
tree="$PWD/target"
daemons() { ps -Ao pid,command | grep -F "$tree" | grep -F "ah-engine serve" | grep -v grep | awk '{print $1}' | sort; }
before="$(daemons)"
cargo test --release "$@"
rc=$?
if [ "$rc" -eq 0 ]; then
  sh tests/wrapper.sh
  rc=$?
fi
sleep 0.3
survivors="$(comm -13 <(printf '%s\n' "$before") <(daemons))"
if [ -n "$survivors" ]; then
  echo "FAIL: daemons survived the test run: $(echo "$survivors" | tr '\n' ' ')" >&2
  exit 1
fi
exit $rc

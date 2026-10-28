#!/usr/bin/env bash
# LANE test pack: the policy gates, then the tests of the touched module(s). Which tests count as "policy" and which are left out of a lane
# (Node parity, benches, soak, wall-clock drills) is defined in .config/nextest.toml (profiles `policy` and `lane`), not here.
# Usage: scripts/lane-tests.sh <module-substring>...   e.g. scripts/lane-tests.sh dswire mesh
set -u
cd "$(dirname "$0")/.." || exit 1
[ "$#" -ge 1 ] || { echo "usage: $0 <module-substring>..." >&2; exit 2; }
filter=""
for m in "$@"; do filter="${filter:+$filter | }test(~$m)"; done
rc=0
nice -n 10 cargo nextest run -j 2 --profile policy --no-fail-fast || rc=1
nice -n 10 cargo nextest run -j 2 --profile lane --no-fail-fast --no-tests=pass -E "$filter" || rc=1
exit $rc

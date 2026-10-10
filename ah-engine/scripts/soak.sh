#!/usr/bin/env bash
# The engine hardening bar (issue #58): runs every bar of tests/hardening_bar.rs one at a time, in release mode, and
# assembles one report. Opt-in (nightly workflow / release train), never the pull-request gate.
#
# Usage: scripts/soak.sh [report.md]        default report: target/hardening/report.md
#   AH_CARGO   cargo wrapper (default: cargo), e.g. ~/.anti-hall/work/bin/cargo-q.sh on a shared machine
#   BARS       space-separated test-name prefixes to run (default: all), e.g. BARS="crash_loop breaker"
# Every threshold and report text lives in plugins/anti-hall/engine/defaults/hardening.toml.
# Exit status: 0 when every bar passed, 1 otherwise (the report is written either way).
set -u
cd "$(dirname "$0")/.."
CARGO=${AH_CARGO:-cargo}
OUT=${1:-target/hardening/report.md}
mkdir -p "$(dirname "$OUT")"
FRAG="$(cd "$(dirname "$OUT")" && pwd)/fragments"
rm -rf "$FRAG"; mkdir -p "$FRAG"
export AH_HARDENING_REPORT_DIR="$FRAG"
TOML=../plugins/anti-hall/engine/defaults/hardening.toml
tv() { awk -v k="[report.$1]" '$0==k{f=1;next} f&&/^value/{sub(/^value = "/,"");sub(/"$/,"");print;exit}' "$TOML"; }
TITLE=$(tv title); FAILW=$(tv fail)

bars=(crash_loop breaker panic_injection corrupt_socket kill_mid_call load_ memory_soak)
[ -n "${BARS:-}" ] && read -r -a bars <<<"$BARS"

fail=0
$CARGO test --release --test hardening_bar --no-run >&2 || exit 1
for b in "${bars[@]}"; do
  echo "== bar: $b" >&2
  # --exact is not usable with a prefix: list the matching ignored tests and run each by its full name
  names=$($CARGO test --release --test hardening_bar -- --ignored --list 2>/dev/null | sed -n 's/^\(.*\): test$/\1/p' | grep "^$b")
  [ -z "$names" ] && { echo "no bar named $b" >&2; fail=1; continue; }
  for t in $names; do
    $CARGO test --release --test hardening_bar -- --ignored --exact "$t" --test-threads=1 --nocapture >&2 || fail=1
  done
done

{
  echo "# $TITLE"
  echo
  echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -sm), commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)."
  echo
  cat "$FRAG"/*.md 2>/dev/null
} > "$OUT"
echo "report: $OUT" >&2
grep -qF "| $FAILW |" "$OUT" && fail=1
exit $fail

#!/bin/sh
# Runs every fenced `sh` block of a doc (default docs/DEVELOPMENT.md) in order, in a fresh clone of this checkout,
# so the doc cannot describe a command that no longer works (D83).
#
#   ah-engine/scripts/doc-check.sh [--doc <file>] [--fast] [--keep]
#
#   --doc <file>  the doc to check, relative to the repository root (default docs/DEVELOPMENT.md)
#   --fast        also skip the blocks marked `long` (the full test suites)
#   --keep        keep the scratch directory and print where it is
#
# Only fences opened with exactly ```sh are run; any other fence (```text, ```json, plain ```) is output or an example.
# A block is controlled by HTML comment lines placed directly above its opening fence:
#   <!-- doc-check: skip (reason) -->       not run (needs credentials, installs globally, writes outside the clone)
#   <!-- doc-check: needs tool tool -->     run only when every tool is on PATH (otherwise skipped, and said so)
#   <!-- doc-check: long -->                a full test suite; skipped with --fast
# Each block runs as its own `sh -e` script with the clone's root as the working directory, in file order, and the run
# stops at the first failure. Isolation: a fresh clone, HOME in a scratch directory (the Rust toolchain keeps using
# the real CARGO_HOME and RUSTUP_HOME, so it is not downloaded again), `nice -n 19`, CARGO_BUILD_JOBS=2. The scratch
# directory is the only thing removed. A daemon still running from the clone when the blocks finish fails the run.
set -eu

doc=docs/DEVELOPMENT.md
fast=0
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --doc) [ $# -ge 2 ] || { echo "doc-check: --doc needs a file" >&2; exit 2; }; doc="$2"; shift 2 ;;
    --fast) fast=1; shift ;;
    --keep) keep=1; shift ;;
    *) echo "usage: doc-check.sh [--doc <file>] [--fast] [--keep]" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
src="$(cd "$here/../.." && pwd)"
[ -f "$src/$doc" ] || { echo "doc-check: no such doc: $src/$doc" >&2; exit 2; }

# Keep the real toolchain locations before HOME moves.
real_home="$HOME"
if [ -z "${CARGO_HOME:-}" ] && [ -d "$real_home/.cargo" ]; then CARGO_HOME="$real_home/.cargo"; export CARGO_HOME; fi
if [ -z "${RUSTUP_HOME:-}" ] && [ -d "$real_home/.rustup" ]; then RUSTUP_HOME="$real_home/.rustup"; export RUSTUP_HOME; fi

# A short base path: the daemon's socket path has a length limit on macOS.
work="$(mktemp -d "${DOC_CHECK_TMP:-/tmp}/ahdc.XXXXXX")"
cleanup() {
  if [ "$keep" = 1 ]; then echo "doc-check: kept $work"; return; fi
  case "$work" in /*/ahdc.*) rm -rf "$work" ;; esac
}
trap cleanup EXIT

mkdir "$work/home" "$work/blocks"
git clone -q --no-hardlinks "$src" "$work/repo"
# Check the doc as it is in the working tree, committed or not.
cp "$src/$doc" "$work/repo/$doc"

# Split the doc into one file per `sh` block plus a .meta file of its directives and line number.
awk -v dir="$work/blocks" '
  /^<!-- doc-check: .* -->[ \t]*$/ {
    d = $0; sub(/^<!-- doc-check: /, "", d); sub(/ -->[ \t]*$/, "", d)
    pending = pending d "\n"; next
  }
  /^[ \t]*$/ { next_blank = 1; if (!inblock) next }
  {
    if (inblock) {
      if ($0 ~ /^```[ \t]*$/) { inblock = 0; close(body); next }
      print $0 > body; next
    }
    if ($0 ~ /^```sh[ \t]*$/) {
      n++; id = sprintf("%03d", n); body = dir "/" id ".sh"; meta = dir "/" id ".meta"
      printf "%s", pending > meta; print "line " NR >> meta; close(meta)
      printf "" > body; inblock = 1; pending = ""; next
    }
    if ($0 ~ /^```/) { skipping = !skipping; pending = ""; next }
    if (!skipping) pending = ""
  }
' "$src/$doc"

total=0 ran=0 skipped=0
for body in "$work"/blocks/*.sh; do
  [ -f "$body" ] || { echo "doc-check: no sh blocks in $doc" >&2; exit 1; }
  total=$((total + 1))
  meta="${body%.sh}.meta"
  line="$(sed -n 's/^line //p' "$meta")"
  first="$(grep -v '^[ \t]*\(#.*\)\{0,1\}$' "$body" | head -n 1 | cut -c1-70)"
  reason=""
  while IFS= read -r d; do
    case "$d" in
      skip*) reason="$d" ;;
      long) [ "$fast" = 1 ] && reason="skip (long, --fast)" ;;
      needs\ *)
        for tool in ${d#needs }; do
          command -v "$tool" >/dev/null 2>&1 || reason="skip (needs $tool, not installed)"
        done ;;
    esac
  done <"$meta"
  if [ -n "$reason" ]; then
    skipped=$((skipped + 1))
    echo "skip  line $line: $first   [$reason]"
    continue
  fi
  echo "run   line $line: $first"
  log="$work/blocks/$(basename "$body" .sh).log"
  if ! (
    cd "$work/repo"
    HOME="$work/home" CARGO_BUILD_JOBS=2 nice -n 19 sh -e "$body"
  ) >"$log" 2>&1; then
    echo "FAIL  line $line: $first" >&2
    tail -n 40 "$log" >&2
    keep=1
    echo "doc-check: kept $work for inspection" >&2
    exit 1
  fi
  ran=$((ran + 1))
done

# No daemon may outlive the blocks (the same rule as ah-engine/test.sh).
survivors="$(ps -Ao pid,command | grep -F "$work/" | grep -F "ah-engine serve" | grep -v grep | awk '{print $1}' || true)"
if [ -n "$survivors" ]; then
  echo "FAIL: daemons survived the blocks: $(echo "$survivors" | tr '\n' ' ')" >&2
  # shellcheck disable=SC2086
  kill $survivors 2>/dev/null || true
  exit 1
fi

echo "doc-check: $doc ok ($ran run, $skipped skipped, $total blocks)"

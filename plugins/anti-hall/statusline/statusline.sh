#!/usr/bin/env bash
# statusline.sh — Dispatcher: routes stdin JSON to the right statusline script.
#
# Monorepo detection (from git toplevel):
#   .gitmodules exists  => monorepo
#   .gsd/ dir exists    => monorepo (GSD project)
#   .planning/ dir exists => monorepo (GSD project)
# Else => simple statusline.
#
# $DIR resolves to the directory containing this script, regardless of cwd.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read stdin once into a variable so we can forward it to the chosen script.
INPUT="$(cat)"

# Determine git toplevel (silently fall back to cwd if not in a git repo).
GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

is_monorepo() {
  [ -f "${GIT_TOP}/.gitmodules" ] && return 0
  [ -d "${GIT_TOP}/.gsd"       ] && return 0
  [ -d "${GIT_TOP}/.planning"  ] && return 0
  return 1
}

if is_monorepo; then
  printf '%s' "$INPUT" | node "${DIR}/statusline-monorepo.js"
else
  printf '%s' "$INPUT" | node "${DIR}/statusline-simple.js"
fi

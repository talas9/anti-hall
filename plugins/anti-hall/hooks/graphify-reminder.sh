#!/usr/bin/env bash
# anti-hall :: graphify update reminder (Stop hook)
#
# Fires on Stop. IF significant code edits happened this session AND a graphify
# graph exists, it logs a gentle one-line reminder to run '/graphify --obsidian'
# so the knowledge graph stays in sync with the code.
#
# Design constraints:
#   - NON-BLOCKING: always exit 0, never emit a blocking decision.
#   - CHEAP: it does NOT run graphify (that can be expensive). Just a notice.
#   - SAFE no-op: if no graph exists or no significant edits happened, do nothing.
#   - No external deps (no jq); reads stdin and greps the transcript.
#
# Contract (Claude Code Stop hook):
#   stdin  : JSON { session_id, transcript_path, cwd, ... }
#   stdout : ignored for control here; we only append to a log file.
#   exit 0 : always.

set -u

# Read the hook payload from stdin (best-effort).
PAYLOAD=$(cat 2>/dev/null || true)

# --- 1. Is there a graphify graph for this project? ---
ROOTS=("$PWD")
if command -v git >/dev/null 2>&1; then
  GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "${GIT_ROOT:-}" ] && [ "$GIT_ROOT" != "$PWD" ]; then
    ROOTS+=("$GIT_ROOT")
  fi
fi

PROJECT_ROOT=""
for root in "${ROOTS[@]}"; do
  if [ -d "$root/graphify-out" ] || [ -d "$root/.planning/graphs" ]; then
    PROJECT_ROOT="$root"
    break
  fi
done

# No graph -> nothing to remind about.
if [ -z "$PROJECT_ROOT" ]; then
  exit 0
fi

# --- 2. Did significant code edits happen this session? ---
# Pull transcript_path out of the payload without jq (simple field extraction).
TRANSCRIPT=$(printf '%s' "$PAYLOAD" \
  | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n1 \
  | sed 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"//; s/"$//')

SIGNIFICANT=0
if [ -n "${TRANSCRIPT:-}" ] && [ -f "$TRANSCRIPT" ]; then
  # Count edit/write tool invocations in the transcript. Two or more = significant.
  EDIT_COUNT=$(grep -o -E '"name"[[:space:]]*:[[:space:]]*"(Edit|Write|NotebookEdit|MultiEdit)"' "$TRANSCRIPT" 2>/dev/null | wc -l | tr -d ' ')
  EDIT_COUNT=${EDIT_COUNT:-0}
  if [ "$EDIT_COUNT" -ge 2 ]; then
    SIGNIFICANT=1
  fi
fi

# No significant edits -> stay quiet.
if [ "$SIGNIFICANT" -ne 1 ]; then
  exit 0
fi

# --- 3. Append a gentle one-line reminder to a log (never block). ---
LOG_DIR="${PROJECT_ROOT}/.planning"
[ -d "$LOG_DIR" ] || LOG_DIR="$PROJECT_ROOT"
LOG_FILE="${LOG_DIR}/.graphify-reminders.log"
TS=$(date "+%Y-%m-%d %H:%M:%S" 2>/dev/null || true)

printf '%s  significant code edits this session — run `/graphify --obsidian` to update the knowledge graph\n' \
  "${TS:-now}" >> "$LOG_FILE" 2>/dev/null || true

# Also surface a brief notice on stderr (non-blocking, informational only).
printf 'graphify: significant edits detected — consider running `/graphify --obsidian` to update the graph.\n' >&2

exit 0

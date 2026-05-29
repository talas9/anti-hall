#!/usr/bin/env bash
# anti-hall :: graphify-first session primer
#
# Fires on SessionStart. If the current project has a graphify knowledge graph,
# it injects context telling the model to QUERY THE GRAPH FIRST (before grep /
# find / broad file reads) when answering "where/why/how does X work" questions.
#
# Safe no-op when graphify isn't used: if no graph is found we emit nothing and
# exit 0. No external deps (no jq) so it runs unchanged on any machine. The JSON
# is hand-emitted, matching the verify-first.sh style.
#
# Contract (Claude Code SessionStart hook):
#   stdin  : JSON { session_id, cwd, ... }  (ignored here)
#   stdout : JSON { hookSpecificOutput.additionalContext } added to the session
#   exit 0 : always (this hook never blocks)

set -u

# Detect a graphify graph rooted at the project. Check cwd and, if inside a git
# repo, the repo root too. Recognized markers: graphify-out/ or .planning/graphs/
ROOTS=("$PWD")
if command -v git >/dev/null 2>&1; then
  GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "${GIT_ROOT:-}" ] && [ "$GIT_ROOT" != "$PWD" ]; then
    ROOTS+=("$GIT_ROOT")
  fi
fi

GRAPH_DIR=""
for root in "${ROOTS[@]}"; do
  if [ -d "$root/graphify-out" ]; then
    GRAPH_DIR="$root/graphify-out"
    break
  fi
  if [ -d "$root/.planning/graphs" ]; then
    GRAPH_DIR="$root/.planning/graphs"
    break
  fi
done

# No graph -> safe no-op.
if [ -z "$GRAPH_DIR" ]; then
  exit 0
fi

# Graph found -> prime the model to use it first.
cat <<JSON
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"GRAPHIFY-FIRST PROTOCOL: this project has a graphify knowledge graph at '${GRAPH_DIR}'. ALWAYS query the graph FIRST when looking up ANY issue, feature, function, class, code path, configuration, document, or 'where/why/how does X work' / 'what connects to Y' question - BEFORE grep / find / glob or broad file reads. Run '/graphify query \"<question>\"' (or read '${GRAPH_DIR}/wiki/index.md' / GRAPH_REPORT.md if present). The graph is the FIRST resort, not the last; fall back to raw search only when the graph lacks the answer. KEEP THE GRAPH UP TO DATE: after any change that adds/moves/removes code or docs, and at the END of any session with significant work, update it with '/graphify --obsidian'."}}
JSON
exit 0

#!/usr/bin/env bash
# The only write path for the issue-triage workflow. Acts on the issue from the
# triggering event only; never takes an issue number, title or body from the model.
#   issue-triage-act.sh label <name>...   add allowlisted labels (+ triaged); once per run
#   issue-triage-act.sh comment           post stdin as ONE comment; once per run
set -euo pipefail

ISSUE=$(jq -r '.issue.number // empty' "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH not set}")
[[ "$ISSUE" =~ ^[0-9]+$ ]] || { echo "no issue number in event payload" >&2; exit 1; }

ALLOWED=" bug false-positive enhancement question needs-repro needs-info claude-port codex-port security triaged area:git-guard area:command-guard area:edit-guard area:agent-guards area:stop-guards "
STATE="${RUNNER_TEMP:?RUNNER_TEMP not set}"
once() { [ ! -e "$STATE/triage-$1.done" ] || { echo "$1 already done this run" >&2; exit 1; }; : > "$STATE/triage-$1.done"; }

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  label)
    once label
    args=(--add-label triaged)
    for l in "$@"; do
      [[ "$ALLOWED" == *" $l "* ]] || { echo "label not allowed: $l" >&2; exit 1; }
      args+=(--add-label "$l")
    done
    gh issue edit "$ISSUE" "${args[@]}"
    ;;
  comment)
    once comment
    body=$(head -c 4000)
    [ -n "$body" ] || { echo "empty comment" >&2; exit 1; }
    printf '%s' "$body" | "$(dirname "$0")/bot-comment.sh" "$ISSUE" triage-brief
    ;;
  *) echo "usage: label <name>... | comment (body on stdin)" >&2; exit 1 ;;
esac

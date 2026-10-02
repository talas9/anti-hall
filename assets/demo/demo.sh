#!/usr/bin/env bash
# anti-hall shell-only demo (NOT the source of the README GIF; see assets/demo/README.md).
# Run from the repo root. Optional recording to a scratch cast + GIF that do not replace anti-hall.gif:
#   asciinema rec --window-size 88x17 -c "bash assets/demo/demo.sh" assets/demo/shell-demo.cast --overwrite
#   agg --font-size 22 --theme github-dark --last-frame-duration 3 assets/demo/shell-demo.cast assets/demo/shell-demo.gif
#
# Every "BLOCKED" message below is the REAL stderr of the real hook, captured live:
# a PreToolUse JSON payload is piped into plugins/anti-hall/hooks/git-guard.js run
# with a throwaway HOME. Nothing is hand-typed. Long messages are word-wrapped and cut
# after MAXL lines with an ellipsis (trimmed, never reworded).

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/plugins/anti-hall/hooks/git-guard.js"
DEMO_HOME="$(mktemp -d)"; trap 'rm -rf "$DEMO_HOME"' EXIT
export ANTIHALL_INGEST_DRY_RUN=1
W=86; MAXL=3

# guard "<displayed command>" "<command JSON-escaped for the payload>"
guard() {
  printf '\033[32m$\033[0m %s\n' "$1"; sleep 1.2
  local out
  out=$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$2" \
        | HOME="$DEMO_HOME" node "$HOOK" 2>&1 >/dev/null)
  local rc=$?
  local folded; folded=$(printf '%s' "$out" | fold -s -w "$W")
  local n; n=$(printf '%s\n' "$folded" | wc -l | tr -d ' ')
  printf '\033[31m%s\033[0m' "$(printf '%s\n' "$folded" | head -n "$MAXL")"
  [ "$n" -gt "$MAXL" ] && printf ' \033[31m...\033[0m'
  printf '\n\033[1;31mexit=%s (blocked)\033[0m\n' "$rc"
}

clear
printf '\033[1;35manti-hall\033[0m — verify-first guardrails for Claude Code and Codex\n\n'
sleep 2.2
guard 'git push --force origin main' 'git push --force origin main'
sleep 2.8
printf '\n'
guard 'git commit -m "fix: typo" --trailer "Co-Authored-By: Claude"' 'git commit -m \"fix: typo\" --trailer \"Co-Authored-By: Claude <noreply@anthropic.com>\"'
sleep 2.8
printf '\n\033[1;32mInstall:\033[0m /plugin marketplace add talas9/anti-hall\n'
printf '         /plugin install anti-hall@anti-hall\n'
sleep 1.5

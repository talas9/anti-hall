#!/usr/bin/env bash
# anti-hall :: git guard (PreToolUse on Bash)
#
# Mechanically enforces two commit/push rules that prose instructions never
# reliably hold:
#   1. NO self-credit in commits. Blocks `git commit` whose message contains a
#      "Co-Authored-By" trailer or any "Generated with / Co-authored by <AI>"
#      style self-credit. Commits are the human's; the assistant takes no credit.
#   2. NO force push. Blocks `git push --force` / `-f` / `--force-with-lease`.
#      Rewriting published history is a deliberate human action, never automatic.
#
# Contract (Claude Code PreToolUse hook, matcher "Bash"):
#   stdin  : JSON { tool_input: { command: "<the bash command>" }, ... }
#   exit 0 : allow
#   exit 2 : BLOCK the command; stderr is shown to the model as the reason
#
# Parses the command from stdin with python3 when present (robust), else falls
# back to scanning raw stdin. Only blocks on a positive match; anything it cannot
# parse is allowed (fail-open) so it never wedges unrelated work.

INPUT="$(cat)"

# Extract the command string.
CMD=""
if command -v python3 >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print((d.get("tool_input") or {}).get("command","") or "")
except Exception:
    pass' 2>/dev/null)"
fi
# Fallback: if parsing yielded nothing, scan the raw payload.
[ -z "$CMD" ] && CMD="$INPUT"

# --- Rule 1: no self-credit trailers in commits -----------------------------
# Match common AI self-credit patterns, case-insensitive.
if printf '%s' "$CMD" | grep -qiE 'co-authored-by:.*(claude|anthropic|chatgpt|gpt-[0-9]|codex|openai|copilot|cursor|\bllm\b|\bai assistant\b|\bassistant\b)'; then
  echo "anti-hall git-guard: BLOCKED. Commit message contains a Co-Authored-By self-credit trailer. Remove it - commits carry no AI/assistant co-author credit. Re-run the commit without that trailer." >&2
  exit 2
fi
if printf '%s' "$CMD" | grep -qiE 'generated with \[?(claude|claude code|chatgpt|codex)'; then
  echo "anti-hall git-guard: BLOCKED. Commit/message contains a 'Generated with <AI>' self-credit line. Remove it before committing." >&2
  exit 2
fi

# --- Rule 2: no force push ---------------------------------------------------
if printf '%s' "$CMD" | grep -qE '\bgit\b' \
   && printf '%s' "$CMD" | grep -qE '\bpush\b' \
   && printf '%s' "$CMD" | grep -qE -- '(--force([^-]|$)|--force-with-lease|[[:space:]]-f([[:space:]]|$))'; then
  echo "anti-hall git-guard: BLOCKED. Force push detected. Rewriting published history is a deliberate human action - do it manually with explicit owner confirmation, never from an automated push." >&2
  exit 2
fi

exit 0

# PreToolUse hook — hard-gate sentinel for feature-launch autonomous mode

This hook blocks destructive Bash commands **before** they execute. Required by
Phase A.5.5 of the feature-launch skill. Without it, the AFK readiness gate (A.5.3)
MUST refuse to emit "AFK ready."

## Why

Hard safety boundaries (force-pushes, production deploys, force-deletions, financial
actions, secret rotation) cannot be enforced at phase-exit only — by then the
destructive command has already run. The official pattern for command-level safety
is the **PreToolUse hook**: regex-match the proposed command, exit code 2 on match
-> block with a stderr message returned to the agent.

Reference:
- https://code.claude.com/docs/en/hooks
- https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py

## Drop-in script

Save as `.claude/hooks/feature-launch-hard-gates.sh`:

```bash
#!/usr/bin/env bash
# Hard-gate sentinel for feature-launch autonomous mode.
# Reads PreToolUse JSON from stdin; exits 2 (block) on hard-gate match, 0 otherwise.

set -euo pipefail

INPUT="$(cat)"

# jq is the standard parser; fall through silently if absent (fail-open, won't block).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
[ "$TOOL" != "Bash" ] && exit 0

CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
[ -z "$CMD" ] && exit 0

# Hard-gate patterns. Match -> block with exit 2.
# These are the UNIVERSAL gates. Add project-specific patterns (your deploy CLI,
# your payment provider, your data-deletion commands) in the marked section below.
declare -a PATTERNS=(
  # Force operations
  'git[[:space:]]+push[^|;&]*--force'
  'git[[:space:]]+push[^|;&]*-f([[:space:]]|$)'
  'git[[:space:]]+reset[[:space:]]+--hard'

  # Hook / verification bypass
  '--no-verify'
  '--no-gpg-sign'

  # Force deletions
  '(^|[[:space:]])rm[[:space:]]+-rf[[:space:]]+'
  'git[[:space:]]+branch[[:space:]]+-D'

  # ---- PROJECT-SPECIFIC GATES (customize) -------------------------------
  # Examples — uncomment / adapt to your stack:
  #   '<deploy-cli>[[:space:]]+deploy'            # production deploy command
  #   '<payments-cli>[[:space:]]+.*refund'        # financial action
  #   '<db-cli>[[:space:]]+.*delete[[:space:]]+--all'  # bulk data deletion
  # -----------------------------------------------------------------------
)

for p in "${PATTERNS[@]}"; do
  if [[ "$CMD" =~ $p ]]; then
    cat >&2 <<EOF
========================================================================
BLOCKED by feature-launch hard-gate sentinel.

Pattern matched: $p
Command:         $CMD

This command requires explicit human approval. See the project's hard
rules and Phase A.5.5 of the feature-launch skill.

If you believe this is a false positive, refine the regex in
.claude/hooks/feature-launch-hard-gates.sh and re-run.
========================================================================
EOF
    exit 2
  fi
done

exit 0
```

Make it executable:

```bash
chmod +x .claude/hooks/feature-launch-hard-gates.sh
```

## settings.json entry

Add to `.claude/settings.json` (project-level — checked in) or
`.claude/settings.local.json` (per-machine, gitignored):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/feature-launch-hard-gates.sh"
          }
        ]
      }
    ]
  }
}
```

If `hooks.PreToolUse` already exists, append to the array — don't replace.

## Verification

After installing, run these self-tests:

```bash
# Should BLOCK (exit 2)
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' | \
  .claude/hooks/feature-launch-hard-gates.sh
echo "exit: $?"   # expect 2

# Should ALLOW (exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | \
  .claude/hooks/feature-launch-hard-gates.sh
echo "exit: $?"   # expect 0

# Should BLOCK (exit 2)
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf build/"}}' | \
  .claude/hooks/feature-launch-hard-gates.sh
echo "exit: $?"   # expect 2

# Should ALLOW (exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | \
  .claude/hooks/feature-launch-hard-gates.sh
echo "exit: $?"   # expect 0
```

If any test fails, the hook is broken — DO NOT enter autonomous mode until fixed.
Also add a verification case for every project-specific pattern you uncomment.

## Maintenance

When the hard-gate list changes (new deploy target, new payment provider, new
force-operation), update `PATTERNS` and add a verification case. The hook is
intentionally fail-open if `jq` is missing — install `jq` on every machine that runs
autonomous mode.

Hook ID: `feature-launch-hard-gates@v1`. Bump when patterns change.

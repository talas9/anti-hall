# PreToolUse hook — hard-gate sentinel for feature-launch autonomous mode

This hook blocks destructive Bash commands **before** they execute. Required by
Phase A.5 (AFK readiness gate) of the feature-launch skill. Without it, the AFK
readiness gate MUST refuse to emit "AFK ready."

## Why

Hard safety boundaries (force-pushes, production deploys, force-deletions, financial
actions, secret rotation) cannot be enforced at phase-exit only — by then the
destructive command has already run. The official pattern for command-level safety
is the **PreToolUse hook**: regex-match the proposed command, exit code 2 on match
-> block with a stderr message returned to the agent.

The sentinel below is **pure Node** (no bash, no `jq`, no `chmod`), so it runs
unchanged on Windows, macOS, and Linux — matching the rest of the anti-hall plugin.
Node is the plugin's only runtime prerequisite (see README). There is intentionally
no `.sh` variant: a shell script cannot run on a stock Windows shell, which would
make this mandatory safety gate impossible to install for Windows AFK users.

Reference:
- https://code.claude.com/docs/en/hooks
- https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py

## Drop-in script

Save as `.claude/hooks/feature-launch-hard-gates.js`:

```js
#!/usr/bin/env node
// Hard-gate sentinel for feature-launch autonomous mode.
// Reads PreToolUse JSON from stdin; exits 2 (block) on hard-gate match, 0 otherwise.
// Pure Node: no bash, no jq, no chmod — runs unchanged on Windows, macOS, Linux.
'use strict';

const fs = require('fs');

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (_) {
  process.exit(0); // no input -> allow (fail-open, never wedge unrelated work)
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (_) {
  process.exit(0); // unparseable envelope -> allow
}

if (!payload || payload.tool_name !== 'Bash') process.exit(0);

const cmd = payload.tool_input && typeof payload.tool_input.command === 'string'
  ? payload.tool_input.command
  : '';
if (!cmd) process.exit(0);

// Hard-gate patterns. Match -> block with exit 2.
// These are the UNIVERSAL gates. Add project-specific patterns (your deploy CLI,
// your payment provider, your data-deletion commands) in the marked section below.
const PATTERNS = [
  // Force operations
  /git\s+push[^|;&]*--force/,
  /git\s+push[^|;&]*-f(\s|$)/,
  /git\s+reset\s+--hard/,

  // Hook / verification bypass. Anchored to a flag boundary (preceding
  // whitespace or start of line) so a benign string that merely CONTAINS
  // "--no-verify" (a commit message, filename, grep argument, doc path) is not
  // false-blocked. Tradeoff (accepted for this example sentinel): this is a naive
  // whole-command regex, not the plugin's quote-aware tokenizer (hooks/git-guard.js),
  // so an interpreter wrapper (sh -c "...") or alias can still bypass it. For a
  // hardened gate, reuse git-guard's argv-position tokenizer instead.
  /(^|\s)--no-verify(\s|=|$)/,
  /(^|\s)--no-gpg-sign(\s|=|$)/,

  // Force deletions
  /(^|\s)rm\s+-rf\s+/,
  /git\s+branch\s+-D/,

  // ---- PROJECT-SPECIFIC GATES (customize) -------------------------------
  // Examples — uncomment / adapt to your stack:
  //   /<deploy-cli>\s+deploy/,            // production deploy command
  //   /<payments-cli>\s+.*refund/,        // financial action
  //   /<db-cli>\s+.*delete\s+--all/,      // bulk data deletion
  // -----------------------------------------------------------------------
];

for (const p of PATTERNS) {
  if (p.test(cmd)) {
    process.stderr.write(
      '========================================================================\n' +
      'BLOCKED by feature-launch hard-gate sentinel.\n\n' +
      'Pattern matched: ' + p.toString() + '\n' +
      'Command:         ' + cmd + '\n\n' +
      'This command requires explicit human approval. See the project\'s hard\n' +
      'rules and Phase A.5 (AFK readiness gate) of the feature-launch skill.\n\n' +
      'If you believe this is a false positive, refine the regex in\n' +
      '.claude/hooks/feature-launch-hard-gates.js and re-run.\n' +
      '========================================================================\n'
    );
    process.exit(2);
  }
}

process.exit(0);
```

No `chmod` is needed: the hook is invoked as `node <path>`, not executed directly.

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
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/feature-launch-hard-gates.js\""
          }
        ]
      }
    ]
  }
}
```

If `hooks.PreToolUse` already exists, append to the array — don't replace.

> Windows note: `$CLAUDE_PROJECT_DIR` is expanded by Claude Code itself before the
> command runs, so the same `node "$CLAUDE_PROJECT_DIR/..."` entry works on Windows,
> macOS, and Linux. No PowerShell/cmd-specific variant is required.

## Verification

After installing, run these self-tests (Node is cross-platform; the JSON is passed
on stdin so no shell-specific quoting tricks are needed):

```bash
# Should BLOCK (exit 2)
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' | \
  node .claude/hooks/feature-launch-hard-gates.js
echo "exit: $?"   # expect 2

# Should ALLOW (exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | \
  node .claude/hooks/feature-launch-hard-gates.js
echo "exit: $?"   # expect 0

# Should BLOCK (exit 2)
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf build/"}}' | \
  node .claude/hooks/feature-launch-hard-gates.js
echo "exit: $?"   # expect 2

# Should ALLOW (exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | \
  node .claude/hooks/feature-launch-hard-gates.js
echo "exit: $?"   # expect 0
```

On Windows PowerShell, pipe the JSON the same way (`'{...}' | node .claude\hooks\feature-launch-hard-gates.js`).

If any test fails, the hook is broken — DO NOT enter autonomous mode until fixed.
Also add a verification case for every project-specific pattern you uncomment.

## Maintenance

When the hard-gate list changes (new deploy target, new payment provider, new
force-operation), update `PATTERNS` and add a verification case. The hook is
intentionally fail-open on unparseable input so it never wedges unrelated work; the
universal gates above always run as long as Node is present (the plugin's documented
prerequisite).

Hook ID: `feature-launch-hard-gates@v2` (pure-Node). Bump when patterns change.

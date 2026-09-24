---
name: anti-hall-auto-handover-config
description: Use when the user asks to change, disable, re-enable, or check the auto-handover context-threshold trigger — e.g. "turn off auto-handover", "set auto-handover to 80%", "stop nagging me to compact", "how often does the compact reminder fire", "what's the auto-handover threshold".
---

# Auto-handover config (Codex)

Shared with Claude: `hooks/auto-handover.js` (UserPromptSubmit) and
`hooks/auto-handover-pause-nag.js` (Stop) watch the MAIN agent's estimated
context usage and, once it first crosses a threshold (default 85%), tell the
agent to self-write a handover, inform the user, and suggest compacting/
clearing the session. It is **on by default** — no setup needed. Follow-up
reminders (a milestone nag every few points of further growth, and a
natural-pause nag at a quiet point) fire unless nagging is turned off.

Settings live in the shared `"autoHandover"` section of
`~/.anti-hall/settings.json` (via `hooks/lib/settings.js`) — identical file
and schema on both platforms:

```json
{ "autoHandover": { "enabled": true, "pct": 85, "nag": true, "nagStepPct": 5, "nagQuietMin": 15 } }
```

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions —
that variable is only set for plugin-bundled hook commands. Resolve the
plugin root from this skill's own file path (Codex shows it when selecting
the skill):

```bash
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

## Run the CLI

```bash
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" get [--json]
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" set <1-99>     # change the threshold
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" off           # disable entirely
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" on            # re-enable (default 85% if unset)
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" nag on|off    # toggle the follow-up reminders
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" nag-step <n>  # milestone step, in percentage points (default 5)
node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" nag-quiet <n> # minimum minutes between natural-pause nags (default 15)
```

After running a command, report back to the user in plain language what
changed, pulled straight from the script's own output.

## Notes

- `ANTIHALL_AUTO_HANDOVER_PCT` (env, `0` = off) overrides the file's `pct`/
  `enabled` for the CURRENT process only — the CLI above persists a change
  across sessions.
- **Codex-specific gap**: Codex has no equivalent of Claude's statusline
  `context_window` telemetry, and Claude's `PreCompact`/`PostCompact` events
  are not yet mapped to Codex payloads (`codex/README.md`). This feature
  therefore relies ENTIRELY on the transcript-usage estimate
  (`hooks/lib/context-pct.js`) on Codex — if a Codex transcript's assistant
  entries don't carry the same Anthropic-shaped `usage` block Claude Code
  writes, the estimate silently returns nothing and the trigger never fires
  (fail-open, not a crash). Treat this as best-effort on Codex until verified
  against a real Codex transcript.

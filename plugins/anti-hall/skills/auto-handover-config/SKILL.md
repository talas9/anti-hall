---
name: auto-handover-config
description: Use when the user asks to change, disable, re-enable, or check the auto-handover context-threshold trigger — e.g. "turn off auto-handover", "set auto-handover to 80%", "stop nagging me to compact", "how often does the compact reminder fire", "what's the auto-handover threshold".
---

# Auto-handover config

The auto-handover trigger (`hooks/auto-handover.js` + `hooks/auto-handover-pause-nag.js`)
watches the MAIN agent's estimated context usage and, once it first crosses a
threshold (default 85%), tells the agent to self-write a handover, inform the
user, and suggest `/compact`/`/clear`. It is **on by default for every
session** — no setup needed. It also sends short follow-up reminders
(a milestone nag every few points of further growth, and a natural-pause nag
at a quiet point in the conversation) unless nagging is turned off.

Settings live in the shared `"autoHandover"` section of
`~/.anti-hall/settings.json` (via `hooks/lib/settings.js`):

```json
{ "autoHandover": { "enabled": true, "pct": 85, "nag": true, "nagStepPct": 5, "nagQuietMin": 15 } }
```

An absent file, or an absent field, means the default shown above. Never
edit this file by hand — always go through the CLI below, which does an
atomic read-modify-write and leaves every other setting untouched.

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

Resolve `$ANTI_HALL_ROOT` the same way other anti-hall scripts do: it's the
plugin root containing `.claude-plugin/plugin.json` (for a `/plugin install`,
this is under the plugin cache; for a repo clone, it's `plugins/anti-hall`).

After running a command, report back to the user in plain language what
changed (e.g. "auto-handover threshold set to 80%"), pulled straight from the
script's own output — don't paraphrase a number you didn't see it print.

## Notes

- `ANTIHALL_AUTO_HANDOVER_PCT` (env, `0` = off) overrides the file's `pct`/
  `enabled` for the CURRENT process only — the CLI above is what persists a
  change across sessions. See `hooks/lib/auto-handover-config.js` for the
  full precedence rule.
- The threshold is an ESTIMATE derived from the transcript's own token usage
  (`hooks/lib/context-pct.js`), not the harness's own context-window figure —
  it can read a few points off. If your context window is 1M-tokens (not the
  default 200k), set `ANTIHALL_CONTEXT_WINDOW_TOKENS` accordingly so the
  estimate stays accurate.

---
name: anti-hall-settings
description: Show or change any anti-hall setting for Codex. Use when the user says "anti-hall settings", "show/change anti-hall settings", "turn off X", "turn on X", "set auto-handover to 80%", "turn off auto-handover", "stop nagging me to compact", "what's the auto-handover threshold", or similar for any guard, Jev, statusline, limit-conservation, or DevSwarm knob.
---

# anti-hall settings for Codex

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — resolve
it from the path Codex shows you for this SKILL.md (see
`docs/KB-codex-platform-hooks-plugins.md`):

```bash
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

All commands below run as `node "$ANTI_HALL_ROOT/scripts/settings.js" <verb>`.

## No `/config` equivalent on Codex

Claude Code exposes a handful of these settings natively in its `/config` panel
(via `plugin.json`'s `userConfig`) as a convenience. **Codex has no equivalent** —
there is no native settings UI this plugin can register into. `~/.anti-hall/settings.json`
via this CLI/skill is the ONLY way to see or change a setting on Codex; it is
complete (every setting, not just the headline ones) and it is what the file-based
precedence chain falls back to on the Claude side too, so a value set here is
honored by both platforms sharing the same `~/.anti-hall/` home.

## Direct requests skip the menu

If the user already named the setting and the value ("turn off the merge gate",
"set auto-handover to 80%", "disable Jev"), resolve it straight to a `section.key`
and value and apply it — do not walk them through the menu below. Confirm by
re-running `get` on that one key afterward.

## Menu flow (when the user just says "show/change my settings")

1. Run:
   ```bash
   node "$ANTI_HALL_ROOT/scripts/settings.js" show
   ```
   Present the output as-is (already grouped into per-section markdown tables:
   Setting / Value / Default / Source / Description). Mention that advanced/tuning
   knobs are hidden by default and can be shown with `show --all` if asked.

2. Codex has no `AskUserQuestion` tool, so present choices as a **numbered list**
   in prose instead:
   - First, number the sections (autoHandover, guards, jev, limitConserve,
     devswarm, statusline, codexNudge, versionAlerts, updates, defects) and ask
     the user to pick one by number.
   - Then number that section's settings and ask again.
   - Then, for a `boolean` or `enum` setting, number its allowed values (an
     `enum`'s options come from the schema's `values` list; boolean is just
     1) true / 2) false) and ask the user to pick a number. For a `number` or
     `string`/`csv` setting, ask for a free value in prose instead (respecting
     any `min`/`max` shown in the table).

3. Apply the change:
   ```bash
   node "$ANTI_HALL_ROOT/scripts/settings.js" set <section.key> <value>
   ```
   A validation failure (out-of-range number, unknown enum value) is returned as
   `{ok:false, error}` on `--json` or a plain `error:` line otherwise — relay the
   error and re-ask for a valid value; never silently coerce or guess one.

4. Re-show just the changed row to confirm:
   ```bash
   node "$ANTI_HALL_ROOT/scripts/settings.js" get <section.key>
   ```

## Auto-handover (`autoHandover` section)

The auto-handover trigger (`hooks/auto-handover.js` + the Stop-time
`hooks/auto-handover-pause-nag.js`) is **on by default at 85%** of this session's actual context window (an optional absolute `maxTokens`
ceiling is available but off by default — see below). When the main agent first crosses it, it self-writes a handover, tells the user,
and suggests `/compact` or `/clear`. Follow-up reminders fire every `nagStepPct`
further points and at a quiet pause (at most once per `nagQuietMin` minutes)
unless `nag` is off.

| Key | Default | Meaning |
|---|---|---|
| `autoHandover.enabled` | `true` | the whole trigger |
| `autoHandover.pct` | `85` | threshold, 1-99 (env `ANTIHALL_AUTO_HANDOVER_PCT`; env `0` = off for that process) |
| `autoHandover.maxTokens` | `0` | opt-in absolute token ceiling (env `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS`; `0` = off, the default); when set, a real token count, so it fires the full directive even when the window is unknown |
| `autoHandover.nag` | `true` | follow-up reminders |
| `autoHandover.nagStepPct` | `5` | milestone step, in points |
| `autoHandover.nagQuietMin` | `15` | minutes between pause reminders |

"Turn off auto-handover" = `set autoHandover.enabled false`; "set auto-handover to
80%" = `set autoHandover.pct 80`. The older one-purpose CLI still works as an alias
over the same keys:
`node "$ANTI_HALL_ROOT/scripts/auto-handover-config.js" get [--json] | set <1-99> | off | on | max-tokens <n> | nag on|off | nag-step <n> | nag-quiet <n>`.

Context % comes from the best source available: the statusline's real
`context_window` figure (Claude), the rollout's `model_context_window` (Codex), else
a transcript estimate (`ANTIHALL_CONTEXT_WINDOW_TOKENS` overrides the window size). An
estimate with an unknown window gets only a soft advisory from the percent path (the
token ceiling still fires the directive). If a long autonomous turn never reaches a
new prompt, the Stop hook delivers the directive once instead. Before every compaction
`precompact-snapshot.js` writes a mechanical `PRECOMPACT-<n>.md` safety-net snapshot
next to the handovers (it never blocks compaction).

## Resetting a setting

`node "$ANTI_HALL_ROOT/scripts/settings.js" reset <section.key>` removes the
settings.json override for that one key, so the legacy source or schema default
takes over again.

## Scripting / non-interactive use

Every subcommand takes `--json`:
```bash
node "$ANTI_HALL_ROOT/scripts/settings.js" show --json
node "$ANTI_HALL_ROOT/scripts/settings.js" get jev.enabled --json
node "$ANTI_HALL_ROOT/scripts/settings.js" set limitConserve.threshold 90 --json
```

## What this skill never does

- Never edits `~/.anti-hall/settings.json` (or any legacy config file) by hand —
  always through `scripts/settings.js`.
- Never deletes a legacy config file (e.g. `~/.anti-hall/jev.json`) — anti-hall
  forward-migrates its values into `settings.json` once but always leaves the
  legacy file in place.
- Never invents a setting or value not in the schema — `scripts/settings.js show`
  is the source of truth.

---
name: settings
description: Show or change any anti-hall setting. Use when the user says "anti-hall settings", "show anti-hall settings", "change anti-hall settings", "turn off X", "turn on X", "set auto-handover to 80%", "turn off auto-handover", "stop nagging me to compact", "what's the auto-handover threshold", "what are my anti-hall settings", or similar for any guard, Jev, statusline, limit-conservation, or DevSwarm knob.
---

# Settings

anti-hall keeps every user-facing setting in ONE place: `~/.anti-hall/settings.json`,
organized into sections (autoHandover, guards, jev, limitConserve, devswarm,
statusline, ...). `scripts/settings.js` is the only thing that reads or writes it —
this skill is the conversational front door.

A handful of the most-changed settings (auto-handover, the merge gate, Jev, limit
conservation, DevSwarm supervisor mode, the statusline) are ALSO exposed natively
in Claude Code's `/config` panel (see `plugin.json`'s `userConfig`). Those are a
convenience for one-shot changes from `/config`; this skill and
`~/.anti-hall/settings.json` remain the complete picture and the only way to see or
change everything. If `show` reports a setting's source as `/config` and the user
changes it here instead, the new value is stored in settings.json and WINS from
then on (env > file > `/config` > legacy > default) — `reset` removes that override
so `/config` takes over again. Known limitation: a `/config` value equal to the manifest default counts as unset
(a lower tier answers); to pin a default-valued setting, set it here.

## Direct requests skip the menu

If the user already named the setting and the value ("turn off the merge gate",
"set auto-handover to 80%", "disable Jev", "hide the statusline email"), resolve it
straight to a `section.key` and value and apply it — do not walk them through the
menu below. Confirm by re-running `get` on that one key afterward.

## Menu flow (when the user just says "show/change my settings")

1. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show
   ```
   Present the output as-is (it is already grouped into per-section markdown
   tables with a Setting / Value / Default / Source / Description) — do not
   re-summarize it into prose. Mention that a section's advanced/tuning knobs are
   hidden by default and can be shown with `show --all` (or
   `show --section <key> --all` for one section) if the user asks for more detail.

2. Use `AskUserQuestion` to let the user pick a **section** (autoHandover, guards,
   jev, limitConserve, devswarm, statusline, codexNudge, versionAlerts, updates,
   defects), then a **setting** within it, then a **value**:
   - For a `boolean` or `enum` setting, offer its allowed values as multiple-choice
     options (an `enum`'s options come straight from the schema's `values` list;
     boolean is just true/false).
   - For a `number` or `string`/`csv` setting, ask for a free value in prose
     instead of `AskUserQuestion` (respecting any `min`/`max` shown in the table).

3. Apply the change:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" set <section.key> <value>
   ```
   A validation failure (out-of-range number, unknown enum value) is returned as
   `{ok:false, error}` on `--json` or a plain `error:` line otherwise — relay the
   error and re-ask for a valid value; never silently coerce or guess one.

4. Re-show just the changed row to confirm:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" get <section.key>
   ```

## Auto-handover (`autoHandover` section)

The auto-handover trigger (`hooks/auto-handover.js` + the Stop-time
`hooks/auto-handover-pause-nag.js`) is **on by default at 85%** context, or at an absolute ceiling of 170000 tokens,
whichever comes first. When the main agent first crosses it, it self-writes a handover, tells the user,
and suggests `/compact` or `/clear`. Follow-up reminders fire every `nagStepPct`
further points and at a quiet pause (at most once per `nagQuietMin` minutes)
unless `nag` is off.

| Key | Default | Meaning |
|---|---|---|
| `autoHandover.enabled` | `true` | the whole trigger |
| `autoHandover.pct` | `85` | threshold, 1-99 (env `ANTIHALL_AUTO_HANDOVER_PCT`; env `0` = off for that process) |
| `autoHandover.maxTokens` | `170000` | absolute token ceiling (env `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS`; `0` = off); real token count, so it fires the full directive even when the window is unknown |
| `autoHandover.nag` | `true` | follow-up reminders |
| `autoHandover.nagStepPct` | `5` | milestone step, in points |
| `autoHandover.nagQuietMin` | `15` | minutes between pause reminders |

"Turn off auto-handover" = `set autoHandover.enabled false`; "set auto-handover to
80%" = `set autoHandover.pct 80`. The older one-purpose CLI still works as an alias
over the same keys:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/auto-handover-config.js" get [--json] | set <1-99> | off | on | max-tokens <n> | nag on|off | nag-step <n> | nag-quiet <n>`.

Context % comes from the best source available: the statusline's real
`context_window` figure (Claude), the rollout's `model_context_window` (Codex), else
a transcript estimate (`ANTIHALL_CONTEXT_WINDOW_TOKENS` overrides the window size). An
estimate with an unknown window gets only a soft advisory from the percent path (the
token ceiling still fires the directive). If a long autonomous turn never reaches a
new prompt, the Stop hook delivers the directive once instead. Before every compaction
`precompact-snapshot.js` writes a mechanical `PRECOMPACT-<n>.md` safety-net snapshot
next to the handovers (it never blocks compaction).

## Resetting a setting

`node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" reset <section.key>` removes the
settings.json override for that one key, so `/config` (if the key has a
`pluginOption`), the legacy source, or the schema default takes over again.

## Scripting / non-interactive use

Every subcommand takes `--json` for machine-readable output:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --section jev --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" get jev.enabled --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" set limitConserve.threshold 90 --json
```

## What this skill never does

- Never edits `~/.anti-hall/settings.json` (or any legacy config file) by hand —
  always through `scripts/settings.js`, so validation and the atomic write always
  run.
- Never deletes a legacy config file (e.g. `~/.anti-hall/jev.json`) — anti-hall
  forward-migrates its values into `settings.json` once (see
  `companion/lib/migrations.js`) but always leaves the legacy file in place.
- Never invents a setting or value not in the schema — `scripts/settings.js show`
  is the source of truth for what exists and what it currently is.

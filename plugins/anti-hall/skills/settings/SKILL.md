---
name: settings
description: Show or change any anti-hall setting. Use when the user says "anti-hall settings", "show anti-hall settings", "change anti-hall settings", "turn off X", "turn on X", "set auto-handover to 80%", "turn off auto-handover", "stop nagging me to compact", "what's the auto-handover threshold", "what are my anti-hall settings", or similar for any guard, Jev, statusline, limit-conservation, or DevSwarm knob.
---

# Settings

anti-hall keeps every user-facing setting in ONE place: `~/.anti-hall/settings.json`,
organized into sections (autoHandover, guards, jev, limitConserve, devswarm,
statusline, ...). `scripts/settings.js` is the only thing that reads or writes it.

## Default: point the user at `/config`

Every non-advanced setting is a row in Claude Code's native **`/config`** panel
(declared in `plugin.json`'s `userConfig`). Titles carry the section as a prefix
("Auto Handover · Threshold %", "Guards · Merge-readiness gate"); enum settings are
pickers; everything is edited with the arrow keys, no model involved. When the user just
says "anti-hall settings" / "change my settings", tell them that in one or two lines:

> Change settings in `/config` (the anti-hall rows) — arrow keys, no model; or tell me
> "set X to Y".

Do not run `show` or print tables for this. Advanced/tuning knobs are NOT in `/config`;
for those, use a direct change below (`show --section <key> --all` lists them if asked).

## Direct named changes: one `set`, no table

When the user names a setting and a value ("turn off the merge gate", "set auto-handover
to 80%", "disable Jev", "hide the statusline email"), resolve it to a `section.key` and
value and apply it:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" set <section.key> <value>
```
then confirm with the single-key line from `get <section.key>`. Never print the full
table for a direct change. A validation failure (out-of-range number, unknown enum value)
comes back as `{ok:false, error}` on `--json` or an `error:` line otherwise — relay it
and ask for a valid value; never silently coerce or guess one.

A value set this way is stored in settings.json and WINS over `/config` from then on
(env > file > `/config` > legacy > default); `reset <section.key>` removes the override
so the `/config` row takes over again. Known limitation: a `/config` value equal to the
manifest default counts as unset (a lower tier answers); to pin a default-valued
setting, `set` it here.

## `show` only when asked

Only when the user explicitly asks to see settings ("show my anti-hall settings", "what
are my settings"), run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show            # or: show --section <key> [--all]
```
and present the output as-is (per-section markdown tables; the Source column says
which tier answered — `/config`, `file`, `env`, `legacy`, `default`).
A question about ONE value ("what's the auto-handover threshold") is a single
`get <section.key>`, not a `show`.

## Auto-handover (`autoHandover` section)

The auto-handover trigger (`hooks/auto-handover.js` + the Stop-time
`hooks/auto-handover-pause-nag.js`) is **on by default at 85%** of this session's actual context window (an optional absolute `maxTokens`
ceiling is available but off by default — see below). When the main agent first crosses it, it self-writes a handover, tells the user,
and suggests `/compact` or `/clear`. Follow-up reminders fire every `nagStepPct`
further points and at a quiet pause (at most once per `nagQuietMin` minutes, and
never the same percentage twice within one step) unless `nag` is off.

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

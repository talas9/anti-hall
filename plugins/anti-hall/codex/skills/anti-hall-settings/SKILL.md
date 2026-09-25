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

On Claude Code every non-advanced setting is an arrow-key row in the native `/config`
panel (via `plugin.json`'s `userConfig`, section-prefixed titles). **Codex has no
equivalent** — its plugin manifest has no `userConfig` and there is no plugin settings UI.
On Codex this skill (over `scripts/settings.js`) is the ONLY way to see or change a
setting. It is complete (every setting, advanced included), and a value set here lands
in `~/.anti-hall/settings.json`, which both platforms read from the same `~/.anti-hall/` home.

## Direct named changes: one `set`, no table

If the user named the setting and the value ("turn off the merge gate", "set
auto-handover to 80%", "disable Jev"), resolve it to a `section.key` and value and apply it:
```bash
node "$ANTI_HALL_ROOT/scripts/settings.js" set <section.key> <value>
```
then confirm with the single-key line from `get <section.key>`. Never print the full
table for a direct change. A validation failure (out-of-range number, unknown enum
value) comes back as `{ok:false, error}` on `--json` or an `error:` line otherwise —
relay it and ask for a valid value; never silently coerce or guess one. A question
about ONE value is a single `get <section.key>`. A safety key (see below) needs the
extra `--confirmed` step instead of a plain `set`.

## Safety guards: a human direct command, or a confirmed warning — never inferred

`safety.gitGuard`, `safety.commandGuard`, `safety.editGuard`, `safety.swarmGuard`,
`guards.stashGuard`, `guards.editGuardAllow` and `guards.allowSubagentMailbox` are
safety keys (owner decision: no hard refusal — a human direct command, or a
confirmation after a clear, plain warning, is enough). `set`/`reset` on one of these
needs `--confirmed`; without it, nothing changes and the CLI returns one short,
factual, human-readable line (`{ok:false, needsConfirmation:true, warning}` on
`--json`) — calm facts, not alarming, built from that key's own one-sentence
`safetyNote` in the schema.

- **The user directly asked to change that guard** ("turn off git-guard") — that
  request IS the confirmation. Run `set`/`reset` with `--confirmed` right away.
- **Otherwise** — Codex has no `AskUserQuestion` tool, so show the one-line warning
  in prose and ask a plain yes/no: "1) Yes, change it  2) No, keep it". Apply
  (`--confirmed`) only on yes; on no, or on no answer, leave it unchanged.
- **Never infer consent**, and never add `--confirmed` on your own initiative to get
  past the warning.

A one-off pause is still the per-guard `skip.json` escape hatch, only on the user's
explicit request.

## Turning a hook off

Every hook the Codex port registers reads the same switch as on Claude Code, so "turn
off X" is one `set <section.key> false`: `context.*` (verify-first injections, task
tracker, handover resume, defect nudge), `maintenance.*` (repair-on-reload, progress
prune, pre-compact snapshot, task lifecycle log), `guards.*` (speculation, claim ledger,
task, task-list; `guards.modelRouting` takes `strict|advisory|off`), and `devswarm.*`
(parentGate, childGate, parentInbox, childTurn, childRole, childDrain,
parentReplyTracker, wakeWatch, appSync, screenshotSync). `show` ends with the parts that
have no switch on purpose, and why.

## Browsing (only when the user asks to see or pick settings)

1. `show` prints every section's tables — run it ONLY when the user explicitly asks to
   see their settings:
   ```bash
   node "$ANTI_HALL_ROOT/scripts/settings.js" show        # or: show --section <key> [--all]
   ```
   Present the output as-is. Advanced/tuning knobs are hidden unless `--all`.

2. To help the user pick without a wall of tables, Codex has no `AskUserQuestion`
   tool, so use **numbered lists** in prose:
   - Number the sections (autoHandover, guards, safety, context, maintenance, jev,
     jevIntegrations, limitConserve, devswarm, statusline, codexNudge, versionAlerts,
     updates, defects); ask for one.
   - Show just that section (`show --section <key>`), number its settings, ask again.
   - For a `boolean` or `enum` setting, number its allowed values (enum `values`
     from the schema; boolean is 1) true / 2) false). For a `number` or
     `string`/`csv` setting, ask for a free value (respecting any `min`/`max`).

3. Apply with `set` and confirm with `get`, as above.

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

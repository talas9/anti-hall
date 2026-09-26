---
name: settings
description: Show or change any anti-hall setting. Use when the user says "anti-hall settings", "show anti-hall settings", "change anti-hall settings", "turn off X", "turn on X", "set auto-handover to 80%", "turn off auto-handover", "stop nagging me to compact", "what's the auto-handover threshold", "what are my anti-hall settings", or similar for any guard, Jev, statusline, limit-conservation, or DevSwarm knob.
---

# Settings

anti-hall keeps every user-facing setting in ONE place: `~/.anti-hall/settings.json`,
organized into sections (autoHandover, guards, safety, context, maintenance, jev,
jevIntegrations, limitConserve, devswarm, statusline, ...). `scripts/settings.js` is the
only thing that reads or writes it. Every hook anti-hall registers has an on/off switch
(default = on, the old behaviour); `show` ends with the short list of parts that have no
switch on purpose, and why. `jevIntegrations` (v0.108.4) is a dedicated section holding
all 14 per-integration Jev trust modes as their own rows/settings — see the `jev` skill's
"Per-integration modes" for the full table.

## Default: point the user at `/config`

Every non-advanced setting is a row in Claude Code's native **`/config`** panel
(declared in `plugin.json`'s `userConfig`). Titles carry the section as a prefix
("Auto Handover · Threshold %", "Guards · Merge-readiness gate"); enum settings are
text fields whose description lists the allowed values; no model involved. When the user just
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
and ask for a valid value; never silently coerce or guess one. A safety key (see below)
needs the extra `--confirmed` step instead of a plain `set`.

A value set this way is stored in settings.json and WINS over `/config` from then on
(env > file > `/config` > legacy > default); `reset <section.key>` removes the override
so the `/config` row takes over again. Known limitation: a `/config` value equal to the
manifest default counts as unset (a lower tier answers); to pin a default-valued
setting, `set` it here.

## Safety guards: a human direct command, or a confirmed warning — never inferred

`safety.gitGuard`, `safety.commandGuard`, `safety.editGuard`, `safety.swarmGuard`,
`guards.stashGuard`, `guards.editGuardAllow` and `guards.allowSubagentMailbox` are
safety keys (owner decision: no hard refusal — a human direct command, or a
confirmation after a clear, plain warning, is enough). `set` to the risky value (a guard off, a
bypass on, a new allow-list path) needs `--confirmed`, and so does a `reset` whose
fallback value is the risky one (e.g. resetting an armed `guards.stashGuard`, whose
default is off); re-arming a guard, narrowing a list, or a reset back to a safe default
does not. Without `--confirmed`, nothing changes and the CLI returns one short,
factual, human-readable line (`{ok:false, needsConfirmation:true, warning}` on
`--json`) — calm facts, not alarming, built from that key's own one-sentence
`safetyNote` in the schema.

- **The user directly asked to change that guard** ("turn off git-guard", "disable
  the stash guard") — that request IS the confirmation. Run `set`/`reset` with
  `--confirmed` right away; do not ask again.
- **Otherwise** (you are about to touch a safety key as a side effect of something
  else the user asked for) — show the one-line warning verbatim (or run the command
  once without `--confirmed` and relay the `warning` it returns), then ask with
  **AskUserQuestion**: "Yes, change it" / "No, keep it". Apply (`--confirmed`) only
  on yes; on no, or on no answer, leave it unchanged and say so.
- **Never infer consent** from context, and never add `--confirmed` on your own
  initiative to get past the warning — that is exactly the case this gate exists for.

A value in `~/.anti-hall/settings.json` counts for these keys like any other (normal
precedence: env > settings.json > `/config` > default). Nothing mechanically stops an
agent from writing that file directly; the owner chose consent over an extra guard, so
the rule is the same as above — never hand-edit a safety key in settings.json to get
around the confirmation.

A one-off pause is still the per-guard `skip.json` escape hatch, only on the user's
explicit request.

## Trusting a project command allowlist

A repo can list its own sanctioned commands in `<repo>/.anti-hall/command-allow.json`
(`{"patterns":["^literal command ...$"]}`), which command-guard then lets the main
thread run inline. Because that file lives in the working tree, a cloned repo could
ship one — so it applies ONLY after the user trusts that exact file content with `trust-command-allow`:

```
node <plugin-root>/scripts/settings.js trust-command-allow [<repo>]              # print patterns, record nothing
node <plugin-root>/scripts/settings.js trust-command-allow [<repo>] --confirmed  # record the trust
```

Trust is a sha256 of the file bytes stored OUTSIDE the repo in
`~/.anti-hall/trusted-command-allow.json`, keyed by the repo's real path; any edit to
the file makes it untrusted until re-trusted. A symlinked allowlist is refused.
Patterns must start with `^` + a literal command word and end with `$`; unbounded
wildcards (`.*`, `.+`, `[^x]*`) and top-level `|` are ignored. `/anti-hall:doctor`
reports untrusted/changed allowlists and ignored patterns. Same consent rule as the
safety keys above: `--confirmed` only on the user's direct request or a yes after
showing them the printed patterns — never on your own initiative.

## Turning a hook off

"Turn off the task-list nudge", "stop the per-turn verify-first line", "disable the
parent gate" and the like are one `set <section.key> false`. The switch keys:
`context.*` (verify-first injections, task tracker, handover resume, defect nudge),
`maintenance.*` (repair-on-reload, progress prune, pre-compact snapshot, task
lifecycle log, session-end MCP reaper), `guards.*` (api, speculation, claim ledger,
task, task-list, scan throttle; `guards.modelRouting` takes `strict|advisory|off`;
`guards.injectionRepeatEvery` — turns between full re-injections of a static
per-turn reminder block (VERIFY-FIRST, the DevSwarm PRIMARY dispatch-tier/
top-fan-out-tier suffixes) once its first-turn/post-compact copy is consumed,
default 10, 0 = every turn; `guards.codexQuotaDetect` — record a Codex
quota/rate-limit exhaustion seen in a `codex:codex-rescue` result so other
sessions stop rediscovering it independently, default on),
and `devswarm.*` (parentGate, childGate, parentInbox, childTurn, childRole, childDrain,
parentReplyTracker, commsGuard, inboxReadGuard, wakeWatch, appSync, screenshotSync, spawnFromOrigin).
Settings are read when each hook runs, so a change applies from the next hook call.

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

**Post-handover new-work gate (v0.109.0, `gateNewWork`, on by default).** Once
usage is past the threshold AND this session's handover file has been written,
each new request gets a short directive: the agent judges the request's size
itself BEFORE starting it, and if it would need more than `gateBudgetPct` (default
5) points of the context window it offers two choices — (a) add it to the task
list and the handover and start it after `/compact` or `/clear`, or (b) proceed
anyway if you insist (an explicit insistence always overrides the gate). Quick
questions, finishing the in-flight task the handover names, and spawning a
DevSwarm workspace pass straight through. A measured backstop sends ONE reminder
per handover once usage grows more than `gateBudgetPct` points past where the
handover was saved: refresh the handover and offer to park the rest.

**Decisive compact/clear prompt (v0.109.5, `decisivePrompt`, on by default).** At a
turn-ending Stop point (the fire-once or the natural-pause nag in
`hooks/auto-handover-pause-nag.js`), once this session's `HANDOVER*.md` exists and
is fresh (no counted file-changing action — including subagent edits and Bash
writes — happened after it was written; the same shared detector
`tasklist-guard.js` uses), the directive tells the agent to END its
reply with one prominent, glyph-led line naming the exact command: `🟢 **GOOD POINT
TO /compact NOW**: handover saved at <path>. /compact keeps working on the same
task; /clear if the next task is different.` — or, when the handover's own "Open
items"/"Next action" read as done, `🟢 **GOOD POINT TO /clear NOW**` instead. If the
handover has gone STALE since it was written, the line becomes `⚠️ **Refresh the
handover first**, then /compact` and never claims a "good point". If freshness cannot
be determined (no readable transcript, e.g. a Codex rollout), the line is a neutral
`📝 Handover saved at <path>. If you've continued working since, refresh it; then
/compact.` — never 🟢. "Next action" counts as done only when it reads exactly
none/done/complete/nothing. Codex sessions get
`/new` in place of `/clear`. Off reverts to the plain (non-decisive) fire/pause-nag
wording.

| Key | Default | Meaning |
|---|---|---|
| `autoHandover.enabled` | `true` | the whole trigger |
| `autoHandover.pct` | `85` | threshold, 1-99 (env `ANTIHALL_AUTO_HANDOVER_PCT`; env `0` = off for that process) |
| `autoHandover.maxTokens` | `0` | opt-in absolute token ceiling (env `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS`; `0` = off, the default); when set, a real token count, so it fires the full directive even when the window is unknown |
| `autoHandover.nag` | `true` | follow-up reminders |
| `autoHandover.nagStepPct` | `5` | milestone step, in points |
| `autoHandover.nagQuietMin` | `15` | minutes between pause reminders |
| `autoHandover.gateNewWork` | `true` | post-handover new-work gate (size-first, park-or-proceed offer) |
| `autoHandover.gateBudgetPct` | `5` | post-handover budget in context-window points, 1-50; also the one-shot backstop distance |
| `autoHandover.decisivePrompt` | `true` | end-of-reply decisive `/compact`\|`/clear`\|`/new` line (or "refresh first" when stale) at a turn-ending Stop point |

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

---
name: settings
description: Show or change anti-hall settings. Use for "anti-hall settings", "turn off X", "set auto-handover to 80%".
---

# Settings

## When to use

Show or change any anti-hall setting. Use when the user says "anti-hall settings", "show anti-hall settings", "change anti-hall settings", "turn off X", "turn on X", "set auto-handover to 80%", "turn off auto-handover", "stop nagging me to compact", "what's the auto-handover threshold", "what are my anti-hall settings", or similar for any guard, Jev, statusline, limit-conservation, or DevSwarm knob.

anti-hall keeps every user-facing setting in ONE place: `~/.anti-hall/settings.json`,
organized into sections (autoHandover, guards, safety, context, maintenance, jev,
jevIntegrations, limitConserve, devswarm, statusline, ...). `scripts/settings.js` is the
only thing that reads or writes it. Every hook anti-hall registers has an on/off switch
(default = on, the old behaviour); `show` ends with the short list of parts that have no
switch on purpose, and why. `jevIntegrations` (v0.108.4) is a dedicated section holding
every per-integration Jev trust mode as its own row/setting — see the `jev` skill's
"Per-integration modes" for the full table.

## Default: grouped `show`, then the section

`/config` (the plugin's options screen) has only the headline switches (auto-handover on/threshold,
Jev on, DevSwarm supervisor mode, model routing, limit conservation), the four safety guards and
the API keys. Every other setting lives in `~/.anti-hall/settings.json`, grouped by category
(section). When the user says "anti-hall settings" / "change my settings":

1. Run the grouped overview, one table per category, and tell them which categories exist:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show`
2. Then show only the category they care about:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --section <category> [--all]`
3. Change with `set <section.key> <value>`, undo with `reset <section.key>` (below).

A non-default value set in Claude Code's plugin options in earlier versions is copied into
`~/.anti-hall/settings.json` by the update or `doctor --repair` run of the first release that
runs the migration (safety keys are copied as human-confirmed values), and still resolves
until then (a stored plugin option stays a read-only source below the settings file);
`/anti-hall:settings` is the place to see and change every setting.

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

A value set this way is stored in settings.json and WINS over any stored plugin option
(env > file > plugin option > legacy > default); `reset <section.key>` removes the override
so the stored plugin option (any setting that has one, row or not), the legacy source or the default takes over again.
Known limitation: a plugin-option value equal to the default counts as unset (a lower tier
answers); to pin a default-valued setting, `set` it here.

## Safety guards: a human direct command, or a confirmed warning — never inferred

`safety.gitGuard`, `safety.commandGuard`, `safety.editGuard`, `safety.swarmGuard`,
`guards.stashGuard`, `guards.editGuardAllow`, `guards.allowSubagentMailbox` and
`devswarm.maintainerNotice.post` are safety keys (owner decision: no hard refusal — a human direct command, or a
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
precedence: env > settings.json > plugin option > default). Nothing mechanically stops an
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

## Trusting a project doc-edit allowlist

A repo can list repo-relative globs in `<repo>/.anti-hall/edit-allow.json`
(`{"paths":["docs/**","PLAN.md","*.md"]}`). edit-guard then lets the main thread
(a DevSwarm Primary or coordinator) Edit/Write matching files directly instead of
delegating them. It uses the same trust model as the command allowlist and applies
only after the user trusts that exact file content with `trust-edit-allow`:

```
node <plugin-root>/scripts/settings.js trust-edit-allow [<repo>]              # print paths, record nothing
node <plugin-root>/scripts/settings.js trust-edit-allow [<repo>] --confirmed  # record the trust
```

Trust lives in `~/.anti-hall/trusted-edit-allow.json`, and any edit to the file revokes
it. A symlinked file is refused. Absolute paths, `..` and match-everything globs (`**`,
`*`, `**/*`) are ignored. A match never covers a path outside the repo, `.git`,
`.anti-hall` (so the file cannot authorize itself; the main thread may not edit it at
all), `.claude`, `.codex`, hook config, or `~/.claude`. Subagents are unaffected.
Kill-switch: `guards.projectEditAllow=false`.

## Semantic judge: `judge on|off|status`

The opt-in speculation-judge (`jev.semanticJudge`, off by default) has a one-line switch:

```bash
node <plugin-root>/scripts/settings.js judge on|off|status
```

`on` sets the flag, then says whether an Anthropic key is visible to the CLI (never the key
itself; a key stored as a plugin option is visible to hooks only, so "not visible" means
unverified from the CLI) and how to add one, and prints the cost: about $0.0001–0.001 and
1–3 s per turn end, estimated, not measured; no precision eval yet. `status` shows on/off, key
visibility and the model (`jev.judgeModel`). Relay that output; do not add claims about accuracy.

## Turning a hook off

"Turn off the task-list nudge", "stop the per-turn verify-first line", "disable the
parent gate" and the like are one `set <section.key> false`. The switch keys:
`context.*` (verify-first injections, task tracker, handover resume, defect nudge;
`context.protocolLevel` (`compact` default / `full` = today's complete text everywhere, the one-key rollback) and `context.orchFullOn` (`auto` default / `spawn` / `session` / `off`: when the full orchestration rules arrive under compact);
`context.dedupeWindowMin` — fallback per-session suppression window (minutes) for
repeated UserPromptSubmit blocks (LIMIT CONSERVATION, TASK-LIST, DEVSWARM COMMS
OVERRIDE, DEVSWARM WORKSPACES) when a burst of queued prompts lands in one turn,
default 20, 0 = off/disables emit-dedupe entirely; suppression counts surface in
`/anti-hall:doctor`),
`maintenance.*` (repair-on-reload, progress prune, pre-compact snapshot, task
lifecycle log, session-end MCP reaper), `guards.*` (api, speculation, claim ledger,
task, task-list, scan throttle; `guards.modelRouting` takes `strict|advisory|off`;
`guards.noBlockingQuestions` takes `off|advise|block` (default `off`; Claude only — watches the
`AskUserQuestion` tool; live firing not yet verified, see docs/KB-claude-code-hooks.md);
`guards.questionAgentsNote` (default on) adds one advisory line to a question asked while background
agents are in flight, independent of that mode;
`guards.sharedTreeAgentNote` (default on) adds one advisory sentence when a write-capable agent is
spawned without `isolation:"worktree"` while another write-capable agent runs in the same working tree;
`guards.mergeSidePickAdvisory` (default on) adds one advisory to a push when a conflict was resolved by
taking one side wholesale (`--ours`/`--theirs`, `-X ours|theirs`) and no test run followed;
`guards.injectionRepeatEvery` — turns between full re-injections of a static
per-turn reminder block (VERIFY-FIRST, the DevSwarm PRIMARY dispatch-tier/
top-fan-out-tier suffixes) once its first-turn/post-compact copy is consumed,
default 10, 0 = every turn; `guards.codexQuotaDetect` — record a Codex
quota/rate-limit exhaustion seen in a `codex:codex-rescue` result so other
sessions stop rediscovering it independently, default on;
`guards.coordinatorWorkWindowMinutes` (default 10, 0 = off; main-thread state-changing Bash calls counted over that many minutes — in a non-git project only coordinator-writable or fresh scripts count),
`guards.coordinatorWorkNudgeAt` (default 4, 0 = no nudge), `guards.coordinatorWorkBlockAt` (default 7, 0 = no block; recovery commands and loosely matched inline code are never blocked),
`guards.coordinatorWorkMaxEntries` (default 50, min 1) `guards.bashEditParity` (default on — command-guard applies edit-guard's verdict to Bash writes into repo files in the main thread) and `guards.shellWriteChecks` (default on — api-guard and ship-it-guard also check Bash file writes)),
and `devswarm.*` (parentGate, childGate, parentInbox, childTurn, childRole, childDrain,
parentReplyTracker, commsGuard, inboxReadGuard, wakeWatch, appSync, screenshotSync, spawnFromOrigin;
`dispatchTierText` turns the Primary dispatch-tier text off everywhere, `inlineWorkNudge` (independent of it) the once-per-session
nudge to spin a child workspace after `inlineWorkNudgeThreshold` inline edits; `tickRosterEvery` N>0 appends the
roster to every Nth `inbox tick --quiet`, default 0 = off). The new question/dispatch/nudge/roster keys have no
/config row (settings file or env only, like every non-headline setting).
Settings are read when each hook runs, so a change applies from the next hook call.

## `show` only when asked

Only when the user explicitly asks to see settings ("show my anti-hall settings", "what
are my settings"), run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show            # or: show --section <key> [--all]
```
and present the output as-is (per-section markdown tables; the Source column says
which tier answered — `plugin-option` (a stored plugin option), `file`, `env`, `legacy`, `default`).
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
settings.json override for that one key, so the stored plugin option (if the key has a
`pluginOption`), the legacy source, or the schema default takes over again.

## Scripting / non-interactive use

Every subcommand takes `--json` for machine-readable output:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --section jev --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" get jev.enabled --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" set limitConserve.threshold 90 --json
```

`show --section jev` (and `--section jevIntegrations`) also prints **Jev integrations —
effective mode**: every integration id, the mode the runtime actually applies (master
switch and `ANTIHALL_JEV_<ID>=0` folded in), the stored value, its source tier, and the
log it writes to (`jevEffectiveIntegrations` in `--json`). `speculation`, `triage` and
`findingDedup` usually show source `default`: no install writes them, so they run on the
schema default `on`.

## What this skill never does

- Never edits `~/.anti-hall/settings.json` (or any legacy config file) by hand —
  always through `scripts/settings.js`, so validation and the atomic write always
  run.
- Never deletes a legacy config file (e.g. `~/.anti-hall/jev.json`) — anti-hall
  forward-migrates its values into `settings.json` once (see
  `companion/lib/migrations.js`) but always leaves the legacy file in place.
- Never invents a setting or value not in the schema — `scripts/settings.js show`
  is the source of truth for what exists and what it currently is.

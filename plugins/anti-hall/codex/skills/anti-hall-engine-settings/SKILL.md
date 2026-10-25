---
name: anti-hall-engine-settings
description: "Use when changing or reading an anti-hall setting or switch, looking up an engine reference, or configuring the Jev classifier."
---

# Settings and Jev

Settings switches, the generated reference and the Jev classifier.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine auto-handover-config` | `<get [--json]\|set <1-99>\|off\|on\|nag on\|off\|nag-step <n>\|nag-quiet <n>\|max-tokens <n>>` Get or change the auto-handover trigger's settings: `get [--json]` (the resolved values and... | main, codex |
| `ah-engine config` | `[validate <file>\|heal\|set <key> <value> [--check] [--confirmed]\|reset <key> [--confirmed]\|undo <id> [--confirmed]\|apply\|history [--limit <n>] [--key <k>] [--verb <v>]]` Show the effective config and where each value comes from, validate a config file, or `heal` the... | main, codex, workspace, subagent (owner args: heal, set, reset, undo, apply) |
| `ah-engine describe` | `[--part <a,b,...>] [--coverage]` The engine's generated self-description for the dashboard and agents: the generated reference... | main, codex, workspace, subagent |
| `ah-engine docs` | `[--format md\|skill\|skill-list] [--host <host>] [--name <path>] [--out <file>]` Print the generated reference: every command, setting, metric, impact kind, check and error code | main, codex, workspace, subagent |
| `ah-engine finding-dedup` | `[--file <findings.json>]` Advisory duplicate-finding detector for the deadly-loop reviewers: reads a JSON array of... | main, codex, workspace, subagent |
| `ah-engine install-statusline` | `` Retired no-op kept for old invocations: prints that anti-hall no longer writes a command-backed... | main, codex |
| `ah-engine jev` | `<ask\|status\|scrub\|evidence>` The optional Jev lane (D34-D38): `ask` reads JSON requests, one per stdin line, and prints each... | main, codex, workspace, subagent (owner args: ask, evidence, arrival) |
| `ah-engine jev-report` | `[--json] [--days N] [--window 24h\|7d] [--by project\|session] [--project <name>] [--weekly] \| label <hash> [tp\|fp] \| prune-audit --days N` The Jev report of the /anti-hall:jev skill: per-integration calls, agreement, changed decisions,... | main, codex, workspace, subagent (owner args: label, prune-audit) |
| `ah-engine jev-setup` | `<status\|enable\|disable\|set-key\|bind-generic-key\|test\|mode\|review-due\|reviewed\|snooze> [--days <n>] [--transport vercel\|typesafe] [--fallback vercel\|typesafe\|none] [--role fallback] [--vendor vercel\|typesafe]` Activate, configure and inspect the opt-in Jev classifier: `status` (resolved settings, key... | main, codex |
| `ah-engine jev_sweep` | `` The scheduled Jev evidence sweep (the `jev_sweep` job): gathers the WaitKind, Loop and StepMap... | main, codex |
| `ah-engine phase` | `<set\|advance\|step\|agents\|update\|clear> [args]` Write or update the phase state the status line's phase bar shows: `set <code> <desc> <done>... | main, codex |
| `ah-engine settings` | `<show\|get\|set\|reset\|judge\|tunables\|trust-command-allow\|trust-edit-allow> [args] [--section <key>] [--all] [--confirmed] [--json]` Show or change any anti-hall setting: `show [--section <key>] [--all]`, `get <section.key>`,... | main, codex, workspace, subagent (owner args: set, reset, judge, trust-command-allow, trust-edit-allow) |
| `ah-engine statusline` | `(session JSON on stdin)` The two-line status line the host runs after each turn (L9a): reads the session JSON on stdin;... | main, codex, workspace, subagent |
| `ah-engine uninstall-statusline` | `[--user\|--project] [--purge-base]` Take an older anti-hall status line out of the host's settings: restores the saved original... | main, codex |

## Guards

- `speculation-guard`: Stop gate: blocks once per reply that states something with a hedge word and no evidence or...
- `speculation-judge`: Stop: the opt-in semantic judge; answers every path without a model call, and asks the Claude...
- `claim-ledger`: Stop, never blocks: records the checkable claims of the last reply that no evidence in the...
- `claim-evidence-guard`: Stop (Claude): holds once a reply that claims a result (tests pass, verified, deployed, is...
- `output-verify-guard`: PostToolUse advisory: flags a test-runner output with both a passing and a failing signal; asks...
- `jev-weekly-scorecard`: Stays silent when the weekly Jev scorecard notice cannot be due (Jev off, notice off, child...
- `jev-review-reminder`: SessionStart notices of Jev: the one-time legacy-key notice, the recommend-Jev notice (Jev off)...

## Switches

- `jev.dispatchTierDetectNoWorkspaces` = true: jev.dispatchTierDetectNoWorkspaces: also read CLAUDE.md and AGENTS.md for the no-workspaces rule...
- `jev.dispatchTierNoWorkspaceRepos` = "": jev.dispatchTierNoWorkspaceRepos: repositories where workspaces are off-limits (comma separated,...
- `guards.failureNudgeFilter` = true: Where the noise-filter switch is read from (guards.failureNudgeFilter, default on)
- `guards.failureRootCauseNudge` = true: Where the on/off switch is read from (guards.failureRootCauseNudge, default on)
- `context.protocolLevel` = "compact": Where the protocol level (compact or full) is read from (context.protocolLevel)
- `jev.cascade` = true: Global kill switch of the cascade
- `jev.cascadeShowJevAnswer` = true: Whether the model sees Jev's answer and confidence next to the evidence (true) or judges the...
- `jev.judgeBackend` = "api": How the judge reaches the model: jev.judgeBackend (env ANTIHALL_JUDGE_BACKEND), api (default),...
- `jev.judgeModel` = "haiku": Where the model alias is read from: jev.judgeModel (env ANTIHALL_JUDGE_MODEL, plugin option...
- `jev.speculationBackend` = "haiku": Which backend answers the speculation question when the semantic judge is on: haiku (default,...
- `jev.triageBackend` = "jev": Which backend labels mesh messages: jev (default: Jev first; a label Jev leaves open stays open,...
- `context.verifyFirstSession` = true: Where the on/off switch of verify-first-full is read from (context.verifyFirstSession, default on)
- `context.verifyFirstTurn` = true: Where the on/off switch is read from (context.verifyFirstTurn, default on)
- `guards.claimLedger` = true: Where the on/off switch is read from (guards.claimLedger, default on)
- `guards.outputVerifyOncePerTurn` = true: Where the once-per-turn switch is read from (guards.outputVerifyOncePerTurn, default on)
- `guards.outputVerifyGuard` = true: Where the on/off switch is read from (guards.outputVerifyGuard, default on)
- `guards.inferenceCheck` = false: The switch of the causal-claim scan (guards.inferenceCheck, default off); the scan reads tool...
- `guards.speculationGuard` = true: Where the on/off switch is read from (guards.speculationGuard, default on)
- `jev.semanticJudge` = false: Where the opt-in switch is read from (jev.semanticJudge, default off)
- `guards.claimEvidence` = true: Switch guards.claimEvidence (default on): off lets a reply assert a check or outcome with no...
- `guards.stopAck` = true: Where the stop-ack switch is read from (guards.stopAck, default on)
- `jev.reviewAfterDays` = 7: The setting jev.reviewAfterDays: days an integration must have been in shadow (and since its...
- `jev.recommendNoticeHeadless` = false: The setting jev.recommendNoticeHeadless (off by default): show the recommend notice in a...
- `jev.reviewMinDecisions` = 30: The setting jev.reviewMinDecisions: decisions an integration must have logged before a review is due
- `jev.recommendNotice` = true: The setting jev.recommendNotice (on by default): the one-in-30-days notice recommending Jev...
- `jev.reviewReminder` = true: The setting jev.reviewReminder (on by default): the session-start line that says a Jev shadow...
- `jev.weeklyNotice` = true: The setting jev.weeklyNotice (on by default; a legacy jev.json value is honoured)
- `jev.enabled` = false: The setting jev.enabled (off by default; a legacy jev.json value is honoured)
- `context.roleGuard` = true: Switch context.roleGuard (default on): off lets every role run every engine verb (the PreToolUse...
- `context.roleNote` = true: Switch context.roleNote (default on): off stops the SessionStart / SubagentStart role note

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

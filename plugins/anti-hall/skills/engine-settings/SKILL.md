---
name: engine-settings
description: "Use when changing or reading an anti-hall setting or switch, looking up an engine reference, or configuring the Jev classifier."
---

# Settings and Jev

Settings switches, the generated reference and the Jev classifier.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine auto-handover-config` | `<get [--json]\|set <1-99>\|off\|on\|nag on\|off\|nag-step <n>\|nag-quiet <n>\|max-tokens <n>>` Get or change the auto-handover trigger's settings (L03, the port of scripts/auto-handover-config.js): `get [--json]` (the resolved... | main, codex |
| `ah-engine config` | `[validate <file>\|heal]` Show the effective config and where each value comes from, validate a config file, or `heal` the plugin's edited defaults (add the... | main, codex, workspace, subagent (owner args: heal) |
| `ah-engine docs` | `[--format md]` Print the generated reference: every command, setting, metric, impact kind, check and error code | main, codex, workspace, subagent |
| `ah-engine finding-dedup` | `[--file <findings.json>]` Advisory duplicate-finding detector for the deadly-loop reviewers (L03, the port of scripts/finding-dedup.js): reads a JSON array of... | main, codex, workspace, subagent |
| `ah-engine install-statusline` | `[--user\|--project] [--consolidate]` Put the anti-hall status line into the host's statusLine setting (L9a, the port of statusline/install-statusline.js): `--user` (default,... | main, codex |
| `ah-engine jev` | `<ask\|status\|scrub\|evidence>` The optional Jev lane (D34-D38): `ask` reads JSON requests, one per stdin line, and prints each decision (a real call when Jev is... | main, codex, workspace, subagent (owner args: ask, evidence) |
| `ah-engine jev-report` | `[--json] [--days N] [--window 24h\|7d] [--by project\|session] [--project <name>] [--weekly] \| label <hash> [tp\|fp] \| prune-audit --days N` The Jev report of the /anti-hall:jev skill (the port of scripts/jev-report.js): per-integration calls, agreement, changed decisions,... | main, codex, workspace, subagent (owner args: label, prune-audit) |
| `ah-engine jev-setup` | `<status\|enable\|disable\|set-key\|bind-generic-key\|test\|mode\|review-due\|reviewed\|snooze> [--days <n>] [--transport vercel\|typesafe] [--fallback vercel\|typesafe\|none] [--role fallback] [--vendor vercel\|typesafe]` Activate, configure and inspect the opt-in Jev classifier (D81, the port of scripts/jev-setup.js): `status` (resolved settings, key... | main, codex |
| `ah-engine jev_sweep` | `` The scheduled Jev evidence sweep (the `jev_sweep` job): gathers the WaitKind, Loop and StepMap facts of the supervisor's questions... | main, codex |
| `ah-engine phase` | `<set\|advance\|step\|agents\|update\|clear> [args]` Write or update the phase state the status line's phase bar shows (L9a, the port of statusline/phase.js): `set <code> <desc> <done>... | main, codex |
| `ah-engine settings` | `<show\|get\|set\|reset\|judge\|tunables\|trust-command-allow\|trust-edit-allow> [args] [--json]` Show or change any anti-hall setting (L9a, the port of scripts/settings.js): `show [--section <key>] [--all]`, `get <section.key>`, `set... | main, codex, workspace, subagent (owner args: set, reset, judge, trust-command-allow, trust-edit-allow) |
| `ah-engine statusline` | `(session JSON on stdin)` The two-line status line the host runs after each turn (L9a, the port of statusline/statusline.js and its renderers): reads the session... | main, codex, workspace, subagent |
| `ah-engine uninstall-statusline` | `[--user\|--project] [--purge-base]` Take the anti-hall status line out of the host's settings (L9a, the port of statusline/uninstall-statusline.js): restores the saved... | main, codex |

## Guards

- `speculation-guard`: Stop gate: blocks once per reply that states something with a hedge word and no evidence or uncertainty flag, asks Jev (speculation,...
- `speculation-judge`: Stop: the opt-in semantic judge; answers every path without a model call, and in a one-shot process asks the Claude CLI judge itself...
- `claim-ledger`: Stop, never blocks: records the checkable claims of the last reply that no evidence in the session backs; asks the Jev shadow question...
- `output-verify-guard`: PostToolUse advisory: flags a test-runner output with both a passing and a failing signal; asks the Jev shadow question...
- `jev-weekly-scorecard`: Stays silent when the weekly Jev scorecard notice cannot be due (Jev off, notice off, child workspace, checked within a week); when the...
- `jev-review-reminder`: Stays silent when no session-start Jev notice can be due (Jev and the semantic judge off, the recommend notice off or shown within 30...

## Switches

- `jev.dispatchTierDetectNoWorkspaces` = true: jev.dispatchTierDetectNoWorkspaces: also read CLAUDE.md and AGENTS.md for the no-workspaces rule (default on)
- `jev.dispatchTierNoWorkspaceRepos` = "": jev.dispatchTierNoWorkspaceRepos: repositories where workspaces are off-limits (comma separated, empty by default)
- `guards.failureNudgeFilter` = true: Where the noise-filter switch is read from (guards.failureNudgeFilter, default on)
- `guards.failureRootCauseNudge` = true: Where the on/off switch is read from (guards.failureRootCauseNudge, default on)
- `context.protocolLevel` = "compact": Where the protocol level (compact or full) is read from (context.protocolLevel)
- `jev.cascade` = true: Global kill switch of the cascade
- `jev.cascadeShowJevAnswer` = true: Whether the model sees Jev's answer and confidence next to the evidence (true) or judges the evidence alone (false), so anchoring can be...
- `jev.judgeBackend` = "api": How the judge reaches the model: jev.judgeBackend (env ANTIHALL_JUDGE_BACKEND), api (default), cli or auto (api when an Anthropic key is...
- `jev.judgeModel` = "haiku": Where the model alias is read from: jev.judgeModel (env ANTIHALL_JUDGE_MODEL, plugin option jev_judge_model), default the alias haiku
- `jev.speculationBackend` = "haiku": Which backend answers the speculation question when the semantic judge is on: haiku (default, today's behaviour: the judge asks the...
- `jev.triageBackend` = "jev": Which backend labels mesh messages: jev (default, today's behaviour: Jev first, the Anthropic API fills a missing label when a key is...
- `context.verifyFirstSession` = true: Where the on/off switch of verify-first-full is read from (context.verifyFirstSession, default on)
- `context.verifyFirstTurn` = true: Where the on/off switch is read from (context.verifyFirstTurn, default on)
- `guards.claimLedger` = true: Where the on/off switch is read from (guards.claimLedger, default on)
- `guards.outputVerifyOncePerTurn` = true: Where the once-per-turn switch is read from (guards.outputVerifyOncePerTurn, default on)
- `guards.outputVerifyGuard` = true: Where the on/off switch is read from (guards.outputVerifyGuard, default on)
- `guards.inferenceCheck` = false: The switch of the causal-claim scan (guards.inferenceCheck, default off); the scan reads tool evidence and stays on Node, so with the...
- `guards.speculationGuard` = true: Where the on/off switch is read from (guards.speculationGuard, default on)
- `jev.semanticJudge` = false: Where the opt-in switch is read from (jev.semanticJudge, default off)
- `guards.stopAck` = true: Where the stop-ack switch is read from (guards.stopAck, default on; hooks/lib/stop-ack.js)
- `jev.recommendNoticeHeadless` = false: The setting jev.recommendNoticeHeadless (off by default): show the recommend notice in a non-interactive run too
- `jev.recommendNotice` = true: The setting jev.recommendNotice (on by default): the one-in-30-days notice recommending Jev while it is off
- `jev.weeklyNotice` = true: The setting jev.weeklyNotice (on by default; a legacy jev.json value is honoured)
- `jev.enabled` = false: The setting jev.enabled (off by default; a legacy jev.json value is honoured)
- `context.roleGuard` = true: Switch context.roleGuard (default on): off lets every role run every engine verb (the PreToolUse Bash check and the command-line check...
- `context.roleNote` = true: Switch context.roleNote (default on): off stops the SessionStart / SubagentStart role note

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

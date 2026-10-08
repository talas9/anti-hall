---
name: anti-hall-engine-guards
description: "Use when an anti-hall guard blocked, warned or injected something, or you need to know which guard covers a rule."
---

# Guards

What the automatic guards check and how to read a block.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine check` | `<name>` Run one built-in check in-process on a hook payload from stdin (used by the parity harness) | main, codex, workspace, subagent |
| `ah-engine gen-hooks` | `--host claude\|codex [--kind hooks\|registry\|list\|map]` Print a file generated from the dispatch table (D87): the thin hooks.json (one trigger per event), the per-hook registry, the wrapper's... | main, codex, workspace, subagent |
| `ah-engine hook` | `[--fallback <hook.js>] \| --event <Event> [--tool <Tool>] [--host claude\|codex] [--fallback-map <file>]` The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back to the Node hook given by --fallback | main, codex, workspace, subagent |

## Guards

- `ship-it-guard`: Opt-in plan gate: blocks edits to hard-risk files with no PLAN.md and advises on files a plan's phases do not declare (port of...
- `command`: command-guard (PreToolUse on Bash): heavy-command and Bash-write delegation gate; the engine answers the commands allowed in every...
- `failure-root-cause-nudge`: Advisory after a failed Bash call: trace the cause before patching; silent for expected exit-1 predicates, interrupts, harness refusals...
- `verify-first-subagent`: SubagentStart context: injects the verify-first protocol (compact, or full when context.protocolLevel is full) into every spawned...
- `verify-first-full`: SessionStart context: injects the verify-first protocol and discipline index for the session, Claude or Codex text (port of...
- `inbox-read-guard`: Blocks a Read of the raw DevSwarm inbox; a Read of the raw store defers to Node, which probes the wrapper; dormant unless DevSwarm is...
- `verify-first`: UserPromptSubmit: the short rotating verify-first reminder, deduplicated per session; DevSwarm Primary sessions stay on Node (port of...
- `api-guard`: Fabricated-API guard: answers every call the Node api-guard would allow without probing an interpreter (guard off or skipped, a target...
- `engine-role-guard`: PreToolUse on Bash: refuses an ah-engine command the caller's role may not run, per the roles.matrix (subagent from the payload,...
- `engine-role-note`: SessionStart and SubagentStart context: tells the session its role, the engine verbs it may use and where the full guide is (the...
- `jev-weekly-scorecard`: Stays silent when the weekly Jev scorecard notice cannot be due (Jev off, notice off, child workspace, checked within a week); when the...
- `jev-review-reminder`: Stays silent when no session-start Jev notice can be due (Jev and the semantic judge off, the recommend notice off or shown within 30...
- `sibling-sweep`: Stop and SubagentStop reminder: when the reply states the cause of a bug in a fix context and the turn shows no search for other...

## Switches

- `guards.apiGuard` = true: Where the guard's own on/off switch is read from (guards.apiGuard, default on)
- `guards.shellWriteChecks` = true: Where the switch for checking the code a shell write puts in a file is read from (guards.shellWriteChecks, default on)
- `guards.apiGuardThirdparty` = false: Where the switch for also verifying installed third-party packages is read from (guards.apiGuardThirdparty, default off)
- `safety.commandGuard` = true: Where command-guard's on/off switch is read from (safety.commandGuard, default on); the work window is off with it
- `safety.editGuard` = true: Where the guard's on/off switch is read from (safety.editGuard, default on)
- `guards.allowAnthropicEnvKey` = false: The home-only switch that lets ANTHROPIC_API_KEY count as a key (guards.allowAnthropicEnvKey; no env, no plugin option)
- `guards.pruneCompletedTasksAfter` = 10: How many completed or cancelled tasks the list may hold before the Stop advisory suggests pruning them (guards.pruneCompletedTasksAfter)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

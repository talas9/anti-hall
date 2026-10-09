---
name: engine-guards
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
- `verify-first-subagent`: SubagentStart context: injects the verify-first protocol (compact, or full when context.protocolLevel is full) into every spawned...
- `verify-first-full`: SessionStart context: injects the verify-first protocol and discipline index for the session, Claude or Codex text (port of...
- `inbox-read-guard`: Blocks a Read of the raw DevSwarm inbox; a Read of the raw store defers to Node, which probes the wrapper; dormant unless DevSwarm is...
- `verify-first`: UserPromptSubmit: the short rotating verify-first reminder, deduplicated per session; DevSwarm Primary sessions stay on Node (port of...
- `api-guard`: Fabricated-API guard: answers every call the Node api-guard would allow without probing an interpreter (guard off or skipped, a target...

## Switches

- `guards.allowSubagentMailbox` = false: guards.allowSubagentMailbox: a one-off allow of the subagent mailbox verbs (default off)
- `guards.editGuardAllow` = "": guards.editGuardAllow: extra file globs edit-guard allows (comma or colon separated, empty by default)
- `guards.allowBackgroundScratchScripts` = true: guards.allowBackgroundScratchScripts: the background scratch script allowance (default on)
- `guards.allowGcloudReads` = true: guards.allowGcloudReads: the narrow read-only Google Cloud access (default on)
- `guards.allowPlainPush` = true: guards.allowPlainPush: the plain git push chain allowance (default on)
- `guards.allowReadOnlyVerify` = true: guards.allowReadOnlyVerify: the bounded single-target verification allowance (default on)
- `guards.allowReadOnlyVerifyScripts` = true: guards.allowReadOnlyVerifyScripts: the script form of that allowance (default on)
- `guards.bashEditParity` = true: guards.bashEditParity: edit-guard's verdict applied to Bash writes (default on)
- `guards.projectCommandAllow` = true: guards.projectCommandAllow: the per-project command allowlist (default on)
- `guards.projectEditAllow` = true: guards.projectEditAllow: the per-project edit allowlist (default on)
- `guards.stashGuard` = false: guards.stashGuard: arms the git stash guard for every repository (default off)
- `guards.apiGuard` = true: Where the guard's own on/off switch is read from (guards.apiGuard, default on)
- `guards.shellWriteChecks` = true: Where the switch for checking the code a shell write puts in a file is read from (guards.shellWriteChecks, default on)
- `guards.apiGuardThirdparty` = false: Where the switch for also verifying installed third-party packages is read from (guards.apiGuardThirdparty, default off)
- `safety.commandGuard` = true: Where command-guard's on/off switch is read from (safety.commandGuard, default on); the work window is off with it
- `safety.editGuard` = true: Where the guard's on/off switch is read from (safety.editGuard, default on)
- `guards.modelRoutingDeployFloor` = "sonnet": Where the deploy/migration/secret model floor (sonnet, opus, off) is read from (guards.modelRoutingDeployFloor): the environment...
- `guards.modelRouting` = "strict": Where the model-routing mode (strict, advisory, off) is read from (guards.modelRouting): the environment variable, settings.json, then...
- `guards.allowAnthropicEnvKey` = false: The home-only switch that lets ANTHROPIC_API_KEY count as a key (guards.allowAnthropicEnvKey; no env, no plugin option)
- `guards.pruneCompletedTasksAfter` = 10: How many completed or cancelled tasks the list may hold before the Stop advisory suggests pruning them (guards.pruneCompletedTasksAfter)
- `guards.handoverHygiene` = true: Where the on/off switch is read from (guards.handoverHygiene, default on)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

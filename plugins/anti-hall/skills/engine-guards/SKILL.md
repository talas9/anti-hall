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
| `ah-engine gen-hooks` | `--host claude\|codex [--kind hooks\|registry\|list\|map]` Print a file generated from the dispatch table (D87): the thin hooks.json (one trigger per... | main, codex, workspace, subagent |
| `ah-engine hook` | `[--fallback <hook.js>] \| --event <Event> [--tool <Tool>] [--host claude\|codex] [--fallback-map <file>]` The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back... | main, codex, workspace, subagent |

## Guards

- `ship-it-guard`: Opt-in plan gate: blocks edits to hard-risk files with no PLAN.md and advises on files a plan's...
- `command`: command-guard (PreToolUse on Bash): heavy-command and Bash-write delegation gate; the engine...
- `verify-first-subagent`: SubagentStart context: injects the verify-first protocol (compact, or full when...
- `verify-first-full`: SessionStart context: injects the verify-first protocol and discipline index for the session,...
- `inbox-read-guard`: Blocks a Read of the raw DevSwarm inbox; a Read of the raw store defers to Node, which probes...
- `verify-first`: UserPromptSubmit: the short rotating verify-first reminder, deduplicated per session; DevSwarm...
- `api-guard`: Fabricated-API guard: answers every call the Node api-guard would allow without probing an...
- `broad-kill-guard`: PreToolUse on Bash, every agent: blocks pkill, killall, `kill -9 -1`, a kill of process group 0...
- `queued-wait-guard`: PreToolUse on Bash, subagents only: blocks a build or test command started with...
- `lane-test-guard`: PreToolUse on Bash, subagents only: blocks suite-scale test commands (cargo test or nextest...
- `wide-search-guard`: PreToolUse on Bash, every agent (subagents and the main thread): blocks a whole-disk search...
- `advisor-guard`: Advisor sessions only: blocks once a plan written with no advisor call this task...
- `switch-notice`: Run by the dispatcher on UserPromptSubmit and PreToolUse (an engine-only dispatch row): tells...
- `burn-breaker`: PreToolUse on every tool, subagents only: while the agent tracker holds the hard burn flag...
- `uncommitted-guard`: PreToolUse on Edit, Write, MultiEdit, NotebookEdit and apply_patch, subagents only: warns past...

## Switches

- `guards.allowSubagentMailbox` = false: a one-off allow of the subagent mailbox verbs (default off)
- `guards.editGuardAllow` = "": extra file globs edit-guard allows (comma or colon separated, empty by default)
- `guards.commandNameSegment` = true: Off switch (guards.commandNameSegment, default on): a heavy-command block in a chain names the...
- `guards.allowBackgroundScratchScripts` = true: Allowance for background scratch scripts (default on)
- `guards.allowGcloudReads` = true: the narrow read-only Google Cloud access (default on)
- `guards.allowPlainPush` = true: the plain git push chain allowance (default on)
- `guards.allowReadOnlyVerify` = true: the bounded single-target verification allowance (default on)
- `guards.allowReadOnlyVerifyScripts` = true: the script form of that allowance (default on)
- `guards.bashEditParity` = true: edit-guard's verdict applied to Bash writes (default on)
- `guards.projectCommandAllow` = true: the per-project command allowlist (default on)
- `guards.projectEditAllow` = true: the per-project edit allowlist (default on)
- `guards.stashGuard` = false: arms the git stash guard for every repository (default off)
- `guards.apiGuard` = true: Switch for the fabricated-API guard
- `guards.shellWriteChecks` = true: Switch for checking code a shell write adds
- `guards.apiGuardThirdparty` = false: Switch for verifying third-party packages
- `safety.commandGuard` = true: Switch for command-guard
- `safety.editGuard` = true: Where the guard's on/off switch is read from (safety.editGuard, default on)
- `guards.modelRoutingDeployFloor` = "sonnet": Model floor for deploys and secrets
- `guards.exploreHintExec` = true: Withholds the Explore hint for file-writing briefs
- `guards.modelRouting` = "strict": Model-routing mode
- `guards.allowAnthropicEnvKey` = false: Home-only switch that lets ANTHROPIC_API_KEY count as a key
- `guards.failOpenNonSafety` = true: Non-safety guards pass when unanswered
- `context.protocolOnce` = true: Once-per-session protocol text switch
- `context.promptDigestLines` = 3: Max lines of the prompt digest
- `context.promptDigestMin` = 3: Min advisories before the digest applies
- `context.promptDigest` = true: Prompt digest switch
- `context.inlineEventChars` = 6000: Characters all hooks of one event may inline together (0 = no total)
- `context.inlineHookChars` = 1500: Inline character cap of one hook
- `context.shrinkInline` = true: Master switch of the inline caps
- `guards.pushedNotDone` = true: Pushed work is not done switch
- `guards.allowNestedSpawns` = false: On lets a subagent or teammate start agents (default off); off blocks Agent and Task calls from them
- `guards.spawnCeiling` = true: On by default; off makes the fan-out ceiling a no-op
- `guards.usageAwareDispatch` = true: On by default; off makes usage-aware dispatch a no-op
- `guards.priorityTagBlockMax` = 2: Max priority-tag Stop blocks per tag set
- `guards.priorityTagCheck` = true: Stop check for non-P0-P3 priority tags
- `guards.pruneStopBlockMax` = 2: Max prune Stop blocks per completed-task count
- `guards.pruneStopBlock` = true: Capped Stop block after an ignored prune advisory
- `guards.pruneCompletedTasksAfter` = 10: Completed or cancelled tasks kept before the task tracker suggests pruning
- `guards.laneTestGuard` = true: Default on; off lets a subagent run suite-scale test commands
- `guards.allowTestSuites` = false: Lets a subagent run test suites
- `guards.testPolicy` = "targeted": Test policy for subagents
- `guards.testPolicyMainThread` = false: On makes testPolicy none apply to the main session too (default off)
- `guards.queuedWaitGuard` = true: Default on; off lets a subagent run heavy commands in the background and poll with sleep loops
- `guards.allowWideSearch` = false: On lets every agent run whole-disk searches (default off)
- `guards.advisorPlan` = true: Blocks a plan written with no advisor call once
- `guards.advisorRetry` = true: Blocks a re-edit after a failed run with no advisor call once
- `guards.advisorReview` = true: Blocks a review agent on a non-flagship model once
- `guards.broadKill` = true: Switch for the broad-kill guard
- `guards.uncommittedWork` = true: Off lets a subagent leave work uncommitted (default on)
- `statusline.devswarm.enabled` = true: Show the DevSwarm workspace segment in the statusline (hidden when DevSwarm is absent or idle)
- `statusline.devswarm.format` = "ws {parts}": The segment text
- `statusline.devswarm.max_chars` = 40: The segment is cut to this many characters (an ellipsis marks the cut)
- `statusline.devswarm.stale_ms` = 180000: Data older than this shows as `?`, not a guess
- `guards.handoverHygiene` = true: Where the on/off switch is read from (guards.handoverHygiene, default on)
- `devswarm_sup.dryRun.retention` = false: Dry run of retention: plans and logs what it would tombstone, writes nothing
- `devswarm_sup.dryRun.verdicts` = false: Dry run of the liveness sweep: computes verdicts, reports them, writes nothing
- `devswarm_sup_env.retention_budget_ms` = 5000: Time budget of one store's tombstoning batches (environment only, as in Node:...
- `devswarm_sup.retention.capAlone` = false: Owner-gated (OFF by default)
- `devswarm_sup.retention.foldAlone` = false: Owner-gated (OFF by default)
- `devswarm.inlineWorkNudge` = true: Where the inline-work advisory's switch is read from
- `devswarm.inlineWorkNudgeThreshold` = 5: Where the inline-work advisory's call threshold is read from
- `guards.repeatHint` = true: Switch for the repeated-block hint
- `guards.delegateStandDown` = true: Default on: while no agent can be spawned the delegate-only guards (standdown.guards) allow the...
- `guards.agentSpawnAvailable` = "auto": Host spawn capability: auto uses the request's tools or standdown.hosts; on/off is an explicit...
- `guards.upfrontNotice` = true: Switch for the switch-change notice

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

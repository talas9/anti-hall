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
| `ah-engine gen-hooks` | `--host claude\|codex [--kind hooks\|registry\|list\|map]` Print a file generated from the dispatch table (D87): the thin hooks.json (one trigger per... | main, codex, workspace, subagent |
| `ah-engine hook` | `[--fallback <hook.js>] \| --event <Event> [--tool <Tool>] [--host claude\|codex] [--fallback-map <file>]` The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back... | main, codex, workspace, subagent |

## Guards

- `ship-it-guard`: Require plans for hard-risk edits
- `command`: Delegate heavy commands and shell writes
- `verify-first-subagent`: Deliver the verify-first protocol to subagents
- `verify-first-full`: Deliver session verify-first rules
- `inbox-read-guard`: Require bounded DevSwarm inbox reads
- `verify-first`: Deliver deduplicated verify-first reminders
- `api-guard`: Check APIs against verified declarations
- `broad-kill-guard`: Block broad or unscoped process kills
- `queued-wait-guard`: Block background builds and busy polling
- `lane-test-guard`: Keep subagent tests within their lane
- `wide-search-guard`: Keep searches scoped to a project
- `advisor-guard`: Require advisor consultation where configured
- `switch-notice`: Report guard switch changes
- `burn-breaker`: Hold wasteful subagents at the hard burn limit
- `uncommitted-guard`: Warn on large uncommitted subagent edits

## Switches

- `guards.allowSubagentMailbox` = false: Allow subagent mailbox verbs
- `guards.editGuardAllow` = "": extra file globs edit-guard allows (comma or colon separated, empty by default)
- `guards.commandNameSegment` = true: Name the heavy segment in command blocks
- `guards.allowBackgroundScratchScripts` = true: Allowance for background scratch scripts (default on)
- `guards.allowGcloudReads` = true: the narrow read-only Google Cloud access (default on)
- `guards.allowPlainPush` = true: the plain git push chain allowance (default on)
- `guards.allowReadOnlyVerify` = true: the bounded single-target verification allowance (default on)
- `guards.allowReadOnlyVerifyScripts` = true: the script form of that allowance (default on)
- `guards.bashEditParity` = true: edit-guard's verdict applied to Bash writes (default on)
- `guards.projectCommandAllow` = true: the per-project command allowlist (default on)
- `guards.projectEditAllow` = true: the per-project edit allowlist (default on)
- `guards.stashGuard` = false: arms the git stash guard for every repository (default off)
- `guards.commandResolveWrapperScripts` = true: Judge shell wrappers by their script body
- `guards.apiGuard` = true: Switch for the fabricated-API guard
- `guards.shellWriteChecks` = true: Switch for checking code a shell write adds
- `guards.apiGuardThirdparty` = false: Switch for verifying third-party packages
- `safety.commandGuard` = true: Switch for command-guard
- `safety.editGuard` = true: Gate coordinator edits
- `guards.modelRoutingDeployFloor` = "sonnet": Model floor for deploys and secrets
- `guards.exploreHintExec` = true: Withholds the Explore hint for file-writing briefs
- `guards.exploreHintSkip` = true: Withhold Explore hints for reviews and tests
- `guards.modelRouting` = "strict": Model-routing mode
- `guards.allowAnthropicEnvKey` = false: Home-only switch that lets ANTHROPIC_API_KEY count as a key
- `guards.failOpenNonSafety` = true: Non-safety guards pass when unanswered
- `context.protocolFullAfterCompact` = true: Full rules on compaction
- `context.protocolOnce` = true: Once-per-session protocol text switch
- `guards.keepaliveCountsScheduled` = false: Count scheduled turns toward keepalives
- `guards.wasteWarnTokens` = 1000: First saved-token warning threshold
- `guards.wasteWarnWindowMin` = 60: Saved-token warning window, minutes
- `guards.wasteWarn` = true: Warn when saved-token levels rise
- `context.promptDigestLines` = 3: Max lines of the prompt digest
- `context.promptDigestMin` = 3: Min advisories before the digest applies
- `context.promptDigest` = true: Prompt digest switch
- `context.inlineEventChars` = 6000: Characters all hooks of one event may inline together (0 = no total)
- `context.inlineHookChars` = 1500: Inline character cap of one hook
- `context.shrinkInline` = true: Master switch of the inline caps
- `context.inlinePinned` = true: Pinned inline
- `guards.pushedNotDone` = true: Pushed work is not done switch
- `guards.denyChildQuestions` = true: Refuse child workspace questions
- `guards.denyPrimaryQuestions` = true: Refuse Primary questions
- `guards.runtimeStopReconcile` = true: Reconcile stale runtime Stop snapshots
- `guards.stopReblockMax` = 2: Allowed unchanged Stop repeats
- `guards.stopReblock` = true: Bound unchanged coordination Stop repeats
- `guards.allowNestedSpawns` = false: On lets subagents and teammates start agents
- `guards.maxConcurrentAgents` = 6: Cap on agents running at once (default 6, 0 = no cap)
- `guards.spawnCeiling` = true: Limit simultaneous agent fan-out
- `guards.usageAwareDispatch` = true: Use usage-aware dispatch
- `guards.priorityTagBlockMax` = 2: Max priority-tag Stop blocks per tag set
- `guards.priorityTagCheck` = true: Stop check for non-P0-P3 priority tags
- `guards.pruneStopBlockMax` = 2: Max prune Stop blocks per completed-task count
- `guards.pruneStopBlock` = true: Capped Stop block after an ignored prune advisory
- `guards.pruneCompletedTasksAfter` = 3: Completed or cancelled tasks kept before the task tracker suggests pruning
- `guards.inlineRule` = false: R-inline
- `guards.advisorPlan` = true: Blocks a plan written with no advisor call once
- `guards.advisorRank` = false: Skips plan/retry blocks for an equal/higher main
- `guards.advisorRetry` = true: Blocks a re-edit after a failed run with no advisor call once
- `guards.advisorReview` = true: Blocks a non-flagship review agent once
- `guards.advisorSayDo` = true: Blocks a Stop once per turn that promises an advisor call
- `guards.advisorThinking` = true: Nudges, then blocks once, thinking dispatch by a non-flagship main
- `guards.broadKill` = true: Switch for the broad-kill guard
- `guards.uncommittedWork` = true: Warn about uncommitted subagent work
- `statusline.devswarm.enabled` = true: Show the DevSwarm statusline segment
- `statusline.devswarm.format` = "ws {parts}": The segment text
- `statusline.devswarm.max_chars` = 40: The segment is cut to this many characters (an ellipsis marks the cut)
- `statusline.devswarm.stale_ms` = 180000: Data older than this shows as `?`, not a guess
- `guards.handoverHygiene` = true: Enforce handover hygiene
- `devswarm_sup.dryRun.retention` = false: Retention dry run (writes nothing)
- `devswarm_sup.dryRun.verdicts` = false: Liveness sweep dry run (writes nothing)
- `devswarm_sup_env.retention_budget_ms` = 5000: Time budget of one store's tombstoning batches (environment only, as in Node:...
- `devswarm_sup.retention.capAlone` = false: Owner-gated (OFF by default)
- `devswarm_sup.retention.foldAlone` = false: Owner-gated (OFF by default)
- `devswarm.inlineWorkNudge` = true: Advise against inline workspace work
- `devswarm.inlineWorkNudgeThreshold` = 5: Inline calls before an advisory
- `guards.repeatHint` = true: Switch for the repeated-block hint
- `guards.delegateStandDown` = true: Relax delegation when spawning is unavailable
- `guards.agentSpawnAvailable` = "auto": Detect or override host spawn capability
- `guards.upfrontNotice` = true: Switch for the switch-change notice
- `guards.pairPostAuthoritativeTasks` = true: Use authoritative tasks for post-tool pairing
- `guards.diskToolAdvisoryOnChangeRepeatS` = 21600: Unchanged disk reminder interval, seconds
- `guards.orchestrationOncePerSessionRepeatS` = 0: Unchanged orchestration reminder interval, seconds
- `guards.pairAdvisoryOnChangeRepeatS` = 7200: Unchanged pair reminder interval, seconds
- `guards.subagentProtocolOnChangeRepeatS` = 0: Unchanged subagent reminder interval, seconds
- `guards.usageAdvisoryOnChangeRepeatS` = 7200: Unchanged usage reminder interval, seconds
- `guards.diskToolAdvisoryOnChange` = true: Emit disk advisories on change
- `guards.orchestrationOncePerSession` = true: Emit orchestration rules on context change
- `guards.pairAdvisoryOnChange` = true: Emit pair advisories on change
- `guards.subagentProtocolOnChange` = true: Emit subagent protocol on change
- `guards.usageAdvisoryOnChange` = true: Emit usage advisories on change
- `guards.usageAdvisoryBucketPct` = 5: Usage percentage bucket width

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

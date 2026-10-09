---
name: anti-hall-engine-resources
description: "Use when you need the engine daemon status, metrics, impact, telemetry, a backup or restore, a scheduled job, or context and usage limits."
---

# Resources and state

Daemon status, metrics, backups, schedules and limits.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine backup` | `[--to <dir>]` Make a consistent online snapshot of hot.db and archive.db with SQLite's backup API, scrubbed of secrets, in backups/<ms> or the given... | main, codex |
| `ah-engine ctl` | `<ping\|reload\|stop\|status>` Send a control verb to the daemon: ping, reload, stop or status | main, codex |
| `ah-engine impact` | `[--kind <kind>] [--project <hash>] [--window <7d>]` Show everything the engine affected: blocks by reason, warnings, context injected, fallbacks, and labelled savings estimates, including... | main, codex, workspace, subagent |
| `ah-engine maintain` | `` Size control (D26): move consumed messages, expired key values and old impact events from hot.db to archive.db, prune derived... | main, codex |
| `ah-engine metrics` | `[--check <name>] [--rollup <resolution> [--since <s>]]` Show the engine's metrics: counters, gauges and latency percentiles, optionally for one check; with --rollup, the stored rollups of one... | main, codex, workspace, subagent |
| `ah-engine reset` | `` Clear the client breaker, the crash-loop stop and the failure record | main, codex |
| `ah-engine restore` | `<snapshot-dir>` Restore a snapshot directory: first keep the current state as an unscrubbed pre-restore snapshot (never deleted), stop the daemon, then... | main, codex |
| `ah-engine schedule` | `<list\|run <job>\|history> [--job <name>] [--limit <n>]` The scheduler (D33): `list` the jobs with their next run and last result, `run <job>` now (waits briefly for the result), or show the... | main, codex, workspace, subagent (owner args: run) |
| `ah-engine serve` | `` Run the resident daemon in the foreground (the client starts it detached when needed) | main, codex, workspace, subagent |
| `ah-engine status` | `[--memory]` Show the daemon's state: version, uptime, memory, counters, breaker and crash-loop state, rules, and a headline summary of what it did | main, codex, workspace, subagent |
| `ah-engine stop` | `` Ask the daemon to drain and exit | main, codex |
| `ah-engine telemetry` | `[summary\|events\|rollup] [--window <7d>] [--kind <k>] [--limit <n>]` Telemetry (D78): `summary` (invocations, outcomes, latency and injected bytes per hook and check), `events` (routing, spawn, Jev and... | main, codex, workspace, subagent (owner args: rollup) |
| `ah-engine version` | `` Print the version this build reports | main, codex, workspace, subagent |

## Guards

- `scan-throttle`: Advisory: recommends the background-throttled form of a user-configured heavy scan command (port of scan-throttle.js)
- `emit-dedupe-reset`: SessionStart: marks a context loss in the session's emit-dedupe state so the next UserPromptSubmit blocks are re-emitted (port of...
- `limit-conserve-inject`: UserPromptSubmit: injects the limit-conservation directive while conservation is on or a usage bucket is at the threshold...
- `session-end-mcp-reaper`: SessionEnd sweep of orphaned MCP server processes (parent PID 1, MCP command signature, old enough, not service-managed, never test...

## Switches

- `guards.scanThrottle` = true: Where the on/off switch is read from (guards.scanThrottle, default on; the old ANTI_HALL_SCAN_THROTTLE name is an alias)
- `context.dedupeWindowMin` = 20: Where the fallback suppression window is read from (context.dedupeWindowMin, minutes, default 20): used when the transcript cannot show...
- `guards.emitDedupe` = true: Where the emit-dedupe on/off switch is read from (guards.emitDedupe, default on): off emits every block every time and records nothing
- `guards.injectionRepeatEvery` = 10: Where the repeat interval is read from (guards.injectionRepeatEvery, delivered turns, default 10); 0 repeats the reminder every turn
- `limitConserve.accountCheck` = true: The limitConserve.accountCheck setting: hold a high usage reading stale after an account switch until the cache is refreshed
- `limitConserve.mode` = "auto": The limitConserve.mode setting: force conservation on or off, or auto-detect from the usage cache
- `limitConserve.threshold` = 85: The limitConserve.threshold setting: the usage percent at which conservation starts
- `context.injectGateCommsEvery` = 30: Turns between keepalives of the unchanged comms-override line (context.injectGateCommsEvery)
- `context.injectGateLimitEvery` = 10: Turns between keepalives of an unchanged limit-conservation directive (context.injectGateLimitEvery)
- `context.injectGateSwarmEvery` = 20: Turns between repeats of an unchanged shared-tree advisory (context.injectGateSwarmEvery)
- `context.injectGateTaskEvery` = 10: Turns between short task-tracker reminders and unchanged freshness notes (context.injectGateTaskEvery)
- `context.injectGateComms` = true: Cut 3 (context.injectGateComms, default on): the DevSwarm comms-override line and the workspace-title instruction are passed on once per...
- `context.injectGateLimit` = true: Cut 1 (context.injectGateLimit, default on): limit-conserve-inject is passed on only when the conservation directive changed (usage...
- `context.injectGate` = true: Master switch of the injection gate (context.injectGate, default on): off hands every gated hook's Node output through unchanged
- `context.injectGateSwarm` = true: Cut 4 (context.injectGateSwarm, default on): swarm-guard's shared-tree advisory is passed on when new or changed, and again only after N...
- `context.injectGateTask` = true: Cut 2 (context.injectGateTask, default on): task-tracker's short reminder is passed on only every N turns (its long form always passes),...
- `guards.reaperExclude` = "": Where the user's exclusion pattern is read from (guards.reaperExclude, a JavaScript regular expression, empty = none): a process it...
- `guards.reaperMatch` = "": Where the user's extra MCP process pattern is read from (guards.reaperMatch, a JavaScript regular expression, empty = none)
- `maintenance.sessionEndReaper` = true: Where the reaper's on/off switch is read from (maintenance.sessionEndReaper, default on; the deprecated environment alias is read too)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

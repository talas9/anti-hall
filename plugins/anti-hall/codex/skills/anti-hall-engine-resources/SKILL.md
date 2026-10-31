---
name: anti-hall-engine-resources
description: "Use when you need the engine daemon status, metrics, impact, telemetry, a backup or restore, a scheduled job, or context and usage limits."
---

# Resources and state

Daemon status, metrics, backups, schedules and limits.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine backup` | `[--to <dir>]` Make a consistent online snapshot of hot.db and archive.db with SQLite's backup API, scrubbed of... | main, codex |
| `ah-engine coordinator-work-baseline` | `<transcript.jsonl> [--from-line <n>] [--cwd <dir>] [--json]` Replay a session transcript's main-thread Bash calls through the coordinator-work classifier and... | main, codex, workspace, subagent |
| `ah-engine ctl` | `<ping\|reload\|stop\|status\|profile on [sample\|full] [--for <dur>]\|profile off\|profile status>` Send a control verb (with its arguments) to the daemon: ping, reload, stop, status, or profile... | main, codex |
| `ah-engine diag` | `<cpu\|mem\|threads\|hooks\|mesh\|jev\|fs\|locks\|trace>` Read-only diagnostic reports over state the engine already keeps: cpu, mem, threads, hooks,... | main, codex, workspace, subagent |
| `ah-engine dispatch-report` | `[--json]` Read-only effectiveness metrics: the parallel-dispatch demand shown, followed and ignored with... | main, codex, workspace, subagent |
| `ah-engine fallback` | `<node\|off\|status>` The manual fallback switch of the Node backup (stage 2): `node` makes the launcher run the... | main, codex, workspace, subagent |
| `ah-engine impact` | `[--kind <kind>] [--project <hash>] [--window <7d>]` Show everything the engine affected: blocks by reason, warnings, context injected, fallbacks,... | main, codex, workspace, subagent |
| `ah-engine maintain` | `` Size control (D26): move consumed messages, expired key values and old impact events from hot.db... | main, codex |
| `ah-engine metrics` | `[--check <name>] [--rollup <resolution> [--since <s>]]` Show the engine's metrics: counters, gauges and latency percentiles, optionally for one check;... | main, codex, workspace, subagent |
| `ah-engine query` | `[<source>] [--limit <n>] [--offset <n>] [--where <field=value,...>] [--since <7d>] [--window <7d>] [--schema]` Read-only, paginated query over the existing stores: `query <source> [--limit N] [--offset N]... | main, codex, workspace, subagent |
| `ah-engine reset` | `` Clear the client breaker, the crash-loop stop and the failure record | main, codex |
| `ah-engine restore` | `<snapshot-dir>` Restore a snapshot directory: first keep the current state as an unscrubbed pre-restore snapshot... | main, codex |
| `ah-engine schedule` | `<list\|run <job>\|history> [--job <name>] [--limit <n>]` The scheduler (D33): `list` the jobs with their next run and last result, `run <job>` now (waits... | main, codex, workspace, subagent (owner args: run) |
| `ah-engine serve` | `` Run the resident daemon in the foreground (the client starts it detached when needed) | main, codex, workspace, subagent |
| `ah-engine shadow-compare` | `[--days N] [--check ID] [--event NAME] [--daily]` Report how the engine and the original Node hooks agree (the Node backup, stage 1): pairs the... | main, codex, workspace, subagent |
| `ah-engine shadow-run` | `<job file>` Internal: the detached half of the Node shadow | main, codex, workspace, subagent |
| `ah-engine status` | `[--memory] [--threads] [--migration]` Show the daemon's state: version, uptime, memory, counters, breaker and crash-loop state, rules,... | main, codex, workspace, subagent |
| `ah-engine stop` | `` Ask the daemon to drain and exit | main, codex |
| `ah-engine telemetry` | `[summary\|events\|rollup\|actions [feature]] [--window <7d>] [--kind <k>] [--limit <n>] [--mistake <feature> <action> <target> <kind>]` Telemetry (D78): `summary` (invocations, outcomes, latency and injected bytes per hook and... | main, codex, workspace, subagent (owner args: rollup) |
| `ah-engine version` | `` Print the version this build reports | main, codex, workspace, subagent |
| `ah-engine web` | `[open\|status] [--no-open] [--json]` The Command Center web dashboard (GH #266): `open` (default) starts the local server when it is... | main, codex |
| `ah-engine mcp-reaper` | `run [--dry-run]` The standalone MCP orphan reaper as an engine command: `run` makes one sweep (the scheduled job... | main, codex |
| `ah-engine hygiene` | `[--report\|--clean]` Disk hygiene | main, codex, workspace, subagent (owner args: --clean) |
| `ah-engine units` | `<status\|install\|heal\|uninstall> [--dry-run] [--bin <path>]` The engine's service units: `status` lists the engine unit and the units the Node installers... | main, codex, workspace, subagent (owner args: install, heal, uninstall) |
| `ah-engine codex-activate` | `` Write the advisory Codex activation marker ~/.anti-hall/codex-activated.json ({activatedAt,... | main, codex |
| `ah-engine codex-limit-status` | `` Print whether limit conservation is active, as JSON (active, reason, weekly, fiveHour,... | main, codex, workspace, subagent |

## Guards

- `scan-throttle`: Advisory: recommends the background-throttled form of a user-configured heavy scan command
- `emit-dedupe-reset`: SessionStart: marks a context loss in the session's emit-dedupe state so the next...
- `limit-conserve-inject`: UserPromptSubmit: injects the limit-conservation directive while conservation is on or a usage...
- `session-end-mcp-reaper`: SessionEnd sweep of orphaned MCP server processes (parent PID 1, MCP command signature, old...

## Switches

- `guards.scanThrottle` = true: Where the on/off switch is read from (guards.scanThrottle, default on; the old...
- `context.dedupeWindowMin` = 20: Where the fallback suppression window is read from (context.dedupeWindowMin, minutes, default...
- `guards.emitDedupe` = true: Where the emit-dedupe on/off switch is read from (guards.emitDedupe, default on): off emits...
- `guards.injectionRepeatEvery` = 10: Where the repeat interval is read from (guards.injectionRepeatEvery, delivered turns, default...
- `limitConserve.accountCheck` = true: The limitConserve.accountCheck setting: hold a high usage reading stale after an account switch...
- `limitConserve.mode` = "auto": The limitConserve.mode setting: force conservation on or off, or auto-detect from the usage cache
- `limitConserve.threshold` = 85: The limitConserve.threshold setting: the usage percent at which conservation starts
- `context.injectGateCommsEvery` = 30: Turns between keepalives of the unchanged comms-override line (context.injectGateCommsEvery)
- `context.injectGateLimitEvery` = 10: Turns between keepalives of an unchanged limit-conservation directive (context.injectGateLimitEvery)
- `context.injectGateSwarmEvery` = 20: Turns between repeats of an unchanged shared-tree advisory (context.injectGateSwarmEvery)
- `context.injectGateTaskEvery` = 10: Turns between short task-tracker reminders and unchanged freshness notes...
- `context.injectGateComms` = true: Cut 3 (context.injectGateComms, default on): the DevSwarm comms-override line and the...
- `context.injectGateLimit` = true: Cut 1 (context.injectGateLimit, default on): limit-conserve-inject is passed on only when the...
- `context.injectGate` = true: Master switch of the injection gate (context.injectGate, default on): off hands every gated...
- `context.injectGateSwarm` = true: Cut 4 (context.injectGateSwarm, default on): swarm-guard's shared-tree advisory is passed on...
- `context.injectGateTask` = true: Cut 2 (context.injectGateTask, default on): task-tracker's short reminder is passed on only...
- `guards.reaperExclude` = "": Where the user's exclusion pattern is read from (guards.reaperExclude, a JavaScript regular...
- `maintenance.mcpReaperJob` = "auto": The switch of the reaper job, maintenance.mcpReaperJob: off never runs it; on always runs it;...
- `guards.reaperMatch` = "": Where the user's extra MCP process pattern is read from (guards.reaperMatch, a JavaScript...
- `maintenance.sessionEndReaper` = true: Where the reaper's on/off switch is read from (maintenance.sessionEndReaper, default on; the...
- `diskHygiene.deployKeep` = 3: How many deploy copies (disk_hygiene.deploy_prefix) are always kept, newest first...
- `diskHygiene.idleHours` = 24: A clone or deploy copy is idle when its newest activity stamp (disk_hygiene.idle_files, the...
- `diskHygiene.remoteTimeoutSecs` = 20: How long one `git ls-remote` of a clone's remote may take (diskHygiene.remoteTimeoutSecs)
- `diskHygiene.reusableClone` = "": The one designated reusable clone, a path relative to a work root (diskHygiene.reusableClone);...
- `diskHygiene.spillDays` = 7: A spill file (disk_hygiene.spill_dirs) older than this many days is listed, report only: spill...
- `diskHygiene.enabled` = true: Where the disk hygiene on/off switch is read from (diskHygiene.enabled, default on)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

---
name: anti-hall-engine-devswarm-supervisor
description: "Use when tuning or checking the DevSwarm supervisor sweep (auto-archive, pokes and escalation, app sync, retention, reconcile, housekeeping)."
---

# DevSwarm supervisor

The DevSwarm supervisor sweep: auto-archive, pokes, app sync, retention, reconcile and housekeeping.

## Switches

- `devswarm.archivedChildStop` = true: The setting devswarm.archivedChildStop (on by default): an archived child workspace is told to save a handover and stop, and its...
- `devswarm.supervisorMode` = "auto": Where devswarm.supervisorMode is read from: environment variable, settings.json, then the plugin option; `values` are the accepted words...
- `devswarm.stepStallMin` = 30: Where the quiet-child window is read from: devswarm.stepStallMin (minutes) through the engine's settings layer (the environment...
- `devswarm.monitorNoOkFailMin` = 10: Where devswarm.monitorNoOkFailMin is read from (minutes without a successful monitor poll before the daemon reads FAILING)
- `devswarm.spawnCreateTimeoutMs` = 180000: Timeout of `workspace create` in ms
- `devswarm.autoArchive.eventDebounceMs` = 2000: How long a workspace stays in the dirty set after its last edge before the event path looks at it (a burst of edges is one look)
- `devswarm.autoArchive.eventTrigger` = true: Whether a state change (a PR, lifecycle or activity edge) archives the finished workspace within seconds instead of waiting for the next...
- `devswarm.autoArchive.idleMin` = 30: Minutes of inactivity before a finished workspace is archived
- `devswarm.autoArchive.ignorePings` = true: Whether the idle gate ignores the child's own wake/heartbeat/status turns
- `devswarm.autoArchive.maxPerSweep` = 3: Most auto-archives in one sweep
- `devswarm.autoArchive.mode` = "on": Auto-archive mode: on (archive), dry-run (plan only, nothing spawned), off
- `devswarm.nag.enabled` = true: Whether the Primary is nagged about a workspace that is done but still open (merged, clean, no unread mail, past idleMin)
- `devswarm.nag.everyMs` = 1800000: Gap between two digests about the same still-open done workspace
- `devswarm.nag.hourlyCap` = 4: Most nag messages sent to the Primary in any rolling hour
- `devswarm.nudgeCooldownSec` = 120: Seconds between two pokes of one workspace
- `devswarm.nudgeMaxAttempts` = 2: Pokes before a stale workspace is escalated
- `devswarm.appSync` = true: Sync the DevSwarm desktop app's state (archived flags, titles, message gaps) into anti-hall every tick
- `devswarm.childGateRetentionDays` = 14: Days a per-session child-gate state file is kept before the housekeeping sweep removes it
- `devswarm.housekeepingSweep` = "auto": Housekeeping sweep switch: auto / on / off
- `devswarm.housekeepingSweepSec` = 3600: Least time between two housekeeping sweeps
- `devswarm.idleSec` = 900: How long a workspace's transcript and worktree must both be quiet before an unread mailbox makes it stale
- `devswarm.supervisorLogRotateBytes` = 10485760: Size above which the supervisor log is rotated to its .1 copy
- `devswarm.maxRecoveries` = 3: Most kill-and-resume recoveries of one workspace
- `devswarm.nudgeWindowSec` = 180: How long a poke stays in effect before the sweep decides again
- `devswarm.postSpawnGraceSec` = 120: Right after a child workspace is spawned it is not force-notified as stale for this long
- `devswarm.reapedRetentionDays` = 30: Days a reaped-workspace log is kept before the housekeeping sweep removes it
- `devswarm.reconcileSweep` = "auto": Reconcile sweep switch: auto / on / off
- `devswarm.reconcileSweepSec` = 900: Least time between two reconcile sweeps
- `devswarm.retention.archive` = true: Write a body to the gzip archive before tombstoning it (restorable)
- `devswarm.retention.archiveMaxMB` = 0: Archive size cap in MB; 0 = never evict an archive month
- `devswarm.retention.days` = 30: Days of message bodies kept before they are archived and tombstoned; 0 switches retention off
- `devswarm.retention.keepPerPartition` = 200: The newest messages of each partition that are never tombstoned (by age or by size)
- `devswarm.retention.maxStoreMB` = 100: Store size limit in MB: above it the oldest eligible bodies are tombstoned whatever their age; 0 = no limit
- `devswarm.supervisorSweepBudgetMs` = 20000: Time budget for one deferred stage of the sweep tail (one stage per tick)
- `devswarm.sweepTailMode` = "engine": Whether the engine decides the sweep tail (archived registry rows, twin descriptors, the deferred post-update stages and the...
- `devswarm.burnCacheReadPct` = 10: How much a cached-input read counts toward the burn, in percent of a fresh input token
- `devswarm.burnTokensWarn` = 2000000: Weighted tokens a child may spend since its last step progress before the burn signal (0 turns it off)
- `devswarm.dormantMs` = 1800000: How long a workspace whose session transcript resolves may stay silent before the stray signals treat it as dormant
- `devswarm.supervisorBlockerLabelReaskSec` = 21600: Seconds a blocker label decision is not asked or logged again while its input (workspace, kind, time) is unchanged
- `devswarm.spawnStrictFlagValues` = true: Whether spawn refuses a create option with no value or an option-shaped value
- `devswarm.spawnFetchTtlSec` = 300: Setting devswarm.spawnFetchTtlSec: skip the origin fetch when the remote-tracking ref was updated within this many seconds (0 always...
- `devswarm.spawnFromOrigin` = true: Setting devswarm.spawnFromOrigin: before a create from the default branch, fetch origin and fast-forward the local default branch...
- `devswarm.monitorTimeoutSec` = 30: The -t of every monitor call: it long-polls at most this long, then exits (an empty exit is a quiet poll, not an error)
- `devswarm.activeFloorPct` = 50: Least percent of a project's previous active-workspace snapshot a new one must hold, or the previous one is kept (0 turns the floor off)
- `devswarm.pausedProbeMax` = 8: Most `workspace info` probes of the start-up sampling per sweep
- `devswarm.startupSampling` = true: Whether the reconcile sweep probes `workspace info` of stale or not-draining workspaces and logs a non-null start-up field or a terminal...

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

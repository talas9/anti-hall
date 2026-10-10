---
name: engine-devswarm-supervisor
description: "Use when tuning or checking the DevSwarm supervisor sweep (auto-archive, pokes and escalation, app sync, retention, reconcile, housekeeping)."
---

# DevSwarm supervisor

The DevSwarm supervisor sweep: auto-archive, pokes, app sync, retention, reconcile and housekeeping.

## Switches

- `devswarm.supervisorMode` = "auto": Where devswarm.supervisorMode is read from: environment variable, settings.json, then the plugin option; `values` are the accepted words...
- `devswarm.autoArchive.eventDebounceMs` = 2000: How long a workspace stays in the dirty set after its last edge before the event path looks at it (a burst of edges is one look)
- `devswarm.autoArchive.eventTrigger` = true: Whether a state change (a PR, lifecycle or activity edge) archives the finished workspace within seconds instead of waiting for the next...
- `devswarm.autoArchive.idleMin` = 30: Minutes of inactivity before a finished workspace is archived
- `devswarm.autoArchive.ignorePings` = true: Whether the idle gate ignores the child's own wake/heartbeat/status turns
- `devswarm.autoArchive.maxPerSweep` = 3: Most auto-archives in one sweep
- `devswarm.autoArchive.mode` = "on": Auto-archive mode: on (archive), dry-run (plan only, nothing spawned), off
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
- `devswarm.sweepTailMode` = "node": Who decides the sweep tail (archived registry rows, twin descriptors; the reconcile port): node (the default; Node's scheduled functions...
- `devswarm.activeFloorPct` = 50: Least percent of a project's previous active-workspace snapshot a new one must hold, or the previous one is kept (0 turns the floor off)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

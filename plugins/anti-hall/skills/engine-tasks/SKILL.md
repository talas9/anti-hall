---
name: engine-tasks
description: "Use when keeping the task list, closing out tasks, or dispatching tasks to agents and a task, task-list or dispatch guard applies."
---

# Tasks and dispatch

Task-list, task-lifecycle and dispatch guards.

## Guards

- `tasklist-hygiene`: Claude only (Codex has no task tools)
- `task-lifecycle-log`: Appends one line per TaskCreated/TaskCompleted event to the per-session history ledger and its index
- `dispatch-tier`: Asks Jev (dispatchTier, detached) how a new or changed task should be dispatched, once per task...
- `task-guard`: Stop gate: blocks a Stop while tasks are open (the idle-neglect block when dispatchable work has...
- `tasklist-guard`: Stop gate: blocks a Stop after untracked work, tasks stalled in progress or a missing or stale...
- `task-tracker`: UserPromptSubmit task-list discipline: the full directive or the short reminder (window,...

## Switches

- `guards.taskGuardOwnerBlockedMarker` = true: Owner-blocked marker switch
- `guards.dispatchDemand` = true: Whether running agents are counted per task from this session's transcript...
- `guards.taskGuard` = true: Where the on/off switch is read from (guards.taskGuard, default on)
- `maintenance.taskLifecycleLog` = true: Where the on/off switch is read from (maintenance.taskLifecycleLog, default on)
- `guards.tasklistCarryProgress` = true: Off switch (guards.tasklistCarryProgress, default on): a session that crossed midnight keeps...
- `guards.tasklistIntegrationSkip` = true: Off switch (guards.tasklistIntegrationSkip, default on): git commands that only integrate worker...
- `guards.tasklistNameCounted` = true: Off switch (guards.tasklistNameCounted, default on): the block message names the first counted...
- `guards.tasklistNoTaskTools` = "reduced": Nag form when task tools are missing
- `guards.tasklistGuard` = true: Where the on/off switch is read from (guards.tasklistGuard, default on)
- `guards.tasklistWorkThreshold` = 3: How many counted file-changing actions make a session non-trivial (guards.tasklistWorkThreshold)
- `context.taskTrackerChangeOnly` = true: Short reminder speaks only on list change
- `guards.dispatchSkipFileConflict` = true: Skips tasks whose file a running agent holds
- `guards.dispatchSkipHeld` = true: Skips held tasks in DISPATCH NOW
- `context.taskTracker` = true: Where the check's on/off switch is read from (context.taskTracker, default on)
- `guards.dispatchQuietSpawnStop` = true: Quiets DISPATCH NOW during the spawn stop
- `context.taskTrackerUntrackedPrompts` = 8: Prompts before the short reminder repeats

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

---
name: engine-agents
description: "Use when spawning, messaging or stopping agents, keeping the task list, or delegating work and a delegation, task or model-routing guard applies."
---

# Agents and tasks

Subagent, task-list, delegation and routing guards.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine agents` | `<status\|tick> [--json]` The agent tracker (feature 21): `status` lists every tracked agent (main sessions, subagents and background tasks, DevSwarm workspaces)... | main, codex, workspace, subagent (owner args: tick) |

## Guards

- `coordinator-work-guard`: Main-thread work window
- `model-routing`: Anti-waste Agent/Task model routing: blocks execution-shaped flagship or inherited generic spawns and advises on routing mismatches...
- `phase-tracker`: Records each Agent or Task spawn in ~/.anti-hall (the statusline's live swarm bar and the running-agents heartbeat); never blocks (port...
- `orch-on-spawn`: Silent unless a spawn-time delivery is pending: answers every case where Node would print nothing; a pending marker defers to Node,...
- `verify-first-orch`: SessionStart orchestration text for the Claude entry: composes the full or compact text and keeps the delivery marker; a DevSwarm...
- `verify-first-orch-codex`: SessionStart orchestration text for the Codex entry (the same hook without --host=claude, so never Claude-confident): composes the full...
- `idle-agent-sweep`: UserPromptSubmit: lists agents that finished but were never stopped or closed, and the call that ends each (port of idle-agent-sweep.js)
- `ask-guard`: Advises on or blocks a question put to the user, and notes background agents still in flight (port of ask-guard.js)
- `silent-agent-nudge`: Stop: nudges once per silent background agent (the block text, the nudge state, the stale-build downgrade and the per-session ack of the...
- `stale-agent-stop-note`: Advisory: a TaskStop on an agent that was sent a message or resumed after its last report (port of stale-agent-stop-note.js)
- `edit-guard`: Coordinator delegation gate for Edit, Write, MultiEdit and NotebookEdit: answers the launcher-directory block and every call that is not...
- `swarm-guard`: Blocks an agent spawn past the spawn-rate cap or under critical memory pressure, and adds the shared-tree advisory to an allowed...
- `task-lifecycle-log`: Appends one line per TaskCreated/TaskCompleted event to the per-session history ledger and its index (port of task-lifecycle-log.js)
- `dispatch-tier`: Asks Jev (dispatchTier, detached) how a new or changed task should be dispatched, once per task text, and keeps the request marker in...
- `task-guard`: Stop gate: blocks a Stop while tasks are open (the idle-neglect block when dispatchable work has no running agent, else the generic...
- `tasklist-guard`: Stop gate: blocks a Stop after untracked work, tasks stalled in progress or a missing or stale progress file, with the Node hook's loop...
- `sibling-sweep`: Stop and SubagentStop reminder: when the reply states the cause of a bug in a fix context and the turn shows no search for other...
- `agent-reminders`: Delivers the agent tracker's queued reminders and advisories to the session or subagent that owns them, at its next UserPromptSubmit or...
- `task-tracker`: UserPromptSubmit task-list discipline: the full directive or the short reminder (window, transcript growth, keepalive and burst dedupe...

## Switches

- `guards.coordinatorWorkBlockAt` = 7: The Nth work call in the window is blocked (guards.coordinatorWorkBlockAt); 0 means never
- `guards.coordinatorWorkMaxEntries` = 50: Safety cap on the stored window timestamps per session (guards.coordinatorWorkMaxEntries)
- `guards.coordinatorWorkNudgeAt` = 4: Work calls in the window at which one advisory is shown (guards.coordinatorWorkNudgeAt); 0 means no advisory
- `guards.coordinatorWorkWindowMinutes` = 10: Minutes of the work window (guards.coordinatorWorkWindowMinutes); 0 turns the window off
- `context.codexOrchFullOn` = "session": Where the Codex delivery mode of the full orchestration rules is read from (context.codexOrchFullOn)
- `context.orchFullOn` = "auto": Where the delivery mode of the full orchestration rules is read from (context.orchFullOn)
- `context.verifyFirstOrchestration` = true: Where the orchestration on/off switch is read from (context.verifyFirstOrchestration, default on; it has no environment variable)
- `context.verifyFirstSubagent` = true: Where the on/off switch of verify-first-subagent is read from (context.verifyFirstSubagent, default on)
- `guards.idleAgentSweepCount` = 3: Where the idle-agent count that fires the advisory is read from (guards.idleAgentSweepCount, default 3)
- `guards.idleAgentSweepMin` = 15: Where the idle minutes that fire the advisory for any one agent are read from (guards.idleAgentSweepMin, default 15)
- `guards.idleAgentSweep` = true: Where the on/off switch is read from (guards.idleAgentSweep, default on)
- `guards.noBlockingQuestions` = "off": Where the question mode is read from (guards.noBlockingQuestions: off, advise or block; default off)
- `guards.questionAgentsNote` = true: Where the in-flight agents note switch is read from (guards.questionAgentsNote, default on)
- `guards.silentAgentNudgeMin` = 20: Where the silence threshold in minutes is read from (guards.silentAgentNudgeMin, default 20, at least 1)
- `guards.silentAgentNudge` = true: Where the on/off switch is read from (guards.silentAgentNudge, default on)
- `guards.staleAgentStopNote` = true: Where the on/off switch is read from (guards.staleAgentStopNote, default on)
- `safety.swarmGuard` = true: The switch safety.swarmGuard (on by default); off makes the guard a no-op
- `guards.sharedTreeAgentNote` = true: The switch guards.sharedTreeAgentNote (on by default): the advisory for a write-capable spawn that shares a working tree with a running...
- `guards.taskGuardOwnerBlockedMarker` = true: Where the switch of the owner-blocked marker is read from (guards.taskGuardOwnerBlockedMarker, default on): a task marked as waiting on...
- `guards.idleNeglectAgentMaxAgeMin` = 30: Minutes after which a running agent that names no task stops counting as cover in the proven count (guards.idleNeglectAgentMaxAgeMin; 0...
- `guards.stopNagBudgetPerPrompt` = 0: Most Stop blocks per user prompt (guards.stopNagBudgetPerPrompt; 0 = no budget)
- `guards.dispatchDemand` = true: Whether running agents are counted per task from this session's transcript (guards.dispatchDemand, default on); off restores the legacy...
- `guards.maxParallelDispatch` = 0: A fixed cap on running background agents (guards.maxParallelDispatch); 0 uses the CPU-based cap
- `guards.idleNeglectMinPriority` = "p1": The priority floor of the idle-neglect block (guards.idleNeglectMinPriority): a pending task below it is backlog and never nags
- `guards.idleNeglectProvenOnly` = true: Block on idle neglect only when a dispatchable task is uncovered under every placement of the agents that name no task...
- `guards.taskGuard` = true: Where the on/off switch is read from (guards.taskGuard, default on)
- `maintenance.taskLifecycleLog` = true: Where the on/off switch is read from (maintenance.taskLifecycleLog, default on)
- `guards.progressFreshMs` = 1800000: How long (ms) a progress file counts as fresh when no work time is known (guards.progressFreshMs)
- `guards.tasklistNoTaskTools` = "reduced": The nag form for a session positively known to lack task tools (guards.tasklistNoTaskTools: reduced, full or skip)
- `guards.tasklistGuard` = true: Where the on/off switch is read from (guards.tasklistGuard, default on)
- `guards.tasklistWorkThreshold` = 3: How many counted file-changing actions make a session non-trivial (guards.tasklistWorkThreshold)
- `guards.siblingSweep` = true: Where the on/off switch is read from (guards.siblingSweep, default on)
- `context.taskTracker` = true: Where the check's on/off switch is read from (context.taskTracker, default on)
- `agents.ownerNotify` = false: Where the owner-notification switch is read from (agents.ownerNotify, default off): on, routes that name the owner channel append a...
- `agents.reminders` = true: Where the reminder switch is read from (agents.reminders, default on): off, signals are still raised and recorded but nothing is queued...
- `agents.tracker` = true: Where the tracker's on/off switch is read from (agents.tracker, default on): off, a tick does nothing

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

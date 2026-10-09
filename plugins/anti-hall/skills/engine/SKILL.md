---
name: engine
description: "Use when you need to know what the anti-hall engine can do, which engine verbs your session may run, or which engine skill covers a feature area. Start here, then open the area's skill."
---

# anti-hall engine

The anti-hall engine (`ah-engine`) runs the guards and the state behind anti-hall. Verbs are role-gated: ask which role you are first.

## Feature areas

- Agents and tasks (`/anti-hall:engine-agents`): Subagent, task-list, delegation and routing guards.
- DevSwarm (`/anti-hall:engine-devswarm`): The DevSwarm role, gate and wake guards.
- DevSwarm supervisor (`/anti-hall:engine-devswarm-supervisor`): The DevSwarm supervisor sweep: auto-archive, pokes, app sync, retention, reconcile and housekeeping.
- Doctor and repair (`/anti-hall:engine-doctor`): Health check, repair, migrations and capability scans.
- Git and GitHub (`/anti-hall:engine-github`): Git, merge and release guards.
- Guards (`/anti-hall:engine-guards`): What the automatic guards check and how to read a block.
- Handovers and compaction (`/anti-hall:engine-handovers`): Handover, resume and compaction guards.
- Mesh (`/anti-hall:engine-mesh`): Read the DevSwarm message store and per-project mailboxes.
- Process, resource and disk watch (`/anti-hall:engine-processes`): Leftover processes, runaway CPU or memory and low disk space.
- Resources and state (`/anti-hall:engine-resources`): Daemon status, metrics, backups, schedules and limits.
- Settings and Jev (`/anti-hall:engine-settings`): Settings switches, the generated reference and the Jev classifier.

## Roles

- `main`: the main session (Primary / coordinator): owns the repo, the settings and the other agents
- `codex`: a Codex top-level session: the main seat on that platform
- `workspace`: a DevSwarm workspace child: works on its own task and reports through the mesh
- `subagent`: a subagent or background task: does one assigned job and reports back

Your role is in the note injected at session start. A role marked `*` in a Roles cell may only name its own workspace; owner args need the main session (or the Codex main seat).

Details: the area skills above; the full reference is `ah-engine docs`.

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._

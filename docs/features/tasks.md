---
title: Task tracking
description: How anti-hall keeps multi-step work tracked, so nothing is dropped or reported done while half-finished.
---

# Task tracking

Long sessions lose track of work: a request gets forgotten, a step is half done, or a
later turn sees changes lying around and calls them finished. anti-hall makes the
assistant keep a task list and a short progress note, and checks both before it stops.

## What happens each turn

At the start of each turn, `task-tracker` reminds the assistant to:

- capture every request as a task before acting on it;
- give each task a priority (`P0`, `P1`, `P2`) and work highest first;
- keep task statuses current, with **one** task in progress at a time;
- hand heavy work to helper agents and report progress.

When tasks are open, a single line keeps them in view, for example:

```text
open tasks: 3 (oldest in_progress subject: "wire up the parser") — update or close them.
```

## Two checks when the turn ends

| Check | Asks | Blocks when |
|---|---|---|
| `task-guard` | "You declared tasks. Are they finished?" | The session is about to stop with tasks still `pending` or `in_progress`. |
| `tasklist-guard` | "You did real work. Was it tracked?" | At least 3 file-changing actions happened, and there is no task activity, more than one task in progress, or no fresh progress file. |

Both are loop-safe: `task-guard` does not block again on the same unchanged set of open
tasks, and `tasklist-guard` blocks at most 3 times per session. If either check hits an
error, it lets the turn end.

A task that waits on you (marked as blocked on the owner, or with a subject starting
`OWNER:`) is not counted as neglected work.

## The progress file

For multi-step work, the assistant keeps a short note per session:

```text
.anti-hall/progress/<date>/<session-id>.md
```

It lists what is **done**, what is **in progress** and what is **next**. It counts as
fresh if it was updated in the last 30 minutes. anti-hall never creates it; the assistant
writes it. Each session gets its own file, so two sessions on the same project never
overwrite each other. `.anti-hall/progress/INDEX.md` links them all.

A companion ledger, `.anti-hall/history/<date>/<session-id>.md`, records each finished
task as **Cause**, **Fix** and **Verified**, so the next session can see what was done and
how it was proven.

Both live under `.anti-hall/`, which is why that folder belongs in your `.gitignore`
([Install](../start/install.md#keep-session-notes-out-of-git)).

## Tuning

| To | Use |
|---|---|
| Turn off the open-tasks check | `guards.taskGuard` = `false` |
| Turn off the tracked-work check | `guards.tasklistGuard` = `false` |
| Need more actions before it applies | `guards.tasklistWorkThreshold` (default 3) |
| Change the freshness window | `guards.progressFreshMs` (default 1800000 ms, 30 minutes) |

More detail: [tasklist-guard](../TASKLIST-GUARD.md) and the design notes in
[Task work design](../TASK-WORK.md).

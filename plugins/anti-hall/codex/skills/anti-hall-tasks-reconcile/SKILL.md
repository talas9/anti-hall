---
name: anti-hall-tasks-reconcile
description: Reconcile the Codex task list with the anti-hall task store (log finished tasks, merge duplicates, re-rank, fill free window slots, rewrite the backlog line). Use at resume, when the list grows past the window, or when it holds legacy or unsorted tasks.
---

# anti-hall tasks reconcile for Codex

Task list rules (enforced at TaskCreate/TaskUpdate by tasklist-hygiene): at most `guards.taskWindowSize` (default 5) active tasks, all top priority, plus one backlog line `T-∞ Backlog: …` as the last slot; subjects are `T-<n> [P<0-3>] title` with `n` a stable task number (never renumbered); an in-progress task names its owner; blocked tasks and tasks waiting on the owner live in the backlog store, not in the window; the full list lives in `.anti-hall/tasks/store/<session>.json`.

Codex has no task tools and no task hook events, so no guard enforces these rules on Codex: keep them yourself in your
plan (`update_plan`), with the same subjects, and keep the store file in step by hand.

## The store

`.anti-hall/tasks/store/<session>.json` in the project root:
`{"format": 1, "session", "from", "resumed", "tasks": [{"n", "p", "title", "state", "id", "owner", "blockedOn", "at"}]}`.
States: `window` (in the plan), `backlog`, `blocked` (backlog, waiting on something or the owner), `done`, `dropped`.
Never delete the file or an item: finished or dropped work keeps its state.

## Steps

1. Read your plan and the store (at resume: the predecessor's store named by the handover's session directory; copy it
   to this session's file, or import the handover's `state.md` `## Task list snapshot` table when there is none: `n`
   from the row's `T-<n>` or the next free number, `p` from its priority, P2 when none).
2. Finished: write each finished task's Cause/Fix/Verified entry in the history ledger
   (`.anti-hall/history/<date>/<session>.md`), set its store state to `done` and drop it from the plan.
3. Duplicates: keep the lower number; set the other to `dropped` and note the merge in the ledger.
4. Re-rank: order the `window` and `backlog` items by `p`, then `n`. The first `guards.taskWindowSize` that are not
   blocked are the plan's steps; the rest stay `backlog` in the store.
5. Backlog line as the last plan step:
   `T-∞ Backlog: <k> more (<a> P0, <b> P1) · next: T-<n> [P<p>] <title> · run $anti-hall-tasks-reconcile`.
6. Every in-progress step names its owner.

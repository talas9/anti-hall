---
name: tasks-reconcile
description: Reconcile the session task list with its task store (log finished tasks, merge duplicates, re-rank, fill free window slots, rewrite the backlog line). Use at resume, when a guard says a window slot is free or the window is full, or when the list holds legacy or unsorted tasks.
---

# tasks-reconcile

Task list rules (enforced at TaskCreate/TaskUpdate by tasklist-hygiene): at most `guards.taskWindowSize` (default 5) active tasks, all top priority, plus one backlog line `T-∞ Backlog: …` as the last slot; subjects are `T-<n> [P<0-3>] title` with `n` a stable task number (never renumbered); an in-progress task names its owner; blocked tasks and tasks waiting on the owner live in the backlog store, not in the window; the full list lives in `.anti-hall/tasks/store/<session>.json`.

## The store

`.anti-hall/tasks/store/<session>.json` in the project root:
`{"format": 1, "session", "from", "resumed", "tasks": [{"n", "p", "title", "state", "id", "owner", "blockedOn", "at"}]}`.
States: `window` (live), `backlog`, `blocked` (backlog, waiting on something or the owner), `done`, `dropped`.
The guard (tasklist-hygiene) updates it on every TaskCreate/TaskUpdate and adopts the predecessor's store at resume.
Edit it yourself (Write/Edit tool) only in the steps below. Never delete the file or an item: finished or dropped work keeps its state.

## Steps

1. Read the live list (TaskList) and the store.
2. Import (only when the guard says the resumed list is not imported): read the `## Task list snapshot` table of the
   handover's `state.md` and write this session's store, one item per row: `n` from the row's `T-<n>` or the next free
   number, `p` from its priority (P2 when none), state `window` for open rows, `blocked` for rows with a blocker, `done`
   for finished ones.
3. Finished: for each completed task, write its Cause/Fix/Verified entry in the history ledger
   (`.anti-hall/history/<date>/<session>.md`), then `TaskUpdate status=deleted`.
4. Duplicates: keep the lower number; set the other item's state to `dropped` and note the merge in the ledger.
5. Re-rank: order the `window` and `backlog` items by `p`, then `n`. The first `guards.taskWindowSize` that are not
   blocked belong in the window.
6. Move out first: for a live task that no longer belongs in the window, set its store state to `backlog`, then
   `TaskUpdate status=deleted`. Then fill: `TaskCreate subject="T-<n> [P<p>] <title>"` for each window item not live.
7. Backlog line, last slot: `TaskCreate` (or `TaskUpdate` its subject)
   `T-∞ Backlog: <k> more (<a> P0, <b> P1) · next: T-<n> [P<p>] <title> · run /anti-hall:tasks-reconcile`.
   Delete it when the backlog is empty.
8. Every in-progress task names its owner (`TaskUpdate owner=<agent name, or main>`).

# tasklist-guard — enforce a live task list + fresh progress file

> Usage guide for the `tasklist-guard` Stop hook and the per-turn freshness note in
> `task-tracker`. For the underlying research and design rationale (Claude task
> tooling, dedup/relate ladder, staleness signals) see [`TASK-WORK.md`](./TASK-WORK.md).

## What it is

Two coordinating pieces that make sure non-trivial work is actually **tracked** as
tasks and that a **live progress file** stays fresh — so work isn't silently
forgotten, left half-done, or "declared done" by a later agent that just sees
changes lying around:

- **`tasklist-guard.js`** — a **Stop** hook. When you finish a turn after doing real
  file-changing work, it checks whether that work was captured as tasks and whether
  progress is fresh. If not, it blocks the stop with a specific instruction.
- **per-turn freshness note** (in `task-tracker.js`, a **UserPromptSubmit** hook) —
  when open/stale tasks exist, it injects a one-line reminder at the top of each
  turn so the list never drifts out of mind.

This **coexists with `task-guard`**, which enforces a different invariant:

| Hook | Enforces |
|---|---|
| `task-guard` | "You **declared** tasks — don't stop with them still open." (drain what you opened) |
| `tasklist-guard` | "You did **real work** — was it tracked, and is progress fresh?" (track what you did) |

Both can fire on the same Stop. Each keeps its **own independent block cap**, so the
two never compound into a runaway loop.

## When it blocks (the Stop)

`tasklist-guard` returns `{"decision":"block","reason":"…"}` **only when all of**:

1. **Non-trivial work happened** this session — at least
   `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default **3**) file-mutating actions. Each of
   these counts as one:
   - an `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` tool use;
   - a mutating `Bash` command (e.g. `git commit/rebase/merge/reset`, `mkdir`,
     `touch`, `tee`, `chmod`, `sed -i`, `npm install`, `rm`/`cp`/`mv` in command
     position, or a `>`/`>>` redirect).

   **AND**

2. At least one of these is true:
   - **No task activity** was seen for that work (no `TaskCreate`/`TaskUpdate`/`TodoWrite`); or
   - **More than one task is `in_progress`** at once (the healthy invariant is exactly
     one — a single `in_progress` task never triggers a block); or
   - **No fresh `.anti-hall-progress.md`** (missing, stale, or not a real file).

It is **capped at `MAX_BLOCKS = 3` total per session** and is **fail-open**: any
error (unreadable transcript, missing cwd, parse failure, cold start) results in **no
block**. A bug in the hook can never hard-loop Claude. It blocks via the JSON
`decision` form (never exit 2), because plugin-packaged Stop hooks don't reliably
continue on exit 2.

## The progress file: `.anti-hall-progress.md`

A small markdown file at the **root of your working directory** (`<cwd>/.anti-hall-progress.md`)
that records, in plain prose or bullets:

- **done** — what's finished and verified this session;
- **in-progress** — what's underway right now;
- **next** — what comes after.

Rules:

- **You create and maintain it — the hook never creates it.** That's the whole
  point: the discipline is yours, the guard only checks it.
- It counts as **fresh** only if it was **updated this session** — within the
  freshness window (`ANTIHALL_PROGRESS_FRESH_MS`, default **30 minutes**). An old
  file from a previous session is treated as stale.
- It must be a **real regular file** — a directory or symlink with that name is
  rejected (so freshness can't be spoofed).
- It is **gitignored** and **never shipped**. It is local session state, not a
  deliverable.

## Per-turn freshness note

On each `UserPromptSubmit`, when the reconstructed task state shows open or stale
tasks, `task-tracker` injects a single line such as:

```
open tasks: 3 (oldest in_progress subject: "wire up the parser") — update or close them.
```

It lists the open-task **count** and the **oldest `in_progress` subject**. When there
are no open tasks, nothing is injected — the per-turn baseline stays lean. The
subject is rendered as an inert quoted string, so a task title can't inject
instructions.

## Environment knobs

| Variable | Default | Effect |
|---|---|---|
| `ANTIHALL_TASKLIST_WORK_THRESHOLD` | `3` | Minimum file-mutating actions before the Stop can block. Raise to be less strict. |
| `ANTIHALL_PROGRESS_FRESH_MS` | `1800000` (30 min) | How recently `.anti-hall-progress.md` must have been updated to count as fresh. |

## Escape hatch

To suppress the guard, write `~/.anti-hall/skip.json` (honored via the shared
skip-guard):

```json
{ "tasklist-guard": 1893456000000 }
```

The value is a **unix-ms expiry** — the guard is skipped until that time. Use the
key `"all"` to suppress every skippable guard. You can also simply **ask the agent to
skip it**, and it will record your consent by writing this file.

## Good workflow

1. **Capture each request as a task.** Before `TaskCreate`, check `TaskList` first to
   **dedup and relate** — don't duplicate an existing open task; refine it instead, and
   link related tasks with `addBlockedBy` (prerequisite) / `addBlocks` (this gates
   that).
2. **Keep exactly one task `in_progress`.** Mark it `in_progress` before starting,
   `completed` only when fully done and verified.
3. **Update `.anti-hall-progress.md` as you go** — done / in-progress / next — so
   freshness survives compaction and cold starts.

Do that and neither the Stop block nor the freshness note will ever fire — they only
appear when the discipline has slipped.

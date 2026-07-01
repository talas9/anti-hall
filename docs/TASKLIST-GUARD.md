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
   - **No fresh per-session progress file** at
     `.anti-hall/progress/<date>/<session-id>.md` (missing, stale, or not a real file).

It is **capped at `MAX_BLOCKS = 3` total per session** and is **fail-open**: any
error (unreadable transcript, missing cwd, parse failure, cold start) results in **no
block**. A bug in the hook can never hard-loop Claude. It blocks via the JSON
`decision` form (never exit 2), because plugin-packaged Stop hooks don't reliably
continue on exit 2.

## The progress file: `.anti-hall/progress/<date>/<session-id>.md`

**Per-session, collision-free (v0.43.0+).** Each Claude Code session gets its own
progress file at `<cwd>/.anti-hall/progress/<date>/<session-id>.md`, where `<date>`
is the current UTC date (`YYYY-MM-DD`) and `<session-id>` is that session's own
`session_id` (sanitized to `[A-Za-z0-9_-]`). Two sessions running concurrently on the
same project each write their own file, so neither can clobber the other's progress —
the old convention was a single shared `.anti-hall-progress.md` at the repo root,
which two concurrent sessions could overwrite.

The file records, in plain prose or bullets:

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
- A running index, `.anti-hall/progress/INDEX.md`, is maintained automatically —
  once a session's progress file exists, the guard appends one line linking to it
  (`- <date> · <session-id> · [progress](<date>/<session-id>.md)`). The append is
  idempotent (skipped if the session id is already present) and atomic
  (`fs.appendFileSync` with the `'a'` flag) — never a read-modify-rewrite — so two
  sessions finishing at the same moment can't corrupt each other's index entry.
  Read `INDEX.md` first to find prior sessions' work.

## The fix ledger: `.anti-hall/history/<date>/<session-id>.md`

An append-only companion to the progress file, also **per-session** at
`<cwd>/.anti-hall/history/<date>/<session-id>.md` (same `<date>`/`<session-id>`
scheme as the progress file, and the same collision-free rationale). When the Stop
reminder fires it also prompts you to append **each completed task** as one entry
with three fields:

- **Cause** — what was actually wrong / why the task existed;
- **Fix** — what you changed to resolve it;
- **Verified** — how you proved it (the authoritative check you ran).

Unlike the progress file (a rolling done/in-progress/next snapshot), this is a
**durable, append-only** record so the fix history persists for the knowledge layer.
It is **gitignored and never shipped**, and the hook **never creates it** — the
discipline is yours; the reminder only nudges. Like the progress file, it gets its
own running index at `.anti-hall/history/INDEX.md`, maintained the same
idempotent/atomic way — but triggered by the file's **existence**, not its
freshness (a fix ledger has no per-turn staleness concept). The project's local
`CLAUDE.md` points at both `INDEX.md` files as the entry point for finding prior
session work.

The pre-v0.43.0 single-file convention (`.anti-hall-progress.md` /
`.anti-hall-history.md` at the repo root) is preserved untouched for any project
that already has one — it is simply no longer written to by new sessions.

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
| `ANTIHALL_PROGRESS_FRESH_MS` | `1800000` (30 min) | How recently the current session's `.anti-hall/progress/<date>/<session-id>.md` must have been updated to count as fresh. |

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
3. **Update your session's `.anti-hall/progress/<date>/<session-id>.md` as you go** —
   done / in-progress / next — so freshness survives compaction and cold starts.
4. **Append each completed task to your session's
   `.anti-hall/history/<date>/<session-id>.md`** — Cause / Fix / Verified — so the
   fix history persists for the knowledge layer.

Do that and neither the Stop block nor the freshness note will ever fire — they only
appear when the discipline has slipped.

# TASK-WORK — Task discipline for agentic Claude work

> Knowledge base for the `anti-hall` tasklist-guard feature: enforced, self-refreshing
> task discipline. Distills Claude Code's native task tooling, Anthropic's
> long-running-agent guidance, and the hook model into implementation-ready facts.

## Overview

Claude Code has two generations of task tooling: the legacy **`TodoWrite`** tool
(one call rewrites the whole list) and the current **Task tools**
(`TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`, one task per call, with
status, ownership, and dependencies). Task tools became the default in **Claude
Code v2.1.142 / TS Agent SDK 0.3.142**; set `CLAUDE_CODE_ENABLE_TASKS=0` to fall
back to `TodoWrite`.

A guard that enforces task hygiene must (a) read the live list, (b) recognize the
tool calls and results in the transcript, and (c) act only at the lifecycle points
the hook model actually fires — there is **no wall-clock timer**, so "always
checking" is approximated per turn and at stop time.

---

## Claude task tooling

### `TodoWrite` (legacy)

- **Shape:** one call carries the entire `todos` array. Each item is
  `{ content, status, activeForm }`. `status` ∈ `pending | in_progress | completed`.
- `content` = imperative ("Fix the auth bug"); `activeForm` = present-continuous
  shown while in progress ("Fixing the auth bug").
- **Rewrites the whole list every call** — no per-item identity, no dependencies,
  no ownership, no cross-session persistence.
- Transcript: `tool_use` block with `name === "TodoWrite"`, full list in
  `block.input.todos`. To track, replace your local copy on each call.

### Task tools (current default)

`TaskCreate` splits one item out; `TaskUpdate` patches one item by id; `TaskList`
and `TaskGet` read back. Designed for long, multi-session, multi-subagent work.

| Tool | Input | Returns |
|---|---|---|
| `TaskCreate` | `{ subject, description, activeForm?, metadata? }` | `tool_result` = `{ task: { id, subject } }` |
| `TaskUpdate` | `{ taskId, status?, subject?, description?, activeForm?, addBlocks?, addBlockedBy?, owner?, metadata? }` | updated task |
| `TaskList` | (filter) | records with **only** `id`, `subject`/`title`, `status`, `owner`, `blockedBy` |
| `TaskGet` | `{ taskId }` | **full** record incl. `description`, `metadata`, `activeForm` |

- **`subject`** = brief imperative title; **`description`** = the detail;
  **`activeForm`** = present-continuous for the in-progress spinner.
- **Status:** every task is born `pending`; move to `in_progress` before work,
  `completed` when done. `status: "deleted"` removes it.
- **Dependencies:** `addBlockedBy` makes this task wait on others;
  `addBlocks` is the inverse (this task gates those). A task is **"available"**
  when `status === "pending"` AND `owner` is empty AND `blockedBy` is empty
  (all deps resolved).
- **Ownership:** `owner` keys multi-agent coordination — an unowned available
  task is free to claim; an owned one is someone's in-flight work.
- **Persistence:** written to disk immediately under
  `~/.claude/tasks/<TASK_LIST_ID>/` (`index.json` + `task-*.json`). Survives
  compaction, restart, and multi-day gaps. `CLAUDE_CODE_TASK_LIST_ID` selects
  the active list; reuse it to resume across sessions.

### Transcript shape (critical for a transcript-scanning hook)

- Match assistant `tool_use` blocks by `block.name`: `"TaskCreate"`,
  `"TaskUpdate"`, `"TaskList"`, `"TaskGet"` (or `"TodoWrite"` in legacy mode).
- **The new task id is NOT in the `TaskCreate` input.** It comes back in the
  matching `tool_result` as `{ task: { id, subject } }`. A guard reconstructing
  the list must key its map off the **result** block, then apply later
  `TaskUpdate` inputs by `taskId`.
- To get an authoritative snapshot rather than replaying deltas, watch for a
  `TaskList` `tool_result` (its records carry `id/subject/status/owner/blockedBy`).
- `TodoWrite` is simpler to scan: every call has the full state in
  `block.input.todos`; take the last one.

---

## Live-list best practices (per Anthropic / system prompts)

- **Use it for non-trivial work:** 3+ distinct steps, multi-part requests, plan
  mode, or any explicit user task list. **Skip** for single trivial / purely
  conversational actions.
- **Capture immediately:** turn user requirements into tasks up front; add
  follow-ups the moment they're discovered. Don't lose work to memory.
- **Exactly ONE `in_progress` at a time** — "not less, not more." Mark a task
  `in_progress` *before* starting it.
- **Complete only when FULLY done.** Never mark `completed` if tests fail,
  implementation is partial, errors remain, or files/deps are missing — leave it
  `in_progress` or split out a blocker.
- **Don't batch completions** — mark complete immediately after each finish so
  the list reflects reality in real time.
- **Don't over-list:** ~7+ steps tempts the model to batch them "for efficiency,"
  defeating the checkpoints. Prefer specific, verifiable items
  ("navbar height 60→80px") over vague ones ("style the navbar").
- **Prune:** remove (or `deleted`) tasks that are no longer relevant rather than
  leaving stale entries.
- **Keep it non-blocking:** the main thread coordinates; delegate heavy/long work
  to subagents so list maintenance never stalls behind a build.

Anthropic's agentic loop = **gather context → act → verify → repeat**; the task
list is the spine of that loop. Verification should be *evidence-based* (show the
command + output), ideally by a fresh verifier, not self-asserted.

---

## Dedup & smart-relate

The system prompt explicitly says: **check `TaskList` before `TaskCreate`** to
avoid duplication. Practical heuristics for an incoming request:

1. **Read the live list first** (`TaskList`, or the reconstructed transcript map).
2. **Duplicate** → same intended outcome as an existing open task. Signals:
   high subject/description token overlap, same target file/symbol/endpoint, same
   verb+object. Action: do **not** create; surface the existing task id, optionally
   refine its `description`. Supersede only by `deleted` + one replacement.
3. **Related but distinct** → shares scope but is a different deliverable
   (sub-step, prerequisite, or follow-on). Action: create it **and** link via
   `addBlockedBy` (prereq) or `addBlocks` (this gates that). Use `metadata` to tag
   a cluster/epic.
4. **Genuinely new** → no scope overlap. Create normally.

Heuristic ordering for a guard: exact-subject match → normalized-subject match
(lowercase, strip stopwords) → target-artifact match → semantic similarity over
`subject + description`. Above a high threshold = duplicate; mid threshold =
relate via dependency; low = new.

---

## Staleness & freshness (and the event-driven, not-timer constraint)

Anthropic's long-running-agent guidance:

- Keep a **progress/state file** (their example: `claude-progress.txt`) logging
  what's been done; new sessions **read git logs + progress file** to recover
  state before picking work.
- Maintain a **feature/task list initialized as "failing"/incomplete**, and only
  flip to "passing"/`completed` **after careful self-verification**. This directly
  defends the named failure mode: *"a later agent instance would look around, see
  that progress had been made, and declare the job done."*
- *"It is unacceptable to remove or edit tests"* to make things look done.

**Staleness signals** for a guard to detect:
- a task `in_progress` with no related tool activity for many turns (untouched);
- more than one `in_progress` (invariant violation);
- `pending` tasks that are now `available` (deps cleared, unowned) but ignored;
- requests in the conversation never captured as tasks (forgotten / orphaned);
- a `completed` task with no verification evidence in the transcript.

**The hard constraint — no native timer.** Claude Code hooks are **event-driven
only**; there is no cron/interval. "Always checking" must be approximated by
firing on lifecycle events:

| Event | Fires | Useful for | Output channel |
|---|---|---|---|
| `UserPromptSubmit` | each user turn, before Claude sees it | per-turn freshness sweep; inject reminders | `additionalContext` (exit 0) injects text into context |
| `Stop` | when Claude finishes a response | enforce "don't stop with work undone" | `{"decision":"block","reason":...}` forces continuation |
| `TaskCreated` / `TaskCompleted` | native task lifecycle events | react to task changes directly | standard hook output |
| `PostToolUse` / `PostToolBatch` | after tool calls | observe `TaskCreate/Update` results live | — |

Key field facts (for the guard script reading stdin JSON):
- Every event includes `session_id`, `cwd`, `hook_event_name`.
- The transcript path arrives as **`transcript_path`** (JSONL). **Cold-start
  caveat:** a `Stop` hook may miss the very first turn or find the JSONL not yet
  flushed — handle a missing/empty transcript gracefully.
- `UserPromptSubmit` also gets `prompt`; on **exit 0** anything on stdout (or
  `additionalContext` JSON) is injected into Claude's context. Its timeout is
  lowered to **30s** — keep the sweep fast.
- `Stop` (and `PostToolUse`) use top-level **`decision: "block"`** with a
  **`reason`**; the reason is *the next instruction Claude acts on*, so make it
  specific ("Task #3 is in_progress but untested — verify before stopping").
- `Stop` input carries **`stop_hook_active`** — when `true` you already forced one
  continuation; **bow out to avoid an infinite loop** (one push-back per stretch).
- Exit codes: **exit 2** blocks with stderr fed back to Claude; **exit 0** = no
  objection (and for `UserPromptSubmit`, stdout becomes context). Don't mix exit 2
  with JSON — JSON is ignored when you exit 2.
- **Plugin caveat:** there is a known issue where `Stop` hooks installed via
  plugins don't reliably continue on exit 2 — prefer the JSON `decision:"block"`
  form and test under plugin packaging.

---

## Design implications for anti-hall enforcement

Goal: **enforce** (not merely nudge) continuous, deduped, fresh task discipline,
treated as a feature launch.

1. **Two coordinated hooks, no timer:**
   - **`UserPromptSubmit` freshness sweep** (≤30s, fast): read the live list
     (parse `transcript_path` JSONL for `Task*`/`TodoWrite` blocks + their
     results; key off `tool_result { task: { id } }`). Inject `additionalContext`
     summarizing open tasks, the single allowed `in_progress`, any newly
     `available` tasks, and any uncaptured request from the just-submitted prompt
     — and run the dedup/relate check on that prompt against the live list.
   - **`Stop` tasklist-guard:** if there's unverified or in-flight work
     (>1 `in_progress` — multiple-in-progress at once is the smell; a single
     `in_progress` is the healthy invariant and never triggers this cause —
     plus available-but-ignored tasks, or completed-without-evidence),
     return `{"decision":"block","reason":"<specific next action>"}`. Always
     short-circuit when `stop_hook_active` is true.

2. **Invariant enforcement:** reject/flag transcripts that show >1 `in_progress`,
   a `completed` with no verification evidence, or a request that produced no task.

3. **Dedup/relate at capture time:** before encouraging a `TaskCreate`, diff the
   prompt against `TaskList` (exact → normalized → artifact → semantic). Duplicate
   ⇒ point at existing id; related ⇒ suggest `addBlockedBy`/`addBlocks` link;
   new ⇒ allow.

4. **State file as ground truth:** keep a `.anti-hall-progress.md` progress file
   refreshed so freshness survives compaction and cold starts (mirrors
   Anthropic's `claude-progress.txt`). NOTE: the hook only **checks** this file's
   freshness (its mtime, relative to the session cwd) — it never writes or refreshes
   it. The agent/user maintains the file each sweep; the guard just nudges when it's
   missing or stale. Tasks themselves already persist under
   `~/.claude/tasks/<TASK_LIST_ID>/` — read that as the authoritative store when
   `CLAUDE_CODE_TASK_LIST_ID` is known.

5. **Mode-agnostic scanning:** support both `Task*` and `TodoWrite` transcripts
   (the user may set `CLAUDE_CODE_ENABLE_TASKS=0`). For `TodoWrite`, take the last
   full `todos` array; for Task tools, fold create-results + update-inputs into a
   map, or trust the latest `TaskList` snapshot.

6. **Non-blocking & resilient:** keep the sweep cheap, tolerate missing transcript
   on cold start, never `rm`/delete tasks, and prefer JSON `decision:"block"` over
   exit 2 for portability across plugin packaging.

7. **Optional native events:** `TaskCreated` / `TaskCompleted` hooks let the guard
   react the instant a task changes, complementing the per-turn sweep.

---

## Sources

- [Todo Lists — Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/todo-tracking) — TodoWrite vs Task tools, exact input/result shapes, `{ task: { id, subject } }` result, migration table.
- [Automate actions with hooks — Claude Code docs](https://code.claude.com/docs/en/hooks-guide) — event list, common input fields (`session_id`, `cwd`, `hook_event_name`, `transcript_path`), exit-code semantics, `additionalContext`, `decision:"block"`, event-driven (no timer).
- [Hooks reference — Claude Code docs](https://code.claude.com/docs/en/hooks) — full event schemas, decision-control table.
- [Effective harnesses for long-running agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — progress file, verify-before-passing, "declare the job done" failure mode.
- [Best practices for Claude Code — Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-best-practices) — agentic loop, evidence-based verification, plan/execute separation.
- [TodoWrite tool description (Piebald-AI/claude-code-system-prompts)](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-todowrite.md) — one-in_progress rule, complete-only-when-done, no-batching, capture-new, prune.
- [TaskCreate tool description (Piebald-AI/claude-code-system-prompts)](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-taskcreate.md) — when to use, fields, check TaskList before creating to dedup.
- [Task Operations and Lifecycle — DeepWiki](https://deepwiki.com/FlorianBruniaux/claude-code-ultimate-guide/8.2-task-operations-and-lifecycle) — TaskList vs TaskGet field visibility, "available" definition, disk persistence path, `CLAUDE_CODE_TASK_LIST_ID`.
- [Claude Code Stop Hook: force task completion — claudefa.st](https://claudefa.st/blog/tools/hooks/stop-hook-task-enforcement) — `decision:"block"` + `reason`, `stop_hook_active` loop guard.
- [Stop hooks exit-2 plugin bug — anthropics/claude-code #10412](https://github.com/anthropics/claude-code/issues/10412) — plugin-packaged Stop hooks unreliable on exit 2.
- [Stop/UserPromptSubmit cold-start timing — anthropics/claude-code #56631](https://github.com/anthropics/claude-code/issues/56631) — first-turn Stop miss; transcript not yet flushed.
</content>
</invoke>

---
name: orchestration
description: Swarm orchestration with a non-blocking main thread. Use whenever work is heavy, long-running, or parallelizable - builds, tests, deploys, data dumps, research, codebase sweeps, multi-part features, or any operation that would otherwise make the user wait. The main conversation stays a coordinator: it decomposes work, launches background and parallel subagents for anything that can run without conflict, keeps itself free to talk to the user, then collects and synthesizes results. Trigger on multi-step tasks, 2+ independent subtasks, anything expected to take more than ~30s or produce verbose output, or any time the user signals the main thread feels blocked/slow.
---

# Orchestration

The main conversation is a **coordinator, not a worker**. Its scarcest resources are
the user's attention and its own context window. So: push heavy work out to
subagents, run independent work in parallel, prefer the background, and keep the main
thread free to think and talk. The user should rarely watch the main thread block on
a long operation.

## Core rules

1. **Never block the main thread on heavy/long work.** Anything expected to take more
   than ~30s or to spew verbose output (builds, test suites, deploys, migrations,
   data dumps, bulk fetches, long scripts, web research, broad code search) is
   dispatched to a subagent — preferably in the background (`run_in_background:
   true`) — and the main thread continues.
2. **Parallelize independent work.** When 2+ subtasks share no state and have no
   ordering dependency, launch them in ONE message as multiple `Agent` calls so they
   run concurrently. Don't serialize what can run at once.
3. **Avoid conflicts.** Two agents must never mutate the same files concurrently.
   - Read-only or non-overlapping work -> parallelize freely.
   - Overlapping writes -> either serialize them, OR isolate each in its own git
     worktree (`isolation: "worktree"`) and integrate the results afterward.
   - Before launching a swarm, partition the work into non-overlapping file/dir sets
     and state the partition.
4. **Collect, then synthesize in the main thread.** A subagent's context dies when it
   returns; only its final summary survives. Have agents return tight structured
   results; the main thread integrates, decides, and reports.
5. **Always tell the user what you launched** and keep going — don't go silent while
   waiting. The user can interrupt; you are not blocked.

## Foreground vs background

- **Foreground (main thread does it):** quick decisions, small targeted edits,
  reading a **specific known file at a known path**, short git commits, talking to
  the user. That is the complete list.
- **Background subagent:** builds, full test runs, deploys, migrations, dumps/exports,
  bulk or long scripts, web research, **broad codebase exploration, Grep/Glob/Bash
  code-nav searches (git grep, find, rg, ag), and any multi-file read sweep**,
  anything verbose.
  > **Why this matters:** a bloated orchestrator context **degrades model quality and
  > directly induces hallucination** — the exact failure this plugin prevents. Keep
  > the coordinator lean.
- **Parallel subagents (one message, many `Agent` calls):** independent investigations
  or transforms across non-overlapping targets.

## Model floors (cost-aware)

Match the model to the job (resolve to the newest in each tier at runtime):
- **Haiku** — mechanical execution: deploys, git ops, builds, data dumps, log
  fetches, repetitive bulk operations.
- **Sonnet (floor)** — code authoring, analysis, code review, most subagent work.
- **Opus** — planning, architecture, and adversarial debate roles (see the
  ship-it and deadly-loop skills' roster in `../MODEL-POLICY.md`).

Don't send a planning problem to Haiku, or a log-tail to Opus.

## Swarm topology for larger work

For a big, multi-stream effort, use a tiered hierarchy so no single context holds
everything:

```
L1  Main coordinator (this conversation)
      decomposes, partitions, launches, collects, decides, talks to the user.
      Does NOT do exploration/implementation/heavy ops directly.
L2  Sub-orchestrators (one per independent stream; optional)
      own a worktree or a subsystem; spawn L3 workers; report up.
L3  Workers
      do the actual Bash/edits/tests/research; return tight summaries.
```

For peer coordination among long-lived streams, a team (`TeamCreate` +
`SendMessage`) beats one-shot `Agent` calls. Use plain `Agent` calls for scope-
isolated, fire-and-collect work.

## Discipline

- **Partition before you parallelize.** Write down which files/dirs each agent owns;
  overlapping ownership is the #1 cause of clobbered work.
- **Don't fan out beyond the work.** A 3-file change doesn't need 10 agents. Scale the
  swarm to the actual independent units.
- **Tear down what you set up.** Worktrees, teams, and background jobs are cleaned up
  when the work is integrated. Don't leave orphans.
- **Surface, don't swallow.** If a background agent fails or is rate-limited, report
  it and decide (retry, re-scope, serialize) — never silently drop its slice.
- **Integration is a main-thread job.** Merging/cherry-picking results, resolving
  cross-agent conflicts, and the final report stay with the coordinator.

## Writing a good agent brief (precise + concise)

A subagent only has the context you hand it. Give it exactly enough — no less, no
filler. Every brief states:
- **Goal** — the one outcome, in a sentence.
- **Context** — the why, plus the specific files/paths/symbols/branches it needs.
  Point to exact locations; don't make it re-discover what you already know.
- **Boundaries** — what NOT to touch (its file/dir ownership), and any hard rules.
- **Return format** — the tight structured result you want back (a verdict, a diff
  summary, a list with `file:line` citations) — NOT a transcript.

Precise and concise both matter: a vague brief produces wandering, wasteful work; a
bloated brief wastes tokens and buries the goal. Aim for the minimum that makes the
task unambiguous.

## Distribute load across Claude AND Codex (when Codex is available)

When the `codex` CLI / plugin is available, treat it as a second worker pool, not a
fallback. Split independent slices between Claude subagents and Codex so they run
concurrently and you get cross-model diversity (different training, different blind
spots). Good splits:
- Implementation slices: some files to Claude agents, others to Codex.
- Review/debate: Reviewer on one model, Critic on the other (this is exactly the
  `../MODEL-POLICY.md` roster — Opus + Codex).
- A second opinion on a hard diagnosis: ask both, compare.
Balance by load (don't pile everything on one pool) and by fit. If Codex is
unavailable, fall back to Claude-only (divergent personas for adversarial roles).

## Keep command output OFF the main thread

Builds, test runs, deploys, pushes, migrations, dumps, installs, **and all broad
reads/greps/searches** — their raw output is garbage for the main context window.
NEVER run them inline in the main conversation.
- Dispatch them to a **Haiku** subagent (cheap, fast for mechanical execution), or to
  **Codex** when available and it fits.
- The subagent runs the command, reads the verbose output itself, and returns ONLY a
  tight summary: pass/fail, the few lines that matter, and any error. The raw log
  stays in the subagent's context and dies there.
- The main thread sees the conclusion, not the scrollback. This keeps the coordinator
  clean for actual thinking and decisions. **A bloated main context degrades model
  quality and induces hallucination — the exact failure this plugin exists to prevent.**

## Query the graph before searching

When a graphify knowledge graph exists (`graphify-out/` or `.planning/graphs/`):
1. Ensure it is fresh: `/graphify --obsidian` (rebuild / update) before analysis.
2. Query it first: `/graphify query "..."` before dispatching any Grep/Glob/raw
   code-nav search or before starting a ship-it analysis.

A graph query is O(1) for the coordinator; a raw grep sweep handed to a subagent
is still cheaper than an inline sweep, but redundant if the graph already has the
answer. Graph-first, search-second.

## Commit and push hygiene (enforced)

- **No self-credit in commits.** Commit messages carry NO `Co-Authored-By` trailer
  and no "Generated with <AI>" line. The work is the owner's; the assistant takes no
  authorship credit. The plugin's `git-guard` PreToolUse hook blocks commits that
  include such trailers.
- **Never force push.** Rewriting published history is a deliberate human action with
  explicit owner confirmation — never an automated push. The `git-guard` hook blocks
  `git push --force` / `-f` / `--force-with-lease`.
- **Never push (or commit) unless asked.** Pushing is outward-facing; do it only on
  explicit request.

## Task-list discipline (enforced)

The plugin enforces a non-negotiable task-list protocol via two hooks:

**Rule: capture every request, sort by priority, work in order.**

1. **Capture every user request as a task before acting.** Use `TaskCreate` for each
   new request. Do this before starting any work so nothing is silently dropped. A
   request that enters your head but not the task list does not exist.

2. **Assign a priority to every task.** Use `metadata.priority`: `P0` (critical /
   blocking), `P1` (important, do next), `P2` (normal / backlog). Maintain the list
   sorted highest-priority-first. Work tasks from the top down — the most important
   work first.

3. **Keep statuses current as you work.**
   - `in_progress` — the moment you start working on a task.
   - `completed` — only when the work is fully done and verified.
   - `deferred` — explicitly deprioritized; tell the user why.
   Never leave a task in `pending` while you are actively working on it, and never
   mark a task `completed` until the work is actually done.

4. **Main thread stays non-blocking.** Delegate heavy/long work to background
   subagents (see rules above) and keep the coordinator free to respond to the user
   and pick up the next task immediately.

5. **Report progress.** After dispatching subagents or completing a task, give the
   user a brief status update. Don't go silent.

**Plugin enforcement:**
- `task-tracker.js` (`UserPromptSubmit`) — injects this discipline as `additionalContext`
  on every turn so it stays at top-of-context where it has the highest salience.
- `task-guard.js` (`Stop`, loop-safe) — when the session is about to stop with open
  tasks still in `pending` or `in_progress`, blocks once to prompt the model to
  continue, defer, or explicitly tell the user what is pending. Loop-safety: if the
  exact same open-task set was already blocked on, the guard does not block again
  (prevents infinite nudge loops). Fail-open on any parse/read error.

## Watchdog & heartbeat

### Heartbeat convention

Long-running or background subagents MUST write a heartbeat file periodically
while they work. File path: `~/.anti-hall/agents/<id>.json`. Format:

```json
{ "id": "my-agent-id", "ts": 1748000000000, "status": "running", "step": "compiling module X" }
```

- `id`     — stable identifier for this agent (string; unique per run).
- `ts`     — `Date.now()` at the time of the write. Update at every meaningful
             checkpoint (e.g. after each file processed, each sub-step done).
- `status` — free-form: `"running"`, `"done"`, `"error"`, etc.
- `step`   — current human-readable step description (optional but useful).

Write the file with `fs.writeFileSync` from Node (built-ins only; no shell).
Delete it on clean exit. Do not write to os.tmpdir() — use the home-dir path
(`~/.anti-hall/agents/`) so it is consistent across hook runners, the
statusline, and the orchestrator.

### Detecting stuck agents (agent-watchdog.js)

The orchestrator polls `hooks/agent-watchdog.js` on a scheduled interval
(ScheduleWakeup or a BACKOFF poll loop) to detect agents that have stopped
updating their heartbeat:

```
node hooks/agent-watchdog.js [threshold_ms]
```

Default threshold: **1 200 000 ms (20 min)**. Override by passing a number.

Output: one `STALE <id> last=<iso> age=<ms>ms status=<status> step=<step>` line
per stale agent, then a `summary: <stale>/<total> stale` line.

### Orchestrator polling pattern

```
loop (every N minutes, via ScheduleWakeup or Agent-poll):
  run agent-watchdog.js
  for each STALE agent:
    call TaskStop(<agent-id>)   # stop the stuck agent
    re-dispatch with tighter scope (smaller file set / shorter time horizon)
  if no new agents are needed:
    break
```

**BACKOFF poll loop** — do not poll at a fixed interval without backoff. Start
at 2 min, double on consecutive stale hits (cap at 10 min). If two consecutive
polls show no stale agents, reduce the interval back toward the floor.

**Never wait forever.** If an agent has been stale for more than 2x the
threshold, stop it, log the failure, and re-dispatch or mark the task failed.
Report to the user.

### Tighter scope on re-dispatch

Stuck agents usually stall on one large operation (too many files, too many
network calls). Re-dispatch with:
- A smaller file set (split the work in half).
- A shorter time horizon (process a single step, not the whole chain).
- An explicit timeout in the brief ("if you cannot complete in 15 min, return
  partial results and mark status=partial").

### SELF-HEAL: wrong or hallucinated output

If a subagent returns an output that does not match the expected schema or
contradicts verifiable facts:
1. Do NOT propagate the output downstream.
2. Log the discrepancy.
3. Re-dispatch the same task to a fresh agent with the schema made explicit in
   the brief and a counter-example showing what went wrong.
4. If two re-dispatches fail, escalate to the user with the evidence.

### Bounded task scoping (prevent hour-long runs)

Every agent brief MUST include an explicit scope limit — a maximum time
horizon, file count, or work unit cap. Examples:
- "Process at most 50 files; stop and return partial results if you hit the cap."
- "Complete within 10 minutes; return what you have if time runs out."
- "Work on files A–F only; do not touch G–Z."

This prevents a single agent from holding the swarm hostage.

## Statusline wiring

The orchestrator updates the phase statusline via `statusline/phase.js` so the
terminal bar reflects the real run state. Call it from the main thread as phases
progress (not from inside subagents — subagents report back, the coordinator
writes state):

```bash
# Start a phase
node statusline/phase.js set PLAN "Planning feature X" 0 3

# Advance as sub-steps complete
node statusline/phase.js advance

# Set the current step label
node statusline/phase.js step "running Reviewer+Critic debate"

# Set active agent count
node statusline/phase.js agents 4

# Clear when done
node statusline/phase.js clear
```

Path is relative to the plugin root (`CLAUDE_PLUGIN_ROOT`). Use an absolute
path in practice: `path.join(pluginRoot, 'statusline', 'phase.js')`.

The statusline reads `~/.anti-hall/phase-state.json`. Write from the main
coordinator only; the file path is consistent across all runners because it
uses the home directory (not os.tmpdir()).

## References & context guardrails

- **Delegate exploration; bring back TIGHT summaries, not raw output.** The
  exploration tokens stay in the throwaway subagent window — only the conclusion
  enters the coordinator (reinforces the core rules above).
- **Externalize findings by TYPE.** Durable, reusable patterns -> Claude Code Auto
  Memory / `CLAUDE.md`. Case-specific findings + current state -> the repo-local
  progress file `.anti-hall-progress.md` (enforced by the tasklist-guard `Stop`
  hook). Do NOT dump transient case facts into `MEMORY.md` — that is the
  reusable-patterns layer; keep it clean.
- **Compact early.** Once findings are externalized, prefer compacting before a long
  context rots; the statusline context gauge (green->yellow->red at ~70/90%) is the
  visual cue.
- **Graph-first.** Query the knowledge graph before broad search (already enforced
  above; named here for completeness).
- **The "sweet spot" is a CADENCE, not a length.** delegate -> externalize ->
  compact early -> retrieve on demand. There is no fixed ideal context length,
  because the detail lives outside the window.

References (docs in this source repo — `docs/` ships with a repo clone, NOT with the
`/plugin install` bundle, so the runtime cannot open them):
- `docs/CONTEXT-PRESERVATION-KB.md` — consolidated, source-backed evidence base for
  context-window discipline (caching, delegation, compaction, retrieval, memory,
  output discipline).
- `docs/TASKLIST-GUARD.md` (usage) + `docs/TASK-WORK.md` (design rationale) — the
  task-list + progress-file discipline. NOTE: `TASK-WORK.md` contains some
  version-pinned facts flagged historical in `docs/KB.md` — treat versions as
  historical.

## Relationship to other skills in this plugin
- **ship-it** runs its plan-hardening and per-phase deadly-loop gates as
  swarms dispatched from the main coordinator — the main thread orchestrates, the
  Reviewer/Critic run as (often background) subagents.
- **deadly-loop** is itself a swarm: parallel Reviewer + Critic auditors and parallel
  fix-wave workers. This skill is the general discipline; deadly-loop is a specific
  application of it.

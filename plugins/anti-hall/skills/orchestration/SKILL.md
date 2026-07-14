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

Match the model to the job (resolve to the newest in each tier at runtime — use the tier
tokens `haiku`/`sonnet`/`opus`/`fable`, never a versioned model id):
- **Haiku** — mechanical execution: web fetch, grep/search, file listing, running
  commands, builds, test runs, data dumps, log tails, git push, deploys, repetitive bulk
  operations. **~10× cheaper than Fable on both input and output** (`docs/KB-fable-5.md`)
  — keep all execution-shaped work here.
- **Sonnet (floor for code)** — code authoring, analysis, standard code review, most
  subagent work.
- **Opus** — deep analysis; flagship-tier work when Fable is unavailable (the Opus floor
  for debate seats — see the availability fallback matrix in `../MODEL-POLICY.md`).
- **Fable (flagship)** — RE-ENABLED as of 2026-07-12 (owner call, reversing the
  2026-07-02 policy-disable now that Fable 5 is available; see `../MODEL-POLICY.md`) —
  routed to the Reviewer seat of the ship-it / deadly-loop trio when `fable-availability.js`
  reports `args.fableAvailable === true`, falling back to Sonnet 5 then Opus. *Reconsider
  if Fable's track record regresses.*

Don't send a planning problem to Haiku, or a log-tail to Fable/Opus.

> **Inheritance warning.** A spawn that OMITS `model` inherits the orchestrator's model.
> On a flagship orchestrator (Fable/Opus), an omitted `model` silently produces an
> all-flagship swarm — expensive and wasteful for mechanical children. **ALWAYS set
> `model` explicitly per spawn** (especially on flagship orchestrators); never rely on
> inheritance to land a child in the right tier.

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

> **Inside DevSwarm, there is a HIGHER tier above all three, and it is the default for
> workspace-scale work.** If this session is a DevSwarm **Primary** (`DEVSWARM_REPO_ID`
> set, `DEVSWARM_SOURCE_BRANCH` empty), the top fan-out primitive is a **child
> workspace**, not an L2 subagent:
> `node scripts/devswarm.js spawn <branch> -p "<brief>"`.
>
> | Work | Tier |
> |---|---|
> | A workspace-scale **matter** — a feature, a fix, a deploy: multi-step, wants its own branch + worktree, its own agent session and token budget, its own review/merge | **Child workspace** (`devswarm.js spawn`) |
> | A read-only lookup, a single command, a scoped investigation, a review/verify pass, a mechanical transform | Subagent / Explore / Workflow (the L1→L2→L3 hierarchy above) |
>
> They **compose, they do not compete**: the Primary splits into workspace-sized chunks;
> each child then uses subagents *inside* its own workspace (children never spawn
> grandchildren — shallow + wide at both tiers). A **child** workspace uses the plain
> hierarchy above and spawns no workspaces. Heuristic source:
> `docs/KB-devswarm-hivecontrol.md` §8.1–8.2. Handing a workspace-scale matter to a
> subagent is the failure this note exists to prevent.

For peer coordination among long-lived streams, a team (`TeamCreate` +
`SendMessage`) beats one-shot `Agent` calls. Use plain `Agent` calls for scope-
isolated, fire-and-collect work.

## Discipline

- **Partition before you parallelize.** Write down which files/dirs each agent owns;
  overlapping ownership is the #1 cause of clobbered work.
- **Don't fan out beyond the work.** A 3-file change doesn't need 10 agents. Scale the
  swarm to the actual independent units. This isn't a style preference — Anthropic's own
  measurement: multi-agent fan-out costs ~15× a single chat turn, a lone agent ~4×, and
  Claude Code's Agent Teams ~7× in plan mode (`docs/KB-token-usage-models.md` §5).
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

Check the `codex-availability` fact (`~/.anti-hall/codex-availability.json`, written
once per session by the `codex-availability` SessionStart hook) before fanning out.
When it reports `available:true`, treat Codex as a co-equal worker pool — not a
fallback — for correctness-review AND a share of implementation, not just review.
Split independent slices between Claude subagents and Codex so they run
concurrently and you get cross-model diversity (different training, different blind
spots). Good splits:
- Implementation slices: some files to Claude agents, others to Codex.
- Review/debate: spread the seats across models (this is exactly the
  `../MODEL-POLICY.md` trio roster — Sonnet 5 Reviewer + Opus Auditor + Codex Critic).
- A second opinion on a hard diagnosis: ask both, compare.
Balance by load (don't pile everything on one pool) and by fit. If the fact is
missing/stale, fall back to the live probe in `../MODEL-POLICY.md`; if Codex is
unavailable, fall back to Claude-only (divergent personas for adversarial roles).

For big/parallel work, PREFER the Workflow tool with a **saved** deadly-loop/ship-it
template (`.claude/workflows/deadly-loop*.js` / `ship-it*.js`) over ad-hoc inline
Agent fan-out — a saved workflow gives the Critic seat's `codexUp` wiring enforced
mechanics, where an inline Skill-driven fan-out only has LLM-followed guidance.

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

When a graphify knowledge graph exists (`graphify-out/`):
1. Ensure it is fresh: `graphify update .` (rebuild / update) before analysis.
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
  continue, defer, or explicitly tell the user what is pending. Defers to an active
  OMC autonomous loop or a live background agent (checked via `~/.anti-hall/agents/*.json`
  fresh heartbeats) rather than blocking work already in flight, and exempts
  low-priority/P2/explicitly-deferred tasks from idle-neglect entirely. Loop-safety: if the
  exact same open-task set was already blocked on, the guard does not block again
  (prevents infinite nudge loops). Fail-open on any parse/read error.

## DevSwarm mesh-only messaging (when this session runs inside a DevSwarm workspace)

This skill governs subagent/Workflow fan-out WITHIN one workspace (L2) **and** — for a
DevSwarm **Primary** — the tier above it: spinning child workspaces (`devswarm.js spawn`),
see the DevSwarm note under "Swarm topology for larger work". The *doctrine* for that tier
is shipped (the injected rule W + the guard redirects); there is no mechanical classifier
that decides scale for you — see the `devswarm` skill. The other place the two intersect: if THIS
coordinating session happens to be running inside an active DevSwarm workspace
(`DEVSWARM_REPO_ID` set), anti-hall's shared **mesh store is the SOLE agent-initiated
messaging channel** for that workspace (v0.58 "mesh-only messaging" — a REPLACE, not an
addition). Native `hivecontrol workspace message-child`/`message-parent` are guard-blocked
in ALL contexts, including a subagent this skill dispatches — **do not delegate a
message-send to a subagent to work around the block; a delegated send writes the native
queue identically and is blocked the same way.**

**CLI verb surface** (`node scripts/devswarm.js <verb>`, agent-agnostic):
`send --to-primary --message TEXT [--urgency low|normal|high|urgent]` (direct to the
Primary) / `send --to <meshId> --message TEXT` (direct to a specific sibling) /
`send --broadcast --message TEXT` (all-to-all) / `heartbeat <id> --summary TEXT` (status
ping, also broadcasts) / `roster` / `mesh read` (unseen broadcasts) / `inbox
read-primary <id>` (Primary's own unread). Lifecycle (`spawn`/`merge`/`reconcile`) is
covered in full in the `devswarm` skill.

**A PRIMARY DOES spawn workspaces — it is its top fan-out tier** (see the DevSwarm note
under "Swarm topology for larger work" above). Earlier revisions of this skill disclaimed
that ("it doesn't spawn or merge DevSwarm workspaces itself"), which left `subagent` as the
only decomposition primitive a Primary was ever told about — the drift this note exists to
stop. A Primary facing a workspace-scale matter runs
`node scripts/devswarm.js spawn <branch> -p "<brief>"` itself (command-guard exempts it —
run it inline) and later `node scripts/devswarm.js merge`. A CHILD workspace never spawns
workspaces: it sends/reports and fans out with subagents internally.

**Role rules:** a CHILD workspace reports to its Primary (`send --to-primary` or
`heartbeat --summary`) and should keep polling the mesh while resting — the resting-poll
IS the Tier-0 wake posture (there is no external mechanism that wakes a truly idle Claude
Code session, `anthropics/claude-code#44380` — do not assume one exists). A PRIMARY checks
`roster`/`mesh read`/`inbox read-primary <id>` and directs a specific child via
`send --to <meshId>`. Neither role should treat this as optional busywork: it is the
only way a sibling/Primary/child learns anything happened.

**Message template** — the same record shape every mesh write uses:
```json
{"from": "<meshId>", "to": "<meshId-or-null>", "type": "direct|broadcast", "message": "<text>", "timestamp": 0, "urgency": "low|normal|high|urgent"}
```

Full detail (guard mechanics, wake-tier caveats, Codex parity, supervisor
escalate-on-urgent): `devswarm` skill's "v0.58 mesh-only messaging" section and
`docs/KB-devswarm-hivecontrol.md` §8.7's same-named note. Outside an active DevSwarm
workspace, none of this applies and this section is inert.

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

Run this inline from the coordinator — `command-guard` carves a narrow exception
for `hooks/agent-watchdog.js` (and `statusline/phase.js`) so these coordinator-owned
helpers are not forced through subagent delegation. See "Statusline wiring" below.

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

`command-guard` normally blocks `node <file>.js` in the coordinator context (to
push heavy work to subagents), but it carves a narrow LIGHT_EXCEPTION for exactly
`statusline/phase.js` and `hooks/agent-watchdog.js` — these two helpers are
coordinator-owned by design, so running them inline is allowed and does not need
to be delegated.

## References & context guardrails

- **Delegate exploration; bring back TIGHT summaries, not raw output.** The
  exploration tokens stay in the throwaway subagent window — only the conclusion
  enters the coordinator (reinforces the core rules above).
- **Externalize findings by TYPE.** Durable, reusable patterns -> Claude Code Auto
  Memory / `CLAUDE.md`. Case-specific findings + current state -> the per-session
  progress file `.anti-hall/progress/<date>/<session-id>.md` (enforced by the
  tasklist-guard `Stop` hook). Do NOT dump transient case facts into `MEMORY.md` —
  that is the reusable-patterns layer; keep it clean.
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

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

- **Foreground (main thread does it):** quick decisions, small edits, reading a
  specific known file, short git commits, talking to the user.
- **Background subagent:** builds, full test runs, deploys, migrations, dumps/exports,
  bulk or long scripts, web research, broad codebase exploration, anything verbose.
- **Parallel subagents (one message, many `Agent` calls):** independent investigations
  or transforms across non-overlapping targets.

## Model floors (cost-aware)

Match the model to the job (resolve to the newest in each tier at runtime):
- **Haiku** — mechanical execution: deploys, git ops, builds, data dumps, log
  fetches, repetitive bulk operations.
- **Sonnet (floor)** — code authoring, analysis, code review, most subagent work.
- **Opus** — planning, architecture, and adversarial debate roles (see the
  feature-launch and deadly-loop skills' roster in `../MODEL-POLICY.md`).

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

Builds, test runs, deploys, pushes, migrations, dumps, installs — their raw output is
garbage for the main context window. NEVER run them inline in the main conversation.
- Dispatch them to a **Haiku** subagent (cheap, fast for mechanical execution), or to
  **Codex** when available and it fits.
- The subagent runs the command, reads the verbose output itself, and returns ONLY a
  tight summary: pass/fail, the few lines that matter, and any error. The raw log
  stays in the subagent's context and dies there.
- The main thread sees the conclusion, not the scrollback. This keeps the coordinator
  clean for actual thinking and decisions.

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

## Relationship to other skills in this plugin
- **feature-launch** runs its plan-hardening and per-phase deadly-loop gates as
  swarms dispatched from the main coordinator — the main thread orchestrates, the
  Reviewer/Critic run as (often background) subagents.
- **deadly-loop** is itself a swarm: parallel Reviewer + Critic auditors and parallel
  fix-wave workers. This skill is the general discipline; deadly-loop is a specific
  application of it.

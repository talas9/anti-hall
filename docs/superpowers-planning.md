# Superpowers Planning/Execution Skills — Distillation

Analysis of seven superpowers skills for informing a lightweight plan-first workflow
in the anti-hall plugin. Read-only study; no plugin code was modified.

---

## 1. Per-Skill Essential Patterns

### brainstorming
**Enforces:** No implementation until design is approved.
**Key discipline:** One question at a time; propose 2-3 approaches with trade-offs; get
explicit user sign-off on written spec before touching a plan. YAGNI from the first
question.
**Inputs:** Idea / request + existing codebase context.
**Outputs:** Committed spec doc (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`);
handoff to writing-plans.

### writing-plans
**Enforces:** Plans are complete artifacts — no placeholders, no TBDs. Every step has
exact file paths, exact code, exact commands with expected output.
**Key discipline:** Map the file structure before decomposing tasks; keep tasks
bite-sized (2-5 min each); plan header declares goal + architecture + tech stack so any
agent can execute without asking. Plan is a self-contained executable script, not a
summary.
**Inputs:** Approved spec doc.
**Outputs:** Committed plan doc (`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`) with
checkbox tasks; offer of subagent-driven vs inline execution.

### executing-plans
**Enforces:** Execute the plan exactly as written; stop and ask rather than guess when
blocked.
**Key discipline:** Critical review of plan before starting (raise concerns first); mark
each task in-progress then complete; never start on main/master without explicit
consent; hand off to finishing-a-development-branch at the end.
**Inputs:** Written plan file.
**Outputs:** Committed, tested implementation; handoff to branch-finish skill.

### subagent-driven-development
**Enforces:** Fresh subagent per task; two-stage review (spec compliance then code
quality) after each task before moving on.
**Key discipline:** Controller reads the full plan once and extracts all task text
upfront — subagents never read the plan file themselves, they receive injected context.
Continuous execution without pausing to check in. Model selection by task complexity
(cheap for mechanical, capable for architecture/review). Four implementer statuses
(DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) with explicit handling for each.
**Inputs:** Written plan + prompt templates for implementer, spec-reviewer,
code-quality-reviewer.
**Outputs:** Fully reviewed, committed implementation; final whole-implementation review;
handoff to finishing-a-development-branch.

### dispatching-parallel-agents
**Enforces:** One agent per independent problem domain; parallel only when no shared
state or file conflicts.
**Key discipline:** Identify domain independence before dispatching. Each agent prompt
must be focused (one clear scope), self-contained (all context injected), constrained
(explicit "do NOT touch X"), and specific about output format. Controller verifies for
conflicts and reruns full suite after integration.
**Inputs:** Multiple independent failures or tasks.
**Outputs:** Per-agent summaries; integrated, conflict-checked result.

### verification-before-completion
**Enforces:** No completion claim without fresh evidence from the actual command output
in the current message.
**Key discipline:** The gate function — identify the command, run it, read full output,
check exit code, then and only then make the claim. Applies to every success assertion:
tests, lint, build, bug-fix, requirements coverage, agent reports. "Should work" is not
evidence.
**Inputs:** Any work claimed to be complete.
**Outputs:** Claim backed by command output, or honest statement of actual state.

### test-driven-development
**Enforces:** No production code before a failing test. Red-Green-Refactor cycle
mandatory. Watching the test fail is not optional.
**Key discipline:** The iron law — if you wrote code before the test, delete it and
start over. Minimal green (YAGNI); refactor only after green. Tests prove behavior, not
implementation. Edge cases are discovered by writing tests first, not remembered after.
**Inputs:** Feature requirement or bug report.
**Outputs:** Committed code with tests that were verified to fail before passing.

---

## 2. What to Keep vs What to Drop

### Keep — genuine value for a lightweight plan-first workflow

| Practice | Why it earns its weight |
|---|---|
| Brainstorm-before-plan hard gate | Stops context-free implementation; surfaces design alternatives before any cost is sunk. One question at a time is fast and avoids overwhelming. |
| Plan-as-artifact (written, committed, no placeholders) | A plan that lives in the repo is checkpointable, auditable, and resumable across sessions. Placeholders silently defer decisions to execution, the most expensive time to decide. |
| Spec self-review before handoff | Cheap, inline consistency pass catches TBD drift and type mismatches before they become runtime bugs. |
| Subagent context injection (controller extracts, agent receives) | Prevents plan-file re-reading on every task; keeps each agent's context budget focused on its task, not the whole plan. |
| Two-stage task review (spec compliance then code quality, in that order) | Spec compliance first ensures the implementation matches intent; code quality second ensures it is well-built. Reversing the order wastes code-quality review on scope-drifted code. |
| Verification-before-completion iron law | The single highest-leverage discipline. False completion claims compound: the next task builds on a broken foundation. Fresh evidence in the current message is the only acceptable standard. |
| TDD red-green-refactor | Watching the test fail proves the test is meaningful. Minimal green enforces YAGNI. Both together reduce the cost of being wrong. |
| Parallel dispatch only when no shared state | Parallel agents on overlapping files create merge conflicts that cost more than the time saved. The independence check is cheap insurance. |

### Drop or defer — heavyweight for a minimal loop

| Practice | Why it can be skipped initially |
|---|---|
| Visual companion during brainstorm | Browser-based mockup tool; high token cost; useful for UI-heavy products but not generic agent workflow infrastructure. |
| Formal spec doc committed to git per brainstorm | Valuable at scale; for a plugin with short feature cycles, the plan document itself can serve as both spec and plan. Merge if context allows. |
| Finishing-a-development-branch skill (PR/merge ceremony) | Useful for human-in-loop branch management; in a swarm, the coordinator handles merge decisions directly. |
| Scope decomposition ceremony (sub-project brainstorm cycles) | Overkill for well-bounded tasks. The plan writer's scope check ("is this one deliverable?") is sufficient. |
| Sequential model tiering (cheap/standard/capable) | Worthwhile optimization once the workflow is stable; premature if model routing adds orchestration complexity before the loop is proven. |

---

## 3. How These Compose with Parallel Subagents and a Non-Blocking Coordinator

The superpowers model maps cleanly onto a non-blocking coordinator pattern:

```
Coordinator (non-blocking, pure orchestrator)
  |
  +-- [phase: brainstorm] -- one question at a time, async back-channel
  |
  +-- [phase: plan] -- produces plan artifact; self-reviews inline
  |
  +-- [phase: execute] -- dispatches per-task implementers
  |     |
  |     +-- Task A implementer (injected context, no plan file access)
  |     +-- Task B implementer (injected context, no plan file access)
  |     +-- Task C implementer (injected context, no plan file access)
  |         (parallel only when A/B/C touch non-overlapping files)
  |
  +-- [phase: review] -- per-task: spec-compliance then quality (sequential per task)
  |     (parallel review agents across independent tasks is safe)
  |
  +-- [phase: verify] -- coordinator runs gate function; no completion claim without output
```

Key compositions:

- The coordinator never reads files for exploration — it extracts task context from the
  plan artifact once and injects it. This is the "context injection" discipline from
  subagent-driven-development, and it directly maps to the anti-hall goal of keeping
  the coordinator context clean.

- Parallel dispatch (dispatching-parallel-agents) slots between the plan and review
  phases. The independence check is the coordinator's responsibility, not the
  implementers'. Implementers have no awareness of sibling tasks.

- Verification-before-completion applies at every phase boundary, not just at the end.
  The coordinator does not report phase N complete until it has evidence. This means
  the review phase cannot be skipped by returning "success" from implementers.

- TDD applies inside each implementer subagent. The coordinator does not enforce TDD
  directly — it enforces it via the spec-compliance reviewer, which checks that tests
  were written and the red-green cycle was followed.

---

## 4. Recommended Minimal Plan-First Loop

This is the minimal loop that captures the superpowers' best disciplines, compatible
with a simplified GSD phase model and an Opus 4.8 swarm (see docs/gsd-distilled.md,
docs/opus-4-8-swarm.md when written).

```
LOOP: plan-first-minimal

  [GATE: brainstorm]
    - If request scope > 1 file or > ~2 hours: require written intent before plan.
    - Intent is short (3-10 sentences): goal, constraints, success criteria, 1-2 approaches
      considered with recommendation. NOT a full spec doc.
    - Hard gate: no plan written until intent is articulated and approved.
    - One clarifying question at a time if scope is ambiguous.

  [PLAN artifact]
    - Written to a file (e.g., .planning/<date>-<feature>.md).
    - Header: goal (1 sentence), architecture (2-3 sentences), tech stack.
    - Tasks: checkbox syntax, bite-sized (2-5 min each), exact file paths,
      exact commands with expected output, no placeholders.
    - Inline self-review before handoff: placeholder scan, type consistency,
      spec coverage.

  [EXECUTE: subagent-per-task]
    - Coordinator extracts all task text upfront; injects per-task context.
    - Implementer subagents receive: task text, relevant file snippets, constraints.
      They do NOT read the plan file.
    - Independent tasks: dispatch in parallel (verify no shared file writes first).
    - Dependent tasks: sequential dispatch.
    - Implementer follows TDD: write failing test, watch it fail, write minimal
      code, watch it pass, refactor, commit.
    - Implementer self-reviews before returning.

  [REVIEW: two-stage per task]
    - Stage 1: spec-compliance reviewer — does the code match the plan task?
      Any missing requirements? Any out-of-scope additions? Returns pass/fail + list.
    - Stage 2: code-quality reviewer — only after stage 1 passes.
      Returns pass/fail + issues.
    - If either stage fails: implementer fixes, reviewer re-reviews (no shortcuts).
    - Stages are independent agents; safe to parallelize across independent tasks,
      but within a single task stage 1 must complete before stage 2 starts.

  [VERIFY: gate function before any phase-complete claim]
    - Identify the command that proves the claim.
    - Run it fresh in the current context.
    - Read full output, check exit code.
    - Only then assert completion.
    - Applies to: tests, builds, lint, requirements checklist, agent reports.

  [REPEAT or SHIP]
    - If more phases remain: return to PLAN (next phase inherits completed artifact).
    - If all phases complete and verified: coordinator reports with evidence.
```

### What this drops relative to full superpowers

- No visual companion.
- No formal spec doc separate from plan (intent note + plan file is sufficient).
- No finishing-a-development-branch ceremony (coordinator handles branch decisions).
- No model tiering protocol (default to swarm-configured models per gsd-distilled.md).

### What this adds relative to vanilla GSD phases

- Hard brainstorm gate before any plan is written (GSD often skips this).
- Plan artifact discipline: no placeholders, no TBDs, committed file.
- Context injection pattern: subagents never read the plan file.
- Two-stage review order enforced (spec compliance before code quality).
- Verification iron law at every phase boundary, not just at ship time.

---

*Source skills read:*
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/writing-plans/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/executing-plans/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/subagent-driven-development/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/dispatching-parallel-agents/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/verification-before-completion/SKILL.md`
- `/Users/talas9/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/test-driven-development/SKILL.md`

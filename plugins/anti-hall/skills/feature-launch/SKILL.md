---
name: feature-launch
description: Rigorous plan-first, debate-hardened protocol for shipping a non-trivial feature spanning one or more repos. Use when the user says "let's build X" / "implement Y" / "apply Z feature" and the work spans more than a single file or a single afternoon, or involves schema design, multi-phase work, cross-repo coordination, or production-data migration. The plan is authored in PLAN MODE, hardened with the deadly-loop BEFORE any code, then executed phase by phase with a deadly-loop gate after each phase. Reviewer = latest Opus at max thinking; Critic = latest OpenAI Codex at max reasoning when available, otherwise a second divergent Opus.
---

# Feature Launch Protocol

A workflow for shipping non-trivial features safely. Its spine is: **understand the
blast radius, plan properly, prove the plan is airtight before writing a single line
of code, then build in small phases that are each hardened before moving on.** Most
feature failures are planning failures that only surface as bugs later — this protocol
spends its rigor up front.

It is intentionally generic: no assumed cloud, language, branch policy, or CI
provider. Substitute the repo's own conventions where the text says "the repo's own
policy."

## When to use

**Use when ANY of these are true:**
- Feature spans more than one file or more than one afternoon
- Feature touches more than one repo
- Schema migration or production data involved
- Estimated > 1 day of work
- Owner will keep working on mainline while you build
- Architectural decisions need cross-model peer review
- Verification rigor matters (live users, money, security)

**Don't use for:** single-file bug fixes, trivial UI tweaks, or implementation of an
already-fully-specced task with no design ambiguity.

## What this skill depends on

This skill **orchestrates** other skills — it does not reimplement them.

- **Plan mode** — the plan is authored in `EnterPlanMode` / `ExitPlanMode`. No code
  until the plan is approved.
- **Planning quality** — blends whatever planning tooling is present (see "Planning
  system selection" in Phase A). Falls back to plan mode + the `references/` templates
  here if nothing is installed.
- **Plan + phase hardening** — the **`deadly-loop`** skill (same plugin) is the debate
  engine. It runs on the PLAN before any code, and after each execution phase.
- **Model roster** — Reviewer/Critic defined in
  [`references/MODEL-POLICY.md`](references/MODEL-POLICY.md). Read it before dispatching
  any debate round. `deadly-loop` uses the same roster.
- **Code graph (optional)** — if a graphing tool exists, build/query it during Orient.
  Skip gracefully if absent.

If the `deadly-loop` skill is unavailable, stop and resolve it — the hardening gates
are the heart of this protocol.

---

## Workflow at a glance

```
Phase A: Initialize
  A1. Orient (analyze-work fan-out)
  A2. Pick planning system
  A3. Worktrees (only if concurrent owner work)
  A4. Write CONVERSATION-CONTEXT.md + SKILLS_PROTOCOL.md

Phase P: PLAN (in plan mode) -- the most important phase
  P1. Brainstorm intent + constraints
  P2. Draft the plan (phase breakdown + blast radius map + edge cases)
  P3. Edge-case enumeration + scenario simulation (mandatory, on paper)
  P4. HARDEN THE PLAN -- deadly-loop gate, BEFORE any code
      (loop until zero NEW P0s, feeding full context each round)

Phase A.5: AFK readiness gate (only if going autonomous)

Phase B: Per-phase execution loop
  B1. Execute the phase (TDD, atomic commits, verify before claiming done)
      Fan out independent sub-tasks in parallel (disjoint files only)
  B2. HARDEN THE PHASE -- deadly-loop gate, after EACH phase
  B3. UI/UX deadly-loop (frontend phases only)
  B4. Verify (tests, integration, goal-backward)
  B5. Statusline advance; rebuild graph if present
  B6. Re-read plan for inserted phases, then advance

Phase C: Lifecycle (milestone, version bump, cleanup)
```

The two `deadly-loop` gates (P4 on the plan, B2 after each phase) are non-negotiable.

---

## Phase A — Initialize

### A1. Orient: analyze-work fan-out

Before writing a single plan task, understand what the work actually touches. Fan out
**3-5 read-only analyzer subagents in parallel**, each with a distinct lens:

- **architecture-analyzer** -- touched modules, API contracts, callers, inheritance chains
- **security-analyzer** -- auth paths, secret access, data flows, trust boundaries
- **test-analyzer** -- coverage gaps, missing edge-case scenarios, fragile fixtures
- **contract-analyzer** -- schema dependencies, downstream consumers, protocol constraints
- **dependency-analyzer** (for large or cross-repo work) -- transitive deps, version pins, migration blockers

Each analyzer is read-only (`Read`, `Grep`, `Glob` only). Use a light model tier (not
full Opus) -- these are information-gathering passes, not reasoning gates.

Synthesize all five reports into the **Blast Radius Map** section of
`CONVERSATION-CONTEXT.md`. The blast radius map must name every module, contract,
schema, caller, config, and downstream consumer the feature perturbs. This is the input
both the planner (P2) and debate agents (P4, B2) attack.

**Graphify-first (mandatory when graph exists):** if `graphify-out/` or
`.planning/graphs/` exists, run `/graphify --obsidian` to ensure the graph is fresh,
then run `/graphify query "<feature description>"` BEFORE dispatching any analyzer
subagent or reading raw files. Pass the graph output as context to each analyzer — this
replaces broad grep sweeps and keeps the orchestrator context lean. If no graphify graph
exists, skip this step and proceed with raw analyzer subagents.

**Statusline:** on entering Phase A, set the statusline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" set A "orient" 0 <total_phases>
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" agents <n_analyzers>
```

### A2. Pick the planning system

Detect, in order, and use the richest available:

1. **superpowers planning skills present** (`brainstorming`, `writing-plans`,
   `executing-plans`, `subagent-driven-development`) -- use them for quality: brainstorm
   intent first, write the plan as a self-contained artifact, execute via subagent
   injection.
2. **GSD-style phase workflow present** (`.planning/` workspace, `gsd-plan-phase`) --
   use it for phase structure, spec/plan/verify artifacts, roadmap tracking.
3. **Both present** -- blend: superpowers for brainstorm and plan-writing discipline,
   GSD for phase decomposition and roadmap tracking. Preferred mode.
4. **Neither** -- fall back to plan mode + the lightweight phase loop below + templates
   in `references/`.

Record the chosen system in `CONVERSATION-CONTEXT.md`. Note: if the graphify graph
was queried in A1, include key graph findings in `CONVERSATION-CONTEXT.md` so
subsequent phases and debate agents do not re-run raw searches.

**Lightweight phase loop (fallback when no planning system is installed):**

For each phase, track one task-list entry -- no extra files:

```
phase task entry:
  goal:        one sentence -- what this phase proves works
  files:       every module, contract, schema, caller this phase perturbs
  edge_cases:  enumerated list (empty input, boundary, auth denied, partial failure, retry, idempotency)
  verify_cmd:  the exact command (or UAT step) that proves the goal is met -- not just "tasks done"
```

Update goal/verify in place as execution reveals gaps. The task list is the
plan -- no extra PLAN.md, no SUMMARY.md, no CONTEXT.md per phase.

### A3. Multi-repo worktree convention (only if needed)

If the feature touches multiple repos AND the owner keeps working on mainline
concurrently, isolate each repo in its own git worktree:

```bash
cd <repo-path>
git fetch origin <base-branch> --quiet
git worktree add <workspace-root>/.worktrees/<repo>-<feature-slug> \
  -b feat/<feature-slug> origin/<base-branch>
```

Use the repo's own branch policy for base and merge target. Record each
worktree path, branch, and base in `SKILLS_PROTOCOL.md`. NEVER edit a repo's primary
checkout while a worktree for it exists. Single-repo with no concurrent owner work --
skip worktrees, use a normal feature branch.

### A4. Write the two protocol files

- **`CONVERSATION-CONTEXT.md`** -- decision history, hard rules, worktree assignments,
  pre-existing branch state, chosen planning system, blast radius map, out-of-scope
  deferrals, and a "when in doubt" lookup order. Template:
  `references/CONVERSATION-CONTEXT-template.md`.
- **`SKILLS_PROTOCOL.md`** -- gate matrix (authoritative): per-phase entry/exit gates,
  the two deadly-loop gates, hard gates that never autonomy-bypass, stack-specific skill
  engagement, worktree discipline. Template: `references/SKILLS_PROTOCOL-template.md`.

Both files live in the planning workspace (`.planning/` when GSD is present, or the
project root when not). Point the repo's `CLAUDE.md` at `SKILLS_PROTOCOL.md`.

---

## Phase P — PLAN (in plan mode)

This phase earns the protocol its keep. **A proper, airtight plan, debated before a
single line is written, prevents the narrow-vision tunneling that turns into days of
rework.** Enter plan mode (`EnterPlanMode`) now -- nothing is edited until the plan
is approved.

**Statusline:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" set P "plan" 0 <total_phases>
```

### P1. Brainstorm intent + constraints

If `superpowers:brainstorming` is present, use it -- surface the real intent,
requirements, and design space before committing to an approach. One clarifying question
at a time if scope is ambiguous. Establish: what problem, for whom, non-negotiables,
what is explicitly out of scope, what existing code/contracts this touches.

Write a short intent note (3-10 sentences: goal, constraints, success criteria, 1-2
approaches considered with trade-offs and recommendation). Gate: no plan is written
until the intent is articulated and approved.

### P2. Draft the plan

Use the chosen planning system (from A2). Whatever the tooling, the plan MUST contain:

- **Phase breakdown** -- small, independently shippable, independently verifiable phases.
  A phase is a vertical slice, not a layer. Each phase has: goal, exact files/modules
  touched, test strategy, verify-cmd.
- **Blast radius map** -- every module, contract, schema, caller, config, migration, and
  downstream consumer the feature affects. Pulled from A1's synthesis. Narrow vision is
  the enemy; name everything it perturbs, not just the happy-path file.
- **Data/schema changes** with migration and rollback.
- **Hard-safety-boundary actions** flagged for the gate (deploys, migrations, secret
  changes, irreversible writes).

The plan is a self-contained artifact: no placeholders, no TBDs. Every step has exact
file paths and verification commands. Any agent should be able to execute it without
asking.

### P3. Edge-case enumeration + scenario simulation (mandatory)

On paper, before the plan is considered done:

- **Enumerate every edge case** for each phase: empty/null/missing inputs, boundary
  values, malformed data, permission/auth denied, concurrent access, partial failure,
  network/timeout, idempotency/retry, ordering, very large inputs, first-run/empty state,
  migration of pre-existing bad data.
- **Simulate every scenario** end to end: walk the happy path AND each failure mode
  through the planned code paths. Write what the system does at each step. If you cannot
  describe the behavior for a scenario, the plan has a hole -- fill it.

Record the edge-case/scenario matrix in the plan. The deadly-loop (P4) will attack
exactly the cases you missed.

### P4. HARDEN THE PLAN with the deadly-loop (mandatory gate, BEFORE any code)

Invoke the **`deadly-loop`** skill with the PLAN as its target (not code). Direct the
auditors to attack the plan for:

- Narrow vision / missed blast radius
- Missing edge cases or unsimulated scenarios (cross-check P3)
- Unsound phase decomposition, hidden cross-phase coupling, wrong sequencing
- Schema/migration/rollback gaps; data-loss or irreversibility risk
- Unproven assumptions stated as fact

**Self-heal rule:** if a debate agent returns garbage (hallucinated output, unrelated
text, clearly wrong claims with no file:line citations), restart that agent with
corrected context -- do NOT accept garbage as a finding and do NOT let a bad round
derail convergence. One restart per agent per round; if the second attempt also fails,
escalate to the owner.

**Convergence stall rule:** if the count of NEW P0/P1 blockers does not decrease between
consecutive rounds, the loop has stalled. Stop retrying. Escalate remaining blockers to
the owner with a summary of why they are not resolving. The owner chooses: accept risk /
redesign / unblock.

Do NOT exit plan mode or start building until the plan survives the deadly-loop with
zero NEW P0s. Then `ExitPlanMode` and surface the hardened plan for owner approval.

---

## Phase A.5 -- AFK readiness gate (only if going autonomous)

If running hands-off, do a full pre-flight BEFORE declaring autonomy: read the hardened
plan, `CONVERSATION-CONTEXT.md`, `SKILLS_PROTOCOL.md`, and
`references/HARD-GATES-CHECKLIST.md`; extract every open question, hard-gate trigger,
credential/token need, and ambiguity; batch into ONE questionnaire for the owner; update
context and commit. Only when zero ambiguities remain, emit the "AFK ready" signal.

Install the pre-Bash hard-gate sentinel (`references/PRE-TOOL-USE-HOOK.md`) BEFORE
entering autonomy. If it is not installed, refuse to declare AFK-ready.

### Anti-speculation discipline (applies to ALL subagents from here on)

Prepend this verbatim to every dispatched subagent prompt:

> **NEVER speculate. NEVER make up information.** Every claim must be backed by
> something you actually read or ran. "think" / "believe" / "assume" / "would
> expect" = speculation: verify with a tool (Read / Grep / Bash) or omit it.
> Findings without a `file:line` citation, command output, or quoted doc are demoted
> to advisory. Hedged language (`probably`, `likely`, `might`, `seems`) auto-demotes
> a P0 to advisory. Include a "verified-against" footer listing the exact files and
> lines you read. This rule is non-negotiable.

---

## Phase B -- Per-phase execution loop

**Statusline on each phase entry:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" set B<n> "<phase goal>" <done> <total>
```

### B1. Execute the phase

Build under TDD discipline: write a failing test before the code, verify the test
fails, write minimal code to pass, refactor, commit atomically. A failing test before
code is not optional -- if code was written before the test, delete it and start over.

**Fan-out within a phase:** for independent sub-tasks (non-overlapping files), dispatch
parallel subagents in one message. Each subagent gets injected context (task text +
relevant file excerpts + constraints) -- subagents do NOT read the plan file themselves.
Dependent sub-tasks execute sequentially.

Verify before claiming done: run the verify-cmd, read the full output, check exit code.
"Should work" is not done. Fresh evidence in the current message is the only acceptable
standard.

**Statusline on each sub-task:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" step "<sub-task description>"
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" agents <n_subagents>
```

### B2. HARDEN THE PHASE with the deadly-loop (mandatory gate, after EACH phase)

After the phase implementation is committed, invoke the **`deadly-loop`** skill on the
phase diff/code. Iterate Reviewer + Critic fix-waves until convergence -- zero NEW P0
blockers -- covering:

- Correctness vs the plan
- Edge cases and scenarios from P3 actually handled in code
- Regressions against prior phases
- Security on security-relevant phases
- Full blast radius (every touched caller/contract)

Do not advance to the next phase until this phase converges. Self-heal and stall rules
from P4 apply here too.

### B3. UI/UX deadly-loop (frontend phases only)

If the phase touched UI, produce/verify a UI-SPEC (information architecture; component
state matrix: default/hover/active/disabled/loading/empty/error; responsive + density;
a11y contrast/keyboard/screen-reader; motion respecting `prefers-reduced-motion`;
destructive-action UX; first-run/empty state). Then run a specialized UI/UX deadly-loop
in addition to B2. Document results in `<phase>/UX-DEBATE.md`.

### B4. Verify

Run: test coverage check, security audit on security-relevant phases, goal-backward
validation (does the result prove the phase goal, not just "tasks done"), integration
checks with adjacent phases.

### B5. Statusline advance + graph rebuild

```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" advance
```

Rebuild code and project graphs if a graph tool exists.

### B6. Advance

Update task state. Re-read the plan -- catches inserted phases. Advance to the next
phase. Do NOT exit until all phases are done or a hard gate is hit.

---

## Phase C -- Lifecycle

Milestone audit, complete the milestone (version bump per the repo's semver policy),
clean up archived phase directories.

```bash
node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js" clear
```

---

## Hard safety boundaries (NEVER bypass, even autonomous)

Force-push, production deploy, force-delete, financial actions, secret rotation, and any
irreversible/production-data action NEVER autonomy-bypass. Enforce at command dispatch
via the PreToolUse sentinel (`references/PRE-TOOL-USE-HOOK.md`); full per-stack
inventory in `references/HARD-GATES-CHECKLIST.md`. If a phase's exit gate needs one,
STOP and surface options to the owner. Never infer authorization from a prior message.
Treat unsure cases AS IF gated.

---

## Autonomous mode

Enter only AFTER Phase P (plan hardened, deadly-loop converged) AND Phase A.5
(AFK-ready) are complete. Run remaining phases via the execution loop, or dispatch a
background driver per `references/AUTONOMOUS-DRIVER-PROMPT.md` with a "Read FIRST"
pointer at `SKILLS_PROTOCOL.md` + `CONVERSATION-CONTEXT.md`, the verbatim hard-gate
list, soft-gate handling (defer on `human_needed`, continue on `gaps_found`), and status
streaming to `.planning/AUTONOMY-STATUS.md`. Silence = continue. Termination rules:
`references/DEBATE-SYNTHESIS-RULES.md` section "Termination".

---

## Agent watchdog discipline

Spawned subagents must be monitored. Reference the orchestration discipline skill for
full details; the key rules:

- Track each background agent by ID. Use TaskOutput on an interval to check status.
- If an agent is silent beyond its expected window, apply backoff and then TaskStop.
- Tasks must be scoped small. A task that runs more than ~15 min without output is
  almost always stuck or drifting -- stop, diagnose, re-scope.
- Never stack blocking waits. Collect results from parallel agents together; only
  serialize when a true dependency requires it.

---

## Anti-patterns

Don't:
- Start coding before the plan survives the deadly-loop (P4) -- that is the whole point
- Skip the per-phase deadly-loop (B2) to "save time" -- the bug you skip costs more
- Skip the analyze-work fan-out (A1) on anything touching > 1 file -- missed blast radius is the enemy
- Plan only the happy-path file -- the blast radius map must name everything it perturbs
- Skip edge-case enumeration / scenario simulation (P3) -- unsimulated scenarios are where production breaks
- Treat the plan as fixed after P4 -- if execution reveals a planning hole, re-plan and re-harden
- Accept garbage from a debate agent -- restart with corrected context, don't let it count as a finding
- Let stalled loops run indefinitely -- apply the convergence stall rule and escalate
- Let two Opus instances collapse to the same opinion on the Codex-fallback path -- the Critic's divergent persona is mandatory to keep the debate adversarial
- Run the analyze-work fan-out with write-capable tools -- analyzers are read-only
- Dispatch parallel subagents on overlapping files -- file conflicts cost more than the time saved
- Claim phase complete without running the verify-cmd and showing actual output

---

## Statusline wiring (summary)

All calls use `node "${CLAUDE_PLUGIN_ROOT}/statusline/phase.js"`. The `CLAUDE_PLUGIN_ROOT`
env var is set by the plugin installer. If it is not set, skip statusline calls silently
-- do not error.

| Event | Call |
|---|---|
| Phase enter | `phase.js set <CODE> "<desc>" <done> <total>` |
| Sub-step change | `phase.js step "<text>"` |
| Active-agent count change | `phase.js agents <n>` |
| Phase complete | `phase.js advance` |
| Run end / cleanup | `phase.js clear` |

---

## References

- [`references/MODEL-POLICY.md`](references/MODEL-POLICY.md) -- shared Reviewer/Critic roster
- [`references/CONVERSATION-CONTEXT-template.md`](references/CONVERSATION-CONTEXT-template.md) -- decision-history scaffolding
- [`references/SKILLS_PROTOCOL-template.md`](references/SKILLS_PROTOCOL-template.md) -- gate-matrix scaffolding
- [`references/DEBATE-PROMPTS.md`](references/DEBATE-PROMPTS.md) -- Reviewer/Critic prompt templates (plan, post-phase, UI/UX) + both Critic personas + anti-speculation + caching
- [`references/DEBATE-SYNTHESIS-RULES.md`](references/DEBATE-SYNTHESIS-RULES.md) -- canonical synthesis + termination ruleset for all gates
- [`references/HARD-GATES-CHECKLIST.md`](references/HARD-GATES-CHECKLIST.md) -- per-stack hard-gate inventory
- [`references/PRE-TOOL-USE-HOOK.md`](references/PRE-TOOL-USE-HOOK.md) -- drop-in PreToolUse hard-gate sentinel
- [`references/AUTONOMOUS-DRIVER-PROMPT.md`](references/AUTONOMOUS-DRIVER-PROMPT.md) -- background driver dispatch template
- [`references/code-graph-ignore-template`](references/code-graph-ignore-template) -- starter exclusions for the code graph

Copy and customize per project.

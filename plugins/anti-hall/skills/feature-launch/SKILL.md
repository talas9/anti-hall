---
name: feature-launch
description: Rigorous plan-first, debate-hardened protocol for shipping a non-trivial feature spanning one or more repos. Use when the user says "let's build X" / "implement Y" / "apply Z feature" and the work spans more than a single file or a single afternoon, or involves schema design, multi-phase work, cross-repo coordination, or production-data migration. The plan is authored in PLAN MODE, blending the best of the superpowers planning skills and a GSD-style phase workflow (it does NOT hard-depend on GSD). The plan is then hardened with the deadly-loop FIRST — before any code — until it is airtight, non-narrow, and every edge case and scenario is simulated. Execution proceeds phase by phase, and the deadly-loop runs again after EACH phase. Reviewer = Claude Opus latest at max thinking; Critic = OpenAI Codex latest at max reasoning when available, otherwise a second divergent Opus.
---

# Feature Launch Protocol

A workflow for shipping non-trivial features safely. Its spine is: **plan properly,
prove the plan is airtight before writing code, then build in small phases that are
each hardened before moving on.** Most feature failures are planning failures that
only surface as bugs later — this protocol spends its rigor up front.

It is intentionally generic: no assumed cloud, language, branch policy, or CI
provider. Substitute the repo's own conventions where the text says "the repo's own
policy."

## When to use

**Use when ANY of these are true:**
- Feature spans more than one repo
- Schema migration / production data involved
- Estimated > 1 day of work
- Owner will keep working on the mainline branch while you build
- Architectural decisions need cross-model peer review
- Verification rigor matters (live users, money, security)

**Don't use for:** single-file bug fixes, trivial UI tweaks, or existing-spec
implementation with no design ambiguity.

## What this skill depends on (and what it does NOT)

This skill orchestrates other skills. It is **not** tied to GSD.

- **Planning** — it uses PLAN MODE to think, and blends whatever planning tooling is
  present (see "Planning system selection" below): the superpowers planning skills
  (`brainstorming`, `writing-plans`, `executing-plans` / `subagent-driven-development`)
  and/or a GSD-style phase workflow. If neither is installed, it falls back to plan
  mode plus the templates in `references/`.
- **Plan + phase hardening** — it uses the **`deadly-loop`** skill (same plugin) as
  the debate engine, applied first to the PLAN and then after each execution phase.
- **Model roster** — Reviewer/Critic roster is defined in
  [`references/MODEL-POLICY.md`](references/MODEL-POLICY.md) (Opus latest max thinking + Codex latest
  max reasoning, fallback divergent 2x Opus). `deadly-loop` consumes the same roster.
- **Knowledge graph (optional)** — a code graph + project graph if a graphing tool
  is available; used to ground the debate. Skip gracefully if absent.

If the `deadly-loop` skill is unavailable, STOP and resolve it — the plan-hardening
gate is the heart of this protocol.

---

## Workflow

```
Phase A: Initialize
  |-- A1. Graph the world (code + project graph)        [optional, if a graph tool exists]
  |-- A2. Pick the planning system (superpowers / GSD / fallback)
  |-- A3. Set up worktrees                               [only if concurrent owner work]
  +-- A4. Write CONVERSATION-CONTEXT.md + SKILLS_PROTOCOL.md

Phase P: PLAN (in plan mode) — the most important phase
  |-- P1. Brainstorm intent + constraints (superpowers:brainstorming if present)
  |-- P2. Draft the plan (plan mode; writing-plans / GSD plan; phase breakdown)
  |-- P3. Edge-case enumeration + scenario simulation (mandatory, on paper)
  +-- P4. HARDEN THE PLAN WITH THE deadly-loop  <-- mandatory gate, BEFORE any code
          (iterate Reviewer+Critic fix-waves until airtight: zero NEW P0 concerns)

Phase A.5: AFK readiness gate (only if going autonomous)

Phase B: Per-phase execution loop
  |-- B1. Execute the phase (TDD; atomic commits; verify before claiming done)
  |-- B2. HARDEN THE PHASE WITH THE deadly-loop  <-- mandatory gate, after EACH phase
  |-- B3. UI/UX deadly-loop                        [frontend phases only]
  |-- B4. Verify (UAT + goal-backward + integration)
  |-- B5. Rebuild graphs                           [if a graph tool exists]
  +-- B6. Iterate to next phase
```

The two `deadly-loop` gates (P4 on the plan, B2 after each phase) are non-negotiable.

---

## Phase A — Initialize

### A1. Graph the world (if a graph tool exists)
Build/update a **code graph** (architecture of the repo[s]) and, once the planning
workspace exists, a **project graph** (relationships among planning artifacts). Keep
their outputs for the debate agents to consult. On a large repo, write an ignore
file first (see `references/code-graph-ignore-template`) and confirm a sensible file
count before running. If no graph tool is installed, skip — do not block.

### A2. Pick the planning system (no GSD dependency)
Detect, in this order, and use the richest available:

1. **superpowers planning skills present** (`brainstorming`, `writing-plans`,
   `executing-plans`, `subagent-driven-development`) -> use them for thinking quality:
   brainstorm intent first, then write the plan, then execute plan-driven.
2. **GSD-style phase workflow present** (`.planning/` workspace, `gsd-plan-phase`
   etc.) -> use it for phase structure, spec/plan/verify artifacts, and roadmap.
3. **Both present** -> BLEND: superpowers for the brainstorm + plan-writing quality
   and execution discipline; GSD for phase decomposition, artifacts, and roadmap
   tracking. This is the preferred mode.
4. **Neither** -> fall back to plan mode + the `references/` templates here.

Record which system you chose in `CONVERSATION-CONTEXT.md`.

### A3. Multi-repo worktree convention (only if needed)
If the feature touches multiple repos AND the owner keeps working on mainline
concurrently, isolate each repo's work in its own git worktree:

```bash
cd <repo-path>
git fetch origin <base-branch> --quiet
git worktree add <workspace-root>/.worktrees/<repo>-<feature-slug> \
  -b feat/<feature-slug> origin/<base-branch>
```

Use the **repo's own branch policy** for base + merge target (this skill prescribes
none). Record each worktree path/branch/base in `SKILLS_PROTOCOL.md`. NEVER edit a
repo's primary checkout while a worktree exists for it. Single-repo or no concurrent
owner work -> skip worktrees, use a normal feature branch.

### A4. Write the two protocol files
- **`.planning/CONVERSATION-CONTEXT.md`** — decision history, hard rules, worktree
  assignments, pre-existing branch state, chosen planning system, graph baseline,
  out-of-scope deferrals, and a "when in doubt" lookup order. Template:
  `references/CONVERSATION-CONTEXT-template.md`.
- **`.planning/SKILLS_PROTOCOL.md`** — the gate matrix (authoritative): per-phase
  entry/exit gates, the two deadly-loop gates, hard gates that NEVER autonomy-bypass,
  stack-specific skill auto-engagement, worktree discipline. Template:
  `references/SKILLS_PROTOCOL-template.md`. Point the repo's `CLAUDE.md` at it.

---

## Phase P — PLAN (in plan mode)

This is where the protocol earns its keep. **A proper, airtight plan, debated before
a single line is written, prevents the narrow-vision tunneling that turns into days
of rework.** Do this in PLAN MODE (`EnterPlanMode`) so nothing is edited until the
plan is approved.

### P1. Brainstorm intent + constraints
If `superpowers:brainstorming` is present, use it — surface the real intent,
requirements, and design space before committing to an approach. Otherwise
interrogate: what problem, for whom, what are the non-negotiables, what is explicitly
out of scope, what existing code/contracts does this touch.

### P2. Draft the plan
Write the plan using the chosen planning system (P=A2). Whatever the tooling, the
plan MUST contain:
- A phase breakdown — small, independently shippable, independently verifiable
  phases (a phase is a vertical slice, not a layer).
- For each phase: goal, the exact files/modules touched, the test strategy, the
  verification that proves the phase's goal (goal-backward, not just "tasks done").
- **A map of ALL touched aspects of the code** — every module, contract, schema,
  caller, config, migration, and downstream consumer the feature affects. Narrow
  vision is the enemy; the plan must name everything it perturbs, not just the
  happy-path file.
- Data/schema changes with migration + rollback.
- The hard-safety-boundary actions the feature will require (deploys, migrations,
  secret changes) flagged for the gate.

### P3. Edge-case enumeration + scenario simulation (MANDATORY)
Before the plan is considered done, on paper:
- **Enumerate every edge case** for each phase: empty/null/missing inputs, boundary
  values, malformed data, permission/auth denied, concurrent access, partial
  failure, network/timeout, idempotency/retry, ordering, very large inputs,
  first-run/empty state, migration of pre-existing bad data.
- **Simulate every scenario** end to end: walk the happy path AND each failure mode
  through the planned code paths, and write what the system does at each step. If you
  cannot describe the behavior for a scenario, the plan has a hole — fill it.
- Record the edge-case/scenario matrix in the plan. The deadly-loop (P4) will attack
  exactly the cases you missed.

### P4. HARDEN THE PLAN WITH THE deadly-loop (mandatory gate, BEFORE any code)
Invoke the **`deadly-loop`** skill with the PLAN as its target (not code). It runs
parallel Reviewer + Critic auditors (roster per `references/MODEL-POLICY.md`) and dispatches
fix-waves, looping until convergence — **zero NEW P0 concerns**. Direct the auditors
to attack the plan specifically for:
- Narrow vision / missed blast radius — a touched module, caller, or contract the
  plan ignored.
- Missing edge cases or unsimulated scenarios (cross-check P3).
- Unsound phase decomposition, hidden cross-phase coupling, wrong sequencing.
- Schema/migration/rollback gaps; data-loss or irreversibility risk.
- Unproven assumptions stated as fact (demote per the anti-speculation rule below).

Do NOT exit plan mode / start building until the plan survives the deadly-loop with
no NEW P0s. Then `ExitPlanMode` for owner approval.

---

## Phase A.5 — AFK readiness gate (only if going autonomous)

If running hands-off, do a full pre-flight scan BEFORE declaring autonomy: read the
hardened plan, `CONVERSATION-CONTEXT.md`, `SKILLS_PROTOCOL.md`, and
`references/HARD-GATES-CHECKLIST.md` in full; extract every open question, hard-gate
trigger, credential/token need, and ambiguity; batch them into ONE questionnaire for
the owner; update context + commit. Only when zero ambiguities remain, emit the
"AFK ready" signal and start. Install the pre-Bash hard-gate sentinel
(`references/PRE-TOOL-USE-HOOK.md`) BEFORE entering autonomy; if it is not installed,
refuse to declare AFK-ready.

### Anti-speculation discipline (applies to ALL subagents from here on)
Every dispatched subagent receives this verbatim, prepended:

> **NEVER speculate. NEVER make up information.** Every claim must be backed by
> something you actually read or ran. "think" / "believe" / "assume" / "would
> expect" = speculation: verify with a tool (Read / grep / git / Bash) or omit it.
> Findings without a `file:line` citation, command output, or quoted doc are demoted
> to advisory. Hedged language (`probably`, `likely`, `might`, `seems`) auto-demotes
> a P0 to advisory. Include a "verified-against" footer of the exact files+lines you
> read. This rule is non-negotiable.

---

## Phase B — Per-phase execution loop

### B1. Execute the phase
Build under TDD discipline: a failing test before the code, atomic commits, and
verify-before-claiming-done (run the check, show the output — "should work" is not
done). If superpowers execution skills are present
(`executing-plans` / `subagent-driven-development`), use them.

### B2. HARDEN THE PHASE WITH THE deadly-loop (mandatory gate, after EACH phase)
After the phase's implementation is committed, invoke the **`deadly-loop`** skill on
the phase's diff/code. Iterate Reviewer + Critic fix-waves until convergence — zero
NEW P0 blockers — covering: correctness vs the plan, regressions, the edge cases and
scenarios from P3 actually handled in code, security on security-relevant phases, and
the full blast radius (every touched caller/contract behaves). Do not advance to the
next phase until this phase converges.

### B3. UI/UX deadly-loop (frontend phases ONLY)
If the phase touched UI, first produce/verify a UI-SPEC (information architecture;
component state matrix: default/hover/active/disabled/loading/empty/error/partial;
responsive + density; a11y contrast/keyboard/screen-reader; motion respecting
`prefers-reduced-motion`; destructive-action UX; first-run/empty state). Then run a
SPECIALIZED UI/UX deadly-loop in addition to B2. Document in `<phase>/UX-DEBATE.md`.

### B4-B5. Verify + graph rebuild
Validate test coverage; security audit on security-relevant phases; conversational
UAT; goal-backward + integration checks. Rebuild both graphs if a graph tool exists.

### B6. Iterate
Update STATE, re-read the roadmap (catches inserted phases), advance. Do NOT exit
until all phases are done OR a hard gate is hit.

---

## Phase C — Lifecycle
Milestone audit, complete the milestone (version bump per the repo's semver policy),
clean up archived phase directories.

---

## Hard safety boundaries (NEVER bypass, even autonomous)
Force-push, production deploy, force-delete, financial actions, secret rotation, and
any irreversible/production-data action NEVER autonomy-bypass. Enforce at command
dispatch via the PreToolUse sentinel (`references/PRE-TOOL-USE-HOOK.md`); full
per-stack inventory in `references/HARD-GATES-CHECKLIST.md`. If a phase's exit gate
needs one, STOP and surface options to the owner. Never infer authorization from a
prior message. Treat unsure cases AS IF gated.

---

## Autonomous mode
Enter only AFTER Phase P (plan hardened, deadly-loop converged) AND Phase A.5
(AFK-ready) are complete. Run remaining phases via the execution loop, or dispatch a
background driver per `references/AUTONOMOUS-DRIVER-PROMPT.md` with a "Read FIRST"
pointer at `SKILLS_PROTOCOL.md` + `CONVERSATION-CONTEXT.md`, the verbatim hard-gate
list, soft-gate handling (defer on `human_needed`, continue on `gaps_found`), and
status streaming to `.planning/AUTONOMY-STATUS.md`. Silence = continue. Termination
rules: `references/DEBATE-SYNTHESIS-RULES.md` section "Termination".

---

## Anti-patterns
Don't:
- Start coding before the plan survives the deadly-loop (P4) — that is the whole point
- Skip the per-phase deadly-loop (B2) to "save time" — the bug you skip costs more
- Plan only the happy-path file — map the full blast radius (P2) or the debate will find it the hard way
- Skip edge-case enumeration / scenario simulation (P3) — unsimulated scenarios are where production breaks
- Treat the plan as fixed after P4 — if execution reveals a planning hole, re-plan and re-harden, don't paper over it
- Let two Opus instances collapse to the same opinion on the Codex-fallback path — the Critic's divergent persona keeps it adversarial (see `references/MODEL-POLICY.md`)
- Run the code graph on a huge corpus with no ignore file — it burns tokens

---

## References
- [`references/MODEL-POLICY.md`](references/MODEL-POLICY.md) — shared Reviewer/Critic roster (used by the deadly-loop gates)
- [`CONVERSATION-CONTEXT-template.md`](references/CONVERSATION-CONTEXT-template.md) — decision-history scaffolding
- [`SKILLS_PROTOCOL-template.md`](references/SKILLS_PROTOCOL-template.md) — gate-matrix scaffolding
- [`DEBATE-PROMPTS.md`](references/DEBATE-PROMPTS.md) — Reviewer/Critic prompt templates (plan, post-phase, UI/UX) + both Critic personas + anti-speculation + caching
- [`DEBATE-SYNTHESIS-RULES.md`](references/DEBATE-SYNTHESIS-RULES.md) — canonical synthesis + termination ruleset for all gates
- [`HARD-GATES-CHECKLIST.md`](references/HARD-GATES-CHECKLIST.md) — per-stack hard-gate inventory
- [`PRE-TOOL-USE-HOOK.md`](references/PRE-TOOL-USE-HOOK.md) — drop-in PreToolUse hard-gate sentinel
- [`AUTONOMOUS-DRIVER-PROMPT.md`](references/AUTONOMOUS-DRIVER-PROMPT.md) — background driver dispatch template
- [`code-graph-ignore-template`](references/code-graph-ignore-template) — starter exclusions for the code graph

Copy and customize per project.

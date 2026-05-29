# GSD Phase Model — Distilled for anti-hall Feature-Launch Extension

Research date: 2026-05-29
Sources: `.gsd/TEAM-FORMATION.md`, `.gsd/DEBATE-WORKFLOW.md`, `.gsd/GRAPHIFY-WORKFLOW.md`,
`.gsd/preferences.md`, `.gsd/ADDONS-CONFIG.md`, `.gsd/agents/*`,
`~/.claude/skills/gsd-{discuss,plan,execute,autonomous,phase,plan-review-convergence,map-codebase}-phase/SKILL.md`,
`~/.claude/get-shit-done/references/{agent-contracts,revision-loop}.md`,
`plugins/anti-hall/skills/feature-launch/SKILL.md`

---

## 1. What GSD's Phase Model Actually Is

### Lifecycle (ordered)

```
context-load (graph-scout / graphify-first)
  -> discuss-phase      [clarify decisions, produce CONTEXT.md]
  -> plan-phase         [research -> planner -> plan-checker -> PLAN.md files]
    -> plan-review-convergence   [optional: external CLI cross-review loop]
  -> post-plan debate   [plan-reviewer (Opus) + plan-critic (cross-provider) in parallel]
    -> fix-wave-coordinator      [if HOLD: group fixes by non-overlapping files, run, re-verify]
    -> graphify update           [if code/config changed]
  -> execute-phase      [wave-based parallel subagents per PLAN.md, each fresh context]
  -> post-execution debate  [execution-reviewer + execution-critic, same structure]
    -> fix-wave loop    [until zero NEW P0/P1]
  -> verify-work / gsd-verifier
  -> deadly-loop skill  [mandatory pre-merge/pre-ship hardening]
  -> milestone complete + cleanup
```

### Phase artifacts written per phase
`{N}-CONTEXT.md`, `{N}-{plan}.PLAN.md` (with YAML frontmatter: wave, depends_on, files_modified), `{N}-{plan}.SUMMARY.md`, `VERIFICATION.md`, `REVIEWS.md`

### Gates
- **Post-plan debate:** Reviewer (Opus) + Critic (cross-provider, e.g. Codex GPT-5.5) in parallel. Both independent; different platforms preferred. Outcome: GO / HOLD / ESCALATE.
- **Post-execution debate:** Same structure; verifies implementation matches plan and tests are real.
- **Fix-wave loop:** Groups independent fixes, runs them in parallel, re-debates until no NEW P0/P1. "New" is the termination signal — rediscovered old findings don't count.
- **Graphify update:** Required before final execution debate and after code/config fix waves.
- **Deadly-loop skill:** Separate, outer hardening loop invoked before merge/ship.

### Autonomous mode
Runs discuss->plan->execute per phase sequentially, pausing only for explicit human decisions. Uses ROADMAP.md + STATE.md for progress tracking. Phase discovery is dynamic (re-reads roadmap to catch inserted phases).

### Convergence rule
Loop terminates when the count of **NEW** (not rediscovered) P0/P1 blockers reaches zero. Stall detection: if blocker count does not decrease between iterations, escalate instead of retrying.

### Model routing
- Cheap workers (graph queries, logs, docs, git): Haiku / Codex Spark
- Orchestration, normal implementation: Sonnet
- Planning, debate gates: Opus (or equivalent high-reasoning)
- Cross-provider critic: a different platform (Codex GPT-5.5 when Opus is reviewer)

---

## 2. What Is Heavyweight / Overkill for a Generic Plugin

The full GSD model is a production ops system tuned for a multi-repo aviation app with
live users, payment flows, and rigid branch policies. These elements are
project-specific overhead, not universally transferable value:

| Element | Why it is heavyweight |
|---|---|
| Per-phase file tree (CONTEXT.md, PLAN.md, SUMMARY.md, VERIFICATION.md, REVIEWS.md, STATE.md, ROADMAP.md) | 7+ files per phase adds friction disproportionate to most features |
| `gsd-sdk` CLI / `gsd-sdk query init.*` bootstrap | External binary dependency; not portable |
| Ambiguity scoring in discuss-phase | Useful for long stakeholder discussions; overkill for most planning |
| Roadmap file management (`gsd-phase --insert/--remove/--edit`) | Valuable for 10+ phase milestones; overhead for 2-4 phase features |
| `.planning/codebase/` 7-document map | Deep brownfield onboarding artifact; regeneration cost high |
| Per-agent completion markers (`## PLANNING COMPLETE`, etc.) | Needed by GSD's regex-based workflow engine; irrelevant without that engine |
| `gsd-sdk` config toggles (`workflow.discuss_mode`, `workflow.plan_review_convergence`) | Config management layer with no generic equivalent |
| Multi-CLI external review (`--gemini`, `--codex`, `--qwen`, `--cursor` flags) | Good for convergence; optional, not core |
| Wave numbering (`wave: 1`, `depends_on:` frontmatter) | Valuable at 5+ parallel plans; overhead for small features |
| Autonomous mode with AUTONOMY-STATUS.md streaming | Useful for AFK multi-hour runs; not a first-class generic need |
| Domain-specialist agent roles (skyflutter-mobile, skyfb-cloud, etc.) | Project-specific; generic plugin needs role-agnostic contracts |
| Hard gates specific to the project (Firestore rules, financial actions, app-store submissions) | Must be parameterized per project, not baked in |

**What survives extraction:** the debate gate structure (parallel reviewer + adversarial critic, fix waves, convergence on NEW P0s), phase decomposition with goal + touched-files + verification, anti-speculation discipline, and model tiering.

---

## 3. A Simpler Phase Model (the Recommendation)

### KEEP / SIMPLIFY / DROP table

| GSD Concept | Decision | Rationale |
|---|---|---|
| Phase decomposition (goal, files, verify) | KEEP | Core value: forces blast-radius mapping before coding |
| Post-plan debate (parallel reviewer + critic, fix waves, NEW-P0 convergence) | KEEP | Prevents narrow-vision tunneling; proven ROI |
| Post-execution debate (same structure) | KEEP | Catches implementation divergence from plan |
| Anti-speculation discipline (every claim needs file:line or command output) | KEEP | Directly addresses hallucination; core anti-hall value |
| Model tiering (cheap for routine, strong for gates) | KEEP | Cost-efficiency without sacrificing gate quality |
| Edge-case enumeration + scenario simulation before coding | KEEP | P3 in feature-launch; the debate attacks exactly the cases you enumerated |
| Context-first (graph / existing knowledge before raw file reads) | KEEP | Prevents redundant exploration |
| Fix-wave parallelism (non-overlapping files -> parallel lanes) | KEEP, simplified | Simplify: one-sentence grouping rule, no YAML frontmatter |
| Discuss-phase (adaptive questioning, produce locked decisions) | SIMPLIFY -> "gather intent" step | Keep the output (a list of locked decisions) without the full questioning protocol |
| CONTEXT.md, PLAN.md, SUMMARY.md, VERIFICATION.md | SIMPLIFY -> task-list entries | Track goal + touched-files + verify in the task description, not separate files |
| ROADMAP.md + STATE.md | SIMPLIFY -> running task list | Single append-only task list (existing TodoWrite / task system) |
| Graphify update at phase boundaries | SIMPLIFY -> "rebuild graph if graph tool present" | Keep the trigger, drop the mandatory-binary dependency |
| Completion marker protocol (`## PLANNING COMPLETE`) | DROP | Only needed for regex-driven workflow engine |
| gsd-sdk / CLI bootstrap | DROP | External binary dependency |
| Per-phase codebase map (7 documents) | DROP | Replace with "graph the world once at start" |
| Multi-CLI external review flags | DROP as core, keep as optional | External reviewers are a nice-to-have, not the gate |
| Autonomous mode + AUTONOMY-STATUS streaming | DROP as core | Keep intent (hands-off execution) without file-streaming protocol |
| Per-phase `.planning/` workspace files | DROP | Replace with task metadata + a single CONVERSATION-CONTEXT doc |
| Domain specialist role contracts | DROP | Generic: caller parameterizes roles per project |
| Wave numbering YAML frontmatter | DROP | Replace with natural-language grouping in plan |

### The Simpler Phase Loop (5-8 line summary)

```
1. ORIENT:  Load existing knowledge (graph/docs if present). List locked decisions.
2. PLAN:    Decompose into phases (goal + exact files/modules touched + verification).
            Enumerate edge cases and simulate each scenario on paper.
3. HARDEN:  Debate the PLAN — parallel Reviewer (strong reasoning) + Critic (adversarial,
            cross-provider when possible). Fix-wave on HOLD findings. Loop until zero NEW P0s.
4. BUILD:   Execute each phase with TDD discipline (test -> code -> verify, atomic commits).
            Fan out independent sub-tasks in parallel (non-overlapping files only).
5. HARDEN:  Debate each phase's diff — same Reviewer + Critic structure. Loop until zero NEW P0s.
6. GATE:    Any irreversible action (deploy, migration, secret rotation, force-push) serializes
            here for explicit human confirmation regardless of autonomy mode.
7. ADVANCE: Update task state, re-read plan (catches inserted phases), repeat from 4.
```

Tracking lives in the existing task list (one entry per phase, updated in place), plus one
`CONVERSATION-CONTEXT.md` that records locked decisions, worktree assignments, and hard-gate log.

---

## 4. Composition with the Opus 4.8 Swarm

The swarm model (documented in `docs/opus-4-8-swarm.md`) fans out parallel analyzers.
Phase boundaries are where the two concepts interact:

### Fan-out points (parallel)
- ORIENT: parallel analyzer agents (architecture, security, contracts, tests) -> synthesis
- PLAN (edge-case simulation): each phase's scenarios can be simulated by parallel agents
- BUILD (per-phase): independent plans in a wave run as parallel subagents (each gets fresh context)
- HARDEN: Reviewer and Critic always run in parallel (they must be independent)
- Fix waves: independent fix groups run as parallel subagents

### Serialization points (gates)
- HARDEN on the PLAN must complete (zero NEW P0s) before BUILD starts — this is the invariant
- HARDEN on each phase must complete before advancing to the next phase
- GATE (step 6) always serializes: human confirmation is synchronous
- Schema/protocol changes before clients (ordering constraint, not a debate gate)

### Generic rule
Parallelize analyzers and fix workers; serialize gates. The gate is the single synchronization
point that prevents parallel agents from building on an unvalidated foundation.

### Where the swarm fits
A natural "analyze work" multi-step in the feature-launch skill:

```
analyze_work(target):
  fan out in parallel:
    - architecture-analyzer (blast radius, touched contracts)
    - security-analyzer (auth, secrets, data flow)
    - test-analyzer (coverage gaps, missing scenarios)
    - contract-analyzer (callers, schema dependencies)
  synthesize -> structured findings fed to the PLAN step
```

This is the graph-scout + architect-planner combo from GSD, generalized. The synthesis
output populates the PLAN's "touched files/modules" section so the debate has concrete
targets to attack.

---

## 5. Concrete Proposal for Extending anti-hall Feature-Launch

### A. The simpler phase loop in feature-launch terms

Extend the existing workflow (Phases A->P->B->C) with this lighter phase structure inside Phase B:

```
per_phase:
  task_entry: { goal, files, edge_cases, verify_cmd }   # one task-list entry, no extra files
  build: TDD, atomic commits, non-overlapping parallel sub-tasks
  harden: deadly-loop on diff (existing mechanism, unchanged)
  gate: check task against HARD-GATES-CHECKLIST; serialize if hit
  advance: mark task done, read plan for next phase
```

Replace the optional "GSD-style phase workflow" branch (currently A2 option 2) with this
lighter model so users without GSD installed get a real phase structure, not just "plan mode."

### B. "Analyze work" multi-step mode

Add an optional `--analyze` flag to feature-launch (or invoke it automatically for
features with blast_radius > 1 repo):

```
Phase A.1 (enhanced):
  if graph tool present: build/refresh code graph
  fan out in parallel (model: light/Haiku tier):
    - architecture-analyzer  -> { touched_modules, api_contracts, callers }
    - security-analyzer      -> { auth_paths, secret_access, data_flows }
    - test-analyzer          -> { coverage_gaps, missing_scenarios }
    - contract-analyzer      -> { schema_deps, downstream_consumers }
  synthesize (model: standard tier): merge findings into CONVERSATION-CONTEXT.md
  output: structured "blast radius map" fed to P2 (plan drafting)
```

The debate agents (P4 / B2) receive the blast radius map as context, which lets them
attack the plan/diff with specificity rather than generic heuristics.

### C. KEEP / SIMPLIFY / DROP applied to the existing feature-launch SKILL.md

The existing SKILL.md is already well-structured. Concrete changes:

| Current element | Proposed change |
|---|---|
| A2 "pick planning system" (4-way branch) | Add "lightweight phase loop" as option 5 (fallback when neither superpowers nor GSD is installed); make it the default for single-repo features |
| P2 plan format (phase breakdown) | Add `edge_cases` and `verify_cmd` fields to the per-phase spec; currently only implied |
| B1 execute (TDD) | Add explicit: "fan out independent sub-tasks in parallel; non-overlapping files only" — currently implied but not stated |
| A.5 AFK readiness | Add "analyze work" fan-out here, before AFK declaration, so the blast radius map is available for the entire run |
| No equivalent | Add: convergence stall detection rule — if blocker count does not decrease between debate rounds, escalate rather than retry |
| No equivalent | Add: explicit "re-read plan after each phase" step — catches phases inserted mid-execution by the debate |

### D. Minimal SKILL.md addition (paste-ready fragment)

```markdown
## Lightweight Phase Loop (when GSD is absent)

If neither GSD nor superpowers are installed (A2 fallback), use this structure for each phase:

  task:
    goal:        one sentence — what this phase proves works
    files:       exact list of every module, contract, schema, caller this phase perturbs
    edge_cases:  enumerated list (empty input, boundary, auth denied, partial failure, retry)
    verify_cmd:  the command (or UAT step) that proves the goal, not just "tasks done"

Track in the task list. No extra files. Update goal/verify in place as execution reveals gaps.

## Analyze Work (fan-out mode, --analyze or blast_radius > 1 repo)

Before Phase P, fan out in parallel:
  - architecture-analyzer  -> touched modules, API contracts, callers
  - security-analyzer      -> auth paths, secret access, data flows
  - test-analyzer          -> coverage gaps, missing edge-case scenarios
  - contract-analyzer      -> schema dependencies, downstream consumers

Synthesize findings into CONVERSATION-CONTEXT.md "Blast Radius" section.
Feed the blast radius map to both the planner (P2) and debate agents (P4, B2).

## Convergence stall rule

If the count of NEW P0/P1 blockers does not decrease between consecutive debate rounds,
the loop has stalled. Stop retrying. Escalate remaining blockers to the owner with a
summary of why they are not resolving. The owner chooses: accept risk / redesign / unblock.
```

---

## Summary

GSD's real value for a generic plugin distills to four primitives:
1. Phase decomposition with blast-radius mapping (not just happy-path files)
2. Parallel reviewer + adversarial critic, fix waves, convergence on NEW P0s (not total P0s)
3. Anti-speculation discipline (every claim needs a citation)
4. Fan-out analyzers -> synthesis before planning, to give the debate agents concrete targets

Everything else — the file tree, the CLI, the agent completion markers, the roadmap management,
the domain roles — is GSD's operational scaffolding for a specific production environment.
Strip it; the four primitives are portable.

The feature-launch SKILL.md already contains primitives 1, 2, and 3. Adding primitive 4
(analyze-work fan-out) and the lightweight phase loop (for the no-GSD path) is the
minimum viable extension.

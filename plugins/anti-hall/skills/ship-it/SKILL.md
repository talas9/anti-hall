---
name: ship-it
description: One lean, anti-hall-native workflow for shipping any change correctly — from a one-line fix to a multi-phase feature. Scales rigor to blast radius (S/M/L tiers). Brainstorm + plan happen IN PLAN MODE (ExitPlanMode is the approval gate); the plan is hardened with the deadly-loop BEFORE any code; on large work the disjoint build phases and the per-phase deadly-loop fan out as a Workflow swarm; each phase is verified with fresh evidence and a vacuous-test guard, then hardened until zero NEW P0s. Standalone — depends only on Claude Code built-ins (plan mode, the Workflow tool) plus anti-hall's own deadly-loop and always-on guards. Use when the user says "let's build X" / "implement Y" / "fix Z" and you want it done right the first time. Replaces feature-launch.
---

# Ship It — Plan Right, Build in Slices, Prove It Works

One workflow, matched to blast radius. Most failures are planning failures that surface
later as bugs, so the rigor is spent up front, then kept cheap by scaling it to risk:

- **Spec before quality.** First nail down WHAT is being built (intent + plan); only then
  attack HOW WELL it's built (the deadly-loop). Never debate code quality before the goal
  is agreed — you'll harden the wrong thing.
- **Brainstorm + plan in plan mode** — nothing is edited or built until the plan is approved
  via `ExitPlanMode`. That approval IS the build gate.
- **Plan as an executable artifact** (zero placeholders), hardened **before** any code.
- **Build in vertical slices**; on large work, fan disjoint phases out as a **Workflow
  swarm** — each verified with fresh evidence, then hardened with the `deadly-loop` to zero
  NEW P0s.

Generic by design: no assumed cloud, language, branch policy, or CI provider. Substitute
the repo's own conventions where the text says "the repo's own policy."

---

## Step 0 — Size the change (match rigor to blast radius)

Classify the work first. This decides how much of the protocol applies. **Do not
over-process a one-line fix; do not under-process a schema migration.**

| Tier | Trigger | Path |
|---|---|---|
| **S** | 1 file, no design ambiguity, no hard-risk trigger | **Just do it**: implement → verify with fresh output (Step 4 rules 3-5) → done. No plan mode, no plan file, no swarm, no deadly-loop. |
| **M** | 2-5 files, single afternoon, some design choices, no hard-risk trigger | **Lite**: plan mode optional → 1-paragraph intent → inline plan in the task list → build inline → verify (Step 4). No swarm. Deadly-loop only if a hard-risk trigger appears. |
| **L** | >5 files / >1 day / multi-repo, **or ANY hard-risk trigger** | **Full**: plan mode (brainstorm + PLAN.md) → ExitPlanMode gate → plan deadly-loop → swarm build + verify + per-phase deadly-loop. |

**Hard-risk triggers (force L regardless of file count):** security/auth, schema/migration,
production data, shell scripts, CI/workflow YAML, cross-repo, LLM prompts — exactly the
list in `deadly-loop` "When to use," where silent failures are expensive. If unsure between
two tiers, pick the higher. The skill below is written for **L**; **M** uses the marked
subset (no plan mode required, no swarm); **S** is a single edit that exits after verifying.

> **Swarm is an L-only mechanism.** It earns its keep only when the plan has ≥2 genuinely
> disjoint phases that can run in parallel. S and M build inline. Even at L, a single phase
> (or a `parallel_group` of one) is a plain inline build — never wrap one phase in a swarm.

---

## Step 1 — Brainstorm IN PLAN MODE (HARD GATE; L only)

**Enter plan mode now** via `EnterPlanMode`. Plan mode is **read-only**: you may read,
explore with bash, web-research, write the plan file, and ask the owner questions — but
**nothing is edited or built**. No code is written until the plan is approved.

- Surface the real intent, not the literal request: what problem, for whom, the success
  criterion, and what is explicitly **out of scope**.
- Ask clarifying questions **one at a time** (use `AskUserQuestion`), multiple-choice when
  possible. One good answer at a time forces real decisions; a dumped questionnaire doesn't.
- Output a short **intent note** (3-10 sentences): goal, constraints, 1-2 approaches with
  trade-offs, and a recommendation.

*(Optional: if `superpowers:brainstorming` is installed, use it — the gate is the point, not the tool.)*

---

## Step 2 — Author the plan file (still IN PLAN MODE; ONE durable artifact; L only)

> **M:** plan mode optional — keep the same fields as task-list entries; skip the file.

Still inside plan mode, write **one** file: `PLAN.md` in `.planning/` if that convention
exists, else the repo root. (Writing PLAN.md is the plan artifact itself, not "editing the
codebase" — it is the one write plan mode allows, and it carries the design through
`ExitPlanMode`, `/clear`, and compaction.) This single file is the durable memory — **not**
an artifact graph, not a file per phase.

```markdown
# <Feature> — Plan

## Intent
<the approved intent note from Step 1>

## Decisions
<key choices + why — the durable record; append, never rewrite>

## Blast radius
<every module, contract, schema, caller, config, migration, downstream consumer this
 change perturbs. Narrow vision is the enemy — name everything, not the happy-path file.>

## Phases  (ordered by dependency; each is a VERTICAL slice, not a horizontal layer)
### Phase 1: <one sentence — the observable capability this proves works>
- depends_on: none
- parallel_group: <phases sharing a group have NO mutual dependency AND disjoint files →
  they become one Workflow `parallel([...])` stage in Step 4>
- files: <exact paths touched — must be DISJOINT from sibling phases in the same group>
- read_first: <exact paths an executor must read before editing>
- steps: <complete, copy-pasteable exact edits / commands — NO placeholders>
- edge_cases: <empty/null, boundary, malformed, auth-denied, concurrent, partial failure,
  timeout, idempotency/retry, ordering, huge input, first-run/empty, pre-existing bad data
  — enumerate, then state what the code does for each>
- acceptance: <the exact command (or UAT step) + expected output that proves the goal —
  NOT "tasks done">
### Phase 2: ...

## Progress  (update in place — this is the resume point after /clear)
- [ ] Phase 1 — <status>
- [ ] Phase 2 — <status>

## Owner actions (manual, out of scope for the agent)
<secrets, deploys, IAM, migrations the owner must run>
```

**No placeholders.** "TBD", "handle edge cases", "similar to Phase N", "etc." are plan
**failures**. The test: *an executor with zero prior context could run this plan verbatim
without asking a question.* If they'd guess, the plan has a hole — fill it.

**Vertical slices, ordered by dependency.** A phase delivers an observable, independently
verifiable capability (e.g., "user can log in"), not a layer (e.g., "all the API"). Each phase
declares `depends_on`; phases that share a `parallel_group` (no mutual dependency, **disjoint
files**) are the swarm fan-out targets in Step 4. *(`parallel_group` only matters at L; M
leaves it blank and builds in order.)*

**Edge-case enumeration is mandatory, on paper, before the plan is done.** If you can't
describe the behavior for a scenario, that's the hole the deadly-loop will find — fill it now.

---

## Step 3 — Harden the plan with the deadly-loop (GATE; BEFORE any code; L only)

**Still in plan mode.** The plan itself is the target, not code. **Invoke `deadly-loop` on
PLAN.md** using the Workflow tool to fan out a parallel `parallel([...])` barrier stage with
two concurrent auditors:

- **Reviewer agent** (latest Opus, max thinking): read `PLAN.md`, audit for narrow vision /
  missed blast radius, unsound phase decomposition or sequencing, schema/migration/rollback
  gaps, and assumptions stated as fact without evidence.
- **Critic agent** (latest Codex if available, else divergent 2nd Opus, max reasoning): same
  lenses, different mental model, find blindspots.

Both run **concurrently** via a **BARRIER** `parallel([...])` — both finish before the
coordinator receives their reports. Spawn the Critic with `agentType` so the cross-model
Codex critic is preserved:

```js
parallel([
  () => agent(reviewerBrief, { model: "opus", run_in_background: true, label: "reviewer" }),
  () => agent(criticBrief,   { agentType: "codex:codex-rescue", run_in_background: true, label: "critic" }),
])
```

Note: spawning both as plain Claude agents would silently drop the cross-model Codex critic
(= 2-Opus fallback); use `agentType` for the Critic. The main thread **stays coordinator**:
it synthesizes their findings, dispatches fix-waves, and loops to re-debate.

**Loop fix-waves → re-debate until zero NEW P0s** (count NEW issues, not rediscovered ones;
the trend must fall to 0). Same deadly-loop caps: soft-10 / hard-15 rounds. If the trend
isn't falling well before soft-10, escalate to the owner (redesign scope / accept risk /
narrow).

**Convergence gate:** once the plan survives with zero NEW P0s, present it via `ExitPlanMode`.
Owner approval of the plan unlocks building. **Do not write a line of code before
`ExitPlanMode` approval** — that is the single plan → build transition.

---

## Step 4 — Build the phases (verify with FRESH evidence)

Plan mode is now exited and approved. **On resume after `/clear`:** read `PLAN.md` first —
Decisions + Progress are the resume point — then continue from the first unchecked phase.
*(S: this step is the whole job, done inline. M: build phases in order, inline.)*

### Swarm fan-out — L only, and only where the plan declares real parallelism

Use the **`Workflow` tool / Dynamic Workflows** to fan out at L. Primitives:
- **`phase(title)`** — names a phase step for logging.
- **`agent(prompt, { schema, model, label, phase, run_in_background, agentType })`** — spawns
  one background auditor or builder with the given options. `schema` returns a typed result.
- **`parallel([() => agent(...), () => agent(...), ...])`** — BARRIER fan-out; all agents
  finish before return. Used for:
  - Step 3 auditors (Reviewer + Critic, disjoint lenses).
  - Step 4 phases in the same `parallel_group` (disjoint files, no dependency).
  - Step 5 per-phase deadly-loops (Reviewer + Critic, same phase diff).
- **Caps:** ~`min(16, cores-2)` in-flight agents; 1000 total per run. **Cost: many tokens —
  test on a small slice first.** Determinism: no `Date.now()` / `Math.random()` / argless
  `new Date()` in the workflow script; pass seeds/timestamps via `args`.

**Build workflow structure:**
1. Group phases by `parallel_group` (from PLAN.md).
2. Each group with ≥2 disjoint phases becomes one `parallel([...])` stage.
3. Dependent groups run as later sequential stages (no `parallel` wrapper for them).
4. A group of 1 phase is **not** wrapped — build it inline, no swarm overhead.
5. The **main thread stays coordinator** — it spawns, collects results into an intermediate
   variable (not returned), and commits serially on the main thread (no concurrent git
   writes). Only the synthesized verdict (which phases passed, which need rework) comes back
   to the user.

Minimal deterministic `build.workflow.js` skeleton (no `Date.now`/`Math.random`/`new Date`;
pass seeds/timestamps via `args`):

```js
// build.workflow.js — DETERMINISTIC: no Date.now/Math.random/new Date; seeds via args.
const results = {};
phase("build: parallel group A (disjoint files, no mutual dependency)");
const groupA = await parallel([                          // BARRIER: both finish first
  () => agent(PHASE1_PROMPT, { schema, run_in_background: true, label: "phase1" }),
  () => agent(PHASE2_PROMPT, { schema, run_in_background: true, label: "phase2" }),
]);
results.phase1 = groupA[0]; results.phase2 = groupA[1];  // collect, don't return mid-run
phase("build: phase 3 (depends on group A)");            // LATER sequential stage
results.phase3 = await agent(PHASE3_PROMPT, { schema, run_in_background: true, label: "phase3" });
// coordinator reads `results`, then commits each phase serially on the main thread
```

For each phase (swarmed at L, or inline at S/M):

1. **Inject context, don't point.** Hand each agent the **full task text + the exact file
   excerpts it needs** — never "read the plan." Fan out **only on disjoint files**;
   dependent sub-tasks run in a later stage. Spawned workflow/build agents **cannot prompt
   the user mid-run**; on ambiguity they STOP and return the question to the coordinator,
   which surfaces it.

2. **Verification preamble for every spawned build agent.** Before editing, each agent runs
   the deadly-loop **A3 branch/SHA verification preamble** (verify it's on the right branch
   and HEAD) so edits are on solid ground. Plain statement: **verify before you claim done;
   no speculation — cite the file:line you actually changed.**

3. **Verification-before-completion (Iron Law).** Do NOT claim a phase done without **fresh
   command output in this message**: run the phase's `acceptance` command, read the full
   output, check the exit code. "Should pass" / "looks correct" is not done. Evidence before
   assertion — always.

4. **Vacuous-test guard.** A green suite is not proof if the tests don't exercise the change.
   Before trusting "tests pass," run the full cycle (matches deadly-loop D1.5): **revert the
   fix → run → confirm RED → restore the fix → run → confirm GREEN.** The test must assert on
   real behavior — not `assert true`, not a mock asserting only that the mock was called. A
   test that can't fail proves nothing; one left reverted breaks the build.

5. **Mechanical validation per file type** — use the deadly-loop's validation table (`*.sh`
   needs `bash -n` **and** a dry-run test; `*.js` → `node --check`; `*.yml` → `yamllint`;
   `*.py` → `py_compile`; etc.). Don't rationalize it away.

6. **Commit atomically**, then update `PLAN.md` → Progress in place. At L the coordinator
   commits each returned phase **serially** (no concurrent git index writes).

---

## Step 5 — Harden each phase with the deadly-loop (GATE)

After a phase is committed, **invoke `deadly-loop` on that phase's diff** — using Workflow
`parallel([...])` again to fan out Reviewer + Critic concurrently, coordinator synthesizing.
Iterate fix-waves to **zero NEW P0s**: correctness vs the plan, edge cases actually handled,
regressions, security on security-relevant phases, and full blast radius.

The deadly-loop's carry-forward discipline (verify prior fixes held, THEN hunt genuinely NEW
issues) + `PLAN.md`/handoff as authoritative state means Round 7 doesn't re-run Round 1.
Same soft-10 / hard-15 caps from Step 3 apply.

- **L:** one gate after **each** phase. Per-phase deadly-loops run **sequentially** from the
  coordinator — the coordinator invokes the deadly-loop once per phase, and each loop manages
  its own single-level Reviewer + Critic agents. Do **not** run per-phase deadly-loops
  concurrently: that would nest agent trees past depth-1 and bust the concurrency cap.
- **M:** one gate total, before merge, **only if** a hard-risk trigger applies; otherwise
  Step 4 verification is sufficient.
- **S:** skip.

**If a phase won't converge** (hits soft cap, or NEW-P0 trend stalls): revert this phase's
commits (it's atomic) and escalate to the owner with options — redesign / accept risk /
unblock. Never advance to the next phase, and never ship an unconverged phase on the
assumption it'll be fixed later.

---

## Step 6 — Wrap up

- **All tiers:** confirm the final result proves the **goal** (goal-backward), not just
  "all tasks done," and list any **owner actions** (deploys, secrets, migrations) explicitly
  — these never autonomy-bypass.
- **L (and M when it produced a release-worthy change):** version bump / changelog per the
  repo's own policy.
- **S / trivial M:** no release ceremony — the verified edit plus a one-line summary is the
  wrap-up.

---

## Hard safety boundaries (NEVER bypass, even autonomous)

Force-push, production deploy, force-delete, financial actions, secret rotation, and any
irreversible / production-data action **never** autonomy-bypass. If a phase needs one, STOP
and surface options to the owner. Never infer authorization from a prior message. Treat
unsure cases AS IF gated. These are enforced at command dispatch by anti-hall's always-on
guards (git-guard / command-guard / etc.) — not a bespoke per-feature sentinel. Swarm agents
inherit these guards; a background agent cannot bypass a gate the main thread couldn't.

---

## What this depends on

- **Plan mode** (Claude Code built-in) — `EnterPlanMode` for Steps 1-3, `ExitPlanMode` as
  the build-unlock gate. No code/edits before approval.
- **`Workflow` tool / Dynamic Workflows** (Claude Code built-in) — the swarm mechanism for
  the **L-only** Step 4 build fan-out and the Step 3/5 auditor `parallel([...])` stages.
  Main thread coordinates; concurrency capped at ~`min(16, cores-2)`. Determinism: no
  `Date.now()` / `Math.random()` / argless `new Date()`; pass seeds via `args`. Cost: many
  tokens — test on a small slice first. S/M don't use it.
- **`deadly-loop`** (same plugin) — the debate engine for Steps 3 & 5 (Reviewer + Critic per
  its `references/MODEL-POLICY.md`), the A3 branch/SHA verification preamble (Step 4.2), the
  validation table (Step 4.5), and the D1.5 fresh-evidence + vacuous-test convergence gate.
  **Required at L** (and at M only when a hard-risk trigger fires). This skill orchestrates
  it; it does not reimplement its prompts.
- **anti-hall guards** — already active in the repo; enforce the hard safety boundaries.
- **Optional, only if installed:** `superpowers:brainstorming` (Step 1); a graphify graph
  (query during blast-radius mapping instead of broad greps). Nice-to-haves; the skill works
  fully standalone without them.

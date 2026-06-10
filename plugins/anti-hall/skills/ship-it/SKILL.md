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

## Step 0 — Size the change (TWO phases: provisional → confirmed)

Tier-sizing is decided **twice**, because the initial prompt rarely reveals the true blast radius:

- **(a) PROVISIONAL tier — from the initial prompt.** Pick a *starting posture* (S/M/L)
  from the ask alone. This only sets how much exploration to do next, not the final rigor.
- **(b) CONFIRMED / REVISED tier — never final until a blast-radius glance.** The provisional
  tier is **always provisional** until you actually look at the touched area. The depth of the
  look scales, but the glance itself is **mandatory for every tier, including S**:
  - **S/M:** a ~30-second **sanity glance** *before locking the tier* — one graphify query (or
    a quick grep) on the area you're about to touch. The only question: *is this secretly
    bigger than the prompt implied?* If it fans out to extra callers, an auth path, a schema,
    or any hard-risk trigger, **upgrade** the tier. This is cheap by design — do **not** turn
    S into full Step-2 research; keep S lean. But an S is never locked sight-unseen.
  - **L:** the full Step-2 research + blast-radius map re-decides the tier **before plan mode
    locks in the rigor.** A deceptively-large "simple" ask (a one-liner touching an auth path
    or fanning out to 12 callers) gets **upgraded**; an over-estimate that turns out isolated
    gets **downgraded**.
  Reuse anti-hall's graphify-first discipline (query the graph before broad greps) to map
  blast radius cheaply.

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

## Step 1 — Brainstorm IN PLAN MODE (gate — hard interactively, SOFT under granted autonomy; L only)

**Enter plan mode now** via `EnterPlanMode`. Plan mode is **read-only for the repo**: you may
read, explore with bash, web-research, and ask the owner questions — but **nothing in the repo
is edited or built**. You DRAFT the plan in this mode and present it via `ExitPlanMode`; the
durable repo `PLAN.md` is written right after approval (see Step 2). No code is written until
the plan is approved.

- Surface the real intent, not the literal request: what problem, for whom, the success
  criterion, and what is explicitly **out of scope**.
- Ask clarifying questions **one at a time** (use `AskUserQuestion`), multiple-choice when
  possible. One good answer at a time forces real decisions; a dumped questionnaire doesn't.
- Output a short **intent note** (3-10 sentences): goal, constraints, 1-2 approaches with
  trade-offs, and a recommendation.

**Under granted autonomy (AFK / "full autonomy" / "build it"):** the gate is satisfied by
*forming and recording* the design — make the call yourself, write the intent note + chosen
approach into the plan, and proceed. Ask the owner ONLY for a genuine blocker the plan can't
resolve or a hard-safety decision — do NOT wait for design sign-off you were already told to
proceed without. Interactively (no autonomy granted), present the intent note and wait.

*(Optional: if `superpowers:brainstorming` is installed, use it — the gate is the point, not the tool.)*

---

## Step 2 — Capture the plan as ONE durable artifact (L only)

> **M:** plan mode optional — keep the same fields as task-list entries; skip the file.

**Draft the plan content while still in plan mode** (it's the body you present via
`ExitPlanMode`). The repo `PLAN.md` itself is **written as the first action right after
`ExitPlanMode` approval** — plan mode is read-only for the repo, so the file lands the moment
the gate clears, before any code. Write **one** file: `PLAN.md` in `.planning/` if that
convention exists, else the repo root. It carries the design through `/clear` and compaction.
This single file is the durable memory — **not** an artifact graph, not a file per phase.

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
the three concurrent TRIO seats:

- **Reviewer agent** (latest flagship Claude `model:"fable"`, max thinking): read `PLAN.md`,
  audit for narrow vision / missed blast radius, unsound phase decomposition or sequencing,
  schema/migration/rollback gaps, and assumptions stated as fact without evidence.
- **Auditor agent** (latest Opus `model:"opus"`, max thinking): divergent regression &
  coupling lens — hunt where the plan's phases couple wrongly, where a later phase regresses
  an earlier one, where the blast-radius map misses a dependent consumer.
- **Critic agent** (latest Codex if available, else divergent Opus, max reasoning): same
  target, different mental model, find blindspots.

All three run **concurrently** via a **BARRIER** `parallel([...])` — all finish before the
coordinator receives their reports. Spawn the Critic with `agentType` so the cross-model
Codex critic is preserved (canonical Codex form + availability fallback matrix in
`deadly-loop/references/MODEL-POLICY.md`):

```js
parallel([
  () => agent(reviewerBrief, { model: "fable", run_in_background: true, label: "reviewer" }),
  () => agent(auditorBrief,  { model: "opus",  run_in_background: true, label: "auditor" }),
  () => agent(criticBrief,   { agentType: "codex:codex-rescue", run_in_background: true, label: "critic" }),
])
```

Note: spawning all three as plain Claude agents would silently drop the cross-model Codex
critic (collapsing to the all-Opus fallback), and an omitted `model` inherits the
orchestrator's model — so set `model` EXPLICITLY on the Reviewer and Auditor and use
`agentType` for the Critic. The main thread **stays coordinator**: it synthesizes their
findings, dispatches fix-waves, and loops to re-debate.

**Loop fix-waves → re-debate until zero NEW P0s** (count NEW issues, not rediscovered ones;
the trend must fall to 0). Same deadly-loop caps: soft-10 / hard-15 rounds. If the trend
isn't falling well before soft-10, escalate to the owner (redesign scope / accept risk /
narrow).

**Convergence gate:** once the plan survives with zero NEW P0s, present it via `ExitPlanMode`.
`ExitPlanMode` is the single plan → build transition; the first post-approval action is
writing the durable `PLAN.md` (Step 2) — **do not write a line of feature code before that.**

**Who approves — interactive vs autonomous (this is a SOFT gate, not a hard stop):**
- **Interactive:** present the plan and wait for the owner's approval, as normal.
- **Autonomy ALREADY granted** (the owner said "AFK" / "full autonomy" / "build it" / "go
  autonomous" / approved this plan): **the deadly-loop convergence to zero NEW P0s IS the
  approval — self-approve and PROCEED to build. Do NOT re-stop for a "go" the owner already
  gave.** Record the plan in `PLAN.md` and continue. Stopping here for human sign-off you
  already have is the failure mode this rule exists to prevent (a converged, green-lit plan
  must not sit idle waiting on a redundant gate).
- The ONLY things that still stop an autonomous run are the **hard safety boundaries** below
  (destructive / irreversible / financial / secret / prod-deploy / force-push) and a
  **genuine ambiguity** the plan can't resolve — never the plan-approval gate itself once
  autonomy is granted. (Anti-hall convention: "AFK" = run autonomously; stop only at the
  destructive gate.)

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
  - Step 3 auditors (Reviewer + Auditor + Critic trio, disjoint lenses).
  - Step 4 phases in the same `parallel_group` (disjoint files, no dependency).
  - Step 5 per-phase deadly-loops (Reviewer + Auditor + Critic trio, same phase diff).
- **Caps:** ~`min(16, cores-2)` in-flight agents; 1000 total per run. **Cost: many tokens —
  test on a small slice first.** Determinism: no `Date.now()` / `Math.random()` / argless
  `new Date()` in the workflow script; pass seeds/timestamps via `args`.

> **Want this as a reusable `/ship-it` command?** A copyable Dynamic-Workflow template
> lives at `references/ship-it.workflow.js`. It is a **single-pass scaffold** showing the
> Step-4 build fan-out + the *shape* of one Step-5 Reviewer+Critic audit pass — it does NOT
> commit and does NOT run the full fix-wave→re-converge loop (the coordinator invokes the
> `deadly-loop` skill for that, and commits serially on the main thread). Plugins can't *ship* a workflow command
> (no `workflows` field in plugin.json; saving is a live-run action), so save the template to
> `.claude/workflows/ship-it.js` (project) or `~/.claude/workflows/ship-it.js` (user) — then
> invoke `/ship-it` with the plan passed via `args`. Plan mode (Steps 1-3) still runs first.

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
   first-hand evidence in this message** that it meets the phase's **acceptance criteria** —
   not just that code ran. Where acceptance is a command/test: run it, read the full output,
   check the exit code. "Should pass" / "looks correct" is not done.
   - **Acceptance is NOT only a runnable command.** When the agreed criterion is *fidelity to
     an artifact* — a UI matching an agreed design/mockup, output matching a spec, behavior
     matching a worked example — **a green test suite does NOT prove it** (behavior/logic
     tests don't look at pixels or compare to the mockup). Verify it the way it can actually
     be checked: open the agreed artifact (the design file / spec / checklist) and compare the
     real output to it, item by item, citing what you checked.
   - **Fidelity you CANNOT verify mechanically (visual/UX/design-match) is NOT "done" — it is
     "built, PENDING OWNER VERIFICATION."** Report it that way and surface it as a blocker on
     completion. **Never demote an unverified agreed-acceptance criterion to a post-hoc
     "follow-up" while calling the work done/shipped/merged** — that is the exact "false done"
     this rule prevents. If owner sign-off is the only way to confirm fidelity, the phase is
     not done until that sign-off.

3b. **The coordinator verifies delegated acceptance (rule L, applied here).** A build/swarm
   agent reporting "implemented per the spec / per the HTML / matches the design / done" is an
   **UNVERIFIED CLAIM**, not completion. Before marking the phase done, the coordinator checks
   the agent's actual output against the acceptance criteria with its **own** evidence (read
   the produced code/diff; compare to the agreed artifact). Never relay a subagent's
   self-reported "done" as the phase's completion — that is how a whole feature ships looking
   nothing like what was agreed.

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
`parallel([...])` again to fan out the Reviewer + Auditor + Critic trio concurrently, coordinator synthesizing.
Iterate fix-waves to **zero NEW P0s**: correctness vs the plan, edge cases actually handled,
regressions, security on security-relevant phases, and full blast radius.

The deadly-loop's carry-forward discipline (verify prior fixes held, THEN hunt genuinely NEW
issues) + `PLAN.md`/handoff as authoritative state means Round 7 doesn't re-run Round 1.
Same soft-10 / hard-15 caps from Step 3 apply.

- **L:** one gate after **each** phase. Per-phase deadly-loops run **sequentially** from the
  coordinator — the coordinator invokes the deadly-loop once per phase, and each loop manages
  its own single-level Reviewer + Auditor + Critic trio agents. Do **not** run per-phase deadly-loops
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

- **All tiers — goal-backward against the AGREED criteria.** Before reporting done/shipped,
  restate each **agreed acceptance criterion** (the goal/design/spec the owner actually agreed
  to) and cite the **first-hand evidence** it is met. "All tasks done" / "all tests pass" /
  "the build agents said it matches" is **NOT** acceptance — tests prove behavior, not that
  the result is what was agreed. Any criterion you could not verify first-hand (especially
  visual/UX/design fidelity) is reported as **"built, PENDING OWNER VERIFICATION,"** listed as
  an open item — **never folded into "done" with the gap hidden as a follow-up.** A truthful
  "done with these 2 items pending your review" beats a false "done."
- **A self-issued hedge IS "not done" (hard rule).** If you find yourself writing
  *"first-pass"*, *"not pixel-perfect yet"*, *"pending review"*, *"needs your eyes"*,
  *"review it in the build"*, or any caveat that the deliverable isn't confirmed against its
  agreed criterion — **that phrase hard-blocks both the "done" status and any auto-merge for
  that deliverable.** You cannot write a review-caveat and "merged/live" about the same item
  in the same breath; the caveat wins and the state is **"pending owner review — do not
  merge."** Your own doubt, written down, is a verification signal — honor it, don't override
  it with "tests pass."
- **List any owner actions** (deploys, secrets, migrations) explicitly — these never
  autonomy-bypass.
- **L (and M when it produced a release-worthy change):** version bump / changelog per the
  repo's own policy.
- **S / trivial M:** no release ceremony — the verified edit plus a one-line summary is the
  wrap-up.

---

## Autonomous mode (AFK / "full autonomy" / "build it")

When the owner has granted autonomy, **run the whole S/M/L flow to completion without
stopping for approvals you already have.** The two human gates in this skill — the brainstorm
gate (Step 1) and the plan-approval gate (Step 3 `ExitPlanMode`) — are **SOFT**: under
granted autonomy they are satisfied by *forming/recording the design* and *converging the
plan via the deadly-loop to zero NEW P0s*, then **proceeding straight into the build**. Do
NOT re-stop at `ExitPlanMode` for a "go" already given — a converged, green-lit plan sitting
idle waiting on a redundant gate is the #1 autonomy failure (it can waste hours/overnight).

Stop an autonomous run ONLY for: (a) a **hard safety boundary** below, or (b) a **genuine
ambiguity / missing input** the plan cannot resolve (a real blocker, not design preference).
Otherwise: plan → harden → build → per-phase harden → ship, continuously. Stream status to a
durable file (e.g. `.planning/AUTONOMY-STATUS.md`) so the owner can follow; silence ≠ stop.
Re-read each granted instruction literally: "build it / merge / full autonomy" means *do it*,
not *plan it and wait*.

**Autonomy does NOT lower the acceptance bar (Step 6).** Running hands-off lets you skip the
approval *gate* — it does NOT let you call something "done/shipped" you have not verified
against the agreed acceptance criteria. A criterion you cannot verify first-hand without the
owner (visual/UX/design fidelity, "looks like the mockup") is reported in `AUTONOMY-STATUS.md`
as **"built, PENDING OWNER VERIFICATION,"** an explicit open item — never as "done," and
never silently relegated to a follow-up. Autonomous "done" must be *truthful* done, or it is
labelled pending. Reporting a green test suite as if it proved design fidelity is the "false
done" failure this protocol forbids. **And a self-issued hedge hard-blocks the AUTO-MERGE
too:** if your status note carries any "first-pass / pending review / not pixel-perfect"
caveat about a deliverable, that deliverable does NOT auto-merge under autonomy — it parks in
`AUTONOMY-STATUS.md` as "pending owner review, not merged." Never auto-merge something you
yourself flagged as unconfirmed.

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
- **`deadly-loop`** (same plugin) — the debate engine for Steps 3 & 5 (Reviewer + Auditor + Critic trio per
  its `references/MODEL-POLICY.md`), the A3 branch/SHA verification preamble (Step 4.2), the
  validation table (Step 4.5), and the D1.5 fresh-evidence + vacuous-test convergence gate.
  **Required at L** (and at M only when a hard-risk trigger fires). This skill orchestrates
  it; it does not reimplement its prompts.
- **anti-hall guards** — already active in the repo; enforce the hard safety boundaries.
- **Optional, only if installed:** `superpowers:brainstorming` (Step 1); a graphify graph
  (query during blast-radius mapping instead of broad greps). Nice-to-haves; the skill works
  fully standalone without them.

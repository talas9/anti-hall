---
name: deadly-loop-multi
description: Run a DOUBLE / TRIPLE / QUADRUPLE deadly loop — the deadly-loop TRIO (Sonnet 5 Reviewer + Opus Auditor + Codex Critic) multiplied N× in parallel, auditing a target (whole repo, a diff, or named files) with diversified lenses, then dedup + synthesize, optionally fix-wave and re-converge. Use when the user says "double deadly loop", "triple deadly loop", "quadruple deadly loop", "deep multi-agent review", "have multiple flagship + codex agents review everything", or wants a heavier review than the standard 1× deadly-loop. Multiplier — double=2× the trio (6 agents), triple=3× (9), quadruple=4× (12).
---

# Multi Deadly Loop

A scaled-up [`deadly-loop`](../deadly-loop/SKILL.md): instead of 1× the
Reviewer + Auditor + Critic TRIO, run **N× the trio in parallel** with *different
lenses*, then synthesize. Catches more because diverse perspectives find
non-overlapping problems.

| Phrase | Multiplier | Reviewers (Sonnet 5) | Auditors (Opus) | Critics (Codex) | Total agents |
|--------|-----------|-------------------|-----------------|-----------------|--------------|
| **double deadly loop** | 2× | 2 | 2 | 2 | **6** |
| **triple deadly loop** | 3× | 3 | 3 | 3 | **9** |
| **quadruple deadly loop** | 4× | 4 | 4 | 4 | **12** |

> This is **token-heavy** (each agent reads the target). It is opt-in — only run it when
> the user explicitly asks. State the agent count before launching.

## Choosing the multiplier (by complexity × sensitivity)

The user may name the tier explicitly ("triple deadly loop"). If they don't, **auto-select**
by the job's complexity and blast-radius/sensitivity — pick the higher tier when in doubt:

| Job profile | Tier |
|-------------|------|
| Small/localized change, low blast radius, reversible | **double** (2× trio = 6) |
| Multi-file feature, cross-module, moderate risk | **triple** (3× trio = 9) |
| Security-sensitive (auth/signing/redaction/prompt-injection), schema/prod-data, cross-repo, release, or "audit everything" | **quadruple** (4× trio = 12) |

The point of fixing the agent count up front: run ONE bounded debate among exactly that many
agents and converge on a single consolidated answer — not an open-ended loop.

## Roster — N× the TRIO, split in thirds (see [MODEL-POLICY.md](../MODEL-POLICY.md))

The 3N auditors are split **exactly in thirds** — one third per trio seat:

- **N Reviewers = Sonnet 5 (`model:"sonnet"`), at effort `xhigh`** — correctness /
  architecture lens. *If Fable returns to general availability, reconsider this seat for
  the flagship tier.*
- **N Auditors = the latest Opus (`model:"opus"`), at full reasoning depth (effort `high`)** — divergent
  regression & coupling lens (a different Claude generation, orthogonal lens).
- **N Critics = the latest OpenAI Codex** when available — a genuinely different model
  finds different bugs. **Check availability once** via the OS-agnostic Node probe in
  [MODEL-POLICY.md](../MODEL-POLICY.md) (or the codex companion's status / `/codex:setup`).
  Walk the availability fallback matrix there: if Sonnet 5 is unavailable, the Reviewer
  third falls back to Opus; if Codex is missing or unauthenticated, substitute Opus with a
  divergent adversarial persona for the Critic third. Floor for every seat is Opus. Never
  silently drop to fewer agents — always run the full 3N, maximally cross-model.

> Always say "the latest flagship" / "the latest Opus" / "the latest Codex" — never pin a
> version number here, so this skill keeps working as newer models ship. (MODEL-POLICY
> follows the same "resolve latest at runtime; version names are examples, not pins" rule.)

Spawn mechanics (canonical forms + availability matrix live in [MODEL-POLICY.md](../MODEL-POLICY.md)):
- Reviewer (Sonnet 5): `Agent({ description: "<lens> Reviewer", subagent_type: "general-purpose", model: "sonnet", effort: "xhigh", run_in_background: true, prompt: <lens brief> })`
- Auditor (Opus): `Agent({ description: "<lens> Auditor", subagent_type: "general-purpose", model: "opus", run_in_background: true, prompt: <lens brief> })`
- Critic (Codex): `Agent({ description: "<lens> Critic", subagent_type: "codex:codex-rescue", run_in_background: true, prompt: "--background --fresh <lens brief>" })`

## Orchestrate as a SWARM (Dynamic Workflows), not hand-rolled calls

Run this as a real swarm using the flagship multi-agent / Dynamic-Workflow primitives.
Prefer the **Workflow** tool: author a script with a **parallel fan-out stage** (the 3N
diversified auditors) feeding a **reconcile + validate synthesis stage** — deterministic
fan-out, a single shared concurrency cap, and one consolidated result. This is the same
`deadly-loop.workflow.js` swarm with `multiplier > 1` (see the deadly-loop "Swarm mode"
section). The main thread stays a coordinator (orchestration discipline): it dispatches the
swarm, keeps itself free, and synthesizes — it does not do the auditing itself.

**Capacity math (the DISPATCH wave):** respect the concurrency cap
(~`min(16, cores-2)` — this repo's own working assumption, not an Anthropic-documented
formula; official docs only guarantee "up to 16 concurrent agents, fewer on machines with
limited CPU cores," no disclosed subtraction constant, see `docs/KB-token-usage-models.md`
§5/§9) AND the swarm-guard spawn cap (≤ 20 spawns / 60 s). At quadruple
the dispatch is **12 auditors** (4 Reviewers + 4 Auditors + 4 Critics) — 12 ≤ `min(16,
cores-2)` on an 8-core+ host and 12 ≤ 20/60 s, so the whole trio fan-out fits in ONE
wave (treat the "fits in one wave" claim as a working estimate, not a guarantee, per the
caveat above). **Retry arithmetic:** the one-retry-per-seat rule can add up to 12 more spawns in
the same 60 s window (12 + 12 = 24 > the 20-cap) — but that is *quadruple's* own
seat count. Triple's worst case is 9 + 9 = 18, which fits under the 20-cap in one
wave, so it needs no special-casing. At multiplier **≥ quadruple, retries
are SEQUENTIAL after the wave settles** (or accept the documented +1-entry
blocked-retry cost). **Wave children** (the fix-wave executors, if you fix-and-reconverge)
land in a LATER 60 s window than the audit dispatch, so they do not stack against the
audit spawns — state this explicitly when you dispatch.

## Protocol

1. **Scope the target.** Whole repo → inventory the files (e.g. `git ls-files`). A diff →
   `git diff`. Named files → just those. Tell each agent EXACTLY what to read.
2. **Assign diverse lenses** — never give 3N agents the same brief; spread them across the
   table below so coverage is non-overlapping. With N=2 use lenses 1–2 per column; N=3 use
   1–3; N=4 use 1–4.

   | # | Reviewer (Sonnet 5) lens | Auditor (Opus) lens | Critic (Codex) lens |
   |---|------------------------|---------------------|---------------------|
   | 1 | correctness / logic bugs | regressions in dependent unchanged code | adversarial "try to break it" bug hunt |
   | 2 | docs-vs-code accuracy + consistency | cross-module / cross-PR coupling drift | verify every doc/CHANGELOG claim against code |
   | 3 | security + fail-open + input handling | fix-vs-fix regressions (did a fix undo a fix?) | injection / ReDoS / path / resource edge cases |
   | 4 | cross-platform + API/contract correctness | merge-order cross-reference breaks | portability + concurrency / race conditions |

   Every brief ends with this mandatory footer:
   - *severity (P0/P1/P2/EASY-WIN), file:line, evidence, fix; verify against actual code —
     no speculation; no rewrites; also list 3–5 easy wins.* (Keep these 3 heat tiers + easy
     wins and the no-speculation / no-rewrites rules — they are non-negotiable.)
   - *DIG DEEP: read the real implementation end-to-end, trace control/data flow across
     files, follow every branch and error path; never judge from names/signatures/diff hunks
     alone — cite the `file:line` ranges you actually read.*
   - *SIMULATE EDGE CASES: enumerate boundary/empty/malformed/huge/unicode/concurrent/
     missing-file/permission-denied/clock-skew/truncated/injection-shaped inputs for each
     changed unit and mentally execute (or write a quick harness); report predicted outcomes
     and flag any wrong/unsafe/unbounded/fail-CLOSED result.*
3. **Launch all 3N agents in parallel** (background) — see the capacity math above (12 fits
   one wave at quadruple; retries sequential at ≥ quadruple). Keep the main thread free; do not
   block. (Codex `--fresh` avoids a resume prompt.)
4. **Collect.** As each of the 3N agents reports, gather all findings. Do not present
   them raw — the deliverable is ONE reconciled report, not 3N dumps.
5. **Reconcile + validate (the core value).** Produce a single consolidated report:
   - **Dedup** by file:line + claim.
   - **Validate each finding against the actual code yourself** before including it —
     agreement between agents raises confidence, but a finding is only "confirmed" if the
     evidence holds when you check it (anti-speculation; agents can be wrong too).
   - **Cross-validate:** tag each finding with how many of the 3N agents raised it
     (≥2 = corroborated; 1 = include only if you verified it).
   - **Reconcile conflicts:** when agents disagree (one flags a bug, another says it's
     fine), inspect the code and rule — state the resolution and why.
   - **Group** the result into **confirmed issues** (severity P0/P1/P2) and **easy wins**,
     each with file:line, the validated evidence, the fix, and which agents raised it.
6. **(Optional) fix-wave + reconverge.** If the user wants fixes, dispatch fix agents
   (one per cluster, worktree-isolated if they touch the same files), then re-run a
   lighter loop to confirm zero NEW P0s or P1s — the convergence rule from the base deadly-loop.
   The reconverge agents are given the PRIOR round's findings + the exact fixes applied,
   and must **verify-then-hunt-new (carry-forward)**: first confirm each prior finding's fix
   actually resolved it without regression, then hunt genuinely NEW issues — distinguishing
   NEW from REDISCOVERED, consistent with the base deadly-loop.
   The same iteration caps apply to this reconverge loop: **soft cap = 10 rounds** (stop and
   checkpoint with the user via AskUserQuestion — continue / stop / change scope) and
   **hard cap = 15 rounds** (force-stop unconditionally and report, even if not converged).
   See the base deadly-loop "Iteration caps (soft 10 / hard 15)" rule.
7. **Report** the deduped issue list + easy wins, with the agent that raised each.

## Notes
- Respect the swarm concurrency cap (~min(16, cores-2) — working assumption, not
  Anthropic-documented; see the caveat above) AND the swarm-guard spawn cap
  (≤ 20 / 60 s); quadruple = 12 agents fits one wave (12 ≤ min(16, cores-2) on 8+ cores,
  12 ≤ 20/60 s), but don't stack it with other large fan-outs, and keep retries sequential
  at ≥ quadruple so 12 + retries doesn't blow the 20-cap (triple's 9+9=18 fits in one wave).
- The phase-tracker hook will surface "orchestrating · N agents" on the statusline while
  this runs — a free progress signal.

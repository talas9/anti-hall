---
name: deadly-loop-multi
description: Run a DOUBLE / TRIPLE / QUADRUPLE deadly loop — N parallel Opus reviewers + N parallel Codex critics auditing a target (whole repo, a diff, or named files) with diversified lenses, then dedup + synthesize, optionally fix-wave and re-converge. Use when the user says "double deadly loop", "triple deadly loop", "quadruple deadly loop", "deep multi-agent review", "have 2 opus and 2 codex review everything", or wants a heavier review than the standard 1+1 deadly-loop. Multiplier — double=2, triple=3, quadruple=4 reviewer+critic PAIRS.
---

# Multi Deadly Loop

A scaled-up [`deadly-loop`](../deadly-loop/SKILL.md): instead of 1 Reviewer + 1 Critic,
run **N of each in parallel** with *different lenses*, then synthesize. Catches more
because diverse perspectives find non-overlapping problems.

| Phrase | Reviewers (Opus) | Critics (Codex) | Total agents |
|--------|------------------|-----------------|--------------|
| **double deadly loop** | 2 | 2 | 4 |
| **triple deadly loop** | 3 | 3 | 6 |
| **quadruple deadly loop** | 4 | 4 | 8 |

> This is **token-heavy** (each agent reads the target). It is opt-in — only run it when
> the user explicitly asks. State the agent count before launching.

## Choosing the multiplier (by complexity × sensitivity)

The user may name the tier explicitly ("triple deadly loop"). If they don't, **auto-select**
by the job's complexity and blast-radius/sensitivity — pick the higher tier when in doubt:

| Job profile | Tier |
|-------------|------|
| Small/localized change, low blast radius, reversible | **double** (2+2) |
| Multi-file feature, cross-module, moderate risk | **triple** (3+3) |
| Security-sensitive (auth/signing/redaction/prompt-injection), schema/prod-data, cross-repo, release, or "audit everything" | **quadruple** (4+4) |

The point of fixing the agent count up front: run ONE bounded debate among exactly that many
agents and converge on a single consolidated answer — not an open-ended loop.

## Roster — always half Codex, half Opus (see [MODEL-POLICY.md](../MODEL-POLICY.md))

The 2N auditors are split **exactly in half**:

- **N Reviewers = the latest Opus, at max thinking.**
- **N Critics = the latest OpenAI Codex** when available — a genuinely different model
  finds different bugs. **Check availability once** (`command -v codex`, or the codex
  companion's status / `/codex:setup`). **If Codex is missing or unauthenticated,
  substitute the latest Opus** with a divergent adversarial persona so you still launch N
  critics. Never silently drop to fewer agents — always run the full 2N, half cross-model
  when possible.

> Always say "the latest Opus" / "the latest Codex" — never pin a version number here, so
> this skill keeps working as newer models ship. (The MODEL-POLICY follows the same rule.)

Spawn mechanics:
- Opus: `Agent({ subagent_type: "general-purpose", model: "opus", run_in_background: true, prompt: <lens brief> })`
- Codex: `Agent({ subagent_type: "codex:codex-rescue", run_in_background: true, prompt: "--background --fresh <lens brief>" })`

## Orchestrate as a SWARM (Dynamic Workflows), not hand-rolled calls

Run this as a real swarm using the latest Opus's multi-agent / Dynamic-Workflow
primitives — see
[docs/opus-4-8-swarm.md](../../../../docs/opus-4-8-swarm.md) and KB §11 (Dynamic
Workflows / Agent Teams). Prefer the **Workflow** tool: author a script with a **parallel
fan-out stage** (the 2N diversified auditors) feeding a **reconcile + validate synthesis
stage** — deterministic fan-out, a single shared concurrency cap, and one consolidated
result. The main thread stays a coordinator (orchestration discipline): it dispatches the
swarm, keeps itself free, and synthesizes — it does not do the auditing itself. Respect the
concurrency cap (~min(16, cores-2)); quadruple = 8 auditors fits in one wave.

## Protocol

1. **Scope the target.** Whole repo → inventory the files (e.g. `git ls-files`). A diff →
   `git diff`. Named files → just those. Tell each agent EXACTLY what to read.
2. **Assign diverse lenses** — never give 2N agents the same brief; spread them across the
   table below so coverage is non-overlapping. With N=2 use lenses 1–2 per side; N=3 use
   1–3; N=4 use 1–4.

   | # | Reviewer (Opus) lens | Critic (Codex) lens |
   |---|----------------------|---------------------|
   | 1 | correctness / logic bugs | adversarial "try to break it" bug hunt |
   | 2 | docs-vs-code accuracy + consistency | verify every doc/CHANGELOG claim against code |
   | 3 | security + fail-open + input handling | injection / ReDoS / path / resource edge cases |
   | 4 | cross-platform + API/contract correctness | portability + concurrency / race conditions |

   Every brief ends with: *severity (P0/P1/P2/EASY-WIN), file:line, evidence, fix; verify
   against actual code — no speculation; no rewrites; also list 3–5 easy wins.*
3. **Launch all 2N agents in parallel** (background). Keep the main thread free; do not
   block. (Codex `--fresh` avoids a resume prompt.)
4. **Collect.** As each of the 2N agents reports, gather all findings. Do not present
   them raw — the deliverable is ONE reconciled report, not 2N dumps.
5. **Reconcile + validate (the core value).** Produce a single consolidated report:
   - **Dedup** by file:line + claim.
   - **Validate each finding against the actual code yourself** before including it —
     agreement between agents raises confidence, but a finding is only "confirmed" if the
     evidence holds when you check it (anti-speculation; agents can be wrong too).
   - **Cross-validate:** tag each finding with how many of the 2N agents raised it
     (≥2 = corroborated; 1 = include only if you verified it).
   - **Reconcile conflicts:** when agents disagree (one flags a bug, another says it's
     fine), inspect the code and rule — state the resolution and why.
   - **Group** the result into **confirmed issues** (severity P0/P1/P2) and **easy wins**,
     each with file:line, the validated evidence, the fix, and which agents raised it.
6. **(Optional) fix-wave + reconverge.** If the user wants fixes, dispatch fix agents
   (one per cluster, worktree-isolated if they touch the same files), then re-run a
   lighter loop to confirm zero NEW P0s — the convergence rule from the base deadly-loop.
7. **Report** the deduped issue list + easy wins, with the agent that raised each.

## Notes
- Respect the swarm concurrency cap (~min(16, cores-2)); quadruple = 8 agents is fine, but
  don't stack it with other large fan-outs.
- The phase-tracker hook will surface "orchestrating · N agents" on the statusline while
  this runs — a free progress signal.

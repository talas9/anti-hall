---
name: anti-hall-ship-it
description: Codex-native ship-it workflow. Use to plan, implement, verify, and harden a change with rigor scaled to blast radius. Replaces anti-hall-feature-launch (retired 2026-07-05, matching the Claude-side ship-it/feature-launch consolidation from v0.27.0).
---

# anti-hall ship-it for Codex

This is the Codex-native equivalent of the Claude `ship-it` workflow. Do not run `ship-it.workflow.js`; Codex does not expose the Claude Workflow runtime.

## 1. Size the change

| Tier | Trigger | Path |
| --- | --- | --- |
| S | one file, clear fix, no hard-risk trigger | implement, verify, report |
| M | 2-5 files, modest design choices, no hard-risk trigger | short plan, implement, verify |
| L | more than 5 files, multi-phase, or any hard-risk trigger | durable plan, deadly-loop plan review, phased build, per-phase verification |

Hard-risk triggers: auth/security, schema/migration, production data, shell scripts, CI/workflow YAML, cross-repo work, LLM prompts.

## 2. Plan

For L work, write `PLAN.md` at the repo root (GSD's `.planning/` convention is discontinued as of 2026-07-03 — no longer written to or read from). Include:

- intent
- decisions and trade-offs
- blast radius
- phases with exact files, read-first paths, steps, edge cases, and acceptance checks
- goal coverage: map every clause of the intent/success-criterion to the specific phase(s)
  whose acceptance check actually proves it, or mark the clause explicitly "descoped." A
  clause with no phase acceptance test behind it, present only in prose, is a plan hole —
  fill it or descope it here, on paper.
- progress checklist
- owner/manual actions

## 3. Harden the plan

Run `anti-hall-deadly-loop` against the plan before code for L work. Debate/validation uses `gpt-5.5`. Convergence (LOCK) requires **zero NEW P0 and P1 findings** — a single confirmed P1 blocks LOCK the same as a P0.

For L-tier work, once LOCK is reached, append any P2-severity findings from the debate to `.anti-hall/ship-it/<slug>/decisions.md` (plain-text append, one entry per finding) instead of dropping them.

## 4. Build and verify

Model routing:

- implementation: `gpt-5.4`
- planning/validation/debate: `gpt-5.5`
- mechanical command execution: `gpt-5.4-mini` (default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only

> Note: the Claude-side ship-it workflow adds Codex-primary/Sonnet-5-failover build-seat routing plus a cross-model no-self-review rule — that's a `ship-it.workflow.js`-specific mechanism (Claude Dynamic Workflows only) and does not apply here. Codex-native ship-it already IS the Codex-primary implementer by construction, so there is no failover-fallback self-review edge case to guard against on this port.

For each phase:

1. Read the relevant plan section.
2. Make only scoped edits.
3. Run the phase acceptance check.
4. Record evidence in the plan progress section.
5. For risky changes, run `anti-hall-deadly-loop` after the phase.

Claim done only after fresh verification output from this turn.

## 5. Resumable state (L-tier only)

For L-tier work, hand-maintain `.anti-hall/ship-it/<slug>/STATE.json` across turns/sessions:

- `plan_hash`: a hash of `PLAN.md`'s content, used only to detect drift on resume — no specific hashing mechanism is prescribed, since Codex has no coordinator process to own one.
- per-phase entries: `{label, status: "pending"|"running"|"done"|"failed", gate: "locked"|"not-run"}`
- `escalations`: counter, see the escalation cap below.

`gate` is set to `"locked"` only immediately after that phase's `anti-hall-deadly-loop` run
(§4 step 5, or §3's plan-level loop before build starts) actually converges — never set by
the phase-build step itself, and never inferred from `status: "done"` alone.
`status` is self-written by whichever agent just ran the phase — the exact self-report this
repo's own false-completion research says cannot be trusted on its own — while `gate` is the
independent record that hardening actually ran and converged. **A `status: "done"` phase is
not resumable as done on `status` alone: a phase with `gate: "not-run"` (or `gate` missing)
must be treated as unfinished — re-run the deadly-loop for that phase before resuming past
it, even if `status` already says `"done"`.**

Codex builds sequentially, one phase at a time, so there is no concurrent-agent staleness problem to track — no heartbeat mechanism is needed here.

On resume, read `STATE.json` alongside `PLAN.md`, recompute the plan hash, warn if it drifted, and continue from the first phase that is `pending`/`failed` by `status`, or has `gate: "not-run"` despite `status: "done"` — never restart from scratch, and never trust a `"done"` status whose gate was never locked.

## 6. Escalation cap

If a phase's fix requires re-planning (not just another fix-wave), that's an escalation: increment `STATE.json`'s `escalations`. At 2, stop and surface options to the human/owner rather than allow a 3rd re-plan loop.

## 7. Legacy state migration

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`docs/KB-codex-platform-hooks-plugins.md`). Resolve the plugin root from this
SKILL.md's own file path (which Codex shows you when it selects the skill)
before running the command below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

`$ANTI_HALL_ROOT/scripts/migrate-state.js` is a pure-Node script with no Claude-specific dependencies — it works identically from a Codex session: `node "$ANTI_HALL_ROOT/scripts/migrate-state.js"`. Use it to fold legacy root `.anti-hall-progress.md`/`.anti-hall-history.md` files into the new dated `.anti-hall/` structure.

## 8. Wrap-up: summarize and index

At the end of a ship-it run (L, and M when release-worthy):

1. Write a session-history entry to `.anti-hall/history/<date>/<session-id>.md` (same dated/session-id convention used elsewhere — plain files on disk, not Claude-specific).
2. For L tier, write `.anti-hall/ship-it/<slug>/SUMMARY.md`.
3. Run `graphify update .` if graphify is available in this environment; otherwise note it as a follow-up action.

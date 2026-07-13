---
name: anti-hall-deadly-loop
description: Codex-native equivalent of anti-hall deadly-loop. Use to harden risky changes with repeated adversarial review and fix waves until no new P0/P1 blockers remain.
---

# anti-hall deadly-loop for Codex

This is the Codex-native protocol. Do not run the Claude `deadly-loop.workflow.js`; Codex does not expose that Workflow runtime.

Use for:

- security/auth/signing/redaction/prompt-injection work
- schema/migration/production-data changes
- shell scripts or CI/workflow YAML
- cross-repo or merge-order-sensitive work
- substantial code changes where silent failure is expensive

Round structure:

1. Snapshot branch/SHA and changed files.
2. Create or update `docs/<date>-<topic>-session-handoff.md` with current state.
3. Run three independent review lenses:
   - Reviewer: correctness/architecture, `gpt-5.6-sol`
   - Auditor: regression/coupling, `gpt-5.6-sol`
   - Critic: adversarial failure-mode hunter, `gpt-5.6-sol`
4. Synthesize findings by evidence, not by vote alone.
5. Fix confirmed P0/P1 issues in scoped waves.
6. Re-run the full three-lens round after any code change.
7. Stop only when a non-degraded round has zero unadjudicated P0/P1 blockers and no new P0s or P1s.
8. On convergence, write an advisory audit record to
   `~/.anti-hall/approvals/<repo>@<HEAD-sha>.json` — fields: `repo`, `sha`,
   `timestamp`, `roundTrend` (NEW confirmed P0/P1 count per round), `seatVerdicts`,
   and `"proof": false`. **This file is an ADVISORY AUDIT RECORD, never proof of
   correctness and never an authorization token.** Deadly-loop is agent-followed
   guidance, not a hook enforced by the harness — an agent that fakes convergence
   can just as easily fake this file. Any reader that consumes it (a CI push gate,
   DevSwarm's merge gate, etc.) MUST treat `"proof": false` as load-bearing and
   enforce its own real gating rather than trusting this record as sufficient
   evidence on its own.

Each review must cite file/line evidence and distinguish:

- `NEW`: newly found issue
- `REDISCOVERED`: known issue still present
- `RESOLVED`: previous issue fixed with evidence
- `REFUTED`: reported issue disproven with evidence

Codex model rule: debate and validation seats use `gpt-5.6-sol`. Do not use mini models for debate roles.

## Same-model disclosure

This roster is three `gpt-5.6-sol` seats — same-model, not the canonical
cross-model TRIO. `MODEL-POLICY.md`'s availability fallback matrix (Claude
side) lists 3-of-one-family as the explicit **worst-case last-resort** row,
with the stated reason "same-model agents share systematic blind spots":

| Roster | Status |
| --- | --- |
| Claude-side TRIO (Fable-or-Sonnet-5 Reviewer + Opus Auditor + Codex Critic) | intended default |
| This Codex-native roster (3× `gpt-5.6-sol`) | degraded / last-resort — Codex has no Workflow runtime to fan a round out across model families on its own |

Treat this file's all-`gpt-5.6-sol` roster as the Codex-only floor, not the goal.
For L-tier hard-risk work, use the opt-in escalation below to recover one
cross-model seat.

## Optional cross-model escalation (L-tier hard-risk work only)

For L-tier hard-risk work only — security/auth/signing/redaction/prompt-injection,
schema/migration/production-data, shell scripts, CI/workflow YAML — optionally
shell out to the `claude` CLI for ONE seat (Reviewer is the recommended pick)
to get a genuinely different model's perspective:

| Aspect | Detail |
| --- | --- |
| Requirement | `claude` CLI installed and on `PATH` (`command -v claude` / `where claude`) |
| Invocation | `claude -p "<REVIEWER_PROMPT>"` — one-shot, non-interactive (`-p`/`--print`) |
| Scope | ONE seat only (Reviewer recommended); Auditor and Critic stay on `gpt-5.6-sol` |
| Requirement level | OPT-IN, not a hard requirement — if `claude` is unavailable, stay on the plain 3×`gpt-5.6-sol` roster and note the degradation |

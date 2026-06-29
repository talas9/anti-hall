---
name: anti-hall-deadly-loop
description: Codex-native equivalent of anti-hall deadly-loop. Use to harden risky changes with repeated adversarial review and fix waves until no new P0 blockers remain.
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
   - Reviewer: correctness/architecture, `gpt-5.5`
   - Auditor: regression/coupling, `gpt-5.5`
   - Critic: adversarial failure-mode hunter, `gpt-5.5`
4. Synthesize findings by evidence, not by vote alone.
5. Fix confirmed P0/P1 issues in scoped waves.
6. Re-run the full three-lens round after any code change.
7. Stop only when a non-degraded round has zero unadjudicated P0 blockers and no new P0s.

Each review must cite file/line evidence and distinguish:

- `NEW`: newly found issue
- `REDISCOVERED`: known issue still present
- `RESOLVED`: previous issue fixed with evidence
- `REFUTED`: reported issue disproven with evidence

Codex model rule: debate and validation seats use `gpt-5.5`. Do not use mini models for debate roles.

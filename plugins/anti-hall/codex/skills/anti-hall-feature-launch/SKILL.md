---
name: anti-hall-feature-launch
description: Codex-native feature launch protocol. Use when starting or launching a non-trivial feature, replacing the old GSD/Claude feature-launch path with graphify, OMX/Codex planning, gpt-5.5 debate gates, phased execution, and verification.
---

# anti-hall feature-launch for Codex

This is the Codex-native replacement for the old Claude/GSD feature launch skill. Do not invoke GSD commands; GSD was removed from active Codex config.

## Use when

Use for non-trivial feature work with any of:

- multi-file or multi-repo changes
- schema, migration, production data, auth, security, CI, shell scripts, or LLM prompt changes
- owner continues on `main` while the feature is built
- design ambiguity or launch go/no-go risk

Do not use for single-file bug fixes or trivial UI copy changes.

## Model routing

- Interview, planning, architecture, launch gate, debate: `gpt-5.5`
- Implementation from settled plan: `gpt-5.4`
- Repo lookup / command runner: `gpt-5.3-codex-spark` or `gpt-5.4-mini`
- Debate roles must use `gpt-5.5`.

## Phase A — initialize

1. Query/update project graph first:

```bash
graphify . --update --obsidian
```

2. Create planning artifacts under `.planning/`:

- `.planning/FEATURE-LAUNCH.md` — goal, scope, non-goals, risks, acceptance checks
- `.planning/CONVERSATION-CONTEXT.md` — user decisions, constraints, branch/worktree rules, manual gates
- `.planning/SKILLS_PROTOCOL.md` — required skills, model routing, entry/exit gates

3. If parallel work is needed, use Codex/OMX worktrees (`.codex/worktrees/<name>`) rather than Claude `.claude/worktrees`.

## Phase B — plan gate

For each feature phase, write a plan section with:

- exact files/components expected to change
- root-cause or design evidence already gathered
- implementation steps
- acceptance checks
- rollback/manual steps

For large/risky phases, run a two-seat `gpt-5.5` debate before implementation:

- Reviewer: executable-plan correctness, missing files, invalid commands, test gaps
- Critic: runtime/regression/security/scale failure modes

Any P0 blocks execution. P1 items must be tracked in the plan before execution continues.

## Phase C — execute and verify

For each phase:

1. Keep implementation scoped to the plan.
2. Run targeted verification first, then broader checks only when needed.
3. Record evidence in `.planning/FEATURE-LAUNCH.md`.
4. For risky phases, run a post-execution `gpt-5.5` Reviewer/Critic debate.
5. Update graphify with `--obsidian` after significant changes.

## Launch gate

Before calling the feature launched, verify:

- acceptance checks passed in the current turn
- no unresolved P0/P1 launch blockers remain
- migration/manual/deploy steps are explicit
- graphify/Obsidian updates are done
- user-visible caveats are listed as open items, not hidden inside “done”

If any launch criterion cannot be mechanically verified, report it as `PENDING OWNER VERIFICATION`.

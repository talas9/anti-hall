# SKILLS_PROTOCOL.md (template)

Copy this to `.planning/SKILLS_PROTOCOL.md` and customize per project. It is the
**authoritative gate matrix** for the feature: per-phase entry/exit gates, the
two deadly-loop debate gates, the hard gates that NEVER autonomy-bypass,
stack-specific skill auto-engagement, and worktree discipline. Point the repo's
`CLAUDE.md` at this file.

---

## 1. Worktree assignments

NEVER edit a repo's primary checkout while a worktree exists for it. Record one
row per repo touched by this feature.

| Repo | Worktree path | Branch | Base branch | Merge target |
|---|---|---|---|---|
| <repo> | `<workspace>/.worktrees/<repo>-<slug>` | `feat/<slug>` | `<base>` | `<target>` |

Single-repo or no concurrent owner work → skip worktrees, use a normal feature
branch and delete this section.

## 2. Per-phase gates

For each phase, define what must be true to ENTER and to EXIT. Exit gates are
verification, not assertion — paste the command output that proves them.

| Phase | Entry gate | Exit gate (with evidence) |
|---|---|---|
| Spec | requirements clarified, ambiguity scored | SPEC.md reviewed |
| Plan | spec approved | PLAN.md + **post-PLAN deadly-loop gate passed** |
| Execute | plan approved | tests green (paste output), lint clean |
| Verify | execution complete | **post-EXECUTION deadly-loop gate passed**, UAT met |

## 3. Deadly-loop debate gates (MANDATORY — two of them)

Both gates run the parallel Reviewer + Critic debate and loop fix-waves until
convergence (zero NEW P0/P1 blockers). See `references/DEBATE-PROMPTS.md` and
`references/DEBATE-SYNTHESIS-RULES.md`.

- **Post-PLAN gate:** audit the PLAN before any code is written.
- **Post-EXECUTION gate:** audit the diff before merge/ship.

Neither gate may be skipped by autonomous execution.

## 4. Hard gates that NEVER autonomy-bypass

List actions that ALWAYS require explicit human approval regardless of autonomy
level (see `references/HARD-GATES-CHECKLIST.md` for the per-stack inventory).
Examples to customize:

- Production data migration / destructive DB ops
- Secret rotation, IAM changes, security-rule edits
- Force push / history rewrite
- Anything that moves money or cancels subscriptions
- Deploys to production

## 5. Stack-specific skill auto-engagement

| Stack detected | Auto-invoke |
|---|---|
| <e.g. Flutter/Dart> | <e.g. flutter-testing> |
| <e.g. Next.js/TS> | <e.g. shadcn, frontend-design> |
| <e.g. Python> | <standard skills> |

Add forbidden combinations (e.g. never run a frontend design skill on backend
work) here.

## 6. When in doubt — lookup order

1. This file (SKILLS_PROTOCOL.md) — authoritative for gates.
2. `.planning/CONVERSATION-CONTEXT.md` — decision history and hard rules.
3. The repo's own `CLAUDE.md` / branch policy.

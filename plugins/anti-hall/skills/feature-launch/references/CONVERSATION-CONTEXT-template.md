# Conversation Context — <FEATURE_NAME> Origin Session (<DATE>)

> **For all subagents:** This file captures decisions, findings, and constraints
> from the planning session that produced this milestone. **Read this before
> answering "why" or "what was decided" questions.** Cross-reference with any formal
> intel synthesis under `.planning/intel/`.

---

## Origin

User opened with: <VERBATIM_QUOTE_OR_PARAPHRASE>

Then escalated through several issues:
- <issue 1>
- <issue 2>
- ...

Conversation evolved into <SUMMARY_OF_REFACTOR>.

---

## Hard rules (NEVER bypass)

Project-specific hard rules. Examples (customize per project):

1. **<Resource X> HANDS-OFF** — never edit/deploy <X>. Owner manages via <console/UI>.
2. **Financial actions blocked** — no refunds, cancellations, payment movements
   without explicit owner approval.
3. **No force push, no destructive ops** — `git push --force`, `git reset --hard`,
   `rm -rf`, `DROP TABLE` require explicit confirmation.
4. **No paid CI builds proactively** — each <CI provider> build costs ~$X.
   Auto-trigger only.
5. <add project-specific>

---

## Worktree assignments (mandatory isolation if owner works concurrently)

| Repo | Worktree path | Branch | Source |
|---|---|---|---|
| <repo-1> | `.worktrees/<repo-1>-<feature-slug>` | `feat/<feature-slug>` | <base branch> |
| <repo-2> | `.worktrees/<repo-2>-<feature-slug>` | `feat/<feature-slug>` | <base branch> |

**NEVER edit a repo's primary checkout while a worktree exists for it.** The primary
checkout may hold the owner's uncommitted local edits.

---

## Branch policy at merge time

Use each repo's own branch policy (read its CONTRIBUTING / config). Record it here so
subagents don't guess:

- <repo-1>: <PR strategy / direct push / staging-first>
- <repo-2>: <strategy>
- Workspace root: <strategy>

---

## Existing branch state — STABLE commit hashes for keep/revert decisions

If the project already has work-in-progress to integrate:

| Commit | What it does | Action in this milestone |
|---|---|---|
| <sha> | <description> | KEEP / REVERT / SURGICAL EDIT |
| ... | ... | ... |

**WARNING for surgical edits:** if a commit bundles multiple workstreams that need
different actions, document the surgical edit instructions explicitly here.

---

## Decisions captured during planning

(Document in chronological order — context for "why X over Y" questions)

- **D-XXX:** <decision> — *Source / rationale:* <where it came from>
- ...

---

## Pre-existing security / quality concerns (deferred — separate hardening)

Concerns NOT in scope for this milestone but worth tracking:

- <concern 1>
- ...

---

## Knowledge graph baseline

- Code graph: <N> nodes, <N> edges, <N> communities
- Project graph: same artifacts

Key communities relevant to this feature:
- Community <N>: <label> (<N> nodes) — <what it covers>
- ...

Confirmed pipelines this feature must touch:
- <pipeline name>: `<step1> -> <step2> -> <step3>`

Top high-degree nodes (architectural pillars):
1. `<node>` (<N> edges)
2. ...

---

## When in doubt

1. Read this file first
2. Then any formal intel synthesis under `.planning/intel/`
3. Then the phase's `CONTEXT.md`
4. Then query the graphs (project graph + code graph)
5. **If still uncertain -> STOP and surface to owner with structured options. Do NOT
   guess.**

---

*Updated: <DATE>. Update incrementally as phases progress and decisions evolve.*

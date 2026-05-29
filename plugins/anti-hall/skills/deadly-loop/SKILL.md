---
name: deadly-loop
description: Iterative 2-agent debate + fix-wave protocol for hardening non-trivial PRs and changes before merge. Spawns parallel Reviewer + Critic auditors, dispatches fix waves, loops until convergence (zero NEW P0 blockers). Use before merging anything with cross-file risk, cross-PR coordination, security-sensitive changes (auth, signing, redaction, prompt-injection defense), schema migrations, production-data touches, shell scripts, CI/workflow YAML, cross-repo coordination, or LLM prompt work — anywhere a silent failure would be expensive. Born from a real project where 7 iteration rounds caught 30+ bugs that solo review would have missed.
---

# Deadly Loop — Iterative Debate Until Clean

Spend 1-2 hours of agent compute to ship a clean change rather than 1-2 weeks of post-merge incident response.

This skill uses a shared debate roster defined in `references/MODEL-POLICY.md` (Reviewer = latest Opus at max thinking; Critic = latest OpenAI Codex at max reasoning, with a 2nd-Opus divergent-persona fallback). Read that file before dispatching any round so the model selection and spawn mechanics are correct.

## When to use this skill

**Use when ANY of these are true:**
- The change touches multiple files across multiple PRs and merge order matters
- Hand-merges between divergent branches are required
- Serverless / Cloud Function deploy with signature verification (HMAC), IAM, or secret coupling
- Schema migration / production-data touches
- Security-sensitive changes (auth, redaction, signing, prompt-injection defense)
- LLM prompt engineering (tokens, caching, model thresholds — easy to claim works without testing)
- Bash / shell scripts (parameter expansion has subtle parser bugs)
- CI / workflow YAML edits (e.g. GitHub Actions — expression context scoping is tricky)
- Cross-repo coordination (monorepo + submodules, parallel agents working concurrently)
- Anything labeled "non-trivial" by an experienced engineer's gut

**Don't use for:**
- Single-file bug fixes
- Trivial UI tweaks
- Existing-spec implementation with no design ambiguity
- Doc-only changes
- Anything <1 day of work AND <2 files touched

## Pre-requisites

Before invoking the deadly loop, ensure:
1. The changes are **committed and pushed** (the loop audits remote state via `gh pr diff` etc.); local-only work can be audited against the working tree, but remote is preferred.
2. A **canonical handoff doc** exists or will be created (e.g., `docs/<date>-<feature>-session-handoff.md`).
3. The owner has authorized at least one full iteration (each round is ~5-30 min of agent compute).
4. A verification preamble + branch/SHA check is in effect for every spawned agent (see Phase A3).
5. The debate roster from `references/MODEL-POLICY.md` is resolved — confirm whether Codex is available (`command -v codex`) so you know which Critic path to take.

## The pattern at a glance

```
Round 1 (initial audit, Reviewer + Critic in parallel)
  └─→ findings → Wave 1 (orchestrator + parallel children)
                  └─→ commits pushed → Round 2 (post-Wave-1 audit)
                                        └─→ findings → Wave 2
                                                       └─→ ...
                                                            └─→ Round N (zero NEW P0s) → GO → owner merge
```

Each round = 1 Reviewer agent + 1 Critic agent, dispatched **in parallel in the same message**. Roster + spawn details: `references/MODEL-POLICY.md`.
Each wave = 1 orchestrator agent + N parallel children for parallel-safe fixes, then serial children for fixes with dependencies.

## Phase A — Initialize the loop

Before Round 1:

### A1. Create / update the canonical handoff doc

`docs/<date>-<feature>-session-handoff.md` becomes the **authoritative state record**. Every round + wave updates it. Format:

```markdown
# <Feature> — Session Handoff (<date>)

**Status:** <one-line current state>

## Where we are right now
- Iteration: Round N / Wave M
- Active background agents: <agent IDs>
- Last verified state: <SHA per branch>

## Round 1 findings (P0/P1/P2 with file:line citations)
## Wave 1 work list + commit SHAs after dispatch
## Round 2 findings
## Wave 2 work list + commit SHAs
... (one section per iteration)

## How to continue
<resume prompt for next session>
```

The handoff is **how every spawned agent gets full prior history**. Without this, Round 7 doesn't know what Round 1 already verified, and re-runs the same audits.

### A2. Snapshot baseline

```bash
git -C <repo> branch --show-current
git -C <repo> rev-parse --short HEAD
gh pr list --state open --json number,headRefName,headRefOid,mergeStateStatus
```

Record these in the handoff. Compare every round to detect drift.

### A3. Lock the verification preamble

Every spawned agent MUST run this before any read/write:

```bash
cd <expected_dir>
ACTUAL_BRANCH=$(git branch --show-current)
ACTUAL_SHA=$(git rev-parse --short HEAD)
EXPECTED_BRANCH=<branch>
EXPECTED_SHA=<sha>
if [ "$ACTUAL_BRANCH" != "$EXPECTED_BRANCH" ] || [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "BRANCH/SHA MISMATCH: expected=$EXPECTED_BRANCH@$EXPECTED_SHA actual=$ACTUAL_BRANCH@$ACTUAL_SHA"
  echo "STOP — surface to orchestrator before proceeding"
  exit 1
fi
```

The orchestrator dispatching the agent fills `<expected_dir>`, `<branch>`, `<sha>` from the moment of dispatch.

## Phase B — Round N debate

Two parallel agents dispatched in the **same message** (roster + exact spawn syntax in `references/MODEL-POLICY.md`):

- **Reviewer** — latest Opus at maximum thinking. Correctness / architecture auditor.
- **Critic** — latest OpenAI Codex at maximum reasoning **when available**; otherwise a 2nd Opus with a divergent adversarial "failure-mode hunter" persona.

See `references/MODEL-POLICY.md` for the `command -v codex` availability check and the concrete `Agent(...)` / Codex invocations. Dispatch both in ONE message so they run truly in parallel.

### B1. Reviewer prompt skeleton

```
You are the Round N Reviewer for <feature>. Verify Wave-(N-1) commits resolve their parent Round-(N-1) findings without regression.

CRITICAL READING:
1. <handoff doc path> — covers Rounds 1 through N-1
2. PR diffs via `gh pr diff` and `gh pr view --json files,mergeStateStatus` (or the working-tree diff if not yet pushed)

Wave-(N-1) commits to verify:
- Fix-X: <commit SHA> on <branch> — targets <Round-(N-1) finding>
- Fix-Y: <commit SHA> on <branch> — targets <Round-(N-1) finding>
- ...

Verification grid:
| Fix | Round-(N-1) finding | What to verify |

For each Fix:
- PASS: cite file:line evidence
- FAIL: cite what's still broken
- PARTIAL: cite what's fixed vs what's not

Cross-PR merge order final walkthrough: predict outcome of each merge in the documented order. Identify any conflicts that would surface during interactive merge.

Verdict:
- GO: All Wave-(N-1) fixes resolve Round-(N-1) issues + merge order clean
- HOLD: list specific blockers
- BLOCKED: architectural issue requiring owner decision

Hard rules:
- Read remotely via `gh pr diff` / `gh pr view --json files` (or working-tree diff if unpushed)
- No local checkout mutations, no edits, no pushes
- Cite file:line for every claim
- If you can't verify due to limited tooling, say so — don't pass blindly

Run independently of the Critic agent.
```

### B2. Critic prompt skeleton

```
You are the Round N Critic for <feature>. Adversarial role: hunt where Wave-(N-1) fixes BROKE something or HID a different bug.

CRITICAL READING: same as Reviewer.

Wave-(N-1) commits to attack:
[same list]

Hunt for these specific failure modes for each fix:
- Edge cases the orchestrator didn't test
- Unintended side effects on adjacent code
- Subtle regressions: did Fix-X accidentally undo Fix-K (K<N-1)?
- Cross-PR runtime correctness: do all references still resolve after the fix?
- Validation claims that weren't actually validated (e.g., "merge rehearsal passed" — was the rehearsal target right?)

Specific cross-PR hunts:
[fill in based on this round's PR landscape]

Output: P0/P1/P2 with file:line citations. Distinguish NEW issues from previously-found issues. New issues should be genuinely new (introduced by Wave-(N-1) commits), not re-discovered from earlier rounds.

Verdict format same as Reviewer.

Run independently.
```

**Critical: dispatch both agents in the SAME message** so they run truly in parallel. Don't sequentially.

### B3. Synthesis (you do this on receipt)

Both agents return → dedup their findings → categorize:
- **GO from both** → proceed to Phase D (merge)
- **HOLD from either** → write Wave N work list, dispatch Phase C
- Issues that BOTH agents flag → highest priority, definitely real
- Issues only ONE flags → either a deeper bug one missed OR a false positive — adjudicate

**Apply the round-discipline rules:**
1. Each round has full history (handoff doc) AND focuses NEW analysis on the latest delta.
2. If a round's findings RE-DISCOVER prior issues already verified clean, that's a process bug — narrow scope further.
3. **Convergence test**: count of NEW (not rediscovered) P0s. Target: 0 → GO. The trend should monotonically decrease.

Append round outputs to handoff. Commit + push.

## Phase C — Wave N fix dispatch

One orchestrator agent + parallel children. The orchestrator handles:

### C1. Wave N orchestrator prompt skeleton

```
You are the Fix Wave N orchestrator for <feature>. Round N found <count> P0/P1 issues. Dispatch the fixes, handle sequencing, report back.

CRITICAL READING:
1. <handoff doc path>
2. The verification preamble (branch+SHA check, Phase A3)
3. The round-discipline rules (focus NEW analysis on the latest delta; convergence counts NEW not rediscovered P0s)

HARD CONSTRAINTS:
- Branch+SHA preamble in EVERY child agent prompt
- `git pull --rebase origin <branch>` before push (NEVER force-push UNLESS this fix spec authorizes it as an explicit rebase fix)
- Push rejection or branch mismatch → STOP + report
- VALIDATION REQUIRED before push (per Critic's directive):
  - bash files: `bash -n` syntax check + INVOCATION TEST with expected output
  - JS files: `node --check`
  - YAML files: `yamllint -d relaxed`
  - Python files: `python -m py_compile` + inline regex unit tests if regex changed
  - Force-push fixes: `git merge --no-commit origin/<base>` rehearsal proof BEFORE force-push

The N fixes (Fix-A through Fix-N):
[per-fix table with severity, branch, file, exact patch, validation requirements]

Sequencing:
- Wave NA — parallel-safe (dispatch in one message): [list]
- Wave NB — serial, requires coordination: [list]

Subagent prompt template:
[ROLE / TARGET / FILE / PATCH / VERIFICATION PREAMBLE / VALIDATION / COMMIT+PUSH / REPORT]

Use a fast/cheap model for execution-only fixes (apply specific patch, push). Use a stronger model for fixes requiring investigation, hand-merging, or rebase planning. (Round debate agents always use the full roster in references/MODEL-POLICY.md — never downgrade those.)

Final report (under 800 words):
| Fix | status | commit SHA | branch | validation evidence (paste actual outputs) |

Plus: overall verdict — "Round N+1 ready" or "still blocked on X". Identify if any validation step would have caught a prior wave's bug.
```

### C2. Wave-A vs Wave-B sequencing

- **Parallel-safe fixes**: independent files, no shared state — dispatch in one Agent message.
- **Serial fixes**: rebases, hand-merges, cross-PR moves — must sequence to avoid clobbering. Use a reasoning-capable model for these (investigation required).

### C3. Validation rigor (the hard-won rule)

A real fix wave once declared 10 fixes "DONE" without runtime validation. A later round caught, among others:
- `PAYLOAD_JSON="${5:-{}}"` — bash parses at the first `}`, corrupting JSON when `$5` is set. `bash -n` does NOT catch this; only an invocation test does.
- A rebase claim ("merge rehearsal: Already up to date") that was misleading because the rehearsal target was the current base, not the future post-merge base — so the real rebase never took.

**Mandatory validation per fix type:**

| File type | Required check |
|---|---|
| `*.sh` | `bash -n <file>` AND **invocation test with expected output** (paste in report) |
| `*.js` / `*.cjs` / `*.mjs` | `node --check <file>` |
| `*.yml` / `*.yaml` | `yamllint -d relaxed <file>` |
| `*.py` | `python -m py_compile <file>` AND **inline regex unit tests if regex changed** |
| Rebases / force-pushes | `git merge --no-commit origin/<base>` rehearsal — paste output |
| Hand-merges | After splice, `node --check` or syntax-equivalent for the language |

If validation fails → child agent STOPS, does NOT commit, reports error to orchestrator.

## Phase D — Convergence + merge sequence

When Round N returns GO from BOTH agents:

### D1. Confirm convergence

- Count of NEW P0s in Round N: should be 0.
- Trend: P0 count per round should monotonically decrease toward 0.
- If Round N finds NEW P0s genuinely introduced by Wave-(N-1), keep iterating (Wave N → Round N+1).
- If Round N finds REDISCOVERED issues, narrow scope (process bug) — re-emphasize delta-focus discipline in the next prompt.

### D2. Owner-action checklist (for the owner, not the agent)

Document in the handoff what the owner must do MANUALLY before / during / after merge — these are explicitly OUT-OF-SCOPE for the agent. Common examples:
- Create secrets in the secret manager / CI secret store
- Mirror or sync repositories if needed
- Grant IAM / access roles
- Deploy serverless functions / containers
- Configure database TTL / indexes
- Seed config documents
- Set workflow / CI env vars
- Enable platform features

### D3. Merge order

Document the strict merge order in the handoff. Common patterns:
1. **Docs PRs first** — no code interaction risk.
2. **Independent-repo PRs second** — repos that have no cross-conflict.
3. **Superset PR before subset PRs** — when one PR owns the canonical merged content, it must merge first so subsets become identical no-ops.
4. **Dependency-source before dependency-consumer** — the PR providing a script/lib before the PR using it.
5. **Audit-emit / audit-store last** — they reference everything else.

For each merge:
- Wait for CI green.
- `gh pr merge --squash --delete-branch=false` (preserve branches for forensics).
- Verify `gh pr view <num> --json mergedAt` after each.
- Move to the next.

### D4. Post-merge validation

After ALL PRs merge, run a real-world test. Define what "actually working in production" looks like for this change and verify it end-to-end (exercise the real path, inspect the real output/data, confirm side effects landed).

If post-merge validation fails → diagnose → potentially Fix Wave N+1 → Round N+1.

## Hard safety boundaries (NEVER bypass)

1. **NEVER auto-merge** — the owner authorizes each merge interactively.
2. **NEVER force-push** without (a) explicit fix-spec authorization AND (b) merge rehearsal proof.
3. **NEVER skip validation** — `bash -n` alone, `node --check` alone, etc. are not sufficient. Runtime invocation tests are required for shell scripts; merge rehearsals are required for rebase fixes.
4. **NEVER delete files unless the fix spec is explicit** — a prior wave deleted a file when the spec said "drop-from-diff", wasting a full round + wave.
5. **NEVER deploy serverless functions / production infra** — owner only.
6. **NEVER push to a protected branch without owner approval** unless project policy explicitly permits.
7. **NEVER ignore a branch+SHA mismatch** in the verification preamble — STOP and surface.
8. **Respect project-specific hands-off files** (security rules, infra config) — read for context, never modify unless the owner explicitly authorizes.

## Anti-patterns

Avoid:

- **Skipping the round debate after a fix wave** — that's how regression bugs slip through. Always run a round AFTER a wave.
- **Recycling broad audit hunts in every round** — narrow scope to the delta. Re-checking the same area in Round 7 because it was in Round 6 is waste.
- **Dispatching the next wave before updating the handoff** — always: handoff update → commit → push → THEN dispatch.
- **Trusting agent claims without runtime validation** — a "merge rehearsal: Already up to date" line can look like proof while the rehearsal target was wrong. Verify the verification.
- **Letting force-pushes happen without rehearsal** — proving the rebase is correct is mandatory.
- **Sending Reviewer + Critic in separate messages** — they run sequentially that way, doubling wall time. Always dispatch BOTH in one message.
- **Downgrading debate agents without checking availability** — if Codex is unavailable, fall back to a 2nd Opus with a divergent persona (per `references/MODEL-POLICY.md`), NOT a weaker/cheaper model. A weaker model's debate depth is substantially shallower; use cheap models only for wave fix children, never for round debate agents. If Opus is also rate-limited, wait and retry rather than silently degrading.
- **Stopping after Round 1 GO** — sometimes Round 1 misses things only Round 2 catches once you have a baseline. The first GO from BOTH agents is the gate, not Round 1.

## Telemetry to track

Per round, record in the handoff:
- Background agent IDs (so output files are recoverable)
- Wall-clock duration
- Token usage (rough)
- P0/P1/P2 count
- Whether findings are NEW or REDISCOVERED
- Convergence trend (P0 count per round)

Per wave:
- Orchestrator agent ID
- Number of child agents dispatched
- Validation outputs (paste actual command results)
- Force-push justifications (with rehearsal proof)

## Origin

This skill was distilled from a real project session that delivered ~10 coordinated PRs across multiple repos, ran 7 debate rounds + 6 fix waves, and caught **30+ distinct bugs** — including a CI `if:` env-context scoping bug that would silently never fire, bash parser corruption in a `${5:-{}}` parameter default, an LLM caching-threshold misinformation, cross-PR delete-modify conflicts, a force-push rebase that didn't take effect despite a "rehearsal passed" claim, a redaction false-positive shredding legitimate text, and an auth-token leak from a regex that required the wrong separator. Each would have been a production incident or owner-time sink. The loop's cost in agent compute was trivial compared to a single one of those incidents.

## How to invoke

When the conditions in "When to use this skill" are met, proactively suggest:

> "This change has [cross-PR coordination / hand-merges / security implications / serverless coupling / shell scripts / CI YAML]. I recommend running the **deadly-loop** skill before merge — it catches subtle bugs that single-pass review usually misses. ~30-90 min of agent compute, ~$5-15 in tokens."

If the owner approves, execute Phase A → B → C → D as documented, using the roster in `references/MODEL-POLICY.md`.

## Reference templates (optional, add incrementally)

A `references/` directory can hold fillable templates as the protocol matures:
- `ROUND-PROMPT-TEMPLATE.md` — fillable Reviewer + Critic skeletons
- `WAVE-ORCHESTRATOR-TEMPLATE.md` — fillable orchestrator prompt
- `HANDOFF-DOC-TEMPLATE.md` — initial handoff doc structure
- `VALIDATION-CHECKLIST.md` — by file type
- `MERGE-ORDER-DECISION-TREE.md` — how to determine merge order from PR diff overlap

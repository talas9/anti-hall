---
name: deadly-loop
description: Iterative TRIO-debate + fix-wave protocol for hardening non-trivial PRs and changes before merge. Spawns a parallel Reviewer + Auditor + Critic trio, dispatches fix waves, loops until convergence (zero NEW P0 or P1 blockers). Use before merging anything with cross-file risk, cross-PR coordination, security-sensitive changes (auth, signing, redaction, prompt-injection defense), schema migrations, production-data touches, shell scripts, CI/workflow YAML, cross-repo coordination, or LLM prompt work — anywhere a silent failure would be expensive. Born from a real project where 7 iteration rounds caught 30+ bugs that solo review would have missed.
---

# Deadly Loop — Iterative Debate Until Clean

Spend 1-2 hours of agent compute to ship a clean change rather than 1-2 weeks of post-merge incident response.

This skill uses a shared TRIO debate roster defined in `references/MODEL-POLICY.md` (Reviewer = Sonnet 5 `model:"sonnet"` at effort `xhigh`; Auditor = latest Opus `model:"opus"`, divergent regression/coupling lens, effort `high`; Critic = latest OpenAI Codex at `xhigh` reasoning, with an Opus divergent-persona fallback). Read that file before dispatching any round so the model selection, the availability fallback matrix, the round governance, and the spawn mechanics are correct.

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
5. The debate roster from `references/MODEL-POLICY.md` is resolved — read the `codex-availability` fact (`~/.anti-hall/codex-availability.json`) first; fall back to the live OS-agnostic Node probe in `references/MODEL-POLICY.md` only if that fact is absent/stale — so you know which row of the availability fallback matrix applies. When Codex is available, the Critic seat MUST spawn `agentType:'codex:codex-rescue'`, not degrade to Opus. (Fable routing is policy-disabled — see `references/MODEL-POLICY.md` — so the `fable` token is informational-only and does not change the Reviewer seat.)

## The pattern at a glance

```
Round 1 (initial audit, Reviewer + Auditor + Critic trio in parallel)
  └─→ findings → Wave 1 (orchestrator + parallel children)
                  └─→ commits pushed → Round 2 (post-Wave-1 audit)
                                        └─→ findings → Wave 2
                                                       └─→ ...
                                                            └─→ Round N (zero NEW P0/P1s) → GO → owner merge
```

Each round = a Reviewer + Auditor + Critic TRIO (3 agents), dispatched **in parallel in the same message**. Roster, availability fallback matrix, round governance + spawn details: `references/MODEL-POLICY.md`.
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

Every spawned agent MUST run this before any read/write. It is pure Node
(`child_process.execFileSync`), so it runs unchanged on Windows, macOS, and Linux —
no POSIX shell, no `$(...)`, no `[ ... ]`. Save as `verify-branch.js` (or paste into
`node -e`) and run `node verify-branch.js <expected_dir> <branch> <sha>`:

```js
// verify-branch.js — exits 1 on branch/SHA drift, 0 when the worktree matches.
'use strict';
const { execFileSync } = require('child_process');
const [dir, expBranch, expSha] = process.argv.slice(2);
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const actualBranch = git('branch', '--show-current');
const actualSha = git('rev-parse', '--short', 'HEAD');
if (actualBranch !== expBranch || actualSha !== expSha) {
  console.error(`BRANCH/SHA MISMATCH: expected=${expBranch}@${expSha} actual=${actualBranch}@${actualSha}`);
  console.error('STOP — surface to orchestrator before proceeding');
  process.exit(1);
}
console.log(`OK ${actualBranch}@${actualSha}`);
```

The orchestrator dispatching the agent fills `<expected_dir>`, `<branch>`, `<sha>` from the moment of dispatch.

> POSIX-only equivalent (Linux/macOS shells), if a Node verifier is unavailable:
> ```bash
> cd <expected_dir>
> [ "$(git branch --show-current)" = "<branch>" ] && [ "$(git rev-parse --short HEAD)" = "<sha>" ] \
>   || { echo "BRANCH/SHA MISMATCH — STOP, surface to orchestrator"; exit 1; }
> ```

## Phase B — Round N debate

A TRIO of three parallel agents dispatched in the **same message** (roster + availability fallback matrix + exact spawn syntax in `references/MODEL-POLICY.md`):

- **Reviewer** — Sonnet 5 (`model:"sonnet"`) at effort `xhigh` (Fable routing is policy-disabled — see `references/MODEL-POLICY.md`). Correctness / architecture auditor.
- **Auditor** — latest Opus (`model:"opus"`) at full reasoning depth (effort `high`). Divergent: regression & coupling hunter (hunts what broke ELSEWHERE — regressions in unchanged code, wrong cross-module/cross-PR coupling, fixes that undid earlier fixes, merge-order cross-reference breaks).
- **Critic** — latest OpenAI Codex at `xhigh` reasoning **when available** (canonical Codex spawn form in `references/MODEL-POLICY.md`); otherwise an Opus with a divergent adversarial "failure-mode hunter" persona.

See `references/MODEL-POLICY.md` for the OS-agnostic Node probe that checks `fable`/Codex availability and the concrete `Agent(...)` / Codex invocations. Dispatch all three in ONE message so they run truly in parallel.

### B0. Auditor depth requirements (all three seats)

These four requirements bind **all three** seats — the Reviewer, the Auditor, and the Critic. A round that skips them is wasted compute — surface-skimming is exactly how the 30+ bugs in the origin session slipped past solo review.

1. **DIG DEEP, DO NOT SURFACE-SKIM.** Read the ACTUAL implementation of each changed/affected function end to end. Trace control flow and data flow across file boundaries; follow every branch, every error path, every early return. Never judge correctness from a name, a signature, a comment, or a diff hunk alone — open the code it calls and the code that calls it. State what you actually read (`file:line` ranges), not what you inferred.

2. **ENUMERATE & SIMULATE EDGE CASES.** For each changed unit, list the boundary/adversarial inputs — empty, null/undefined, malformed, max-size/huge, unicode, concurrent/interleaved, missing file, permission-denied, clock-skew/future-timestamp, partial/truncated, injection-shaped — and MENTALLY EXECUTE the code for each (or write a quick throwaway harness). Report the predicted outcome per input. Flag any input that produces a wrong/unsafe result, a throw on a fail-open path, or an unbounded operation.

3. **THREE-TIER SEVERITY (heat).** Tag every finding:
   - **P0** — critical/blocker: silent failure, security, data loss, fail-CLOSED, breaks a guard.
   - **P1** — high: wrong behavior on a real path, regression.
   - **P2** — medium: robustness, clarity, perf.
   - **EASY-WIN** — cheap, high-value cleanups worth doing while you're in there.
   Sort by heat, P0 first.

4. **CARRY-FORWARD.** You are given the full prior-round history (handoff doc) + the exact fixes applied since. FIRST verify each prior finding's fix actually resolved it WITHOUT regression; THEN hunt genuinely NEW issues. Always distinguish NEW from REDISCOVERED.

### B1. Reviewer prompt skeleton

(Apply the B0 depth requirements: dig deep, simulate edge cases, P0/P1/P2 + EASY-WIN, carry-forward.)

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

Run independently of the Auditor and Critic agents.
```

### B1.5. Auditor prompt skeleton (divergent regression & coupling lens)

(Apply the B0 depth requirements: dig deep, simulate edge cases, P0/P1/P2 + EASY-WIN, carry-forward.)

The Auditor (latest Opus, `model:"opus"`) runs a DIFFERENT Claude generation from the Reviewer, with an orthogonal lens: it does not re-verify the diff the way the Reviewer does — it traces the blast radius OUTWARD to find what the change broke elsewhere.

```
You are the Round N Auditor for <feature>. DIVERGENT lens: regression & coupling hunter. Do NOT duplicate the Reviewer's diff-verification — trace OUTWARD from the change.

CRITICAL READING: same as Reviewer (handoff doc + PR diffs / working-tree diff).

Wave-(N-1) commits to trace the blast radius of:
[same list as Reviewer]

Hunt specifically for:
- Regressions in UNCHANGED code that depends on the changed code (callers, importers, downstream consumers) — open the call sites, do not infer.
- Wrong coupling: a contract / schema / shared constant / message shape that the change perturbs but a sibling module/PR still assumes the old form.
- Fix-vs-fix regressions: did a Wave-(N-1) fix silently undo an earlier fix (Fix-K, K<N-1)?
- Merge-order cross-reference breaks: after the documented merge order, does every cross-PR reference still resolve?

Output: P0/P1/P2 + EASY-WIN with file:line citations. Distinguish NEW from REDISCOVERED.

Verdict format same as Reviewer.

Run independently of the Reviewer and Critic agents.
```

### B2. Critic prompt skeleton

Reminder: Codex (`agentType:'codex:codex-rescue'`) is the DEFAULT spawn for this seat; `{model:'opus'}` is the FALLBACK only, used only when Codex is unavailable per the availability check above.

(Apply the B0 depth requirements: dig deep, simulate edge cases, P0/P1/P2 + EASY-WIN, carry-forward.)

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

Run independently of the Reviewer and Auditor agents.
```

**Critical: dispatch all three seats in the SAME message** so they run truly in parallel. Don't sequentially.

### B3. Synthesis (you do this on receipt)

All three seats return → dedup their findings → categorize, applying the **round governance** in `references/MODEL-POLICY.md`:
- **GO from all three (a non-degraded round)** → proceed to Phase D (merge). A GO requires zero un-adjudicated HOLD blockers AND a full, non-degraded round — a **DEGRADED round (a seat dead after its one retry) can NEVER grant a final GO**; the missing seat must sit in a full follow-up round first.
- **HOLD from any seat** → write Wave N work list, dispatch Phase C.
- **≥2-of-3 agreement on a finding = confirmed-real** → highest priority, definitely real.
- Issues only ONE seat flags → either a deeper bug the other two missed OR a false positive — adjudicate against the actual code.

**Argument outcomes (dissent adjudication):** a **single-seat re-run** is allowed ONLY for evidence-adjudication with NO code/plan change in between (re-run the one dissenting seat to confirm/refute against the current state). **ANY fix wave ⇒ the FULL TRIO re-runs next round** — never a single-seat re-audit after code changed (preserves the anti-pattern below). Evidence-refuted dissent may be overridden, documented in the handoff.

**Apply the round-discipline rules:**
1. Each round has full history (handoff doc) AND focuses NEW analysis on the latest delta.
2. If a round's findings RE-DISCOVER prior issues already verified clean, that's a process bug — narrow scope further.
3. **Convergence test**: count of NEW (not rediscovered) confirmed P0s or P1s. Target: 0 → GO. The trend should monotonically decrease.

Append round outputs to handoff. Commit + push.

## Phase C — Wave N fix dispatch

One orchestrator agent + parallel children. The orchestrator handles:

### C1. Wave N orchestrator prompt skeleton

```
You are the Fix Wave N orchestrator for <feature>. Round N found <count> P0/P1 issues. Dispatch the fixes, handle sequencing, report back.

CRITICAL READING:
1. <handoff doc path>
2. The verification preamble (branch+SHA check, Phase A3)
3. The round-discipline rules (focus NEW analysis on the latest delta; convergence counts NEW not rediscovered P0s/P1s)

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

When Round N returns GO from ALL THREE seats (a non-degraded round — see the round governance in `references/MODEL-POLICY.md`):

### D1. Confirm convergence

- Count of NEW confirmed P0s or P1s in Round N: should be 0.
- Trend: P0/P1 count per round should monotonically decrease toward 0.
- If Round N finds NEW P0s or P1s genuinely introduced by Wave-(N-1), keep iterating (Wave N → Round N+1).
- If Round N finds REDISCOVERED issues, narrow scope (process bug) — re-emphasize delta-focus discipline in the next prompt.

### D1.5 — Verification gate (a GO is NOT valid without it)

Zero NEW P0/P1s is necessary but NOT sufficient. Before declaring GO, the orchestrator
must independently confirm — with FRESH evidence in the current round, not an agent's
say-so — that every "fixed / passing" claim is real. A clean debate over unverified
fixes is a false GO. This makes the verify-first discipline a hard convergence
requirement, inherited by every workflow that uses the deadly-loop.

For each fix claimed resolved this loop:
1. **IDENTIFY** the exact command/test that proves the claim.
2. **RUN** it fresh THIS round (re-run yourself or via a separate verifier — never trust the fix agent's report; rule L).
3. **READ** the full output + exit code.
4. **VERIFY** the output actually confirms the claim (a green suite ≠ the bug is fixed — check the bug's own assertion).
5. **VACUOUS-TEST GUARD:** any test added/changed to prove a fix MUST be shown to FAIL when the fix is reverted (revert → run → confirm red → restore). A test that passes with the fix removed proves nothing and does not count as resolution.

If any claim fails its check, the issue is NOT resolved — keep it open and iterate, regardless of the debate verdict. GO requires zero NEW P0s or P1s **and** every resolution verified by fresh evidence here.

### D1.6 — Write the advisory audit record (NOT a proof/authorization token)

On convergence (GO from D1 + D1.5 passing), write
`~/.anti-hall/approvals/<repo>@<HEAD-sha>.json` with:

```json
{
  "repo": "<repo>",
  "sha": "<HEAD short SHA>",
  "timestamp": "<ISO-8601>",
  "roundTrend": [/* NEW confirmed P0/P1 count per round, e.g. [5,2,0] */],
  "seatVerdicts": { "reviewer": "GO", "auditor": "GO", "critic": "GO" },
  "proof": false
}
```

**This file is an ADVISORY AUDIT RECORD, never proof of correctness and never an
authorization token.** Label it as such wherever it is referenced. The deadly-loop
is agent-followed guidance, not a hook enforced by the harness — an agent that
fakes convergence (skips D1.5, rubber-stamps a verdict) can just as easily fake
this file. Any reader that consumes it — e.g. a CI push gate or DevSwarm's merge
gate — MUST treat `"proof": false` as load-bearing and enforce its OWN real
gating (fresh test runs, its own review, branch protection) rather than trusting
this record as sufficient evidence on its own. This file is a breadcrumb for
audit trails and telemetry, not a substitute for the reader's own verification.

### Iteration caps (soft 10 / hard 15)

The convergence loop (Reviewer + Auditor + Critic trio debate → fix wave → re-converge, "until zero NEW P0/P1 blockers") MUST be bounded — a loop that never converges is itself a failure signal, not a reason to keep grinding silently.

- **SOFT CAP = 10 rounds.** When you reach round 10 without convergence, STOP and checkpoint with the user via `AskUserQuestion` — present the choice: **continue** (keep iterating), **stop** (accept current state and report outstanding P0s/P1s), or **change scope** (narrow the target / split the work). Do NOT keep looping silently past this point.
- **HARD CAP = 15 rounds.** At round 15, force-stop unconditionally — even if not converged. Report the remaining NEW P0s/P1s, the per-round trend, and why convergence was not reached. No further automatic rounds.

Soft = ask the user what to do; hard = force-stop regardless. If the trend is not monotonically decreasing well before the soft cap, treat that as a process bug (rediscovery / scope too broad) and fix the process rather than burning rounds.

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
- **Sending the trio (Reviewer + Auditor + Critic) in separate messages** — they run sequentially that way, tripling wall time. Always dispatch ALL THREE in one message.
- **Single-seat re-audit after a fix wave** — a single-seat re-run is allowed ONLY for evidence-adjudication with no code/plan change in between; ANY fix wave ⇒ the FULL TRIO re-runs next round (per the round governance in `references/MODEL-POLICY.md`).
- **Granting a final GO on a DEGRADED round** — a round where a seat stayed dead after its one retry can drive a fix wave but NEVER grants a final GO; the missing seat must sit in a full follow-up round first.
- **Downgrading debate agents without checking availability** — walk the availability fallback matrix in `references/MODEL-POLICY.md`: if Sonnet 5 is unavailable the Reviewer falls back to Opus; if Codex is unavailable the Critic becomes an Opus with a divergent adversarial persona — NOT a weaker/cheaper model. The floor for every seat is Opus. A weaker model's debate depth is substantially shallower; use cheap models only for wave fix children, never for round debate agents. If a flagship seat is rate-limited, wait and retry rather than silently degrading.
- **Stopping after Round 1 GO** — sometimes Round 1 misses things only Round 2 catches once you have a baseline. The first GO from ALL THREE seats (non-degraded) is the gate, not Round 1.

## Telemetry to track

Per round, record in the handoff:
- Background agent IDs (so output files are recoverable)
- Wall-clock duration
- Token usage (rough)
- P0/P1/P2 count
- Whether findings are NEW or REDISCOVERED
- Convergence trend (P0/P1 count per round)

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

## Swarm mode — the deadly swarm (Workflow execution; swarm-first)

The loop runs **swarm-first** as a Dynamic Workflow via
`references/deadly-loop.workflow.js`. The plain Agent-tool path (Phases A–D
above) stays **fully supported as the documented fallback** for sessions without
Workflow consent — it is not deprecated. Pick swarm mode for multi-round /
multi-roster runs; pick the inline Agent-tool path for small one-off audits or
when Workflow consent is unavailable.

**One workflow run = ONE round + its fix wave.** The COORDINATOR loops: run the
workflow → read the verdicts → update the handoff doc (durable state lives in the
handoff, NOT in workflow memory — there is NO cross-round caching) → decide →
next run. Each round is a fresh workflow process. The soft-cap-10 checkpoint
happens at the coordinator level via `AskUserQuestion` BETWEEN runs (a workflow
cannot prompt mid-run); the hard-15 cap is enforced by the coordinator and
double-guarded by a round-counter arg the script refuses past 15.

**Three-phase architecture (per round):**

1. **CONTEXT AGENT** (`agent(contextBrief, {model:"sonnet"})`, first call) —
   builds the shared context pack so the seats don't each re-read the target. On
   round 1 it assembles a comprehensive pack (target files, prior history via the
   handoff path passed in `args`, scope declaration, line anchors) and does the
   graphify freshness check HERE ONLY (never per-round). On round >1 it builds an
   INCREMENTAL pack (prior pack + findings + fixes applied + reinvestigation
   instructions) without re-reading targets in full. Output = a context-pack FILE
   (path in the structured output) — the seats' shared source. The prior pack is
   an INPUT, not a cache (no cross-round caching preserved).

2. **THE DUEL** — *2a independent investigation*: the TRIO runs in parallel over
   the context pack ONLY (`parallel([...])`), each seat anchored to its lens but
   investigating independently (independence is load-bearing — non-anchored
   divergent seats are what catch the late-round P0s). *2b structured argument*:
   each seat receives the other seats' finding arrays and responds per finding
   with `refute` (file:line counter-evidence) / `corroborate` / `escalate`. Two
   `parallel()` waves; Codex participates identically via staged file I/O (no
   live channel).

3. **CONVERGE & CONFIRM** — VERDICT_SCHEMA dedup; the 2b responses feed
   adjudication (≥2-of-3 + argument outcomes, per the round governance).
   **RESPAWN-ON-DRIFT — OBJECTIVE criteria ONLY** (dissent is NEVER drift;
   dissents go to 2b): (1) branch/SHA mismatch vs the `targetSHA` arg; (2) wrong
   scope audited; (3) schema-required `file:line` evidence missing; (4)
   VERDICT_SCHEMA parse failure. A respawned seat gets the corrected pack + a
   drift-reason code + its offending output — NOT peer findings (contamination).
   A respawn counts against the one-retry-per-seat quota.

**Dynamic-formation args** the workflow accepts: `{seats, multiplier,
contextMode, argue, respawnQuota}` (seats = the roster from the availability
matrix; multiplier = 1 for the base loop, ≥2 for deadly-loop-multi; contextMode
= initial|incremental; argue = run phase 2b; respawnQuota = the per-seat retry
budget). deadly-loop-multi is the same script with `multiplier > 1`.

**Trio seats** are spawned per the canonical forms in `references/MODEL-POLICY.md`:
`agent(brief, {model:"sonnet", effort:"xhigh"})` / `agent(brief, {model:"opus"})` /
`agent(brief, {agentType:"codex:codex-rescue"})`. Fable routing is
policy-disabled (see `references/MODEL-POLICY.md`) — the Reviewer seat is fixed
Sonnet 5, falling back to Opus only if Sonnet 5 itself is unavailable or
rate-limited, never routed to `fable`. The script begins with the codex
availability probe (the MODEL-POLICY Node probe) and seats the Opus
adversarial fallback if Codex is absent.

**Workflow consent friction (stated honestly):** each Workflow call may require
harness consent unless pre-allowed — a 7-round loop can mean up to 7 prompts. Use
the skill-invocation opt-in path to pre-allow if running many rounds. If Workflow
consent is unavailable, take the plain Agent-tool path (Phases A–D) — the
coordinator spawns the trio directly and passes the context-pack path in the
briefs. Guard-coverage boundary: whether Workflow-internal `agent()` spawns fire
the Agent/Task PreToolUse hooks is environment-dependent; the script ships
explicit `model` OPTIONS on every brief so routing is correct regardless.

## Reference templates (optional, add incrementally)

A `references/` directory can hold fillable templates as the protocol matures:
- `ROUND-PROMPT-TEMPLATE.md` — fillable Reviewer + Auditor + Critic skeletons
- `WAVE-ORCHESTRATOR-TEMPLATE.md` — fillable orchestrator prompt
- `HANDOFF-DOC-TEMPLATE.md` — initial handoff doc structure
- `VALIDATION-CHECKLIST.md` — by file type
- `MERGE-ORDER-DECISION-TREE.md` — how to determine merge order from PR diff overlap

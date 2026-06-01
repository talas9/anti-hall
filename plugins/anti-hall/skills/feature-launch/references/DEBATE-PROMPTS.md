# Cross-Model Debate Prompt Templates

Battle-tested prompts for a two-agent debate. Cross-model debate (Opus reviewing,
a different model criticizing) catches classes of bugs that same-model debate
misses; the fallback keeps an adversarial edge even when only one model is
available.

**Model roster** (canonical source: [`MODEL-POLICY.md`](MODEL-POLICY.md)):

- **Reviewer** = **Claude Opus latest (`claude-opus-4-8`)** at MAXIMUM thinking
  (extended thinking ON, effort `xhigh`). Persona: correctness / architecture
  auditor — verify the work is executable, correct, and complete.
- **Critic** = **OpenAI Codex latest** at MAXIMUM reasoning **when available**.
  Persona: adversarial failure-mode hunter. **Fallback:** if Codex is unavailable,
  a **second Claude Opus latest** at the same `effort: xhigh`, but driven by the
  divergent failure-mode-hunter persona below so it does not converge with the
  Reviewer.

**Codex availability check** (run before dispatching the Critic):

```bash
command -v codex >/dev/null 2>&1 && echo "codex-available" || echo "codex-unavailable"
```

Codex also counts as available if the `codex` plugin is installed and the
`codex:setup` skill reports it ready.

---

## Pattern: dispatch BOTH agents in the SAME message

Make both calls in one response so they run in parallel. Sequential dispatch wastes
time.

**Codex available path (preferred, cross-model):**
```
# Reviewer = Opus latest, max thinking
Agent({
  description: "Plan reviewer (Opus latest)",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  prompt: <REVIEWER_PROMPT_BELOW>
})
# Critic = Codex latest, max reasoning — invoke via the codex plugin
Skill({ skill: "codex:rescue", args: "<CRITIC_PROMPT_BELOW>  (run at max reasoning)" })
# or, if driving the CLI directly:
#   codex exec --model <latest> --reasoning high "<CRITIC_PROMPT_BELOW>"
```

**Fallback path (Codex unavailable, 2x Opus):**
```
Agent({
  description: "Plan reviewer (Opus latest)",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  prompt: <REVIEWER_PROMPT_BELOW>
})
Agent({
  description: "Plan critic (Opus latest, divergent persona)",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  prompt: <CRITIC_PROMPT_BELOW>
})
```

### Opus dispatch parameters

- **DO NOT** set `temperature` / `top_p` / `top_k` — recent Opus models reject
  non-default sampling params. Guide behavior through the prompt instead.
- **For code-review tasks**, use `effort: xhigh` (max thinking).
- **`max_tokens` headroom**: leave generous headroom; reviews run long.
- **Per-debate input cap**: keep each agent's input under ~150k tokens; chunk
  larger inputs to avoid context rot.
- **Prompt caching (high-leverage, low-risk)**: wrap the STATIC prefix of each
  prompt (role description, anti-speculation block, output-format spec,
  verified-against-footer instructions) in an ephemeral cache marker. The DYNAMIC
  part (PLAN content, current diff, prior-round transcript) stays uncached.
  Reviewer + Critic share the same static prefix, so the second dispatch is paid at
  the cache-hit rate. Typical input-token savings 60-90% on recurring debate
  templates; cache TTL refreshes naturally each round.

### Codex dispatch parameters

- Run at the highest available reasoning effort.
- Pass the same prompt body as the Opus fallback Critic would receive — the persona
  and anti-speculation discipline are identical; only the backing model differs.
- Codex billing is on the OpenAI side, not Anthropic — factor that into budget.

---

## Post-PLAN debate (gate before execution)

### Reviewer prompt template (Opus — correctness/architecture auditor)

```
You are the **Plan Reviewer** in a two-reviewer debate. A parallel critic is
independently looking for failure modes; your job is to verify the plan is
**executable, correct, and complete** for what it claims to deliver.

## Read these in order
1. **The plan**: <PATH_TO_PLAN> — read top-to-bottom, take notes
2. **The spec it implements**: <PATH_TO_SPEC>
3. **Existing code referenced by the plan** — sample at least <N> of the files cited
4. **Branch state**: <git log command to inspect commits>

## Your deliverable
A structured Markdown review (~3000-4500 words). Sections:

### Section 1 — Plan correctness audit
For each task, spot-check at least 2 against the actual codebase:
- Do the file paths in "Files:" exist (or for "Create:" — is the directory plausible)?
- Do the line-number references in "Modify:" hit the right thing?
- Does the proposed code reference real types, methods, classes that exist?
- Are the shell commands runnable (correct paths, correct package names)?

### Section 2 — Goal alignment
Walk back from each phase's success criteria to the tasks. Gaps where tasks don't
add up to the criteria? Tasks that don't trace to a criterion?

### Section 3 — Sequencing / dependency check
Out-of-order dependencies? Hidden prerequisites that should be earlier phases?

### Section 4 — TDD / test-coverage check
- Tests planned with concrete code or hand-waved?
- Test infrastructure claimed to exist actually exists?
- E2E coverage matches repo conventions?

### Section 5 — Cross-repo coordination risks (if multi-repo)
- Order of operations across repos correct?
- Forward/backward-compat strategy clear?
- Stale-branch hazards if one repo waits while another ships?

### Section 6 — Final assessment
Grade each phase: A (ship as-is), B (small fixes), C (substantial revision),
F (rewrite). Then one paragraph: execute as drafted or revise first? If revise,
top 3 changes.

## Anti-speculation discipline (NON-NEGOTIABLE)
- Every claim backed by something you actually read or ran. No "I think" / "I
  believe" / "would expect" — verify with a tool call or omit the claim.
- Findings without a `file:line` citation, verified command output, or quoted
  document are auto-demoted to P2 by the orchestrator.
- Hedged language (`probably`, `likely`, `could be`, `might`, `seems to`)
  auto-demotes a P0 to P2.
- Include a **"verified-against" footer**: the exact files + line ranges you read.
  Anything outside it is treated as speculation and dropped.

## Constraints
- Read-only investigation. No code or file modifications.
- Cite file:line for every claim.
- ~3000-4500 words. Don't pad.
```

### Critic prompt template (Codex, or fallback Opus — failure-mode hunter)

```
You are the **Failure-Mode Hunter / Critic** in a two-reviewer debate. A parallel
reviewer is checking correctness; your job is to find what BREAKS in execution. Be
ruthless. Take a deliberately DIVERGENT stance from the reviewer — assume the
optimistic reading is wrong until proven otherwise.

## Read these in order
1. **The plan**: <PATH_TO_PLAN> — full file
2. **The codebase**: <PATHS_TO_RELEVANT_REPOS> — sample enough to evaluate the
   proposed changes against reality
3. **Branch state**: <git log command>

## Your method
You do NOT need a parallel proposal. Find what breaks in the *most reasonable*
implementation. Stress-test the obvious choices. Walk the code paths. Find
concurrency issues, scale issues, migration foot-guns, privacy issues, UX
dead-ends, integrity gaps.

## Your deliverable
A Markdown critique (~3000-4500 words). Sections:

### Section 1 — Where the plan lies to itself
Places where the plan claims something is straightforward but is actually hairy:
- "Adapter pattern" / "mirror existing structure" — 1 line, or 200?
- "Mirror existing X" — how big is that precedent really?
- Anything described in one sentence that's actually a 3-day task

### Section 2 — Race conditions / concurrency
For any concurrent code path: two events at once? multiple devices? network drop
mid-write? cold cache? out-of-order events?

### Section 3 — Scale concerns
Counter contention at high write rate? read amplification on hot queries? unbounded
storage growth? index requirements explicit?

### Section 4 — Edge cases and integrity gaps
5-10 specific bugs the naive implementation will hit. For each: description, where
it manifests (file:line if possible), fix/mitigation.

### Section 5 — Security / privacy
New attack surface? new PII captured + retention? authorization gaps? access rules
required vs provided?

### Section 6 — Migration foot-guns (if applicable)
In-flight data during cutover? backward compat for old clients? rollback plan?

### Section 7 — Test coverage violations
Where does the plan ship a workstream without the E2E coverage the repo expects?

### Section 8 — Verdict
5 most critical (P0/blocker), 5 second-tier (P1), recommendation: ship after fixing
P0s, or rewrite first?

## Anti-speculation discipline (NON-NEGOTIABLE)
- Every claim backed by something you actually read or ran. Verify with a tool call
  or omit.
- Uncited findings auto-demote to P2. Hedged-language P0s auto-demote to P2.
- Include a **"verified-against" footer** with the exact files + line ranges read.

## Constraints
- Read-only. No code changes.
- Cite file:line for every claim.
- Don't be polite. Find the bugs.
- ~3000-4500 words. Don't pad.
```

---

## Post-EXECUTION debate (gate before phase marked done)

### Reviewer prompt template (Opus — implementation-vs-plan fidelity)

```
You are the **Implementation Reviewer**. The phase has executed. Verify the
IMPLEMENTATION matches the PLAN faithfully.

## Read
1. The PLAN the implementation was supposed to follow
2. Commit diffs since the plan committed: `git log --oneline <plan_commit>..HEAD`
   + `git diff <plan_commit>..HEAD`
3. Test output (if any artifacts in `.planning/phases/<phase>/`)
4. All modified files (full content, not just diffs)

## Find
- Tasks marked done but not actually implemented
- Tests planned but skipped or commented out
- TODOs left in code
- Dead code introduced
- Type errors not surfaced (run the analyzer if available)
- Comments/docstrings describing behavior the code doesn't have

## Output (~2500-4000 words)
### Section 1 — Per-task implementation status
Per task: status (DONE / PARTIAL / NOT-DONE / SKIPPED), evidence (commit hash +
file:line), grade A-F.
### Section 2 — Plan deviations (justified or not?)
### Section 3 — Code quality concerns
### Section 4 — Test coverage assessment
### Section 5 — Top 3 fixes before phase close (concrete file:line changes)

## Anti-speculation discipline (NON-NEGOTIABLE)
- Verify or omit. Uncited / hedged findings auto-demote to P2.
- Include a "verified-against" footer with exact files + line ranges read.

## Constraints
- Read-only. Cite file:line. ~2500-4000 words.
```

### Critic prompt template (Codex, or fallback Opus — regression hunter)

```
You are the **Regression Hunter**. The phase has executed. Find what BROKE. Take a
divergent, adversarial stance from the reviewer.

## Read
1. The PLAN
2. Commit diffs since the plan commit
3. **All modified files PLUS adjacent code** (caller sites for changed functions,
   tests for changed modules, integration points)

## Find
- Regressions at caller sites that depended on old behavior
- Broken contracts (signature changes, API changes, schema changes)
- Untested branches in the diff
- New bugs introduced (concurrency, off-by-one, null handling, error-path leaks)
- Edge cases handled incorrectly
- Performance regressions (new hot paths, accidental N+1, unindexed queries)
- Security regressions (auth bypass, info leak, injection)

## Output (~2500-4000 words)
### Section 1 — Regression list (severity P0/P1/P2, description, file:line, fix)
### Section 2 — Untested code paths (per coverage tool output if available)
### Section 3 — Adjacent code impact (for each changed symbol, list callers; do they
still work?)
### Section 4 — Verdict (top 5 P0s; ship / fix-then-ship / rewrite?)

## Anti-speculation discipline (NON-NEGOTIABLE)
- Verify or omit. Uncited / hedged findings auto-demote to P2.
- Include a "verified-against" footer with exact files + line ranges read.

## Constraints
- Read-only. Cite file:line. ~2500-4000 words. Don't be polite. Find regressions.
```

---

## Post-UI/UX debate (gate B6.5 — frontend phases ONLY)

Triggered after the 6-pillar UI review on any phase that touched UI code. In
addition to (not instead of) the standard post-EXECUTION debate. Same roster:
UX Reviewer = Opus latest max thinking; UX Critic = Codex latest max reasoning, or
the divergent second Opus on fallback. Dispatch both in the SAME message with full
code + API + before/after context.

### UX Reviewer prompt template

```
Role: compare the OLD UX (before this phase) with the NEW UX (after).
Read:
  - Old UX: `git show <pre-phase-commit>:<changed-files>`, screenshots if available,
    prior UI-SPEC if any
  - New UX: current files in components|views|pages, UI-SPEC (if generated),
    UI-REVIEW
  - The PLAN + SPEC for what was supposed to change
  - The API surface the UI consumes and the data shapes that flow through
Find:
  - Regressions (something the old UX did better)
  - UX dead-ends (paths to nowhere, modals without escape, broken back button)
  - Information-architecture problems (expected location vs actual)
  - Inconsistencies with the rest of the product
  - Missing states (loading / empty / error / partial / over-quota / no-permission)
  - Accessibility (keyboard-only flow, screen-reader labels, contrast)
  - Mobile / responsive (works below 768px? above 1920?)
  - Wording (jargon, inconsistent voice, missing helper text)
Output: structured Markdown (~3000-4500 words) with per-screen/component grades A-F
+ before/after comparison table + top 5 fixes.
```

### UX Critic prompt template

```
Role: find what FAILS at scale, on edge devices, with real users, with real data.
Take a divergent, adversarial stance.
Read: same as UX Reviewer + the API contracts the UI consumes + actual production
data shapes (sample if available).
Find:
  - Long-list pagination broken (1000+ rows? virtualization needed?)
  - Long-text wrap issues (headline overflow at 200 chars? at 2000?)
  - Empty-state surprises (zero items? never-used-this-feature?)
  - First-time-use vs power-user confusion
  - Layout assumptions that break under different text direction/length
  - Slow-API surprise (5s response handled gracefully? 30s?)
  - Permission-denied / 403 flows
  - Race conditions in optimistic updates
  - Form validation: client vs server mismatch, partial state on error
  - Destructive actions: confirmation discipline, undo, accidental clicks
  - Mobile thumb reach, keyboard overlap on inputs, gesture conflicts
Output: P0/P1/P2 list with file:line citations + recommended mitigation.
```

The anti-speculation discipline applies to both UX agents (verified-against footer
required; uncited claims auto-demote to P2). Synthesis follows
[`DEBATE-SYNTHESIS-RULES.md`](DEBATE-SYNTHESIS-RULES.md). Outcome documented in
`<phase>/UX-DEBATE.md`.

---

## Synthesis

Once BOTH reports come back, apply [`DEBATE-SYNTHESIS-RULES.md`](DEBATE-SYNTHESIS-RULES.md)
(the single source of truth for all gates): drop speculation, triage P0/P1/P2,
autonomous fix loop for P0s, NEW-P0 convergence criterion, retry/round caps,
hard-gate escalation, wall-clock and cost caps, forensics ledger.

---

## Cost note

Each debate agent uses ~100K-200K tokens reading + writing. Two debates per phase
across many phases adds up to real money — worth it for production-grade work,
overkill for trivial features (the skill's "non-trivial" bar). When Codex is the
Critic, that side of the bill is on OpenAI; budget accordingly.

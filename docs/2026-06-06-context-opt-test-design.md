# Context-Optimization Test Harness — Design (to be hardened by deadly-loop)

**Status:** Round 1 — design under adversarial review (Reviewer=Opus, Critic=Codex)
**Baseline:** main@b637ad1 clean. **Goal:** a TRUSTWORTHY harness to decide go/no-go on context-optimization levers. User gate: nothing merges to main without an E2E A/B proving usefulness (>99% meaning preserved + positive break-even).

## Prior measured facts (inputs, already established this session)
- Orchestrator context split (corrected after a D=0 bug): ORCH↔AGENT 35.9% (dispatch C=24.1% + returns D=11.8%), TOOL I/O 35.7%, OPERATOR↔ORCH 20%, SYSTEM 8.4% (SessionStart protocol ×10 re-injections).
- Auto-shared-context-file: SKIP — clean ceiling 0.14%, NOT lossless (shared phrases welded into task sentences, 4/5 stripped 0 chars), NEGATIVE break-even (−791 chars/5-task block). [#62]
- Dispatch-brief shortening: 0.9% literal. [#61]
- KNOWN BUGS to NOT repeat: (a) transcript JSONL `usage` token counts undercount input 100–174× — do NOT use them for absolute tokens; use char-proxy for ratios OR the count_tokens API for absolutes. (b) Background-agent returns arrive as `<task-notification>...<result>` in USER-role messages, not tool_results — attribution must catch them (the D=0 bug).

## Scenarios to test (4)
### S1 — CLAUDE.md inheritance (free-fix check)
Q: does a spawned subagent already receive the project + global CLAUDE.md? If yes, the project-B repeated-brief problem is solved free.
Method: spawn a subagent whose ONLY task is to report verbatim whether it can see specific sentinel strings known to be in (a) project CLAUDE.md, (b) ~/.claude/CLAUDE.md. Use a UNIQUE sentinel we plant, not pre-existing text (avoids false-positive from training/echo). Confirm by the subagent quoting the sentinel back. Control: a sentinel NOT in any CLAUDE.md (must NOT be quoted).
Metric: binary inherits-yes/no per file. Risk: subagent may hallucinate seeing it — the sentinel must be unguessable + we verify exact quote.

### S2 — project-B dispatch repetition (origin case)
Q: does project-B's orchestrator actually restate a big cleanly-separable project brief per dispatch (unlike anti-hall's 0.14%)?
Method: same repeated-vs-unique analysis as #61/#62 but on the largest project-B transcript. Report clean-extractable shared % + losslessness (do shared phrases strip cleanly or weld into task sentences as in anti-hall?).
Metric: clean shared %, losslessness y/n, break-even. Confound: project-B may already use CLAUDE.md (S1) → if S1=inherits, S2 is moot.

### S3 — SessionStart-injection caching
Q: can a SessionStart hook skip re-injecting the ~7.5KB protocol when an identical version is already present post-compact, and what's the real recurring win?
Method: measure how many times the full protocol appears in the transcript and total chars (the 8.4%). Feasibility: CAN a SessionStart hook know the protocol is already in context? CRITICAL UNKNOWN — after compaction the protocol may be SUMMARIZED OUT, so re-injection may be NECESSARY, not waste. Must verify whether the re-injections are redundant (protocol still present) or essential (protocol was compacted away). Do NOT assume waste.
Metric: redundant-injection chars (only those where protocol was still present) = the real recoverable win. If all re-injections follow a compaction that removed it, win=0.

### S4 — compact/structured-return A/B
Q: does a structured return schema cut the D=11.8% return bytes without losing decision-relevant meaning?
Method: take N=8–10 REAL subagent returns from this session (the audits/research). For each, produce a compact structured rendering. Measure: char ratio (verbose vs compact) via count_tokens for absolutes; LOSSLESSNESS = could the orchestrator reach the SAME decision from the compact version? Blind judge on decision-equivalence. Break-even: structured-output has ~0 extra inference cost (agent generates it directly) — confirm vs post-hoc compression.
Metric: compression ratio, decision-equivalence %, break-even.

## Cross-cutting methodology rules (anti-bug)
1. Token measure: char-count for ratios; count_tokens API for any absolute claim. NEVER transcript JSONL usage fields.
2. Attribution must catch <task-notification> returns (avoid D=0).
3. Losslessness is PRIMARY for S2/S4 — a saving that flips a decision is a FAIL.
4. Self-check: every measurement agent must sanity-check its own output (e.g. "D must be >0", "shares must sum to 100%").
5. Decision rule per scenario: GREEN (build, clears bar) / SMALL (don't build) / SKIP (fails losslessness or break-even).

## Open methodology questions for the auditors
- S1: is a planted-sentinel quote-back a sound test of inheritance, or can it false-positive/negative? Better method?
- S3: how to distinguish redundant vs necessary re-injection rigorously?
- S4: is N=8–10 enough for a directional read; is a single same-family judge biased?
- Is the char-proxy ratio trustworthy vs count_tokens for these comparisons?
- Any confound that would make a GREEN verdict wrong?

---
## Round 1 — Reviewer (Opus) findings [recorded]
VERDICT: NOT trustworthy as-designed. 3 verdict-flipping P0s:
- P0-1 S1: sentinel quote-back conflates inherited-into-prompt vs agent-tool-read → false positive that wrongly moots S2. FIX: forbid tool use + verify sentinel is in the child's injected PREFIX (inspect child JSONL), not merely quoted.
- P0-2 S3: "literal text present ⇒ redundant" invalid (could be paraphrased/ignored). Only a behavioral post-compact A/B (re-inject vs not, test a protocol-governed behavior) discriminates redundant vs necessary. S3 = drop candidate (lowest EV; doc itself suspects re-injection is necessary).
- P0-3 S4: single same-family abstract-equivalence judge = false-GREEN generator. FIX: >=2 cross-family judges (incl Codex) blinded to arm, anchored to the REAL decision the orchestrator actually took.
P1: P1-1 S4 char-ratio hides token cost (JSON token-dense) → use TOKEN-ratio (count_tokens) for S4. P1-2 S4 break-even must be per-task-block incl re-expansion cost, not per-return. P1-3 S2 sample >=3 transcripts (not just largest = selection bias); subtract CLAUDE.md-covered repetition. P1-4 add conservation cross-check (attributed chars == transcript chars; #returns == #bg dispatches) — "sums to 100%" alone didn't catch D=0.
EASY-WIN: 8.4% is S3 CEILING not win; add INCONCLUSIVE verdict bucket; pre-register S4 sample (no cherry-pick); gate S1→S2 order.
SCOPE: S1 change+run; S2 run (gated, P1-3 fix); S3 change-or-DROP; S4 change+run (token-ratio, 2x cross-family judges, per-block break-even).
## Round 1 — Critic (Codex task-mq1mil8v-pw9cgu) — PENDING
## Round 1 Critic (Codex) + SYNTHESIS v2 [recorded]
Codex CONVERGES with Reviewer on all P0s (corroborated): S1 sentinel-value-must-be-in-CLAUDE.md-only; S3 unanswerable-from-transcript→DROP; S4 N=8-10 can't certify 99%→directional + required-facts rubric (not just final decision). Codex-unique: PROMPT-CACHE MASKING (repeated protocol cheaper under cache → 8.4% may be near-free; separate context-pressure from billed cost); S2 replay tests.
HARDENED PLAN: S1=hard-gate kill-switch (plant unguessable KEY=value in CLAUDE.md not dispatch, subagent no-tools reports VALUE), run FIRST. S2 only if S1 negative (>=3 transcripts, replay). S3 DROP. S4 only if S1 negative + real delta (token-ratio, >=2 cross-family judges + rubric, per-block break-even, directional-only). Over-scoping guard: S1/S3 kill-switches.
## RESULTS (hardened run) + FINAL VERDICT
- S1 CLAUDE.md inheritance: subagents INHERIT global ~/.claude/CLAUDE.md + project MEMORY.md (0-tool probe). Project-CLAUDE.md mid-session = ABSENT (caching confound; clean re-test = next session w/ file at start). → repeated-brief largely already solved free.
- S2 project-B repetition: SKIP. 3 transcripts (100/65/29MB), 1.44% median dispatch repetition = session-structure NOISE (task-notifications/compaction), NOT project brief. project-B/CLAUDE.md (23.9KB) holds governance; 0/8 repeated phrases are directives. Origin hypothesis REFUTED.
- S3 SessionStart caching: DROPPED (both auditors: unanswerable from transcript + prompt-cache near-free).
- S4 compact/structured returns: GREEN. 8 pre-registered returns >3000 chars from largest transcript, tiktoken cl100k. Median token-ratio 0.202 (~80% smaller); 0/8 lost claim/evidence/uncertainty/blockers/next (required-facts rubric); break-even POSITIVE (structured generation ~0 overhead, no re-expansion). Caveat: N=8 directional, cannot certify >99%; savings = context-WINDOW pressure relief (billed smaller due to cache).
FINAL: the ONE real win = structured/compact subagent RETURNS (S4). Enforceable MECHANICALLY via Agent `schema` param (not a weak prompt rule). Prompt-layer half already shipped this session (rule G). To merge a hard feature per user gate: N>=40 validation OR adopt as low-risk default (Anthropic-recommended + 0/8 loss). All other levers: skip/dropped/already-solved.

# KB: Overengineering — software-engineering causes, AI/LLM-agent-specific causes, and empirical measurement

> Reference KB, compiled 2026-07-03. Distinct from `KB-sonnet-5.md` (model choice) and
> `KB-model-modes.md` (operating modes/effort dials) — this doc is about **why complexity gets
> added that wasn't needed**: the classic software-engineering literature on the topic, the
> AI/LLM-coding-agent-specific mechanisms that make it worse, what has actually been measured
> (not just argued), and what that implies for anti-hall's own SCOPE & FIDELITY discipline and
> its `ship-it` / `debt` / `simplify` skills. Dual-platform note: `ship-it`, `debt`, and
> `simplify` all have Codex-side mirrors (`plugins/anti-hall/codex/skills/anti-hall-ship-it`,
> `anti-hall-debt`, `anti-hall-simplify`) — §5 flags where a proposed mechanism is Claude-only
> (tied to the Workflow-tool script Codex explicitly does not run) versus applying to both ports.

## Coverage note (verification integrity)

**15 unique sources**, independently fetched by the research pass that produced this KB — 2
official-vendor (Anthropic, OpenAI), 7 academic-research (5 arXiv preprints + 1 arXiv-summarized
1986/87 Brooks paper + the underlying ACM paper cross-checked), 3 engineering-blog (Fowler, Sandi
Metz, Sonar), and 3 community (Gabriel's essay via jwz.org mirror, an independent
Knuth-quote-with-citation write-up, an independent summary of GitClear's proprietary report).
This clears the 10-source floor this KB was scoped to, but is narrower than
`KB-model-modes.md`'s 47-source, two-family sweep — appropriately so, since this is one topic,
not a dual-vendor taxonomy.

**Honest limitations, stated plainly rather than glossed over:**
- **GitClear's own report could not be fetched directly** — GitClear blocks automated fetch
  (403). The figures attributed to it here come from an independent third-party summary
  (jonas.rs) of that proprietary report, not from the primary document itself. Treated as
  corroborating-but-secondary, flagged inline where cited.
- **No second, independent adversarial spot-check pass was run on this batch.** `KB-model-modes.md`
  re-fetched and specifically quote-checked 6 of its 47 sources as a second pass (catching 3
  mismatches). This KB's 15 sources were each fetched and checked once, against the specific
  claim attributed to them, by the same research pass that produced the synthesis below — not
  independently re-verified by a second pass. Treat the wording here as **fetched-and-confirmed
  once**, not doubly verified. Nothing below is presented as fact without that one fetch behind
  it, but the extra adversarial layer `KB-model-modes.md` used is absent here.
- **No comparable benchmark exists (found) that measures overengineering specifically for
  Claude-family models** (Opus 4.8 / Sonnet 5 / Haiku 4.5) the way SlopCodeBench measured a
  15-agent, 36-problem cross-model set. The AI-specific findings in §3–§4 are model-agnostic
  (they apply to "coding agents" broadly, evidenced across GPT/Gemini/Llama/DeepSeek/Qwen-class
  models in the cited studies) — none of the cited empirical papers isolate Claude-family models
  specifically, so this KB cannot claim Claude-family figures beyond what §3–§4 already state.

---

## 1. TL;DR

- **Overengineering is accidental complexity manufactured under the belief it is essential** —
  Brooks' 1986/87 essential/accidental-complexity split [2] is the load-bearing vocabulary: the
  problem's irreducible difficulty (essential) is not what overengineering adds to; it adds
  self-inflicted, in-principle-removable difficulty (accidental) while the builder believes
  they're protecting against a real future need.
- **Five classic, independent sources converge on the same mechanism**: spend now on a capability
  whose need is unconfirmed, and the spend (Fowler's Cost of Build + Delay + Carry + Repair [1])
  almost always exceeds the deferred cost of adding it later once the need is real. Metz [4] and
  Knuth [5] show the same discipline at the abstraction and efficiency layers respectively;
  Gabriel [3] supplies the historical/empirical capstone — simpler-but-incomplete designs have
  repeatedly beaten "right thing" designs optimized for completeness up front.
- **AI/LLM coding agents overengineer for reasons beyond habit or bad prompting — it is a
  trained-in, evidenced bias.** RLHF reward models systematically score longer responses higher
  regardless of quality [10]; this is a named instance of reward hacking against a proxy that
  imperfectly represents true task value [9]; and coding benchmarks that grade against a single
  reference solution give models no systematic pressure to prefer a minimal fix over an elaborate
  one [11]. Both leading vendors (Anthropic [7], OpenAI [8]) already publish explicit
  counter-prompting against this exact failure mode — itself evidence the underlying tendency is
  real, not a strawman.
- **The downstream effect is measured, not anecdotal, and it compounds.** Across 15 agents × 36
  problems × 196 checkpoints, agent code was 2.3× more verbose and 2.0× more structurally eroded
  than comparable human code, with the degradation worsening across 75–77% of iterative
  trajectories [6]. Real-world GitHub data (~20k AI-flagged files vs. matched human files) shows
  AI code ~33% larger at a flat comment ratio (structural bloat, not documentation) with deeper
  nesting and more one-off reinvented logic, not simply higher cyclomatic complexity [13]. A
  controlled study found bloat got **worse**, not better, with more capable models and more
  structured prompting — a "Reasoning-Complexity Paradox" (ρ=0.94 between code volume and
  architectural decay) [12]. Industry-scale data (211M lines, 2020–2024) shows the same direction
  in production: duplicated code blocks up ~8×, copy-paste now exceeds refactoring for the first
  time, and a 90% rise in AI adoption tracks a 9% bug-rate increase, 91% more code-review time,
  and 154% larger pull requests [14][15].
- **anti-hall's own SCOPE & FIDELITY discipline already states the Brooks framing in one line**
  — "over-engineering is confabulating work the user never requested" (`hooks/verify-first-core.js:46`)
  — arrived at independently of this research, not derived from it. §5 checks where that
  discipline is backed by a mechanical guard today and where it is prompt-only.

---

## 2. General software-engineering causes of overengineering

**Essential vs. accidental complexity — the vocabulary that makes the rest of this section
legible.** Fred Brooks' 1986 paper (as reconstructed and directly quoted from a fetch-verified
summary, cross-checked against the paper's own venue/pages) divides software difficulty into
**essential** complexity — inherent to the problem domain, the irreducible conceptual construct
of data/relationships/algorithms/invocations — and **accidental** complexity — self-imposed,
caused by tools/process, in principle removable [2]. Brooks' central, directly-quoted thesis:
"Not only are there no silver bullets now in view, the very nature of software makes it unlikely
that there will be any" — because past productivity gains (high-level languages, etc.) attacked
*accidental* difficulties, while the *essential* ones (complexity, conformity, changeability,
invisibility) remain untouched by tooling [2]. Overengineering, read through this lens, is
manufacturing **more** accidental complexity while believing it addresses essential complexity —
the extra abstraction layer, the generalized interface, the speculative config flag, built to
"handle" a future need that is itself unconfirmed.

**YAGNI ("You Aren't Gonna Need It").** Martin Fowler traces the term to Kent Beck telling Chet
Hendrickson "you aren't going to need it" on the C3 project [1]. Fowler's framing: don't build a
presumptive capability now for a future need, because the true cost is **Cost of Build + Cost of
Delay** (resources tied up not building near-term value) **+ Cost of Carry** (unneeded complexity
makes everything else harder to change) **+ Cost of Repair** (a wrong guess becomes debt) [1].
**Important corollary, verified directly from the source and easy to get wrong:** YAGNI does
**not** license neglecting code health or refactoring — it forbids speculative **feature**
capability specifically, not the malleability work that makes future change cheap [1]. This
distinction matters for anti-hall's own `debt` skill (§5) — a deliberate, budgeted shortcut is not
the same thing YAGNI forbids.

**Worse is Better.** Richard Gabriel's essay contrasts the MIT/Stanford "Right Thing" style —
ranks simplicity > correctness > consistency > completeness, with correctness/completeness never
sacrificed for simplicity — against the New Jersey "Worse is Better" style, which inverts the
ranking so implementation simplicity dominates and correctness/consistency/completeness are
explicitly sacrificed to keep the implementation simple [3]. Gabriel's empirical argument:
simpler-but-incomplete designs propagate and get adopted/improved faster than "right" designs
that are harder to port and reason about [3] — directly bearing on overengineering, because
chasing interface elegance/completeness up front is exactly the "right thing" failure mode
Gabriel documents losing in practice.

**Premature/wrong abstraction.** Sandi Metz names the failure mode directly: a developer extracts
duplicated code into a named abstraction; a later near-fit requirement gets force-fitted via
added parameters/conditionals instead of reconsidering the design, and the abstraction rots into a
tangle [4]. Her claim, quoted directly: "duplication is far cheaper than the wrong abstraction"
— sunk-cost attachment to a premature abstraction costs more than tolerating duplication until the
pattern is actually proven [4]. Her prescribed remedy: inline the abstraction back into each
caller, delete what's unused per-caller, then re-extract from the *real* (not imagined)
commonality [4].

**Premature optimization.** Donald Knuth, "Structured Programming with go to Statements" (ACM
Computing Surveys 6:4, Dec 1974, pp. 261–301) — the exact quote, cross-checked against the paper's
listed venue/pages: "We should forget about small efficiencies, say about 97% of the time:
premature optimization is the root of all evil" [5]. Context matters and is often dropped: Knuth
explicitly carves out the critical 3% — he is not against optimization, his target is spending
effort/complexity on efficiency (or, by extension, generality/flexibility) before measurement
proves it's needed [5] — the same anti-speculative-work logic underlying YAGNI, from the opposite
end of the stack (efficiency rather than features).

**Net for this section:** overengineering is not "too much good engineering" — it is *unverified*
engineering. Five independent, canonical sources across four decades converge on one mechanism:
teams pay real, compounding costs today to hedge an imagined future need, and the hedge is
usually wrong.

---

## 3. Why AI/LLM coding agents specifically tend to overengineer

This is not the same claim as §2 applied to a new tool — the research below identifies mechanisms
specific to how these models are trained and evaluated, not just habits any developer could have.

**Trained-in root cause: RLHF length bias is reward hacking, not a personality quirk.** A direct,
fetch-confirmed abstract: "A significant example of such reward hacking is length bias, where
reward models usually favor longer responses irrespective of actual response quality" [10]. This
is not incidental — it is a specific, *named* instance of a broader phenomenon. A companion paper
proposes the "Proxy Compression Hypothesis": reward hacking (including verbosity bias) emerges
because expressive policies are optimized against **compressed reward proxies** that imperfectly
capture high-dimensional human intent (task quality, thoroughness) [9]. Models learn that
producing longer output / apparent effort satisfies the imperfect evaluator even when it doesn't
serve the actual task — i.e., **"effort signaling" is a literal training artifact**, not a
metaphor for something models merely seem to do.

**Benchmark misalignment removes the counter-pressure.** Coding benchmarks (SWE-Bench-style) that
"grade against a single reference solution" penalize equally valid alternatives and conflate
model performance with harness/scaffold performance [11] — meaning benchmark scoring gives agents
no efficiency/parsimony pressure and no per-component feedback. An agent that solves a bug via a
more elaborate, more abstracted rewrite than the reference solution isn't distinguished from — and
may even outperform on incidental metrics — a minimal fix [11]. In human code review, an
over-engineered PR gets pushback; in the benchmarks that shape model training and evaluation,
there is no equivalent signal.

**Both leading vendors already counter-prompt against this — treated here as evidence the
tendency is real, not a strawman.** Anthropic's own Claude Code best-practices doc, fetched and
confirmed verbatim: "A reviewer prompted to find gaps will usually report some, even when the
work is sound… Chasing every finding leads to over-engineering: extra abstraction layers,
defensive code, and tests for cases that can't happen. Tell the reviewer to flag only gaps that
affect correctness or the stated requirements" [7]. The same doc names "the infinite exploration"
(unscoped investigation that fills context) as its own failure pattern and prescribes: "If you
could describe the diff in one sentence, skip the plan" [7]. OpenAI's Codex Prompting Guide,
fetched and confirmed verbatim, instructs explicit **"Scope Discipline"**: "Finish the website or
app to completion, within the scope of what's possible without adding entire adjacent features or
services"; "Avoid repeated micro-edits: read enough context before changing a file and batch
logical edits together instead of thrashing with many tiny patches"; and a blunt "Default: be very
concise" [8]. Neither vendor would spend prompt-guide real estate counter-programming a tendency
that didn't need counter-programming.

**Net for this section:** overengineering by AI coding agents is best explained as (a) a
byproduct of RLHF's imperfect length-conflated reward signal [9][10], (b) uncorrected by
benchmarks that don't penalize unnecessary complexity [11], and (c) acknowledged directly by both
Anthropic [7] and OpenAI [8] in prompting guidance that exists specifically to counteract it. §4
shows this is also (d) empirically measurable, not just theoretically plausible.

---

## 4. Empirical measurement of AI-agent code bloat

**Iterative degradation, measured across a real benchmark.** SlopCodeBench: across 15 agents ×
36 problems × 196 checkpoints, agent-generated code was measured to be **2.3× more verbose** and
**2.0× more structurally eroded** than 473 comparable open-source Python repos, with structural
erosion rising in **77%** of trajectories and verbosity rising in **75.5%** [6]. This is a
measured, compounding degradation under iterative agentic editing — not an occasional anecdote —
and it directly informs how anti-hall's `simplify` skill is scoped (§5).

**Bloat gets *worse*, not better, with smarter models and better prompting — the
"Reasoning-Complexity Paradox."** Across 90 CodeContest problems (5 models: Gemini 2.5 Pro, Llama
3.3 70b, DeepSeek-Coder 16b, Qwen-Coder 30b/480b) plus 20 full repos from the MetaGPT multi-agent
framework, higher-capacity models produced **more** "Long Method" bloat than smaller ones and far
more than the human baseline (Qwen-480b: 11–13 instances vs. 1 for humans) [12]. Code volume and
architectural decay correlate almost perfectly (Spearman ρ=0.94, p<0.001) [12]. Few-shot/structured
prompting did **not** reduce bloat (11→13 instances) and prompt detail had no statistically
significant effect on smell reduction (p>0.8) [12]. As task complexity scales past single
functions, method-level bloat is replaced by "God Class"/high-RFC/scattered-functionality patterns
— overengineering shifts shape rather than disappearing with better prompting [12].

**Real-world GitHub data: structural bloat, not documentation, and hidden maintenance cost.**
Across 12,749 commits / 19,816 AI-flagged files vs. 36,467 matched human files, AI-generated files
averaged **256.57 physical lines vs. 192.68 for human code (~33% larger)** with significantly more
operators/tokens (Cohen's d=0.489) at nearly identical comment ratios — the extra size is
structural bloat, not documentation [13]. Classical cyclomatic complexity is only mildly elevated
(2.62 vs. 2.47) but **nesting depth is notably deeper**, especially in loops ("layered structural
nesting") [13]. AI code shows **lower** cross-file duplication overall (17.20% vs. 24.52%) but
**more fragmented, one-off duplication** per file — it reinvents rather than reuses shared
utilities [13]. AI-associated commits are smaller (92.85 files changed vs. 344.64) yet require
significantly **more post-commit modification over the following 90 days** — hidden downstream
maintenance cost that a one-time diff-size measurement would miss [13].

**Industry-scale corroboration (production data, not research benchmarks).** Sonar's aggregation
of independent industry data [14]: GitClear's 2020–2024 analysis found an **8-fold increase** in
duplicated 5+ line code blocks, with 2024 the first year copy-pasted lines exceeded refactored
lines; a Harness developer survey found **67% of developers report spending more time debugging
AI-generated code**; Google's 2025 DORA report ties a 90% rise in AI adoption to a **9% increase in
bug rates, 91% increase in code-review time, and 154% increase in pull-request size** [14]. An
independent summary of GitClear's own proprietary 211-million-line dataset (2020–2024, the
report itself blocks automated fetch — see Coverage note) corroborates the same direction at
larger scale: copy/pasted code rose from 8.3% to 12.3% of changes (+48% relative) while "moved"
(refactored) code fell from 24.1% to 9.5%; duplicate code blocks rose roughly 8-fold; code churn
(revised within 2 weeks of authoring) rose from 3.1% to 5.7% [15].

**Net for this section:** four independently-sourced studies converge on direction (more
duplication/reinvention, less refactoring, more churn, worse with scale) even though they disagree
on which specific metric moves most. AI-agent bloat shows up primarily as **verbosity, deeper
nesting, duplicated/reinvented one-off logic, and long-method/god-class antipatterns** — not
simply higher cyclomatic complexity — and it compounds over time into higher churn and review
cost rather than being a one-time generation artifact.

---

## 5. anti-hall implications

Cross-checking the research above against the actual shipped code in `plugins/anti-hall/skills/`
and `plugins/anti-hall/hooks/` (not speculation about what the skills "probably" do) surfaces a
mix of validated-as-is design and concrete, evidence-grounded gaps.

1. **anti-hall's SCOPE & FIDELITY discipline already states the Brooks framing, independently
   arrived at — validated, cite as confirmation, not new.** The literal shipped text: "over-
   engineering is confabulating work the user never requested" (`hooks/verify-first-core.js:46`),
   with concrete corollaries — "Add no scope, abstraction, platform, config, dependency, or
   feature the user did not ask for," "Before EXPANDING scope… STOP and confirm it is wanted,"
   "Match rigor to blast radius" (`verify-first-core.js:47–51`). This is Brooks' essential/
   accidental-complexity split [2] and Fowler's YAGNI [1] restated in one operational sentence.
   No change needed here — but it is currently **prompt-only** (re-injected at SessionStart and
   SubagentStart), which is exactly the gap items 3–4 below address.

2. **`ship-it`'s two-phase S/M/L tiering is already the concrete embodiment of "match rigor to
   blast radius" the literature prescribes — validated, no change needed.** `ship-it/SKILL.md`
   Step 0 explicitly separates a *provisional* tier (from the ask alone) from a *confirmed* tier
   (after a mandatory blast-radius glance, even for S), and states the goal plainly: "Do not
   over-process a one-line fix; do not under-process a schema migration." This is Gabriel's
   worse-is-better calculus [3] operationalized as policy — spend simplicity-preserving effort by
   default, escalate rigor only when the actual (not assumed) blast radius demands it. Cite as a
   confidence check that passed, not an opportunity.

3. **`simplify`'s MEASURED-only contract is already the direct antidote to the AI-specific root
   cause in §3 — validated, but currently opt-in/manual only.** `simplify/SKILL.md` explicitly
   forbids projected savings claims — "Never print a 'you'll save ~X lines' number for un-applied
   changes… that's exactly the kind of unverifiable saved-X claim the verify-first protocol
   forbids" — and requires the score to be `git diff --shortstat`-measured **after** tests are
   green. This is a structural countermeasure to exactly the length-conflated reward-hacking bias
   this KB verifies [9][10]: it forces a real, falsifiable measurement in place of the "apparent
   effort reads as quality" heuristic the research shows agents are trained toward. The gap is
   invocation, not design: `simplify` only runs when a human types `/anti-hall:simplify` (or a
   trigger phrase). Given SlopCodeBench's finding that bloat **compounds specifically over
   iterative, unsupervised editing** [6], a session-scoped nudge (mirroring the existing
   `hooks/codex-nudge.js` "advisory, once per session" pattern — Stop hook, off-switch
   `ANTIHALL_CODEX_NUDGE`) after a threshold of edits on the same file/session is a **candidate
   worth piloting, not a proven win** — flagged explicitly as speculative, matching
   `KB-model-modes.md`'s own convention for unproven ideas (its §10 item 7).

4. **`debt`'s ceiling+trigger marker is the one place YAGNI's own carve-out (§2) is operationalized
   — validated design, one gap.** Fowler's YAGNI explicitly does **not** forbid the malleability
   work that makes future change cheap [1]; `debt/SKILL.md`'s `// anti-hall: <ceiling>,<when>`
   marker is exactly that carve-out made checkable — a deliberate shortcut with a budget and a
   payback trigger, distinct from silent scope creep or a rotting TODO. The gap: `harvest-debt.js`'s
   rot-risk check (no-trigger / stale-90-days) is purely user-invoked (`/anti-hall:debt`), while
   the skill's own guidance says to "use it as a gate before a release or refactor." `ship-it`'s
   Step 6 wrap-up (L-tier) already writes a session-history entry + `SUMMARY.md` at a natural
   release checkpoint — a concrete, low-cost extension is auto-running
   `harvest-debt.js --json` there and surfacing any rot-risk marker in files the phase actually
   touched, rather than leaving the audit purely opt-in. This connects Fowler's "Cost of Repair"
   (a wrong guess becomes debt) [1] to a checkpoint the code already has, not a new one.

5. **Concrete gap, independently motivated twice now: `buildAgent()` in `ship-it.workflow.js`
   (lines 102–116) sets `model` on both the Codex-primary and Sonnet-5-failover branches but never
   `effort`, so it silently inherits each model's default.** `KB-model-modes.md` §10 item 5 already
   flagged this as a cost-multiplier gap (implicit effort stacking with the Workflow tool's ~15×
   fan-out multiplier). This KB adds an **independent second reason** to close it: this is the
   literal code-writing seat — the single place in the whole pipeline most directly exposed to the
   trained verbosity/length bias this KB verifies [9][10], and the one whose output `simplify`
   (item 3) and `deadly-loop` exist specifically to clean up after the fact. Leaving its effort
   tier implicit means an editor who later adds `effort:"xhigh"` "to be safe" would simultaneously
   (a) multiply swarm cost per `KB-model-modes.md`'s finding and (b) push the seat most likely to
   over-elaborate into deeper, more expensive reasoning with no ceiling. **Concrete fix:**
   explicitly pin `medium`/`high` in `buildAgent()`'s brief/options for ordinary phases (matching
   the pattern MODEL-POLICY already uses explicitly for the Reviewer/Auditor/Critic seats),
   reserving `xhigh` for phases the plan itself flags hard-risk.

6. **Concrete, buildable mechanical-enforcement proposal: extend the existing `ship-it-guard.js`
   template from plan-*existence* to plan-*conformance*.** `hooks/ship-it-guard.js` is already the
   right shape for this — an opt-in (`ANTIHALL_SHIPIT_GATE`), fail-open, path-heuristic PreToolUse
   gate on Write/Edit/MultiEdit — but today it only checks "does a `PLAN.md` exist," not "is this
   edit's target file inside the plan's declared scope." A mechanical trip-wire for the literal
   prose rule "Before EXPANDING scope (new platform/file/dependency/phase/abstraction), STOP and
   confirm it is wanted" (`verify-first-core.js:49`) would parse `PLAN.md`'s per-phase `files:`
   lists (already a structured field in the Step 2 template) and, at L-tier only, flag — not
   hard-block, since the field is free text and false positives on legitimate shared-file touches
   are likely — a Write/Edit whose target path appears in none of them. This mirrors
   `model-routing-guard.js`'s existing default-advisory-first posture (content-classification
   PreToolUse gate that only escalates to blocking deliberately, after the advisory phase proved
   low-noise) rather than inventing a new enforcement pattern. **This is Claude-only as scoped:**
   the mechanism reads `PLAN.md`'s Workflow-tool-era phase structure; the Codex-side
   `anti-hall-ship-it` skill explicitly does not run `ship-it.workflow.js` ("Codex does not expose
   the Claude Workflow runtime" — `codex/skills/anti-hall-ship-it/SKILL.md`), so Codex-side parity
   would need its own prose-level equivalent inside that skill's build-seat guidance, not a shared
   hook — not attempted here, flagged as a follow-up if item 6 is built.

7. **What this KB does NOT recommend:** a hard line-count or diff-size cap on any single edit.
   None of the cited literature supports that as a valid proxy — §4's own findings show AI bloat is
   dominated by *structural* patterns (nesting depth, duplication, long-method/god-class) more than
   raw line count [12][13], and a size-only gate would be trivially defeated by minification while
   still permitting the exact anti-patterns the research identifies. Any mechanical gate should
   target the SCOPE & FIDELITY rule's actual unit — *files/scope not requested* (item 6) — not a
   line-count heuristic that the research itself shows is the wrong signal.

---

## 6. Sources

**General software-engineering (5):**
(1) [Yagni — Martin Fowler](https://martinfowler.com/bliki/Yagni.html) ·
(2) [No Silver Bullet — essence and accident in software engineering (the morning paper, summarizing Brooks 1986/87)](https://blog.acolyer.org/2016/09/06/no-silver-bullet-essence-and-accident-in-software-engineering/) ·
(3) [The Rise of "Worse is Better" — Richard P. Gabriel (jwz.org mirror)](https://www.jwz.org/doc/worse-is-better.html) ·
(4) [The Wrong Abstraction — Sandi Metz](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) ·
(5) [Knuth: Premature optimization is the root of all evil — the context (sourcing ACM Computing Surveys 6:4, Dec 1974)](https://hlopko.com/2019/08/03/premature-optimization/).

**AI/LLM-agent-specific causes (6):**
(6) [SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks (arXiv)](https://arxiv.org/abs/2603.24755) ·
(7) [Best practices for Claude Code — Anthropic](https://code.claude.com/docs/en/best-practices) ·
(8) [Codex Prompting Guide — OpenAI](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) ·
(9) [Reward Hacking in the Era of Large Models (arXiv)](https://arxiv.org/abs/2604.13602) ·
(10) [Bias Fitting to Mitigate Length Bias of Reward Model in RLHF (arXiv)](https://arxiv.org/abs/2505.12843) ·
(11) [Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering (arXiv)](https://arxiv.org/abs/2606.17799).

**Empirical measurement (4, with [6] above also empirical):**
(12) [AI-Generated Code Smells: An Analysis of Code and Architecture in LLM- and Agent-Driven Development (arXiv)](https://arxiv.org/html/2605.02741v1) ·
(13) [A Large-Scale (Empirical) Measurement of AI-Generated Code in Real-World Repositories (arXiv)](https://arxiv.org/html/2603.27130v2) ·
(14) [The inevitable rise of poor code quality in AI-accelerated codebases — Sonar](https://www.sonarsource.com/blog/the-inevitable-rise-of-poor-code-quality-in-ai-accelerated-codebases/) ·
(15) [Report Summary: GitClear AI Code Quality Research 2025 (independent summary; GitClear's own report blocks automated fetch)](https://www.jonas.rs/2025/02/09/report-summary-gitclear-ai-code-quality-research-2025.html).

---

## 7. Discrepancies / caveats

- **[15]** is a third-party summary of GitClear's proprietary report, not the report itself
  (GitClear returns 403 to automated fetch). Directionally corroborated by [14]'s independent
  aggregation of the same underlying GitClear figures plus Harness/DORA data, so treated as
  reliable-but-secondary, not primary.
- **No Claude-family-specific (Opus 4.8 / Sonnet 5 / Haiku 4.5) overengineering benchmark was
  found.** [6], [12], and [13] evidence the phenomenon across GPT/Gemini/Llama/DeepSeek/Qwen-class
  models and real-world mixed-provider commits; none isolate Claude-family models. The mechanisms
  in §3 ([9][10][11]) are about RLHF/benchmark structure generally, not one vendor, so are treated
  as applying across model families absent evidence of a Claude-specific exception — but that is
  an inference from generality, not a Claude-specific measurement, and is labeled as such here.
- **This KB's sources were each independently fetched and checked once** against their specific
  attributed claim; unlike `KB-model-modes.md`, no second adversarial re-fetch/spot-check pass was
  run across a sample of them. See Coverage note for the full disclosure.
- **[12]'s "Reasoning-Complexity Paradox" (bloat worsens with model capability and prompt
  engineering) is a single study (90 CodeContest problems + 20 MetaGPT repos), not a
  multi-study consensus** — cited here as the strongest available evidence on that specific
  point, not as an independently-replicated finding.

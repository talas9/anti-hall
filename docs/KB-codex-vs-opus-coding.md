# KB — Codex (GPT-5.5) vs Claude Opus 4.8 for coding

> Reference knowledge base for **dividing coding work between OpenAI Codex (GPT-5.5) and
> Claude Opus 4.8** — which to route where, and whether the "Codex = apply, Opus = think"
> framing holds. Compiled from 13 recent sources (Feb–Jun 2026), 2 official.
>
> **Provenance caveat:** these are *sourced web claims*, not benchmarks re-run in-repo.
> OpenAI's GPT-5.5 page 403'd on fetch (numbers corroborated by secondary sources);
> several scores are ranges; no Reddit/HN thread signal surfaced (blog/dev.to only).
> Treat the numbers as directional and harness-dependent, not exact.
>
> **Scope note (2026-07-01):** this KB was compiled 2026-06-29, one day before Claude
> Sonnet 5's release (2026-06-30), and frames routing as a two-way Opus-4.8-vs-Codex-GPT-5.5
> choice — Sonnet 5 was not in scope. It is now the anti-hall **primary implementer failover**
> and handles most multi-file/arch-aware work (`docs/KB-sonnet-5.md` §5); Opus is current
> guidance's escalation tier, reserved for multi-repo refactors with subtle invariants
> (§6), not general multi-file refactors as the "Keep on Opus 4.8" section below might
> suggest read in isolation. See `docs/KB-sonnet-5.md` §5–§7 for current routing.

## TL;DR (verdict)

- On **repo-scale real-world engineering** (SWE-bench Pro), **Opus 4.8 leads by ~10.6 pts**
  (69.2% vs 58.6%) — a meaningful gap. On **terminal/CLI agent loops** (Terminal-Bench),
  **GPT-5.5 edges Opus by 3–5 pts**. SWE-bench Verified is ~tied (~88%).
- **Opus 4.8** = cleaner/more idiomatic code, architecture, multi-file coherence,
  self-correction, convention-following, long-context. **Slow + verbose (≈3.35× tokens).**
- **GPT-5.5 (Codex)** = terminal/DevOps, token efficiency, ~50% faster, long autonomous
  parallel runs, catching subtle low-level bugs (off-by-one, races). **Stateless, drifts
  from project conventions.**
- The **"Codex = apply / Opus = think" framing is PARTIAL** — a good *routing heuristic*,
  not a *capability boundary*. GPT-5.5 plans fine autonomously (73.1% Expert-SWE, 25-hr
  runs); Opus can apply. The real split is **quality/architecture/self-correction (Opus)
  vs speed/efficiency/parallelism/terminal (Codex)**.

## Benchmark table (sourced; harness-dependent)

| Model | SWE-bench Verified | SWE-bench Pro | Terminal-Bench 2.1 | LiveBench | Expert-SWE |
|---|---|---|---|---|---|
| Claude Opus 4.8 | ~88.6% | **69.2%** | 74.6–78.9%* | 77.2% | — |
| GPT-5.5 (Codex) | 87.6–88.7%* | 58.6% | **78.2–83.4%*** | **80.7%** | **73.1%** |

\*Terminal-Bench varies by harness: raw model GPT-5.5 78.2% / Opus 74.6%; with Codex-CLI
harness GPT-5.5 = 83.4%, with Claude-Code harness Opus = 78.9%. Per source [12], harness
engineering explains most of the gap — "harness matters more than model for CLI work."

## Codex (GPT-5.5) is best at

- Terminal / shell / DevOps loops — Terminal-Bench lead [1][5][12]
- Token efficiency (≈3.35× fewer output tokens/task) and ~50% faster runtime [4]
- Long-horizon autonomous parallel runs (demonstrated 25 hr, ~13M tokens, ~30K LOC) [1][13]
- Mechanical, well-specified tasks: bug fixes, migrations, overnight batch, PR-from-issue [6][7]
- Catching subtle low-level bugs — "fewer off-by-one errors and race conditions" [9]
- Multi-agent cloud orchestration with native worktrees / sandbox [8]
- Cost-per-completed-task (lower token volume offsets the $30/M vs $25/M output price) [4][5]

## Claude Opus 4.8 is best at

- Real-world GitHub issue resolution — SWE-bench Pro +10.6 pts [3][5][10]
- Repository-scale understanding + multi-file refactors / migrations [2][5]
- Frontend/app code *quality* — wins blind code-quality reviews even though 65% of devs
  prefer Codex for daily *convenience* [3]
- Self-correction / code honesty — "4× less likely to let flawed code pass"; pushes back
  on unsound plans [2][4]
- Planning & orchestration — routed to the "Planning/Coordination" slot in multi-model
  guides [8][9]
- Long-context (GraphWalks 1M: 68.1% vs 45.4%) [4]
- Convention adherence (honors CLAUDE.md / project standards; doesn't restart cold) [6]

## "Codex = apply / Opus = think": PARTIAL

**For:** practitioner hybrids consistently put Opus on planning and Codex on execution —
"Claude plans → Codex executes → Claude reviews" [6][9]; Augment routes Opus to
Planning/Coordination [8]; Composio splits "Codex = terminal/CLI, Opus = complex app/
frontend" [4]; Anthropic's own language for Opus is planner-shaped [2].

**Against (why it oversimplifies):** GPT-5.5 scores 73.1% on Expert-SWE (≈20-hr human
tasks needing sustained planning) [1]; Codex has its own Plan Mode / PLANS.md and multi-hour
autonomous runs [1][13]; "Codex code straight up has fewer bugs" = real cognitive work, not
diff-application [9]; some guides put *Sonnet* (a cheaper Claude) — not Codex — in the
implement slot, suggesting "apply" really means "cheaper model," not "Codex specifically" [8].

**Synthesis:** keep it as a routing heuristic; don't mistake it for a ceiling. Route by
*what matters for the task* (quality/architecture → Opus; speed/efficiency/terminal/parallel
→ Codex), not by a hard think-vs-apply wall.

## Cost / speed / context

| Dimension | Opus 4.8 | GPT-5.5 |
|---|---|---|
| Input / output price | $5/M · **$25/M** | $5/M · $30/M |
| Output verbosity | ≈3.35× more/task | baseline |
| Runtime (same task) | ~2× wall-clock | **~50% faster** |
| Effective cost/task | higher (verbosity; one build cited $28 [10]) | **lower** (fewer tokens) |
| Context | ~1M in / 128K out | ~1M in / 128K out (effective sometimes lower) |

## Failure modes

- **Codex:** foreign-to-project style, no learning across stateless sessions [6][9];
  context staleness when main moves [6]; long-run stalls / terminal hangs; occasional
  hallucinated library args [research]; some TypeScript errors [4].
- **Opus:** verbosity → expensive/slow, drains usage 5–10× faster than Sonnet [3][4];
  can freeze on some algorithmic tasks (regex 58+ min [10]); sometimes edits code unprompted
  when it reads a question as disagreement [3]; can add components but miss the wiring
  (e.g. not mounting a React component into `<App>`) [9].

## Recommended division of labor

**Route to Codex (GPT-5.5):** terminal/shell/DevOps; parallel background batch (multi-PR,
multi-issue overnight); well-specified independently-testable mechanical tasks (migrations,
scaffolding, boilerplate); CLI-heavy git/build work; cost-sensitive high-volume execution;
**second-opinion review for subtle correctness bugs** (off-by-one, races).

**Keep on Opus 4.8:** architecture & planning; ambiguous-requirement decomposition;
multi-file refactors / codebase-scale migrations; frontend/UI quality; self-review &
auditing; convention-aware work; unclear-root-cause debugging; multi-agent orchestration
(Opus as coordinator spawning Sonnet/Haiku).

**Cross-check (high value):** Opus plans → Codex executes → Opus reviews for style/architecture
[6][9]; and/or Codex reviews Opus output for low-level bugs while Opus reviews for design [9].
This is exactly the anti-hall TRIO Critic seat (Codex) + Reviewer/Auditor (Claude) pattern.

## Uncertain / not found

- Aider Polyglot for Opus **4.8** (only 4.5 = 89.4% found); LiveCodeBench for this exact pair;
  a single authoritative GPT-5.5 SWE-bench Verified number (OpenAI page 403'd, range 87.6–88.7%);
  algorithmic/competitive-programming head-to-head; Reddit/HN consensus (no thread signal).

## Sources

1. [OFFICIAL] Introducing GPT-5.5 — OpenAI — https://openai.com/index/introducing-gpt-5-5/
2. [OFFICIAL] Introducing Claude Opus 4.8 — Anthropic — https://www.anthropic.com/news/claude-opus-4-8
3. Claude Code vs Codex: 100+ Hours — Composio — https://composio.dev/content/claude-code-vs-openai-codex
4. Opus 4.8 vs GPT-5.5 Agentic Coding — Composio — https://composio.dev/content/opus-vs-gpt
5. Best AI Model for Coding (Jun 2026) — MorphLLM — https://www.morphllm.com/best-ai-model-for-coding
6. Codex vs Claude Code: The Honest Comparison — dev.to — https://dev.to/pockit_tools/openai-codex-vs-claude-code-in-2026-the-honest-comparison-nobodys-making-22c1
7. The Code Agent Orchestra — Addy Osmani — https://addyosmani.com/blog/code-agent-orchestra/
8. AI Model Routing Guide — Augment Code — https://www.augmentcode.com/guides/ai-model-routing-guide
9. Coding Agents in Feb 2026 — calv.info — https://calv.info/agents-feb-2026
10. Opus 4.8 vs GPT-5.5 — DataCamp — https://www.datacamp.com/blog/claude-opus-4-8-vs-gpt-5-5
11. Opus 4.8 vs GPT-5.5 compare — llm-stats — https://llm-stats.com/models/compare/claude-opus-4-8-vs-gpt-5.5
12. Terminal-Bench 2.1 June 2026 Landscape — codex.danielvaughan.com — https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/
13. GPT-5.5 masters agentic coding 82.7% — Interesting Engineering — https://interestingengineering.com/ai-robotics/opanai-gpt-5-5-agentic-coding-gains

_Compiled 2026-06-29 from a background research sweep; numbers are sourced, not re-run in-repo._

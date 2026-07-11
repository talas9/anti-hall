# KB: Claude Sonnet 5 + model routing (Opus 4.8 / Sonnet 5 / Haiku 4.5) — and the Codex parallel

> Reference KB. Benchmark numbers rest on third-party agreement (the Anthropic system-card PDF was
> unparseable at time of writing) and are tagged with sources; treat exact figures as directional
> until checked against the official model card. Model IDs and pricing are from Anthropic docs.
> Dual-platform note: anti-hall routes both Claude and Codex — the Codex-model table is in
> [§7](#7-codex-model-parallel-gpt-5x); orchestration parity is OMC ↔ OMX (see `KB-omc.md` /
> `KB-omx.md`).

## 1. TL;DR
- **Sonnet 5** (`claude-sonnet-5`, 2026-06-30) is a **clear win for implementation** — near-Opus
  coding at ~30–40% *real* savings (the ~40% sticker discount is eroded by a 1.3–1.4× tokenizer).
- **Sonnet 5 @xhigh ≈ Opus 4.8 @medium-to-high** (per §4's DataCamp citation — the source hedges
  across both tiers, not just @medium) — so it's a great **cheaper secondary** planning/review tier,
  but does **not** replace Opus on the hardest work.
- **Opus 4.8 stays ahead** on deep reasoning (GPQA +15.6), olympiad math (USAMO +17.2), and deep
  multi-file coding (SWE-bench Pro +6.0). Keep it for root-cause, architecture, top-level planning.
- **Haiku 4.5** stays the cheap, fast default (91–104 t/s, $1/$5) for trivial/mechanical/high-volume.

## 2. Model facts (from Anthropic docs)
| | Opus 4.8 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| Model ID | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` |
| Released | 2026-05-28 | 2026-06-30 | ~2025-10 |
| Price $/M (in / out) | $5 / $25 | **$3 / $15** ($2/$10 intro → Aug 31 2026) | **$1 / $5** |
| Context / max output | 1M / 128k | 1M / 128k (300k batch) | 200k / 64k |
| Thinking | adaptive, scales with `effort` | adaptive, scales with `effort` | extended thinking (explicit budget) |
| Claude Code/API default effort | `high` | `high` | n/a (no `effort` support) |
| Knowledge cutoff | Jan 2026 | Jan 2026 | Feb 2025 |

> **Correction (2026-07-01):** an earlier version of this KB claimed `xhigh` was the default effort
> for Opus 4.8/Sonnet 5. That was wrong — verified against the live official effort docs
> (`platform.claude.com/docs/en/build-with-claude/effort`, fetched 2026-07-01): **`high` is the
> default** ("produces exactly the same behavior as omitting the `effort` parameter entirely");
> `xhigh` is an available, non-default tier. Corrected below; see `docs/KB-token-usage-models.md`
> for the full effort-tier + billing research this correction came from.

Notes: the full API effort taxonomy is **five tiers** — `low`, `medium`, `high` (default), `xhigh`,
`max` — not a Sonnet-specific set. `xhigh` support is narrow: only Opus 4.8, Opus 4.7, and Sonnet 5
among the models in this KB (official). **Haiku 4.5 does not support the `effort` parameter (or
adaptive thinking) at all** — it's legacy manual `thinking:{budget_tokens}` only. Sonnet 5 does
**not** support `temperature` / `top_p` / `top_k`. Opus 4.8 and Sonnet 5 share the newer tokenizer
introduced at Opus 4.7 (official range: ~1.0–1.35× tokens vs pre-4.7 for the same text, "~30%"
aggregate; independent testing found up to ~1.47× for some content types — see
`docs/KB-token-usage-models.md` §3 for the full tokenizer research).

## 3. Benchmarks (source-tagged; directional)
| Benchmark | Opus 4.8 | Sonnet 5 | Haiku 4.5 | Winner |
|---|---|---|---|---|
| SWE-bench Verified | **88.6** | 72.7 (official) / 82.1 (ext. budget) | 73.3 | Opus |
| SWE-bench Pro | **69.2** | 63.2 | 39.5 | Opus +6.0 |
| GPQA Diamond | **93.6** | 78.0 | — | Opus +15.6 |
| USAMO 2026 | **96.7** | 79.5 | — | Opus +17.2 |
| HLE (no tools) | **49.8** | 43.2 | — | Opus +6.6 |
| HLE (with tools) | 57.9 | 57.4 | — | ~tie |
| OSWorld-Verified | **83.4** | 81.2 | — | ~tie (Opus +2.2) |
| Terminal-Bench 2.1 | 74.6* | **80.4** | — | Sonnet +5.8 |
| GDPval-AA v2 (knowledge work) | 1615 | **1618** | — | Sonnet +3 |
| MMLU-Pro / AIME | unconfirmed | unconfirmed | 72.4 / 80.7 | — |
| Output speed (t/s) | moderate (unmeasured) | 57 @high / 78.9 @max | **91–104** | Haiku |

*Terminal-Bench Opus figure is harness-dependent, not effort-dependent: 74.6 raw model vs 78.9 with
Claude-Code harness (see `docs/KB-codex-vs-opus-coding.md` §Benchmark table). The 82.7% figure
sometimes seen alongside this benchmark is GPT-5.5's (Interesting Engineering, source [13] in that
doc), not Opus's — do not conflate.

## 4. Effort-tier behavior
`low` (renames/greps/classification) · `medium` (coding, small refactors, tests) · `high` (default;
multi-file refactors, complex debugging) · `xhigh` (long agentic, exploratory) · `max`
(architecture, race conditions, security — confirmed for Opus; unconfirmed for Sonnet 5).

**Key finding:** "At its maxed-out `xhigh` reasoning level, Sonnet 5 performs roughly in line with
Opus 4.8's medium-to-high setting" (DataCamp). Effort alone does **not** close Sonnet 5 → Opus 4.8
to parity on the hardest tasks. Sonnet 5 @max: generation ~78.9 t/s but **TTFT ~163s** (deep
reasoning phase) — expensive and slow; avoid inside loops.

## 5. Decision matrix (task → model + effort)
| Task type | Model | Effort | Why |
|---|---|---|---|
| Trivial edit (rename, grep, format) | **Haiku 4.5** | — | 104 t/s, no reasoning overhead |
| Mechanical impl (CRUD, boilerplate) | **Haiku 4.5** | — | within Haiku's tier; ~80× cost edge on Opus |
| Standard impl (1–3 files, known stack) | **Sonnet 5** | medium/high | 63.2 SWE-Pro covers it; cheap |
| Complex impl (multi-file, arch-aware) | **Sonnet 5** | xhigh | closes most of the Opus gap; escalate only on failure |
| Deep debugging (races, subtle logic, security) | **Opus 4.8** | high | GPQA 93.6 vs 78; reasoning depth matters |
| Olympiad / proof-level math | **Opus 4.8** | high/max | USAMO +17.2 decisive |
| Architecture planning / design review | **Opus 4.8** | high/xhigh | HLE-no-tools +6.6 (deep constrained reasoning) |
| Correctness / safety review | **Opus 4.8** or **Codex** | high | GPQA edge; cross-model for independence |
| Long-horizon agentic (multi-turn, 1M ctx) | **Sonnet 5** | high | beats Opus on GDPval-AA v2 + terminal-bench, 40% cheaper |
| High-volume production agents (latency SLA) | **Haiku 4.5** / Sonnet 5 `low` | — | throughput |

## 6. Switch thresholds
- **Haiku → Sonnet 5** when: >2 inference hops; Haiku hallucinates field names / gets lost past
  ~50k ctx; needs post-Feb-2025 knowledge; needs >64k output or >200k input.
- **Sonnet 5 → Opus 4.8** when: GPQA/USAMO-class scientific/math reasoning is the bottleneck; formal
  proof / security audit / multi-repo refactor with subtle invariants; **Sonnet 5 @xhigh failed
  twice** on the same task; error blast-radius is high (prod security, compliance, correctness-
  critical path).
- **Do NOT use Opus for:** knowledge work, long-horizon agentic pipelines, terminal tasks,
  customer-facing chat — Sonnet 5 matches/beats it there at ~40% lower price.

## 7. anti-hall routing (Claude side)
Effective seat map (mirrored in `skills/MODEL-POLICY.md`):

| Seat | Model | Effort |
|---|---|---|
| Main coordinator | Opus 4.8 | — |
| **Implementation (code-apply)** | **Codex primary → Sonnet 5 failover** | Sonnet 5 @high on failover |
| Planning — L / top-level | Opus 4.8 | xhigh |
| Planning — M / secondary | Sonnet 5 | xhigh |
| deadly-loop Reviewer | Sonnet 5 | xhigh |
| deadly-loop Auditor | Opus 4.8 | high |
| deadly-loop Critic | Codex (Opus/Sonnet 5 if Codex implemented the diff) | — |
| Root-cause / deep debug | Opus 4.8 | high |
| Trivial | Haiku 4.5 | — |

**Rules:** (1) the code implementer and its correctness reviewer are **always different models**
(cross-model second opinion, no self-review); (2) Codex is primary implementer because it draws its
**own** limit (conserves the Claude weekly bucket) — **failover to Sonnet 5 on unavailable /
rate-limited / placeholder return; backoff, never retry-loop**; (3) **never run Sonnet 5 at `max`
inside a loop** (TTFT ~163s + cost); (4) the `sonnet` tier token now resolves to `claude-sonnet-5`.

## 8. Codex-model parallel (gpt-5.x) — for the Codex port
anti-hall ships a Codex-native port, so routing has a Codex mirror. **GPT-5.6 (Sol/Terra/Luna)
went GA 2026-07-09, superseding gpt-5.5/gpt-5.4 as the recommended tiers** — see
[`KB-gpt-5.6.md`](./KB-gpt-5.6.md) for full sourcing/confidence-labeling; this section reflects
that migration. `gpt-5.4-mini` is kept as the cheap-default tier (unchanged; still the cheapest
confirmed-priced option) alongside the new `gpt-5.6-luna` as a selective alternative.

**Model facts** (`KB-gpt-5.6.md` §1–2, PRIMARY-CONFIRMED for pricing/tier-ID/positioning; context
window, knowledge cutoff, and full effort-tier taxonomy were **not** independently re-confirmed for
GPT-5.6 and are marked accordingly — do not carry over the old gpt-5.5/gpt-5.4 numbers as fact):
| | gpt-5.6-sol (frontier) | gpt-5.6-terra (flagship) | gpt-5.4-mini | gpt-5.6-luna (alt.) |
|---|---|---|---|---|
| Price $/M (in / out) | $5 / $30 | $2.50 / $15 | $0.75 / $4.50 | $1 / $6 |
| Cached input $/M | $0.50 (confirmed) | [unverified] | $0.075 | [unverified] |
| Context | [unverified for GPT-5.6 — not re-confirmed, see `KB-gpt-5.6.md` §9] | [unverified] | 400k | [unverified] |
| Knowledge cutoff | [not stated in confirmed GPT-5.6 sourcing] | [not stated] | Aug 2025 | [not stated] |
| Max effort | documented `max`/"ultra" tier, Sol-only (2-1 vote, not unanimous — `KB-gpt-5.6.md` §1) | "standard reasoning-effort range," no documented `max` | high (likely) | "standard reasoning-effort range" |
| **Claude equivalent** | **Opus 4.8** | **Sonnet 5** | **Haiku 4.5** | **Haiku 4.5** |

**Reasoning effort:** `model_reasoning_effort` = `minimal | low | medium | high | xhigh` (Responses
API only; `medium` was the confirmed default for the gpt-5.5/gpt-5.4 generation). GPT-5.6-tier
effort defaults are **not independently confirmed** — treat the same `minimal/low/medium/high/xhigh`
scale as a working assumption pending direct verification, not a confirmed GPT-5.6 fact. Rough
parity: Codex `minimal/low` ≈ Claude thinking-off, `medium` ≈ Claude default, `high` ≈ ~8k budget,
`xhigh` ≈ 16k+ budget.

**Benchmarks** (directional; vendor vs standardized-harness noted). These are the last confirmed
figures for the **superseded** gpt-5.5/gpt-5.4/gpt-5.4-mini generation — GPT-5.6's own reported
benchmarks (Artificial Analysis Coding Agent Index: Sol scores 80; SWE-Bench Pro: Sol 64.6%, both
press-reported per `KB-gpt-5.6.md` §6) use different suites/formats and are **not directly
comparable** to the rows below; do not merge them into one table:
| Benchmark | gpt-5.5 | gpt-5.4 | gpt-5.4-mini |
|---|---|---|---|
| SWE-bench Verified | 88.7 (vendor) / 80.6 (LMC std) | 76.9 (LMC) | — |
| SWE-bench Pro | 58.6 | 59.1 (Scale SEAL) | 54.4* |
| GPQA Diamond | 93–94 | 93.3 | 88* |
| Terminal-Bench 2.0 | 84.7 | 81.8 | — |
| OSWorld-Verified | 78.7 | 75.0 | — |

**Codex decision matrix:** trivial → gpt-5.4-mini @minimal · mechanical impl → gpt-5.4-mini @low ·
standard impl → gpt-5.6-terra @medium · complex impl → gpt-5.6-terra @high *or* gpt-5.6-sol @medium ·
debugging / planning → gpt-5.6-sol @high · correctness-review → gpt-5.6-sol @xhigh · long-horizon
agentic → gpt-5.6-sol @medium · parallel subagent → gpt-5.4-mini @low–medium (or gpt-5.6-luna where
available).

**Switch thresholds:** mini → gpt-5.6-terra when multi-file reasoning / mini errors 2× / needs
`high`. gpt-5.6-terra → gpt-5.6-sol when concurrency/cross-system debugging, correctness-critical
`xhigh`, or Sol's deeper reasoning tier matters. Downgrade for budget sprints (gpt-5.6-terra default;
gpt-5.6-sol for review/unblock).

**Cross-platform equivalence:** gpt-5.6-sol ≈ Opus 4.8 · gpt-5.6-terra ≈ Sonnet 5
(affordable-flagship class) · gpt-5.4-mini / gpt-5.6-luna ≈ Haiku 4.5 (subagent/latency tier). This
equivalence mirrors the prior gpt-5.5≈Opus / gpt-5.4≈Sonnet 5 / gpt-5.4-mini≈Haiku framing by tier
position, not by re-verified benchmark parity — GPT-5.6's own benchmark numbers (§ above) were not
cross-compared against Claude figures in this pass.

**Orchestration (OMX ↔ OMC):** OMX (oh-my-codex) is the Codex analogue of OMC. `scalarian/oh-my-codex`
was archived 2026-05-25; `Yeachan-Heo/oh-my-codex` is the active fork. OMX does **not** auto-select
models — the user/orchestrator sets `model` + `model_reasoning_effort` in `.codex/config`; skills
recommend effort in-prompt but can't switch models mid-session. Pattern: orchestrator on flagship,
`$team` parallel workers on mini. See `KB-omx.md` / `KB-omc.md`.

## 9. Sources
Official Anthropic: (1) [platform.claude.com models overview](https://platform.claude.com/docs/en/about-claude/models/overview) · (2) [platform.claude.com pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Third-party (2026): (3) [morphllm.com Claude benchmarks](https://www.morphllm.com/claude-benchmarks) · (4) [MarkTechPost — Sonnet 5 vs Sonnet 4.6 vs Opus 4.8](https://www.marktechpost.com/2026/06/30/anthropic-claude-sonnet-5-vs-sonnet-4-6-vs-opus-4-8-agentic-coding-benchmarks-api-pricing-and-cost-performance-tradeoffs-compared/) · (5) [codingfleet.com — Sonnet 5 vs Opus 4.8](https://codingfleet.com/blog/claude-sonnet-5-vs-claude-opus-4-8/) · (6) [llm-stats.com — Sonnet 5 vs Opus 4.8](https://llm-stats.com/blog/research/claude-sonnet-5-vs-claude-opus-4-8) · (7) [cosmicjs.com — Sonnet 5 benchmarks](https://www.cosmicjs.com/blog/claude-sonnet-5-benchmarks-pricing-developers) · (8) [datacamp.com — Claude Sonnet 5](https://www.datacamp.com/blog/claude-sonnet-5) · (9) [artificialanalysis.ai — Sonnet 5](https://artificialanalysis.ai/models/claude-sonnet-5) · (10) [artificialanalysis.ai — Haiku 4.5](https://artificialanalysis.ai/models/claude-4-5-haiku) · (11) [anthonymaio.substack.com — effort levels](https://anthonymaio.substack.com/p/opus-47-the-five-effort-levels-in).

Codex (gpt-5.x) — official OpenAI: (12) [developers.openai.com/codex/models](https://developers.openai.com/codex/models) · (13) [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) · (14) [developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference). Third-party: (15) [LM Council benchmarks](https://lmcouncil.ai/benchmarks) · (16) [morphllm SWE-bench Pro](https://www.morphllm.com/swe-bench-pro). OMX: (17) [github.com/Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex).

## 10. Discrepancies / caveats
- Terminal-Bench 2.1 Opus: 74.6 (raw model) vs 78.9 (Claude-Code harness) — harness-dependent, not
  effort-dependent (see `docs/KB-codex-vs-opus-coding.md`). The 82.7% Terminal-Bench figure
  circulating in some sources is GPT-5.5's, not Opus's.
- Sonnet 5 SWE-bench Verified: 72.7 (official announcement) vs 82.1 (third-party, extended thinking).
- GDPval: "Sonnet beats Opus" holds on **v2** only (1618 vs 1615); Opus led the original v1.
- MMLU-Pro / AIME / LiveCodeBench / TAU-bench: no published Opus-4.8/Sonnet-5 figures found as of
  2026-07-01.

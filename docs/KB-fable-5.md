# Claude Fable 5 — Knowledge Base

> Compiled 2026-06-10 from 14 sources (researcher agent draft; load-bearing claims
> under independent spot-check — see Verification status at the end). All claims
> carry inline source references [n] mapped to the numbered list at the end.

## 1. Identity

**Model IDs**

| Surface | ID |
|---|---|
| Claude API / Claude Platform on AWS | `claude-fable-5` |
| Amazon Bedrock | `anthropic.claude-fable-5` |
| Bedrock geo-routing | `us.anthropic.claude-fable-5` / `eu.anthropic.claude-fable-5` |
| Vertex AI | `claude-fable-5` |
| Microsoft Foundry / Azure AI | `claude-fable-5` |

Source: [1][2][7]

**Release date:** June 9, 2026. [1][2]

**Naming:** "Fable is from the Latin *fabula*, 'that which is told,' akin to the
Greek *mythos*. The safeguards are what distinguish the two models." [3] Fable 5
is the safeguarded release of the Mythos-class model; Mythos 5 is the
access-gated version without general-use classifiers. [1][3]

**Tier hierarchy (top→bottom):**
1. Claude Mythos 5 (`claude-mythos-5`) — same weights, classifiers lifted, invitation-only (Project Glasswing) [1][2]
2. **Claude Fable 5** (`claude-fable-5`) — most capable generally-available model [1][2]
3. Claude Opus 4.8 (`claude-opus-4-8`) [2]
4. Claude Sonnet 4.6 (`claude-sonnet-4-6`) [2]
5. Claude Haiku 4.5 (`claude-haiku-4-5`) [2]

## 2. Capabilities

| Spec | Value |
|---|---|
| Context window | 1M tokens (Opus 4.7 tokenizer — same text ≈ 30% more tokens than pre-4.7) [2] |
| Max output (sync) | 128k tokens [1][2] |
| Max output (Batch) | UNVERIFIED for Fable 5 (Opus 4.8 has 300k via `output-300k-2026-03-24` beta) [2] |
| Knowledge cutoff | January 2026 [7] |

**Thinking:** Adaptive thinking is the ONLY mode — always on;
`thinking: {type: "disabled"}` is rejected ("not supported" per official docs;
exact error code UNVERIFIED — spot-check found no "400" wording), and manual
`budget_tokens` extended thinking is likewise not supported (effort controls
depth instead). Raw CoT never returned (`thinking.display` defaults `"omitted"`;
`"summarized"` available). Pass thinking blocks back unchanged in multi-turn on
the same model. [1][4]

**Effort parameter — all five levels supported on Fable 5** [4]:
`low` / `medium` / `high` (default) / `xhigh` (Fable 5, Mythos 5, Opus 4.8/4.7
only) / `max` (reserve for frontier problems). Official note: `low` is
"suitable for subagents". "Ultracode" is NOT an API effort level — it pairs
`xhigh` with multi-agent permission messaging in Claude Code. [4]
At `high`/`xhigh` set large `max_tokens` (hard cap on thinking + response). [4]

**Agentic features at launch:** tool use, memory tool, task budgets (beta),
context editing/tool-result clearing (beta), compaction, vision. [1]
AWS model card: "sustained autonomous operation across multi-day tasks — plans
across stages, delegates to sub-agents, and self-verifies its work." [7][3]

**Bedrock sampling constraints:** temperature 1.0/unset; top_p ≥0.99 <1.0/unset; no top_k. [7]

## 3. Pricing (per MTok)

| Model | Input | Output | vs Fable input | vs Fable output |
|---|---|---|---|---|
| **Fable 5** | $10 | $50 | — | — |
| Opus 4.8 | $5 | $25 | 2× cheaper | 2× cheaper |
| Sonnet 4.6 | $3 | $15 | 3.3× cheaper | 3.3× cheaper |
| Haiku 4.5 | $1 | $5 | **10× cheaper** | **10× cheaper** |

Sources: [1][2]. Fable 5 < half the price of Mythos Preview. [3]
Bedrock prompt caching: 90% input discount (1,024-token min, 4 checkpoints, 5-min/1-h TTL). [7]
Refusals before any output are not billed; mid-stream refusals billed to the block
point; "fallback credit" refunds prompt-cache cost on fallback-model retry. [1]

## 4. Availability

- **GA 2026-06-09:** Claude API, Claude Platform on AWS, Bedrock, Vertex AI, Microsoft Foundry. [1][2]
- **Claude.ai:** Free/Pro/Enterprise (Free phased in after 2026-06-22, credits beyond allotment). [5]
- **Claude Code:** by model name `claude-fable-5`; also via "ultracode" mode. [4]
- **GitHub Copilot:** Pro+/Max/Business/Enterprise; org policy DISABLED by default (data-retention requirement). [10]
- **Bedrock tiers:** Standard only at launch (no Priority/Flex/Reserved). [7]
- **⚠ Data retention:** Fable 5 is a Covered Model — mandatory 30-day retention,
  NOT available under Zero Data Retention; existing ZDR commitments don't extend
  to it (classifier operation requirement). Opus 4.8 / Sonnet 4.6 / Haiku 4.5
  still support ZDR. [1][8][10]

## 5. Benchmarks vs Opus 4.8 (launch materials; independent replication limited)

| Benchmark | Fable 5 | Opus 4.8 | Source |
|---|---|---|---|
| SWE-Bench Pro | 80.3% | 69.2% | [6] |
| FrontierCode Diamond | 29.3% | 13.4% | [6] |
| GDP.pdf vision (no tools) | 29.8% | 22.5% | [6] |
| Hex core analytics | "first to break 90%" | — | [5] |
| Hebbia Finance | highest scorer | — | [3] |

Effort scaling: FrontierCode Diamond 11.5%→30.9% (low→xhigh). [6]
Counterpoint: Andon Labs reported Mythos 5 underperforming some competitors on
agentic-business benchmarks. [6]

## 6. Orchestration guidance (feeds anti-hall model routing)

- **Safety fallback routing:** 3 classifiers (cyber, bio/chem, distillation)
  redirect refused requests to Opus 4.8 when API `fallbacks` is set; >95% of
  sessions involve no fallback. [1][3][5]
- **Cost tiering** [4][9]: Fable 5 high/xhigh/max = orchestrator + hardest
  subtasks; Fable low/medium = lower-priority subtasks (still often exceeds
  xhigh on Opus 4.7); Opus 4.8 xhigh = complex agentic/coding where Fable cost
  unjustified; Sonnet 4.6 = most implementation; Haiku 4.5 = lookups,
  classification, navigation, high-volume subagents.
- **Multi-agent:** async subagent harnesses (3/5/10 agents) → 2.2×/2.7×/2.7×
  latency speedups vs single-agent; non-blocking beats blocking on latency AND
  tokens. [9]

## 7. Migration notes (Opus 4.8 → Fable 5) [1][4][14]

1. Remove `thinking: {type:"disabled"}` (rejected — official docs say "not supported"; exact error code unverified).
2. Remove manual `budget_tokens` extended thinking (rejected — official docs say "not supported"; exact error code unverified).
3. `max_tokens` caps thinking+response combined — revisit values.
4. Handle `stop_reason: "refusal"` (HTTP 200 path, not an error).
5. Raw thinking never returned.
6. Strip Fable-5 thinking blocks before replaying history to non-Fable/Mythos models.
7. Tokenizer ≈ +30% tokens vs pre-4.7 — re-baseline costs. [2][14]
8. No ZDR (see §4). No Opus 4.8 deprecation announced; Sonnet 4 / Opus 4 retire
   2026-06-15, Opus 4.1 retires 2026-08-05 (unrelated). [2]

## Sources

1. Anthropic API Docs — Introducing Claude Fable 5 and Claude Mythos 5 (2026-06-10): https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5
2. Anthropic API Docs — Models Overview (2026-06-10): https://platform.claude.com/docs/en/about-claude/models/overview
3. Anthropic — Fable 5 / Mythos 5 announcement (2026-06-10): https://www.anthropic.com/news/claude-fable-5-mythos-5
4. Anthropic API Docs — Effort parameter (2026-06-10): https://platform.claude.com/docs/en/build-with-claude/effort
5. TechCrunch — Anthropic released Claude Fable 5 (2026-06-10): https://techcrunch.com/2026/06/09/anthropic-released-claude-fable-5-its-most-powerful-model-publicly-days-after-warning-ai-is-getting-too-dangerous/
6. Vellum.ai — Fable 5 / Mythos 5 benchmarks explained (2026-06-10): https://www.vellum.ai/blog/claude-fable-5-and-mythos-5-benchmarks-explained
7. AWS Bedrock — Model card: Claude Fable 5 (2026-06-10): https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5.html
8. Anthropic Help Center — Data retention for Mythos-class models (2026-06-10): https://support.claude.com/en/articles/15425996-data-retention-practices-for-mythos-class-models
9. OpenRouter — Claude Fable 5 API specs (2026-06-10): https://openrouter.ai/anthropic/claude-fable-5
10. GitHub Changelog — Fable 5 GA for Copilot (2026-06-10): https://github.blog/changelog/2026-06-09-claude-fable-5-is-generally-available-for-github-copilot/
11. Anthropic — Claude Fable product page (2026-06-10): https://www.anthropic.com/claude/fable
12. Simon Willison — Initial impressions of Claude Fable 5 (2026-06-10): https://simonwillison.net/2026/Jun/9/claude-fable-5/
13. Microsoft Azure AI Foundry — Fable 5 model catalog (2026-06-10): https://ai.azure.com/catalog/models/claude-fable-5
14. Anthropic API Docs — Migration guide Opus 4.8 → Fable 5 (2026-06-10): https://platform.claude.com/docs/en/about-claude/models/migration-guide

## Verification status

Researcher-compiled 2026-06-10; flagged-UNVERIFIED items are marked inline.
Independent spot-check (2026-06-10, separate agent, sources [1][2][4] fetched
fresh) on five load-bearing claims:
- ✅ CONFIRMED: model id `claude-fable-5` exact; pricing $10/$50 (Opus $5/$25,
  Haiku $1/$5); effort levels incl. `xhigh` + `max` on Fable 5 and `low`
  "suitable for subagents"; Covered-Model 30-day retention / no ZDR.
- ✏️ CORRECTED: "thinking disabled → 400 error" — official docs say "not
  supported" without specifying an error code; §2 wording adjusted.

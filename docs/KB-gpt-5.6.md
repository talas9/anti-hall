# KB — GPT-5.6 (Sol / Terra / Luna)

> OpenAI's GPT-5.6 model family, its three named tiers, pricing, API/Codex CLI
> availability, and this machine's local Codex CLI gap. Compiled 2026-07-11 from a
> deep-research pass (19 sources fetched, 25 claims adversarially cross-verified,
> 23 confirmed / 2 refuted / 0 unverified) plus a primary-source re-verification
> pass against OpenAI's own developer docs, and a local check of the installed
> Codex CLI on this machine.

## Confidence & provenance

Three confidence bands are used throughout this doc — read them literally, they are
load-bearing:

- **PRIMARY-CONFIRMED** — fetched HTTP 200 directly from an OpenAI-controlled docs
  domain (`developers.openai.com/*`, which redirects 308 to `learn.chatgpt.com/docs/*`)
  during the re-verification pass. Stated as fact.
- **SECONDARY-CONFIRMED** — corroborated by multiple independent secondary sources
  (GitHub's own changelog, Wikipedia, tech press) but the primary OpenAI page for
  this specific claim was **not** successfully machine-read. Labeled explicitly
  where used.
- **PRESS/BENCHMARK** — third-party benchmark aggregator or press reporting, not an
  OpenAI-published number. Labeled explicitly, never asserted as OpenAI-official.

**The 403 caveat:** OpenAI's own announcement pages —
`openai.com/index/gpt-5-6/`, `openai.com/index/previewing-gpt-5-6-sol/`, and the
`help.openai.com` preview article — returned **HTTP 403 to automated fetch** (bot
protection, not 404 — the pages are live and indexed; content was corroborated via
search-result extraction and independent secondary sources, not read verbatim by a
fetcher). Anything resting solely on those pages is marked secondary-confirmed
below, even though OpenAI is the ultimate origin.

## 1. The three tiers

GPT-5.6 is a **generation**, not a single model; **Sol / Terra / Luna** are three
named, independently-priced tiers within it. OpenAI's own framing (from the
`developers.openai.com` docs, PRIMARY-CONFIRMED): *"the number identifies a model's
generation, while Sol, Terra, and Luna identify durable capability tiers that can
advance on their own cadence."*

| Tier | Official API model ID | Positioning | Reasoning-effort notes |
|---|---|---|---|
| **Sol** | `gpt-5.6-sol` | Flagship/frontier — "strongest capability for complex coding, computer use, research, and cybersecurity." Bare `gpt-5.6` is an **alias that routes to Sol**: *"The `gpt-5.6` alias routes requests to GPT-5.6 Sol."* | Only tier documented with a `max` reasoning-effort level and an "ultra" mode (press-reported as parallel-subagent execution — see §7 caveat). |
| **Terra** | `gpt-5.6-terra` | Balanced everyday/agentic-coding tier — "competitive with GPT-5.5 at lower cost." | Standard reasoning-effort range (not documented as offering `max`). |
| **Luna** | `gpt-5.6-luna` | Fastest, lowest-cost tier in the family. | Standard reasoning-effort range; targets latency-sensitive workloads. |

Source for the tier table: `developers.openai.com/api/docs/models/gpt-5.6-sol` and
`developers.openai.com/api/docs/models` — PRIMARY-CONFIRMED.

## 2. Pricing

Per 1M tokens, standard rates (`developers.openai.com/api/docs/pricing` —
PRIMARY-CONFIRMED):

| Tier | Input | Output | Cached input |
|---|---|---|---|
| Sol | $5.00 | $30.00 | $0.50 |
| Terra | $2.50 | $15.00 | — (not separately re-verified; treat as proportionally discounted pending direct check) |
| Luna | $1.00 | $6.00 | — (same caveat) |

Additional billing rules (PRIMARY-CONFIRMED, from the same pricing page and the Sol
model-card page):

- **Cache writes** are billed at **1.25×** the uncached input rate.
- **Long-context surcharge:** prompts whose input exceeds **272K tokens** are billed
  at **2× input / 1.5× output for the entire request** (not just the excess).

## 3. API access

Per `developers.openai.com/api/docs/models/gpt-5.6-sol` and
`developers.openai.com/api/docs/models` (PRIMARY-CONFIRMED):

- **Endpoints:** Chat Completions, Responses, Realtime, Batch.
- **Features:** streaming, function calling, structured outputs.
- **Alias behavior:** the bare `gpt-5.6` string is not its own model — it is an
  alias that resolves to `gpt-5.6-sol`. Callers who want Terra or Luna must name
  the tier explicitly (`gpt-5.6-terra` / `gpt-5.6-luna`).
- Context-window size and per-tier rate limits were **not** confirmed from a
  primary source during re-verification (an earlier research pass extracted a
  1,050,000-token context / 128,000-token max-output figure for Sol from a search
  snippet, but this was not independently re-fetched from the model card during the
  primary pass) — **not stated as fact here**; verify directly against
  `developers.openai.com/api/docs/models/gpt-5.6-sol` before relying on it.

## 4. Availability & rollout

- **GA date — SECONDARY-CONFIRMED, not primary-read:** OpenAI's own two
  announcement pages (`openai.com/index/gpt-5-6/`,
  `openai.com/index/previewing-gpt-5-6-sol/`) 403'd to direct fetch. The
  **2026-07-09** general-availability date (across ChatGPT, Codex, and the OpenAI
  API, following a limited preview beginning ~2026-06-26) is corroborated by:
  - GitHub's own Copilot changelog (PRIMARY-CONFIRMED for the Copilot-rollout claim
    specifically — see next bullet): *"Release Date: July 9, 2026."*
  - Wikipedia's `GPT-5.6` article (secondary).
  - Multiple press outlets — TechCrunch, CNBC, MarkTechPost, Vellum (secondary,
    independently converging on the same date).
- **GitHub Copilot rollout — PRIMARY-CONFIRMED:** `github.blog`'s own changelog
  entry (dated 2026-07-09) states GPT-5.6 Sol, Terra, and Luna became available in
  GitHub Copilot starting that date. This is GitHub's own official changelog, so it
  is treated as primary for the Copilot-specific claim (independent of the 403'd
  OpenAI pages).
- **Codex CLI selectability — PRIMARY-CONFIRMED:** `learn.chatgpt.com/docs/models`
  (the page `developers.openai.com/codex/models` 308-redirects to — an
  OpenAI-owned docs domain, fetched HTTP 200) documents Codex CLI model selection
  for GPT-5.6 verbatim, including:
  ```
  codex -m gpt-5.6-sol
  codex --model gpt-5.6
  ```
  alongside gpt-5.5, gpt-5.4, gpt-5.4-mini, and gpt-5.3-codex-spark as other
  selectable models. `/model` is documented as the interactive-session switch.

## 5. Local Codex availability caveat (this machine)

Verified on this machine 2026-07-10, not a general OpenAI fact:

- The installed `codex` CLI is **v0.143.0**, default model **gpt-5.5**.
- Its local cache file `~/.codex/models_cache.json` (fetched 2026-07-10) lists
  **only** `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark` — GPT-5.6
  (any tier) is **absent from the interactive `/model` picker** on this install.
- This matches a filed upstream bug, **`github.com/openai/codex/issues/31873`**
  (filed against v0.143.0): *"/model does not list GPT-5.6 models that are
  available via -m"* — i.e., GPT-5.6 **is** invocable via `codex -m gpt-5.6-sol`
  (per §4 above), it is just missing from the picker/cache on this version.
- Practical consequence: invoking an uncached model id on this install emits
  *"Model metadata not found. Defaulting to fallback metadata"* — reasoning-effort
  and tool defaults may be degraded relative to a fully-cached model until the
  picker/cache bug is fixed upstream.

## 6. Coding/agentic benchmarks (third-party, not OpenAI-official)

**Caveat first:** OpenAI's own benchmark/announcement pages were not readable
(403, see §0 confidence note above). Every number below comes from third-party
benchmark aggregators or press, reported as such, not asserted as OpenAI-official:

- **Artificial Analysis Coding Agent Index v1.1** (per MarkTechPost's reported
  table and independently per `artificialanalysis.ai`'s own article): Sol scores
  **80**, ahead of the reported field — press coverage frames this as Sol leading
  the index.
- **SWE-Bench Pro** (press-reported, via `vellum.ai` / Artificial Analysis
  coverage): Sol **64.6%**, versus a reported **80.3%** for a Claude codename used
  by these outlets ("Claude Mythos 5") — a roughly 15–16 point gap in Sol's favor
  for the competitor. Vellum's own reporting notes OpenAI did not itself publish
  Sol's SWE-Bench Pro figure, and the Claude codenames used by these aggregators
  are the outlets' own naming, not confirmed Anthropic product names.
- Treat both figures as **third-party benchmark claims**, not first-party OpenAI
  results, and re-verify against a transparent/reproducible harness before citing
  them as settled.

## 7. Relevance to anti-hall's Codex port

Brief pointer only — this doc does not design a migration. Anti-hall's current
Codex port (`plugins/anti-hall/codex/`) routes debate/validation/planning seats to
`gpt-5.5`, implementation to `gpt-5.4`, and mechanical/cheap work to `gpt-5.4-mini`
(default), per `plugins/anti-hall/codex/skills/*/SKILL.md` and
`plugins/anti-hall/codex/README.md`. GPT-5.6 Sol/Terra/Luna are the natural
migration targets for those same three seats respectively once the local
picker/cache gap (§5) is resolved upstream and the model is broadly available on
this install — but the actual migration plan is out of scope for this KB entry and
belongs in a separate design doc.

## 8. Sources

Official/primary sources are marked **[OFFICIAL]**. OpenAI's own announcement
pages that 403'd to direct fetch (content corroborated via search/secondary
sources, not read verbatim) are marked accordingly.

1. `developers.openai.com/api/docs/models/gpt-5.6-sol` — **[OFFICIAL]** Sol model card (tier ID, positioning, endpoints/features).
2. `developers.openai.com/api/docs/models` — **[OFFICIAL]** full model list incl. all three GPT-5.6 tier IDs.
3. `developers.openai.com/api/docs/pricing` — **[OFFICIAL]** per-tier pricing, cache-write multiplier, >272K surcharge.
4. `developers.openai.com/codex/models` (308-redirects to `learn.chatgpt.com/docs/models`) — **[OFFICIAL]** Codex CLI model-selection syntax (`-m`, `--model`, `/model`) and per-tier availability matrix.
5. `learn.chatgpt.com/docs/models` — **[OFFICIAL]** the redirect target of #4; fetched HTTP 200; documents `codex -m gpt-5.6-sol` / `codex --model gpt-5.6` alongside gpt-5.5/5.4/5.4-mini/5.3-codex-spark.
6. `developers.openai.com/codex/changelog` (308-redirects to `learn.chatgpt.com/docs/changelog`) — **[OFFICIAL]** Codex CLI version history; v0.143.0 (2026-07-08) Bedrock GPT-5.6 support entry, v0.144.0 (2026-07-09) naming-display fix entry.
7. `github.blog/changelog/2026-07-09-openais-gpt-5-6-sol-terra-and-luna-are-now-available-in-github-copilot/` — **[OFFICIAL]** GitHub's own changelog confirming the Copilot rollout date and the three tier names.
8. `openai.com/index/gpt-5-6/` — **[official, not machine-readable — 403]** OpenAI's primary GPT-5.6 announcement page; content triangulated via search extraction and secondary sources only.
9. `openai.com/index/previewing-gpt-5-6-sol/` — **[official, not machine-readable — 403]** OpenAI's limited-preview announcement page; same caveat as above.
10. `help.openai.com/en/articles/20001325-a-preview-of-gpt-56-sol-terra-and-luna` — **[official, not machine-readable — 403]** OpenAI support-center preview article; direct fetch 403'd, content corroborated via search extraction.
11. `github.com/openai/codex/releases/tag/rust-v0.143.0` — OpenAI's own Codex CLI GitHub release page, corroborating the v0.143.0/2026-07-08 date.
12. `github.com/openai/codex/issues/31873` — filed upstream bug (this machine's install, v0.143.0): `/model` omits GPT-5.6 from the picker despite `-m` support.
13. `github.com/openai/codex/issues/31905` — community-filed Codex issue referencing GPT-5.6/Bedrock rollout, used as corroborating (forum-quality) evidence.
14. `github.com/openai/codex/issues/31869` — community-filed Codex issue referencing GPT-5.6 availability, corroborating (forum-quality) evidence.
15. `en.wikipedia.org/wiki/GPT-5.6` — secondary encyclopedia summary corroborating GA date and tier structure.
16. `techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/` — press coverage of the 2026-07-09 GA rollout.
17. `www.marktechpost.com/2026/07/09/openai-releases-gpt-5-6-a-three-tier-model-family-with-programmatic-tool-calling/` — press coverage; source of the reported Coding Agent Index and SWE-Bench Pro table.
18. `www.vellum.ai/blog/gpt-5-6-benchmarks-explained` — third-party benchmark analysis blog; explicitly notes OpenAI did not itself publish the SWE-Bench Pro number for Sol.
19. `artificialanalysis.ai/articles/gpt-5-6-has-landed` — third-party benchmark aggregator's own published article (independent confirmation of the Coding Agent Index scores).
20. `www.datacamp.com/blog/claude-sonnet-5-vs-gpt-5-6` — press/blog head-to-head comparison, used only for cross-checking benchmark figures, not as a primary claim source.
21. `venturebeat.com/technology/openai-unveils-gpt-5-6-sol-terra-and-luna-models-but-only-accessible-to-limited-preview-partners-for-now-per-us-gov` — press coverage of the limited-preview phase preceding GA.
22. `www.axios.com/2026/06/26/openai-gpt-sol-terra-luna-trump` — press coverage of the ~2026-06-26 limited-preview start date.
23. `lmcouncil.ai/benchmarks` — third-party benchmark listing site; cited here specifically because a claim sourced from it (that GPT-5.6 was absent from its comparison page as of 2026-07-01) was **tested and refuted (0-3 vote)** during adversarial verification — kept in the source list for that provenance, not as a claim source.
24. `www.morphllm.com/best-ai-model-for-coding` — blog-quality source consulted during the coding-benchmark research angle; not used for a load-bearing claim in this doc.
25. `codex.danielvaughan.com/2026/06/03/gpt-5-6-codex-cli-canary-signals-developer-readiness-guide/` — independent blog tracking pre-GA Codex CLI canary signals for GPT-5.6.
26. `techsy.io/en/blog/gpt-5-6-leak` — blog covering pre-announcement leak chatter; consulted specifically for the "leak vs. official" skeptical angle, superseded by the confirmed official sources above.

## 9. Facts dropped or down-labeled for lack of verification

- **Context window / max output size** (a 1,050,000-token context / 128,000-token
  max-output figure for Sol) — **dropped from the fact sections above.** It
  surfaced in one search-snippet extraction during the initial research pass but
  was flagged by that same research as **not confirmed from a primary source**
  (explicit open question in the research output), and it was not independently
  re-verified during the primary-source re-check pass. Do not treat it as
  established; re-fetch `developers.openai.com/api/docs/models/gpt-5.6-sol`
  directly before relying on it.
- **Per-tier rate limits** — not surfaced by any source in this research pass;
  omitted entirely rather than guessed.
- **Terra/Luna cached-input pricing** — only Sol's cached-input rate ($0.50) was
  directly re-verified against the primary pricing page during the
  re-verification pass; Terra/Luna cached rates are left uncited above rather than
  extrapolated.
- **The GA date itself** — down-labeled to SECONDARY-CONFIRMED throughout this doc
  (not stated as OpenAI-primary) because the two OpenAI announcement pages that
  would be the primary source for it both returned HTTP 403 to direct fetch during
  this research; only secondary/press corroboration was available.
- **"Sol-exclusive `max`/ultra mode" as a hard architectural fact** — the
  underlying adversarial verification pass recorded a 2-1 (not unanimous) vote on
  this specific detail. Kept in §1's table because it is the majority-confirmed
  reading, but flagged here as the one item in this doc with a dissenting vote
  rather than unanimous confirmation.
- **Regional/enterprise gating during the June 26 limited preview** (reported by
  press as restricted per a US-government request) — not included in the fact
  sections above; this research pass did not verify it against a primary source
  and it is unrelated to the GA-era facts this doc otherwise states.

# KB: Token usage & cost mechanics — Claude + Codex, all effort tiers, Workflow/ultracode

> Reference KB for actual routing/cost decisions (not benchmark scores — see `KB-sonnet-5.md` and
> `KB-codex-vs-opus-coding.md` for those). This doc covers how tokens are actually BILLED and
> CONSUMED: thinking/reasoning-token billing mechanics, the full effort-tier taxonomy for both
> platforms, tokenizer effects, real observed token volume (third-party + anti-hall's own session
> telemetry), and the Workflow tool's/ultracode's own cost dynamics. 25 sources (many official
> Anthropic + OpenAI docs), compiled 2026-07-01. Where data is thin, this doc says so explicitly
> rather than papering over the gap.

## 0. TL;DR

- **Thinking/reasoning tokens bill as OUTPUT tokens on BOTH platforms** — confirmed officially for
  Claude and Codex. Neither vendor discloses a numeric token budget per effort tier; both frame
  effort as a qualitative/behavioral dial, not a fixed quota.
- **Claude's full effort taxonomy is 5 tiers: `low/medium/high/xhigh/max`.** `high` is the **default**
  for Opus 4.8 and Sonnet 5 (not `xhigh` — corrects an error in this repo's own `KB-sonnet-5.md`).
  **Haiku 4.5 doesn't support `effort` at all.**
- **Codex's taxonomy is `minimal(or none)/low/medium/high/xhigh`** — a naming inconsistency exists
  between Codex CLI's config schema (`minimal`) and the gpt-5.4/5.5 model cards (`none`), unresolved
  in official docs.
- **"ultracode" is officially defined**: `xhigh` effort + automatic Workflow orchestration for every
  substantive task in the session, compounding cost — not a one-off setting.
- **Anthropic's own published multiplier: multi-agent systems use ~15× more tokens than a single
  chat turn** (single agents ~4×); Claude Code's separate Agent-Teams feature is ~7× in plan mode.
  These are exact, sourced figures, not estimates.
- **Codex has a real long-context premium (2× input/1.5× output past 272K tokens); Claude currently
  has none up to 1M.** This is a genuine cost asymmetry relevant to routing large-context work.
- **Third-party same-model/cross-effort token-VOLUME data is thin** — the best available number
  (Artificial Analysis, GPT-5 low→high) is a mixed-benchmark-suite 23× multiplier, not coding-isolated.
  Don't over-generalize it to "any coding task costs 23× more at high effort."
- **First-party (this session's own telemetry, ~24 real anti-hall subagent runs):** included below —
  useful for order-of-magnitude planning, not a controlled experiment.

---

## 1. Claude billing mechanics (official)

**Thinking/reasoning tokens are billed as OUTPUT tokens**, regardless of display setting (summarized
or hidden) — "the display setting controls visibility only. Under every setting, thinking happens
and is billed the same" (`platform.claude.com/docs/.../adaptive-thinking`). The billed count is
`usage.output_tokens_details.thinking_tokens`, folded into the authoritative `output_tokens` total.

**Multi-turn nuance:** on models that *keep* prior-turn thinking blocks by default (Opus 4.5+,
Sonnet 4.6+), those carried-forward blocks become ordinary input on the *next* turn and bill as
**input** (cache-read rate if cached). Models that strip prior thinking blocks (older Opus/Sonnet,
all Haiku) never re-bill them.

**Effort taxonomy — 5 tiers, no disclosed token budgets:**
| Tier | Description (official) | Model support (this KB's 3 models) |
|---|---|---|
| `low` | lighter reasoning | all effort-capable models |
| `medium` | "comparable to Sonnet 4.6 at high" for Sonnet 5 | all effort-capable models |
| `high` | **API/Claude-Code default** — identical to omitting `effort` | all effort-capable models |
| `xhigh` | "extended capability for long-horizon work... token budgets in the millions" (describes *aggregate agentic spend*, not a per-request quota) | **Opus 4.8, Opus 4.7, Sonnet 5 only** |
| `max` | "absolute maximum capability, no constraints on token spending" | confirmed for Opus; unconfirmed model list |

Anthropic explicitly rejects a fixed-budget framing: "Effort is a behavioral signal, not a strict
token budget... Claude will still think on sufficiently difficult problems [at low effort], but
less than at higher levels for the same problem." **Haiku 4.5 supports NEITHER `effort` NOR adaptive
thinking** — only legacy manual `thinking:{type:"enabled", budget_tokens:N}`.

**Prompt caching (official multipliers, relative to base input price):**
| | Multiplier |
|---|---|
| 5-minute cache write | 1.25× |
| 1-hour cache write | 2× |
| Cache read/hit (either duration) | **0.1×** (90% discount) |
Break-even: one cache read (5m) or two reads (1h) pays off the write. Stacks with Batch (-50%) and
the 1.1× data-residency uplift. In a long agentic session with automatic caching, each new turn
re-reads the entire prior system-prompt+tools+history as a cache hit and only pays full rate on the
newly appended turn — directly relevant to a long-running coordinator session like this one.

**Context-window pricing:** **no long-context surcharge** currently for Opus 4.8/Sonnet 5's 1M
window — "a 900k-token request is billed at the same per-token rate as a 9k-token request." **Haiku
4.5 has a 200k window (not 1M)** — the no-surcharge policy is moot for it since it isn't offered at
1M at all.

**Base pricing (official):**
| Model | Input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|---|
| Opus 4.8 | $5/MTok | $6.25 | $10 | $0.50 | $25/MTok |
| Sonnet 5 (intro, →Aug 31 2026) | $2/MTok | $2.50 | $4 | $0.20 | $10/MTok |
| Sonnet 5 (standard, from Sep 1 2026) | $3/MTok | $3.75 | $6 | $0.30 | $15/MTok |
| Haiku 4.5 | $1/MTok | $1.25 | $2 | $0.10 | $5/MTok |

**⚠ Side finding (out of this KB's scope, flagged for the owner):** the live official docs fetched
for this research also reference **"Claude Fable 5"** and **"Claude Mythos 5"/"Mythos Preview"** by
name, consistently across the effort/pricing/context-window pages — models beyond this KB's
research-agent's training knowledge. This may mean Fable is available again under a new name. Not
investigated further here; see the owner note in CHANGELOG/task list for follow-up.

## 2. Codex billing mechanics (official)

**Reasoning tokens billed as OUTPUT tokens** — "reasoning tokens are not visible via the API, [but]
they still occupy space in the model's context window and are billed as output tokens"
(`developers.openai.com/api/docs/guides/reasoning`), tracked in `output_tokens_details.reasoning_tokens`.

**`model_reasoning_effort` — naming inconsistency across official pages (unresolved):**
- Codex CLI's `config.toml` schema: `minimal | low | medium | high | xhigh` (5 values).
- The gpt-5.4/gpt-5.5 model cards themselves: `none | low | medium | high | xhigh` — "none" not
  "minimal" as the floor. Per OpenAI's GPT-5.1 announcement, `minimal` (near-zero reasoning tokens,
  legacy) and `none` (true non-reasoning mode, newer) are **distinct** concepts; `gpt-5-codex` never
  supported `minimal` at all. **Unconfirmed which value Codex CLI actually honors against gpt-5.4/5.5
  if you set `minimal`.**
- No numeric budget disclosed per tier on any official page — only "anywhere from a few hundred to
  tens of thousands of reasoning tokens depending on task complexity" (a range descriptor, not a
  per-tier figure).
- `plan_mode_reasoning_effort` (Codex CLI plan-mode override) adds a 6th value, `none`, and defaults
  to an undisclosed built-in preset.

**Prompt caching:** GPT-5.6 (Sol/Terra/Luna) went GA 2026-07-09 and supersedes gpt-5.5/gpt-5.4 as
the recommended tiers — see [`KB-gpt-5.6.md`](./KB-gpt-5.6.md) for full sourcing. `gpt-5.4-mini`
is kept as the cheap-default tier (unchanged); `gpt-5.6-luna` is a selective cheap alternative.
| Model | Input | Cached input | Output |
|---|---|---|---|
| gpt-5.6-sol | $5.00 | $0.50 (confirmed, `KB-gpt-5.6.md` §2) | $30.00 |
| gpt-5.6-terra | $2.50 | [unverified — not separately re-confirmed] | $15.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.6-luna | $1.00 | [unverified — same caveat as Terra] | $6.00 |
Caching is automatic (no opt-in) for prompts ≥1,024 tokens with matching prefixes. **Pricing-model
discrepancy across generations, both confirmed:** the gpt-5.5/gpt-5.4 generation was confirmed
no-write-fee (OpenAI prompt-caching guide, source 20 below); GPT-5.6 is separately confirmed to
bill cache writes at **1.25× the uncached input rate** (`KB-gpt-5.6.md` §2, PRIMARY-CONFIRMED
against the pricing page). Not reconciled further here — flagged as a real generational change, not
an error in either source. Retention: in-memory 5–10 min (up to 1hr), or an "extended retention"
tier (up to 24hr) on newer models via `prompt_cache_retention` — parameter-level detail on
interaction with `previous_response_id` not fully confirmed from docs.

**⚠ Real cost asymmetry vs Claude: Codex has a long-context premium Claude does not.** The
>272K-input-token premium is **CONFIRMED for GPT-5.6** (`gpt-5.6-sol`/`gpt-5.6-terra`, per
`KB-gpt-5.6.md` §2, PRIMARY-CONFIRMED): prompts whose input exceeds **272K tokens are billed at 2×
input / 1.5× output for the entire request** (not just the excess) — the same threshold and
multiplier previously confirmed on the gpt-5.5/gpt-5.4 model cards, now reconfirmed on the GPT-5.6
pricing page. `gpt-5.4-mini`/`gpt-5.6-luna` (smaller-context tiers) have no stated premium tier
(not confirmed either way — treat as unconfirmed, not proven-flat). **This directly matters for the
Codex-primary-implementer routing we just shipped: a Codex task fed a large repo context past 272K
tokens could jump to 1.5–2× cost mid-task, while the equivalent Sonnet 5/Opus task at even 900K
tokens stays flat-rate.** Worth a scope check before routing very-large-context work to Codex by
default. (GPT-5.6's context-window size itself is **not** independently re-confirmed — see
`KB-gpt-5.6.md` §9 — so this note describes the surcharge rule, not a specific window size.)

## 3. Tokenizer comparison (official + independently verified)

**Claude:** the "~1.3×" figure is a genuine PRIMARY Anthropic claim (not a repeated secondary
citation) — confirmed identically across 3 official pages: "roughly 1.0×–1.35× as many tokens...
(up to ~35% more, varying by content)," aggregate "~30% more," introduced at **Opus 4.7** and
carried forward into Sonnet 5 (and Fable 5/Mythos per the docs). No official code-vs-prose
breakdown is published. **Two independent, methodology-shown measurements DISAGREE on whether code
inflates more or less than prose**: one found TypeScript 1.36×/Python 1.29×/English 1.20× (code >
prose); another found English 1.42×/Python 1.27–1.28× (prose > code). Both found CJK/non-Latin
scripts near-unchanged (~1.01×), and both found structured Markdown (CLAUDE.md, technical docs) at
the top of or slightly above Anthropic's documented ceiling (1.44–1.47×). **Practical implication:**
budget code-heavy Claude workloads toward the upper end of the documented range (30–35%+); don't
assume code is cheaper than prose.

**Codex/GPT:** verified directly from OpenAI's own tiktoken source (`github.com/openai/tiktoken`):
`gpt-5` maps to `o200k_base` — the **same** encoding introduced with GPT-4o in 2024, not a new
GPT-5-specific tokenizer. That transition (cl100k_base→o200k_base) went the OPPOSITE direction from
Claude's — code and non-English text got **cheaper** (JS code ~9% fewer tokens, Chinese ~40–43%
fewer), not more expensive. No official evidence of a further GPT-5.x-specific tokenizer change was
found (absence of evidence, not confirmed absence of change). Net: **Claude's tokenizer inflates
cost for code-heavy work relative to older Claude models; Codex's inherited tokenizer is comparatively
efficient relative to its own older GPT-4-era baseline** — an asymmetric picture, not a wash.

## 4. Third-party token-VOLUME studies (honest gap flagged)

**This facet is genuinely thin.** No public source publishes a full input+output+reasoning token
breakdown for the *same coding-agentic task* run at *multiple effort levels* on the *same model*
with disclosed methodology. What exists:
- **Best available (still not coding-isolated):** Artificial Analysis independently ran all 4 GPT-5
  effort levels on an 8-benchmark Intelligence Index suite: **82M tokens at `high` vs 3.5M at
  `minimal` — a 23× multiplier** across the whole mixed suite (includes LiveCodeBench/SciCode, not
  purely coding). Don't generalize this 23× to "any coding task."
- Sonnet 5 `max` uses ~6× more agentic *turns* than `low` on GDPval-AA (a turns proxy, not a token
  count, and GDPval-AA is knowledge-work-adjacent, not coding-isolated).
- Anecdotal single-task blog tests (undisclosed methodology, small sample): GPT-5 low→high on one
  algorithm task went 150→380 tokens (~2.5×); another single task went ~8,500→13,000+ reasoning
  tokens (medium→high, ~1.5×). Treat as informal proxies, not evidence.
- **Vendor claims that LOOK like effort comparisons but AREN'T:** Anthropic's "Opus 4.5 @medium uses
  76% fewer output tokens than Sonnet 4.5's best score" and OpenAI's "GPT-5.1-Codex-Max @medium uses
  30% fewer thinking tokens than GPT-5.1-Codex @medium" are both **cross-model-generation**
  comparisons, not same-model cross-effort — flagging explicitly since they're easy to misread as
  answering this question.
- A general (non-effort-varying) session baseline: a modeled 50-turn agentic coding session runs
  ~1M input / ~40K output tokens (~25:1 ratio), $0.60–$6.00 depending on model (Vantage).

**Net:** no rigorous, coding-isolated, same-model/cross-effort token-volume study exists publicly.
Use the qualitative decision matrix in `KB-sonnet-5.md` for model choice; don't expect precise
per-effort $ multipliers for coding tasks specifically — they aren't published anywhere credible.

## 5. Workflow tool / multi-agent orchestration cost (official)

**Anthropic's own multi-agent research engineering blog** (`anthropic.com/engineering/multi-agent-research-system`,
exact quote): **"agents typically use about 4× more tokens than chat interactions, and multi-agent
systems use about 15× more tokens than chats."** Same post: **"token usage by itself explains 80%
of the variance [in performance], with tool calls and model choice as the two other factors."**
Anthropic's own framing: multi-agent orchestration is justified only when "the value of the outcome
outweighs the expense" — for breadth-first, independent-subtask research, and explicitly **not** for
tightly-coupled work like most coding ("less parallelizable").

**A separate, different figure for a separate feature:** Claude Code's own cost docs state **"Agent
teams use approximately 7× more tokens than standard sessions when teammates run in plan mode."**
This is Agent Teams (a different feature from Dynamic Workflows) — don't conflate the 7× and 15×
figures; they measure different architectures from different Anthropic teams.

**Concurrency cap:** official language is "up to 16 concurrent agents, fewer on machines with
limited CPU cores" plus a **1,000-agent total-per-run** cap (`code.claude.com/docs/en/workflows`).
**The specific "min(16, cpu cores − 2)" formula this plugin's tooling documentation cites internally
is NOT independently corroborated in any official or third-party source** — treat it as this
codebase's own implementation detail (verifiable via the tool's own spec), not a publicly-documented
formula. Fan-out mechanics are confirmed qualitatively: "running several sessions or subagents at
once multiplies token usage" — each spawned agent gets its own full context and its own token bill,
so N parallel agents cost roughly N × (that agent's own cost) plus orchestrator overhead; Anthropic
doesn't publish an exact N-formula for Workflows specifically (unlike the 7×/15× figures above), but
provides live per-agent token totals in the `/workflows` view instead.

**"ultracode" — officially defined, not a harness guess:**
> "Ultracode is a Claude Code setting that combines `xhigh` reasoning effort with automatic workflow
> orchestration. With it on, Claude plans a workflow for each substantive task instead of waiting
> for you to ask... A single request can turn into several workflows in a row: one to understand the
> code, one to make the change, and one to verify it. This applies to every task in the session, so
> each request uses more tokens and takes longer than at lower effort levels. Ultracode lasts for
> the current session and resets when you start a new one."

So ultracode is a **compound, session-scoped** setting: `xhigh` effort tax × auto-workflow-spawn tax
× applies to *every* task until you drop `/effort` or start a new session — not a one-off dial.
Anthropic gives no fixed multiplier for it (unlike 7×/15×); guidance is qualitative ("uses more
tokens and takes longer"). **Reminder to self and future sessions: watch for ultracode silently
spawning a workflow-per-substep chain across an entire session — that's the compounding cost this
section documents, by design, not a bug.**

## 6. First-party: anti-hall's own observed session telemetry

Opportunistic sample from THIS session — ~24 real, standalone (non-workflow-nested) subagent calls,
grouped by model/task-type. **Not a controlled experiment** — task scope varied per call, so this
shows order-of-magnitude/relative shape, not a precise unit-cost model. Full table:
`private scratchpad (session-local)`; summary below.

| Model / task-type | tokens (range) | tool calls | duration | n |
|---|---|---|---|---|
| Opus — exploratory research (Explore, inherited pre-restart default) | 38K–76K | 18–28 | 71–123s | 4 |
| Opus — deep review/critique (explicit `model:"opus"`, deadly-loop seats) | 63K–75K | 4–7 | 161–169s | 2 |
| Sonnet 5 — code-writing/executor | 46K–113K | 17–56 | 122–729s | 4 |
| Sonnet 5 — research/explore | 32K–63K | 13–26 | 84–480s | 4 |
| Sonnet 5 — review/grading | 58K | 19 | 126s | 1 |
| Haiku 4.5 — verification/release-ops | 26K–47K | 2–19 | 17–77s | 9 |
| Codex wrapper (`codex:codex-rescue`) | ~17K | 1 | 81–97s | 2 |

**Observed patterns:**
- Opus deep-review tasks: HIGH tokens, LOW tool-call count, LONG duration — heavy internal reasoning
  + one large synthesized output, few discrete actions. Consistent with §1's "thinking tokens count
  as output" mechanic driving up the total.
- Sonnet 5 code-writing: token count tracks **scope** (files touched, tool calls) far more than
  model choice — the widest range (46K–113K) was driven by one task touching 7 files vs. one file.
- Sonnet 5/Haiku research tasks: duration is dominated by web-fetch/network latency, not reasoning —
  token volume doesn't track duration for this task shape.
- Haiku: the cheapest, fastest, most consistent profile of any model this session — matches its
  mechanical/verification role.
- **Codex wrapper — critical caveat:** `codex:codex-rescue` is a hardcoded Claude Sonnet wrapper
  that authors the Codex prompt and relays the response (established earlier this session). The
  ~17K-token, 1-tool-call, 81–97s-duration figures above measure ONLY the thin Claude-side wrapper —
  **NOT Codex/GPT-5.x's true reasoning-token cost on OpenAI's own infrastructure**, which bills
  separately and is invisible to this telemetry entirely. **Do not conclude "Codex is cheap" from
  this table** — the correct conclusion is "this session's own telemetry cannot see Codex's true
  cost," which is itself the useful, honest finding. The v0.42.1 fix-workflow that just shipped used
  this exact `codex:codex-rescue` seat 3 times as primary implementer (28.7K/30.1K/32.1K
  Claude-side-wrapper tokens, 127–196s each) — real anti-hall usage, same caveat applies.

## 7. Decision guidance for anti-hall routing

- **Codex-as-primary-implementer (v0.42.0 routing) is sound for typical task sizes**, but watch
  context size: past ~272K input tokens fed to Codex, expect a 2×/1.5× cost jump (§2) that Sonnet
  5/Opus wouldn't incur at the same size. For large-repo-context tasks, consider Sonnet 5 instead.
- **`xhigh` is genuinely reserved for the few models that support it** (Opus 4.8/4.7, Sonnet 5) —
  this repo's MODEL-POLICY routing (Sonnet 5 @xhigh for Reviewer/M-planning, Opus elsewhere) is
  consistent with official support, not a guess.
- **Never run `max` inside a loop** (already in MODEL-POLICY) — confirmed by §0/§4: `max` is
  "absolute maximum, no constraints on spending," and the only real volume data available (23× on a
  mixed suite, ~6× turns on GDPval-AA) shows the top tier can compound fast without a bounded ceiling.
- **Multi-agent fan-out (Workflows) costs ~15× a single chat turn, by Anthropic's own measurement**
  — reserve it for genuinely breadth-first/independent-subtask work (research, parallel review),
  matching Anthropic's own stated criterion; avoid it for tightly-coupled sequential coding, where
  the multiplier buys little.
- **"ultracode" compounds per-task, per-session** — if a session drifts into many small tasks under
  ultracode, each can spawn its own workflow chain (§5). For a long session, consider dropping back
  to a lower `/effort` between heavy tasks rather than leaving ultracode on for routine follow-ups.
- **Caching is a bigger lever than model choice for a long agentic session**: a 90% cache-read
  discount on repeated context (system prompt, tools, history) means the SHAPE of the conversation
  (how much changes turn-to-turn) affects cost more than swapping Sonnet 5 for Opus at the margin.

## 8. Sources

**Official Anthropic:** (1) [platform.claude.com/docs/.../extended-thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) · (2) [.../adaptive-thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) · (3) [.../effort](https://platform.claude.com/docs/en/build-with-claude/effort) · (4) [.../prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · (5) [.../about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) · (6) [.../context-windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) · (7) [.../models/migration-guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide) · (8) [.../models/whats-new-sonnet-5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5) · (9) [anthropic.com/news/claude-opus-4-7](https://www.anthropic.com/news/claude-opus-4-7) · (10) [anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system) · (11) [code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows) · (12) [code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs) · (13) [code.claude.com/docs/en/model-config](https://code.claude.com/docs/en/model-config) · (14) [code.claude.com/docs/en/agents](https://code.claude.com/docs/en/agents).

**Official OpenAI:** (15) [developers.openai.com/api/docs/guides/reasoning](https://developers.openai.com/api/docs/guides/reasoning) · (16) [.../api/docs/pricing](https://developers.openai.com/api/docs/pricing) · (17) [.../api/docs/models/gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) · (18) [.../api/docs/models/gpt-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) · (19) [.../api/docs/models/gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · (20) [.../api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching) · (21) [.../codex/config-reference](https://developers.openai.com/codex/config-reference) · (22) [openai.com/index/gpt-5-1-for-developers](https://openai.com/index/gpt-5-1-for-developers/) · (23) [github.com/openai/tiktoken](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py).

**Independent (methodology shown):** (24) [claudecodecamp.com — tokenizer measurement](https://www.claudecodecamp.com/p/i-measured-claude-4-7-s-new-tokenizer-here-s-what-it-costs-you) · (25) [simonwillison.net — Claude token counts](https://simonwillison.net/2026/Jun/30/claude-sonnet-5/) · (26) [artificialanalysis.ai — GPT-5 benchmarks](https://artificialanalysis.ai/articles/gpt-5-benchmarks-and-analysis) · (27) [artificialanalysis.ai — Sonnet 5 agentic cost](https://artificialanalysis.ai/articles/claude-sonnet-5-agentic-cost) · (28) [vantage.sh — agentic coding costs](https://www.vantage.sh/blog/agentic-coding-costs).

## 9. Discrepancies / open gaps (explicit)

- **`minimal` vs `none` naming** for Codex's lowest reasoning tier is inconsistent across official
  OpenAI pages (Codex CLI config schema vs model cards) — unresolved, flagged in §2.
- **No numeric per-tier token budget exists for ANY effort level, on either platform** — this is a
  deliberate non-disclosure by both vendors, not a research gap.
- **Same-model/cross-effort, coding-isolated token-volume data is thin-to-absent** publicly (§4) —
  the routing guidance in §7 leans on qualitative signals, not precise multipliers, because more
  precise numbers don't exist in public sources.
- **"min(16, cpu cores − 2)" concurrency formula is unconfirmed externally** (§5) — treat as this
  codebase's own tool-spec detail, not an Anthropic-published fact.
- **gpt-5.4-mini's long-context premium status is unconfirmed** (absent from its model card, not
  proven flat). Same caveat applies to **gpt-5.6-luna**.
- **GPT-5.6 tier migration (2026-07-09 GA):** pricing and the >272K surcharge are re-confirmed for
  Sol/Terra directly against the pricing page (see `KB-gpt-5.6.md` §2); Terra/Luna cached-input
  rates, context-window size, and knowledge cutoff are **not** independently re-confirmed — see
  `KB-gpt-5.6.md` §9 for the full list of facts dropped for lack of verification.
- **"Claude Fable 5" / "Claude Mythos 5" / "Mythos Preview"** appear in live official docs but are
  outside this KB's scope and the research agent's training knowledge — flagged, not investigated.

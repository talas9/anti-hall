# Context-Window Discipline: A Consolidated Field Guide

_Swarm-synthesized 2026-06-02 from 130 selected sources (123 read) across official docs + arXiv papers + practitioner sources; 637 technique-observations reconciled. Regenerate via the context-preservation-research workflow._


## Thesis

An LLM agent's main context window is a finite, *depleting* attention budget, not a storage tank — as token count grows, recall and accuracy degrade (a phenomenon Anthropic names **context rot**), so the goal is to make the window fill **slower** and stay **high-signal**, not merely larger. Across Anthropic, OpenAI, and Google's official guidance the same playbook converges: **cache the static prefix** (don't re-pay for it), **delegate exploration to isolated sub-agents** (keep only their distillate), **compact and prune the growing tail** (summarize dialogue, clear stale tool results), **retrieve just-in-time instead of stuffing** (hold pointers, load slices), **externalize durable state to files/memory** (survive resets), and **clamp output and reasoning tokens** (don't bloat the transcript you have to re-read). These are complementary layers, not competitors — production systems (e.g. Claude Code) run several at once.

### Top highest-leverage techniques (ranked)

| # | Technique | Why it ranks here | Headline evidence |
|---|-----------|-------------------|-------------------|
| 1 | **Sub-agent delegation with isolated context** | Removes the single largest source of bloat — raw exploration — from the main window entirely | Sub-agent spends ~tens of thousands of tokens, returns a 1–2k summary; multi-agent beat single-agent Opus by **90.2%** [a1, a6] |
| 2 | **Prompt caching of the static prefix** | Doesn't reduce tokens but slashes the *cost/latency* of carrying them, making a large stable context economically free to keep | Cache read ≈ **0.1×** input price; up to **90% cost / 80% latency** reduction on repeated prefixes [c1, o-cache] |
| 3 | **Compaction / summarization of the growing tail** | The primary lever for multi-hour coherence; converts linear growth into reset-and-resume | ~**50% peak-token reduction**; input resets to ~2k after each event [cb-comp, sdk-comp] |
| 4 | **Tool-result clearing (context editing)** | Cheapest, safest prune — drops re-fetchable bulk the model already consumed | **84% token reduction** in a 100-turn search; 29% standalone improvement [ce1] |
| 5 | **Just-in-time retrieval over stuffing** | Holds cheap pointers (paths, IDs, queries); loads only the needed slice | Claude Code analyzes large DBs via `head`/`tail` without loading full objects [a1] |
| 6 | **Memory externalization (files / memory tool)** | Persists state *across* resets so the window needn't carry long-horizon facts | Memory + context-editing gave **39%** improvement [mem1] |
| 7 | **Output- & reasoning-token discipline** | Every emitted token re-enters the transcript you must re-read; clamping density compounds | Verbosity caps, reasoning-effort tuning, thinking-block stripping [g5-2, reason] |
| 8 | **Tool-output / tool-definition discipline** | Tools dominate the window; concise outputs + deferred schemas keep per-call cost low | Tool selection holds with 100k+ non-tool tokens; defer via tool-search [sdk1, cw] |

---

## 1. Prompt caching

> **Mechanism class:** Doesn't shrink context — makes a large *stable* context cheap to carry, so you can keep high-value background resident without re-paying. KV/prefix reuse at ~0.1× input cost.

### 1.1 Cache the static prefix
**What:** Mark the end of a reusable prefix (tools, system prompt, large background) with a cache breakpoint; identical prefixes on later requests are served as `cache_read_input_tokens` at ~0.1× base input price. **Mechanism:** later requests with a byte-identical prefix reuse cached compute instead of re-billing/re-processing it. **When:** any repeated or multi-turn workload with a stable head. **Trade-offs:** minimum cacheable prompt 1,024 tokens (model-dependent; 4,096 on some); a breakpoint on content that changes every request (timestamps) *never* hits; not on Bedrock/Vertex for automatic caching. **Convergence:** Anthropic, OpenAI, Google, and Vertex all describe the same prefix-hash mechanism. [c1, o-cache, g-cache, g-impl, vx-explicit]

### 1.2 Static-before-dynamic ordering
**What:** Put static content (system, tools, examples, docs) first; volatile content last, maximizing the cacheable prefix. **Mechanism:** cache invalidation is hierarchical (tools → system → messages); any change invalidates from that level down, so a static head and volatile tail keep the longest reusable prefix. **Trade-offs:** requires prompt discipline; dynamic-first ordering forfeits caching entirely. **Convergence:** unanimous across Anthropic, OpenAI, Gemini, Vertex. [c2, o-cache, g-cache, vx-prefix]

### 1.3 Multiple breakpoints by change-frequency
**What:** Use up to 4 breakpoints to cache sections changing at different rates (tools rarely, system daily, conversation continuously). **Mechanism:** each breakpoint is an independent segment, so a fast-changing tail doesn't invalidate a slow head; a second breakpoint near the growing tail beats the 20-block lookback window. **Trade-offs:** only 4 slots; longer-TTL breakpoints must precede shorter-TTL ones; a wasted slot on volatile content yields no hits. [c3] *(Anthropic-specific mechanics.)*

### 1.4 Multi-turn incremental caching
**What:** Mark each turn's final block so the growing history caches incrementally and re-reads cheaply. **Mechanism:** each turn writes a small new tail segment; the next turn reads the whole prior prefix from cache (refreshes free on hit) and writes only the delta. **Trade-offs:** each turn must add <20 blocks for automatic lookback; not on Bedrock/Vertex. [c4]

### 1.5 TTL / retention tuning
**What:** Extend cache lifetime for slow or bursty workloads. **Mechanism:** longer TTL keeps the prefix warm across gaps so it's still a cheap read. **Reconciliation of the cost knob across vendors:**
- **Anthropic:** 5-min write = 1.25×, 1-hour write = 2× base input — use 1-hour for side-agents / slow chats reused >5 min but <1 hr apart. [c5]
- **OpenAI:** default in-memory 5–10 min; *Extended Prompt Caching* offloads KV to GPU-local storage for up to **24 hours** (newer models only). [o-cache]
- **Gemini/Vertex:** TTL configurable (default ~1 hour, no hard bounds), billed by token-count × storage-duration. [g-cache, vx-explicit]
> *Conditions:* longer TTL only pays off if reuse is frequent enough to amortize the higher write cost / storage fee.

### 1.6 Explicit vs implicit caching (Gemini/Vertex; OpenAI implicit)
**What:** *Explicit* — declare a named cache once, reference by resource name at a steep discount (90% on Gemini 2.5+/Vertex; 75% on 2.0). *Implicit* — automatic, zero-setup discount when prefixes are shared. **Mechanism:** explicit pays full processing once then discounts references; implicit fires opportunistically on shared prefixes. **Trade-offs:** explicit = developer effort + storage cost, predictable savings; implicit = no control, no guarantee, no storage cost. Minimum thresholds: Gemini 3 = 4,096 tokens, 2.0/2.5 = 2,048; OpenAI implicit ≥1,024. **Reconciliation:** prefer explicit when a large static context is referenced repeatedly; implicit is a free bonus on naturally repeating traffic. [g-impl, vx-explicit, vx-implicit, o-cache]

### 1.7 Cache pre-warming & measurement
**What:** Send a `max_tokens:0` request to write the cache before real traffic; track `cache_read`/`cache_creation`/`input_tokens` to confirm hits. **Mechanism:** pre-warm eliminates first-request write latency; usage fields decompose each request so you find misplaced breakpoints. **Trade-offs:** pre-warm rejected with streaming/thinking/structured-output/batch; `input_tokens` counts only post-breakpoint tokens (misreading it masks misses). **Cross-vendor:** Gemini exposes `usage_metadata.cachedContentTokenCount`; OpenAI `prompt_cache_key` steers routing for higher hit rates. [c6, c7, g-meas, o-cache]

### 1.8 Caching aligned with compaction
**What:** Cache the system prompt on its own breakpoint so it survives compaction; only the fresh summary is newly written. **Mechanism:** independent cache_control keeps the system prompt cached across compaction events. [c8]

---

## 2. Delegation / sub-agent context isolation

> **Mechanism class:** Move heavy exploration into a *separate* window; the orchestrator only ever sees the distilled result. The single biggest lever against main-window bloat.

### 2.1 Sub-agent delegation with isolated windows
**What:** A lead decomposes a task into subtasks run by separate agents, each with its own context; they explore heavily but return only a condensed summary. **Mechanism:** exploratory detail (tens of thousands of tokens) stays in the child window; only a ~1–2k distillate enters the lead's attention budget; parallel children also compress by dividing the search space. **When:** tasks requiring sifting large volumes where most info is irrelevant; heavily parallelizable research. **Trade-offs:** multi-agent uses **~15× more tokens** than chat — only worth it for high-value parallelizable work; **not** for most coding tasks needing shared real-time state; needs detailed task descriptions or children duplicate work / leave gaps; adds orchestration latency. **Convergence:** Anthropic engineering, Agent SDK, and multi-agent research all agree on isolation + condensed return. [a1, a6, sdk-sub] **Evidence:** multi-agent (Opus lead + Sonnet children) beat single Opus by **90.2%**; parallelization cut research time up to **90%**.

### 2.2 Parallel tool calls + parallel sub-agent spawning
**What:** Run multiple tools and 3–5 sub-agents concurrently. **Mechanism:** fits more reasoning into the same time/context budget. **Trade-offs:** synchronous coordination bottlenecks; async adds state-consistency and error-propagation complexity. [a7]

### 2.3 Artifact output redirection (filesystem/DB bypass)
**What:** Route large structured sub-agent outputs straight to external storage instead of copying them back through the lead's conversation. **Mechanism:** prevents re-encoding large code/reports/data into the lead's history multiple times. **When:** structured outputs (code, reports, visualizations). **Trade-offs:** limited to structured outputs; adds system complexity. [a-artifact]

### 2.4 Effort-scaling guardrails & start-wide-then-narrow
**What:** Encode rules matching agent/tool count to query complexity (1 agent for fact-finding, 10+ for complex); prompt agents to issue short broad queries first. **Mechanism:** prevents over-spending tokens on simple queries; broad queries return more per token before narrowing. **Trade-offs:** rigid rules miss edge cases; premature narrowing misses specialized info. [a-effort, a-wide]

### 2.5 Local-context vs LLM-context separation
**What:** Keep tool data/dependencies in code (local context) out of the model's input; only conversation history and explicit inputs reach the LLM. **Mechanism:** runtime/sensitive data stays usable by tools without polluting the window. **Trade-offs:** requires explicit mechanisms to surface info to the LLM when needed. [oa-local]

> **Reconciliation — when delegation is *wrong*:** All sources agree delegation costs tokens and latency overall; it *redistributes* tokens away from the main window rather than reducing total spend (~15×). Use it when the main window's signal is the bottleneck, not when total cost is — and avoid it for tightly-coupled coding tasks needing shared real-time state. [a6, a1]

---

## 3. Compaction & summarization

> **Mechanism class:** When the tail grows large, replace older turns/reasoning with a high-fidelity summary and continue. Converts linear growth into reset-and-resume. Inherently **lossy**.

### 3.1 Server-side compaction (auto-summarize at threshold)
**What:** When input crosses a configured trigger, the platform summarizes user messages, reasoning, tool calls/results into one block and continues; prior blocks are dropped on later requests. **Mechanism:** keeps active context focused as the model would otherwise lose focus across full history. **Evidence:** ~**50% peak reduction** (335k → 169k tokens); high-level facts preserved 3/3, obscure appendix specifics lost. **Trade-offs:** adds a sampling step (cost/latency); may misfire when tools are defined (model calls a tool instead of summarizing); lossy — don't use when you need verbatim fidelity; no cross-session persistence. **Convergence:** Anthropic (`compact_20260112`), OpenAI Responses, and SDK all implement this. [comp1, cb-comp, o-comp, gpt5-comp] **Recommendation alignment:** both Anthropic and OpenAI recommend **server-side** over client-side (handles edge cases, avoids cache-token miscounting). [sdk-comp, o-comp]

### 3.2 Trigger-threshold tuning
**What:** Set the input-token count at which compaction fires (Anthropic default 150k, min 50k; SDK default 100k). **Mechanism:** lower fires more often (smaller windows, more cost, more signal loss); higher keeps more raw detail but risks limits. **Reconciliation of recommended thresholds by workflow:** 5k–20k for sequential entity processing (frequent, minimal accumulation); 50k–100k for multi-phase; 100k–150k to preserve raw detail. **Critical caveat:** "the threshold should not be set too low, otherwise the summary itself could trigger a compaction." [comp-trig, sdk-trig]

### 3.3 Custom summarization instructions
**What:** Replace the default summarizer prompt to force preservation of task-critical specifics (code snippets, variable names, decisions, every quantitative figure with source, which docs read/remain). **Mechanism:** directs the lossy summary to keep the signal that matters; commonly forbids tool calls during summarization. **Trade-offs:** custom instructions *fully replace* the default — a poor prompt drops what the default would have kept. **Convergence:** Anthropic and OpenAI cookbooks both stress domain-specific summary prompts; OpenAI's session-memory cookbook adds **contradiction-check, temporal-ordering ("most recent wins"), and hallucination flags (mark UNVERIFIED)** to prevent "summary poisoning." [comp-instr, cb-instr, sdk-sumprompt, oa-sumdesign]

### 3.4 Pause-after-compaction + token-budget tracking
**What:** Halt after the summary to retain recent messages verbatim and control the next request; estimate cumulative usage via `n_compactions × trigger` and gracefully wrap up at a budget. **Mechanism:** two-call control over what continues; compaction counter approximates total spend. **Trade-offs:** two API calls per event; estimates are approximate. [comp-pause, comp-budget]

### 3.5 Client-side / manual compaction
**What:** SDK or app monitors token usage and, past a threshold, injects a summary prompt that replaces the entire history with a ~2–3k structured block (Task Overview / Current State / Discoveries / Next Steps / Context to Preserve). **Evidence:** 105k → 2.5k tokens; 5-ticket workflow **58.6% reduction**. **Trade-offs:** Anthropic recommends server-side instead; SDK **miscounts tokens with server-side tools** (cache_read inflation triggers premature compaction); does **not** work with server-side extended thinking or web search; loses precise early-detail recall. **Cheaper-model option:** generate summaries with a faster/cheaper model (client-side only). [sdk-comp, sdk-cheap, comp-cheap]

### 3.6 Compaction at workflow boundaries / modular structuring
**What:** Trigger compaction at meaningful task boundaries, not every turn; structure work into independent units so each unit's tool output can be discarded after completion. **Mechanism:** processing entities one at a time creates checkpoints where intermediate results become noise; low signal-loss because only intermediate noise is removed. **Trade-offs:** only works for loosely-coupled phases; tightly interdependent phases break this. **Convergence:** OpenAI ("compact at boundaries, not every turn") and Anthropic (modular/one-feature-at-a-time) agree. [oa-boundary, sdk-modular]

### 3.7 Compaction is necessary-but-insufficient
**What:** Built-in compaction extends runtime but must be paired with scaffolding (initializer, feature lists, progress files, memory). **Mechanism:** compaction reduces tokens but doesn't preserve enough *structure* for long-horizon coherence alone. [harness-comp]

> **Reconciliation — compaction vs. trimming vs. clearing:** These are three different prunes with different loss profiles. **Trimming** (last-N turns) is zero-latency and verbatim but abruptly loses long-range constraints/IDs — best for independent/ops tasks. **Summarization** retains long-range memory but can drop/misweight details and risks summary-poisoning — best for long sessions needing continuity. **Tool-result clearing** (§4) loses only re-fetchable bulk. Use trimming for short workflows, summarization for long continuity, clearing for tool-heavy loops — and combine. [oa-trim, oa-summ]

---

## 4. Pruning / eviction / sliding-window

> **Mechanism class:** Mechanically remove the lowest-signal tokens (stale tool results, old reasoning, old turns) under a threshold, keeping the window bounded.

### 4.1 Tool-result clearing (`clear_tool_uses_20250919`)
**What:** Server-side, clears the oldest tool results past a threshold, replacing them with a placeholder while keeping the `tool_use` record. **Mechanism:** older results (file contents, search output) aren't needed once consumed; the placeholder lets the model know it was removed and re-fetch if needed. **Evidence:** clearing 2 of 3 file reads: 128k → 43k (**67%**); **84% reduction** in a 100-turn web search; **29%** standalone improvement. **Trade-offs:** only helps re-fetchable output (not dialogue/reasoning); invalidates cached prefixes when it fires (cache-write cost) — gate with `clear_at_least`; agent may re-fetch if its notes were incomplete (costly for slow APIs). **Convergence:** the single most-cited "safe, light-touch" prune across Anthropic docs, cookbook, and engineering blog. [ce1, cb-clear, a3]

### 4.2 Clearing config knobs (`keep` / `clear_at_least` / `exclude_tools` / `clear_tool_inputs`)
**What:** Tune which/how-many results survive: `keep` retains N most-recent; `clear_at_least` ensures each firing frees enough to justify breaking cache; `exclude_tools` pins high-value tools (e.g. `memory`, `web_search`); `clear_tool_inputs` optionally also drops inputs. **Trade-offs:** `keep` too low loses recently-useful results; `clear_at_least` too high never fires (window keeps growing); forgetting `exclude_tools:['memory']` wipes memory results. [ce-knobs, cb-knobs, ce-excl]

### 4.3 Thinking-block handling
**What:** Two related mechanisms — (a) **automatic stripping**: the API removes prior turns' thinking blocks from the context calculation by default (billed once as output, not carried as input); (b) **explicit clearing** (`clear_thinking_20251015`) for the within-tool-cycle case, with `keep` to balance cache vs context. **Mechanism:** reasoning can be substantial; not re-feeding it avoids waste. **Critical exception:** the exact thinking block accompanying a tool request **must** be returned with its `tool_result` (cryptographic signature) — modifying it errors. **Cross-vendor parallel:** Gemini's **thought signatures** must be circulated back to preserve reasoning across tool calls (missing → 400 error in function calling). **Trade-offs:** aggressive clearing loses reasoning continuity and invalidates cache. [cw-think, ce-think, g3-thoughtsig]

### 4.4 Combining clearing strategies
**What:** Run thinking-block clearing and tool-result clearing together (thinking listed first in the `edits` array). **Mechanism:** layers two independent eviction strategies. **Trade-offs:** ordering constraint mandatory; more cache-invalidation events. [ce-combine]

### 4.5 Context trimming (last-N turns) & history limiting
**What:** Keep only the most recent N user turns verbatim; drop everything before with a deterministic cutoff (`SessionSettings(limit=N)`, `session_input_callback`, `pop_item`). **Mechanism:** wholesale eviction of old turns caps historical accumulation. **Trade-offs:** abruptly loses long-range constraints/IDs/decisions; best for independent tasks where recent steps dominate, *not* sessions needing long-range continuity. **Mitigation:** pair with **session-memory reinjection** — flag important session decisions to reinject into the system prompt after a trim. [oa-trim, oa-limit, oa-pop, oa-callback, oa-reinject]

### 4.6 Token counting with editing preview
**What:** Use `count_tokens` to preview tokens *after* context editing (`original_input_tokens` vs `input_tokens`) before sending. **Mechanism:** quantify savings before the real request. **Trade-offs:** extra preview call. [ce-count]

---

## 5. Retrieval-over-stuffing (RAG / just-in-time)

> **Mechanism class:** Hold cheap references (paths, IDs, queries) and load only the needed slice at runtime, mirroring human cognition, instead of pre-loading everything.

### 5.1 Just-in-time context retrieval
**What:** Keep lightweight identifiers in context; load data at runtime via tools. **Mechanism:** the window holds pointers (cheap); the agent pulls only the slice it needs when it needs it. **Evidence:** Claude Code analyzes large DBs via targeted queries and `head`/`tail` without loading full objects. **Trade-offs:** runtime exploration slower than pre-computed data; needs opinionated tool engineering to avoid dead-ends. **Convergence:** Anthropic context-engineering, Agent SDK, memory-tool docs, and OpenAI function-tool docs all converge on "load on demand." [a1, sdk-jit, mem-jit, oa-fn]

### 5.2 Hybrid pre-load + just-in-time
**What:** Eagerly load a small high-value set (e.g. CLAUDE.md), fetch the rest on demand via glob/grep. **Mechanism:** balances latency vs freshness while keeping the eager footprint small. **Trade-offs:** requires tuning the boundary; adds conditional logic. [a2]

### 5.3 Agentic search over retrieval stuffing
**What:** Use bash primitives (grep/tail) to load only needed file sections; the filesystem + folder structure *is* the context engineering. **Mechanism:** selectively pulls slices instead of embedding whole documents. **Trade-offs:** slower than pre-indexed semantic search; needs well-structured files; weaker for fuzzy/conceptual queries. [sdk-agentic]

### 5.4 Semantic search (selective, secondary)
**What:** Vector chunk retrieval for faster/fuzzier lookups — add *only* when agentic search is insufficient. **Mechanism:** returns relevant excerpts rather than whole documents. **Trade-offs:** higher complexity/maintenance, less transparent, less accurate. **Reconciliation:** Anthropic's explicit ordering is **agentic-search-first, semantic-search-only-if-needed** — a deliberate inversion of the classic RAG-first default, justified by transparency and maintenance cost. [sdk-semantic, sdk-agentic]

### 5.5 Metadata-driven navigation
**What:** Use file paths, hierarchy, naming conventions, sizes, timestamps as lightweight signals for what to load. **Mechanism:** infer relevance from cheap metadata rather than reading full content. **Trade-offs:** requires well-organized, consistently-named structures. [a-meta]

### 5.6 Retrieval/web-search for grounding; MCP retrieval
**What:** Fetch only task-relevant excerpts to ground responses (retrieval/web-search/function tools), or expose docs through an MCP search tool the agent queries on demand. **Mechanism:** supplies excerpts rather than whole knowledge bases; the full docs never occupy the main window. **Trade-offs:** retrieval quality determines signal; adds latency/tool calls; depends on external service. **Convergence:** OpenAI Agents SDK and Gemini coding-agents docs both frame retrieval-on-demand as the alternative to baking everything into context. [oa-retrieve, g-mcp]

### 5.7 Context-gathering stop criteria + tool-call budgets
**What:** Define explicit early-stop criteria and a maximum tool-call budget ("top hits converge ~70%", "absolute max 2 tool calls"); bias toward internal knowledge over repetitive search. **Mechanism:** caps how many search/read outputs append to context. **Trade-offs:** risks incomplete info — needs escape hatches; biasing to internal knowledge risks hallucination. **Note:** Cursor found `MAXIMIZE_CONTEXT_UNDERSTANDING` *caused* over-searching — a concrete anti-pattern. [g5-stop, g5-bias]

---

## 6. Tool / observation-output discipline

> **Mechanism class:** Tools are the most prominent thing in the window; control what they emit and how many definitions sit resident.

### 6.1 Concise tool design (tool-output discipline)
**What:** Design tools to return only essential, structured info. **Mechanism:** tools are the primary actions in the window, so concise outputs maximize per-call efficiency. **Trade-offs:** upfront API design cost; too-narrow tools proliferate, too-broad miss edge cases. [sdk1]

### 6.2 Minimal tool-set curation + good descriptions
**What:** Keep tools few and non-overlapping; write descriptions that prevent wrong paths; add source-quality heuristics. **Mechanism:** fewer definitions = fewer tokens and less wasted exploration ("if a human can't say which tool to use, the agent can't either"); quality heuristics stop agents filling context with content-farm junk. **Trade-offs:** limits flexibility; needs upfront tool engineering. [a-tools, a-toolqual]

### 6.3 Reduce tool-definition context (tool search tool)
**What:** Defer loading full tool schemas until needed via a tool-search tool. **Mechanism:** large tool catalogs don't sit permanently in context; selection holds even with 100k+ non-tool tokens. **Trade-offs:** deferred schemas add a lookup step; only worth it for large catalogs. **Cross-vendor:** Gemini's "Skills as compact rules with retrieval fallback" defers bulk docs to MCP/llms.txt similarly. [cw-tooldef, g-skills]

### 6.4 Tool-result clearing as a discipline
See §4.1 — the eviction counterpart to concise tool design. [ce1]

### 6.5 Per-tool uncertainty thresholds
**What:** Set distinct clarification/uncertainty thresholds per tool (high for search to suppress repetitive low-value calls, lower for checkout). **Mechanism:** suppresses repetitive search outputs entering context. **Trade-offs:** domain-specific calibration. [g5-toolthresh]

---

## 7. Memory externalization

> **Mechanism class:** Persist state *outside* the token budget so long-horizon facts survive resets without occupying the live window. This is the cross-session complement to retrieval.

### 7.1 Memory tool / structured note-taking (files)
**What:** Agent writes notes to external storage (NOTES.md, `/memories`, to-do lists) and pulls them back after resets via view/create/str_replace/etc. **Mechanism:** offloads state to files; the agent checks memory before tasks and loads only what's relevant. **Evidence:** Claude playing Pokémon keeps tallies across thousands of steps and survives resets; memory + context-editing gave **39%** improvement; Session 2 loaded ~3k tokens of notes instead of re-reading docs. **Trade-offs:** client-side implementation (you secure the backend, enforce path-traversal protection + size limits); file-op latency; needs guidance on *what* to save or memory clutters; pointless for genuinely independent sessions. **Convergence:** Anthropic memory tool/engineering, Agent SDK file-system-as-context, and OpenAI all agree. [mem1, a-notes, sdk-fs]

### 7.2 Progress-file + scaffolding externalization (multi-session bootstrap)
**What:** An initializer session writes structured artifacts (init.sh, progress log, feature checklist, initial git commit) before substantive work; later sessions read them to recover state in seconds; work one feature at a time, mark complete only after end-to-end verification. **Mechanism:** front-loads setup into reusable artifacts so each fresh window reads scaffolding rather than re-deriving build/run/test. **Trade-offs:** upfront discipline; an out-of-date progress log misleads the next session. **Key auto-injected prompt:** "ASSUME INTERRUPTION: Your context window might be reset at any moment." **Convergence:** Anthropic harness blog + memory-tool multi-session pattern. [harness-init, harness-feature, harness-progress, mem-bootstrap]

### 7.3 JSON over Markdown for critical state
**What:** Store critical state (feature lists) as JSON, not Markdown. **Mechanism:** JSON's rigidity makes the model less likely to inappropriately rewrite/overwrite it. **Trade-offs:** less human-readable; empirical observation. *(Single-source.)* [harness-json]

### 7.4 Git as compact state / recovery
**What:** Use version control with descriptive commits as compact recoverable state. **Mechanism:** the agent reverts to working states and reads concise git logs instead of carrying history in context. **Trade-offs:** needs VCS; less applicable outside code. [harness-git]

### 7.5 Memory stores reusable patterns, not case facts
**What:** Persist durable process/workflow lessons; keep case-specific facts in reviewed artifacts, not memory. **Mechanism:** keeps the persistent layer small and high-signal — "Memory should help future agents work better; it should not become a shadow compliance record." **Trade-offs:** requires discipline to separate durable from ephemeral. [oa-mempattern]

### 7.6 State-based memory vs retrieval-based; scoped memory
**What:** Maintain a structured user-state object (YAML frontmatter for fixed fields + Markdown notes) instead of loose semantically-searched documents; separate **global** (durable cross-session) from **session** (short-lived) scope. **Mechanism:** authoritative fields with precedence enable deterministic decisions without fragile semantic search; scoping filters one-off noise out of persistent context. **Trade-offs:** manual schema design; doesn't scale to unlimited memory dimensions; needs a promotion step to move session→global. [oa-state, oa-scope]

### 7.7 Memory distillation, consolidation & forgetting
**What:** Gate writes via a dedicated `save_memory_note` tool (durable/actionable/explicit only, reject speculation + sensitive PII); an end-of-session job merges into global with recency-wins precedence, dedups, and **prunes stale notes** under a "no invention" rule. **Mechanism:** active forgetting prevents the persistent layer growing without bound and degrading quality. **Trade-offs:** consolidation is "the most error-prone stage" — bad merges or over-aggressive pruning lose real signal. **Supporting:** metadata-enhanced notes (ISO dates + keywords) drive recency weighting and consolidation routing. [oa-distill, oa-consol, oa-meta]

### 7.8 Precedence-ordered, advisory memory injection
**What:** Inject memory in delimited blocks (`<user_profile>`, `<memories>`) with strict precedence: **current user message > session context > global memory**, treated as advisory not authoritative. **Mechanism:** prevents stale/conflicting memory over-influencing output, reducing hallucinations and keeping injected context trustworthy. **Trade-offs:** advisory framing may under-weight memory that should dominate. [oa-inject]

### 7.9 Memory + compaction composition; all-three composition
**What:** Pair compaction with memory so critical facts survive the lossy summary across boundaries; run **clearing + compaction + memory** together (each handles a different growth source). **Mechanism:** clearing drops re-fetchable tool results, compaction summarizes dialogue/reasoning, memory persists across sessions — combined they keep a bounded high-signal window (what Claude Code uses). **Evidence:** clearing-alone 173k peak (49%), compaction-alone 169k (50%), baseline 335k; production uses the combination. **Trade-offs:** most complex to tune; thresholds interact (clearing vs compaction trigger order); always `exclude_tools:['memory']` from clearing. [mem-compose, cb-allthree]

### 7.10 Server-side conversation state
**What:** Persist turns server-side (Conversations API / `previous_response_id`) instead of re-sending full history. **Mechanism:** state lives server-side; pass an ID to continue. **Trade-offs:** **all prior input tokens still count toward billing** even when chained server-side — this reduces *transmission*, not *context size or cost*. `store` flag controls 30-day retention (privacy vs retrieval trade-off). [oa-convstate, oa-store]

---

## 8. Output-token discipline

> **Mechanism class:** Every token the model *emits* re-enters the transcript it must re-read next turn — clamping output density compounds across a long session.

### 8.1 Verbosity clamping / output-shape constraints
**What:** Explicit length limits (3–6 sentences, ≤5 bullets); prefer compact bullets over narrative. **Mechanism:** fewer output tokens keep the growing transcript denser. **Trade-offs:** risk of undershooting detail on genuinely complex tasks. [g5-2]

### 8.2 Verbosity parameter (split thinking from answer length)
**What:** Control final-answer length independently of reasoning, scoped per tool (Cursor: low verbosity globally, high only for coding tools). **Mechanism:** caps output tokens where long output isn't needed. **Trade-offs:** controls output, not reasoning tokens. [g5-verbosity]

### 8.3 Structured tool preambles instead of running narration
**What:** Rephrase the goal and outline a plan once up front rather than narrating every step. **Mechanism:** replaces redundant per-call narration with a single structured plan. [g5-preamble]

### 8.4 Scope discipline / forbid feature creep
**What:** Explicitly forbid extra features/components/UX embellishments; force the simplest valid interpretation of ambiguity. **Mechanism:** prevents scope drift bloating both output and follow-up context. **Trade-offs:** may undershoot implicit polish. [g5-scope]

### 8.5 `max_output_tokens` cap / context-window buffer
**What:** Cap total generated tokens (reasoning + visible); reserve ≥25,000 tokens headroom for reasoning/output. **Mechanism:** halts runaway generation (`status: incomplete`); keeps headroom so history doesn't consume the space needed to think/answer. **Trade-offs:** may truncate; if the cap hits during reasoning you pay input+reasoning with no visible output. [reason-maxtok, reason-buffer]

---

## 9. Compact formats & structured output

> **Mechanism class:** Denser representations carry the same signal in fewer tokens.

### 9.1 Code as compact output format
**What:** Emit code rather than verbose prose for complex/repeatable operations. **Mechanism:** code is precise, composable, reusable — denser than prose — and offloads execution to a runtime. **Evidence:** Claude.ai file creation relies entirely on code generation. **Trade-offs:** needs an execution environment; debugging overhead. [sdk-code]

### 9.2 Structured / schema-constrained output
**What:** Provide an explicit JSON schema; mark required vs optional; use `null` for missing data instead of guessing. **Mechanism:** forces compact schema-compliant output, avoiding speculative filler. **Trade-offs:** reduces flexibility for unstructured synthesis; can't capture intent the schema doesn't model. **Convergence:** OpenAI extraction guidance + Gemini structured outputs (combinable with built-in tools). [g5-2-schema, g3-structured]

### 9.3 Curated codebase context over full dumps
**What:** Provide scoped design principles/architecture rules/directory structure (e.g. XML `<code_editing_rules>`) instead of dumping the whole codebase. **Mechanism:** replaces a large raw payload with a small structured spec. **Trade-offs:** upfront documentation effort; specs go stale. [g5-curated]

### 9.4 Manifest-based workspace (stage files, don't paste)
**What:** Put source docs/manifests/helpers/output dirs in a bounded sandbox the agent reads on demand, instead of pasting large content into the prompt. **Mechanism:** keeps evidence external, fetched only when needed. **Trade-offs:** requires Filesystem/Shell tooling. [oa-manifest]

### 9.5 Canonical few-shot examples + right-altitude prompting
**What:** Use a few diverse representative examples instead of exhaustive edge-case lists; calibrate prompt specificity between brittle hardcoding and vague generality. **Mechanism:** examples encode behavior at high information density; right-altitude prompts keep the persistent prompt lean. **Trade-offs:** incomplete coverage; minimal prompts risk underperformance, over-specification raises maintenance. [a-fewshot, a-altitude]

### 9.6 Concise prompting / remove contradictions
**What:** Drop legacy chain-of-thought/few-shot scaffolding for natively-reasoning models; eliminate contradictory/vague instructions. **Mechanism:** cuts input tokens; contradictions force the model to *spend reasoning tokens* reconciling them. **Trade-offs:** over-trimming drops needed detail; modern models follow instructions literally so contradictions are more damaging. **Convergence:** Gemini 3 ("be concise, it over-analyzes verbose prompts") + GPT-5 ("remove contradictions"). [g3-concise, g5-contradict]

### 9.7 System-prompt instructions for always-useful info
**What:** Put genuinely always-relevant facts (user name, date) in agent instructions (static or dynamic function). **Mechanism:** avoids re-encoding the same data every turn. **Trade-offs:** only for always-relevant info; overloading wastes the always-resident budget. [oa-sysprompt]

---

## 10. Attention / KV-cache / model level

> **Mechanism class:** Levers below the message layer — reasoning depth, media tokens, position, model choice.

### 10.1 Reasoning-effort / thinking-level tuning
**What:** Set reasoning depth to match the task (`none|minimal|low|medium|high|xhigh`; Gemini `thinking_level`). **Mechanism:** lower effort generates fewer reasoning tokens, consuming less budget and latency. **Reconciliation of defaults:** GPT-5.2 defaults to `none`; Gemini 3.1 Pro defaults to `high`, Flash-Lite to `minimal` — so the *same* knob has opposite defaults by vendor/tier; set it explicitly. **Trade-offs:** higher effort = more latency/cost/reasoning tokens; lower risks shallow reasoning on hard tasks; minimal varies more by prompt; low-temp + high-thinking can loop. [g5-2-effort, g3-thinking]

### 10.2 Reasoning persistence / pass-back across tool calls
**What:** Persist reasoning across tool calls (`previous_response_id`, pass-back reasoning items, encrypted reasoning content for zero-retention orgs). **Mechanism:** avoids re-reasoning from scratch — more efficient outputs per token. **Evidence:** Tau-Bench Retail 73.9% → 78.2% with the Responses API. **Trade-offs:** requires Responses API; stateless mode needs manual/encrypted item management. **Cross-vendor:** Gemini thought signatures (§4.3) are the same idea. [g5-reasonpersist, reason-passback, reason-encrypted, g3-thoughtsig]

### 10.3 Reasoning summaries instead of raw reasoning
**What:** Request `summary: auto|concise|detailed` for human-readable reasoning without raw-storing all reasoning tokens. **Mechanism:** surfaces a compact summary rather than the full trace. **Trade-offs:** summary generation uses extra tokens. [reason-summary]

### 10.4 Media-resolution control / code execution with vision
**What:** Cap tokens per image/frame/PDF (`media_resolution`); let the model write code to zoom/crop an already-supplied image instead of re-uploading. **Mechanism:** visual inputs occupy far fewer tokens (PDF quality saturates at medium ~560 tokens; video low=medium=70/frame); code-execution avoids re-adding the full image each step. **Trade-offs:** low resolution loses fine detail; code-execution adds latency. [g3-media, g3-codevision]

### 10.5 Query positioning at the end of long prompts
**What:** Place the question *after* all context, especially when context is long. **Mechanism:** improves recall/signal on long inputs without adding tokens; anchors reasoning to the provided data, reducing wasted over-analysis. **Convergence:** Gemini long-context and Gemini 3 both recommend instructions-after-context. **Note:** mirrors OpenAI's static-first / dynamic-last *caching* ordering — but the motivations differ (caching vs recall), and they're compatible since both put the volatile query last. [g-querypos, g3-instrafter]

### 10.6 Selective token inclusion
**What:** Don't pass tokens the model doesn't need. **Mechanism:** reduces processing overhead and latency. **Trade-offs:** requires upfront filtering; conflicts with the context-stuffing paradigm for high-recall tasks. **Reconciliation:** Gemini also notes multi-needle retrieval *degrades* with more needles in one context (single-needle ~99%; 100 needles may need 100 requests) — direct evidence that stuffing hurts both cost *and* accuracy. [g-selective, g-multineedle]

### 10.7 Model selection by task tier
**What:** Match model tier (Pro/Flash/Flash-Lite; upgrade model vs enlarge budget) to task complexity. **Mechanism:** cheaper models for high-volume work lower cost and their lower default verbosity reduces bloat; a stronger model can beat more tokens. **Evidence:** "Token usage explains **80% of variance**" in search; "upgrading to Sonnet 4 is a larger gain than doubling the token budget on 3.7." **Trade-offs:** underpowered = lower quality; over-selection wastes budget. [g3-modeltier, a-tokenperf]

### 10.8 Batch / flex inference offload
**What:** Offload high-volume non-interactive work to a background queue (Batch, ~50% price, ~24h) or off-peak compute (Flex, ~50% discount) for dependent agentic chains. **Mechanism:** decouples bulk processing from the interactive loop, keeping the main interactive context free. **Trade-offs:** async/sheddable; unsuitable for interactive turns. [g-batch, g-flex]

---

## 11. Verification & error-sprawl prevention (cross-cutting)

**Verification/feedback loops:** Use linting, visual feedback, or LLM judges to catch errors early before failed attempts accumulate. **Mechanism:** detecting mistakes before they compound stops the context filling with retry loops and failed-attempt history. **Trade-offs:** verification adds latency; false positives block valid output; judge-based checks are expensive. [sdk-verify] **Extended/interleaved thinking as scratchpad:** concentrate reasoning (plan up front, evaluate tool results before acting) to prevent wasteful exploration that bloats context — at the cost of more tokens per task. [a-thinking]

---

## 12. Measurement & budgeting (cross-cutting)

| Technique | What it measures | Source |
|-----------|------------------|--------|
| Per-iteration usage (`usage.iterations`) | Compaction vs message token cost; top-level excludes compaction so sum iterations | [comp-meas] |
| Cache performance fields | `cache_read` / `cache_creation` / `input_tokens` to confirm hits + find misplaced breakpoints | [c7, g-meas] |
| Token-counting before send | Estimate vs model limit; on 4.5+ overflow *stops* (`model_context_window_exceeded`) not errors | [cw-count, oa-budget] |
| Context-awareness / token budget | Model receives `<budget>` + per-tool-call `<system_warning>` of tokens used/remaining → proactive self-management (Sonnet 4.6/4.5, Haiku 4.5) | [cw-aware] |
| Compaction monitoring | Detect firing via message-count drop (31→1); confirm input resets vs grows linearly | [sdk-monitor] |
| Token-based performance analysis | Token usage = 80% of performance variance → guides model-vs-budget decisions | [a-tokenperf] |
| Memory eval harness | Distillation precision/recall, injection correctness, consolidation quality | [oa-memeval] |

> **Convergent principle (universal):** "Curate context, don't maximize it" — accuracy and recall **degrade** as tokens grow (context rot). Anthropic states it directly; Gemini's multi-needle data quantifies it; OpenAI's trimming/compaction cookbooks operationalize it. This is the *why* behind every technique above. [cw-rot, g-multineedle]

---

## Applicability to Claude Code / anti-hall orchestration

The anti-hall **Delegation-First Architecture** is, in effect, technique §2 (sub-agent isolation) applied as a standing discipline — and the literature strongly validates it while sharpening the conditions:

1. **The coordinator-keeps-clean rule is exactly right, and measurable.** Keeping the main agent free of heavy Bash/MCP/search output and delegating to Haiku/Explore sub-agents is the §2.1 isolation pattern: children burn tens of thousands of tokens, the main window receives only the distillate. The 90.2% multi-agent result and "token usage = 80% of variance" justify the cost. **But heed the ~15× token caveat** — delegation is for *protecting the main window's signal*, not minimizing total spend, and is *wrong* for tightly-coupled coding tasks needing shared real-time state. [a6, a1]

2. **Layer compaction + clearing + memory, don't rely on one.** The repo's context-protection discipline should treat auto-compaction (which "the system auto-compacts" relies on) as **necessary-but-insufficient** [harness-comp] and pair it with: tool-result clearing for the verbose Bash/MCP output the architecture already routes to sub-agents, and memory externalization (the existing `.continue-here.md` / `MEMORY.md` / progress-file pattern *is* §7.2). Always `exclude_tools:['memory']` when clearing. [cb-allthree, mem-compose]

3. **The "ASSUME INTERRUPTION" multi-session pattern maps directly onto the compact policy.** The repo's "treat compacts as invisible, update memory files (1–2 edits max), resume immediately" rule is the §7.2 progress-file bootstrap — and the literature's discipline of *marking work complete only after end-to-end verification* and keeping the progress log current is the missing reinforcement. [mem-bootstrap, harness-progress]

4. **Memory should hold reusable patterns, not case facts.** The Obsidian/graphify "FIRST RESORT" rule aligns with §7.5 — persist durable process/methodology knowledge, keep one-off case facts in reviewed artifacts (graphify graphs / git), and prune stale notes (§7.7 forgetting) so the knowledge layer stays high-signal. [oa-mempattern, oa-consol]

5. **Output discipline for sub-agent returns.** Instruct sub-agents to return distilled, structured summaries (§8, §9.2) and route large structured outputs to files rather than back through the orchestrator (§2.3) — directly relevant to anti-hall's "subagents report findings back so the main agent persists them." [a-artifact, g5-2]

6. **If using the Claude API directly**, cache the system prompt on its own breakpoint (§1.8) so it survives auto-compaction, and use the 1-hour TTL for slow agentic side-agents (§1.5) — both keep the always-resident base economically free across the long sessions this environment runs. [c8, c5]

---

## Caveats on evidence strength

- **Thin / single-source claims** (use with lower confidence): JSON-over-Markdown for state [harness-json]; the specific 90.2% / "80% of variance" figures are from one multi-agent study and may not generalize beyond research-style tasks [a6]; cheaper-model summarization is client-side-only and untested for fidelity here [sdk-cheap].
- **Vendor-specific mechanics** (don't port blindly): cache breakpoint counts/lookback windows, thinking-block signatures, thought signatures, media-resolution token counts, and reasoning-effort defaults all differ by vendor and model tier — verify against the current provider docs before relying on exact numbers.
- **Strongly convergent (high confidence):** context rot / curate-don't-maximize; prefix-caching mechanism and static-first ordering; sub-agent isolation; compaction as lossy-but-effective; just-in-time retrieval; tool-result clearing; memory externalization. These appear independently across Anthropic, OpenAI, and Google.

---

## Sources

### Anthropic — engineering blog
- Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents [a1, a2, a-meta, a-tools, a-fewshot, a-altitude, a-notes, a3]
- Effective harnesses for long-running agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents [harness-init, harness-feature, harness-progress, harness-git, harness-json, harness-comp]
- Multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system [a6, a7, a-artifact, a-effort, a-wide, a-toolqual, a-thinking, a-tokenperf]

### Anthropic — platform docs & cookbook
- Building agents with the Claude Agent SDK — https://claude.com/blog/building-agents-with-the-claude-agent-sdk [sdk1, sdk-sub, sdk-agentic, sdk-semantic, sdk-code, sdk-fs, sdk-verify]
- Compaction — https://platform.claude.com/docs/en/build-with-claude/compaction [comp1, comp-trig, comp-instr, comp-pause, comp-budget, comp-meas, c8]
- Context editing — https://platform.claude.com/docs/en/build-with-claude/context-editing [ce1, ce-knobs, ce-excl, ce-think, ce-combine, ce-count, sdk-comp, sdk-cheap, comp-cheap]
- Context windows — https://platform.claude.com/docs/en/build-with-claude/context-windows [cw-think, cw-aware, cw-rot, cw-tooldef, cw-count]
- Memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool [mem1, sdk-jit, mem-jit, mem-bootstrap, mem-compose]
- Prompt caching — https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching [c1, c2, c3, c4, c5, c6, c7]
- Cookbook: context-engineering tools — https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools [cb-comp, cb-instr, cb-clear, cb-knobs, cb-allthree]
- Cookbook: automatic context compaction — https://platform.claude.com/cookbook/tool-use-automatic-context-compaction [sdk-comp, sdk-trig, sdk-sumprompt, sdk-modular, sdk-monitor, o-comp]

### OpenAI — API docs
- Prompt caching — https://developers.openai.com/api/docs/guides/prompt-caching [o-cache]
- Compaction — https://developers.openai.com/api/docs/guides/compaction [o-comp]
- Conversation state — https://developers.openai.com/api/docs/guides/conversation-state [oa-convstate, oa-budget, oa-store]
- Reasoning — https://developers.openai.com/api/docs/guides/reasoning [reason-maxtok, reason-buffer, reason-passback, reason-summary, reason-encrypted]

### OpenAI — cookbook & Agents SDK
- GPT-5.2 prompting guide — https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide [g5-2, g5-2-schema, g5-2-effort, gpt5-comp]
- GPT-5 prompting guide — https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide [g5-stop, g5-bias, g5-preamble, g5-verbosity, g5-scope, g5-contradict, g5-toolthresh, g5-curated, g5-reasonpersist]
- Agents SDK — session memory — https://developers.openai.com/cookbook/examples/agents_sdk/session_memory [oa-trim, oa-summ, oa-sumdesign]
- Agents SDK — memory & compaction — https://developers.openai.com/cookbook/examples/agents_sdk/building_reliable_agents_memory_compaction [oa-boundary, oa-mempattern, oa-manifest]
- Agents SDK — context personalization — https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization [oa-state, oa-scope, oa-distill, oa-consol, oa-inject, oa-meta, oa-memeval]
- Agents SDK — context — https://openai.github.io/openai-agents-python/context/ [oa-local, oa-sysprompt, oa-fn, oa-retrieve]
- Agents SDK — sessions — https://openai.github.io/openai-agents-python/sessions/ [oa-limit, oa-pop, oa-callback, oa-reinject]
- Compaction (OpenAI Responses) — https://developers.openai.com/api/docs/guides/compaction [o-comp]

### Google — Gemini & Vertex AI
- Long context — https://ai.google.dev/gemini-api/docs/long-context [g-querypos, g-selective, g-multineedle]
- Caching — https://ai.google.dev/gemini-api/docs/caching [g-cache, g-impl, g-meas]
- Gemini 3 — https://ai.google.dev/gemini-api/docs/gemini-3 [g3-thinking, g3-thoughtsig, g3-media, g3-instrafter, g3-concise, g3-structured, g3-codevision, g3-modeltier]
- Optimization — https://ai.google.dev/gemini-api/docs/optimization [g-batch, g-flex]
- Coding agents — https://ai.google.dev/gemini-api/docs/coding-agents [g-mcp, g-skills]
- Vertex AI context cache overview — https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview [vx-explicit, vx-implicit, vx-prefix]

## Unreadable / skipped sources

- https://www.kaggle.com/whitepaper-prompt-engineering — returns only a page title/landing shell with no article body (whitepaper is a gated PDF download); no extractable technique text via WebFetch.
- https://arxiv.org/pdf/2502.11444 — PDF returned binary/FlateDecode-compressed stream, not extractable text; substituted the arXiv abstract page (https://arxiv.org/abs/2502.11444) which was readable and yielded the RetroLM/KV-level technique.
- https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/ — page served only a newsletter signup/navigation shell; article body not present in fetched content
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/token-efficient-tool-use — partial: the standalone token-efficient-tool-use page now redirects to the Claude model migration guide; only the migration note (Claude 4+ have built-in token-efficient tool use; legacy beta header is a no-op) was extractable, not the original page's full percentage/latency tables.
- https://docs.cline.bot/prompting/understanding-context-management — fetched repeatedly but the fetcher returns Cline provider setup/auth/billing content (apparent redirect or wrong-page serving), not the 'Understanding Context Management' article; no context-management techniques were retrievable.
- https://openai.com/index/api-prompt-caching/ — HTTP 403 Forbidden (blocked to WebFetch); content largely overlaps with the readable Prompt Caching 201 cookbook source.
- https://sankalp.bearblog.dev/how-prompt-caching/ (HTTP 404 Not Found; retried without trailing slash, also 404)

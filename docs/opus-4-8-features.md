# Claude Opus 4.8 — Feature Reference for Anti-Hallucination / Agentic Hook Work

**Released:** 2026-05-28  
**Model ID:** `claude-opus-4-8`  
**Research date:** 2026-05-29  
**Authoritative source:** [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)

---

## 1. Model Identity and Context Window

| Property | Value |
|---|---|
| API model ID | `claude-opus-4-8` |
| Context window | **1M tokens** (default on Claude API, Amazon Bedrock, Vertex AI) |
| Context window (Microsoft Foundry) | 200k tokens |
| Max output tokens | **128k** (synchronous Messages API) |
| Max output tokens (Batch API) | 300k (with `output-300k-2026-03-24` beta header) |
| Pricing (standard) | $5 / input MTok, $25 / output MTok (unchanged vs Opus 4.7/4.6) |
| Knowledge cutoff (reliable) | Jan 2026 |
| Training data cutoff | Jan 2026 |

1M context window is GA (not preview) on all three major cloud platforms. The 200k cap on Foundry is a Foundry-specific constraint, not a model limitation.

---

## 2. New API Features (4.8-specific)

### 2.1 Mid-Conversation System Messages

**What it is:** `role: "system"` messages can now appear inside the `messages` array, not just in the top-level `system` field. Placement rule: immediately after a `user` turn (or an `assistant` turn ending in server tool use); must either be the last entry or be followed by an `assistant` turn.

**Why it matters for agentic loops:**
- Injecting new constraints mid-session (e.g., "from now on require parameterized queries") no longer invalidates the prompt cache for all prior turns.
- The cached prefix stays stable; only the new instruction is processed as fresh input.
- No beta header required.
- Available on Claude API and Claude Platform on AWS only (not Bedrock, Vertex AI, Microsoft Foundry).
- **Only available on Opus 4.8** in the current generation.

**Anti-hallucination hook design:** A `PostToolUse` hook can append a `role: "system"` message with evidence gathered from the tool result, giving it system-level authority without re-processing the full conversation history. This preserves cache hits on the stable prefix.

Reference: [platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)

### 2.2 Refusal Stop Details (now publicly documented)

**What it is:** When Opus 4.7+ declines a request, the response now includes `stop_details` alongside `stop_reason: "refusal"`. No beta header required.

```json
{
  "stop_reason": "refusal",
  "stop_details": {
    "type": "refusal",
    "category": "cyber",        // or "bio" or null
    "explanation": "..."        // human-readable, not stable — don't parse programmatically
  }
}
```

**Categories currently documented:** `"cyber"`, `"bio"`, or `null` (when the refusal doesn't map to a named category).

**Hook relevance:** Allows routing refusals to different error-handling paths (e.g., log `"cyber"` and `"bio"` separately, surface specific user-facing messages). Available on 4.7 as well; 4.8 ships with the feature publicly documented for the first time.

Reference: [platform.claude.com/docs/en/build-with-claude/handling-stop-reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)

### 2.3 Lower Prompt Cache Minimum

Opus 4.8 minimum cacheable prompt length: **1,024 tokens** (down from a higher threshold on Opus 4.7). Prompts previously too short to cache now create cache entries with zero code changes.

**Impact:** Short agentic system prompts that missed the cache threshold on 4.7 now cache on 4.8, reducing input cost per turn in agent loops.

Reference: [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

---

## 3. Adaptive Thinking (the only thinking mode on Opus 4.8)

### 3.1 What changed vs Opus 4.6 and earlier

On **Opus 4.7 and Opus 4.8**, manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`) is **rejected with a 400 error**. The only supported thinking mode is adaptive.

Migration snippet:
```python
# Before (Opus 4.6 or earlier)
thinking = {"type": "enabled", "budget_tokens": 32000}

# After (Opus 4.7 and later — including 4.8)
thinking = {"type": "adaptive"}
output_config = {"effort": "high"}
```

### 3.2 How adaptive thinking works

- Thinking is **off by default** on 4.8. You must explicitly set `thinking: {type: "adaptive"}` to enable it.
- When enabled, Claude evaluates complexity per turn and decides whether and how much to think. It does not allocate a fixed budget.
- Interleaved thinking (thinking between tool calls) is **automatically enabled** in adaptive mode. This makes it especially effective for agentic workflows.
- At `high`, `xhigh`, and `max` effort, Claude almost always thinks. At `medium` and `low`, it may skip thinking for simple turns.

### 3.3 Thinking display defaults changed on 4.8

On **Opus 4.8 and Opus 4.7**, `thinking.display` defaults to `"omitted"` (empty `thinking` field, but `signature` still present for multi-turn continuity). This is a **silent change** from Opus 4.6 where the default was `"summarized"`.

To restore visible thinking output on 4.8:
```python
thinking = {"type": "adaptive", "display": "summarized"}
```

**Billing note:** You are billed for the full internal thinking tokens regardless of `display` setting. Use `usage.output_tokens_details.thinking_tokens` to observe spend.

### 3.4 Caching with adaptive thinking

Consecutive requests using `adaptive` mode preserve prompt cache breakpoints. Switching between `adaptive` and `enabled`/`disabled` modes breaks cache breakpoints for messages (system prompts and tool definitions stay cached regardless).

### 3.5 Promptable thinking behavior

Adaptive thinking's triggering is steerable via system prompt. If Claude thinks more than needed:
```
Extended thinking adds latency and should only be used when it will meaningfully 
improve answer quality — typically for problems that require multi-step reasoning. 
When in doubt, respond directly.
```
Warning from Anthropic: test the impact before deploying prompt-based tuning to production. Consider lower effort levels first.

Reference: [platform.claude.com/docs/en/build-with-claude/adaptive-thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)

---

## 4. Effort Parameter

### 4.1 Valid levels and availability

| Level | Available on | Thinking behavior (with adaptive enabled) | Typical use |
|---|---|---|---|
| `low` | Opus 4.8, 4.7, 4.6, Sonnet 4.6, Opus 4.5 | Minimizes thinking; skips for simple tasks | Simple classification, high-volume, speed-sensitive |
| `medium` | Same | Moderate thinking; may skip for simple queries | Balanced agentic, tool-heavy workflows |
| `high` | Same | Claude always thinks (default on Opus 4.8) | Complex reasoning, coding, agentic tasks |
| `xhigh` | **Opus 4.8 and Opus 4.7 only** | Claude always thinks deeply with extended exploration | Long-running agentic/coding tasks (>30 min), millions of tokens |
| `max` | Opus 4.8, Mythos Preview, Opus 4.7, Opus 4.6, Sonnet 4.6 | No constraints on thinking depth | Frontier reasoning, deepest analysis |

### 4.2 Opus 4.8 defaults and API shape

- **Default on all surfaces including Claude Code: `high`.**  
  Setting `effort: "high"` is identical to omitting the parameter.
- Pass via `output_config.effort` in the request body:

```python
output_config = {"effort": "xhigh"}
```

- Effort affects **all tokens**: text responses, tool call arguments, and extended thinking.

### 4.3 Guidance for Opus 4.8 agentic/coding work (from Anthropic docs)

- Start with **`xhigh`** for coding and agentic use cases.
- Use **`high`** as the minimum for most intelligence-sensitive workloads.
- Step down to `medium` only after measuring quality on evals.
- At `xhigh` or `max`, set a large `max_tokens` (Anthropic suggests starting at 64k and tuning from there).
- The effort parameter respects turns more strictly than 4.6. At lower levels, the model scopes to what was asked. If shallow reasoning appears at low effort on complex tasks, raise effort rather than prompting around it.

### 4.4 "ultracode" in Claude Code

`ultracode` appears in Claude Code's effort UI but is **not an API effort level**. It pairs `xhigh` effort with standing permission for Claude Code to launch multi-agent workflows, granted through mid-conversation system messages. The API only accepts the five levels above.

Reference: [platform.claude.com/docs/en/build-with-claude/effort](https://platform.claude.com/docs/en/build-with-claude/effort)

---

## 5. Fast Mode (Research Preview)

### 5.1 What it is

Same model weights, faster inference configuration. Up to 2.5x higher output tokens per second (OTPS). Does not improve time-to-first-token (TTFT).

### 5.2 Enabling it

Requires beta header `anthropic-beta: fast-mode-2026-02-01` and `speed: "fast"` in request body. Uses the beta client endpoint.

```python
response = client.beta.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    speed="fast",
    betas=["fast-mode-2026-02-01"],
    messages=[...]
)
```

Response `usage.speed` field returns `"fast"` or `"standard"` to confirm which mode was used.

### 5.3 Pricing (Opus 4.8 vs 4.7/4.6)

| Model | Fast mode input | Fast mode output |
|---|---|---|
| Claude Opus 4.6 / 4.7 | $30 / MTok | $150 / MTok |
| **Claude Opus 4.8** | **$10 / MTok** | **$50 / MTok** |

Opus 4.8 fast mode is 3x cheaper than 4.7/4.6 fast mode.

### 5.4 Caching interaction

Fast and standard speed requests **do not share prompt cache entries**. Switching speed invalidates the cache. Fast mode is not available on Vertex AI, Bedrock, Foundry, Batch API, Priority Tier, or Claude Platform on AWS.

### 5.5 Rate limits

Fast mode has a **separate dedicated rate limit** from standard Opus. Rate limit status comes back in response headers (`anthropic-fast-input-tokens-limit`, etc.). On rate limit: SDK auto-retries up to 2x. Fallback pattern: catch `RateLimitError`, retry without `speed: "fast"` at standard pricing.

Reference: [platform.claude.com/docs/en/build-with-claude/fast-mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)

---

## 6. Capability Improvements vs Opus 4.7

From the official what's-new page and Anthropic's announcement:

| Benchmark | Opus 4.7 | Opus 4.8 |
|---|---|---|
| Agentic coding score | 64.3% | 69.2% |
| Multidisciplinary reasoning with tools | 54.7% | 57.9% |
| Agentic computer use | 82.8% | 83.4% |
| Knowledge work score | 1753 | 1890 |

Source: search result from 9to5Mac citing Anthropic. These are not directly verifiable from the official docs page (which does not publish a benchmark table) — treat as press-release figures pending official model card.

### 6.1 Behavioral improvements (from official docs)

Three targeted improvement areas vs Opus 4.7:
1. **Long-horizon agentic coding** — better long-context handling, fewer compactions, better compaction recovery.
2. **Reasoning effort calibration** — more reliable behavior at each effort level across domains.
3. **Tool triggering** — fewer cases of skipping a required tool call (an issue some Opus 4.7 users reported).

### 6.2 Honesty / anti-hallucination signal (from Anthropic announcement)

Anthropic states Opus 4.8 is "around four times less likely than its predecessor to allow flaws in code it has written to pass unremarked." Early testers report higher rates of flagging uncertainties and fewer unsupported claims. Anthropic's internal assessment shows lower rates of misaligned behavior and improved prosocial traits.

These are Anthropic marketing claims. No independent replication is cited. But the mechanism — adaptive thinking choosing to think per-turn rather than always or never — structurally supports more calibrated responses on bimodal workloads.

---

## 7. API Constraints Inherited from Opus 4.7 (Breaking if You're Coming from 4.6)

- `temperature`, `top_p`, `top_k` at non-default values return a **400 error**. Use prompting to guide behavior instead.
- `thinking: {type: "enabled", budget_tokens: N}` returns a **400 error**. Use adaptive mode.
- These apply to the Messages API only; Claude Managed Agents are unaffected.

---

## 8. Implications for Anti-Hallucination Hook Workflows

### Verification hooks

- **`xhigh` effort + adaptive thinking** is the right default for verification-intensive agentic tasks. At this level Claude almost always thinks, and its calibration on whether to invoke tools is more reliable than 4.7.
- **Tool triggering improvement** in 4.8 means fewer false negatives where Claude silently skips a required check — directly relevant to hooks that expect Claude to call a verification tool.

### Injecting evidence mid-session

- Mid-conversation system messages let hooks inject verified facts with system-level authority. A `PostToolUse` hook can append `{role: "system", content: "Verified: file X exists at path Y, checksum Z"}` without breaking the cache on the preceding conversation. This is the cleanest mechanism for grounding subsequent turns against tool output.

### Effort ladder for subagents

- The docs explicitly recommend `low` effort for "subagents" (the exact word used). In a multi-agent anti-hallucination system where L3 subagents do targeted, scoped verification tasks, `low` effort reduces cost; reserve `xhigh` for the orchestrator and complex reasoning calls.

### Caching strategy

- Lower 1,024-token cache minimum on 4.8 means even short verification system prompts can be cached. Design prompts to keep the stable verification-rules prefix under a cache breakpoint, then append per-turn context after it.
- Switching between `adaptive` and `disabled` thinking modes between turns breaks message-level cache. Keep thinking mode consistent across turns in a session.

### Refusal routing

- Use `stop_details.category` to distinguish `"cyber"` and `"bio"` refusals from generic safety refusals. Hooks can log them to separate audit buckets or surface different user-facing explanations, without parsing the unstable `explanation` string.

### Fast mode for latency-sensitive verification loops

- At $10/$50 per MTok, Opus 4.8 fast mode is cost-viable for verification loops where standard speed creates unacceptable latency. Be aware: fast/standard speed requests do not share prompt cache. If you rely on prompt caching across turns, pick one speed and stay on it.

---

## 9. What Is Not New / Not Changed

- **Dynamic Workflows** (parallel subagent orchestration for codebase migrations) is a **Claude Code** feature, not an API endpoint or model capability. It is not an API parameter you can set.
- **Extended thinking `budget_tokens`** — deprecated on 4.6/Sonnet 4.6, rejected on 4.7/4.8. If your code sets `budget_tokens`, it will 400 on 4.8.
- **Sampling params** (`temperature`, `top_p`, `top_k`) — still rejected on 4.8 (same as 4.7).
- **300k Batch API output** — available on 4.8 via `output-300k-2026-03-24` beta header, same as 4.7 and 4.6.

---

## Sources

- [Official: What's new in Claude Opus 4.8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
- [Official: Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Official: Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Official: Effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Official: Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [Official: Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- [Official: Handling stop reasons (refusal stop_details)](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- [Official: Claude Opus 4.8 product page](https://www.anthropic.com/claude/opus)
- [Anthropic announcement (unofficial summary via WebFetch)](https://www.anthropic.com/news/claude-opus-4-8)
- [9to5Mac: Anthropic upgrades Claude with new Opus 4.8 model](https://9to5mac.com/2026/05/28/anthropic-upgrades-claude-with-new-opus-4-8-model-heres-whats-new/) — benchmark figures sourced here
- [VentureBeat: Anthropic's Claude Opus 4.8 — 3X cheaper fast mode](https://venturebeat.com/technology/anthropics-claude-opus-4-8-is-here-with-3x-cheaper-fast-mode-and-near-mythos-level-alignment)
- [9to5Google: Claude Opus 4.8 launches with agentic improvements](https://9to5google.com/2026/05/28/claude-opus-4-8-launches-today-with-agentic-improvements-new-features/)
- [MarkTechPost: Claude Opus 4.6 release (adaptive thinking context)](https://www.marktechpost.com/2026/02/05/anthropic-releases-claude-opus-4-6-with-1m-context-agentic-coding-adaptive-reasoning-controls-and-expanded-safety-tooling-capabilities/)

# Latest Opus Swarm / Multi-Agent Orchestration: Research Report

**Date:** 2026-05-29 (research captured at Opus 4.8 release)  
**Purpose:** Inform an extension to the `feature-launch` skill — simpler latest-Opus-native phase model + analyze-work mode  
**Status of primary subject:** Opus 4.8 was the latest at time of writing (released 2026-05-28, 41 days after 4.7); always use the newest available. Dynamic Workflows = research preview. Managed Agents API = beta.

---

## 1. What Is Actually New in the Latest Opus for Multi-Agent Work

### 1.1 Model improvements (verified from official release notes)

Source: [platform.claude.com — What's New in the latest Claude Opus](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8) **[OFFICIAL]**

- **Long-horizon agentic coding**: better long-context handling, fewer compactions mid-session, better recovery after compaction. Direct improvement for multi-phase work.
- **Reasoning effort calibration**: more reliable behavior at each effort level across domains. Previously, effort levels were inconsistently honored.
- **Better tool triggering**: fewer cases of Claude skipping a tool call the task required — a real bug in 4.7.
- **Adaptive thinking**: triggers reasoning only when the turn needs it. On short agentic steps it responds directly; on complex multi-step problems it reasons before answering. Reduces wasted tokens on bimodal workloads.
- **Mid-conversation system messages**: `role: "system"` messages can now be appended mid-conversation (after user turns) without invalidating the prompt cache prefix. Latest Opus only (Claude API / Claude Platform on AWS); no beta header needed. This enables mode switches and standing permission grants during long-running agentic sessions without cache-miss cost.
- **Lower prompt cache minimum**: 1,024 tokens (down from 4.7's minimum). More turns qualify for caching.
- **Fast mode** (research preview on API): `speed: "fast"` — up to 2.5x higher output token speed, premium pricing. Useful for parallelizing many short subagent calls.
- **No extended thinking budgets**: `budget_tokens` returns a 400 error. Use `thinking: {type: "adaptive"}` plus the `effort` parameter.
- **Sampling params not supported**: `temperature`, `top_p`, `top_k` → 400 error on recent Opus generations.

### 1.2 Effort parameter (verified official)

Source: [platform.claude.com — Effort](https://platform.claude.com/docs/en/build-with-claude/effort) **[OFFICIAL]**

Five API levels (bottom to top): `low`, `medium`, `high` (default), `xhigh`, `max`.

| Level | Key guidance for the latest Opus / agentic work |
|---|---|
| `low` | Fast, cheap. Recommended for subagents doing simple tasks. |
| `medium` | Balanced. Good for subagents doing moderate work, cost-sensitive pipelines. |
| `high` | Default. Complex reasoning, general agentic tasks. |
| `xhigh` | Start here for coding and long-running agentic use cases (>30 min). Token usage is meaningfully higher than `high`. Set large `max_tokens` (start at 64k). |
| `max` | No token constraints. Reserve for truly frontier problems; often adds cost with marginal quality gain on most tasks. |

**Important clarification**: `ultracode` is NOT an API effort level. It is a Claude Code UI setting that pairs `xhigh` effort with automatic workflow orchestration (via mid-conversation system messages that grant standing permission). To replicate ultracode behavior via the API, use `effort: xhigh` plus mid-conversation system messages granting workflow launch permission. See: [Build an orchestration mode](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-effort-example).

Setting effort affects all tokens: text, tool calls, and thinking. Lower effort = fewer/combined tool calls, direct action without preamble. Higher effort = more tool calls, detailed plans, comprehensive summaries.

### 1.3 Mid-conversation system messages (latest Opus only, verified official)

Source: [platform.claude.com — Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) **[OFFICIAL]**

- Append `{"role": "system"}` in the `messages` array after a user turn.
- Instruction applies from that point onward with system-level authority.
- Does NOT invalidate the prompt cache prefix — the stable prefix remains byte-identical.
- Key use case for multi-agent work: **mode switches that grant standing permissions** (e.g., "you may now launch multi-agent workflows"). This is exactly how ultracode works internally.
- Limitations: cannot be first message; must follow a user turn; consecutive system messages not allowed (merge or wait for next user turn); not available on Bedrock/Vertex/Foundry.

---

## 2. Native Multi-Agent Primitives (Three Tiers)

### 2.1 Dynamic Workflows (research preview, Claude Code)

Source: [code.claude.com — Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) **[OFFICIAL]**  
Source: [claude.com — Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) **[OFFICIAL]**

**What it is**: Claude writes a JavaScript orchestration script; a background runtime executes it. Intermediate results live in script variables, not in Claude's context window. Only the final answer returns to the session.

**Hard limits (verified)**:
- 16 concurrent agents maximum (fewer on low-CPU machines)
- 1,000 total agents per run (prevents runaway loops)
- No direct filesystem/shell access from the script itself — agents do the file ops
- No mid-run user input (only tool permission prompts can pause)
- Requires Claude Code v2.1.154+; paid plans only

**Resumability**: progress saved as run goes; interrupted runs resume within same session. Exit Claude Code = workflow restarts fresh next session.

**Activation**:
- Include the word "workflow" in a prompt
- `/effort ultracode` (session-wide; Claude auto-decides)
- `/deep-research <question>` (bundled workflow for research)
- Save any run as a reusable `/command`

**Verified quality pattern**: The script can have independent agents adversarially review each other's findings before they're reported, and draft a plan from several angles before committing. This is different from simply spawning more agents — it's a codified verification loop.

**Cost warning (verified from MarkTechPost report + official docs)**: A 500-agent audit can shift the session bill by an order of magnitude vs a standard Claude Code session. One hands-on tester (aiwithmo.com) reported Claude attempting 47 concurrent agents, then launching 25, and making "several dumb mistakes in a 5 hour session." Research preview status means bugs are expected.

### 2.2 Agent Teams (experimental, Claude Code)

Source: [code.claude.com — Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) **[OFFICIAL]**

**What it is**: Multiple Claude Code instances where one is the lead; teammates have independent context windows and communicate directly with each other via a shared task list and mailbox.

**How to enable**: Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json or environment. Requires Claude Code v2.1.32+. Experimental; known limitations around session resumption and shutdown.

**Key differentiator from subagents**: Teammates message each other directly. Subagents only report back to the parent.

**Practical limits**:
- No hard agent count documented, but "start with 3-5 teammates" is the official recommendation
- Coordination overhead increases nonlinearly with team size
- 5-6 tasks per teammate is the recommended ratio
- No nested teams: teammates cannot spawn their own teams. Only the lead manages the team.
- One team at a time; lead is fixed for its lifetime.
- Token cost scales linearly — each teammate is a separate Claude instance.

**Quality hooks (verified)**:
- `TeammateIdle`: runs when teammate goes idle; exit code 2 = send feedback, keep working
- `TaskCreated` / `TaskCompleted`: gate quality before tasks are created or marked done

**Best for**: research with competing hypotheses, adversarial review (security + performance + tests in parallel), debugging with multiple theories.

**Not for**: sequential tasks, same-file edits, work with many dependencies — use subagents or single session instead.

### 2.3 Managed Agents API + Multiagent Sessions (beta)

Source: [platform.claude.com — Multiagent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent) **[OFFICIAL]**  
Source: [platform.claude.com — Managed Agents: Decoupling brain from execution](https://www.anthropic.com/engineering/managed-agents) **[OFFICIAL ENGINEERING BLOG]**

**What it is**: Server-side multi-agent API. Coordinator agent has a roster of worker agents; each runs in its own session thread (context-isolated). All share the same sandbox/filesystem but have separate conversation histories.

**Hard limits (verified)**:
- Maximum **25 concurrent threads**
- Maximum **20 unique agents** in a coordinator's roster
- Coordinator can only delegate one level deep (depth > 1 is ignored)
- Coordinator CAN call multiple copies of the same agent (counts against 25 threads)
- Archive threads to free up slots: `threads.archive(thread_id, session_id=session_id)`

**Key architecture points**:
- Requires `managed-agents-2026-04-01` beta header
- Each agent defined with its own model, system prompt, tools, MCP servers, skills
- Coordinator gets `type: "agent_toolset_20260401"` tool to delegate
- Vault credentials are session-scoped (all threads share); MCP servers are agent-scoped
- Threads are persistent: coordinator can follow up to an agent it called earlier
- Primary thread provides condensed view; drill into session threads for per-agent detail

**Subagent resumption**: capture `session_id` + `agentId` from first run; pass `resume: sessionId` to continue. Subagent retains full conversation history.

---

## 3. Subagents via Agent SDK (stable, not research preview)

Source: [code.claude.com — Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents) **[OFFICIAL]**

The most stable primitive. Define via `agents` parameter in `query()` options (Python: `claude_agent_sdk.AgentDefinition`, TypeScript: `AgentDefinition` object).

**Key fields per subagent definition**:
- `description`: when Claude should use this agent (determines auto-invocation)
- `prompt`: system prompt for the agent
- `tools`: allowlist (omit = inherit all)
- `model`: override (`"sonnet"`, `"opus"`, `"haiku"`, or full model ID)
- `effort`: per-agent effort level (separate from orchestrator's effort)
- `background`: `true` = non-blocking background task
- `maxTurns`: cap on agentic turns
- `skills`, `mcpServers`, `memory`: context configuration

**Critical design rules**:
- Subagents cannot spawn their own subagents. Do not include `Agent` in a subagent's `tools`.
- The only channel from parent to subagent is the Agent tool's prompt string. Include all needed file paths, decisions, and errors directly in that prompt.
- Subagent context starts fresh — no parent conversation history.

**Phase fan-out pattern (verified from SDK docs + Shipyard blog)**:
```
Phase 1 (parallel): agent-A + agent-B run simultaneously
Phase 2 (sequential gate): synthesize Phase 1 results, then spawn phase-2 agents
Phase 3: verification agents
```
Claude determines task dependencies and serializes dependent tasks, parallelizes independent ones.

---

## 4. Orchestrator-Worker Patterns (Official Guidance)

Source: [anthropic.com — Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents) **[OFFICIAL]**  
Source: [anthropic.com — Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) **[OFFICIAL ENGINEERING BLOG]**

### 4.1 Anthropic's documented orchestration patterns

**Orchestrator-Workers**: central LLM dynamically breaks down tasks, delegates to workers, synthesizes results. Distinguished from parallelization by dynamic task decomposition — subtasks are determined by the orchestrator based on specific input, not pre-defined.

**Parallelization variants**:
- *Sectioning*: independent subtasks executed simultaneously for speed
- *Voting*: same task run N times, diverse outputs for higher confidence / reduced hallucination

### 4.2 Research system architecture (official, verified)

Anthropic's own Research feature uses an orchestrator-worker pattern:
- Lead agent: uses extended thinking to plan, spawn N subagents simultaneously, synthesize
- Subagents: each has distinct tools, prompts, exploration trajectories (reduces path dependency)
- Effort scales dynamically: simple fact = 1 agent (3-10 calls); comparison = 2-4 agents (10-15 calls each); complex research = 10+ agents
- Lead saves research plans before hitting 200k-token context limit
- Fresh subagent contexts = clean windows, minimal interference
- Dedicated CitationAgent for verification

### 4.3 Managed Agents decoupling architecture (official)

Three-component model:
- **Brain** (Claude + harness): inference and decisions
- **Hands** (sandboxes, tools): execution
- **Session** (event log): durable state store

The event log (`getEvents()`) stores durable external state — not just Claude's context window. This enables context transformations and checkpoint handoffs between phases. Time-to-first-token improved 60% at p50, >90% at p95 from decoupling harness from execution container.

---

## 5. Concurrency, Limits, and Phase Gating (What's Verified)

| Surface | Concurrency limit | Total limit | Source |
|---|---|---|---|
| Dynamic Workflows | 16 concurrent agents | 1,000 agents/run | Official workflows docs |
| Managed Agents API | 25 concurrent threads | 20 unique agents in roster | Official multiagent docs |
| Agent Teams | No stated limit; 3-5 recommended | One team at a time | Official agent-teams docs |
| Agent SDK subagents | Not stated explicitly; "25 concurrent threads" referenced | Subagents cannot spawn subagents | SDK docs + managed-agents docs |

**Phase gating mechanisms**:
- Dynamic Workflows: no mid-run user input — structure gates into phases by splitting each stage as its own workflow
- Agent Teams: `TaskCompleted` hook with exit code 2 blocks task completion until gate passes
- Managed Agents API: interrupt a thread (`user.interrupt`) then archive it to free slots; thread events (`session.thread_status_idle`) signal completion
- Agent SDK: coordinator synthesizes results after subagent turns before dispatching next phase

---

## 6. Practical Pitfalls (Evidence-Based)

1. **Research preview status for Dynamic Workflows**: Not production-ready. Anthropic explicitly says "kick the tires before betting production on it." One practitioner tester reported Claude attempted 47 concurrent agents, launched 25, and made "several dumb mistakes in a 5 hour session" that required human review to catch. Source: [aiwithmo.com review](https://www.aiwithmo.com/prompts/claude-opus-4-8-release).

2. **Cost scales brutally**: A 500-agent audit "can shift the session bill by an order of magnitude" vs a standard session. Dynamic Workflows, Agent Teams, and Managed Agents all consume tokens for every agent's context. Token costs scale linearly with active teammates. Source: Official workflows docs.

3. **Vague prompts compound through autonomous execution**: "There are fewer chances to redirect agents when they misinterpret a task" — errors propagate without check-ins. Source: [Shipyard blog](https://shipyard.build/blog/claude-code-multi-agent/).

4. **No nested agents**: In Agent Teams, teammates cannot spawn subteams. In Managed Agents, depth > 1 is ignored. In the SDK, subagents cannot spawn subagents. Planning must fit within one level of delegation.

5. **Context limit of coordinator**: 1M token context, but in long-running sessions the coordinator still compacts. The latest Opus's better compaction recovery is a direct fix for this, but it is not guaranteed to be lossless.

6. **File conflicts**: Two agents editing the same file leads to overwrites. Work must be decomposed so each agent owns disjoint files.

7. **Agent Teams limitations**: No session resumption with in-process teammates; task status can lag; shutdown is slow (agents finish current turn before stopping). Source: Official agent-teams docs.

8. **Mythos withheld**: Anthropic is withholding its most advanced Mythos model for autonomous subagent coordination due to cybersecurity concerns. Source: [Unite.AI article](https://www.unite.ai/what-opus-4-8-changes-for-anyone-running-agents-on-claude/).

9. **Thread/slot exhaustion**: 25-thread limit on Managed Agents can be reached in large workflows; must archive completed threads to reclaim slots.

10. **Ultracode applies to whole session**: Once `/effort ultracode` is set, every substantive task gets a workflow — including trivial ones. Token burn is unbounded unless you drop back with `/effort high`.

---

## 7. Feature-Launch Skill Extension Recommendations

### 7.1 Current feature-launch pain points this research addresses

The current `feature-launch` skill uses a heavy GSD spec/plan/execute/verify loop per phase with mandatory cross-model debate at every phase boundary. This is correct for large multi-repo features but heavy for:
- Analysis-only phases (no code output)
- Parallel investigation before planning begins
- Verification passes that are independent subsets

### 7.2 A simpler latest-Opus-native phase model

**Phase = parallel fan-out + gate.** Each phase has three elements:
1. **Fan-out**: spawn N subagents (or workflow agents) with distinct scopes, all starting simultaneously
2. **Synthesis**: coordinator collects results (final messages only, not intermediate tool calls), synthesizes into a canonical artifact (e.g., `.planning/PHASE-N-synthesis.md`)
3. **Gate**: a verification check against the synthesis; either automated (hook, test) or human approval; blocks Phase N+1 until passed

This maps directly to the latest Opus's primitives:
- Fan-out = Agent SDK `background: true` subagents OR Dynamic Workflow phases
- Synthesis = orchestrator turn after all subagents complete
- Gate = `TaskCompleted` hook (Agent Teams), mid-conversation system message mode switch (API), or explicit human confirm prompt

**Effort routing**:
- Orchestrator/coordinator: `xhigh` effort (long-horizon planning, synthesis)
- Analysis subagents: `medium` or `high` effort (focused scope, shorter output)
- Verification subagents: `low` or `medium` effort (reading/checking, not deep reasoning)

### 7.3 Analyze-work mode

A dedicated pre-planning mode: parallel analyzers, no code output, converge on a diagnosis.

```
analyze-work mode:
  → spawn 3-5 read-only subagents (tools: Read, Grep, Glob only)
  → each given a distinct analysis lens (architecture, data flow, risk, test coverage, dependency graph)
  → each effort: medium
  → coordinator collects summaries, writes .planning/ANALYSIS-<feature>.md
  → gate: coordinator checks for P0 blockers before advancing to PLAN phase
```

This replaces the current "graph-scout → gsd-pattern-mapper" pattern with native subagent fan-out, and is cheaper than running a full GSD spec cycle before knowing the shape of the work.

### 7.4 When to use Dynamic Workflows vs Agent SDK subagents vs Agent Teams

| Scenario | Recommended primitive | Why |
|---|---|---|
| Pre-planning analysis of large codebase | Agent SDK subagents (background, read-only) | Stable, no research-preview risk, context isolation |
| Parallel execution of independent feature slices | Agent Teams (experimental) | Direct peer communication, shared task list |
| Codebase-scale migration or audit | Dynamic Workflows | Scale (up to 1000 agents), resumable, repeatable script |
| Cross-model debate gate (Reviewer + Critic) | Two explicit Agent SDK subagents | Control over model choice, not tied to team topology |
| Verification after execution | Single Agent SDK subagent with test tools | Simple, focused, cheap |

**Do not use Dynamic Workflows for production feature-launch phases yet** (research preview). Use them for research/analysis work where a stale result is recoverable, and for codebase audits where you review before acting.

---

## Sources

### Official (Anthropic)

1. **[OFFICIAL]** [What's New in the latest Claude Opus — platform.claude.com](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
2. **[OFFICIAL]** [Effort parameter — platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/effort)
3. **[OFFICIAL]** [Mid-conversation system messages — platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
4. **[OFFICIAL]** [Orchestrate teams of Claude Code sessions (Agent Teams) — code.claude.com](https://code.claude.com/docs/en/agent-teams)
5. **[OFFICIAL]** [Subagents in the SDK — code.claude.com](https://code.claude.com/docs/en/agent-sdk/subagents)
6. **[OFFICIAL]** [Dynamic Workflows — code.claude.com](https://code.claude.com/docs/en/workflows)
7. **[OFFICIAL]** [Multiagent sessions (Managed Agents API) — platform.claude.com](https://platform.claude.com/docs/en/managed-agents/multi-agent)
8. **[OFFICIAL]** [Building Effective AI Agents — anthropic.com research](https://www.anthropic.com/research/building-effective-agents)
9. **[OFFICIAL ENGINEERING BLOG]** [Scaling Managed Agents: Decoupling the brain from execution — anthropic.com](https://www.anthropic.com/engineering/managed-agents)
10. **[OFFICIAL ENGINEERING BLOG]** [Multi-Agent Research System — anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system)
11. **[OFFICIAL]** [Introducing Dynamic Workflows in Claude Code — claude.com blog](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)

### Community / Practitioner

12. **[COMMUNITY]** [Anthropic Ships latest Opus + Dynamic Workflows (1,000 subagent cap details) — MarkTechPost](https://www.marktechpost.com/2026/05/28/anthropic-ships-claude-opus-4-8-alongside-dynamic-workflows-and-cheaper-fast-mode-with-workflows-capped-at-1000-subagents/)
13. **[COMMUNITY]** [What the latest Opus Changes for Anyone Running Agents on Claude — Unite.AI](https://www.unite.ai/what-opus-4-8-changes-for-anyone-running-agents-on-claude/)
14. **[COMMUNITY]** [Claude Code Multi-Agent Orchestration — Shipyard blog](https://shipyard.build/blog/claude-code-multi-agent/)
15. **[COMMUNITY — PRACTITIONER TEST]** [Latest Claude Opus hands-on, ultracode, 47-agent attempt — aiwithmo.com](https://www.aiwithmo.com/prompts/claude-opus-4-8-release)
16. **[COMMUNITY]** [Anthropic releases latest Opus with dynamic workflows — TechCrunch](https://techcrunch.com/2026/05/28/anthropic-releases-opus-4-8-with-new-dynamic-workflow-tool/)


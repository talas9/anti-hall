# KB — Claude Code multi-agent orchestration & the Workflow tool

> Reference knowledge base for **when and how** to use programmatic multi-agent
> orchestration (Claude Code Dynamic Workflows / the `Workflow` tool) versus a single
> agent or shallow subagent fan-out. Built from 14 sources (8 official Anthropic),
> reconciled against in-repo live verification. Project/user-agnostic.

## TL;DR

- The `Workflow` tool is a **native Claude Code feature** (GA ~May 28 2026, shipped with
  Opus 4.8). It is **not** tied to any one model — workflow agents inherit the session
  model by default. Verified live in-repo: a 2-agent workflow run under an Opus 4.8
  session executed with both workers self-reporting `claude-opus-4-8`.
- Use it for **wide, parallelizable, repeatable** work where intermediate results would
  flood the main context. Do **not** use it for routine, sequential, or low-value tasks.
- **Cost is real:** a full multi-agent run ≈ **15× the tokens** of a single chat; nesting
  5 levels deep ≈ **7× tokens**. The win comes from **width (parallel fan-out)**, not
  **depth (nesting)**. Keep chains shallow + wide.
- Do **not** hardwire a "always use Workflow" rule. Trigger it deliberately, by the
  decision criteria below.

## What it is (vs ad-hoc subagent spawns)

Ad-hoc spawning = the model decides turn-by-turn whether to delegate; control flow lives
in-context; every intermediate result accumulates in the main window (expensive,
unrepeatable). **Programmatic orchestration** moves control flow into a JavaScript script
the runtime executes *outside* the conversation. The script holds the loop, branching, and
intermediate state as variables; the main context receives only the final answer.

Three primitives:

| Primitive | Semantics |
|---|---|
| `agent(prompt, opts)` | spawn one subagent; optional structured-output `schema`; `opts.model`/`opts.effort` override, omit to inherit session model |
| `pipeline(items, ...stages)` | stream each item through stages **with no barrier** — item enters stage N+1 as soon as it clears stage N (the default for throughput) |
| `parallel(thunks)` | run N tasks concurrently and **wait for all** (barrier) — use only when the next stage needs the whole set |

Properties: deterministic, repeatable (saveable as a named workflow), inspectable/editable
(the script is plain JS), resumable within the session, runs in the background with a
completion notification. Hard caps: **16 concurrent agents**, **1,000 total per run**.

## When to use it (decision criteria)

**Reach for a workflow when ALL of these trend true:**
- The task is **breadth-first and genuinely parallelizable** with little shared state.
- It needs **more agents than one turn can coordinate** (audits, large migrations,
  multi-source cross-checked research).
- You want **adversarial verification** (independent agents checking each other before
  reporting) or a **judge panel**.
- The orchestration should be **repeatable** (rerun the same script next sprint).
- Intermediate results would **flood the main context** (e.g. one search dump per file
  across 200 files).

**Stay single-agent / shallow when ANY of these hold:**
- Task is **sequential with many inter-agent dependencies** (workers mostly wait).
- Multiple agents would **edit the same files** (conflict risk; use `isolation: "worktree"`
  if you must).
- Task value **doesn't justify ~15× tokens** (low-stakes fact-finding).
- **Real-time human input** is needed mid-run (the workflow runtime has no pause-for-input).
- It's **routine coding** — "limited parallelizable tasks" per Anthropic's own assessment.

Anthropic's embedded heuristic: **1 agent** for simple fact-finding, **2–4** for direct
comparisons, **10+** for complex multi-angle research.

## Core patterns

| Pattern | One-liner | Source |
|---|---|---|
| Orchestrator–worker | Lead (Opus) decomposes + delegates to parallel specialists (Sonnet), then synthesizes | Anthropic eng. |
| Pipeline (no barrier) | `pipeline()` streams items through stages independently; **the default** | alexop.dev / official docs |
| Parallel (barrier) | `parallel()` fans out N, waits for all; only when synthesis needs the full set (dedup, voting) | aiagentsfirst / docs |
| Map-reduce | fan out over files/sources, reduce with **pure JS** (not an agent), synthesize with a final agent | alexop.dev |
| Loop-until-done | iterate spawning until a stop condition (no new findings / budget / quality threshold) | claudefa.st "loop-until-dry" |
| Adversarial verify | independent agents try to **disprove** each other; surviving claim is reported | Anthropic agent-teams / alexop.dev |

## Cost / quality tradeoffs (real numbers)

- **15×** tokens vs standard chat for a full multi-agent run; a single agent ≈ **4×** chat.
- **Token budget explains ~80%** of performance variance on BrowseComp — more tokens →
  better results, with diminishing returns.
- Opus lead + Sonnet workers **beat single-agent Opus by 90.2%** on Anthropic's internal
  research eval.
- Parallel tool-calling cut **latency by up to 90%** (wall-clock, not token cost).
- **Nesting 5 levels deep ≈ 7× tokens** — model-tier by depth (Opus at the synthesis top,
  Sonnet mid, Haiku at leaves) to control cost.

**Economics rule:** orchestrate only when task value clears the token overhead. The 90.2%
gain is from **width**; no source shows deep *nesting* improving quality.

## Best practices for triggering & using it well

1. **Trigger deliberately**, not ad-hoc — include `ultracode` in the prompt, run a saved
   workflow, or explicitly ask. Don't let routine work auto-escalate to a swarm.
2. **Default to `pipeline()`** over `parallel()`; reserve the barrier for true
   all-results-needed synthesis (dedup, early-exit voting).
3. **Write tight subagent contracts**: objective + output format + tool/source guidance +
   explicit task boundaries. Vague delegation causes duplication and drift (a confirmed
   Anthropic production failure mode).
4. **Tier by model**: orchestrator/synthesis → Opus; workers → Sonnet; leaf/filter → Haiku.
5. **Scope before committing**: dry-run on one directory; `/workflows` shows per-agent
   token spend live.
6. **Isolate writers**: `isolation: "worktree"` prevents cross-agent file conflicts.
7. **Use hooks as quality gates** (`PostToolUse`/`TaskCompleted` exit-2 to block + feed back).
8. **Start with research/review** before parallel implementation (lower conflict risk).
9. **Save successful runs** as named workflow commands so orchestration is an asset.
10. **Keep it shallow + wide.** The depth-5 spawn cap is a guardrail, not a target —
    sub-agents should do their own work, not re-delegate.

## How to make an agent actually utilize Workflow more

The tool is gated behind an **explicit opt-in** (it can spawn dozens of agents). It does
NOT fire on inference alone. To raise appropriate usage without a blanket "always" rule:

- **Lower the trigger friction for the right shape only.** Add an instruction that says:
  *"When a task is breadth-first, parallelizable, and would otherwise need 3+ subagents or
  flood context, propose a Workflow (and run it on opt-in) instead of ad-hoc spawns."*
  Pair it with the decision criteria above so it fires on shape, not on whim.
- **Make the opt-in cheap.** A one-word trigger (`ultracode`) or a saved `/workflow`
  command beats reconstructing a script each time.
- **Pre-accept the consent prompt** (`skipWorkflowUsageWarning: true` in settings) so the
  tool can fire without a modal once the user has opted into the pattern.
- **Prefer Workflow over deep nesting** explicitly: when the agent catches itself about to
  spawn a subagent that will spawn another, that's the signal to lift the whole thing into
  one flat Workflow with `parallel`/`pipeline` instead.
- **Always set worker `model`/`effort` explicitly** in the script — an omitted model
  inherits the orchestrator (a flagship), silently producing an all-flagship swarm.
- **Never hardcode an unavailable model token** in a workflow script without a code-level
  fallback. If a seat's preferred model can be disabled at the account level, wire the
  fallback into the script (probe the `null` return) — don't rely on prose policy.

## Sources

**Official Anthropic**
1. Building agents with the Claude Agent SDK — https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
2. How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
3. Orchestrate subagents at scale with dynamic workflows — https://code.claude.com/docs/en/workflows
4. Run Claude Code programmatically (headless) — https://code.claude.com/docs/en/headless
5. Create custom subagents — https://code.claude.com/docs/en/sub-agents
6. Orchestrate teams of Claude Code sessions — https://code.claude.com/docs/en/agent-teams
7. Effective harnesses for long-running agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
8. Enabling Claude Code to work more autonomously — https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously

**Community**
9. Claude Code Workflows: Deterministic Multi-Agent Orchestration — https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/
10. Claude Code Agent Patterns: Orchestration Strategies — https://claudefa.st/blog/guide/agents/agent-patterns
11. Build a Multi-Agent Fan-Out System With Dynamic Workflows — https://aiagentsfirst.com/claude-code-dynamic-workflows-multi-agent-fan-out
12. Multi-Agent Orchestration: 5 Patterns That Work in 2026 — https://www.digitalapplied.com/blog/multi-agent-orchestration-5-patterns-that-work
13. Anthropic's Multi-Agent Blueprint: What Production Adds — https://fountaincity.tech/resources/blog/anthropic-multi-agent-blueprint-production/
14. Simon Willison — Anthropic multi-agent research system — https://simonwillison.net/2025/Jun/14/multi-agent-research-system/

_Last reconciled against in-repo live verification: a 2-agent Workflow run under an
Opus 4.8 session (both workers reported `claude-opus-4-8`), confirming model-independence._

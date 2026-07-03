# Knowledge Base: Claude Code + Codex — Hooks, Plugins, Prompting & Anti-Hallucination

Synthesis of 8 parallel research streams covering Claude Code hooks, the plugin/skill/marketplace ecosystem, Anthropic prompting guidance, agent best practices, OpenAI Codex configuration, community adherence-improving design patterns, multi-agent orchestration, and peer-reviewed instruction-following / hallucination research.

Audience: building a **verify-first, anti-hallucination Claude Code plugin**. Claims are cited inline; full source list at the end.

---

## 1. Claude Code Hooks

### 1.1 Event taxonomy (consensus across streams)
Hooks fire at lifecycle points across three cadences ([official hooks ref](https://code.claude.com/docs/en/hooks); [plugins ref](https://code.claude.com/docs/en/plugins-reference)):

- **Session-level**: `SessionStart`, `Setup`, `SessionEnd`
- **Turn-level**: `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`
- **Agentic loop (per tool call)**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`
- **Permission/team**: `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`
- **Content/context**: `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `MessageDisplay`, `PreCompact`, `PostCompact`
- **Workspace**: `WorktreeCreate`, `WorktreeRemove`
- **Other**: `Notification`, `Elicitation`, `ElicitationResult`

> **Count discrepancy (flagged):** The [official docs](https://code.claude.com/docs/en/hooks) and [plugins reference](https://code.claude.com/docs/en/plugins-reference) enumerate ~28–32 events; community sources say "27+" ([thepromptshelf](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/), [dev.to context-injection](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg)). The exact count is version-dependent and not worth pinning; treat the official plugins-reference list as authoritative.

### 1.2 Blocking vs. context-injection (strong consensus)
- **`PreToolUse` is the only event that can hard-block a tool action.** All production safety gates (file protection, dangerous-command blocking) must use it ([pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns); [dev.to](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg)).
- `UserPromptSubmit` can also block (exit 2 or `decision: "block"`) ([official ref](https://code.claude.com/docs/en/hooks)).
- In **agent-teams** mode, `TeammateIdle` (exit 2) keeps a teammate working instead of idling, and `TaskCompleted` (exit 2) blocks task closure until criteria met — both are enforcement points ([agent-teams](https://code.claude.com/docs/en/agent-teams)).
- `PostToolUse` runs after success — **cannot block**, but can replace output / add audit context. Use for formatting, linting, audit logs ([pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)).

### 1.3 Exit codes — the single most common mistake
| Code | Behavior | Blocks? |
|---|---|---|
| 0 | success; stdout parsed as context/JSON | no |
| 1 | **non-blocking** error; stderr shown to user | **no** |
| 2 | blocking error; stderr fed back per event | **yes** (only on blockable events) |
| other | non-blocking error | no |

**Exit code 1 does NOT block** despite Unix convention — "the single most common implementation mistake" ([thepromptshelf](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/)). Only exit 2 enforces.

### 1.4 JSON contract (event-specific schema differences)
All hooks receive on stdin: `session_id`, `hook_event_name`, `transcript_path`, `cwd`, optionally `tool_name`/`tool_input`/`tool_use_id` ([official ref](https://code.claude.com/docs/en/hooks)).

Schema differs by event — **mismatch silently fails enforcement**:
- **PreToolUse** uses a *nested* `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`/`defer`) plus optional `updatedInput`/`additionalContext`.
- **UserPromptSubmit** — two separate channels, do not conflate them: *blocking* uses the flat top-level `decision` + `reason`; *context injection* uses **nested** `hookSpecificOutput.additionalContext` (same nesting as SessionStart), NOT a flat `additionalContext`. A maintainer who "flattens" `additionalContext` to match the blocking fields breaks context injection silently.
- **SessionStart** uses nested `hookSpecificOutput.additionalContext` (+ `sessionTitle`).
- **Context injection is event-gated.** Per the official docs, stdout/`additionalContext` is added to the model's context on exit 0 for **only** `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart`. For every other event (including **`Stop`**, `PreCompact`, `PostToolUse`) stdout is written to the debug log only — it does NOT reach the model. The only model-reaching output for those events is the top-level `decision`/`reason` (e.g. a `Stop` hook can surface text solely via `{"decision":"block","reason":"..."}`); `additionalContext` on a `Stop`/`PreCompact` hook is inert. **[UPDATE 2026-06-10 — harness-version-dependent; verified delivering on 2026-06-10 build (see `tests/fixtures/step0-probe-record.md` P2 + gate A3-1):** PreToolUse `hookSpecificOutput.additionalContext` was observed reaching the model in multiple instances on the current Claude Code build (2026-06-10), appearing as model-visible context blocks acted on in-turn. This contradicts the official-docs claim above, which was sourced from an older harness. The older claim is retained here for reference; the 2026-06-10 observation is the newer data point. Both are harness-version-dependent. If the harness reverts, PreToolUse advisory delivery degrades to inert no-ops (fail-open). `Stop`/`PreCompact`/`PostToolUse` delivery-gap is NOT overturned by this observation — those are separate events.] **[UPDATE 2026-07-03 — SubagentStart CONFIRMED delivering (see `tests/fixtures/step0-probe-record.md` P9):** `verify-first-subagent.js`'s `hookSpecificOutput.additionalContext` was empirically confirmed reaching a real spawned subagent's actual model context on the current Claude Code build (2026-07-03) — not simulated. Method: captured the hook's real stdout via direct execution, diffed it byte-for-byte against the text a live subagent session actually received (exact match, appearing as a `system SubagentStart hook additional context: ...` turn in the primacy slot before the subagent's first response), then cross-checked 37 independent real prior subagent transcripts in the harness's own persisted transcript archive (`~/.claude/projects/.../subagents/*.jsonl`), all showing the identical harness-internal delivery record (`{"type":"attachment","attachment":{"type":"hook_additional_context","hookEvent":"SubagentStart",...}}` at message index 1, pre-assistant-turn). SubagentStart therefore joins `UserPromptSubmit`/`UserPromptExpansion`/`SessionStart`/`PreToolUse` as a confirmed context-delivering event on this harness build. Harness-version-dependent like the others; re-probe if the harness changes.]

Using the flat `decision` field on PreToolUse makes the hook "succeed" (exit 0) while enforcement silently fails ([thepromptshelf](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/)). **Generate schemas from code/docs, not memory.**

PreToolUse decision precedence when multiple hooks conflict: **deny > defer > ask > allow** ([official ref](https://code.claude.com/docs/en/hooks)).

### 1.5 Handler types (5)
`command` (shell), `http` (webhook), `mcp_tool` (MCP call), `prompt` (single-turn LLM eval), `agent` (subagent) ([official ref](https://code.claude.com/docs/en/hooks)). Use **command hooks for deterministic safety** (shell-native), `prompt` for semantic judgments, `agent` for codebase-wide analysis. Do not use LLM-evaluated hooks for deterministic checks — they can hallucinate compliance ([pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns); [thepromptshelf](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/)).

### 1.6 Constraints, matchers, placeholders
- **Output cap ~10,000 chars** — excess silently truncated ([dev.to context-injection](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg)).
- **Timeouts vary by handler**: command default 600s; http/prompt 30s; agent 60s. `UserPromptSubmit` reduces all to 30s max. Slow webhooks time out silently (non-blocking) ([official ref](https://code.claude.com/docs/en/hooks)).
- **Matchers**: exact (`"Bash"`), regex-OR (`"Edit|Write"`), MCP (`"mcp__server__.*"`), conditional input filter (`if: "Bash(rm *)"`). Without `if`, all matches apply ([luongnv89](https://github.com/luongnv89/claude-howto/blob/main/06-hooks/README.md)).
- **Placeholders**: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`. Quote in shell-form; unquoted in exec/args form ([plugins ref](https://code.claude.com/docs/en/plugins-reference)).
- **Config hierarchy**: `.claude/settings.local.json` (git-ignored) > `.claude/settings.json` (project) > `~/.claude/settings.json` (user). View via `/hooks`.

### 1.7 Security & testing
Hooks run as the user — **validate/sanitize all stdin** (no `../` traversal, always quote `"$TOOL_INPUT"` or extract with `jq -r`), exclude `.env`/`.git`, explicit env-var allowlists for HTTP hooks ([luongnv89](https://github.com/luongnv89/claude-howto/blob/main/06-hooks/README.md)). Test standalone before integrating: `echo '{...}' | ./hook.sh`; debug with `claude --debug`. This fixes ~80% of schema bugs pre-deployment.

---

## 2. Plugins, Skills, Marketplaces, Output Styles, Statusline

### 2.1 plugin.json ([plugins ref](https://code.claude.com/docs/en/plugins-reference))
- Manifest is **optional**; without it components auto-discover in default locations.
- Only required field: `name` (kebab-case). Unrecognized fields permitted (warned only under `--strict`, ignored at runtime). **Type mismatches** (e.g. `keywords` as string vs array) are the one case that *fails load*.
- Caching: installed to `~/.claude/plugins/cache/{id}/`; **external symlinks stripped**, path traversal (`../shared`) breaks post-install.

### 2.2 Skills / SKILL.md ([skills ref](https://code.claude.com/docs/en/skills); [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview))
- **Three-tier progressive disclosure**: metadata (name+description, ~100 tokens, always pre-loaded) → SKILL.md body (<5k tokens, on trigger) → reference files/scripts (on-demand, zero upfront cost). Scripts execute without loading code into context — only output consumed.
- Command name = directory name (except plugin-root SKILL.md where `name` field sets it).
- `description` is the primary auto-invocation control; vague descriptions cause "skill not triggered." Put key use-case first.
- `disable-model-invocation: true` blocks auto-invoke; `user-invocable: false` hides from `/` menu (Claude can still invoke).
- `paths: [glob]` limits auto-load to matching files.
- **Dynamic context injection**: `` !`shell command` `` runs *before* the skill renders and inlines output — grounds skills in live data (git diff, file contents), preventing stale-memory hallucination. Disableable via `disableSkillShellExecution: true` policy.
- **Keep SKILL.md <500 lines**; reference files **one level deep** — nested refs (`SKILL.md → A → B`) cause partial reads ([best-practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).

> **Convergence:** All four streams that touch skills agree on the same numbers (~100-token metadata, <5k body, <500 lines, one-level-deep references). High confidence.

### 2.3 Marketplaces ([plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces))
- Required: `name`, `owner` (with `name`), `plugins[]`. Entries need `name` + `source`.
- Source types: relative path, GitHub (`repo`, `ref?`, `sha?`), git URL, git-subdir, npm.
- **Version precedence**: plugin.json `version` > marketplace entry `version` > git SHA > "unknown". Setting `version` in both places: plugin.json wins **silently** — avoid.
- `strict: true` (default) = plugin.json is authority; `strict: false` = marketplace entry is the whole definition.
- Reserved names block impersonation (`claude-code-*`, `anthropic-*`, etc.).
- **Pitfall**: relative plugin sources don't work in URL-distributed marketplaces (file downloaded alone) — use GitHub/npm/git URL.

### 2.4 Output styles ([output-styles](https://code.claude.com/docs/en/output-styles))
Markdown + YAML frontmatter; modify the system prompt directly. `keep-coding-instructions: true` preserves default engineering behavior. **Loaded once at session start** — mid-session changes need `/clear` or restart. Orthogonal to CLAUDE.md; use for voice/tone, not project rules.

### 2.5 Statusline ([statusline](https://code.claude.com/docs/en/statusline))
Shell script receives JSON on stdin, prints to stdout. Rich schema (model, workspace, cost, context_window, rate_limits, effort, vim, agent, pr, worktree). **Many fields can be absent** — scripts must use fallbacks (`// empty` in jq) or fail silently (empty output). Only stdout shows; stderr is invisible. Requires `chmod +x` and workspace trust. Subagent statuslines via `subagentStatusLine`.

### 2.6 Other plugin components
LSP servers (`.lsp.json`), **Monitors** (background processes streaming notifications, `when: always|on-skill-invoke:<name>`), Themes (experimental), Channels (MCP-bound message injection). `userConfig` declares install-time prompts; `sensitive: true` → keychain, else `settings.json`; available as `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_<KEY>`. Plugin agents **cannot** declare `hooks`, `mcpServers`, or `permissionMode` (security). Run `claude plugin validate --strict` in CI.

---

## 3. Prompting Claude (official Anthropic guidance)

Sources: [prompting best-practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [reduce-hallucinations](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations), [extended-thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [system-prompts](https://platform.claude.com/docs/en/release-notes/system-prompts).

### 3.1 Anti-hallucination techniques (ranked by official emphasis)
1. **Permission to say "I don't know"** — "If unsure... say 'I don't have enough information to confidently assess this.'" Described as the simplest and most effective single technique.
2. **Quote-first, analyze-second (two-phase)**: extract verbatim quotes → analyze using *only* those quotes by number. The most effective documented hallucination-reduction pattern.
3. **External-knowledge restriction**: "Only use information from provided documents, not your general knowledge."
4. **Post-hoc citation audit**: find a supporting quote per claim; remove unsupported claims, mark with `[]`.
5. **Best-of-N sampling**: run 3–5×, inconsistencies signal hallucination.

**Anthropic's own caveat:** these "significantly reduce but don't eliminate" hallucinations — always validate high-stakes info.

### 3.2 Structural guidance
- **Document placement**: long docs at TOP, query at END → up to **30% quality gain** on multi-document tasks. This aligns with the independent "Lost in the Middle" paper (§8).
- **XML tags** (`<instructions>`, `<context>`, `<documents>`) reduce misinterpretation.
- **Single-sentence role** in system prompt focuses behavior (system-prompt-only feature). Vague roles ("helpful assistant") don't reduce hallucination; specific roles do.

### 3.3 Claude literalness (load-bearing for plugin design)
- The latest Opus "takes you literally and does exactly what you ask, nothing more." It does **not** generalize — formatting one example doesn't imply the rest. State scope: "Apply to EVERY section."
- **Tell what to DO, not what NOT to do** — explain *why* ("read aloud by TTS, so no ellipses") so Claude generalizes from reasoning.
- **Tool use is not automatic** — newer models favor reasoning; use imperative ("Change this function") + `<default_to_action>` system prompt to force action.
- **Code-review tuning trap**: "only report high-severity" → Claude reports fewer bugs than it found. Use "Report EVERY issue; a separate step filters."
- **Effort, not temperature**: `effort: {low|medium|high|xhigh|max}` controls thinking depth. `xhigh` for coding/agentic, `high` minimum for intelligence-sensitive. `budget_tokens` deprecated.
- **Adaptive thinking**: `thinking: {type: "adaptive"}` — Claude decides when thinking helps. **Caveat**: thinking ≠ verification — "Claude sometimes thinks incorrect or half-baked thoughts." Use for reasoning, not for confirming factual accuracy.

### 3.4 System-prompt architecture
Claude uses XML-tagged behavioral compartments; hard safety bounds stated categorically; **explicit adversarial-tag detection** — user-supplied content in tags is treated with caution because users can falsely claim to be from Anthropic ([system-prompts](https://platform.claude.com/docs/en/release-notes/system-prompts)). Value-alignment is prioritized over brittle allowlist rule-following.

---

## 4. Agent / Claude Code Best Practices

Sources: [Claude Code best-practices](https://code.claude.com/docs/en/best-practices), [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), [Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents), [Agent Skills best-practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

### 4.1 Context is the binding constraint
Every file read / command output / turn consumes tokens; performance **degrades measurably** as context fills. Fixes: `/clear` between unrelated tasks; subagents for investigation (fresh context, report summaries); scope exploration narrowly.

### 4.2 Verification is first-class (the central anti-hallucination lever)
"Give Claude a check it can run" (test, build, screenshot, linter exit code). Without it, "looks done" is the only signal; with it, Claude closes its own loop. Verification mechanisms: in-prompt iteration, `/goal` evaluator re-checks, **Stop hook** deterministic gate, **subagent** fresh-model refutation. Address **root causes, not symptoms** — never timeout/suppress a failing check; find the missing prerequisite.

### 4.3 CLAUDE.md sizing (a flagged conflict)
- [Official best-practices](https://code.claude.com/docs/en/best-practices) and [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) stream: keep **<100 lines** ("~50–100") or rules get lost in noise.
- The Superpowers/community stream cites **~400 lines** as the threshold.
- **Reconciliation**: both agree on the *principle* (prune ruthlessly; bloat → ignored rules; move complex/dynamic logic to skills+hooks). The numeric threshold is contested — treat <100 as the conservative target and ~400 as a hard ceiling.

### 4.4 Tool & skill design
- **Few thoughtful tools** beat wrapping all APIs; overlapping tools cause confusion ([Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)).
- **Semantic identifiers** (resolve UUIDs → human names) measurably improve precision; small tool-description refinements yield large gains ([Writing Tools](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- **Evaluation-driven**: write realistic multi-step workflow tests *before* building tools/skills.
- **Degrees of freedom match fragility**: high-freedom text for exploration, low-freedom **bundled scripts** for fragile ops (migrations, validation, batch). Test with Haiku, Sonnet, AND Opus — Haiku may need more detail.
- **Pick the simplest agent pattern** (prompt chaining handles ~80%); add orchestrator-workers/evaluator-optimizer only when measurement proves benefit.

---

## 5. OpenAI Codex — Config, AGENTS.md, Hooks, Reasoning

Sources: [config-reference](https://developers.openai.com/codex/config-reference), [hooks](https://developers.openai.com/codex/hooks), [agents-md](https://developers.openai.com/codex/guides/agents-md), [subagents](https://developers.openai.com/codex/subagents), [noninteractive](https://developers.openai.com/codex/noninteractive), [prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide), [approvals-security](https://developers.openai.com/codex/agent-approvals-security), [Codex best-practices](https://developers.openai.com/codex/learn/best-practices).

### 5.1 config.toml
- `approval_policy`: `untrusted` | `on-request` | `never` | `granular`. `on-failure` deprecated.
- `sandbox`: `:read-only` | `:workspace` | `:danger-full-access`.
- `model_reasoning_effort`: minimal/low/medium(default)/high/xhigh. **`xhigh` not available on all Codex variants; some Bedrock deployments cap at high.** xhigh is "noticeably slower and more expensive" — async/proof-bound work only.
- **Project-local config cannot override machine-owned settings** (auth, telemetry, notifications) — enforced boundary; attempts silently ignored.
- Protected paths `.git`, `.agents`, `.codex` stay read-only even in writable modes.

### 5.2 Hooks — Codex vs Claude (key divergence)
- `PreToolUse` intercepts Bash, `apply_patch`, MCP **before** execution; can deny/rewrite/inject. Returns `"permissionDecision": "deny"` to block.
- `PostToolUse` observes only; `"decision": "block"` replaces output.
- **DIVERGENCE FROM CLAUDE**: Codex `PreToolUse` currently **rejects `additionalContext`** (the Claude-style pattern is not yet supported) ([Codex hooks](https://developers.openai.com/codex/hooks), GitHub #19385).
- **Important caveat**: "doesn't intercept all shell calls yet, only simpler ones" — complex piped commands may slip through. PreToolUse is a guardrail, **not airtight**.
- Community confirms the harness-realization value: hooks turn governance from conversational ("remember the rule") to operational ("technically unavoidable at execution") ([Blake Crosley](https://blakecrosley.com/blog/codex-hooks-make-the-harness-real); [GitHub #14882](https://github.com/openai/codex/issues/14882)).

### 5.3 AGENTS.md precedence
Discovery (first match wins): `~/.codex/AGENTS.override.md` → `~/.codex/AGENTS.md` → walk git-root→cwd checking `AGENTS.override.md`/`AGENTS.md`/fallbacks. Closer dirs override; 32 KiB/file max. **Verify load order**: `codex --ask-for-approval never "Summarize current instructions"`.

### 5.4 Subagents
Explicit spawning only ("Codex only spawns a new agent when you explicitly ask"). Built-ins: `default`, `worker`, `explorer`. `max_threads` default 6, `max_depth` default 1 (prevents costly nesting), `job_max_runtime_seconds`. Subagent workflows cost **more** tokens than single-agent — use only for true parallelism.

### 5.5 Non-interactive & prompting
`codex exec "task"` (progress→stderr, output→stdout); `--json` JSON Lines; `--output-schema` for structured output. CI-safe combo: `approval_policy: "never"` + explicit `--sandbox`. **Never** set `OPENAI_API_KEY` as job env var (issue #5038: VS Code extension can ignore `never` and prompt). Codex prompting: "produces higher-quality outputs when it can verify its work" — include reproduce/validate/lint steps; decompose; goal mode with measurable outcomes. The latest OpenAI Codex `phase` field ("commentary"/"final_answer") must be preserved in history.

> **Cross-tool consensus:** Both Claude and Codex official docs independently state verification-driven work produces higher quality, and both make `PreToolUse` the primary preventive enforcement point. Strong convergence.

---

## 6. Community Skill/Hook Design Patterns That Improve Adherence

### 6.1 Superpowers framework ([blog](https://blog.marcnuri.com/superpowers-claude-code-skills-framework); [repo](https://github.com/obra/superpowers))
- **Iron Law + Rationalization Table**: each skill opens with a capitalized non-negotiable rule paired with an enumerated table of the *specific excuses* agents use to bypass it. TDD red flags: "tests pass on first run", "kept old code as reference", "just this once". Verification red flags: "should", "probably", "seems to". Stated target: **"preventing the agent from talking itself out of following [the rules]"**, not teaching — the agent already knows them.
- 14 skills; 7-step workflow (brainstorm → worktrees → plan → develop w/ 2-stage review → TDD → code review → complete). TDD skill **deletes code written before tests**.

### 6.2 Recency bias / U-shaped attention ([reverse-engineering writeup](https://medium.com/@fengliu_367/the-complete-guide-to-writing-agent-system-prompts-lessons-from-reverse-engineering-claude-code-09ecd87c7cc1))
- Instruction adherence degrades noticeably **beyond ~80K tokens**, severely above 120K, despite 200K window.
- Inject `<system-reminder>`-tagged rule refreshes every **40–80K new tokens**. Keep system prompt <6,000 tokens (leaving 5–15k for tools).
- Place critical rules at **start AND end** (primacy + recency). This matches the official "docs at top, query at end" guidance (§3.2) and the "Lost in the Middle" paper (§8) — **three independent sources converge**.

### 6.3 Spec-driven external memory ([dev.to spec-workflow](https://dev.to/samhath03/how-i-stopped-claude-code-from-hallucinating-on-day-4-the-spec-driven-workflow-3lim))
`.claude/specs/{plans,in-progress,plans-executed}/`; Claude re-reads before code generation. Combats "context rot." **Caveat (consensus across two streams)**: prune weekly — append-only spec dirs become contradictory and stale.

### 6.4 Smart-model-reviewer is backwards ([cloudpresser](https://cloudpresser.com/writing/smart-model-reviewer-is-backwards))
Conventional (cheap generate → smart review) is **inverted**. Correct: **smart model generates** (open-ended reasoning), **cheap model verifies** against spec/tests (bounded), **human aligns intent**. A smart reviewer can spot errors but can't elevate mediocre work → structural quality ceiling.

> **Conflict flagged:** This contradicts the `deadly-loop` convention of using **Opus for review/critique**. Reconciliation: cloudpresser's argument is about *cost-tier routing for bounded vs open-ended tasks*; deadly-loop deliberately spends premium models on *adversarial* review of high-stakes merges where missing a bug is more expensive than the tokens. Both can be right depending on stakes — use cheap verifiers for routine bounded checks, premium adversarial reviewers for high-stakes/security/cross-repo merges.

### 6.5 Two-reviewer debate ([agentic-patterns](https://agentic-patterns.com/patterns/ai-assisted-code-review-verification/))
Correctness Auditor + Failure-Mode Hunter in parallel; loop until zero NEW P0/P1. Empirically (librarian v0.6.0) 7 rounds caught 30+ bugs solo review missed.

### 6.6 Prevent-not-suppress
When a safety check misbehaves, fix the missing prerequisite — never `.timeout()`/`unawaited()`/disable. Weakening a check to fix a symptom leaks enforcement to all future code (consensus with §4.2 official "root causes not symptoms").

### 6.7 Three-layer architecture (consensus)
**CLAUDE.md (advisory, static)** + **Skills (reusable workflows w/ Iron Laws)** + **Hooks (deterministic, unbypassable gates, exit 2)**. Hooks for "must happen every time, zero exceptions"; skills for procedures; CLAUDE.md for static conventions. Dynamic/enforcement logic → hooks, never CLAUDE.md ([pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns); [MuhammadUsmanGM wiki](https://github.com/MuhammadUsmanGM/claude-code-best-practices); [karanb192](https://github.com/karanb192/claude-code-hooks)).

---

## 7. Claude + Codex Multi-Agent Orchestration

Sources: [agent-teams](https://code.claude.com/docs/en/agent-teams), [multiagent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent), [Beyond Trusting Trust](https://arxiv.org/pdf/2502.16279), [Multi-Agent Code Verification via Information Theory](https://arxiv.org/pdf/2511.16708), [MindStudio](https://www.mindstudio.ai/blog/what-is-claude-code-agent-teams), [Particula oh-my-codex](https://particula.tech/blog/parallel-coding-agents-worktree-pattern-oh-my-codex), [Frontiers dual-perspective](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2025.1655469/full).

### 7.1 Agent Teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)
- Parallel teammates in separate context windows with **direct inter-agent messaging** (not funneled through lead); shared task list with auto-resolving dependencies.
- **Coordinator stays non-blocked** — assigns/synthesizes, doesn't implement. Pitfall: lead starts coding → teammates idle → parallelism lost.
- **Optimal size 3–5 teammates; 5–6 tasks each.** Token cost scales linearly per active teammate. Up to 25 concurrent threads ([multiagent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent)).
- **Strict file ownership** — two teammates editing one file = silent overwrites.
- Teams beat subagents when teammates must **challenge/debate** (competing root-cause hypotheses); subagents better for quick result-only delegation. Use git worktrees to isolate ([Particula](https://particula.tech/blog/parallel-coding-agents-worktree-pattern-oh-my-codex)).

### 7.2 Model diversity catches uncorrelated bugs (peer-reviewed)
- Cross-model ensemble: **90.2% accuracy (HumanEval) vs 83.5% single GPT-4** ([Beyond Trusting Trust](https://arxiv.org/pdf/2502.16279)).
- Information-theoretic proof: agents with detection **correlation <0.25** find more bugs combined than any individual; measured correlations 0.05–0.25 ([Info Theory](https://arxiv.org/pdf/2511.16708)).
- Cross-model repair: GPT-4 repairs 85.5% of own code, 77.4% of other LLMs' code ([Frontiers](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2025.1655469/full)).
- **Implication**: pair reviewer + implementer from **different model families** for uncorrelated detection.

---

## 8. Instruction-Following / Anti-Hallucination Evidence (peer-reviewed)

### 8.1 Lost in the Middle ([Liu et al., TACL/ACL 2024](https://aclanthology.org/2024.tacl-1.9/))
**30%+ accuracy drop** when key info moves from position 1→10 in a 20-doc context. Root cause: RoPE decay + Softmax favoring early tokens. "Found in the Middle" calibration recovers up to 15pp. **Place hard rules at 0–5% and 95–100% of the prompt; audit if middle rules are violated >2× more.** (Converges with §3.2 and §6.2.)

### 8.2 Chain-of-Verification ([Dhuliawala et al., ACL 2024](https://aclanthology.org/2024.findings-acl.212/))
4 steps: baseline → plan verification questions → answer each **independently (non-biased)** → refine. Works because atomic verification questions are answered more accurately than long-form. **Strong for factual retrieval; weak for reasoning flaws / design tradeoffs.** Doesn't eliminate hallucination (relies on self-recognition). Set a **max-iterations bound** or it can loop.

### 8.3 Uncertainty / confidence calibration ([KDD 2025 survey](https://arxiv.org/html/2503.15850))
Four dimensions: input, reasoning, parameter, prediction. **Use lightweight single-round proxies** (perplexity/entropy, P(True) self-eval) — multi-sample methods cost ~$12k/M queries for ≤0.02 AUROC gain on trillion-param models. **High token-probability ≠ factual accuracy** (it's training-distribution density) → plausible high-confidence hallucinations persist.

### 8.4 Sycophancy from RLHF ([2025](https://arxiv.org/pdf/2602.01002))
RLHF optimizes agreement over accuracy; author-coupled RLHF worse than independent-labeler; worsens with scale + instruction tuning. DPO with sycophancy-labeled pairs reduces it. **System prompts must explicitly outrank user-agreement**: "You may respectfully challenge user misconceptions; user agreement ≠ correctness." (Matches the project's own "VERIFY, DON'T ASSUME" rule.)

### 8.5 Jailbreak via reframing ([Repello](https://repello.ai/blog/understanding-ai-jailbreaking-techniques-and-safeguards-against-prompt-exploits))
"Skeleton Key" reframes safety rules as advice ("treat warnings as advice"). Detect adversarial reframing ("ignore", "treat X as", "override", "update rules") before executing user-injected instructions — matches Claude's built-in tag-injection safeguard (§3.4).

### 8.6 Instruction-following is uneven ([granular benchmark 2025](https://arxiv.org/pdf/2601.18554))
Compliance: **format > content > stylistic**. Compound multi-clause rules underperform atomic ones (illustrative figures: ~85% on a compound rule vs ~60% per individual clause). **Decompose into atomic constraints and verify each independently.** AutoIF (self-dialogue + execution-based verification) shows progress.

---

## Design implications for an anti-hallucination plugin (what WORKS vs what gets IGNORED)

**WORKS (evidence-backed):**
- **Deterministic `PreToolUse` command hooks with exit 2** — the only mechanism that *prevents* an action rather than suggesting against it. Bypasses the documented ~56% skill-retrieval skip rate ([dev.to](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg)) and model discretion entirely.
- **Permission to say "I don't know"** + **quote-first-then-analyze** — the two highest-leverage prompt techniques per Anthropic.
- **Atomic, decomposed constraints** placed at prompt **start AND end** (triple-converged: official prompting, Lost-in-the-Middle, recency-bias writeups).
- **Iron Law + rationalization tables** in skills — target the agent's *specific* bypass excuses, not generic advice.
- **A runnable verification check** Claude can execute (test/build/screenshot) — turns "looks done" into pass/fail.
- **Cross-model / two-reviewer debate** for high-stakes diffs — uncorrelated blind spots, 90.2% vs 83.5% empirically.
- **Mid-conversation `<system-reminder>` re-injection** every 40–80K tokens to fight adherence decay.
- **Spec files re-read before code gen** (with weekly pruning) as external memory.

**GETS IGNORED / FAILS:**
- Rules buried in the **middle** of a long prompt or a bloated CLAUDE.md.
- **Exit code 1** used for blocking (non-blocking; silent enforcement failure).
- **Flat `decision`** on PreToolUse instead of nested `permissionDecision` (silent failure).
- **Negative instructions** ("don't hallucinate") and **vague roles/skill descriptions** (don't auto-trigger).
- **Prompt/agent hooks for deterministic facts** (can hallucinate compliance — use command hooks).
- **Output-first then fact-check** (Claude rarely retracts post-hoc; use two-phase extract-then-analyze).
- **Extended thinking as a verification guarantee** (Anthropic: thinking can be "half-baked").
- **Disabling/timeout-ing a failing safety check** (leaks enforcement; fix the prerequisite).
- **Trusting high token-probability** as factual confidence.

**Cross-tool note:** Claude `PreToolUse` supports `additionalContext`; Codex `PreToolUse` currently does **not**, and Codex doesn't intercept all shell calls — design context-injection to be Claude-only and treat Codex hooks as guardrails, not airtight gates.

---

## 9. Anthropic Prompting 101 (Code w/ Claude 2025) — key tips

Distilled from the "Prompting 101 | Code w/ Claude" keynote (Hannah Moran & Christian Ryan, Applied AI, Anthropic; May 22, 2025) and the companion "Prompt Doctor" workshop (Zack Witten). These are the people who built the model; the tips below are the load-bearing ones for an anti-hallucination injection.

### 9.1 The 5-element prompt structure
Anthropic's recommended scaffold for any production prompt:
1. **Task description** — 1–2 sentences defining the role and the specific task.
2. **Dynamic content** — the data/images/retrieved info to process (goes in the user message).
3. **Detailed instructions** — step-by-step approach; **mirror the reasoning order a human would naturally follow** (dependencies first).
4. **Examples (optional, high-impact)** — few-shot; "production systems often carry dozens to hundreds of examples." One high-quality example beats several truncated ones; include negative/contrasting pairs for subjective qualities.
5. **Reminder of critical points** — restate the important rules **at the end**; "for long prompts, repeating critical instructions at the end is especially effective." (Converges with §8.1 Lost-in-the-Middle and §6.2 recency bias — the same primacy+recency principle.)

### 9.2 XML tags as delimiters (top structural recommendation)
- Use XML tags (`<instructions>`, `<context>`, `<documents>`, `<user_preferences>`) to delimit prompt sections. Zack Witten's #1 principle: "clearly separating different parts of the prompt is the most important thing."
- Claude parses XML tags better than Markdown (training-data exposure), and they are more token-efficient than prose.
- Wrap **outputs** in semantic tags too (`<final_verdict>`, `<json>`) for programmatic extraction.
- Position long documents/context **above** instructions; the instructions followed most tightly sit **near the bottom**.

### 9.3 Prefill (assistant pre-fill)
- Seed the assistant turn with an opening token to force format and kill preamble: prefill `<final_verdict>` (or `{` for JSON, or `<quotes>` for grounding). Claude continues from the prefill — no "Here is my analysis…" filler.
- For JSON: prefill `{` (re-add it before `json.loads()`), or wrap in `<json>…</json>` + a `</json>` stop sequence. Most reliable JSON technique per the workshop.

### 9.4 Extended thinking as a diagnostic, not a production crutch
- "Treat Extended Thinking as a diagnostic tool, not a permanent crutch. Use it to identify where Claude struggles, then **encode those reasoning steps as explicit instructions** in the system prompt." Encoding reasoning as instructions yields equivalent quality at lower latency/cost. (Reinforces §3.3's caveat that thinking ≠ verification.)

### 9.5 Quote-before-summarize (grounding)
- Force grounding by requiring Claude to **extract verbatim quotes first**, then summarize/analyze using only those quotes (a `<quotes>` block, often via prefill). This is the most effective documented hallucination-reduction pattern (same as §3.1 #2). "Generate reasoning before responses rather than after — post-hoc rationalizations are unreliable."

### 9.6 Permission to say "I don't know"
- Specify confidence thresholds ("do not make an assessment if not fully confident"); grant explicit permission to say "I don't know" and to acknowledge missing information rather than inventing it. Give explicit edge-case "outs" via tags like `<unsure>`. Caveat: "hallucination cannot reach zero — production systems require validation layers, human review, and failure logging separate from prompting." (Same lever this plugin's UNCERTAINTY-IS-ALLOWED rule encodes.)

### 9.7 Prompt engineering is iterative empirical science
- "Build test cases, find failure patterns, encode fixes into the system prompt — keep running this loop to reach production quality." Treat the prompt like a spec for a competent contractor (fix typos, use proper capitalization; CAPS/`!` emphasize directives). Replace ambiguous words ("concise") with measurable constraints ("1–3 sentences, never more than 3"). Prefer positive phrasing; use negatives sparingly. Test with messy/realistic inputs, not idealized ones.

---

## 10. The latest Opus — features relevant to this plugin

From the Opus feature reference (as of 2026-05-28, the latest is `claude-opus-4-8`; always use the newest available). Only the features that bear on this anti-hallucination plugin are summarized; see the source for the full set (fast mode, refusal stop_details, lower cache minimum, etc.).

### 10.1 Adaptive thinking is the only thinking mode
- On the latest Opus generations, manual `thinking: {type:"enabled", budget_tokens:N}` returns a **400 error**. The only supported mode is `thinking: {type:"adaptive"}`, and thinking is **off by default** — you must enable it explicitly.
- When enabled, Claude decides per turn whether/how much to think; **interleaved thinking between tool calls is automatic** in adaptive mode (strong for agentic loops). At `high`/`xhigh`/`max` Claude almost always thinks; at `medium`/`low` it may skip simple turns.
- On recent Opus generations `thinking.display` defaults to `"omitted"` (silent change from earlier versions' `"summarized"`); you are still billed for the full thinking tokens. Thinking ≠ verification still holds (§3.3): adaptive thinking is reasoning, not a factual guarantee.

### 10.2 Effort defaults to `high`; `xhigh` is the recommended max for agentic/coding work
- **Default effort on all surfaces including Claude Code is `high`** (setting `high` == omitting the parameter). Pass via `output_config.effort`; it affects **all tokens** (text, tool args, thinking). `budget_tokens` is deprecated/rejected.
- Anthropic's guidance: **start at `xhigh`** for coding/agentic use; use `high` as the minimum for intelligence-sensitive work; step down to `medium` only after measuring on evals; at `xhigh`/`max` set a large `max_tokens` (start ~64k).
- **Availability caveat:** `xhigh` exists only on the latest Opus generations; `low/medium/high/max` are broader. (This is the API-side analog of the Codex §5.1 `xhigh` caveat — request `xhigh`, but fall back to `high` where the surface/model doesn't support it.)
- The latest Opus improves **tool triggering** (fewer skipped required tool calls) and **effort calibration** — directly relevant to hooks that depend on Claude actually running a verification tool.

### 10.3 Mid-conversation system messages
- `role: "system"` messages can now appear **inside** the `messages` array (not just the top-level `system` field), placed immediately after a user turn. **Only on the latest Opus** (Claude API / Claude Platform on AWS only — not Bedrock/Vertex/Foundry); no beta header.
- Why it matters here: a `PostToolUse` hook can append `{role:"system", content:"Verified: <evidence>"}` to inject verified facts with **system-level authority** mid-session **without invalidating the prompt cache** on the stable prefix. This is the cleanest mechanism for grounding subsequent turns against tool output — a future enhancement path for this plugin's hooks beyond `additionalContext`.

### 10.4 "ultracode" in Claude Code
- `ultracode` appears in Claude Code's effort UI but is **not** an API effort level. It pairs **`xhigh` effort with standing permission to launch multi-agent workflows**, granted through mid-conversation system messages. Relevant to the `orchestration` skill: `ultracode` is the surface affordance for "max effort + permission to spawn a swarm." The API itself only accepts `low/medium/high/xhigh/max`.

---

## 11. Latest Opus swarm & phased orchestration

Sources: [Dynamic Workflows](https://code.claude.com/docs/en/workflows), [Agent Teams](https://code.claude.com/docs/en/agent-teams), [Subagents SDK](https://code.claude.com/docs/en/agent-sdk/subagents), [Managed Agents API](https://platform.claude.com/docs/en/managed-agents/multi-agent), [Managed Agents blog](https://www.anthropic.com/engineering/managed-agents), [Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system), [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).

### 11.1 Three native primitives and their hard limits

| Primitive | Status | Concurrency | Key limits |
|---|---|---|---|
| **Agent SDK subagents** | Stable | ~25 threads | No nesting (subagents cannot spawn); only channel = injected prompt string; context starts fresh |
| **Agent Teams** | Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | 3–5 recommended | No nested teams; one team at a time; token cost linear per active teammate; no session resumption |
| **Dynamic Workflows** | Research preview (Claude Code v2.1.154+, paid plans) | 16 concurrent; 1,000 per run | Not production-ready; no mid-run user input; a 500-agent audit can shift the bill by an order of magnitude; practitioner tester reported 47-agent attempt, "several dumb mistakes in 5 hours" |
| **Managed Agents API** | Beta (`managed-agents-2026-04-01` header) | 25 concurrent threads | 20 unique agents in roster; coordinator depth-1 only; archive threads to reclaim slots |

Agent SDK subagents are the right choice when you control model selection and need deterministic nesting-free dispatch. Dynamic Workflows are for scale research/audit work where a stale result is recoverable. Agent Teams for adversarial debate with direct peer messaging. Managed Agents for server-side multi-agent pipelines.

### 11.2 The 3-element phase primitive

Every phase has exactly three elements:
1. **Fan-out** — spawn N subagents (or workflow agents) with distinct, non-overlapping scopes simultaneously. SDK: `background: true` subagents. Dynamic Workflows: parallel script stages.
2. **Synthesis** — coordinator collects final messages only (not intermediate tool calls), writes a canonical artifact (e.g., `.planning/PHASE-N-synthesis.md`).
3. **Gate** — verification check against the synthesis. Automated (hook, test, exit code) or explicit human confirm. Blocks Phase N+1 until passed.

**Rule**: parallelize analyzers and fix workers; serialize gates. The gate is the single synchronization point that prevents agents from building on an unvalidated foundation.

### 11.3 Analyze-work mode (pre-planning fan-out)

A dedicated pre-planning pass of parallel read-only subagents, no code output, converge on a diagnosis before any plan is written:

```
fan out in parallel (effort: medium, tools: Read/Grep/Glob only):
  - architecture-analyzer  -> { touched_modules, api_contracts, callers }
  - security-analyzer      -> { auth_paths, secret_access, data_flows }
  - test-analyzer          -> { coverage_gaps, missing_edge_case_scenarios }
  - contract-analyzer      -> { schema_deps, downstream_consumers }
coordinator synthesizes -> .planning/ANALYSIS-<feature>.md ("blast radius map")
gate: check for P0 blockers before advancing to PLAN phase
```

This replaces "graph-scout + codebase map" with native subagent fan-out. Cheaper than a full GSD spec cycle before you know the shape of the work. The blast radius map is then fed to both the planner and the debate agents so they attack with specificity.

### 11.4 Effort routing for phased orchestration

- **Orchestrator/coordinator**: `xhigh` (long-horizon planning, synthesis). Set `max_tokens` ≥ 64k at xhigh.
- **Analysis subagents**: `medium` or `high` (focused scope, shorter output).
- **Verification subagents**: `low` or `medium` (reading/checking, not deep reasoning).

`xhigh` exists only on the latest Opus generations; fall back to `high` on other models. `ultracode` (Claude Code UI) pairs `xhigh` with standing workflow-launch permission via mid-conversation system messages — to replicate via API, use `effort: xhigh` + a mid-conversation system message granting permission.

### 11.5 Mid-conversation system messages as phase mode switches

On the latest Opus (Claude API / Claude Platform on AWS only — not Bedrock/Vertex/Foundry): append `{"role":"system"}` after a user turn to switch mode mid-session without invalidating the prompt cache prefix. Key use: grant standing permission to launch multi-agent workflows at a phase boundary, or inject verified evidence with system-level authority after a `PostToolUse` hook completes. Limitations: cannot be first message; must follow a user turn; consecutive system messages must be merged.

### 11.6 Practical pitfalls

- **Vague prompts compound** through autonomous execution — errors propagate without check-ins. Include exact file paths, decisions, and errors in each subagent prompt.
- **No nested agents** at any tier. Plan must fit within one delegation level.
- **File conflicts**: two agents editing one file = silent overwrites. Decompose so each agent owns disjoint files.
- **Thread slot exhaustion** (Managed Agents): archive completed threads to reclaim the 25-slot limit.
- **Cost scales brutally**: token cost is linear per active teammate; Dynamic Workflows compound this at scale. Do not enable Dynamic Workflows or Agent Teams for routine single-repo features.
- **Mythos withheld**: Anthropic is withholding its most advanced Mythos model for autonomous subagent coordination due to cybersecurity concerns ([Unite.AI](https://www.unite.ai/what-opus-4-8-changes-for-anyone-running-agents-on-claude/)).

---

## 12. GSD distilled: a simpler phase loop

Sources: internal GSD skill files (`.gsd/TEAM-FORMATION.md`, `.gsd/DEBATE-WORKFLOW.md`, `~/.claude/skills/gsd-*/SKILL.md`). Full GSD is a production ops system for a multi-repo aviation app; the four portable primitives are distilled below. Source doc: `docs/gsd-distilled.md` in this repo.

### 12.1 The four portable primitives

1. **Phase decomposition with blast-radius mapping** — each phase declares: `goal` (one sentence), `files` (every module/contract/caller perturbed), `edge_cases` (enumerated: empty input, boundary, auth denied, partial failure, retry), `verify_cmd` (the command that proves the goal, not just "tasks done"). Forces blast-radius mapping before any code is written.
2. **Parallel reviewer + adversarial critic, fix waves, convergence on NEW P0s** — Reviewer (strong reasoning, e.g. Opus) and Critic (cross-provider, e.g. the latest OpenAI Codex) run in parallel and independently. Loop terminates on count of **new** (not rediscovered) P0/P1 reaching zero. If blocker count does not decrease between rounds, **escalate** rather than retry (stall detection).
3. **Anti-speculation discipline** — every claim requires a citation: `file:line` or command output. No assertion without evidence.
4. **Fan-out analyzers -> synthesis before planning** — gives debate agents concrete targets rather than generic heuristics (see §11.3).

### 12.2 KEEP / SIMPLIFY / DROP

| GSD concept | Decision | Why |
|---|---|---|
| Phase decomposition (goal, files, verify) | KEEP | Forces blast-radius mapping before coding |
| Post-plan and post-execution debate (parallel Reviewer + Critic, fix waves, NEW-P0 convergence) | KEEP | Proven ROI; prevents narrow-vision tunneling |
| Anti-speculation discipline | KEEP | Core anti-hallucination lever |
| Model tiering (Haiku for cheap ops, Sonnet for implementation, Opus for gates) | KEEP | Cost-efficient without sacrificing gate quality |
| Edge-case enumeration + scenario simulation | KEEP | Debate agents attack exactly the enumerated cases |
| Fix-wave parallelism (non-overlapping files) | KEEP, simplified | Simplify: one-sentence grouping rule, no YAML frontmatter |
| Discuss-phase questioning protocol | SIMPLIFY -> "gather intent" step | Keep output (list of locked decisions) without full protocol |
| Per-phase file tree (CONTEXT.md, PLAN.md, SUMMARY.md, VERIFICATION.md, REVIEWS.md) | SIMPLIFY -> task-list entries | Goal + files + verify live in the task description, not separate files |
| ROADMAP.md + STATE.md | SIMPLIFY -> running task list | Single append-only task list suffices |
| gsd-sdk CLI / binary bootstrap | DROP | External binary dependency; not portable |
| Per-phase codebase map (7 documents) | DROP | Replace with analyze-work fan-out (§11.3) |
| Wave numbering YAML frontmatter | DROP | Natural-language grouping in plan is sufficient |
| Domain specialist agent roles (project-specific) | DROP | Caller parameterizes per project |
| Per-agent completion markers (`## PLANNING COMPLETE`) | DROP | Only needed for GSD's regex-driven workflow engine |

### 12.3 The 7-step lite loop

```
1. ORIENT:  Load existing knowledge (graph/docs if present). List locked decisions.
2. PLAN:    Decompose into phases (goal + exact files/modules + edge_cases + verify_cmd).
            Enumerate edge cases; simulate each scenario on paper.
3. HARDEN:  Debate the PLAN — parallel Reviewer (strong reasoning) + Critic (adversarial,
            cross-provider when possible). Fix-wave on HOLD findings. Loop until zero NEW P0s.
            Stall rule: if blocker count does not decrease, escalate instead of retrying.
4. BUILD:   Execute each phase with TDD (test -> code -> verify, atomic commits).
            Fan out independent sub-tasks in parallel (non-overlapping files only).
5. HARDEN:  Debate each phase's diff — same Reviewer + Critic structure. Zero NEW P0s to advance.
6. GATE:    Any irreversible action (deploy, migration, secret rotation, force-push) serializes
            here for explicit human confirmation regardless of autonomy mode.
7. ADVANCE: Update task state, re-read plan (catches phases inserted mid-execution), repeat from 4.
```

Tracking: one append-only task list (goal + files + verify per entry) + one `CONVERSATION-CONTEXT.md` with locked decisions, worktree assignments, and hard-gate log.

---

## 13. Superpowers planning patterns

Sources: [superpowers framework writeup](https://blog.marcnuri.com/superpowers-claude-code-skills-framework), [obra/superpowers repo](https://github.com/obra/superpowers). Skills analyzed: brainstorming, writing-plans, executing-plans, subagent-driven-development, dispatching-parallel-agents, verification-before-completion, test-driven-development. Source doc: `docs/superpowers-planning.md` in this repo.

### 13.1 The 5-stage pipeline

```
[GATE: brainstorm] -> [PLAN artifact] -> [EXECUTE: subagent-per-task] -> [REVIEW: two-stage] -> [VERIFY: gate function]
```

**Stage 1 — Brainstorm gate**: No implementation until design is approved. If scope > 1 file or > ~2 hours: require written intent (3–10 sentences: goal, constraints, success criteria, 1–2 approaches with recommendation) before writing any plan. One clarifying question at a time. Hard gate — no plan exists until intent is articulated and approved.

**Stage 2 — Plan artifact**: Written to a committed file (`.planning/<date>-<feature>.md`). Header: goal (1 sentence), architecture (2–3 sentences), tech stack. Tasks: checkbox syntax, bite-sized (2–5 min each), exact file paths, exact commands with expected output. **No placeholders, no TBDs.** Inline self-review before handoff: placeholder scan, type consistency, spec coverage.

**Stage 3 — Execute with subagent context injection**: Coordinator reads the full plan once and extracts all task text upfront. Each implementer subagent receives injected context (task text, relevant file snippets, constraints) — they do NOT read the plan file themselves. This keeps each agent's context budget focused on its task. Independent tasks dispatch in parallel (no shared file writes); dependent tasks are sequential. Each implementer follows TDD internally.

**Stage 4 — Two-stage review per task (order is load-bearing)**:
- Stage A: spec-compliance reviewer — does the code match the plan task? Any missing requirements, out-of-scope additions?
- Stage B: code-quality reviewer — only after Stage A passes.
Reversing the order wastes code-quality review on scope-drifted code. Stages are independent agents; safe to parallelize across independent tasks, but within a single task Stage A precedes Stage B.

**Stage 5 — Verification iron law**: No completion claim without fresh evidence from the actual command output in the current message. Applies to: tests, builds, lint, requirements checklists, agent reports. "Should work" is not evidence. This applies at every phase boundary, not just at ship time.

### 13.2 What to keep vs drop for a minimal loop

**Keep:**
- Brainstorm-before-plan gate (stops context-free implementation; one question at a time is fast)
- Plan-as-artifact with no placeholders (checkpointable, auditable, resumable across sessions)
- Context injection pattern (subagents receive injected text, never read plan file; keeps context budgets clean)
- Two-stage review order: spec-compliance then code-quality (reversing wastes review on drifted code)
- Verification-before-completion iron law at every phase boundary
- TDD red-green-refactor (watching the test fail proves the test is meaningful)
- Parallel dispatch only when no shared state (independence check is cheap insurance)

**Drop for minimal loop:**
- Visual companion during brainstorm (high token cost; not generic infrastructure)
- Formal spec doc separate from plan (intent note + plan file suffices)
- finishing-a-development-branch ceremony (coordinator handles merge decisions)
- Sequential model tiering protocol (premature before the loop is proven; defer to §12.1 model tiering)

### 13.3 Compositions with §11 (swarm) and §12 (GSD lite)

- The **brainstorm gate** (§13.1 Stage 1) maps to GSD's ORIENT/gather-intent step (§12.3 step 1) — both enforce "locked decisions before planning."
- **Context injection** (coordinator extracts, subagent receives) directly maps to §11.1's "only channel = injected prompt string."
- **Two-stage review** slots between BUILD and the §12 HARDEN debate: spec compliance first ensures the debate agents are attacking a correctly-scoped implementation.
- **Verification iron law** is the gate function that prevents false phase-complete reports from compounding. Complements §4.2's "give Claude a check it can run."
- **Parallel dispatch independence check** is the coordinator's responsibility, not implementers' — identical to §11.6's file-conflict pitfall.

---

## 14. Claude Code environment internals (verified empirically)

Captured by instrumenting real hook invocations and processes — not from docs. These
hold under **cmux** (a terminal wrapper that launches `claude`); some differ from a
vanilla CLI, so the reliable signals below are the cross-environment ones.

### 14.1 Coordinator vs subagent detection — use the PAYLOAD, not the env var

`CLAUDE_CODE_ENTRYPOINT` is **not** a reliable subagent signal. In a vanilla `claude`
CLI a Task-tool subagent's process gets `CLAUDE_CODE_ENTRYPOINT=agent_tool`, but under
cmux (and any wrapper that spawns subagents in-process) the subagent inherits the
parent's exact environment: same `CLAUDE_CODE_ENTRYPOINT=cli`, same
`CLAUDE_CODE_SESSION_ID`, even the same PID. No environment variable distinguishes them.

**The reliable discriminator is the PreToolUse hook PAYLOAD.** Claude Code injects
`agent_id` and `agent_type` into the payload for Task-tool subagents; the top-level
coordinator's payload has neither. So a guard that must run only in the coordinator
should: parse the payload first, treat it as a subagent (allow) if `agent_id` or
`agent_type` is present, and use `entrypoint === "agent_tool"` only as a fallback. A
guard relying on the env var alone blocks subagents too under cmux — which deadlocks any
delegation-based design (nothing left to delegate TO).

### 14.2 PreToolUse hook payload shape (observed)

Common keys: `session_id`, `transcript_path`, `cwd`, `permission_mode`,
`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`. Context-distinguishing
keys: the **coordinator** payload additionally carries `effort` (e.g. `{level:"medium"}`)
and has no agent fields; a **subagent** payload carries `agent_id` + `agent_type`
(e.g. `"general-purpose"`) and no `effort`. `transcript_path` and `session_id` are the
SAME for coordinator and subagent under cmux, so they are not usable discriminators.

### 14.3 `os.freemem()` is the wrong memory metric on macOS/Linux

`os.freemem()` counts only truly-free pages and **excludes reclaimable cache** (inactive
/ speculative / file-backed). On a healthy 64 GB Mac it reads ~2 GB "free" (<4%) while
~24 GB is actually available and memory pressure is green with zero swap. A guard that
blocks on `os.freemem()/os.totalmem() < threshold` therefore false-positives constantly.
Compute REAL available memory per-platform: macOS via `vm_stat`
(`Pages free + inactive + speculative` × the actual page size — **16384 on Apple
Silicon**, not a hardcoded 4096), Linux via `/proc/meminfo` `MemAvailable`,
`os.freemem()` as the Windows/error fallback. The true OOM signal is memory
pressure + swap usage, not free pages.

### 14.4 Two-line statusline architecture (base wrap + phase bar)

A wrapping statusline dispatcher (line 1 = an existing/base statusline, line 2 = a phase
bar) is configured through two GLOBAL files under `~/.anti-hall/`:
- `base-statusline.json` `{ "command": "..." }` — the line-1 command. A **relative**
  command (e.g. `node .claude/helpers/statusline.cjs`) resolves against the per-project
  cwd, so each project shows its own rich helper if present and falls back to the
  plugin's simple renderer otherwise. Overwriting this file changes line 1 for EVERY
  project whose statusLine points at the dispatcher (e.g. a project that set it via
  `settings.local.json`) — do not assume it is project-local.
- `phase-state.json` — read by the phase bar; written by the orchestrator. Must live in
  **`os.homedir()`**, not `os.tmpdir()`: each process can see a different `TMPDIR`
  (the statusline runner's differs from a hook's), so a tmpdir-written state file is
  invisible to the live statusline, whereas homedir is identical for all processes.
- Settings precedence that decides which statusLine actually renders:
  `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`.
- **`statusLine` is read ONLY at session startup — no hot-reload.** Installing the
  statusline into a project mid-session (writing `.claude/settings.json`) shows nothing
  until Claude Code is **restarted in that repo**; an already-running session keeps the
  statusLine it loaded at startup. This is why a freshly-installed project shows no bar
  while a separately-opened project (whose session loaded the dispatcher) shows it fine —
  the global `phase-state.json` is shared, only the per-session load timing differs.

### 14.5 A command-string guard must parse the verb, not scan the whole string

A PreToolUse Bash guard that regex-matches the entire `tool_input.command` will
false-positive on quoted content — e.g. a `git commit -m "...node x.js..."` whose
MESSAGE body mentions a heavy command gets blocked even though the actual verb is
`git commit`. Match against the parsed command verb / pipeline segments, not the raw
string including quoted argument bodies.

---

## Sources

> **Count: 67 unique sources** (≥20 requirement met). Kinds: official (Anthropic + OpenAI), peer-reviewed papers, community.

**Official — Anthropic / Claude Code**
1. [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — official
2. [Plugins reference](https://code.claude.com/docs/en/plugins-reference) — official
3. [Extend Claude with skills](https://code.claude.com/docs/en/skills) — official
4. [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) — official
5. [Output styles](https://code.claude.com/docs/en/output-styles) — official
6. [Customize your status line](https://code.claude.com/docs/en/statusline) — official
7. [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) — official
8. [Orchestrate teams of Claude Code sessions (Agent Teams)](https://code.claude.com/docs/en/agent-teams) — official
9. [Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) — official
10. [Reduce Hallucinations](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations) — official
11. [Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) — official
12. [Claude System Prompts](https://platform.claude.com/docs/en/release-notes/system-prompts) — official
13. [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — official
14. [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — official
15. [Multiagent sessions (Claude API)](https://platform.claude.com/docs/en/managed-agents/multi-agent) — official
16. [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents) — official
17. [Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — official

**Official — OpenAI Codex**
18. [Configuration Reference](https://developers.openai.com/codex/config-reference) — official
19. [Hooks](https://developers.openai.com/codex/hooks) — official
20. [Custom Instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) — official
21. [Subagents](https://developers.openai.com/codex/subagents) — official
22. [Non-interactive mode](https://developers.openai.com/codex/noninteractive) — official
23. [Codex Prompting Guide (Cookbook)](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) — official
24. [Agent Approvals & Security](https://developers.openai.com/codex/agent-approvals-security) — official
25. [Codex Best Practices](https://developers.openai.com/codex/learn/best-practices) — official

**Peer-reviewed papers**
26. [Lost in the Middle (Liu et al., TACL/ACL 2024)](https://aclanthology.org/2024.tacl-1.9/) — paper
27. [Chain-of-Verification (Dhuliawala et al., ACL 2024)](https://aclanthology.org/2024.findings-acl.212/) — paper
28. [Uncertainty Quantification & Confidence Calibration survey (KDD 2025)](https://arxiv.org/html/2503.15850) — paper
29. [How RLHF Amplifies Sycophancy (2025)](https://arxiv.org/pdf/2602.01002) — paper
30. [Deconstructing Instruction-Following: Granular Benchmark (2025)](https://arxiv.org/pdf/2601.18554) — paper
31. [Beyond Trusting Trust: Multi-Model Validation](https://arxiv.org/pdf/2502.16279) — paper
32. [Multi-Agent Code Verification via Information Theory](https://arxiv.org/pdf/2511.16708) — paper
33. [Dual perspective review on LLMs and code verification (Frontiers in CS)](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2025.1655469/full) — paper

**Community**
34. [Claude Code Hooks Complete Reference 2026 (The Prompt Shelf)](https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/) — community
35. [Claude Code Hooks: Production Patterns (Pixelmojo)](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns) — community
36. [Hooks for Guaranteed Context Injection (DEV / Sasha Podles)](https://dev.to/sasha_podles/claude-code-using-hooks-for-guaranteed-context-injection-2jg) — community
37. [Spec-Driven Workflow (DEV / samhath03)](https://dev.to/samhath03/how-i-stopped-claude-code-from-hallucinating-on-day-4-the-spec-driven-workflow-3lim) — community
38. [karanb192/claude-code-hooks](https://github.com/karanb192/claude-code-hooks) — community
39. [luongnv89/claude-howto (hooks README)](https://github.com/luongnv89/claude-howto/blob/main/06-hooks/README.md) — community
40. [Superpowers framework writeup (Marc Nuri)](https://blog.marcnuri.com/superpowers-claude-code-skills-framework) — community
41. [obra/superpowers repo](https://github.com/obra/superpowers) — community
42. [Reverse-Engineering Claude Code system prompts (Medium / Feng Liu)](https://medium.com/@fengliu_367/the-complete-guide-to-writing-agent-system-prompts-lessons-from-reverse-engineering-claude-code-09ecd87c7cc1) — community
43. [MuhammadUsmanGM/claude-code-best-practices](https://github.com/MuhammadUsmanGM/claude-code-best-practices) — community
44. [AI-Assisted Code Review / Verification Pattern (Agentic Patterns)](https://agentic-patterns.com/patterns/ai-assisted-code-review-verification/) — community
45. [Why the Smart Model Reviewer Pattern Is Backwards (Cloudpresser)](https://cloudpresser.com/writing/smart-model-reviewer-is-backwards) — community
46. [Codex Hooks Make the Harness Real (Blake Crosley)](https://blakecrosley.com/blog/codex-hooks-make-the-harness-real) — community
47. [Proposal: PreToolUse/PostToolUse Lifecycle Hooks (GitHub #14882)](https://github.com/openai/codex/issues/14882) — community
48. [What Is Claude Code Agent Teams (MindStudio)](https://www.mindstudio.ai/blog/what-is-claude-code-agent-teams) — community
49. [Parallel Coding Agents oh-my-codex (Particula)](https://particula.tech/blog/parallel-coding-agents-worktree-pattern-oh-my-codex) — community
50. [AI Jailbreak Prompts (Repello AI)](https://repello.ai/blog/understanding-ai-jailbreaking-techniques-and-safeguards-against-prompt-exploits) — community

**Official — Anthropic prompting keynotes & latest Opus (added for §9–§10)**
51. [Prompting 101 | Code w/ Claude 2025 (YouTube)](https://www.youtube.com/watch?v=ysPbXH0LpIE) — Hannah Moran & Christian Ryan, Applied AI
52. [Building with Anthropic's Claude: The Prompt Doctor Is In (YouTube)](https://www.youtube.com/watch?v=hkhDdcM5V94) — Zack Witten workshop
53. [Prompting for Agents | Code w/ Claude (YouTube)](https://www.youtube.com/watch?v=XSZP9GhhuAc) — recommended follow-on
54. [Effective Context Engineering for AI Agents (Anthropic Engineering)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
55. [What's new in the latest Claude Opus (official)](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
56. [Adaptive thinking (official)](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
57. [Effort parameter (official)](https://platform.claude.com/docs/en/build-with-claude/effort)
58. [Mid-conversation system messages (official)](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)

**Official — Anthropic multi-agent swarm (added for §11)**
59. [Dynamic Workflows — code.claude.com](https://code.claude.com/docs/en/workflows) — official
60. [Subagents in the SDK — code.claude.com](https://code.claude.com/docs/en/agent-sdk/subagents) — official
61. [Scaling Managed Agents: Decoupling brain from execution — anthropic.com engineering](https://www.anthropic.com/engineering/managed-agents) — official engineering blog
62. [Multi-Agent Research System — anthropic.com engineering](https://www.anthropic.com/engineering/multi-agent-research-system) — official engineering blog
63. [Introducing Dynamic Workflows in Claude Code — claude.com blog](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) — official
64. [Anthropic Ships the latest Opus + Dynamic Workflows — MarkTechPost](https://www.marktechpost.com/2026/05/28/anthropic-ships-claude-opus-4-8-alongside-dynamic-workflows-and-cheaper-fast-mode-with-workflows-capped-at-1000-subagents/) — community
65. [What the latest Opus Changes for Anyone Running Agents on Claude — Unite.AI](https://www.unite.ai/what-opus-4-8-changes-for-anyone-running-agents-on-claude/) — community
66. [Claude Code Multi-Agent Orchestration — Shipyard blog](https://shipyard.build/blog/claude-code-multi-agent/) — community
67. [The latest Claude Opus hands-on, ultracode, 47-agent attempt — aiwithmo.com](https://www.aiwithmo.com/prompts/claude-opus-4-8-release) — community practitioner test

**Referenced but not standalone-fetched (noted for completeness):** GitHub Codex issues #19385 (PreToolUse `additionalContext` limitation) and #5038 (VS Code extension ignoring `approval_policy: never`) are cited within source #19/#22 findings but were not independently retrieved as full pages.

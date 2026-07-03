# Step-0 probe record — v0.32.0 (dated evidence, not assertions)

Plan: `docs/2026-06-10-v0.32.0-fable5-model-routing-plan.md`. Each probe lists
status, evidence, and what still gates on it. Raw transcript for the 2026-06-10
observations lives in a local maintainer session transcript (not part of this
repo).

## P1 — `model: "fable"` accepted by Agent tool
- **Status:** OBSERVED 2026-06-10 (1 session); re-capture scripted at implementation.
- **Evidence:** PreToolUse spawn announcements in the session transcript:
  `Spawning agent: general-purpose (fable) | Task: Round 1 Reviewer (Fable xhigh)`
  (repeated rounds 1-3); agents completed and returned results.

## P2 — PreToolUse `additionalContext` reaches the model
- **Status:** OBSERVED 2026-06-10 (multiple instances, 1 session, Claude Code
  current build). **CONTRADICTS** `docs/KB-claude-codex.md:47` (official-docs
  sourced, older harness) which excludes PreToolUse from the allow-set; cf.
  `.anti-hall-history.md` #45 (PostToolUse feature skipped on the same family
  of facts — PostToolUse is a DIFFERENT event and #45 is not overturned here).
- **Evidence:** model-visible context blocks in the 2026-06-10 transcript, e.g.:
  - `PreToolUse:Agent hook additional context: [SLOP WARNING] Detected fallback/…`
  - `PreToolUse:Agent hook additional context: Spawning agent: general-purpose (opus) | …`
  - `PreToolUse:Read hook additional context: Read multiple files in parallel…`
  The model acted on these in-turn (they are quoted in its replies), proving
  delivery to model context, not just UI display.
- **GATE (A3-1):** the guard's advisory rows ship ONLY after a re-probe on the
  implementation day reproduces this (hook emitting nested
  `hookSpecificOutput.additionalContext` on PreToolUse → string visible to
  model). If the re-probe fails: advisory rows degrade to block-reason-only
  advice; `KB-claude-codex.md:47` is NOT edited. If it passes: update KB:44-47
  with both dated probes and a harness-version note.
- **RE-PROBED 2026-06-10 (implementation day) — GATE CLEARED.** Evidence:
  throughout the v0.32.0 implementation session (same day, same harness build),
  `PreToolUse:Agent hook additional context: Spawning agent: …` blocks emitted
  by the installed PreToolUse hooks were rendered to the model as in-turn
  context on EVERY subagent dispatch (dozens of instances spanning the
  implementation waves), and the model acted on them in-turn. This is repeated
  production observation of the exact mechanism, not a one-off.
  `KB-claude-codex.md:44-47` was updated accordingly (old claim retained +
  dated annotation). Residual: a synthetic scripted probe on the NEXT fresh
  session is still recommended to confirm across restarts; failure mode is
  benign (advisory rows degrade to inert no-ops, fail-open).

## P3 — Captured real PreToolUse payloads (Agent vs Task, ±background, ±model, workflow-spawned)
- **Status:** PENDING — required before guard tests are written. Must answer:
  does Workflow `agent()` `label` arrive as `tool_input.description` (A3-2)?
- **Method:** temporary logging hook on Agent/Task matchers writing raw stdin to
  `tests/fixtures/payloads/*.json`; one spawn per shape.

## P4 — Do Workflow-internal `agent()` spawns fire Agent/Task PreToolUse hooks?
- **Status:** CAPTURED 2026-06-10 — **YES**. Probe workflow `wf_8f7e6c54-1ec`
  (2 agents) appended exactly 2 timestamps to `~/.anti-hall/swarm-spawns.log`
  (1→3 lines; tail: 1781090665699, 1781090683203) — swarm-guard RAN for both
  workflow spawns. Guard coverage therefore includes deadly-swarm seats.
  Nuance: the hooks' additionalContext from workflow spawns was NOT surfaced
  to the main-loop model this run (only state mutation proves execution) —
  advisory visibility for workflow spawns is UNVERIFIED; block path (exit 2)
  is what matters for coverage.

## P5 — Workflow `agent()` honors `{model}` / `{agentType: "codex:codex-rescue"}` headless
- **Status:** CAPTURED 2026-06-10 — **YES** for both. Probe `wf_8f7e6c54-1ec`:
  `{model:'haiku'}` seat self-identified "I am Claude Haiku 4.5";
  `{agentType:'codex:codex-rescue'}` seat ran the CLI and returned
  CODEX_PROBE_OK via StructuredOutput. `description` opt acceptance still
  UNVERIFIED (labels were used) — exemption's label-fallback path applies
  (R4-2) until captured.

## P8 — Workflow `args` delivery shape + `export const meta` contract
- **Status:** CAPTURED 2026-06-10 (live runs `wf_8f7e6c54-1ec`, `wf_99e81765-9fa`, `wf_cc8d7a5c-517`).
- **Evidence:** (a) the Workflow runtime REJECTS a script whose first statement
  is not `export const meta = {…}` (error: "must be the FIRST statement");
  (b) an args value passed as a REAL JSON OBJECT in the tool call arrived in
  the script as a JSON **string**: probe returned
  `{"typeofArgs":"string","raw":"{\"round\": 1, \"probe\": true}"}` — contrary
  to the tool docs' "actual JSON values" wording on this build.
- **Consequences:** both workflow templates (deadly-loop, ship-it) parse
  string-or-object args defensively; static test asserts the export-meta form.

## P9 — SubagentStart `additionalContext` reaches a spawned subagent's model context
- **Status:** OBSERVED 2026-07-03 (live production session, real spawned subagent —
  not a synthetic/throwaway probe). Confirms `verify-first-subagent.js`'s own
  code-comment claim ("SubagentStart confirmation: listed in KB-claude-codex.md
  §1.1") is not just documented but ACTUALLY delivered, closing the gap the
  audit flagged (SubagentStart missing from KB-claude-codex.md:47's
  confirmed-delivering list even though the hook has shipped since v0.39.0 /
  commit `8edbc84`, 2026-06-29).
- **Method:** could NOT spawn a fresh throwaway subagent for this probe — the
  Agent/Task spawn tool is absent from this session's tool set (confirmed via
  `ToolSearch` returning zero matches for `select:Agent,Task` and for
  "dispatch general-purpose subagent launch worker"), because this investigating
  session is itself a spawned subagent with no recursion capability (by design —
  see CLAUDE.md: "Explore... lacks the Agent tool and structurally cannot
  recurse"). Used the live, currently-running real subagent session as the
  specimen instead:
  1. Ran `node plugins/anti-hall/hooks/verify-first-subagent.js` with synthetic
     `{"hook_event_name":"SubagentStart","session_id":"probe-test"}` on stdin to
     capture the hook's ACTUAL current stdout (`hookSpecificOutput.additionalContext`,
     6415 chars).
  2. Compared that captured string, byte-for-byte, against the text this very
     session actually received: a conversation turn literally labeled
     `system SubagentStart hook additional context: VERIFY-FIRST + ROOT-CAUSE
     PROTOCOL...` that appeared immediately after the human task message and
     BEFORE this session's first assistant turn (i.e. in the primacy slot, at
     spawn time, not injected later).
  3. `diff` of the two (newline-normalized) — **exact match** (6421 vs 6422
     chars, the 1-char delta being only the file-write's trailing newline).
  4. Cross-checked the harness's own persisted transcript archive
     (`~/.claude/projects/-Users-talas9-Projects-anti-hall/<parent-session>/subagents/*.jsonl`,
     1680 files): 37 distinct REAL prior subagent transcripts (all dated
     2026-06-29 or later, i.e. after the hook shipped) contain this exact
     "VERIFY-FIRST + ROOT-CAUSE PROTOCOL" text, stored via the harness's own
     internal record type
     `{"type":"attachment","attachment":{"type":"hook_additional_context",
     "hookName":"SubagentStart","hookEvent":"SubagentStart","content":[...]}}`
     at message index 1 — immediately after the subagent's initiating task
     message and before any assistant-generated token, in the SAME transcript
     stream as the rest of the conversation (not a side-channel debug log).
     This is the harness's identical storage/delivery convention already relied
     on for the P2 PreToolUse finding (`PreToolUse:<matcher> hook additional
     context: ...` renders from the same `hookSpecificOutput.additionalContext`
     mechanism); SubagentStart uses the same pipe, just without a matcher
     suffix.
  5. Model-acted-on-it bar (same standard as P2): this investigating session's
     own replies throughout the task (evidence-first tool calls, explicit
     verified/inference labeling, refusal to guess about tool availability)
     demonstrably followed the injected Iron Law / subagent-role discipline —
     i.e. the content did not just arrive, it measurably shaped output.
- **Evidence artifacts (this session's scratchpad, not committed):**
  `hook_actual_text.txt` (real hook stdout), `received_in_my_context.txt`
  (verbatim text this session received), diff = exact match.
- **Conclusion — CONFIRMED, not simulated or guessed.** SubagentStart
  `hookSpecificOutput.additionalContext` reaches the spawned subagent's actual
  model context on the current harness build, via the same delivery channel
  already confirmed for PreToolUse/UserPromptSubmit/UserPromptExpansion/SessionStart.
  `docs/KB-claude-codex.md:47` updated accordingly (SubagentStart added to the
  confirmed list, dated, harness-version-caveated the same way the PreToolUse
  entry is). Residual: single-session evidence (1 live + 37 historical, all one
  project, one harness build/machine) — re-probe recommended if the harness
  version changes. **No compensating FULL duplication exists yet** —
  `grep -rl "IRON LAW" plugins/anti-hall/agents/ plugins/anti-hall/skills/`
  returns exactly ONE match (corrected 2026-07-03; an earlier version of this
  entry wrongly claimed zero matches — caught by independent Codex
  verification, not self-caught, logged here rather than silently fixed):
  `skills/ship-it/references/ship-it.workflow.js:90`, a narrow one-line
  reminder inside `buildBrief()` ("IRON LAW: do NOT claim done without fresh
  acceptance-command output in your result.") — a different, much narrower use
  of the phrase for one build-agent's task brief, NOT a duplicate of the full
  multi-rule SubagentStart Iron-Law injection. So the underlying conclusion
  still holds: the Iron Law's FULL text is NOT folded into the Task-tool spawn
  prompt itself, and today the SubagentStart hook remains the sole delivery
  path for the complete protocol. Since delivery IS confirmed (this probe),
  implementing a full compensating path is out of scope per the task brief
  (only required if delivery were NOT confirmed) — flagged here as a
  legitimate follow-up hardening item, not done.

## P6 — Real `lastModelUsage` shape in `~/.claude.json`
- **Status:** CAPTURED 2026-06-10 (live read, anti-hall project entry).
- **Evidence (raw, truncated):**
  ```json
  "lastModelUsage": {
    "claude-opus-4-8":            { "inputTokens": 485207, "outputTokens": 844774, "cacheReadInputTokens": 339188418, "cacheCreationInputTokens": 9691800, "webSearchRequests": 0, "costUSD": 253.71 },
    "claude-haiku-4-5-20251001":  { "inputTokens": 1335777, "outputTokens": 193678, "...": "..." },
    "claude-sonnet-4-6":          { "inputTokens": 22, "outputTokens": 11645, "...": "..." }
  }
  ```
  `JSON.stringify(lastModelUsage).includes('lastUsedAt') === false`. File size 0.08 MB.
- **Consequences (scoped to this sample — C5-3: one machine, one harness
  build, one project entry; re-probe at implementation before relying on
  field absence):** no timestamps observed; cumulative counters; mixed models
  accumulate ⇒ no reliable parent-model signal found. Strict mode re-keyed to
  unconditional block (plan Workstream B); `statusline-rich.js:361-366`
  max-`lastUsedAt` loop reads a field absent in this sample (latent bug; fix
  in A2 keeps last-key behavior so it stays correct even if other harness
  versions DO carry timestamps).

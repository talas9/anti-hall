# KB: what makes a hook nudge reach and change the model

Reference only. Written 2026-10-31 from web research plus first-party fetches. Every claim carries a grade. Nothing here is a change to hook code; the implications section lists what the graded findings support. A companion file, `docs/KB-hook-nudge-message-review.md`, scores the shipped messages against this KB.

## Core: what reaches the model, what it respects, how to design nudges (consolidated 2026-10-31)

Grades: [OFF] official Anthropic page fetched by a research lane (the fetch tool summarises pages, so read these as close paraphrase); [OFF-2] official but known only via an issue or search snippet; [MEAS] measured in a study; [ANEC] anecdotal; [LOCAL] our own telemetry; [OPEN] not settled.

### 1. What reaches the model, by event

| Event | Reaches the model | Notes |
|---|---|---|
| SessionStart | stdout or `additionalContext` [OFF] | Most trusted slot (system layer). A compact matcher or PostCompact can re-inject; visibility after a real compaction is [OPEN]. |
| UserPromptSubmit | stdout or `additionalContext`, arriving with the user turn [OFF] | Does not follow a tool result, so it is outside the injection-suspicion slot. Default timeout 30 s [OFF]. |
| PreToolUse | `additionalContext` beside the tool result; `permissionDecisionReason` on a deny [OFF] | Slot right after a tool result is suspect on Sonnet 5.5 and Haiku 5.5 [OFF]. |
| PostToolUse | `additionalContext` beside the tool result; exit-2 stderr [OFF] | Same suspicion. |
| Stop | Only the block reason, after which the turn continues [OFF]. Exit-0 stdout goes to the debug log, stderr is never seen, `systemMessage` is shown to the user only [OFF]. | Whether `additionalContext` reaches the model is [OPEN]: docs say yes, an older first-party observation says no. Cap: 8 consecutive blocks with no tool call between end the turn; override `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` [OFF-2]. `stop_hook_active` reported unreliable when reminders interleave [ANEC]: keep your own counter. |
| SubagentStop | Its block reason becomes the subagent's next instruction [OFF] | To inject into the parent after a subagent returns, use PostToolUse on the Agent tool [OFF]. |
| PreCompact | not found | |

Limits for every event:
- 10,000-character cap per string (`additionalContext`, `systemMessage`, stdout). Longer output goes to a file; the model gets a 2,000-character preview and is never asked to read the file [OFF].
- anti-hall uses one hook command per event, so all checks share one string and one 10k budget per event. A per-string cap does not relieve a merged output.
- Timeout: output discarded. Exit codes other than 0 and 2, and crashes, do not block [OFF]. `onFailure: "block"` is opt-in from v2.1.295 [OFF].
- Parallel hooks: every `additionalContext` is delivered; the most restrictive decision wins [OFF].

### 2. What the model respects and what it discounts

Respects:
- Blocks with an actionable reason [OFF; MEAS 9 of 9 in a small trial]. Emphasis does not rescue an ignored rule: move the rule into a hook [OFF].
- System-layer text over tool-result text [OFF; system cards via secondary sources].
- Rare, factual, explicitly scoped instructions; one brief instruction steers the newer models [OFF].
- Grounding: asking the model to audit each progress claim against a tool result nearly eliminated fabricated status reports [OFF, no number].
- An honest exit ("name the check you did not run") reduces false completion claims [OFF; MEAS on older models].
- Outside feedback from tools and tests beats self-critique, which can make output worse [MEAS].

Discounts:
- Harness text after every tool result, on Sonnet 5.5 and Haiku 5.5: may be treated as injection, ignored, or reported to the user; send less often [OFF]. No such statement exists for Opus (an absence, not a confirmed difference).
- Repeated identical alerts: acceptance falls with repeats; 90% false alarms produce alarm fatigue [MEAS clinical, search-only for repeats].
- Capitals, CRITICAL, MUST over-trigger on Opus 4.5/4.6 [OFF].
- Imperative system-command framing can trip injection defences; the model resists instructions that seem to work against the user. State facts [OFF].
- Many competing instructions: best models about 68% at 500 instructions, earlier instructions favoured, mid-context least used [MEAS].
- Long sessions: compliance decays; compaction summarises injected text; re-injecting after compaction was the second most common practitioner fix [ANEC, 5 sources].
- Non-delivery mistaken for ignoring: many "ignored rule" reports were rules never loaded (staff-reproduced in Cursor). Prove delivery before blaming the model.

Model profiles:
- Sonnet 5.5, Haiku 5.5: injection suspicion; at low effort they report work done without running a check [OFF].
- Opus 5: verifies unprompted (telling it to verify causes over-verification); tends to widen scope, so "do not do X" constraints help [OFF].
- Sonnet 5 and Opus 4.8: literal, do not generalise; state the scope [OFF].
- No Sonnet-versus-Opus rule-adherence numbers exist [NOT FOUND]. The owner's observation fits the direction of the evidence; it is not measured.

### 3. Design rules

1. Hard rule = mechanism: deny, Stop block, TaskCompleted gate, claim gate against a ledger the agent cannot write. Prose is for guidelines.
2. Channel by trust: SessionStart (re-injected at compaction) and UserPromptSubmit carry rules; on Sonnet/Haiku 5.5 nothing important depends on a PreToolUse/PostToolUse advisory; use those events for block reasons.
3. Trigger on state change, not per call: if the agent was already told this state, stay silent; fire again only on change.
4. Escalation ladder, counted outside the model's context:
   - L0: the relevant rule, at most 2 lines, last in the output.
   - L1: specific advisory naming the observed act and the compliant step.
   - L2: change form (e.g. a task-list item with acceptance evidence).
   - L3: block the next action of that class, or the Stop; the reason says how to unblock and offers an honest exit.
   - L4: after N blocks (under the 8 cap) stop blocking and hand to a verifier or human with the evidence.
   - Reset on compliance evidence; escalate only while the violation is still present; irreversible/financial/deletion actions go straight to L3. The effect of the ladder on agents is unmeasured: instrument it.
5. Wording: fact first, then one action, then a one-clause reason; no capitals or intensifiers; at most 2 lines; one instruction per string; explicit scope. Emoji effect untested.
6. Budget: keep each event's combined output well under 10k, ordered by priority; drop whole low-priority notices and replace with one count line; never spill text meant for the model; never require a Read to learn a rule.
7. Per-model profile: for Opus remove the verify nags; for Sonnet/Haiku 5.5 send fewer advisories, use more blocks, put a grounding paragraph in the system layer; consider effort level.
8. Noise kills trust: measure false positives per kind; demote or delete advisories that fire benignly.
9. Measure per message with no shared counters. Funnel: emitted, delivered (not suppressed, spilled, timed out, or Stop exit 0), acted on; split by kind and by model; add deferred-then-delivered and deferred-then-expired.

### 4. Anti-patterns

"Re-check your work" as the verifier or a same-model judge alone; repeating the same text verbatim; loading every rule on every event; letting the agent write its own evidence ledger or hook config; per-subject ids in an alert kind; a model-based hook as the only gate for a hard rule; a Stop block that ignores pending background work (loops); relying on `stop_hook_active` alone.

### 5. Open questions, each with a test

- Does Stop `additionalContext` reach the model? Stop hook emits a nonce only in `additionalContext`, control run puts it in the block reason; ask the model to repeat it (scratch setup).
- Is re-injected text visible after a real compaction? Test compact matcher vs PostCompact.
- Which wording works? A/B one high-volume nudge (fact vs imperative vs with-consequence), acted-on rate per model.
- Does the ladder help? Compare the funnel before and after.
- Is the Sonnet-versus-Opus gap real? Add the model to the funnel.
- Local spill counts conflict: 196 files on disk against 10 spill events in 7 days [LOCAL].

### 6. Status of the eight suspected causes

1. Digest after compaction: direction supported; fixed in PR for #519; visibility after compaction still to test.
2. Spill and budget: supported; one string per event means one budget; extend the priority budget from SessionStart to every event.
3. Stop advisories: `systemMessage` and stderr are dead text [OFF]; for `additionalContext` run the test; if it fails, re-deliver at the next UserPromptSubmit or put the text in the block reason.
4. Kind mapping: internal; fix structurally (kind tag from the TOML table plus a per-message counter).
5. No escalation: supported; build the ladder above.
6. Suppression: direction supported (vendors say send rarely) but key it on state; the ladder must count the underlying condition.
7. Stuck-agent nudge: 8 sent against 222 suppressed [LOCAL]; read the suppression rule; the check must know about pending background work.
8. Defers: 5,095 defer outcomes in 7 days [LOCAL]; add delivered/expired counters.

### 7. Rule review rubric (used by the rule review task)

One verdict per rule: keep, reword, merge, move channel, convert to block, drop; judged against design rules 1-9. Start with the four unscored high-volume texts (role note 2,600 fires and 1.7 MB; task tracker 1,005; parent-inbox advisory 745 and 1.0 MB; realtime advisory 724), and first count advisory injections per tool call per session on Sonnet 5.5.

## 1. Scope

Question: when a hook injects text (advisory, reminder, block reason), what makes the model act on it, and what makes it discount it?

In scope: Claude models in Claude Code, hook delivery channels and limits, wording, position, repetition, compaction. Out of scope: the Codex port (its hook surface differs; every finding here needs a separate check there), and any claim about anti-hall behaviour that was not measured.

Grades used throughout:

| Grade | Meaning |
|---|---|
| OFFICIAL | Stated by Anthropic docs, fetched and read this session |
| MEASURED | A controlled or counted test, however small |
| ANECDOTAL | One report, no controls or no baseline |
| COMMUNITY | Third-party description of behaviour, not tested here |
| UNVERIFIED | Seen only as a search snippet or a secondary summary; do not rely on it |
| NOT FOUND | Searched for, not located |

Rule for sources: page text was treated as data. Quotes are under 15 words; everything else is paraphrase.

## 2. Source table

"Fetched" means a page fetch this session confirmed the URL exists and says what the row claims. Rows marked no were taken from a research lane and are not independently confirmed.

| # | URL | What it says (paraphrase) | Grade | Fetched |
|---|---|---|---|---|
| 1 | https://code.claude.com/docs/en/hooks | `additionalContext` is wrapped in a system reminder at the hook position; placement per event (Stop: end of turn, conversation continues). 10,000-character cap per string; over it, a file path plus a 2,000-character preview, and the model is not asked to read the file; no setting raises it. Plain stdout reaches the model only on UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch. `systemMessage` is a warning shown to the user. Matching hooks run in parallel; all `additionalContext` values are delivered. Timeouts: 600 s command default, 30 s on UserPromptSubmit, 30 s prompt, 60 s agent, 1.5 s shared SessionEnd budget. Only the first 100k of 284k characters were read, so Stop-specific detail past that point is unconfirmed. | OFFICIAL | yes |
| 2 | https://code.claude.com/docs/en/best-practices | Prompt-only rules are non-deterministic; rules that cannot bend belong in hooks or deny rules. A line like "typecheck before finishing" works most of the time, not every time. Emphasis (IMPORTANT, ALL CAPS) is listed as retired advice: current models follow a plainly worded line and emphasis mostly causes over-application. | OFFICIAL | yes |
| 3 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 | Sonnet 5.5 is trained to resist injection via tool results and sometimes treats genuine text placed right after a tool result as injected, tells the user, and ignores it. Per-step harness text can trigger this. An occasional one-turn reminder is far less likely to. If a reminder is ignored, stop after the second or third. A reminder after about five silent steps changed behaviour with no quality change. A verification paragraph at low effort made skipped checks rare. | OFFICIAL | yes |
| 4 | https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages | On Sonnet 5.5 and Haiku 5.5 a system message right after a tool result may be ignored as untrusted. State what changed as context instead of commanding. Turn-scoped messages clear at the next user message so they do not accumulate. Only the first 100k of 113k characters read. | OFFICIAL | yes |
| 5 | https://github.com/anthropics/claude-code/issues/94358 | Output over 10,000 characters is written to a file; the model gets the path and first 2,000 characters with no note that content was withheld. Reproduced on two versions. A payload just under the cap held; a larger one lost rules. Open, no maintainer reply. | ANECDOTAL (single reporter; code path quoted in the issue) | yes |
| 6 | https://github.com/anthropics/claude-code/issues/59583 | Since a 2.1.14x release, Stop and SubagentStop hooks that block 8 times in a row are overridden and the turn ends. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` sets the threshold, 0 disables. Docs were updated per the closing comment. One commenter says the user sees a silent end. | OFFICIAL (quoted from the docs by the issue; the quoted `stop_hook_active` passage was not on the portion of the hooks page read) | yes |
| 7 | https://arxiv.org/abs/2605.10039 | Factorial study, 1,650 Claude Code sessions. File size, instruction position and conflicting adjacent files showed no detectable effect on compliance with a config-file rule. Size has Bayes support for no effect; position does not. Compliance odds dropped about 5.6 percent per generated function within a session (post-hoc). Config files only, not hook output. | MEASURED | yes (abstract) |
| 8 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices | Aggressive emphasis overtriggers on current models; state the reason behind a rule; queries at the end improve long-input quality (up to 30 percent in Anthropic's tests, method not given). | OFFICIAL | no (lane fetched; not re-fetched here) |
| 9 | https://code.claude.com/docs/en/memory | CLAUDE.md is context, not enforcement; under 200 lines is more reliably followed; re-read after `/compact`. | OFFICIAL | no |
| 10 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Context is a finite resource; smallest high-signal set wins; just-in-time loading. | OFFICIAL (summary text) | no |
| 11 | https://dev.to/cdelgado70/hooks-and-the-wrapper-authority-problem-why-your-ai-coding-agent-ignores-them-go6 | Hook output arrives wrapped as a system reminder with less weight than user text; emphatic prefixes changed nothing; a hook that conflicted with the user was flagged as possible injection. One run per case. | ANECDOTAL | no |
| 12 | https://dev.to/yurukusa/your-claudemd-rules-arent-being-enforced-heres-what-actually-works-3aa8 | 39 trials: a CLAUDE.md-only rule was attempted-violated 0 of 22 times in short sessions; a hook that blocked stopped 9 of 9 attempts. Burying the rule changed nothing. Three to four runs per cell. | MEASURED (tiny) | no |
| 13 | https://dev.to/rulestack/6-of-6-prompts-a-claude-code-userpromptsubmit-hook-erased-were-still-in-the-transcript-and-15m2 | Headless lab, 20 runs: 10,000-character output arrived whole; 50,000 became a path plus a roughly 1.9k preview. Exit 0 stdout and additionalContext reached the model; exit 1 output did not. Unknown JSON keys ignored. | MEASURED (tiny) | no |
| 14 | https://github.com/anthropics/claude-code/issues/54360 | Stop hook fired repeatedly with `stop_hook_active` false when other system reminders interleaved; sentinel plus cooldown workaround; model drifted to terse replies. | ANECDOTAL | no |
| 15 | https://github.com/anthropics/claude-code/issues/55754 | A Stop hook returning not-done while background subagents ran looped 100+ times and used the quota. | ANECDOTAL | no |
| 16 | https://github.com/anthropics/claude-code/issues/15174 | A SessionStart hook with the compact matcher ran but its output was not visible to the model after compaction on 2.0.72 to 2.0.76. | ANECDOTAL | no |
| 17 | https://scottspence.com/posts/how-to-make-claude-code-follow-hook-instructions | A hook alone stopped being reliable; hook re-injected each prompt plus a CLAUDE.md line declaring hook text mandatory did better. Author's figures come from an earlier post. | ANECDOTAL | no |
| 18 | https://arxiv.org/abs/2509.21051 | All-instructions-followed rate falls as instruction count rises (older models: 0.95 at 1 to 0.48 at 10 for one Claude 3.5 model). | MEASURED (older models) | no |
| 19 | https://arxiv.org/abs/2307.03172 | Retrieval accuracy is U-shaped in position; middle is worst. 2023-era models; retrieval, not obedience. | MEASURED (indirect) | no |
| 20 | https://arxiv.org/abs/2404.13208 | Training objective ranks system above user above tool output and treats instructions found in tool output as to be ignored. | MEASURED (other model family) | no |

Lane-only claims kept out of the table because only a snippet or a secondary summary was seen: a SessionStart compact-matcher test on one older version, two false-completion papers with detector scores, a prompt-repetition paper, several hook-guide blog posts. They are UNVERIFIED and are not used below.

## 3. What the model respects

| Finding | Grade | Source rows |
|---|---|---|
| A plainly worded, specific, checkable line is followed better than an emphasised one | OFFICIAL | 2, 8 |
| A blocking gate (exit 2 or a block decision) changes behaviour; advisory exit-0 text is frequently skipped | MEASURED (tiny) plus ANECDOTAL | 12, 14, 15 |
| Facts about state ("the budget is now Y") are acted on more readily than commands | OFFICIAL | 4 |
| A reason in one clause helps the model aim its response | OFFICIAL (unmeasured) | 8 |
| A concrete definition of an acceptable check, plus an honest exit ("say which check you did not run and why"), made skipped checks rare at low effort | OFFICIAL (vendor-reported, no percentages) | 3 |
| A low-frequency reminder after a long silent stretch changed behaviour | OFFICIAL (vendor-reported) | 3 |
| Rules in the user-visible slot or in CLAUDE.md survive better than text in a tool-result slot | ANECDOTAL | 11, 17 |
| A visible artifact requirement (checklist) makes skips detectable | ANECDOTAL | uncited lane row, treat as UNVERIFIED |

## 4. What it ignores or discounts

| Finding | Grade | Source rows |
|---|---|---|
| Text right after a tool result on Sonnet 5.5 and Haiku 5.5 may be read as an injection and ignored | OFFICIAL | 3, 4 |
| Harness text added after every tool result raises that risk; frequency is the lever | OFFICIAL | 3 |
| Emphasis (caps, IMPORTANT, MUST) does not add weight and mostly causes over-application | OFFICIAL | 2, 8 |
| Hook text that conflicts with what the user asked can be refused and flagged | ANECDOTAL | 11 |
| Advisory exit-0 text used as a gate | ANECDOTAL | 14 (the reporter retracted the violation count; non-blocking hooks simply advised) |
| Output over 10,000 characters beyond a 2,000-character preview | OFFICIAL (cap) plus MEASURED (tiny) | 1, 13 |
| Exit-1 hook output on context hooks, and JSON objects with unknown keys | MEASURED (tiny) | 13 |
| More competing instructions lowers the chance that all are followed | MEASURED (older models) | 18 |
| Asking the model why it ignored a hook yields no explanation | ANECDOTAL | uncited lane row, UNVERIFIED |

## 5. Delivery channels and limits per hook event

Grades apply to each item. "Tested" means a first-party test exists in this repo's history; the older observation behind the Stop item below was not re-run for this KB.

| Item | Statement | Grade |
|---|---|---|
| additionalContext wrapping | Wrapped in a system reminder at the hook position; reaches the model on the next request; stored in the transcript and replayed on resume | OFFICIAL (row 1) |
| additionalContext placement | SessionStart, SubagentStart: start of conversation. UserPromptSubmit, UserPromptExpansion: alongside the prompt. PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch: next to the tool result. Stop, SubagentStop: end of turn, conversation continues. PostModelSwitch: with the next request | OFFICIAL (row 1) |
| Plain stdout | Becomes context only on UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch; on other events it goes to the debug log | OFFICIAL (row 1) |
| Stop additionalContext | The docs say it is inserted at the end of the turn and the conversation continues so the model can act. An older first-party observation in this repo recorded a silent no-op for it. These conflict. Whether it reaches the model is NOT RESOLVED and must be tested empirically (section 9) | OFFICIAL (docs) vs ANECDOTAL (own observation) |
| Stop block reason | `decision: block` with `reason`, or exit 2 stderr, is fed back and the conversation continues | OFFICIAL (row 1, partly read) |
| systemMessage | A warning message shown to the user; some events deliver or discard it elsewhere. Not documented as model context. Use additionalContext or a block reason for model-facing text | OFFICIAL (row 1) |
| Block reason on PreToolUse | Shown to the model as the tool's error | OFFICIAL (row 1) |
| 10,000-character cap | Applies separately to additionalContext, systemMessage, initialUserMessage and plain stdout; each string measured alone | OFFICIAL (row 1) |
| Overflow behaviour | File path plus up to the first 2,000 characters; the model is not asked to read the file; no env var or setting; the model is not told content was withheld | OFFICIAL (cap, preview, not asked to read) plus ANECDOTAL (no notice) |
| Stop continuation cap | 8 consecutive Stop or SubagentStop blocks, then the turn ends; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides, 0 disables | OFFICIAL (via row 6) |
| stop_hook_active | Guard flag for Stop hooks. Reported as false even on repeat fires when other reminders interleave | COMMUNITY (row 14); docs passage not seen in the portion read |
| Timeouts | Command, http, mcp_tool: 600 s; 30 s on UserPromptSubmit, UserPromptExpansion, PreModelSwitch, PostModelSwitch; 10 s on MessageDisplay; prompt hooks 30 s; agent hooks 60 s; SessionEnd shares 1.5 s | OFFICIAL (row 1) |
| Parallel hooks | Matching hooks run in parallel; at most 12 prompt or agent hooks at once; additionalContext from all hooks for the event is delivered; ordering and contradictory-output behaviour NOT FOUND | OFFICIAL (row 1) |
| Exit codes | Exit 2 is the block code; exit 1 is non-blocking | OFFICIAL (existing KB) plus MEASURED (tiny, row 13) |

## 6. Wording

| Factor | What the sources support | Grade |
|---|---|---|
| Emphasis | Do not use caps or intensifiers. Official guidance says they over-apply; the only wording test found (one run per case) saw no change from emphasis | OFFICIAL, ANECDOTAL |
| Factual vs imperative | Prefer stating the state of the world; commanding text that sounds like an override gets resisted | OFFICIAL (row 4) |
| Reason plus consequence | A reason helps (OFFICIAL, unmeasured). A stated consequence: no source found | OFFICIAL / NOT FOUND |
| Position | Instruction-file position showed no detectable effect (MEASURED, config files). For hooks, position is set by the event, so choose the event. Text right after a tool result is the most injection-suspect slot on current models | MEASURED, OFFICIAL |
| Length | Keep short; Anthropic examples are one sentence. No measured length curve for hook text | OFFICIAL; NOT FOUND (numbers) |
| Count of instructions | More concurrent instructions lowers joint compliance (older models). No Claude 5.x figure | MEASURED (older models) |
| Reminder frequency | Per-step reminders risk being read as injection; a reminder after about five silent steps worked; stop after two or three ignored. No decay curve | OFFICIAL |
| Verifiable exit | Give the model an honest alternative to compliance (say what was not run and why) | OFFICIAL |

## 7. Compaction behaviour

| Finding | Grade |
|---|---|
| CLAUDE.md at the project root is re-read after `/compact`; nested and path-scoped files reload on demand | OFFICIAL (row 9, not re-fetched) |
| Text injected by hooks is stored in the transcript and replayed on resume; after compaction it is summarised with the rest of the conversation. Whether a hook-injected rule survives a summary verbatim: NOT FOUND | OFFICIAL (replay) plus NOT FOUND |
| A SessionStart hook with the compact matcher can re-inject after compaction; one report says it ran but was invisible on early 2.0.x builds | ANECDOTAL (row 16) |
| A PostCompact event exists and accepts additionalContext | OFFICIAL (existing KB) |
| Re-sending only a digest after compaction versus the full rule text: no comparative evidence | NOT FOUND |

## 8. Open questions (NOT FOUND)

- Whether `additionalContext` returned by a Stop hook reaches the model. The docs say yes; one repo observation says no. This must be tested empirically: a Stop hook that emits a unique token in additionalContext only, then ask in the next turn whether the token is visible, with a control hook using a block reason.
- Whether `stop_hook_active` is reliable on current builds (reports predate fixes; status after the last report NOT FOUND).
- Whether the model is told that overflow content was withheld (one issue says no; docs silent).
- Which API channel Claude Code uses for each hook event (tool_result block, system role, user text block). This decides whether the Sonnet 5.5 injection warning applies as written.
- Any measured comparison of: capitals vs plain, reason vs no reason, consequence vs none, numbered steps vs prose, reminder every turn vs once.
- Any measured effect of advisory length on compliance for hook text.
- Any controlled test of compaction versus hook-injected rules.
- Behaviour of contradictory additionalContext from parallel hooks.
- Hacker News and Reddit threads on hook compliance: none surfaced.

## 9. A/B plan for nudges

Pick one nudge whose violation is detectable from the transcript (example: a completion claim with no check run this turn). Hold the trigger, event, and approximate length constant; change only the text. Same model alias, same task set.

| Variant | Wording |
|---|---|
| A control | Current shipped text |
| B plain fact | One sentence stating the state ("No test output was seen since the last edit.") |
| C fact plus reason | B plus one clause on why it matters |
| D fact plus exit | B plus an honest exit ("Run the check, or say which one was not run and why.") |
| E channel | D delivered as a block reason instead of additionalContext (tests the channel, not the words) |
| F frequency | D sent once vs D re-sent on every trigger |

Metrics per variant, at least 30 runs each (a sample-size suggestion, not from a source): violation rate after the nudge; turns to a compliant action; over-application (unneeded tool calls, extra tokens); repeats needed per session. Compare violation rate with a two-proportion test and report over-application beside it so a variant is not rewarded for just doing more.

Separate channel test for the open Stop question: three Stop hooks in a scratch project, one returning a unique token via additionalContext, one via a block reason, one via systemMessage. Record which tokens the model can repeat in the next turn.

Caveat: results transfer only to the model and surface tested. No source read covers hook-injected nudges directly.

## 10. Implications for a nudge system

Derived only from graded findings above.

1. Anything that must hold goes behind a block (exit 2 or a block decision), not an advisory. Basis: rows 2, 12, 14.
2. Use plain words. Remove caps and intensifiers (emoji effect: NOT FOUND, no source tests it). Basis: rows 2, 8.
3. State the observed fact first, then one action. Basis: row 4.
4. Add a short reason; add an honest exit where the model might skip a check. Basis: rows 3, 8.
5. Keep each injected string far under 10,000 characters, and put the most important sentence first, since overflow keeps only 2,000. Basis: rows 1, 5, 13.
6. Do not send the same nudge on every tool result. Rate-limit by state change; stop after two or three ignored sends and escalate to a gate instead. Basis: row 3.
7. Route model-facing text through additionalContext on events where it is documented to land, or through a block reason. Do not use systemMessage for text the model must see. Basis: row 1.
8. Put persistent rules where they survive: root CLAUDE.md, SessionStart, and a compact-matcher or PostCompact re-injection. Basis: rows 1, 9, 16 (the last ANECDOTAL).
9. Every Stop hook that blocks needs its own counter or cooldown and awareness of the 8-block cap. Basis: rows 6, 14, 15.
10. Cut the count of concurrent nudges; merge overlapping ones. Basis: row 18 (older models; direction only).
11. Run the A/B plan before rewriting at scale. No source measures hook-delivered wording.

## Addendum: widened research (round 2)

Rows are summaries from fetched pages only (the fetch tool summarises pages, so read them as close paraphrase). Grades follow section 1. Search-only and unread sources were dropped. The 25-row cap applies to the whole addendum (17 rows from three lanes plus 8 version rows).

### A. Model differences

| # | URL | Finding | Grade |
|---|---|---|---|
| A1 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5 | Sonnet 5.5 is trained to resist indirect injection and may treat text right after a tool result as a possible injection. The trigger is harness text after every tool result; an occasional reminder is far less likely to trigger. | OFFICIAL |
| A2 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5 | Haiku 5.5 carries the same injection-resistance text, skips checks at low or medium effort, and drifts from system-prompt rules under user pressure unless told they hold all conversation. | OFFICIAL |
| A3 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 | Opus 5 verifies its own work unprompted, so explicit verify instructions cause over-verification; it can expand scope, so constrain it explicitly. No injection-suspicion section was found for Opus. | OFFICIAL |
| A4 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5 | A prompt that audits each progress claim against a tool result nearly eliminated fabricated status reports (no number given). | OFFICIAL |
| A5 | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices | Opus 4.5/4.6 can overtrigger on aggressive wording (all-caps MUST or CRITICAL); soften. Newer models are trained for precise instruction following. | OFFICIAL |
| A6 | https://platform.claude.com/docs/en/models/overview | Default effort differs per tier (Opus 5.5 medium, Sonnet 5.5 high, Haiku 5.5 medium, Fable 5.1 high); effort changes verification and stopping behaviour. | OFFICIAL |

No source tests short hook-appended advisories on Sonnet versus Opus; every hook implication from this lane is inference from harness-notice guidance.

### B. Practitioner reports

| # | URL | Finding | Grade |
|---|---|---|---|
| B1 | https://dev.to/yurukusa/your-claudemd-rules-arent-being-enforced-heres-what-actually-works-3aa8 | 39 trials, one task, one forbidden command: no prohibition 17/17 attempted, prohibition in CLAUDE.md 0/22 attempted, hook 9/9 blocked. Short sessions only; the author calls his own headline too strong. | MEASURED |
| B2 | https://forum.cursor.com/t/alwaysapply-true-rules-are-being-completely-ignored-now/158551 | Some "ignored rules" were a loading bug (always-apply rules listed as requestable, not injected), fixed in a later release. Treat "ignored" reports as unverified until the rule is shown in context. | ANECDOTAL (staff-reproduced) |
| B3 | https://dev.to/mikeadolan/i-wrote-500-lines-of-rules-for-claude-code-heres-how-i-made-it-actually-follow-them-3c8 | Longer rule files and bold warnings helped only marginally; session-start, prompt and compaction hooks reduced skipped protocols in the author's own counts, no baseline. | ANECDOTAL |
| B4 | https://github.com/anthropics/claude-code/issues/4017 | Reports that CLAUDE.md is no longer followed after compaction; the cause is a reporter hypothesis, unconfirmed. Workaround: a hook that re-prints it. | ANECDOTAL |
| B5 | https://github.com/anthropics/claude-code/issues/55754 | A Stop hook returning not-ok while a background subagent ran looped about 50 minutes; the hook ignored the stop-active flag. Root cause not confirmed by maintainers. | ANECDOTAL |
| B6 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Context is a finite attention budget; compaction is lossy; keep prompts minimal and add instructions for observed failures. Rot severity varies by model, no numbers. | OFFICIAL |

Contested: whether text rules fail through disobedience or non-delivery, and whether compaction drops CLAUDE.md, are mixed by tool and version. B1 tested only short sessions, so it does not contradict the long-session violation reports. [inference]

### C. Enforcement patterns

| # | URL | Finding | Grade |
|---|---|---|---|
| C1 | https://code.claude.com/docs/en/best-practices | Split rules into deterministic (hooks, deny rules, CI) and non-deterministic (prompts). A line that is still ignored after emphasis belongs in a hook. Consecutive Stop blocks are capped at 8. | OFFICIAL |
| C2 | https://code.claude.com/docs/en/hooks | Stop and SubagentStop block reasons keep the agent working; a TaskCompleted hook can reject task closure. The stop-active semantics were not found in the segments read. | OFFICIAL |
| C3 | https://arxiv.org/abs/2310.01798 | Without external feedback, models struggle to self-correct and sometimes get worse; a "re-check your work" prompt is a weak verifier. | MEASURED |
| C4 | https://arxiv.org/abs/2507.11538 | Instruction following degrades as rule count grows (best models about 68% at 500 instructions, bias toward earlier ones). Fewer rules per injection. | MEASURED |
| C5 | https://arxiv.org/abs/2307.03172 | Information at the start or end of context is used best, the middle worst; re-inject critical rules near the point of action. | MEASURED |

Not found: any controlled study of escalation ladders for LLM agents, so the ladder in the enforcement lane is a hypothesis to instrument, not a result.

### D. Version behaviour (changelog lane)

Source for every row: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (locator is the version). The changelog was read through a summarising extractor and entries carry no dates; verify before quoting externally.

| Version | Behaviour | Grade |
|---|---|---|
| 2.1.9 | PreToolUse hooks can return additionalContext to the model (context injection starts here). | OFFICIAL |
| 2.1.143 | Stop hooks that block repeatedly no longer loop forever (before this, loops could run unbounded). | OFFICIAL |
| 2.1.163 | Stop and SubagentStop hooks can return additionalContext (before this, Stop could only block). | OFFICIAL |
| 2.1.201 | For Sonnet 5, harness reminders no longer use the mid-conversation system role. | OFFICIAL |
| 2.1.292 | system-reminder tags written in hook output are escaped, so hook text cannot forge a reminder. | OFFICIAL |
| 2.1.295 | onFailure "block" added for command and HTTP hooks; a failed or timed-out hook can now block. | OFFICIAL |
| 2.1.311 | Fixed Claude seeing stale memory and CLAUDE.md content right after automatic compaction. | OFFICIAL |
| 2.1.314 | Each hook's output is cut at 10,000 characters. CONFLICTS with the spill-to-file behaviour in section 5 and Core (2.1.89 and 2.1.280 entries say oversized output is saved to a file). Which applies is unverified; the more careful statement is to treat output over 10,000 characters as truncated or spilled, never delivered whole. | OFFICIAL (conflict) |

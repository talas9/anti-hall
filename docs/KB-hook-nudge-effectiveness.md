# KB: what makes a hook nudge reach and change the model

Reference only. Written 2026-10-31 from web research plus first-party fetches. Every claim carries a grade. Nothing here is a change to hook code; the implications section lists what the graded findings support. A companion file, `docs/KB-hook-nudge-message-review.md`, scores the shipped messages against this KB.

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

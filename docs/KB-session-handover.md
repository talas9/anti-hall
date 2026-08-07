# KB — AI-agent session handover

> Reference knowledge base for **how to write a session handover an agent can actually
> resume from**: what belongs in it, what structure survives compaction, and which failure
> modes destroy continuity. Built from 24 sources (7 official Anthropic, 6 community
> practitioner posts, 8 OSS tools, 5 GitHub issue threads, 4 theory/prior-art), plus
> clinical-handoff research. Backs anti-hall's `handover` skill.
> Project/user-agnostic.

## TL;DR

- A handover is **not a memory file**. Reusable project knowledge (build commands,
  conventions, architecture) belongs in `CLAUDE.md` / `AGENTS.md`. A handover is the
  **perishable job state** of one session: goal, current position, next executable step.
  Conflating the two is the single most common mistake.
- **Two tiers beat one file.** A small always-read index (Select-able in full) plus detail
  files paged in on demand — the MemGPT working/archival split, LangChain's Select stage,
  and Claude Code's own `MEMORY.md`-plus-topic-files design all converge here.
- **Fixed schema beats prose.** SBAR's clinical result — a predictable slot order lowers
  receiver cognitive load and unstructured handoffs are a top sentinel-event cause —
  transfers directly. Typed fields (Status enum, Branch, Next-action, Do-not) let the
  reader jump straight to the actionable slot.
- **Write proactively, at a task boundary — not when context is exhausted.** `/compact`
  itself fails at the ceiling (issue #26317), so a handover written "when we run out" may
  never be written at all.
- **Front-load.** Skill/context re-injection truncation keeps the **start** of a file. The
  first 20 lines must carry goal, status, and next action.
- **Raw transcripts are the worst possible format** (Aider's own acknowledged anti-pattern;
  echoed by novaelvaris). Replay is not handover.

## Source catalog

### Official (Anthropic)

| # | Source | Takeaway |
|---|---|---|
| O1 | [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Aim for the smallest set of high-signal tokens. Agents should **write persisted notes outside the context window**. Use hierarchical structure with headers. Compaction is recall-first then precision: keep decisions and unresolved issues, drop redundant tool output. |
| O2 | [Claude Code memory](https://code.claude.com/docs/en/memory) | `MEMORY.md` index is loaded only to **first 200 lines / 25 KB**; topic files are read on demand. `CLAUDE.md` over ~200 lines degrades adherence. Write an entry "when the same mistake happens twice". Concrete beats vague ("2-space indentation", not "format properly"). Timestamp entries so staleness is visible. |
| O3 | [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Include what the agent **cannot guess** (commands, gotchas, architecture decisions); exclude anything derivable from the code. Litmus test: *would removing this cause mistakes?* Self-contained specs name files and interfaces, state what is out of scope, and end with an end-to-end verification step. `/compact <instructions>` is steerable. Names the "kitchen sink session" anti-pattern. |
| O4 | [Context window & compaction](https://code.claude.com/docs/en/context-window) | The compaction summary preserves: requests + intent, key technical concepts, files examined/modified with snippets, errors + fixes, pending tasks, current work — **Anthropic's canonical handover schema**. Project-root `CLAUDE.md` and auto-memory are re-injected after compact; **nested `CLAUDE.md` files are lost**. Skill re-injection caps at 5k/skill, 25k total, and truncation keeps the file **start** → front-load. |
| O5 | [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) | The LeadResearcher saves its plan to memory **before** the 200k truncation risk materializes — proactive, not reactive. Subagents store work externally and pass lightweight references. The handoff document *is* the continuity mechanism across fresh contexts. |
| O6 | [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Pair a human-readable progress log (`claude-progress.txt`) with a structured status file (`feature_list.json`, only the `passes` field mutable) and descriptive git commits. Session-start routine: read notes + git log, run the init script, run a smoke test **before** any new work. Keep a "clean state" mergeable at every boundary. |
| O7 | [Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) | Resuming replays the **full** history — that token cost is precisely why a compact handover document exists. Session forking establishes the precedent of branching from a known-good checkpoint. |

### Community practitioner posts

| # | Source | Takeaway |
|---|---|---|
| C1 | [Nathan Onn — handoff doc skill](https://www.nathanonn.com/claude-code-handoff-doc-skill/) | Five sections: What Happened / Where Things Live / Verification Done (**including what was NOT tested**) / Git State / Open Follow-ups (numbered). Trigger at ~20% context remaining, after finishing the current micro-task. Numbered handoff series. Automation lowers friction: "type one line, skim 30s". Don'ts: narrating every step; including dead-ends without labeling them as dead. |
| C2 | [Mervin Praison — managing handoffs](https://mer.vin/2026/04/managing-handoffs-in-multi-agent-coding-sessions-fresh-context-without-losing-continuity/) | **"Typed state, not prose."** `HANDOFF_YYYY-MM-DD_branch_topic.md` with Status enum, Branch, one-sentence Goal, a single executable Next-action, a Do-not list of failed approaches, and Evidence (validating commands). Durable rules stay in `CLAUDE.md`/`AGENTS.md`. One active handoff per branch+topic; archive stale ones fast; never trust an undated `HANDOFF.md`. |
| C3 | [Artem — never lose your work](https://artemxtech.substack.com/p/never-lose-your-work-between-claude) | Trigger the handoff ~200k tokens in, before the "dumb zone". Run a retrospective **before** the handoff so permanent skills get updated too. Session file carries goals, background, definition of done, and running progress. |
| C4 | [skinnyandbald — smart handoff](https://blog.skinnyandbald.com/never-lose-your-flow-smart-handoff-for-claude-code/) | Two artifacts: a custom `/compact` message (Direction) plus `WORKING.md` (Details). Run at 70–80% context usage. On resume, read direction first, details second. |
| C5 | [novaelvaris — the handoff prompt](https://dev.to/novaelvaris/the-handoff-prompt-transfer-ai-context-between-models-without-losing-state-39a4) | Eight sections: Header / Goal / Current state / Decisions made (with reasoning) / Open questions / Constraints / Next step / Context files (an **ordered read list**). 200–400 tokens typical. "Raw transcripts are the worst possible format." Explicit decisions prevent the next session silently contradicting the last. |
| C6 | [Hermes Agent — handoff checklist](https://hermes-agent.ai/blog/ai-agent-session-handoff-checklist) | Goal + Status / Source of Truth / Files + routes changed / Commands run **and their actual output** / Verification gaps / Assumptions + risks / Next safe action. Reusable memory ≠ job handoff. Never claim done without naming the changed files. |

_Excluded: jdhodges.com (HTTP 403, unverifiable)._

### OSS tools

| # | Tool | Design | Weakness |
|---|---|---|---|
| T1 | [Cline/Roo memory-bank](https://docs.cline.bot/best-practices/memory-bank) | Multi-file hierarchy: `projectbrief` → `productContext`/`techContext` → `activeContext`+`progress` → `systemPatterns`, with an explicit re-read ritual. | No staleness detection, no sequence numbering. |
| T2 | [thenguyenvn90/claude-session-handoff](https://github.com/thenguyenvn90/claude-session-handoff) | Chat-only, 7 fixed sections ending in "Pick up here". Deliberately rejects files as a management burden. | No durability, no index — nothing survives the terminal. |
| T3 | [rohitg00/pro-workflow session-handoff](https://github.com/rohitg00/pro-workflow/blob/main/skills/session-handoff/SKILL.md) | Single `HANDOFF.md`, 10 sections including `file:line` precision, Gotchas, and a literal Resume Command. Guiding rule: "write for the reader". | Single file; no chain across sessions. |
| T4 | [obra/superpowers](https://github.com/obra/superpowers) | The plan file doubles as the handover artifact. | Issue #931 admits the gap: no handoff artifact exists for non-plan sessions. |
| T5 | [GSD get-shit-done](https://github.com/gsd-build/get-shit-done) | Richest layout: `.planning/` with `PROJECT.md`, a `STATE.md` hub, `HANDOFF.json` (machine-readable) beside `STATE.md` (human), per-phase PLAN/SUMMARY pairs, and an active/resolved split for debug notes. | Heavyweight for ordinary sessions. |
| T6 | ruvnet/claude-flow | SQLite `memory.db`, namespaced, with export/import of named sessions. | A database is only warranted when multi-agent swarm consumers read it; overkill otherwise. |
| T7 | Aider chat history | Append-only `.aider.chat.history.md`, replayed verbatim. | **Cautionary anti-pattern** — unbounded, noisy, full resend; acknowledged upstream as poor. |
| T8 | [REMvisual/claude-handoff](https://github.com/REMvisual/claude-handoff) | `HANDOFF_[tag]_[date].md`, 8 sections including What We Tried (chronological, **including abandoned approaches**), Key Decisions (including rejected alternatives), and quantified Evidence & Data. Auto-increments a sequence number and each file names its predecessor — the most rigorous chain-linking found. | No separate index file, so discovery still means listing the directory. |

### Forums / issue threads

> **Caveat:** Reddit was unreachable during research, so no Reddit evidence is represented
> here. Hacker News item 45231217 returned HTTP 429 and was not read. The findings below
> come from GitHub issue threads only.

| # | Thread | Evidence |
|---|---|---|
| F1 | anthropics/claude-code #4517 | `CLAUDE.md` gets summarized away by `/compact`; behavioral rules are silently dropped. Reported example: an agent ran `npx cdk deploy` against an explicit `CLAUDE.md` prohibition post-compact. Workaround: re-read `CLAUDE.md` after every compact. |
| F2 | #10960 | Compaction drops repo/directory-switch state; the agent reverts to the wrong repo and reports a false "no changes". Re-verify `pwd` and `git status` post-compact. |
| F3 | #13112 | Auto-compact "forgot everything", with degraded performance afterwards. |
| F4 | #26317 | `/compact` itself fails with "Conversation too long" once at the ceiling → compact **proactively at task boundaries**, never as a rescue. |
| F5 | #11455 | Feature request for `.claude/handoff.md` via `SessionEnd`/`SessionStart` hooks. The author runs it manually in production and reports it "works exceptionally well": Completed / Pending / Context Notes (decisions + blockers) / Next Steps (numbered), plus a session-history archive directory. |

**Unverified:** "68% of context fill is tool results" (mindstudio.ai, secondhand, no primary
source located) — **flagged unverified; do not cite as fact.**

### Theory / prior art

| # | Source | Takeaway |
|---|---|---|
| P1 | [LangChain — context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents) | Four operations: Write / Select / Compress / Isolate. Distinguishes a **scratchpad** (within-task) from **memory** (cross-session). The index must be small enough to Select in full; details are Selected on demand. |
| P2 | [MemGPT (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560) | Working context (always loaded, small) vs archival memory (paged in explicitly). Validates the index+detail tier split; retrieval is an **explicit agent action**, not ambient. |
| P3 | [SBAR clinical handoff](https://link.springer.com/article/10.1186/s40886-018-0073-1) | A fixed 4-slot order cuts receiver cognitive load; unstructured handoffs are a leading sentinel-event cause. Predictability lets the receiver jump straight to "Recommendation". |
| P4 | Progressive disclosure (practitioner consensus: claude-mem, roundz, mindstudio) | Three layers: metadata index → full content on demand → original source last. Index rows need enough metadata (subsystem and file tags, not just dates) to judge relevance **without opening the file**. |

## Consolidated DOs

| # | Do | Why | Sources |
|---|---|---|---|
| 1 | Write the handover **proactively at a task boundary**, not when context runs out | `/compact` fails at the ceiling; a rescue-time handover may never get written | F4, O5, C1, C3 |
| 2 | Split into an **index + detail files** | Index stays Select-able in full; details page in on demand | O2, P1, P2, P4 |
| 3 | **Front-load** goal, status, next action in the first ~20 lines | Truncation keeps the file **start** | O4 |
| 4 | Use a **fixed slot order / typed fields** (Status enum, Branch, Goal, Next-action) | Predictable order cuts receiver load; typed state parses | P3, C2, T2 |
| 5 | State a **single executable next action** | Removes the "where do I even start" cost | C2, C5, C6, F5 |
| 6 | Record **decisions with their reasoning** | Prevents the next session silently re-deciding the opposite | C5, T8, O1 |
| 7 | Record **what was tried and rejected** (a Do-not list) | Stops rediscovery of dead ends | C2, T8, C1 |
| 8 | Record **verification done AND what was NOT tested** | An unstated gap reads as a passing gate | C1, C6, O3 |
| 9 | Include **commands run and their actual output** | Claimed results are not evidence | C6, O6 |
| 10 | Name **changed files with `file:line` precision** | "Done" without file names is unverifiable | T3, C6, O4 |
| 11 | Capture **git state**: branch, dirty/clean, last commit, unpushed work | Post-compact repo confusion is a documented failure | C1, C2, F2 |
| 12 | Provide an **ordered context-file read list** | Tells the receiver *what to load and in what order* | C5, T1 |
| 13 | **Date and sequence-number** every handover; name its predecessor | Undated handovers are untrustworthy; chains reconstruct history | C2, T8, O2 |
| 14 | Put **durable rules in `CLAUDE.md`/`AGENTS.md`**, perishable state in the handover | Different lifetimes, different files | C2, C6, O3 |
| 15 | Add a **resume-verification checklist** (`pwd`, `git status`, smoke test, re-read `CLAUDE.md`) before new work | Directly counters F1/F2 | O6, F1, F2 |
| 16 | Use **pointers, not payloads** — reference artifacts, don't inline them | Lightweight references are the multi-agent norm | O5, O1 |
| 17 | Keep entries **concrete** ("2-space indentation", not "format properly") | Vague rules aren't followed | O2, O3 |
| 18 | **Archive stale handovers** and keep one active per branch+topic | Ambiguity about which is live defeats the whole mechanism | C2, T5 |
| 19 | Run a **retrospective before the handover** so durable skills/rules get updated too | Otherwise lessons die with the session | C3 |
| 20 | Give index rows **subsystem/file metadata**, not just dates | Relevance must be judgeable without opening the file | P4, O2 |

## Consolidated DON'TS

| # | Don't | Why | Sources |
|---|---|---|---|
| 1 | Dump a **raw transcript** or append-only chat log | Unbounded, noisy, full resend — the acknowledged worst format | T7, C5 |
| 2 | Narrate **every step** taken | Signal drowns; the reader needs state, not a diary | C1, O1 |
| 3 | Include **dead-ends without labeling them dead** | Reads as an open avenue; the next session repeats it | C1, T8 |
| 4 | Include anything **derivable from the code** | Costs tokens, goes stale, adds no information | O3, O1 |
| 5 | Wait for **low context** to start writing | The compact/handover may fail at that point | F4, C3 |
| 6 | Rely on **`CLAUDE.md` surviving a compact** | It gets summarized away; nested files are lost outright | F1, O4 |
| 7 | Trust post-compact **repo/directory state** | Documented reversion to the wrong repo with false "no changes" | F2 |
| 8 | Ship an **undated `HANDOFF.md`** | Unknown age = unusable | C2 |
| 9 | Claim **done without naming changed files** or showing output | Unverifiable completion claim | C6, T3 |
| 10 | Let the handover become a **kitchen-sink session dump** | Named anti-pattern; adherence collapses | O3, O2 |
| 11 | Mix **reusable memory** into the job handover | Different lifetimes; pollutes both | C2, C6 |
| 12 | Keep the index **long** (>200 lines / 25 KB) | Beyond the load cap, the tail is silently unread | O2 |
| 13 | Store state **chat-only** with no file artifact | Nothing survives the terminal | T2 |
| 14 | Reach for a **database** for single-agent handover | Only warranted with multi-agent swarm consumers | T6 |
| 15 | Leave **open questions implicit** | Silent contradiction in the next session | C5 |

## Structural design principles

**Two/three-tier index + detail.** One always-read index file, plus per-topic detail files
opened on demand, plus (optionally) the original artifacts as the last tier. This is the
same shape in four independent places: MemGPT's working/archival split (P2), LangChain's
Select-in-full index (P1), Claude Code's `MEMORY.md`+topic-files design (O2), and the
practitioner progressive-disclosure consensus (P4). The index's job is **routing**, not
content.

**Progressive disclosure.** Layer 1 is a metadata index (title, date, subsystem, files,
status). Layer 2 is the full detail file. Layer 3 is the original source — code, logs, PR.
Each layer is only paid for when the previous one says it's relevant.

**Fixed SBAR-like schema.** Same slots, same order, every time. SBAR's clinical evidence
(P3) is that predictability, not richness, is what cuts receiver load — the receiver learns
where "Recommendation" lives and jumps there. The practical schema, reconciled across O4,
C1, C2, C5, C6 and F5:

| Slot | Content | Type |
|---|---|---|
| Goal | One sentence — what this work is for | prose, 1 line |
| Status | `in-progress` / `blocked` / `ready-for-review` / `done` | enum |
| Branch + git state | branch, clean/dirty, last commit, unpushed | typed |
| Current position | what was just finished, what is mid-flight | prose, short |
| Next action | **one** executable step | imperative, 1 line |
| Decisions made | decision + reasoning + rejected alternatives | list |
| Do-not / tried & rejected | failed approaches, explicitly labeled dead | list |
| Files changed | `path:line` precision | list |
| Verification | commands run + actual output, **and what was NOT tested** | evidence |
| Open questions / risks | unresolved, with assumptions named | list |
| Context read list | ordered files for the next session to load | ordered list |

**Sequence-chaining.** Number handovers and have each name its predecessor (T8). A chain is
reconstructible; a pile of same-named files is not. Combine with dating (C2) so staleness
is visible without opening anything.

**Append-only ledger vs compressed index.** Detail files are append-only — history is
evidence and rewriting it destroys the record. The **index** is compressed and rewritten:
it holds the current state of each thread, not its history. Aider (T7) shows what happens
when the append-only side is the *only* side: unbounded replay. GSD (T5) shows the pairing
done well — machine-readable `HANDOFF.json` beside a human `STATE.md` hub.

**Front-loading.** Skill and context re-injection truncate by keeping the **start** of the
file (O4). Everything load-bearing goes in the first screen: goal, status, next action.
Sources, appendices, and full chronology go last, where losing them costs least.

**Metadata-rich index rows.** A row reading `2026-08-07 — session-a3be — auth refactor` is
not enough to decide whether to open it. Add subsystem and touched-file tags (P4, O2) so
relevance is judgeable from the index alone — that is the entire point of the tier split.

**Resume-verification checklist.** Before any new work in a resumed session: re-read
`CLAUDE.md` (F1), confirm `pwd` and `git status` (F2), run the init script and a smoke test
(O6), then read the handover's ordered context list (C5). The checklist exists because
every item on it corresponds to a documented real failure.

**"What was tried and rejected."** The most under-served section across tools; only T8, C2
and C1 handle it well. Without it the receiving session's most likely first move is the
approach the previous session already disproved.

**Pointers over payloads.** Reference artifacts by path, PR number, or run ID rather than
inlining their content (O5, O1). Inlined payloads bloat the index, go stale silently, and
duplicate a source of truth that already exists.

**Proactive, not reactive.** Write at task boundaries while context is healthy (O5, F4,
C3). A handover written under context pressure is written by the degraded version of the
session it is meant to preserve — and `/compact` may refuse outright at that point (F4).

**Verification honesty.** State what was verified, with the command and its real output,
and state explicitly **what was not tested** (C1, C6). An omitted gap is read as a passed
gate; naming it is the difference between a handover and a claim.

## Failure modes

| Failure | Mechanism | Countermeasure | Source |
|---|---|---|---|
| Behavioral rules silently dropped | `/compact` summarizes `CLAUDE.md` away; nested `CLAUDE.md` files are lost entirely | Re-read `CLAUDE.md` immediately post-compact; keep critical rules in the project-root file (re-injected) and in the handover itself | F1, O4 |
| Wrong-repo / wrong-directory state | Compaction drops directory-switch state; agent reverts and reports a false "no changes" | Record branch + `pwd` in the handover; re-verify `pwd` and `git status` before trusting anything | F2 |
| Compaction amnesia | Auto-compact drops working state; measurable performance degradation after | Persist state to files *before* the compact, not during | F3, O1 |
| `/compact` refuses at the ceiling | "Conversation too long" — the rescue mechanism itself needs headroom | Compact and hand over **proactively at task boundaries** | F4 |
| Raw-transcript handover | Unbounded append-only log replayed verbatim; noise crowds out signal, cost grows without bound | Structured, compressed, fixed-schema handover; never replay | T7, C5 |
| Undated / ambiguous active handover | Multiple `HANDOFF.md` files with no dates or sequence; unclear which is live | Date + sequence-number + predecessor link; one active per branch+topic; archive the rest | C2, T8 |
| False completion | "Done" with no file list and no command output | Require changed files with `path:line` and real command output before any done claim | C6, T3 |
| Handover/memory conflation | Perishable job state written into durable memory files (and vice versa) | Durable rules → `CLAUDE.md`/`AGENTS.md`; session state → handover | C2, C6 |
| Silent index truncation | Index exceeds the 200-line / 25 KB load cap; the tail is never read | Keep the index short and front-loaded; push detail into linked files | O2, O4 |

## How anti-hall's handover skill applies this

The skill lives at `plugins/anti-hall/skills/handover/` and writes to a dated,
session-scoped directory:

```
.anti-hall/handovers/INDEX.md                      # global, compressed, metadata-rich
.anti-hall/handovers/<YYYY-MM-DD>/<session-id>/
    HANDOVER.md                                    # per-session index — the fixed schema
    <detail>.md                                    # append-only detail files, opened on demand
```

Mapping to the principles above:

| Principle | Implementation |
|---|---|
| Index + detail tiers | Global `INDEX.md` → per-session `HANDOVER.md` → detail files |
| Metadata-rich rows | `INDEX.md` rows carry date, session id, subsystem, status, touched files |
| Fixed schema | `HANDOVER.md` uses the 11-slot table above, in that order, every time |
| Front-loading | Goal / Status / Next action are the first three slots |
| Sequence-chaining | Date + session-id directory naming; each `HANDOVER.md` names its predecessor |
| Append-only vs compressed | Detail files append; `INDEX.md` and `HANDOVER.md` are rewritten to current state |
| Pointers over payloads | Detail files and repo artifacts referenced by path, never inlined into the index |
| Proactive writing | Written at task boundaries, not at context exhaustion |
| Resume verification | `HANDOVER.md` ends with the checklist: re-read `CLAUDE.md`, `pwd`, `git status`, smoke test |
| Verification honesty | A required "Verified / NOT tested" slot; an empty NOT-tested field must be explicit, not blank |
| Handover ≠ memory | Durable project rules stay in `CLAUDE.md`; the handover carries only perishable session state |

This mirrors the existing `.anti-hall/progress/` and `.anti-hall/history/` layouts, so the
three artifacts share one navigation model: read the `INDEX.md` first, open only what the
index says is relevant.

## Sources

**Official** — O1 [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · O2 [memory](https://code.claude.com/docs/en/memory) · O3 [best practices](https://code.claude.com/docs/en/best-practices) · O4 [context window](https://code.claude.com/docs/en/context-window) · O5 [multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) · O6 [long-running harnesses](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) · O7 [Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)

**Community** — C1 [nathanonn.com](https://www.nathanonn.com/claude-code-handoff-doc-skill/) · C2 [mer.vin](https://mer.vin/2026/04/managing-handoffs-in-multi-agent-coding-sessions-fresh-context-without-losing-continuity/) · C3 [artemxtech](https://artemxtech.substack.com/p/never-lose-your-work-between-claude) · C4 [skinnyandbald](https://blog.skinnyandbald.com/never-lose-your-flow-smart-handoff-for-claude-code/) · C5 [dev.to/novaelvaris](https://dev.to/novaelvaris/the-handoff-prompt-transfer-ai-context-between-models-without-losing-state-39a4) · C6 [hermes-agent.ai](https://hermes-agent.ai/blog/ai-agent-session-handoff-checklist)

**OSS tools** — T1 [Cline memory-bank](https://docs.cline.bot/best-practices/memory-bank) · T2 [claude-session-handoff](https://github.com/thenguyenvn90/claude-session-handoff) · T3 [pro-workflow](https://github.com/rohitg00/pro-workflow/blob/main/skills/session-handoff/SKILL.md) · T4 [superpowers](https://github.com/obra/superpowers) · T5 [get-shit-done](https://github.com/gsd-build/get-shit-done) · T6 ruvnet/claude-flow · T7 Aider chat history · T8 [REMvisual/claude-handoff](https://github.com/REMvisual/claude-handoff)

**Forums** — F1 #4517 · F2 #10960 · F3 #13112 · F4 #26317 · F5 #11455 (all anthropics/claude-code). Reddit unreachable during research; HN 45231217 not read (HTTP 429).

**Theory** — P1 [LangChain context engineering](https://www.langchain.com/blog/context-engineering-for-agents) · P2 [MemGPT, arXiv 2310.08560](https://arxiv.org/abs/2310.08560) · P3 [SBAR handoff research](https://link.springer.com/article/10.1186/s40886-018-0073-1) · P4 progressive disclosure (practitioner consensus)

_One claim in the research pool — "68% of context fill is tool results" — could not be
traced to a primary source and is excluded from every recommendation above._

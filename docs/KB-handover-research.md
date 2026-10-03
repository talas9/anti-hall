# KB — Session handover research (2026-09-24)

> Research pass behind anti-hall's handover safety net, token-ceiling trigger and content
> rules. Companion to [KB-session-handover.md](KB-session-handover.md) (the original KB,
> cited below as "KB-session-handover"). Every claim carries a source tag:
> **[official]** = vendor documentation or vendor engineering blog, **[community]** =
> practitioner post / OSS / issue thread, **[paper]** = peer-reviewed or arXiv preprint,
> **[clinical]** = medical handoff literature. Claims that could not be sourced were left
> out. All URLs accessed 2026-09-24. Project/user-agnostic.

---

## 1. Principles (each with the source that establishes it)

| # | Principle | Evidence | Source |
|---|---|---|---|
| P1 | **Compaction is lossy by design; the handover is the durable record.** Claude Code's compaction "clears older tool outputs first, then summarizes"; "detailed instructions from early in the conversation may be lost." | Vendor statement | [official] Claude Code, *How Claude Code works → When context fills up* — https://code.claude.com/docs/en/how-claude-code-works |
| P2 | **User-issued session constraints are the single most-lost class of content under compaction.** Across multi-turn chat, agentic trajectories and long-horizon research, "current compactors retain only 17% of injected constraints on average"; a side-constraint-aware extractor run beside the compactor reached >90%. | Measured | [paper] Wang, Zhang, Lee, Yang, *Lost in Compaction* (arXiv 2608.11242, 31 Jul 2026) — https://arxiv.org/abs/2608.11242 |
| P3 | **Repeated compaction compounds loss ("compaction cliff").** "Claude Code's /compact prompt on Sonnet 4.6 preserves 53% of safety rules after one compaction round and 10% after five." | Measured | [paper] Zerhoudi, Mitrovic, Granitzer, *The Compaction Cliff* (arXiv 2608.22752, 24 Aug 2026) — https://arxiv.org/abs/2608.22752 |
| P4 | **Never compact a compaction; derive every summary from original evidence.** CliffCompaction "keeps compacted information faithful by only truncating or dropping content, never rephrasing" and "never compact[s] a compaction — each pass operates only on original content." | Design + benchmark (Terminal-Bench, KernelBench) | [paper] Nguyen, Cho, Chen, Dettmers, *CliffCompaction* (arXiv 2609.26779, 22 Sep 2026) — https://arxiv.org/abs/2609.26779 |
| P5 | **Quality degrades with context length even before the limit.** 18 frontier models "exhibit this behavior at every input length increment tested"; a single distractor lowers accuracy; low needle–question similarity degrades faster. | Measured | [community, research lab] Chroma, *Context Rot* (14 Jul 2025) — https://www.trychroma.com/research/context-rot |
| P6 | **Multi-turn drift is a reliability problem, not an aptitude problem.** Average 39% drop across six tasks multi-turn vs single-turn; "when LLMs take a wrong turn in a conversation, they get lost and do not recover." | 200k+ simulated conversations | [paper] Laban et al., *LLMs Get Lost in Multi-Turn Conversation* (arXiv 2505.06120) — https://arxiv.org/abs/2505.06120 |
| P7 | **Positional bias:** recall is best at the start and end of the context and worst in the middle. Front-load the load-bearing lines of any injected file. | Measured | [paper] Liu et al., *Lost in the Middle* (arXiv 2307.03172) — https://arxiv.org/abs/2307.03172 |
| P8 | **Structured, fixed-slot handoffs reduce errors in high-stakes human handovers.** I-PASS (Illness severity / Patient summary / Action list / Situation awareness & contingency / **Synthesis by receiver**): medical errors 24.5 → 18.8 per 100 admissions (−23%), preventable adverse events 4.7 → 3.3 (−30%), 10,740 admissions, 9 hospitals. | Prospective multi-site study | [clinical] Starmer et al., NEJM 2014, doi:10.1056/NEJMsa1405556 — https://pubmed.ncbi.nlm.nih.gov/25372088/ (abstract; full text paywalled/403 today) |
| P9 | **Receiver read-back is part of the handoff, not an optional extra.** On-call guidance: "Have the incoming engineer summarize back before the outgoing engineer signs off"; write a shift report "even [for] quiet [shifts]"; give "specific URLs, not 'check Datadog'". | Practitioner guidance | [community] incident.io, *On-call best practices* (27 Feb 2026) — https://incident.io/blog/on-call-best-practices-guide-2026 |
| P10 | **The vendor's own long-running-agent recipe is: progress file + structured feature list + descriptive commits, and a session-start routine that reads notes and git log, runs init, then a smoke test *before* new work.** | Vendor engineering | [official] Anthropic, *Effective harnesses for long-running agents* (26 Nov 2025) — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| P11 | **Amp's model: keep threads short; "the longer your conversation goes on, the higher the chances are the model goes 'off the rails'"; a second model extracts a handoff into a fresh thread.** | Vendor doc | [official, Sourcegraph] Amp, *Context management* — https://ampcode.com/guides/context-management |

---

## 2. What to capture / what to omit

### Capture (each item has a source that motivates it)

| Slot | Why | Source |
|---|---|---|
| Goal + definition of done (1–2 lines) | Front-loaded, positional bias | P7; [community] softaworks agent-toolkit session-handoff README (10-section schema) — https://github.com/softaworks/agent-toolkit/blob/main/skills/session-handoff/README.md |
| **Single next executable action** | I-PASS "Action list"; softaworks "begin with the first Immediate Next Steps item" | P8; softaworks |
| **Session constraints the user issued** ("do not X until Y", scope limits, ordering rules) | Exactly the class compaction loses (17% retention); Nathan Onn's real failure: a "serial agent execution" rule vanished on compact → ten simultaneous subagents | P2; [community] N. Onn, *Never let Claude Code auto-compact* (1 May 2026) — https://www.nathanonn.com/claude-code-never-auto-compact/ |
| Git state: branch, HEAD, dirty/clean, unpushed; `pwd` | Post-compact wrong-repo / false "no changes" failure | [community] anthropics/claude-code #10960 (cited in KB-session-handover F2; not re-fetched) |
| Done + evidence (`file:line`, command, real output) | Verification honesty | P10 (smoke-test-before-work); incident.io "specific URLs" |
| **NOT verified / gaps, explicit** | An omitted gap reads as a passed gate | [community] hermes-agent / nathanonn (KB-session-handover C1, C6) |
| Decisions + rejected alternatives; tried-and-abandoned | Prevents silent re-deciding; I-PASS "contingency plans" | P8; softaworks "decisions made with rationale", "gotchas" |
| Ordered context read list (pointers, not payloads) | Progressive disclosure; keep the injected index short | [official] Claude Code memory: MEMORY.md loads first 200 lines / 25 KB only — https://code.claude.com/docs/en/context-window (interactive page states the cap) |
| Running background items (agents, monitors, workflows) with re-attach instructions | I-PASS "situation awareness"; on-call "silenced alerts … when it expires" | P8, P9 |
| Date, sequence number, predecessor link | Staleness must be judgeable without opening | [community] REMvisual/claude-handoff, mer.vin (KB-session-handover T8, C2) |

### Omit

| Don't | Why | Source |
|---|---|---|
| Raw transcript / chat replay | Unbounded, noisy; the harness already keeps the JSONL | [official] Claude Code writes every message to `~/.claude/projects/*.jsonl` — https://code.claude.com/docs/en/how-claude-code-works ; KB-session-handover T7 |
| Anything derivable from code or `git log` | Costs tokens, goes stale | P10 (git log is read at session start anyway) |
| Durable rules (build cmds, conventions) | Belong in CLAUDE.md / AGENTS.md, which are re-injected after compaction; the handover is not | [official] *What survives compaction* table: project-root CLAUDE.md, auto memory, plan file → "Re-injected from disk" — https://code.claude.com/docs/en/context-window |
| `[TODO]` placeholders, empty required sections, secrets | softaworks validation rejects these | softaworks README |
| Rephrased/paraphrased evidence | Rewriting is where drift enters | P4 |

---

## 3. Format and length

- **Fixed slot order every time** (SBAR/I-PASS lesson): the receiver learns where the action lives. [P8]
- **Front-load**: Claude Code's post-compaction re-injection of invoked skills is "capped at 5,000 tokens per skill and 25,000 tokens total; oldest dropped first … Truncation keeps the start of the file." Same rule applies to any file you expect to be re-injected. [official] https://code.claude.com/docs/en/context-window
- **Index ≤ 200 lines / 25 KB** (the MEMORY.md load cap is the only vendor-published number for an always-loaded index). [official] same page
- **Pointers over payloads**: Claude Code re-reads "up to five of the files … modified most recently" after compaction, and "a file over 5,000 tokens comes back as a path reference." [official] same page
- Typical size reported by practitioners: 200–400 tokens for the core (KB-session-handover C5); softaworks uses 10 sections; I-PASS uses 5. Keep the *always-read* part at one screen.

---

## 4. Timing triggers

### Vendor facts (Claude Code) [official] — https://code.claude.com/docs/en/model-config

- Default: "Claude Code compacts when the conversation reaches the model's context limit," except: Sonnet 4.6 / Opus 4.6 without extended context compact "at the 200K boundary"; native-1M models (Sonnet 5, Fable, Opus 4.7+) "compact before the window fills, at about 967K tokens by default."
- Configurable earlier: `/autocompact 500k` (persists to `autoCompactWindow`), `--autocompact` flag, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env (takes precedence). Accepted range 100K–1M.
- Thrashing guard: "If a single file or tool output is so large that context refills immediately after each summary, Claude Code stops auto-compacting after a few attempts and shows an error." — https://code.claude.com/docs/en/how-claude-code-works
- Live % is available to a statusline script: `context_window.used_percentage` = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` over `context_window_size` (200000 or 1000000); "may be `null` early in the session" and `current_usage` is `null` again "after `/compact` until the next API call." [official] https://code.claude.com/docs/en/statusline

### Vendor facts (Codex CLI) [official] — https://learn.chatgpt.com/docs/cli?surface=cli (developers.openai.com/codex/cli now 308-redirects here)

- Shows "% context left" in the TUI; `/compact` "removing older turns while preserving task continuity"; "Automatic compaction triggers when context approaches limits"; `codex resume` / `codex resume --last`; `/status`.
- AGENTS.md is rebuilt "on every run (and at the start of each TUI session)"; combined size capped by `project_doc_max_bytes` (default 32 KiB). [official] https://learn.chatgpt.com/docs/agent-configuration/agents-md
- [community] Codex compaction internals: `model_auto_compact_token_limit`, `model_context_window`, `compact_prompt`, `tool_output_token_limit`; effective limit = min(user limit, 90% of window); after compaction only the summary + ≤20k tokens of recent user messages survive. — D. Vaughan, *Codex CLI context compaction architecture* (31 Mar 2026, updated 24 Sep 2026) https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/ ; corroborated by M. Zechner's cross-tool gist (Codex 95% "effective_context_window_percent"; Claude Code ~95% at the time, Dec 2025) https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f
- [community] openai/codex #46186 (17 Sep 2026, open): AGENTS.md rules "applied inconsistently after compaction … continuation summary carrying an incorrect interpretation"; proposes verbatim re-injection once per compaction. https://github.com/openai/codex/issues/46186 — same failure class as P2/P3.

### Practitioner trigger points [community]

| Source | Trigger |
|---|---|
| N. Onn (1 May 2026) | Yellow 30–50% watch; orange 50–60% finish micro-task then compact; red >60% mandatory reset before new features; "at a boundary, not at panic" |
| softaworks agent-toolkit | Proactive at >80% context, at milestones, or after 5+ file edits |
| skinnyandbald (KB-session-handover C4) | 70–80% |
| nathanonn handoff skill (KB-session-handover C1) | ~20% remaining, after finishing the current micro-task |
| anthropics/claude-code #28728 (25 Feb 2026, closed duplicate) | Reports the failure chain: overshoot → hard limit → manual `/compact` fails "conversation is too long" → only `/clear` left. https://github.com/anthropics/claude-code/issues/28728 |

**Synthesis:** trigger on *task boundary* first and *percentage* second; pick the percentage
so that the handover is written by a still-healthy context (P5/P6) and with enough headroom
that `/compact` cannot fail (#28728). On a 1M window, 85% = 850K tokens, far past where
P5 shows measurable degradation — an absolute-token ceiling is the safer second trigger.

### Hook surface (Claude Code) [official] — https://code.claude.com/docs/en/hooks

- `PreCompact`: matchers `manual` (`/compact`) | `auto` (auto-compact window reached); input adds `trigger` and `custom_instructions` (what the user passed to `/compact`, `null` otherwise). **It CAN block compaction**: exit code 2, or JSON `"decision": "block"`; blocking an auto-compact that was recovering from a context-limit error makes the request fail. Its `systemMessage`/`continue` fields are discarded. A timed-out command hook's output is discarded (no decision). — https://code.claude.com/docs/en/hooks ("PreCompact", "Timeouts", fetched 2026-09-24)
- `PostCompact`: same matchers; input adds `trigger` and `compact_summary`; no decision control. [official] same page
- `Stop`: besides `decision: "block"` + `reason`, accepts `hookSpecificOutput.additionalContext` as non-error feedback that continues the conversation; both go through the `stop_hook_active` input and an 8-consecutive-continuation cap. [official] same page, "Stop decision control"
- `SessionStart`: matchers `startup` | `resume` | `clear` | `compact` | `fork`; stdout is added to context; **the documented pattern for re-injecting context after compaction** — https://code.claude.com/docs/en/hooks-guide#re-inject-context-after-compaction
- `SessionEnd`: matchers `clear` | `resume` | `logout` | `prompt_input_exit` | `other`; shared **1.5 s budget** (raised to your per-hook timeout, max 60 s).
- Request for a `PreCompact` that lets *Claude* act (write a state file) — anthropics/claude-code #43733 (5 Apr 2026) — **closed, not planned**. So a PreCompact hook can only do mechanical work, never make the model write a handover. https://github.com/anthropics/claude-code/issues/43733
- `/compact <focus>` and a "Compact Instructions" section in CLAUDE.md steer the summary. [official] https://code.claude.com/docs/en/how-claude-code-works
- `/rewind` → "Summarize from here / up to here" compacts part of the conversation. [official] https://code.claude.com/docs/en/context-window

---

## 5. Verification on resume

1. Re-read project-root CLAUDE.md/AGENTS.md — official docs say only the project-root file is re-injected; path-scoped rules and nested CLAUDE.md are summarized away. [official] https://code.claude.com/docs/en/context-window
2. `pwd`, `git status`, `git log -1`, compare to the handover's recorded HEAD. [P10; #10960 via KB-session-handover]
3. Run the repo's smoke test before new work. [P10]
4. **Receiver synthesis**: restate goal / next action / active constraints in your own words before acting (I-PASS "S"; incident.io read-back). [P8, P9]
5. Rebuild the task list from the handover snapshot, not from the compact summary. [P1]
6. Record that the checklist ran (timestamp + what was observed) — an unrecorded check is indistinguishable from a skipped one. [P9 "write a shift report even for quiet ones"]

---

## 6. Failure modes

| Failure | Mechanism | Evidence |
|---|---|---|
| Constraint loss | Compactor drops "do not…" rules | P2 (17% retained), P3 (53%→10%), codex #46186, Onn's ten-subagent incident |
| Handover written too late | Overshoot past auto-compact → `/compact` fails → `/clear` only | #28728 |
| Handover written *from* a compacted context | Summary-of-summary drift | P3, P4 |
| Wrong repo / dir after compaction | Directory-switch state lost | #10960 (KB-session-handover) |
| Error detail flattened | "Error messages with stack traces get reduced to 'there was an error'" | [community] M. Dolan (6 Apr 2026) https://dev.to/mikeadolan/claude-code-compaction-kept-destroying-my-work-i-built-hooks-that-fixed-it-2dgp |
| Thrash loop | Single oversized output refills context after each summary | [official] how-claude-code-works |
| Mid-turn compaction | Codex compacts pre-turn *and* mid-turn during tool chains; Claude Code auto-compacts at the limit regardless of turn boundary | Vaughan (Codex); model-config (Claude) |

---

## 7. Anti-patterns

- Trusting the compact summary as the continuation record (P1, P2, P3).
- Writing the handover as a narrative diary or transcript (KB-session-handover C1/T7; softaworks validation).
- Paraphrasing earlier evidence into the new handover instead of copying it with its source (P4).
- Waiting for a percentage alarm instead of a task boundary (Onn; #28728).
- Percent-only trigger on a 1M window (P5: degradation is length-driven, not limit-driven).
- Handover that names no changed files / no command output (KB-session-handover C6, T3).
- No read-back on resume (P8, P9).

---

## 8. Tool-specific tips

### Claude Code
- Put "Compact Instructions" in CLAUDE.md naming your handover path so even the *automatic* summary points at it. [official] how-claude-code-works
- Use `SessionStart` matcher `compact` to inject the handover pointer (documented pattern). [official] hooks-guide
- Use `PreCompact` (auto|manual) for a **mechanical** pre-compaction snapshot — git state, cwd, task snapshot parsed from the transcript, last user constraints — because the model cannot be made to act there (#43733 closed). [official] hooks
- Lower the auto-compact window with `/autocompact <tokens>` rather than relying on the default (model limit / ~967K on 1M). [official] model-config
- `/context` shows live usage; statusline `context_window.used_percentage` is the exact figure hooks cannot otherwise see. [official] statusline
- `--resume`/`--continue` replay the same session id; `--fork-session`/`/branch` copy history to a new id (use for "known-good checkpoint" branching). [official] how-claude-code-works
- Claude Code re-reads up to 5 recently modified files after compaction — keep the handover file *recently modified* so it is one of them (a side benefit of writing it last). [official] context-window

### Codex CLI
- Watch the TUI "% context left"; `/compact` supports focus instructions (v0.117.0+ per Vaughan). [official cli page; community for the version]
- Only ≤20k tokens of recent *user* messages survive compaction — assistant reasoning and tool results do not; the handover file must carry them. [community, Vaughan/Zechner]
- Keep AGENTS.md under `project_doc_max_bytes` (32 KiB default) — it is the only auto-re-injected instruction source. [official agents-md]
- Session rollouts record `token_count` with `model_context_window` — an exact reading a hook can parse (verified in anti-hall's `context-pct.js` header, see review).
- `codex resume --last` for same-session continuation. [official]
- **Codex hook events (official, https://learn.chatgpt.com/docs/hooks, fetched 2026-09-24):** `SessionStart` matcher values `startup` | `resume` | `clear` | `compact`; "After Codex compacts a root session, `SessionStart` hooks that match `source: "compact"` run before the next model request. This also applies when automatic compaction happens in the middle of a turn." `PreCompact`/`PostCompact` take `trigger` (`manual`|`auto`) and `turn_id`; plain stdout is ignored; JSON `continue: false` stops before (Pre) / after (Post) compacting. `Stop` carries `stop_hook_active` and `last_assistant_message`; `decision: "block"` makes Codex continue with `reason` as a new prompt. `transcript_path` "isn't a stable interface".
- **Codex slash commands (official, https://learn.chatgpt.com/docs/developer-commands?surface=cli):** `/compact` (summarize the visible chat; no focus argument documented there), `/new` (new chat in the same CLI session), `/clear` (clear the terminal and start a fresh chat), `/resume`, `/skills`.

### Other agents (for parity thinking)
- Cursor: automatic summarization at the context limit + `/summarize` on demand (changelog 1.6, 12 Sep 2025). [official] https://cursor.com/changelog/1-6
- Gemini CLI: `/resume save <name>` / `/resume list`, `gemini --resume`; sessions persist prompts, tool I/O, token stats, thoughts. [official] https://geminicli.com/docs/cli/session-management/
- Amp: manual handoff via a second model that extracts files + facts into a new thread; no auto-compaction. [official] ampcode.com

---

## 9. Gap review → what anti-hall shipped (v0.108.0)

The review compared anti-hall's handover system to the principles above. Status after this
release:

| # | Gap | Source | Status |
|---|---|---|---|
| G1 | No `PreCompact` hook: nothing mechanical saved if auto-compact fires before the next prompt | §4 hooks [official]; #43733 | **Shipped** `precompact-snapshot.js` (Claude + Codex): `PRECOMPACT-<n>.md` with git state, task snapshot, last 10 user messages verbatim, newest-handover pointer; never blocks |
| G2 | Fire directive rode `UserPromptSubmit` only | #28728; Codex mid-turn compaction | **Shipped** once-only Stop-side fire (shared latch, `stop_hook_active` guarded) |
| G3 | Percent-only trigger (85% of 1M = 850K) | P5, P6 | **Shipped, then corrected (v0.108.2)**: `autoHandover.pct` is measured against this session's ACTUAL context window (not a fixed 200K assumption), so 85% already scales correctly to 1M+ windows — a fixed `autoHandover.maxTokens` ceiling defaulted to 170000 would instead fire an unrelated, far-too-early handover on a genuinely large window. `maxTokens` now defaults to `0` (off) and is opt-in only, for a user who wants an absolute floor regardless of window size |
| G4 | No slot for user-issued session constraints | P2 | **Shipped** slot 2a "Session rules (verbatim)" |
| G5 | Seq-N handovers could re-summarize a compacted context | P3, P4 | **Shipped** carry-forward rule (copy verbatim with evidence) |
| G6 | No receiver read-back | P8, P9 | **Shipped** read-back step (skill + resume step 5) |
| G7 | Resume injection had no freshness facts | P10 | **Shipped** HEAD / commits since handover / dirty count |
| G8 | Directive text was Claude-only on Codex | dual-platform parity | **Shipped** platform-aware text |
| G9 | No `/compact <focus>` bridge | §8 [official] | **Shipped** exact `/compact focus:` line + CLAUDE.md "Compact Instructions" snippet |
| G10 | No error-evidence slot | Dolan | Open |
| G11 | Codex compact-source unverified | §4 Codex | **Resolved**: documented officially (see §8 Codex) |
| G12 | `SessionEnd` unused for handover | §4 | Open |

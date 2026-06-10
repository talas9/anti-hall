# KB.md — Canonical Knowledge Base for anti-hall

> **Source of truth for developing and maintaining the anti-hall plugin.**
> This is the map. The deep research lives in the section docs linked below; this
> file is the authoritative index, the *current-plugin ground truth*, and the
> *staleness ledger* that sits over all of them. When code and a doc disagree,
> **code wins** — and the disagreement gets logged in [§4 Staleness ledger](#4-staleness-ledger).

---

## 0. How to use this KB

**What it's for.** Anti-hall is a verify-first / anti-hallucination Claude Code
plugin. This KB is the dev-facing knowledge layer the plugin is built and
maintained from: the prompting/hook/orchestration research it encodes, the design
rationale behind each mechanism, and the current ground-truth state of the
shipped plugin.

**How it's organized.**

| Layer | What it holds | Where |
|---|---|---|
| **Index + ground truth** | This file. Current plugin facts, navigation, freshness + staleness ledgers. | `KB.md` (you are here) |
| **Living reference docs** | Deep, citation-backed research. Still authoritative for their topic. | [§2](#2-living-reference-docs) |
| **Folded-in source docs** | Research that has been distilled into the living KB synthesis; kept for provenance. | [§2](#2-living-reference-docs) (marked *folded*) |
| **Historical artifacts** | Dated audits, reviews, and one-time plans. Frozen records — never edited to match current code. | [§5 History](#5-history--historical-artifacts) |

**How to keep it fresh (the rule):**

1. **On any significant change** (new hook, renamed file, version bump, changed
   nudge/footprint/count, new skill), update [§1 Current plugin ground truth](#1-current-plugin-ground-truth)
   in the SAME change. The CHANGELOG is the authority for *what changed*; this
   KB mirrors the *current resting state*.
2. **Cite date + ref for every new entry.** Use the date already in the source
   (CHANGELOG entry, commit, source doc header). **Never invent a date** — if
   unknown, write `(date unknown)`.
3. **Never silently rewrite a fact you can't verify.** Flag it in
   [§4 Staleness ledger](#4-staleness-ledger) with `doc:line` and the reason.
4. **Code is the tiebreaker.** Any prose claim about plugin behavior must be
   checkable against a file in `plugins/anti-hall/`. If it isn't, it's an
   aspiration, not a fact — label it.

**This file is the source of truth for plugin-development decisions.** Design
debates reference the living docs for evidence; the *current* state and the
*open discrepancies* are settled here.

---

## 1. Current plugin ground truth

> Verified against the working tree on **2026-06-04** (commit context: post
> `0.24.1`; `0.22.0` shipped api-guard (mechanical API-hallucination guard) + the
> eval harness, `0.22.1`/`0.22.2` Windows-CI fixes, `0.23.0` api-guard v2 (opt-in
> 3rd-party after a deadly-loop proved default-on = edit-time RCE), `0.24.0`
> extended git-guard to block AI self-credit in gh pr/issue/release bodies, `0.25.0`
> added the always-on SCOPE & FIDELITY discipline + the opt-in mcp-reaper companion
> (macOS + Linux), `0.26.0` made rule G's structured-return discipline concrete +
> S4-measured (~5× smaller than verbose prose, lossless), `0.27.0` replaced
> feature-launch with the lean `ship-it` workflow (plan-mode + Workflow-swarm +
> deadly-loop, scaled S/M/L) and added the deadly-loop D1.5 verification gate
> (fresh-evidence + vacuous-test guard) — all in
> ground truth). This block is the canonical snapshot — update it on every
> significant change. Ref: `plugins/anti-hall/.claude-plugin/plugin.json`,
> `plugins/anti-hall/hooks/`, `plugins/anti-hall/skills/`, `CHANGELOG.md`.

| Fact | Value | Source / verify |
|---|---|---|
| **Version** | `0.32.0` | `plugin.json` `version` — the single authority. Marketplace entry carries NO `version` (avoids the silent-precedence trap). |
| **Runtime** | Pure Node, built-ins only; requires Node.js ≥ 18 on PATH | `plugin.json` description; hooks launched as `node <hook>.js` |
| **Hook language** | All hooks are `.js` (NOT `.sh`) | `ls plugins/anti-hall/hooks/` |
| **Hooks shipped (23 files)** | `agent-watchdog`, `api-guard`, `command-guard`, `doctor`, `git-guard`, `graphify-guard`, `graphify-reminder`, `graphify-session`, `merge-gate`, `model-routing-guard`, `omc-detect`, `phase-tracker`, `ship-it-guard`, `skip-guard`, `speculation-guard`, `speculation-judge`, `swarm-guard`, `task-guard`, `task-tracker`, `tasklist-guard`, `verify-first-full`, `verify-first`, plus `hooks.json`. `model-routing-guard` (0.32.0) = PreToolUse Agent/Task, anti-waste routing: classifies spawn descriptions (mechanical vs complex) and blocks/advises toward the cheapest fitting model; default advisory, strict opt-in (`ANTIHALL_MODEL_ROUTING=strict` via project-scoped env — global-export blast radius: blocks omitted-model mechanical spawns in every project; remedy: explicit cheap model or unset strict). `omc-detect` (0.32.0) = shared helper (not a hook), exported `isOmcLoopActive()`: detects whether an oh-my-claudecode autonomous loop is active and fresh; consumed by `task-guard` + `tasklist-guard` to defer Stop-blocks to advisory when an OMC loop is running. `merge-gate` (0.31.0) = OPT-IN PreToolUse Bash, **default OFF**; only when `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on} does it block (exit 2) an auto-merge intent (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop) when the recent **assistant** transcript tail (bounded 128 KB) carries an UNRESOLVED self-hedge ("pending review"/"first-pass"/"do not merge"/"needs your eyes"/…) — i.e. mechanizes the checkable part of the v0.30.0 "false done" failure (hedged then merged anyway). A hedge is RESOLVED (merge allowed) when a resolution token follows it ("owner signed off"/"fidelity verified"/"verified against"/"resolved:"/…). HONEST limits: keyword-heuristic, bypassable (alt merge syntax/heredoc/UI/API), fail-open on every error, cannot hard-loop (PreToolUse single-shot, no state). A backstop, NOT a guarantee. `api-guard` (0.22.0) = PreToolUse Write/Edit/MultiEdit, blocks fabricated stdlib/builtin APIs in code (verified against installed python3/node); bench `eval/api-guard-bench.js`. `ship-it-guard` (0.28.0) = OPT-IN PreToolUse Write/Edit/MultiEdit, **default OFF**; only when `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on} does it block (exit 2) a CODE edit on a hard-risk path (migration/auth/.github-workflows/security) when no `PLAN.md` exists (repo root or `.planning/PLAN.md`). HONEST limits: enforces artifact-EXISTENCE only (not plan quality), bypassable via Bash heredoc, conservative (never gates ordinary edits), fail-open. `task-guard` (0.29.0) = Stop hook that now detects **IDLE NEGLECT**: it classifies open tasks into ACTIONABLE-NOW (status `pending` + unowned/main-owned + no OPEN `blockedBy`) and checks `~/.anti-hall/agents/*.json` for a FRESH (<~20 min `ts`/mtime) heartbeat; if ≥1 actionable-now task AND no agents running, it blocks with a SHARP, task-naming reason demanding parallel dispatch — otherwise (agents in flight, or only blocked/owned/in_progress tasks) it falls back to the gentler generic nudge. Loop-safe: idle-neglect dedupes on (actionable-set + "no-agents"), absolute `MAX_BLOCKS=5` cap across both modes → cannot hard-loop; fail-open. `task-tracker` (0.29.0) = UserPromptSubmit hook providing the **per-turn complement** to that Stop block: on EVERY prompt it reconstructs tasks (now capturing `owner`/`blockedBy`; status-only `TaskUpdate` doesn't clear them), applies the SAME `classifyOpen` (pending + unowned/main-owned + no OPEN `blockedBy`) and the SAME `~/.anti-hall/agents/*.json` fresh-heartbeat check; when ≥1 actionable-now task AND no agents running it injects a SPECIFIC "TASK REVIEW (every turn): N … dispatch a background agent for EACH now, in parallel … : &lt;up to 4 names&gt;" line into `additionalContext` (subjects control-char-stripped + `JSON.stringify`'d = inert), else the existing generic discipline + open-tasks freshness note. Bounded (256 KB tail) + fail-open. | `plugins/anti-hall/hooks/` |
| **Skills shipped (7)** | `root-cause`, `orchestration`, `ship-it`, `deadly-loop`, `deadly-loop-multi`, `doctor`, `install-statusline` (+ shared `MODEL-POLICY.md`) | `plugins/anti-hall/skills/` |
| **Cadence — full protocol** | Injected at **SessionStart** via `verify-first-full.js` — includes the always-on **SCOPE & FIDELITY** discipline (0.25.0: simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked / drop nothing), named in the "ALWAYS APPLY" disciplines list alongside root-cause/orchestration/anti-sycophancy. Orchestration (0.25.0) also requires the coordinator to **independently verify delegated work** — a subagent's "done/passing" is an unverified claim re-checked against ground truth before marking complete (rule L), and now **defaults delegated heavy/parallel work to the background** (the coordinator passes `run_in_background` so the user needn't background it manually) while still verifying each on completion — never fire-and-forget (rule F). SessionStart **re-fires after compaction** with `source="compact"`, so the same no-matcher entry covers the post-compact reset. **There is no `PreCompact` hook** (its `additionalContext` would be inert — see KB-claude-codex §1.2). | `hooks/hooks.json`, `hooks/verify-first-full.js` |
| **Message-bloat prevention (#45, 0.25.0; rule G concretized 0.26.0)** | Rule G is **SYNTHESIZE, NEVER RELAY**: the coordinator never pastes a subagent's raw return into the user thread (verbatim relay = the **#1 cause of message-context bloat**); subagents return tight summaries under an **OUTPUT BUDGET**. For a **SUBSTANTIAL** return (review/audit/research dump, many claims) rule G now specifies a concrete structured shape — `{claim, evidence:"file:line", verdict, blockers/uncertainty, next}` — which an **S4 study measured ~5× smaller than verbose prose with zero decision-relevant loss** (claim/evidence/uncertainty/blockers/next rubric, N=8, directional). The **prose-for-tiny caveat is kept**: a single prose line wins for a SMALL result (schema only ~1.4× denser there, and JSON overhead can make tiny outputs LARGER). **Reconciliation:** the earlier ~1.43× pilot figure measured *small, already-summarized* content; the ~5× figure is for *verbose* returns — both hold, different inputs. To **enforce** rather than request, pass a **schema to the Agent/Task tool** (validated structured return); the biggest levers remain the output budget + no-raw-relay rule, the schema is the multiplier on large returns. Shipped as prompt discipline (rule G text + nudge #57), not a schema-enforcement system. A `PostToolUse`-on-`Task` size-flag hook was evaluated and is **NOT feasible**: per KB-claude-codex §1.4 `PostToolUse` stdout/`additionalContext` never reaches the model and it cannot block — no hook was faked. | `hooks/verify-first-full.js` (rule G), `hooks/verify-first.js` |
| **Cadence — per-turn nudge** | `verify-first.js` on **UserPromptSubmit** emits ONE short nudge, deterministically chosen by SHA-1 of the stdin envelope `mod NUDGES.length`. | `hooks/verify-first.js` |
| **Nudge count** | **18** rotating one-liners (0.25.0 added 2 scope-fidelity + verify-delegated-work + background-default + synthesize-never-relay nudges; 0.30.0 added the done-bar/AGREED-acceptance-criteria nudge — DONE = verified against agreed acceptance, un-mechanically-verifiable fidelity = PENDING OWNER REVIEW, self-issued hedge hard-blocks 'done' + auto-merge; NOT "5") | `NUDGES` array in `verify-first.js` (`% NUDGES.length`) |
| **SessionStart injection footprint** | **~7474 B** of `additionalContext` (trimmed from 8074 B in `0.18.0`, prose-only, zero rule loss). Distinct from the `verify-first-full.js` file size (~11.4 KB incl. comments). | CHANGELOG `0.18.0` |
| **AGENTS.md mirror** | Present at repo root (Codex/clone-based governance). NOT bundled by `/plugin install`. | `AGENTS.md` |
| **Model policy** | Cross-model debate TRIO: Reviewer = latest flagship Claude (`model:"fable"`); Auditor = latest Opus (`model:"opus"`, divergent regression/coupling lens); Critic = latest OpenAI Codex at max reasoning (Opus adversarial-persona fallback). **"Latest" is resolved at runtime** — spawn paths use ONLY tier tokens (`fable`/`opus`/`sonnet`/`haiku`; Codex = latest the installed CLI reports). No versioned/dated model IDs in executable spawn snippets. API call sites are the sole exception (the API has no evergreen tier alias; `claude-haiku-4-5` is the alias-form for its tier). | `skills/MODEL-POLICY.md` (duplicated to `skills/deadly-loop/references/MODEL-POLICY.md`, byte-identical; **2 copies**, not 3 — symlinks stripped on install) |
| **Model tier tokens resolve latest-at-call-time** | `model:"fable"` / `"opus"` / `"sonnet"` / `"haiku"` in Agent/Task tool and Workflow `agent()` resolve to the newest available build at call time — they are NOT pinned version IDs. Consequence: spawn snippets in docs/skills MUST use tier tokens only; a versioned ID (e.g. `claude-opus-4-8`) in a snippet would pin a snapshot and age. Verified live 2026-06-10 (step0-probe-record.md P1: `model:"fable"` accepted, spawned `general-purpose (fable)`). | `tests/fixtures/step0-probe-record.md` P1 |
| **`lastModelUsage` has NO timestamps** | The live `~/.claude.json` `lastModelUsage` field carries cumulative token/cost counters per model key — NO `lastUsedAt` / timestamp fields. Observed sample: `{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD}` only. `JSON.stringify(lastModelUsage).includes('lastUsedAt') === false` verified 2026-06-10. Consequence: no reliable parent-model signal exists in hook stdin; strict mode is unconditional (not heuristic). The `statusline-rich.js` max-`lastUsedAt` loop reads a phantom field (ts always 0, masked by last-key fall-through) — latent bug fixed in 0.32.0 to last-key explicitly. | `tests/fixtures/step0-probe-record.md` P6 |
| **PreToolUse `additionalContext` observed reaching model** | 2026-06-10 (multiple instances, current build): `hookSpecificOutput.additionalContext` emitted by a PreToolUse hook appeared as model-visible context blocks (`PreToolUse:Agent hook additional context: …`) and was acted on by the model. This CONTRADICTS `docs/KB-claude-codex.md:47` (official-docs sourced, older harness claim that only UserPromptSubmit/UserPromptExpansion/SessionStart deliver context). Both dated probes retained — see KB-claude-codex.md:44-47 annotation. The advisory rows in `model-routing-guard` rely on this channel; on a harness that does not deliver it, advisories are inert no-ops (fail-open, nothing breaks). | `tests/fixtures/step0-probe-record.md` P2; gate A3-1 |
| **Test net** | Zero-dependency `node:test` E2E suite (black-box, process-level), **459 passing (+2 platform-skipped), 461 total** — guards, api-guard (stdlib/builtin/3rd-party + shadowing/portability/RCE-no-execute), git-guard gh-PR self-credit, speculation, tasklist-guard (+ history-ledger reminder), task-guard **idle-neglect** (actionable-now + no-agents → sharp block; agents-running/blocked/owned → generic; dedupe + cap), scope-fidelity + verify-delegated-work + background-default + synthesize-never-relay protocol/nudge regression, etc. | `tests/`, [`E2E-TESTING.md`](./E2E-TESTING.md), CHANGELOG |
| **Companion (opt-in)** | `companion/mcp-reaper.js` (+ `install-reaper.js`) — NOT a hook; an interval job (macOS LaunchAgent / Linux `systemd --user` timer) that kills ONLY orphaned MCP-server processes (parent already died). Safety invariant: reaps only when the command matches a generic MCP signature AND the parent is a reaper/init (launchd / init / `systemd --user`), so a live MCP (live spawner parent) can never be killed. **Windows = documented no-op** (no parent-death reparenting + PID recycling → external orphan detection unsafe; correct fix is Job Objects spawner-side). Recognizes Python MCPs too (`uvx`/`uv` + underscore `mcp_server_*` forms). **Limitation:** an MCP run as a LaunchAgent / `systemd --user` unit / OS service shares init as a parent (like a leaked orphan) and can be reaped — exclude it via `ANTIHALL_REAPER_EXCLUDE='name|name'`. Install: `node companion/install-reaper.js` (`--uninstall`). Env: `MCP_REAP_DRYRUN=1`, `MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`. | `plugins/anti-hall/companion/` |

**Why these matter:** the historical docs ([PLUGIN-REVIEW.md](./PLUGIN-REVIEW.md),
[ULTRAPLAN.md](./ULTRAPLAN.md)) describe the plugin *before* the cadence redesign —
they reference `.sh` hooks, "5 nudges", a missing `PreCompact`, and a missing
`AGENTS.md`. All of those were resolved on the way to `0.19.0`. Read those docs as
*history*, not as current spec (see [§5](#5-history--historical-artifacts)).

---

## 2. Living reference docs

These hold the deep, citation-backed knowledge. Topic, date, status, and the
authoritative reference are below. *Folded* means the content is also distilled
into the `KB-claude-codex.md` synthesis (kept standalone for provenance + depth).

| Doc | Topic | ~Size | Status | Date | Primary ref |
|---|---|---|---|---|---|
| [`KB-claude-codex.md`](./KB-claude-codex.md) | **Backbone synthesis** — hooks, plugins, prompting, Codex, orchestration, anti-hallucination evidence (§1–§14) | 672 ln | **Living — primary** | (compiled 2026-05) | 8 parallel research streams; cited inline + Sources §15 |
| [`TASK-WORK.md`](./TASK-WORK.md) | Task discipline (`TaskCreate`/`TaskUpdate` vs legacy `TodoWrite`); event-driven, no-timer freshness; basis for the tasklist-guard feature | 241 ln | **Living** | (date unknown; references Claude Code v2.1.142 / SDK 0.3.142) | Anthropic long-running-agent guidance + hook model; Sources at doc end |
| [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md) | **Usage guide** for the `tasklist-guard` Stop hook + per-turn freshness note: when it blocks, the `.anti-hall-progress.md` file, the `.anti-hall-history.md` fix-ledger reminder (append each completed task with Cause/Fix/Verified), env knobs, escape hatch, good workflow | — | **Living** | 2026-06-02 | this repo (`tasklist-guard.js` / `task-tracker.js`); design in `TASK-WORK.md` |
| [`E2E-TESTING.md`](./E2E-TESTING.md) | How the zero-dep `node:test` hook suite works; I/O contract per event; env-isolation gotcha | 129 ln | **Living** | 2026-06-02 (mtime) | [Claude Code hooks contract](https://code.claude.com/docs/en/hooks) |
| [`opus-4-8-features.md`](./opus-4-8-features.md) | Latest-Opus feature reference (context window, effort param, thinking, pricing) | 299 ln | **Living — snapshot** | Released 2026-05-28; research 2026-05-29 | [platform.claude.com whats-new-claude-4-8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8) |
| [`opus-4-8-swarm.md`](./opus-4-8-swarm.md) | Multi-agent orchestration on the latest Opus; Dynamic Workflows (research preview), Managed Agents (beta) | 319 ln | **Living — snapshot** | 2026-05-29 | Official release notes + community (cited inline) |
| [`gsd-distilled.md`](./gsd-distilled.md) | GSD phase model distilled; the lightweight phase loop ship-it borrows from | 270 ln | **Living — folded** (KB-claude-codex §12) | Research 2026-05-29 | `.gsd/*`, gsd-*-phase SKILLs (cited in header) |
| [`superpowers-planning.md`](./superpowers-planning.md) | Distillation of 7 superpowers skills; Iron-Law + rationalization-table pattern; minimal plan-first loop | 234 ln | **Living — folded** (KB-claude-codex §13) | (date unknown) | superpowers skill set (read-only study) |
| [`keynote-prompting-claude.md`](./keynote-prompting-claude.md) | Distilled notes from two Anthropic prompting talks (Prompting 101 + Prompting for Agents) | 267 ln | **Living — folded** (KB-claude-codex §9) | Captured 2026-05-29; talks dated 2025-05-22 | [youtube ysPbXH0LpIE](https://www.youtube.com/watch?v=ysPbXH0LpIE) |
| [`keynote-transcript.md`](./keynote-transcript.md) | Best-available reconstruction of the Prompting 101 talk (no verbatim transcript exists — explicitly flagged) | 342 ln | **Living — reference** | Talk 2025-05-22 (published 2025-07-31) | DEV recap + youtubesummary + sinyblog (cited) |
| [`CONTEXT-PRESERVATION-KB.md`](./CONTEXT-PRESERVATION-KB.md) | **Consolidated research KB** on slowing main-agent context growth — caching, sub-agent isolation, compaction, pruning, JIT retrieval, memory externalization (12 technique families) | ~640 ln | **Living — research** | Swarm-synthesized 2026-06-02 | 130 selected sources (123 read) across Anthropic/OpenAI/Google docs + arXiv + practitioner sources |
| [`KB-fable-5.md`](./KB-fable-5.md) | Fable 5 knowledge base — identity, pricing, context window, features, tier-token routing | 158 ln | **Living — snapshot** | Compiled 2026-06-10 | 14 sources (researcher agent draft; spot-checked) |
| [`2026-06-10-v0.32.0-fable5-model-routing-plan.md`](./2026-06-10-v0.32.0-fable5-model-routing-plan.md) | v0.32.0 design plan — Fable 5 support, model-routing guard, TRIO roster update, deadly-swarm-converged | 482 ln | **Historical — design plan** | 2026-06-10 | This repo (`main@86fb79a` baseline) |

**Reading order for a new contributor:** `KB.md` → `KB-claude-codex.md` (the
synthesis) → the topic doc you need. The `keynote-*` and `superpowers`/`gsd`
docs are background; their actionable content is already in the synthesis.

---

## 3. Topic → doc map (where each subject lives)

| If you're working on… | Read |
|---|---|
| A new or changed **hook** (event taxonomy, blocking vs injection, `additionalContext` gating) | KB-claude-codex §1; current state in [§1](#1-current-plugin-ground-truth) |
| **plugin.json / marketplace / version** precedence | KB-claude-codex §2; [§1](#1-current-plugin-ground-truth) version row |
| **Prompting** the protocol text / nudges | KB-claude-codex §3, §6, §9; keynote-prompting-claude; superpowers-planning (Iron-Law form) |
| **Codex / AGENTS.md** governance | KB-claude-codex §5; `AGENTS.md` at root |
| **Orchestration / swarm / subagents** | KB-claude-codex §7, §11; opus-4-8-swarm |
| **Slowing main-agent context growth** (caching, sub-agent isolation, compaction, pruning, JIT retrieval, memory externalization) | [`CONTEXT-PRESERVATION-KB.md`](./CONTEXT-PRESERVATION-KB.md) — consolidated research KB |
| **deadly-loop / ship-it** phase model + debate roster | KB-claude-codex §12, §13; gsd-distilled; superpowers-planning; `skills/MODEL-POLICY.md` |
| **Task discipline** (tasklist-guard) | TASKLIST-GUARD (usage); TASK-WORK (design/research) |
| **Testing** the hooks | E2E-TESTING |
| **Model selection / effort / thinking** | opus-4-8-features; opus-4-8-swarm; `skills/MODEL-POLICY.md` |
| Anti-hallucination **evidence base** (peer-reviewed) | KB-claude-codex §8 + "Design implications" |

---

## 4. Staleness ledger

> Suspected-stale or code-contradicting claims found in the **living** docs, flagged
> for review. Per the freshness rule, these are **flagged, not silently rewritten** —
> a maintainer should verify and either fix the source doc or confirm it's fine.
> Format: `doc:line — claim — why suspect — current truth`.

**Living docs — open flags:**

- `opus-4-8-features.md:5` — Header pins `Model ID: claude-opus-4-8`. **Why
  suspect:** a hardcoded model ID dates fast and can read as policy. **Status:**
  *acceptable as a dated snapshot* — the doc header carries `Released: 2026-05-28`
  and `Research date: 2026-05-29`, and `MODEL-POLICY.md` resolves "latest" at
  runtime, so policy is NOT pinned. Keep as a snapshot; do not cite this ID as
  the model to use.
- `opus-4-8-swarm.md:5` — "Opus 4.8 was the latest at time of writing … always
  use the newest available." **Why noted:** correctly framed already — left as a
  model for how snapshots should self-date. No action.
- `TASK-WORK.md` (Overview) — "Task tools became the default in Claude Code
  v2.1.142 / TS Agent SDK 0.3.142." **Why suspect:** a pinned client version that
  may have moved. **Status:** unverified against current Claude Code; treat the
  version numbers as historical, the *behavior* (Task tools default, set
  `CLAUDE_CODE_ENABLE_TASKS=0` to fall back) as current. Verify before quoting the
  exact version.
- `KB-claude-codex.md:22` — "official docs … enumerate ~28–32 events; community
  says 27+." **Why noted:** the doc *already* flags this as version-dependent and
  declines to pin it. No action — this is the correct handling of a moving count.
- `KB-claude-codex.md:211` — "Empirically (librarian v0.6.0) 7 rounds caught 30+
  bugs." **Why noted:** references an external project by name/version as
  provenance for the deadly-loop origin. The claim is anecdotal-but-cited; keep,
  but it is not a plugin fact.
- `keynote-transcript.md:1` — "No verbatim transcript is publicly available …
  close reconstruction, not verbatim." **Why noted:** the doc self-flags as
  reconstruction. Correct handling; no action — do not treat its quotes as exact.

**Historical docs — pre-redesign claims (do NOT fix; they are frozen records):**
These describe the plugin *before* the cadence redesign and are intentionally
stale. Listed here so no one mistakes them for current spec.

- `PLUGIN-REVIEW.md:14,29,57,90,113` etc. — references `hooks/verify-first.sh`,
  `git-guard.sh`, `graphify-session.sh`. **Current:** all hooks are `.js`.
- `PLUGIN-REVIEW.md:22–25` — "No PreCompact re-injection … add a PreCompact
  hook." **Current:** resolved differently — SessionStart re-fires on `compact`;
  no PreCompact hook (and the review's own §1.2 in KB shows PreCompact
  `additionalContext` is inert).
- `PLUGIN-REVIEW.md:34` — "No AGENTS.md mirror → plugin is Claude-only."
  **Current:** `AGENTS.md` exists at repo root.
- `PLUGIN-REVIEW.md:46` — "ships five strong skills." **Current:** 7 skills.
- `ULTRAPLAN.md:71,316,341` — "rotates 5 one-liners" / "spread across the 5
  nudges." **Current:** 18 nudges (`% NUDGES.length`).
- `ULTRAPLAN.md:184` — `version: 0.3.0`, bump to `0.4.0`. **Current:** `0.21.0`.
- `AUDIT-REPORT.md:123,129,132` / `AUDIT-REPORT-2.md` — version `0.7.0`,
  `0.11.x`, "Codex GPT-5.5" pin. **Current:** all superseded; these record the
  fixes *as applied at the time*. The "12 entries" note at `AUDIT-REPORT.md:132`
  is correct and matches current code.

---

## 5. History — historical artifacts

> One-time records: dated audits, the plugin review, and the consolidated plan.
> **Frozen.** Never edited to match current code — their value is the timestamped
> snapshot of what was true and what was decided then.

| Artifact | What it is | Date / version context | Status now |
|---|---|---|---|
| [`AUDIT-REPORT.md`](./AUDIT-REPORT.md) | 4-auditor review (2 Opus + 2 Codex); confirmed issues + fixes | 2026-06-01 (mtime); `v0.7.0`-era | Superseded; findings applied |
| [`AUDIT-REPORT-2.md`](./AUDIT-REPORT-2.md) | Double deadly-loop final gate; `sudo`-bypass fix et al. | 2026-06-01; `v0.11.1 → v0.11.2` | Superseded; findings applied |
| [`PLUGIN-REVIEW.md`](./PLUGIN-REVIEW.md) | KB-driven plugin audit (P0–P2); the doc that *prescribed* the cadence redesign (Iron-Law form, SessionStart primacy, AGENTS.md, skills primer) | 2026-06-01; pre-redesign (`.sh` hooks, 5 nudges) | Superseded — its P0s are now shipped (see [§4](#4-staleness-ledger)) |
| [`ULTRAPLAN.md`](./ULTRAPLAN.md) | Single consolidated reconciliation plan; planning artifact only | 2026-05-31; `v0.3.0`-era | Superseded — executed; resting state is `0.20.3` |

**Origin note:** the deadly-loop discipline that anti-hall ships as a skill was
born from a real 7-round iteration that caught 30+ bugs solo review missed
(KB-claude-codex §6/§7, cited there). `AUDIT-REPORT*.md` are that discipline
applied to anti-hall itself — dogfooding.

---

## 6. Recommendations (consolidation outcome)

- **No source docs deleted.** All 13 remain in place; this KB references and
  classifies them.
- **Archive candidates.** The four historical artifacts
  ([`AUDIT-REPORT.md`](./AUDIT-REPORT.md), [`AUDIT-REPORT-2.md`](./AUDIT-REPORT-2.md),
  [`PLUGIN-REVIEW.md`](./PLUGIN-REVIEW.md), [`ULTRAPLAN.md`](./ULTRAPLAN.md)) could
  move to `docs/archive/` to keep the living set uncluttered. They are linked from
  [§5](#5-history--historical-artifacts) and nothing depends on their path, so the
  move is safe — **left in place pending maintainer sign-off** (not moved here, to
  avoid a silent relocation).
- **Folded docs stay standalone.** `gsd-distilled`, `superpowers-planning`,
  `keynote-*` are distilled into `KB-claude-codex.md` §9/§12/§13 but retained for
  depth + provenance. Marked *folded* in [§2](#2-living-reference-docs).
- **Single canonical file chosen over a `KB/` tree.** The heavy content already
  lives in well-structured source docs (3,500 lines across 13 files). Re-flowing
  them into section files would duplicate content and create a *second* staleness
  surface to maintain. The higher-leverage artifact is this thin authoritative
  layer — index + current ground truth + staleness ledger — sitting over the
  existing docs. One file, one place to keep fresh.

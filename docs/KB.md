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

> Verified against the working tree on **2026-06-02** (commit context: post
> `0.21.1`; `0.20.0` shipped the tasklist-guard + skip-guard, `0.20.1`–`0.20.3`
> follow-ups, `0.21.0` the pre-publish triple-deadly-loop hardening, and `0.21.1`
> the marketplace description refresh + demo assets are all in
> ground truth). This block is the canonical snapshot — update it on every
> significant change. Ref: `plugins/anti-hall/.claude-plugin/plugin.json`,
> `plugins/anti-hall/hooks/`, `plugins/anti-hall/skills/`, `CHANGELOG.md`.

| Fact | Value | Source / verify |
|---|---|---|
| **Version** | `0.24.0` | `plugin.json` `version` — the single authority. Marketplace entry carries NO `version` (avoids the silent-precedence trap). |
| **Runtime** | Pure Node, built-ins only; requires Node.js ≥ 18 on PATH | `plugin.json` description; hooks launched as `node <hook>.js` |
| **Hook language** | All hooks are `.js` (NOT `.sh`) | `ls plugins/anti-hall/hooks/` |
| **Hooks shipped (19 files)** | `agent-watchdog`, `api-guard`, `command-guard`, `doctor`, `git-guard`, `graphify-guard`, `graphify-reminder`, `graphify-session`, `phase-tracker`, `skip-guard`, `speculation-guard`, `speculation-judge`, `swarm-guard`, `task-guard`, `task-tracker`, `tasklist-guard`, `verify-first-full`, `verify-first`, plus `hooks.json`. `api-guard` (0.22.0) = PreToolUse Write/Edit/MultiEdit, blocks fabricated stdlib/builtin APIs in code (verified against installed python3/node); bench `eval/api-guard-bench.js`. | `plugins/anti-hall/hooks/` |
| **Skills shipped (7)** | `root-cause`, `orchestration`, `feature-launch`, `deadly-loop`, `deadly-loop-multi`, `doctor`, `install-statusline` (+ shared `MODEL-POLICY.md`) | `plugins/anti-hall/skills/` |
| **Cadence — full protocol** | Injected at **SessionStart** via `verify-first-full.js`. SessionStart **re-fires after compaction** with `source="compact"`, so the same no-matcher entry covers the post-compact reset. **There is no `PreCompact` hook** (its `additionalContext` would be inert — see KB-claude-codex §1.2). | `hooks/hooks.json`, `hooks/verify-first-full.js` |
| **Cadence — per-turn nudge** | `verify-first.js` on **UserPromptSubmit** emits ONE short nudge, deterministically chosen by SHA-1 of the stdin envelope `mod NUDGES.length`. | `hooks/verify-first.js` |
| **Nudge count** | **12** rotating one-liners (NOT "5") | `NUDGES` array in `verify-first.js` (`% NUDGES.length`) |
| **SessionStart injection footprint** | **~7474 B** of `additionalContext` (trimmed from 8074 B in `0.18.0`, prose-only, zero rule loss). Distinct from the `verify-first-full.js` file size (~11.4 KB incl. comments). | CHANGELOG `0.18.0` |
| **AGENTS.md mirror** | Present at repo root (Codex/clone-based governance). NOT bundled by `/plugin install`. | `AGENTS.md` |
| **Model policy** | Cross-model debate roster: latest Opus (Reviewer) + latest OpenAI Codex (Critic); fallback = second divergent Opus. **"Latest" is resolved at runtime** — no model ID is hardcoded as policy. | `skills/MODEL-POLICY.md` (duplicated into both skills' `references/`, kept byte-identical by design) |
| **Test net** | Zero-dependency `node:test` E2E suite (black-box, process-level). 77-test marker net asserts every protocol rule is present. | `tests/`, [`E2E-TESTING.md`](./E2E-TESTING.md), CHANGELOG `0.18.0` |

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
| [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md) | **Usage guide** for the `tasklist-guard` Stop hook + per-turn freshness note: when it blocks, the `.anti-hall-progress.md` file, env knobs, escape hatch, good workflow | — | **Living** | 2026-06-02 | this repo (`tasklist-guard.js` / `task-tracker.js`); design in `TASK-WORK.md` |
| [`E2E-TESTING.md`](./E2E-TESTING.md) | How the zero-dep `node:test` hook suite works; I/O contract per event; env-isolation gotcha | 129 ln | **Living** | 2026-06-02 (mtime) | [Claude Code hooks contract](https://code.claude.com/docs/en/hooks) |
| [`opus-4-8-features.md`](./opus-4-8-features.md) | Latest-Opus feature reference (context window, effort param, thinking, pricing) | 299 ln | **Living — snapshot** | Released 2026-05-28; research 2026-05-29 | [platform.claude.com whats-new-claude-4-8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8) |
| [`opus-4-8-swarm.md`](./opus-4-8-swarm.md) | Multi-agent orchestration on the latest Opus; Dynamic Workflows (research preview), Managed Agents (beta) | 319 ln | **Living — snapshot** | 2026-05-29 | Official release notes + community (cited inline) |
| [`gsd-distilled.md`](./gsd-distilled.md) | GSD phase model distilled; the lightweight phase loop feature-launch borrows from | 270 ln | **Living — folded** (KB-claude-codex §12) | Research 2026-05-29 | `.gsd/*`, gsd-*-phase SKILLs (cited in header) |
| [`superpowers-planning.md`](./superpowers-planning.md) | Distillation of 7 superpowers skills; Iron-Law + rationalization-table pattern; minimal plan-first loop | 234 ln | **Living — folded** (KB-claude-codex §13) | (date unknown) | superpowers skill set (read-only study) |
| [`keynote-prompting-claude.md`](./keynote-prompting-claude.md) | Distilled notes from two Anthropic prompting talks (Prompting 101 + Prompting for Agents) | 267 ln | **Living — folded** (KB-claude-codex §9) | Captured 2026-05-29; talks dated 2025-05-22 | [youtube ysPbXH0LpIE](https://www.youtube.com/watch?v=ysPbXH0LpIE) |
| [`keynote-transcript.md`](./keynote-transcript.md) | Best-available reconstruction of the Prompting 101 talk (no verbatim transcript exists — explicitly flagged) | 342 ln | **Living — reference** | Talk 2025-05-22 (published 2025-07-31) | DEV recap + youtubesummary + sinyblog (cited) |
| [`CONTEXT-PRESERVATION-KB.md`](./CONTEXT-PRESERVATION-KB.md) | **Consolidated research KB** on slowing main-agent context growth — caching, sub-agent isolation, compaction, pruning, JIT retrieval, memory externalization (12 technique families) | ~640 ln | **Living — research** | Swarm-synthesized 2026-06-02 | 130 selected sources (123 read) across Anthropic/OpenAI/Google docs + arXiv + practitioner sources |

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
| **deadly-loop / feature-launch** phase model + debate roster | KB-claude-codex §12, §13; gsd-distilled; superpowers-planning; `skills/MODEL-POLICY.md` |
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
  nudges." **Current:** 12 nudges (`% NUDGES.length`).
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

<div align="center">

<img src="assets/anti-hall-logo.png" alt="anti-hall logo" width="200">

# 🛡️ anti-hall

### Make Claude Code and Codex *verify before they claim* — with platform-native guardrails and workflow skills.

[![tests](https://github.com/talas9/anti-hall/actions/workflows/test.yml/badge.svg)](https://github.com/talas9/anti-hall/actions/workflows/test.yml) [![version](https://img.shields.io/github/v/tag/talas9/anti-hall?label=version)](https://github.com/talas9/anti-hall/releases) [![license](https://img.shields.io/github/license/talas9/anti-hall)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen) ![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2) ![Codex port](https://img.shields.io/badge/Codex-port-111827)

A Claude Code **marketplace + plugin** plus a separate Codex-native port that installs always-on hooks where each platform supports them, evidence-driven workflow skills, and a live two-line statusline for Claude Code. Pure Node.js, no dependencies, runs on
**macOS · Linux**. The only prerequisite is Node ≥ 22 on `PATH`. Windows is untested and not officially supported.

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

Codex project-local activation:

```bash
node plugins/anti-hall/codex/install-codex.js
```

Codex global activation:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

</div>

---

## Codex / OMX port

The Claude plugin remains the authoritative Claude Code package. The Codex port is intentionally separate:

- Manifest: `plugins/anti-hall/.codex-plugin/plugin.json`
- Installer: `plugins/anti-hall/codex/install-codex.js`
- Skills: `plugins/anti-hall/codex/skills/*/SKILL.md`
- Local launch helper: `./cx.sh` (OMX `--madmax` wrapper)

Codex hook parity is not 1:1 with Claude Code. The Codex installer hard-registers the surfaces Codex can enforce today: `SessionStart`, `UserPromptSubmit`, Bash `PreToolUse`, and `Stop`. Claude edit-time gates (`api-guard`, `ship-it-guard`), subagent lifecycle hooks, compaction/session-end hooks, and Claude Workflow JS are represented as Codex skills/protocols until their Codex payload contracts are adapted and tested.

Codex skills include `anti-hall-context-conserve`, `anti-hall-ship-it`, `anti-hall-deadly-loop`, `anti-hall-doctor`, `anti-hall-update`, and `anti-hall-omx`. Debate/review gates use `gpt-5.6-sol` (migrated from `gpt-5.5` on GPT-5.6's 2026-07-09 GA — see `docs/KB-gpt-5.6.md`); settled implementation uses `gpt-5.6-terra` (migrated from `gpt-5.4`); mechanical lookup/commands use `gpt-5.4-mini` (kept as cheap default) or `gpt-5.3-codex-spark`, with `gpt-5.6-luna` as a selective alternative.

Codex/OMX statusline note: Claude Code supports command-backed `statusLine`, so anti-hall can append the `AH: Vx.y.z` chip there. Codex `[tui].status_line` is documented as built-in footer item IDs only; this port does not inject an unsupported custom `anti-hall-version` item. Use `omx hud` / Codex built-ins for Codex HUD, and keep the Claude statusline installer for Claude Code.

Codex KBs: `docs/KB-codex-platform-hooks-plugins.md`, `docs/KB-codex-workflow-orchestration.md`, and `docs/KB-omx.md`. Each carries a source audit with at least 10 sources and at least 2 official OpenAI sources.

## Why it exists

Coding assistants fail in four predictable ways. anti-hall puts a guardrail on each one:

| # | Failure mode | What it looks like | anti-hall's answer |
|---|--------------|--------------------|--------------------|
| 1 | **Eagerness** | acting/answering before investigating | a verify-first protocol injected every session + a per-turn nudge |
| 2 | **Hallucination** | stating unverified facts as truth | the Iron Law: *no claim without evidence* — verify with a tool or label it unverified |
| 3 | **Fix-before-diagnosis** | patching a symptom before proving the cause | the `root-cause` discipline: *no fix without a proven root cause* |
| 4 | **Fake completion** | "done / fixed / passing" without running the check | claim success only after showing the command output, this turn |

The trick isn't a one-time system prompt — models *habituate*. anti-hall keeps the
discipline alive with a **layered defense**: protocol at session start (and again after
compaction), a short rotating reminder every turn, and **mechanical hooks** that can't be
argued with.

> **What's proven, and what isn't.** The **mechanical hooks** are the load-bearing part and
> are verified by 2942 passing tests (+2 platform-skipped, 2944 total) — they deterministically block force-pushes, AI-credit
> trailers, un-delegated heavy commands, and stale task state regardless of what the model
> "feels" like doing. The **prompt layer** (verify-first protocol + nudges) is a *discipline*,
> not a benchmark-validated hallucination cure: a four-round A/B eval ([`eval/`](eval/)) —
> including a fair run with a *naive* baseline that genuinely fabricates ~13% of the time —
> found **no net fabrication reduction from the prompt alone** (it fixed one trap and induced
> another, netting zero). That test deliberately disables tools, so it does not measure the
> protocol's *verification* half (running code / reading files to check a claim), which is
> plausibly where its value lies. Treat anti-hall as **guardrails + enforced discipline**, not
> a magic anti-hallucination switch. **Acting on that finding,** anti-hall ships `api-guard` —
> a mechanical hook that *does* verify, blocking fabricated stdlib/builtin APIs in code with
> **0 false positives and full in-scope catch** on a committed, reproducible bench
> (`node eval/api-guard-bench.js`) — vs the prompt's unproven ~18%. The lesson the eval
> taught, applied: **enforce mechanically, don't exhort.**

---

## How it works — two layers

**🟢 Always-on (the hook layer).** These fire automatically — no invocation, every session:

- **Verify-first** — injects the full Iron-Law + rationalization-table protocol at
  `SessionStart` (re-fires after compaction so it survives long sessions), plus a varying
  one-line nudge on every prompt (`task-tracker` is **throttled**: full directive only on
  the first turn, a one-liner after — cutting per-turn injection ~68%).
- **Output-presentation (rule K)** — an always-on "present for scannability" rule in the
  SessionStart protocol: organize output with GitHub-flavored markdown (tables, **bold**
  verdicts, `code` for flags/paths, fenced blocks), emoji as signal not decoration, and
  avoid renderer-dropped syntax. Styling organizes, never pads.
- **Guards that can't be talked around:**

| Hook | Event | What it enforces |
|------|-------|-----------------|
| `git-guard` | PreToolUse/Bash | Blocks AI self-credit trailers (in `git commit` **and** in `gh pr/issue/release` `--body`/`--title`) and `--force` pushes (quote-aware, alias-resolving, won't false-block legit pushes); also unwraps `bash -c`/`sh -c`/`zsh -c`/`dash -c`/`ksh -c`/`ash -c` shell wrappers so neither block can be smuggled past it that way |
| `api-guard` | PreToolUse/Write+Edit+MultiEdit | **The mechanical answer to API hallucination.** Resolves `module.attribute` references in the code-to-be-written against the *installed* `python3`/`node` and blocks the write when a real stdlib/builtin module is missing the attribute (a fabrication). Default scope is **stdlib/builtins** (import-safe). **100% in-scope catch, 0 false positives** on a committed, reproducible bench (`node eval/api-guard-bench.js`). Opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also verifies installed **3rd-party** packages (off by default — verifying a package means importing it, which runs its code at edit time). A prompt can be ignored; a blocked Write cannot. Fail-open on any uncertainty; never probes local/relative modules; skip-hatch supported |
| `command-guard` | PreToolUse/Bash | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload (`agent_id`), not env — works correctly under cmux and other wrappers. Per-segment (quote-aware split on `; && \|\| \|`), so `cd app && npm test` is not a bypass. **v0.76.0:** all four DevSwarm destructive-verb blocks below now also match the `devswarm` alias, not just `hivecontrol` — `hivecontrol` is a thin shim that execs `devswarm` (the primary command name, equally on PATH), so running `devswarm workspace monitor`/`read-messages`/`message-child`/`message-parent` directly used to bypass every block; fixed with a shared verb set and a `(?:hivecontrol|devswarm)` alternation (latent since the blocks were added, not a new regression; shared file, so both ports are covered). Under a DevSwarm-active session it also redirects destructive native inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` AND `read-messages` both block unconditionally (no evidence check — a raw `read-messages` desyncs the durable cursor regardless of whether a durable inbox exists); also blocks a raw shell read (`cat`/`head`/`grep`/…) of the durable inbox/store files, redirecting to `devswarm.js inbox pull/read/messages`; quoted DATA mentions are not false-positives. **v0.58 mesh-only messaging:** a separate branch (own skip `devswarm-send-guard`) also unconditionally blocks the native SEND subcommands `hivecontrol workspace message-child`/`message-parent` (all contexts), redirecting to `devswarm.js send`/`heartbeat` — lifecycle verbs (`create`/`list`/`check-merge`/`merge`) and `message-count` stay allowed; fires on Codex too (shared file). **v0.59 workspace-tier redirect:** for a DevSwarm Primary specifically, the heavy-command block reason now names a CHILD WORKSPACE (`devswarm.js spawn <branch> -p "<brief>"`) as the top fan-out tier ahead of a subagent — doctrine only, no mechanical scale classifier; a DevSwarm child and any non-DevSwarm session see the byte-identical baseline reason |
| `edit-guard` | PreToolUse/Write+Edit+MultiEdit+NotebookEdit | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`plan.md`/`STATE.json`/`CONTINUE-HERE.md`, `*.continue-here.md`, the out-of-cwd `.claude/projects/**/memory/**` store), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard`. Shares coordinator/subagent detection with `command-guard` via `coordinator-detect.js`. Fail-open. **v0.59:** same Primary-only workspace-tier redirect as `command-guard` above (child workspace named ahead of a subagent); an allowlist match is now also rejected when the target is a symlink, or reached through a symlinked directory — a real pre-existing bypass (`PLAN.md`/`STATE.json` included, not just the new entry) that let a symlinked allowlisted name write through to an arbitrary file. **v0.64.0:** also exempts PLAN MODE (`permission_mode==='plan'`) for non-source targets — narrowed by an `isLikelySource` classifier so an undelegated write to a real source file is STILL blocked even in plan mode |
| `output-verify-guard` | PostToolUse/Bash (advisory) | **v0.69.0, Harness Phase-1.** Scans a completed Bash call's own output for BOTH a passing signal ("8 passed", "PASS") and a failing signal ("2 failed", a confirmed non-zero exit) in the same run — the shape of a partial-pass summary easy to mis-report as a clean "tests pass". Never blocks; fail-open on any shape surprise |
| `failure-root-cause-nudge` | PostToolUseFailure/Bash (advisory) | **v0.69.0, Harness Phase-1.** One short reminder pointing at `/anti-hall:root-cause` when a Bash command exits non-zero — deliberately terse since OMC already injects its own root-cause reminders. Fail-open; off-switch `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off` |
| `model-routing-guard` | PreToolUse/Agent+Task | **Anti-waste routing.** Classifies spawn descriptions by keyword signals (mechanical vs complex) and nudges toward the cheapest model that fits the task shape. Emits an `additionalContext` advisory when an explicit flagship model (`opus`/`fable`) is paired with a purely mechanical task (fetch, grep, build, deploy, etc.). **Strict mode is now the default (v0.35.0+):** omitted-model mechanical spawns are blocked unconditionally — an omitted model inherits the orchestrator's, so on a flagship orchestrator this silently produces an all-flagship swarm. Set `ANTIHALL_MODEL_ROUTING=advisory` to opt out and revert to advisory-only for omitted-model spawns. Row-1 blocks (explicit flagship + mechanical) are downgraded to advisory when a debate role-word (`reviewer`/`auditor`/`critic`/`debate`/`deadly-loop`) appears in the spawn description — TRIO debate seats need flagship models. Fail-open on any error; never blocks unknown model tokens (forward-compat) |
| `swarm-guard` | PreToolUse/Agent+Task | Anti-fork-bomb: caps spawn rate (20/60 s) and refuses new agents under **real** memory pressure — measures reclaimable memory correctly on macOS (`vm_stat` free+inactive+speculative, correct 16 KB page size on Apple Silicon) and Linux (`/proc/meminfo` MemAvailable), not the misleading `os.freemem()`; a blocked spawn also logs one line to `~/.anti-hall/swarm-trips.log` (observation only — doesn't feed the rate window) |
| `task-guard` | Stop | Blocks stop when open tasks remain; counts only currently-open tasks (completed/cleared don't count); fail-open. **OMC-deference:** when `omc-detect.js` reports an oh-my-claudecode autonomous loop (ralph, ultrawork, autopilot, etc.) is active and fresh, the block is suppressed to an advisory — preventing a deadlock where the guard stops the loop it was meant to coexist with |
| `tasklist-guard` | Stop | Blocks stop when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh per-session progress file (`.anti-hall/progress/<date>/<session-id>.md`); coexists with `task-guard`; capped + fail-open — see [`docs/TASKLIST-GUARD.md`](./docs/TASKLIST-GUARD.md). **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see below) |
| `task-tracker` | UserPromptSubmit | Captures every request as a task; throttled to avoid growing context; adds a one-line freshness note when open/stale tasks exist. **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see below) |
| `hooks/lib/state-prune.js` | shared module (not a hook), **new in 0.76.0** | Bounds per-session state files under `~/.anti-hall` so they can't grow without limit. Every per-session state file (task-tracker, speculation-guard, tasklist-guard, codex-nudge) was kept forever and never read back once its session ended — on a heavy multi-session machine this reached 47,000+ files across 71 days, worsened by `doctor.js`'s own self-tests orphaning one file per hook per run. `pruneStale()` is wired into each of those four hooks' existing write paths (no new hook, no new event): removes same-prefix files past a 7-day TTL, throttled to once per 6 hours via a stamp file, never removes the current session's own file, fails open on any fs error |
| `limit-conserve-inject` | UserPromptSubmit | **Limit-conservation mode.** Injects a token-conservation nudge when context usage reaches `ANTIHALL_LIMIT_THRESHOLD` (default 85%). `ANTIHALL_LIMIT_CONSERVE`: `auto` (default) reads the OMC usage cache; `on` forces the nudge; `off` disables. Auto requires OMC; without it, manual on/off only. **Account-aware:** deactivates if the logged-in Claude account changes and the usage cache hasn't refreshed under the new account yet, rather than apply a stale cross-account reading (kill-switch `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`). Skip-guard hatch: `limit-conserve` |
| `speculation-guard` | Stop (Tier 2) | Lexical: catches 15 hedge-word speculation markers; suppressed when the message contains evidence/uncertainty acknowledgment; block-once (never wedges) |
| `speculation-judge` | Stop (Tier 3, **OPT-IN**) | Semantic: calls an LLM to catch confident inference-as-fact with *no* hedge word — the gap Tier 2 can't close. Enable: `ANTIHALL_SEMANTIC_JUDGE=1` + `ANTHROPIC_API_KEY`. Model override: `ANTIHALL_JUDGE_MODEL=<alias-form id>` (default `claude-haiku-4-5`; use alias-form, not versioned snapshot IDs). Zero cost/latency when unset (the default). Fail-open |
| `ship-it-guard` | PreToolUse/Write+Edit+MultiEdit (**OPT-IN**, default OFF) | The only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root) — nudging the ship-it plan-first workflow. Also does a CONFORMANCE ADVISORY (never blocks): flags an edit outside every phase's declared `files:` list. Enforces artifact *existence* only (not plan quality), conservative (never gates ordinary edits), fail-open. Zero effect when unset (the default) |
| `merge-gate` | PreToolUse/Bash (**OPT-IN**, default OFF) | Backstops the "false done" discipline. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "do not merge" / "needs your eyes" / …) not followed by a resolution token ("owner signed off" / "verified against" / …). Keyword-heuristic, bypassable (alt syntax / heredoc / UI / API), fail-open, cannot hard-loop. A backstop, not a guarantee. Zero effect when unset (the default) |
| `phase-tracker` | PreToolUse/Agent+Task | Records every subagent spawn so line 2 shows live swarm activity with zero coordinator effort. It also writes a rolling `~/.anti-hall/agents/recent-spawn.json` heartbeat that `agentsRunning()` consumes, so the Stop guards know when parallel work is live. |
| `agent-watchdog` | CLI helper | Heartbeat enforcer: manually invoked by orchestration skill; polls agent state files; kills idle/hung agents; integrates with `phase.js` |
| `graphify-session` | SessionStart | Reminds to query the graph first when a `graphify-out/` graph exists |
| `graphify-guard` | PreToolUse/Grep+Glob+Bash | Advisory: nudges toward `/graphify query` before the first raw code-navigation search of a session when a graph exists — no longer blocks (Task-tool subagents were already exempt, so under delegation-first doctrine it rarely reached the traffic it targeted). Still hard-blocks graph-*write* commands (`graphify update`, `--update`, `--obsidian`) from a DevSwarm child workspace — updating the graph stays the Primary's job; children may query only |
| `graphify-reminder` | Stop | One-time soft block reminding to keep the graph updated |
| `codex-nudge` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off |
| `version-alert` | SessionStart (non-blocking) | Alerts when a newer anti-hall version is available; reads running version vs a cached latest (`~/.anti-hall/version-check.json`); emits a one-line "vX available — /anti-hall:update" if behind. Cache refresh is DETACHED + unref'd — SessionStart never blocks on network. Off-switch: `ANTIHALL_VERSION_ALERT=off` |
| `devswarm-version` | SessionStart (non-blocking, **new in 0.76.0**, OPTIONAL/feature-gated) | Probes the installed DevSwarm version and flags drift from the baseline anti-hall was verified against — `command-guard` matches DevSwarm subcommands by literal string, so a renamed verb in a future DevSwarm release would make a block silently stop matching with nothing to signal it. Mirrors `version-alert`'s shape: a fresh cache short-circuits, a stale/absent one spawns a detached background probe (`devswarm-version-refresh.js`) so session start is never blocked. Semver-aware drift classification (major/minor advises, patch-only stays silent, downgrades worded accordingly), deduped so it never nags twice for the same drift. Absent DevSwarm or unparseable output fails open and silent. Baseline lives in the shared `hooks/lib/devswarm-baseline.js` module, also consumed by the `doctor` health check. Registered once, shared by both the Claude plugin and the Codex port |
| `claude-cli-version` (+ `claude-cli-version-refresh`) | SessionStart (non-blocking, **new in 0.79.0**) | Probe 2 of anti-hall's drift-probe family. Detects the installed Claude Code CLI version and flags major/minor drift from the version anti-hall's harness-feature KB (`docs/KB-claude-code-harness-features.md`) was last audited against. Mirrors `devswarm-version`'s shape exactly: a fresh cache short-circuits, a stale/absent one spawns a detached background probe so session start is never blocked. Patch-only drift stays silent; deduped on the (installed, baseline) pair so it never nags twice. CLI absent or unparseable fails open and silent |
| `repo-self-drift` | SessionStart (non-blocking, **new in 0.79.0**) | Probe 3 of anti-hall's drift-probe family — the cheapest and highest-signal: deterministic, no network, no version parsing. Two independent checks: (1) parses `docs/KB.md`'s own claimed hook/skill counts and compares them against the actual count on disk, advising on either mismatch; (2) tracks the DATE the model KBs (`docs/opus-4-8-features.md` etc.) were last audited and advises when that exceeds a 60-day threshold — a date-based check rather than a network probe, since model facts (lineup, pricing) aren't locally discoverable. Cached (<24h), deduped, fail-open and silent on any error |
| `fable-availability` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache `/model` renders from) once per session to detect whether Fable is available — no live API probe. Silent unless available; when it is, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable → Sonnet → Opus. Fail-open |
| `codex-availability` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness. Registered on both the Claude plugin and the Codex port. Fail-open |
| `handover-resume` | SessionStart | On a fresh session (including after `/clear` or compaction), surfaces the latest `.anti-hall/handovers/` entry (if any) and guides a structured resume from it — supersedes the lossy default compact summary. Fail-open (silent no-op if no handover exists). Registered on both the Claude plugin and the Codex port |
| `defect-nudge` | SessionStart (non-blocking, **new in 0.78.0**) | Once-per-day notice of open defects filed against anti-hall through the new durable defect channel (`scripts/defect.js` + `hooks/lib/defect-store.js`) — reports live in `~/.anti-hall/defects/`, cross-repo, one append-only NDJSON file per defect, never a git worktree. Counts and ages only — no reporter-supplied text. Never a Stop hook, never a forced acknowledgement. Registered on both the Claude plugin and the Codex port |
| `skip-guard` | Escape hatch (shared) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive `git-guard` (must be named explicitly) |

**🔵 On-demand (the skills).** Invoke as `/anti-hall:<name>`:

| Skill | Use it when | What it does |
|-------|-------------|--------------|
| **root-cause** | any bug, crash, flaky test, alert | evidence → hypothesis → instrument → prove the *original* root cause → fix → verify |
| **orchestration** | heavy/parallel/long work | non-blocking coordinator; fan out to subagents; watchdog + heartbeat; live phase statusline; **verify delegated work** (a subagent's "done/passing" is an unverified claim — re-check it against ground truth before marking complete) |
| **deadly-loop** | before merging anything risky | parallel **Reviewer + Auditor + Critic TRIO** debate + fix-waves, looping until zero *new* P0s or P1s. Three-phase swarm mode (Context → Duel → Converge) via `deadly-loop.workflow.js`; plain Agent-tool path available for no-consent sessions. On convergence, writes an ADVISORY `~/.anti-hall/approvals/<repo>@<sha>.json` record (`"proof": false` — not authorization; a real gate must still enforce its own check) |
| **deadly-loop-multi** | deeper review — double/triple/quadruple pass | N TRIO sets (Reviewer + Auditor + Critic per slot) with diversified lenses, then dedup + synthesize into one report |
| **ship-it** | any change, from a one-line fix to a multi-phase feature | one lean workflow scaled S/M/L to blast radius — brainstorm + plan **in plan mode** (ExitPlanMode is the gate), deadly-loop-hardened *before* code, large work fanned out as a Workflow swarm, each phase verified with fresh evidence + a vacuous-test guard until zero *new* P0s or P1s. **L tier:** resumable `.anti-hall/ship-it/<slug>/STATE.json` (per-phase status + escalation cap), P2 findings logged to `decisions.md`, Codex-primary/Sonnet-failover build seats (with a cross-model no-self-review guard), and an end-of-run session-history + `SUMMARY.md` + `graphify update .`. **v0.67.0:** the per-phase gate now tracks `totalSeats`/`liveSeats`/`deadSeats`/`degraded`/`seatReports` and requires `deadSeats === 0` to converge — a lost review seat can no longer report a silently passing gate |
| **install-statusline** | "install the statusline / add the bar" | writes the `statusLine` setting (global or per-repo), wraps an existing statusline as line 1 + adds anti-hall bar as line 2, with backup + restore. `--consolidate` merges with an existing statusline (e.g., OMC HUD) instead of replacing it; base persisted to `~/.anti-hall/consolidated-base.json`. Env: `ANTIHALL_STATUSLINE_BASE` |
| **doctor** | "is anti-hall working?" / "repair anti-hall" / after install/update | confirms Node ≥ 22, all hooks present + syntax-valid, **runs live behavioral self-tests** (spawns real guards with crafted payloads and asserts exit codes), reports context footprint in bytes + estimated tokens. **Env-aware:** also detects + tests OMC, Codex/OMX, and the DevSwarm liveness supervisor (installed-companion state + a per-workspace liveness self-test, `nudged` reads as WARN not FAIL), each silent and skipped when that integration isn't in play. **Repair mode (v0.55.0):** plain `doctor` also auto-applies AUTO-SAFE fixes (state migrations, statusline-if-missing, idempotent supervisor/codex refresh) and, only under the DevSwarm gate, GATED daemon fixes (ingest install / wrong-path rebind / stale-script / (v0.58.1) `reconcile` — draining stranded per-worktree queues into the shared store, previously manual-only); `--check` is the pure read-only CI path, `--dry-run` previews, `--fix`/`--repair` are explicit aliases |
| **system-briefing** | "brief me on anti-hall" / "what's in this build" / "how does the whole system work" | a DERIVED (never hardcoded) live inventory for the agent that installs or operates anti-hall — every hook grouped by event with its one-line purpose (read from `hooks.json` + each file's own header), the shipped skills, the DevSwarm substrate (mechanical triggers · store · CLI · auto-safe migration), and a docs/KB map. Generated by `scripts/briefing.js` so it can't drift. The orientation companion to `doctor` (which answers "do the guards actually fire?") |
| **update** | "update anti-hall" / "is anti-hall up to date?" | `git pull --ff-only` the marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof), prints the changelog delta, then instructs `/reload-plugins` for in-session reload (hooks and statusline pick up from disk immediately; `/reload-plugins` refreshes the skill list and version label; rarely a restart is needed). Then runs a **dynamic capability scan** (read-only) reporting each opt-in capability this build ships — companions, statusline, pending state migrations — as available-vs-active on this machine, with the exact command to close any gap |
| **devswarm** | "explain the anti-hall DevSwarm integration" / "tune the liveness supervisor" / "recover a stuck workspace" | explains the four DevSwarm addons (hivecontrol reference KB, the designed-not-built workspace tier, the shipped layered recovery model, the on-demand recovery CLI) — the automatic path only detects → pokes → escalates and **never kills**; killing is on-demand only, via `devswarm-recover.js` — plus the full activation checklist + tunable env vars |
| **flutter-debug** | "debug my Flutter app" / "drive the iOS simulator / Android emulator" / "reproduce this bug in the app" / "fix and verify in the UI" | agent-driven Flutter debug loop (run + hot reload + **visually verified UI changes**); reproduces bugs → reads errors (exceptions / layout / logs / VM service) → roots cause → fixes → re-verifies with screenshots. iOS fully; Android run/reload/errors today, taps/screenshots pending FP7 probe. Delegates to the `flutter-debug` agent after zero-setup MCP + app-side marionette integration. Capability tier degradation (full-visual / coordinate-visual / error-only) announced per preflight |
| **activate** | "activate anti-hall" / "set up anti-hall" / "first-time setup" | one-shot idempotent first-run setup: checks & installs the statusline (user scope by default; offers project-scope on conflict), reports model-routing state (strict by default), writes a `~/.anti-hall/activated.json` sentinel, and prints a restart reminder if settings changed. **Never auto-invoked** — always user-triggered. Re-running is safe |
| **simplify** | "simplify this" / "deslop" / "trim the fat" / "this is over-engineered" | behavior-preserving simplification harvest on recently-changed (or named) code: tags each finding `delete:`/`stdlib:`/`native:`/`yagni:`/`shrink:`/`slop:`, applies the safe set, re-runs tests, and reports a single **measured** `net: -N lines` score (the real post-apply diff delta — never a projected estimate). Scope change ≠ simplification: declines anything that removes capability |
| **debt** | "track this debt" / "audit our debt" / "what shortcuts did we take" / "is this debt rotting" | register + auditor for **deliberate** technical debt via `// anti-hall: <ceiling>,<when>` markers (a budgeted, harvestable alternative to vague TODOs). Greps the tree (`scripts/harvest-debt.js`, pure Node), parses each ceiling + payback trigger, and flags **rot-risk** when a marker has no trigger or sits in code untouched past a staleness threshold. Not a license to skip real work |
| **handover** | "hand this off" / end of session / before `/clear` or running low on context | writes a comprehensive, organized, minimal-but-lossless session handover under `.anti-hall/handovers/`: a global index plus a per-session `HANDOVER.md` (front-loaded, fixed SBAR-derived schema, ≤200 lines) and detail files (`state.md`/`decisions.md`/`trials.md`/`knowledge.md`), sequence-chained to prior handovers. Paired with the `handover-resume` SessionStart hook, which surfaces the latest handover automatically after `/clear` or compaction — so a fresh session resumes without re-deriving or guessing anything. Codex mirror: `anti-hall-handover` |
| **defects** (**new in 0.80.0**) | "file an anti-hall bug" / "did they fix my report" / "check my defect reports" | file, list, show, and read rulings on anti-hall's own defect reports via the durable, home-scoped, two-way channel that shipped in v0.78.0 but had no discoverable entry point until now — the `defect-nudge` hook's pointer led nowhere on both ports. `report` accepts `--sym-file`/`--repro-file` so a body doesn't need shell-safe quoting (unknown flags are rejected, not silently dropped); a report against a defect already ruled `fixed` is derived `regressed` or `staleBuild` from the reporter's installed version. `rule --status` also accepts `partial` for a fix that shipped only in part (never derives as fully `fixed`). `list --mine` identity no longer depends on the current directory. The `devswarm` skill now points here too. Codex mirror: `anti-hall-defects` |

> **root-cause** and **orchestration** are also enforced *always-on* as disciplines via the hook layer, alongside anti-sycophancy (challenge a wrong premise with evidence — never agree just to agree) and **scope & fidelity** (solve the actual problem with the simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked and drop nothing). Orchestration now also requires the coordinator to **independently verify delegated work** — a subagent's "done/passing" is an unverified claim, re-checked against ground truth before marking complete — and **defaults delegated heavy/parallel work to the background** (the coordinator passes `run_in_background` so the user needn't background it manually), while still verifying each on completion. **deadly-loop** and **ship-it** stay conditional, invoked on match.
>
> **Debate roster (TRIO):** Reviewer = Sonnet (`model:"sonnet"`, effort `xhigh`); Auditor = latest Claude Opus (`model:"opus"`, divergent regression/coupling lens, effort `high`); Critic = latest OpenAI Codex at `xhigh` reasoning (Opus adversarial-persona fallback when Codex unavailable). All three dispatched in the same message for true parallelism. Model floor for fallback seats = Opus; never a cheaper model. Spawns use **tier tokens only** (`opus`/`sonnet`/`haiku`) — resolved to the newest available build at call time, never hardcoded version IDs. See `plugins/anti-hall/skills/MODEL-POLICY.md`.

---

## 🤖 Autonomous execution

`ship-it` runs autonomously once the plan is approved at the **ExitPlanMode** gate — it
builds phase by phase, verifies each with fresh evidence, and hardens with the deadly-loop
without waking you for routine decisions. The one hard stop: **absolutely-destructive** hard
gates (force-push, prod deploy, data/branch/file deletion, financial action, secret/access
change) **never** autonomy-bypass — the run STOPS and surfaces options to you. These
boundaries are enforced at command dispatch by anti-hall's always-on guards (git-guard /
command-guard), and swarm agents inherit them: a background agent cannot bypass a gate the
main thread couldn't. For everything else it keeps shipping and only surfaces what truly
needs a human.

---

## 🧹 Context-protection discipline

A bloated orchestrator context degrades the model and induces the hallucination the plugin
is meant to prevent. anti-hall enforces this at two levels:

**For your agents:** the SessionStart protocol + per-turn nudges enforce:
- Delegate not just heavy *commands* but also **broad reads, Grep, Glob, and code-navigation searches** to subagents — inline only a specific known-file read.
- **Graphify-first:** query the graph before raw search and before ship-it analysis.

**For itself:** the plugin minimizes its own footprint in your conversation:
- `task-tracker` is **throttled** — full directive once per ~6h window, one-liner after (~68% per-turn reduction, ≈693 B → ≈223 B steady-state).
- The SessionStart injection is split across **two** hooks so each clears the ~10k per-hook cap (over which Claude Code spills the overflow to a file instead of delivering it inline): `verify-first-full.js` carries the Iron-Law foundation + the disciplines/skills index, and `verify-first-orch.js` carries the orchestration ruleset (rules A–N + DevSwarm rule W). `verify-first-subagent.js` (SubagentStart) re-injects the Iron Law into every spawned subagent (omitting the orchestration/delegate block so workers don't recurse); shared core in `verify-first-core.js`. `/anti-hall:doctor` reports the exact byte size of the SessionStart injection, so any footprint change stays visible and auditable.
- `/anti-hall:doctor` **measures** the context footprint — reports SessionStart / per-turn / per-Stop injection sizes in bytes + estimated tokens, so the cost is visible and auditable.

---

## 📊 The statusline

A live **two-line** statusline the plugin renders itself — installable globally or per-repo.

```
▊ my-repo · git-user · 🌿 main ~4 ?2 · Fable (1M context) · ⏱ 71m · ● 56% ctx · $1.23
[███████████◐────────] 56% context
```

- **Line 1 — rich & dynamic:** project, git (branch / worktree / stash / staged-modified-untracked / ahead-behind), model, effort, subagent count, session duration, context-window %, cost. Also shows an **anti-hall version chip** (`AH: Vx.y.z`) between the cost and email segments; `★` prefix in YELLOW for a new minor version, RED for a new major version, plain dim when up-to-date (fail-open if no cache).
- **Line 2 — always-on, three smart tiers:**
  1. **During an orchestration run** → live phase progress bar (`P2 · build api 2/5 · 3 agents`)
  2. **While a swarm is active** (auto, zero setup) → animated `orchestrating · N agents` (powered by `phase-tracker` recording every spawn)
  3. **Idle** → context-window gauge, color-coded green/yellow/red at ≤70/70-89/≥90%
- **`phase.js` — the progress writer:** the orchestrator calls `phase.js set/advance/step/agents/clear` as phases progress; the file writes `~/.anti-hall/phase-state.json`, which line 2 reads. Stale state (>30 min old) auto-hides so orphaned bars never linger.

Install it the easy way — just ask Claude **"install the statusline"** (the
`install-statusline` skill writes the setting, wraps any existing statusline as line 1 +
adds the anti-hall bar as line 2, with backup/restore) — or run the installer directly.
Use `--consolidate` to merge with an existing statusline (e.g., the OMC HUD) instead of
replacing it; the base is persisted to `~/.anti-hall/consolidated-base.json`. Set
`ANTIHALL_STATUSLINE_BASE` to pin the base expression explicitly.
See [STATUSLINE.md](plugins/anti-hall/statusline/STATUSLINE.md). *Claude Code reads
`statusLine` only at startup, so restart once after installing.*

---

## 🔌 Optional: oh-my-claudecode (OMC)

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) is a **recommended optional** companion. anti-hall is fully standalone without it, but two features gain automatic behavior when OMC is installed:

- **Limit-conservation auto mode** — `limit-conserve-inject` reads the OMC usage cache to detect the live context percentage and fire at the right moment. Without OMC, the hook operates in manual `on`/`off` mode only (`ANTIHALL_LIMIT_CONSERVE=on` to force). **Account-aware:** deactivates if the logged-in Claude account changes before the usage cache refreshes under it (kill-switch `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`).
- **Consolidated statusline** — `install-statusline --consolidate` merges the anti-hall bar with the OMC HUD seamlessly.

Nothing breaks without OMC. These features fall back gracefully.

---

## 🧟 MCP orphan reaper (companion, opt-in, macOS + Linux)

A separate **interval companion** (not a hook) that kills **orphaned** MCP-server
processes leaked when their spawner (a Claude / codex / npm / node session) exits without
cleaning them up — on macOS these reparent to launchd and pile up over a workday.

```bash
node plugins/anti-hall/companion/install-reaper.js              # install (auto-detects OS)
node plugins/anti-hall/companion/install-reaper.js --uninstall  # remove
```

macOS installs a 60 s LaunchAgent; Linux a `systemd --user` timer (cron fallback).
**Safety invariant:** a process is reaped only if its command matches a generic MCP
signature **and** its parent is a reaper/init (launchd / init / `systemd --user`) — since
Unix reparents a dead process's children, a *live* MCP always has a live spawner as
parent, so killing an in-use server is impossible by construction. Env knobs:
`MCP_REAP_DRYRUN=1`, `MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`.
Python MCPs (`uvx`/`uv` + underscore `mcp_server_*` forms) are recognized too.
**Limitation:** an MCP run as a LaunchAgent / `systemd --user` unit / OS service shares
init as a parent (just like a leaked orphan) and can be reaped — exclude it with
`ANTIHALL_REAPER_EXCLUDE='name|name'`. **Windows is unsupported**
(documented no-op): it has no parent-death reparenting and recycles PIDs, so external
orphan detection is unsafe — the correct fix there is Job Objects set by the spawner.

---

## 🐝 DevSwarm layered recovery (companion, opt-in and OPTIONAL)

**DevSwarm coordination is entirely optional.** anti-hall's core — the verify-first
protocol, the mechanical guards, the statusline, `doctor`, `update`, etc. — works fully
**without** DevSwarm. Everything below is dormant with zero behavioral change unless a
DevSwarm session is active (`DEVSWARM_REPO_ID` set) and/or one of its own opt-in
companions (the ingest daemon / the liveness supervisor) is installed; nothing else in the
plugin depends on it.

**All DevSwarm features, at a glance** (detail below; full reference:
[`docs/KB-devswarm-hivecontrol.md`](docs/KB-devswarm-hivecontrol.md) §8):

- **Layered recovery, never-auto-kill** — a wedged child self-reports idleness, a
  supervisor **pokes** it, then **escalates to the parent**; the only path that ever kills
  a process is the separate, on-demand `devswarm-recover.js` CLI. Delivery of that
  escalation still requires the Primary to have self-registered from the true main
  worktree — see the v0.67.1 bullet below for the known gap when it hasn't.
- **Human-readable workspace names (v0.67.0)** — `devswarm.js spawn` titles a new
  workspace from its `-p` brief via a separate best-effort `hivecontrol workspace
  update-title` call (a caller-supplied `-t/--title` is never overridden); the parent's
  per-turn status table now shows `name (shortid)` instead of a bare UUID, reading a
  shared fs cache (`companion/lib/devswarm-names.js`) that never spawns `hivecontrol` on
  that hot path.
- **Supervisor escalation actually delivers, plus a cross-repo hijack guard (v0.67.1)** —
  fixed four stacked defects that had kept the escalate-to-parent path above from ever
  delivering end-to-end (stale post-append projection, wrong-bucket store open, parentId
  derived from the child's own worktree instead of the resolved main worktree, and two
  fold/rehome paths skipping their projection refresh); hardened the roster's native fold
  with a cross-repo `repositoryId` check against a cwd-anchored ground truth (drops +
  logs mismatches, fails open unfiltered) — a new guard, not a repair of a prior break.
  **Known remaining gap:** an escalation that lands in `orphans[]` (no live registry row)
  is surfaced by the informational parent-inbox hook but not by the blocking parent-gate
  hook, so a Primary can `Stop` unblocked on an escalation the inbox hook is showing.
- **Parent decide+reply gate, no more silent nag-out (v0.69.0)** — the Stop-gate could
  previously be satisfied by a Primary merely *reading* a child's blocking `--question`; it
  now requires an OBSERVED reply. A new `devswarm-parent-reply-tracker` hook (PostToolUse,
  Bash) records a successful `send --to <id> --question` into a durable, per-project
  reply-state file (`companion/lib/devswarm-reply-state.js`, repoKey-keyed so it survives a
  read/ack and new Claude sessions); the forced-ack cap can no longer silence an unanswered
  question forever — once exhausted it escalates once instead of going quiet, and every
  Primary turn re-asserts the obligation. `recordReply`'s read-modify-write is now
  lock-protected after a reproduced race lost entries under concurrent writers. New
  persisted shape: a `needs_reply` column on mesh rows, backfilled via an additive/
  idempotent/fail-open `ALTER TABLE ADD COLUMN` that runs on every store open (both the
  `update` path and `doctor` self-tests exercise it). Hardened via a 6-round deadly-loop.
- **Child self-continue directive (v0.69.0)** — a child in a multi-round autonomous task
  (deadly-loop, iterative fix waves) now gets a per-turn nudge to keep issuing tool calls
  across rounds within the same turn instead of ending its turn to "check in", cutting the
  wake-cycle (supervisor cron) latency that cost every time it idled between rounds. Shared
  verbatim with the Codex port.
- **Mesh/store message-loss fix (v0.70.0)** — `archive` used to tombstone exactly one
  registry row per generation, so a re-archived-and-reregistered worktree could still hold
  LIVE sibling rows sharing it, and a real unanswered question could forward into one of
  those dead partitions. `foldArchivedRegistryRows` now folds ALL same-worktree rows for an
  archived id and picks the forward survivor by LIVENESS; it's a dual-path migration wired
  into both `update` and `doctor --fix` (idempotent, fail-open-honestly, no-delete — message
  rows are never deleted, only registry rows are tombstoned after their unread forwards).
- **Archived-row read filter + archive self-heal (v0.70.0)** — a new read-side filter
  excludes a genuinely archived workspace from the LIVE per-turn injection immediately,
  without needing a `doctor` run first; an archived workspace with real unread still
  surfaces as an orphan (no lost signal). `archive` also self-heals a stale
  `archived/<id>.json` leftover from a prior generation (decided by inode, fail-closed on
  any incomplete scan) instead of permanently wedging re-archive of that id. The per-turn
  parent-inbox STOP wording is now advisory for the normal tier (urgent/high tier
  unchanged).
- **DevSwarm `archive` shortId/prefix resolve (v0.70.1)** — `archive <id>` now also
  resolves an unambiguous shortId/prefix (the same short form shown in the roster/
  injection table), so the id displayed there is directly archivable; an ambiguous
  prefix archives nothing and lists the candidates instead. `isSafeId` still gates
  (no `/`); exact-id behavior is unchanged.
- **Append-only reply-state redesign (v0.71.0)** — DevSwarm parent decide-gate reply
  state moved from a lockfile read-modify-write to an append-only JSONL log
  (`recordReply` = one `O_APPEND` write, no lock; `readReplyState` folds the log,
  fail-closed newline separator, 480-byte record cap, `Object.create(null)` fold
  accumulator so a `__proto__`-named sender survives). Loss-safe forward migration
  wired into both `update.js` and `doctor --fix`. Structurally eliminates the
  disclosed steal-branch TOCTOU.
- **Emoji-as-signal rule propagated to subagents + Codex (v0.71.0)** — Rule K (status
  glyph as SIGNAL, never decoration) now also injected at `SubagentStart` and in the
  Codex orchestration skill, not just the orchestrator's `SessionStart`.
- **Test-store-leak hardening + read-only leak audit (v0.71.0)** — fixed 4 doctor
  tests' `HOME`-default landmine; added a READ-ONLY store audit/classifier
  (REAL/GARBAGE/UNKNOWN) and a leak-report CLI whose `--out` is guarded (realpath
  canonicalization, `O_EXCL`/`O_NOFOLLOW`, a distinctive marker) so it can never
  overwrite a production `devswarm.db`. Detection-only — never deletes.
- **`register-primary` records the real Claude `session_id` (v0.71.0)** — `--session`
  now defaults to `CLAUDE_CODE_SESSION_ID` (was the workspace hash), so Primary rows
  resolve their transcript for liveness reads.
- **Partition resolution follows the WORKSPACE, not the caller's cwd (v0.84.0)** —
  `inbox read-primary`/`inbox count` used to resolve the store partition from the
  directory the command ran in, so a Primary could be gate-blocked on mail it
  structurally could not see, and running the gate's own prescribed command from the
  wrong directory risked writing a cursor into another project's partition. Both the CLI
  and the Stop hook now resolve through ONE shared helper
  (`companion/lib/devswarm-repokey.js` `registeredRepoKey`; precedence fresh key →
  recorded `repoKey` → non-hash `ownerKey`), so they can no longer disagree about which
  workspaces a session owns. In the same change: `gate`/`ensure`/`archive` no longer
  re-home a foreign project's workspace BEFORE their ownership guard runs (a refused call
  now writes nothing — `archive` had been removing the live descriptor); `inbox ack` on a
  workspace the caller doesn't own no longer advances the cursor past unread mail; and
  `inbox count`/`read` report `known:false` with the named `registeredRepoKey`/
  `callerRepoKey` instead of a silent zero that reads like "no mail".
- **Archived-stranded orphan partitions no longer warn (v0.84.0)** — the orphan detector
  counted an archived child's own outbox copy as unread-with-no-reader, so the Primary saw
  a permanent, unactionable warning every turn. It now excludes exactly the set
  `healOrphanPartitions` classifies as `unhealable/archived-no-family`, by CALLING heal's
  own exported helpers (`companion/lib/devswarm-orphan-policy.js`) rather than
  re-implementing the rule — an equivalence test fails CI if the two predicates drift. The
  excluded ids move to a quiet `archivedStranded[]` on the summary rather than being
  dropped, and the classifier fails open (it can only quiet a warning it positively proved
  unactionable).
- **Defect fields are no longer silently truncated (v0.84.0)** — the shared clamp cut
  over-length values at their cap and returned plain success with nothing in the result or
  the record to show text was lost. Truncation is now named in `scripts/defect.js`'s JSON
  result and on stderr and marked inside the stored value (`[truncated from N chars]`),
  and the caps for `note` (300 → 1200), `claimed`, and `observed` were raised — bounded so
  a maximum-length field still cannot push a record past `MAX_LINE_BYTES`. The write never
  fails.
- **Archive retires the whole identity family (v0.85.0)** — `archive` tombstoned by
  `<id>` only, but a descriptor's identity family can be cross-linked by `sessionId`
  instead (one row's `sessionId` IS the other row's `id`), so the twin stayed live in
  `workspaces/` after its sibling was archived and the Stop gate nagged every turn about
  an inbox that, by design, could never exist — un-clearable without editing state by
  hand. `cmdArchive` now retires the whole family at archive time, and
  `foldArchivedFamilyDescriptors` folds sets already split by the bug (a forward
  migration wired into BOTH `update` and doctor's AUTO-SAFE
  `fold-archived-family-descriptors` repair) — the descriptor-file counterpart of
  v0.70.0's registry-row `foldArchivedRegistryRows`.
- **The parent gate tells a dead descriptor from neglect (v0.85.0)** — the old rule was
  that `known:false` on the unread read ALWAYS blocked, unconditionally, including an
  absent inbox file; that absolute was the defect. An `inbox-missing` (ENOENT, and only
  ENOENT) on a descriptor whose `worktreePath` is ALSO provably gone no longer raises the
  unknown axis, because no action the Primary can take would ever clear it. Nothing is
  hidden: store-side unread still blocks on `unionUnread`, a stale/escalated verdict
  still blocks, and every other unreadable reason (`inbox-unreadable`, `cursor-*`,
  `no-inbox-path`, `read-threw`) still blocks regardless of the worktree. "Gone" requires
  a definitive ENOENT `lstat` on an ABSOLUTE path — a relative/missing path, a dangling
  symlink, or a stat that failed for any other reason is NOT provably gone and still
  blocks.
- **A descriptor is retired only against PROVEN write authority (v0.85.0)** — every
  descriptor writer publishes by atomic rename, which installs a NEW INODE at the same
  pathname, so a retire that classified a twin at scan time and unlinked it by pathname
  could destroy a freshly-registered LIVE descriptor. Retirement now re-reads a coherent
  inode+bytes generation fingerprint INSIDE the per-id lock and compares it against the
  scan-time snapshot; `devswarm-child-turn.js` takes that same per-id lock around its own
  descriptor rename (bounded ~1s, fail-open, no nested acquisition); and the migration
  path is additionally gated on `worktreeIsProvablyGone`. A mismatch or unproven
  gone-ness REFUSES the retire rather than guessing, and a one-way historical identity
  link is never by itself sufficient authority. Grouping uses the id/`sessionId`
  cross-link only, never bare worktree equality, so two legitimately-live tabs on one
  worktree are never retired. Safety refusals surface through `update`'s summary and a
  doctor `notice` instead of reading as a clean no-op.
- **Daemon units now ship a PATH that can resolve their own interpreter (v0.86.0)** — the
  ingest/supervisor installers bake an ABSOLUTE node path as the unit's interpreter
  (`process.execPath`, commonly a version-manager dir on no scheduler's default `PATH`)
  but built the unit's `PATH` from the `hivecontrol` dir plus a minimal fallback only. The
  daemon itself always started and looked healthy (absolute `argv[0]`), while
  `hivecontrol` — a SCRIPT whose shebang re-resolves `node` THROUGH `PATH` — died on every
  grandchild spawn with `env: node: No such file or directory`, exit 127: 23,928
  occurrences over 1,757 supervisor sweeps across three repoKeys, `healed:0` on every one,
  i.e. reconciliation had never once succeeded. Fixed at the single chokepoint all six
  plist/service/cron emitters derive from — `unitEnvFor` prepends `dirname(execPath)` and
  takes `execPath` as a REQUIRED argument, so a unit's `PATH` structurally cannot disagree
  with the interpreter baked into it. Install refuses if that node binary is not a real
  file, and a unit whose `hivecontrol` could not be resolved now still gets a
  node-resolving `PATH` instead of no environment at all.
- **Auto-heal can now fire when it is actually needed (v0.86.0)** — `update.js` only
  attempted `healIngestDaemon` on a run that had synced new bytes into the version cache.
  But a daemon's baked script path goes stale with NO version bump (the plugin manager
  relocates the version-pinned cache dir it was built from) — exactly the case the heal
  exists for — and in that steady state `syncCache` no-ops and the classifier that would
  spot the dangling path never ran. The heal now also fires when the installed unit fails
  to classify `ok`, through the same lookup the heal action itself uses so the decision and
  the action cannot disagree. Read-only and fail-open on a no-sync run; `absent` is
  deliberately excluded, so a no-op update never first-installs an opt-in daemon.
- **The store leak report is now genuinely read-only (v0.86.0)** —
  `devswarm-store-leak-report.js` promises in its own banner that it modifies nothing, then
  defaulted `--out` to a timestamped path and wrote a JSON file on every invocation. The
  file is now opt-in: no `--out`, no write. All `--out` safety (realpath containment,
  `.json` requirement, `O_EXCL`/`O_NOFOLLOW`, report-marker check) is unchanged, and the
  analysis logic is untouched.
- **A stale/escalated verdict alone can no longer hard-block the Primary indefinitely
  (v0.87.0)** — `escalated` is STICKY (`liveness.js`'s terminal short-circuit returns it
  unchanged until a fresh heartbeat a finished session will never emit again), so a
  verdict of `{"status":"escalated","pending":false,"notDraining":false}` — the verdict
  itself saying nothing was outstanding — force-blocked the Primary on ~20 consecutive
  turns, because the gate read only the bare `status` string and discarded the verdict's
  own `pending`/`notDraining` flags. A bare `stale`/`escalated` status now needs
  corroboration from at least one of four independent axes (the verdict's own `pending`
  flag, a real union-unread backlog, an unreadable unread axis — fail-open toward
  blocking — or an unanswered question from that family) before it can drive a hard
  block; an uncorroborated status degrades to a one-time stderr advisory instead. A bare
  verdict label is not evidence — see `docs/KB-devswarm-hivecontrol.md` for the
  generalized invariant.
- **Liveness's own union-unread signal no longer double-counts a caller's own outbound
  message as evidence a target is neglecting inbound work (v0.87.0)** — `resolveSelfId()`
  resolves the caller's real Primary id (mirroring the addressee-hash fix `recovery.js`
  already carries) and excludes store-only rows sent by that id from the staleness gate.
- **DevSwarm wake is count-first (v0.87.0)** — the wake instruction used to tell an agent
  to run the full mailbox drain+read sequence every turn, which the agent's own cron
  prompt routinely delegated to a subagent even on an empty mailbox. It now runs the
  cheap, inline `inbox count` first and only pays for a drain/read when `unreadTotal > 0`.
- **The durable-inbox ack cursor is monotonic by default (v0.87.0)** — `ackTo()` was
  callable unlocked from multiple sites, so two overlapping drains could race a cursor
  backward and cause re-delivery. The one proven legitimate exception (a MIN-only
  cross-namespace reconciliation) opts in explicitly via `{ allowRewind: true }`.
- **A fold pass now advances a folded-away candidate's own cursor (v0.87.0)** once its
  unread rows have fully forwarded to the survivor, so an already-forwarded backlog on a
  `left` candidate stops rendering as permanently "not draining"; a partial/failed
  forward still leaves the cursor untouched for a safe idempotent re-forward.
- **The orphan-entry classifier now checks drained state, not just forwarded state
  (v0.87.0)** — a forwarded entry that was later drained is not an orphan.
- **Per-project mesh store** — one shared store per project keyed by a stable `repoKey`,
  so any worktree can message any other directly; **#36-STRUCTURAL scoping** closes a
  spoofable cross-project bleed.
- **Mesh messaging CLI** (`scripts/devswarm.js`) — `send --to <meshId>|--to-primary|
  --broadcast [--urgency low|normal|high|urgent] [--question]`, `roster` (also folds in
  unregistered native `hivecontrol` children), `mesh read`, `heartbeat --summary`, `inbox
  pull/read/read-primary/peek-primary` (`peek-primary` is the non-acking counterpart to
  `read-primary` — same read, no cursor advance, for checking status without clearing it).
  Every message row carries `{from, to, type, message, timestamp,
  urgency}`. `--question` marks a direct send as a blocking decision-request — rejected on
  `--broadcast`. The blocking/reply-tracking guarantee (Stop-gate + `recordReply`) is
  enforced when the recipient is the Primary; a peer child→child `--question` is
  delivered and flagged (`needs_reply`) but is not gate-enforced on the recipient side.
- **Mesh self-heal (v0.61.0).** Drain-aware routing delivers to the partition a child
  actually drains, plus a phantom-only rescue on a child's first registration; a pure
  `computeSummary` projection derives `orphans[]` (unread partition, no live workspace)
  and `staleRegistryPartitions[]` (registry row whose worktree is gone); new read-only
  `diagnose` and `healthcheck [--json]` (pass/fail, exit 0/2, for monitors/CI) verbs;
  register-time dedup with an `isForwardable` noise filter (forwards only real directs,
  never poke/hash-mirror junk); `foldMeshDuplicates` migrates every prior store shape
  (phantom/dual/subdir-split/stale) onto one canonical git-toplevel identity, wired into
  both `update` (post-update) and `doctor`'s auto-safe repair (dry-run doubles as a
  read-only mesh-shape check); `roster`/`workspaces list`/`diagnose` are now pure reads
  (no `summary.json` write side-effect); orphans/stale partitions surface to the Primary
  via `devswarm-parent-inbox` (capped, read-only).
- **Mesh self-heal follow-ups (v0.62.0).** `unarchive <id>` reverses `archive`; a new
  `migrate-owner-keys` forward-migration backfills/re-homes a descriptor's `ownerKey`
  (idempotent, fail-open, no-delete; wired into `update`/`doctor`); `reap-stale
  [--yes|--confirm]` dry-run-reaps descriptors verdicted stale/escalated, gated by a
  fresh-heartbeat/recent-git-activity safety check; `reconcile-active [--active id,...]
  [--allow-empty] [--stdin] [--yes|--confirm]` archives every current workspace of a
  project NOT in an explicit "still active" set.
- **Mesh usability + self-heal (v0.63.0).** `send --to` now accepts the roster `id` (not
  only the internal meshId), falling back from a meshId match to an exact registry-`id`
  match with an `ambiguous-recipient` fail-closed guard; `roster` surfaces each row's
  `meshId`. `reconcile` gained a `healRegistry` pre-pass that corrects a mis-keyed
  registry row in place or rehomes one physically in the wrong store (no-delete,
  message-preserving, idempotent) instead of silently rejecting it; the aggregate `ok`
  now requires `rejected===0`. A wedged-but-alive ingest daemon whose own heartbeat is
  confirmed stale is SIGKILLed and its lock reclaimed (never a fresh-heartbeat daemon).
  New structured JSONL logger (`companion/lib/anti-hall-log.js`, fail-open,
  size-bounded/rotating) wired into ingest/lock/parent-inbox error paths.
- **Self-heal reliability + observability (v0.64.0).** `rehomeMiskeyedRow` normalizes a
  mis-keyed row's stored `worktree_path` to the descriptor's verified current path before
  rehoming, so `healRegistry` no longer no-ops on a legacy bare-hash store on the first
  pass. `doctor --fix` now gates ingest-daemon health on the two-signal liveness check
  (fresh heartbeat + live-pid lock) instead of install-shape alone, taking the reinstall
  path with a distinct dead-daemon reason when install-ok-but-dead. The structured logger
  is now wired across ingest/lock/send/reconcile/inbox/register error paths (including a
  previously-swallowed top-level catch), with two read-only surfaces to query it:
  `devswarm.js logs` (filter by `--repo`/`--component`/`--min-level`/`--since`/`--limit`)
  and `doctor --logs`. `inbox messages --ack-as-owner` without `--ack` now warns it did
  NOT ack instead of silently staying read-only.
- **Daemon reliability + honest health (v0.65.0).** Root-caused an ingest daemon that was
  RUNNING but ingesting nothing: it spawned `hivecontrol` by bare name under the service
  manager's minimal `PATH` and failed every cycle with a swallowed ENOENT. The binary is
  now resolved at install time and baked into the generated launchd/systemd/cron unit
  (never a hardcoded path). ENOENT/EACCES/ENOTDIR now escalate through a capped backoff
  instead of storming the log, while the heartbeat keeps writing. Orphaned ingest locks
  self-heal on daemon start (positive OS confirmation required before any removal); the
  new `doctor --reclaim-ingest-lock` is an explicit, opt-in sweep-and-reinstall path,
  never automatic. The heartbeat now records the monitor outcome, so an alive-but-failing
  daemon is reported as a `doctor` FAILURE and surfaced by a one-line in-session banner
  instead of reading as healthy; a heartbeat missing these fields (pre-upgrade daemon) is
  treated as unknown, never a fault. Install now also detects a memory-guard/reaper
  script that would kill the service-managed daemon and reports the exact allowlist entry
  to add (detect-and-report only). Separately, a DevSwarm child now forwards a decision to
  its parent with its recommendation and default, keeps working every other item, and
  proceeds on that default if unanswered — never blocking the swarm on a question; only an
  unauthorized destructive action is a hard stop.
- **Loss accounting + one health definition + honest success shapes (v0.66.0).** A
  monitor batch that arrives but fails to parse (shape change, stderr contamination, a
  truncating timeout) is now logged and quarantined to disk instead of silently vanishing
  via the consume-on-read native queue; a well-formed empty result is still normal. Doctor
  no longer asserts health from a weaker second definition that omitted the pid guard and
  monitor-fault check — reaping now uses the one shared `daemonHealth` definition
  everywhere. Project identity now resolves via the git superproject from inside a
  submodule and refuses on an unresolvable context instead of quietly keying off the
  submodule or falling back to a legacy store. `heartbeat`, `reconcile`, and other paths
  no longer report `ok` while a mesh broadcast failed or individual targets crashed/timed
  out; a genuinely absent hivecontrol is a benign skip, not a failure. A cooldown-gated
  reconcile sweep now runs on its own on the existing supervisor (same single-consumer
  lock as the drains) instead of waiting for an update or manual repair. `devswarm logs`
  and `doctor --logs` now read rotated log history; the rotation lock records its owner
  instead of being stolen on age alone; the Primary's own unreadable inbox is surfaced
  instead of silently counting zero; the singleton supervisor unit now carries the same
  resolved `hivecontrol` path as the per-project units.
- **Guard-blocked native messaging** — `hivecontrol workspace message-child`/
  `message-parent` are unconditionally blocked and redirected to the mesh CLI, which is
  the sole agent-initiated messaging transport once DevSwarm is active.
- **Per-turn communication override + mesh-poll resting posture** — every role gets a
  per-turn reminder to poll the mesh instead of idling.
- **Idle self-wake (v0.59, `CronCreate`)** — no external signal can wake a genuinely idle
  Claude Code session
  ([anthropics/claude-code#44380](https://github.com/anthropics/claude-code/issues/44380)),
  so a SessionStart directive now tells a Claude workspace to self-schedule its own
  recurring mailbox-drain via the `CronCreate` tool (the only primitive that fires while
  the REPL is idle) — default `*/5 * * * *`, tunable via `ANTIHALL_DEVSWARM_WAKE_CRON`
  (validated against a strict cron charset; not a mechanism anti-hall itself runs). A
  bounded Stop-gate re-verify on both `devswarm-child-gate` and `devswarm-parent-gate`
  re-creates the job if it has auto-expired (recurring cron tasks self-delete after 7
  days). Claude-only by construction (`CronCreate` is a Claude tool); a Codex/non-Claude
  workspace gets the honest fallback instruction instead (drain every turn) and is never
  told to call a tool it doesn't have.
- **Workspace-tier orchestration doctrine (v0.59)** — a DevSwarm **Primary** is now
  proactively directed, at SessionStart and at both guard-block points, that its top
  fan-out tier is a **child workspace** (`devswarm.js spawn <branch> -p "<brief>"`), not a
  subagent. Injected doctrine only — there is no mechanical scale classifier (a false
  positive would break legitimate subagent use); the choice is the model's. A DevSwarm
  **child** workspace and any **non-DevSwarm** session see byte-identical behavior to
  before.
- **Thin lifecycle wrappers** — `spawn`/`merge` wrap `hivecontrol workspace create` /
  `check-merge`+`merge-into-source`, then auto-register/broadcast the result to the mesh;
  `reconcile` one-shot-drains every registered worktree's inbox (e.g. after a daemon
  outage) — auto-run since v0.58.1 by `doctor --fix` (GATED) and by `update`
  (DevSwarm-session-only), with the manual verb still available.
- **`archive-request`** — a direct store write asking a child to archive itself;
  archiving stays a human-confirmed handoff on both sides, never mechanical.
- **Supervisor escalate-on-urgent + liveness** — the opt-in supervisor also escalates to
  the parent on a high/urgent mesh unread; it still never kills anything itself. As of
  v0.67.1 this path actually delivers end-to-end (four stacked defects fixed — see above);
  delivery still requires the Primary to have self-registered from the true main worktree,
  else the escalation lands in `orphans[]` and only the informational parent-inbox hook
  (not the blocking parent-gate hook) surfaces it.
- **Optional per-project ingest daemon** — the one native consumer wrapping `hivecontrol
  workspace monitor` into the shared store, installed per project via
  `companion/install-devswarm-ingest.js`.

A second **interval companion** (not a hook), dormant with zero effect unless
[DevSwarm](https://devswarm.ai) is actually in use — feature-gated exactly like the OMC
integration above. It works around a `claude` session silently wedging (process alive,
listener dead, claude-code#39755) with three escalating layers, **none of which ever
kill anything**: a child workspace's own idle self-report, a supervisor **poke** (an
optional descriptor-supplied command) on a detected-stale workspace, then an
**escalate-to-parent** signal once the poke budget is exhausted (as of v0.67.1 this
signal actually reaches the parent's projection end-to-end — see the at-a-glance bullets
above for the four fixes and the remaining self-registration precondition). Killing lives
separately, on-demand only:

```bash
node plugins/anti-hall/companion/install-devswarm-supervisor.js              # install the automatic poke/escalate sweep
node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall  # remove
node plugins/anti-hall/companion/devswarm-recover.js <workspace-id>          # on-demand: the ONLY path that ever kills
```

macOS + Linux run the full sweep; **Windows is detection-only** for the automatic path,
and the on-demand CLI is escalate-only there too (the cwd confirm-gate that makes the
kill safe isn't obtainable in pure Node on Windows). anti-hall ships only the generic
supervisor — a DevSwarm-aware consumer publishes the workspace descriptor it sweeps.
Sweep thresholds are env-tunable (seconds; clamped, invalid/absent falls back to the
default): `ANTIHALL_DEVSWARM_IDLE_SEC` (900), `ANTIHALL_DEVSWARM_COOLDOWN_SEC` (600),
`ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` (2), `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` (180),
`ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` (120); the on-demand CLI resolves its own
`ANTIHALL_DEVSWARM_MAX_RECOVERIES` (3) and `ANTIHALL_DEVSWARM_GRACE_SEC` (5). See
[`plugins/anti-hall/README.md`](plugins/anti-hall/README.md#opt-in-companion-devswarm-layered-recovery-macos--linux-full-windows-detection-only).

Alongside the recovery companion, anti-hall ships a generic, project-agnostic **DevSwarm
coordination substrate** — also dormant unless DevSwarm is in use — that turns the
"Primary silently neglects its child workspaces" failure into a mechanical one. Four
feature-gated hooks are the trigger: `devswarm-parent-inbox` (surfaces each turn the real
unread/idle state of active workspaces + recommends archiving a completed one, plus a
live per-turn status table of every active workspace — status/finish-rate/unread/
last-activity, attention-needing rows first) and `devswarm-parent-gate` (blocks the
Primary from ending a turn while a child has REAL unread backlog — as of v0.61.1, noise
like a mirrored `[Primary poke]` is excluded via a shared classifier, closing a
ghost-workspace nag loop — or the supervisor judged it stale/escalated, except (v0.62.0)
a fresh heartbeat now overrides a stale/escalated verdict as definitive proof-of-life
**OR the Primary itself has unread parent/peer messages of its own**,
with the same imperative "STOP and read them FIRST" wording as the child gate — as of
v0.56.0 the Primary can no longer silently sit on its own inbound) on the Primary; `devswarm-child-turn` (turn-authored heartbeat +
reminder to report to the parent, plus a non-destructive surfacing of unread parent
messages from the child's own durable inbox — the drain that fills that inbox is the
CLI's `inbox pull`, a bounded guard-safe one-shot: non-destructive `message-count` gate
first, then at most one bounded `read-messages`, never `monitor` — surfaced as IMPERATIVE
PRIORITY wording, plus detection of a `[[ANTIHALL_ARCHIVE_REQUEST]]` marker in an unread
message, and mechanical per-turn descriptor registration so the parent can always discover
this child) and `devswarm-child-gate` (forced self-report before idling; v0.54.0's
heartbeat-freshness silencing was REVERTED in v0.54.1 — it false-silenced a child that
worked <5 min then stopped without reporting, so the gate always demands a report per
unchanged blocking state, bounded only by the per-episode cap `MAX_BLOCKS = 2`; STRICT mode
backs the durable-inbox check with a bounded native `message-count` probe) on a child. Two
roles hand off teardown, never mechanically: the Primary verifies merged/tested/deployed
per its own repo policy, then `devswarm.js archive-request <id>` asks the child to archive;
the child confirms with its own user, then runs `devswarm.js archive <id>`. They sit over a
dual-backend store
(`companion/lib/devswarm-store.js` — feature-detects `node:sqlite`, else an NDJSON
journal; hooks read only its `summary.json` projection, never the DB), a structured CLI
(`scripts/devswarm.js` — register/register-primary/heartbeat/inbox
[pull/read/count/ack/messages/read-primary/peek-primary]/workspaces/gate/nudge/archive/archive-request/migrate;
see `docs/KB-devswarm-hivecontrol.md` §8.8 for the full reference), a PER-PROJECT ingest
daemon (`companion/devswarm-ingest.js`, the one native consumer wrapping `hivecontrol
workspace monitor` into the store — install ONE per repo/worktree you want covered, via
`companion/install-devswarm-ingest.js`; auto-installed/refreshed by `/anti-hall:update`
inside an active DevSwarm session, but only for the repo the update runs in), and
auto-safe migration (idempotent, non-destructive, count-verified). Every raw
shell/`Read`-tool access to the durable inbox/store files (bypassing the durable
cursor) is guard-blocked in favor of the CLI. anti-hall stays agnostic: the
consumer owns its done-contract and calls the generic CLI. Run
`/anti-hall:system-briefing` for a live, derived map of the whole system.

**v0.57 mesh (SHIPPED in v0.58.0; Claude-side only — Codex/OMX mesh support is
deferred to v0.57.1).** Every worktree of one project now shares a SINGLE store keyed by
a readable `repoKey` (`sanitize(repo-name)-<6hex>` of the git common-dir's realpath, stable
across every linked worktree, hardened for Windows short-name/casing quirks) instead of a
store per worktree, so any worktree of the project can message any other directly
(all-to-all), not just its own parent/child. New daemon-independent CLI verbs: `send --to
<meshId>|--broadcast --message TEXT [--urgency low|normal|high|urgent]` (spoof-resistant
`--from`, fail-closed `--to`), `roster [--ack]`, `mesh read`, and `heartbeat --summary TEXT`
(also broadcasts a mesh status ping). The ingest daemon is now ONE per project (not per
worktree), reaping legacy per-worktree units before taking over; a two-signal (heartbeat
freshness + live-pid lock) health check backs both a stale-data banner and send-time
self-heal; a non-destructive migration folds old per-worktree stores into the new
per-project one; and a #36-STRUCTURAL fix scopes `devswarm-parent-gate`/
`devswarm-parent-inbox` to the caller's OWN project via `repoKey` (replacing a spoofable
env-var filter). Full reference: `docs/KB-devswarm-hivecontrol.md` §8.7's "v0.57 mesh
follow-up" note.

**v0.58 mesh-only messaging (SHIPPED in v0.58.0).** The mesh above is now the **sole**
agent-initiated messaging transport for DevSwarm — a REPLACE, not an addition: native
`hivecontrol workspace message-child`/`message-parent` are guard-blocked in all contexts
(`command-guard.js`, shared file — fires for Codex too, though the proactive per-turn
reminder to use the mesh instead stays Claude-only), redirecting to the CLI. New/changed
verbs: `send --to-primary` (direct to the registered Primary, fail-closed if none),
`reconcile` (one-shot drain of every registered worktree's inbox), `spawn`/`merge` (thin
pass-through wraps of `hivecontrol workspace create`/`check-merge`+`merge-into-source`,
then auto-register/broadcast), a `roster` fold of unregistered native children, and
`archive-request` revised from a hivecontrol send to a direct store write (zero
`hivecontrol` calls, `--child-branch` removed). Every DevSwarm role gets a per-turn
COMMUNICATION OVERRIDE re-assertion (mesh-poll RESTING posture = the Tier-0 wake
mechanism) — with an honest caveat carried straight from the design record: no external
mechanism wakes a genuinely idle Claude Code session (`anthropics/claude-code#44380`), so
a Tier-2 runner-wrap fallback is explicitly named as DEFERRED, not built. The liveness
supervisor additionally escalates-to-parent on an urgent/high mesh unread (still never
kills). The ingest daemon is unchanged; no MCP server was built (CLI-over-MCP stays the
rationale). Full reference: `docs/KB-devswarm-hivecontrol.md` §8.7's "v0.58 mesh-only
messaging" note.

**v0.93.0 app-side archive detection + attribution fixes.** hivecontrol 2.5.1's
`workspace list all` carries no archive field, so the supervisor sweep now caches the
active set (`hivecontrol-active.json`) whenever a list call succeeds; a registry row
absent from that cache by both id and worktree path, and stale by a 10-minute grace,
reads as app-archived while the cache stays fresh — liveness axis only, a genuine
unread question still gates. `computeSummary` additionally projects
`archivedRegistryRows`, so archived-but-still-live senders keep blocking (a question is
informational only when its sender has no registry row of any kind, active or
archived, and no descriptor). Pending-question sender attribution now excludes the
recipient's own identity family before ranking candidates, closing a bug where a reply
from the recipient itself (or a cross-linked twin) could wrongly clear someone else's
question. **Contract change:** `pendingQuestions[].from` is now the true sender's
identity-family id instead of the freshest live row on the worktree.

**v0.94.0 deterministic attribution + bounded reconcile.** When a worktree's meshId maps to
more than one sibling registry row, `pendingQuestions[].from` is now picked by a new pure,
liveness-free function of row values (`devswarm-attribution.js`'s `pickAttributionRow`:
real-sessionId row wins, then the branch-slug row, then ascending lexical id) instead of the
freshest-live picker used elsewhere — closing a bug where the same stored message could
report a different sender across summary passes. `reconcile` now bounds itself to a total
wall-clock budget (60s default, `ANTIHALL_RECONCILE_BUDGET_MS`, `0` = unlimited), skips a
row whose worktree is already gone before spawning, and defers whatever is left when the
budget runs out to a resume marker drained first next run. `update.js` prints per-stage
progress on stderr (`ANTIHALL_UPDATE_QUIET=1` silences it); its `devswarm-repokey.js` git
spawn now times out at 10s instead of hanging (this was the actual root cause of a real
update hang traced to a stray test-fixture worktree). `doctor --check` reports (never
deletes) leaked test-fixture stores, and a new hygiene test lints for the leak pattern.

**v0.95.0 diagnose descriptor fallback + unclaimed: promotion sources.** `diagnose`
resolves `sessionId` through the descriptor when the registry is stale, and reports a
`descriptorSessionId` field on disagreement instead of surfacing the stale registry value
as if it were current. `unclaimed:` promotion derives the caller's real session id from
`--session`, the `CLAUDE_CODE_SESSION_ID` env var, or — only for a row still carrying the
marker or lacking a sessionId — the harness's own session file found by walking the
caller's parent-pid chain, gated by a cwd-in-worktree check and a pid-reuse/staleness
liveness guard. Descriptor/registry divergence is repaired in both directions, and a
registry write failure during promotion is now reported as `promotion.registryWriteError`
on `inbox pull`/`read-primary`/`inbox messages` JSON output (plus a stderr line) instead of
being swallowed silently — the next read repairs the registry from the descriptor.

---

## Requirements

- **Node.js ≥ 22** on `PATH`. The hooks launch as `node <hook>.js`; without Node they
  silently no-op (intentional — a shell preflight can't reach a stock Windows box, so we
  omit it by design). Verify with `node --version`.
- That's it. No npm install, no native deps, no config.

---

## What's inside

```
anti-hall/
├── .claude-plugin/marketplace.json     # marketplace manifest
├── plugins/anti-hall/
│   ├── .claude-plugin/plugin.json      # plugin manifest — version is the sole authority
│   ├── hooks/                          # always-on Node hooks (+ hooks.json registration)
│   ├── skills/                         # root-cause · orchestration · deadly-loop · deadly-loop-multi · ship-it · install-statusline · doctor · system-briefing · update · flutter-debug · activate · simplify · debt · devswarm · handover · defects
│   ├── scripts/                        # shared pure-Node helpers — harvest-debt.js (debt-marker harvester behind /anti-hall:debt), migrate-state.js (folds legacy root state files into .anti-hall/history/legacy/, run by /anti-hall:update), capability-scan.js (read-only available-vs-active report for opt-in capabilities, run by /anti-hall:update), briefing.js (derived live system briefing behind /anti-hall:system-briefing), devswarm.js (the DevSwarm coordination CLI)
│   ├── companion/                      # opt-in mcp-reaper (macOS+Linux) — kills orphaned MCP processes; not a hook
│   │                                   #   + optional devswarm-supervisor (macOS+Linux full, Windows detection-only) + the DevSwarm substrate: lib/devswarm-store.js, devswarm-ingest.js (+ install-devswarm-ingest.js, auto-installed on update), devswarm-migrate.js
│   └── statusline/                     # two-line statusline: dispatcher + rich/simple/monorepo renderers + installer
├── AGENTS.md                           # prose Iron-Law mirror for Codex / cross-tool agents (copy into your repo)
├── docs/                               # KB + design notes — CONTEXT-PRESERVATION-KB · KB · TASKLIST-GUARD · TASK-WORK · E2E-TESTING (+ Claude Code internals)
├── tests/                              # zero-dependency node:test E2E suite (2944 tests, 2942 pass +2 platform-skip) — `node --test`
├── .github/workflows/test.yml          # CI: runs the suite on push/PR
└── CHANGELOG.md
```

**AGENTS.md** is a self-contained mirror of the discipline for tools that read
`AGENTS.md` (e.g. Codex). It lives at the repo root and is **not** bundled by
`/plugin install` — copy it into your own repo if you want cross-tool coverage.

A zero-dependency **`node --test` E2E suite** (`tests/`, 2942 passing +2 platform-skipped, 2944 total) covers the hooks and
runs in **CI** on every push/PR ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for the full component
reference, configuration, troubleshooting, and local testing.

---

## Updating

Ask Claude **"update anti-hall"** — the `/anti-hall:update` skill handles the full
update: pulls the latest, syncs the version-pinned cache, shows the changelog delta,
and instructs `/reload-plugins` for in-session reload. Alternatively, updates pull on
restart if autoUpdate is enabled (or via the `/plugin` manager —
optionally `/plugin marketplace update anti-hall` first). After pulling, the skill also
runs `node plugins/anti-hall/scripts/migrate-state.js` once per repo (idempotent) to fold
any legacy root-level `.anti-hall-progress.md` / `.anti-hall-history.md` into the dated
`.anti-hall/history/` structure.

---

## License

MIT © Mohammed Talas. See [LICENSE](LICENSE).

<div align="center">

<img src="assets/anti-hall-logo.png" alt="anti-hall logo" width="200">

# 🛡️ anti-hall

### Make Claude Code and Codex *verify before they claim* — with platform-native guardrails and workflow skills.

[![tests](https://github.com/talas9/anti-hall/actions/workflows/test.yml/badge.svg)](https://github.com/talas9/anti-hall/actions/workflows/test.yml) [![version](https://img.shields.io/github/v/tag/talas9/anti-hall?label=version)](https://github.com/talas9/anti-hall/releases) [![license](https://img.shields.io/github/license/talas9/anti-hall)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2) ![Codex port](https://img.shields.io/badge/Codex-port-111827)

A Claude Code **marketplace + plugin** plus a separate Codex-native port that installs always-on hooks where each platform supports them, evidence-driven workflow skills, and a live two-line statusline for Claude Code. Pure Node.js, no dependencies, runs on
**macOS · Linux · Windows**. The only prerequisite is Node ≥ 18 on `PATH`.

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
> are verified by 783 passing tests (+2 platform-skipped, 785 total) — they deterministically block force-pushes, AI-credit
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
| `command-guard` | PreToolUse/Bash | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload (`agent_id`), not env — works correctly under cmux and other wrappers. Per-segment (quote-aware split on `; && \|\| \|`), so `cd app && npm test` is not a bypass. Under a DevSwarm-active session it also redirects destructive native inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` blocks unconditionally (no-timeout long-poll), `read-messages` blocks only with durable-inbox evidence; quoted DATA mentions are not false-positives |
| `edit-guard` | PreToolUse/Write+Edit+MultiEdit+NotebookEdit | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`STATE.json`), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard`. Shares coordinator/subagent detection with `command-guard` via `coordinator-detect.js`. Fail-open |
| `model-routing-guard` | PreToolUse/Agent+Task | **Anti-waste routing.** Classifies spawn descriptions by keyword signals (mechanical vs complex) and nudges toward the cheapest model that fits the task shape. Emits an `additionalContext` advisory when an explicit flagship model (`opus`/`fable`) is paired with a purely mechanical task (fetch, grep, build, deploy, etc.). **Strict mode is now the default (v0.35.0+):** omitted-model mechanical spawns are blocked unconditionally — an omitted model inherits the orchestrator's, so on a flagship orchestrator this silently produces an all-flagship swarm. Set `ANTIHALL_MODEL_ROUTING=advisory` to opt out and revert to advisory-only for omitted-model spawns. Row-1 blocks (explicit flagship + mechanical) are downgraded to advisory when a debate role-word (`reviewer`/`auditor`/`critic`/`debate`/`deadly-loop`) appears in the spawn description — TRIO debate seats need flagship models. Fail-open on any error; never blocks unknown model tokens (forward-compat) |
| `swarm-guard` | PreToolUse/Agent+Task | Anti-fork-bomb: caps spawn rate (20/60 s) and refuses new agents under **real** memory pressure — measures reclaimable memory correctly on macOS (`vm_stat` free+inactive+speculative, correct 16 KB page size on Apple Silicon) and Linux (`/proc/meminfo` MemAvailable), not the misleading `os.freemem()`; a blocked spawn also logs one line to `~/.anti-hall/swarm-trips.log` (observation only — doesn't feed the rate window) |
| `task-guard` | Stop | Blocks stop when open tasks remain; counts only currently-open tasks (completed/cleared don't count); fail-open. **OMC-deference:** when `omc-detect.js` reports an oh-my-claudecode autonomous loop (ralph, ultrawork, autopilot, etc.) is active and fresh, the block is suppressed to an advisory — preventing a deadlock where the guard stops the loop it was meant to coexist with |
| `tasklist-guard` | Stop | Blocks stop when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh per-session progress file (`.anti-hall/progress/<date>/<session-id>.md`); coexists with `task-guard`; capped + fail-open — see [`docs/TASKLIST-GUARD.md`](./docs/TASKLIST-GUARD.md) |
| `task-tracker` | UserPromptSubmit | Captures every request as a task; throttled to avoid growing context; adds a one-line freshness note when open/stale tasks exist |
| `limit-conserve-inject` | UserPromptSubmit | **Limit-conservation mode.** Injects a token-conservation nudge when context usage reaches `ANTIHALL_LIMIT_THRESHOLD` (default 85%). `ANTIHALL_LIMIT_CONSERVE`: `auto` (default) reads the OMC usage cache; `on` forces the nudge; `off` disables. Auto requires OMC; without it, manual on/off only. **Account-aware:** deactivates if the logged-in Claude account changes and the usage cache hasn't refreshed under the new account yet, rather than apply a stale cross-account reading (kill-switch `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`). Skip-guard hatch: `limit-conserve` |
| `speculation-guard` | Stop (Tier 2) | Lexical: catches 15 hedge-word speculation markers; suppressed when the message contains evidence/uncertainty acknowledgment; block-once (never wedges) |
| `speculation-judge` | Stop (Tier 3, **OPT-IN**) | Semantic: calls an LLM to catch confident inference-as-fact with *no* hedge word — the gap Tier 2 can't close. Enable: `ANTIHALL_SEMANTIC_JUDGE=1` + `ANTHROPIC_API_KEY`. Model override: `ANTIHALL_JUDGE_MODEL=<alias-form id>` (default `claude-haiku-4-5`; use alias-form, not versioned snapshot IDs). Zero cost/latency when unset (the default). Fail-open |
| `ship-it-guard` | PreToolUse/Write+Edit+MultiEdit (**OPT-IN**, default OFF) | The only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root) — nudging the ship-it plan-first workflow. Also does a CONFORMANCE ADVISORY (never blocks): flags an edit outside every phase's declared `files:` list. Enforces artifact *existence* only (not plan quality), conservative (never gates ordinary edits), fail-open. Zero effect when unset (the default) |
| `merge-gate` | PreToolUse/Bash (**OPT-IN**, default OFF) | Backstops the "false done" discipline. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "do not merge" / "needs your eyes" / …) not followed by a resolution token ("owner signed off" / "verified against" / …). Keyword-heuristic, bypassable (alt syntax / heredoc / UI / API), fail-open, cannot hard-loop. A backstop, not a guarantee. Zero effect when unset (the default) |
| `phase-tracker` | PreToolUse/Agent+Task | Records every subagent spawn so line 2 shows live swarm activity with zero coordinator effort. It also writes a rolling `~/.anti-hall/agents/recent-spawn.json` heartbeat that `agentsRunning()` consumes, so the Stop guards know when parallel work is live. |
| `agent-watchdog` | CLI helper | Heartbeat enforcer: manually invoked by orchestration skill; polls agent state files; kills idle/hung agents; integrates with `phase.js` |
| `graphify-session` | SessionStart | Reminds to query the graph first when a `graphify-out/` graph exists |
| `graphify-guard` | PreToolUse/Grep+Glob+Bash | Blocks the *first* code-navigation search of a session and redirects to `/graphify query` when a graph exists. Segment/verb-aware — a substring like `echo /graphify && rg secret` doesn't exempt the search. Block-once per session; second call always allowed |
| `graphify-reminder` | Stop | One-time soft block reminding to keep the graph updated |
| `codex-nudge` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off |
| `version-alert` | SessionStart (non-blocking) | Alerts when a newer anti-hall version is available; reads running version vs a cached latest (`~/.anti-hall/version-check.json`); emits a one-line "vX available — /anti-hall:update" if behind. Cache refresh is DETACHED + unref'd — SessionStart never blocks on network. Off-switch: `ANTIHALL_VERSION_ALERT=off` |
| `fable-availability` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache `/model` renders from) once per session to detect whether Fable 5 is available — no live API probe. Silent unless available; when it is, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable 5 → Sonnet 5 → Opus. Fail-open |
| `codex-availability` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness. Registered on both the Claude plugin and the Codex port. Fail-open |
| `skip-guard` | Escape hatch (shared) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive `git-guard` (must be named explicitly) |

**🔵 On-demand (the skills).** Invoke as `/anti-hall:<name>`:

| Skill | Use it when | What it does |
|-------|-------------|--------------|
| **root-cause** | any bug, crash, flaky test, alert | evidence → hypothesis → instrument → prove the *original* root cause → fix → verify |
| **orchestration** | heavy/parallel/long work | non-blocking coordinator; fan out to subagents; watchdog + heartbeat; live phase statusline; **verify delegated work** (a subagent's "done/passing" is an unverified claim — re-check it against ground truth before marking complete) |
| **deadly-loop** | before merging anything risky | parallel **Reviewer + Auditor + Critic TRIO** debate + fix-waves, looping until zero *new* P0s or P1s. Three-phase swarm mode (Context → Duel → Converge) via `deadly-loop.workflow.js`; plain Agent-tool path available for no-consent sessions. On convergence, writes an ADVISORY `~/.anti-hall/approvals/<repo>@<sha>.json` record (`"proof": false` — not authorization; a real gate must still enforce its own check) |
| **deadly-loop-multi** | deeper review — double/triple/quadruple pass | N TRIO sets (Reviewer + Auditor + Critic per slot) with diversified lenses, then dedup + synthesize into one report |
| **ship-it** | any change, from a one-line fix to a multi-phase feature | one lean workflow scaled S/M/L to blast radius — brainstorm + plan **in plan mode** (ExitPlanMode is the gate), deadly-loop-hardened *before* code, large work fanned out as a Workflow swarm, each phase verified with fresh evidence + a vacuous-test guard until zero *new* P0s or P1s. **L tier:** resumable `.anti-hall/ship-it/<slug>/STATE.json` (per-phase status + escalation cap), P2 findings logged to `decisions.md`, Codex-primary/Sonnet-5-failover build seats (with a cross-model no-self-review guard), and an end-of-run session-history + `SUMMARY.md` + `graphify update .` |
| **install-statusline** | "install the statusline / add the bar" | writes the `statusLine` setting (global or per-repo), wraps an existing statusline as line 1 + adds anti-hall bar as line 2, with backup + restore. `--consolidate` merges with an existing statusline (e.g., OMC HUD) instead of replacing it; base persisted to `~/.anti-hall/consolidated-base.json`. Env: `ANTIHALL_STATUSLINE_BASE` |
| **doctor** | "is anti-hall working?" / after install/update | confirms Node ≥ 18, all hooks present + syntax-valid, **runs live behavioral self-tests** (spawns real guards with crafted payloads and asserts exit codes), reports context footprint in bytes + estimated tokens. **Env-aware:** also detects + tests OMC, Codex/OMX, and the DevSwarm liveness supervisor (installed-companion state + a per-workspace liveness self-test, `nudged` reads as WARN not FAIL), each silent and skipped when that integration isn't in play |
| **system-briefing** | "brief me on anti-hall" / "what's in this build" / "how does the whole system work" | a DERIVED (never hardcoded) live inventory for the agent that installs or operates anti-hall — every hook grouped by event with its one-line purpose (read from `hooks.json` + each file's own header), the shipped skills, the DevSwarm substrate (mechanical triggers · store · CLI · auto-safe migration), and a docs/KB map. Generated by `scripts/briefing.js` so it can't drift. The orientation companion to `doctor` (which answers "do the guards actually fire?") |
| **update** | "update anti-hall" / "is anti-hall up to date?" | `git pull --ff-only` the marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof), prints the changelog delta, then instructs `/reload-plugins` for in-session reload (hooks and statusline pick up from disk immediately; `/reload-plugins` refreshes the skill list and version label; rarely a restart is needed). Then runs a **dynamic capability scan** (read-only) reporting each opt-in capability this build ships — companions, statusline, pending state migrations — as available-vs-active on this machine, with the exact command to close any gap |
| **devswarm** | "explain the anti-hall DevSwarm integration" / "tune the liveness supervisor" / "recover a stuck workspace" | explains the four DevSwarm addons (hivecontrol reference KB, the designed-not-built workspace tier, the shipped layered recovery model, the on-demand recovery CLI) — the automatic path only detects → pokes → escalates and **never kills**; killing is on-demand only, via `devswarm-recover.js` — plus the full activation checklist + tunable env vars |
| **flutter-debug** | "debug my Flutter app" / "drive the iOS simulator / Android emulator" / "reproduce this bug in the app" / "fix and verify in the UI" | agent-driven Flutter debug loop (run + hot reload + **visually verified UI changes**); reproduces bugs → reads errors (exceptions / layout / logs / VM service) → roots cause → fixes → re-verifies with screenshots. iOS fully; Android run/reload/errors today, taps/screenshots pending FP7 probe. Delegates to the `flutter-debug` agent after zero-setup MCP + app-side marionette integration. Capability tier degradation (full-visual / coordinate-visual / error-only) announced per preflight |
| **activate** | "activate anti-hall" / "set up anti-hall" / "first-time setup" | one-shot idempotent first-run setup: checks & installs the statusline (user scope by default; offers project-scope on conflict), reports model-routing state (strict by default), writes a `~/.anti-hall/activated.json` sentinel, and prints a restart reminder if settings changed. **Never auto-invoked** — always user-triggered. Re-running is safe |
| **simplify** | "simplify this" / "deslop" / "trim the fat" / "this is over-engineered" | behavior-preserving simplification harvest on recently-changed (or named) code: tags each finding `delete:`/`stdlib:`/`native:`/`yagni:`/`shrink:`/`slop:`, applies the safe set, re-runs tests, and reports a single **measured** `net: -N lines` score (the real post-apply diff delta — never a projected estimate). Scope change ≠ simplification: declines anything that removes capability |
| **debt** | "track this debt" / "audit our debt" / "what shortcuts did we take" / "is this debt rotting" | register + auditor for **deliberate** technical debt via `// anti-hall: <ceiling>,<when>` markers (a budgeted, harvestable alternative to vague TODOs). Greps the tree (`scripts/harvest-debt.js`, pure Node), parses each ceiling + payback trigger, and flags **rot-risk** when a marker has no trigger or sits in code untouched past a staleness threshold. Not a license to skip real work |

> **root-cause** and **orchestration** are also enforced *always-on* as disciplines via the hook layer, alongside anti-sycophancy (challenge a wrong premise with evidence — never agree just to agree) and **scope & fidelity** (solve the actual problem with the simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked and drop nothing). Orchestration now also requires the coordinator to **independently verify delegated work** — a subagent's "done/passing" is an unverified claim, re-checked against ground truth before marking complete — and **defaults delegated heavy/parallel work to the background** (the coordinator passes `run_in_background` so the user needn't background it manually), while still verifying each on completion. **deadly-loop** and **ship-it** stay conditional, invoked on match.
>
> **Debate roster (TRIO):** Reviewer = Sonnet 5 (`model:"sonnet"`, effort `xhigh`); Auditor = latest Claude Opus (`model:"opus"`, divergent regression/coupling lens, effort `high`); Critic = latest OpenAI Codex at `xhigh` reasoning (Opus adversarial-persona fallback when Codex unavailable). All three dispatched in the same message for true parallelism. Model floor for fallback seats = Opus; never a cheaper model. Spawns use **tier tokens only** (`opus`/`sonnet`/`haiku`) — resolved to the newest available build at call time, never hardcoded version IDs. `sonnet` resolves to Sonnet 5 (`claude-sonnet-5`). See `plugins/anti-hall/skills/MODEL-POLICY.md`.

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
- `verify-first-full.js` (SessionStart) carries the full Iron-Law + orchestration protocol; `verify-first-subagent.js` (SubagentStart) re-injects the Iron Law into every spawned subagent (omitting the orchestration/delegate block so workers don't recurse); shared core in `verify-first-core.js`. `/anti-hall:doctor` reports the exact byte size of the SessionStart injection, so any footprint change stays visible and auditable.
- `/anti-hall:doctor` **measures** the context footprint — reports SessionStart / per-turn / per-Stop injection sizes in bytes + estimated tokens, so the cost is visible and auditable.

---

## 📊 The statusline

A live **two-line** statusline the plugin renders itself — installable globally or per-repo.

```
▊ my-repo · git-user · 🌿 main ~4 ?2 · Fable 5 (1M context) · ⏱ 71m · ● 56% ctx · $1.23
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

A second **interval companion** (not a hook), dormant with zero effect unless
[DevSwarm](https://devswarm.ai) is actually in use — feature-gated exactly like the OMC
integration above. It works around a `claude` session silently wedging (process alive,
listener dead, claude-code#39755) with three escalating layers, **none of which ever
kill anything**: a child workspace's own idle self-report, a supervisor **poke** (an
optional descriptor-supplied command) on a detected-stale workspace, then an
**escalate-to-parent** signal once the poke budget is exhausted. Killing lives
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
unread/idle state of active workspaces + recommends archiving a completed one) and
`devswarm-parent-gate` (blocks the Primary from ending a turn while a child has unread
backlog or the supervisor judged it stale/escalated) on the Primary; `devswarm-child-turn`
and `devswarm-child-gate` (turn-authored heartbeat + forced self-report to the parent) on a
child. They sit over a dual-backend store (`companion/lib/devswarm-store.js` — feature-detects
`node:sqlite`, else an NDJSON journal; hooks read only its `summary.json` projection, never
the DB) and a structured CLI (`scripts/devswarm.js` — register/heartbeat/inbox/gate/nudge/
archive/migrate), with auto-safe migration (idempotent, non-destructive, count-verified).
anti-hall stays agnostic: the consumer owns its done-contract and calls the generic CLI. Run
`/anti-hall:system-briefing` for a live, derived map of the whole system.

---

## Requirements

- **Node.js ≥ 18** on `PATH`. The hooks launch as `node <hook>.js`; without Node they
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
│   ├── skills/                         # root-cause · orchestration · deadly-loop · deadly-loop-multi · ship-it · install-statusline · doctor · system-briefing · update · flutter-debug · activate · simplify · debt · devswarm
│   ├── scripts/                        # shared pure-Node helpers — harvest-debt.js (debt-marker harvester behind /anti-hall:debt), migrate-state.js (folds legacy root state files into .anti-hall/history/legacy/, run by /anti-hall:update), capability-scan.js (read-only available-vs-active report for opt-in capabilities, run by /anti-hall:update), briefing.js (derived live system briefing behind /anti-hall:system-briefing), devswarm.js (the DevSwarm coordination CLI)
│   ├── companion/                      # opt-in mcp-reaper (macOS+Linux) — kills orphaned MCP processes; not a hook
│   │                                   #   + optional devswarm-supervisor (macOS+Linux full, Windows detection-only) + the DevSwarm substrate: lib/devswarm-store.js, devswarm-ingest.js, devswarm-migrate.js
│   └── statusline/                     # two-line statusline: dispatcher + rich/simple/monorepo renderers + installer
├── AGENTS.md                           # prose Iron-Law mirror for Codex / cross-tool agents (copy into your repo)
├── docs/                               # KB + design notes — CONTEXT-PRESERVATION-KB · KB · TASKLIST-GUARD · TASK-WORK · E2E-TESTING (+ Claude Code internals)
├── tests/                              # zero-dependency node:test E2E suite (785 tests, 783 pass +2 platform-skip) — `node --test`
├── .github/workflows/test.yml          # CI: runs the suite on push/PR
└── CHANGELOG.md
```

**AGENTS.md** is a self-contained mirror of the discipline for tools that read
`AGENTS.md` (e.g. Codex). It lives at the repo root and is **not** bundled by
`/plugin install` — copy it into your own repo if you want cross-tool coverage.

A zero-dependency **`node --test` E2E suite** (`tests/`, 783 passing +2 platform-skipped, 785 total) covers the hooks and
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

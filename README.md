<div align="center">

<img src="assets/anti-hall-logo.png" alt="anti-hall logo" width="200">

# 🛡️ anti-hall

### Make Claude Code *verify before it claims* — and ship the workflow skills that enforce it.

[![tests](https://github.com/talas9/anti-hall/actions/workflows/test.yml/badge.svg)](https://github.com/talas9/anti-hall/actions/workflows/test.yml) [![version](https://img.shields.io/github/v/tag/talas9/anti-hall?label=version)](https://github.com/talas9/anti-hall/releases) [![license](https://img.shields.io/github/license/talas9/anti-hall)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)

A Claude Code **marketplace + plugin** that installs always-on hooks, evidence-driven
workflow skills, and a live two-line statusline. Pure Node.js, no dependencies, runs on
**macOS · Linux · Windows**. The only prerequisite is Node ≥ 18 on `PATH`.

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

</div>

---

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
> are verified by 533 passing tests (+2 platform-skipped, 535 total) — they deterministically block force-pushes, AI-credit
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
| `git-guard` | PreToolUse/Bash | Blocks AI self-credit trailers (in `git commit` **and** in `gh pr/issue/release` `--body`/`--title`) and `--force` pushes (quote-aware, alias-resolving, won't false-block legit pushes) |
| `api-guard` | PreToolUse/Write+Edit+MultiEdit | **The mechanical answer to API hallucination.** Resolves `module.attribute` references in the code-to-be-written against the *installed* `python3`/`node` and blocks the write when a real stdlib/builtin module is missing the attribute (a fabrication). Default scope is **stdlib/builtins** (import-safe). **100% in-scope catch, 0 false positives** on a committed, reproducible bench (`node eval/api-guard-bench.js`). Opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also verifies installed **3rd-party** packages (off by default — verifying a package means importing it, which runs its code at edit time). A prompt can be ignored; a blocked Write cannot. Fail-open on any uncertainty; never probes local/relative modules; skip-hatch supported |
| `command-guard` | PreToolUse/Bash | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload (`agent_id`), not env — works correctly under cmux and other wrappers. Per-segment (quote-aware split on `; && \|\| \|`), so `cd app && npm test` is not a bypass |
| `model-routing-guard` | PreToolUse/Agent+Task | **Anti-waste routing.** Classifies spawn descriptions by keyword signals (mechanical vs complex) and nudges toward the cheapest model that fits the task shape. Default (advisory) mode emits an `additionalContext` advisory when an explicit flagship model (`opus`/`fable`) is paired with a purely mechanical task (fetch, grep, build, deploy, etc.), or when `model` is omitted (a missing model inherits the orchestrator's — on a flagship orchestrator that silently produces an all-flagship swarm). **Strict mode** (`ANTIHALL_MODEL_ROUTING=strict`) upgrades omitted-model mechanical spawns from advisory to an unconditional **block** — opt-in because a globally-exported strict blocks ALL projects including genuinely-cheap-orchestrator ones (blast-radius warning; remedy: set an explicit cheap model on the spawn, or unset strict). Enable strict only via the PROJECT's `.claude/settings.json` env block, not a global shell profile. Row-1 blocks (explicit flagship + mechanical) are downgraded to advisory when a debate role-word (`reviewer`/`auditor`/`critic`/`debate`/`deadly-loop`) appears in the spawn description — TRIO debate seats need flagship models. Fail-open on any error; never blocks unknown model tokens (forward-compat) |
| `swarm-guard` | PreToolUse/Agent+Task | Anti-fork-bomb: caps spawn rate (20/60 s) and refuses new agents under **real** memory pressure — measures reclaimable memory correctly on macOS (`vm_stat` free+inactive+speculative, correct 16 KB page size on Apple Silicon) and Linux (`/proc/meminfo` MemAvailable), not the misleading `os.freemem()` |
| `task-guard` | Stop | Blocks stop when open tasks remain; counts only currently-open tasks (completed/cleared don't count); fail-open. **OMC-deference:** when `omc-detect.js` reports an oh-my-claudecode autonomous loop (ralph, ultrawork, autopilot, etc.) is active and fresh, the block is suppressed to an advisory — preventing a deadlock where the guard stops the loop it was meant to coexist with |
| `tasklist-guard` | Stop | Blocks stop when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh `.anti-hall-progress.md`; coexists with `task-guard`; capped + fail-open — see [`docs/TASKLIST-GUARD.md`](./docs/TASKLIST-GUARD.md) |
| `task-tracker` | UserPromptSubmit | Captures every request as a task; throttled to avoid growing context; adds a one-line freshness note when open/stale tasks exist |
| `speculation-guard` | Stop (Tier 2) | Lexical: catches 15 hedge-word speculation markers; suppressed when the message contains evidence/uncertainty acknowledgment; block-once (never wedges) |
| `speculation-judge` | Stop (Tier 3, **OPT-IN**) | Semantic: calls an LLM to catch confident inference-as-fact with *no* hedge word — the gap Tier 2 can't close. Enable: `ANTIHALL_SEMANTIC_JUDGE=1` + `ANTHROPIC_API_KEY`. Model override: `ANTIHALL_JUDGE_MODEL=<alias-form id>` (default `claude-haiku-4-5`; use alias-form, not versioned snapshot IDs). Zero cost/latency when unset (the default). Fail-open |
| `ship-it-guard` | PreToolUse/Write+Edit+MultiEdit (**OPT-IN**, default OFF) | The only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root or `.planning/PLAN.md`) — nudging the ship-it plan-first workflow. Enforces artifact *existence* only (not plan quality), conservative (never gates ordinary edits), fail-open. Zero effect when unset (the default) |
| `merge-gate` | PreToolUse/Bash (**OPT-IN**, default OFF) | Backstops the "false done" discipline. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "do not merge" / "needs your eyes" / …) not followed by a resolution token ("owner signed off" / "verified against" / …). Keyword-heuristic, bypassable (alt syntax / heredoc / UI / API), fail-open, cannot hard-loop. A backstop, not a guarantee. Zero effect when unset (the default) |
| `phase-tracker` | PreToolUse/Agent+Task | Records every subagent spawn so line 2 shows live swarm activity with zero coordinator effort |
| `agent-watchdog` | CLI helper | Heartbeat enforcer: manually invoked by orchestration skill; polls agent state files; kills idle/hung agents; integrates with `phase.js` |
| `graphify-session` | SessionStart | Reminds to query the graph first when a `graphify-out/` graph exists |
| `graphify-guard` | PreToolUse/Grep+Glob+Bash | Blocks the *first* code-navigation search of a session and redirects to `/graphify query` when a graph exists. Segment/verb-aware — a substring like `echo /graphify && rg secret` doesn't exempt the search. Block-once per session; second call always allowed |
| `graphify-reminder` | Stop | One-time soft block reminding to keep the graph updated |
| `skip-guard` | Escape hatch (shared) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive `git-guard` (must be named explicitly) |

**🔵 On-demand (the skills).** Invoke as `/anti-hall:<name>`:

| Skill | Use it when | What it does |
|-------|-------------|--------------|
| **root-cause** | any bug, crash, flaky test, alert | evidence → hypothesis → instrument → prove the *original* root cause → fix → verify |
| **orchestration** | heavy/parallel/long work | non-blocking coordinator; fan out to subagents; watchdog + heartbeat; live phase statusline; **verify delegated work** (a subagent's "done/passing" is an unverified claim — re-check it against ground truth before marking complete) |
| **deadly-loop** | before merging anything risky | parallel **Reviewer + Auditor + Critic TRIO** debate + fix-waves, looping until zero *new* P0s. Three-phase swarm mode (Context → Duel → Converge) via `deadly-loop.workflow.js`; plain Agent-tool path available for no-consent sessions |
| **deadly-loop-multi** | deeper review — double/triple/quadruple pass | N TRIO sets (Reviewer + Auditor + Critic per slot) with diversified lenses, then dedup + synthesize into one report |
| **ship-it** | any change, from a one-line fix to a multi-phase feature | one lean workflow scaled S/M/L to blast radius — brainstorm + plan **in plan mode** (ExitPlanMode is the gate), deadly-loop-hardened *before* code, large work fanned out as a Workflow swarm, each phase verified with fresh evidence + a vacuous-test guard until zero *new* P0s |
| **install-statusline** | "install the statusline / add the bar" | writes the `statusLine` setting (global or per-repo), wraps an existing statusline as line 1 + adds anti-hall bar as line 2, with backup + restore |
| **doctor** | "is anti-hall working?" / after install/update | confirms Node ≥ 18, all hooks present + syntax-valid, **runs live behavioral self-tests** (spawns real guards with crafted payloads and asserts exit codes), reports context footprint in bytes + estimated tokens |
| **update** | "update anti-hall" / "is anti-hall up to date?" | `git pull --ff-only` the marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof), prints the changelog delta, then instructs `/reload-plugins` for in-session reload (hooks and statusline pick up from disk immediately; `/reload-plugins` refreshes the skill list and version label; rarely a restart is needed) |
| **flutter-debug** | "debug my Flutter app" / "drive the iOS simulator / Android emulator" / "reproduce this bug in the app" / "fix and verify in the UI" | agent-driven Flutter debug loop (run + hot reload + **visually verified UI changes**); reproduces bugs → reads errors (exceptions / layout / logs / VM service) → roots cause → fixes → re-verifies with screenshots. iOS fully; Android run/reload/errors today, taps/screenshots pending FP7 probe. Delegates to the `flutter-debug` agent after zero-setup MCP + app-side marionette integration. Capability tier degradation (full-visual / coordinate-visual / error-only) announced per preflight |

> **root-cause** and **orchestration** are also enforced *always-on* as disciplines via the hook layer, alongside anti-sycophancy (challenge a wrong premise with evidence — never agree just to agree) and **scope & fidelity** (solve the actual problem with the simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked and drop nothing). Orchestration now also requires the coordinator to **independently verify delegated work** — a subagent's "done/passing" is an unverified claim, re-checked against ground truth before marking complete — and **defaults delegated heavy/parallel work to the background** (the coordinator passes `run_in_background` so the user needn't background it manually), while still verifying each on completion. **deadly-loop** and **ship-it** stay conditional, invoked on match.
>
> **Debate roster (TRIO):** Reviewer = latest flagship Claude (`model:"fable"`, max thinking); Auditor = latest Claude Opus (`model:"opus"`, divergent regression/coupling lens); Critic = latest OpenAI Codex at max reasoning (Opus adversarial-persona fallback when Codex unavailable). All three dispatched in the same message for true parallelism. Model floor for every seat = Opus; never a cheaper model. Spawns use **tier tokens only** (`fable`/`opus`/`sonnet`/`haiku`) — resolved to the newest available build at call time, never hardcoded version IDs. See `plugins/anti-hall/skills/MODEL-POLICY.md`.

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
- `verify-first-full.js` (SessionStart) carries the full Iron-Law + orchestration protocol; `/anti-hall:doctor` reports its exact byte size, so any change to the footprint stays visible and auditable rather than hidden behind a fixed claim.
- `/anti-hall:doctor` **measures** the context footprint — reports SessionStart / per-turn / per-Stop injection sizes in bytes + estimated tokens, so the cost is visible and auditable.

---

## 📊 The statusline

A live **two-line** statusline the plugin renders itself — installable globally or per-repo.

```
▊ my-repo · git-user · 🌿 main ~4 ?2 · Fable 5 (1M context) · ⏱ 71m · ● 56% ctx · $1.23
[███████████◐────────] 56% context
```

- **Line 1 — rich & dynamic:** project, git (branch / worktree / stash / staged-modified-untracked / ahead-behind), model, effort, subagent count, session duration, context-window %, cost, and the GSD `.planning` phase when present.
- **Line 2 — always-on, three smart tiers:**
  1. **During an orchestration run** → live phase progress bar (`P2 · build api 2/5 · 3 agents`)
  2. **While a swarm is active** (auto, zero setup) → animated `orchestrating · N agents` (powered by `phase-tracker` recording every spawn)
  3. **Idle** → context-window gauge, color-coded green/yellow/red at ≤70/70-89/≥90%
- **`phase.js` — the progress writer:** the orchestrator calls `phase.js set/advance/step/agents/clear` as phases progress; the file writes `~/.anti-hall/phase-state.json`, which line 2 reads. Stale state (>30 min old) auto-hides so orphaned bars never linger.

Install it the easy way — just ask Claude **"install the statusline"** (the
`install-statusline` skill writes the setting, wraps any existing statusline as line 1 +
adds the anti-hall bar as line 2, with backup/restore) — or run the installer directly.
See [STATUSLINE.md](plugins/anti-hall/statusline/STATUSLINE.md). *Claude Code reads
`statusLine` only at startup, so restart once after installing.*

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
│   ├── skills/                         # root-cause · orchestration · deadly-loop · deadly-loop-multi · ship-it · install-statusline · doctor · update
│   ├── companion/                      # opt-in mcp-reaper (macOS+Linux) — kills orphaned MCP processes; not a hook
│   └── statusline/                     # two-line statusline: dispatcher + rich/simple/monorepo renderers + installer
├── AGENTS.md                           # prose Iron-Law mirror for Codex / cross-tool agents (copy into your repo)
├── docs/                               # KB + design notes — CONTEXT-PRESERVATION-KB · KB · TASKLIST-GUARD · TASK-WORK · E2E-TESTING (+ Claude Code internals)
├── tests/                              # zero-dependency node:test E2E suite (535 tests, 533 pass +2 platform-skip) — `node --test`
├── .github/workflows/test.yml          # CI: runs the suite on push/PR
└── CHANGELOG.md
```

**AGENTS.md** is a self-contained mirror of the discipline for tools that read
`AGENTS.md` (e.g. Codex). It lives at the repo root and is **not** bundled by
`/plugin install` — copy it into your own repo if you want cross-tool coverage.

A zero-dependency **`node --test` E2E suite** (`tests/`, 533 passing +2 platform-skipped, 535 total) covers the hooks and
runs in **CI** on every push/PR ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for the full component
reference, configuration, troubleshooting, and local testing.

---

## Updating

Ask Claude **"update anti-hall"** — the `/anti-hall:update` skill handles the full
update: pulls the latest, syncs the version-pinned cache, shows the changelog delta,
and instructs `/reload-plugins` for in-session reload. Alternatively, updates pull on
restart if autoUpdate is enabled (or via the `/plugin` manager —
optionally `/plugin marketplace update anti-hall` first).

---

## License

MIT © Mohammed Talas. See [LICENSE](LICENSE).

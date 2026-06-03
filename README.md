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
> are verified by 132 passing tests — they deterministically block force-pushes, AI-credit
> trailers, un-delegated heavy commands, and stale task state regardless of what the model
> "feels" like doing. The **prompt layer** (verify-first protocol + nudges) is a *discipline*,
> not a benchmark-validated hallucination cure: a four-round A/B eval ([`eval/`](eval/)) —
> including a fair run with a *naive* baseline that genuinely fabricates ~13% of the time —
> found **no net fabrication reduction from the prompt alone** (it fixed one trap and induced
> another, netting zero). That test deliberately disables tools, so it does not measure the
> protocol's *verification* half (running code / reading files to check a claim), which is
> plausibly where its value lies. Treat anti-hall as **guardrails + enforced discipline**, not
> a magic anti-hallucination switch. **Acting on that finding,** anti-hall ships `api-guard` —
> a mechanical hook that *does* verify, blocking fabricated stdlib/builtin APIs in code at a
> measured **~95% catch / ~0% false-positive** (vs the prompt's unproven ~18%). The lesson the
> eval taught, applied: **enforce mechanically, don't exhort.**

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
| `git-guard` | PreToolUse/Bash | Blocks AI self-credit trailers and `--force` pushes (quote-aware, alias-resolving, won't false-block legit pushes) |
| `api-guard` | PreToolUse/Write+Edit+MultiEdit | **The mechanical answer to API hallucination.** Resolves `module.attribute` references in the code-to-be-written against the *installed* `python3`/`node` and blocks the write when a real stdlib/builtin module is missing the attribute (a fabrication). Measured **~95% catch, ~0% false-positive**. A prompt can be ignored; a blocked Write cannot. Fail-open on any uncertainty (no interpreter, 3rd-party pkg, version skew); skip-hatch supported |
| `command-guard` | PreToolUse/Bash | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload (`agent_id`), not env — works correctly under cmux and other wrappers. Per-segment (quote-aware split on `; && \|\| \|`), so `cd app && npm test` is not a bypass |
| `swarm-guard` | PreToolUse/Agent+Task | Anti-fork-bomb: caps spawn rate (20/60 s) and refuses new agents under **real** memory pressure — measures reclaimable memory correctly on macOS (`vm_stat` free+inactive+speculative, correct 16 KB page size on Apple Silicon) and Linux (`/proc/meminfo` MemAvailable), not the misleading `os.freemem()` |
| `task-guard` | Stop | Blocks stop when open tasks remain; counts only currently-open tasks (completed/cleared don't count); fail-open |
| `tasklist-guard` | Stop | Blocks stop when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh `.anti-hall-progress.md`; coexists with `task-guard`; capped + fail-open — see [`docs/TASKLIST-GUARD.md`](./docs/TASKLIST-GUARD.md) |
| `task-tracker` | UserPromptSubmit | Captures every request as a task; throttled to avoid growing context; adds a one-line freshness note when open/stale tasks exist |
| `speculation-guard` | Stop (Tier 2) | Lexical: catches 15 hedge-word speculation markers; suppressed when the message contains evidence/uncertainty acknowledgment; block-once (never wedges) |
| `speculation-judge` | Stop (Tier 3, **OPT-IN**) | Semantic: calls an LLM to catch confident inference-as-fact with *no* hedge word — the gap Tier 2 can't close. Enable: `ANTIHALL_SEMANTIC_JUDGE=1` + `ANTHROPIC_API_KEY`. Zero cost/latency when unset (the default). Fail-open |
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
| **orchestration** | heavy/parallel/long work | non-blocking coordinator; fan out to subagents; watchdog + heartbeat; live phase statusline |
| **deadly-loop** | before merging anything risky | parallel **Reviewer + Critic** debate + fix-waves, looping until zero *new* P0s |
| **deadly-loop-multi** | deeper review — double/triple/quadruple pass | N Reviewer + N Critic pairs (half latest Opus, half latest Codex) with diversified lenses, then dedup + synthesize into one report |
| **feature-launch** | a non-trivial feature (multi-file / multi-phase) | plan-first, deadly-loop-hardened *before* code, executed phase-by-phase — with **AFK mode** and goal-anchor drift watcher |
| **install-statusline** | "install the statusline / add the bar" | writes the `statusLine` setting (global or per-repo), wraps an existing statusline as line 1 + adds anti-hall bar as line 2, with backup + restore |
| **doctor** | "is anti-hall working?" / after install/update | confirms Node ≥ 18, all hooks present + syntax-valid, **runs live behavioral self-tests** (spawns real guards with crafted payloads and asserts exit codes), reports context footprint in bytes + estimated tokens |

> **root-cause** and **orchestration** are also enforced *always-on* as disciplines via the hook layer, alongside anti-sycophancy (challenge a wrong premise with evidence — never agree just to agree). **deadly-loop** and **feature-launch** stay conditional, invoked on match.

---

## 🤖 AFK mode

`feature-launch` ships an **autonomous driver** for hands-off runs. The contract: it
**never returns to you or stops** — except for an *absolutely-destructive* hard gate
(force-push, prod deploy, data/branch/file deletion, financial action, secret/access
change). For everything else it **collects data instead of pausing**, and when it's
genuinely confused it runs a **deadly-loop** to resolve the decision adversarially rather
than waking you. A **goal-anchor drift watcher** re-checks work against the locked goal
each cycle and course-corrects on scope drift, only deviating when you explicitly redirect.
You leave; it ships phases and only surfaces what truly needs a human.

---

## 🧹 Context-protection discipline

A bloated orchestrator context degrades the model and induces the hallucination the plugin
is meant to prevent. anti-hall enforces this at two levels:

**For your agents:** the SessionStart protocol + per-turn nudges enforce:
- Delegate not just heavy *commands* but also **broad reads, Grep, Glob, and code-navigation searches** to subagents — inline only a specific known-file read.
- **Graphify-first:** query the graph before raw search and before feature-launch analysis.

**For itself:** the plugin minimizes its own footprint in your conversation:
- `task-tracker` is **throttled** — full directive once per ~6h window, one-liner after (~68% per-turn reduction, ≈693 B → ≈223 B steady-state).
- `verify-first-full.js` (SessionStart) carries the full Iron-Law + orchestration protocol; `/anti-hall:doctor` reports its exact byte size, so any change to the footprint stays visible and auditable rather than hidden behind a fixed claim.
- `/anti-hall:doctor` **measures** the context footprint — reports SessionStart / per-turn / per-Stop injection sizes in bytes + estimated tokens, so the cost is visible and auditable.

---

## 📊 The statusline

A live **two-line** statusline the plugin renders itself — installable globally or per-repo.

```
▊ my-repo · git-user · 🌿 main ~4 ?2 · Opus 4.8 (1M context) · ⏱ 71m · ● 56% ctx · $1.23
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
│   ├── skills/                         # root-cause · orchestration · deadly-loop · deadly-loop-multi · feature-launch · install-statusline · doctor
│   └── statusline/                     # two-line statusline: dispatcher + rich/simple/monorepo renderers + installer
├── AGENTS.md                           # prose Iron-Law mirror for Codex / cross-tool agents (copy into your repo)
├── docs/                               # KB + design notes — CONTEXT-PRESERVATION-KB · KB · TASKLIST-GUARD · TASK-WORK · E2E-TESTING (+ Claude Code internals)
├── tests/                              # zero-dependency node:test E2E suite (120 tests) — `node --test`
├── .github/workflows/test.yml          # CI: runs the suite on push/PR
└── CHANGELOG.md
```

**AGENTS.md** is a self-contained mirror of the discipline for tools that read
`AGENTS.md` (e.g. Codex). It lives at the repo root and is **not** bundled by
`/plugin install` — copy it into your own repo if you want cross-tool coverage.

A zero-dependency **`node --test` E2E suite** (`tests/`, 120 tests) covers the hooks and
runs in **CI** on every push/PR ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for the full component
reference, configuration, troubleshooting, and local testing.

---

## Updating

Updates pull on restart if autoUpdate is enabled (or via the `/plugin` manager —
optionally `/plugin marketplace update anti-hall` first).

---

## License

MIT © Mohammed Talas. See [LICENSE](LICENSE).

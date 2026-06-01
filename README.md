<div align="center">

# 🛡️ anti-hall

### Make Claude Code *verify before it claims* — and ship the workflow skills that enforce it.

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

---

## How it works — two layers

**🟢 Always-on (the hook layer).** These fire automatically — no invocation, every session:

- **Verify-first** — injects the full Iron-Law + rationalization-table protocol at
  `SessionStart` (re-fires after compaction so it survives long sessions), plus a varying
  one-line nudge on every prompt.
- **Guards that can't be talked around:**
  - `git-guard` — blocks AI self-credit commit trailers and silent `--force` pushes (quote-aware, won't false-block).
  - `command-guard` — keeps the **main thread** clean by blocking heavy commands in the coordinator and pushing them to subagents. *Subagent-aware even under terminal wrappers like cmux* (detects via the hook payload, not just env).
  - `swarm-guard` — anti-fork-bomb: caps spawn rate and refuses new agents under **real** memory pressure (measures reclaimable memory correctly on macOS/Linux, not the misleading `os.freemem()`).
  - `task-guard` / `task-tracker` — capture every request as a task; don't let work be silently dropped.
  - `speculation-guard` / `speculation-judge` — catch inference-stated-as-fact at stop time.
  - `phase-tracker` — records subagent spawns so the statusline can show live swarm activity automatically.
  - `graphify` hooks — nudge "query the knowledge graph first" when one exists.

**🔵 On-demand (the skills).** Invoke as `/anti-hall:<name>`:

| Skill | Use it when | What it does |
|-------|-------------|--------------|
| **root-cause** | any bug, crash, flaky test, alert | evidence → hypothesis → instrument → prove the *original* and root cause → fix → verify |
| **orchestration** | heavy/parallel/long work | non-blocking coordinator; fan out to subagents; watchdog + heartbeat; live phase statusline |
| **deadly-loop** | before merging anything risky | parallel **Reviewer + Critic** debate + fix-waves, looping until zero *new* P0s |
| **feature-launch** | a non-trivial feature (multi-file / multi-phase) | plan-first, deadly-loop-hardened *before* code, executed phase-by-phase — with **AFK mode** |
| **install-statusline** | "install the statusline / add the bar" | writes the statusLine setting (global or per-repo) + reminds you to restart |

> **root-cause** and **orchestration** are also enforced *always-on* as disciplines via the hook layer, alongside anti-sycophancy (challenge a wrong premise with evidence — never agree just to agree). **deadly-loop** and **feature-launch** stay conditional, invoked on match.

---

## 🤖 AFK mode

`feature-launch` ships an **autonomous driver** for hands-off runs. The contract: it
**never returns to you or stops** — except for an *absolutely-destructive* hard gate
(force-push, prod deploy, data/branch/file deletion, financial action, secret/access
change). For everything else it **collects data instead of pausing**, and when it's
genuinely confused it runs a **deadly-loop** to resolve the decision adversarially rather
than waking you. You leave; it ships phases and only surfaces what truly needs a human.

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
  2. **While a swarm is active** (auto, no setup) → animated `orchestrating · N agents`
  3. **Idle** → context-window gauge

Install it the easy way — just ask Claude **"install the statusline"** (the
`install-statusline` skill writes the setting, global or per-repo) — or run the installer
directly. See [STATUSLINE.md](plugins/anti-hall/statusline/STATUSLINE.md). *Claude Code
reads `statusLine` only at startup, so restart once after installing.*

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
│   ├── skills/                         # root-cause · orchestration · deadly-loop · feature-launch · install-statusline
│   └── statusline/                     # two-line statusline: dispatcher + rich/simple/monorepo renderers + installer
├── AGENTS.md                           # prose Iron-Law mirror for Codex / cross-tool agents (copy into your repo)
├── docs/                               # KB + design notes (incl. Claude Code internals)
└── CHANGELOG.md
```

**AGENTS.md** is a self-contained mirror of the discipline for tools that read
`AGENTS.md` (e.g. Codex). It lives at the repo root and is **not** bundled by
`/plugin install` — copy it into your own repo if you want cross-tool coverage.

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for the full component
reference, configuration, troubleshooting, and local testing.

---

## Updating

The marketplace entry has `autoUpdate` on, so a **restart** pulls the latest. To update
right now, use the `/plugin` manager (optionally `/plugin marketplace update anti-hall`
first).

---

## License

MIT © Mohammed Talas. See [LICENSE](LICENSE).

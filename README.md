<div align="center">

<img src="assets/anti-hall-logo.png" alt="anti-hall logo" width="200">

# 🛡️ anti-hall

### Make Claude Code and Codex *verify before they claim* — with platform-native guardrails and workflow skills.

[![tests](https://github.com/talas9/anti-hall/actions/workflows/test.yml/badge.svg)](https://github.com/talas9/anti-hall/actions/workflows/test.yml) [![version](https://img.shields.io/github/v/tag/talas9/anti-hall?label=version)](https://github.com/talas9/anti-hall/releases) [![license](https://img.shields.io/github/license/talas9/anti-hall)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen) ![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2) ![Codex port](https://img.shields.io/badge/Codex-port-111827)

</div>

<p align="center">
  <img src="assets/demo/anti-hall.gif" alt="Terminal demo: git-guard blocks a force-push and an AI self-credit commit trailer (exit 2), then the plugin install commands for Claude Code." width="820">
</p>

## What it does

- Stops your coding assistant from stating things it has not checked: invented library functions, "it works" without running anything, "done" with tasks still open.
- Blocks risky git actions outright: force-pushes, and AI credit lines in commit messages and GitHub PR/issue/release text.
- Keeps the main conversation responsive by pushing heavy commands and file edits to helper agents, and caps runaway agent spawning.
- Adds skills you can call by name for debugging to a proven root cause, reviewing risky changes, and writing a session handover.
- Works with Claude Code (plugin) and Codex (separate port). Pure Node, nothing else to install.

**Before and after.** An assistant, mid-task, runs a force-push to `main`. Without anti-hall, the published history is rewritten. With it, the command never runs and the assistant is told:

> anti-hall git-guard: BLOCKED. Force push detected. Rewriting published history is a deliberate human action - do it manually with explicit owner confirmation, never from an automated push.

anti-hall is a Claude Code **marketplace + plugin**, plus a separate Codex-native port,
that keeps coding assistants from acting before they verify. It ships always-on Node
hooks (mechanical guards no prompt can talk around), a set of evidence-driven workflow
skills, and a live two-line statusline. Pure Node.js, no dependencies, **macOS · Linux**
(Node ≥ 22 on `PATH` is the only prerequisite; Windows is not supported).

It targets four predictable failure modes: **eagerness** (acting before investigating),
**hallucination** (stating unverified facts as truth), **fix-before-diagnosis** (patching
a symptom before proving the cause), and **fake completion** ("done" without running the
check). See [why it exists, and what's proven vs. not](docs/GUIDE.md#hook-reference-detailed)
for the eval behind that claim.

## What it blocks, and how to turn it off

The main guards. Every one can be switched off with its setting (`/anti-hall:settings`, the `/config` panel, or `node plugins/anti-hall/scripts/settings.js set <key> false`). The four `safety.*` keys are locked: changing them needs `--confirmed`. Separately, you can tell the assistant to skip a guard for a short time; it records that in `~/.anti-hall/skip.json` (per guard name, expires after 15 minutes by default; `"all"` never covers `git-guard`, which must be named).

| Guard | What it stops | Why | Turn off |
|---|---|---|---|
| `git-guard` | Force-push and AI self-credit in commits and `gh` PR/issue/release text | Rewriting published history and AI co-author trailers are human decisions | `safety.gitGuard`; skip name `git-guard` |
| `command-guard` | The main session running heavy commands (build, test, deploy, push) itself | Keeps the main conversation free; helpers do the long work | `safety.commandGuard`; skip name `command-guard` |
| `edit-guard` | The main session editing files outside its own plan/state/handover files | Edits go through a helper that can be checked | `safety.editGuard`; skip name `edit-guard` |
| `swarm-guard` | Agent spawns past the spawn-rate cap or under critical memory pressure | Prevents a fork-bomb of agents overloading the machine | `safety.swarmGuard`; skip name `swarm-guard` |
| `api-guard` | Written code that calls a standard-library or built-in API that does not exist | Catches invented functions before they land | `guards.apiGuard`; skip name `api-guard` |
| `speculation-guard` | A turn that ends on unverified, hedged claims | Claims need evidence, not "probably" | `guards.speculationGuard`; skip name `speculation-guard` |
| `output-verify-guard` | Unverified completion claims | "Done" needs a check that was actually run | `guards.outputVerifyGuard` |
| `task-guard` / `tasklist-guard` | Stopping while tracked tasks are open; multi-step work with no task list or progress file | Stops half-finished work being reported as finished | `guards.taskGuard` / `guards.tasklistGuard`; skip names `task-guard` / `tasklist-guard` |

Everything else, with the exact behaviour of each hook: [docs/GUIDE.md](docs/GUIDE.md#hook-reference--plugin-features-table-detailed-per-hook).

## Network and data

No telemetry or analytics. Full detail: [PRIVACY.md](PRIVACY.md).

| Feature | Default | Sends to | What |
|---|---|---|---|
| Update check | On | github.com/talas9/anti-hall (`git ls-remote --tags`) | A tag-list request, no project data. Off: `versionAlerts.antiHall` or `ANTIHALL_VERSION_ALERT=off` |
| Jev classifier | Off | ai-gateway.vercel.sh or api.typesafe.ai (both, only if `jev.fallbackTransport` is set: a failed call is retried once on the second vendor) | May include prompts, assistant text, test output, commit text, file paths (4000-8000 chars per call); secrets matching known token shapes are redacted before sending (best-effort; short or unlabelled secrets may not be caught). Off: `jev.enabled` or `ANTIHALL_JEV=0` |
| Semantic judge | Off | api.anthropic.com | Last assistant message (up to 8000 chars). Enabled only by `ANTIHALL_SEMANTIC_JUDGE=1` |
| Mesh message triage | Off (needs Jev) | Jev, then api.anthropic.com if an Anthropic key is available | DevSwarm message text |

API keys come from sensitive plugin options; reading a key from the environment or a key file is opt-in (`jev.allowLegacyKeyRead`, `guards.allowAnthropicEnvKey`), and the Jev endpoint override is loopback-only.

Everything else (logs, handovers, defect reports) stays in `~/.anti-hall/` and `<repo>/.anti-hall/`. `gh`, `codex` and `hivecontrol` run under your own accounts; the plugin does not spawn `gh` or `codex`.

## Install

Prerequisite: **Node.js >= 22** on `PATH` (check with `node --version`).

**Claude Code:**

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

**Codex** (from scratch; the installer lives in the repo, so clone it first):

```bash
git clone https://github.com/talas9/anti-hall.git
cd anti-hall
node plugins/anti-hall/codex/install-codex.js            # project-local: writes ./.codex/hooks.json
node plugins/anti-hall/codex/install-codex.js --global   # or user-wide: writes ~/.codex/hooks.json
```

Add `--dry-run` to preview. The installer merges into an existing `hooks.json`, backs up any file it changes (`.bak-<timestamp>`), and enables `[features] hooks = true` in the matching `config.toml`.

### Enable Jev

<!-- jev-recommend:start -->
> **Recommended: enable Jev, the optional classifier, for more accurate guards.**
>
> Without it, guards such as the speculation check rely on pattern matching alone. With Jev on, they also get a model's second opinion: by default it can only add blocks the patterns miss (it never removes one), and nine integrations are on by default once it is enabled (speculation, message triage, duplicate-finding grouping, dispatch-tier hints, five DevSwarm supervision labels).
>
> Measured so far: one offline check (2026-09, 65 deadly-loop finding pairs from 3 projects) had Jev's duplicate-finding judgments 65/65 correct at confidence >= 0.85, against 45% precision for a same-file proximity heuristic. That is one narrow task; no end-to-end accuracy figure exists for the other guards yet ([`KB-jev-classifier.md`](docs/KB-jev-classifier.md), section 7).
>
> **Costs:** optional and off by default; needs your own Vercel AI Gateway or TypeSafe API key; sends the text a guard judges (prompts, assistant messages, test output, commit text; up to 8000 characters per call, known secret shapes redacted on a best-effort basis) to the provider you choose; uses provider credits. Details: [PRIVACY.md](PRIVACY.md).
>
> Enable: say "activate jev" (runs the `jev` skill: stores your key, enables, tests). Silence the session-start reminder: set `jev.recommendNotice` to false.
<!-- jev-recommend:end -->

**Git-ignore the state directory:** anti-hall writes per-project session notes (progress, history, handovers, reports) under `.anti-hall/` in your repo, and never edits your tracked files. Add `.anti-hall/` to your project's `.gitignore` so a `git add .` can't commit them (or run `/anti-hall:doctor --repair`, which appends it to the untracked `.git/info/exclude`).

**Verify it worked:** in Claude Code, ask "is anti-hall working" (runs the `doctor` skill: live self-tests on every guard), or run `/anti-hall:settings` to see the active settings. From a clone you can also run `node plugins/anti-hall/hooks/doctor.js --check`.

The Claude plugin is the authoritative package; the Codex port
(`plugins/anti-hall/codex/`) is a separate, intentionally non-1:1 mirror — see
[plugins/anti-hall/codex/README.md](plugins/anti-hall/codex/README.md) for hook parity
and [docs/GUIDE.md](docs/GUIDE.md) for the full Codex/OMX detail.

## Uninstall

**Claude Code:**

```bash
claude plugin uninstall anti-hall@anti-hall
claude plugin marketplace remove anti-hall   # optional: also drop the marketplace
```

If you installed the statusline, remove it first with the `install-statusline` skill's uninstall, or run `node statusline/uninstall-statusline.js` from the plugin directory (it restores your previous `statusLine`).

**Codex:** the installer has no uninstall flag. Open `.codex/hooks.json` (project) or `~/.codex/hooks.json` (global) and delete the hook groups whose command path contains `/plugins/anti-hall/hooks/`; the installer's `.bak-<timestamp>` copies hold your prior file. The `[features] hooks = true` line it added to `config.toml` is left alone.

**Optional companions** (only if you installed them; run from `plugins/anti-hall/companion/` in a clone or the plugin directory):

```bash
node install-reaper.js --uninstall                # MCP orphan reaper (macOS LaunchAgent com.anti-hall.mcp-reaper / Linux systemd --user timer)
node install-devswarm-supervisor.js --uninstall   # DevSwarm liveness supervisor (com.anti-hall.devswarm-supervisor)
node install-devswarm-ingest.js --uninstall       # DevSwarm ingest daemon (com.anti-hall.devswarm-ingest)
```

`~/.anti-hall/` holds your settings, skip file and logs; it is not removed automatically. Delete it yourself only if you want that state gone.

## Requirements

**Node.js ≥ 22 on `PATH`.** Every hook and the statusline are pure Node (built-ins
only), launched as `node <hook>.js`. No `node` on the hook shell's `PATH` means Claude
Code silently skips every anti-hall hook — verify with `node --version`. No npm
install, no native deps, no other config.

**`/config` rows need Claude Code ≥ 2.1.269; older versions still work via the skill.**
The plugin's `userConfig` never declares `options` (a public plugin can't require v2.1.271+
just for its settings UI — per the Claude Code plugin docs, an `options` picker would break
loading on older versions), so every version can load the plugin; enum settings just render
as a plain string field describing the allowed values instead of a picker.

## Capabilities

Terms used below: **DevSwarm** is a multi-workspace orchestration app with a `hivecontrol` CLI; anti-hall's integration is optional and dormant unless you use it. **Jev** is TypeSafe's "System One" decision model, used as an opt-in classifier. **deadly-loop** is a parallel Reviewer + Auditor + Critic debate with fix waves, run before merging risky changes.

| Area | What it does |
|---|---|
| **Guards** | Mechanical, always-on Node hooks — block AI self-credit/force-push (`git-guard`), fabricated stdlib/builtin APIs (`api-guard`), un-delegated heavy commands (`command-guard`), un-delegated direct edits (`edit-guard`), spawn-rate/memory fork-bombs (`swarm-guard`), stopping with open tasks (`task-guard`/`tasklist-guard`), and more. |
| **Verify-first discipline** | Injects the Iron-Law + rationalization-table protocol at session start (survives compaction) and a rotating one-line nudge every turn; enforced, not just suggested. |
| **Orchestration** | Non-blocking coordinator discipline: delegate heavy/broad work to subagents, verify delegated "done" claims against ground truth, live phase progress on the statusline. |
| **Auto-handover** | On by default: at 85% context the agent writes a handover itself, tells you, and suggests `/compact` or `/clear`; short follow-up reminders after that. Configure via `/anti-hall:settings`. |
| **DevSwarm mesh** | Optional, dormant unless a DevSwarm session is active — layered wake/recovery (self-report → poke → escalate, never auto-kill), one mailbox per session, per-turn mesh status. The DevSwarm app's own database is the ground truth for workspace state; done workspaces are auto-archived (DevSwarm ≥ 2.5.3), old message bodies are archived then pruned. See [`docs/KB-devswarm-hivecontrol.md`](docs/KB-devswarm-hivecontrol.md) and [`docs/KB-devswarm-app-db.md`](docs/KB-devswarm-app-db.md). |
| **Jev classifier** | Optional LLM-backed speculation classifier ([`docs/KB-jev-classifier.md`](docs/KB-jev-classifier.md)) — per-integration on/shadow/off modes, metrics + `jev report` KEEP/REVIEW/REMOVE calls. |
| **Statusline** | Live two-line statusline: git/model/context/cost on line 1, live orchestration/context gauge on line 2. Installable globally or per-repo, consolidates with an existing statusline (e.g. OMC HUD). |
| **doctor / update** | `doctor` runs live behavioral self-tests on every guard and repairs safe drift; `update` pulls the latest release and shows the changelog delta. Repairs also run by themselves after a plugin reload or on a new version. |
| **Settings** | One place for every setting — `~/.anti-hall/settings.json`, every non-advanced setting is an arrow-key row in Claude Code's native `/config` panel (anti-hall rows, section-prefixed titles); or tell `/anti-hall:settings` "set X to Y". See [docs/GUIDE.md#settings-anti-hallsettings](docs/GUIDE.md#settings-anti-hallsettings). |

Full per-hook reference (event, exact behavior, version history): [docs/GUIDE.md](docs/GUIDE.md#hook-reference--plugin-features-table-detailed-per-hook).

## Skills

Invoke any of these as `/anti-hall:<name>`:

| Skill | One line |
|---|---|
| `root-cause` | Evidence → hypothesis → instrument → prove the root cause → fix → verify. |
| `orchestration` | Non-blocking coordinator: fan out to subagents, verify delegated work before trusting it. |
| `deadly-loop` | Parallel Reviewer + Auditor + Critic debate + fix-waves before merging anything risky. |
| `deadly-loop-multi` | Double/triple/quadruple deadly-loop for deeper review. |
| `ship-it` | One workflow, scaled to size: plan in plan mode, deadly-loop-harden, build, verify each phase. |
| `install-statusline` | Installs the two-line statusline (global or per-repo), with backup/restore. |
| `doctor` | "Is anti-hall working?" — live self-tests on every guard, `--repair` for safe auto-fixes. |
| `system-briefing` | The agent-facing operator guide (terms, rules, every verb and setting) plus a live inventory of what this build ships. |
| `update` | Updates anti-hall and prints the changelog delta. |
| `flutter-debug` | Agent-driven Flutter debug loop with hot reload and visual verification. |
| `activate` | One-shot first-run setup (statusline, model routing, sentinel). |
| `simplify` | Behavior-preserving simplification pass with a measured `net: -N lines` score. |
| `debt` | Tracks and audits deliberate technical debt markers for rot risk. |
| `devswarm` | Explains and tunes the optional DevSwarm mesh integration. |
| `handover` | Writes a lossless session handover so a fresh session can resume cold. |
| `defects` | File/list/show/rule on anti-hall's own defect reports. |
| `jev` | Say "activate jev" — asks for your Vercel AI Gateway or TypeSafe key, installs it, enables and tests it. |
| `settings` | Show or change any anti-hall setting — one unified `~/.anti-hall/settings.json`, browsable via `show`/`get`/`set`/`reset`. |

Codex mirrors live under `plugins/anti-hall/codex/skills/anti-hall-*`; full descriptions
and the DevSwarm/statusline/context-protection detail behind each skill are in
[docs/GUIDE.md](docs/GUIDE.md#skills-reference-detailed).

## Documentation

Full index with more detail: [`docs/README.md`](docs/README.md). Every doc under
`docs/`, grouped by topic, one line each:

**Guides**

| Doc | What it covers |
|---|---|
| [`docs/KB.md`](docs/KB.md) | Canonical knowledge-base index — current-plugin ground truth, topic → doc map, staleness ledger. Read this first. |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Extended guide — hook reference, skills reference, statusline/config/troubleshooting, contributing. |
| [`docs/E2E-TESTING.md`](docs/E2E-TESTING.md) | How the zero-dependency `node:test` hook suite works; per-event I/O contract. |
| [`docs/TASK-WORK.md`](docs/TASK-WORK.md) | Task discipline design (`TaskCreate`/`TaskUpdate` vs legacy `TodoWrite`); basis for tasklist-guard. |
| [`docs/TASKLIST-GUARD.md`](docs/TASKLIST-GUARD.md) | Usage guide for the `tasklist-guard` Stop hook: progress/history file convention, env knobs, escape hatch. |

**Knowledge base (KB-\*)**

| Doc | Topic |
|---|---|
| [`docs/KB-claude-codex.md`](docs/KB-claude-codex.md) | Backbone synthesis — hooks, plugins, prompting, Codex, orchestration, anti-hallucination evidence. |
| [`docs/KB-claude-code-hooks.md`](docs/KB-claude-code-hooks.md) | Claude Code's hook system reference. |
| [`docs/KB-claude-code-harness-features.md`](docs/KB-claude-code-harness-features.md) | Full harness feature surface vs what anti-hall actually uses; gap list. |
| [`docs/KB-claude-workflow-orchestration.md`](docs/KB-claude-workflow-orchestration.md) | When/how to use the `Workflow` tool vs a single/shallow agent. |
| [`docs/KB-claude-monitor-tool.md`](docs/KB-claude-monitor-tool.md) | The `Monitor` tool for event-driven orchestration. |
| [`docs/KB-codex-platform-hooks-plugins.md`](docs/KB-codex-platform-hooks-plugins.md) | Codex platform hooks, plugins, skills, customization. |
| [`docs/KB-codex-workflow-orchestration.md`](docs/KB-codex-workflow-orchestration.md) | Codex workflow orchestration, subagents, Workflow/swarm equivalents. |
| [`docs/KB-codex-vs-opus-coding.md`](docs/KB-codex-vs-opus-coding.md) | Codex (GPT-5.x) vs Claude Opus for coding — division of labor. |
| [`docs/KB-omc.md`](docs/KB-omc.md) | oh-my-claudecode (OMC) — Claude-side orchestration layer. |
| [`docs/KB-omx.md`](docs/KB-omx.md) | oh-my-codex (OMX) — Codex-side orchestration layer. |
| [`docs/KB-devswarm-hivecontrol.md`](docs/KB-devswarm-hivecontrol.md) | DevSwarm & the `hivecontrol` CLI — multi-workspace orchestration. |
| [`docs/KB-devswarm-app-db.md`](docs/KB-devswarm-app-db.md) | The DevSwarm desktop app's database: what anti-hall reads (read-only), field evidence, sync. |
| [`docs/KB-cmux.md`](docs/KB-cmux.md) | cmux — terminal workspace for AI coding agents. |
| [`docs/KB-fable-5.md`](docs/KB-fable-5.md) | Claude Fable 5 model reference. |
| [`docs/KB-sonnet-5.md`](docs/KB-sonnet-5.md) | Claude Sonnet 5 + model routing, Claude and Codex tables. |
| [`docs/KB-gpt-5.6.md`](docs/KB-gpt-5.6.md) | GPT-5.6 (Sol/Terra/Luna) model reference. |
| [`docs/KB-model-modes.md`](docs/KB-model-modes.md) | Model operating modes — effort levels, Plan Mode, Workflow/ultracode, Codex reasoning tiers. |
| [`docs/KB-token-usage-models.md`](docs/KB-token-usage-models.md) | Token usage & cost mechanics across effort tiers, Claude + Codex. |
| [`docs/KB-jev-classifier.md`](docs/KB-jev-classifier.md) | Jev (TypeSafe System One) opt-in classifier: every wired integration, metrics, cost and budget watch. |
| [`docs/KB-goal-setting.md`](docs/KB-goal-setting.md) | Goal setting theory + AI-agent goal misspecification as a reward-hacking cause. |
| [`docs/KB-false-completion.md`](docs/KB-false-completion.md) | False task completion — reward hacking, claimed-vs-verified gaps, mitigations. |
| [`docs/KB-overengineering.md`](docs/KB-overengineering.md) | Overengineering causes and measurement; anti-hall's scope-fidelity implications. |
| [`docs/KB-session-handover.md`](docs/KB-session-handover.md) | AI-agent session handover design; backs the `handover` skill. |
| [`docs/KB-handover-research.md`](docs/KB-handover-research.md) | Handover research refresh: compaction loss, context rot, trigger points, Claude Code + Codex compaction/hook facts. |
| [`docs/KB-flutter-claude-debug.md`](docs/KB-flutter-claude-debug.md) | Research backing the `flutter-debug` skill. |
| [`docs/CONTEXT-PRESERVATION-KB.md`](docs/CONTEXT-PRESERVATION-KB.md) | Slowing main-agent context growth — caching, sub-agent isolation, compaction, JIT retrieval. |
| [`docs/CODEX-KB-MIGRATION-MAP.md`](docs/CODEX-KB-MIGRATION-MAP.md) | Cross-reference between Claude-side and Codex-side KB docs. |

**Reference / design**

| Doc | What it covers |
|---|---|
| [`docs/opus-4-8-features.md`](docs/opus-4-8-features.md) | Claude Opus 4.8 feature reference (context window, effort, thinking, pricing). |
| [`docs/opus-4-8-swarm.md`](docs/opus-4-8-swarm.md) | Multi-agent orchestration on Opus 4.8 — Dynamic Workflows, Managed Agents. |
| [`docs/gsd-distilled.md`](docs/gsd-distilled.md) | GSD phase model, distilled; the phase loop `ship-it` borrows from. |
| [`docs/superpowers-planning.md`](docs/superpowers-planning.md) | Distillation of the superpowers skill set; Iron-Law + rationalization-table pattern. |
| [`docs/keynote-prompting-claude.md`](docs/keynote-prompting-claude.md) | Distilled notes from two Anthropic prompting talks. |
| [`docs/keynote-transcript.md`](docs/keynote-transcript.md) | Reconstructed transcript of the Prompting 101 talk. |
| [`docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md`](docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md) | Approved design — DevSwarm-aware workspace-tier orchestration. |
| [`docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`](docs/superpowers/plans/2026-07-06-devswarm-orchestration.md) | Implementation plan for the design above. |
| [`docs/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md`](docs/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md) | Design — DevSwarm liveness supervisor (wedged-session recovery). |
| [`docs/superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md`](docs/superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md) | Implementation plan for the liveness supervisor. |
| [`docs/superpowers/specs/2026-08-01-harness-feature-adoption.md`](docs/superpowers/specs/2026-08-01-harness-feature-adoption.md) | Harness-feature adoption plan derived from `KB-claude-code-harness-features.md`. |

**Archive / history** — frozen, dated records, never edited to match current code:

| Doc | What it is |
|---|---|
| [`docs/AUDIT-REPORT.md`](docs/AUDIT-REPORT.md) | 4-auditor review, `v0.7.0`-era. Superseded; findings applied. |
| [`docs/AUDIT-REPORT-2.md`](docs/AUDIT-REPORT-2.md) | Double deadly-loop final gate, `v0.11.1 → v0.11.2`. Superseded; findings applied. |
| [`docs/PLUGIN-REVIEW.md`](docs/PLUGIN-REVIEW.md) | KB-driven plugin audit that prescribed the cadence redesign. Superseded; shipped. |
| [`docs/ULTRAPLAN.md`](docs/ULTRAPLAN.md) | Single consolidated reconciliation plan, `v0.3.0`-era. Superseded; executed. |
| [`docs/2026-06-06-context-opt-test-design.md`](docs/2026-06-06-context-opt-test-design.md) | Dated context-optimization test-harness design. |
| [`docs/2026-06-10-v0.32.0-fable5-model-routing-plan.md`](docs/2026-06-10-v0.32.0-fable5-model-routing-plan.md) | Dated v0.32.0 design plan (Fable 5 support, model-routing guard). |
| [`docs/2026-06-10-v0.34.0-flutter-debug-plan.md`](docs/2026-06-10-v0.34.0-flutter-debug-plan.md) | Dated v0.34.0 design plan (flutter-debug agent + skill). |
| [`docs/archive/devswarm-layered-recovery-history.md`](docs/archive/devswarm-layered-recovery-history.md) | DevSwarm layered-recovery version history (v0.54–v0.107), moved out of GUIDE in v0.108.0. |

Codex port: [`plugins/anti-hall/codex/README.md`](plugins/anti-hall/codex/README.md) — hook parity, install, skills.

## Troubleshooting

- **Hooks not firing?** Run `node --version` — if `node` isn't on the hook shell's
  `PATH`, every hook silently no-ops. Ask Claude "is anti-hall working" (`doctor`).
- **Guard blocking something legitimate?** Most guards fail open and have a skip hatch
  (`~/.anti-hall/skip.json`, per-guard, TTL'd) — `git-guard` must be named explicitly.
- **Statusline not showing?** Restart Claude Code once after installing — `statusLine`
  is only read at startup.
- **Update didn't take effect?** Run `/reload-plugins` after `/anti-hall:update`. Restart Claude Code only if a hook
  or skill path still shows the old version afterwards (or to re-run SessionStart-only injections).
- **Upgrading from 0.107.x or earlier?** Run `claude plugin update anti-hall@anti-hall`
  once, then restart Claude Code — the old `update` cannot register 0.108.0 with the
  harness. Later updates do this themselves.
- Anything else: [docs/KB.md](docs/KB.md) is the doc index; file a defect with
  `/anti-hall:defects`.

## What's inside / updating / license

Repo layout, the `AGENTS.md` cross-tool mirror, the `node --test` suite, and the
`/anti-hall:update` flow are documented in [docs/GUIDE.md](docs/GUIDE.md). Full
component reference, configuration, and local testing:
[plugins/anti-hall/README.md](plugins/anti-hall/README.md).

Release notes and what is new in each version: [CHANGELOG.md](CHANGELOG.md).

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md): project layout, running the tests, adding a guard.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): expected behaviour and how to report a conduct problem.
- [SECURITY.md](SECURITY.md): report a vulnerability privately, not in a public issue.
- [Open an issue](https://github.com/talas9/anti-hall/issues/new/choose): bug report, false positive, or feature request.

MIT © Mohammed Talas. See [LICENSE](LICENSE).

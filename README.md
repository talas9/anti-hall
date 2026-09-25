<div align="center">

<img src="assets/anti-hall-logo.png" alt="anti-hall logo" width="200">

# 🛡️ anti-hall

### Make Claude Code and Codex *verify before they claim* — with platform-native guardrails and workflow skills.

[![tests](https://github.com/talas9/anti-hall/actions/workflows/test.yml/badge.svg)](https://github.com/talas9/anti-hall/actions/workflows/test.yml) [![version](https://img.shields.io/github/v/tag/talas9/anti-hall?label=version)](https://github.com/talas9/anti-hall/releases) [![license](https://img.shields.io/github/license/talas9/anti-hall)](LICENSE) ![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen) ![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2) ![Codex port](https://img.shields.io/badge/Codex-port-111827)

</div>

anti-hall is a Claude Code **marketplace + plugin**, plus a separate Codex-native port,
that keeps coding assistants from acting before they verify. It ships always-on Node
hooks (mechanical guards no prompt can talk around), a set of evidence-driven workflow
skills, and a live two-line statusline. Pure Node.js, no dependencies, **macOS · Linux**
(Node ≥ 22 on `PATH` is the only prerequisite; Windows is untested).

It targets four predictable failure modes: **eagerness** (acting before investigating),
**hallucination** (stating unverified facts as truth), **fix-before-diagnosis** (patching
a symptom before proving the cause), and **fake completion** ("done" without running the
check). See [why it exists, and what's proven vs. not](docs/GUIDE.md#hook-reference-detailed)
for the eval behind that claim.

## Install

**Claude Code:**

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

**Codex** (project-local or `--global`):

```bash
node plugins/anti-hall/codex/install-codex.js
node plugins/anti-hall/codex/install-codex.js --global
```

The Claude plugin is the authoritative package; the Codex port
(`plugins/anti-hall/codex/`) is a separate, intentionally non-1:1 mirror — see
[plugins/anti-hall/codex/README.md](plugins/anti-hall/codex/README.md) for hook parity
and [docs/GUIDE.md](docs/GUIDE.md) for the full Codex/OMX detail.

## Requirements

**Node.js ≥ 22 on `PATH`.** Every hook and the statusline are pure Node (built-ins
only), launched as `node <hook>.js`. No `node` on the hook shell's `PATH` means Claude
Code silently skips every anti-hall hook — verify with `node --version`. No npm
install, no native deps, no other config.

**Claude Code ≥ 2.1.271.** The plugin's `/config` settings rows use `userConfig` `options`
pickers; per the Claude Code plugin docs, older versions can't load a plugin that declares them.

## Capabilities

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
- **Update didn't take effect?** Restart Claude Code after `/anti-hall:update` when it says
  RESTART (a registry change); otherwise `/reload-plugins` is enough.
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

MIT © Mohammed Talas. See [LICENSE](LICENSE).

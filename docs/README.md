# anti-hall documentation

The start page: every doc, grouped, one line each. New here? Read the
[`GUIDE.md`](./GUIDE.md) sections you need; [`KB.md`](./KB.md) is the canonical,
maintained knowledge base (ground truth, staleness ledger, topic map).

## Getting started

| Doc | What it covers |
|---|---|
| [`GUIDE.md` install](./GUIDE.md#install-verify-and-uninstall) | Install for Claude Code and Codex, the `.anti-hall/` git-ignore line, how to check it worked, and uninstall (including companions). |
| [`GUIDE.md` requirements](./GUIDE.md#requirements) | Node 22+ on `PATH`, and what `/config` needs. |
| [`GUIDE.md` capabilities](./GUIDE.md#capabilities-at-a-glance) | What each area of the plugin does, in one table. |
| [Skills](#skills) | Every `/anti-hall:<name>` skill, one line each. |
| [`GUIDE.md` troubleshooting](./GUIDE.md#troubleshooting--faq) | Hooks not firing, a guard blocking something legitimate, statusline, updates. |

## Guards and settings

| Doc | What it covers |
|---|---|
| [`GUIDE.md` what it blocks](./GUIDE.md#what-it-blocks-and-how-to-turn-it-off) | The main guards, what each stops, and the setting and skip name that turns it off. |
| [`GUIDE.md` settings](./GUIDE.md#settings-anti-hallsettings) | `/anti-hall:settings`, `/config`, and every setting key with its default. |
| [`GUIDE.md` statusline](./GUIDE.md#statusline-opt-in-one-command) | The opt-in two-line statusline and its installer. |

## Jev and DevSwarm (both optional)

| Doc | What it covers |
|---|---|
| [`KB-jev-classifier.md`](./KB-jev-classifier.md) | Jev (TypeSafe System One) opt-in classifier: [Enable Jev](./KB-jev-classifier.md#enable-jev) (full text and the measured result), every wired integration, metrics, cost and budget watch. |
| [`KB-devswarm-hivecontrol.md`](./KB-devswarm-hivecontrol.md) | DevSwarm & the `hivecontrol` CLI — multi-workspace orchestration. |
| [`KB-devswarm-app-db.md`](./KB-devswarm-app-db.md) | The DevSwarm desktop app's database: what anti-hall reads (read-only), field evidence, sync, screenshot sync, 2.5.3 notes. |

## Project

| Doc | What it covers |
|---|---|
| [`../README.md`](../README.md) | The short landing page: what it does, install, Jev, data. |
| [`../PRIVACY.md`](../PRIVACY.md) | Everything that leaves your machine, and how to turn it off. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Release notes: what is new in each version. |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Project layout, running the tests, adding a guard. |
| [`../SECURITY.md`](../SECURITY.md) | Report a vulnerability privately, not in a public issue. |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Expected behaviour and how to report a conduct problem. |
| [`../RELEASING.md`](../RELEASING.md) | The release checklist. |
| [`../AGENTS.md`](../AGENTS.md) | The protocol for Codex and cross-tool agents. |
| [`../plugins/anti-hall/README.md`](../plugins/anti-hall/README.md) | The plugin directory page (ships inside the plugin). |
| [`../plugins/anti-hall/codex/README.md`](../plugins/anti-hall/codex/README.md) | The Codex port: hook parity, install, skills. |
| [Open an issue](https://github.com/talas9/anti-hall/issues/new/choose) | Bug report, false positive, or feature request. |

## Guides

| Doc | What it covers |
|---|---|
| [`KB.md`](./KB.md) | Canonical knowledge-base index: current-plugin ground truth, topic → doc map, staleness ledger. Read this first. |
| [`GUIDE.md`](./GUIDE.md) | Extended guide: hook reference, skills reference, statusline/config/troubleshooting, contributing. |
| [`E2E-TESTING.md`](./E2E-TESTING.md) | How the zero-dependency `node:test` hook suite works; per-event I/O contract. |
| [`TASK-WORK.md`](./TASK-WORK.md) | Task discipline design (`TaskCreate`/`TaskUpdate` vs legacy `TodoWrite`); basis for tasklist-guard. |
| [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md) | Usage guide for the `tasklist-guard` Stop hook: progress/history file convention, env knobs, escape hatch. |

## Skills

Invoke any of these as `/anti-hall:<name>`. Full descriptions (arguments, env vars, version history):
[`GUIDE.md`](./GUIDE.md#skills-reference-detailed). Codex mirrors live under `plugins/anti-hall/codex/skills/anti-hall-*`.

| Skill | Use it when | One line |
|---|---|---|
| `root-cause` | any bug, crash, flaky test | evidence → hypothesis → instrument → prove root cause → fix → verify |
| `orchestration` | heavy/parallel/long work | non-blocking coordinator; fan out to subagents, verify delegated work against ground truth |
| `deadly-loop` | before merging anything risky | parallel Reviewer + Auditor + Critic debate + fix-waves until convergence |
| `deadly-loop-multi` | deeper review | double/triple/quadruple deadly-loop pass |
| `ship-it` | any change, small fix to multi-phase feature | plan-in-plan-mode → deadly-loop harden → build → verify each phase |
| `install-statusline` | "install the statusline" | installs the two-line statusline (global or per-repo), wraps any existing one, backup/restore |
| `doctor` | "is anti-hall working?" | live self-tests on every guard; `--repair` for safe auto-fixes |
| `system-briefing` | "brief me on anti-hall", "what does X mean" | operator guide (terms, rules, verbs, settings) + live inventory of every hook/skill shipped |
| `update` | "update anti-hall" | pulls latest, shows changelog delta, prompts `/reload-plugins` (restart only if a hook or skill path still shows the old version) |
| `flutter-debug` | debugging a running Flutter app | agent-driven hot-reload + visual-verification debug loop |
| `activate` | first-time setup | one-shot idempotent install of statusline + model-routing state (statusline, model routing, sentinel) |
| `simplify` | "simplify this" / "deslop" | behavior-preserving simplification with a measured `net: -N lines` score |
| `debt` | tracking deliberate shortcuts | register + audit `// anti-hall: <ceiling>,<when>` debt markers for rot risk |
| `devswarm` | tuning/recovering the DevSwarm mesh | explains + activates + tunes the optional DevSwarm integration |
| `handover` | end of session / before `/clear` | writes a lossless session handover for a cold-start resume |
| `defects` | "file an anti-hall bug" | file/list/show/rule on anti-hall's own defect reports |
| `jev` | "activate jev" | asks for your Vercel AI Gateway or TypeSafe key, installs it, enables and tests it |
| `settings` | "anti-hall settings", "set auto-handover to 80%" | show or change any setting; one unified `~/.anti-hall/settings.json`, browsable via `show`/`get`/`set`/`reset` |

## Knowledge base (KB-*)

| Doc | Topic |
|---|---|
| [`KB-claude-codex.md`](./KB-claude-codex.md) | Backbone synthesis — hooks, plugins, prompting, Codex, orchestration, anti-hallucination evidence. |
| [`KB-claude-code-hooks.md`](./KB-claude-code-hooks.md) | Claude Code's hook system reference. |
| [`KB-claude-code-harness-features.md`](./KB-claude-code-harness-features.md) | Full harness feature surface vs what anti-hall actually uses; gap list. |
| [`KB-claude-workflow-orchestration.md`](./KB-claude-workflow-orchestration.md) | When/how to use the `Workflow` tool vs a single/shallow agent. |
| [`KB-claude-monitor-tool.md`](./KB-claude-monitor-tool.md) | The `Monitor` tool for event-driven orchestration. |
| [`KB-codex-platform-hooks-plugins.md`](./KB-codex-platform-hooks-plugins.md) | Codex platform hooks, plugins, skills, customization. |
| [`KB-codex-workflow-orchestration.md`](./KB-codex-workflow-orchestration.md) | Codex workflow orchestration, subagents, Workflow/swarm equivalents. |
| [`KB-codex-vs-opus-coding.md`](./KB-codex-vs-opus-coding.md) | Codex (GPT-5.x) vs Claude Opus for coding — division of labor. |
| [`KB-omc.md`](./KB-omc.md) | oh-my-claudecode (OMC) — Claude-side orchestration layer. |
| [`KB-omx.md`](./KB-omx.md) | oh-my-codex (OMX) — Codex-side orchestration layer. |
| [`KB-cmux.md`](./KB-cmux.md) | cmux — terminal workspace for AI coding agents. |
| [`KB-fable-5.md`](./KB-fable-5.md) | Claude Fable 5 model reference. |
| [`KB-sonnet-5.md`](./KB-sonnet-5.md) | Claude Sonnet 5 + model routing, Claude and Codex tables. |
| [`KB-gpt-5.6.md`](./KB-gpt-5.6.md) | GPT-5.6 (Sol/Terra/Luna) model reference. |
| [`KB-model-modes.md`](./KB-model-modes.md) | Model operating modes — effort levels, Plan Mode, Workflow/ultracode, Codex reasoning tiers. |
| [`KB-token-usage-models.md`](./KB-token-usage-models.md) | Token usage & cost mechanics across effort tiers, Claude + Codex. |
| [`KB-goal-setting.md`](./KB-goal-setting.md) | Goal setting theory + AI-agent goal misspecification as a reward-hacking cause. |
| [`KB-false-completion.md`](./KB-false-completion.md) | False task completion — reward hacking, claimed-vs-verified gaps, mitigations. |
| [`KB-overengineering.md`](./KB-overengineering.md) | Overengineering causes and measurement; anti-hall's scope-fidelity implications. |
| [`KB-session-handover.md`](./KB-session-handover.md) | AI-agent session handover design; backs the `handover` skill. |
| [`KB-handover-research.md`](./KB-handover-research.md) | 2026-09-24 sourced handover research: compaction loss, context rot, trigger points, Claude Code + Codex compaction/hook facts, receiver read-back; the gap review behind the 0.108 handover changes. |
| [`KB-flutter-claude-debug.md`](./KB-flutter-claude-debug.md) | Research backing the `flutter-debug` skill. |
| [`CONTEXT-PRESERVATION-KB.md`](./CONTEXT-PRESERVATION-KB.md) | Slowing main-agent context growth — caching, sub-agent isolation, compaction, JIT retrieval. |
| [`CODEX-KB-MIGRATION-MAP.md`](./CODEX-KB-MIGRATION-MAP.md) | Cross-reference between Claude-side and Codex-side KB docs. |

## Reference / design

| Doc | What it covers |
|---|---|
| [`opus-4-8-features.md`](./opus-4-8-features.md) | Claude Opus 4.8 feature reference (context window, effort, thinking, pricing). |
| [`opus-4-8-swarm.md`](./opus-4-8-swarm.md) | Multi-agent orchestration on Opus 4.8 — Dynamic Workflows, Managed Agents. |
| [`gsd-distilled.md`](./gsd-distilled.md) | GSD phase model, distilled; the phase loop `ship-it` borrows from. |
| [`superpowers-planning.md`](./superpowers-planning.md) | Distillation of the superpowers skill set; Iron-Law + rationalization-table pattern. |
| [`keynote-prompting-claude.md`](./keynote-prompting-claude.md) | Distilled notes from two Anthropic prompting talks. |
| [`keynote-transcript.md`](./keynote-transcript.md) | Reconstructed transcript of the Prompting 101 talk. |

## Archive / history

Frozen, dated records — never edited to match current code. Several are internal
session artifacts (dated design plans, audits) kept for provenance only; read
[`KB.md` §5](./KB.md#5-history--historical-artifacts) for context on each.
Historical working documents live in [`archive/`](./archive/README.md); they may be out of date.

| Doc | What it is |
|---|---|
| [`archive/README.md`](./archive/README.md) | The archive folder: what it holds and why it may be out of date. |
| [`archive/AUDIT-REPORT.md`](./archive/AUDIT-REPORT.md) | 4-auditor review, `v0.7.0`-era. Superseded; findings applied. |
| [`archive/AUDIT-REPORT-2.md`](./archive/AUDIT-REPORT-2.md) | Double deadly-loop final gate, `v0.11.1 → v0.11.2`. Superseded; findings applied. |
| [`archive/PLUGIN-REVIEW.md`](./archive/PLUGIN-REVIEW.md) | KB-driven plugin audit that prescribed the cadence redesign. Superseded; shipped. |
| [`archive/ULTRAPLAN.md`](./archive/ULTRAPLAN.md) | Single consolidated reconciliation plan, `v0.3.0`-era. Superseded; executed. |
| [`archive/2026-06-06-context-opt-test-design.md`](./archive/2026-06-06-context-opt-test-design.md) | Dated context-optimization test-harness design. |
| [`archive/2026-06-10-v0.32.0-fable5-model-routing-plan.md`](./archive/2026-06-10-v0.32.0-fable5-model-routing-plan.md) | Dated v0.32.0 design plan (Fable 5 support, model-routing guard). |
| [`2026-06-10-v0.34.0-flutter-debug-plan.md`](./2026-06-10-v0.34.0-flutter-debug-plan.md) | Dated v0.34.0 design plan (flutter-debug agent + skill). Kept here: `tests/hooks/flutter-debug.test.js` reads it by path. |
| [`archive/superpowers/specs/2026-07-05-devswarm-orchestration-design.md`](./archive/superpowers/specs/2026-07-05-devswarm-orchestration-design.md) | Approved design — DevSwarm-aware workspace-tier orchestration. |
| [`archive/superpowers/plans/2026-07-06-devswarm-orchestration.md`](./archive/superpowers/plans/2026-07-06-devswarm-orchestration.md) | Implementation plan for the design above. |
| [`archive/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md`](./archive/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md) | Design — DevSwarm liveness supervisor (wedged-session recovery). |
| [`archive/superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md`](./archive/superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md) | Implementation plan for the liveness supervisor. |
| [`archive/superpowers/specs/2026-08-01-harness-feature-adoption.md`](./archive/superpowers/specs/2026-08-01-harness-feature-adoption.md) | Harness-feature adoption plan derived from `KB-claude-code-harness-features.md`. |
| [`archive/devswarm-layered-recovery-history.md`](./archive/devswarm-layered-recovery-history.md) | DevSwarm layered-recovery version history (v0.54–v0.107), moved out of GUIDE in v0.108.0. |

MIT © Mohammed Talas.

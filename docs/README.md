# docs/ index

Full index of every doc in this directory. [`KB.md`](./KB.md) is the canonical,
maintained knowledge base (ground truth, staleness ledger, topic map); this page is
a flat link index so nothing is missed. Start with [`KB.md`](./KB.md) →
[`GUIDE.md`](./GUIDE.md) for a guided read.

## Guides

| Doc | What it covers |
|---|---|
| [`KB.md`](./KB.md) | Canonical knowledge-base index: current-plugin ground truth, topic → doc map, staleness ledger. Read this first. |
| [`GUIDE.md`](./GUIDE.md) | Extended guide: hook reference, skills reference, statusline/config/troubleshooting, contributing. |
| [`E2E-TESTING.md`](./E2E-TESTING.md) | How the zero-dependency `node:test` hook suite works; per-event I/O contract. |
| [`TASK-WORK.md`](./TASK-WORK.md) | Task discipline design (`TaskCreate`/`TaskUpdate` vs legacy `TodoWrite`); basis for tasklist-guard. |
| [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md) | Usage guide for the `tasklist-guard` Stop hook: progress/history file convention, env knobs, escape hatch. |

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
| [`KB-devswarm-hivecontrol.md`](./KB-devswarm-hivecontrol.md) | DevSwarm & the `hivecontrol` CLI — multi-workspace orchestration. |
| [`KB-devswarm-app-db.md`](./KB-devswarm-app-db.md) | The DevSwarm desktop app's database: what anti-hall reads (read-only), field evidence, sync, screenshot sync, 2.5.3 notes. |
| [`KB-cmux.md`](./KB-cmux.md) | cmux — terminal workspace for AI coding agents. |
| [`KB-fable-5.md`](./KB-fable-5.md) | Claude Fable 5 model reference. |
| [`KB-sonnet-5.md`](./KB-sonnet-5.md) | Claude Sonnet 5 + model routing, Claude and Codex tables. |
| [`KB-gpt-5.6.md`](./KB-gpt-5.6.md) | GPT-5.6 (Sol/Terra/Luna) model reference. |
| [`KB-model-modes.md`](./KB-model-modes.md) | Model operating modes — effort levels, Plan Mode, Workflow/ultracode, Codex reasoning tiers. |
| [`KB-token-usage-models.md`](./KB-token-usage-models.md) | Token usage & cost mechanics across effort tiers, Claude + Codex. |
| [`KB-jev-classifier.md`](./KB-jev-classifier.md) | Jev (TypeSafe System One) opt-in classifier: every wired integration, metrics, cost and budget watch. |
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
| [`superpowers/specs/2026-07-05-devswarm-orchestration-design.md`](./superpowers/specs/2026-07-05-devswarm-orchestration-design.md) | Approved design — DevSwarm-aware workspace-tier orchestration. |
| [`superpowers/plans/2026-07-06-devswarm-orchestration.md`](./superpowers/plans/2026-07-06-devswarm-orchestration.md) | Implementation plan for the design above. |
| [`superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md`](./superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md) | Design — DevSwarm liveness supervisor (wedged-session recovery). |
| [`superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md`](./superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md) | Implementation plan for the liveness supervisor. |
| [`superpowers/specs/2026-08-01-harness-feature-adoption.md`](./superpowers/specs/2026-08-01-harness-feature-adoption.md) | Harness-feature adoption plan derived from `KB-claude-code-harness-features.md`. |

## Archive / history

Frozen, dated records — never edited to match current code. Several are internal
session artifacts (dated design plans, audits) kept for provenance only; read
[`KB.md` §5](./KB.md#5-history--historical-artifacts) for context on each.

| Doc | What it is |
|---|---|
| [`AUDIT-REPORT.md`](./AUDIT-REPORT.md) | 4-auditor review, `v0.7.0`-era. Superseded; findings applied. |
| [`AUDIT-REPORT-2.md`](./AUDIT-REPORT-2.md) | Double deadly-loop final gate, `v0.11.1 → v0.11.2`. Superseded; findings applied. |
| [`PLUGIN-REVIEW.md`](./PLUGIN-REVIEW.md) | KB-driven plugin audit that prescribed the cadence redesign. Superseded; shipped. |
| [`ULTRAPLAN.md`](./ULTRAPLAN.md) | Single consolidated reconciliation plan, `v0.3.0`-era. Superseded; executed. |
| [`2026-06-06-context-opt-test-design.md`](./2026-06-06-context-opt-test-design.md) | Dated context-optimization test-harness design. |
| [`2026-06-10-v0.32.0-fable5-model-routing-plan.md`](./2026-06-10-v0.32.0-fable5-model-routing-plan.md) | Dated v0.32.0 design plan (Fable 5 support, model-routing guard). |
| [`2026-06-10-v0.34.0-flutter-debug-plan.md`](./2026-06-10-v0.34.0-flutter-debug-plan.md) | Dated v0.34.0 design plan (flutter-debug agent + skill). |

MIT © Mohammed Talas.

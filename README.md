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
| **Settings** | One place for every setting — `~/.anti-hall/settings.json`, browsable/editable via `/anti-hall:settings` or `scripts/settings.js`; a headline subset also shows in Claude Code's native `/config` panel. See [docs/GUIDE.md#settings-anti-hallsettings](docs/GUIDE.md#settings-anti-hallsettings). |

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

Full index: [`docs/README.md`](docs/README.md) (every doc, grouped, with a one-line
description). Start here:

| Doc | What it covers |
|---|---|
| [`docs/KB.md`](docs/KB.md) | Canonical knowledge-base index — current-plugin ground truth, topic → doc map. |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Extended guide — full hook/skills reference, statusline, config, contributing. |
| [`docs/KB-devswarm-hivecontrol.md`](docs/KB-devswarm-hivecontrol.md) | DevSwarm mesh integration reference. |
| [`docs/KB-jev-classifier.md`](docs/KB-jev-classifier.md) | Jev opt-in speculation classifier reference. |
| [`plugins/anti-hall/codex/README.md`](plugins/anti-hall/codex/README.md) | Codex port — hook parity, install, skills. |

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

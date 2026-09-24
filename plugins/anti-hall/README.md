# anti-hall

> A Claude Code plugin that enforces verify-first discipline and ships the workflow
> skills that go with it.

It fights four failure modes common to coding assistants:

1. **Eagerness** — answering or acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Fix-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done, fixed, or passing without running the check.

## Quickstart

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

The hooks apply globally once enabled. The statusline is a separate one-command
install (see [Statusline](#statusline)). To try it without installing:

```bash
claude --plugin-dir /path/to/anti-hall
```

## Requirements

> **Node.js ≥ 22 on `PATH`** is the one hard prerequisite. Every hook and the
> statusline are pure Node.js (built-ins only), launched as `node <hook>.js`. If
> `node` is unreachable by the hook shell, Claude Code **silently skips every
> anti-hall hook** — nothing is surfaced. There is intentionally no shell-based
> preflight (it can't reach a stock Windows shell either). Install Node from
> <https://nodejs.org> and verify with `node --version`.

## Capabilities

| Area | What it does |
|---|---|
| **Guards** | Always-on Node hooks: `git-guard` (AI self-credit / force-push), `api-guard` (fabricated stdlib/builtin APIs), `command-guard` (heavy commands → subagents), `edit-guard` (direct edits → subagents), `swarm-guard` (fork-bomb / memory), `task-guard`/`tasklist-guard` (stop with open work), `model-routing-guard` (cheapest fitting model), `merge-gate`/`ship-it-guard` (opt-in). |
| **Verify-first discipline** | Full Iron-Law + rationalization-table protocol at session start (survives compaction), a rotating one-line nudge every turn, and the always-on scope-fidelity + anti-sycophancy rules. |
| **Orchestration** | Coordinator discipline: delegate broad reads/heavy commands to subagents, independently verify a subagent's "done" claim before trusting it, live phase progress on the statusline. |
| **DevSwarm mesh** | Optional, dormant unless a DevSwarm session is active. Layered recovery (self-report → poke → escalate, never auto-kill), one mailbox per session, per-turn mesh status table, the DevSwarm app database as ground truth, auto-archive of done workspaces (DevSwarm ≥ 2.5.3), message retention. Full reference: [`docs/KB-devswarm-hivecontrol.md`](https://github.com/talas9/anti-hall/blob/main/docs/KB-devswarm-hivecontrol.md). |
| **Jev classifier** | Optional LLM-backed speculation classifier. [`docs/KB-jev-classifier.md`](https://github.com/talas9/anti-hall/blob/main/docs/KB-jev-classifier.md). |
| **Auto-handover** | On by default: at 85% context the agent writes a handover itself, tells you, and suggests `/compact` or `/clear`. |
| **Settings** | Every setting in one place, `~/.anti-hall/settings.json`, via `/anti-hall:settings` (or `scripts/settings.js`); a headline subset also appears in `/config`. |
| **Statusline** | Live two-line bar — git/model/context/cost, plus live orchestration/context gauge. |
| **doctor / update** | `doctor` runs live behavioral self-tests on every guard (`--repair` for safe fixes); `update` pulls the latest release and prints the changelog delta. Repairs also run by themselves after a plugin reload or on a new version. |

Full per-hook table (every hook, its event, exact behavior, and version history) moved
to [`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#hook-reference--plugin-features-table-detailed-per-hook) — nothing was deleted,
only relocated so this page stays a landing page.

## Codex port

The Codex-native port lives in [`codex/`](codex/README.md) and is intentionally
separate from the Claude plugin — different hooks.json, different skill set
(`anti-hall-*`), same underlying guards where payload contracts are verified for
Codex. Parity notes, model-routing categories, and the full changelog are in
[`codex/README.md`](codex/README.md) and [`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md).

## Skills

Invoke as `/anti-hall:<name>`:

| Skill | Use it when | One line |
|---|---|---|
| `root-cause` | any bug, crash, flaky test | evidence → hypothesis → instrument → prove root cause → fix → verify |
| `orchestration` | heavy/parallel/long work | non-blocking coordinator; verify delegated work against ground truth |
| `deadly-loop` | before merging anything risky | parallel Reviewer + Auditor + Critic debate + fix-waves until convergence |
| `deadly-loop-multi` | deeper review | double/triple/quadruple deadly-loop pass |
| `ship-it` | any change, small fix to multi-phase feature | plan-in-plan-mode → deadly-loop harden → build → verify each phase |
| `install-statusline` | "install the statusline" | writes the statusline setting, wraps any existing one, backup/restore |
| `doctor` | "is anti-hall working?" | live self-tests on every guard; `--repair` for safe auto-fixes |
| `system-briefing` | "brief me on anti-hall" | derived (never hardcoded) live inventory of every hook/skill shipped |
| `update` | "update anti-hall" | pulls latest, shows changelog delta, prompts `/reload-plugins` |
| `flutter-debug` | debugging a running Flutter app | agent-driven hot-reload + visual-verification debug loop |
| `activate` | first-time setup | one-shot idempotent install of statusline + model-routing state |
| `simplify` | "simplify this" / "deslop" | behavior-preserving simplification with a measured `net: -N lines` score |
| `debt` | tracking deliberate shortcuts | register + audit `// anti-hall: <ceiling>,<when>` debt markers |
| `devswarm` | tuning/recovering the DevSwarm mesh | explains + activates the optional DevSwarm integration |
| `handover` | end of session / before `/clear` | writes a lossless session handover for a cold-start resume |
| `defects` | "file an anti-hall bug" | file/list/show/rule on anti-hall's own defect reports |
| `jev` | "activate jev" | asks for your Vercel AI Gateway or TypeSafe key, installs it, enables and tests it |
| `settings` | "anti-hall settings", "set auto-handover to 80%" | show or change any setting; one `~/.anti-hall/settings.json` |

Full descriptions (arguments, env vars, version history) moved to
[`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#skills-reference-detailed).

## Documentation

Full index (every doc, grouped, one-line descriptions):
[`docs/README.md`](https://github.com/talas9/anti-hall/blob/main/docs/README.md).
Start with [`docs/KB.md`](https://github.com/talas9/anti-hall/blob/main/docs/KB.md)
(canonical index + ground truth) →
[`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md) (full
hook/skills reference). This README uses absolute GitHub URLs for `docs/` links
because this file ships inside the plugin cache, where `../../docs/` does not exist.

## Statusline

Install by asking Claude **"install the statusline"**, or run
`node plugins/anti-hall/statusline/install-statusline.js`. `--consolidate` merges with
an existing statusline (e.g. OMC HUD) instead of replacing it. Restart Claude Code once
after installing — `statusLine` is only read at startup. Full renderer/tier detail:
[`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#statusline-configuration-tuning-troubleshooting-and-local-testing-plugin)
and [`statusline/STATUSLINE.md`](statusline/STATUSLINE.md).

## Configuration / tuning, Troubleshooting / FAQ, Test locally

Moved to [`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#statusline-configuration-tuning-troubleshooting-and-local-testing-plugin) —
env-var reference for every opt-in feature, common gotchas, and how to run the suite
locally (`node --test`).

## Contributing

See [`docs/GUIDE.md`](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#contributing--testing-plugin) for the full
contributing guide (style, test conventions, PR checklist).

## License

MIT © Mohammed Talas. See [LICENSE](../../LICENSE).

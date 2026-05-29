# anti-hall

> Make Claude Code verify before it claims — and ship the workflow skills that enforce it.

`anti-hall` is a Claude Code marketplace + plugin that installs always-on hooks and
workflow skills which push the model to check its work instead of guessing. It runs
on any machine and any repo (the one prerequisite is Node.js on `PATH`).

## The problem it solves

Coding assistants fail in four predictable ways. anti-hall targets each one:

1. **Eagerness** — acting or answering before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Fix-before-diagnosis** — proposing a fix before the root cause is proven.
4. **Fake completion** — claiming work is done, fixed, or passing without running the check.

It does this by injecting a verify-first protocol at session start, a short rotating
nudge every turn, and a set of mechanical guards (no AI self-credit in commits, no
silent force-push, no silently-dropped tasks).

## Quickstart

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

That enables the hooks globally. The statusline is opt-in — see
[the plugin README](plugins/anti-hall/README.md#statusline-opt-in-one-command).

## Requirements

- **Node.js >= 18 on `PATH`.** Every hook and the statusline launch as
  `node "<plugin>/hooks/<name>.js"`. Claude Code does NOT guarantee a user-installed
  `node` on the hook shell's `PATH`, and this plugin does not bundle one. If `node`
  is unreachable by the hook shell (common on a fresh Windows box or for non-JS
  developers) the hooks **silently no-op** — the guards do not run and nothing is
  surfaced. Install Node from <https://nodejs.org> and verify with `node --version`
  before relying on the protections.

## What's inside

| Component | Type | What it does |
|---|---|---|
| `verify-first-full.js` | SessionStart hook | Injects the full Iron-Law + rationalization-table protocol + skill primer; re-injects after compaction (`source=compact`). |
| `verify-first.js` | UserPromptSubmit hook | Adds a short, varying one-line nudge per turn so the slot stays high-salience. |
| `git-guard.js` | PreToolUse hook | Blocks AI self-credit commit trailers and `git push --force`. |
| `task-tracker.js` / `task-guard.js` | UserPromptSubmit / Stop hooks | Task-list discipline: capture, prioritize, finish — nothing dropped. |
| `graphify-session.js` / `graphify-reminder.js` | SessionStart / Stop hooks | Query-the-graph-first; keep-it-updated reminder (no-op without a graph). |
| `root-cause`, `orchestration`, `feature-launch`, `deadly-loop` | Skills | Slash commands: `/anti-hall:<name>`. |
| `statusline/` | Node statusline | Rich line for monorepos, simple line otherwise. |

## Layout

```
anti-hall/                          # marketplace root
├── .claude-plugin/marketplace.json
├── AGENTS.md                       # Codex / cross-tool prose mirror (not bundled by install)
├── llms.txt                        # LLM-oriented index of this repo
└── plugins/anti-hall/              # the plugin
    ├── .claude-plugin/plugin.json
    ├── hooks/                      # 7 Node hooks
    ├── skills/                     # root-cause, orchestration, feature-launch, deadly-loop, MODEL-POLICY.md
    ├── statusline/                 # monorepo + simple statuslines + installer
    └── README.md
```

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for the full
component reference, configuration, troubleshooting, and local testing.

## License

MIT — see [LICENSE](LICENSE).

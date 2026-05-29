# anti-hall

Claude Code marketplace + plugin that makes Claude **verify before it claims** and
ships the workflow skills that enforce it — reducing eagerness, hallucination,
fix-before-diagnosis, and fake "it's done" completion. Works on any machine and any
repo.

## What's inside
- **Per-turn hook** — verify-first + root-cause protocol injected every turn (no
  cause / no fix, evidence before claims, instrument don't guess, no fake completion).
- **Skills** — `root-cause` (evidence-driven debugging), `orchestration` (non-blocking
  swarm; Claude+Codex load split; commands via Haiku), `feature-launch` (plan-first,
  deadly-loop-hardened, edge-case/scenario simulated), `deadly-loop` (iterative
  Reviewer+Critic debate), and a shared `MODEL-POLICY.md` (Opus + Codex roster).
- **graphify hooks** — query-the-graph-first on session start; keep-it-updated reminder.
- **Statusline** — rich for monorepos, simple otherwise; activated by an installer.

## Requirements
- **Node.js (>= 18) on `PATH`.** Every hook and the statusline are launched as
  `node "<plugin>/hooks/<name>.js"`. Claude Code does NOT guarantee a
  user-installed `node` on the hook shell's `PATH`, and this plugin does not
  bundle one. On a machine with no global Node install (common on a fresh Windows
  box or for non-JS developers) the hooks fail to launch and the guards
  (force-push / self-credit block, verify-first, task discipline) silently do not
  run. Install Node from <https://nodejs.org> and verify with `node --version`
  before relying on the protections. "Works on any machine / any repo" means
  OS-portable *given Node* — Node is the one hard prerequisite.

## Install
```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```
Or from a local clone: `/plugin marketplace add /path/to/anti-hall`.

## Layout
```
anti-hall/                          # marketplace root
├── .claude-plugin/marketplace.json
└── plugins/anti-hall/              # the plugin
    ├── .claude-plugin/plugin.json
    ├── hooks/                      # verify-first, graphify-session, graphify-reminder
    ├── skills/                     # root-cause, orchestration, feature-launch, deadly-loop, MODEL-POLICY.md
    ├── statusline/                 # monorepo + simple statuslines + installer
    └── README.md
```

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for component
details and local testing.

## License
MIT — see [LICENSE](LICENSE).

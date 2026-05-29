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

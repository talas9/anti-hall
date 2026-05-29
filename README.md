# anti-hall

Claude Code marketplace + plugin that makes Claude **verify before it claims** — reducing
eagerness, hallucination, fix-before-diagnosis, and fake "it's done" completion.

The plugin injects a compact verify-first protocol into every turn via a `UserPromptSubmit`
hook. It works on any machine and any repo, with no `CLAUDE.md` edits required.

## Install

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

Or add from a local clone:

```bash
/plugin marketplace add /path/to/anti-hall
/plugin install anti-hall@anti-hall
```

## Layout

```
anti-hall/                          # marketplace root
├── .claude-plugin/marketplace.json # lists the plugin(s)
└── plugins/
    └── anti-hall/                  # the plugin itself
        ├── .claude-plugin/plugin.json
        ├── hooks/hooks.json
        ├── hooks/verify-first.sh   # edit this to tune the injected protocol
        └── README.md
```

See [`plugins/anti-hall/README.md`](plugins/anti-hall/README.md) for how it works and how
to test it locally.

## License

MIT — see [LICENSE](LICENSE).

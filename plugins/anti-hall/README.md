# anti-hall

> A Claude Code plugin that enforces verify-first discipline and ships the workflow
> skills that go with it.

It fights four failure modes common to coding assistants:

1. **Eagerness** — answering or acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Fix-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done, fixed, or passing without running the check.

What it ships: always-on Node hooks (mechanical guards such as `git-guard`, `api-guard`,
`command-guard`, `edit-guard`, `swarm-guard`, `task-guard`), a rotating verify-first nudge,
skills you call as `/anti-hall:<name>` (`root-cause`, `deadly-loop`, `ship-it`, `doctor`,
`handover`, `settings`, and more), an optional two-line statusline, and optional DevSwarm and
Jev integrations.

## Quickstart

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

The hooks apply globally once enabled. To try it without installing:
`claude --plugin-dir /path/to/anti-hall`. For the statusline, ask Claude "install the statusline".

**Requirement: Node.js >= 22 on `PATH`** (verify with `node --version`). Every hook is pure
Node.js (built-ins only). If `node` is unreachable by the hook shell, Claude Code silently
skips every anti-hall hook, and nothing is surfaced.

### Enable Jev

<!-- jev-recommend:start -->
> **Recommended: enable Jev, the optional classifier, for more accurate guards.**
>
> It gives guards such as the speculation check a model's second opinion on top of pattern matching, and it can only add blocks, never remove one. **Costs:** optional and off by default; needs your own Vercel AI Gateway or TypeSafe API key; sends the text a guard judges to the provider you choose; uses provider credits. Details: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).
>
> Enable: say "activate jev" (runs the `jev` skill). The full text and the measured result are in the Jev page of the documentation (below).
<!-- jev-recommend:end -->

## Network and data

No telemetry or analytics. Full detail: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).

| Feature | Default | Sends to | What |
|---|---|---|---|
| Update check | On | github.com/talas9/anti-hall (`git ls-remote --tags`) | A tag-list request, no project data. Off: `versionAlerts.antiHall` or `ANTIHALL_VERSION_ALERT=off` |
| Jev classifier | Off | ai-gateway.vercel.sh or api.typesafe.ai | May include prompts, assistant text, test output, commit text, file paths (4000-8000 chars per call); secrets matching known token shapes are redacted before sending (best-effort). Off: `jev.enabled` or `ANTIHALL_JEV=0` |
| Semantic judge | Off | api.anthropic.com (key, or your `claude` CLI login with `jev.judgeBackend` cli) | Last assistant message (up to 8000 chars), latest prompt (up to 2000) and newest tool output (about 6000); known secret shapes redacted (best-effort). Off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1` |
| Mesh message triage | Off (needs Jev) | Jev, then api.anthropic.com if an Anthropic key is available | DevSwarm message text |

Everything else (logs, handovers, defect reports) stays in `~/.anti-hall/` and `<repo>/.anti-hall/`. `gh`, `codex` and `hivecontrol` run under your own accounts; the plugin does not spawn `gh` or `codex`.

## Documentation

Everything else (every guard and setting, all skills, the statusline, troubleshooting, the
Codex port, contributing) starts at the
[documentation start page](https://github.com/talas9/anti-hall/blob/main/docs/README.md).
This README uses absolute GitHub URLs because it ships inside the plugin cache, where
`../../docs/` does not exist.

## Links

- [Documentation](https://github.com/talas9/anti-hall/blob/main/docs/README.md)
- [Support](https://github.com/talas9/anti-hall/issues)
- [Privacy](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md)

## License

MIT © Mohammed Talas. See [LICENSE](https://github.com/talas9/anti-hall/blob/main/LICENSE).

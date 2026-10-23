# anti-hall

> A Claude Code plugin that enforces verify-first discipline and ships the workflow
> skills that go with it.

It fights four failure modes common to coding assistants:

1. **Eagerness** — answering or acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Fix-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done, fixed, or passing without running the check.

What it ships: always-on hooks, all decided by the `ah-engine` binary (mechanical guards such as `git-guard`, `api-guard`,
`command-guard`, `edit-guard`, `swarm-guard`, `task-guard`), a rotating verify-first nudge,
skills you call as `/anti-hall:<name>` (`root-cause`, `deadly-loop`, `ship-it`, `doctor`,
`handover`, `settings`, and more), legacy statusline cleanup, and optional DevSwarm and
Jev integrations.

## Quickstart

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

The hooks apply globally once enabled. To try it without installing:
`claude --plugin-dir /path/to/anti-hall`. The old anti-hall statusline installer is retired; use uninstall-statusline only to clean up older installs.

**No Node.js needed.** Every hook is a thin `sh` trigger that asks the `ah-engine` binary (macOS and Linux). The plugin
ships no Node code; the old Node runtime is kept outside the published plugin as a local backup (`plugins/anti-hall-node`).

### Enable Jev

<!-- jev-recommend:start -->
> **Recommended: enable Jev, the optional classifier, for more accurate guards.**
>
> It gives guards such as the speculation check a model's second opinion on top of pattern matching, and it can only add blocks, never remove one. **Costs:** optional and off by default; needs your own Vercel AI Gateway or TypeSafe API key; sends the text a guard judges to the provider you choose; uses provider credits. Details: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).
>
> Enable: say "activate jev" (runs the `jev` skill). The full text and the measured result are in the Jev page of the documentation (below).
<!-- jev-recommend:end -->

## How the hooks run

`hooks/hooks.json` holds one thin trigger per event (`hooks/ah-hook.sh <Event>`). The core is the `ah-engine` binary
(downloaded once from the GitHub Release and installed only if its sha256 equals the one pinned in `ah-engine.lock`; skip it with
the setting `engine.bootstrap` = false or `AH_ENGINE_BOOTSTRAP=0`), the engine decides every hook (v0.301 and later: it is the only runtime); with no binary, hook calls pass through and the session gets a one-line notice. Its rules, settings and texts are plain files in `engine/`, hot-reloaded
with fallbacks (edited, last-known-good, pristine). macOS and Linux; Windows is not supported yet. Details:
[AH-ENGINE.md](https://github.com/talas9/anti-hall/blob/main/docs/AH-ENGINE.md).

## Binary download and verification

The `ah-engine` binary is fetched once from this repository's GitHub Releases (tag `ah-engine-v*`, HTTPS) and installed only if its sha256 equals the one in `ah-engine.lock`; on a failure or a mismatch nothing is installed and hook calls pass through. Releases carry build-provenance attestations and are immutable. Opt out with `AH_ENGINE_BOOTSTRAP=0`. Full detail, including building from source: [How it works](https://github.com/talas9/anti-hall/blob/main/docs/how-it-works/index.md#binary-download-and-verification).

## Network and data

No analytics and nothing is reported to anyone; the `ah-engine` keeps local-only usage counters (identifiers only, never content; `telemetry.enabled`). Full detail: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).

| Feature | Default | Sends to | What |
|---|---|---|---|
| Update check | On | github.com/talas9/anti-hall (`git ls-remote --tags`) | A tag-list request, no project data. Off: `versionAlerts.antiHall` or `ANTIHALL_VERSION_ALERT=off` |
| Engine binary download | On, once per pinned release (needs a release that pins `ah-engine.lock`) | github.com/talas9/anti-hall Releases (HTTPS) | The release archive for your platform; no data about you or your project is sent. Installed only if its sha256 equals the one pinned in the plugin; a mismatch installs nothing. Off: the setting `engine.bootstrap` = false or `AH_ENGINE_BOOTSTRAP=0` (hook calls then pass through) |
| Jev classifier | Off | ai-gateway.vercel.sh or api.typesafe.ai | May include prompts, assistant text, test output, commit text, file paths (4000-8000 chars per call); secrets matching known token shapes are redacted before sending (best-effort). Off: `jev.enabled` or `ANTIHALL_JEV=0` |
| Semantic judge | Off | api.anthropic.com (key, or your `claude` CLI login with `jev.judgeBackend` cli) | Last assistant message (up to 8000 chars), latest prompt (up to 2000) and newest tool output (about 6000); known secret shapes redacted (best-effort). Off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1` |
| Mesh message triage | Off (needs Jev) | Jev, then api.anthropic.com if an Anthropic key is available | DevSwarm message text |

Everything else (logs, handovers, defect reports) stays in `~/.anti-hall/` and `<repo>/.anti-hall/`. `gh`, `codex` and `hivecontrol` run under your own accounts; the plugin does not spawn `gh` or `codex`.

## What it runs, sends and fetches

| | What happens |
|---|---|
| **Runs** | Hooks run on Claude Code tool events (one thin trigger per event, `hooks/ah-hook.sh`). They read the event, decide, and print a verdict or a note. No hook sends project content anywhere. |
| **Fetches** | The `ah-engine` binary is downloaded once at install, only from this repository's GitHub releases. Its SHA-256 is pinned in `ah-engine.lock` and verified before the binary runs; a mismatch means it is not used (hook calls then pass through with a one-line notice). The only other request is the optional update check (a GitHub tag-list request, no project data). |
| **Sends** | Only if you turn on Jev (opt-in, off by default): review questions go to the one vendor whose API key you entered in the plugin options, and to no other. Nothing else is sent. No analytics, no telemetry upload; usage counters stay on your machine. |

Details and every setting: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).

## Documentation

Everything else (every guard and setting, all skills, legacy statusline cleanup, troubleshooting, the
Codex port, contributing) starts at the
[documentation start page](https://github.com/talas9/anti-hall/blob/main/docs/README.md).
This README uses absolute GitHub URLs because it ships inside the plugin cache, where
`../../docs/` does not exist.

## Links

- [Documentation](https://github.com/talas9/anti-hall/blob/main/docs/README.md)
- [Docs site](https://talas9.github.io/anti-hall/)
- [Support](https://github.com/talas9/anti-hall/issues)
- [Privacy](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md)

## License

MIT © Mohammed Talas. See [LICENSE](https://github.com/talas9/anti-hall/blob/main/LICENSE).

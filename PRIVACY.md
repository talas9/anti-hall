# Privacy

As of plugin version 0.120.12.

## Summary

anti-hall has no telemetry, analytics or usage reporting. It makes one network request by default: an update check. Optional AI-assisted features send text to the provider you configure, and only after you turn them on.

## What leaves your machine

| Feature | Default | Destination | What is sent | Turn off |
|---|---|---|---|---|
| Update check | On | `github.com/talas9/anti-hall` (via `git ls-remote --tags`) | A tag-list request; no project data. Re-checked at most every 2 hours | `/anti-hall:settings` `versionAlerts.antiHall`, or `ANTIHALL_VERSION_ALERT=off` |
| Jev classifier | Off | `ai-gateway.vercel.sh` or `api.typesafe.ai`, per your setting | Text the feature judges, with your Jev key. May include your prompts, the assistant's last message (up to 8000 characters), test output, commit or PR text, subagent briefs, file paths and DevSwarm message text; most calls send at most 4000 characters. Not redacted, except DevSwarm supervision text | `jev.enabled` off, or `ANTIHALL_JEV=0` |
| Jev credit balance | Off | `ai-gateway.vercel.sh` | Your key only, when you run the Jev status or report commands | Same |
| Semantic judge | Off | `api.anthropic.com` | The assistant's last message (up to 8000 characters), with `ANTHROPIC_API_KEY` | Unset `ANTIHALL_SEMANTIC_JUDGE` |
| Mesh message triage | Off (needs Jev on) | Jev, then `api.anthropic.com` if `ANTHROPIC_API_KEY` is set | DevSwarm workspace message text, up to 4000 characters | `jevIntegrations.triage` off |

Other `git` requests happen only when you run them: `/anti-hall:update` pulls from the plugin's GitHub clone, and DevSwarm spawn fetches your own `origin` (setting `devswarm.spawnFromOrigin`).

## What stays on your machine

- `~/.anti-hall/`: settings, skip file, caches, and logs. The Jev decision log holds hashes and verdicts, not prompt text. Optional redacted snippets (at most 200 characters) are off unless you enable `jev.audit.snippets`. The decision log rotates at 2 MB, and per-session state files are pruned after 7 days. Defect reports stay local.
- `<repo>/.anti-hall/`: progress notes, history ledgers and handovers, which can quote your session.

## Third-party tools

The plugin does not run `gh` or `codex` itself; it only checks whether `codex` is on your `PATH`. When you or the assistant run `git`, `gh`, `codex` or DevSwarm's `hivecontrol`, they act under your own accounts and their own privacy policies.

## Your keys

The Jev key is read from an environment variable or key file and sent only to its vendor as a bearer token; `ANTHROPIC_API_KEY` goes only to `api.anthropic.com`. The client code does not log keys. What those vendors retain is set by their own policies.

## Changes to this policy

Changes are visible in this repository's history.

## Contact

Open a GitHub issue at github.com/talas9/anti-hall/issues, or use a private security advisory for sensitive matters.

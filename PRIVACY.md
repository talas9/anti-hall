# Privacy

Last updated: 2026-10-02.

## Summary

anti-hall has no telemetry, analytics or usage reporting. It makes one network request by default: an update check. Optional AI-assisted features send text to the provider you configure, and only after you turn them on.

## What leaves your machine

| Feature | Default | Destination | What is sent | Turn off |
|---|---|---|---|---|
| Update check | On | `github.com/talas9/anti-hall` (via `git ls-remote --tags`) | A tag-list request; no project data. Re-checked at most every 2 hours | `/anti-hall:settings` `versionAlerts.antiHall`, or `ANTIHALL_VERSION_ALERT=off` |
| Jev classifier | Off | `ai-gateway.vercel.sh` or `api.typesafe.ai`, per your setting | Text the feature judges, with your Jev key. May include your prompts, the assistant's last message (up to 8000 characters), test output, commit or PR text, subagent briefs, file paths and DevSwarm message text; most calls send at most 4000 characters. Secrets matching known token shapes are redacted before sending (best-effort; short or unlabelled secrets may not be caught); DevSwarm supervision text is also redacted | `jev.enabled` off, or `ANTIHALL_JEV=0` |
| Jev credit balance | Off | `ai-gateway.vercel.sh` | Your key only, when you run the Jev status or report commands | Same |
| Semantic judge | Off | `api.anthropic.com` | The assistant's last message (up to 8000 characters), with your Anthropic key | Off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1`. To stop it: `jev.semanticJudge` false and `ANTIHALL_SEMANTIC_JUDGE` unset |
| Mesh message triage | Off (needs Jev on) | Jev, then `api.anthropic.com` if an Anthropic key is available | DevSwarm workspace message text, up to 4000 characters | `jevIntegrations.triage` off |

Other `git` requests happen only when you run them: `/anti-hall:update` pulls from the plugin's GitHub clone, and DevSwarm spawn fetches your own `origin` (setting `devswarm.spawnFromOrigin`).

## What stays on your machine

- `~/.anti-hall/`: settings, skip file, caches, and logs. The Jev decision log holds hashes and verdicts, not prompt text. Optional redacted snippets (at most 200 characters) are off unless you enable `jev.audit.snippets`. The decision log rotates at 2 MB, and per-session state files are pruned after 7 days. Defect reports stay local.
- `<repo>/.anti-hall/`: progress notes, history ledgers and handovers, which can quote your session.
- Your account email: the optional statusline reads it from Claude Code's own `~/.claude.json` to show it in the status bar. It is displayed only, never sent anywhere. Hide it with `statusline.noEmail` (`ANTIHALL_STATUSLINE_NO_EMAIL=1`).

## What it runs and writes

These are the notable things anti-hall runs and writes outside the project. Hook state lives under `~/.anti-hall/` and `<project>/.anti-hall/`.

| What | When | Where |
|---|---|---|
| Background units (launchd agent / systemd user unit / cron entry) for the optional DevSwarm ingest daemon, liveness supervisor and MCP reaper | Only if you run the matching `install-*` script | `~/Library/LaunchAgents/`, `~/.config/systemd/user/` or your crontab |
| `claude plugin update anti-hall@anti-hall` | When you run `/anti-hall:update` and the harness registration is older than the latest release | the `claude` CLI |
| `claude -p --resume <session> --dangerously-skip-permissions` | Only when you run the on-demand `devswarm-recover` CLI for one workspace | the `claude` CLI |
| statusLine entry in `~/.claude/settings.json` | Only when you install the statusline (`/anti-hall:install-statusline`) | `~/.claude/settings.json` |
| Launcher scripts that find the current plugin version | Written by the DevSwarm hooks in DevSwarm sessions | `~/.anti-hall/bin/` |
| Local reads of `~/.claude.json` (`userID`, Fable availability) and the OMC usage cache | By the limit-conservation and model-availability hooks; never sent anywhere | `~/.claude.json`, `~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json` |

## Jev fallback transport

If you set `jev.fallbackTransport`, a Jev call that fails on the primary vendor (timeout, network error, 5xx, 402, 429) is retried once on the second vendor (`ai-gateway.vercel.sh` or `api.typesafe.ai`). The same secret-scrubbed text then goes to that second vendor under its own terms. Default off.

## Third-party tools

The plugin does not run `gh` or `codex` itself; it only checks whether `codex` is on your `PATH`. When you or the assistant run `git`, `gh`, `codex` or DevSwarm's `hivecontrol`, they act under your own accounts and their own privacy policies.

## Your keys

Keys come from the sensitive plugin options you set on the plugin's options screen (Claude Code prompts for these options when the plugin is enabled; they can be changed later from the plugin's configuration) (`jev_vercel_api_key`, `jev_typesafe_api_key`, the legacy generic `jev_api_key`, `anthropic_api_key`). The plugin reads a key from your machine's environment or key file only if you opt in through a home-settings-only key (`jev.allowLegacyKeyRead` for the Jev key; `guards.allowAnthropicEnvKey` for `ANTHROPIC_API_KEY`); with the opt-in off it only checks whether such a key exists, without reading its value. A Jev key file must be a regular file under `~/.config` or `~/.anti-hall`. Each key is sent only to its vendor as a bearer token: each Jev key only to its own vendor's host (`jev_vercel_api_key` to the Vercel AI Gateway, `jev_typesafe_api_key` to the TypeSafe API; the legacy generic `jev_api_key` and `jev.keyFile` only to the one vendor named by the home-only setting `jev.genericKeyVendor` (default `vercel`; changed only by `jev-setup.js bind-generic-key`), never to another vendor even if `jev.transport` or `jev.fallbackTransport` is changed or flipped by an environment variable or plugin option; requests never follow redirects), `ANTHROPIC_API_KEY` to `api.anthropic.com`. The Jev endpoint override used by tests is honoured only for a loopback host; any other value is ignored, so a project setting cannot redirect your key. The client code does not log keys. What those vendors retain is set by their own policies.

## Changes to this policy

Changes are visible in this repository's history.

## Contact

Open a GitHub issue at github.com/talas9/anti-hall/issues, or use a private security advisory for sensitive matters.

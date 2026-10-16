# Privacy

Last updated: 2026-10-08.

## Summary

anti-hall has no analytics and reports nothing to anyone. It makes two network requests by default: an update check, and a one-time download of the optional `ah-engine` binary. The engine keeps local-only usage counters (see below). Optional AI-assisted features send text to the provider you configure, and only after you turn them on.

## What leaves your machine

| Feature | Default | Destination | What is sent | Turn off |
|---|---|---|---|---|
| Update check | On | `github.com/talas9/anti-hall` (via `git ls-remote --tags`) | A tag-list request; no project data. Re-checked at most every 2 hours | `/anti-hall:settings` `versionAlerts.antiHall`, or `ANTIHALL_VERSION_ALERT=off` |
| Engine binary download | On, once per pinned release (needs a release that pins `ah-engine.lock`) | `github.com/talas9/anti-hall` Releases (HTTPS) | The release archive for your platform; no data about you or your project is sent. Installed only if its sha256 equals the one pinned in the plugin; a mismatch installs nothing. Off: the setting `engine.bootstrap` = false or `AH_ENGINE_BOOTSTRAP=0` (the Node hooks then do everything) |
| Engine update (`ah-update`) | Off until you run `hooks/ah-update.sh` or set `engine.autoUpdate` to `stable` or `dev` | `api.github.com` and `github.com/talas9/anti-hall` Releases (HTTPS); for the dev channel with a live kit also `git fetch` of one commit | The release list, the engine archive for your platform, `SHA256SUMS` and the build attestation (via `gh`, if installed). No data about you or your project is sent. Installed only if the sha256 matches; a mismatch installs nothing. Off: `engine.autoUpdate` = off (default) |
| Jev classifier | Off | `ai-gateway.vercel.sh` or `api.typesafe.ai`, per your setting | Text the feature judges, with your Jev key. May include your prompts, the assistant's last message (up to 8000 characters), test output, commit or PR text, subagent briefs, file paths and DevSwarm message text; most calls send at most 4000 characters. Secrets matching known token shapes are redacted before sending (best-effort; short or unlabelled secrets may not be caught); DevSwarm supervision text is also redacted | `jev.enabled` off, or `ANTIHALL_JEV=0` |
| Jev credit balance | Off | `ai-gateway.vercel.sh` | Your key only, when you run the Jev status or report commands | Same |
| Semantic judge | Off | `api.anthropic.com` (directly with your Anthropic key, or through your own `claude` CLI login when `jev.judgeBackend` is `cli`/`auto`) | The assistant's last message (up to 8000 characters), your latest prompt (up to 2000 characters) and the newest tool calls and tool output from the session (up to about 6000 characters); secrets matching known token shapes are redacted before sending (best-effort) | Off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1`. To stop it: `jev.semanticJudge` false and `ANTIHALL_SEMANTIC_JUDGE` unset |
| Mesh message triage | Off (needs Jev on) | Jev, then `api.anthropic.com` if an Anthropic key is available | DevSwarm workspace message text, up to 4000 characters | `jevIntegrations.triage` off |

Other `git` requests happen only when you run them: `/anti-hall:update` pulls from the plugin's GitHub clone, and DevSwarm spawn fetches your own `origin` (setting `devswarm.spawnFromOrigin`).

## What stays on your machine

- `~/.anti-hall/`: settings, skip file, caches, and logs. The Jev decision log holds hashes and verdicts, not prompt text. Optional redacted snippets (at most 200 characters) are off unless you enable `jev.audit.snippets`. The decision log rotates at 2 MB, and per-session state files are pruned after 7 days. Defect reports stay local.
- `<repo>/.anti-hall/`: progress notes, history ledgers and handovers, which can quote your session.
- Legacy statusline cleanup: anti-hall no longer installs a Claude `statusLine`; `uninstall-statusline` may read old anti-hall statusline settings to remove them.

## Local telemetry (engine)

The optional `ah-engine` counts what it and the hooks did: per hook or check, the event, the outcome (allow, block, advise, defer, error, skip), a latency histogram and the bytes injected into the model's context. A line with text where an identifier belongs is rejected, so no prompt, transcript or file text is stored. It lives in `~/.anti-hall/ah-engine/` (SQLite), is never uploaded, is kept `telemetry.retention_days` (default 30) and is read with `ah-engine telemetry summary`. Turn it off with `telemetry.enabled`.

## What it runs and writes

These are the notable things anti-hall runs and writes outside the project. Hook state lives under `~/.anti-hall/` and `<project>/.anti-hall/`.

| What | When | Where |
|---|---|---|
| Background units (launchd agent / systemd user unit / cron entry) for the optional DevSwarm ingest daemon, liveness supervisor and MCP reaper | Only if you run the matching `install-*` script | `~/Library/LaunchAgents/`, `~/.config/systemd/user/` or your crontab |
| `claude plugin update anti-hall@anti-hall` | When you run `/anti-hall:update` and the harness registration is older than the latest release | the `claude` CLI |
| `claude -p --resume <session> --dangerously-skip-permissions` | Only when you run the on-demand `devswarm-recover` CLI for one workspace | the `claude` CLI |
| statusLine entry in `~/.claude/settings.json` | No longer written; uninstall only removes old anti-hall entries | `~/.claude/settings.json` |
| `ah-engine serve`, a detached per-user background process with a Unix socket in a private directory (no network); `bootstrap.log` | Started by the first hook call once the engine binary is installed; exits on its memory cap, `ah-engine stop` or a newer build | `~/.anti-hall/ah-engine/` |
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

---
name: update
description: Update anti-hall to the latest released version and show the changelog delta. Use when the user says "update anti-hall", "/anti-hall:update", "upgrade the plugin", "is anti-hall up to date", or "check for an anti-hall update". Fast-forward-pulls the marketplace clone, mirrors the new version into the plugin cache, prints what changed, then has the user reload in-session via /reload-plugins (rarely, a harness build may require a restart — the skill says so when relevant).
---

# Update

Brings anti-hall up to the latest released version **in place** and reports exactly
what changed. The hard part of a plugin self-update is honesty about what actually
takes effect in-session — this skill does not over-promise.

## How the install is laid out (VERIFIED — do not re-derive)

- **Marketplace clone** — `~/.claude/plugins/marketplaces/anti-hall/` — a real git
  checkout (origin = github.com/talas9/anti-hall). This is what we `git pull --ff-only`.
- **Version-pinned cache** — `~/.claude/plugins/cache/anti-hall/anti-hall/<version>/` —
  the manager's per-version copy that `/reload-plugins` resolves against.
- **Active version** — recorded by the harness in
  `~/.claude/plugins/installed_plugins.json` under key `anti-hall@anti-hall`. This file
  is **HARNESS-OWNED**: the helper reads it, it **never** writes it.
- **Version authority** — `plugins/anti-hall/.claude-plugin/plugin.json` in the clone.
  `CHANGELOG.md` (repo root) carries one `## <version>` section per release.
- **DevSwarm ingest daemon's baked script path** — `install-devswarm-ingest.js`'s daemon
  unit bakes the **marketplace clone's own `companion/devswarm-ingest.js`** (this is the
  ONE path this skill `git pull --ff-only`s in place — never a version-pinned cache dir,
  which is a NEW directory per release). That is what makes the daemon survive an update
  without crash-looping; see step 5's ingest-daemon heal below for the one-time repair of
  a daemon installed before this fix shipped.

## What the helper does (`scripts/update.js`)

Pure Node ≥ 18 built-ins, cross-platform (Windows included), fail-open
(report-don't-break). It makes **no writes outside the marketplace clone and stdout** —
the only filesystem mutation is copying the clone's `plugins/anti-hall/` into a **new**
`cache/.../<newver>/` dir (it never deletes or overwrites another version dir).

1. Resolve paths (`ANTIHALL_MARKETPLACE_DIR` overrides the clone path for tests).
2. Read the INSTALLED version: `installed_plugins.json` → newest cache dir → clone
   `plugin.json` (first that resolves wins).
3. `git -C <clone> pull --ff-only` (via `execFileSync`, no shell). **Never** merges,
   rebases, or force-pulls. A **dirty tree** or a **non-fast-forward** divergence is a
   hard STOP with a clear message (exit 1) — it does not try to "fix" it. Offline / no
   git → reported, exit 0.
4. Read the NEW version from the (now-updated) clone `plugin.json`.
5. If `cache/.../<newver>/` is missing **and** the cache root exists, mirror the clone's
   plugin dir into it so `/reload-plugins` can resolve the new version.
   - **Ingest-daemon heal (auto, gated, fail-open — `healIngestDaemon`):** immediately
     after a cache sync, the helper ALSO attempts to heal the DevSwarm ingest daemon's
     launchd/systemd/cron unit in-process (no separate agent step needed for this part).
     Root cause: `install-devswarm-ingest.js`'s daemon unit used to bake an install-time
     script path (`__dirname`) that could go stale across a plugin update — the plugin
     manager relocating the version-pinned cache dir the daemon was baked from, crash-
     looping the daemon. The installer now bakes the **git marketplace clone's own copy**
     of `devswarm-ingest.js` (the exact path this very update step just `git pull
     --ff-only`ed **in place**) so a fresh install never goes stale again — but a daemon
     installed *before* this fix shipped is still pointed at a path that may now be gone,
     and needs a one-time re-bake. `healIngestDaemon` runs ONLY under the same
     DevSwarm-session-only gate `hooks/lib/doctor-repair.js`'s own GATED ingest fix uses
     (`isDevswarmActive(env) && resolveWorktree(cwd) !== null`) and reuses that module's
     already-tested classify/detect helpers rather than re-deriving the logic; it re-runs
     the (freshly-pulled) installer only when the unit is genuinely `wrong-path` or
     `stale-script` — an `ok` or `absent` unit is left untouched. Reported as `ingestHeal:
     {attempted, healed, detail}` on the JSON status line. Gate-closed, nothing-to-heal,
     or an internal error are all reported and NEVER fatal to the update. This is
     independent of — and does not replace — step 7's broader, always-refresh install/
     refresh instruction below (which also covers a FIRST install and the supervisor).
6. Extract the `CHANGELOG.md` sections strictly between installed (exclusive) and new
   (inclusive) and print them.
7. Emit a JSON status line + a human summary:
   `{installed, latest, updated, cacheSynced, ingestHeal, action}` where `action` is
   `run /reload-plugins` | `already up to date` | an error/STOP detail, and `ingestHeal`
   is `{attempted, healed, detail}` from step 5's auto-heal (absent on a STOP/offline
   report — those paths never reach cache sync).

Modes:
- `node scripts/update.js --check` — `git fetch` + compare local vs remote
  `plugin.json` version. **No pull, no writes.** Answers "is anti-hall up to date?".
- `node scripts/update.js` — the full update above.

## Steps

1. Pick the mode from the user's words:
   - "is anti-hall up to date" / "check for an update" → `--check`
   - "update" / "upgrade anti-hall" → full update
2. The helper is a `node` script (a state change — it pulls and may copy into the
   cache), so **delegate it to a Haiku subagent** (`model:"haiku"`) — do not run it
   inline in the coordinator (the command-guard blocks heavy commands on the main
   thread; an execution-shaped spawn with no explicit model also trips
   model-routing-guard's strict-mode block). Brief the subagent to run exactly one of:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/update/scripts/update.js" --check
   node "${CLAUDE_PLUGIN_ROOT}/skills/update/scripts/update.js"
   ```
   and report its stdout verbatim (the JSON line + the human summary).
3. Present the result to the user: the `installed → latest` versions, whether it
   updated, and the **changelog delta** (the printed `## <version>` sections).
4. If the helper hit a **STOP** (dirty clone / diverged branch) or reported
   offline / no-git, relay that message as-is — do **not** attempt a merge, rebase, or
   force-pull on the user's behalf. Tell them to resolve it in
   `~/.claude/plugins/marketplaces/anti-hall/`.
5. On a successful update (`action: run /reload-plugins`), **always** end with:

   > Run **/reload-plugins** now to load `<version>` in this session (rarely, a
   > harness build may require a restart instead — if the new version is not
   > reflected after reloading, restart Claude Code). Statusline + hooks pick up
   > changes automatically; /reload-plugins refreshes the skill list and version
   > label.
6. After pulling a new plugin version, run
   `node plugins/anti-hall/scripts/migrate-state.js` once per repo (idempotent,
   safe to re-run) to fold any legacy root-level `.anti-hall-progress.md` /
   `.anti-hall-history.md` files into the new dated `.anti-hall/history/`
   structure. The same command also folds a GSD `.planning/` tree (if present)
   into `.anti-hall/history/legacy/planning/` — non-destructive; GSD's own
   `/gsd-*` tooling keeps working against the untouched original. Owner
   decision (2026-07-03): `.anti-hall/` is the intended destination for
   progress/handover state across all projects going forward.
7. Run the capability scan (`node plugins/anti-hall/scripts/capability-scan.js`)
   to find what's missing on **this machine** vs what this build **ships**.
   Read-only — it never installs anything. It reports each opt-in capability
   (companions under `companion/install-*.js`, statusline, pending state
   migrations) as `{name, available, active, how}`. Present a concise
   available-vs-active summary to the user:
   - `state-migrations` at `active: false` is already handled by step 6 above
     (it just ran) — no action needed, don't re-surface it as a gap.
   - **DevSwarm liveness supervisor** — **autonomously install-or-refresh it
     whenever this update is running inside a DevSwarm session, no offer, no
     ask.** Check `devswarm-detect`'s `isDevswarmActive(process.env)` — true
     only when `DEVSWARM_REPO_ID` is set, i.e. the current session really is a
     DevSwarm workspace (do NOT trigger on machine-level descriptor presence
     alone; the session might be running outside DevSwarm). If inside a
     DevSwarm session, run its `how` command
     (`node companion/install-devswarm-supervisor.js`) regardless of the
     capability scan's `active` value — delegate to a **Haiku subagent**
     (`model:"haiku"`), never inline (it's a `node` script that writes a
     launchd/systemd/cron job; the command-guard blocks heavy commands on the
     main thread). The installer is idempotent (`launchctl unload && load` on
     macOS / systemd reload on Linux), so this both first-installs when absent
     and refreshes an already-installed supervisor so the next sweep runs this
     build's code. REPORT it plainly ("DevSwarm session detected — installed/
     refreshed the liveness supervisor to `<version>`"). Fail-open: an install/
     refresh failure is reported, never fatal to the update. If NOT inside a
     DevSwarm session, do **not** install — just note it's available. (Safe to
     do unprompted: the supervisor's automatic sweep never kills — killing is
     only the separate on-demand `devswarm-recover` CLI. Defense in depth: the
     installed daemon is inert without work — it only ever acts on descriptors
     under `~/.anti-hall/devswarm/workspaces/`, so it no-ops when DevSwarm isn't
     actually running.)
   - **DevSwarm ingest daemon** — install-or-refresh it under the **same
     DevSwarm-session-only, no-offer, no-ask posture as the supervisor above**,
     in the SAME `isDevswarmActive(process.env)` branch. When inside a DevSwarm
     session, also run its `how` command
     (`node companion/install-devswarm-ingest.js`) regardless of the scan's
     `active` value — delegate to a **Haiku subagent** (`model:"haiku"`), never
     inline (it's a `node` script that writes a launchd/systemd/cron unit; the
     command-guard blocks heavy commands on the main thread). It is idempotent
     (`launchctl unload && load` on macOS / `systemctl --user daemon-reload` +
     `restart` on Linux), so it first-installs when absent and refreshes an
     already-installed daemon to this build's code. Unlike the supervisor (a
     periodic sweep), the ingest daemon runs **continuously** — the unit uses
     `KeepAlive`/`Restart=always` to re-exec it on exit; that is why it has a
     distinct label (`com.anti-hall.devswarm-ingest`) and log
     (`~/.anti-hall/devswarm-ingest.log`). It is the single native consumer that
     wraps `hivecontrol workspace monitor` and folds messages into the store;
     nothing else auto-starts it, so a DevSwarm session without it silently
     ingests nothing. Safe to install unprompted and idempotently: the daemon
     takes an O_EXCL single-consumer lock, so only ONE instance ever runs even if
     multiple installs race — a redundant install is a no-op. REPORT it plainly
     ("DevSwarm session detected — installed/refreshed the ingest daemon to
     `<version>`"). Fail-open: an install/refresh failure is reported, never
     fatal to the update. If NOT inside a DevSwarm session, do **not** install —
     just note it's available.
   - **Any other opt-in companion** at `active: false` (e.g. mcp-reaper — no
     active-integration signal) — just print its `how` command and let the user
     install it when they want.
   - `active: 'unknown'` — the probe couldn't determine state (fail-open);
     mention it as unverified rather than claiming either state.
   - `active: true` for everything — say so briefly; no gaps to report.

## Why /reload-plugins, and the honest edge

`/reload-plugins` is a built-in, user-typed command that reloads plugins, skills, hooks,
and agents in-session (documented in discover-plugins.md). Hooks are re-executed from
disk per event, and the statusline dispatcher reads from the stable marketplace path on
every render — so **hook and statusline changes are live without any reload**.
`/reload-plugins` is what refreshes the **skill list** and the **version label**.

**Honest edge:** on some harness builds `/reload-plugins` may not pick up a brand-new
version dir until a restart. If after `/reload-plugins` the new version is not reflected,
the fallback is to **restart Claude Code**. Do not claim more than this — the update on
disk is real either way; only the in-session refresh path varies by harness build.

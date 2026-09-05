---
name: anti-hall-update
description: Check or update anti-hall from the local marketplace clone. Use when the user asks to update anti-hall, check whether anti-hall is current, or refresh the Codex port files.
---

# anti-hall update for Codex

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`docs/KB-codex-platform-hooks-plugins.md`). Codex does show you this skill's own
file path when it selects the skill ("Codex starts with each skill's name,
description, and file path" — official Codex Skills doc). Resolve the plugin
root from that path before running anything below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

Use the existing pure-Node update helper:

```bash
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js" --check
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js"
```

For Codex, also re-run the Codex hook installer after a successful update:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

or for global Codex hooks:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```

Do not force-pull, rebase, or delete plugin cache directories. If the update helper reports a dirty tree, diverged branch, offline state, or missing marketplace clone, surface that result and stop.

## DevSwarm ingest daemon durability (auto-heal, gated, fail-open)

`install-devswarm-ingest.js`'s daemon unit used to bake an install-time script path
(`__dirname`) that could go stale across a plugin update — the plugin manager relocating
the version-pinned cache dir the daemon was baked from, orphaning/crash-looping the
daemon. The installer now bakes the **git marketplace clone's own copy** of
`devswarm-ingest.js` (the exact path the update helper above just `git pull --ff-only`ed
**in place**), so a fresh install never goes stale again.

The update helper (`scripts/update.js`) ALSO attempts to heal an already-installed daemon
in-process via `healIngestDaemon` — no separate step needed. **v0.86.0 — the heal fires
when EITHER this run synced new bytes into the cache OR the installed unit fails to
classify `ok`.** Gating it on a cache sync alone made it unreachable in exactly the state
it was written for: a daemon goes stale with NO version bump, and in that steady state the
installed version already equals latest, `syncCache` no-ops, and the classifier that would
have spotted the dangling script path never ran. The extra arm is read-only on a no-sync
run (a unit enumeration plus a few `statSync`s — no spawn, no writes) and deliberately
does NOT treat `absent` as "needs heal", so a no-op update can never first-install an
opt-in daemon for a user who never enabled it. It runs ONLY under the same
DevSwarm-session-only gate
`hooks/lib/doctor-repair.js`'s own gated ingest fix uses
(`isDevswarmActive(env) && resolveWorktree(cwd) !== null`), and re-runs the
(freshly-pulled) installer only when the unit is genuinely `wrong-path` or `stale-script`
— an `ok` or `absent` unit is left untouched. The daemon also now logs
(startup / lock-refusal / ERROR+stack) to `~/.anti-hall/devswarm-ingest.log` instead of
discarding output. Reported as `ingestHeal: {attempted, healed, detail}` on the update
helper's JSON status line (`{installed, latest, updated, cacheSynced, ingestHeal,
action}`) — absent on a STOP/offline report, since those paths never reach cache sync.
Gate-closed, nothing-to-heal, or an internal error are all reported and NEVER fatal to
the update. This is independent of — and does not replace — the ingest-daemon
install-or-refresh step further below (which also covers a FIRST install).

## Reconcile (auto, DevSwarm-session-only, fail-open — v0.58.1)

Every update run ALSO drains `node scripts/devswarm.js reconcile` in-process via
`reconcilePostUpdate` — no separate step needed. `reconcile` (v0.58.0) drains every
worktree registered in this project's shared store once, recovering messages stranded in
a per-worktree native hivecontrol queue whose child never ran `inbox pull` itself (e.g. a
worktree torn down before it drained). Previously a MANUAL-only verb; now auto-run
whenever `isDevswarmActive(process.env)` — `DEVSWARM_REPO_ID` set, i.e. an actual
DevSwarm session (do NOT trigger on machine-level descriptor/registry-file presence
alone) — regardless of whether the cache actually synced this run (a stranded queue is
unrelated to whether the plugin version changed — the same reasoning that, in v0.86.0,
freed the ingest heal above from its own cache-sync gate). Safe to
auto-run: idempotent (content-hash dedup), lock-respecting (a worktree a live child is
already draining is skipped, never raced), and loss-free (a short-received batch fails
loud rather than silently dropping messages). Reported as
`reconcile: {attempted, count, imported, results, detail}` on the JSON status line.
Gate-closed or an internal error are both reported and NEVER fatal to the update. The
manual verb (`node scripts/devswarm.js reconcile`) stays available for an on-demand sweep
outside an update.

**Promote unclaimed sessions (auto, fail-open — `promoteUnclaimedPostUpdate`, v0.90.0):**
every update run also sweeps every descriptor for the `unclaimed:` forward migration,
promoting a row to its real session id wherever an independent source (a heartbeat's own
recorded `sessionId`) proves one — see `docs/KB-devswarm-hivecontrol.md` §40 for the
sourcing rules this is a forward migration of.

**(v0.94.0) Bounded reconcile.** `reconcile` now applies a total wall-clock budget across all
its per-row drains — `ANTIHALL_RECONCILE_BUDGET_MS` (default `60000`; `0` = unlimited) or
`--budget-ms` on a direct CLI call — so a large stranded backlog can no longer hang `update`
indefinitely (defect f3c1bc827d89). A row whose worktree no longer exists on disk is skipped
before it costs any budget; whatever is still deferred when the budget runs out is written to
a resume marker and drained FIRST on the next sweep. Separately, `update.js`'s stdout contract
(the JSON status line + human summary) is unchanged, but it now also prints a `[update]
<stage> start` / `done <ms>ms` line to **stderr** around each post-update stage so a slow
stage is visible while it runs; `ANTIHALL_UPDATE_QUIET=1` suppresses these lines.

After a successful update, also run the capability scan to find what's missing on this machine vs what this build ships:

```bash
node "$ANTI_HALL_ROOT/scripts/capability-scan.js"
```

Read-only — it never installs anything. It reports each opt-in capability (companions under `companion/install-*.js`, statusline, pending state migrations) as `{name, available, active, how}`. Present a concise available-vs-active summary:
- `state-migrations` at `active: false` — run `node "$ANTI_HALL_ROOT/scripts/migrate-state.js"` (idempotent, safe to re-run) to fold it, same as the Claude-side update flow.
- **DevSwarm liveness supervisor** — **autonomously install-or-refresh it
  whenever this update is running inside a DevSwarm session, no offer, no
  ask.** Check `devswarm-detect`'s `isDevswarmActive(process.env)` — true only
  when `DEVSWARM_REPO_ID` is set, i.e. the current session really is a DevSwarm
  workspace (do NOT trigger on machine-level descriptor presence alone; the
  session might be running outside DevSwarm). If inside a DevSwarm session, run
  its `how` command (`node companion/install-devswarm-supervisor.js`)
  regardless of the capability scan's `active` value. The installer is
  idempotent (`launchctl unload && load` on macOS / systemd reload on Linux),
  so this both first-installs when absent and refreshes an already-installed
  supervisor so the next sweep runs this build's code. **Report it** plainly
  ("DevSwarm session detected — installed/refreshed the liveness supervisor to
  `<version>`"). Fail-open: an install/refresh failure is reported, never fatal
  to the update. If NOT inside a DevSwarm session, do **not** install — just
  note it's available. (Safe to do unprompted: the supervisor's automatic
  sweep never kills — killing is only the separate on-demand
  `devswarm-recover` CLI. Defense in depth: the installed daemon is inert
  without work — it only ever acts on descriptors under
  `~/.anti-hall/devswarm/workspaces/`, so it no-ops when DevSwarm isn't
  actually running.)
- **DevSwarm ingest daemon** — install-or-refresh it under the **same
  DevSwarm-session-only, no-offer, no-ask posture as the supervisor above**, in
  the SAME `isDevswarmActive(process.env)` branch. When inside a DevSwarm
  session, also run its `how` command
  (`node companion/install-devswarm-ingest.js`) regardless of the scan's
  `active` value. It is idempotent (`launchctl unload && load` on macOS /
  `systemctl --user daemon-reload` + `restart` on Linux), so it first-installs
  when absent and refreshes an already-installed daemon to this build's code.
  Unlike the supervisor (a periodic sweep), the ingest daemon runs
  **continuously** — the unit uses `KeepAlive`/`Restart=always` to re-exec it on
  exit; hence a distinct label (`com.anti-hall.devswarm-ingest`) and log
  (`~/.anti-hall/devswarm-ingest.log`). It is the single native consumer that
  wraps `hivecontrol workspace monitor` and folds messages into the store;
  nothing else auto-starts it, so a DevSwarm session without it silently ingests
  nothing. Safe to install unprompted and idempotently: the daemon takes an
  O_EXCL single-consumer lock, so only ONE instance ever runs even if installs
  race. **Report it** plainly ("DevSwarm session detected — installed/refreshed
  the ingest daemon to `<version>`"). Fail-open: an install/refresh failure is
  reported, never fatal to the update. If NOT inside a DevSwarm session, do
  **not** install — just note it's available.
- Any other opt-in capability at `active: false` (e.g. mcp-reaper — no
  active-integration signal) — guide, don't auto-install: print its `how`
  command and let the user decide.
- `active: 'unknown'` — the probe couldn't determine state (fail-open); mention it as unverified rather than claiming either state.
- `active: true` for everything — say so briefly; no gaps to report.

After updating, restart Codex or start a fresh session if plugin/skill discovery does not reflect the new files immediately.

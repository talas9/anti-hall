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

## What the helper does (`skills/update/scripts/update.js`)

Pure Node ≥ 22 built-ins, cross-platform (Windows included), fail-open
(report-don't-break). It makes **no writes outside the marketplace clone and stdout** —
the only filesystem mutation is copying the clone's `plugins/anti-hall/` into a **new**
`cache/.../<newver>/` dir (it never deletes or overwrites another version dir).

**(v0.94.0)** The stdout contract (the JSON status line + human summary) is unchanged, but
`update.js` now also prints a `[update] <stage> start` / `done <ms>ms` line to **stderr**
around each post-update stage (reconcile, fold, migrations, ...) so a slow stage is visible
while it runs instead of the script staying silent until every stage returns. Set
`ANTIHALL_UPDATE_QUIET=1` to suppress these lines (e.g. for a caller that captures stderr for
its own purposes).

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
   - **Ingest-daemon heal (auto, gated, fail-open — `healIngestDaemon`):** the helper
     ALSO attempts to heal the DevSwarm ingest daemon's launchd/systemd/cron unit
     in-process (no separate agent step needed for this part). **v0.86.0 — the heal
     now fires when EITHER this run synced new bytes into the cache OR the installed
     unit fails to classify `ok`.** Gating it on a cache sync alone made it
     unreachable in exactly the state it was written for: a daemon goes stale with NO
     version bump (the plugin manager relocates or `.bak`s the version-pinned cache
     dir the unit was baked from), and in that steady state the installed version
     already equals latest, `syncCache` no-ops, and the classifier that would have
     spotted the dangling script path never ran. The extra arm is read-only on a
     no-sync run (a unit enumeration plus a few `statSync`s — no spawn, no writes)
     and deliberately does NOT treat `absent` as "needs heal", so a no-op update can
     never first-install an opt-in daemon for a user who never enabled it.
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
   - **Harness re-registration (auto, fail-open — `harnessRegisterPostUpdate`,
     P0 — proven live):** Claude Code itself loads this plugin from
     `~/.claude/plugins/installed_plugins.json`'s
     `plugins["anti-hall@anti-hall"][].installPath` — a **HARNESS-OWNED** file
     this helper only ever reads. Every step above (pull + cache mirror)
     changes the marketplace clone and the cache dir, but does **nothing** to
     that pointer, so a session — including after a full app/Claude restart —
     keeps loading whatever version `installed_plugins.json` still names until
     the harness re-registers it itself. Whenever `installed_plugins.json`'s
     own recorded version is older than the newly-pulled version, the helper
     runs the harness's own `claude plugin update anti-hall@anti-hall`
     (`execFileSync`, ~20s timeout) to trigger that re-registration. **Never
     interactive**: if the harness reports it needs an `--accept-command
     <sha256>` confirmation (command-source installs) or the command fails for
     any reason, the helper does **not** retry with `--accept-command` — it
     reports the exact command for a human to run. Reported as
     `harnessRegistered: {attempted, ok, detail}` on the JSON status line and
     in the human summary. **On success, tell the user to RESTART Claude Code
     (exit and resume the session) to load it — field-verified (2026-09-24):
     after `claude plugin update` the registry updates immediately, but a
     session ALREADY RUNNING keeps executing hooks from the OLD install path
     until it restarts (`claude plugin update --help` itself says "restart
     required to apply"). `/reload-plugins` is NOT sufficient for this path —
     unlike a fresh cache-dir sync (step 5 above), which `/reload-plugins`
     alone can pick up — never tell the user it might be enough here.**
     `installed_plugins.json` itself is still never written directly by this
     helper.
   - **Reconcile (auto, DevSwarm-session-only, fail-open — `reconcilePostUpdate`,
     v0.58.1):** every update run ALSO drains `node scripts/devswarm.js reconcile`
     in-process — no separate agent step needed for this part. `reconcile` (v0.58.0)
     drains every worktree registered in this project's shared store once, recovering
     messages stranded in a per-worktree native hivecontrol queue whose child never ran
     `inbox pull` itself (e.g. a worktree torn down before it drained). Previously a
     MANUAL-only verb; now auto-run whenever `isDevswarmActive(env)` — `DEVSWARM_REPO_ID`
     set, i.e. an actual DevSwarm session (do NOT trigger on machine-level
     descriptor/registry-file presence alone) — regardless of whether the cache actually
     synced this run (a stranded queue is unrelated to whether the plugin version
     changed — the same reasoning that, in v0.86.0, freed the ingest heal above from
     its own cache-sync gate). Safe to auto-run: idempotent (content-hash
     dedup — a re-run imports 0 new messages), lock-respecting (a worktree a live child
     is already draining is skipped via the per-id O_EXCL pull lock, never raced), and
     loss-free (a short-received batch fails loud rather than silently dropping
     messages — see `docs/KB-devswarm-hivecontrol.md` §8.8's `reconcile` row). Reported
     as `reconcile: {attempted, count, imported, results, detail}` on the JSON status
     line and as a per-worktree breakdown in the human summary. Gate-closed or an
     internal error are both reported and NEVER fatal to the update. The manual verb
     (`node scripts/devswarm.js reconcile`) stays available for an on-demand sweep
     outside an update.
   - **Promote unclaimed sessions (auto, fail-open — `promoteUnclaimedPostUpdate`,
     v0.90.0):** every update run also sweeps every descriptor for the `unclaimed:`
     forward migration, promoting a row to its real session id wherever an independent
     source (a heartbeat's own recorded `sessionId`) proves one — see
     `docs/KB-devswarm-hivecontrol.md` §40 for the sourcing rules this is a forward
     migration of.
   - **Overall post-pull budget (v0.96.0, D11-C, defect e7307778b614 — `postPullBudgetMs`):**
     a single wall-clock budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default 90000ms;
     `0` = unlimited) now bounds every DevSwarm post-pull stage COMBINED — reconcile, fold,
     fold-all-stores, heal-orphan-partitions, fold-archived-rows, and heal-registry-rows —
     checked BEFORE each stage starts (never mid-stage). A stage that would start past the
     deadline is deferred WHOLE, reported as `deferred: true` on its stage result, and picked
     up on the NEXT `update`/`doctor` call rather than lost: every one of these stages is
     independently idempotent/resumable (fold/heal/fold-archived-rows persist their own
     resume markers; the one-time-per-version stages simply re-attempt next call). As of
     v0.96.1, the periodic supervisor sweep (`companion/devswarm-supervisor.js`) also picks
     up `fold-all-stores`, `heal-orphan-partitions`, `fold-archived-rows` and (v0.102.1)
     `heal-registry-rows` — one deferred
     stage per supervisor pass, within `ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS` (default
     20000ms) — so a machine that always exhausts the post-pull budget is no longer stuck
     waiting on the next explicit `update`/`doctor` call to make progress on those stages.
6. Extract the `CHANGELOG.md` sections strictly between installed (exclusive) and new
   (inclusive) and print them.
7. Emit a JSON status line + a human summary:
   `{installed, latest, updated, cacheSynced, ingestHeal, reconcile, harnessRegistered,
   action}` where `action` is `run /reload-plugins` | `already up to date` | an
   error/STOP detail, `ingestHeal` is `{attempted, healed, detail}` from step 5's
   auto-heal, `reconcile` is `{attempted, count, imported, results, detail}` from step
   5's reconcile auto-heal, and `harnessRegistered` is `{attempted, ok, detail}` from
   step 5's harness re-registration (all absent on a STOP/offline report — those paths
   never reach cache sync).

Modes:
- `node "${CLAUDE_PLUGIN_ROOT}/skills/update/scripts/update.js" --check` — `git fetch` + compare local vs remote
  `plugin.json` version. **No pull, no writes.** Answers "is anti-hall up to date?".
- `node "${CLAUDE_PLUGIN_ROOT}/skills/update/scripts/update.js"` — the full update above.

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
   node "$HOME/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/skills/update/scripts/update.js" --check
   node "$HOME/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/skills/update/scripts/update.js"
   ```
   **Always the MARKETPLACE CLONE's own copy, never `${CLAUDE_PLUGIN_ROOT}`**
   (the currently-LOADED, possibly-stale cache dir): a P0 field bug showed
   `${CLAUDE_PLUGIN_ROOT}` pulling a NEWER version, syncing the cache, then
   running the OLD cached version's own hardcoded post-pull stage list — a
   stage first added in the new release never ran until a second update or
   `doctor` call. The marketplace clone is always the newest copy right after
   `git pull --ff-only`, which `update.js` itself does as its first step, so
   this path is self-correcting even before that pull completes. (`update.js`
   also now re-execs the freshly-pulled version's own copy internally as a
   second line of defense — see its own `runPostPullReexec` — but the
   INVOCATION path here should never depend on that.)
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
disk per event (so in-place edits take effect on the next event), but the entry point's
`__dirname` is bound at session start to the versioned cache dir, so a NEW plugin version
installed to a new cache dir remains invisible until `/reload-plugins` or a restart.
`/reload-plugins` is what refreshes the **skill list**, **version label**, and **cache-bound paths**.

**Honest edge:** on some harness builds `/reload-plugins` may not pick up a brand-new
version dir until a restart. If after `/reload-plugins` the new version is not reflected,
the fallback is to **restart Claude Code**. Do not claim more than this — the update on
disk is real either way; only the in-session refresh path varies by harness build.

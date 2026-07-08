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
6. Extract the `CHANGELOG.md` sections strictly between installed (exclusive) and new
   (inclusive) and print them.
7. Emit a JSON status line + a human summary:
   `{installed, latest, updated, cacheSynced, action}` where `action` is
   `run /reload-plugins` | `already up to date` | an error/STOP detail.

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

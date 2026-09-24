#!/usr/bin/env node
// anti-hall :: version-alert (SessionStart)
//
// If a newer anti-hall version is available, injects an additionalContext
// DIRECTIVE (not just a fact) telling the agent to inform the user, e.g.:
//   "Tell the user now: anti-hall v0.107.0 is available (you are running
//   v0.104.0) — run /anti-hall:update ..., then reload ..."
//
// PROVEN ROOT CAUSE (2026-09-24, real ~/.anti-hall/version-check.json):
//   the old 24h cache TTL let a genuinely-fresh cache serve a STALE `latest`
//   for the rest of the day. v0.104.0 (checked ~07:21 UTC, correct AT THAT
//   MOMENT) through v0.107.0 (16:56 UTC) all shipped inside one 24h window;
//   the alert never fired for ANY of them because the cache "wasn't stale
//   yet" per the old TTL, even though six releases had happened since the
//   last check. See CHANGELOG "## Unreleased" for the full writeup.
//
// DESIGN (non-blocking, cached, two independent cases):
//   CASE 2 (reload only) — checked FIRST, no network, immune to TTL/cache
//     staleness and to installed_plugins.json lag (harness-owned, can report
//     a stale version — e.g. observed reporting 0.105.3 while 0.107.0 was
//     actually loaded/running): if the local plugin-cache dir
//     (~/.claude/plugins/cache/anti-hall/anti-hall/<version>/) already holds
//     a version newer than the one actually running (this file's own
//     ../.claude-plugin/plugin.json) — i.e. `/anti-hall:update` (or Codex's
//     update path) already mirrored it but the session hasn't reloaded —
//     tell the user to reload. Cheap enough to also read that version's own
//     CHANGELOG.md for a one-line headline (the file is already on disk).
//   CASE 1 (update needed) — Running version read from
//     ../.claude-plugin/plugin.json (SYNCHRONOUS, tiny). Cache read from
//     ~/.anti-hall/version-check.json = { latest, checkedAt }. Fresh cache
//     (< CACHE_TTL_MS) + latest > running => emit. Absent/stale cache =>
//     spawn a detached background refresh (version-alert-refresh.js) and
//     exit immediately; no alert this session.
//   CASE 3 (up to date) — neither of the above => silent no-op.
//   Once-per-SESSION: an alert already shown for the exact (session, case,
//   versions) tuple this session is not repeated on a same-session SessionStart
//   re-fire (resume/compact/fork) — but a DIFFERENT session with the same
//   versions is told again, since the owner wants a check every session.
//   Main-thread only: a payload carrying a subagent/sidechain marker is
//   skipped (see isSubagentPayload below for why this is defensive-only).
//
// Escape hatches:
//   - ANTIHALL_VERSION_ALERT=off disables the hook.
//   - skip.json { "version-alert": <future-ms> } (or "all") disables it.
//   - NOTE(settings.js pending): another worker is landing
//     hooks/lib/settings.js with a `versionAlert.enabled` boolean (default
//     true). Once that module exists, read it here as the primary opt-out,
//     ahead of the env var. VERSION_ALERT_ENABLED_DEFAULT below documents
//     that default in the meantime.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, cwd, permission_mode, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error — never slow or block session start).

'use strict';

const fs   = require('fs');
const path = require('path');
// v0.108.0 unified settings (env > ~/.anti-hall/settings.json > default);
// fail-open to `undefined` (never the value that would disable a guard).
function settingsGet(section, key) {
  try { return require('./lib/settings.js').get(section, key); } catch (_) { return undefined; }
}
const os   = require('os');
const { spawn } = require('child_process');
const { alreadyAdvisedKey, persistAdvisedKey, readCache: readDriftCache } = require('./lib/drift-baseline.js');

const PLUGIN_JSON  = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
const CACHE_FILE   = path.join(os.homedir(), '.anti-hall', 'version-check.json');
// CASE 2's own dedupe marker — kept SEPARATE from CACHE_FILE (the remote-latest
// cache) so a session that never had a network check (cache absent) still gets
// once-per-session dedupe on the reload nudge, and so the remote cache file
// stays a pure reflection of the last real network check (never a synthetic
// {checkedAt} invented just to carry a dedupe key).
const RELOAD_MARK_FILE = path.join(os.homedir(), '.anti-hall', 'version-alert-reload.json');

// See PROVEN ROOT CAUSE above: 2h keeps the check cheap (still cached,
// detached, off the critical path) while catching same-day releases within a
// couple of sessions instead of missing an entire day's worth.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// NOTE(settings.js pending) — see header comment.
const VERSION_ALERT_ENABLED_DEFAULT = true;

// Local plugin-cache root `/anti-hall:update` (and Codex's update path) mirror
// a new release into, one semver-named subdir per version — see
// plugins/anti-hall/skills/update/scripts/update.js's own resolvePaths().
// Deriving this from os.homedir() (not __dirname) keeps it test-injectable via
// HOME, same as every other anti-hall cache path.
const MIRROR_CACHE_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');

const SEMVER_DIR_RE = /^v?\d+\.\d+\.\d+$/;

// semverGreater(a, b) — true when a > b. Leading 'v' stripped. Fail-open: any
// parse error (non-numeric segment, missing parts) returns false (no alert).
function semverGreater(a, b) {
  try {
    const parse = (s) => String(s).replace(/^v/, '').split('.').map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : NaN;
    });
    const [aMaj, aMin, aPatch] = parse(a);
    const [bMaj, bMin, bPatch] = parse(b);
    if ([aMaj, aMin, aPatch, bMaj, bMin, bPatch].some(isNaN)) return false;
    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPatch > bPatch;
  } catch (_) {
    return false;
  }
}

function readRunningVersion() {
  const raw = fs.readFileSync(PLUGIN_JSON, 'utf8');
  const obj = JSON.parse(raw);
  if (typeof obj.version !== 'string' || !obj.version) throw new Error('missing version');
  return obj.version;
}

// readCache() — returns { latest, checkedAt, ... } or throws (absent / malformed).
function readCache() {
  const raw = fs.readFileSync(CACHE_FILE, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('bad cache');
  if (typeof obj.latest !== 'string' || !Number.isFinite(obj.checkedAt)) {
    throw new Error('bad cache shape'); // reject NaN/Infinity checkedAt too
  }
  return obj;
}

// newestMirroredVersion(root) -> highest vX.Y.Z-shaped subdirectory name under
// the local plugin-cache root, or null. isSemver-style dir-name gating (not a
// leading-digit match) so a commit-sha-named dir never sorts above a real
// version — same regression class update.js's own newestCacheVersion guards
// against.
function newestMirroredVersion(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory() && SEMVER_DIR_RE.test(e.name))
      .map((e) => e.name);
    if (!versions.length) return null;
    versions.sort((a, b) => {
      if (semverGreater(a, b)) return -1;
      if (semverGreater(b, a)) return 1;
      return 0;
    });
    return versions[0];
  } catch (_) {
    return null;
  }
}

// changelogHeadline(versionDirName) -> first bullet line under that version's
// "## " heading in the MIRRORED copy's own CHANGELOG.md, or null. Only ever
// called for a version already ON DISK (case 2) — the remote-only case (1)
// would need a network fetch for this, which the "cheap" contract rules out.
function changelogHeadline(versionDirName) {
  try {
    const p = path.join(MIRROR_CACHE_ROOT, versionDirName, 'CHANGELOG.md');
    const raw = fs.readFileSync(p, 'utf8');
    const bareVersion = versionDirName.replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headingRe = new RegExp('^##\\s+v?' + bareVersion + '\\b');
    const lines = raw.split('\n');
    let inSection = false;
    for (const line of lines) {
      if (headingRe.test(line)) { inSection = true; continue; }
      if (inSection) {
        if (/^##\s+/.test(line)) break; // next heading — section ended, no bullet found
        const m = /^-\s+(.+)/.exec(line.trim());
        if (m) return m[1].slice(0, 160); // cap length defensively
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Spawn the background refresh script detached + unref'd so SessionStart returns
// immediately. Fails silently — no network = no cache write = next session retries.
function spawnRefresh() {
  try {
    const refreshScript = path.join(__dirname, 'version-alert-refresh.js');
    const child = spawn(process.execPath, [refreshScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (_) {
    // fail-open: git absent, process spawn failed, etc. — silent.
  }
}

// isSubagentPayload(payload) -> true when the stdin payload carries a
// subagent/sidechain marker. Per docs/KB-claude-code-hooks.md's SessionStart
// row, the DOCUMENTED fields are session_id/cwd/permission_mode with NO
// subagent marker (agent_id/agent_type are documented only on
// PreToolUse/PostToolUse/TeammateIdle) — i.e. SessionStart is specified as
// firing per top-level session, not per subagent, so this check is expected
// to never trigger today. It costs nothing and is defensive belt-and-suspenders
// in case a future harness version starts tagging SessionStart payloads too.
function isSubagentPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.agent_id || payload.agent_type) return true;
  if (payload.isSidechain === true || payload.is_sidechain === true) return true;
  return false;
}

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function emit(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  // Synchronous write: avoids the macOS node 18/20 async-pipe-flush truncation
  // that process.stdout.write can cause when the process exits immediately after.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

function main() {
  // Env off-switch (case-insensitive).
  if (settingsGet('versionAlerts', 'antiHall') === false) return;

  // Skip-guard escape hatch.
  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('version-alert')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const payload = readStdinPayload();
  if (isSubagentPayload(payload)) return; // main-thread only

  const sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : '';

  const running = readRunningVersion(); // throws if plugin.json unreadable
  const now = Date.now();

  // CASE 2: already mirrored locally, newer than running -> reload only.
  // Checked first: no network, immune to TTL/cache staleness.
  const mirrored = newestMirroredVersion(MIRROR_CACHE_ROOT);
  if (mirrored && semverGreater(mirrored, running)) {
    let reloadMarker = null;
    try { reloadMarker = readDriftCache(RELOAD_MARK_FILE); } catch (_) { reloadMarker = null; }

    const key = { case: 'reload', sessionId, mirrored, running };
    if (sessionId && reloadMarker && alreadyAdvisedKey(reloadMarker, key)) return;

    const headline = changelogHeadline(mirrored);
    const additionalContext =
      `Tell the user now: anti-hall v${mirrored} is already downloaded (you are running v${running}) ` +
      `— run /reload-plugins (Claude) or restart Codex / start a fresh session (Codex) to pick it up.` +
      (headline ? ` Highlight: ${headline}` : '');
    emit(additionalContext);

    // Own dedupe marker (never the remote-latest cache) — see RELOAD_MARK_FILE
    // comment: this must work even when version-check.json has never existed.
    if (sessionId) {
      try {
        persistAdvisedKey(RELOAD_MARK_FILE, reloadMarker || { checkedAt: Date.now() }, key);
      } catch (_) { /* best effort */ }
    }
    return;
  }

  // CASE 1: cache-based remote-latest check.
  let cache = null;
  try {
    cache = readCache();
  } catch (_) {
    cache = null; // absent or malformed => treat as stale
  }

  // age must be NON-NEGATIVE: a future checkedAt (clock rollback / manual edit) would
  // otherwise read as perpetually "fresh" and alert forever on frozen data. age<0 => stale.
  const age = cache !== null ? now - cache.checkedAt : Infinity;
  const fresh = cache !== null && age >= 0 && age < CACHE_TTL_MS;

  if (!fresh) {
    // Stale / absent: kick off background refresh; no alert this session.
    spawnRefresh();
    return;
  }

  // Cache is fresh — alert only when a newer version is available.
  if (semverGreater(cache.latest, running)) {
    const key = { case: 'update', sessionId, latest: cache.latest, running };
    if (sessionId && alreadyAdvisedKey(cache, key)) return;

    const additionalContext =
      `Tell the user now: anti-hall v${cache.latest} is available (you are running v${running}) ` +
      `— run /anti-hall:update (Claude) or the anti-hall-update skill (Codex), then reload via ` +
      `/reload-plugins (Claude) or restart Codex / start a fresh session (Codex).`;
    emit(additionalContext);

    if (sessionId) {
      try { persistAdvisedKey(CACHE_FILE, cache, key); } catch (_) { /* best effort */ }
    }
  }
  // Fresh cache, version up-to-date => silent no-op (CASE 3).
}

try {
  main();
} catch (_) {
  // Fail-open: plugin.json unreadable, unexpected throw, etc.
}
process.exit(0);

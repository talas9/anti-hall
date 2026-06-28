#!/usr/bin/env node
// anti-hall :: version-alert (SessionStart)
//
// If a newer anti-hall version is available (per a LOCAL cache), injects a
// one-line additionalContext nudge: "anti-hall vLATEST available (running
// vRUNNING) — run /anti-hall:update".
//
// DESIGN (non-blocking, cached):
//   - Running version read from ../.claude-plugin/plugin.json (SYNCHRONOUS, tiny).
//   - Cache read from ~/.anti-hall/version-check.json = { latest, checkedAt }.
//   - Fresh cache (<24 h) + latest > running  => emit additionalContext.
//   - Fresh cache (<24 h) + latest <= running => silent no-op.
//   - Absent or stale cache (>= 24 h)         => spawn detached background
//     refresh (version-alert-refresh.js) then exit immediately. NO alert this
//     session — the next session picks it up.
//   - The ONLY synchronous work is two small file reads + a string compare;
//     all network access is fully off the critical path (detached+unref'd child).
//
// Escape hatches:
//   - ANTIHALL_VERSION_ALERT=off disables the hook.
//   - skip.json { "version-alert": <future-ms> } (or "all") disables it.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error — never slow or block session start).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const PLUGIN_JSON  = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
const CACHE_FILE   = path.join(os.homedir(), '.anti-hall', 'version-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

// readCache() — returns { latest, checkedAt } or throws (absent / malformed).
function readCache() {
  const raw = fs.readFileSync(CACHE_FILE, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('bad cache');
  if (typeof obj.latest !== 'string' || !Number.isFinite(obj.checkedAt)) {
    throw new Error('bad cache shape'); // reject NaN/Infinity checkedAt too
  }
  return obj;
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

function main() {
  // Env off-switch (case-insensitive).
  if ((process.env.ANTIHALL_VERSION_ALERT || '').toLowerCase() === 'off') return;

  // Skip-guard escape hatch.
  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('version-alert')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const running = readRunningVersion(); // throws if plugin.json unreadable
  const now = Date.now();

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
    const additionalContext =
      `anti-hall v${cache.latest} available (running v${running}) — run /anti-hall:update`;
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
  // Fresh cache, version up-to-date => silent no-op.
}

try {
  main();
} catch (_) {
  // Fail-open: plugin.json unreadable, unexpected throw, etc.
}
process.exit(0);

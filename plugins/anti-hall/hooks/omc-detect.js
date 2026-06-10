#!/usr/bin/env node
// anti-hall :: omc-detect — OMC loop-active detector (shared helper, not a hook)
//
// Exported: isOmcLoopActive({ cwd, sessionId }) -> boolean
//
// Returns TRUE when an oh-my-claudecode autonomous loop (ralph, ultrawork,
// autopilot, ultraqa, team, ultrapilot, pipeline, omc-teams) is currently
// ACTIVE and FRESH so that consuming hooks (task-guard, tasklist-guard) can
// DEFER their Stop blocks rather than deadlock against the loop.
//
// Fail-open direction = NOT deferring (false): a detection failure is safer than
// a silent loop — the hooks block as usual. Missing/malformed state = false.
//
// Detection algorithm (four sequential gates — all must pass for true):
//
//   1. Kill-switch: DISABLE_OMC === '1'  OR
//      OMC_SKIP_HOOKS contains 'persistent-mode' → return false.
//
//   2. OMC enabled: enabledPlugins["oh-my-claudecode@omc"] === true in ANY of
//      ~/.claude/settings.json, <cwd>/.claude/settings.json, or
//      <cwd>/.claude/settings.local.json (all missing/unreadable → false).
//
//   3. State root: <cwd>/.omc/state/ (fallback ~/.omc/state/ when cwd missing
//      or the cwd-relative dir does not exist).
//
//   4. Active mode: any of these state files under the root —
//        ralph-state.json, ultrawork-state.json, autopilot-state.json,
//        ultraqa-state.json, team-state.json, ultrapilot-state.json,
//        pipeline-state.json, omc-teams-state.json
//      — with ALL three conditions:
//        (a) active === true
//        (b) fresh: any of last_checked_at / updated_at / started_at is within 2h
//            (OMC's own staleness rule, persistent-mode.mjs:244)
//        (c) session affinity: session_id field absent OR caller presents the
//            SAME sessionId (pinned state + missing caller sid = NO match, R1-6)
//
// Version fragility: state filenames are stable since OMC 4.14.6; the
// enabledPlugins key may migrate in future OMC versions — missing key → false is
// the fail-safe direction (no deference, guards stay active).
//
// Pure Node built-ins only. No side effects, no I/O beyond bounded reads.
// Everything wrapped in try/catch — never throws to the caller.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// OMC autonomous mode state filenames (stable since 4.14.6).
const OMC_STATE_FILES = [
  'ralph-state.json',
  'ultrawork-state.json',
  'autopilot-state.json',
  'ultraqa-state.json',
  'team-state.json',
  'ultrapilot-state.json',
  'pipeline-state.json',
  'omc-teams-state.json',
];

// Freshness window: 2 hours in ms (mirrors OMC persistent-mode.mjs:244).
const FRESH_MS = 2 * 60 * 60 * 1000;

// Read at most MAX_BYTES from a state file to bound memory (state files are
// tiny JSON objects; a pathological multi-MB file is treated as malformed).
const MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Gate 1: kill-switches
// ---------------------------------------------------------------------------
function killSwitchActive() {
  try {
    if (process.env.DISABLE_OMC === '1') return true;
    const skipList = process.env.OMC_SKIP_HOOKS || '';
    if (typeof skipList === 'string' && skipList.split(',').map(s => s.trim()).includes('persistent-mode')) {
      return true;
    }
  } catch (_) {
    // env access errors → assume no kill-switch
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gate 2: OMC enabled in settings.json (global or project scope)
// ---------------------------------------------------------------------------

// Bounded read of a single settings file; returns true if it enables OMC.
function settingsFileEnablesOmc(filePath) {
  try {
    const stat = fs.statSync(filePath);
    // 256 KB (vs the 64 KB state-file bound): settings files legitimately grow
    // large (hooks, permission allowlists, plugin registries); state files don't.
    if (stat.size > 256 * 1024) return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    let settings;
    try { settings = JSON.parse(raw); } catch (_) { return false; }
    if (!settings || typeof settings !== 'object') return false;
    const plugins = settings.enabledPlugins;
    if (!plugins || typeof plugins !== 'object') return false;
    return plugins['oh-my-claudecode@omc'] === true;
  } catch (_) {
    return false; // missing / unreadable → not enabled
  }
}

function omcEnabled(cwd) {
  try {
    // Global: ~/.claude/settings.json
    if (settingsFileEnablesOmc(path.join(os.homedir(), '.claude', 'settings.json'))) return true;
    // Project scope: <cwd>/.claude/settings.json and <cwd>/.claude/settings.local.json
    if (cwd && typeof cwd === 'string') {
      const projectClaudeDir = path.join(cwd, '.claude');
      if (settingsFileEnablesOmc(path.join(projectClaudeDir, 'settings.json'))) return true;
      if (settingsFileEnablesOmc(path.join(projectClaudeDir, 'settings.local.json'))) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gate 3: resolve state root
// ---------------------------------------------------------------------------
function resolveStateRoot(cwd) {
  try {
    if (cwd && typeof cwd === 'string') {
      const cwdState = path.join(cwd, '.omc', 'state');
      try {
        const st = fs.statSync(cwdState);
        if (st.isDirectory()) return cwdState;
      } catch (_) {
        // not present → fall through to global fallback
      }
    }
    // Fallback: ~/.omc/state/
    return path.join(os.homedir(), '.omc', 'state');
  } catch (_) {
    return path.join(os.homedir(), '.omc', 'state');
  }
}

// ---------------------------------------------------------------------------
// Gate 4: check a single state file for active + fresh + session affinity
// ---------------------------------------------------------------------------
function checkStateFile(filePath, sessionId) {
  try {
    let raw;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_BYTES) return false; // oversized → treat as malformed
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      return false; // missing / unreadable
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (_) {
      return false; // malformed JSON
    }

    if (!state || typeof state !== 'object') return false;

    // (a) active flag
    if (state.active !== true) return false;

    // (b) freshness — any timestamp within 2 h
    // OMC 4.14.6 writes ISO-8601 strings (new Date().toISOString()); accept
    // both ISO strings and legacy numeric ms-since-epoch values.
    const now = Date.now();
    const ts = [state.last_checked_at, state.updated_at, state.started_at]
      .map(v => {
        const n = typeof v === 'number' ? v : (typeof v === 'string' ? new Date(v).getTime() : 0);
        return Number.isFinite(n) ? n : 0;
      })
      .find(v => v > 0 && (now - v) <= FRESH_MS);
    if (ts === undefined) return false; // no fresh timestamp found

    // (c) session affinity — absent field = matches any session. A session-
    // PINNED state requires the caller to prove the SAME session (R1-6: a
    // loop pinned to ANOTHER session must not suppress THIS session's guard;
    // a caller that cannot present a session id gets no deference either).
    if (typeof state.session_id !== 'undefined' && state.session_id !== null) {
      if (!sessionId || String(state.session_id) !== String(sessionId)) return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * isOmcLoopActive({ cwd, sessionId }) → boolean
 *
 * @param {object} opts
 * @param {string} [opts.cwd]       - project working directory (from hook stdin)
 * @param {string} [opts.sessionId] - session_id from hook stdin (for affinity check)
 * @returns {boolean} true = active OMC loop detected; false = defer to normal guard behavior
 */
function isOmcLoopActive(opts) {
  try {
    const { cwd, sessionId } = opts || {};

    // Gate 1: kill-switches
    if (killSwitchActive()) return false;

    // Gate 2: OMC must be enabled (global or project scope)
    if (!omcEnabled(cwd)) return false;

    // Gate 3: resolve state root
    const stateRoot = resolveStateRoot(cwd);

    // Gate 4: scan state files
    for (const filename of OMC_STATE_FILES) {
      const filePath = path.join(stateRoot, filename);
      if (checkStateFile(filePath, sessionId)) return true;
    }

    return false;
  } catch (_) {
    return false; // fail-open = not deferring
  }
}

module.exports = { isOmcLoopActive };

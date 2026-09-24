#!/usr/bin/env node
// anti-hall :: repair-on-reload (SessionStart + UserPromptSubmit fallback)
//
// ITEM E (v0.107.1): "an update OR a reload of the plugin must always fix
// corrupt or stale data." Before this hook, repairs (runMigrations, via
// migrations.js) only ran through `update.js` or a manual `doctor --repair`.
// A plain `/reload-plugins`, a brand-new session that just picked up a newer
// cache dir, or an update applied by the plugin manager WITHOUT our own
// update.js script, ran none of them — stale/corrupt state (e.g. a split
// store, a mis-keyed registry row) could sit unrepaired indefinitely even
// though the running code had already moved past the version that caused it.
//
// WHY BOTH SessionStart AND UserPromptSubmit: docs/GUIDE.md + skills/update/
// SKILL.md's own "Why /reload-plugins" section documents that `/reload-
// plugins` refreshes the skill list, version label, and cache-bound paths
// in-session, but neither that doc nor docs/KB-claude-code-harness-features.md
// (the SessionStart hook-event table) states that `/reload-plugins` fires a
// NEW SessionStart event — and no such event is observed by any hook in this
// plugin (none of the existing SessionStart handlers re-arm on reload; they
// are one-shot at session start/resume/compact). Absent documented proof that
// `/reload-plugins` re-fires SessionStart, this hook is ALSO registered on
// UserPromptSubmit as the fallback that actually catches the reload case: the
// very next prompt after a reload re-runs this same cheap check.
//
// DESIGN (cheap, idempotent, fail-open, never blocks):
//   - Running version read from ../.claude-plugin/plugin.json (sync, tiny).
//   - "Repair pending" is derived from the SAME per-migration marker store
//     migrations.js/update.js/doctor already share (~/.anti-hall/update-
//     sweep-state.json): any DEFAULT (non-optIn) migration not yet marked
//     completedVersion === running version is pending. This is ONE small JSON
//     read + an in-memory array walk over ~10 entries — no detect() calls, no
//     store scan — so the no-op path (nothing pending) stays well under the
//     50ms budget.
//   - Nothing pending -> silent no-op, exit 0. (No separate "seen version"
//     stamp is written — the per-migration markers ARE the stamp; re-deriving
//     "pending" each time is already O(1) and avoids a second source of truth
//     that could itself drift stale.)
//   - Something pending -> try to acquire a tiny lock file
//     (~/.anti-hall/repair-on-reload.lock, atomic 'wx' create). Lock held by a
//     LIVE pid -> skip (another repair already in flight, this session or
//     another). Lock held by a DEAD pid (or unreadable/corrupt) -> stolen.
//   - Lock acquired -> spawn `node hooks/doctor.js --repair --migrations-only
//     --quiet` DETACHED
//     (stdio redirected to a fresh ~/.anti-hall/logs/repair-on-reload-<ts>.log
//     file, unref'd) and return immediately — the hook itself never waits.
//     doctor.js --repair --migrations-only runs ONLY the stamped data
//     migrations + store repairs (runMigrations via lib/doctor-repair.js) and
//     never touches config outside ~/.anti-hall: idempotent, fail-open, no-delete, and it
//     stamps each migration's own marker (migrations.js recordRun) ONLY once
//     that migration's apply+re-scan both report complete — "stamp only after
//     success" falls out of reusing that existing contract rather than this
//     hook inventing a second one.
//   - The lock file is intentionally left behind after the child exits (dead
//     pid, harmless) — the NEXT invocation's pidIsAlive check reclaims it.
//
// Escape hatches:
//   - ANTIHALL_REPAIR_ON_RELOAD=off disables the hook.
//   - skip.json { "repair-on-reload": <future-ms> } (or "all") disables it.
//   - A subagent/sidechain payload (agent_id/agent_type present) is skipped —
//     repairs belong to the main session, not a Task-tool subagent turn.
//
// Contract (Claude Code SessionStart / UserPromptSubmit hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : nothing (this hook never injects additionalContext)
//   exit 0 : always (fail-open on ANY error — never slow or block the turn)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
// Fallback ONLY (see resolveDoctorJs below): whatever doctor.js sits next to
// THIS running hook — i.e. the cache-version dir the harness bound __dirname
// to when it loaded this file for the current session.
const DOCTOR_JS_FALLBACK = path.join(__dirname, 'doctor.js');

function antiHallDir(home) { return path.join(home || os.homedir(), '.anti-hall'); }
function lockPath(home) { return path.join(antiHallDir(home), 'repair-on-reload.lock'); }
function logsDir(home) { return path.join(antiHallDir(home), 'logs'); }

function readRunningVersion() {
  const raw = fs.readFileSync(PLUGIN_JSON, 'utf8');
  const obj = JSON.parse(raw);
  if (typeof obj.version !== 'string' || !obj.version) throw new Error('missing version');
  return obj.version;
}

// resolveDoctorJs(home) -> absolute path to the NEWEST cache version's own
// doctor.js, falling back to THIS running hook's own sibling doctor.js when
// no newer/valid cache dir can be found. Same staleness class as the update.js
// re-exec fix (P0): this hook's own __dirname is bound to whichever
// cache-version dir the harness loaded for the CURRENT session, which can lag
// a version already synced into the cache by a prior update.js run. Spawning
// that stale doctor.js would run an OLD repair/migration set instead of the
// one the just-synced version actually ships. Read-only, fail-open: any
// resolution failure (missing cache root, unreadable dir, no doctor.js at the
// resolved path) falls back to DOCTOR_JS_FALLBACK.
function semverCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

function resolveDoctorJs(home, runningVersion) {
  try {
    const cacheRoot = path.join(home || os.homedir(), '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name)); // semver dirs only — never a sha-named dir
    if (!versions.length) return DOCTOR_JS_FALLBACK;
    versions.sort(semverCmp);
    const newest = versions[versions.length - 1];
    // Never pick a cache dir OLDER than the running version (e.g. a
    // --plugin-dir/dev run whose cache still holds a previous release): an
    // older doctor.js predates --migrations-only and would ignore it, running
    // the full repair instead. Own sibling copy is the right one then.
    if (runningVersion && semverCmp(newest, runningVersion) < 0) return DOCTOR_JS_FALLBACK;
    const candidate = path.join(cacheRoot, newest, 'hooks', 'doctor.js');
    return fs.existsSync(candidate) ? candidate : DOCTOR_JS_FALLBACK;
  } catch (_) {
    return DOCTOR_JS_FALLBACK;
  }
}

// repairPending(home, version) -> bool. O(1): one small JSON read
// (migrations.js's own marker store) + an in-memory walk of the default
// migration list. NEVER calls a migration's own detect() (which can scan
// stores) — that is exactly the per-run cost this hook must stay under.
function repairPending(home, version) {
  const migrations = require('../companion/lib/migrations.js');
  const state = migrations.readMarkers(home);
  return migrations.defaultMigrations().some((m) => !migrations.isApplied(state, m.key, version));
}

// acquireLock(home) -> true (acquired) | false (held by a live process).
// Atomic create ('wx'); a pre-existing lock is reclaimed when its pid is dead
// or the file is unreadable/corrupt (best-effort — never throws outward).
function acquireLock(home) {
  const p = lockPath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return false; // unexpected fs error -> fail-open, skip this turn
  }
  // Lock file already exists — reclaim only if its pid is provably dead.
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { existing = null; }
  const pid = existing && Number.isInteger(existing.pid) ? existing.pid : null;
  let alive = null;
  if (pid) {
    try { alive = require('../companion/lib/liveness.js').pidIsAlive(pid); } catch (_) { alive = null; }
  }
  if (alive === true) return false; // genuinely in flight elsewhere -> skip
  // Dead pid / no pid / corrupt file / unknown verdict from a THIS-process
  // liveness read: reclaim (steal) the lock rather than let a crashed run
  // wedge repairs forever. Atomic rename avoids a torn read by a concurrent
  // stealer.
  try {
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false; // couldn't steal -> fail-open, skip this turn (retried next turn)
  }
}

function spawnDetachedRepair(home, runningVersion) {
  try {
    const dir = logsDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'repair-on-reload-' + Date.now() + '.log');
    const fd = fs.openSync(logPath, 'a');
    const doctorJs = resolveDoctorJs(home, runningVersion);
    // --migrations-only: the reload hook runs ONLY the stamped data
    // migrations (runMigrations, runSettingsMigration, store repairs under
    // ~/.anti-hall). Everything that writes config OUTSIDE ~/.anti-hall —
    // statusLine into ~/.claude/settings.json, Codex hooks/[features] into
    // ~/.codex, supervisor/ingest units — stays behind a user-typed
    // `doctor --repair`; an unasked reload must never install those.
    const child = spawn(process.execPath, [doctorJs, '--repair', '--migrations-only', '--quiet'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    try { fs.closeSync(fd); } catch (_) {} // the child holds its own fd via dup; safe to close here
    // Re-point the lock at the CHILD's pid (acquireLock() wrote THIS process's
    // own pid as a placeholder to win the atomic-create race) — the hook exits
    // right after this, so a liveness check against the parent's pid would go
    // stale within milliseconds and let a second turn steal the lock while the
    // repair is still genuinely running. Best-effort; a failure here just means
    // the next hook invocation might see a live-looking placeholder pid for a
    // moment, which is still fail-SAFE (skip, not double-spawn).
    if (Number.isInteger(child.pid)) {
      try {
        const p = lockPath(home);
        const tmp = p + '.' + process.pid + '.repoint.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
        fs.renameSync(tmp, p);
      } catch (_) {}
    }
  } catch (_) {
    // fail-open: spawn failed (missing doctor.js, sandboxed env, etc.) — silent.
  }
}

function main() {
  if ((process.env.ANTIHALL_REPAIR_ON_RELOAD || '').toLowerCase() === 'off') return;

  let payload = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) { payload = null; }

  // Subagent/sidechain turns never trigger a repair — repairs are a
  // main-session concern, and a subagent's payload carries agent markers the
  // main session's never does (see coordinator-detect.js's own header).
  try {
    const { isSubagentByPayload } = require('./coordinator-detect.js');
    if (isSubagentByPayload(payload)) return;
  } catch (_) { /* detector missing -> fail-open, proceed */ }

  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('repair-on-reload')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const home = os.homedir();
  const version = readRunningVersion(); // throws if plugin.json unreadable -> fail-open below

  if (!repairPending(home, version)) return; // fast path: nothing to do

  if (!acquireLock(home)) return; // another repair already in flight

  spawnDetachedRepair(home, version);
}

try {
  main();
} catch (_) {
  // Fail-open: plugin.json unreadable, migrations.js missing, unexpected
  // throw, etc. — never slow or block the session/turn.
}
process.exit(0);

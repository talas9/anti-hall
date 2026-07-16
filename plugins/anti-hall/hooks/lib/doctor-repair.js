'use strict';
// anti-hall :: doctor-repair — the REPAIR half of doctor.js as a pure, testable
// module (mirrors companion/lib/doctor-devswarm.js's require-and-call pattern).
//
// doctor.js diagnoses; this module FIXES. Plain `node doctor.js` (and --fix /
// --repair / --dry-run) call runRepairs() after the diagnostic sections; --check
// skips it entirely (pure read-only, the CI/test path).
//
// Two safety classes:
//   AUTO-SAFE — always applied (honoring dryRun): legacy/GSD/DevSwarm-store
//     migration, statusline-if-missing (never overriding a custom statusLine),
//     supervisor idempotent relaunch when ALREADY installed, codex hook refresh
//     when a <scope>/.codex/config.toml exists but the hooks are unwired.
//   GATED — applied only when isDevswarmActive(env) AND resolveWorktree(cwd) is a
//     real git worktree: ingest daemon install / wrong-path rebind / stale-script /
//     unstable-script (config drift — the baked ExecStart script still exists but is
//     no longer the current stable marketplace-clone path; see resolveStableScript in
//     install-devswarm-ingest.js and classifyIngestUnit below), and supervisor
//     FIRST-install. Gate-fail → status 'gated' + the exact manual command, never a
//     mutation. This mirrors (and is reused by) skills/update/scripts/update.js's own
//     healIngestDaemon — same classify helpers, same gate — so `doctor --repair` and
//     `update` migrate a drifted/misconfigured unit the identical way.
//   REPORT-ONLY — reaper missing (it kills orphans on a timer; never auto-installed).
//
// Every fix is wrapped try/catch and FAILS OPEN (a raised fix becomes one
// status:'failed' entry and never aborts the pass). After a real fix, the relevant
// detection is RE-RUN to confirm it actually took (a spawned installer's exit code
// is not trusted — launchctl load can warn) before reporting 'fixed'.
//
// Pure Node built-ins, cross-platform. Windows daemon fixes are documented no-ops.

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..'); // hooks/lib -> plugin root

const INGEST_INSTALLER     = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-ingest.js');
const INGEST_DAEMON        = path.join(PLUGIN_ROOT, 'companion', 'devswarm-ingest.js');
const DEVSWARM_REPOKEY     = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-repokey.js');
const SUPERVISOR_INSTALLER = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-supervisor.js');
const REAPER_INSTALLER     = path.join(PLUGIN_ROOT, 'companion', 'install-reaper.js');
const STATUSLINE_INSTALLER = path.join(PLUGIN_ROOT, 'statusline', 'install-statusline.js');
const CODEX_INSTALLER      = path.join(PLUGIN_ROOT, 'codex', 'install-codex.js');
const MIGRATE_STATE        = path.join(PLUGIN_ROOT, 'scripts', 'migrate-state.js');
const DEVSWARM_SCRIPT      = path.join(PLUGIN_ROOT, 'scripts', 'devswarm.js');

// v0.57 mesh Phase 6 (D9/D25/D28) — belt-and-suspenders orphan sweep for LEGACY
// per-worktree ingest units. A legacy unit's heartbeat/lock are keyed by its own
// hash; the per-project daemon it may now be redundant with is keyed by repoKey —
// both are read via the companion modules below, NEVER re-derived here (same
// discipline as ingestConst() above).
function ingestDaemonMod() {
  try { return require(INGEST_DAEMON); } catch (_) { return {}; }
}
function repokeyMod() {
  try { return require(DEVSWARM_REPOKEY); } catch (_) { return {}; }
}
function devswarmRootFor(home) {
  try { return require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'liveness.js')).devswarmRoot(home); } catch (_) { return path.join(home, '.anti-hall', 'devswarm'); }
}
// REAP_HEALTH_FRESH_MS — mirrors hooks/devswarm-parent-inbox.js's own
// HEARTBEAT_STALE_MS (3 min): the per-project daemon rewrites its heartbeat every
// monitor sweep regardless of inserts, so anything older is very likely dead.
const REAP_HEALTH_FRESH_MS = 3 * 60 * 1000;
function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// projectDaemonHealthy(home, repoKey, now, io) -> bool. D25's TWO-signal health
// check (freshness-only is NOT proof of life; a dead process can leave a
// fresh-LOOKING stale file within the window) scoped to what Phase 6 needs: (1)
// heartbeats/ingest-<repoKey>.json refreshed within REAP_HEALTH_FRESH_MS, AND (2)
// the per-project O_EXCL ingest lock is held by a LIVE pid (reusing
// devswarm-ingest.js's own readLockHolder — never re-derived here). Pure fs reads
// (+ an injectable isAlive probe for tests); never a spawn. Fail-open: any read
// error -> false (never falsely reports healthy).
function projectDaemonHealthy(home, repoKey, now, io) {
  if (!repoKey) return false;
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const daemon = ingestDaemonMod();
  if (typeof daemon.ingestHeartbeatPath !== 'function' || typeof daemon.readLockHolder !== 'function') return false;
  let fresh = false;
  try {
    const beat = JSON.parse(F.readFileSync(daemon.ingestHeartbeatPath(home, repoKey), 'utf8'));
    fresh = !!(beat && Number.isFinite(beat.ts) && (now - beat.ts) <= REAP_HEALTH_FRESH_MS);
  } catch (_) { fresh = false; }
  if (!fresh) return false;
  try {
    const lockPath = path.join(devswarmRootFor(home), 'locks', 'ingest-project-' + repoKey + '.lock');
    const holder = daemon.readLockHolder(lockPath, F);
    return !!(holder && Number.isFinite(holder.pid) && isAlive(holder.pid));
  } catch (_) { return false; }
}

// Friendly (plugin-relative) command strings for the manual-command hints in
// GATED reports — humans copy these, so keep them repo-relative not absolute.
const CMD_INGEST     = 'node plugins/anti-hall/companion/install-devswarm-ingest.js';
const CMD_SUPERVISOR = 'node plugins/anti-hall/companion/install-devswarm-supervisor.js';
const CMD_REAPER     = 'node plugins/anti-hall/companion/install-reaper.js';
const CMD_RECONCILE  = 'node plugins/anti-hall/scripts/devswarm.js reconcile';

// LABEL/UNIT/marker come from the installers themselves — NEVER re-derived here, so
// this can't drift from what install actually writes (same discipline as doctor.js).
function ingestConst() {
  try { return require(INGEST_INSTALLER); } catch (_) { return {}; }
}

// resolveCurrentStableScript(env, home) -> absolute path | null. Thin, fail-open
// wrapper around install-devswarm-ingest.js's OWN resolveStableScript (never
// re-derived here — same discipline as LABEL/UNIT above) so classifyIngestUnit can
// tell a script that still EXISTS apart from one that is the CURRENT canonical
// git-marketplace-clone path a fresh install would bake. Returns null (never
// throws) when the installer can't be required or the marketplace clone isn't on
// this machine — the caller then skips the drift check entirely (dev-mode/no
// marketplace has no "stable path" concept to drift from).
function resolveCurrentStableScript(env, home) {
  try {
    const { resolveStableScript } = ingestConst();
    if (typeof resolveStableScript === 'function') return resolveStableScript(env, home);
  } catch (_) {}
  return null;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function firstLine(s) { return String(s || '').split('\n').find(Boolean) || ''; }
function errMsg(e) { return (e && e.message) ? e.message : String(e); }

// ---------------------------------------------------------------------------
// readInstalledIngestWorkingDir({home, platform, worktree|repoKey}) -> {present,
// workingDir, scriptPath, source, hash, repoKey, others}. PER-WORKTREE aware
// (v0.55+): delegates to the installer's listInstalledIngestUnits (the canonical
// multi-unit readback) and picks the unit that belongs to the CURRENT worktree so
// a wrong-path / stale-script unit for THIS repo can be detected and healed
// WITHOUT touching another repo's unit.
//   - o.repoKey given -> match the unit whose repoKey === o.repoKey (v0.57 mesh
//     Phase 6, D9/D24: the per-project unit install now actually creates —
//     mutually exclusive with the `worktree` mode below, and used by
//     update.js's healIngestDaemon so it heals what the installer really
//     produces post-reap-before-drain, not a unit that was just reaped).
//   - o.worktree given -> match the unit whose hash === worktreeHash(worktree),
//     or a legacy (hash-null) unit whose baked WorkingDirectory IS this worktree.
//   - neither given    -> the legacy (hash-null) unit if any, else the only unit.
// `others` carries the remaining installed units (OTHER worktrees) for reporting.
// Fail-open: any error -> present:false with an empty `others`.
// ---------------------------------------------------------------------------
function readInstalledIngestWorkingDir(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const out = { present: false, workingDir: null, scriptPath: null, source: null, hash: null, repoKey: null, others: [] };

  let units = [];
  try {
    const { listInstalledIngestUnits } = ingestConst();
    if (typeof listInstalledIngestUnits === 'function') units = listInstalledIngestUnits({ home, platform }) || [];
  } catch (_) { units = []; }
  if (!units.length) return out;

  let wantHash = null;
  if (o.worktree) {
    try { const { worktreeHash } = ingestConst(); if (typeof worktreeHash === 'function') wantHash = worktreeHash(o.worktree); } catch (_) {}
  }

  let pick = null;
  if (o.repoKey) {
    pick = units.find((u) => u.repoKey === o.repoKey) || null;
  } else if (o.worktree) {
    // Only a unit that genuinely belongs to THIS worktree may be healed in place.
    pick = units.find((u) => wantHash && u.hash === wantHash)
      || units.find((u) => u.hash === null && u.workingDir && samePath(u.workingDir, o.worktree))
      || null;
  } else {
    pick = units.find((u) => u.hash === null) || units[0] || null;
  }

  if (pick) {
    out.present = true;
    out.workingDir = pick.workingDir;
    out.scriptPath = pick.scriptPath;
    out.source = pick.source;
    out.hash = pick.hash;
    out.repoKey = pick.repoKey != null ? pick.repoKey : null;
  }
  out.others = units.filter((u) => u !== pick);
  return out;
}

function samePath(a, b) {
  try { return path.resolve(String(a)) === path.resolve(String(b)); } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// classifyIngestUnit({workingDir, scriptPath, home, env}) ->
//   'absent' | 'wrong-path' | 'stale-script' | 'unstable-script' | 'ok'
// WRONG-PATH: workingDir absent, equals $HOME, a non-existent path, or NOT inside a
// git worktree. STALE-SCRIPT: the baked ExecStart script no longer exists on disk.
// UNSTABLE-SCRIPT (v0.56.0, config drift within the CURRENT scheme): the baked
// script EXISTS but is not install-devswarm-ingest.js's current
// resolveStableScript() result — e.g. a unit installed before that fix still
// points at a version-pinned plugin-cache path the manager can relocate/.bak out
// from under it on the next update, even though nothing is missing YET. Opt-in:
// only checked when the caller passes `env` (real callers — runRepairs below,
// mirrored by update.js's healIngestDaemon — always do); a bare classify call that
// omits `env` keeps the pre-v0.56.0 existence-only check, so a placeholder
// scriptPath in a low-level unit test never false-flags against whatever build
// happens to be marketplace-installed on the machine running the test.
// ---------------------------------------------------------------------------
function classifyIngestUnit(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const workingDir = o.workingDir;
  const scriptPath = o.scriptPath;

  // Nothing readable at all -> no unit installed.
  if (!workingDir && !scriptPath) return 'absent';

  // WrongPath checks first (a unit that can never resolve a workspace).
  if (!workingDir) return 'wrong-path';
  if (path.resolve(workingDir) === path.resolve(home)) return 'wrong-path';
  let isDir = false;
  try { isDir = fs.statSync(workingDir).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) return 'wrong-path';
  if (!insideWorktree(workingDir)) return 'wrong-path';

  // Then stale-script: the baked script path is gone.
  if (scriptPath) {
    let scriptExists = false;
    try { scriptExists = fs.statSync(scriptPath).isFile(); } catch (_) { scriptExists = false; }
    if (!scriptExists) return 'stale-script';

    if (o.env) {
      const stable = resolveCurrentStableScript(o.env, home);
      if (stable) {
        let drifted = false;
        try { drifted = path.resolve(scriptPath) !== path.resolve(stable); } catch (_) { drifted = false; }
        if (drifted) return 'unstable-script';
      }
    }
  }
  return 'ok';
}

// insideWorktree(dir) -> bool. Reuses install-devswarm-ingest.resolveWorktree
// (git -C dir rev-parse --show-toplevel) so the "is this a git worktree" test is
// byte-identical to the one the installer itself gates on.
function insideWorktree(dir) {
  try {
    const { resolveWorktree } = ingestConst();
    if (typeof resolveWorktree === 'function') return resolveWorktree(dir) !== null;
  } catch (_) {}
  // Fallback: a direct git probe (never throws to the caller).
  try {
    const r = cp.spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return !r.error && r.status === 0 && String(r.stdout || '').trim() !== '';
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Shared detection helpers (mirror doctor.js's own read-only scans, so a repair
// decision uses the same evidence the diagnostic section prints).
// ---------------------------------------------------------------------------
function scanStatusLine(cwd, home) {
  const scopes = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  for (const p of scopes) {
    const s = readJSON(p);
    const cmd = s && s.statusLine && s.statusLine.command;
    if (cmd) return { present: true, path: p, command: cmd };
  }
  return { present: false };
}

function scanCodex(cwd, home) {
  const scopesX = [
    ['project', path.join(cwd, '.codex'), []],
    ['global',  path.join(home, '.codex'), ['--global']],
  ];
  const out = [];
  for (const [label, dir, flags] of scopesX) {
    let hasConfig = false;
    try { hasConfig = fs.statSync(path.join(dir, 'config.toml')).isFile(); } catch (_) {}
    if (!hasConfig) continue;
    let wired = null; // null = hooks.json absent/unreadable
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
      wired = JSON.stringify(cfg).replace(/\\\\/g, '/').includes('/plugins/anti-hall/hooks/');
    } catch (_) { wired = null; }
    out.push({ label, dir, flags, wired });
  }
  return out;
}

// unitInstalled(installerPath, home, platform) -> bool. Read-only existence check
// of a companion's scheduler artifact, keyed to LABEL/UNIT from the installer.
function unitInstalled(installerPath, home, platform) {
  try {
    const inst = require(installerPath);
    if (platform === 'darwin') return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${inst.LABEL}.plist`));
    if (platform === 'linux') return fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${inst.UNIT}.timer`));
  } catch (_) {}
  return false; // win32 / unknown / require-fail = not installed
}

// spawnInstaller — run one of the plugin's OWN idempotent installers as a
// subprocess (never a hand-written plist). cwd + env are threaded so os.homedir()
// and resolveWorktree() inside the child resolve to the same home/worktree doctor
// is operating on.
function spawnInstaller(script, argv, cwd, env) {
  return cp.spawnSync(process.execPath, [script].concat(argv || []), {
    cwd, env, encoding: 'utf8', timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// reapOrphanedLegacyUnits({home, platform, dryRun, now, io}) ->
//   [{id, hash, workingDir, status, msg}]  status ∈ 'reaped'|'would-reap'|'kept'|'failed'
//
// v0.57 mesh Phase 6 (D9/D25/D28) — BELT-AND-SUSPENDERS sweep for LEGACY
// per-worktree ingest units that are ALREADY orphaned or REDUNDANT. This is NOT
// the live reap-before-drain handoff (that already happens INSIDE
// install-devswarm-ingest.js's install path — see reapLegacyUnitsForRepo — every
// time the per-project daemon is (re)installed for a repo). This sweep exists for
// the units that handoff never touched: a worktree that was deleted WITHOUT ever
// re-running install (no reap trigger fired), or a machine where the install-time
// stop silently failed (launchctl/systemctl errors are ignored at install time,
// D9).
//
// A legacy unit is reaped when EITHER:
//   (a) its worktree no longer resolves at all (genuinely orphaned), OR
//   (b) its worktree still resolves AND the per-project daemon for that
//       worktree's repoKey is CONFIRMED running+healthy (D25 — freshness AND
//       lock/process evidence, never freshness alone) — i.e. this legacy unit is
//       provably redundant.
// Otherwise it is LEFT IN PLACE (status 'kept') — never reap a legacy unit that
// might still be the SOLE live drainer of its Primary queue; reaping it then
// would silently stop ingestion with no replacement.
//
// Only units bearing the anti-hall ingest LABEL/UNIT prefix with the LEGACY
// `-<hash>` shape are candidates (`u.hash != null` — the DISJOINT regex in
// listInstalledIngestUnits, D28) — a repoKey-shaped per-project unit, or any
// non-anti-hall scheduler entry, is never enumerated by listInstalledIngestUnits
// in the first place, so neither is ever a candidate here.
//
// Stop is ALWAYS scheduler-based (launchctl unload / systemctl disable / cron-
// marker removal via stopLegacyUnitEntry) — NEVER kill(2); a currently-live
// legacy daemon's own finally block releases its lock+store cleanly once its
// scheduler unit is torn down. `opts.io` (schedRun/schedFs/fs/isAlive) is fully
// injectable so tests NEVER touch a real launchctl/systemctl/crontab/process —
// mirrors reapLegacyUnitsForRepo's own opts.io.schedRun/schedFs discipline.
// Fail-open per unit: one unit that raises while being evaluated/stopped is
// reported 'failed' and never blocks sweeping the rest.
function reapOrphanedLegacyUnits(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const dryRun = !!o.dryRun;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const results = [];

  let units = [];
  try {
    const { listInstalledIngestUnits } = ingestConst();
    if (typeof listInstalledIngestUnits === 'function') units = listInstalledIngestUnits({ home, platform }) || [];
  } catch (_) { units = []; }

  // ONLY legacy per-worktree-suffixed units (hash set). Never the ambiguous
  // legacy BASE unit (hash===null, repoKey===null — owned by the existing GATED
  // ingest-install section above) and NEVER a repoKey-shaped per-project unit
  // (hash===null, repoKey set — D28 disjoint regex guarantees this).
  const candidates = units.filter((u) => u && u.hash != null);

  for (const u of candidates) {
    const rid = 'reap-legacy-' + u.hash;
    try {
      const worktreeGone = !u.workingDir || !insideWorktree(u.workingDir);
      let reason = null;
      if (worktreeGone) {
        reason = 'orphaned — worktree no longer resolves (' + (u.workingDir || 'unset') + ')';
      } else {
        let repoKey = null;
        try {
          const { repoKeyForWorktree } = repokeyMod();
          if (typeof repoKeyForWorktree === 'function') repoKey = repoKeyForWorktree(u.workingDir);
        } catch (_) { repoKey = null; }
        if (repoKey && projectDaemonHealthy(home, repoKey, now, o.io)) {
          reason = 'redundant — the per-project daemon for repoKey ' + repoKey + ' is confirmed running+healthy';
        }
      }
      if (!reason) {
        results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'kept', msg: 'legacy ingest unit ' + u.hash + ' left in place (worktree resolves, no confirmed-healthy replacement — may still be the sole drainer)' });
        continue;
      }
      if (dryRun) {
        results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'would-reap', msg: '[dry-run] would reap legacy ingest unit ' + u.hash + ': ' + reason });
        continue;
      }
      const { stopLegacyUnitEntry } = ingestConst();
      if (typeof stopLegacyUnitEntry === 'function') {
        stopLegacyUnitEntry({ label: u.label, unit: u.unit, hash: u.hash }, { platform, home, io: o.io });
      }
      results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'reaped', msg: 'reaped legacy ingest unit ' + u.hash + ' (' + reason + ') via the scheduler (never kill)' });
    } catch (e) {
      results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'failed', msg: 'reap of legacy ingest unit ' + u.hash + ' raised: ' + errMsg(e) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// runRepairs({cwd, env, home, dryRun}) -> [{id, action, status, msg}]
//   status ∈ 'fixed' | 'gated' | 'skipped' | 'failed'
// ---------------------------------------------------------------------------
function runRepairs(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const dryRun = !!o.dryRun;
  const platform = o.platform || process.platform;
  const results = [];
  const push = (id, action, status, msg) => results.push({ id, action, status, msg });

  // GATE — GATED fixes need BOTH a DevSwarm-active env AND a real git worktree cwd.
  let gateOpen = false;
  try {
    const { isDevswarmActive } = require('./devswarm-detect.js');
    const { resolveWorktree } = ingestConst();
    gateOpen = !!(isDevswarmActive(env) && typeof resolveWorktree === 'function' && resolveWorktree(cwd) !== null);
  } catch (_) { gateOpen = false; }
  const gatedHint = (cmd) =>
    'DevSwarm gate closed (needs an active DevSwarm session + a git-worktree cwd). Run manually from the worktree: ' + cmd;

  // The worktree doctor is operating on — used to pick THIS repo's ingest unit out of
  // the (possibly multi-repo) set of installed units, so a wrong-path/stale unit for
  // this repo is healed while OTHER repos' units are only reported, never touched.
  let currentWorktree = null;
  try { const { resolveWorktree } = ingestConst(); if (typeof resolveWorktree === 'function') currentWorktree = resolveWorktree(cwd); } catch (_) {}

  // --- AUTO-SAFE: state migrations -----------------------------------------
  migrationFix('migrate-legacy', 'migrate-legacy-state', () => {
    const r = require(MIGRATE_STATE).migrateLegacyState({ dir: cwd, dryRun: true });
    const pending = r.filter((x) => x.action === 'pending').map((x) => x.file);
    return { pending: pending.length > 0, detail: pending.join(', ') };
  }, () => require(MIGRATE_STATE).migrateLegacyState({ dir: cwd }));

  migrationFix('migrate-gsd', 'migrate-gsd-planning', () => {
    const r = require(MIGRATE_STATE).migrateGsdPlanning({ dir: cwd, dryRun: true });
    const pending = r.filter((x) => x.action === 'pending').map((x) => x.file);
    return { pending: pending.length > 0, detail: pending.length + ' file(s)' };
  }, () => require(MIGRATE_STATE).migrateGsdPlanning({ dir: cwd }));

  migrationFix('migrate-devswarm-store', 'migrate-devswarm-store', () => {
    const r = require(MIGRATE_STATE).migrateDevswarmStore({ dryRun: true });
    return { pending: !!(r && r.pending), detail: (r && r.workspaces || 0) + ' workspace(s)' };
  }, () => require(MIGRATE_STATE).migrateDevswarmStore({}));

  // #70: fold ALL prior mesh forms (phantom rows, dual/legacy pairs, subdir-splits)
  // into one canonical survivor per worktree. A PURE store read+write (forward-then-
  // tombstone, message rows NEVER deleted) — so AUTO-SAFE, not GATED (no daemon /
  // scheduler side effect; same posture as migrate-devswarm-store above). Reuses
  // devswarm.js's foldMeshDuplicates for BOTH the dry-run detect and the apply — one
  // code path, idempotent (a re-run tombstones nothing left), fail-open.
  migrationFix('fold-mesh-duplicates', 'fold-mesh-duplicates', () => {
    const r = require(DEVSWARM_SCRIPT).foldMeshDuplicates(home, { cwd, env, dryRun: true });
    const n = (r && Array.isArray(r.retired)) ? r.retired.length : 0;
    const leftN = (r && Array.isArray(r.left)) ? r.left.length : 0;
    const rekeyN = (r && Number.isFinite(r.rekeyed)) ? r.rekeyed : 0; // P1b: subdir rows to re-key to their toplevel
    return {
      pending: n > 0 || rekeyN > 0,
      detail: (n > 0 ? (n + ' duplicate mesh row(s) to fold') : (rekeyN + ' subdir mesh row(s) to re-key'))
        + (n > 0 && rekeyN ? ' + ' + rekeyN + ' subdir re-key' : '')
        + (leftN ? ' (' + leftN + ' descriptor-backed left in place)' : ''),
    };
  }, () => require(DEVSWARM_SCRIPT).foldMeshDuplicates(home, { cwd, env }));

  // --- AUTO-SAFE: statusline-if-missing ------------------------------------
  try {
    const sl = scanStatusLine(cwd, home);
    if (sl.present) {
      push('statusline', 'install-statusline', 'skipped', 'statusLine already configured — not touching a custom line (' + firstLine(sl.command).slice(0, 48) + ')');
    } else if (dryRun) {
      push('statusline', 'install-statusline', 'skipped', '[dry-run] would install the anti-hall statusline (--user)');
    } else {
      spawnInstaller(STATUSLINE_INSTALLER, ['--user'], cwd, env);
      const after = scanStatusLine(cwd, home);
      if (after.present) push('statusline', 'install-statusline', 'fixed', 'installed the anti-hall statusline (--user)');
      else push('statusline', 'install-statusline', 'failed', 'statusline still absent after install (does ~/.claude/settings.json exist?)');
    }
  } catch (e) {
    push('statusline', 'install-statusline', 'failed', 'statusline repair raised: ' + errMsg(e));
  }

  // --- AUTO-SAFE: codex hook refresh (only when config.toml exists) ---------
  try {
    const codex = scanCodex(cwd, home);
    for (const c of codex) {
      if (c.wired === true) {
        push('codex-' + c.label, 'install-codex', 'skipped', 'anti-hall codex hooks already wired (' + c.label + ')');
      } else if (dryRun) {
        push('codex-' + c.label, 'install-codex', 'skipped', '[dry-run] would refresh anti-hall codex hooks (' + c.label + ')');
      } else {
        spawnInstaller(CODEX_INSTALLER, c.flags, cwd, env);
        const after = scanCodex(cwd, home).find((x) => x.label === c.label);
        if (after && after.wired === true) push('codex-' + c.label, 'install-codex', 'fixed', 'wired anti-hall codex hooks (' + c.label + ')');
        else push('codex-' + c.label, 'install-codex', 'failed', 'codex hooks still unwired after refresh (' + c.label + ')');
      }
    }
  } catch (e) {
    push('codex', 'install-codex', 'failed', 'codex repair raised: ' + errMsg(e));
  }

  // --- Supervisor: AUTO-SAFE relaunch if installed, else GATED first-install -
  if (platform === 'win32') {
    push('supervisor', 'install-supervisor', 'skipped', 'Windows: DevSwarm recovery is a documented no-op (no safe cwd confirm-gate)');
  } else {
    try {
      const installed = unitInstalled(SUPERVISOR_INSTALLER, home, platform);
      if (installed) {
        if (dryRun) push('supervisor', 'refresh-supervisor', 'skipped', '[dry-run] would relaunch the installed supervisor (idempotent refresh)');
        else { spawnInstaller(SUPERVISOR_INSTALLER, [], cwd, env); push('supervisor', 'refresh-supervisor', 'fixed', 'relaunched the installed supervisor (idempotent refresh to this build)'); }
      } else if (!gateOpen) {
        push('supervisor', 'install-supervisor', 'gated', 'supervisor not installed. ' + gatedHint(CMD_SUPERVISOR));
      } else if (dryRun) {
        push('supervisor', 'install-supervisor', 'skipped', '[dry-run] would install the supervisor (gate open)');
      } else {
        spawnInstaller(SUPERVISOR_INSTALLER, [], cwd, env);
        const now = unitInstalled(SUPERVISOR_INSTALLER, home, platform);
        push('supervisor', 'install-supervisor', now ? 'fixed' : 'failed', now ? 'installed the supervisor companion' : 'supervisor still not installed after run');
      }
    } catch (e) {
      push('supervisor', 'install-supervisor', 'failed', 'supervisor repair raised: ' + errMsg(e));
    }
  }

  // --- Ingest daemon: GATED (install / wrong-path rebind / stale-script) ----
  if (platform === 'win32') {
    push('ingest', 'install-ingest', 'skipped', 'Windows: ingest daemon has no built-in scheduler (documented no-op)');
  } else {
    try {
      const read = readInstalledIngestWorkingDir({ home, platform, worktree: currentWorktree });
      // Report OTHER repos' installed ingest units (never healed here — each repo
      // heals its own from its own worktree). Informational only.
      if (read.others && read.others.length) {
        const list = read.others.map((u) => (u.workingDir || '(unknown worktree)')).join(', ');
        push('ingest-others', 'none', 'skipped', read.others.length + ' other ingest unit(s) installed for other worktree(s): ' + list);
      }
      const cls = classifyIngestUnit({ workingDir: read.workingDir, scriptPath: read.scriptPath, home, env });
      if (cls === 'ok') {
        push('ingest', 'install-ingest', 'skipped', 'ingest daemon installed and healthy (WorkingDirectory ' + read.workingDir + ')');
      } else {
        const reason = cls === 'absent' ? 'ingest daemon not installed'
          : cls === 'wrong-path' ? 'ingest daemon WorkingDirectory is wrong (' + (read.workingDir || 'unset') + ')'
          : cls === 'unstable-script' ? 'ingest daemon ExecStart script is not the current stable build (' + (read.scriptPath || 'unset') + ' — pinned to an old/relocatable path)'
          : 'ingest daemon ExecStart script is missing (' + (read.scriptPath || 'unset') + ')';
        if (!gateOpen) {
          push('ingest', 'install-ingest', 'gated', reason + '. ' + gatedHint(CMD_INGEST));
        } else if (dryRun) {
          let wt = cwd;
          try { const { resolveWorktree } = ingestConst(); wt = resolveWorktree(cwd) || cwd; } catch (_) {}
          push('ingest', 'install-ingest', 'skipped', '[dry-run] would (re)install the ingest daemon from ' + wt + ' (' + cls + ')');
        } else {
          spawnInstaller(INGEST_INSTALLER, [], cwd, env);
          const read2 = readInstalledIngestWorkingDir({ home, platform, worktree: currentWorktree });
          const cls2 = classifyIngestUnit({ workingDir: read2.workingDir, scriptPath: read2.scriptPath, home, env });
          if (cls2 === 'ok') push('ingest', 'install-ingest', 'fixed', 'ingest daemon (re)installed — WorkingDirectory now ' + read2.workingDir);
          else push('ingest', 'install-ingest', 'failed', 'ingest daemon still ' + cls2 + ' after reinstall');
        }
      }
    } catch (e) {
      push('ingest', 'install-ingest', 'failed', 'ingest repair raised: ' + errMsg(e));
    }
  }

  // --- Legacy ingest unit orphan sweep: GATED (v0.57 mesh Phase 6, D9/D25/D28) -
  // Belt-and-suspenders reap of legacy per-worktree units already orphaned or
  // provably redundant. Distinct from the ingest section above (which heals THIS
  // worktree's own unit): this sweeps ALL installed legacy units on the machine,
  // so it stays behind the SAME DevSwarm-active + git-worktree gate as every
  // other daemon-touching repair (never mutates scheduler state for an idle/non-
  // DevSwarm session).
  if (platform === 'win32') {
    push('reap-legacy-ingest', 'reap-legacy-ingest', 'skipped', 'Windows: no scheduler to reap legacy ingest units from (documented no-op)');
  } else if (!gateOpen) {
    push('reap-legacy-ingest', 'reap-legacy-ingest', 'gated', 'legacy-ingest-unit orphan sweep skipped. ' + gatedHint(CMD_INGEST));
  } else {
    try {
      const reapResults = reapOrphanedLegacyUnits({ home, platform, dryRun, env });
      if (!reapResults.length) {
        push('reap-legacy-ingest', 'reap-legacy-ingest', 'skipped', 'no legacy per-worktree ingest units installed — nothing to sweep');
      } else {
        for (const r of reapResults) {
          const status = r.status === 'reaped' ? 'fixed'
            : r.status === 'failed' ? 'failed'
            : 'skipped'; // 'kept' | 'would-reap' — informational, not a failure
          push(r.id, 'reap-legacy-ingest', status, r.msg);
        }
      }
    } catch (e) {
      push('reap-legacy-ingest', 'reap-legacy-ingest', 'failed', 'legacy-ingest-unit orphan sweep raised: ' + errMsg(e));
    }
  }

  // --- Reconcile: GATED (drains stranded per-worktree native hivecontrol queues
  // into the shared store) ----------------------------------------------------
  // v0.58.0 shipped `node scripts/devswarm.js reconcile` as a MANUAL-only verb.
  // Wired here as an auto-heal under the SAME DevSwarm gate as every other
  // daemon-touching repair above — safe to auto-run because devswarm.js's own
  // cmdReconcile (and the devswarm-pull.js pullOnce it drives per worktree) is:
  //   - IDEMPOTENT: pullOnce's collectExistingHashes dedupes every recovered
  //     message by content hash (devswarm-pull.js) before appending, so a
  //     re-run imports 0 new messages (already-seen ones count as `duplicate`,
  //     never re-appended).
  //   - LOCK-RESPECTING: pullOnce takes the per-id O_EXCL pull lock
  //     (devswarm-pull.js's acquireExclLock) before touching a worktree's
  //     queue; a worktree a live child is ALREADY draining is SKIPPED (never
  //     raced) and surfaced back as `locked:true` on that descriptor's result,
  //     never silently dropped from the count.
  //   - LOSS-FREE: pullOnce's own RECONCILIATION check compares the native
  //     message-count against what actually landed in the durable inbox/store;
  //     a shortfall fails loud with a `lost` field (devswarm-pull.js) rather
  //     than silently discarding messages — drained messages land in the
  //     SHARED store (store.openStore + ingestPayload/deriveSummary), never a
  //     throwaway.
  // Gate-fail REPORTS the exact manual command and mutates nothing (never
  // spawns a single per-worktree drain). --dry-run never spawns either — a
  // genuine live preview would need a NEW non-destructive count-only mode
  // cmdReconcile does not have; reporting the action without a per-worktree
  // preview matches this file's existing ingest/supervisor dry-run precedent
  // above (which also reports the action, not a live diff).
  if (!gateOpen) {
    push('reconcile', 'reconcile', 'gated', 'stranded per-worktree DevSwarm queues not swept. ' + gatedHint(CMD_RECONCILE));
  } else if (dryRun) {
    push('reconcile', 'reconcile', 'skipped', '[dry-run] would run reconcile (drain stranded per-worktree native queues into the shared store) from ' + (currentWorktree || cwd));
  } else {
    try {
      const devswarm = require(DEVSWARM_SCRIPT);
      const { result } = devswarm.run(['reconcile'], { cwd, env, home });
      if (result && result.ok) {
        push('reconcile', 'reconcile', 'fixed', 'reconciled ' + result.count + ' worktree(s) — imported ' + result.imported + ' message(s) into the shared store');
      } else if (result && result.lost) {
        // P1 fix: a reconcile that LOST messages (real shortfall, distinct
        // from a benign `locked` contention skip) must never be reported as
        // fixed — that would tell the user everything is fine while
        // messages actually vanished. cmdReconcile now returns ok:false with
        // a `lost` total whenever ANY target reports a shortfall.
        push('reconcile', 'reconcile', 'failed', 'reconcile LOST ' + result.lost + ' message(s) across ' + (result.count || 0) + ' worktree(s) — see per-worktree detail: ' + CMD_RECONCILE);
      } else {
        push('reconcile', 'reconcile', 'failed', 'reconcile failed: ' + ((result && (result.reason || result.error)) || 'unknown error'));
      }
    } catch (e) {
      push('reconcile', 'reconcile', 'failed', 'reconcile raised: ' + errMsg(e));
    }
  }

  // --- Reaper: REPORT-ONLY (kills orphans on a timer — never auto-installed) -
  if (platform !== 'win32') {
    try {
      const installed = unitInstalled(REAPER_INSTALLER, home, platform);
      if (installed) push('reaper', 'none', 'skipped', 'MCP orphan reaper installed');
      else push('reaper', 'none', 'skipped', 'MCP orphan reaper not installed (report-only — it kills orphans on a timer, never auto). To enable: ' + CMD_REAPER);
    } catch (e) {
      push('reaper', 'none', 'skipped', 'reaper check raised: ' + errMsg(e));
    }
  }

  return results;

  // ---- local: generic AUTO-SAFE migration fix ----------------------------
  function migrationFix(id, action, detect, apply) {
    try {
      const before = detect();
      if (!before.pending) { push(id, action, 'skipped', 'nothing to migrate'); return; }
      if (dryRun) { push(id, action, 'skipped', '[dry-run] would migrate: ' + (before.detail || 'pending')); return; }
      apply();
      const after = detect();
      if (!after.pending) push(id, action, 'fixed', 'migrated: ' + (before.detail || 'pending'));
      else push(id, action, 'failed', 'still pending after migrate: ' + (after.detail || ''));
    } catch (e) {
      push(id, action, 'failed', id + ' raised: ' + errMsg(e));
    }
  }
}

module.exports = {
  readInstalledIngestWorkingDir, classifyIngestUnit, runRepairs,
  // v0.57 mesh Phase 6 (D9/D25/D28) — legacy ingest unit orphan sweep:
  reapOrphanedLegacyUnits, projectDaemonHealthy,
};

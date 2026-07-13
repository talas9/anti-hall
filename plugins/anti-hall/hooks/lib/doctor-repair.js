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
const SUPERVISOR_INSTALLER = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-supervisor.js');
const REAPER_INSTALLER     = path.join(PLUGIN_ROOT, 'companion', 'install-reaper.js');
const STATUSLINE_INSTALLER = path.join(PLUGIN_ROOT, 'statusline', 'install-statusline.js');
const CODEX_INSTALLER      = path.join(PLUGIN_ROOT, 'codex', 'install-codex.js');
const MIGRATE_STATE        = path.join(PLUGIN_ROOT, 'scripts', 'migrate-state.js');

// Friendly (plugin-relative) command strings for the manual-command hints in
// GATED reports — humans copy these, so keep them repo-relative not absolute.
const CMD_INGEST     = 'node plugins/anti-hall/companion/install-devswarm-ingest.js';
const CMD_SUPERVISOR = 'node plugins/anti-hall/companion/install-devswarm-supervisor.js';
const CMD_REAPER     = 'node plugins/anti-hall/companion/install-reaper.js';

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
// readInstalledIngestWorkingDir({home, platform, worktree}) -> {present, workingDir,
// scriptPath, source, hash, others}. PER-WORKTREE aware (v0.55+): delegates to the
// installer's listInstalledIngestUnits (the canonical multi-unit readback) and picks
// the unit that belongs to the CURRENT worktree so a wrong-path / stale-script unit
// for THIS repo can be detected and healed WITHOUT touching another repo's unit.
//   - worktree given -> match the unit whose hash === worktreeHash(worktree), or a
//     legacy (hash-null) unit whose baked WorkingDirectory IS this worktree.
//   - no worktree    -> the legacy (hash-null) unit if any, else the only unit.
// `others` carries the remaining installed units (OTHER worktrees) for reporting.
// Fail-open: any error -> present:false with an empty `others`.
// ---------------------------------------------------------------------------
function readInstalledIngestWorkingDir(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const out = { present: false, workingDir: null, scriptPath: null, source: null, hash: null, others: [] };

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
  if (o.worktree) {
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

module.exports = { readInstalledIngestWorkingDir, classifyIngestUnit, runRepairs };

'use strict';
// cache-prune.js — the opt-in plugin cache prune behind `doctor --prune-cache`
// (owner-approved 2026-09-26). NEVER automatic: nothing but doctor.js's
// explicit --prune-cache flag calls this — not update.js, the supervisor, a
// cron, SessionStart or any hook. Without --confirmed it only LISTS.
//
// Scope: direct children of <home>/.claude/plugins/cache/anti-hall/anti-hall/
// whose name is a semver. It KEEPS:
//   - the newest 3 version dirs;
//   - every dir holding an installPath registered in installed_plugins.json;
//   - every dir a live process runs from (process cwd, via doctor-devswarm's
//     scanProcessCwds, or the cache path in its argv via `ps`);
//   - the running version (and the dir the running doctor itself lives in);
//   - anything it cannot parse (non-semver names, non-directories), and every
//     symlink (refused, never followed).
// If the live-process scan is unavailable, NOTHING is removed.
// With --confirmed each listed dir is re-validated right before removal
// (still a real directory, not a symlink, its realpath's parent is the cache
// root's realpath) and each removal is logged by the caller.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const KEEP_NEWEST = 3;

function cacheRootFor(home) {
  return path.join(home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
}

function compareVersions(a, b) {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch (_) { return null; }
}

// canonicalPath(p) -> fs.realpathSync.native(p) (resolves symlinks, `..`,
// /tmp vs /private/tmp), falling back to path.resolve(p) when p does not
// exist; lowercased on darwin, whose default volumes are case-insensitive —
// a registered path spelled in a different case names the same dir (0.113 P2).
function canonicalPath(p) {
  let out;
  try { out = fs.realpathSync.native(p); } catch (_) { out = path.resolve(p); }
  return process.platform === 'darwin' ? out.toLowerCase() : out;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// dirSize(dir) -> total bytes of regular files, never following symlinks.
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try { const st = fs.lstatSync(p); if (st.isFile()) total += st.size; } catch (_) { /* skip */ }
    }
  }
  return total;
}

// registeredInstallPaths(home) -> every anti-hall installPath in
// installed_plugins.json (v2 { plugins: { "anti-hall@anti-hall": [...] } } or
// the legacy top-level shape), all scopes.
function registeredInstallPaths(home) {
  const out = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const reg = (data && data.plugins && typeof data.plugins === 'object') ? data.plugins : data;
    const entry = reg && reg['anti-hall@anti-hall'];
    const list = Array.isArray(entry) ? entry : [entry];
    for (const e of list) {
      if (e && typeof e === 'object' && typeof e.installPath === 'string' && e.installPath) out.push(e.installPath);
    }
  } catch (_) { /* missing/unreadable registry: nothing registered */ }
  return out;
}

// defaultScanArgv() -> [command line strings] | null (scan unavailable).
function defaultScanArgv() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const r = cp.spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.split('\n').filter(Boolean);
  } catch (_) {
    return null;
  }
}

// defaultScanCwds() -> [cwd strings] | null. Reuses the 0.111 doctor
// orphan-scan helper (doctor-devswarm.js scanProcessCwds). An empty result
// counts as unavailable: a working scan always sees at least this process.
function defaultScanCwds() {
  try {
    const procs = require('../../companion/lib/doctor-devswarm.js').scanProcessCwds({});
    if (!Array.isArray(procs) || !procs.length) return null;
    return procs.map((p) => p && p.cwd).filter((c) => typeof c === 'string' && c);
  } catch (_) {
    return null;
  }
}

// mentionsDir(text, dirs) -> true when text names one of dirs as a path
// (the dir itself, or anything below it).
function mentionsDir(text, dirs) {
  for (const d of dirs) {
    let i = text.indexOf(d);
    while (i !== -1) {
      const next = text[i + d.length];
      if (next === undefined || next === '/' || next === path.sep || /\s|["']/.test(next)) return true;
      i = text.indexOf(d, i + 1);
    }
  }
  return false;
}

// planCachePrune(opts) -> { root, ok, error?, entries: [{name, dir, action:'remove'|'keep', reasons:[], bytes}], removeBytes }
// opts: { home, runningVersion, runningRoot, scanCwds, scanArgv }
function planCachePrune(opts) {
  const o = opts || {};
  const root = cacheRootFor(o.home);
  const plan = { root, ok: true, entries: [], removeBytes: 0 };
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (_) { plan.error = 'no plugin cache at ' + root; plan.ok = false; return plan; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    plan.ok = false; plan.error = 'refused: the cache root is a symlink or not a directory (' + root + ')'; return plan;
  }
  const realRoot = realOrNull(root) || root;

  let dirents = [];
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { plan.ok = false; plan.error = 'cannot read ' + root; return plan; }

  const versions = [];
  for (const d of dirents) {
    const dir = path.join(root, d.name);
    const entry = { name: d.name, dir, action: 'keep', reasons: [], bytes: 0 };
    plan.entries.push(entry);
    if (d.isSymbolicLink()) { entry.reasons.push('symlink (refused)'); continue; }
    if (!d.isDirectory()) { entry.reasons.push('not a directory'); continue; }
    if (!STRICT_SEMVER_RE.test(d.name)) { entry.reasons.push('unparseable name'); continue; }
    versions.push(entry);
  }

  versions.sort((a, b) => compareVersions(b.name, a.name));
  versions.slice(0, KEEP_NEWEST).forEach((e) => e.reasons.push('newest ' + KEEP_NEWEST));

  for (const p of registeredInstallPaths(o.home)) {
    const reg = canonicalPath(p);
    for (const e of versions) {
      if (isInside(reg, canonicalPath(e.dir))) e.reasons.push('registered installPath');
    }
  }

  if (o.runningVersion) {
    for (const e of versions) if (e.name === o.runningVersion) e.reasons.push('running version');
  }
  if (o.runningRoot) {
    const realRunning = realOrNull(o.runningRoot) || o.runningRoot;
    for (const e of versions) {
      if (isInside(realRunning, realOrNull(e.dir) || e.dir)) e.reasons.push('running doctor lives here');
    }
  }

  const scanCwds = typeof o.scanCwds === 'function' ? o.scanCwds : defaultScanCwds;
  const scanArgv = typeof o.scanArgv === 'function' ? o.scanArgv : defaultScanArgv;
  const cwds = scanCwds();
  const argv = scanArgv();
  const liveScanOk = Array.isArray(cwds) && Array.isArray(argv);
  for (const e of versions) {
    const names = [e.dir, path.join(realRoot, e.name)];
    const live = liveScanOk && (cwds.some((c) => mentionsDir(c, names)) || argv.some((a) => mentionsDir(a, names)));
    if (live) e.reasons.push('live process');
    if (!liveScanOk) e.reasons.push('live-process scan unavailable');
  }

  for (const e of versions) {
    if (e.reasons.length) continue;
    e.action = 'remove';
    e.bytes = dirSize(e.dir);
    plan.removeBytes += e.bytes;
  }
  return plan;
}

// applyCachePrune(plan, log) -> { removed: [{dir, bytes}], refused: [{dir, why}] }.
// Re-validates every 'remove' entry right before deleting it.
function applyCachePrune(plan, log) {
  const say = typeof log === 'function' ? log : () => {};
  const out = { removed: [], refused: [] };
  if (!plan || !plan.ok) return out;
  const realRoot = realOrNull(plan.root);
  for (const e of plan.entries) {
    if (e.action !== 'remove') continue;
    let why = null;
    try {
      const st = fs.lstatSync(e.dir);
      if (st.isSymbolicLink()) why = 'symlink';
      else if (!st.isDirectory()) why = 'not a directory';
    } catch (_) { why = 'gone'; }
    if (!why && !STRICT_SEMVER_RE.test(path.basename(e.dir))) why = 'unparseable name';
    if (!why) {
      const real = realOrNull(e.dir);
      if (!realRoot || !real || path.dirname(real) !== realRoot) why = 'outside the cache root';
    }
    if (why) { out.refused.push({ dir: e.dir, why }); say('refused ' + e.dir + ' (' + why + ')'); continue; }
    try {
      fs.rmSync(e.dir, { recursive: true, force: false });
      out.removed.push({ dir: e.dir, bytes: e.bytes });
      say('removed ' + e.dir + ' (' + formatBytes(e.bytes) + ')');
    } catch (err) {
      out.refused.push({ dir: e.dir, why: 'remove failed: ' + (err && err.message) });
      say('FAILED to remove ' + e.dir + ': ' + (err && err.message));
    }
  }
  return out;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

module.exports = { cacheRootFor, planCachePrune, applyCachePrune, formatBytes, registeredInstallPaths, KEEP_NEWEST };

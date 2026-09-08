#!/usr/bin/env node
// update.js — anti-hall self-update helper (skill: /anti-hall:update).
//
//   node update.js            full update: git pull --ff-only, sync the version-
//                             pinned cache dir, print the CHANGELOG delta + a
//                             JSON status line. Then the skill tells the user to
//                             run /reload-plugins.
//   node update.js --check    dry compare only: git fetch + compare local vs
//                             remote plugin.json version; NO pull, NO writes.
//
// Layout (VERIFIED — see SKILL.md):
//   marketplace clone:  ~/.claude/plugins/marketplaces/anti-hall            (git, origin = talas9/anti-hall)
//   version-pinned cache: ~/.claude/plugins/cache/anti-hall/anti-hall/<version>/
//   active version recorded by the harness in
//       ~/.claude/plugins/installed_plugins.json — HARNESS-OWNED: we READ it,
//       we NEVER write it. v2 schema (VERIFIED live 2026-06-10):
//         { version: 2, plugins: { "anti-hall@anti-hall": [
//             { scope: "user"|"project", installPath, version: "0.32.1",
//               installedAt, lastUpdated, gitCommitSha }, ... ] } }
//
// Fail-open contract: report, don't break. Any failure → a status object with an
// `action` string and exit 0 (so the skill can relay it), unless a destructive
// git precondition (dirty tree / non-fast-forward) demands a hard STOP.
//
// Writes: the marketplace clone dir and stdout, PLUS two ~/.anti-hall/ paths this
// module owns directly — update-sweep-state.json (writeSweepState, atomic tmp+
// rename, fail-open) and, when healIngestDaemon repairs a stale ingest daemon,
// its own state under ~/.anti-hall. The plugin-copy mutation itself is
// fs.cpSync of the marketplace plugin dir into a NEW cache/<ver>/ dir (never
// deletes or overwrites a sibling version). Pure Node >= 18 built-ins;
// cross-platform incl. Windows (git step uses execFileSync, no shell).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

// Bound reads: plugin.json / installed_plugins.json are tiny; CHANGELOG.md can
// grow but stays well under this. A pathological huge file → treated as unread.
const MAX_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path resolution (Step 1)
// ---------------------------------------------------------------------------

/**
 * resolvePaths(env, homedir) → { marketplaceDir, cacheRoot, installedJson, pluginJson, changelog }
 * ANTIHALL_MARKETPLACE_DIR overrides the marketplace clone path (used by tests).
 * cacheRoot / installedJson are derived from the plugins root, which is the
 * grandparent of the default marketplace dir (~/.claude/plugins) — but when the
 * marketplace dir is overridden we derive the plugins root from it too (two
 * levels up: <root>/marketplaces/anti-hall → <root>).
 */
function resolvePaths(env, homedir) {
  env = env || {};
  const home = homedir || os.homedir();
  // ANTIHALL_MARKETPLACE_DIR is a TEST-ONLY escape hatch (fixture trees). It is
  // validated, not trusted: it must be an ABSOLUTE path to an EXISTING
  // directory, else it is ignored (fall back to the default + report via
  // `overrideIgnored`). The syncCache traversal gate (R1-C-01) remains the real
  // write barrier regardless of what this resolves to.
  let marketplaceDir = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall');
  let overrideIgnored = '';
  const override = env.ANTIHALL_MARKETPLACE_DIR;
  if (override) {
    let valid = false;
    try {
      valid = path.isAbsolute(override) && fs.statSync(override).isDirectory();
    } catch (_) {
      valid = false;
    }
    if (valid) {
      marketplaceDir = override;
    } else {
      overrideIgnored =
        'warning: ANTIHALL_MARKETPLACE_DIR ignored (not an absolute path to an existing directory): ' + override;
    }
  }
  // plugins root = two levels above the marketplace clone (.../plugins/marketplaces/anti-hall)
  const pluginsRoot = path.resolve(marketplaceDir, '..', '..');
  return {
    marketplaceDir,
    overrideIgnored,
    pluginsRoot,
    cacheRoot: path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall'),
    installedJson: path.join(pluginsRoot, 'installed_plugins.json'),
    pluginJson: path.join(marketplaceDir, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'),
    changelog: path.join(marketplaceDir, 'CHANGELOG.md'),
    pluginSrcDir: path.join(marketplaceDir, 'plugins', 'anti-hall'),
  };
}

// ---------------------------------------------------------------------------
// Bounded JSON read (fail-soft → null)
// ---------------------------------------------------------------------------
function readJsonBounded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_BYTES) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Version comparison (semver-ish: numeric dot segments, ignores pre-release tags)
// ---------------------------------------------------------------------------

// Strict semver-shape gate. EVERY step of the installed-version resolution
// chain must pass this before its value may surface. REGRESSION (live E2E,
// 2026-06-10): a commit-sha-named cache dir ('3928cc1257d9') starts with digits,
// so parseVersion's lenient leading-digit match accepted it as [3928]; it then
// sorted as the "newest" cache version AND compared newer than 0.32.1 → a hash
// reported as installed + a false 'already up to date'. isSemver closes that
// hole: \d+.\d+.\d+ required, so bare digit-prefixed hex never qualifies.
// FULLY anchored (^...$) — a start-only anchor accepted '0.33.0/../../../evil'
// (R1-C-01), which a later path.join would have used to escape the cache root.
// Optional -prerelease/+build suffix is allowed; path separators are not.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** isSemver(v) → true only for 'X.Y.Z'-shaped strings (v-prefix tolerated). */
function isSemver(v) {
  return typeof v === 'string' && SEMVER_RE.test(v.trim().replace(/^v/i, ''));
}

/** parseVersion('1.2.3') → [1,2,3]; tolerates 'v1.2', '1.2.3-beta'. null if unparseable. */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  const parts = m[1].split('.').map(n => parseInt(n, 10));
  if (parts.some(n => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * compareVersions(a, b) → -1 if a<b, 0 if equal, 1 if a>b. Unparseable sorts
 * LAST-known (treated as 0.0.0) so a readable version always wins the compare.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a) || [0];
  const pb = parseVersion(b) || [0];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Installed version resolution (Step 2): installed_plugins.json → newest cache
// dir → marketplace plugin.json. Read-only throughout.
// ---------------------------------------------------------------------------

/**
 * versionFromInstalledJson(installedJson path) → semver string | null.
 *
 * v2 schema (VERIFIED live): { version: 2, plugins: { "anti-hall@anti-hall":
 * [ { scope: "user"|"project", version: "0.32.1", ... }, ... ] } } — the entry
 * lives under .plugins and is an ARRAY of scope entries. Prefer scope "user",
 * then "project", then any entry with a valid semver. Legacy/flat shapes
 * (top-level key, bare string, single {version} object) are tolerated.
 * Non-semver values NEVER surface (→ null, next fallback).
 */
function versionFromInstalledJson(installedJsonPath) {
  const data = readJsonBounded(installedJsonPath);
  if (!data || typeof data !== 'object') return null;
  // v2: registry under .plugins; legacy: key at top level.
  const reg = (data.plugins && typeof data.plugins === 'object') ? data.plugins : data;
  const entry = reg['anti-hall@anti-hall'];
  if (Array.isArray(entry)) {
    const valid = entry.filter(e => e && typeof e === 'object' && isSemver(e.version));
    const pick =
      valid.find(e => e.scope === 'user') ||
      valid.find(e => e.scope === 'project') ||
      valid[0];
    return pick ? pick.version : null;
  }
  if (typeof entry === 'string') return isSemver(entry) ? entry : null;
  if (entry && typeof entry === 'object' && isSemver(entry.version)) return entry.version;
  return null;
}

/**
 * newestCacheVersion(cacheRoot) → highest SEMVER dir name | null.
 * isSemver (not parseVersion) gates the dir names: real caches contain
 * commit-sha-named dirs (e.g. '3928cc1257d9') that a leading-digit match would
 * accept and sort above every real version — the live-E2E regression.
 */
function newestCacheVersion(cacheRoot) {
  try {
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    const versions = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => isSemver(name));
    if (versions.length === 0) return null;
    return versions.sort(compareVersions).pop();
  } catch (_) {
    return null;
  }
}

/** versionFromMarketplace(pluginJson path) → semver string | null. */
function versionFromMarketplace(pluginJsonPath) {
  const data = readJsonBounded(pluginJsonPath);
  if (data && isSemver(data.version)) return data.version;
  return null;
}

/**
 * resolveInstalledVersion(paths) → semver string | null.
 * Order: installed_plugins.json → newest cache dir → marketplace plugin.json.
 * Every step is isSemver-gated, so a non-semver value at any step falls through
 * to the next; null means GENUINELY unknown (callers must report
 * 'unknown-installed-version', never 'already up to date').
 */
function resolveInstalledVersion(paths) {
  return (
    versionFromInstalledJson(paths.installedJson) ||
    newestCacheVersion(paths.cacheRoot) ||
    versionFromMarketplace(paths.pluginJson)
  );
}

// ---------------------------------------------------------------------------
// CHANGELOG extraction (Step 6)
// ---------------------------------------------------------------------------

/**
 * extractChangelog(text, fromVersion, toVersion) → string
 * Returns the concatenated `## <version>` sections strictly newer than
 * fromVersion (exclusive) and up to toVersion (inclusive). Sections are matched
 * by a heading line `## <semver>` (optionally followed by more text). Order is
 * preserved as found in the file (newest-first by convention). Missing/empty →
 * ''. Malformed input → '' (never throws).
 */
function extractChangelog(text, fromVersion, toVersion) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const lines = text.split(/\r?\n/);
  // Heading regex: '## 0.32.1' or '## 0.32.1 — title'. Capture the version token.
  const headingRe = /^##\s+v?(\d+(?:\.\d+)*)\b/;
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (current) sections.push(current);
      current = { version: m[1], body: [line] };
    } else if (current) {
      current.body.push(line);
    }
    // lines before the first heading (preamble) are dropped.
  }
  if (current) sections.push(current);

  const out = [];
  for (const sec of sections) {
    const newerThanFrom = !fromVersion || compareVersions(sec.version, fromVersion) > 0;
    const upToTarget = !toVersion || compareVersions(sec.version, toVersion) <= 0;
    if (newerThanFrom && upToTarget) {
      out.push(sec.body.join('\n').replace(/\s+$/, ''));
    }
  }
  return out.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Cache sync (Step 5)
// ---------------------------------------------------------------------------

/**
 * syncCache(paths, newVersion, fsImpl) → { synced: bool, reason: string }
 * Copies marketplace plugins/anti-hall/ → cache/anti-hall/anti-hall/<newVersion>/
 * ONLY when (a) the cache ROOT already exists (we mirror the manager's layout,
 * we don't invent it) and (b) the target <newVersion>/ dir does NOT yet exist.
 * Never deletes or overwrites a sibling version dir. fsImpl is injectable for
 * tests (defaults to the real fs).
 */
function syncCache(paths, newVersion, fsImpl) {
  const f = fsImpl || fs;
  try {
    if (!newVersion) return { synced: false, reason: 'no target version' };
    // Defense-in-depth (R1-C-01): even though every caller isSemver-gates the
    // version, reject ANY value that could traverse out of the cache root when
    // joined — must be a single path segment with no separators or '..'.
    if (
      typeof newVersion !== 'string' ||
      newVersion !== path.basename(newVersion) ||
      /[\\/]|\.\./.test(newVersion)
    ) {
      return { synced: false, reason: 'unsafe version string' };
    }
    // cache root must already exist (the plugin manager created it on install).
    let rootStat;
    try { rootStat = f.statSync(paths.cacheRoot); } catch (_) { rootStat = null; }
    if (!rootStat || !rootStat.isDirectory()) {
      return { synced: false, reason: 'cache root absent (nothing to mirror)' };
    }
    const target = path.join(paths.cacheRoot, newVersion);
    // Target already present → never overwrite.
    try {
      if (f.statSync(target)) return { synced: false, reason: 'cache already has ' + newVersion };
    } catch (_) {
      // does not exist → proceed to copy
    }
    // Source must exist.
    try {
      if (!f.statSync(paths.pluginSrcDir).isDirectory()) {
        return { synced: false, reason: 'plugin source dir missing' };
      }
    } catch (_) {
      return { synced: false, reason: 'plugin source dir missing' };
    }
    f.cpSync(paths.pluginSrcDir, target, { recursive: true });
    return { synced: true, reason: 'copied ' + newVersion };
  } catch (e) {
    return { synced: false, reason: 'copy failed: ' + (e && e.message) };
  }
}

// ---------------------------------------------------------------------------
// Git step (Step 3) — injectable exec for tests (no real git/network in tests).
// ---------------------------------------------------------------------------

// Positively-recognized offline / network / no-git failure shapes — the ONLY
// pull-failure class that fails open (report, exit 0). Covers git's own
// network errors, libcurl messages, OS resolver errors, Node spawn errors
// (ENOENT = git binary missing), and the Windows "not recognized" shell text.
const OFFLINE_RE = new RegExp(
  [
    'could not resolve host',
    'unable to access',
    'could not read from remote',
    'failed to connect',
    'connection (?:refused|reset|timed? ?out)',
    'network is unreachable',
    'temporary failure in name resolution',
    'no route to host',
    'operation timed out',
    'timed out',
    'command not found',
    'not recognized as an internal or external command',
    'ENOENT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENETUNREACH',
  ].join('|'),
  'i'
);

// 20s (was 60s): a hung/slow remote should fail fast into the existing
// fail-open path (report + continue with local state) rather than block the
// update for a full minute per git call — gitState + gitPullFfOnly each make
// one such call. Failure/timeout behavior itself (OFFLINE_RE fail-open vs
// hard STOP) is unchanged; only how long we wait before deciding.
const GIT_EXEC_TIMEOUT_MS = 20000;

/** defaultExec(args, cwd) → stdout string. Throws on non-zero (carries .stderr/.status). */
function defaultExec(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_EXEC_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * gitState(marketplaceDir, exec) → { ok, clean, reason }
 * Reads `git status --porcelain`; clean=true when empty. ok=false on error
 * (offline/no-git/not-a-repo) — the caller fails open.
 */
function gitState(marketplaceDir, exec) {
  try {
    const out = exec(['status', '--porcelain'], marketplaceDir);
    return { ok: true, clean: String(out).trim().length === 0, reason: '' };
  } catch (e) {
    return { ok: false, clean: false, reason: gitErr(e) };
  }
}

function gitErr(e) {
  const stderr = e && (e.stderr || (e.output && e.output[2]));
  const msg = (stderr ? String(stderr) : (e && e.message) || String(e)).trim();
  return msg.split('\n')[0] || 'git error';
}

/**
 * gitPullFfOnly(marketplaceDir, exec) → { ok, action, reason }
 * NEVER merges/rebases/force-pulls. On a non-fast-forward or dirty tree the
 * caller must STOP. Offline/no-git → ok:false, reason set, caller exits 0.
 */
function gitPullFfOnly(marketplaceDir, exec) {
  try {
    exec(['pull', '--ff-only'], marketplaceDir);
    return { ok: true, action: 'pulled', reason: '' };
  } catch (e) {
    return { ok: false, action: 'pull-failed', reason: gitErr(e) };
  }
}

/**
 * gitFetchAndRemoteVersion(paths, exec) → { ok, reason } — used by --check.
 * Fetches without merging, then the caller reads the remote plugin.json version
 * via `git show origin/HEAD:...`. We surface the remote file content here.
 */
function remotePluginVersion(marketplaceDir, exec) {
  try {
    exec(['fetch', '--quiet'], marketplaceDir);
  } catch (e) {
    return { ok: false, version: null, reason: gitErr(e) };
  }
  // Resolve the upstream ref for the current branch, fall back to origin/HEAD.
  let ref = 'origin/HEAD';
  try {
    ref = String(exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], marketplaceDir)).trim() || ref;
  } catch (_) { /* detached or no upstream → origin/HEAD */ }
  try {
    const raw = exec(['show', ref + ':plugins/anti-hall/.claude-plugin/plugin.json'], marketplaceDir);
    const data = JSON.parse(raw);
    return { ok: true, version: (data && typeof data.version === 'string') ? data.version : null, reason: '' };
  } catch (e) {
    return { ok: false, version: null, reason: gitErr(e) };
  }
}

// ---------------------------------------------------------------------------
// Sweep throttling + resume/stamp state (post-update heavy scans) — Step 5.4.
// ---------------------------------------------------------------------------
//
// foldAllStoresPostUpdate / healRegistryPostUpdate each enumerate EVERY
// per-project DevSwarm store on this machine (hundreds, on a heavily-used
// box). Unthrottled + re-run in full on every single update, that turns a
// routine update into a minutes-long stall. This section adds three things,
// shared by both sweeps (and reused by healIngestDaemon's own version check):
//   1. a small yield between per-item iterations (Atomics.wait — a real
//      pure-Node sleep, never a busy-wait spin) so a long sweep never runs as
//      one uninterrupted CPU burst,
//   2. an overall TIME BUDGET (default 20s, ANTIHALL_UPDATE_SWEEP_BUDGET_MS-
//      overridable) — on exhaustion the sweep stops cleanly mid-list. Every
//      sweep step is independently idempotent (fold/heal never re-does work a
//      prior partial pass already completed), so a resumed sweep next run is
//      always safe,
//   3. a persisted state file (~/.anti-hall/update-sweep-state.json) recording
//      EITHER a pending-resume list (continue from here next run) OR a
//      completed-for-version stamp (skip entirely on a re-run at the SAME
//      version — these are one-time per-version migrations, not steady-state
//      work; a version bump naturally invalidates the old stamp). Fully
//      fail-open: an unreadable/corrupt state file reads as empty, never
//      thrown; a write failure is swallowed (the NEXT run just re-sweeps).
const DEFAULT_SWEEP_BUDGET_MS = 20000;
const DEFAULT_SWEEP_YIELD_MS = 30;

/** sweepBudgetMs(env) -> positive ms, ANTIHALL_UPDATE_SWEEP_BUDGET_MS-overridable. */
function sweepBudgetMs(env) {
  const raw = (env || process.env || {}).ANTIHALL_UPDATE_SWEEP_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWEEP_BUDGET_MS;
}

// DEFAULT_POSTPULL_BUDGET_MS / postPullBudgetMs(env) (D11-C, defect
// e7307778b614): an OVERALL wall-clock ceiling across every DevSwarm
// post-pull sweep stage combined (reconcile through heal-registry-rows) —
// distinct from each stage's OWN per-stage budget (sweepBudgetMs/
// resolveReconcileBudgetMs above), which bounds how long ONE stage spends but
// not how many stages a single update run pays for in total. Field-measured:
// reconcile (62s, within its own 60s-ish budget already) + fold-all-stores
// (17.6s) + heal-orphan-partitions (45.8s, itself already over its 20s
// per-stage budget — a SEPARATE defect, fixed alongside this one) + a
// fold-archived-rows pass that never finished at all summed past a 300s kill
// ceiling. This budget is checked BEFORE each stage starts (never mid-stage);
// once exhausted, every remaining stage is deferred whole — reported as
// `deferred: true` rather than silently skipped, and NOT run at all this
// pass. Every deferred stage is either itself idempotent/resumable (fold/
// heal/fold-archived-rows all persist their own resume markers) or re-derives
// fresh from disk on the next `update` invocation, so deferring it costs
// nothing but time — see runUpdate's own call site for which stages carry a
// periodic safety net (companion/devswarm-supervisor.js's cooldown-gated
// sweep) versus which rely SOLELY on the next update/doctor run.
// ANTIHALL_UPDATE_POSTPULL_BUDGET_MS-overridable; 0 = unlimited (opt-out,
// mirrors ANTIHALL_RECONCILE_BUDGET_MS's own 0-means-unlimited convention).
const DEFAULT_POSTPULL_BUDGET_MS = 90000;
function postPullBudgetMs(env) {
  const raw = (env || process.env || {}).ANTIHALL_UPDATE_POSTPULL_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_POSTPULL_BUDGET_MS;
}

/**
 * sweepYield(ms) -> blocks the event loop for `ms` via Atomics.wait — a real
 * sleep, never a spin/busy-wait. Fails open (no-op) on a runtime without
 * SharedArrayBuffer/Atomics: pacing is best-effort, never load-bearing for
 * correctness.
 */
function sweepYield(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) { /* no-op */ }
}

/**
 * runThrottledSweep({ items, budgetMs, yieldMs, worker, now, sleepFn }) ->
 *   { results, processedItems, remaining, budgetExhausted }
 * Calls worker(item, index) for each item in order, sleeping `yieldMs`
 * between calls. Stops BEFORE starting an item once the budget has elapsed —
 * an in-flight worker call is never interrupted. The FIRST item always runs
 * regardless of budget, so a budget of 0 still guarantees forward progress
 * instead of stalling forever on an ever-growing store list.
 */
function runThrottledSweep(opts) {
  const o = opts || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : DEFAULT_SWEEP_BUDGET_MS;
  const yieldMs = Number.isFinite(o.yieldMs) ? o.yieldMs : DEFAULT_SWEEP_YIELD_MS;
  const now = o.now || Date.now;
  const sleep = o.sleepFn || sweepYield;
  const worker = o.worker;
  const start = now();
  const results = [];
  const processedItems = [];
  let i = 0;
  for (; i < items.length; i++) {
    if (i > 0 && (now() - start) >= budgetMs) break;
    results.push(worker(items[i], i));
    processedItems.push(items[i]);
    if (i < items.length - 1) sleep(yieldMs);
  }
  return { results, processedItems, remaining: items.slice(i), budgetExhausted: i < items.length };
}

/**
 * storeDirSizeBytes(dir, fsi) -> total bytes on disk for one store directory,
 * fail-open to 0 on any read error. SHALLOW by design: sums top-level file
 * sizes plus one level into any subdirectory (the only shape either backend
 * writes — sqlite's devswarm.db/-wal/-shm sit at top level; the journal
 * backend's messages/registry/etc. live one level down under journal/) — no
 * need to walk deeper than what devswarm-store.js itself ever creates.
 */
function storeDirSizeBytes(dir, fsi) {
  const F = fsi || fs;
  let total = 0;
  let entries;
  try { entries = F.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        let sub = [];
        try { sub = F.readdirSync(p); } catch (_) { sub = []; }
        for (const name of sub) {
          try { total += F.statSync(path.join(p, name)).size; } catch (_) { /* unreadable entry, skip */ }
        }
      } else {
        total += F.statSync(p).size;
      }
    } catch (_) { /* unreadable entry, skip */ }
  }
  return total;
}

/**
 * orderStoreHashesBySize(devstore, home, hashes, fsi) -> hashes reordered
 * SMALLEST-DISK-SIZE-FIRST.
 *
 * FIX (field-measured starvation): runThrottledSweep walks its `items` in
 * whatever order they arrive and stops BEFORE starting the next item once the
 * wall-clock budget (default 20s) has elapsed. listStoreHashes' raw
 * fs.readdirSync order has no relationship to store cost, so a single large
 * store (measured on this machine: 39MB, one project's db+wal) can consume
 * the entire budget while stores needing milliseconds (measured: two 48KB
 * stores) sit later in that same readdir order — starved on EVERY run,
 * because readdir order is stable. At a version boundary (which forces a
 * full re-enumeration — sweepItemsFor's fullEnumerate path) this wastes an
 * entire sweep on the same victims.
 *
 * Smallest-first bounds the damage: every store this pass processes gets
 * SOME budget before a large store can consume the rest, and a store's disk
 * size is a reasonable (not perfect, but cheap) proxy for how long
 * healRegistry/foldMeshDuplicates/healOrphanPartitions will spend on it —
 * all three walk the registry/messages the store actually holds, which is
 * exactly what its size on disk reflects.
 *
 * Cost measured empirically (see tests/scripts/update-sweep-order.test.js):
 * stat-ing every store's shallow size for a few hundred stores is single-digit
 * milliseconds — negligible next to the 20s budget it's ordering. Fail-open:
 * a size read error scores 0 (same bucket as a genuinely-empty store), never
 * throws, never reorders on partial failure — worst case, an unreadable
 * store keeps its position among other zero-sized ones.
 */
function orderStoreHashesBySize(devstore, home, hashes, fsi) {
  const list = Array.isArray(hashes) ? hashes : [];
  if (list.length < 2) return list.slice();
  const sized = list.map((h) => {
    let size = 0;
    try { size = storeDirSizeBytes(devstore.storeDirForHash(home, h), fsi); } catch (_) { size = 0; }
    return { h, size };
  });
  sized.sort((a, b) => a.size - b.size);
  return sized.map((x) => x.h);
}

/** sweepStatePath(home) -> ~/.anti-hall/update-sweep-state.json (home-injectable). */
function sweepStatePath(home) { return path.join(home, '.anti-hall', 'update-sweep-state.json'); }

/** readSweepState(home) -> plain object, fail-open (missing/corrupt/non-object -> {}). */
function readSweepState(home) {
  try {
    const raw = fs.readFileSync(sweepStatePath(home), 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

/** writeSweepState(home, state) -> bool ok. Fail-open — a write failure is
 * swallowed; the next run simply re-sweeps instead of trusting a stale/absent
 * stamp. Atomic (tmp + rename) so a crash mid-write never corrupts the file. */
function writeSweepState(home, state) {
  try {
    const dir = path.join(home, '.anti-hall');
    fs.mkdirSync(dir, { recursive: true });
    const file = sweepStatePath(home);
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

/**
 * sweepItemsFor(state, key, version, fullEnumerate) -> { skip, items }
 * skip:true when `key` is already stamped complete for `version` (nothing to
 * do). Otherwise `items` is either a prior partial run's pending list (same
 * key + version — RESUME) or `fullEnumerate()`'s result (first run at this
 * version, or state unreadable/absent). `version` falsy (direct/unit-test
 * calls with no version) always takes the fullEnumerate path — no stamping
 * without a version to stamp against.
 */
function sweepItemsFor(state, key, version, fullEnumerate) {
  const s = state[key];
  if (version && s && s.completedVersion === version) return { skip: true, items: [] };
  if (version && s && s.pendingVersion === version && Array.isArray(s.pendingHashes) && s.pendingHashes.length) {
    return { skip: false, items: s.pendingHashes.slice() };
  }
  return { skip: false, items: fullEnumerate() };
}

/**
 * recordSweepResult(home, state, key, version, sweep, opts) -> updated state
 * (persisted to disk, fail-open). `sweep` is a runThrottledSweep() result.
 * Budget-exhausted -> a pending list is saved for next run to RESUME from.
 * Fully drained AND clean (opts.clean !== false) -> a completed-for-version
 * stamp is saved (skips entirely next run at the SAME version). Fully drained
 * but NOT clean (per-item errors occurred) -> NO completion stamp: the stamp
 * must never bless a pass that skipped real work (e.g. a transiently-locked
 * store) — any stale pending list is cleared so the NEXT run re-enumerates in
 * full, exactly the pre-stamp behavior, just throttled. No-op (returns state
 * unchanged, writes nothing) when `version` is falsy.
 *
 * `lastCompletedHash` is OBSERVABILITY-ONLY — decided, not incidental. It is
 * never read back by sweepItemsFor/resumption: `pendingHashes` alone is the
 * resume cursor (the FULL remaining list, not an index into it), because a
 * store hash disappearing/reordering between runs (a store removed, or a
 * fresh listStoreHashes() enumeration ordering it differently) would make a
 * "resume after hash X" position ambiguous or wrong, whereas an explicit
 * remaining-list has no such failure mode. Wiring lastCompletedHash up as a
 * second, competing resume mechanism would only add a second source of
 * truth that could drift from pendingHashes for no resumption benefit. It is
 * kept and set purely so a human/log inspecting ~/.anti-hall/update-sweep-
 * state.json mid-sweep can see the last store actually finished before a
 * budget stop — debugging aid, not a control-flow input. Do not read it in
 * sweepItemsFor.
 */
function recordSweepResult(home, state, key, version, sweep, opts) {
  if (!version) return state;
  const clean = !(opts && opts.clean === false);
  const next = Object.assign({}, state);
  if (sweep.budgetExhausted) {
    next[key] = {
      pendingVersion: version,
      pendingHashes: sweep.remaining,
      lastCompletedHash: sweep.processedItems.length ? sweep.processedItems[sweep.processedItems.length - 1] : null,
      completedVersion: (state[key] && state[key].completedVersion) || null,
    };
  } else if (clean) {
    next[key] = { completedVersion: version, completedTs: Date.now(), pendingVersion: null, pendingHashes: [], lastCompletedHash: null };
  } else {
    next[key] = {
      completedVersion: (state[key] && state[key].completedVersion) || null,
      pendingVersion: null, pendingHashes: [], lastCompletedHash: null,
    };
  }
  writeSweepState(home, next);
  return next;
}

// ---------------------------------------------------------------------------
// Ingest-daemon heal (Step 5.5) — the update → doctor auto-heal wiring.
// ---------------------------------------------------------------------------

/**
 * healIngestDaemon({ paths, env, cwd, spawnFn }) → { attempted, healed, detail }
 *
 * Root-cause companion fix (see install-devswarm-ingest.js SCRIPT /
 * resolveStableScript): a DevSwarm ingest daemon installed BEFORE the installer
 * baked a STABLE script path (the marketplace clone this very update.js just
 * `git pull --ff-only`ed IN PLACE) is still pointed at whatever path it was
 * baked from at install time — a version-pinned cache dir the plugin manager
 * may have relocated/.bak'd out from under it. A FRESH install after that fix
 * never goes stale again, but an ALREADY-broken daemon needs a one-time
 * re-bake. This wires that re-bake into the update itself instead of relying
 * solely on a human (or an LLM agent following SKILL.md prose) remembering to
 * run doctor or reinstall.
 *
 * GATED the same way hooks/lib/doctor-repair.js gates its own ingest fix
 * (isDevswarmActive(env) && resolveWorktree(cwd) !== null) — reuses THAT
 * module's already-tested readInstalledIngestWorkingDir/classifyIngestUnit
 * (read-only) instead of re-deriving the classification logic here, and only
 * spawns the (freshly-pulled) installer when the classification is NOT already
 * 'ok'. Requires from paths.pluginSrcDir (the just-pulled marketplace clone),
 * not this update.js's own possibly-stale __dirname, so the installer that
 * actually runs is the one carrying the stable-path fix.
 *
 * REPOKEY-AWARE (v0.57 mesh Phase 6, D9/D24): spawning the installer on a real
 * git worktree now ALSO reaps this repo's LEGACY per-worktree unit (D9
 * reap-before-drain — see install-devswarm-ingest.js's reapLegacyUnitsForRepo,
 * invoked unconditionally from a resolved worktree) and installs the PER-PROJECT
 * (repoKey-keyed) unit in its place. Re-checking ONLY the legacy unit after that
 * spawn would find it GONE (reaped, not fixed) and misreport healed:false
 * forever. So `bestUnit` below prefers the freshly-installed PROJECT unit
 * (readInstalledIngestWorkingDir({repoKey})) when repoKey resolves and a project
 * unit exists, falling back to the LEGACY per-worktree unit otherwise — which
 * also keeps this fully backward-compatible with a pre-mesh install (no project
 * unit yet) and with mocked-spawnFn tests that only simulate a legacy-unit fix.
 *
 * Fully fail-open: ANY error here is reported in `detail` and NEVER thrown — a
 * heal failure must never fail the update itself.
 */
/**
 * inspectInstalledIngest(opts) -> { gated, detail, installIngest, worktree, repoKey, bestUnit, cls }
 *
 * The SHARED read-only half of the ingest heal: resolve the freshly-pulled
 * plugin modules, apply the DevSwarm/worktree gate, locate the unit that is
 * actually installed for this repo, and classify it. Extracted (v0.86) so the
 * heal DECISION and the heal ACTION read the exact same unit through the exact
 * same lookup — the two cannot drift into disagreeing about what "ok" means.
 *
 * `gated:true` means "do not heal, and this is not a defect" (not a DevSwarm
 * session, cwd is not a worktree, or the expected plugin files are missing);
 * `detail` then carries the reason verbatim for the caller's result object.
 *
 * READ-ONLY: readInstalledIngestWorkingDir enumerates the installed units and
 * classifyIngestUnit statSyncs the baked WorkingDirectory/script path. Neither
 * writes, spawns, or mutates anything — verified in hooks/lib/doctor-repair.js.
 * Fully fail-open: never throws.
 */
function inspectInstalledIngest(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  const gate = (detail) => ({ gated: true, detail, cls: null });
  try {
    if (!paths || !paths.pluginSrcDir) return gate('ingest heal skipped: no plugin source dir resolved');
    const installerPath = path.join(paths.pluginSrcDir, 'companion', 'install-devswarm-ingest.js');
    const repairPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'doctor-repair.js');
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const repokeyPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-repokey.js');
    if (!fs.existsSync(installerPath) || !fs.existsSync(repairPath) || !fs.existsSync(detectPath)) {
      return gate('ingest heal skipped: expected plugin files not found under ' + paths.pluginSrcDir);
    }
    const installIngest = require(installerPath);
    const { isDevswarmActive } = require(detectPath);
    const { readInstalledIngestWorkingDir, classifyIngestUnit } = require(repairPath);

    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return gate('not a DevSwarm session — ingest heal skipped (gate closed)');
    }
    const worktree = typeof installIngest.resolveWorktree === 'function' ? installIngest.resolveWorktree(cwd) : null;
    if (!worktree) {
      return gate('cwd is not a git worktree — ingest heal skipped (gate closed)');
    }

    // repoKey (v0.57 mesh): fail-open to null on ANY error (older marketplace
    // clone pre-dating devswarm-repokey.js, non-resolvable worktree, etc.) — a
    // null repoKey just means bestUnit below always falls back to the LEGACY
    // per-worktree reading, i.e. today's pre-mesh behavior, unchanged.
    let repoKey = null;
    try {
      if (fs.existsSync(repokeyPath)) {
        const repokey = require(repokeyPath);
        if (typeof repokey.repoKeyForWorktree === 'function') repoKey = repokey.repoKeyForWorktree(worktree);
      }
    } catch (_) { repoKey = null; }

    // bestUnit — prefer the PER-PROJECT (repoKey) unit when one exists (the
    // mesh-era canonical install target); otherwise fall back to the LEGACY
    // per-worktree unit (pre-mesh, or a mocked test that never writes a project
    // unit). Never a hard error: readInstalledIngestWorkingDir itself fails open.
    const bestUnit = () => {
      const project = repoKey ? readInstalledIngestWorkingDir({ repoKey, home, platform: o.platform }) : { present: false };
      if (project.present) return project;
      return readInstalledIngestWorkingDir({ worktree, home, platform: o.platform });
    };
    const before = bestUnit();
    const cls = classifyIngestUnit({ workingDir: before.workingDir, scriptPath: before.scriptPath, home, env });
    return { gated: false, detail: null, installerPath, classifyIngestUnit, bestUnit, cls };
  } catch (e) {
    return gate('ingest inspect raised: ' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * ingestUnitNeedsHeal(opts) -> boolean
 *
 * The heal TRIGGER for a run that synced no new bytes (v0.86 root-cause fix).
 *
 * Pre-fix, runUpdate gated healIngestDaemon on `cache.synced` alone — i.e. heal
 * only ever ran when THIS run copied a new version into the cache. But a daemon
 * goes stale WITHOUT any version bump (the plugin manager relocates or .bak's
 * the version-pinned cache dir the unit was baked from), and in that steady
 * state syncCache no-ops, `cache.synced` is false, and classifyIngestUnit — the
 * one thing that would notice the dangling scriptPath — was never reached. The
 * function whose own header describes re-baking exactly that daemon was
 * unreachable precisely when it was needed.
 *
 * Returns true ONLY for a unit that is installed AND classified broken.
 * 'absent' is deliberately NOT a trigger: first-installing an opt-in daemon
 * unprompted is the update SKILL's explicit step, not this code path's job
 * (healIngestDaemon already returns a no-op for it), so treating 'absent' as
 * "needs heal" would spawn an installer on every no-op update for every user
 * who never opted in. A closed gate (`cls === null`) is likewise not a trigger.
 */
function ingestUnitNeedsHeal(opts) {
  const info = inspectInstalledIngest(opts);
  if (info.gated || !info.cls) return false;
  return info.cls !== 'ok' && info.cls !== 'absent';
}

function healIngestDaemon(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  try {
    // Shared read-only lookup + gate + classification (see inspectInstalledIngest).
    const info = inspectInstalledIngest(o);
    if (info.gated) return { attempted: false, healed: false, detail: info.detail };
    const { installerPath, classifyIngestUnit, bestUnit, cls } = info;
    if (cls === 'absent') {
      // Not installed here — first-installing an opt-in daemon unprompted stays
      // the update SKILL's own explicit, documented step (SKILL.md step 7), not
      // this code path's job.
      return { attempted: true, healed: true, detail: 'ingest daemon absent — no heal needed' };
    }

    // #4 pacing fix: defense-in-depth against a spawn race — TWO update.js
    // runs (e.g. two DevSwarm worktree sessions) that each observe
    // cache.synced:true for the SAME newly-copied version would, pre-fix,
    // each independently spawn the installer. `o.version` (runUpdate passes
    // the just-resolved `latest`) lets a SECOND spawn for a version this
    // process already healed (persisted stamp) skip when the daemon is
    // ALSO currently healthy — never when it isn't, so a genuinely broken
    // daemon still gets re-installed regardless of the stamp. `o.version`
    // falsy (every existing call site/test that predates this) always falls
    // through to the pre-existing forced-restart behavior, unchanged.
    const version = o.version || null;
    if (version && cls === 'ok') {
      const priorState = readSweepState(home);
      const healedVersion = priorState.ingestHeal && priorState.ingestHeal.healedVersion;
      if (healedVersion === version) {
        return { attempted: true, healed: true, detail: 'ingest daemon already healthy + healed for ' + version + ' — skipped (no re-spawn)' };
      }
    }

    const spawn = o.spawnFn || ((script) => spawnSync(process.execPath, [script], {
      cwd, env: Object.assign({}, env, { HOME: home }), encoding: 'utf8', timeout: 30000,
    }));
    // FORCED RESTART even when cls === 'ok' (v-pacing-fix delivery gap): `git
    // pull` above already landed new companion/ content at the stable
    // ExecStart path, but the ingest daemon's main loop
    // (runIngestLoop's maxIterations:Infinity) only re-execs on a CRASH — it
    // never notices new content on disk on its own. Re-running the installer is
    // SAFE and idempotent (install-devswarm-ingest.js documents it: "reinstalling
    // rewrites the unit and RELAUNCHES so the running daemon picks up this
    // build's code — launchctl unload+load on macOS / systemd restart on
    // Linux") and update only runs on a real version bump (never per-turn), so
    // forcing it here — unlike doctor's install-shape-driven repair, which only
    // reinstalls when cls !== 'ok' — is the ONE place that is always safe and
    // always warranted: an update JUST changed the code on disk.
    spawn(installerPath);
    const after = bestUnit();
    const cls2 = classifyIngestUnit({ workingDir: after.workingDir, scriptPath: after.scriptPath, home, env });
    if (version && cls2 === 'ok') {
      const s = readSweepState(home);
      writeSweepState(home, Object.assign({}, s, { ingestHeal: { healedVersion: version, healedTs: Date.now() } }));
    }
    return {
      attempted: true,
      healed: cls2 === 'ok',
      detail: cls2 === 'ok'
        ? (cls === 'ok'
            ? 'ingest daemon restarted so the running process picks up this build — WorkingDirectory ' + after.workingDir
            : 're-installed the ingest daemon (was ' + cls + ') — WorkingDirectory now ' + after.workingDir)
        : 'ingest daemon still ' + cls2 + ' after re-install attempt',
    };
  } catch (e) {
    return { attempted: false, healed: false, detail: 'ingest heal raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------------------------------------------------------------------------
// Reconcile heal (post-update) — v0.58.0 shipped `node scripts/devswarm.js
// reconcile` as a MANUAL-only verb; wired here so `update` drains it too.
// ---------------------------------------------------------------------------

/**
 * reconcilePostUpdate({ paths, env, cwd, home, devswarm }) → { attempted, count, imported, results, detail }
 *
 * Auto-runs `devswarm.js`'s `reconcile` verb (drains EVERY worktree registered
 * in the current project's shared store once, recovering messages stranded in
 * a per-worktree native hivecontrol queue that never got its own `inbox pull`
 * — e.g. a worktree torn down before it drained itself) as a post-update step,
 * so a stale queue does not require a human to remember the manual command.
 *
 * Gated the SAME DevSwarm-session-only, no-offer, no-ask posture SKILL.md step
 * 7 already documents for the supervisor/ingest-daemon installs —
 * isDevswarmActive(env) ONLY (`DEVSWARM_REPO_ID` set, i.e. an actual DevSwarm
 * session — never machine-level descriptor/registry-file presence alone; the
 * session might be running outside DevSwarm entirely). Unlike
 * healIngestDaemon above, this does NOT also require resolveWorktree(cwd): a
 * cwd that isn't a resolvable git project is already handled harmlessly by
 * devswarm.js's own cmdReconcile, which reports `{ok:false, reason:'no-project'}`
 * and mutates nothing rather than needing a duplicate pre-check here.
 *
 * Safe to auto-run (see doctor-repair.js's mirrored GATED reconcile repair for
 * the full verification): idempotent (devswarm-pull.js's pullOnce dedupes by
 * content hash — a re-run imports 0 new messages), lock-respecting (a
 * worktree a live child is already draining is skipped via the per-id O_EXCL
 * pull lock, never raced), and loss-free (a short-received batch fails loud
 * with a `lost` field rather than silently dropping messages — drained
 * messages land in the shared store, never a throwaway).
 *
 * Fully fail-open: ANY error is reported in `detail` and NEVER thrown — a
 * reconcile failure must never fail the update itself.
 */
function reconcilePostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'reconcile skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — reconcile skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    // Wave D9: forward THIS caller's own reconcile budget (test-injectable via
    // `o.reconcileBudgetMs`) straight through to devswarm.js's cmdReconcile —
    // `ctx.reconcileBudgetMs` is the carrier (update.js never invokes reconcile
    // via a shell argv, so a `--budget-ms` CLI flag would have no natural call
    // site here). Omitted entirely when the caller didn't set one, so
    // cmdReconcile's own default (or `ANTIHALL_RECONCILE_BUDGET_MS` in `env`)
    // still applies unchanged — this is a pass-through, not a second default.
    const reconcileCtx = { cwd, env, home };
    if (o.reconcileBudgetMs !== undefined) reconcileCtx.reconcileBudgetMs = o.reconcileBudgetMs;
    const { result } = devswarm.run(['reconcile'], reconcileCtx);
    if (!result || !result.ok) {
      // P1 fix: a reconcile that LOST messages (real shortfall — distinct
      // from a benign `locked` contention skip) must surface the loss count
      // rather than falling through to a generic "unknown error" that reads
      // as success-adjacent. cmdReconcile now returns ok:false + a `lost`
      // total whenever ANY target reports a shortfall. Still fully
      // fail-open — this NEVER throws, and the caller never fails the
      // update itself over a reconcile outcome (see doc comment above).
      let detail;
      if (result && result.lost) {
        detail = 'reconcile LOST ' + result.lost + ' message(s) across ' + (result.count || 0) + ' worktree(s)';
      } else {
        // P2 fix (ported from doctor-repair.js's mirrored reconcile summariser):
        // cmdReconcile's returned object never carries a top-level
        // `.reason`/`.error` for a per-target-failure shape (only `.results[i]`
        // does) — a top-level `result.reason` exists ONLY for the early
        // `{ok:false, reason:'no-project'}` guard. Reading only the top level
        // discarded every real per-target cause and always printed "unknown
        // error". Surface the actual non-benign per-target errors instead —
        // benign skips (`locked`, `hivecontrolMissing`, `worktreeMissing`, the
        // same allow-list cmdReconcile itself uses for `ok`) are excluded so a
        // sweep failing ONLY on genuine causes never gets buried under skip
        // noise. Bounded to keep the line readable on a large target list.
        const MAX_LISTED = 5;
        detail = (result && result.reason) || null;
        if (!detail && result && Array.isArray(result.results)) {
          const real = result.results.filter((x) => x && !x.ok && !x.locked && !x.hivecontrolMissing && !x.worktreeMissing);
          if (real.length) {
            const shown = real.slice(0, MAX_LISTED).map((x) => x.id + ': ' + (x.error || 'unknown error'));
            const more = real.length > MAX_LISTED ? ' (+' + (real.length - MAX_LISTED) + ' more)' : '';
            detail = shown.join('; ') + more;
          }
        }
        detail = 'reconcile failed: ' + (detail || 'unknown error');
      }
      return { attempted: true, count: result && result.count, lost: result && result.lost, results: result && result.results, detail };
    }
    return {
      attempted: true,
      count: result.count,
      imported: result.imported,
      lost: result.lost || 0,
      results: result.results,
      detail: 'reconciled ' + result.count + ' worktree(s) — imported ' + result.imported + ' message(s) into the shared store',
    };
  } catch (e) {
    return { attempted: false, detail: 'reconcile raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * foldMeshPostUpdate({ paths, env, cwd, home, devswarm }) → { attempted, retired, forwarded, folded, left, detail }
 *
 * #70 migration: fold ALL prior mesh forms an OLD store accumulated (phantom rows,
 * dual/legacy pairs, subdir-splits) into one canonical survivor per worktree — the
 * dedup the drain-only `reconcile` above never does. Runs ONCE per repo in the same
 * post-update pass, immediately after reconcile (drain first so a stranded queue's
 * messages exist to be forwarded, then fold). Same DevSwarm-session-only gate as
 * reconcilePostUpdate; idempotent (a re-run tombstones nothing left) and fully
 * fail-open (never throws — a fold outcome must NEVER fail the update itself).
 */
function foldMeshPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'fold skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — fold skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.foldMeshDuplicates !== 'function') {
      return { attempted: false, detail: 'fold skipped: this devswarm.js build has no foldMeshDuplicates' };
    }
    const r = devswarm.foldMeshDuplicates(home, { cwd, env }) || {};
    const retired = Array.isArray(r.retired) ? r.retired.length : 0;
    const left = Array.isArray(r.left) ? r.left.length : 0;
    const rekeyed = Number.isFinite(r.rekeyed) ? r.rekeyed : 0; // P1b: subdir rows re-keyed to their toplevel
    return {
      attempted: true,
      retired,
      forwarded: r.forwarded || 0,
      folded: r.folded || 0,
      left,
      rekeyed,
      detail: 'folded ' + retired + ' duplicate mesh row(s) into their canonical survivor'
        + (r.forwarded ? ' (forwarded ' + r.forwarded + ' message(s))' : '')
        + (rekeyed ? ' — re-keyed ' + rekeyed + ' subdir row(s) to their toplevel' : '')
        + (left ? ' — ' + left + ' descriptor-backed row(s) left in place' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'fold raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * foldArchivedRowsPostUpdate({ paths, env, cwd, home, devswarm }) →
 *   { attempted, retired, forwarded, left, detail }
 *
 * Forward-migration for registries ALREADY split by the archive bug: cmdArchive
 * used to tombstone exactly ONE registry row per archive, while up to four rows
 * (builder UUID / spawn phantom / legacy ingested / subdir-derived) can exist for
 * ONE worktree — so every surviving row kept an ARCHIVED workspace projecting as
 * active. This sweeps every per-project store for rows belonging to a genuinely
 * archived workspace and applies the same forward-then-tombstone + safety gate
 * cmdArchive now applies at archive time (devswarm.js foldArchivedRegistryRows —
 * this wrapper adds no decision logic of its own).
 *
 * Runs AFTER foldMeshPostUpdate: fold first collapses same-worktree duplicates
 * into ONE canonical survivor per worktree, so this pass usually has a single row
 * left to retire per archived workspace instead of racing the same rows from the
 * other direction. Both are idempotent, so the order is about doing less work, not
 * correctness. Same DevSwarm-session-only gate + fully fail-open posture as
 * reconcile/fold/ownerKeyMigrate; NEVER throws, never affects the update's own
 * success. NO-DELETE (message rows are forwarded, never deleted) and idempotent (a
 * re-run finds no row left for any archived id).
 */
/**
 * promoteUnclaimedPostUpdate({ paths, env, cwd, home, devswarm }) →
 *   { attempted, promoted, left, errors, detail }
 *
 * FORWARD MIGRATION for the persisted `unclaimed:<id>` sessionId shape (carry-out
 * (e), v0.90.0). `inbox pull` stamps that synthetic marker when no real session
 * claimed the row; from this build on, any read/pull by a real session promotes it
 * in place — but rows stamped by an OLDER build only get promoted if something
 * happens to read them again, and a row nothing reads is exactly the one whose
 * false "not live" reading does the damage (a `send` routed elsewhere, a sweep
 * classing it abandoned).
 *
 * This sweep promotes ONLY rows with an INDEPENDENT, POSITIVE source of the real
 * session id (a heartbeat file recording one). Everything else is LEFT EXACTLY AS
 * IT IS — never deleted, never guessed. Idempotent (a re-run finds no marker left
 * on any promoted row), fail-open, and gated on the same DevSwarm-session check as
 * every other post-update step; it never affects the update's own success.
 */
function promoteUnclaimedPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'promote-unclaimed skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — promote-unclaimed skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.promoteUnclaimedRegistrySessions !== 'function') {
      return { attempted: false, detail: 'promote-unclaimed skipped: this devswarm.js build has no promoteUnclaimedRegistrySessions' };
    }
    const r = devswarm.promoteUnclaimedRegistrySessions(home, { cwd, env }) || {};
    const promoted = Array.isArray(r.promoted) ? r.promoted.length : 0;
    const left = Array.isArray(r.left) ? r.left.length : 0;
    return {
      attempted: true,
      promoted,
      left,
      errors: r.errors || 0,
      ok: r.ok !== false,
      detail: 'promote-unclaimed: promoted ' + promoted + ' unclaimed workspace session id(s)'
        + (left ? ' — ' + left + ' left as is (no known session)' : ''),
    };
  } catch (e) {
    return { attempted: false, errors: 1, ok: false, detail: 'promote-unclaimed failed (non-fatal): ' + String((e && e.message) || e) };
  }
}

function foldArchivedRowsPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'fold-archived-rows skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — fold-archived-rows skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.foldArchivedRegistryRows !== 'function') {
      return { attempted: false, detail: 'fold-archived-rows skipped: this devswarm.js build has no foldArchivedRegistryRows' };
    }
    // BUDGET (D11-C, defect e7307778b614): this migration is O(archived ids ×
    // store buckets) and previously ran with NO deadline of its own — the
    // stage that field evidence showed never finishing before update.js's own
    // run was killed at a 300s ceiling. `o.deadline` (an absolute ms
    // timestamp) is threaded through from runUpdate's overall post-pull
    // budget when provided; falling back to a fresh
    // now+sweepBudgetMs(env) window keeps a direct/test call (no caller-
    // supplied deadline) behaved exactly as every other throttled sweep in
    // this file. Both devswarm.js-side migrations persist their OWN resume
    // marker (fold-archived-resume.json / fold-archived-family-resume.json),
    // so a deferred pass is picked back up automatically next call — nothing
    // here needs its own resume state.
    const nowFn = o.now || Date.now;
    const ownDefaultDeadline = nowFn() + sweepBudgetMs(env);
    const deadline = Number.isFinite(o.deadline)
      ? o.deadline
      : (Number.isFinite(o.postPullDeadline) ? Math.min(ownDefaultDeadline, o.postPullDeadline) : ownDefaultDeadline);
    const r = devswarm.foldArchivedRegistryRows(home, { cwd, env, deadline }) || {};
    // Descriptor half of the SAME defect (see devswarm.js
    // foldArchivedFamilyDescriptors): an archived workspace's cross-linked twin
    // DESCRIPTOR stayed live in `workspaces/` and kept the parent gate nagging
    // unclearably. Folded into this same pass rather than given its own post-update
    // step: both are idempotent, fail-open, NO-DELETE archive-cleanup migrations
    // gated on the same DevSwarm-session check, and reporting them together keeps
    // the update's output honest about everything the archive fix repaired.
    //
    // REPORT THE REFUSALS, NOT JUST THE WINS (P2). This pass can decline to
    // retire a twin — a tombstone holding different bytes, a lock-busy id, a
    // descriptor that changed since the scan, or (the migration gate) a twin
    // whose worktree is still there. Those land in `left`, and a run that raised
    // reports ok:false. Folding only `retired.length` into the result made every
    // one of those look like a clean "0 to migrate" no-op — the exact
    // success-while-dropping-part-of-the-job shape docs/KB-devswarm-hivecontrol.md
    // §28 names as the worst failure mode for a safety refusal. Propagated using
    // the SAME retired/left/errors contract the registry fold above already uses.
    let famRetired = 0;
    let famLeft = 0;
    let famErrors = 0;
    let famOk = true;
    if (typeof devswarm.foldArchivedFamilyDescriptors === 'function') {
      try {
        const fr = devswarm.foldArchivedFamilyDescriptors(home, { cwd, env, deadline }) || {};
        famRetired = Array.isArray(fr.retired) ? fr.retired.length : 0;
        famLeft = Array.isArray(fr.left) ? fr.left.length : 0;
        famErrors = fr.errors || 0;
        famOk = fr.ok !== false;
      } catch (_) {
        // fail-open for the update's own success, but NEVER silent: a raise is an
        // error the caller must see.
        famOk = false;
        famErrors += 1;
      }
    }
    const retired = Array.isArray(r.retired) ? r.retired.length : 0;
    const left = Array.isArray(r.left) ? r.left.length : 0;
    const budgetExhausted = !!(r.budgetExhausted);
    const skipped = (r.skipped || 0);
    return {
      attempted: true,
      retired,
      forwarded: r.forwarded || 0,
      left,
      errors: r.errors || 0,
      familyDescriptorsRetired: famRetired,
      familyDescriptorsLeft: famLeft,
      familyDescriptorsErrors: famErrors,
      familyDescriptorsOk: famOk,
      budgetExhausted,
      skipped,
      detail: 'fold-archived-rows: retired ' + retired + ' registry row(s) of archived workspace(s)'
        + (famRetired ? ' + ' + famRetired + ' orphaned twin descriptor(s)' : '')
        + (r.forwarded ? ' (forwarded ' + r.forwarded + ' message(s))' : '')
        + (left ? ' — ' + left + ' row(s) left in place (safety-gated)' : '')
        + (famLeft ? ' — ' + famLeft + ' twin descriptor(s) left in place (safety-gated)' : '')
        + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : '')
        + (famErrors ? ' (' + famErrors + ' twin-descriptor error(s), fail-open)' : '')
        + (famOk ? '' : ' (twin-descriptor pass did NOT complete cleanly)')
        + (budgetExhausted ? ' (budget hit — ' + skipped + ' pending next run)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'fold-archived-rows raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * reRetireResurrectedPostUpdate({ paths, env, cwd, home, devswarm, version }) →
 *   { attempted, candidates, reRetired, forwarded, skippedLive, errors, detail }
 *
 * Item 6, defect df54edf54804 field aftermath (SkyCrew, 2026-09-08): the store
 * migration's resurrection bug (fixed above via companion/lib/
 * devswarm-archive-gate.js) left already-upgraded installs holding registry
 * rows for a whole retired worktree-group family (~43 legacy-slug rows
 * measured on one install). The gate prevents this going forward; this step
 * restores pre-migration state on installs that already ran the buggy
 * migration once — devswarm.js's reRetireResurrectedRowsAllStores forwards
 * any unread mail into a same-worktree archived id, then removes ONLY the
 * registry row (never a file), for any row that is (a) descriptor-less or
 * worktree-group-matched to an archived marker AND (b) NOT live by
 * isSiblingPartitionLive — see that function's own header for the full
 * mechanism and why it is deliberately stricter than, and not a duplicate
 * of, fold-archived-rows above.
 *
 * RESTORING pre-migration state is not a data-deletion risk in the sense the
 * rest of this file reserves for gated/opt-in repairs, so — like
 * cursor-hygiene below, which this shares its per-version-stamp shape with —
 * it runs UNCONDITIONALLY on every update for a DevSwarm-active session
 * (never gated behind doctor's separate `--repair` flag), stamped complete
 * for `version` so a clean install never re-scans for nothing to do.
 * IDEMPOTENT, FAIL-OPEN, NO-DELETE-OF-FILES.
 */
function reRetireResurrectedPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 're-retire-resurrected skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — re-retire-resurrected skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.reRetireResurrectedRowsAllStores !== 'function') {
      return { attempted: false, detail: 're-retire-resurrected skipped: this devswarm.js build has no reRetireResurrectedRowsAllStores' };
    }
    const version = o.version || null;
    const sweepState = readSweepState(home);
    if (version && sweepState.reRetireResurrected && sweepState.reRetireResurrected.completedVersion === version) {
      return {
        attempted: true, candidates: 0, unhealable: 0, errors: 0, skippedAlreadyDone: true,
        detail: 're-retire-resurrected: report already shown for ' + version + ' — skipped (one-time per-version report)',
      };
    }
    // REPORT-ONLY (owner decision, R2): removal is HUMAN-INITIATED only, via
    // the existing doctor `--repair` flag — same posture as
    // `--repair-ingest-orphans`/`--repair-test-stores`. update.js NEVER calls
    // reRetireResurrectedRowsAllStores without dryRun:true; it only detects
    // and tells the operator what to run. The per-version stamp still
    // applies here so the report prints once per version, not every update.
    const r = devswarm.reRetireResurrectedRowsAllStores(home, { cwd, env, dryRun: true }) || {};
    const errCount = r.errors || 0;
    if (version && !errCount) {
      writeSweepState(home, Object.assign({}, sweepState, {
        reRetireResurrected: { completedVersion: version, completedTs: Date.now() },
      }));
    }
    const n = r.candidates || 0;
    return {
      attempted: true,
      candidates: n, unhealable: r.unhealable || 0, errors: errCount,
      detail: n > 0
        ? ('re-retire-resurrected: ' + n + ' resurrected registry row(s) found — run `doctor --repair-resurrected --apply` to re-retire them'
          + (r.unhealable ? '; ' + r.unhealable + ' additional row(s) need manual review (no safe forward target)' : '')
          + (errCount ? ' (' + errCount + ' error(s) during detection, fail-open)' : ''))
        : ('re-retire-resurrected: nothing to report'
          + (r.unhealable ? ' — ' + r.unhealable + ' row(s) need manual review (no safe forward target)' : '')),
    };
  } catch (e) {
    return { attempted: false, detail: 're-retire-resurrected raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * ownerKeyMigratePostUpdate({ paths, env, cwd, home, devswarm }) →
 *   { attempted, scanned, backfilled, rehomed, errors, detail }
 *
 * P1-8 persisted-shape forward-migration for the new `ownerKey` descriptor field.
 * Backfills ownerKey on every existing descriptor (active AND archived) and heals
 * prior hash-bucket split-brain via re-home. Runs on EVERY update (not gated on
 * cache.synced — an existing store predates the field regardless of whether the
 * plugin changed version this run). Same DevSwarm-session-only gate + fully
 * fail-open posture as fold/reconcile; NEVER throws, never affects the update's
 * own success. Idempotent (a re-run backfills/re-homes nothing).
 */
function ownerKeyMigratePostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'ownerKey migrate skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — ownerKey migrate skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.migrateOwnerKeys !== 'function') {
      return { attempted: false, detail: 'ownerKey migrate skipped: this devswarm.js build has no migrateOwnerKeys' };
    }

    // Run-once-per-version stamp (spec item 3): migrateOwnerKeys does its own
    // full descriptor-directory walk (workspaces/ + archived/) — a THIRD full
    // traversal alongside the two store-hash sweeps above, on EVERY update
    // regardless of whether anything changed. It keeps that walk (its own
    // enumeration is a directory listing, not the store-hash sweep the other
    // two share), but a completed pass for a given version needs no repeat —
    // this is a one-time forward-migration per version, not steady-state work.
    const version = o.version || null;
    const sweepState = readSweepState(home);
    if (version && sweepState.ownerKeyMigrate && sweepState.ownerKeyMigrate.completedVersion === version) {
      return {
        attempted: true, scanned: 0, backfilled: 0, rehomed: 0, errors: 0,
        skippedAlreadyDone: true,
        detail: 'ownerKey migrate: already completed for ' + version + ' — skipped (one-time per-version migration)',
      };
    }

    const r = devswarm.migrateOwnerKeys(home, { env, cwd }) || {};
    // Stamp ONLY a clean pass: a run with per-descriptor errors (r.errors > 0)
    // skipped real work, and stamping it would skip those descriptors' one-time
    // migration forever at this version — leave it unstamped so the next run
    // (or doctor) retries; that is exactly the pre-stamp behavior.
    if (version && !(r.errors > 0)) {
      writeSweepState(home, Object.assign({}, sweepState, {
        ownerKeyMigrate: { completedVersion: version, completedTs: Date.now() },
      }));
    }
    return {
      attempted: true,
      scanned: r.scanned || 0,
      backfilled: r.backfilled || 0,
      rehomed: r.rehomed || 0,
      errors: r.errors || 0,
      detail: 'ownerKey migrate: scanned ' + (r.scanned || 0) + ', backfilled ' + (r.backfilled || 0)
        + ', re-homed ' + (r.rehomed || 0) + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'ownerKey migrate raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * cursorHygienePostUpdate({ paths, env, cwd, home, devswarm, version }) →
 *   { attempted, scanned, deleted, evicted, kept, errors, detail }
 *
 * defect 8b211241bbe9 — persisted-shape forward migration for per-instance
 * cursors (`cursors/<id>#inst-<short6>.json`, `cursors/<id>#nd-<short6>.json`
 * and `cursors/<id>#base.json`).
 *
 * Correctness needs NO migration: an absent instance file reads as the
 * loss-free baseline, which is itself seeded from the pre-fix
 * `max(cursors/<id>.json, store cursor)` on first touch, so every pre-0.99
 * installation resumes exactly where it left off. What IS needed is bounded
 * hygiene — without it a dead instance's file pins the shared floor forever and
 * every consumer reading that value goes stale.
 *
 * IDEMPOTENT (running it twice leaves the tree identical), FAIL-OPEN (never
 * throws into the update, a missing cursors/ dir is a no-op), NO-DELETE of
 * anything this code could not have written (an unparseable name is skipped,
 * never guessed at), and ALL PRIOR FORMS are readable (a bare integer and
 * `{line:n}` are both handled by the inbox-cursor primitive). Same one-time
 * per-version stamp + gate posture as ownerKeyMigratePostUpdate above.
 */
function cursorHygienePostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath)) {
      return { attempted: false, detail: 'cursor hygiene skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — cursor hygiene skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.gcInstanceCursors !== 'function') {
      return { attempted: false, detail: 'cursor hygiene skipped: this devswarm.js build has no gcInstanceCursors' };
    }
    const version = o.version || null;
    const sweepState = readSweepState(home);
    if (version && sweepState.cursorHygiene && sweepState.cursorHygiene.completedVersion === version) {
      return {
        attempted: true, scanned: 0, deleted: 0, evicted: 0, kept: 0, errors: 0, skippedAlreadyDone: true,
        detail: 'cursor hygiene: already completed for ' + version + ' — skipped (one-time per-version migration)',
      };
    }
    const r = devswarm.gcInstanceCursors(null, home, { env, cwd }) || {};
    const errCount = Array.isArray(r.errors) ? r.errors.length : (r.errors || 0);
    if (version && !errCount) {
      writeSweepState(home, Object.assign({}, sweepState, {
        cursorHygiene: { completedVersion: version, completedTs: Date.now() },
      }));
    }
    return {
      attempted: true,
      scanned: r.scanned || 0, deleted: r.deleted || 0, evicted: r.evicted || 0,
      kept: r.kept || 0, errors: errCount,
      detail: 'cursor hygiene: scanned ' + (r.scanned || 0) + ', removed ' + (r.deleted || 0)
        + ', evicted ' + (r.evicted || 0) + ', kept ' + (r.kept || 0)
        + (errCount ? ' (' + errCount + ' error(s), fail-open)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'cursor hygiene raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * replyStateMigratePostUpdate({ paths, env, cwd, home }) →
 *   { attempted, scanned, migrated, alreadyAppendOnly, errors, detail }
 *
 * Task #4 persisted-shape forward-migration: normalize every parent-gate
 * reply-state file (~/.anti-hall/devswarm/parent-gate/*-replies.json) from the
 * legacy single-merged-object shape to the new append-only JSONL shape. Pure
 * per-user-file fold+rewrite via migrate-state.js's migrateReplyState (which
 * delegates to devswarm-reply-state.js) — no store open, no daemon/scheduler
 * side effect. Runs on EVERY update (not gated on cache.synced — an existing
 * reply-state file predates the new shape regardless of whether the plugin
 * changed version this run). Same DevSwarm-session-only gate + fully
 * fail-open posture as fold/reconcile/ownerKeyMigrate above; NEVER throws,
 * never affects the update's own success. Idempotent (an already-append-only
 * file is detected and skipped); NEAR-lossless with one documented, bounded
 * residual — devswarm-reply-state.js's own header (see its foldAndRewrite)
 * discloses that a live append landing in the tiny window AFTER this
 * migration's re-read but BEFORE its atomic rename is dropped by that
 * replace. That residual can only cause one redundant Stop-gate nag for the
 * affected reply, never let an unanswered question slip through the gate.
 */
function replyStateMigratePostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const migratePath = path.join(paths.pluginSrcDir, 'scripts', 'migrate-state.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(migratePath)) {
      return { attempted: false, detail: 'reply-state migrate skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — reply-state migrate skipped (gate closed)' };
    }
    const migrate = o.migrate || require(migratePath);
    if (typeof migrate.migrateReplyState !== 'function') {
      return { attempted: false, detail: 'reply-state migrate skipped: this build has no migrateReplyState' };
    }
    const r = migrate.migrateReplyState({ home }) || {};
    return {
      attempted: true,
      scanned: r.scanned || 0,
      migrated: r.migrated || 0,
      alreadyAppendOnly: r.alreadyAppendOnly || 0,
      errors: r.errors || 0,
      detail: 'reply-state migrate: scanned ' + (r.scanned || 0) + ', migrated ' + (r.migrated || 0)
        + ', already-append-only ' + (r.alreadyAppendOnly || 0)
        + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'reply-state migrate raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * gateIntentsMigratePostUpdate({ paths, env, cwd, home }) →
 *   { attempted, scanned, migrated, alreadyCurrent, errors, detail }
 *
 * devswarm-parent-gate.js stated-intent persisted-shape forward-migration:
 * normalize every existing gate-loop-state file
 * (~/.anti-hall/devswarm/parent-gate/<session>.json) to carry `intents` /
 * `intentAcks`, losslessly. Same shape as replyStateMigratePostUpdate just
 * above — pure per-user-file additive rewrite via migrate-state.js's
 * migrateGateIntents (which delegates to devswarm-gate-state.js), no store
 * open, no daemon/scheduler side effect. Same DevSwarm-session-only gate +
 * fully fail-open posture; NEVER throws, never affects the update's own
 * success. Idempotent (a file already carrying both keys is skipped
 * untouched), NO-DELETE. A courtesy normalization, not a correctness
 * prerequisite: the hook itself already defaults a missing
 * `intents`/`intentAcks` to `{}`/`0` on read.
 */
function gateIntentsMigratePostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const migratePath = path.join(paths.pluginSrcDir, 'scripts', 'migrate-state.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(migratePath)) {
      return { attempted: false, detail: 'gate-intents migrate skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — gate-intents migrate skipped (gate closed)' };
    }
    const migrate = o.migrate || require(migratePath);
    if (typeof migrate.migrateGateIntents !== 'function') {
      return { attempted: false, detail: 'gate-intents migrate skipped: this build has no migrateGateIntents' };
    }
    const r = migrate.migrateGateIntents({ home }) || {};
    return {
      attempted: true,
      scanned: r.scanned || 0,
      migrated: r.migrated || 0,
      alreadyCurrent: r.alreadyCurrent || 0,
      errors: r.errors || 0,
      detail: 'gate-intents migrate: scanned ' + (r.scanned || 0) + ', migrated ' + (r.migrated || 0)
        + ', already-current ' + (r.alreadyCurrent || 0)
        + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'gate-intents migrate raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * healRegistryPostUpdate({ paths, env, cwd, home, devswarm }) →
 *   { attempted, checked, healed, rehomed, stores, detail }
 *
 * Claim 3 self-heal forward-migration. Sweeps EVERY per-project store's
 * registry (via devswarm-store.js's listStoreHashes enumeration) for a row
 * whose descriptor's own real worktreePath disagrees with the store it is
 * physically sitting in — rehomed out (message-preserving, zero loss) — or
 * carries a stale persisted ownerKey/repoKey/registry worktree_path — healed
 * in place. This heals the real breakage class the Claim 3 fix targets: a row
 * left under the WRONG per-project store (e.g. a submodule split, or a stray
 * row left by an earlier bug/race) whose descriptor structurally belongs
 * somewhere else. Reuses devswarm.js's own exported healRegistry(home,
 * repoKey, ctx) for the ACTUAL heal decision (see rehomeMiskeyedRow's doc
 * comment for the full tree) — this wrapper only enumerates every store to
 * sweep, mirroring ownerKeyMigratePostUpdate's own enumerate-and-apply shape.
 *
 * Same DevSwarm-session-only gate + fully fail-open posture as
 * reconcile/fold/ownerKeyMigrate above: NEVER throws, never affects the
 * update's own success/failure. NO-DELETE (healRegistry's own contract never
 * deletes a message, only tombstones a row after its content is verified-
 * copied) and idempotent (a re-run heals/rehomes nothing further — proven by
 * devswarm-lifecycle.test.js's own healRegistry idempotency test; this
 * wrapper only adds enumeration, not new heal logic).
 */
function healRegistryPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    const storePath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-store.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath) || !fs.existsSync(storePath)) {
      return { attempted: false, detail: 'heal-registry-rows skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — heal-registry-rows skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.healRegistry !== 'function') {
      return { attempted: false, detail: 'heal-registry-rows skipped: this devswarm.js build has no healRegistry' };
    }
    const devstore = o.devswarmStore || require(storePath);

    const version = o.version || null;
    const sweepState = readSweepState(home);
    const sel = sweepItemsFor(sweepState, 'healRegistry', version, () => {
      if (Array.isArray(o.hashes)) return o.hashes.slice();
      try { return devstore.listStoreHashes(home) || []; } catch (_) { return []; }
    });
    if (sel.skip) {
      return {
        attempted: true, checked: 0, healed: 0, rehomed: 0, stores: [],
        skippedAlreadyDone: true,
        detail: 'heal-registry-rows: already completed for ' + version + ' — skipped (one-time per-version migration)',
      };
    }

    let checked = 0, healed = 0, rehomed = 0, errors = 0;
    const stores = [];
    const sweep = runThrottledSweep({
      items: sel.items,
      budgetMs: sweepBudgetMs(env),
      worker: (repoKey) => {
        let r = null;
        // healRegistry itself always returns an object (internal store errors
        // fail open to empty rows) — a null here means it THREW at this level.
        try { r = devswarm.healRegistry(home, repoKey, { cwd, env }); } catch (_) { r = null; }
        if (!r) { errors++; return null; }
        checked += r.checked || 0;
        healed += r.healed || 0;
        rehomed += r.rehomed || 0;
        const rowIds = (r.rows || [])
          .filter((row) => row && (row.healedDescriptor || row.healedRegistryPath || row.rehomed))
          .map((row) => (row.id == null ? '?' : row.id));
        if (rowIds.length) stores.push({ repoKey, rows: rowIds });
        return r;
      },
    });
    // clean:false on any per-store throw — same no-stamp-over-skipped-work
    // rationale as foldAllStoresPostUpdate above.
    recordSweepResult(home, sweepState, 'healRegistry', version, sweep, { clean: errors === 0 });

    return {
      attempted: true,
      checked, healed, rehomed, errors, stores,
      budgetExhausted: sweep.budgetExhausted,
      pending: sweep.remaining.length,
      detail: (healed === 0 && rehomed === 0
        ? 'checked ' + checked + ' registry row(s) across ' + sweep.processedItems.length + ' store(s) — nothing mis-keyed/stale'
        : 'healed ' + healed + ' + rehomed ' + rehomed + ' of ' + checked + ' registry row(s) across ' + sweep.processedItems.length + ' store(s)')
        + (sweep.budgetExhausted ? ' (budget hit — ' + sweep.remaining.length + ' store(s) pending next run)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'heal-registry-rows raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * foldAllStoresPostUpdate({ paths, env, cwd, home, devswarm }) →
 *   { attempted, stores, retired, forwarded, folded, errors, detail }
 *
 * Spec item 5c / [E] UPDATE-TIME SELF-HEAL. `foldMeshPostUpdate` above only
 * folds the ONE project the update was run FROM (foldMeshDuplicates resolves
 * repoKey from cwd) — an already-split registry sitting in a DIFFERENT
 * project's store on this same machine is never reached just because the
 * operator happened to run `/anti-hall:update` from project A instead of B
 * (the exact gap the SkyCrew field report's live store inspection surfaced:
 * the split was found by direct store inspection, not by update reaching it).
 * This sweeps EVERY store this machine has ever opened (devswarm.js's
 * foldMeshDuplicatesAllStores — same store.listStoreHashes(home) enumeration
 * healRegistryPostUpdate already uses) so an existing install self-heals
 * regardless of which project triggered the update. Deliberately AFTER
 * foldMeshPostUpdate (redundant-but-harmless overlap on the cwd project;
 * idempotent either way) and BEFORE foldArchivedRowsPostUpdate, mirroring the
 * existing fold -> foldArchivedRows ordering rationale (fold first collapses
 * duplicates so the archived-row sweep typically sees one row per workspace).
 * Same DevSwarm-session-only gate + fully fail-open posture as its siblings;
 * NEVER throws, never affects the update's own success. NO-DELETE (forward-
 * before-tombstone, same primitive as foldMeshDuplicates) and idempotent (a
 * re-run finds no store-only duplicate left to retire in any store).
 */
// Throttled/resumable/one-time-per-version refactor (spec items 1-3): rather
// than delegating to devswarm.foldMeshDuplicatesAllStores' own single
// unthrottled internal loop, this calls the SAME per-store primitive
// (devswarm.foldMeshDuplicates with a repoKey override — exactly what
// foldMeshDuplicatesAllStores uses under the hood) directly, one hash at a
// time, through runThrottledSweep. `foldMeshDuplicatesAllStores` itself is
// left untouched (still exported, still usable un-throttled by any future
// CLI/doctor caller) — only THIS post-update wiring changes.
function foldAllStoresPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    const storePath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-store.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath) || !fs.existsSync(storePath)) {
      return { attempted: false, detail: 'fold-all-stores skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — fold-all-stores skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.foldMeshDuplicates !== 'function') {
      return { attempted: false, detail: 'fold-all-stores skipped: this devswarm.js build has no foldMeshDuplicates' };
    }
    const devstore = o.devswarmStore || require(storePath);

    const version = o.version || null;
    const sweepState = readSweepState(home);
    const sel = sweepItemsFor(sweepState, 'foldAllStores', version, () => {
      if (Array.isArray(o.hashes)) return o.hashes.slice();
      try { return devstore.listStoreHashes(home) || []; } catch (_) { return []; }
    });
    if (sel.skip) {
      return {
        attempted: true, stores: 0, retired: 0, forwarded: 0, folded: 0, errors: 0,
        skippedAlreadyDone: true,
        detail: 'fold-all-stores: already completed for ' + version + ' — skipped (one-time per-version migration)',
      };
    }

    let retired = 0, forwarded = 0, folded = 0, errors = 0;
    // Per-repoKey deadline for devswarm.foldMeshDuplicates' own mesh-id group
    // loop (D11-C, defect e7307778b614: that loop previously had NO budget of
    // its own and could run to full completion regardless of THIS sweep's
    // own budget). SAME lazy-computed-on-first-worker-call pattern
    // healOrphanPartitionsPostUpdate already uses below, so it lines up with
    // the SAME clock runThrottledSweep uses to decide when to stop.
    const nowFn = o.now || Date.now;
    let deadline = null;
    const sweep = runThrottledSweep({
      items: sel.items,
      budgetMs: sweepBudgetMs(env),
      worker: (repoKey) => {
        // Capped by the OVERALL post-pull budget (D11-C) when the caller
        // supplies one (runUpdate's postPullDeadline) — never lets THIS
        // stage's own fresh sweepBudgetMs window outlive the whole run's
        // ceiling.
        if (deadline === null) deadline = Number.isFinite(o.postPullDeadline) ? Math.min(nowFn() + sweepBudgetMs(env), o.postPullDeadline) : nowFn() + sweepBudgetMs(env);
        let r = null;
        try { r = devswarm.foldMeshDuplicates(home, { cwd, env, repoKey, deadline }); }
        catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
        if (!r || r.ok === false) { errors++; return r; }
        retired += Array.isArray(r.retired) ? r.retired.length : 0;
        forwarded += r.forwarded || 0;
        folded += r.folded || 0;
        return r;
      },
    });
    // clean:false on any per-store error — a drained-but-errored pass must NOT
    // stamp completion (the errored store's one-time migration would be skipped
    // forever at this version); next run re-enumerates in full instead.
    recordSweepResult(home, sweepState, 'foldAllStores', version, sweep, { clean: errors === 0 });

    return {
      attempted: true,
      stores: sweep.processedItems.length,
      retired, forwarded, folded, errors,
      budgetExhausted: sweep.budgetExhausted,
      pending: sweep.remaining.length,
      detail: 'fold-all-stores: folded ' + retired + ' duplicate mesh row(s) into their canonical'
        + ' survivor across ' + sweep.processedItems.length + ' store(s)'
        + (forwarded ? ' (forwarded ' + forwarded + ' message(s))' : '')
        + (errors ? ' (' + errors + ' store error(s), fail-open)' : '')
        + (sweep.budgetExhausted ? ' (budget hit — ' + sweep.remaining.length + ' store(s) pending next run)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'fold-all-stores raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * healOrphanPartitionsPostUpdate({ paths, env, cwd, home, devswarm, hashes, version }) →
 *   { attempted, stores, adopted, forwarded, unhealable, skipped, errors, detail }
 *
 * self-heal for a partition with real messages but NO registry row — structurally
 * invisible to every fold path (foldMeshDuplicates groups s.listRegistry(), so an
 * unregistered id is never a candidate/survivor/forward target). deriveSummary's
 * `orphans[]` already DETECTS this shape read-only; this is the heal, wired the
 * same throttled/resumable/one-time-per-version way as foldAllStoresPostUpdate
 * above (modeled on it line-for-line): same isDevswarmActive gate, same
 * runThrottledSweep + sweepItemsFor/recordSweepResult resumable budget, same
 * run-once-per-version stamp (keyed 'healOrphanPartitions'), same shared
 * `hashes`/`sharedStoreHashes` reuse from the caller. Deliberately run AFTER
 * foldAllStoresPostUpdate (duplicates collapse to one canonical survivor per
 * worktree FIRST, so an adopted orphan forwards into an already-canonical group)
 * and BEFORE foldArchivedRowsPostUpdate. Same gate + fail-open posture as every
 * other post-update self-heal here; never affects the update's own success.
 * NO-DELETE: healOrphanPartitions only ever calls s.upsertRegistry (additive) and
 * forwards via appendMeshRow (append-only) — never removeRegistryIf.
 */
function healOrphanPartitionsPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const devswarmPath = path.join(paths.pluginSrcDir, 'scripts', 'devswarm.js');
    const storePath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-store.js');
    if (!fs.existsSync(detectPath) || !fs.existsSync(devswarmPath) || !fs.existsSync(storePath)) {
      return { attempted: false, detail: 'heal-orphan-partitions skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, detail: 'not a DevSwarm session — heal-orphan-partitions skipped (gate closed)' };
    }
    const devswarm = o.devswarm || require(devswarmPath);
    if (typeof devswarm.healOrphanPartitions !== 'function') {
      return { attempted: false, detail: 'heal-orphan-partitions skipped: this devswarm.js build has no healOrphanPartitions' };
    }
    const devstore = o.devswarmStore || require(storePath);

    const version = o.version || null;
    const sweepState = readSweepState(home);
    const sel = sweepItemsFor(sweepState, 'healOrphanPartitions', version, () => {
      if (Array.isArray(o.hashes)) return o.hashes.slice();
      try { return devstore.listStoreHashes(home) || []; } catch (_) { return []; }
    });
    if (sel.skip) {
      return {
        attempted: true, stores: 0, adopted: 0, forwarded: 0, unhealable: 0, skipped: 0, errors: 0,
        unhealableSample: [],
        skippedAlreadyDone: true,
        detail: 'heal-orphan-partitions: already completed for ' + version + ' — skipped (one-time per-version migration)',
      };
    }

    let adopted = 0, forwarded = 0, unhealable = 0, skipped = 0, errors = 0;
    // UNHEALABLE VISIBILITY (defect fix): the count alone gives a user no way
    // to know WHICH store/id is stuck or what to do about it. Collect a
    // BOUNDED sample of {repoKey, id} pairs from each store's own r.detail
    // (already carries {id, action:'unhealable', reason:'no-descriptor'|
    // 'wrong-store'|'archived-no-family'|'archived-no-survivor'}) — capped so
    // this can never dump the full 75-of-242 field-observed count into a hook
    // payload (10k-char cap + spill-to-file convention: this stays a short
    // sample, not a dump). Same shape convention as healRegistryPostUpdate's
    // `stores` array above.
    const UNHEALABLE_SAMPLE_CAP = 20;
    const unhealableSample = [];
    const nowFn = o.now || Date.now;
    // Per-id deadline for devswarm.healOrphanPartitions' own no-descriptor
    // bucket (see its doc comment): the SAME overall sweep budget this
    // throttled pass already uses, so a store whose orphans are mostly
    // "unhealable, forever" (re-derived fresh every pass, by design — never
    // persisted/blacklisted) cannot burn the remaining budget on ids that can
    // never produce a write, at the expense of real adopt/forward work in
    // THIS or a later store. Computed LAZILY on the first worker call (not
    // before runThrottledSweep runs) so it never consumes a `now()` tick
    // ahead of runThrottledSweep's own budget clock — this must line up with
    // the SAME clock runThrottledSweep uses to decide when to stop.
    let deadline = null;
    const sweep = runThrottledSweep({
      items: sel.items,
      budgetMs: sweepBudgetMs(env),
      worker: (repoKey) => {
        // Capped by the OVERALL post-pull budget (D11-C) when the caller
        // supplies one (runUpdate's postPullDeadline) — never lets THIS
        // stage's own fresh sweepBudgetMs window outlive the whole run's
        // ceiling.
        if (deadline === null) deadline = Number.isFinite(o.postPullDeadline) ? Math.min(nowFn() + sweepBudgetMs(env), o.postPullDeadline) : nowFn() + sweepBudgetMs(env);
        let r = null;
        try { r = devswarm.healOrphanPartitions(home, { cwd, env, repoKey, deadline }); }
        catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
        if (!r || r.ok === false) { errors++; return r; }
        adopted += r.adopted || 0;
        forwarded += r.forwarded || 0;
        unhealable += r.unhealable || 0;
        skipped += r.skipped || 0;
        errors += r.errors || 0;
        if (unhealableSample.length < UNHEALABLE_SAMPLE_CAP && Array.isArray(r.detail)) {
          for (const d of r.detail) {
            if (unhealableSample.length >= UNHEALABLE_SAMPLE_CAP) break;
            if (d && d.action === 'unhealable') {
              unhealableSample.push({ repoKey, id: d.id, reason: d.reason || null });
            }
          }
        }
        return r;
      },
    });
    // clean:false on any per-store error — a drained-but-errored pass must NOT
    // stamp completion (the errored store's one-time migration would be skipped
    // forever at this version); next run re-enumerates in full instead.
    recordSweepResult(home, sweepState, 'healOrphanPartitions', version, sweep, { clean: errors === 0 });

    return {
      attempted: true,
      stores: sweep.processedItems.length,
      adopted, forwarded, unhealable, skipped, errors,
      unhealableSample,
      budgetExhausted: sweep.budgetExhausted,
      pending: sweep.remaining.length,
      detail: 'heal-orphan-partitions: adopted ' + adopted + ' orphan partition(s)'
        + ' across ' + sweep.processedItems.length + ' store(s)'
        + (forwarded ? ' (forwarded ' + forwarded + ' message(s))' : '')
        + (unhealable ? ' (' + unhealable + ' unhealable — no descriptor/family'
            + (unhealableSample.length
              ? '; e.g. ' + unhealableSample.slice(0, 5).map((u) => u.repoKey + '/' + u.id).join(', ')
                + (unhealable > unhealableSample.length || unhealableSample.length > 5 ? ', …' : '')
              : '')
            + ')' : '')
        + (skipped ? ' (' + skipped + ' skipped — lock-busy or budget-deferred, retried next pass)' : '')
        + (errors ? ' (' + errors + ' store error(s), fail-open)' : '')
        + (sweep.budgetExhausted ? ' (budget hit — ' + sweep.remaining.length + ' store(s) pending next run)' : ''),
    };
  } catch (e) {
    return { attempted: false, detail: 'heal-orphan-partitions raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * wakeMonitorPostUpdate({ paths, env, cwd, home }) →
 *   { attempted, shipped, live, stateDirEnsured, detail }
 *
 * Monitor-based idle-wake forward-migration companion (see
 * companion/lib/devswarm-wake-watch.js + hooks/lib/devswarm-wake.js). This is
 * a PLAIN NODE PROCESS — it has NO `Monitor` tool (that is agent-only), so it
 * must NEVER claim to have armed a watcher. What it DOES, idempotently:
 *   1. Verifies the watcher script is present in the installed/mirrored
 *      plugin dir and syntactically loads via require() in a try/catch
 *      (confirmed side-effect-free: the module's own
 *      `require.main === module` guard keeps its main() from auto-running on
 *      require).
 *   2. Ensures the watcher's persisted-state dir exists (CREATE ONLY, never
 *      deletes) — <home>/.anti-hall/devswarm/wake, via the SAME devswarmRoot()
 *      helper the watcher itself uses for its own seen-cursor file, so this
 *      can never drift from where the watcher actually looks.
 *   3. Detects whether a watcher is CURRENTLY LIVE for this identity by
 *      read-only inspection of its lock file — mirrors devswarm-pull.js's
 *      acquireExclLock holder/isAlive semantics (pid recorded in the lock
 *      JSON, liveness via process.kill(pid, 0)) WITHOUT ever acquiring,
 *      stealing, or deleting that lock.
 *   4. When not live, returns the exact manual arm command (the `Monitor`
 *      tool invocation) in `detail` — never a fake auto-fix, since no
 *      hook/CLI can call an agent-only tool.
 *
 * Same DevSwarm-session-only gate + fully fail-open posture as
 * reconcile/fold/ownerKeyMigrate/healRegistryRows above: NEVER throws, never
 * affects `stop` or the update's own success/failure. Idempotent — a re-run
 * reports the same shipped/live state; the only mutation (mkdirSync
 * recursive on the state dir) is itself idempotent and NO-DELETE.
 */
function wakeMonitorPostUpdate(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const watcherPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-wake-watch.js');
    if (!fs.existsSync(detectPath)) {
      return { attempted: false, shipped: false, live: false, detail: 'wake-monitor skipped: expected plugin file not found under ' + paths.pluginSrcDir };
    }
    const { isDevswarmActive } = require(detectPath);
    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, shipped: false, live: false, detail: 'not a DevSwarm session — wake-monitor skipped (gate closed)' };
    }

    // 1. shipped? — file present, require()-loadable, has the exports this
    // function itself depends on next (fail-open: a broken/missing watcher
    // must never throw, only report shipped:false).
    if (!fs.existsSync(watcherPath)) {
      return { attempted: true, shipped: false, live: false, detail: 'wake-monitor NOT shipped: watcher script missing at ' + watcherPath + ' — Monitor-based idle-wake unavailable this run (cron fallback is unaffected)' };
    }
    let watcherMod = null;
    try {
      watcherMod = require(watcherPath);
    } catch (e) {
      return { attempted: true, shipped: false, live: false, detail: 'wake-monitor NOT shipped: watcher script failed to load (' + (e && e.message ? e.message : String(e)) + ') at ' + watcherPath };
    }
    if (typeof watcherMod.resolveIdentity !== 'function' || typeof watcherMod.lockPathFor !== 'function') {
      return { attempted: true, shipped: false, live: false, detail: 'wake-monitor NOT shipped: watcher script loaded but is missing expected exports (resolveIdentity/lockPathFor)' };
    }

    // 2. ensure the watcher's state dir exists — CREATE ONLY, never delete.
    let stateDirEnsured = false;
    try {
      const livenessPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'liveness.js');
      const { devswarmRoot } = require(livenessPath);
      fs.mkdirSync(path.join(devswarmRoot(home), 'wake'), { recursive: true });
      stateDirEnsured = true;
    } catch (_) { stateDirEnsured = false; /* fail-open: reported honestly, never blocks */ }

    // 3. is a watcher currently live for THIS identity? Read-only lock
    // inspection — never acquire/steal/delete (see doc comment above).
    let identity = null;
    try { identity = watcherMod.resolveIdentity(env, cwd, {}); } catch (_) { identity = null; }
    const armCmd = 'call the `Monitor` tool with command `node ' + watcherPath + '`, persistent: true (or run that command yourself in a background terminal)';
    if (!identity) {
      return {
        attempted: true, shipped: true, live: false, stateDirEnsured,
        detail: 'wake-monitor shipped (state dir ' + (stateDirEnsured ? 'ready' : 'NOT ensured') + ') — could not resolve a DevSwarm identity for ' + cwd + ', live-check skipped. Manual arm: ' + armCmd + '.',
      };
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(watcherMod.lockPathFor(home, identity.id), 'utf8')); } catch (_) { holder = null; }
    const pid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
    let alive = false;
    if (pid !== null) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
    }
    if (alive) {
      return {
        attempted: true, shipped: true, live: true, stateDirEnsured,
        detail: 'wake-monitor shipped + LIVE — a watcher already holds the lock for ' + identity.role + ' ' + identity.id + ' (pid ' + pid + ')',
      };
    }
    return {
      attempted: true, shipped: true, live: false, stateDirEnsured,
      detail: 'wake-monitor shipped but NOT live for ' + identity.role + ' ' + identity.id + ' — arm it: ' + armCmd + '.',
    };
  } catch (e) {
    return { attempted: false, shipped: false, live: false, detail: 'wake-monitor raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------------------------------------------------------------------------
// Rollback (v0.57 mesh -> legacy per-worktree units) — PLAN-v0.57-mesh.md
// Phase 6b / D13. Documented + tested, NOT auto-run by `main()`/runUpdate.
// ---------------------------------------------------------------------------

// HEARTBEAT_STALE_MS — same 3-minute freshness window D25/Phase-7's
// `daemonHealth` uses for the live ingest daemon; duplicated locally (Phase 7's
// `companion/lib/ingest-health.js` does not exist yet — this file is disjoint
// from Phase 7 per the plan's file list) rather than importing a module that
// may not be present on an older checkout.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/**
 * readLegacyHeartbeat(devswarmRootFn, home, hash, now) -> { fresh, ts }
 * Reads the LEGACY per-worktree daemon heartbeat file
 * (`<devswarmRoot>/heartbeats/ingest-<hash>.json`, written by
 * devswarm-ingest.js's writeIngestHeartbeat) and reports freshness. Fail-open:
 * a missing/corrupt/unparsable file reads as NOT fresh, never throws.
 */
function readLegacyHeartbeat(devswarmRootFn, home, hash, now) {
  try {
    const p = path.join(devswarmRootFn(home), 'heartbeats', 'ingest-' + String(hash) + '.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ts = data && Number.isFinite(data.ts) ? data.ts : null;
    const n = typeof now === 'function' ? now() : Date.now();
    return { fresh: ts != null && (n - ts) <= HEARTBEAT_STALE_MS, ts };
  } catch (_) {
    return { fresh: false, ts: null };
  }
}

/**
 * rollbackToLegacyUnits(opts) -> {
 *   attempted, viable, repoKey, uninstalled,
 *   reinstalled: [{ worktree, hash, installed, fresh }],
 *   detail,
 * }
 *
 * D13/Phase-6b downgrade helper (0.57 mesh -> <=0.56 legacy per-worktree
 * units), invoked as part of a documented rollback procedure (Phase 11 KB) —
 * NOT wired into runUpdate/main, and NEVER run automatically.
 *
 * Step 1: uninstalls THIS repo's per-project ingest daemon (best-effort — an
 * absent unit is a harmless no-op).
 * Step 2: enumerates this repo's worktrees via `git worktree list --porcelain`
 * from the MAIN worktree (install-devswarm-ingest.js's `reapPlanForRepo` —
 * the SAME enumeration Phase 5's own reap-before-drain uses; worktreeHash is a
 * one-way sha256 and can NEVER be inverted back to a worktree path — Gap-2)
 * and REINSTALLS each one's LEGACY per-worktree unit (the shape a <=0.56
 * daemon/scheduler expects).
 * `viable:true` is declared ONLY once every reinstalled unit's legacy
 * heartbeat file (`heartbeats/ingest-<hash>.json`) reads FRESH — a written
 * unit is not proof the daemon is actually draining (mirrors D25's "running
 * AND healthy" posture, not freshness-only). This is a ONE-SHOT check (no
 * poll/sleep loop) — a caller sees `viable:false` immediately after install
 * and may re-invoke once the daemon has had time to start.
 *
 * NON-DESTRUCTIVE (D13): no `store/<hash>/` directory is ever read, written,
 * or deleted here — those sources stay exactly as migration (Phase 3) left
 * them, which is what makes a later re-upgrade's idempotent migration able to
 * reconverge.
 *
 * Fully injectable / fail-open, mirroring healIngestDaemon's own posture:
 * every real system mutation is behind an override a test replaces with a
 * mock (`installIngest`, `repokey`, `liveness`, `doUninstallProject`,
 * `doInstallLegacy`, `readHeartbeat`); production defaults call the REAL
 * exported install-devswarm-ingest.js functions. Any internal throw is
 * caught and reported in `detail`, never propagated.
 *
 * Windows: documented no-op (D28 — the ingest daemon/scheduler is
 * unsupported there; nothing to roll back to).
 */
function rollbackToLegacyUnits(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  const platform = o.platform || process.platform;
  const NOOP = { attempted: false, viable: false, repoKey: null, uninstalled: false, reinstalled: [] };
  try {
    if (platform === 'win32') {
      return Object.assign({}, NOOP, {
        detail: 'rollback is a documented no-op on win32 (ingest daemon/scheduler unsupported there — D28)',
      });
    }
    const installerPath = path.join(paths.pluginSrcDir, 'companion', 'install-devswarm-ingest.js');
    const repokeyPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-repokey.js');
    const livenessPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'liveness.js');
    if (!fs.existsSync(installerPath) || !fs.existsSync(repokeyPath) || !fs.existsSync(livenessPath)) {
      return Object.assign({}, NOOP, {
        detail: 'rollback skipped: expected plugin files not found under ' + paths.pluginSrcDir,
      });
    }
    const installIngest = o.installIngest || require(installerPath);
    const repokey = o.repokey || require(repokeyPath);
    const liveness = o.liveness || require(livenessPath);
    const devswarmRootFn = liveness.devswarmRoot;

    const mainWorktree = typeof installIngest.resolveMainWorktree === 'function'
      ? installIngest.resolveMainWorktree(cwd, o.io)
      : null;
    if (!mainWorktree) {
      return Object.assign({}, NOOP, {
        detail: 'cwd is not a git worktree — rollback skipped (no project to resolve)',
      });
    }
    const repoKey = typeof repokey.repoKeyForWorktree === 'function'
      ? repokey.repoKeyForWorktree(mainWorktree, { io: o.io })
      : null;

    // Step 1: uninstall the per-project daemon (best-effort; an absent unit is
    // a harmless no-op, matching *UninstallProject's own ignore-err posture).
    let uninstalled = false;
    const doUninstallProject = o.doUninstallProject || ((rk) => {
      if (platform === 'darwin') installIngest.macUninstallProject(rk);
      else installIngest.linuxUninstallProject(rk);
    });
    if (repoKey) {
      try { doUninstallProject(repoKey); uninstalled = true; } catch (_) { uninstalled = false; }
    }

    // Step 2: enumerate + reinstall this repo's LEGACY per-worktree units. A
    // worktree that was removed (`git worktree remove`) simply never appears
    // in the porcelain listing, so it is skipped for free; a worktree whose
    // directory vanished WITHOUT `git worktree remove` (still listed,
    // "prunable") is attempted and its failure is caught per-entry — one bad
    // worktree never blocks reinstalling the rest.
    const plan = typeof installIngest.reapPlanForRepo === 'function'
      ? installIngest.reapPlanForRepo(mainWorktree, { io: o.io })
      : [];
    const doInstallLegacy = o.doInstallLegacy || ((wt) => {
      if (platform === 'darwin') installIngest.macInstall(wt);
      else installIngest.linuxInstall(wt);
    });
    const readHeartbeat = o.readHeartbeat || ((h, hash) => readLegacyHeartbeat(devswarmRootFn, h, hash, o.now));

    const reinstalled = [];
    for (const entry of plan) {
      let installed = false;
      try { doInstallLegacy(entry.worktree); installed = true; } catch (_) { installed = false; }
      const hb = installed ? readHeartbeat(home, entry.hash) : { fresh: false, ts: null };
      reinstalled.push({ worktree: entry.worktree, hash: entry.hash, installed, fresh: !!(hb && hb.fresh) });
    }

    const viable = plan.length > 0 && reinstalled.every((r) => r.installed && r.fresh);
    return {
      attempted: true,
      viable,
      repoKey,
      uninstalled,
      reinstalled,
      detail: plan.length === 0
        ? 'no worktrees resolved for this repo — nothing to reinstall (store/<hash>/ sources, if any, are left untouched)'
        : (viable
          ? 'rollback viable: ' + reinstalled.length + ' legacy unit(s) reinstalled and confirmed fresh'
          : 'rollback NOT viable: one or more reinstalled units are not yet confirmed (not installed, or no fresh heartbeat yet) — safe to re-check shortly'),
    };
  } catch (e) {
    return Object.assign({}, NOOP, { detail: 'rollback raised: ' + (e && e.message ? e.message : String(e)) });
  }
}

// ---------------------------------------------------------------------------
// Orchestration (impure — wires the pure pieces together)
// ---------------------------------------------------------------------------

/**
 * runCheck({ paths, exec }) → status object (no writes, no pull).
 * Compares installed version against the remote plugin.json version.
 */
function runCheck(opts) {
  const { paths, exec } = opts;
  const installed = resolveInstalledVersion(paths);
  const remote = remotePluginVersion(paths.marketplaceDir, exec || defaultExec);
  if (!remote.ok) {
    return {
      installed: installed || null,
      latest: null,
      updated: false,
      cacheSynced: false,
      action: 'check failed (offline / no git): ' + remote.reason,
    };
  }
  // If the whole resolution chain failed to produce a semver, NEVER claim
  // 'already up to date' — we cannot know. Surface it as unknown.
  if (!isSemver(installed)) {
    return {
      installed: null,
      latest: remote.version,
      updated: false,
      cacheSynced: false,
      action: UNKNOWN_INSTALLED_ACTION,
    };
  }
  const cmp = compareVersions(installed, remote.version || '0');
  return {
    installed,
    latest: remote.version,
    updated: false,
    cacheSynced: false,
    action: cmp < 0
      ? 'update available (' + installed + ' → ' + remote.version + ') — run without --check to apply'
      : 'already up to date',
  };
}

// Shared unknown-installed-version action text (runCheck + runUpdate).
const UNKNOWN_INSTALLED_ACTION =
  'unknown-installed-version — could not determine the installed anti-hall version ' +
  '(installed_plugins.json, cache dirs, and plugin.json all yielded no valid X.Y.Z); ' +
  'reinstall the plugin or inspect ~/.claude/plugins/installed_plugins.json';

/**
 * runUpdate({ paths, exec, fsImpl }) → { status, changelog, stop }
 * Full update. `stop` is set (with a message) when a destructive git
 * precondition forbids continuing (dirty tree / non-fast-forward).
 */
// stageProgress(env, name, fn) -> fn()'s return value. Wave D9: emits one
// STDERR line before and after each post-update stage (`[update] <stage>
// start` / `done <ms>`) so a slow stage (e.g. reconcile draining dozens of
// stale worktrees) is visible while it runs instead of update.js printing
// nothing until EVERY stage returns (main()'s final JSON/status line on
// STDOUT is unchanged — no hook/test parses this session's stderr).
// ANTIHALL_UPDATE_QUIET=1 suppresses it (e.g. for a script that captures
// stderr for its own purposes).
function stageProgress(env, name, fn) {
  const quiet = !!(env && env.ANTIHALL_UPDATE_QUIET === '1');
  if (!quiet) { try { fs.writeSync(2, '[update] ' + name + ' start\n'); } catch (_) { /* best-effort */ } }
  const t0 = Date.now();
  const result = fn();
  if (!quiet) { try { fs.writeSync(2, '[update] ' + name + ' done ' + (Date.now() - t0) + 'ms\n'); } catch (_) { /* best-effort */ } }
  return result;
}

function runUpdate(opts) {
  const { paths, exec, fsImpl } = opts;
  const e = exec || defaultExec;
  const env = opts.env || process.env;
  const installed = resolveInstalledVersion(paths);

  // Git availability + cleanliness.
  const st = gitState(paths.marketplaceDir, e);
  if (!st.ok) {
    return {
      status: {
        installed: installed || null, latest: installed || null,
        updated: false, cacheSynced: false,
        action: 'offline / no git — cannot update: ' + st.reason,
      },
      changelog: '',
      stop: false,
    };
  }
  if (!st.clean) {
    return {
      status: {
        installed: installed || null, latest: installed || null,
        updated: false, cacheSynced: false,
        action: 'STOP: marketplace clone has local changes — refusing to pull. Resolve them in ' + paths.marketplaceDir,
      },
      changelog: '',
      stop: true,
    };
  }

  // Fast-forward pull only. INVERTED failure posture (A2): only a pull failure
  // POSITIVELY recognized as offline/network/no-git (the fail-open class) is a
  // transient report (exit 0). Everything else — non-fast-forward, "refusing to
  // merge unrelated histories", and any UNKNOWN git error — is treated as
  // divergence-like and is a hard STOP (exit 1) with the raw git message, so a
  // real divergence can never masquerade as a transient hiccup.
  const pull = gitPullFfOnly(paths.marketplaceDir, e);
  if (!pull.ok) {
    const offline = OFFLINE_RE.test(pull.reason);
    return {
      status: {
        installed: installed || null, latest: installed || null,
        updated: false, cacheSynced: false,
        action: offline
          ? 'update failed (offline / network): ' + pull.reason
          : 'STOP: git pull --ff-only failed (likely divergence) — resolve manually in ' + paths.marketplaceDir + ' (' + pull.reason + ')',
      },
      changelog: '',
      stop: !offline,
    };
  }

  // New version from the (now-updated) marketplace plugin.json.
  const latest = versionFromMarketplace(paths.pluginJson) || (isSemver(installed) ? installed : null);

  // Cache sync (only mirrors when needed; never touches sibling dirs). Runs
  // even when installed is unknown — mirroring the pulled version aids recovery.
  const cache = syncCache(paths, latest, fsImpl);

  // Ingest-daemon heal (see healIngestDaemon's doc comment for the root cause).
  // Fires when EITHER this run actually synced new bytes into the cache OR the
  // installed unit fails to classify 'ok'. The second arm is the v0.86 fix: a
  // daemon goes stale with NO version bump (the plugin manager relocates the
  // cache dir it was baked from), and gating on cache.synced alone made the heal
  // unreachable in exactly that steady state — the installed version already
  // equals latest, syncCache no-ops, and the classifier that would spot the
  // dangling scriptPath never ran. Read-only and fail-open on non-sync runs
  // (a unit enumeration plus a few statSyncs; no spawn, no writes).
  const ingestHealArgs = { paths, env: opts.env, cwd: opts.cwd, home: opts.home, spawnFn: opts.spawnIngestInstaller, version: latest };
  const ingestHeal = (cache.synced || ingestUnitNeedsHeal(ingestHealArgs))
    ? healIngestDaemon(ingestHealArgs)
    : { attempted: false, healed: false, detail: 'no cache sync this run and the installed ingest unit classifies ok — nothing to heal' };

  // Shared store-hash enumeration (throttle/pacing fix, spec item 1): ONE
  // listStoreHashes pass this run, reused by BOTH foldAllStoresPostUpdate and
  // healRegistryPostUpdate instead of each doing its own full store-root
  // directory listing. Only computed once, and only when a DevSwarm session
  // is genuinely active — mirrors the gate each sweep already checks
  // internally, so a non-DevSwarm run never pays even the one readdir.
  // `null` (gate closed / files missing) means "let each sweep self-enumerate
  // if it ends up needing to" — never forces a stale/empty list on them.
  let sharedStoreHashes = null;
  try {
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    const storeLibPath = path.join(paths.pluginSrcDir, 'companion', 'lib', 'devswarm-store.js');
    if (fs.existsSync(detectPath) && fs.existsSync(storeLibPath)) {
      const { isDevswarmActive } = require(detectPath);
      if (typeof isDevswarmActive === 'function' && isDevswarmActive(opts.env)) {
        const devstore = opts.devswarmStore || require(storeLibPath);
        const homeForOrder = opts.home || os.homedir();
        const rawHashes = devstore.listStoreHashes(homeForOrder) || [];
        // Smallest-store-first (see orderStoreHashesBySize doc comment): all
        // three throttled sweeps below (foldAllStores, healOrphanPartitions,
        // healRegistry) share this ONE ordered list, so the fix applies once
        // here rather than three times.
        sharedStoreHashes = orderStoreHashesBySize(devstore, homeForOrder, rawHashes, fsImpl);
      }
    }
  } catch (_) { sharedStoreHashes = null; }

  // OVERALL POST-PULL BUDGET (D11-C, defect e7307778b614): see
  // postPullBudgetMs's own header comment for the full rationale — a ceiling
  // across every DevSwarm post-pull stage COMBINED (reconcile through
  // heal-registry-rows), checked BEFORE each one starts, never mid-stage. A
  // stage whose start would exceed the deadline is deferred WHOLE (never
  // partially run) and reported as `deferred:true` — it picks back up on the
  // next `update`/`doctor` run rather than being lost, because every one of
  // these stages is independently idempotent/resumable (fold/heal/
  // fold-archived-rows persist their own resume markers; the one-time-per-
  // version stages simply re-attempt next call).
  //
  // DEFERRAL SAFETY NET (task #40, v0.96.1 — closes the gap this comment
  // used to describe): companion/devswarm-supervisor.js ALSO runs a periodic,
  // cooldown-gated sweep — `reconcile` + single-project `foldMeshDuplicates`
  // on every tick (its own reconcileSweepIfDue), PLUS a separate bounded
  // per-pass slot (deferredSweepIfDue) that picks up AT MOST ONE of
  // fold-all-stores / heal-orphan-partitions / fold-archived-rows per tick,
  // rotating through the three, and ONLY when that stage's own persisted
  // resume/sweep-state marker shows it actually deferred work here (a no-op
  // tick otherwise). It calls these SAME stage functions
  // (foldAllStoresPostUpdate/healOrphanPartitionsPostUpdate/
  // foldArchivedRowsPostUpdate) directly — no separate implementation. So a
  // deferral of any of these four stages now has a real periodic backstop;
  // it is bounded (one stage, one small budget, per tick) rather than
  // instant, but no longer relies SOLELY on the next explicit
  // `update`/`doctor` invocation the way it did before this task.
  const postPullNowFn = opts.now || Date.now;
  const postPullBudget = postPullBudgetMs(env);
  const postPullDeadline = postPullBudget > 0 ? postPullNowFn() + postPullBudget : Infinity;
  function deferPostPullStage(name) {
    return {
      attempted: false, deferred: true,
      detail: name + ': deferred — overall post-pull budget (' + postPullBudget + 'ms) exhausted before'
        + ' this stage started; it runs on the NEXT update/doctor pass (idempotent/resumable, nothing lost)',
    };
  }
  function runPostPullStage(name, fn) {
    if (postPullNowFn() >= postPullDeadline) return deferPostPullStage(name);
    return stageProgress(env, name, fn);
  }

  // Reconcile: DevSwarm-session-only post-update step (drains stranded per-
  // worktree native hivecontrol queues into the shared store). Unlike
  // ingestHeal above, this runs on EVERY update regardless of cache.synced —
  // stranded messages are unrelated to whether the plugin itself changed
  // version this run. Fully fail-open — never affects `stop` or the update's
  // own success/failure (see reconcilePostUpdate's doc comment).
  const reconcile = runPostPullStage('reconcile', () => reconcilePostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm,
    reconcileBudgetMs: opts.reconcileBudgetMs,
  }));
  // #70: fold prior mesh forms (phantom/dual/subdir-split) into canonical
  // survivors — after reconcile drains, so stranded messages exist to forward.
  // Same gate + fail-open posture; never affects `stop` or the update's success.
  const fold = runPostPullStage('fold', () => foldMeshPostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm }));
  // Spec item 5c: fold EVERY store this machine has opened, not only the cwd
  // project's — see foldAllStoresPostUpdate's doc comment. Same gate + fail-
  // open posture; never affects the update's success. Throttled + resumable +
  // one-time-per-version (spec items 1-3): shares this run's enumeration and
  // is stamped complete for `latest` once fully drained.
  const foldAllStores = runPostPullStage('fold-all-stores', () => foldAllStoresPostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm,
    hashes: sharedStoreHashes, version: latest, postPullDeadline,
  }));
  // Self-heal a partition with real messages but no registry row — after fold
  // (duplicates collapse to one canonical survivor first, so an adopted orphan
  // forwards into an already-canonical group) and before foldArchivedRows. Same
  // gate + fail-open posture; never affects the update's success. Throttled +
  // resumable + one-time-per-version, sharing this run's enumeration.
  const healOrphanPartitions = runPostPullStage('heal-orphan-partitions', () => healOrphanPartitionsPostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm,
    hashes: sharedStoreHashes, version: latest, postPullDeadline,
  }));
  // Archived-still-active migration: retire every registry row still held by a
  // GENUINELY archived workspace. Deliberately AFTER `fold` — fold first collapses
  // each worktree's duplicates into one canonical survivor, so this pass typically
  // has a single row per archived workspace to retire rather than approaching the
  // same rows from the other direction. Both are idempotent, so the ordering is a
  // work-reduction, not a correctness requirement. Same gate + fail-open posture.
  const foldArchivedRows = runPostPullStage('fold-archived-rows', () => foldArchivedRowsPostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm, postPullDeadline,
  }));
  // Item 6, defect df54edf54804 field aftermath: re-retire registry rows an
  // ALREADY-RUN (pre-fix) migration resurrected — restoring pre-migration
  // state, not deleting user data, so this runs unconditionally on every
  // update (same one-time-per-version stamp posture as cursor-hygiene
  // below), not gated behind doctor's separate repair flag.
  const reRetireResurrected = runPostPullStage('re-retire-resurrected', () => reRetireResurrectedPostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm, version: latest,
  }));
  // P1-8: backfill the new `ownerKey` descriptor field + heal prior hash-bucket
  // split-brain. Same gate + fail-open posture; never affects the update's
  // success. Run-once-per-version stamped (spec item 3) — its own descriptor
  // walk (not the shared store-hash enumeration) is skipped entirely once a
  // pass for `latest` has already completed.
  // carry-out (e): forward-migrate persisted `unclaimed:<id>` session ids.
  const promoteUnclaimed = runPostPullStage('promote-unclaimed', () => promoteUnclaimedPostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm }));
  const ownerKeyMigrate = runPostPullStage('owner-key-migrate', () => ownerKeyMigratePostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm, version: latest }));
  // Task #4: normalize parent-gate reply-state files to the append-only shape.
  // Pure per-user-file fold+rewrite; same gate + fail-open posture; never
  // affects the update's own success.
  const replyStateMigrate = runPostPullStage('reply-state-migrate', () => replyStateMigratePostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home }));
  // defect 8b211241bbe9: bounded hygiene for per-instance cursor files. Same
  // gate + fail-open posture; never affects the update's own success.
  const cursorHygiene = runPostPullStage('cursor-hygiene', () => cursorHygienePostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm, version: latest }));
  // devswarm-parent-gate.js stated-intent shape: normalize every gate-loop-
  // state file to carry intents/intentAcks. Same gate + fail-open posture;
  // never affects the update's own success.
  const gateIntentsMigrate = runPostPullStage('gate-intents-migrate', () => gateIntentsMigratePostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home }));
  // Claim 3 self-heal: sweep every per-project store registry for a mis-keyed/
  // stale row via devswarm.js's healRegistry. Same gate + fail-open posture;
  // never affects the update's success. Throttled + resumable + one-time-per-
  // version (spec items 1-3): shares this run's enumeration and is stamped
  // complete for `latest` once fully drained.
  const healRegistryRows = runPostPullStage('heal-registry-rows', () => healRegistryPostUpdate({
    paths, env: opts.env, cwd: opts.cwd, home: opts.home, devswarm: opts.devswarm,
    hashes: sharedStoreHashes, version: latest,
  }));
  // Monitor-based idle-wake companion: report shipped/live state + the exact
  // manual arm command. update.js is a plain Node process — it CANNOT call
  // the agent-only `Monitor` tool, so this only verifies/reports, never
  // claims to have armed anything. Same gate + fail-open posture; never
  // affects the update's success.
  const wakeMonitor = stageProgress(env, 'wake-monitor', () => wakeMonitorPostUpdate({ paths, env: opts.env, cwd: opts.cwd, home: opts.home }));

  // Unknown installed version → NEVER 'already up to date'; no delta computable
  // (a null `from` would dump the entire changelog, so suppress it).
  if (!isSemver(installed)) {
    return {
      status: {
        installed: null,
        latest: latest || null,
        updated: false,
        cacheSynced: cache.synced,
        ingestHeal,
        reconcile,
        fold,
        foldAllStores,
        healOrphanPartitions,
        foldArchivedRows,
        reRetireResurrected,
        promoteUnclaimed,
        ownerKeyMigrate,
        cursorHygiene,
        replyStateMigrate,
        gateIntentsMigrate,
        healRegistryRows,
        wakeMonitor,
        action: UNKNOWN_INSTALLED_ACTION,
      },
      changelog: '',
      stop: false,
    };
  }

  const updated = !!(latest && compareVersions(installed, latest) < 0);

  // CHANGELOG delta (installed exclusive → latest inclusive).
  let changelog = '';
  try {
    const stat = fs.statSync(paths.changelog);
    if (stat.size <= MAX_BYTES) {
      changelog = extractChangelog(fs.readFileSync(paths.changelog, 'utf8'), installed, latest);
    }
  } catch (_) { changelog = ''; }

  return {
    status: {
      installed,
      latest: latest || null,
      updated,
      cacheSynced: cache.synced,
      ingestHeal,
      reconcile,
      fold,
      foldAllStores,
      healOrphanPartitions,
      foldArchivedRows,
      reRetireResurrected,
      promoteUnclaimed,
      ownerKeyMigrate,
      cursorHygiene,
      replyStateMigrate,
      gateIntentsMigrate,
      healRegistryRows,
      wakeMonitor,
      action: updated ? 'run /reload-plugins' : 'already up to date',
    },
    changelog,
    stop: false,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
function main() {
  const isCheck = process.argv.includes('--check');
  const paths = resolvePaths(process.env, os.homedir());
  if (paths.overrideIgnored) fs.writeSync(1, paths.overrideIgnored + '\n');

  // fs.writeSync(1, ...) NOT process.stdout.write: on macOS node 18/20,
  // process.exit races the async stdout pipe flush and truncates large output
  // (repo-wide rule — the changelog delta can be multi-KB).
  if (isCheck) {
    const status = runCheck({ paths });
    fs.writeSync(1, JSON.stringify(status) + '\n');
    fs.writeSync(1, renderHuman(status, '') + '\n');
    process.exit(0);
  }

  const { status, changelog, stop } = runUpdate({ paths });
  fs.writeSync(1, JSON.stringify(status) + '\n');
  fs.writeSync(1, renderHuman(status, changelog) + '\n');
  // A hard STOP (dirty / diverged) is a precondition failure → non-zero so it is
  // visible to scripts; the skill still relays the human message.
  process.exit(stop ? 1 : 0);
}

/** renderHuman(status, changelog) → readable summary block. */
function renderHuman(status, changelog) {
  const lines = [];
  lines.push('anti-hall update');
  lines.push('  installed: ' + (status.installed || '(unknown)'));
  lines.push('  latest:    ' + (status.latest || '(unknown)'));
  lines.push('  updated:   ' + status.updated + (status.cacheSynced ? ' (cache synced)' : ''));
  lines.push('  action:    ' + status.action);
  if (status.reconcile && status.reconcile.attempted) {
    lines.push('  reconcile: ' + status.reconcile.detail);
    if (Array.isArray(status.reconcile.results) && status.reconcile.results.length) {
      for (const r of status.reconcile.results) {
        const bits = ['imported ' + (r.imported || 0), 'duplicate ' + (r.duplicate || 0)];
        if (r.locked) bits.push('locked — another pull in progress, skipped');
        if (r.lost) bits.push('LOST ' + r.lost);
        if (r.error) bits.push('ERROR: ' + r.error);
        lines.push('    - ' + r.id + ': ' + bits.join(', '));
      }
    }
  }
  if (status.fold && status.fold.attempted) {
    lines.push('  fold:      ' + status.fold.detail);
  }
  if (status.foldAllStores && status.foldAllStores.attempted) {
    lines.push('  fold-all-stores: ' + status.foldAllStores.detail);
  }
  if (status.healOrphanPartitions && status.healOrphanPartitions.attempted) {
    lines.push('  heal-orphan-partitions: ' + status.healOrphanPartitions.detail);
  }
  if (status.foldArchivedRows && status.foldArchivedRows.attempted) {
    lines.push('  fold-archived-rows: ' + status.foldArchivedRows.detail);
  }
  if (status.cursorHygiene && status.cursorHygiene.attempted) {
    lines.push('  cursor-hygiene: ' + status.cursorHygiene.detail);
  }
  if (status.replyStateMigrate && status.replyStateMigrate.attempted) {
    lines.push('  reply-state-migrate: ' + status.replyStateMigrate.detail);
  }
  if (status.gateIntentsMigrate && status.gateIntentsMigrate.attempted) {
    lines.push('  gate-intents-migrate: ' + status.gateIntentsMigrate.detail);
  }
  if (status.healRegistryRows && status.healRegistryRows.attempted) {
    lines.push('  heal-registry-rows: ' + status.healRegistryRows.detail);
    if (Array.isArray(status.healRegistryRows.stores) && status.healRegistryRows.stores.length) {
      for (const s of status.healRegistryRows.stores) {
        lines.push('    - ' + s.repoKey + ': ' + s.rows.join(', '));
      }
    }
  }
  if (status.wakeMonitor && status.wakeMonitor.attempted) {
    lines.push('  wake-monitor: ' + status.wakeMonitor.detail);
  }
  if (changelog) {
    lines.push('');
    lines.push('Changelog delta:');
    lines.push(changelog);
  }
  return lines.join('\n');
}

// Run only when invoked directly (not when required by tests).
if (require.main === module) {
  main();
}

module.exports = {
  resolvePaths,
  readJsonBounded,
  isSemver,
  parseVersion,
  compareVersions,
  versionFromInstalledJson,
  newestCacheVersion,
  versionFromMarketplace,
  resolveInstalledVersion,
  extractChangelog,
  syncCache,
  gitState,
  gitPullFfOnly,
  remotePluginVersion,
  GIT_EXEC_TIMEOUT_MS,
  sweepBudgetMs,
  postPullBudgetMs,
  sweepYield,
  runThrottledSweep,
  orderStoreHashesBySize,
  storeDirSizeBytes,
  sweepStatePath,
  readSweepState,
  writeSweepState,
  sweepItemsFor,
  recordSweepResult,
  healIngestDaemon,
  inspectInstalledIngest,
  ingestUnitNeedsHeal,
  reconcilePostUpdate,
  foldMeshPostUpdate,
  foldAllStoresPostUpdate,
  healOrphanPartitionsPostUpdate,
  foldArchivedRowsPostUpdate,
  reRetireResurrectedPostUpdate,
  promoteUnclaimedPostUpdate,
  ownerKeyMigratePostUpdate,
  cursorHygienePostUpdate,
  healRegistryPostUpdate,
  wakeMonitorPostUpdate,
  readLegacyHeartbeat,
  rollbackToLegacyUnits,
  runCheck,
  runUpdate,
  renderHuman,
};

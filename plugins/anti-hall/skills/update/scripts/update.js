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
// NO writes outside the marketplace clone dir and stdout. The only filesystem
// mutation is fs.cpSync of the marketplace plugin dir into a NEW cache/<ver>/
// dir (never deletes or overwrites a sibling version). Pure Node >= 18
// built-ins; cross-platform incl. Windows (git step uses execFileSync, no shell).

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

/** defaultExec(args, cwd) → stdout string. Throws on non-zero (carries .stderr/.status). */
function defaultExec(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
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
 * Fully fail-open: ANY error here is reported in `detail` and NEVER thrown — a
 * heal failure must never fail the update itself.
 */
function healIngestDaemon(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const home = o.home || os.homedir();
  const paths = o.paths;
  try {
    const installerPath = path.join(paths.pluginSrcDir, 'companion', 'install-devswarm-ingest.js');
    const repairPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'doctor-repair.js');
    const detectPath = path.join(paths.pluginSrcDir, 'hooks', 'lib', 'devswarm-detect.js');
    if (!fs.existsSync(installerPath) || !fs.existsSync(repairPath) || !fs.existsSync(detectPath)) {
      return { attempted: false, healed: false, detail: 'ingest heal skipped: expected plugin files not found under ' + paths.pluginSrcDir };
    }
    const installIngest = require(installerPath);
    const { isDevswarmActive } = require(detectPath);
    const { readInstalledIngestWorkingDir, classifyIngestUnit } = require(repairPath);

    if (typeof isDevswarmActive !== 'function' || !isDevswarmActive(env)) {
      return { attempted: false, healed: false, detail: 'not a DevSwarm session — ingest heal skipped (gate closed)' };
    }
    const worktree = typeof installIngest.resolveWorktree === 'function' ? installIngest.resolveWorktree(cwd) : null;
    if (!worktree) {
      return { attempted: false, healed: false, detail: 'cwd is not a git worktree — ingest heal skipped (gate closed)' };
    }

    const before = readInstalledIngestWorkingDir({ worktree, home });
    const cls = classifyIngestUnit({ workingDir: before.workingDir, scriptPath: before.scriptPath, home, env });
    if (cls === 'ok' || cls === 'absent') {
      // 'ok': already healthy — nothing to heal. 'absent': not installed here —
      // first-installing an opt-in daemon unprompted stays the update SKILL's own
      // explicit, documented step (SKILL.md step 7), not this code path's job.
      return { attempted: true, healed: true, detail: 'ingest daemon ' + cls + ' — no heal needed' };
    }

    const spawn = o.spawnFn || ((script) => spawnSync(process.execPath, [script], {
      cwd, env: Object.assign({}, env, { HOME: home }), encoding: 'utf8', timeout: 30000,
    }));
    spawn(installerPath);
    const after = readInstalledIngestWorkingDir({ worktree, home });
    const cls2 = classifyIngestUnit({ workingDir: after.workingDir, scriptPath: after.scriptPath, home, env });
    return {
      attempted: true,
      healed: cls2 === 'ok',
      detail: cls2 === 'ok'
        ? 're-installed the ingest daemon (was ' + cls + ') — WorkingDirectory now ' + after.workingDir
        : 'ingest daemon still ' + cls2 + ' after re-install attempt',
    };
  } catch (e) {
    return { attempted: false, healed: false, detail: 'ingest heal raised: ' + (e && e.message ? e.message : String(e)) };
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
function runUpdate(opts) {
  const { paths, exec, fsImpl } = opts;
  const e = exec || defaultExec;
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

  // Ingest-daemon heal: only worth attempting once something was actually
  // synced this run (see healIngestDaemon doc comment for the full root-cause
  // rationale). Fully fail-open — never affects `stop` or the update's own
  // success/failure.
  const ingestHeal = cache.synced
    ? healIngestDaemon({ paths, env: opts.env, cwd: opts.cwd, home: opts.home, spawnFn: opts.spawnIngestInstaller })
    : { attempted: false, healed: false, detail: 'no cache sync this run — nothing to heal' };

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
  healIngestDaemon,
  runCheck,
  runUpdate,
  renderHuman,
};

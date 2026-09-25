'use strict';
// anti-hall :: doctor-devswarm — the DevSwarm liveness section of doctor.js as a
// pure, testable check function (mirrors skills/flutter-debug/scripts/preflight.js
// -> doctor.js §6b). Workaround for claude-code#39755.
//
// runChecks({home, env, fsi}) -> { active, results: [{status, message}] }.
// Silent (active:false, no results) unless the supervisor is in play — either the
// session is DevSwarm-active OR the consumer has published workspace descriptors.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDevswarmActive } = require('../../hooks/lib/devswarm-detect.js');
const { computeLiveness, livenessPathFor, projectDirFor, devswarmRoot, isSafeId, unreadBacklog, heartbeatVersion } = require('./liveness.js');
const { checkResults: descriptorChecks } = require('./doctor-descriptors.js');
const { DEVSWARM_BASELINE } = require('../../hooks/lib/devswarm-baseline.js');
const { classifyVersionDrift } = require('../../hooks/devswarm-version.js');
// item 4b — stale-anti-hall-BUILD detection (distinct from classifyVersionDrift
// above, which compares the DevSwarm CLI's OWN version against anti-hall's
// integration baseline — this compares a workspace's RECORDED anti-hall
// version, item 4a, against the newest anti-hall build known on THIS machine).
const versionCheck = require('./devswarm-version-check.js');

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const SELFTEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LISTENER_IDLE_MS = 15 * 60 * 1000; // mirrors liveness.js's DEFAULT_IDLE_MS

function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }

function readDescriptors(home, F) {
  let names = [];
  try { names = F.readdirSync(workspacesDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const d = JSON.parse(F.readFileSync(path.join(workspacesDir(home), n), 'utf8'));
      if (d && d.worktreePath && d.sessionId && isSafeId(d.id)) out.push(d);
    } catch (_) {}
  }
  return out;
}

// statusFor(verdictStatus) -> PASS | WARN | FAIL (base mapping).
function statusFor(s) {
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'nudged') return WARN;
  return FAIL; // ambiguous | escalated | anything unexpected
}

// statusForVerdict(verdict) -> PASS | WARN | FAIL. No stuck-timer any more — the
// automatic path never kills, so there is no kill-then-resume window to watch
// for being "stuck"; a `nudged` verdict is just a soft WARN, and the
// poke/escalate machinery (liveness.js's nudge branch + recovery.js's
// pokeOrEscalate) already owns moving it to `escalated` once the nudge budget is
// exhausted.
function statusForVerdict(verdict) {
  const s = verdict && verdict.status;
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'nudged') return WARN;
  return FAIL; // ambiguous | escalated | unexpected
}

// selfTest(home, F) -> [{status, message}]. Constructed-fixture behavioral test
// (doctor convention): a FRESH transcript classifies alive; a WEDGED one (idle +
// pending) classifies stale. Proves the live logic still fires. Liveness is
// uuid-SCOPED, so the fixture's transcript is named <SELFTEST_UUID>.jsonl and the
// descriptor carries that sessionId.
function selfTest(home, F) {
  const out = [];
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-selftest-'));
    try {
      const wt = path.join(base, 'wt');
      F.mkdirSync(wt, { recursive: true });
      const projectDir = projectDirFor(wt, base);
      F.mkdirSync(projectDir, { recursive: true });
      const tp = path.join(projectDir, SELFTEST_UUID + '.jsonl');
      F.writeFileSync(tp, '{}\n');
      const inboxPath = path.join(wt, 'i'); const cursorPath = path.join(wt, 'c');
      F.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
      F.writeFileSync(cursorPath, '0');
      const descriptor = { id: 'selftest', worktreePath: wt, inboxPath, cursorPath, sessionId: SELFTEST_UUID };

      // Fresh: transcript mtime = now -> alive.
      const nowTs = Date.now();
      const alive = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => nowTs } });
      out.push({ status: alive.status === 'alive' ? PASS : FAIL, message: 'liveness self-test: fresh workspace classified ' + alive.status + ' (expected alive)' });

      // Wedged: both signals idle + pending -> stale.
      const old = nowTs - 30 * 60 * 1000;
      const t = old / 1000; F.utimesSync(tp, t, t);
      const wedged = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => old } });
      out.push({ status: wedged.status === 'stale' ? WARN : FAIL, message: 'liveness self-test: wedged workspace classified ' + wedged.status + ' (expected stale)' });
    } finally {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (e) {
    out.push({ status: WARN, message: 'liveness self-test raised (fail-open): ' + (e && e.message) });
  }
  return out;
}

// listenerPresenceFor(descriptor, now, F) -> {status, message}. A distinct
// signal from the combined liveness verdict above: is something actually
// CONSUMING the workspace's inbox, not just "is the target session alive".
// Derived ONLY from observable file state (cursor/inbox mtimes + the same
// unreadBacklog() cursor-vs-inbox math liveness.js already trusts) — there is
// no separate heartbeat file for this, so a case that can't be read cleanly
// reports WARN "state unknown" rather than guessing a PASS.
function listenerPresenceFor(d, now, F) {
  let cursorMtime = null;
  try { cursorMtime = F.statSync(d.cursorPath).mtimeMs; } catch (_) {}
  const backlog = unreadBacklog(d.inboxPath, d.cursorPath, F);
  if (cursorMtime === null || !backlog.known) {
    return { status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (inbox/cursor unreadable)' };
  }
  // Caught up: an empty backlog is never evidence of a dead listener, whatever
  // the cursor's age — nothing pending means nothing to have missed.
  if (backlog.lines.length === 0) {
    return { status: PASS, message: 'workspace ' + d.id + ' listener: present (inbox caught up, no backlog)' };
  }
  const cursorAgeMs = now - cursorMtime;
  // Pending backlog + a recently-moved cursor = direct evidence something is
  // actively draining it.
  if (cursorAgeMs <= LISTENER_IDLE_MS) {
    return { status: PASS, message: 'workspace ' + d.id + ' listener: present (cursor advanced ' + Math.round(cursorAgeMs / 1000) + 's ago, draining ' + backlog.lines.length + ' pending)' };
  }
  // Pending backlog + a stale cursor: could be a dead listener OR just a slow
  // one — we cannot tell them apart from file state alone, so never claim PASS.
  return { status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (' + backlog.lines.length + ' unread message(s), cursor last moved ' + Math.round(cursorAgeMs / 60000) + 'm ago)' };
}

// ---------------------------------------------------------------------------
// wake-monitor (Monitor-based idle-wake) — shipped / proven / live report.
// Companion to skills/update/scripts/update.js's wakeMonitorPostUpdate: THAT
// function runs post-update and can only verify/report (a plain Node process
// has no `Monitor` tool); THIS check runs on every `doctor` pass and reports
// the same three honest facts — shipped, proven (behavioral self-test), live
// (read-only lock inspection) — plus the exact manual arm command whenever no
// watcher is currently live. Neither path ever claims to have armed anything.
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = path.join(__dirname, '..', '..');

// wakeMonitorShipped(pluginRoot) -> { shipped, watcherPath, watcherMod, reason }.
// shipped requires BOTH: the watcher script present + require()-loadable with
// its expected exports, AND hooks/lib/devswarm-wake.js's wakeDirective actually
// emitting Monitor-arm text when given a watcher path (proves the two halves
// are still wired together, not just independently present).
function wakeMonitorShipped(pluginRoot) {
  const watcherPath = path.join(pluginRoot, 'companion', 'lib', 'devswarm-wake-watch.js');
  try {
    if (!fs.existsSync(watcherPath)) return { shipped: false, watcherPath, reason: 'watcher script missing at ' + watcherPath };
    let watcherMod;
    try { watcherMod = require(watcherPath); } catch (e) { return { shipped: false, watcherPath, reason: 'watcher script failed to load: ' + (e && e.message ? e.message : String(e)) }; }
    if (typeof watcherMod.tick !== 'function' || typeof watcherMod.normalizeState !== 'function'
      || typeof watcherMod.resolveIdentity !== 'function' || typeof watcherMod.lockPathFor !== 'function') {
      return { shipped: false, watcherPath, reason: 'watcher script loaded but is missing expected exports (tick/normalizeState/resolveIdentity/lockPathFor)' };
    }
    const wakePath = path.join(pluginRoot, 'hooks', 'lib', 'devswarm-wake.js');
    if (!fs.existsSync(wakePath)) return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js missing at ' + wakePath };
    let wakeMod;
    try { wakeMod = require(wakePath); } catch (e) { return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js failed to load: ' + (e && e.message ? e.message : String(e)) }; }
    if (typeof wakeMod.wakeDirective !== 'function') return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js is missing wakeDirective' };
    const cli = path.join(pluginRoot, 'scripts', 'devswarm.js');
    let text = '';
    try { text = wakeMod.wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, false, cli, watcherPath) || ''; } catch (_) { text = ''; }
    if (typeof text !== 'string' || !text.includes('Monitor') || !text.includes(watcherPath)) {
      return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js did not emit Monitor-arm text for a watcher path — the two halves are no longer wired together' };
    }
    return { shipped: true, watcherPath, watcherMod };
  } catch (e) {
    return { shipped: false, watcherPath, reason: 'raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

// wakeMonitorSelfTest(watcherMod) -> [{status, message}]. Behavioral proof the
// PURE tick() core still fires correctly — mirrors selfTest()'s constructed-
// fixture style above. Starts from an already-armed synthetic state so the
// arm-line's own one-time emission never muddies the silent/emits assertions:
// a no-change snapshot must stay silent, a new-total snapshot must emit
// exactly one wake line.
function wakeMonitorSelfTest(watcherMod) {
  const out = [];
  try {
    const { tick, normalizeState } = watcherMod;
    let st = normalizeState({ armed: true, lastTotal: 5 });
    const noChange = { ok: true, total: 5, role: 'primary', id: 'selftest', nowMs: Date.now() };
    const r1 = tick(st, noChange);
    const silentOk = Array.isArray(r1.lines) && r1.lines.length === 0;
    out.push({ status: silentOk ? PASS : FAIL, message: 'wake-monitor self-test: no-change snapshot stayed silent (' + (r1.lines ? r1.lines.length : '?') + ' line(s), expected 0)' });

    st = r1.state;
    const newTotal = { ok: true, total: 6, role: 'primary', id: 'selftest', nowMs: Date.now() };
    const r2 = tick(st, newTotal);
    const emitOk = Array.isArray(r2.lines) && r2.lines.length === 1 && /new mesh mail/.test(r2.lines[0]);
    out.push({ status: emitOk ? PASS : FAIL, message: 'wake-monitor self-test: new-total snapshot emitted a wake line (' + (r2.lines ? r2.lines.length : '?') + ' line(s), expected 1)' });
  } catch (e) {
    out.push({ status: WARN, message: 'wake-monitor self-test raised (fail-open): ' + (e && e.message) });
  }
  return out;
}

// wakeMonitorLiveCheck(watcherMod, watcherPath, home, env, cwd) -> {status, message}.
// READ-ONLY lock inspection — mirrors devswarm-pull.js's acquireExclLock
// holder/isAlive semantics exactly (same pid-liveness test), but NEVER
// acquires, steals, or deletes the lock; it only reads the file that is
// already there, if any.
function wakeMonitorLiveCheck(watcherMod, watcherPath, home, env, cwd) {
  const armCmd = 'call the `Monitor` tool with command `node ' + watcherPath + '`, arming it with '
    + '`persistent: true` if your Monitor tool supports that field — otherwise set `timeout_ms` '
    + 'to its maximum and re-arm when the tool emits its final/expired event (never run two '
    + 'watchers; the watcher\'s own lock also guards this, and the cron job stays the fallback '
    + 'either way) (or run that command yourself in a background terminal)';
  let identity = null;
  try { identity = watcherMod.resolveIdentity(env, cwd, {}); } catch (_) { identity = null; }
  if (!identity) {
    return { status: WARN, message: 'wake-monitor: could not resolve a DevSwarm identity for ' + cwd + ' — live-check skipped. Manual arm: ' + armCmd + '.' };
  }
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(watcherMod.lockPathFor(home, identity.id), 'utf8')); } catch (_) { holder = null; }
  const pid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
  let alive = false;
  if (pid !== null) {
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
  }
  if (alive) {
    return { status: PASS, message: 'wake-monitor: LIVE for ' + identity.role + ' ' + identity.id + ' (pid ' + pid + ')' };
  }
  return { status: WARN, message: 'wake-monitor: shipped but NOT live for ' + identity.role + ' ' + identity.id + ' — arm it: ' + armCmd + '.' };
}

// wakeMonitorChecks(home, env, cwd) -> [{status, message}]. shipped -> proven
// (self-test) -> live (read-only lock inspection), each gated on the previous
// step actually succeeding (no self-test against a watcher that failed to
// load; no live-check without a watcherMod to call resolveIdentity on).
function wakeMonitorChecks(home, env, cwd) {
  const out = [];
  const shipped = wakeMonitorShipped(PLUGIN_ROOT);
  if (!shipped.shipped) {
    out.push({ status: FAIL, message: 'wake-monitor: NOT shipped — ' + shipped.reason + ' (cron fallback is unaffected)' });
    return out;
  }
  out.push({ status: PASS, message: 'wake-monitor: shipped (watcher script + devswarm-wake.js Monitor-arm emission both present)' });
  out.push(...wakeMonitorSelfTest(shipped.watcherMod));
  out.push(wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, env, cwd));
  return out;
}

// ---------------------------------------------------------------------------
// install-vs-source integrity (CHECK 1: divergence, CHECK 2: monitors.json
// presence) — DETECTION ONLY, never repairs. Closes a proven blind spot:
// skills/update/scripts/update.js's syncCache NEVER overwrites an existing
// cache/<version>/ dir (see that file's own doc comment), so a cache dir
// populated mid-release — before the final commits land — freezes pre-
// release code under the released version number forever, and no update run
// will ever refresh it. Proven live on this machine: cache 0.68.0 held a
// watcher from an earlier commit while the repo/marketplace clone had already
// moved on, and nothing reported it. wakeMonitorPostUpdate (update.js) only
// ever inspects the MARKETPLACE CLONE (paths.pluginSrcDir), never the
// installed cache dir that actually runs — these checks look in the right
// place instead.
// ---------------------------------------------------------------------------

// resolveMarketplaceDir(env, home) -> the marketplace clone's plugins/anti-hall
// dir, or null if it is not present (a user who installed without a clone —
// callers must treat that as a clean no-op, never a warning). Same
// ANTIHALL_MARKETPLACE_DIR override + existence-gate pattern as
// install-devswarm-ingest.js's resolveStableScript (test-only escape hatch;
// production always resolves the default ~/.claude/plugins/marketplaces/... path).
function resolveMarketplaceDir(env, home) {
  const e = env || {};
  let marketplaceDir = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall');
  const override = e.ANTIHALL_MARKETPLACE_DIR;
  if (override) {
    try { if (path.isAbsolute(override) && fs.statSync(override).isDirectory()) marketplaceDir = override; } catch (_) {}
  }
  const candidate = path.join(marketplaceDir, 'plugins', 'anti-hall');
  try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch (_) {}
  return null;
}

// SKIP_DIR_NAMES — directories that are genuinely not shipped content.
// `.in_use` is the one entry PROVEN necessary by running this check against
// the real installed cache: `.claude/plugins/cache/anti-hall/anti-hall/<ver>/
// .in_use/<pid>` is the harness's OWN cache-GC bookkeeping (one file per live
// process holding that cache version open, content `{pid,procStart}`) — it is
// written into the cache dir by Claude Code itself, never present in the
// marketplace clone, and would otherwise flag as "diverged" on every machine
// with anti-hall active, since a running pid never matches across roots. The
// real plugin tree otherwise has neither .git nor node_modules under it
// (verified: plugins/anti-hall/ contains only .claude-plugin, .codex-plugin,
// .in_use (installed side only), agents, codex, companion, hooks, monitors,
// README.md, scripts, skills, statusline) — those two are a defensive
// exclusion for any install/clone that happens to carry one, not an expected
// case. Tests and docs are deliberately NOT excluded — they are shipped
// content and a diff there is exactly the kind of drift this check exists to
// catch.
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.in_use']);

// MAX_FILE_BYTES — files above this are skipped from the walk (both the
// listing and the divergence compare), so a stray large/binary file can never
// make this check expensive. The largest real shipped file today is
// scripts/devswarm.js at ~265KB, so 5MB leaves comfortable headroom while
// staying far below anything that would make hashing hundreds of files slow.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// MAX_DIFFS_REPORTED — cap on how many differing paths are named in the
// human-readable message (the full list still lives in the returned `files`
// array for programmatic consumers).
const MAX_DIFFS_REPORTED = 20;

// hashFileOrNull(p, F) -> hex sha256 digest | null (missing/unreadable).
// node:crypto only — never shells out to md5/shasum (cross-platform constraint).
function hashFileOrNull(p, F) {
  try { return crypto.createHash('sha256').update(F.readFileSync(p)).digest('hex'); }
  catch (_) { return null; }
}

// collectShippedFiles(root, F) -> {files: string[], skippedForSize: number}.
// Recursively walks `root`, returning every regular file's path relative to
// `root` (OS-native separators). Same F.readdirSync + F.statSync convention
// already used by readDescriptors() above — no withFileTypes dependency, so
// a minimal fsi mock (readdirSync + statSync + readFileSync) keeps working.
// Fail-open per directory: an unreadable subtree is silently skipped rather
// than aborting the whole walk (matches every other check in this file).
function collectShippedFiles(root, F) {
  const files = [];
  let skippedForSize = 0;
  (function walk(dir, rel) {
    let names;
    try { names = F.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const full = path.join(dir, name);
      const relPath = rel ? path.join(rel, name) : name;
      let st = null;
      try { st = F.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { walk(full, relPath); continue; }
      if (!st.isFile()) continue; // skip symlinks-to-nowhere/sockets/etc — defensive
      if (st.size > MAX_FILE_BYTES) { skippedForSize++; continue; }
      files.push(relPath);
    }
  })(root, '');
  return { files, skippedForSize };
}

// readPluginVersion(pluginRoot, F) -> semver-ish string | null. Fail-open.
function readPluginVersion(pluginRoot, F) {
  try {
    const data = JSON.parse(F.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    return (data && typeof data.version === 'string') ? data.version : null;
  } catch (_) { return null; }
}

/**
 * installDivergenceCheck({installedRoot, marketplaceRoot, fsi}) -> {status, message[, files]}
 * status: 'clean' | 'diverged' | 'skipped' | 'unknown'.
 *
 * Compares the INSTALLED plugin root (the running copy — callers pass the
 * cache dir the harness actually loaded, e.g. doctor-repair.js's own
 * PLUGIN_ROOT) against the marketplace clone. Only fires when both exist AND
 * their plugin.json `version` fields MATCH but on-disk content of the WHOLE
 * shipped tree differs (every file, hashed by sha256 — see
 * collectShippedFiles/MAX_FILE_BYTES/SKIP_DIR_NAMES above) — the exact shape
 * of a cache dir populated mid-release that syncCache will never touch
 * again. A file present in only one root counts as divergence too. A missing
 * clone, a version mismatch (an update is simply pending — not this bug), or
 * any unreadable path all degrade to a clean/unknown no-op, never a false alarm.
 * REPORT ONLY: never copies/overwrites/deletes anything. FAIL OPEN: never throws.
 */
function installDivergenceCheck(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  try {
    const installedRoot = o.installedRoot;
    const marketplaceRoot = o.marketplaceRoot;
    if (!marketplaceRoot) {
      return { status: 'skipped', message: 'install-divergence: no marketplace clone present — nothing to compare (clean no-op)' };
    }
    let mpStat = null;
    try { mpStat = F.statSync(marketplaceRoot); } catch (_) { mpStat = null; }
    if (!mpStat || !mpStat.isDirectory()) {
      return { status: 'skipped', message: 'install-divergence: no marketplace clone present — nothing to compare (clean no-op)' };
    }
    let installedStat = null;
    try { installedStat = installedRoot ? F.statSync(installedRoot) : null; } catch (_) { installedStat = null; }
    if (!installedRoot || !installedStat || !installedStat.isDirectory()) {
      return { status: 'unknown', message: 'install-divergence: installed plugin root not resolvable — skipped' };
    }
    const installedVersion = readPluginVersion(installedRoot, F);
    const cloneVersion = readPluginVersion(marketplaceRoot, F);
    if (!installedVersion || !cloneVersion) {
      return { status: 'unknown', message: 'install-divergence: could not read plugin.json version from the installed root and/or the marketplace clone — skipped' };
    }
    if (installedVersion !== cloneVersion) {
      return {
        status: 'skipped',
        message: 'install-divergence: installed v' + installedVersion + ' != marketplace clone v' + cloneVersion + ' — different versions (an update is simply pending, not this check\'s target)',
      };
    }
    // Walk BOTH trees in full (not a hand-picked file set — see history: a
    // hardcoded 2-file sample missed a proven real divergence in
    // hooks/api-guard.js, which is exactly the class of bug this check exists
    // to detect). A file present in only one root is divergence too — it is
    // tracked separately from content mismatches so the message can say which
    // kind it is, while `files` stays a flat list of relative paths for
    // programmatic consumers.
    const installedTree = collectShippedFiles(installedRoot, F);
    const marketplaceTree = collectShippedFiles(marketplaceRoot, F);
    const installedSet = new Set(installedTree.files);
    const marketplaceSet = new Set(marketplaceTree.files);
    const allRel = new Set([...installedTree.files, ...marketplaceTree.files]);
    const diffs = [];
    for (const rel of allRel) {
      const inInstalled = installedSet.has(rel);
      const inMarketplace = marketplaceSet.has(rel);
      if (inInstalled && inMarketplace) {
        const a = hashFileOrNull(path.join(installedRoot, rel), F);
        const b = hashFileOrNull(path.join(marketplaceRoot, rel), F);
        if (a !== b) diffs.push({ rel, kind: 'content' });
      } else if (inInstalled) {
        diffs.push({ rel, kind: 'only-in-installed' });
      } else {
        diffs.push({ rel, kind: 'only-in-marketplace' });
      }
    }
    diffs.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
    const skippedForSize = installedTree.skippedForSize + marketplaceTree.skippedForSize;
    const sizeNote = skippedForSize > 0
      ? ' (skipped ' + skippedForSize + ' file(s) over ' + Math.round(MAX_FILE_BYTES / (1024 * 1024)) + 'MB)'
      : '';
    if (diffs.length === 0) {
      return {
        status: 'clean',
        message: 'install-divergence: installed cache (v' + installedVersion + ') content matches the marketplace clone across ' + allRel.size + ' shipped file(s) — no divergence' + sizeNote,
      };
    }
    const shown = diffs.slice(0, MAX_DIFFS_REPORTED).map((d) => {
      if (d.kind === 'only-in-installed') return d.rel + ' [only in installed]';
      if (d.kind === 'only-in-marketplace') return d.rel + ' [only in marketplace clone]';
      return d.rel;
    });
    const moreNote = diffs.length > MAX_DIFFS_REPORTED ? ' (+' + (diffs.length - MAX_DIFFS_REPORTED) + ' more)' : '';
    return {
      status: 'diverged',
      files: diffs.map((d) => d.rel),
      message: 'install-divergence: installed cache v' + installedVersion + ' DIFFERS from the marketplace clone at the SAME version — ' + diffs.length + ' file(s) differ: ' + shown.join(', ') + moreNote + sizeNote + '. The cache dir for this version was populated before the final code landed, and syncCache (update.js) never overwrites an existing cache/<version>/ dir — a version bump is required for this install to pick up the fix.',
    };
  } catch (e) {
    return { status: 'unknown', message: 'install-divergence check raised (fail-open): ' + (e && e.message) };
  }
}

// resolveInstallScope(home, installedRoot, F) -> 'user' | 'project' | null.
// Cheap best-effort lookup against installed_plugins.json (HARNESS-OWNED —
// read only, never written) — matches the entry whose installPath resolves
// to installedRoot. null (unknown) whenever the file/entry/match is absent;
// callers must word their message so it stays accurate either way.
function resolveInstallScope(home, installedRoot, F) {
  try {
    const data = JSON.parse(F.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const reg = (data && data.plugins && typeof data.plugins === 'object') ? data.plugins : data;
    const entry = reg && reg['anti-hall@anti-hall'];
    const list = Array.isArray(entry) ? entry : (entry ? [entry] : []);
    const target = path.resolve(installedRoot);
    for (const e of list) {
      if (e && typeof e.installPath === 'string' && path.resolve(e.installPath) === target) {
        return (e.scope === 'user' || e.scope === 'project') ? e.scope : null;
      }
    }
    return null;
  } catch (_) { return null; }
}

/**
 * monitorsJsonPresenceCheck({installedRoot, home, fsi}) -> {status, message}
 * status: 'present' | 'missing' | 'unknown'.
 *
 * Reports whether monitors/monitors.json exists in the INSTALLED plugin root
 * (not the repo/clone) — the mechanical `when:"always"` arming manifest. A
 * project-scope install NEVER loads background monitors at all (docs/KB-
 * claude-monitor-tool.md:619-623) regardless of whether the file is present,
 * so a missing file there is expected, not a failure — the message reflects
 * scope when it is cheaply resolvable and stays accurate when it is not.
 * REPORT ONLY. FAIL OPEN: never throws.
 */
function monitorsJsonPresenceCheck(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  try {
    const installedRoot = o.installedRoot;
    if (!installedRoot) return { status: 'unknown', message: 'monitors.json check: installed plugin root not resolvable — skipped' };
    const p = path.join(installedRoot, 'monitors', 'monitors.json');
    let present = false;
    try { present = F.statSync(p).isFile(); } catch (_) { present = false; }
    const home = o.home || os.homedir();
    const scope = resolveInstallScope(home, installedRoot, F);
    if (present) {
      return { status: 'present', message: 'monitors.json present in the installed plugin root — the mechanical when:"always" arming path is available' + (scope ? ' (scope: ' + scope + ')' : '') };
    }
    if (scope === 'project') {
      return {
        status: 'missing',
        message: 'monitors.json not present in the installed plugin root (project-scope install — background monitors are never loaded for project-scope installs regardless, per docs/KB-claude-monitor-tool.md; this absence is expected, not a failure). Only the cron fallback and the instructional directive remain.',
      };
    }
    return {
      status: 'missing',
      message: 'monitors.json not present in the installed plugin root (' + p + ') — the mechanical when:"always" arming path is unavailable for this install; only the cron fallback and the instructional directive remain. (If this is a project-scope install, that absence is expected — project-scope installs never load background monitors at all.)',
    };
  } catch (e) {
    return { status: 'unknown', message: 'monitors.json check raised (fail-open): ' + (e && e.message) };
  }
}

// ---------------------------------------------------------------------------
// version-mismatch (companion surface for hooks/devswarm-version.js) — reads
// the SAME cache file the SessionStart hook writes (~/.anti-hall/
// devswarm-version.json) so `/anti-hall:doctor` surfaces the drift alarm too,
// without re-probing (no spawn from inside doctor). REPORT ONLY, fail-open:
// an absent/malformed cache or a DevSwarm-absent probe is never a FAIL — only
// a genuine version mismatch against the baseline is WARN.
// ---------------------------------------------------------------------------
const DEVSWARM_VERSION_CACHE = 'devswarm-version.json';

// readDevswarmVersionCache(home, F) -> parsed cache object | null (absent/malformed).
function readDevswarmVersionCache(home, F) {
  try {
    const raw = F.readFileSync(path.join(home, '.anti-hall', DEVSWARM_VERSION_CACHE), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) {
    return null;
  }
}

// versionMismatchCheck({home, fsi}) -> {status, message}. Mirrors the
// additionalContext wording hooks/devswarm-version.js emits (reuses the SAME
// classifyVersionDrift() helper), so the doctor line and the SessionStart
// nudge never drift apart in phrasing OR in what counts as a mismatch.
//
// Compares against DEVSWARM_BASELINE (the one authoritative constant — see
// hooks/lib/devswarm-baseline.js), NOT cache.baseline: the cache is just a
// probe result written by a background script that may be running an older
// build of that script, so treating its copy as authoritative would reopen
// exactly the drift this fix closes.
//
// No cache yet is NOT a warning — it's the expected state on every DevSwarm
// machine before the first background refresh lands (SessionStart spawns it
// detached; doctor never re-probes). Only a genuine major/minor mismatch is
// WARN; patch-only drift and an absent/unparseable install are PASS.
function versionMismatchCheck(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;
  try {
    const cache = readDevswarmVersionCache(home, F);
    if (!cache) {
      return { status: PASS, message: 'devswarm-version: no cache yet (~/.anti-hall/devswarm-version.json) — populates on next SessionStart' };
    }
    if (cache.installed === null || typeof cache.installed !== 'string' || !cache.installed) {
      return { status: PASS, message: 'devswarm-version: DevSwarm CLI not detected on this machine — nothing to compare (anti-hall works without it)' };
    }
    const drift = classifyVersionDrift(cache.installed, DEVSWARM_BASELINE);
    if (!drift.advise) {
      return { status: PASS, message: 'devswarm-version: DevSwarm ' + cache.installed + ' matches anti-hall\'s verified baseline (' + DEVSWARM_BASELINE + ')' };
    }
    const suffix = drift.reason === 'older' ? ' (newer)' : '';
    return {
      status: WARN,
      message: 'devswarm-version: DevSwarm ' + cache.installed + ' installed; anti-hall\'s integration is verified against ' +
        DEVSWARM_BASELINE + suffix + ' — behavior may have drifted, see docs/KB-devswarm-hivecontrol.md',
    };
  } catch (e) {
    return { status: WARN, message: 'devswarm-version check raised (fail-open): ' + (e && e.message) };
  }
}

// capabilitiesCheck({home}) -> {status, message}. v0.108.0: reads the
// capability gate's cache (companion/lib/devswarm-capabilities.js) — NO spawn —
// and lists every feature put to sleep because this DevSwarm build lacks its
// surface ("feature X needs DevSwarm >= Y, you have Z"). A sleeping feature is
// expected on an older DevSwarm, so this is PASS (informational), never WARN.
function capabilitiesCheck(opts) {
  const o = opts || {};
  const lines = require('./devswarm-capabilities.js').dormantLines(o.home || os.homedir());
  if (!lines.length) return { status: PASS, message: 'devswarm-capabilities: no dormant features recorded' };
  return { status: PASS, message: 'devswarm-capabilities: ' + lines.length + ' dormant feature(s) — ' + lines.join('; ') };
}

// legacyCursorShapeLeftovers(home) -> [names]. REPORT-ONLY (defect
// 8b211241bbe9, R3 item 3). Earlier development builds of the per-instance
// cursor feature used dot separators (`<id>.inst-<6hex>.json`,
// `<id>.base.json`); the shipped form uses `#`, which no workspace id can
// contain. A home that ran one of those builds still holds the old files. They
// are inert — nothing reads them — but they are indistinguishable by eye from a
// real workspace's own cursor, so doctor NAMES them and never deletes them: a
// `<id>.base.json` may equally be the legacy cursor of a workspace genuinely
// called `<id>.base`, and deleting that would destroy a live read position.
function legacyCursorShapeLeftovers(home, F) {
  const out = [];
  try {
    const dir = path.join(devswarmRoot(home), 'cursors');
    const names = (F || fs).readdirSync(dir);
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      if (n.includes('#')) continue;                 // current shape
      if (/\.seen-/.test(n)) continue;               // shipped watermark namespace
      if (/\.inst-[0-9a-f]{6}\.json$/.test(n) || /\.base\.json$/.test(n)) out.push(n);
    }
  } catch (_) { return out; } // fail-open: unreadable dir -> nothing to report
  out.sort();
  return out;
}
// cursorHygieneCheck({ home, env, cwd, now, devswarmPath }) -> a doctor result.
// defect 8b211241bbe9 — the DOCTOR half of the per-instance-cursor forward
// migration (the persisted-shape rule requires the same idempotent, fail-open,
// no-delete pass in BOTH update.js and doctor, so an installation that never
// runs the updater still converges).
//
// REPORT-ONLY here: it runs the pass in dryRun mode and reports what WOULD be
// removed. The repair path (doctor --repair) applies it for real. Nothing is
// deleted by a plain `doctor` run.
function cursorHygieneCheck(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  try {
    const devswarmPath = o.devswarmPath
      || path.join(__dirname, '..', '..', 'scripts', 'devswarm.js');
    let devswarm = null;
    try { devswarm = o.devswarm || require(devswarmPath); } catch (_) { devswarm = null; }
    if (!devswarm || typeof devswarm.gcInstanceCursors !== 'function') {
      return { status: PASS, message: 'per-instance cursor hygiene: not applicable (this build has no gcInstanceCursors)' };
    }
    const r = devswarm.gcInstanceCursors(null, home, {
      env: o.env, cwd: o.cwd, now: o.now, dryRun: true,
    }) || {};
    const errCount = Array.isArray(r.errors) ? r.errors.length : (r.errors || 0);
    // Phase 3: legacy per-instance files are inert and NEVER removed (the GC is
    // report-only); `verb` names what the pre-Phase-3 pass would have removed.
    const verb = 'legacy, inert — would previously have removed';
    // Phase 3 one-time reader_cursors import — the doctor half (update.js runs
    // the other). Plain doctor: dry path only (zero writes, the R1 item-15
    // lesson). --repair: imports (idempotent, no delete, fail-open).
    let importNote = '';
    if (typeof devswarm.importReaderCursorsAllStores === 'function') {
      try {
        const env = Object.assign({}, o.env || process.env);
        const ir = devswarm.importReaderCursorsAllStores(home, { env, cwd: o.cwd, now: o.now, dryRun: !o.repair }) || {};
        importNote = ir.dryRun
          ? ' — reader_cursors import: ' + (ir.wouldImport || 0) + ' partition(s) not yet imported (run doctor --repair, or they import lazily on first ack)'
          : ' — reader_cursors import: imported ' + (ir.imported || 0) + ' partition(s)';
        if (ir.errors) importNote += ' (' + ir.errors + ' error(s), fail-open)';
      } catch (e) {
        importNote = ' — reader_cursors import unavailable: ' + (e && e.message);
      }
    }
    // v0.106.1 floors pinned by the v0.106.0 import — REPORT only here (dry run,
    // zero writes); doctor --repair applies it through the migration registry
    // ('repair-reader-floors'), update.js through its 'reader-floor-repair' stage.
    if (typeof devswarm.repairReaderFloorsAllStores === 'function') {
      try {
        const rr = devswarm.repairReaderFloorsAllStores(home, { env: Object.assign({}, o.env || process.env), cwd: o.cwd, now: o.now, dryRun: true }) || {};
        if (rr.pending) importNote += ' — reader floors pinned by the v0.106.0 import: ' + rr.pending + ' partition(s) (run doctor --repair or /anti-hall:update)';
        if (rr.errors) importNote += ' (floor check: ' + rr.errors + ' error(s), fail-open)';
      } catch (e) {
        importNote += ' — reader floor check unavailable: ' + (e && e.message);
      }
    }
    // defect #10 follow-up — REPORT only here (dry run, zero writes); doctor
    // --repair applies it through the migration registry
    // ('merge-split-backend-stores'), update.js through its matching stage.
    if (typeof devswarm.mergeSplitBackendStoresAllStores === 'function') {
      try {
        const ms = devswarm.mergeSplitBackendStoresAllStores(home, { env: Object.assign({}, o.env || process.env), cwd: o.cwd, now: o.now, dryRun: true }) || {};
        if (ms.splitStores) importNote += ' — split stores found: ' + ms.splitStores + ' (run doctor --repair / update)';
        if (ms.errors) importNote += ' (split-store check: ' + ms.errors + ' error(s), fail-open)';
      } catch (e) {
        importNote += ' — split-store check unavailable: ' + (e && e.message);
      }
    }
    // Report-only: old-shape leftovers from a pre-release dev build.
    const legacyShapes = legacyCursorShapeLeftovers(home, o.fsi);
    const legacyNote = legacyShapes.length
      ? ' — also found ' + legacyShapes.length + ' pre-release cursor file(s) in the old dot shape ('
        + legacyShapes.slice(0, 3).join(', ') + (legacyShapes.length > 3 ? ', …' : '')
        + '); these are inert and are NEVER deleted automatically, since such a name can equally belong to a real workspace'
      : '';
    if (errCount) {
      return {
        status: WARN,
        message: 'per-instance cursor hygiene: ' + errCount + ' file(s) could not be swept (fail-open) — scanned '
          + (r.scanned || 0) + ', ' + verb + ' ' + ((r.deleted || 0) + (r.evicted || 0)) + legacyNote + importNote,
      };
    }
    // A large number of instance files for one id means many distinct process
    // identities have read that partition and none have aged out yet — worth
    // surfacing, since a file pinning the floor holds the shared cursor back.
    return {
      status: PASS,
      message: 'per-instance cursor hygiene: scanned ' + (r.scanned || 0) + ', ' + verb + ' '
        + (r.deleted || 0) + ' subsumed + ' + (r.evicted || 0) + ' stale, kept ' + (r.kept || 0) + legacyNote + importNote,
    };
  } catch (e) {
    return { status: WARN, message: 'per-instance cursor hygiene unavailable: ' + (e && e.message) };
  }
}

// escalationIntentsCheck({home, now, fsi}) -> one result. READ-ONLY: lists the
// supervisor escalation notices still PARKED (undelivered — WARN, with the child
// ids and what to run) and counts the delivered records, with the oldest ages.
// Nothing is ever removed automatically (one file per child id bounds storage).
function escalationIntentsCheck(opts) {
  const o = opts || {};
  const st = require('./recovery.js').escalationIntentStats(o.home, o.now, o.fsi);
  const age = (ms) => (ms == null ? 'n/a' : (ms < 3600000 ? Math.round(ms / 60000) + 'm' : (ms < 86400000 ? Math.round(ms / 3600000) + 'h' : Math.round(ms / 86400000) + 'd')));
  const tail = st.delivered + ' delivered record(s) kept (oldest ' + age(st.oldestDeliveredAgeMs) + '; never removed automatically)';
  if (!st.undelivered) return { status: PASS, message: 'escalation-pending: 0 undelivered; ' + tail };
  const kids = st.undeliveredIds.map((x) => x.childId + ' -> ' + x.parentId + (x.lastStatus ? ' (' + x.lastStatus + ')' : '')).join(', ');
  return {
    status: WARN,
    message: 'escalation-pending: ' + st.undelivered + ' undelivered supervisor escalation(s) (oldest ' + age(st.oldestUndeliveredAgeMs) + '): ' + kids
      + ' — the Primary is not registered in the mesh store (run `devswarm.js register-primary`); the supervisor retries every sweep. ' + tail,
    escalationIntents: st,
  };
}

// appDbChecks({ home, env, now, fsi }) -> results[]. v0.108.0 REPORT-ONLY view of
// the DevSwarm desktop app's database (companion/lib/devswarm-app-db.js) plus
// the supervisor's last app sync (<devswarm>/app-state.json):
//   - app version + snapshot health; "DevSwarm app schema changed: <col>" for
//     every pinned column/table the live DB no longer has (the reader degrades
//     fail-open, this line says which feature went quiet); capability-gated reads
//   - a freshly spawned workspace whose brief was not delivered / was withheld
//   - drift: open in the app but unknown to anti-hall; open in the app but
//     archived in anti-hall (conflict — never auto-unarchived)
//   - message-loss cross-check (counts only): gaps to live targets
//   - entries the app has scheduled for deletion (names only)
// Silent when there is no app DB at all. Never throws, never writes.
const APP_STATE_STALE_MS = 15 * 60 * 1000;
function appDbChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const F = o.fsi || fs;
  const cwd = o.cwd || process.cwd();
  const out = [];
  let appDb;
  try { appDb = require('./devswarm-app-db.js'); } catch (_) { return out; }
  const file = appDb.appDbPath({ home, env });
  let exists = false;
  try { exists = !!file && F.statSync(file).isFile(); } catch (_) { exists = false; }
  if (!exists) return out; // no DevSwarm app here: app-DB features are simply dormant
  const snap = appDb.snapshot({ home, env, now, fresh: true });
  if (!snap) {
    out.push({ status: WARN, message: 'DevSwarm app DB present but unreadable (builders.id/isActive missing, capability-gated, or locked) — app-DB features dormant; anti-hall falls back to hivecontrol/absence rules' });
    return out;
  }
  const active = snap.workspaces.filter((w) => w.active);
  out.push({ status: PASS, message: 'DevSwarm app DB ' + (snap.appVersion || '(version unknown)') + ': ' + snap.workspaces.length + ' builders, ' + active.length + ' open' });
  if (snap.missing.length) out.push({ status: WARN, message: 'DevSwarm app schema changed: ' + snap.missing.join(', ') + ' — the dependent app-DB features are dormant until anti-hall is updated for it' });
  if (snap.gated && snap.gated.length) out.push({ status: WARN, message: 'DevSwarm app-DB reads capability-gated (dormant): ' + snap.gated.join(', ') });
  const briefs = [];
  for (const w of active) {
    const b = appDb.briefDelivery(snap, w, now);
    if (b && (b.status === 'not-delivered' || b.status === 'withheld')) briefs.push((w.label || w.id) + ' (' + String(w.id).slice(0, 8) + '): brief ' + b.status);
  }
  if (briefs.length) out.push({ status: WARN, message: 'DevSwarm spawn delivery: ' + briefs.join('; ') + ' — the child never received its task; resend it (`devswarm.js send --to <id>`)' });
  let st = null;
  try { st = JSON.parse(F.readFileSync(path.join(devswarmRoot(home), 'app-state.json'), 'utf8')); } catch (_) { st = null; }
  if (!st) {
    out.push({ status: WARN, message: 'DevSwarm app sync: no app-state.json yet — the supervisor sweep has not run the app-DB sync (install/enable the supervisor, or run `devswarm.js app-sync`)' });
    return out;
  }
  const age = now - Number(st.at);
  if (!(age >= 0 && age <= APP_STATE_STALE_MS)) out.push({ status: WARN, message: 'DevSwarm app sync: last run ' + (Number.isFinite(age) ? Math.round(age / 60000) + 'm ago' : 'unknown') + ' — the supervisor sweep is not running it' });
  if (Array.isArray(st.unknownToAntiHall) && st.unknownToAntiHall.length) {
    out.push({ status: WARN, message: 'open in the DevSwarm app but unknown to anti-hall (no descriptor): ' + st.unknownToAntiHall.map((u) => (u.label || u.id) + ' (' + String(u.id).slice(0, 8) + ')').join('; ') });
  }
  if (Array.isArray(st.openButMarkedArchived) && st.openButMarkedArchived.length) {
    // P1 fix (same scoping as hooks/devswarm-parent-inbox.js): openButMarkedArchived
    // is HOME-GLOBAL (every repo the app knows about), so scope it to THIS repo
    // before reporting — otherwise `doctor` warns about conflicts in other repos.
    // Resolve the current repositoryId through the canonical toplevel resolver
    // (identity.js resolveContext) + the existing app-DB reader
    // (repositoryForWorktree) — no new fs-walk. Fail CLOSED: an entry lacking
    // repositoryId (written by 0.108.0-0.108.2) or an unresolvable current repo
    // never matches, so it is never reported here.
    let curRepoId = null;
    try {
      const gitTop = require('./identity.js').resolveContext(cwd, { home, missingPath: 'ancestor' }).worktreeRoot;
      const repo = (gitTop && snap) ? appDb.repositoryForWorktree(snap, gitTop) : null;
      curRepoId = (repo && repo.id != null) ? String(repo.id) : null;
    } catch (_) { curRepoId = null; }
    const scopedConflicts = curRepoId
      ? st.openButMarkedArchived.filter((u) => u && u.repositoryId != null && String(u.repositoryId) === curRepoId)
      : [];
    if (scopedConflicts.length) {
      out.push({ status: WARN, message: 'open in the DevSwarm app but archived in anti-hall (stale marker — the app is right; the next app-DB sync retires it, `doctor --repair` does it now): ' + scopedConflicts.map((u) => (u.label || u.id) + ' (' + String(u.id).slice(0, 8) + ')').join('; ') });
    }
  }
  if (st.gaps && Array.isArray(st.gaps.repos)) {
    const gapRepos = st.gaps.repos.filter((r) => r.gap > 0);
    if (gapRepos.length) {
      out.push({
        status: WARN,
        message: 'DevSwarm message cross-check (report only): ' + gapRepos.map((r) => (r.name || r.repositoryId) + ' ' + r.gap + ' app message(s) to live targets never ingested ['
          + Object.entries(r.byBranch || {}).map(([b, v]) => b + ': ' + v.n + (v.lt1d ? ', ' + v.lt1d + ' in the last day' : '')).join('; ') + ']').join('; ')
          + ' — archived targets and pre-ingest history excluded',
      });
    } else {
      out.push({ status: PASS, message: 'DevSwarm message cross-check: no gaps to live targets' });
    }
  }
  if (Array.isArray(st.scheduledForDeletion) && st.scheduledForDeletion.length) {
    out.push({ status: PASS, message: 'DevSwarm app has ' + st.scheduledForDeletion.length + ' entr' + (st.scheduledForDeletion.length === 1 ? 'y' : 'ies') + ' scheduled for deletion (report only): ' + st.scheduledForDeletion.slice(0, 10).join(', ') });
  }
  return out;
}

function runChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  const descriptors = readDescriptors(home, F);
  const active = isDevswarmActive(env) || descriptors.length > 0;
  if (!active) return { active: false, results: [] };

  const results = selfTest(home, F);
  results.push(...wakeMonitorChecks(home, env, cwd));
  try {
    results.push(versionMismatchCheck({ home, fsi: F }));
  } catch (e) {
    results.push({ status: WARN, message: 'devswarm-version check unavailable: ' + (e && e.message) });
  }
  try {
    results.push(capabilitiesCheck({ home }));
  } catch (e) {
    results.push({ status: WARN, message: 'devswarm-capabilities check unavailable: ' + (e && e.message) });
  }
  // defect 8b211241bbe9 — the doctor half of the per-instance-cursor forward
  // migration. Report-only unless doctor is running in repair mode.
  try {
    results.push(cursorHygieneCheck({ home, env, cwd, now, repair: !!o.repair }));
  } catch (e) {
    results.push({ status: WARN, message: 'per-instance cursor hygiene unavailable: ' + (e && e.message) });
  }
  try {
    results.push(escalationIntentsCheck({ home, now, fsi: F }));
  } catch (e) {
    results.push({ status: WARN, message: 'escalation-pending check unavailable: ' + (e && e.message) });
  }
  // Message retention (devswarm-retention.js): store size vs limit, protected-
  // over-limit stores, archive cap, first-run dry-run pending. Read-only.
  try {
    results.push(...require('./devswarm-retention.js').doctorCheck({ home, env }));
  } catch (e) {
    results.push({ status: WARN, message: 'message retention check unavailable: ' + (e && e.message) });
  }

  // v0.108.0 DevSwarm app-DB view (report-only, silent without an app DB).
  try {
    for (const r of appDbChecks({ home, env, now, fsi: F, cwd })) results.push(r);
  } catch (e) {
    results.push({ status: WARN, message: 'DevSwarm app-DB check unavailable: ' + (e && e.message) });
  }

  // Phase 5 delivery WAL health (report-only): pending batches past the
  // age/size threshold, spilled batches (WAL unwritable -> reads blocked), or an
  // unreadable WAL. Never drops anything.
  try {
    const walHealth = require('./devswarm-read-wal.js').health(F, home, now);
    const alerts = walHealth.filter((h) => h.alert);
    if (alerts.length) {
      for (const a of alerts) results.push({ status: WARN, message: 'delivery WAL ' + a.file + ': ' + a.reason });
    } else {
      results.push({ status: PASS, message: 'delivery WAL: nothing stuck (' + walHealth.length + ' reader(s) with open batches)' });
    }
  } catch (e) {
    results.push({ status: WARN, message: 'delivery WAL health unavailable: ' + (e && e.message) });
  }

  // Descriptor-store integrity (companion/lib/doctor-descriptors.js): a
  // REPORT-ONLY scan for malformed ids and for archived ids that strict-prefix a
  // live one (the phantom-roster-row signature). It lives in its own module
  // because it reads descriptors RAW — including the malformed ones
  // readDescriptors() above deliberately filters out, which is precisely why
  // nothing caught this before. Fail-open: a raising scan never breaks doctor,
  // and it never mutates the store.
  try {
    for (const r of descriptorChecks({ home, fsi: F })) results.push(r);
  } catch (e) {
    results.push({ status: WARN, message: 'descriptor integrity scan unavailable: ' + (e && e.message) });
  }

  // item 4b (P0, field-proven): resolved ONCE for the whole descriptor loop
  // below (pure fs reads — see devswarm-version-check.js's own header), not
  // once per workspace.
  let newestAntiHallVersion = null;
  try { newestAntiHallVersion = versionCheck.newestKnownAntiHallVersion({ env, home }); } catch (_) { newestAntiHallVersion = null; }

  // Per-real-workspace readout from persisted verdicts, plus a distinct
  // listener-presence line (evidence something is consuming the inbox — see
  // listenerPresenceFor above) so a combined-verdict PASS can't hide a wedged
  // consumer that just hasn't been swept as stale yet.
  //
  // PRIMARY-ROW EXCLUSION (item F.2, v0.107.1 field report): a `register-
  // primary`-registered `primary-<hash>` descriptor is not a child workspace
  // — it structurally has no `nudgeCommand`, so devswarm-supervisor.js's
  // sweep now excludes it from pokeOrEscalate entirely (see that file's own
  // header on this same fix). Read-side must match: `statusForVerdict`
  // mapping 'escalated'/'stale' to FAIL/WARN was written for CHILD rows and
  // misclassifies a Primary's own row the same way (observed live: `workspace
  // primary-<id>: escalated (nudgeAttempts=0)` for an actively-draining
  // Primary that was never nudged because there was never a nudgeCommand to
  // fire). A primary row is reported via listener-presence ONLY (still
  // useful — proves something is consuming its inbox); its nudge/escalate
  // verdict, if any (possibly stale from before this fix), is surfaced as an
  // informational note, NEVER as FAIL/WARN, and — in `--repair` mode — the
  // stale verdict file is cleared (idempotent: a missing file is a no-op) so
  // it stops being read as terminal 'escalated' state on the next tick.
  let primaryIdFor = null;
  try { primaryIdFor = require('../install-devswarm-ingest.js').primaryWorkspaceId; } catch (_) { primaryIdFor = null; }
  for (const d of descriptors) {
    const isPrimaryRow = !!(primaryIdFor && d.worktreePath
      && (() => { try { return String(d.id) === String(primaryIdFor(d.worktreePath)); } catch (_) { return false; } })());

    let verdict = null;
    try { verdict = JSON.parse(F.readFileSync(livenessPathFor(d.id, home), 'utf8')); } catch (_) {}

    if (isPrimaryRow) {
      if (verdict && (verdict.status === 'escalated' || verdict.status === 'nudged')) {
        results.push({
          status: PASS,
          message: 'workspace ' + d.id + ': Primary row — nudge/escalate does not apply (no nudgeCommand); '
            + 'stale verdict "' + verdict.status + '" ignored'
            + (o.repair ? '; cleared' : ' (run doctor --repair to clear it)'),
        });
        if (o.repair) {
          try { F.unlinkSync(livenessPathFor(d.id, home)); } catch (_) { /* already gone / unwritable — fail-open */ }
        }
      }
      // else: no verdict, or a benign 'alive'/'stale' snapshot — nothing to say.
    } else if (!verdict) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ': no liveness verdict yet (sweep has not run)' });
    } else {
      const status = statusForVerdict(verdict);
      results.push({
        status,
        message: 'workspace ' + d.id + ': ' + verdict.status + ' (nudgeAttempts=' + (verdict.nudgeAttempts || 0) + ')',
      });
    }
    try {
      results.push(listenerPresenceFor(d, now, F));
    } catch (e) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (check raised: ' + (e && e.message) + ')' });
    }
    // item 4b — stale anti-hall BUILD detection: a child heartbeating an
    // OLDER anti-hall version (item 4a's recorded field) than the newest one
    // known on this machine gets its own explicit line naming the fix
    // (restart, or drain with the newest CLI path) — the real cause of a
    // "not-draining"-looking workspace can be a stale build the roster/
    // parent-inbox already relabel accordingly (see devswarm-parent-inbox.js).
    // Silent (no line at all) when unknown/current — never a false positive
    // over a legacy pre-item-4a heartbeat record (null version) or an
    // unresolvable newest version.
    try {
      if (newestAntiHallVersion) {
        const hbVersion = heartbeatVersion(d.id, home, F);
        if (versionCheck.isVersionStale(hbVersion, newestAntiHallVersion)) {
          const cliPath = versionCheck.newestCliPath({
            env, home, newestVersion: newestAntiHallVersion, segments: ['scripts', 'devswarm.js'],
          });
          results.push({
            status: WARN,
            message: 'workspace ' + d.id + ': ' + versionCheck.staleAntiHallMessage(hbVersion, newestAntiHallVersion, cliPath),
          });
        }
      }
    } catch (e) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ' stale-build check unavailable: ' + (e && e.message) });
    }
  }
  return { active: true, results };
}

module.exports = {
  PASS, WARN, FAIL, statusFor, statusForVerdict, listenerPresenceFor, runChecks,
  // wake-monitor (Monitor-based idle-wake) — exported individually for tests.
  wakeMonitorShipped, wakeMonitorSelfTest, wakeMonitorLiveCheck, wakeMonitorChecks,
  // version-mismatch (companion surface for hooks/devswarm-version.js) — exported for tests.
  versionMismatchCheck, capabilitiesCheck,
  // per-instance cursor hygiene (defect 8b211241bbe9) — exported for tests.
  cursorHygieneCheck, legacyCursorShapeLeftovers,
  // parked supervisor escalation notices (read-only).
  escalationIntentsCheck,
  // v0.108.0 DevSwarm app-DB view (read-only).
  appDbChecks,
  // install-vs-source integrity (CHECK 1/CHECK 2) — exported individually for tests.
  installDivergenceCheck, monitorsJsonPresenceCheck, resolveMarketplaceDir, resolveInstallScope,
  collectShippedFiles,
};

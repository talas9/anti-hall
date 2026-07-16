'use strict';
// anti-hall :: doctor-runtime — DevSwarm RUNTIME health checks, as a pure,
// testable module (mirrors companion/lib/doctor-devswarm.js's require-and-call
// pattern: doctor.js requires this and calls it IN-PROCESS).
//
// Five checks. 1-4 are wired into doctor.js's existing DevSwarm section (same
// gate: isDevswarmActive(env) || descriptors present). 5 is UNCONDITIONAL (its
// own top-level doctor section) — a foreign hook/skill conflict can matter even
// when DevSwarm itself is dormant.
//
//   1. checkDbHealth        — store/devswarm.db quick_check (sqlite) + journal
//                              torn-line scan + store<->summary parity.
//   2. checkDataStaleness   — summary.json staleness, gated on daemon RUNNING
//                              (check 3) + unread>0 (never flags an idle system).
//   3. checkDaemonsRunning  — ingest (per-worktree) + supervisor RUNNING, not
//                              just installed. REPORT-ONLY (never restarts).
//   4. checkNoOtherConsumer — a second native `hivecontrol workspace monitor`
//                              consumer would split the destructive queue.
//                              REPORT-ONLY (never kills — see devswarm-ingest.js's
//                              single-consumer invariant).
//   5. scanForeignConflicts — other ENABLED plugins' hooks.json / skill names
//                              cross-referenced against anti-hall's own, for
//                              competing PreToolUse/Stop hooks and skill-name
//                              collisions. PRIVACY: reports plugin name + event +
//                              matcher + hook BASENAME only — never full command
//                              strings (which can carry a local username/path)
//                              or file contents.
//
// All five are fail-open: a probe error becomes one WARN/INFO result line, never
// a throw — doctor.js must never crash because a runtime probe couldn't run.
// Pure Node >= 18 built-ins, cross-platform (Windows reports 'unknown'/no-op
// for the process/scheduler-introspection pieces that have no built-in
// equivalent there — same documented posture as the installers themselves).

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { devswarmRoot } = require('./liveness.js');
const store = require('./devswarm-store.js');

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const INFO = 'INFO'; // neutral "not installed / not applicable" — never a warning

// Generous freshness windows vs the ingest daemon's ~3s monitor-poll cadence
// (devswarm-ingest.js's DEFAULT_MONITOR_INTERVAL_SEC) — a live-but-quiet daemon
// must never false-read as dead/stale just because nothing happened to insert.
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;
const STALE_GENERATED_AT_MS = 5 * 60 * 1000;

function errMsg(e) { return (e && e.message) ? e.message : String(e); }

// ---------------------------------------------------------------------------
// check 1: DB/store health
// ---------------------------------------------------------------------------

// SQLITE_PROBE_SCRIPT — run in a CHILD process launched with --no-warnings so
// `require('node:sqlite')`'s ExperimentalWarning never reaches doctor's own
// stderr. Opens a SEPARATE read-only handle: WAL allows concurrent readers, so
// this can never block the ingest daemon (its single-consumer lock is a
// distinct O_EXCL lockfile — see devswarm-ingest.js's ingestLockPath — not a DB
// lock). Emits one JSON line: quick_check rows + a per-workspace message count
// (for the store<->summary parity check below), or {ok:false, error}.
const SQLITE_PROBE_SCRIPT = [
  'try {',
  '  const { DatabaseSync } = require("node:sqlite");',
  '  const db = new DatabaseSync(process.argv[1], { readOnly: true });',
  '  const quickCheck = db.prepare("PRAGMA quick_check;").all();',
  '  let counts = {};',
  '  try {',
  '    const rows = db.prepare("SELECT workspace_id AS id, COUNT(*) AS c FROM messages GROUP BY workspace_id;").all();',
  '    for (const r of rows) counts[String(r.id)] = Number(r.c);',
  '  } catch (_) {}',
  '  db.close();',
  '  process.stdout.write(JSON.stringify({ ok: true, quickCheck, counts }));',
  '} catch (e) {',
  '  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));',
  '}',
].join('\n');

function runSqliteProbe(dbPath, opts) {
  const o = opts || {};
  const execPath = o.execPath || process.execPath;
  const spawn = o.spawnSync || cp.spawnSync;
  try {
    const r = spawn(execPath, ['--no-warnings', '-e', SQLITE_PROBE_SCRIPT, '--', dbPath], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.error) return { ok: false, error: errMsg(r.error) };
    const out = String(r.stdout || '').trim();
    if (!out) return { ok: false, error: 'sqlite probe produced no output' + (r.stderr ? (' (stderr: ' + String(r.stderr).slice(0, 200) + ')') : '') };
    const parsed = JSON.parse(out);
    return (parsed && typeof parsed === 'object') ? parsed : { ok: false, error: 'malformed sqlite probe output' };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// scanJournalTornLinesIn(journalDirPath, F) — count non-TRAILING torn
// (unparseable) lines per messages.ndjson-family file in a specific journal dir.
// The trailing raw-split element is ALWAYS excluded (whether it's the well-formed
// '' remnant of a proper trailing '\n', or a genuinely in-flight last write with
// no trailing '\n' yet) — a mid-write line is expected, not corruption; only a
// torn line FOLLOWED by more valid content is real damage to the trail.
function scanJournalTornLinesIn(journalDirPath, F) {
  const f = F || fs;
  let files = [];
  try { files = f.readdirSync(journalDirPath).filter((n) => n.endsWith('.ndjson')); } catch (_) { return { checked: 0, torn: [] }; }
  const torn = [];
  for (const name of files) {
    let raw;
    try { raw = String(f.readFileSync(path.join(journalDirPath, name), 'utf8')); } catch (_) { continue; }
    const lines = raw.split('\n');
    const checkable = lines.slice(0, -1); // drop the trailing element (see above)
    let tornCount = 0;
    for (const line of checkable) {
      if (line.trim() === '') continue;
      try { JSON.parse(line); } catch (_) { tornCount++; }
    }
    if (tornCount > 0) torn.push({ file: name, count: tornCount });
  }
  return { checked: files.length, torn };
}

// enumerateStoreUnits(home, F) -> [{ label, dbPath, journalDirPath, summary }].
// The store is now PHYSICALLY PER-PROJECT (store/<hash>/devswarm.db + journal), so
// DB-health + parity ENUMERATE every per-project store rather than one global file.
// A LEGACY flat store (store/devswarm.db / store/journal, pre-migration) is also
// included so a not-yet-migrated user still gets a check. Fail-open: any read error
// yields the units it COULD enumerate.
function enumerateStoreUnits(home, F) {
  const f = F || fs;
  const units = [];
  // legacy flat store (pre-per-project). Its summary was the old global summary.json.
  const legacyDb = path.join(store.storeRootDir(home), 'devswarm.db');
  const legacyJournal = path.join(store.storeRootDir(home), 'journal');
  let legacyPresent = false;
  try { legacyPresent = f.statSync(legacyDb).isFile(); } catch (_) {}
  if (!legacyPresent) { try { legacyPresent = f.statSync(legacyJournal).isDirectory(); } catch (_) {} }
  if (legacyPresent) {
    units.push({
      label: 'legacy',
      dbPath: legacyDb,
      journalDirPath: legacyJournal,
      summary: (function () { try { const raw = String(f.readFileSync(path.join(devswarmRoot(home), 'summary.json'), 'utf8')); return raw.trim() ? JSON.parse(raw) : null; } catch (_) { return null; } })(),
    });
  }
  for (const hash of store.listStoreHashes(home, f)) {
    units.push({
      label: hash,
      dbPath: store.sqlitePathForHash(home, hash),
      journalDirPath: store.journalDirForHash(home, hash),
      summary: store.readSummaryForHash(home, hash, f),
    });
  }
  return units;
}

// checkDbHealth(home, opts) -> [{status, message}]. Report-only. Enumerates every
// per-project store.
function checkDbHealth(home, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const results = [];

  const units = enumerateStoreUnits(home, F);
  if (units.length === 0) return results; // no store on disk yet -> nothing to check

  for (const unit of units) {
    const tag = unit.label === 'legacy' ? 'legacy store' : ('store ' + unit.label);

    let dbExists = false;
    try { dbExists = F.statSync(unit.dbPath).isFile(); } catch (_) { dbExists = false; }

    let storeCounts = null; // per-workspace-id message totals, when derivable
    if (dbExists) {
      const probe = runSqliteProbe(unit.dbPath, { execPath: o.execPath, spawnSync: o.spawnSync });
      if (probe.ok) {
        const qc = Array.isArray(probe.quickCheck) ? probe.quickCheck : [];
        const healthy = qc.length === 1 && qc[0] && qc[0].quick_check === 'ok';
        results.push({
          status: healthy ? PASS : FAIL,
          message: 'sqlite ' + tag + ' quick_check: ' + (healthy ? 'ok' : JSON.stringify(qc)),
        });
        storeCounts = probe.counts || {};
      } else {
        results.push({ status: WARN, message: 'sqlite ' + tag + ' quick_check probe failed (fail-open): ' + probe.error });
      }
    }

    let journalFiles = [];
    try { journalFiles = F.readdirSync(unit.journalDirPath).filter((n) => n.endsWith('.ndjson')); } catch (_) { journalFiles = []; }
    if (journalFiles.length) {
      const scan = scanJournalTornLinesIn(unit.journalDirPath, F);
      if (scan.torn.length === 0) {
        results.push({ status: PASS, message: 'journal ' + tag + ': ' + scan.checked + ' file(s), no torn lines' });
      } else {
        const detail = scan.torn.map((t) => t.file + '(' + t.count + ')').join(', ');
        results.push({ status: WARN, message: 'journal ' + tag + ': torn line(s) found — ' + detail });
      }
    }

    // store<->summary parity: flag ONLY summary.total > store.total (a store
    // ahead of a not-yet-(re)derived summary is normal/benign, never flagged).
    const summary = unit.summary;
    if (summary && summary.workspaces && (dbExists || journalFiles.length)) {
      let jHandle = null;
      for (const id of Object.keys(summary.workspaces)) {
        const ws = summary.workspaces[id];
        const wsTotal = Number(ws && ws.total) || 0;
        let storeTotal = null;
        if (dbExists && storeCounts) {
          storeTotal = Object.prototype.hasOwnProperty.call(storeCounts, id) ? storeCounts[id] : 0;
        } else if (journalFiles.length) {
          try {
            if (!jHandle) jHandle = store.openStore({ home, backend: 'journal', dir: path.dirname(unit.journalDirPath), fsi: F });
            storeTotal = jHandle.messageCount(id);
          } catch (_) { storeTotal = null; }
        }
        if (storeTotal !== null && wsTotal > storeTotal) {
          results.push({
            status: WARN,
            message: 'workspace ' + id + ' (' + tag + '): summary total (' + wsTotal + ') > store total (' + storeTotal + ') — summary may be stale/ahead of the store',
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// check 3: daemons RUNNING (not just installed)
// ---------------------------------------------------------------------------

// probeLaunchdRunning — for a CONTINUOUS (KeepAlive) unit, e.g. the ingest
// daemon (install-devswarm-ingest.js's buildPlist sets KeepAlive:true): a live
// PID is the correct "running" signal.
function probeLaunchdRunning(label, opts) {
  const o = opts || {};
  const spawn = o.spawnSync || cp.spawnSync;
  try {
    const r = spawn('launchctl', ['list', label], { encoding: 'utf8', timeout: 5000 });
    if (r.error) return { known: false };
    if (r.status !== 0) return { known: true, running: false };
    return { known: true, running: /"PID"\s*=/.test(String(r.stdout || '')) };
  } catch (_) { return { known: false }; }
}

// probeLaunchdLoaded — for a PERIODIC (StartInterval, no KeepAlive) unit, e.g.
// the supervisor (install-devswarm-supervisor.js's buildPlist has NO KeepAlive
// key): it has no persistent PID between sweeps, so "loaded" (exit 0 from
// `launchctl list`) is the correct "still scheduled" signal — requiring a live
// PID here would false-WARN almost always.
function probeLaunchdLoaded(label, opts) {
  const o = opts || {};
  const spawn = o.spawnSync || cp.spawnSync;
  try {
    const r = spawn('launchctl', ['list', label], { encoding: 'utf8', timeout: 5000 });
    if (r.error) return { known: false };
    return { known: true, running: r.status === 0 };
  } catch (_) { return { known: false }; }
}

// probeSystemdActive — `systemctl --user is-active <unit>`. Used for BOTH the
// ingest .service (Type=simple, Restart=always — "active" IS running) and the
// supervisor's .timer (a timer's "active" state is its persistent
// waiting-to-fire state, not tied to the oneshot service's execution window —
// the correct periodic-unit signal, matching probeLaunchdLoaded's rationale).
function probeSystemdActive(unit, opts) {
  const o = opts || {};
  const spawn = o.spawnSync || cp.spawnSync;
  try {
    const r = spawn('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeout: 5000 });
    if (r.error) return { known: false };
    return { known: true, running: String(r.stdout || '').trim() === 'active' };
  } catch (_) { return { known: false }; }
}

// enumerateProcesses — POSIX-only process table snapshot (pid + full command).
// Used by both the cron-fallback running-probe and check 4 (no-other-consumer).
function enumerateProcesses(spawnSyncFn) {
  if (process.platform === 'win32') return { known: false, lines: [] };
  const spawn = spawnSyncFn || cp.spawnSync;
  try {
    const r = spawn('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
    if (r.error || typeof r.stdout !== 'string') return { known: false, lines: [] };
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    return { known: true, lines };
  } catch (_) { return { known: false, lines: [] }; }
}

// probeCronRunning — the cron fallback has no daemon manager to ask, so prefer
// the daemon's OWN liveness heartbeat (written every sweep regardless of
// inserts — devswarm-ingest.js's writeIngestHeartbeat/ingestHeartbeatPath), a
// truer signal than `ps` (which only proves A process exists, not that it is
// draining THIS worktree's queue).
//
// When a specific worktree hash is known, a bare `ps` scan for the ingest
// script's basename can NEVER be a correct fallback: every worktree's daemon
// shares the identical script path, so a dead cron unit for hash X would
// false-report RUNNING whenever ANY other worktree's ingest daemon happens to
// be alive. Instead, fall back to the per-worktree lock file's holder PID
// (devswarm-ingest.js's ingestLockPath — `locks/ingest-<hash>.lock`), which
// IS specific to this hash: only a live process actually holding THIS
// worktree's single-consumer lock counts as "running" for it.
// Only a hash-LESS (legacy, pre-per-worktree) unit falls back to the bare `ps`
// scan, matching its own pre-migration single-instance semantics.
function probeCronRunning(home, hash, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (hash != null) {
    try {
      const ingestMod = require('../devswarm-ingest.js');
      const hbPath = ingestMod.ingestHeartbeatPath(home, hash);
      const beat = JSON.parse(F.readFileSync(hbPath, 'utf8'));
      if (Number.isFinite(beat && beat.ts)) {
        return { known: true, running: (now - beat.ts) <= HEARTBEAT_FRESH_MS, via: 'heartbeat' };
      }
    } catch (_) { /* no heartbeat yet — fall through to the per-worktree lock */ }
    try {
      const lockPath = path.join(devswarmRoot(home), 'locks', 'ingest-' + hash + '.lock');
      const lock = JSON.parse(F.readFileSync(lockPath, 'utf8'));
      const pid = lock && lock.pid;
      if (Number.isFinite(pid)) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
        return { known: true, running: alive, via: 'lock' };
      }
    } catch (_) { /* no lock either — nothing worktree-specific to go on */ }
    return { known: true, running: false, via: 'none' };
  }
  const proc = enumerateProcesses(o.spawnSync);
  if (!proc.known) return { known: false };
  const running = proc.lines.some((l) => /devswarm-ingest\.js/.test(l));
  return { known: true, running, via: 'ps' };
}

// checkDaemonsRunning(home, opts) -> {results, anyRunning, units}. REPORT-ONLY
// — never restarts/reinstalls anything (that's doctor-repair.js's job, gated).
function checkDaemonsRunning(home, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const platform = o.platform || process.platform;
  const spawnSyncFn = o.spawnSync;
  const now = o.now;
  const env = o.env || process.env;
  const results = [];
  const runningByHash = {};

  if (platform === 'win32') {
    results.push({ status: INFO, message: 'daemon RUNNING probe: Windows has no built-in scheduler/process introspection (documented no-op — same posture as the installers)' });
    return { results, runningByHash, anyRunning: false, units: [] };
  }

  let installIngest = null;
  try { installIngest = require('../install-devswarm-ingest.js'); } catch (_) { installIngest = null; }
  let units = [];
  try { units = (installIngest && typeof installIngest.listInstalledIngestUnits === 'function') ? (installIngest.listInstalledIngestUnits({ home, platform }) || []) : []; } catch (_) { units = []; }

  for (const u of units) {
    const key = u.label || u.unit || '(unlabeled)';
    const where = u.workingDir || '(unknown worktree)';
    let probe;
    if (u.source === 'launchd') probe = probeLaunchdRunning(u.label, { spawnSync: spawnSyncFn });
    else if (u.source === 'systemd') probe = probeSystemdActive(u.unit, { spawnSync: spawnSyncFn });
    else if (u.source === 'cron') probe = probeCronRunning(home, u.hash, { fsi: F, now, spawnSync: spawnSyncFn });
    else probe = { known: false };

    if (u.hash != null) runningByHash[u.hash] = probe.known ? probe.running : null;

    if (!probe.known) {
      results.push({ status: WARN, message: 'ingest daemon (' + key + ', worktree ' + where + '): running-state unknown (probe failed, fail-open)' });
    } else if (probe.running) {
      results.push({ status: PASS, message: 'ingest daemon (' + key + ', worktree ' + where + '): RUNNING' });
    } else {
      results.push({ status: WARN, message: 'ingest daemon (' + key + ', worktree ' + where + '): installed but NOT running (dead) — from that worktree: node companion/install-devswarm-ingest.js' });
    }

    // v0.56.0: REPORT-ONLY config-drift flag (never fixes — that's
    // hooks/lib/doctor-repair.js's GATED job). A unit whose baked ExecStart
    // script still EXISTS but is no longer install-devswarm-ingest.js's current
    // resolveStableScript() result was installed before that fix (or the
    // marketplace clone has since moved) and can silently crash-loop the next
    // time the plugin manager relocates the version-pinned path it was baked
    // from. Fail-open: no resolvable stable script (e.g. dev-mode, no
    // marketplace clone on this machine) means nothing to compare against.
    if (u.scriptPath && installIngest && typeof installIngest.resolveStableScript === 'function') {
      let stable = null;
      try { stable = installIngest.resolveStableScript(env, home); } catch (_) { stable = null; }
      if (stable) {
        let drifted = false;
        try { drifted = path.resolve(u.scriptPath) !== path.resolve(stable); } catch (_) { drifted = false; }
        if (drifted) {
          results.push({
            status: WARN,
            message: 'ingest daemon (' + key + ', worktree ' + where + '): ExecStart script is not the current stable build (' + u.scriptPath + ') — run doctor --repair (or reinstall) from that worktree to migrate',
          });
        }
      }
    }
  }
  if (units.length === 0) {
    results.push({ status: INFO, message: 'ingest daemon: not installed' });
  }

  // Supervisor: single legacy-style unit (no per-worktree hashing).
  let supMod = null;
  try { supMod = require('../install-devswarm-supervisor.js'); } catch (_) { supMod = null; }
  if (supMod) {
    let supInstalled = false;
    try {
      if (platform === 'darwin') supInstalled = F.existsSync(path.join(home, 'Library', 'LaunchAgents', supMod.LABEL + '.plist'));
      else if (platform === 'linux') supInstalled = F.existsSync(path.join(home, '.config', 'systemd', 'user', supMod.UNIT + '.timer'));
    } catch (_) { supInstalled = false; }
    if (!supInstalled) {
      results.push({ status: INFO, message: 'supervisor: not installed' });
    } else {
      const probe = platform === 'darwin'
        ? probeLaunchdLoaded(supMod.LABEL, { spawnSync: spawnSyncFn })
        : probeSystemdActive(supMod.UNIT + '.timer', { spawnSync: spawnSyncFn });
      if (!probe.known) results.push({ status: WARN, message: 'supervisor: running-state unknown (probe failed, fail-open)' });
      else if (probe.running) results.push({ status: PASS, message: 'supervisor: scheduled/RUNNING' });
      else results.push({ status: WARN, message: 'supervisor: installed but NOT scheduled (dead) — node companion/install-devswarm-supervisor.js' });
    }
  }

  const anyRunning = Object.keys(runningByHash).some((k) => runningByHash[k] === true);
  return { results, runningByHash, anyRunning, units };
}

// ---------------------------------------------------------------------------
// check 2: data staleness (depends on check 3's daemonInfo)
// ---------------------------------------------------------------------------

// hashFromWorkspaceId — the ingest store partitions the Primary/parent
// reception queue as `primary-<8-hex-worktreeHash>` (install-devswarm-ingest.js's
// primaryWorkspaceId). Extracting the hash lets staleness prefer that
// workspace's own ingest heartbeat over the blunter summary.generatedAt.
function hashFromWorkspaceId(id) {
  const m = /^primary-([0-9a-f]{8})$/.exec(String(id || ''));
  return m ? m[1] : null;
}

// checkDataStaleness(home, opts) -> [{status, message}]. opts.daemonInfo is the
// return of checkDaemonsRunning (computed once, shared — see runChecks below).
function checkDataStaleness(home, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const daemonInfo = o.daemonInfo || {};
  const results = [];

  const daemonRunning = !!daemonInfo.anyRunning;
  if (!daemonRunning) return results; // dormant/dead daemon is check 3's concern, not this one's

  // ENUMERATE per-project summaries (every summaries/<hash>.json) + a legacy global
  // summary.json (pre-migration). Each summary is checked independently.
  const summaries = [];
  let sumNames = [];
  try { sumNames = F.readdirSync(store.summariesRootDir(home)).filter((n) => n.endsWith('.json')); } catch (_) { sumNames = []; }
  for (const name of sumNames) {
    try {
      const raw = String(F.readFileSync(path.join(store.summariesRootDir(home), name), 'utf8'));
      if (raw.trim()) { const s = JSON.parse(raw); if (s && typeof s === 'object') summaries.push(s); }
    } catch (_) {}
  }
  try {
    const raw = String(F.readFileSync(path.join(devswarmRoot(home), 'summary.json'), 'utf8'));
    if (raw.trim()) { const s = JSON.parse(raw); if (s && typeof s === 'object') summaries.push(s); }
  } catch (_) {}

  for (const summary of summaries) {
    if (!summary || !summary.workspaces) continue;
    const generatedAt = Number(summary.generatedAt);
    if (!Number.isFinite(generatedAt)) continue;
    const ageMs = now - generatedAt;

    for (const id of Object.keys(summary.workspaces)) {
      const ws = summary.workspaces[id];
      const unread = Number(ws && ws.unread) || 0;
      if (unread <= 0) continue; // idle workspace — an old generatedAt is not evidence of a problem

      const hash = hashFromWorkspaceId(id);
      if (!hash) continue; // no per-worktree Primary daemon owns this id (e.g. a
      // child's own pull — devswarm-pull.js deliberately never advances the
      // store cursor, so unread stays == total forever; that is expected, not
      // evidence of a stuck ingest loop). With no OWN daemon to attribute
      // staleness to, never flag it off an unrelated primary daemon's state.

      let heartbeatFresh = null;
      try {
        const ingestMod = require('../devswarm-ingest.js');
        const beat = JSON.parse(F.readFileSync(ingestMod.ingestHeartbeatPath(home, hash), 'utf8'));
        if (Number.isFinite(beat && beat.ts)) heartbeatFresh = (now - beat.ts) <= HEARTBEAT_FRESH_MS;
      } catch (_) { heartbeatFresh = null; }

      // No heartbeat yet for THIS hash: only fall back to the generatedAt-age
      // signal when THIS workspace's OWN daemon is confirmed running
      // (daemonInfo.runningByHash[hash] === true) — never off the machine-wide
      // anyRunning flag, which may be a wholly unrelated worktree's daemon.
      const ownRunning = heartbeatFresh !== null || (daemonInfo.runningByHash || {})[hash] === true;
      if (!ownRunning) continue;

      const stale = heartbeatFresh === null ? ageMs > STALE_GENERATED_AT_MS : !heartbeatFresh;
      if (stale) {
        results.push({
          status: WARN,
          message: 'workspace ' + id + ': summary looks stale (generatedAt ' + Math.round(ageMs / 1000) + 's ago, ' + unread + ' unread) while the ingest daemon reports running — check the ingest loop',
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// check 4: no other consumer
// ---------------------------------------------------------------------------

// checkNoOtherConsumer(home, opts) -> [{status, message}]. REPORT-ONLY — NEVER
// kills a second consumer (see devswarm-ingest.js's single-consumer invariant
// comment: two `monitor` consumers SPLIT the destructive native queue).
function checkNoOtherConsumer(home, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const platform = o.platform || process.platform;
  const results = [];
  if (platform === 'win32') {
    results.push({ status: INFO, message: 'other-consumer scan: unknown on Windows (no process-introspection built-in)' });
    return results;
  }

  const locksDir = path.join(devswarmRoot(home), 'locks');
  let lockFiles = [];
  try { lockFiles = F.readdirSync(locksDir).filter((n) => /^ingest(-[0-9a-f]{8})?\.lock$/.test(n)); } catch (_) { lockFiles = []; }
  const holderPids = new Set();
  for (const name of lockFiles) {
    try {
      const lock = JSON.parse(F.readFileSync(path.join(locksDir, name), 'utf8'));
      if (Number.isFinite(lock && lock.pid)) {
        let alive = false;
        try { process.kill(lock.pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
        if (alive) holderPids.add(lock.pid);
      }
    } catch (_) { /* torn/missing lock — not a holder */ }
  }

  const proc = enumerateProcesses(o.spawnSync);
  if (!proc.known) {
    results.push({ status: WARN, message: 'other-consumer scan: process enumeration failed (fail-open, unknown)' });
    return results;
  }

  const monitorRe = /hivecontrol[^|&;]*workspace[^|&;]*monitor/i;
  let monitorCount = 0;
  const strayPids = [];
  for (const line of proc.lines) {
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (!monitorRe.test(m[2])) continue;
    monitorCount++;
    const pid = Number(m[1]);
    if (!holderPids.has(pid)) strayPids.push(pid);
  }

  if (monitorCount > 1 || strayPids.length > 0) {
    results.push({
      status: WARN,
      message: 'SECOND CONSUMER detected: ' + monitorCount + ' `hivecontrol workspace monitor` process(es) running'
        + (strayPids.length ? ', PID(s) ' + strayPids.join(',') + ' hold no lock' : '')
        + ' — the single-consumer invariant may be violated (splits the destructive native queue between consumers; report-only, never auto-killed).'
        + ' To remove it: (1) identify — run `ps aux | grep \'hivecontrol.*monitor\'` to list all consumers;'
        + ' (2) stop — stop the competing process (`kill <PID>`), and remove its respawn config'
        + ' (cron entry, launchd/systemd unit, a repo-local shell monitor loop, or a package.json start loop);'
        + ' (3) verify — re-run doctor; it should report a single consumer (the ingest daemon) or none.'
        + ' Limitation: anti-hall cannot mechanically block or kill an external (non-tool-call) consumer'
        + ' — detection and your action are the only levers.',
    });
  } else if (monitorCount === 1) {
    results.push({ status: PASS, message: 'exactly one `hivecontrol workspace monitor` consumer running (matches the lock holder)' });
  } else {
    results.push({ status: PASS, message: 'no `hivecontrol workspace monitor` consumer process detected' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// check 6: mesh-shape drift (#70/#71) — READ-ONLY. Reuses devswarm.js's
// `healthcheck` (which sits on the SAME computeDiagnosis/computeSummary as
// `diagnose` and the fold's detect — one computation, never a fourth). Reports
// the THIS-project (cwd repoKey) orphan/stale/split counts; a dry-run fold adds
// the un-resolvable `left` list (2 descriptor-backed rows on one meshId — surfaced,
// never silently absorbed). Project-scoped: a non-git cwd is silently skipped.
// Advisory only (WARN, never FAIL) — matches the no-delete surface-only posture.
// ---------------------------------------------------------------------------
function checkMeshShape(home, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const env = o.env || process.env;
  const F = o.fsi || fs;
  const results = [];

  // NEVER open/create the shared store just to check it — doctor --check is a pure
  // read-only path (see doctor-repair.js's header + the --check invariant test). If
  // this project's per-repoKey store dir does not exist yet, there is no mesh to
  // diagnose, so skip BEFORE any store.openStore (which would create the dir).
  let repoKey = null;
  try {
    const rk = require('./devswarm-repokey.js');
    repoKey = cwd && typeof rk.repoKeyForWorktree === 'function' ? rk.repoKeyForWorktree(cwd) : null;
  } catch (_) { repoKey = null; }
  if (!repoKey) return results; // non-git cwd -> nothing to check
  let storeExists = false;
  try { storeExists = F.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
  if (!storeExists) return results;

  let devswarm = null;
  try { devswarm = require('../../scripts/devswarm.js'); } catch (_) { devswarm = null; }
  if (!devswarm || typeof devswarm.run !== 'function') return results; // fail-open

  let r = null;
  try { r = (devswarm.run(['healthcheck', '--json'], { cwd, env, home, backend: o.backend }) || {}).result; }
  catch (_) { r = null; }
  if (!r || r.reason === 'no-project' || r.ok === undefined) return results; // not a DevSwarm project cwd -> nothing to report

  const c = r.counts || {};
  const drift = (c.orphans || 0) + (c.stale || 0) + (c.splits || 0);

  let leftIds = [];
  try {
    const fr = typeof devswarm.foldMeshDuplicates === 'function'
      ? devswarm.foldMeshDuplicates(home, { cwd, env, backend: o.backend, dryRun: true })
      : null;
    if (fr && Array.isArray(fr.left)) leftIds = fr.left;
  } catch (_) { leftIds = []; }

  if (drift === 0 && leftIds.length === 0) {
    results.push({ status: PASS, message: 'mesh shape: no drift (orphans=0 stale=0 splits=0)' });
  } else {
    let msg = 'mesh shape DRIFT: ' + (c.orphans || 0) + ' orphan partition(s), ' + (c.stale || 0)
      + ' stale registry row(s), ' + (c.splits || 0) + ' split worktree(s)';
    if (leftIds.length) msg += '; ' + leftIds.length + ' un-resolvable dual row(s) LEFT in place (' + leftIds.join(', ') + ')';
    msg += ' — run doctor --repair to fold duplicates (orphans/stale are surface-only, never auto-deleted)';
    results.push({ status: WARN, message: msg });
  }
  return results;
}

// ---------------------------------------------------------------------------
// runChecks — orchestrates checks 1-4 + 6 (the gated set doctor.js wires into its
// existing DevSwarm section).
// ---------------------------------------------------------------------------
function runChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const platform = o.platform || process.platform;

  const results = [];
  try { results.push(...checkDbHealth(home, { fsi: F, execPath: o.execPath, spawnSync: o.spawnSync })); }
  catch (e) { results.push({ status: WARN, message: 'DB/store health check raised (fail-open): ' + errMsg(e) }); }

  let daemonInfo = { results: [], anyRunning: false, units: [] };
  try { daemonInfo = checkDaemonsRunning(home, { fsi: F, platform, now, spawnSync: o.spawnSync, env }); }
  catch (e) { daemonInfo = { results: [{ status: WARN, message: 'daemon RUNNING check raised (fail-open): ' + errMsg(e) }], anyRunning: false, units: [] }; }

  try { results.push(...checkDataStaleness(home, { fsi: F, now, daemonInfo })); }
  catch (e) { results.push({ status: WARN, message: 'data staleness check raised (fail-open): ' + errMsg(e) }); }

  results.push(...daemonInfo.results);

  try { results.push(...checkNoOtherConsumer(home, { fsi: F, platform, spawnSync: o.spawnSync })); }
  catch (e) { results.push({ status: WARN, message: 'no-other-consumer scan raised (fail-open): ' + errMsg(e) }); }

  try { results.push(...checkMeshShape(home, { cwd: o.cwd, env, backend: o.backend })); }
  catch (e) { results.push({ status: WARN, message: 'mesh-shape check raised (fail-open): ' + errMsg(e) }); }

  // env is threaded into checkDaemonsRunning (v0.56.0: resolveStableScript
  // drift comparison) but, beyond that, is still NOT used to compute an
  // `active` gate here — doctor.js reuses ITS OWN already-computed active flag
  // (isDevswarmActive(env) || descriptors present) to decide whether to print
  // these results, so there is nothing to duplicate.
  return { results };
}

// ---------------------------------------------------------------------------
// check 5: foreign skill/hook conflict scan — UNCONDITIONAL (own top-level
// doctor section, never gated on DevSwarm activity).
// ---------------------------------------------------------------------------

function readJsonBounded(p, F, maxBytes) {
  try {
    const st = F.statSync(p);
    if (st.size > (maxBytes || 512 * 1024)) return null;
    return JSON.parse(F.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

// readEnabledPlugins — the union of enabledPlugins across the user + project
// settings scopes (mirrors omc-detect.js's own scope list), keyed "name@marketplace".
function readEnabledPlugins(cwd, home, F) {
  const scopes = [
    path.join(home, '.claude', 'settings.json'),
    cwd ? path.join(cwd, '.claude', 'settings.json') : null,
    cwd ? path.join(cwd, '.claude', 'settings.local.json') : null,
  ].filter(Boolean);
  const enabled = new Set();
  for (const p of scopes) {
    const s = readJsonBounded(p, F);
    const plugins = s && s.enabledPlugins;
    if (plugins && typeof plugins === 'object') {
      for (const k of Object.keys(plugins)) if (plugins[k] === true) enabled.add(k);
    }
  }
  return enabled;
}

// readInstalledPluginPaths — installed_plugins.json v2 schema (HARNESS-OWNED,
// read-only; see skills/update/scripts/update.js's documented layout):
//   { plugins: { "<name>@<marketplace>": [{installPath, ...}, ...] } }
// Each installPath is a plugin cache dir containing hooks/hooks.json and
// skills/<name>/ (verified layout).
function readInstalledPluginPaths(home, F) {
  const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const out = {};
  const data = readJsonBounded(p, F, 4 * 1024 * 1024);
  const plugins = data && data.plugins;
  if (plugins && typeof plugins === 'object') {
    for (const key of Object.keys(plugins)) {
      const entries = Array.isArray(plugins[key]) ? plugins[key] : [];
      const withPath = entries.filter((e) => e && typeof e.installPath === 'string');
      if (withPath.length) out[key] = withPath[withPath.length - 1].installPath;
    }
  }
  return out;
}

// extractHookEntries(hooksJsonConfig) -> [{event, matcher, basename}]. PRIVACY:
// only the command's basename (a `.js` filename) is kept — never the full
// command string, which can carry an absolute path (local username).
function extractHookEntries(cfg) {
  const out = [];
  const hooksObj = cfg && cfg.hooks;
  if (!hooksObj || typeof hooksObj !== 'object') return out;
  for (const event of Object.keys(hooksObj)) {
    const groups = Array.isArray(hooksObj[event]) ? hooksObj[event] : [];
    for (const g of groups) {
      const matcher = (g && typeof g.matcher === 'string' && g.matcher !== '') ? g.matcher : null;
      const hs = Array.isArray(g && g.hooks) ? g.hooks : [];
      for (const h of hs) {
        const cmdStr = (h && typeof h.command === 'string') ? h.command : '';
        // .js/.mjs/.cjs — third-party plugins (e.g. oh-my-claudecode) commonly
        // wrap the real target script as a SECOND token (`node run.cjs
        // real-hook.mjs`); first-match is a simple, defensible heuristic
        // (matches doctor.js's own sessionStartHookFiles() convention).
        const m = cmdStr.match(/[\w-]+\.(?:js|mjs|cjs)/);
        const basename = m ? m[0] : '(non-script hook)';
        out.push({ event, matcher, basename });
      }
    }
  }
  return out;
}

function matchesBashMatcher(matcher) {
  if (matcher === null) return true; // no matcher = matches every tool
  return matcher === '*' || /bash/i.test(matcher);
}

// scanForeignConflicts({home, cwd, fsi}) -> {results}. Read-only; never writes.
function scanForeignConflicts(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const cwd = o.cwd || process.cwd();
  const F = o.fsi || fs;
  const results = [];

  const ownHooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
  const ownCfg = readJsonBounded(ownHooksPath, F);
  const ownEntries = extractHookEntries(ownCfg);
  const ownHasStop = ownEntries.some((e) => e.event === 'Stop');
  let ownSkillNames = [];
  try {
    const skillsDir = path.join(__dirname, '..', '..', 'skills');
    ownSkillNames = F.readdirSync(skillsDir).filter((n) => {
      try { return F.statSync(path.join(skillsDir, n)).isDirectory(); } catch (_) { return false; }
    });
  } catch (_) { ownSkillNames = []; }

  const enabled = readEnabledPlugins(cwd, home, F);
  enabled.delete('anti-hall@anti-hall'); // never compare against self
  if (enabled.size === 0) return { results }; // nothing else enabled — nothing to scan

  const installedPaths = readInstalledPluginPaths(home, F);

  for (const key of enabled) {
    const installPath = installedPaths[key];
    if (!installPath) continue; // harness knows it's enabled but not where it lives — skip, fail-open
    const pluginName = key.split('@')[0];

    const foreignCfg = readJsonBounded(path.join(installPath, 'hooks', 'hooks.json'), F);
    const foreignEntries = extractHookEntries(foreignCfg);
    for (const e of foreignEntries) {
      if (e.event === 'PreToolUse' && matchesBashMatcher(e.matcher)) {
        results.push({
          status: 'HIGH',
          message: 'foreign PreToolUse hook on Bash: plugin "' + pluginName + '" registers ' + e.basename
            + ' (matcher ' + (e.matcher || '*') + ') — may compete with anti-hall\'s own allow/deny (git-guard/command-guard/edit-guard)',
        });
      } else if (e.event === 'Stop') {
        results.push({
          status: 'HIGH',
          message: 'foreign Stop hook: plugin "' + pluginName + '" registers ' + e.basename + (ownHasStop ? ' — a second Stop hook alongside anti-hall\'s own' : ''),
        });
      } else if (e.event === 'UserPromptSubmit' || e.event === 'SessionStart') {
        results.push({
          status: INFO,
          message: 'additive ' + e.event + ' overlap: plugin "' + pluginName + '" also registers ' + e.basename + ' (both run; non-competing)',
        });
      }
    }

    if (ownSkillNames.length) {
      let foreignSkillNames = [];
      try {
        const dir = path.join(installPath, 'skills');
        foreignSkillNames = F.readdirSync(dir).filter((n) => {
          try { return F.statSync(path.join(dir, n)).isDirectory(); } catch (_) { return false; }
        });
      } catch (_) { foreignSkillNames = []; }
      for (const name of foreignSkillNames) {
        if (ownSkillNames.includes(name)) {
          results.push({
            status: 'HIGH',
            message: 'skill-name collision: plugin "' + pluginName + '" also ships a skill named "' + name + '" (anti-hall ships one too)',
          });
        }
      }
    }
  }

  // Dedupe identical (status+message) lines — a plugin registering several
  // hooks on the SAME event with the SAME basename (e.g. a shared `run.cjs`
  // dispatcher wrapping multiple targets) would otherwise repeat the same
  // report line once per registration; the underlying fact is still one
  // "this plugin also hooks this event" signal.
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = r.status + ' ' + r.message;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return { results: deduped };
}

module.exports = {
  PASS, WARN, FAIL, INFO,
  // check 1
  runSqliteProbe, scanJournalTornLinesIn, enumerateStoreUnits, checkDbHealth,
  // check 2
  hashFromWorkspaceId, checkDataStaleness,
  // check 3
  probeLaunchdRunning, probeLaunchdLoaded, probeSystemdActive, probeCronRunning,
  enumerateProcesses, checkDaemonsRunning,
  // check 4
  checkNoOtherConsumer,
  // check 6 (mesh-shape drift, #70/#71)
  checkMeshShape,
  // orchestration (checks 1-4 + 6)
  runChecks,
  // check 5
  readEnabledPlugins, readInstalledPluginPaths, extractHookEntries, scanForeignConflicts,
};

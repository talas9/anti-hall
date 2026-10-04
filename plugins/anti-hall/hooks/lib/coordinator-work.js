'use strict';
// coordinator-work.js — the main-thread WORK window (coordinator-drift F1).
//
// Per session: the timestamps of successful WORK Bash calls from the last
// guards.coordinatorWorkWindowMinutes (capped at coordinatorWorkMaxEntries),
// plus calls/work/blocks/skippedWouldBlock counters, the plugin version and
// firstTs (the first post). coordinator-work-guard.js drives the pure step
// functions below: stepPost on PostToolUse (prune, re-arm below nudgeAt,
// append, nudge once per crossing) and checkPre on PreToolUse (a blockable
// WORK call is blocked when the window already holds blockAt - 1).
//
// Storage (~/.anti-hall/): coordinator-work-session-<id>.json (+ .lock),
// coordinator-work-metrics.json (+ .lock; written only on a shown nudge, a
// block or a fold), coordinator-work-trips.log (JSONL, rotated at 1 MiB),
// .coordinator-work-fold-stamp.json. Lock order is always session -> metrics:
// update() releases the session lock before the caller touches metrics, and
// foldStale() takes the metrics lock only while holding the session lock.
// Every export is fail-open.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ tMs: 600000, nudgeAt: 4, blockAt: 7, cap: 50 });
const SIX_H = 21600000;
const TRIP_MAX_BYTES = 1024 * 1024;
const SESSION_RE = /^coordinator-work-session-.+\.json$/;
const COUNTERS = ['calls', 'work', 'blocks', 'skippedWouldBlock'];
const PRE_CAP = 20;

const VERSION = (() => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch (_) { return 'unknown'; }
})();

function int(v, dflt, min) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

function config(env) {
  try {
    const s = require('./settings.js');
    const g = (k) => s.get('guards', k, undefined, s.envOpts(env));
    return {
      tMs: int(g('coordinatorWorkWindowMinutes'), 10, 0) * 60000,
      nudgeAt: int(g('coordinatorWorkNudgeAt'), DEFAULTS.nudgeAt, 0),
      blockAt: int(g('coordinatorWorkBlockAt'), DEFAULTS.blockAt, 0),
      cap: int(g('coordinatorWorkMaxEntries'), DEFAULTS.cap, 1),
    };
  } catch (_) { return Object.assign({}, DEFAULTS); }
}

function emptyState(version) {
  return { v: 1, version: version || VERSION, firstTs: 0, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0, pre: [] };
}

// Pre verdicts keyed by tool_use_id: Post reuses the verdict taken before the
// command ran (a script the command itself deletes is gone by Post time).
function rememberPre(state, id, v) {
  state.pre = (state.pre || []).filter((e) => e.id !== id);
  state.pre.push({ id, work: !!v.work, blockable: !!v.blockable });
  if (state.pre.length > PRE_CAP) state.pre = state.pre.slice(-PRE_CAP);
  return state;
}

function takePre(state, id) {
  const list = state && Array.isArray(state.pre) ? state.pre : [];
  const k = list.findIndex((e) => e.id === id);
  if (k === -1) return null;
  const e = list.splice(k, 1)[0];
  return { work: e.work, blockable: e.blockable };
}

// normalize(raw) -> a well-formed state, or null when raw is not an object.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = emptyState(typeof raw.version === 'string' && raw.version ? raw.version : 'unknown');
  if (Number.isFinite(raw.firstTs) && raw.firstTs > 0) s.firstTs = raw.firstTs;
  if (Array.isArray(raw.ts)) s.ts = raw.ts.filter((t) => Number.isFinite(t));
  s.armed = raw.armed !== false;
  if (Array.isArray(raw.pre)) {
    s.pre = raw.pre.filter((e) => e && typeof e.id === 'string' && e.id && typeof e.work === 'boolean' && typeof e.blockable === 'boolean')
      .map((e) => ({ id: e.id, work: e.work, blockable: e.blockable })).slice(-PRE_CAP);
  }
  for (const k of COUNTERS.concat(['lastBlockAt'])) if (Number.isFinite(raw[k]) && raw[k] >= 0) s[k] = raw[k];
  return s;
}

function sessionStart(state, now) {
  return state && state.firstTs ? state.firstTs : now - SIX_H;
}

function prune(state, now, cfg) {
  state.ts = state.ts.filter((t) => now - t < cfg.tMs);
  if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  return state;
}

function checkPre(state, { now, work, blockable }, cfg) {
  try {
    const count = state && Array.isArray(state.ts) ? state.ts.filter((t) => now - t < cfg.tMs).length : 0;
    const wouldBlock = cfg.tMs > 0 && cfg.blockAt > 0 && !!work && !!blockable && count >= cfg.blockAt - 1;
    return { wouldBlock, count };
  } catch (_) { return { wouldBlock: false, count: 0 }; }
}

function stepPost(state, { now, work }, cfg) {
  if (!state.firstTs) state.firstTs = now;
  prune(state, now, cfg);
  if (state.ts.length < cfg.nudgeAt) state.armed = true;
  state.calls++;
  if (work) {
    state.work++;
    state.ts.push(now);
    if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  }
  let crossing = null;
  if (cfg.nudgeAt > 0 && state.ts.length >= cfg.nudgeAt && state.armed) {
    state.armed = false;
    crossing = { count: state.ts.length };
  }
  return { state, crossing };
}

// ---- storage ----------------------------------------------------------------

function dir(home) { return path.join(home, '.anti-hall'); }
function safeId(sid) { return String(sid || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80); }
function sessionPath(home, sid) { return path.join(dir(home), 'coordinator-work-session-' + safeId(sid) + '.json'); }
function metricsPath(home) { return path.join(dir(home), 'coordinator-work-metrics.json'); }
function stampPath(home) { return path.join(dir(home), '.coordinator-work-fold-stamp.json'); }
function tripsPath(home) { return path.join(dir(home), 'coordinator-work-trips.log'); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}

function lockWaitMs() {
  if (process.env.ANTIHALL_TEST_HOME_ISOLATED) {
    const n = Number(process.env.ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 250;
}

function acquire(p) {
  try {
    return require('../../companion/lib/lock.js').acquire(p, {
      staleMs: 5000, liveStaleMs: 5000, maxTries: Infinity, waitMs: lockWaitMs(), stepMs: 5,
    });
  } catch (_) { return null; }
}

function release(h) {
  try { require('../../companion/lib/lock.js').release(h); } catch (_) { /* best effort */ }
}

function readState(home, sid) {
  try { return normalize(readJson(sessionPath(home, sid))); } catch (_) { return null; }
}

// update(home, sid, fn) -> fn's state after the write, or null (lock not
// acquired / error: the update is skipped). The session lock is released
// before this returns, so a caller may then take the metrics lock.
function update(home, sid, fn) {
  const p = sessionPath(home, sid);
  let h = null;
  try {
    fs.mkdirSync(dir(home), { recursive: true });
    h = acquire(p + '.lock');
    if (!h) return null;
    const s = normalize(readJson(p)) || emptyState(VERSION);
    fn(s);
    writeJson(p, s);
    return s;
  } catch (_) {
    return null;
  } finally {
    if (h) release(h);
  }
}

function normalizeMetrics(raw) {
  const m = { v: 1, nudges: 0, blocks: 0, byVersion: {} };
  if (raw && typeof raw === 'object') {
    for (const k of ['nudges', 'blocks', 'maxSessionBlocks']) if (Number.isFinite(raw[k]) && raw[k] >= 0) m[k] = raw[k];
    if (raw.byVersion && typeof raw.byVersion === 'object') {
      for (const [v, e] of Object.entries(raw.byVersion)) {
        if (!e || typeof e !== 'object') continue;
        const o = { sessions: 0, calls: 0, work: 0, blocks: 0, skippedWouldBlock: 0 };
        for (const k of Object.keys(o)) if (Number.isFinite(e[k]) && e[k] >= 0) o[k] = e[k];
        m.byVersion[v] = o;
      }
    }
  }
  return m;
}

function bumpMetrics(home, fn) {
  const p = metricsPath(home);
  let h = null;
  try {
    fs.mkdirSync(dir(home), { recursive: true });
    h = acquire(p + '.lock');
    if (!h) return false;
    const m = normalizeMetrics(readJson(p));
    fn(m);
    writeJson(p, m);
    return true;
  } catch (_) {
    return false;
  } finally {
    if (h) release(h);
  }
}

function logTrip(home, obj) {
  try {
    const p = tripsPath(home);
    fs.mkdirSync(dir(home), { recursive: true });
    try {
      if (fs.statSync(p).size >= TRIP_MAX_BYTES) fs.renameSync(p, p + '.1');
    } catch (_) { /* absent */ }
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + '\n', 'utf8');
  } catch (_) { /* telemetry only */ }
}

// foldStale(home, now?) -> number of session files folded. At most once per
// 6 h (stamp). Per stale file: session lock, re-stat, metrics lock, fold +
// unlink, release metrics, release session.
function foldStale(home, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  let folded = 0;
  try {
    const stamp = readJson(stampPath(home));
    if (stamp && Number.isFinite(stamp.ts) && t - stamp.ts < SIX_H) return 0;
    const ttl = require('./state-prune.js').DEFAULT_TTL_MS;
    let names = [];
    try { names = fs.readdirSync(dir(home)).filter((f) => SESSION_RE.test(f)); } catch (_) { names = []; }
    for (const name of names) {
      const p = path.join(dir(home), name);
      let st = null;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (t - st.mtimeMs <= ttl) continue;
      const h = acquire(p + '.lock');
      if (!h) continue;
      try {
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (t - st.mtimeMs <= ttl) continue;
        bumpMetrics(home, (m) => {
          const s = normalize(readJson(p)) || emptyState('unknown');
          const v = s.version || 'unknown';
          const e = m.byVersion[v] || { sessions: 0, calls: 0, work: 0, blocks: 0, skippedWouldBlock: 0 };
          e.sessions += 1;
          for (const k of COUNTERS) e[k] += s[k];
          m.byVersion[v] = e;
          m.maxSessionBlocks = Math.max(m.maxSessionBlocks || 0, s.blocks);
          fs.unlinkSync(p);
          folded++;
        });
      } finally {
        release(h);
      }
    }
    writeJson(stampPath(home), { ts: t });
  } catch (_) { /* fail-open */ }
  return folded;
}

function share(num, den) { return den > 0 ? num / den : null; }

// summary(home) -> folded byVersion merged with live session files (calls > 0).
function summary(home) {
  const out = { nudges: 0, blocks: 0, skippedWouldBlock: 0, sessionsWithSkippedWouldBlock: 0, versions: {}, blocksPerSession: { mean: null, max: 0 } };
  try {
    const m = normalizeMetrics(readJson(metricsPath(home)));
    out.nudges = m.nudges;
    out.blocks = m.blocks;
    const acc = {};
    const add = (v, e) => {
      const a = acc[v] || (acc[v] = { sessions: 0, calls: 0, work: 0, blocks: 0 });
      a.sessions += e.sessions;
      a.calls += e.calls;
      a.work += e.work;
      a.blocks += e.blocks;
      out.skippedWouldBlock += e.skippedWouldBlock;
    };
    for (const [v, e] of Object.entries(m.byVersion)) add(v, e);
    let max = m.maxSessionBlocks || 0;
    let names = [];
    try { names = fs.readdirSync(dir(home)).filter((f) => SESSION_RE.test(f)); } catch (_) { names = []; }
    for (const name of names) {
      const s = normalize(readJson(path.join(dir(home), name)));
      if (!s || !(s.calls > 0)) continue;
      add(s.version || 'unknown', Object.assign({ sessions: 1 }, s));
      if (s.skippedWouldBlock > 0) out.sessionsWithSkippedWouldBlock++;
      max = Math.max(max, s.blocks);
    }
    let sessions = 0;
    let blocks = 0;
    for (const [v, a] of Object.entries(acc)) {
      sessions += a.sessions;
      blocks += a.blocks;
      out.versions[v] = Object.assign({}, a, {
        postedShare: share(a.work, a.calls),
        attemptedShare: share(a.work + a.blocks, a.calls + a.blocks),
      });
    }
    out.blocksPerSession = { mean: sessions > 0 ? blocks / sessions : null, max };
  } catch (_) { /* fail-open */ }
  return out;
}

const fmtMin = (cfg) => Math.round(cfg.tMs / 60000);

function BLOCK(count, cfg, skipCmd) {
  return require('./block-message.js').blockMessage({
    guard: 'coordinator-work-guard',
    what: count + ' state-changing calls in the main thread within ' + fmtMin(cfg) + ' min; this one is blocked.',
    why: 'Too much hands-on work in the main thread; the window clears as calls age out.',
    instead: 'hand this and the remaining steps (patch applies and test runs included) to a subagent (Agent tool) that returns a tight summary.',
    allowed: 'reads, recovery commands (--abort/--quit, stash pop/apply) and loosely matched inline code.',
    override: skipCmd + ' (15-min TTL)',
  });
}

function NUDGE(count, cfg) {
  return require('./block-message.js').message({
    kind: 'warn',
    guard: 'coordinator-work-guard',
    what: count + ' state-changing calls in the main thread within ' + fmtMin(cfg) + ' min.',
    instead: 'delegate the rest to a subagent now' + (cfg.blockAt > 0 ? '; call ' + cfg.blockAt + ' in the window is blocked.' : '.'),
  });
}

// replay(rows, cfg, classify) -> what the window would have done over a log.
// rows: [{n?, ts, tool?, posted, command, cwd}] (non-Bash rows are skipped).
// calls/work/share come from the as-recorded pass (every posted row counted);
// crossings/blocks/attemptedShare from an enforcement pass where a blocked
// row is not posted. Rows after a block replay as logged (detection points).
function replay(rows, cfg, classify) {
  const list = (rows || []).filter((r) => r && (r.tool === undefined || r.tool === 'Bash') && typeof r.command === 'string');
  const start = list.length ? Date.parse(list[0].ts) : Date.now();
  const labeled = list.map((r, i) => {
    let c = null;
    try { c = classify(r.command, { cwd: r.cwd, session_id: 'replay' }, { sessionStartTs: start }); } catch (_) { c = null; }
    return { n: r.n !== undefined ? r.n : i + 1, now: Date.parse(r.ts), posted: r.posted !== false, work: !!(c && c.work), blockable: !!(c && c.blockable) };
  });
  const rec = emptyState('replay');
  for (const l of labeled) if (l.posted) stepPost(rec, { now: l.now, work: l.work }, cfg);
  const enf = emptyState('replay');
  const crossings = [];
  const blocks = [];
  for (const l of labeled) {
    if (checkPre(enf, { now: l.now, work: l.work, blockable: l.blockable }, cfg).wouldBlock) {
      blocks.push(l.n);
      continue;
    }
    if (!l.posted) continue;
    if (stepPost(enf, { now: l.now, work: l.work }, cfg).crossing) crossings.push(l.n);
  }
  return {
    calls: rec.calls,
    work: rec.work,
    share: share(rec.work, rec.calls),
    attemptedShare: share(enf.work + blocks.length, enf.calls + blocks.length),
    wouldNudge: crossings.length,
    wouldBlock: blocks.length,
    crossings,
    blocks,
    labeled: labeled.map(({ n, posted, work, blockable }) => ({ n, posted, work, blockable })),
  };
}

// provablyNotWork(command): a conservative pre-filter so the hook can skip loading
// command-guard.js (237 KB) for plain read-only commands. True ONLY for a command
// built from a closed vocabulary: every segment (split at && || ; | newline) starts
// with a read-only verb (or `git <read-only sub>`) and the whole string has no
// quote, substitution, redirect, glob, brace, backslash or env assignment. Anything
// else returns false and goes through classifyBashWork unchanged. Differentially
// tested against classifyBashWork (tests/hooks/coordinator-work-fastpath.test.js).
const RO_VERBS = new Set(['ls', 'cat', 'head', 'tail', 'pwd', 'wc', 'grep', 'rg', 'which', 'whoami', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'id', 'uname', 'hostname', 'true', 'false']);
const RO_GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe']);
const SAFE_CMD_RE = /^[A-Za-z0-9 \t\n_.\/:=@%+,&|;-]*$/;
const SAFE_ARG_RE = /^[A-Za-z0-9_.\/:=@%+,-]+$/;
function provablyNotWork(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) return false;
  if (!SAFE_CMD_RE.test(command)) return false;
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    if (/&/.test(seg)) return false; // a lone `&` (background) is not handled
    const t = seg.trim().split(/\s+/).filter(Boolean);
    if (!t.length) continue; // empty segment: the classifier ignores it too
    if (!t.every((x, i) => i === 0 ? /^[a-z-]+$/.test(x) : SAFE_ARG_RE.test(x))) return false;
    if (RO_VERBS.has(t[0])) continue;
    if (t[0] === 'git' && t.length >= 2 && RO_GIT_SUBS.has(t[1]) && !t.slice(2).some((a) => /output|^-o/.test(a))) continue;
    return false;
  }
  return true;
}

module.exports = {
  provablyNotWork, DEFAULTS, VERSION, config, emptyState, normalize, rememberPre, takePre, sessionStart, prune, checkPre, stepPost,
  sessionPath, metricsPath, readState, update, bumpMetrics, logTrip, foldStale, summary,
  BLOCK, NUDGE, replay,
};

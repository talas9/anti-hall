// check = "coordinator-work-guard" (PreToolUse and PostToolUse on Bash). The Node guard keeps a per-session window of the main thread's
// state-changing Bash calls, nudges once per crossing of a threshold and blocks past a second one. PreToolUse: a call that is not a Bash
// call, has no session id, or carries a subagent marker in its payload is not the main thread, so the guard says nothing; every other
// call defers to the Node guard, whose command classifier (`classifyBashWork`) decides what counts as work and owns the block.
// PostToolUse (`--post`): records the call in the window `~/.anti-hall/coordinator-work-session-<id>.json` (with its `.lock`), says one
// COORDINATOR DRIFT note per crossing of the nudge threshold, then folds stale window files into the metrics
// `coordinator-work-metrics.json` and the log of nudges `coordinator-work-trips.log`: the files the Node guard keeps, in the bytes it
// writes, so this script and a Node hook that answers for the same session in turn see one record. The pass is answered only when whether
// the call counts as work is already known without the classifier: the Node PreToolUse pass stored its verdict under the call's
// `tool_use_id`, or the command is provably not work (a closed vocabulary of read-only verbs); anything else, and a window lock another
// process holds, defers. Mirrors hooks/coordinator-work-guard.js and hooks/lib/coordinator-work.js. Keys, limits and texts:
// small_guards.toml (coordinator_work.*).
'use strict';

function cwT(k) { return ah.cfg('coordinator_work.' + k); }
function cwN(k) { return ah.cfgNum('coordinator_work.' + k); }

// ---- who is the main thread --------------------------------------------------------------------------------------------------------

// A Codex payload: a non-empty string for each of the Codex marker fields.
function cwCodex(p) { return cwT('codex_markers').every(function (k) { return typeof p[k] === 'string' && p[k] !== ''; }); }

// True when the payload alone proves this is not the main thread (a present non-null marker on a Codex payload, a truthy one on a
// Claude payload: the entrypoint variable is the only other way to be a subagent).
function cwSubagent(p) {
  var markers = cwT('agent_markers');
  return cwCodex(p) ? markers.some(function (k) { return p[k] !== undefined && p[k] !== null; }) : markers.some(function (k) { return !!p[k]; });
}

// `isCoordinator(payload, env)`: not a subagent and running under an interactive entry point.
function cwCoordinator(p) {
  var entry = ah.env.get(cwT('entrypoint_env')) || '';
  if (cwCodex(p)) return !cwSubagent(p) && entry === '';
  if (cwSubagent(p) || entry === cwT('subagent_entrypoint')) return false;
  return cwT('coordinator_entrypoints').indexOf(entry) >= 0 || (entry !== '' && entry.indexOf(cwT('coordinator_entrypoint_prefix')) === 0);
}

// ---- configuration -----------------------------------------------------------------------------------------------------------------

function cwInt(v, dflt, min) { return isFinite(v) && v >= min ? Math.floor(v) : dflt; }

function cwConfig() {
  var g = function (k) { return ah.settings.num('coordinator_work.' + k); };
  return {
    tMs: cwInt(g('window_setting'), cwN('window_default'), 0) * 60000, nudgeAt: cwInt(g('nudge_setting'), cwN('nudge_default'), 0),
    blockAt: cwInt(g('block_setting'), cwN('block_default'), 0), cap: cwInt(g('cap_setting'), cwN('cap_default'), 1),
  };
}

// ---- the window state --------------------------------------------------------------------------------------------------------------

function cwEmpty(version) { return { v: 1, version: version, firstTs: 0, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0, pre: [] }; }

function cwTakePre(state, id) {
  var list = state && Array.isArray(state.pre) ? state.pre : [], k = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) { k = i; break; }
  if (k === -1) return null;
  var e = list.splice(k, 1)[0];
  return { work: e.work, blockable: e.blockable };
}

// `normalize(raw)`: a well-formed state, or null when `raw` is not an object.
function cwNormalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var s = cwEmpty(typeof raw.version === 'string' && raw.version ? raw.version : cwT('unknown_version'));
  if (typeof raw.firstTs === 'number' && isFinite(raw.firstTs) && raw.firstTs > 0) s.firstTs = raw.firstTs;
  if (Array.isArray(raw.ts)) s.ts = raw.ts.filter(function (t) { return typeof t === 'number' && isFinite(t); });
  s.armed = raw.armed !== false;
  if (Array.isArray(raw.pre)) {
    s.pre = raw.pre.filter(function (e) { return e && typeof e.id === 'string' && e.id && typeof e.work === 'boolean' && typeof e.blockable === 'boolean'; })
      .map(function (e) { return { id: e.id, work: e.work, blockable: e.blockable }; }).slice(-cwN('pre_cap'));
  }
  cwT('counters').concat(['lastBlockAt']).forEach(function (k) { if (typeof raw[k] === 'number' && isFinite(raw[k]) && raw[k] >= 0) s[k] = raw[k]; });
  return s;
}

// `stepPost(state, {now, work}, cfg)`: record one call; the window count when a nudge threshold was just crossed, else null.
function cwStep(state, now, work, cfg) {
  if (!state.firstTs) state.firstTs = now;
  state.ts = state.ts.filter(function (t) { return now - t < cfg.tMs; });
  if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  if (state.ts.length < cfg.nudgeAt) state.armed = true;
  state.calls++;
  if (work) {
    state.work++;
    state.ts.push(now);
    if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  }
  if (cfg.nudgeAt > 0 && state.ts.length >= cfg.nudgeAt && state.armed) { state.armed = false; return state.ts.length; }
  return null;
}

// ---- storage ------------------------------------------------------------------------------------------------------------------------

function cwSafeId(sid) { return String(sid || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, cwN('session_id_max')); }
function cwDir() { return ah.cfg('paths.base_dir'); }
function cwSessionRel(sid) { return cwDir() + '/' + cwT('session_file_prefix') + cwSafeId(sid) + ah.cfg('guardkit.state_ext'); }
function cwNamed(key) { return cwDir() + '/' + cwT(key); }

function cwReadJson(rel) {
  var raw = ah.state.readText(rel);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function cwLockWait() {
  var iso = ah.env.get(cwT('lock_isolation_env'));
  if (iso !== null && iso !== '') {
    var w = ah.env.get(cwT('lock_wait_env'));
    var n = w === null ? NaN : Number(w.trim() === '' ? NaN : w);
    if (isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function cwLock(rel) { return ah.state.lock(rel + cwT('lock_suffix'), 'coordinator_work', cwLockWait()); }

// ---- the metrics ----------------------------------------------------------------------------------------------------------------------

function cwNormalizeMetrics(raw) {
  var m = { v: 1, nudges: 0, blocks: 0, byVersion: {} };
  if (raw && typeof raw === 'object') {
    ['nudges', 'blocks', 'maxSessionBlocks'].forEach(function (k) { if (typeof raw[k] === 'number' && isFinite(raw[k]) && raw[k] >= 0) m[k] = raw[k]; });
    if (raw.byVersion && typeof raw.byVersion === 'object') {
      Object.keys(raw.byVersion).forEach(function (v) {
        var e = raw.byVersion[v];
        if (!e || typeof e !== 'object') return;
        var o = {};
        cwT('version_keys').forEach(function (k) { o[k] = typeof e[k] === 'number' && isFinite(e[k]) && e[k] >= 0 ? e[k] : 0; });
        m.byVersion[v] = o;
      });
    }
  }
  return m;
}

// The metrics read-modify-write with the metrics lock already held; false when `fn` declines or the write fails.
function cwBumpLocked(fn) {
  var rel = cwNamed('metrics_file'), m = cwNormalizeMetrics(cwReadJson(rel));
  if (fn(m) === false) return false;
  try { return ah.state.writeAtomic(rel, JSON.stringify(m)); } catch (e) { return false; }
}

// `bumpMetrics`: the metrics under their lock; false when the lock was not taken or the write failed.
function cwBump(fn) {
  var h = cwLock(cwNamed('metrics_file'));
  if (h === null) return false;
  var ok = cwBumpLocked(fn);
  ah.state.unlock(h);
  return ok;
}

// `logTrip`: one JSON line in the trips log, the log rotated at its size cap. Telemetry only.
function cwLogTrip(event, count) {
  try {
    var rel = cwNamed('trips_file'), size = ah.fs.size(ah.home() + '/' + rel);
    if (size !== null && size >= cwN('trips_max_bytes')) ah.state.op(ah.home(), 'rename', rel, rel + '.1');
    ah.state.appendFile(rel, JSON.stringify({ ts: new Date(ah.clock.now()).toISOString(), event: event, count: count }) + '\n');
  } catch (e) { /* telemetry only */ }
}

// `foldStale`: at most once per throttle window, fold window files older than the pruning TTL into the metrics and remove them.
function cwFoldStale(now) {
  var stamp = cwReadJson(cwNamed('fold_stamp_file'));
  if (stamp && typeof stamp.ts === 'number' && isFinite(stamp.ts) && now - stamp.ts < cwN('fold_throttle_ms')) return;
  var ttl = ah.cfgNum('guardkit.prune_ttl_ms'), names = ah.fs.readdir(ah.home() + '/' + cwDir());
  var re = new RegExp('^' + cwT('session_file_prefix').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.+' + ah.cfg('guardkit.state_ext').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  (names || []).filter(function (n) { return re.test(n); }).forEach(function (name) {
    var rel = cwDir() + '/' + name, mt = ah.fs.mtimeMs(ah.home() + '/' + rel);
    if (mt === null || now - mt <= ttl) return;
    var h = cwLock(rel);
    if (h === null) return;
    var again = ah.fs.mtimeMs(ah.home() + '/' + rel);
    if (again !== null && now - again > ttl) {
      cwBump(function (m) {
        var s = cwNormalize(cwReadJson(rel)) || cwEmpty(cwT('unknown_version'));
        var v = s.version || cwT('unknown_version');
        var e = m.byVersion[v];
        if (!e) { e = {}; cwT('version_keys').forEach(function (k) { e[k] = 0; }); }
        e.sessions += 1;
        cwT('counters').forEach(function (k) { e[k] += s[k]; });
        m.byVersion[v] = e;
        m.maxSessionBlocks = Math.max(m.maxSessionBlocks || 0, s.blocks);
        if (!ah.state.remove(rel)) return false;
      });
    }
    ah.state.unlock(h);
  });
  try { ah.state.writeAtomic(cwNamed('fold_stamp_file'), JSON.stringify({ ts: now })); } catch (e) { /* a lost sweep stamp only repeats the sweep */ }
}

// ---- classification that needs no classifier -------------------------------------------------------------------------------------------

// True ONLY for a command built from a closed vocabulary: every segment starts with a read-only verb (or `git <read-only sub>`) and the
// whole string has no quote, substitution, redirect, glob, brace, backslash or assignment.
function cwProvablyNotWork(command) {
  if (command.trim() === '' || command.length > cwN('safe_max_len') || !new RegExp(cwT('safe_command')).test(command)) return false;
  var argRe = new RegExp(cwT('safe_arg')), verbRe = new RegExp(cwT('safe_verb')), gitFlag = new RegExp(cwT('git_output_flag')), ro = cwT('readonly_verbs'), roGit = cwT('readonly_git_subs');
  var segs = command.split(new RegExp(cwT('segment_split')));
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].indexOf('&') >= 0) return false;
    var t = segs[i].trim().split(/\s+/).filter(function (x) { return x !== ''; });
    if (t.length === 0) continue;
    if (!t.every(function (x, k) { return k === 0 ? verbRe.test(x) : argRe.test(x); })) return false;
    if (ro.indexOf(t[0]) >= 0) continue;
    if (t[0] === cwT('git_verb') && t.length >= 2 && roGit.indexOf(t[1]) >= 0 && !t.slice(2).some(function (a) { return gitFlag.test(a); })) continue;
    return false;
  }
  return true;
}

// `NUDGE(count, cfg)`.
function cwNudge(count, cfg) {
  var minutes = Math.round(cfg.tMs / 60000);
  var instead = cfg.blockAt > 0 ? text.render(cwT('nudge_instead_block'), { block_at: cfg.blockAt }) : cwT('nudge_instead');
  return text.message('warn', cwT('guard_name'), { what: text.render(cwT('nudge_what'), { count: count, minutes: minutes }), instead: instead });
}

// The plugin version that stamps a new window file: the plugin manifest's `version`.
function cwVersion(root) {
  var raw = ah.fs.readText(root + '/' + cwT('plugin_json'));
  if (raw === null) return cwT('unknown_version');
  try { var v = JSON.parse(raw).version; return typeof v === 'string' && v ? v : cwT('unknown_version'); } catch (e) { return cwT('unknown_version'); }
}

function cwPost(p, opts) {
  if (!jx.isObj(p) || p.tool_name !== 'Bash') return 'allow';
  var sid = typeof p.session_id === 'string' ? p.session_id.trim() : '';
  if (sid === '') return 'allow';
  if (!cwCoordinator(p) || ah.settings.skipped(cwT('command_guard_name')) || !ah.settings.bool('coordinator_work.command_guard_setting')) return 'allow';
  var cfg = cwConfig();
  if (cfg.tMs === 0) return 'allow';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : (ah.env.get(ah.cfg('env.plugin_root')) || '');
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || home === '' || root === '') return 'defer';
  var command = jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  var now = ah.clock.now();
  var id = typeof p.tool_use_id === 'string' && p.tool_use_id !== '' && command.trim() !== '' ? p.tool_use_id : '';
  var rel = cwSessionRel(sid), seen = cwNormalize(cwReadJson(rel));
  var stored = id !== '' && seen !== null ? cwTakePre(seen, id) : null, work;
  if (stored !== null) work = stored.work;
  else if (cwProvablyNotWork(command)) work = false;
  else return 'defer'; // the classification needs command-guard's `classifyBashWork`: the Node hook decides
  // update(): the window file under its lock; a lock another process holds is the Node hook's to wait for or to take over. Everything is
  // decided in memory first and the metrics lock (taken after the window lock, the order Node keeps) is acquired before anything is
  // written, so a lock that cannot be had hands the whole call to Node with nothing recorded.
  var lock = cwLock(rel);
  if (lock === null) return 'defer';
  var s = cwNormalize(cwReadJson(rel)) || cwEmpty(cwVersion(root));
  if (id !== '') cwTakePre(s, id);
  var crossing = cwStep(s, now, work, cfg);
  var nudge = crossing !== null && cfg.nudgeAt > 0 && !ah.settings.skipped(cwT('guard_name')) ? crossing : null;
  var metricsLock = null;
  if (nudge !== null) {
    metricsLock = cwLock(cwNamed('metrics_file'));
    if (metricsLock === null) { ah.state.unlock(lock); return 'defer'; }
  }
  try { ah.state.writeAtomic(rel, JSON.stringify(s)); } catch (e) { /* a lost window write is the Node hook's loss too */ }
  ah.state.unlock(lock);
  var out = 'allow';
  if (nudge !== null) {
    cwBumpLocked(function (m) { m.nudges += 1; });
    ah.state.unlock(metricsLock);
    cwLogTrip(cwT('trip_nudge'), nudge);
    out = { advisory: text.advisoryJson(cwT('post_event'), cwNudge(nudge, cfg)) };
  }
  cwFoldStale(now);
  return out;
}

function decide(p, opts, event) {
  if (event === cwT('post_event')) return cwPost(p, opts);
  if (!jx.isObj(p) || p.tool_name !== 'Bash') return 'allow';
  if (typeof p.session_id !== 'string' || p.session_id.trim() === '') return 'allow';
  if (cwSubagent(p)) return 'allow';
  return 'defer';
}

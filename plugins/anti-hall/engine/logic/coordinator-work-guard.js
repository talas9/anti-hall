// check = "coordinator-work-guard" (PreToolUse and PostToolUse on Bash): the main-thread WORK window. Pre blocks a blockable WORK
// call when the session's window already holds blockAt - 1 WORK calls; Post records the call in the window, says one COORDINATOR
// DRIFT note per crossing of nudgeAt and folds stale window files into the metrics. WORK is the command classifier of command-guard
// (`classifyBashWork`, in command.js, which this script builds on: script.includes). Mirrors hooks/coordinator-work-guard.js and
// hooks/lib/coordinator-work.js; the window file, its lock, the metrics and the trips log are the files and the lock protocol the
// Node hook uses, byte for byte, so the engine and a Node hook answering for the same session in turn see one record. Every name,
// limit, pattern and text is in small_guards.toml (coordinator_work.*).
//
// Never weaker than Node: a question only the Node hook can answer (the hook process's working directory, a lock another process
// holds) defers the whole call with nothing written; a script failure defers too.
'use strict';

// ---------------------------------------------------------------------------------------------------------------------
// window state (hooks/lib/coordinator-work.js)

function cwInt(v, dflt, min) {
  var n = Number(v);
  return isFinite(n) && n >= min ? Math.floor(n) : dflt;
}
// `config(env)`: the window length (minutes to ms), the nudge and block thresholds and the stored-timestamp cap
function cwConfig() {
  return {
    tMs: cwInt(ah.settings.numStrict('coordinator_work.window_setting'), ah.cfg('coordinator_work.window_default'), 0) * 60000,
    nudgeAt: cwInt(ah.settings.numStrict('coordinator_work.nudge_setting'), ah.cfg('coordinator_work.nudge_default'), 0),
    blockAt: cwInt(ah.settings.numStrict('coordinator_work.block_setting'), ah.cfg('coordinator_work.block_default'), 0),
    cap: cwInt(ah.settings.numStrict('coordinator_work.cap_setting'), ah.cfg('coordinator_work.cap_default'), 1),
  };
}
function cwEmptyState(version) {
  return { v: 1, version: version, firstTs: 0, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0, pre: [] };
}
function cwVersion(pluginRoot) {
  var unknown = ah.cfg('coordinator_work.unknown_version');
  if (!pluginRoot) return unknown;
  var t = ah.fs.readText(pluginRoot + '/' + ah.cfg('coordinator_work.plugin_json'));
  if (t === null) return unknown;
  try { var v = JSON.parse(t).version; return typeof v === 'string' && v ? v : unknown; } catch (e) { return unknown; }
}
function cwRememberPre(state, id, v) {
  state.pre = (state.pre || []).filter(function (e) { return e.id !== id; });
  state.pre.push({ id: id, work: !!v.work, blockable: !!v.blockable });
  var cap = ah.cfg('coordinator_work.pre_cap');
  if (state.pre.length > cap) state.pre = state.pre.slice(-cap);
  return state;
}
function cwTakePre(state, id) {
  var list = state && Array.isArray(state.pre) ? state.pre : [];
  var k = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) { k = i; break; }
  if (k === -1) return null;
  var e = list.splice(k, 1)[0];
  return { work: e.work, blockable: e.blockable };
}
function cwNormalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var s = cwEmptyState(typeof raw.version === 'string' && raw.version ? raw.version : ah.cfg('coordinator_work.unknown_version'));
  if (isFinite(raw.firstTs) && typeof raw.firstTs === 'number' && raw.firstTs > 0) s.firstTs = raw.firstTs;
  if (Array.isArray(raw.ts)) s.ts = raw.ts.filter(function (t) { return typeof t === 'number' && isFinite(t); });
  s.armed = raw.armed !== false;
  if (Array.isArray(raw.pre)) {
    s.pre = raw.pre.filter(function (e) { return e && typeof e.id === 'string' && e.id && typeof e.work === 'boolean' && typeof e.blockable === 'boolean'; })
      .map(function (e) { return { id: e.id, work: e.work, blockable: e.blockable }; }).slice(-ah.cfg('coordinator_work.pre_cap'));
  }
  ah.cfg('coordinator_work.counters').concat(['lastBlockAt']).forEach(function (k) { if (typeof raw[k] === 'number' && isFinite(raw[k]) && raw[k] >= 0) s[k] = raw[k]; });
  return s;
}
function cwSessionStart(state, now) { return state && state.firstTs ? state.firstTs : now - ah.cfg('coordinator_work.session_start_ms'); }
function cwPrune(state, now, cfg) {
  state.ts = state.ts.filter(function (t) { return now - t < cfg.tMs; });
  if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  return state;
}
function cwCheckPre(state, p, cfg) {
  var count = state && Array.isArray(state.ts) ? state.ts.filter(function (t) { return p.now - t < cfg.tMs; }).length : 0;
  return { wouldBlock: cfg.tMs > 0 && cfg.blockAt > 0 && !!p.work && !!p.blockable && count >= cfg.blockAt - 1, count: count };
}
function cwStepPost(state, p, cfg) {
  if (!state.firstTs) state.firstTs = p.now;
  cwPrune(state, p.now, cfg);
  if (state.ts.length < cfg.nudgeAt) state.armed = true;
  state.calls++;
  if (p.work) {
    state.work++;
    state.ts.push(p.now);
    if (state.ts.length > cfg.cap) state.ts = state.ts.slice(-cfg.cap);
  }
  var crossing = null;
  if (cfg.nudgeAt > 0 && state.ts.length >= cfg.nudgeAt && state.armed) {
    state.armed = false;
    crossing = { count: state.ts.length };
  }
  return { state: state, crossing: crossing };
}

// ---- files (the state directory under the home directory; the scoped host primitives)

function cwDirRel() { return ah.cfg('script.write_root'); }
function cwSafeId(sid) { return String(sid || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfg('coordinator_work.session_id_max')); }
function cwSessionRel(sid) { return cwDirRel() + '/' + ah.cfg('coordinator_work.session_file_prefix') + cwSafeId(sid) + ah.cfg('guardkit.state_ext'); }
function cwMetricsRel() { return cwDirRel() + '/' + ah.cfg('coordinator_work.metrics_file'); }
function cwStampRel() { return cwDirRel() + '/' + ah.cfg('coordinator_work.fold_stamp_file'); }
function cwTripsRel() { return cwDirRel() + '/' + ah.cfg('coordinator_work.trips_file'); }
function cwReadJson(rel) {
  var t = ah.state.readText(rel);
  if (t === null) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}
function cwWrite(rel, obj) { return ah.state.writeAtomic(rel, JSON.stringify(obj)); }
function cwLockWait() {
  if (ah.env.get(ah.cfg('coordinator_work.lock_isolation_env'))) {
    var n = Number(ah.env.get(ah.cfg('coordinator_work.lock_wait_env')));
    if (isFinite(n) && n >= 0 && ah.env.get(ah.cfg('coordinator_work.lock_wait_env')) !== null) return n;
  }
  return ah.cfg('coordinator_work.lock_wait_ms');
}
function cwLock(rel) { return ah.state.lock(rel + ah.cfg('coordinator_work.lock_suffix'), 'coordinator_work', cwLockWait()); }

// `update(home, sid, fn)` under the window lock; null when the lock was not taken (the whole call then defers). The first change to
// shared state lifts the call's time limit: an interrupt after it would defer to the Node hook, which would count the call again.
function cwUpdate(sid, fn) {
  ah.commit();
  var rel = cwSessionRel(sid), h = cwLock(rel);
  if (h === null) return null;
  try {
    var s = cwNormalize(cwReadJson(rel)) || cwEmptyState(cwVersion(S.pluginRoot));
    fn(s);
    cwWrite(rel, s);
    return s;
  } finally { ah.state.unlock(h); }
}

function cwNormalizeMetrics(raw) {
  var m = { v: 1, nudges: 0, blocks: 0, byVersion: {} };
  if (raw && typeof raw === 'object') {
    ['nudges', 'blocks', 'maxSessionBlocks'].forEach(function (k) { if (typeof raw[k] === 'number' && isFinite(raw[k]) && raw[k] >= 0) m[k] = raw[k]; });
    if (raw.byVersion && typeof raw.byVersion === 'object') {
      Object.keys(raw.byVersion).forEach(function (v) {
        var e = raw.byVersion[v];
        if (!e || typeof e !== 'object') return;
        var o = {};
        ah.cfg('coordinator_work.version_keys').forEach(function (k) { o[k] = 0; });
        Object.keys(o).forEach(function (k) { if (typeof e[k] === 'number' && isFinite(e[k]) && e[k] >= 0) o[k] = e[k]; });
        m.byVersion[v] = o;
      });
    }
  }
  return m;
}
// `bumpMetrics(home, fn)` under the metrics lock; false when the lock was not taken. `fn` may decline (false) a change.
function cwBumpMetrics(fn) {
  var rel = cwMetricsRel(), h = cwLock(rel);
  if (h === null) return false;
  try {
    var m = cwNormalizeMetrics(cwReadJson(rel));
    if (fn(m) === false) return false;
    return cwWrite(rel, m);
  } finally { ah.state.unlock(h); }
}
function cwLogTrip(obj) {
  var rel = cwTripsRel(), st = ah.fs.lstat(ah.home() + '/' + rel);
  if (st && st.kind === 'file' && st.size >= ah.cfg('coordinator_work.trips_max_bytes')) ah.state.op(ah.home(), 'rename', rel, rel + '.1');
  ah.state.appendFile(rel, JSON.stringify(Object.assign({ ts: new Date(ah.clock.now()).toISOString() }, obj)) + '\n');
}
// `foldStale(home, now)`: at most once per throttle window, fold window files older than the pruning TTL into the metrics.
function cwFoldStale(now) {
  var stamp = cwReadJson(cwStampRel());
  if (stamp && typeof stamp.ts === 'number' && isFinite(stamp.ts) && now - stamp.ts < ah.cfg('coordinator_work.fold_throttle_ms')) return 0;
  var ttl = ah.cfgNum('guardkit.prune_ttl_ms'), dir = ah.home() + '/' + cwDirRel(), folded = 0;
  var re = new RegExp('^' + cmdEsc(ah.cfg('coordinator_work.session_file_prefix')) + '.+' + cmdEsc(ah.cfg('guardkit.state_ext')) + '$');
  var names = (ah.fs.readdir(dir) || []).filter(function (f) { return re.test(f); });
  names.forEach(function (name) {
    var rel = cwDirRel() + '/' + name, p = dir + '/' + name, st = ah.fs.lstat(p);
    if (!st || st.kind === 'error' || now - st.mtimeMs <= ttl) return;
    var h = cwLock(rel);
    if (h === null) return;
    try {
      st = ah.fs.lstat(p);
      if (!st || st.kind === 'error' || now - st.mtimeMs <= ttl) return;
      cwBumpMetrics(function (m) {
        var s = cwNormalize(cwReadJson(rel)) || cwEmptyState(ah.cfg('coordinator_work.unknown_version'));
        var v = s.version || ah.cfg('coordinator_work.unknown_version');
        var e = m.byVersion[v];
        if (!e) { e = {}; ah.cfg('coordinator_work.version_keys').forEach(function (k) { e[k] = 0; }); }
        e.sessions += 1;
        ah.cfg('coordinator_work.counters').forEach(function (k) { e[k] += s[k]; });
        m.byVersion[v] = e;
        m.maxSessionBlocks = Math.max(m.maxSessionBlocks || 0, s.blocks);
        if (!ah.state.remove(rel)) return false;
        folded++;
        return true;
      });
    } finally { ah.state.unlock(h); }
  });
  cwWrite(cwStampRel(), { ts: now });
  return folded;
}

// ---- classification that needs no classifier: a closed vocabulary of read-only commands (`provablyNotWork`)

function cwProvablyNotWork(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > ah.cfg('coordinator_work.safe_max_len')) return false;
  if (!new RegExp(ah.cfg('coordinator_work.safe_command')).test(command)) return false;
  var arg = new RegExp(ah.cfg('coordinator_work.safe_arg')), verb = new RegExp(ah.cfg('coordinator_work.safe_verb')), flag = new RegExp(ah.cfg('coordinator_work.git_output_flag'));
  var segs = command.split(new RegExp(ah.cfg('coordinator_work.segment_split')));
  for (var i = 0; i < segs.length; i++) {
    if (/&/.test(segs[i])) return false;
    var t = segs[i].trim().split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    if (!t.every(function (x, j) { return j === 0 ? verb.test(x) : arg.test(x); })) return false;
    if (ah.cfg('coordinator_work.readonly_verbs').indexOf(t[0]) >= 0) continue;
    if (t[0] === ah.cfg('coordinator_work.git_verb') && t.length >= 2 && ah.cfg('coordinator_work.readonly_git_subs').indexOf(t[1]) >= 0 && !t.slice(2).some(function (a) { return flag.test(a); })) continue;
    return false;
  }
  return true;
}

// ---- the texts

function cwMinutes(cfg) { return Math.round(cfg.tMs / 60000); }
function cwBlock(count, cfg) {
  return text.message('block', ah.cfg('coordinator_work.guard_name'), {
    what: text.render(ah.cfg('coordinator_work.block_what'), { count: count, minutes: cwMinutes(cfg) }),
    why: ah.cfg('coordinator_work.block_why'), instead: ah.cfg('coordinator_work.block_instead'), allowed: ah.cfg('coordinator_work.block_allowed'),
    override: text.render(ah.cfg('coordinator_work.block_override'), { skip: LIB['./lib/skip-cmd.js'].skipCommand(ah.cfg('coordinator_work.guard_name')) }),
  });
}
function cwNudge(count, cfg) {
  return text.message('warn', ah.cfg('coordinator_work.guard_name'), {
    what: text.render(ah.cfg('coordinator_work.nudge_what'), { count: count, minutes: cwMinutes(cfg) }),
    instead: cfg.blockAt > 0 ? text.render(ah.cfg('coordinator_work.nudge_instead_block'), { block_at: cfg.blockAt }) : ah.cfg('coordinator_work.nudge_instead'),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// the decision (hooks/coordinator-work-guard.js `main`)

function cwMain(payload, post) {
  if (!payload || typeof payload !== 'object' || payload.tool_name !== 'Bash') return 'allow';
  var sid = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sid) return 'allow';
  if (!coordinator.isCoordinator(payload)) return 'allow';
  if (ah.settings.skipped(ah.cfg('coordinator_work.command_guard_name'))) return 'allow';
  if (!ah.settings.bool('coordinator_work.command_guard_setting')) return 'allow';
  var cfg = cwConfig();
  if (!cfg.tMs) return 'allow';
  var command = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
  var home = io.homeOf();
  if (!path.isAbsolute(home) || !S.pluginRoot) return 'defer';
  var now = ah.clock.now();
  var st = cwNormalize(cwReadJson(cwSessionRel(sid)));
  var id = typeof payload.tool_use_id === 'string' && payload.tool_use_id && command.trim() ? payload.tool_use_id : '';
  var classify = function () {
    return cwProvablyNotWork(command) ? { work: false, blockable: false } : classifyBashWork(command, payload, { sessionStartTs: cwSessionStart(st, now) });
  };
  var skipped = function () { return ah.settings.skipped(ah.cfg('coordinator_work.guard_name')); };

  if (!post) {
    var r = classify();
    if (S.unsure) return 'defer';
    var v = { work: r.work, blockable: r.blockable };
    var pre = cwCheckPre(st, { now: now, work: r.work, blockable: r.blockable }, cfg);
    if (!pre.wouldBlock) {
      if (id && cwUpdate(sid, function (s) { cwRememberPre(s, id, v); }) === null) return 'defer';
      return 'allow';
    }
    if (skipped()) {
      if (cwUpdate(sid, function (s) { s.skippedWouldBlock++; if (id) cwRememberPre(s, id, v); }) === null) return 'defer';
      cwLogTrip({ event: ah.cfg('coordinator_work.trip_skipped'), count: pre.count });
      return 'allow';
    }
    if (cwUpdate(sid, function (s) { s.blocks++; s.lastBlockAt = now; }) === null) return 'defer';
    cwBumpMetrics(function (m) { m.blocks++; });
    cwLogTrip({ event: ah.cfg('coordinator_work.trip_block'), count: pre.count });
    return { exact: { code: 2, out: JSON.stringify({ decision: 'block', reason: cwBlock(pre.count, cfg) }) + '\n', err: '' } };
  }

  var stored = id && st ? cwTakePre(st, id) : null;
  var work = stored ? stored.work : classify().work;
  if (S.unsure) return 'defer';
  var crossing = null;
  if (cwUpdate(sid, function (s) {
    if (id) cwTakePre(s, id);
    crossing = cwStepPost(s, { now: now, work: work }, cfg).crossing;
  }) === null) return 'defer';
  var out = 'allow';
  if (crossing && cfg.nudgeAt > 0 && !skipped()) {
    cwBumpMetrics(function (m) { m.nudges++; });
    cwLogTrip({ event: ah.cfg('coordinator_work.trip_nudge'), count: crossing.count });
    out = { advisory: text.advisoryJson(ah.cfg('coordinator_work.post_event'), cwNudge(crossing.count, cfg)) };
  }
  cwFoldStale(now);
  return out;
}

function decide(p, opts, event) {
  cmdBegin(opts);
  var v;
  try { v = cwMain(p, event === ah.cfg('coordinator_work.post_event')); } catch (e) { if (!cmdFatal(e)) throw e; S.unsure = true; v = null; }
  return cmdEnd() || v === null ? 'defer' : v;
}

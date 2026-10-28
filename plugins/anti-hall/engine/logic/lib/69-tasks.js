// Helpers the task Stop gates share (D88 batch 6; mirrors hooks/lib/task-state.js and the text helpers of task-guard.js and
// tasklist-guard.js): the task list from the engine's reconstruction, the one-line text sanitizer, the safe state key, the
// unknown-state note and the DevSwarm app database test. Keys: task_guards.toml (taskstate.*, taskkit.*, task_guard.*).
'use strict';
var tk = {
  // `String(x).replace(/[^A-Za-z0-9_.-]/g, '_')`, one underscore per UTF-16 unit.
  safeKey: function (s) { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_'); },
  // The tasks of a transcript tail ('guard' variant): an array of the engine's task records; a tail the engine cannot read exactly
  // (counted) keeps any known records and carries an uncertainty flag.
  tasks: function (path) {
    var r = ah.transcript.tasks(path, 'guard', ah.cfgNum('taskstate.tail_bytes'));
    if (r.unsure) ah.unable('tasks:tail_unsure');
    var tasks = r.unreadable ? [] : (r.tasks || []);
    tasks.unsure = !!r.unsure;
    return tasks;
  },
  // The task list in Claude Code's own store for the session (`<home>/<store_base>/<dir name>/<id>.json`), or null when there is none
  // or it cannot be read within the bounds. A long session's transcript tail no longer holds the creates, so the store is the source of
  // what is done and open; the transcript's tasks only add what the store does not carry.
  storeTasks: function (home, sid) {
    if (!home || typeof sid !== 'string' || sid === '' || /[^A-Za-z0-9_-]/.test(sid)) return null;
    var base = home + '/' + ah.cfg('taskstate.store_base').join('/') + '/', names = ah.cfg('taskstate.store_dir_names');
    var suffix = ah.cfg('taskstate.store_file_suffix'), maxFiles = ah.cfgNum('taskstate.store_max_files'), maxBytes = ah.cfgNum('taskstate.store_file_max_bytes');
    for (var i = 0; i < names.length; i++) {
      var dir = base + text.render(names[i], { sid: sid, sid8: sid.slice(0, 8) });
      var files = ah.fs.readdir(dir);
      if (files === null) continue;
      files = files.filter(function (f) { return f.length > suffix.length && f.slice(-suffix.length) === suffix; });
      if (files.length > maxFiles) { ah.unable('tasks:store_big'); return null; }
      var out = [];
      for (var k = 0; k < files.length; k++) {
        var raw = ah.fs.readText(dir + '/' + files[k], maxBytes);
        if (raw === null) continue;
        var rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (rec === null || typeof rec !== 'object' || (typeof rec.id !== 'string' && typeof rec.id !== 'number') || typeof rec.status !== 'string') continue;
        out.push({
          id: String(rec.id), content: typeof rec.subject === 'string' ? rec.subject : String(rec.id),
          description: typeof rec.description === 'string' ? rec.description : '', status: rec.status,
          owner: typeof rec.owner === 'string' ? rec.owner.trim() : '',
          blockedBy: Array.isArray(rec.blockedBy) ? rec.blockedBy.map(String) : [],
        });
      }
      if (out.length > 0) return out;
    }
    return null;
  },
  // The store's tasks laid over the transcript's: the store is the list (a task it lacks is gone), and for a task both hold the store
  // gives subject, status, owner and blockers while the transcript keeps its other facts (blockedOn marker, time).
  withStore: function (tasks, store) {
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    return store.map(function (s) {
      var t = byId[s.id] || { id: s.id, priority: null, subjectUpdated: false, sinceMs: null };
      t.content = s.content; t.description = t.description || s.description; t.status = s.status; t.owner = s.owner; t.blockedBy = s.blockedBy;
      t.unknown = null; t.blockUnknown = false;
      return t;
    });
  },
  statusLc: function (t) { return (t.status || '').toLowerCase(); },
  isOpen: function (t) { return ah.cfg('taskstate.open_statuses').indexOf(tk.statusLc(t)) >= 0; },
  isDone: function (t) { return ah.cfg('taskstate.done_statuses').indexOf(tk.statusLc(t)) >= 0; },
  // The blockedOn marker as the owner-blocked test reads it: a string trimmed and lowercased, else empty.
  blockedOnText: function (t) { return typeof t.blockedOn === 'string' ? t.blockedOn.trim().toLowerCase() : ''; },
  // oneLine: control characters become spaces, white space runs collapse, the text is trimmed and cut to `max` UTF-16 units with an
  // ellipsis; a cut through a surrogate pair drops the half pair (a Rust string cannot hold one).
  oneLine: function (s, max) {
    var o = jx.replaceAll(ah.cfg('taskkit.control_chars'), '', s, ' ').replace(/\s+/g, ' ').trim();
    if (o.length > max) {
      var cut = o.slice(0, max), last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) { ah.unable('oneline:pair_cut'); cut = cut.slice(0, -1); }
      return cut.replace(/\s+$/, '') + ah.cfg('taskkit.ellipsis');
    }
    return o;
  },
  // Tasks whose status is unknown, and open tasks whose block state could not be established.
  unknownIds: function (tasks) {
    return tasks.filter(function (t) { return t.status === null || (tk.isOpen(t) && t.blockUnknown); }).map(function (t) { return t.id; });
  },
  // The unknown-state note and the write that goes with saying it: {note, write: function () -> note|''}. A note file of a shape the
  // script does not model is read as absent (counted); the next write replaces it.
  unknownNote: function (tasks, home, sessionId, tag) {
    var none = { note: '', write: function () { return ''; } };
    var ids = tk.unknownIds(tasks);
    if (ids.length === 0) return none;
    var count = ids.length;
    ids.sort();
    var hash = ah.sha1(ids.join('\u0000'));
    var dir = ah.cfg('paths.base_dir'), prefix = ah.cfg('taskstate.unknown_file_prefix');
    var rel = dir + '/' + prefix + '-' + tag + '-' + tk.safeKey(sessionId || 'nosession') + '.json';
    var lastHash = '', lastN = 0;
    var f = jx.read(home + '/' + rel);
    if (f.big) ah.unable('unknown_note:file_big');
    if (f.text !== undefined) {
      var r = jx.parse(f.text.trim());
      if (r.unsure) ah.unable('unknown_note:parse_unsure');
      else if (!r.invalid && r.v !== null && typeof r.v === 'object') {
        var h = r.v.hash;
        if (h) { if (typeof h === 'object') ah.unable('unknown_note:hash_shape'); else lastHash = String(h); }
        var n = r.v.n;
        if (n !== null && n !== undefined && typeof n === 'object') ah.unable('unknown_note:n_shape');
        else lastN = Number(n) || 0;
      }
    }
    if (lastHash === hash || lastN >= ah.cfgNum('taskstate.unknown_max_notes')) return none;
    var note = text.render(ah.cfg('taskstate.unknown_note_text'), { n: count });
    return {
      note: note,
      write: function () {
        if (!ah.state.writeAtomic(rel, JSON.stringify({ hash: hash, n: lastN + 1 }))) return '';
        ah.state.prune(prefix, rel.slice(rel.lastIndexOf('/') + 1));
        return note;
      },
    };
  },
  // The DevSwarm app database file `companion/lib/devswarm-app-db.js` names, or null when there is none.
  appDbPath: function (home) {
    var over = (ah.env.get(ah.cfg('task_guard.app_db_env')) || '').trim();
    if (over) return over.toLowerCase() !== ah.cfg('task_guard.app_db_off') ? over : null;
    if (!home) return null;
    var base;
    var plat = ah.platform();
    if (plat === 'macos') base = home + '/' + ah.cfg('task_guard.app_db_darwin_dir').join('/');
    else if (plat === 'linux') {
      var x = ah.env.get(ah.cfg('task_guard.app_db_xdg_env'));
      base = x ? x : home + '/' + ah.cfg('task_guard.app_db_linux_config');
    } else return null;
    return base + '/' + ah.cfg('task_guard.app_db_file').join('/');
  },
  // True when the DevSwarm app database file exists (without it the answers below are fixed: no record, nothing live).
  appDbPresent: function (home) { var p = tk.appDbPath(home); return p !== null && ah.fs.isFile(p); },
  // `devswarmChildAttended(owner)`: true only when `owner` (a workspace id, branch or title) names a workspace the app database shows
  // live. A blank, coordinator-like or unknown owner, an archived workspace and an unreadable database all answer false.
  childAttended: function (owner) {
    var o = (owner || '').trim();
    if (!o || jx.re('task_guard.coordinator_owner_re', 'i').test(o)) return false;
    var id = o.replace(jx.re('task_guard.workspace_prefix_re', 'i'), '').trim();
    if (!id || !tk.appDbPresent(ah.home())) return false;
    var verdict = ah.mesh.appArchived(id, '', false).verdict; // null (no verdict, or one the host cannot give: counted) goes on to the builders list
    if (verdict === false) return true;
    if (verdict === true) return false;
    var all = tk.appBuilders();
    return all !== null && all.some(function (w) { return w.archived === false && (w.branch === id || w.label === id); });
  },
  // The app database's workspaces [{id, archived, branch, label}] (read once per call), or null when there is no readable database.
  appBuilders: function () {
    if (tk.buildersMemo === undefined || tk.buildersGen !== ah.clock.now()) {
      var raw = ahHost.meshAppBuilders();
      tk.buildersMemo = raw === null || raw === undefined ? null : JSON.parse(raw);
      tk.buildersGen = ah.clock.now();
    }
    return tk.buildersMemo;
  },
  // `anyLiveDevswarmChildren()`: the database shows at least one workspace that is not archived.
  anyLiveChildren: function () {
    if (!tk.appDbPresent(ah.home())) return false;
    var all = tk.appBuilders();
    return all !== null && all.some(function (w) { return w.archived !== true; });
  },
};

// ---- shared by task-guard (Stop) and task-tracker (UserPromptSubmit): the dispatch demand --------------------------------------------
// The cap, the per-task cover, the label: `lib/dispatch-demand.js` (`evaluate`, `label`). `wantProven` also computes the Stop block's
// proven count (it reads output-file times); the per-turn line does not.
tk.lastActivity = function (r) {
  var act = NaN, vs = [r.launchedAtMs, r.resumedAtMs === null || r.resumedAtMs === undefined ? NaN : r.resumedAtMs, r.lastSeenMs];
  vs.forEach(function (v) { if (typeof v === 'number' && isFinite(v) && (isNaN(act) || v > act)) act = v; });
  if (r.outputFile) {
    if (r.outputFile.charAt(0) !== '/') ah.unable('lastactivity:relative_output'); // Node resolves it against its own directory; here it is not read
    else {
      var m = ah.fs.mtimeMs(r.outputFile);
      if (m !== null && isFinite(m) && (isNaN(act) || m > act)) act = m;
    }
  }
  return act;
};
tk.cap = function () {
  var v = ah.settings.num('task_guard.max_parallel_setting');
  if (isFinite(v) && v > 0) return Math.floor(v);
  var c = ah.sys.cores();
  if (c === null) { ah.unable('cap:cores_unknown'); c = 0; }
  if (c === 0) c = ah.cfgNum('task_guard.cap_fallback_cores');
  return Math.max(ah.cfgNum('task_guard.cap_floor'), Math.min(ah.cfgNum('task_guard.cap_ceiling'), c - ah.cfgNum('task_guard.cap_reserve')));
};
tk.evaluate = function (actionable, tasks, open, running, now, wantProven) {
  if (running === null) return { fire: false, proven: false, unknown: true, dispatch: [], cap: 0 };
  var cap = tk.cap();
  var known = {}, covered = {}, unmapped = 0, refsOf = [];
  tasks.forEach(function (t) { known[t.id] = true; });
  running.forEach(function (a) {
    var refs = [], re = new RegExp(ah.cfg('task_guard.task_ref_re'), 'g'), m;
    while ((m = re.exec(a.description)) !== null) { if (refs.indexOf(m[1]) < 0 && known[m[1]] === true) refs.push(m[1]); if (m[0].length === 0) re.lastIndex++; }
    if (refs.length === 0) unmapped++;
    refs.forEach(function (id) { covered[id] = true; });
    refsOf.push(refs);
  });
  var inProgress = open.filter(function (t) { return jx.re('task_guard.in_progress_re', 'i').test(t.status || '') && covered[t.id] !== true; }).length;
  var onPending = Math.max(0, unmapped - inProgress);
  var dispatch = actionable.filter(function (t) { return covered[t.id] !== true; });
  var fire = dispatch.length > 0 && dispatch.length > onPending && running.length < cap;
  var maxAgeSetting = ah.settings.num('task_guard.agent_max_age_setting');
  var maxAge = (isFinite(maxAgeSetting) && maxAgeSetting >= 0 ? maxAgeSetting : ah.cfgNum('task_guard.agent_max_age_default_min')) * ah.cfgNum('task_guard.ms_per_minute');
  function earliest() {
    if (dispatch.length === 0) return NaN;
    var min = Infinity;
    for (var i = 0; i < dispatch.length; i++) {
      var s = dispatch[i].sinceMs;
      if (s === 'unsure') { ah.unable('evaluate:since_unsure'); return NaN; }
      if (typeof s !== 'number' || !isFinite(s)) return NaN;
      min = Math.min(min, s);
    }
    return min;
  }
  if (!wantProven) return { fire: fire, proven: false, unknown: false, dispatch: dispatch, cap: cap };
  var provenUnmapped = 0, uncounted = 0;
  for (var i = 0; i < running.length; i++) {
    if (refsOf[i].length !== 0) continue;
    var r = running[i], act = tk.lastActivity(r);
    var stale = maxAge > 0 && isFinite(act) && now - act > maxAge;
    var l = typeof r.launchedAtMs === 'number' && isFinite(r.launchedAtMs) ? r.launchedAtMs : -Infinity;
    var rs = typeof r.resumedAtMs === 'number' && isFinite(r.resumedAtMs) ? r.resumedAtMs : -Infinity;
    var started = Math.max(l, rs), before = false;
    if (!stale && isFinite(started)) {
      var e = earliest();
      before = isFinite(e) && started < e;
    }
    if (stale || before) uncounted++; else provenUnmapped++;
  }
  var proven = dispatch.length > 0 && dispatch.length > provenUnmapped && (running.length - uncounted) < cap;
  return { fire: fire, proven: proven, unknown: false, dispatch: dispatch, cap: cap };
};
tk.label = function (t) {
  var src = t.content ? t.content : t.id;
  var subj = tk.oneLine(src.replace(jx.re('task_guard.label_priority_prefix_re', 'i'), ''), ah.cfgNum('task_guard.label_max'));
  var quoted = JSON.stringify(subj ? subj : t.id);
  if (!/^[0-9]+$/.test(t.id)) return quoted;
  return subj && subj !== t.id ? '#' + t.id + ' ' + quoted : '#' + t.id;
};

// ---- raw transcript and Jev primitives of the task family (the rules that use them live in the check scripts) ----------------------
Object.assign(ah.transcript, {
  // The lines of the last `bytes` of a transcript (the cut first line dropped) that contain every string of `needles` and, when `re` is
  // given, match it: {lines: [...]}, null (unreadable), or {unsure: true} (relative path, or more lines than the host hands over).
  grep: function (p, bytes, needles, re, flags) { var r = ahHost.transcriptGrep(p, bytes || 0, JSON.stringify(needles), re || '', flags || ''); return r === null || r === undefined ? null : JSON.parse(r); },
  // {rows: [{id, description}] | null (the count cannot be trusted), seen: [launched ids], windowBytes}, or {unsure: true}.
  countProof: function (p) { return JSON.parse(ahHost.agentCountProof(p)); },
});
// The shared Jev cache entry under `hash`: null (none), {unsure: true}, or {answer: string|null, confidence: number|null}.
ah.jev.cachePeek = function (hash) { var r = ahHost.jevCachePeek(hash); return r === null || r === undefined ? null : JSON.parse(r); };

// ---- the dispatch-tier state file (hooks/lib/dispatch-tier.js readState/writeState), shared by the dispatch-tier hook and task-tracker ----
// `readState(home)`: the state object with `requested` and `sessions` objects in place. A file over the read cap, one the script cannot
// parse exactly, or one whose parts are arrays is read as a fresh state (counted); the next write replaces it (the repair).
// `readOnly`: the caller only looks things up, so a state whose parts are arrays is read as JavaScript reads it (an array is indexed by
// the keys that name no element).
tk.tierRead = function (path, readOnly) {
  var s = {};
  var f = jx.read(path);
  if (f.big) ah.unable('tier:file_big');
  if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) ah.unable('tier:parse_unsure');
    else if (r.v !== undefined && r.v !== null && typeof r.v === 'object') {
      if (Array.isArray(r.v) && !readOnly) ah.unable('tier:array_state');
      else s = r.v;
    }
  }
  var keys = ['requested', 'sessions'];
  for (var i = 0; i < keys.length; i++) {
    var v = s[keys[i]];
    if (Array.isArray(v) && !readOnly) { ah.unable('tier:array_part'); s[keys[i]] = {}; continue; }
    if (!v || typeof v !== 'object') s[keys[i]] = {};
  }
  return s;
};

// `writeState(home, s)`: bounded, then replaced atomically. Best effort, as in Node.
tk.tierWrite = function (rel, s, now) {
  var max = ah.cfgNum('dispatch_tier.max_sessions');
  var sids = Object.keys(s.sessions);
  if (sids.length > max) {
    sids.sort(function (a, b) { return ((s.sessions[a] && s.sessions[a].t) || 0) - ((s.sessions[b] && s.sessions[b].t) || 0); });
    sids.slice(0, sids.length - max).forEach(function (k) { delete s.sessions[k]; });
  }
  var ttl = ah.cfgNum('dispatch_tier.request_ttl_ms');
  Object.keys(s.requested).forEach(function (k) { var v = s.requested[k]; if (!Number.isFinite(v) || now - v > ttl) delete s.requested[k]; });
  ah.state.writeAtomic(rel, JSON.stringify(s)); // a lost write only means the tier question is asked again
};

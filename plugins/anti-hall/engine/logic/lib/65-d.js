// Batch-6 additions to the `ah` API (D88): the task list, the agent scan, the Jev outcome and cache probes, the plugin versions
// and the CPU count. Shaped from the raw `ahHost` functions the engine installs; they carry no rule.
'use strict';
// The task snapshot (#390): a transcript tail of taskstate.tail_bytes cannot show a task list whose creates lie further back, so a
// session's last rebuilt list is kept in one file (taskstate.snapshot_*) and the tail's result is laid over it. Every failure leaves the
// rebuild as the tail alone gives it, counted under snapshot_error; the engine never deletes a snapshot file.
var taskSnap = {
  count: function (name, labels, by) { ah.metric(name, labels || {}, by); },
  // `<base_dir>/<snapshot_dir>/<file>` for a transcript path.
  rel: function (p) {
    var base = ah.path.basename(p), dot = base.lastIndexOf('.');
    var name = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('taskstate.snapshot_name_max'));
    var file = text.render(ah.cfg('taskstate.snapshot_file'), { name: name, hash: ah.sha1(p).slice(0, ah.cfgNum('taskstate.snapshot_hash_len')) });
    return ah.cfg('paths.base_dir') + '/' + ah.cfg('taskstate.snapshot_dir') + '/' + file;
  },
  // The task `t` of the tail laid over the same task `s` of the snapshot: what the tail states wins, what it does not (`unknown`: a task
  // the tail only saw updated) stays as the snapshot has it.
  merge: function (t, s) {
    var m = {}, k;
    for (k in t) if (Object.prototype.hasOwnProperty.call(t, k)) m[k] = t[k];
    var tu = t.unknown, su = s.unknown, keys = ['status', 'owner', 'blockedBy', 'blockedOn'], mu = {}, still = false;
    keys.forEach(function (f) { mu[f] = !!(tu && tu[f]) && !!(su && su[f]); still = still || mu[f]; });
    if (t.content === t.id && s.content !== t.id) m.content = s.content;
    if (!t.description) m.description = s.description;
    if (tu && tu.status) m.status = s.status;
    if (tu && tu.owner) m.owner = s.owner;
    if (tu && tu.blockedBy) m.blockedBy = s.blockedBy;
    if (tu && tu.blockedOn) { if (s.blockedOn === undefined) delete m.blockedOn; else m.blockedOn = s.blockedOn; }
    if (t.priority === null || t.priority === undefined) m.priority = s.priority === undefined ? null : s.priority;
    if (t.sinceMs === null || t.sinceMs === undefined) m.sinceMs = s.sinceMs === undefined ? null : s.sinceMs;
    m.subjectUpdated = !!(t.subjectUpdated || s.subjectUpdated);
    m.unknown = still ? mu : null;
    m.blockUnknown = !tu ? !!t.blockUnknown : ((tu.blockedBy || tu.blockedOn) ? !!(s.blockUnknown || mu.blockedBy || mu.blockedOn) : !!t.blockUnknown);
    return m;
  },
  // The snapshot's tasks, then the tail's tasks the snapshot does not hold, each tail task laid over its snapshot twin.
  overlay: function (snap, tail) {
    var byId = {}, seen = {}, out = [];
    tail.forEach(function (t) { byId[t.id] = t; });
    snap.forEach(function (s) { seen[s.id] = true; out.push(byId[s.id] ? taskSnap.merge(byId[s.id], s) : s); });
    tail.forEach(function (t) { if (!seen[t.id]) out.push(t); });
    return out;
  },
  apply: function (p, variant, r) {
    if (!ah.cfg('taskstate.snapshot_enabled') || r.unsure || r.unreadable || !Array.isArray(r.tasks) || typeof p !== 'string' || p === '') return r;
    var g = ah.homeGuard();
    if (g.status === 'guarded') return r; // a test run against the real home reads and writes no state
    if (g.status !== 'ok') { taskSnap.count('snapshot_error', { kind: 'home' }); return r; }
    var rel = taskSnap.rel(p), size = ah.fs.size(p), doc = null, sec = null, raw = null;
    try { raw = ah.state.readText(rel); } catch (e) { taskSnap.count('snapshot_error', { kind: 'read' }); return r; }
    if (raw !== null) {
      try { doc = JSON.parse(raw); } catch (e) { doc = null; taskSnap.count('snapshot_error', { kind: 'parse' }); }
      if (doc === null || typeof doc !== 'object' || doc.variants === null || typeof doc.variants !== 'object') doc = null;
    }
    var existed = raw !== null, tasks = r.tasks;
    if (doc !== null) {
      var why = doc.format !== ah.cfgNum('taskstate.snapshot_format') ? 'format' : doc.path !== p ? 'session' : r.windowReset ? 'reset' : null;
      sec = doc.variants[variant];
      if (sec === null || typeof sec !== 'object' || !Array.isArray(sec.tasks) || typeof sec.size !== 'number') sec = null;
      if (why === null && sec !== null && (size === null || size < sec.size)) why = 'shrunk';
      if (why !== null) { if (sec !== null || why === 'format' || why === 'session') taskSnap.count('snapshot_discarded', { reason: why }); if (why === 'format' || why === 'session') doc = null; sec = null; }
    }
    if (sec !== null) {
      tasks = taskSnap.overlay(sec.tasks, r.tasks);
      var recovered = tasks.length - r.tasks.length;
      if (recovered > 0) taskSnap.count('snapshot_overlaid', {}, recovered);
      r = Object.assign({}, r, { tasks: tasks });
    }
    try {
      var same = sec !== null && JSON.stringify(sec.tasks) === JSON.stringify(tasks);
      if (same && size !== null && size - sec.size < ah.cfgNum('taskstate.snapshot_refresh_bytes')) return r;
      if (tasks.length === 0 && !existed) return r;
      if (!existed) {
        var dir = g.home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('taskstate.snapshot_dir');
        var names = ah.fs.isDir(dir) ? ah.fs.readdir(dir) : [];
        if (names === null || names.length >= ah.cfgNum('taskstate.snapshot_max_files')) { taskSnap.count('snapshot_error', { kind: 'cap' }); return r; }
      }
      var body = doc === null ? { format: ah.cfgNum('taskstate.snapshot_format'), path: p, variants: {} } : doc;
      body.format = ah.cfgNum('taskstate.snapshot_format'); body.path = p;
      var max = ah.cfgNum('taskstate.snapshot_max_bytes'), done = ah.cfg('taskstate.done_statuses');
      var put = function (list) { body.variants[variant] = { size: size === null ? 0 : size, ms: ah.clock.now(), tasks: list }; return JSON.stringify(body); };
      var text1 = put(tasks);
      if (text1.length > max) text1 = put(tasks.filter(function (t) { return done.indexOf((t.status || '').toLowerCase()) < 0; }));
      if (text1.length > max) { taskSnap.count('snapshot_error', { kind: 'big' }); return r; }
      if (ah.state.writeAtomic(rel, text1)) taskSnap.count('snapshot_written'); else taskSnap.count('snapshot_error', { kind: 'write' });
    } catch (e) { taskSnap.count('snapshot_error', { kind: 'write' }); }
    return r;
  },
};
Object.assign(ah.transcript, {
  // The task list a transcript tail shows, rebuilt as the Node hooks rebuild it. variant: 'guard' (task-guard.js), 'state'
  // (lib/task-state.js) or 'scan' (the task part of tasklist-guard.js). window: bytes of tail (the shipped default when 0); wide: only
  // 'scan' reads it. Returns {unsure: true}, or for guard/state {tasks: [{id, content, description, status (null: unknown), owner,
  // blockedBy, blockedOn (absent: never set), priority, subjectUpdated, unknown, blockUnknown, sinceMs}], windowReset, firstCreated,
  // truncated} in task-list order ({tasks: [], unreadable: true} when the file cannot be read), or for scan {sawTaskActivity,
  // taskStoreReset, inProgressCount, openTaskIds} ({quiet: true}: the Node hook ends silently; {unreadable: true}).
  // For guard and state the tail's list is laid over the session's snapshot of it (taskstate.snapshot_enabled), so a task whose creates lie
  // before the tail is still listed; scan is the tail alone.
  tasks: function (p, variant, window, wide) {
    var r = JSON.parse(ahHost.transcriptTasks(p, variant, window || 0, wide || 0));
    return variant === 'guard' || variant === 'state' ? taskSnap.apply(p, variant, r) : r;
  },
  // Every agent the tail shows launched, in launch order, and the ids with terminal evidence: null (unreadable), {unsure: true}, or
  // {launched: [{id, adopted, outputFile, description, launchedAtMs, toolUseId, resumedAtMs, teammate, lastSeenMs, pendingMessage,
  // spawnInput}], terminal: [id]} (a time that is unknown is null).
  // {launched, terminal, pending} (see ahHost.agentScan); `ignoreStops` skips a TaskStop with no result yet
  agentScan: function (p, tailBytes, ignoreStops) { var r = ahHost.agentScan(p, tailBytes || 0, !!ignoreStops); return r === null || r === undefined ? null : JSON.parse(r); },
});
Object.assign(ah.jev, {
  // Report a later observed result against the decision with that hash (the decision log row `outcome`); projectFrom: a directory.
  recordOutcome: function (id, hash, outcome, source, projectFrom) { ahHost.jevRecordOutcome(id, hash, outcome, source || null, projectFrom || null); },
  // Whether the Jev master switch is on for this request (an integration can still be off: see jev.mode).
  enabled: function () { return ahHost.jevEnabled(); },
  // Whether the shared answer cache holds an answer under `hash`: true, false, or null when the file is one only JavaScript reads.
  cacheHas: function (hash) { return ahNull(ahHost.jevCacheHas(hash)); },
});
ah.plugin = {
  root: function () { return ahHost.pluginRoot() || null; },
  install: function (root) { return JSON.parse(ahHost.pluginInstall(root || '')); },
  // {running, registered, unsure}: the version of the plugin at `root` (null when unreadable) and the one the host registered.
  versions: function (root) { return JSON.parse(ahHost.pluginVersions(root || '')); },
};
// The CPU count as Node's os.availableParallelism() reads it, or null when the engine cannot read it the same way.
ah.sys.cores = function () { return ahNull(ahHost.cores()); };
// The home directory state files may live under: {status: 'ok' | 'guarded' | 'unknown', home} (guarded: a test run against the real
// home, so a hook reads and writes no state; unknown: no usable HOME).
ah.homeGuard = function () { return JSON.parse(ahHost.homeGuard()); };
// The project root of an absolute working directory as the handover finder resolves it, or null when the engine cannot tell.
ah.project = {
  root: function (cwd) { return ahNull(ahHost.projectRoot(cwd)); },
  // The git work tree around an absolute directory, or the directory itself when there is none (or the work tree is the home directory);
  // null for a relative directory or a request with no home. The root the task and history ledgers are kept under.
  repoRoot: function (cwd) { return ahNull(ahHost.repoRoot(cwd)); },
};
// What V8's Date.parse makes of a text under the request's time zone: {ms}, {nan: true} or {unsure: true} (a text whose reading the engine
// does not reproduce: the script defers). Facts only; what a date means is the script's.
ah.date = { parse: function (text) { return JSON.parse(ahHost.dateParse(text)); } };
// The last `bytes` bytes of a file as text (the whole file when smaller), no line handling; null when unreadable.
ah.fs.readEnd = function (p, bytes) { return ahNull(ahHost.readEnd(p, bytes || 0)); };
// A regular file this process may execute.
ah.fs.isExecutable = function (p) { return ahHost.isExecutable(p); };
// The process's user id.
ah.sys.uid = function () { return ahHost.uid(); };

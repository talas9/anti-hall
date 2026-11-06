// Batch-6 additions to the `ah` API (D88): the task list, the agent scan, the Jev outcome and cache probes, the plugin versions
// and the CPU count. Shaped from the raw `ahHost` functions the engine installs; they carry no rule.
'use strict';
// The task snapshot (#390): a transcript tail of taskstate.tail_bytes cannot show a task list whose creates lie further back, so a
// session's last rebuilt list is kept in one file (taskstate.snapshot_*) and the tail's result is laid over it. Every failure leaves the
// rebuild as the tail alone gives it, counted under snapshot_error; the engine never deletes a snapshot file.
// A task's identity is the tool-use id of the TaskCreate that made it (kept per section as `ids`), never its subject: subjects are renamed
// and repeated, a tool-use id is neither.
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
    if (m.src === undefined && s.src !== undefined) m.src = s.src;
    m.subjectUpdated = !!(t.subjectUpdated || s.subjectUpdated);
    m.unknown = still ? mu : null;
    m.blockUnknown = !tu ? !!t.blockUnknown : ((tu.blockedBy || tu.blockedOn) ? !!(s.blockUnknown || mu.blockedBy || mu.blockedOn) : !!t.blockUnknown);
    return m;
  },
  // The snapshot's tasks, then the tail's tasks the snapshot does not hold, each tail task laid over its snapshot twin. A snapshot task the
  // tail found "not found" (`deleted`) is gone: only what the tail itself holds of that id is listed. `proof` (see `proof`) says which
  // snapshot entries are provably ghosts.
  overlay: function (snap, tail, deleted, proof, dropped) {
    var byId = Object.create(null), seen = Object.create(null), gone = Object.create(null), out = [];
    tail.forEach(function (t) { byId[t.id] = t; });
    deleted.forEach(function (id) { gone[id] = true; });
    var drop = 0, kept = 0, repaired = 0;
    snap.forEach(function (s) {
      if (gone[s.id]) return;
      if (taskSnap.ghost(s, proof)) { drop++; if (proof.proven[s.id] === true) repaired++; if (dropped) dropped.push(s); return; } // a ghost an older rebuild saved: never listed again, and the rewrite below drops it from the file
      if (taskSnap.shaped(s.id) && s.src !== 'todo') kept++; // looks like a harness id but no provenance: kept (a task is never dropped without proof)
      seen[s.id] = true;
      out.push(byId[s.id] ? taskSnap.merge(byId[s.id], s) : s);
    });
    tail.forEach(function (t) { if (!seen[t.id]) out.push(t); });
    if (drop > 0) taskSnap.count('snapshot_ghost_dropped', {}, drop);
    if (repaired > 0) taskSnap.count('snapshot_ghost_repaired', {}, repaired);
    if (kept > 0) taskSnap.count('snapshot_ghost_kept', {}, kept);
    return out;
  },
  // What the tail's rebuild proves about ids: `prov` (ids keyed by a TaskCreate tool-use id whose result it does not show), `todo` (ids a
  // TodoWrite set: real, whatever their shape) and `uses` (every TaskCreate tool-use id it shows, resolved or not).
  proof: function (r) {
    var out = { prov: Object.create(null), todo: Object.create(null), uses: Object.create(null), proven: Object.create(null) };
    if (Array.isArray(r.provisional)) r.provisional.forEach(function (id) { out.prov[id] = true; out.uses[id] = true; });
    if (Array.isArray(r.todoIds)) r.todoIds.forEach(function (id) { out.todo[id] = true; });
    if (r.createdBy !== null && typeof r.createdBy === 'object') Object.keys(r.createdBy).forEach(function (k) { if (typeof r.createdBy[k] === 'string') out.uses[r.createdBy[k]] = true; });
    return out;
  },
  // Whether `id` has the exact shape of a harness tool-use id (taskstate.provisional_id_re): the shape alone proves nothing, a TodoWrite
  // item may carry any id.
  shaped: function (id) { return ah.cfg('taskstate.snapshot_drop_provisional') === true && typeof id === 'string' && jx.re('taskstate.provisional_id_re').test(id); },
  // Whether `t` is a provisional ghost, by provenance only (taskstate.snapshot_drop_provisional is the kill switch): never a task a TodoWrite
  // set (marked `src: 'todo'`); a task flagged `prov` (the tail's own provisional create, flagged when it is read; an older file may carry
  // the flag too); or an unflagged older entry of the exact harness shape whose id the tail shows as a TaskCreate tool-use id.
  ghost: function (t, proof) {
    if (ah.cfg('taskstate.snapshot_drop_provisional') !== true || t.src === 'todo' || proof.todo[t.id] === true) return false;
    if (t.prov === true || proof.prov[t.id] === true || proof.proven[t.id] === true) return true;
    return taskSnap.shaped(t.id) && proof.uses[t.id] === true;
  },
  // The repair of ghosts an older rebuild saved from replayed request rows (GH #438): a snapshot entry of the exact harness shape that no
  // tail proof or flag condemns is looked up in the WHOLE transcript once (ahHost.transcriptIdProof). It is a ghost only when the id occurs in
  // replayed rows and in no conversation row, never as a TodoWrite item (`src: todo`). A verdict that is not a ghost is remembered in the
  // section's `checked`, so the scan is not repeated. Fills `proof.proven`; returns the `checked` map to write. Any failure proves nothing.
  repair: function (p, sec, r, proof, gone) {
    var checked = {}, own = Object.prototype.hasOwnProperty;
    if (sec.checked !== null && typeof sec.checked === 'object' && !Array.isArray(sec.checked)) Object.keys(sec.checked).forEach(function (k) { if (sec.checked[k] === true) checked[k] = true; });
    if (ah.cfg('taskstate.ghost_proof_enabled') !== true || ah.cfg('taskstate.snapshot_drop_provisional') !== true) return checked;
    var cand = [], max = ah.cfgNum('taskstate.ghost_candidates_max');
    sec.tasks.forEach(function (t) {
      if (gone[t.id] || t.src === 'todo' || t.prov === true || proof.todo[t.id] === true || proof.prov[t.id] === true || proof.uses[t.id] === true) return;
      if (own.call(checked, t.id) || !taskSnap.shaped(t.id) || cand.length >= max) return;
      cand.push(t.id);
    });
    if (cand.length === 0) return checked;
    var res = null;
    try { res = JSON.parse(ahHost.transcriptIdProof(p, JSON.stringify(cand))); } catch (e) { res = null; }
    if (res === null || typeof res !== 'object' || res.unsure === true || res.ids === null || typeof res.ids !== 'object') { taskSnap.count('snapshot_ghost_scan', { result: 'unread' }); return checked; }
    taskSnap.count('snapshot_ghost_scan', { result: 'read' });
    cand.forEach(function (id) {
      var v = res.ids[id];
      if (v === null || typeof v !== 'object' || typeof v.skipped !== 'number' || typeof v.conversation !== 'number') return; // no answer: nothing proven, asked again
      if (v.skipped > 0 && v.conversation === 0) proof.proven[id] = true;
      else checked[id] = true;
    });
    return checked;
  },
  // The quarantine a section keeps: its earlier entries and the snapshot entries dropped as ghosts now, each once by id, at most
  // taskstate.ghost_quarantine_max. A dropped record is never lost with the task list: it stays here, flagged `prov`, for the owner.
  quarantine: function (old, dropped) {
    var out = [], seen = Object.create(null), max = ah.cfgNum('taskstate.ghost_quarantine_max'), full = 0;
    (Array.isArray(old) ? old : []).concat(dropped).forEach(function (t) {
      if (!taskSnap.sound(t) || seen[t.id] === true) return;
      if (out.length >= max) { full++; return; }
      seen[t.id] = true;
      out.push(t.prov === true ? t : Object.assign({}, t, { prov: true }));
    });
    if (full > 0) taskSnap.count('snapshot_error', { kind: 'quarantine_full' }, full);
    return out;
  },
  // The tail's tasks marked with what the rebuild proves: `prov: true` on a provisional create, `src: 'todo'` on a TodoWrite item (additive
  // fields; an older reader ignores them, and a snapshot without them is read by the shape rule above).
  mark: function (r, proof) {
    r.tasks.forEach(function (t) {
      if (proof.todo[t.id] === true) t.src = 'todo';
      else if (proof.prov[t.id] === true) t.prov = true;
    });
  },
  // The tasks a snapshot may hold: `tasks` without the ghosts. An in-flight create stays in the answer but is not written.
  persisted: function (tasks, proof) { return tasks.filter(function (t) { return !taskSnap.ghost(t, proof); }); },
  // A task as a snapshot may hold it: an id and a status that is text or absent. Anything else is a damaged file.
  sound: function (t) {
    return t !== null && typeof t === 'object' && typeof t.id === 'string' && t.id !== '' && (t.status === null || t.status === undefined || typeof t.status === 'string');
  },
  soundSection: function (sec) {
    return sec !== null && typeof sec === 'object' && Array.isArray(sec.tasks) && typeof sec.size === 'number' && sec.tasks.every(taskSnap.sound) &&
      (sec.ids === undefined || (sec.ids !== null && typeof sec.ids === 'object' && !Array.isArray(sec.ids) && Object.keys(sec.ids).every(function (k) { return typeof sec.ids[k] === 'string' && sec.ids[k] !== ''; })));
  },
  // The create identities a section keeps: for each task of `tasks`, the tool-use id of the TaskCreate that made it. The tail's own
  // creates win over what the section had (a create the tail shows is the latest word on its number); a task no create was ever seen for
  // has none, which `renumbered` reads as "cannot tell".
  idsOf: function (tasks, old, by) {
    var out = {};
    tasks.forEach(function (t) {
      if (old && Object.prototype.hasOwnProperty.call(old, t.id)) out[t.id] = old[t.id];
      if (by && Object.prototype.hasOwnProperty.call(by, t.id) && typeof by[t.id] === 'string' && by[t.id] !== '') out[t.id] = by[t.id];
    });
    return out;
  },
  // The fingerprint of the transcript's generation: a hash of its first bytes and of the same number of bytes just before the tail
  // window as it stands now, read back later at that fixed offset (a transcript only grows at its end). null when it cannot be read.
  fingerprint: function (p, size, win) {
    var n = ah.cfgNum('taskstate.snapshot_fingerprint_bytes'), hl = Math.min(n, size), at = Math.max(0, size - win - n), ml = Math.min(n, size - at);
    var h = ah.fs.rangeSha1Hex(p, 0, hl), m = ah.fs.rangeSha1Hex(p, at, ml);
    if (h === null || m === null) return null;
    return { head: h, headLen: hl, at: at, mid: m, midLen: ml };
  },
  // Whether the transcript at `p` still has the bytes a fingerprint recorded.
  sameFile: function (p, g) {
    if (g === null || typeof g !== 'object' || typeof g.headLen !== 'number' || typeof g.midLen !== 'number' || typeof g.at !== 'number' || typeof g.head !== 'string' || typeof g.mid !== 'string') return false;
    return ah.fs.rangeSha1Hex(p, 0, g.headLen) === g.head && ah.fs.rangeSha1Hex(p, g.at, g.midLen) === g.mid;
  },
  // Whether the tail began a new list under numbers the snapshot already holds. A TaskCreate the tail shows for a number the snapshot
  // holds is either the create the snapshot already saw (the tail reaches back over the bytes the snapshot was written from) or a new
  // list numbered from one again. When the tail starts at or after the snapshot's size every create in it is new. When they overlap, the
  // create is new iff its tool-use id differs from the one the snapshot recorded for that number (the same bytes name the same id).
  // When either id is unknown (a snapshot task no create was recorded for) it cannot be told: the snapshot is kept, and that is counted.
  renumbered: function (sec, r, tailStart) {
    if (!Array.isArray(r.created) || r.created.length === 0) return false;
    var own = Object.prototype.hasOwnProperty, held = Object.create(null), clean = tailStart >= sec.size, unknown = false, fresh = false;
    sec.tasks.forEach(function (t) { held[t.id] = true; });
    r.created.forEach(function (id) {
      if (!held[id]) return;
      if (clean) { fresh = true; return; }
      var rec = sec.ids && own.call(sec.ids, id) ? sec.ids[id] : undefined, use = r.createdBy && own.call(r.createdBy, id) ? r.createdBy[id] : undefined;
      if (typeof rec !== 'string' || rec === '' || typeof use !== 'string' || use === '') unknown = true;
      else if (rec !== use) fresh = true;
    });
    if (unknown && !fresh) taskSnap.count('snapshot_identity_unknown');
    return fresh;
  },
  // The rebuild over the last `need` bytes (the gap between a snapshot's size and the tail's start, plus the tail), or null when that is
  // over taskstate.snapshot_gap_max_bytes or cannot be read exactly. Counted under snapshot_gap by result.
  catchUp: function (p, variant, need) {
    if (need > ah.cfgNum('taskstate.snapshot_gap_max_bytes')) { taskSnap.count('snapshot_gap', { result: 'too_big' }); return null; }
    var w = JSON.parse(ahHost.transcriptTasks(p, variant, need + 1, 0)); // one byte more than the gap: the tail drops its first (cut) line, which must be the line break before the gap
    if (w.unsure || w.unreadable || !Array.isArray(w.tasks)) { taskSnap.count('snapshot_gap', { result: 'unread' }); return null; }
    taskSnap.count('snapshot_gap', { result: 'caught_up' });
    return w;
  },
  // The kill switch, read through the owner's layers (settings.json, config.toml) with `ah.cfgLive`: it is a documented setting, and `ah.cfg`
  // answers the shipped value only (every other logic read relies on that). Falls back to the shipped value when the layers cannot be read.
  enabled: function () {
    try { return ah.cfgLive('taskstate.snapshot_enabled') === true; } catch (e) { return ah.cfg('taskstate.snapshot_enabled') === true; }
  },
  // `r` (the tail's rebuild) over the session's snapshot; `sid` the hook payload's session id (or none), `win` the tail window in bytes.
  // Any failure, and a snapshot that cannot be written, leave `r` as it is.
  apply: function (p, variant, r, sid, win) {
    if (!taskSnap.enabled() || r.unsure || r.unreadable || !Array.isArray(r.tasks) || typeof p !== 'string' || p === '') return r;
    var g = ah.homeGuard();
    if (g.status === 'guarded') return r; // a test run against the real home reads and writes no state
    if (g.status !== 'ok') { taskSnap.count('snapshot_error', { kind: 'home' }); return r; }
    try { return taskSnap.run(p, variant, r, typeof sid === 'string' && sid !== '' ? sid : null, win, g); } catch (e) { taskSnap.count('snapshot_error', { kind: 'read' }); return r; }
  },
  run: function (p, variant, r, sid, win, g) {
    var rel = taskSnap.rel(p), size = ah.fs.size(p), doc = null, sec = null, raw = null, fmt = ah.cfgNum('taskstate.snapshot_format');
    if (size === null) { taskSnap.count('snapshot_error', { kind: 'read' }); return r; }
    try { raw = ah.state.readText(rel); } catch (e) { taskSnap.count('snapshot_error', { kind: 'read' }); return r; }
    var max = ah.cfgNum('taskstate.snapshot_max_bytes');
    if (raw !== null && raw.length > max) { taskSnap.count('snapshot_error', { kind: 'big' }); raw = ''; } // a file over the cap is damaged: it is replaced, never trusted
    if (raw !== null && raw !== '') {
      try { doc = JSON.parse(raw); } catch (e) { doc = null; taskSnap.count('snapshot_error', { kind: 'parse' }); }
      if (doc === null || typeof doc !== 'object' || doc.variants === null || typeof doc.variants !== 'object') doc = null;
    }
    var existed = raw !== null, tasks = r.tasks, recovered = 0, discarded = false, tailStart = r.truncated ? Math.max(0, size - win) : 0;
    if (doc !== null) {
      var why = null;
      sec = doc.variants[variant];
      if (sec !== undefined && sec !== null && !taskSnap.soundSection(sec)) { taskSnap.count('snapshot_error', { kind: 'shape' }); sec = null; }
      else if (sec === undefined || sec === null || typeof sec !== 'object') sec = null;
      if (doc.format !== fmt) why = 'format';
      else if (doc.path !== p || (sid !== null && typeof doc.session === 'string' && doc.session !== sid)) why = 'session';
      else if (sec !== null && size < sec.size) why = 'shrunk';
      else if (!taskSnap.sameFile(p, doc.gen)) why = 'replaced';
      // Bytes between the snapshot's size and the tail's start were read by nobody: a TaskUpdate in them is unseen, so the snapshot's
      // list may name as open a task that was finished there. Read them (the tail widened back to the snapshot's size); when that
      // cannot be done the snapshot is not trusted (fail-open: the tail alone, never a block on a list that may be stale).
      if (why === null && sec !== null && r.truncated && tailStart > sec.size) {
        var wide = taskSnap.catchUp(p, variant, size - sec.size);
        if (wide === null) why = 'gap';
        else { r = wide; win = size - sec.size + 1; tasks = r.tasks; tailStart = sec.size; } // the one byte before it is a line break the tail drops as its cut first line
      }
      if (why === null && r.windowReset) why = 'reset';
      if (why === null && sec !== null && taskSnap.renumbered(sec, r, tailStart)) why = 'renumbered';
      if (why !== null) {
        // any reason retires the whole file's sections: another transcript, or a list that ended, leaves none of them true
        if (sec !== null || why === 'format' || why === 'session' || why === 'replaced') taskSnap.count('snapshot_discarded', { reason: why });
        doc = null; sec = null; discarded = true;
      }
    }
    var proof = taskSnap.proof(r);
    taskSnap.mark(r, proof);
    var checked = {}, quarantine = [];
    if (sec !== null) {
      var deletedIds = Array.isArray(r.deleted) ? r.deleted : [], goneIds = Object.create(null), dropped = [];
      deletedIds.forEach(function (id) { goneIds[id] = true; });
      checked = taskSnap.repair(p, sec, r, proof, goneIds);
      tasks = taskSnap.overlay(sec.tasks, r.tasks, deletedIds, proof, dropped);
      quarantine = taskSnap.quarantine(sec.quarantine, dropped);
      var tailIds = Object.create(null);
      r.tasks.forEach(function (t) { tailIds[t.id] = true; });
      recovered = tasks.filter(function (t) { return !tailIds[t.id]; }).length;
    }
    var out = sec !== null ? Object.assign({}, r, { tasks: tasks }) : r;
    var keep = taskSnap.persisted(tasks, proof); // what the file holds: an in-flight create stays in the answer but is not written
    var ids = taskSnap.idsOf(keep, sec !== null ? sec.ids : null, r.createdBy);
    try {
      var same = sec !== null && JSON.stringify(sec.tasks) === JSON.stringify(keep) && JSON.stringify(sec.ids || {}) === JSON.stringify(ids) &&
        JSON.stringify(sec.quarantine || []) === JSON.stringify(quarantine) && JSON.stringify(sec.checked || {}) === JSON.stringify(checked);
      if (same && size - sec.size < ah.cfgNum('taskstate.snapshot_refresh_bytes')) return taskSnap.counted(out, recovered);
      if (keep.length === 0 && !existed) return r;
      if (!existed) {
        var dir = g.home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('taskstate.snapshot_dir');
        var names = ah.fs.isDir(dir) ? ah.fs.readdir(dir) : [];
        if (names !== null && names.length > 0) { // an absent or empty directory (the first snapshot) has nothing to filter: the suffixes are not read
          var lockEnd = ah.cfg('taskstate.snapshot_lock_suffix'), flockEnd = ah.cfg('taskstate.snapshot_flock_suffix');
          names = names.filter(function (n) { return n.slice(-lockEnd.length) !== lockEnd && n.slice(-flockEnd.length) !== flockEnd; }); // a lock file is no snapshot
        }
        if (names === null || names.length >= ah.cfgNum('taskstate.snapshot_max_files')) { taskSnap.count('snapshot_error', { kind: 'cap' }); return r; }
      }
      var fp = taskSnap.fingerprint(p, size, win);
      if (fp === null) { taskSnap.count('snapshot_error', { kind: 'read' }); return r; }
      // The file is read, merged and rewritten whole by every hook that rebuilds a list, so the last step runs under one lock per file:
      // a hook that cannot take it in taskstate.snapshot_lock_wait_ms writes nothing (its answer is the same; the next rebuild writes)
      // and is counted under snapshot_error kind `lock`. Without the lock two hooks in the same instant could still lose one section.
      var lk = null, lockKind = 'file';
      var kind;
      try { kind = ah.cfgLive('taskstate.snapshot_lock_kind'); } catch (e) { kind = ah.cfg('taskstate.snapshot_lock_kind'); } // the kill switch is the owner's: settings.json or config.toml; the shipped value stands when they cannot be read
      if (kind === 'flock') {
        // Only a flock this platform or filesystem does not have at all (null) may fall back to the lock file, whose protocol does not exclude
        // a holder of the flock. Every other outcome that is not a held lock ('busy', 'failed': an unopenable or linked file, an errno, a refused path) writes nothing.
        try { lk = ah.state.flock(rel + ah.cfg('taskstate.snapshot_flock_suffix'), ah.cfg('taskstate.snapshot_lock_group'), ah.cfgNum('taskstate.snapshot_lock_wait_ms')); } catch (e) { lk = 'failed'; }
        lockKind = 'flock';
        if (lk === 'busy' || lk === 'failed') { taskSnap.count('snapshot_lock', { kind: 'flock', result: lk }); taskSnap.count('snapshot_error', { kind: 'lock' }); return taskSnap.counted(out, recovered); }
        if (lk === null) lockKind = 'fallback'; // no flock here at all: the lock file below
      }
      if (lk === null) {
        // The lock file protocol (kind `file`, or the flock fallback). A write needs a lock POSITIVELY held: only a handle counts. A null
        // (held by another past the wait, or no lock file can be made: a directory or a link in its place, an unwritable directory, a
        // refused path) and an exception both write nothing, counted like a busy flock.
        var res = 'busy';
        try { lk = ah.state.lock(rel + ah.cfg('taskstate.snapshot_lock_suffix'), ah.cfg('taskstate.snapshot_lock_group'), ah.cfgNum('taskstate.snapshot_lock_wait_ms')); } catch (e) { lk = null; res = 'failed'; }
        if (lk === null) { taskSnap.count('snapshot_lock', { kind: lockKind, result: res }); taskSnap.count('snapshot_error', { kind: 'lock' }); return taskSnap.counted(out, recovered); }
      }
      taskSnap.count('snapshot_lock', { kind: lockKind, result: 'taken' });
      try {
        var body = doc === null ? { format: fmt, path: p, variants: {} } : doc;
        body.format = fmt; body.path = p; body.gen = fp;
        body.session = sid !== null ? sid : (typeof body.session === 'string' ? body.session : null);
        if (!discarded) taskSnap.mergeOthers(rel, body, variant, p, fmt, max);
        var done = ah.cfg('taskstate.done_statuses');
        var put = function (list) {
          var section = { size: size, ms: ah.clock.now(), tasks: list, ids: taskSnap.idsOf(list, ids) };
          if (quarantine.length > 0) section.quarantine = quarantine; // additive: an older reader ignores it
          if (Object.keys(checked).length > 0) section.checked = checked;
          body.variants[variant] = section;
          return JSON.stringify(body);
        };
        var text1 = put(keep);
        if (text1.length > max) text1 = put(keep.filter(function (t) { return done.indexOf((t.status || '').toLowerCase()) < 0; }));
        if (text1.length > max) { taskSnap.count('snapshot_error', { kind: 'big' }); return r; }
        if (!ah.state.writeAtomic(rel, text1)) { taskSnap.count('snapshot_error', { kind: 'write' }); return r; }
        taskSnap.count('snapshot_written');
      } finally { ah.state.unlock(lk); } // lk is a held handle here: no path reaches the write without one
    } catch (e) { taskSnap.count('snapshot_error', { kind: 'write' }); return r; }
    return taskSnap.counted(out, recovered);
  },
  counted: function (out, recovered) { if (recovered > 0) taskSnap.count('snapshot_overlaid', {}, recovered); return out; },
  // The guard and the state variants share one file and each rewrites it whole: read it again just before the write and take the other
  // variants' sections from what is there now, so a section filed since this call's first read is not lost. A file that is not this
  // session's, or no longer this transcript's, adds nothing.
  mergeOthers: function (rel, body, variant, p, fmt, max) {
    var fresh = null, raw = null;
    try { raw = ah.state.readText(rel); } catch (e) { return; }
    if (typeof raw !== 'string' || raw.length > max) return; // a file over the cap is replaced, not merged
    try { fresh = JSON.parse(raw); } catch (e) { return; }
    if (fresh === null || typeof fresh !== 'object' || fresh.format !== fmt || fresh.path !== p || fresh.variants === null || typeof fresh.variants !== 'object') return;
    if (typeof body.session === 'string' && typeof fresh.session === 'string' && body.session !== fresh.session) return;
    if (!taskSnap.sameFile(p, fresh.gen)) return;
    Object.keys(body.variants).forEach(function (k) { if (k !== variant) delete body.variants[k]; });
    Object.keys(fresh.variants).forEach(function (k) { if (k !== variant && taskSnap.soundSection(fresh.variants[k])) body.variants[k] = fresh.variants[k]; });
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
  // `sid`, the hook payload's session id, ties a snapshot to the session that wrote it.
  tasks: function (p, variant, window, wide, sid) {
    var r = JSON.parse(ahHost.transcriptTasks(p, variant, window || 0, wide || 0));
    return variant === 'guard' || variant === 'state' ? taskSnap.apply(p, variant, r, sid, window || ah.cfgNum('taskstate.tail_bytes')) : r;
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
// `n` bytes of a regular file from byte `from` as lowercase hex (fewer at the end of the file); null when unreadable.
ah.fs.readRangeHex = function (p, from, n) { return ahNull(ahHost.readRangeHex(p, from || 0, n || 0)); };
// The lowercase hex SHA-1 of the lowercase hex text of exactly `n` bytes from byte `from` (= ah.sha1 of ah.fs.readRangeHex, computed in
// the engine without moving the bytes into the script); null when unreadable or fewer than `n` bytes exist.
ah.fs.rangeSha1Hex = function (p, from, n) { return ahNull(ahHost.rangeSha1Hex(p, from || 0, n || 0)); };
// A regular file this process may execute.
ah.fs.isExecutable = function (p) { return ahHost.isExecutable(p); };
// The process's user id.
ah.sys.uid = function () { return ahHost.uid(); };

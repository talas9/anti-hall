// check = "tasklist-hygiene" (engine-only; PostToolUse and PreToolUse on TaskCreate and TaskUpdate, Claude only: Codex has no task tools
// and no task hook events). Keeps the session task list small, because the harness re-sends the whole list on every turn:
// (1) PostToolUse: a task just marked completed gets an ORDER (done_order.msg_fresh, lib/86-done-order.js) to record the outcome in the history
// ledger and delete it; a completed task that stays in the list is ordered again at UserPromptSubmit (task-tracker) and, with taskListEnforce = block, at Stop (task-guard);
// (2) PostToolUse: a created or renamed task whose subject is over handover.taskSubjectMax, or a list with more open tasks than
// handover.taskListBudget, gets one advisory line with the numbers (a state table of the advisory layer, so an unchanged state is not repeated);
// (3) PreToolUse: only with handover.taskListEnforce = block, the same two breaches refuse the call instead.
// The open count comes from the transcript (ah.transcript.tasks, variant state); a call not yet in it is added. An unreadable transcript
// leaves the count out (subject length is still judged). Never blocks unless the owner turned that on. Keys and texts: task_guards.toml
// (tasklist_hygiene.*), ctxbudget.toml (ctxbudget.set_h_task_*), advisory.toml.
// (4) The task window (GH #982, guards.taskWindow, on by default): at PreToolUse the list rules are enforced when a task is created or
// changed (subject format `T-<n> [P<0-3>] title`, a free number, the window size, the top priorities in the window, an owner on an
// in-progress task, a blocked task moved to the backlog, the resume check), each refusal naming the exact form to use; at PostToolUse the
// per-session task store (the full list, task_window.store_dir) mirrors the call and a freed slot orders tasks-reconcile. A call that
// finishes or deletes a task is never refused, and the format is judged only when the call sets a subject, so no existing list can lock.
// The store is read and written under a per-session lock; a create that passes holds its slot (a reservation) until it shows in the live
// list, so parallel creates cannot overfill the window. A store that cannot be read, locked or written runs no store rule (fail-open);
// a task is never ordered deleted unless it was saved first. Keys and texts: task_guards.toml (task_window.*).
'use strict';

// ---- task window (GH #982) ----

function twC(k) { return ah.cfg('task_window.' + k); }
function twR(k, a) { return text.render(twC(k), a || {}); }
function twOn() { return ah.settings.bool('task_window.setting'); }
function twMetric(action) { ah.metric('task_window', ['action', action]); }
function twStates() { return twC('states'); }

// {n, p, title} of a subject in the window form, else null.
function twParse(subject) {
  if (typeof subject !== 'string') return null;
  var m = jx.re('task_window.subject_re').exec(subject);
  return m ? { n: parseInt(m[1], 10), p: parseInt(m[2], 10), title: m[3] } : null;
}

function twIsBacklog(subject) { return typeof subject === 'string' && jx.re('task_window.backlog_re').test(subject); }
function twNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function twSubject(n, p, title) { return twR('subject_form', { n: String(n), p: p === null ? twC('p_unknown') : String(p), title: title }); }

// The title of a malformed subject (its id and tags removed) and the priority its tag names, if a valid one.
function twTitleOf(subject) {
  var s = String(subject || ''), m = jx.re('task_guard.priority_slot_re').exec(s), p = null;
  if (m && jx.re('task_guard.priority_ok_re', 'i').test(m[1].trim())) p = parseInt(m[1].trim().slice(1), 10);
  var title = tk.oneLine(s.replace(jx.re('task_window.title_strip_re', 'i'), ''), ah.cfgNum('task_window.title_max'));
  return { title: title, p: p };
}

function twSid(p) {
  var s = typeof p.session_id === 'string' ? p.session_id : '';
  return s !== '' && s.replace(new RegExp(ah.cfg('taskkit.session_id_unsafe'), 'g'), '') === s ? s : '';
}

// The session's live task list (finished ones included), or null when it cannot be read exactly.
function twLive(p) {
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return null;
  var r = tk.tasksOf(ah.home(), p.session_id, tp, 'state');
  if (!r || r.unsure || r.unreadable || !Array.isArray(r.tasks)) return null;
  return r.tasks;
}

// {root, rel} of the session's store, or null (no absolute working directory, no project root, no usable session id).
function twStorePath(p, sid) {
  if (sid === '' || typeof p.cwd !== 'string' || p.cwd.charAt(0) !== '/') return null;
  var root = ah.project.repoRoot(p.cwd);
  return root === null ? null : { root: root, rel: twC('store_dir').join('/') + '/' + sid + '.json' };
}

function twNew(sid) { return { format: ah.cfgNum('task_window.store_format'), session: sid, from: '', resumed: false, tasks: [] }; }

// {absent, v} of a store file, or null when it exists but cannot be read exactly (it is then left alone).
function twReadAbs(abs, sid) {
  if (ah.fs.kind(abs) === null) return { absent: true, v: twNew(sid) };
  var size = ah.fs.size(abs), max = ah.cfgNum('task_window.store_max_bytes');
  if (size === null || size > max) { twMetric('store_unreadable'); return null; }
  var raw = ah.fs.readText(abs, max);
  if (raw === null) { twMetric('store_unreadable'); return null; }
  var r = jx.parse(raw);
  if (r.unsure || r.invalid || !jx.isObj(r.v) || r.v.format !== ah.cfgNum('task_window.store_format') || !Array.isArray(r.v.tasks)) { twMetric('store_unreadable'); return null; }
  return { absent: false, v: r.v };
}

function twWrite(sp, st) {
  var s = JSON.stringify(st, null, 1) + '\n', ok = false;
  if (s.length > ah.cfgNum('task_window.store_max_bytes')) { twMetric('store_write_failed'); return false; }
  try { ok = ah.state.op(sp.root, 'write', sp.rel, s); } catch (e) { ok = false; }
  if (!ok) twMetric('store_write_failed');
  return ok;
}

// The per-session store lock: a handle, or null when it cannot be taken (no store rule runs then).
function twLock(sid) {
  var rel = twR('lock_rel', { sid: sid }), wait = ah.cfgNum('task_window.lock_wait_ms');
  var h = ah.state.flock(rel, twC('lock_group'), wait);
  if (h === null) h = ah.state.lock(rel, twC('lock_group'), wait); // this platform has no flock at all
  if (h === null || h === 'busy' || h === 'failed') { twMetric('lock_busy'); return null; }
  return h;
}

function twFind(st, n) {
  for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].n === n) return st.tasks[i];
  return null;
}

function twWaiting(it) { var S = twStates(); return it.state === S.backlog || it.state === S.blocked; }

// The top task of the backlog that can be worked (not blocked), by priority then number; null when none.
function twTop(st, exceptN) {
  var S = twStates(), best = null;
  st.tasks.forEach(function (it) {
    if (it.state !== S.backlog || it.n === exceptN) return;
    if (best === null || it.p < best.p || (it.p === best.p && it.n < best.n)) best = it;
  });
  return best;
}

function twBacklogLine(st) {
  var waiting = st.tasks.filter(twWaiting), byP = {}, counts = [];
  waiting.forEach(function (it) { byP[it.p] = (byP[it.p] || 0) + 1; });
  Object.keys(byP).sort().forEach(function (k) { counts.push(twR('backlog_count', { n: String(byP[k]), p: k })); });
  var top = twTop(st, null);
  var nBlocked = st.tasks.filter(function (it) { return it.state === twStates().blocked; }).length;
  return twR('backlog_line', { n: String(waiting.length), counts: counts.join(twC('backlog_count_sep')), blocked: nBlocked > 0 ? twR('backlog_blocked', { b: String(nBlocked) }) : '', next: top ? twSubject(top.n, top.p, top.title) : twC('backlog_none'), skill: twC('reconcile_skill') });
}

function twNextN(st, live) {
  var max = 0;
  st.tasks.forEach(function (it) { if (it.n > max) max = it.n; });
  (live || []).forEach(function (t) { var pr = twParse(t.content); if (pr && pr.n > max) max = pr.n; });
  return max + 1;
}

// Mirror the live list into the store: every live task in the window form is in the store with its id; a finished one is done. A
// waiting (backlog or blocked) task keeps its state while it is still live (it is on its way out). True when something changed.
function twSync(st, live, now) {
  var S = twStates(), changed = false;
  (live || []).forEach(function (t) {
    var pr = twParse(t.content);
    if (pr === null) return;
    var it = twFind(st, pr.n), done = tk.isDone(t), id = String(t.id);
    if (it === null) {
      st.tasks.push({ n: pr.n, p: pr.p, title: pr.title, state: done ? S.done : S.window, id: id, owner: t.owner || '', blockedOn: '', at: now });
      return (changed = true);
    }
    if (it.id !== id) { it.id = id; changed = true; }
    if (it.title !== pr.title || it.p !== pr.p) { it.title = pr.title; it.p = pr.p; changed = true; }
    if (done && it.state !== S.done) { it.state = S.done; changed = true; }
    else if (!done && (it.state === S.done || it.state === S.dropped)) { it.state = S.window; changed = true; } // reopened
    if (typeof it.reservedAt === 'number') { delete it.reservedAt; changed = true; }
  });
  return changed;
}

// The numbers of the live open tasks in the window form.
function twLiveNs(open) {
  var out = {};
  open.forEach(function (t) { var pr = twParse(t.content); if (pr) out[pr.n] = true; });
  return out;
}

// The live open tasks (the backlog line is not one) plus the creates still holding a reserved slot.
function twWindowCount(st, open, now) {
  var S = twStates(), ttl = ah.cfgNum('task_window.reserve_ttl_ms'), liveN = twLiveNs(open);
  var blockedLive = open.filter(function (t) { var pr = twParse(t.content), it = pr === null ? null : twFind(st, pr.n); return it !== null && it.state === S.blocked; }).length;
  return open.length - blockedLive + st.tasks.filter(function (it) {
    return it.state === S.window && !it.id && typeof it.reservedAt === 'number' && now - it.reservedAt < ttl && liveN[it.n] !== true;
  }).length;
}

// Save task `pr` in the store as `state` (idempotent: an item of that number keeps its place and only changes state). True when changed.
function twSave(st, pr, state, extra, now) {
  var it = twFind(st, pr.n);
  if (it === null) {
    it = { n: pr.n, p: pr.p, title: pr.title, state: state, id: '', owner: '', blockedOn: '', at: now };
    Object.keys(extra || {}).forEach(function (k) { it[k] = extra[k]; });
    st.tasks.push(it);
    twMetric('saved_backlog');
    return true;
  }
  var changed = it.state !== state;
  it.state = state;
  Object.keys(extra || {}).forEach(function (k) { if (it[k] !== extra[k]) { it[k] = extra[k]; changed = true; } });
  if (changed) twMetric('saved_backlog');
  return changed;
}

// The resume check of a session with no store yet: the predecessor's store (adopted), or the predecessor's markdown snapshot (to be
// imported by tasks-reconcile). {adopt: store} | {importPath} | null.
function twResume(sp, sid, now) {
  if (!ah.settings.bool('task_window.resume_setting')) return null;
  var raw = ah.state.readText(ah.cfg('codex_handover.state_dir') + '/' + ah.cfg('codex_handover.resume_state_prefix') + ho.sanitize(sid) + '.json');
  if (raw === null) return null;
  var r = jx.parse(raw);
  if (r.unsure || r.invalid || !jx.isObj(r.v) || typeof r.v.handoverFile !== 'string' || r.v.handoverFile.indexOf('/') < 0) return null;
  var dir = r.v.handoverFile.slice(0, r.v.handoverFile.lastIndexOf('/')), old = dir.slice(dir.lastIndexOf('/') + 1);
  if (old === '' || old === sid || old.replace(new RegExp(ah.cfg('taskkit.session_id_unsafe'), 'g'), '') !== old) return null;
  var prev = twReadAbs(sp.root + '/' + twC('store_dir').join('/') + '/' + old + '.json', old);
  if (prev !== null && !prev.absent) {
    var S = twStates(), st = twNew(sid);
    st.from = old; st.resumed = true;
    prev.v.tasks.forEach(function (it) {
      if (!jx.isObj(it) || typeof it.n !== 'number' || [S.window, S.backlog, S.blocked].indexOf(it.state) < 0) return;
      st.tasks.push({ n: it.n, p: it.p, title: it.title, state: it.state, id: '', owner: it.owner || '', blockedOn: it.blockedOn || '', at: typeof it.at === 'number' ? it.at : now });
    });
    return { adopt: st };
  }
  var spath = dir + '/' + twC('snapshot_file'), text0 = ah.fs.readText(spath, ah.cfgNum('task_window.snapshot_read_max'));
  if (text0 === null) return null;
  var lines = text0.split('\n'), head = jx.re('task_window.snapshot_heading_re', 'i'), rowRe = jx.re('task_window.snapshot_row_re'), endRe = jx.re('task_window.snapshot_end_re'), inside = false;
  for (var i = 0; i < lines.length; i++) {
    if (!inside) { inside = head.test(lines[i]); continue; }
    if (endRe.test(lines[i])) break;
    if (rowRe.test(lines[i])) return { importPath: spath };
  }
  return null;
}

function twBlock(action, what, instead, extra) { twMetric(action); return { what: what, instead: instead, extra: extra || [] }; }

// The PreToolUse rules: a refusal {what, instead, extra} or null (allow).
function twPre(p, tool, inp) {
  if (!twOn()) return null;
  var isCreate = tool === ah.cfg('tasklist_hygiene.create_tool'), sid = twSid(p), now = ah.clock.now(), S = twStates();
  var status = typeof inp.status === 'string' ? inp.status.toLowerCase() : '';
  var shrinks = ah.cfg('taskstate.done_statuses').indexOf(status) >= 0 || ah.cfg('tasklist_hygiene.delete_trigger').indexOf(status) >= 0;
  if (!isCreate && shrinks) return null; // finishing or deleting a task is never refused
  var subject = isCreate ? (typeof inp.subject === 'string' ? inp.subject : '') : (typeof inp.subject === 'string' ? inp.subject : null);
  var live = twLive(p), id = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId);
  var target = null;
  if (!isCreate && live !== null) live.forEach(function (t) { if (String(t.id) === id) target = t; });
  var backlog = subject !== null && twIsBacklog(subject);
  // the subject form
  if (subject !== null && !backlog && twParse(subject) === null) {
    var st0 = null, sp0 = twStorePath(p, sid);
    if (sp0 !== null) {
      var r0 = twReadAbs(sp0.root + '/' + sp0.rel, sid);
      st0 = r0 === null ? null : r0.v;
      // a resumed session numbers on from the predecessor's store it is about to adopt (read only here)
      if (r0 !== null && r0.absent) { var a0 = twResume(sp0, sid, now); if (a0 !== null && a0.adopt) st0 = a0.adopt; }
    }
    var tp = twTitleOf(subject), keepN = !isCreate && target !== null ? twParse(target.content) : null;
    var n = keepN !== null ? keepN.n : twNextN(st0 || twNew(sid), live);
    var want = twSubject(n, tp.p, tp.title);
    return twBlock('block_format', twR('what_format', { subject: tk.oneLine(subject, ah.cfgNum('task_window.title_max')) }), isCreate ? twR('instead_create', { subject: want }) : twR('instead_rename', { id: id, subject: want }));
  }
  // a second backlog line
  if (backlog && live !== null) {
    var other = null;
    live.forEach(function (t) { if (String(t.id) !== id && twIsBacklog(t.content) && ah.cfg('taskstate.open_statuses').indexOf(tk.statusLc(t)) >= 0) other = t; });
    if (other !== null) return twBlock('block_backlog_dup', twR('what_backlog_dup', { id: String(other.id) }), twR('instead_backlog_dup', { id: String(other.id) }));
  }
  if (!isCreate && target !== null && twIsBacklog(target.content)) return null; // the backlog line's own updates
  // an in-progress task names its owner
  if (!isCreate && ah.settings.bool('task_window.owner_setting') && ah.cfg('taskstate.in_progress_statuses').indexOf(status) >= 0) {
    var given = typeof inp.owner === 'string' ? inp.owner.trim() : '';
    if (given === '' && target !== null && String(target.owner || '').trim() === '') {
      return twBlock('block_owner', twR('what_owner', { id: id }), twR('instead_owner', { id: id, owner: twC('owner_hint') }));
    }
  }
  var bo = jx.isObj(inp.metadata) && typeof inp.metadata.blockedOn === 'string' ? inp.metadata.blockedOn.trim() : '';
  var blocking = !isCreate && ah.settings.bool('task_window.blocked_setting') && (bo.length >= ah.cfgNum('idle_rule.blocked_on_min') || (Array.isArray(inp.addBlockedBy) && inp.addBlockedBy.length > 0));
  if (!isCreate && !blocking) return null;
  if (isCreate && backlog) return null;
  // the rules below need the store
  var sp = twStorePath(p, sid);
  if (sp === null || live === null) return null;
  var lock = twLock(sid);
  if (lock === null) return null;
  try {
    var rd = twReadAbs(sp.root + '/' + sp.rel, sid);
    if (rd === null) return null;
    var st = rd.v, dirty = false;
    if (rd.absent) {
      var res = twResume(sp, sid, now);
      if (res !== null && res.adopt) { st = res.adopt; dirty = true; twMetric('adopted'); }
      else if (res !== null && res.importPath && isCreate) return twBlock('block_import', twR('what_import', { path: res.importPath }), twR('instead_import', { skill: twC('reconcile_skill') }), [twR('import_detail', { skill: twC('reconcile_skill'), path: res.importPath })]);
    }
    if (twSync(st, live, now)) dirty = true;
    ah.commit();
    if (blocking) {
      if (target === null) return null;
      var tpr = twParse(target.content), tt = twTitleOf(target.content);
      if (tpr === null) tpr = { n: twNextN(st, live), p: tt.p === null ? ah.cfgNum('task_guard.priority_default_rank') : tt.p, title: tt.title };
      var reason = bo !== '' ? bo : inp.addBlockedBy.join(' ');
      var keep = ah.settings.num('task_window.blocked_keep_setting');
      // the blocked tasks already visible in the live list (not this one): the cap keeps the window readable
      var shown = live.filter(function (t) { var q = twParse(t.content), it = q === null ? null : twFind(st, q.n); return it !== null && it.state === S.blocked && q.n !== tpr.n && !tk.isDone(t); }).length;
      twSave(st, tpr, S.blocked, { blockedOn: reason, owner: String(target.owner || '') }, now);
      if (!twWrite(sp, st)) return null; // never ordered deleted unless saved
      if (shown < keep) { twMetric('blocked_kept'); return null; } // saved, and it stays visible
      return twBlock('block_blocked', twR('what_blocked', { n: String(tpr.n), keep: String(keep) }), twR('instead_blocked', { id: id }));
    }
    var pr = twParse(subject), open = live.filter(tk.isOpen), liveN = twLiveNs(open), mine = twFind(st, pr.n);
    var write = function () { if (dirty) twWrite(sp, st); };
    // a number taken by another task
    var taken = null;
    live.forEach(function (t) { var q = twParse(t.content); if (q && q.n === pr.n && twNorm(q.title) !== twNorm(pr.title) && !tk.isDone(t)) taken = q.title; });
    if (taken === null && mine !== null && twNorm(mine.title) !== twNorm(pr.title) && [S.done, S.dropped].indexOf(mine.state) < 0) taken = mine.title;
    if (taken !== null) {
      write();
      return twBlock('block_dup', twR('what_dup', { n: String(pr.n), other: tk.oneLine(taken, ah.cfgNum('task_window.title_max')) }), twR('instead_create', { subject: twSubject(twNextN(st, live), pr.p, pr.title) }));
    }
    // a resumed session loads its saved window first
    if (st.resumed === true) {
      var missing = st.tasks.filter(function (it) { return it.state === S.window && liveN[it.n] !== true; });
      if (missing.length === 0) { st.resumed = false; dirty = true; }
      else if (!missing.some(function (it) { return it.n === pr.n; })) {
        if (mine === null) dirty = twSave(st, pr, S.backlog, null, now) || dirty;
        write();
        var subs = missing.map(function (it) { return twSubject(it.n, it.p, it.title); });
        return twBlock('block_drift', twR('what_drift', { missing: String(missing.length) }), twR('instead_drift', { subject: subs[0] }), [twR('drift_detail', { list: subs.join(twC('drift_sep')) }), twBacklogLine(st)]);
      }
    }
    var size = ah.settings.num('task_window.size_setting'), count = twWindowCount(st, open, now);
    if (liveN[pr.n] === true) { write(); return null; } // already live: the harness answers a duplicate itself
    if (count >= size) {
      if (mine === null || mine.state !== S.blocked) dirty = twSave(st, pr, S.backlog, null, now) || dirty;
      write();
      return twBlock('block_full', twR('what_full', { n: String(pr.n), open: String(count), max: String(size) }), twR('instead_full', { skill: twC('reconcile_skill') }), [twBacklogLine(st)]);
    }
    if (ah.settings.bool('task_window.priority_setting')) {
      var top = twTop(st, pr.n);
      if (top !== null && top.p < pr.p) {
        if (mine === null) dirty = twSave(st, pr, S.backlog, null, now) || dirty;
        write();
        return twBlock('block_order', twR('what_order', { n: String(pr.n), p: String(pr.p), bn: String(top.n), bp: String(top.p) }), twR('instead_order', { subject: twSubject(top.n, top.p, top.title) }));
      }
    }
    // the create passes: it holds its slot until it shows in the live list
    if (mine === null) st.tasks.push({ n: pr.n, p: pr.p, title: pr.title, state: S.window, id: '', owner: '', blockedOn: '', at: now, reservedAt: now });
    else { mine.state = S.window; mine.p = pr.p; mine.title = pr.title; mine.id = ''; mine.reservedAt = now; }
    twMetric('reserved');
    twWrite(sp, st);
    return null;
  } finally { ah.state.unlock(lock); }
}

// The PostToolUse side: mirror the call into the store; the slot-free order text when a window task was finished or deleted while the
// backlog holds tasks ('' otherwise).
function twPost(p, tool, inp) {
  if (!twOn()) return '';
  var sid = twSid(p), sp = twStorePath(p, sid), live = twLive(p);
  if (sp === null || live === null) return '';
  var S = twStates(), now = ah.clock.now(), status = typeof inp.status === 'string' ? inp.status.toLowerCase() : '';
  var id = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId);
  var lock = twLock(sid);
  if (lock === null) return '';
  try {
    var rd = twReadAbs(sp.root + '/' + sp.rel, sid);
    if (rd === null) return '';
    var st = rd.v, prior = {};
    st.tasks.forEach(function (it) { if (it.id) prior[it.id] = it.state; });
    var dirty = twSync(st, live, now), freed = false;
    if (tool === ah.cfg('tasklist_hygiene.update_tool') && id !== '') {
      // a kept blocked task that is worked again (in progress, or its blockedOn cleared) is a window task once more
      var cleared = jx.isObj(inp.metadata) && typeof inp.metadata.blockedOn === 'string' && inp.metadata.blockedOn.trim() === '';
      if (cleared || ah.cfg('taskstate.in_progress_statuses').indexOf(status) >= 0) {
        st.tasks.forEach(function (it) { if (it.id === id && it.state === S.blocked) { it.state = S.window; it.blockedOn = ''; dirty = true; } });
      }
      if (ah.cfg('tasklist_hygiene.delete_trigger').indexOf(status) >= 0) {
        st.tasks.forEach(function (it) { if (it.id === id && it.state === S.window) { it.state = S.dropped; dirty = true; freed = true; } });
      } else if (ah.cfg('taskstate.done_statuses').indexOf(status) >= 0) freed = prior[id] === S.window;
    }
    if (rd.absent && st.tasks.length === 0) return ''; // nothing to keep yet
    ah.commit();
    if (dirty) twWrite(sp, st);
    var top = freed ? twTop(st, null) : null;
    if (top === null) return '';
    twMetric('slot_free');
    return twSubject(top.n, top.p, top.title);
  } finally { ah.state.unlock(lock); }
}

function thLen(s) { return Array.from(String(s)).length; }

// Open tasks of the session's list, not counting finished ones; null when the transcript cannot be read exactly.
function thLive(p) {
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return null;
  var r = tk.tasksOf(ah.home(), p.session_id, tp, 'state');
  if (!r || r.unsure || r.unreadable || !Array.isArray(r.tasks)) return null;
  var done = cb.c('ctxbudget.hb_done_statuses');
  return r.tasks.filter(function (t) { return done.indexOf(String(t.status)) < 0; });
}

// The breaches of the call as {sub, subMax, open, budget}; a field is null when not breached or not known.
function thBreach(p, tool, pre) {
  var inp = jx.isObj(p.tool_input) ? p.tool_input : {};
  var out = { sub: null, open: null }, subject = inp.subject;
  var subMax = ah.settings.num('ctxbudget.set_h_task_subject'), budget = ah.settings.num('ctxbudget.set_h_task_budget');
  out.subMax = subMax; out.budget = budget;
  if (typeof subject === 'string' && thLen(subject) > subMax) out.sub = thLen(subject);
  // with the task window on, its size is the open-task limit (enforced at PreToolUse), not handover.taskListBudget
  if (tool === ah.cfg('tasklist_hygiene.create_tool') && !twOn()) {
    var live = thLive(p);
    if (live !== null) {
      var has = !pre && typeof subject === 'string' && live.some(function (t) { return t.content === subject; });
      var n = live.length + (has ? 0 : 1);
      if (n > budget) out.open = n;
    }
  }
  return out;
}

function thCompose(b) {
  var parts = [];
  if (b.sub !== null) parts.push(text.render(ah.cfg('tasklist_hygiene.msg_subject'), { n: b.sub, max: b.subMax }));
  if (b.open !== null) parts.push(text.render(ah.cfg('tasklist_hygiene.msg_open'), { n: b.open, max: b.budget }));
  return parts.join(ah.cfg('tasklist_hygiene.join'));
}

function decide(p, opts, event) {
  if (!jx.isObj(p) || (event !== 'PostToolUse' && event !== 'PreToolUse')) return 'allow';
  var tool = p.tool_name;
  if (tool !== ah.cfg('tasklist_hygiene.create_tool') && tool !== ah.cfg('tasklist_hygiene.update_tool')) return 'allow';
  var guard = ah.cfg('tasklist_hygiene.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  var mode = ah.settings.enum('ctxbudget.set_h_task_enforce');
  var inp = jx.isObj(p.tool_input) ? p.tool_input : {};
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  if (event === 'PreToolUse') {
    var tw = twPre(p, tool, inp);
    if (tw !== null) {
      var twReason = text.message('block', guard, { what: tw.what, instead: tw.instead, extra: tw.extra, details: tw.extra.length > 0 }, sid);
      return { exact: { code: 2, out: text.blockJson(twReason), err: '' } };
    }
    if (mode !== 'block') return 'allow';
    var bp = thCompose(thBreach(p, tool, true));
    if (bp === '') return 'allow';
    var reason = text.message('block', guard, { what: bp, instead: ah.cfg('tasklist_hygiene.instead_block') }, sid);
    return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
  }
  var whats = [], instead = '', doneNote = false, mk = ah.cfg('metric.tasklist_hygiene').advisory_kind;
  var orderOn = dord.on(), orderLine = '', taskId = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId);
  if (tool === ah.cfg('tasklist_hygiene.update_tool') && ah.cfg('tasklist_hygiene.delete_trigger').indexOf(String(inp.status)) >= 0) {
    ah.advisory(mk, ah.cfg('tasklist_hygiene.event_deleted'));
    if (orderOn && taskId !== '') dord.forget(sid, taskId); // an ordered task that is deleted: the order was followed
  }
  var isDone = tool === ah.cfg('tasklist_hygiene.update_tool') && ah.settings.bool('ctxbudget.set_h_task_done_note') && ah.cfg('tasklist_hygiene.done_trigger').indexOf(String(inp.status)) >= 0;
  // a subagent's list is the spawner's: its done task gets no delete order and no done tip (only those; the block, the budget line and
  // the deleted count above still apply)
  if (isDone && ah.cfg('tasklist_hygiene.skip_subagent') === true && coordinator.subagentByPayload(p)) {
    ah.advisory(mk, ah.cfg('tasklist_hygiene.event_subagent_skipped'));
    isDone = false;
  }
  if (isDone) {
    var id = taskId;
    ah.advisory(mk, ah.cfg('tasklist_hygiene.event_nudge'));
    // the completion line is an order (GH #762), recorded so a task left in the list is ordered again on the schedule; when the record
    // cannot be saved (or the switch is off) the one-shot tip is what is left
    if (orderOn && id !== '') orderLine = dord.fresh(sid, id, ah.clock.now(), p);
    // a task the gate refuses (another owner's, or the list is ambiguous or unreadable) gets neither the order nor the delete tip
    var refused = orderOn && id !== '' && orderLine === '' && !dord.orderable(sid, id, dord.ownNames(p));
    if (orderLine === '' && !refused) {
      whats.push(text.render(ah.cfg('tasklist_hygiene.msg_done'), { id: id }));
      instead = ah.cfg('tasklist_hygiene.instead_done');
      doneNote = true;
    }
  }
  if (mode !== 'off') {
    var content = thCompose(thBreach(p, tool, false));
    if (content !== '') {
      var kind = ah.cfg('advisory.kind_tasklist_budget'), d = adv.decide(kind, sid, content);
      if (d.emit) { ah.commit(); adv.commit(d); whats.push(content); if (instead === '') instead = ah.cfg('tasklist_hygiene.instead_budget'); }
    }
  }
  // the task window: the store mirrors the call; a freed slot with a waiting backlog orders tasks-reconcile, folded into the done order
  // when there is one (one order per message)
  var next = twPost(p, tool, inp);
  if (next !== '') {
    var slot = { skill: twC('reconcile_skill'), next: next };
    if (orderLine !== '') orderLine += twR('slot_free_then', slot);
    else orderLine = text.message('order', guard, { what: twR('slot_free', slot) }, sid);
  }
  if (whats.length === 0 && orderLine === '') return 'allow';
  var tip = whats.length === 0 ? '' : text.message('tip', guard, { what: whats.join(ah.cfg('tasklist_hygiene.join')), instead: instead, extra: doneNote ? [ah.cfg('tasklist_hygiene.detail_done')] : [], details: doneNote }, sid);
  return { advisory: text.advisoryJson('PostToolUse', [orderLine, tip].filter(function (x) { return x !== ''; }).join(ah.cfg('tasklist_hygiene.order_joiner'))) };
}

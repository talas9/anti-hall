// Completed-task orders (GH #762), shared by tasklist-hygiene (PostToolUse), task-tracker (UserPromptSubmit) and task-guard (Stop).
// Claude only: Codex has no task tools. A completed task that stays in the session list is re-sent on every turn, so it is ordered
// deleted: once when it is marked completed, then again once it has stayed past guards.doneOrderAfterMin, on the escalating schedule
// done_order.steps_min (never every turn) up to done_order.max_orders. A task that leaves the list after an order counts as followed.
// The record is one small file per session: {ids: {<task id>: {first, count, lastAt}}}; `first` is when the engine first saw the task
// done. `plan` only reads; `apply` writes and counts. Keys and texts: task_guards.toml (done_order.*).
'use strict';
var dord = {
  on: function () { return ah.settings.bool('done_order.sw_enabled'); },
  rel: function (sid) {
    var s = tk.safeKey(typeof sid === 'string' && sid !== '' ? sid : ah.cfg('done_order.no_session')).slice(0, ah.cfgNum('done_order.key_max'));
    return ah.cfg('done_order.dir') + '/' + ah.cfg('done_order.file_prefix') + '-' + s + '.json';
  },
  event: function (name) { ah.advisory(ah.cfg('metric.tasklist_hygiene').advisory_kind, ah.cfg('done_order.events')[name]); },
  count: function (name, n) { for (var i = 0; i < n; i++) dord.event(name); },
  // The record of one session: {id: {first, count, lastAt}}; anything unreadable is an empty record.
  read: function (rel) {
    var raw = ah.state.readText(rel), o = null;
    try { o = raw === null ? null : JSON.parse(raw); } catch (e) { o = null; }
    return o && typeof o === 'object' && o.ids && typeof o.ids === 'object' && !Array.isArray(o.ids) ? o.ids : {};
  },
  write: function (rel, ids) {
    // bounded: the newest max_entries records are kept (the 7-day prune only drops whole stale files)
    var keys = Object.keys(ids), cap = ah.cfgNum('done_order.max_entries');
    if (keys.length > cap) {
      keys.sort(function (a, b) { return dord.num(ids[b] && ids[b].lastAt || ids[b] && ids[b].first) - dord.num(ids[a] && ids[a].lastAt || ids[a] && ids[a].first); });
      var kept = {};
      keys.slice(0, cap).forEach(function (k) { kept[k] = ids[k]; });
      ids = kept;
    }
    var ok = ah.state.writeAtomic(rel, JSON.stringify({ ids: ids }));
    if (ok) gk.pruneStale(ah.cfg('done_order.dir'), ah.cfg('done_order.file_prefix'));
    return ok;
  },
  // The list the orders are about: {list, shared, ambiguous}. A NAMED list (taskstate.list_id_env) is shared with other owners and its ids are
  // keyed `<list>/<id>`; the variable set to a valid id with no store directory is ambiguous (which list the harness writes is unknown).
  ctx: function () {
    var home = ah.home(), named = tk.namedList(home);
    if (named !== null) return { list: named, shared: true, ambiguous: false };
    var id = ah.env.get(ah.cfg('taskstate.list_id_env'));
    var set = typeof id === 'string' && new RegExp(ah.cfg('taskstate.list_id_re')).test(id);
    return { list: '', shared: false, ambiguous: set };
  },
  // Owner by id of the NAMED list's tasks, read from the store exactly: null when it cannot be (no session id, no files, any file unreadable),
  // and then nothing in the shared list is ordered. Every path that gives an order goes through this gate (`foreign`).
  owners: function (sid) {
    var gaps = { n: 0 }, st = tk.storeTasks(ah.home(), sid, gaps);
    if (st === null || gaps.n > 0) return null;
    var m = {};
    st.forEach(function (t) { m[t.id] = t.owner; });
    return m;
  },
  // True when the task must not be ordered deleted: the list is ambiguous, or it is shared and the task's owner is not exactly known to be
  // nobody (`owners` is `dord.owners(sid)` when the list is shared).
  foreign: function (c, owners, id) {
    if (c.ambiguous) return true;
    if (!c.shared) return false;
    return owners === null || !Object.prototype.hasOwnProperty.call(owners, String(id)) || owners[String(id)] !== '';
  },
  // May this task be ordered deleted now (the gate `fresh` and `plan` share)?
  orderable: function (sid, id) {
    var c = dord.ctx();
    return !dord.foreign(c, c.shared ? dord.owners(sid) : null, id);
  },
  key: function (c, id) { return c.list === '' ? String(id) : c.list + '/' + id; },
  num: function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; },
  // `tasks`: the session's task list (a read that is exact). Returns {rel, due: [ids], lingering, followed, next, changed}; nothing is written.
  plan: function (sid, tasks, now) {
    var rel = dord.rel(sid), prev = dord.read(rel), next = {}, due = [], lingering = 0;
    var after = ah.settings.num('done_order.num_after_min') * ah.cfgNum('done_order.ms_per_minute');
    var steps = ah.cfg('done_order.steps_min'), max = ah.cfgNum('done_order.max_orders'), perMin = ah.cfgNum('done_order.ms_per_minute');
    var present = {}, c = dord.ctx(), owners = c.shared ? dord.owners(sid) : null;
    tasks.forEach(function (t) { present[dord.key(c, t.id)] = true; });
    tasks.filter(tk.isDone).forEach(function (t) {
      var id = dord.key(c, t.id), rec = prev[id] && typeof prev[id] === 'object' ? prev[id] : {};
      // fail safe: in a shared list a task another owner holds is never ordered deleted, nor is any task when the list is ambiguous
      var foreign = dord.foreign(c, owners, t.id);
      var first = rec.first > 0 ? rec.first : now, count = dord.num(rec.count), last = dord.num(rec.lastAt);
      next[id] = { first: first, count: count, lastAt: last };
      if (foreign) return;
      if (now - first < after) return;
      lingering++;
      if (count >= max) return;
      if (count > 0 && now - last < steps[Math.min(count, steps.length) - 1] * perMin) return;
      due.push(String(t.id));
      next[id] = { first: first, count: count + 1, lastAt: now };
    });
    var followed = Object.keys(prev).filter(function (id) { return !present[id] && dord.num(prev[id] && prev[id].count) > 0; }).length;
    return { rel: rel, due: due, lingering: lingering, followed: followed, next: next, changed: JSON.stringify(prev) !== JSON.stringify(next) };
  },
  // Write the record (only when it changed) and count; call after ah.commit(). False when the record could not be saved: an order that
  // cannot be counted is never given, so a caller that blocks gives no block then.
  apply: function (pl) {
    var ok = !pl.changed || dord.write(pl.rel, pl.next);
    if (!ok) return false;
    dord.count('lingering', pl.lingering);
    dord.count('followed', pl.followed);
    dord.count('emitted', pl.due.length);
    return true;
  },
  // The order naming the due ids: "Do now: TaskUpdate status=deleted #a #b +2 more".
  order: function (ids) {
    var max = ah.cfgNum('done_order.list_max');
    var list = ids.slice(0, max).map(function (id) { return text.render(ah.cfg('done_order.item'), { id: id }); }).join(ah.cfg('done_order.list_joiner'));
    if (ids.length > max) list += text.render(ah.cfg('done_order.more'), { m: ids.length - max });
    return text.render(ah.cfg('done_order.msg_list'), { n: ids.length, list: list });
  },
  // A task was just marked completed: the record starts at its first order (the line is given now). Returns the order, or '' when the
  // record cannot be saved.
  fresh: function (sid, id, now) {
    if (!dord.orderable(sid, id)) return '';
    var rel = dord.rel(sid), ids = dord.read(rel);
    ids[dord.key(dord.ctx(), id)] = { first: now, count: 1, lastAt: now };
    if (!dord.write(rel, ids)) return '';
    dord.count('emitted', 1);
    return text.render(ah.cfg('done_order.msg_fresh'), { id: id });
  },
  // A task was deleted: if it had been ordered, the order was followed.
  forget: function (sid, id) {
    var rel = dord.rel(sid), ids = dord.read(rel);
    id = dord.key(dord.ctx(), id);
    if (!Object.prototype.hasOwnProperty.call(ids, id)) return;
    var ordered = dord.num(ids[id] && ids[id].count) > 0;
    delete ids[id];
    if (dord.write(rel, ids) && ordered) dord.count('followed', 1);
  },
};

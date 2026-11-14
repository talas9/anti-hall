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
    var ok = ah.state.writeAtomic(rel, JSON.stringify({ ids: ids }));
    if (ok) gk.pruneStale(ah.cfg('done_order.dir'), ah.cfg('done_order.file_prefix'));
    return ok;
  },
  num: function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; },
  // `tasks`: the session's task list (a read that is exact). Returns {rel, due: [ids], lingering, followed, next, changed}; nothing is written.
  plan: function (sid, tasks, now) {
    var rel = dord.rel(sid), prev = dord.read(rel), next = {}, due = [], lingering = 0;
    var after = ah.settings.num('done_order.num_after_min') * ah.cfgNum('done_order.ms_per_minute');
    var steps = ah.cfg('done_order.steps_min'), max = ah.cfgNum('done_order.max_orders'), perMin = ah.cfgNum('done_order.ms_per_minute');
    var present = {};
    tasks.forEach(function (t) { present[String(t.id)] = true; });
    tasks.filter(tk.isDone).forEach(function (t) {
      var id = String(t.id), rec = prev[id] && typeof prev[id] === 'object' ? prev[id] : {};
      var first = rec.first > 0 ? rec.first : now, count = dord.num(rec.count), last = dord.num(rec.lastAt);
      next[id] = { first: first, count: count, lastAt: last };
      if (now - first < after) return;
      lingering++;
      if (count >= max) return;
      if (count > 0 && now - last < steps[Math.min(count, steps.length) - 1] * perMin) return;
      due.push(id);
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
    var rel = dord.rel(sid), ids = dord.read(rel);
    ids[id] = { first: now, count: 1, lastAt: now };
    if (!dord.write(rel, ids)) return '';
    dord.count('emitted', 1);
    return text.render(ah.cfg('done_order.msg_fresh'), { id: id });
  },
  // A task was deleted: if it had been ordered, the order was followed.
  forget: function (sid, id) {
    var rel = dord.rel(sid), ids = dord.read(rel);
    if (!Object.prototype.hasOwnProperty.call(ids, id)) return;
    var ordered = dord.num(ids[id] && ids[id].count) > 0;
    delete ids[id];
    if (dord.write(rel, ids) && ordered) dord.count('followed', 1);
  },
};

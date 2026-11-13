// Escalating idle orders (GH #744), shared by idle-agent-sweep (teammates, Codex agents) and devswarm-parent-inbox (child workspaces).
// A child that stays idle past guards.idleOrderAfterMin gets one order to the coordinator; the order repeats on the escalating schedule
// idle_order.steps_min (never every turn) up to idle_order.max_orders, and stops once the child is no longer idle (given work, answered,
// archived or stopped: counted acted_on). The record is one small file per kind and scope. `plan` only reads; `apply` writes and counts.
// Keys and texts: prompt_emit.toml (idle_order.*).
'use strict';
var idleOrder = {
  enabled: function () { return ah.settings.bool('idle_order.sw_enabled'); },
  afterMs: function () { return ah.settings.num('idle_order.num_after_min') * ah.cfgNum('idle_order.ms_per_minute'); },
  safe: function (s) { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('idle_order.key_max')); },
  rel: function (kind, scope) { return ah.cfg('idle_order.dir') + '/' + ah.cfg('idle_order.file_prefix') + '-' + idleOrder.safe(kind) + '-' + idleOrder.safe(scope) + '.json'; },
  skip: function (kind, reason) { ah.metric('idle_order', ['kind', kind, 'outcome', 'suppressed', 'reason', reason]); },
  // The record of one kind and scope: {id: {count, lastAt}}.
  read: function (rel) {
    var raw = ah.state.readText(rel), o = null;
    try { o = raw === null ? null : JSON.parse(raw); } catch (e) { o = null; }
    return o && typeof o === 'object' && o.subjects && typeof o.subjects === 'object' && !Array.isArray(o.subjects) ? o.subjects : {};
  },
  // `cands`: [{id, label, idleMs}] of the children that are idle past the threshold and eligible for an order; `keep`: ids that are
  // idle past it but silenced this turn (unread mail, busy, focused...): their record is carried forward, so a flap neither counts as
  // acted on nor restarts the schedule. Returns {rel, kind, due: [cand], next: subjects, acted: n, held: [reason]}; nothing is written.
  plan: function (kind, scope, cands, now, keep) {
    var rel = idleOrder.rel(kind, scope), prev = idleOrder.read(rel), next = {}, due = [], held = [];
    var steps = ah.cfg('idle_order.steps_min'), max = ah.cfgNum('idle_order.max_orders'), perMin = ah.cfgNum('idle_order.ms_per_minute');
    cands.forEach(function (c) {
      var rec = prev[c.id], count = rec && isFinite(rec.count) ? rec.count : 0, last = rec && isFinite(rec.lastAt) ? rec.lastAt : 0;
      if (count >= max) { next[c.id] = rec; held.push('cap'); return; }
      var gap = count > 0 ? steps[Math.min(count, steps.length) - 1] * perMin : 0;
      if (count > 0 && now - last < gap) { next[c.id] = rec; held.push('interval'); return; }
      due.push(c);
      next[c.id] = { count: count + 1, lastAt: now };
    });
    (keep || []).forEach(function (id) { if (Object.prototype.hasOwnProperty.call(prev, id) && !Object.prototype.hasOwnProperty.call(next, id)) next[id] = prev[id]; });
    var acted = Object.keys(prev).filter(function (id) { return !Object.prototype.hasOwnProperty.call(next, id); }).length;
    return { rel: rel, kind: kind, due: due, next: next, acted: acted, held: held, changed: due.length > 0 || acted > 0 };
  },
  // Write the record (only when it changed) and count. Call after ah.commit().
  apply: function (pl) {
    pl.held.forEach(function (r) { idleOrder.skip(pl.kind, r); });
    if (pl.acted > 0) ah.metric('idle_order', ['kind', pl.kind, 'outcome', 'acted_on', 'reason', ''], pl.acted);
    if (pl.due.length > 0) ah.metric('idle_order', ['kind', pl.kind, 'outcome', 'fired', 'reason', ''], pl.due.length);
    if (!pl.changed) return;
    ah.state.writeAtomic(pl.rel, JSON.stringify({ subjects: pl.next }));
    gk.pruneStale(ah.cfg('idle_order.dir'), ah.cfg('idle_order.file_prefix'));
  },
  // The named list: "a (42m), b (31m) +2 more".
  list: function (items, itemKey) {
    var max = ah.cfgNum('idle_order.list_max');
    var shown = items.slice(0, max).map(function (c) { return text.render(ah.cfg(itemKey), { name: c.label, min: Math.floor(c.idleMs / ah.cfgNum('idle_order.ms_per_minute')) }); });
    return shown.join(ah.cfg('idle_order.list_joiner')) + (items.length > max ? text.render(ah.cfg('idle_order.more'), { m: items.length - max }) : '');
  },
};

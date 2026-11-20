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
'use strict';

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
  if (tool === ah.cfg('tasklist_hygiene.create_tool')) {
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
  if (ah.cfg('tasklist_hygiene.skip_subagent') === true && coordinator.subagentByPayload(p)) return 'allow';
  var mode = ah.settings.enum('ctxbudget.set_h_task_enforce');
  var inp = jx.isObj(p.tool_input) ? p.tool_input : {};
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  if (event === 'PreToolUse') {
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
  if (tool === ah.cfg('tasklist_hygiene.update_tool') && ah.settings.bool('ctxbudget.set_h_task_done_note') && ah.cfg('tasklist_hygiene.done_trigger').indexOf(String(inp.status)) >= 0) {
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
  if (whats.length === 0 && orderLine === '') return 'allow';
  var tip = whats.length === 0 ? '' : text.message('tip', guard, { what: whats.join(ah.cfg('tasklist_hygiene.join')), instead: instead, extra: doneNote ? [ah.cfg('tasklist_hygiene.detail_done')] : [], details: doneNote }, sid);
  return { advisory: text.advisoryJson('PostToolUse', [orderLine, tip].filter(function (x) { return x !== ''; }).join(ah.cfg('tasklist_hygiene.order_joiner'))) };
}

// check = "tasklist-hygiene" (engine-only; PostToolUse and PreToolUse on TaskCreate and TaskUpdate, Claude only: Codex has no task tools
// and no task hook events). Keeps the session task list small, because the harness re-sends the whole list on every turn:
// (1) PostToolUse: a task just marked completed gets one line telling the agent to record the outcome in the history ledger and delete it;
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

// Write task `id`'s Cause/Fix/Verified entry in the session ledger (inc/task-ledger.js), from the task's subject and description (the
// session's list) and its metadata (the call's own over the store's). True when the ledger holds it afterwards; a failure is counted
// and leaves the old note (the entry is then the agent's to write, and the Stop `ledger` rule lists it).
function thAutoLedger(p, inp, id, sid) {
  if (!ah.settings.bool('pair_rule.strict_auto_ledger')) return false;
  try {
    var home = ah.home(), t = { id: id, content: '', description: '' };
    // the task's own store file answers first (a named list leaves the session store empty, and a transcript scan is the costly path)
    var rec = tlgStoreRec(home, sid, id);
    var r = rec === null && typeof p.transcript_path === 'string' && p.transcript_path !== '' ? tk.tasksOf(home, sid, p.transcript_path, 'state') : null;
    var hit = r && Array.isArray(r.tasks) ? r.tasks.filter(function (x) { return String(x.id) === id; })[0] : undefined;
    if (hit) t = { id: id, content: hit.content || '', description: hit.description || '' };
    var res = tlgEnsure(p, home, t, jx.isObj(inp.metadata) ? inp.metadata : null, ah.clock.now());
    if (res.result === 'written') ah.metric('task_strict_auto_ledgered', ['event', ah.cfg('pair_rule.event_post')]);
    if (res.result === 'failed') ah.unable('tasklist-hygiene:ledger_failed');
    return res.result !== 'failed';
  } catch (e) { ah.unable('tasklist-hygiene:ledger_threw'); return false; }
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
    if (mode !== 'block') return 'allow';
    var bp = thCompose(thBreach(p, tool, true));
    if (bp === '') return 'allow';
    var reason = text.message('block', guard, { what: bp, instead: ah.cfg('tasklist_hygiene.instead_block') }, sid);
    return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
  }
  var whats = [], instead = '', doneNote = false, mk = ah.cfg('metric.tasklist_hygiene').advisory_kind;
  if (tool === ah.cfg('tasklist_hygiene.update_tool') && ah.cfg('tasklist_hygiene.delete_trigger').indexOf(String(inp.status)) >= 0) ah.advisory(mk, ah.cfg('tasklist_hygiene.event_deleted'));
  var finished = tool === ah.cfg('tasklist_hygiene.update_tool') && ah.cfg('tasklist_hygiene.done_trigger').indexOf(String(inp.status)) >= 0;
  var id = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId);
  // GH #682: the engine writes the finished task's ledger entry itself (guards.taskAutoLedger), so the agent only deletes the task
  var ledgered = finished && id !== '' && thAutoLedger(p, inp, id, sid);
  if (finished && ah.settings.bool('ctxbudget.set_h_task_done_note')) {
    whats.push(text.render(ah.cfg(ledgered ? 'tasklist_hygiene.msg_done_auto' : 'tasklist_hygiene.msg_done'), { id: id }));
    instead = ledgered ? text.render(ah.cfg('tasklist_hygiene.instead_done_auto'), { id: id }) : ah.cfg('tasklist_hygiene.instead_done');
    doneNote = true;
    ah.advisory(mk, ah.cfg('tasklist_hygiene.event_nudge'));
  }
  if (mode !== 'off') {
    var content = thCompose(thBreach(p, tool, false));
    if (content !== '') {
      var kind = ah.cfg('advisory.kind_tasklist_budget'), d = adv.decide(kind, sid, content);
      if (d.emit) { ah.commit(); adv.commit(d); whats.push(content); if (instead === '') instead = ah.cfg('tasklist_hygiene.instead_budget'); }
    }
  }
  if (whats.length === 0) return 'allow';
  return { advisory: text.advisoryJson('PostToolUse', text.message('tip', guard, { what: whats.join(ah.cfg('tasklist_hygiene.join')), instead: instead, extra: doneNote ? [ah.cfg('tasklist_hygiene.detail_done')] : [], details: doneNote }, sid)) };
}

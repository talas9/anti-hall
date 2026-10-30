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
  var out = { sub: null, open: null, shape: thShape(inp.subject) }, subject = inp.subject;
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

// Every task of the session's list (finished ones too), or null when the transcript cannot be read exactly.
function thAll(p) {
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return null;
  var r = tk.tasksOf(ah.home(), p.session_id, tp, 'state');
  return !r || r.unsure || r.unreadable || !Array.isArray(r.tasks) ? null : r.tasks;
}

// The shape breach: a subject that is not `T-<n> [P0-P3] title`; only while guards.priorityTagCheck is on.
function thShape(subject) {
  return typeof subject === 'string' && ah.settings.bool('task_guard.priority_check_setting') && !ah.re.test(ah.cfg('tasklist_hygiene.title_shape_re'), 'i', subject);
}

function thCompose(b) {
  var parts = [];
  if (b.sub !== null) parts.push(text.render(ah.cfg('tasklist_hygiene.msg_subject'), { n: b.sub, max: b.subMax }));
  if (b.shape) parts.push(ah.cfg('tasklist_hygiene.msg_shape'));
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
  if (event === 'PreToolUse' && tool === ah.cfg('tasklist_hygiene.update_tool') && ah.cfg('tasklist_hygiene.delete_trigger').indexOf(String(inp.status)) >= 0 && ah.settings.bool('tasklist_hygiene.delete_guard_setting')) {
    var all = thAll(p), tid = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId), dk = ah.cfg('tasklist_hygiene.delete_fp_kind');
    var target = all === null || tid === '' ? null : all.filter(function (t) { return String(t.id) === tid; })[0];
    if (target) {
      if (tk.isDone(target)) ah.advisory(dk, 'acted_on');
      else {
        ah.advisory(dk, 'fired');
        var why = text.render(ah.cfg('tasklist_hygiene.msg_delete'), { id: tid, status: String(target.status || 'open'), subject: tk.oneLine(String(target.content || ''), ah.cfgNum('tasklist_hygiene.delete_subject_max')) });
        return { exact: { code: 2, out: text.blockJson(text.message('block', guard, { what: why, instead: ah.cfg('tasklist_hygiene.instead_delete') }, sid)), err: '' } };
      }
    }
  }
  if (event === 'PreToolUse') {
    if (mode !== 'block') return 'allow';
    var bp = thCompose(thBreach(p, tool, true));
    if (bp === '') return 'allow';
    var reason = text.message('block', guard, { what: bp, instead: ah.cfg('tasklist_hygiene.instead_block') }, sid);
    return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
  }
  var whats = [], instead = '', doneNote = false, mk = ah.cfg('metric.tasklist_hygiene').advisory_kind;
  if (tool === ah.cfg('tasklist_hygiene.update_tool') && ah.cfg('tasklist_hygiene.delete_trigger').indexOf(String(inp.status)) >= 0) ah.advisory(mk, ah.cfg('tasklist_hygiene.event_deleted'));
  if (tool === ah.cfg('tasklist_hygiene.update_tool') && ah.settings.bool('ctxbudget.set_h_task_done_note') && ah.cfg('tasklist_hygiene.done_trigger').indexOf(String(inp.status)) >= 0) {
    var id = inp.taskId === undefined || inp.taskId === null ? '' : String(inp.taskId);
    whats.push(text.render(ah.cfg('tasklist_hygiene.msg_done'), { id: id }));
    instead = ah.cfg('tasklist_hygiene.instead_done');
    doneNote = true;
    ah.advisory(mk, ah.cfg('tasklist_hygiene.event_nudge'));
  }
  if (mode !== 'off') {
    var content = thCompose(thBreach(p, tool, false));
    if (content !== '') {
      // the dedupe hash covers the subject too: two different over-long subjects of the same length are two breaches, not one repeat
      var kind = ah.cfg('advisory.kind_tasklist_budget'), fk = ah.cfg('tasklist_hygiene.fp_kind'), d = adv.decide(kind, sid, content + '\u0000' + String(inp.subject === undefined ? '' : inp.subject));
      if (d.emit) { ah.commit(); adv.commit(d); whats.push(content); ah.advisory(fk, ah.cfg('tasklist_hygiene.event_fired') + '.' + tool); if (instead === '') instead = ah.cfg('tasklist_hygiene.instead_budget'); }
      else { adv.commit(d); ah.advisory(fk, ah.cfg('tasklist_hygiene.event_suppressed') + '.' + tool); }
      if (thShape(inp.subject)) ah.advisory(fk, ah.cfg('tasklist_hygiene.event_shape') + '.' + tool);
    }
  }
  if (whats.length === 0) return 'allow';
  return { advisory: text.advisoryJson('PostToolUse', text.message('tip', guard, { what: whats.join(ah.cfg('tasklist_hygiene.join')), instead: instead, extra: doneNote ? [ah.cfg('tasklist_hygiene.detail_done')] : [], details: doneNote }, sid)) };
}

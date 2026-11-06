// check = "task-pair-guard" (PreToolUse and PostToolUse on Agent and Task, Stop; Claude, engine-only, no Node twin; R-pair, switch guards.pairRule,
// on by default). Every task is paired with the named agent working on it: spawn the agent with a `name`, then `TaskUpdate owner=<name>`, so
// the task panel shows the owner and its live activity. Three facts, one per event:
//   PreToolUse Agent/Task: the spawn has no usable `name` (shorter than pair_rule.name_min_chars): denied, with the step that clears it,
//   unless (switch guards.pairRuleByTaskId, on by default) its description starts with `#<id>` of an open, unowned task of the session's list
//   (the LEADING token only, read by a bounded linear scan, pair_rule.ref_*; any later `#400` is prose): such an unnamed agent is paired by the
//   id. A named teammate's SendMessage reports do not reach the coordinator, so the coordinator's real spawn shape is an unnamed agent with the
//   id in its description. Allow ONLY on positive proof: evidence that cannot be read, an unclear reference or a task another agent owns denies.
//   PostToolUse Agent/Task: the named agent is running but no open task names it as owner: an advisory.
//   Stop: (F2) a live agent with a launch name that no open task names as owner, or (F3) an in-progress task whose owner is that agent's id or
//   description and not its launch name: blocked, listing at most pair_rule.ids_max items.
// Open tasks with no owner, and owners that name no live agent, are task-guard's facts and print nothing here. Main session only, Claude only,
// not plan mode, not while an OMC loop runs (task-guard's own step-aside), never on liveness or agents this script cannot read. With the switch
// off the facts are computed and counted (pair_rule_observed) and nothing is printed. The owner matching is task-guard's (tgMatchingOwners,
// tgLiveAgentOwner), copied here because a shared-lib edit would touch six golden-tested checks. State: none (a Stop that re-fires is cut by the
// host's stop_hook_active). Keys, texts and counters: pair_rule.toml (pair_rule.*, metric.pair_rule_*); the task keys: task_guards.toml.
'use strict';

// Every counter label is a key of pair_rule.labels (the text a label shows is a setting, not code).
function prgLabel(key) { var v = ah.cfg('pair_rule.labels')[key]; return typeof v === 'string' ? v : key; }
function prgSuppressed(reason, n) { ah.metric('pair_rule_suppressed', ['reason', prgLabel(reason)], n); }
function prgObserved(event, result) { ah.metric('pair_rule_observed', ['event', event, 'result', prgLabel(result)]); }
function prgFired(event, kind) { ah.metric('pair_rule_fired', ['event', event, 'kind', prgLabel(kind)]); }

function prgIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function prgCoordinator(owner) { return new RegExp(ah.cfg('task_guard.coordinator_owner_re'), 'i').test(owner); }
// The pairing key of an owner or an agent name: control characters and white space runs read as one space (the way every message shows them,
// so the text a block quotes is the text that pairs), trimmed, case-insensitive.
function prgLc(s) { return tk.oneLine(String(s === undefined || s === null ? '' : s), Number.MAX_SAFE_INTEGER).toLowerCase(); }
// The key of a name in a lookup table: prefixed, so no name (`__proto__`, `constructor`, ...) can be an inherited member of the table.
function prgKey(s) { return 'n:' + prgLc(s); }

// The event the payload names; a payload without the name is read by its shape (a tool response: after, a tool name: before, else a turn end).
function prgEvent(p) {
  if (typeof p.hook_event_name === 'string' && p.hook_event_name !== '') return p.hook_event_name;
  if (p.tool_response !== undefined) return ah.cfg('pair_rule.event_post');
  return typeof p.tool_name === 'string' && p.tool_name !== '' ? ah.cfg('pair_rule.event_pre') : ah.cfg('pair_rule.event_stop');
}

// The launch name of an Agent/Task call input in the form every message shows and every pairing compares (control characters and white space
// runs read as one space, trimmed; '' when there is none, or when nothing but control characters and white space is left: such a name can
// never be set as an owner, so it is no name).
function prgInputName(inp) {
  var v = prgIsObj(inp) ? inp[ah.cfg('task_guard.owner_name_key')] : undefined;
  return typeof v === 'string' ? tk.oneLine(v, Number.MAX_SAFE_INTEGER) : '';
}

// True when a name cannot be shown exactly on the visible line of a message: it is longer than pair_rule.name_max (shown cut) or text.message
// would clean it (backticks, emoji and symbols are dropped, white space is collapsed). Such a name is never put in a step on that line.
function prgInexact(s) { return tk.oneLine(s, ah.cfgNum('pair_rule.name_max')) !== s || text.plain(s) !== s; }

// ---- an OMC autonomous loop (task-guard tgOmcActive, same keys): R-pair steps aside like task-guard does ----
function prgSmallJson(path, max) {
  var size = ah.fs.size(path);
  if (size === null || size > max) return { none: true };
  var f = jx.read(path);
  if (f.text === undefined) return { none: true };
  var r = jx.parse(f.text);
  if (r.unsure) return { unsure: true };
  return r.invalid ? { none: true } : { v: r.v };
}

function prgOmcEnabled(home, cwd) {
  var files = [home + '/' + ah.cfg('task_guard.omc_claude_dir') + '/' + ah.cfg('task_guard.omc_settings_file')];
  if (cwd) ah.cfg('task_guard.omc_project_settings').forEach(function (f) { files.push(cwd + '/' + ah.cfg('task_guard.omc_claude_dir') + '/' + f); });
  for (var i = 0; i < files.length; i++) {
    var r = prgSmallJson(files[i], ah.cfgNum('task_guard.omc_settings_max_bytes'));
    if (r.unsure) { ah.unable('task-pair-guard:omc_settings_unsure'); continue; }
    if (r.none) continue;
    var plugins = jx.field(r.v, ah.cfg('task_guard.omc_plugins_key'));
    if (plugins && plugins[ah.cfg('task_guard.omc_plugin_id')] === true) return true;
  }
  return false;
}

function prgOmcActive(home, cwd, sid, now) {
  if (ah.env.get(ah.cfg('task_guard.omc_disable_env')) === ah.cfg('task_guard.omc_disable_value')) return false;
  var skip = ah.env.get(ah.cfg('task_guard.omc_skip_env')) || '';
  if (skip.split(',').some(function (s) { return s.trim() === ah.cfg('task_guard.omc_skip_token'); })) return false;
  if (cwd && (cwd.charAt(0) !== '/' || cwd.split('/').some(function (s) { return s === '.' || s === '..'; }))) cwd = null;
  if (!prgOmcEnabled(home, cwd)) return false;
  var rel = ah.cfg('task_guard.omc_state_dir').join('/');
  var root = cwd && ah.fs.isDir(cwd + '/' + rel) ? cwd + '/' + rel : home + '/' + rel;
  var files = ah.cfg('task_guard.omc_state_files');
  for (var i = 0; i < files.length; i++) {
    var r = prgSmallJson(root + '/' + files[i], ah.cfgNum('task_guard.omc_state_max_bytes'));
    if (r.unsure) { ah.unable('task-pair-guard:omc_state_unsure'); continue; }
    if (r.none || !jx.isObj(r.v) || r.v[ah.cfg('task_guard.omc_active_key')] !== true) continue;
    var found = false, keys = ah.cfg('task_guard.omc_ts_keys');
    for (var k = 0; k < keys.length && !found; k++) {
      var v = r.v[keys[k]], n = 0;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string') {
        n = jx.isoMs(v);
        if (n === undefined) { ah.unable('task-pair-guard:omc_ts_form'); n = 0; }
      }
      if (!isFinite(n)) n = 0;
      if (n > 0 && now - n <= ah.cfgNum('task_guard.omc_fresh_ms')) found = true;
    }
    if (!found) continue;
    var s = r.v[ah.cfg('task_guard.omc_session_key')];
    if (s === undefined || s === null) return true;
    if (!sid) continue;
    if (String(s) === sid) return true;
  }
  return false;
}

// ---- the scope: null when R-pair speaks, else the reason it steps aside (counted by the caller) ----
function prgScope(p, home, event) {
  if (coordinator.subagentByPayload(p)) return 'subagent';
  if (coordinator.isCodexPayload(p)) return 'codex';
  if (typeof p.permission_mode === 'string' && p.permission_mode.toLowerCase() === ah.cfg('tasklist_guard.plan_mode_value')) return 'plan_mode';
  if (event === ah.cfg('pair_rule.event_stop') && p.stop_hook_active === true) return 'stop_hook_active';
  if (home && prgOmcActive(home, typeof p.cwd === 'string' ? p.cwd : null, p.session_id ? String(p.session_id) : null, ah.clock.now())) return 'omc';
  return null;
}

// The open tasks of the session (null when the list cannot be read exactly: no transcript, an unreadable one or a tail read inexactly is
// missing evidence, never "no open tasks").
function prgOpenTasks(p, home) {
  var all = prgAllTasks(p, home);
  return all === null ? null : all.filter(tk.isOpen);
}

// Every task of the session's list, open or not (null when it cannot be read exactly, as above).
function prgAllTasks(p, home) {
  var tp = p.transcript_path;
  if (!tp || typeof tp !== 'string' || !home) return null;
  var given = p.session_id ? String(p.session_id) : '';
  var r = tk.tasksOf(home, given === '' ? undefined : given, tp, 'guard');
  if (r.unsure) ah.unable('tasks:tail_unsure');
  if (r.unsure || r.unreadable) return null;
  var out = r.tasks || [];
  return out;
}

// The launched agents of the transcript with their launch name and liveness: [{id, description, name, live}] (null when unreadable). Only
// agents whose Agent/Task launch was seen count: adopted rows (a task_status attachment: a Workflow agent, a background shell) carry no
// launch input and are left out.
function prgAgents(p) {
  var own = ah.transcript.agents(p.transcript_path);
  if (own === null || own.unsure) return null;
  var tracked = ah.transcript.trackedAgents(p);
  var out = [];
  own.rows.forEach(function (r) {
    if (r.adopted === true || !prgIsObj(r.spawnInput)) return;
    out.push({ id: String(r.id || ''), description: String(r.description || ''), name: prgInputName(r.spawnInput), live: ah.transcript.trackedLiveness(r.id, tracked) });
  });
  return out;
}

// ---- PreToolUse ----
// PRINCIPLE: the by-id path allows ONLY on positive proof. The proof is: the description's LEADING token is `#<digits>` read exactly, the
// task list was read exactly, and that task is open and unowned (or owned by this spawn's own name). Every other branch (no reference, an
// unclear one, a closed or unknown task, a task owned by another agent, a list that cannot be read) denies and is counted under its result.
//
// The reference of an Agent/Task call's description (a bounded LINEAR scan, no regex): skip leading characters of pair_rule.ref_lead_chars,
// then pair_rule.ref_sigil, then a run of ASCII digits, then the end of the FULL description or a character of pair_rule.ref_end_chars.
// Only the first pair_rule.description_scan_max characters are read. {id} the digits; {none: true} the description has no leading reference;
// {unclear: true} it starts like one but the scan cannot be sure (the first token lies at or after the scan limit, the digits touch the end
// of the scan window so a cut may have made them, or anything but the end/a delimiter follows them): denied. A leading no-break space, byte
// order mark or zero-width character is not in ref_lead_chars: such a description has no reference (denied), never a guessed one.
function prgRef(inp) {
  var d = prgIsObj(inp) && typeof inp.description === 'string' ? inp.description : '';
  var cap = ah.cfgNum('pair_rule.description_scan_max'), lead = ah.cfg('pair_rule.ref_lead_chars'), sigil = ah.cfg('pair_rule.ref_sigil');
  var ends = ah.cfg('pair_rule.ref_end_chars'), len = d.length, win = Math.min(len, cap), i = 0;
  while (i < win && lead.indexOf(d.charAt(i)) >= 0) i++;
  if (i >= len) return { none: true }; // nothing but leading characters
  if (i >= cap) return { unclear: true }; // the first token lies beyond what is scanned
  if (d.charAt(i) !== sigil) return { none: true };
  var j = i + 1;
  while (j < win && d.charCodeAt(j) >= 48 && d.charCodeAt(j) <= 57) j++;
  if (j === i + 1) return { none: true }; // a sigil with no digits
  if (j >= cap && j < len) return { unclear: true }; // the digit run reaches the end of the window: more digits may follow
  if (j < len && ends.indexOf(d.charAt(j)) < 0) return { unclear: true }; // `#400a`, `#400,#401`, `#400#401`
  return { id: d.slice(i + 1, j) };
}

// How an unnamed spawn stands against the task list: paired_by_task_id (the ONLY allow: positive proof, see above), unnamed_no_task (no
// reference, or a number no task has), unnamed_ref_unclear (a reference the scan cannot read exactly), unnamed_closed_task (the task exists
// but is not open), unnamed_other_owner (it is open but another agent owns it), unnamed_duplicate_task (two store files carry its id: which
// one is live is unknown), unnamed_owner_unverified (its owner field is not text), unnamed_unverified (the list cannot be read). A result is a
// key of pair_rule.labels. Returns {result, task}: `task` is the referenced task (the owner a denial names).
function prgByTaskId(p, home) {
  var ref = prgRef(p.tool_input);
  if (ref.unclear === true) return { result: 'unnamed_ref_unclear' };
  if (ref.id === undefined) return { result: 'unnamed_no_task' };
  var all = prgByIdTasks(p, home);
  if (all === null) return { result: 'unnamed_unverified' };
  var hits = all.filter(function (x) { return x.id === ref.id; });
  if (hits.length === 0) return { result: 'unnamed_no_task' };
  if (hits.length > 1) return { result: 'unnamed_duplicate_task' }; // never "the last file wins"
  var t = hits[0];
  if (!tk.isOpen(t)) return { result: 'unnamed_closed_task' };
  // an owner that is present but not text (a number, an object) cannot be compared: unverified, never "unowned"
  if (t.owner !== undefined && t.owner !== null && typeof t.owner !== 'string') return { result: 'unnamed_owner_unverified' };
  var owner = prgLc(t.owner), name = prgLc(prgInputName(p.tool_input));
  if (owner === '' || (name !== '' && owner === name)) return { result: 'paired_by_task_id' };
  return { result: 'unnamed_other_owner', task: t };
}

// The task files of one store directory as raw records [{id, status, owner}] (owner as the file holds it: a non-text owner is kept so the
// caller can refuse it; a duplicate id is kept so the caller can refuse it). null: the directory cannot be read within the bounds (more than
// taskstate.store_max_files task files). A file that is not valid JSON, has no string status or no string/number id is skipped (as
// tk.storeTasks does).
function prgDirRecords(dir) {
  var suffix = ah.cfg('taskstate.store_file_suffix'), maxFiles = ah.cfgNum('taskstate.store_max_files'), maxBytes = ah.cfgNum('taskstate.store_file_max_bytes');
  var files = ah.fs.readdir(dir);
  if (files === null) return null;
  files = files.filter(function (f) { return f.length > suffix.length && f.slice(-suffix.length) === suffix; });
  if (files.length > maxFiles) { ah.unable('tasks:store_big'); return null; }
  var out = [];
  files.forEach(function (f) {
    var raw = ah.fs.readText(dir + '/' + f, maxBytes), rec;
    if (raw === null) return;
    try { rec = JSON.parse(raw); } catch (e) { return; }
    if (rec === null || typeof rec !== 'object' || (typeof rec.id !== 'string' && typeof rec.id !== 'number') || typeof rec.status !== 'string') return;
    out.push({ id: String(rec.id), status: rec.status, owner: typeof rec.owner === 'string' ? rec.owner.trim() : rec.owner });
  });
  return out;
}

// The task list the by-id proof reads: the shared store ladder `tk.storeLadder` (named list, else the session's own directory even when
// empty, else the transcript), here over the raw record reader above. The whole named list is read (it is a by-id proof that a task exists,
// not a gate). null: no readable list (denied).
function prgByIdTasks(p, home) {
  var sid = p.session_id ? String(p.session_id) : '';
  var st = tk.storeLadder(home, sid, function (dir) { return ah.fs.isDir(dir) ? prgDirRecords(dir) : undefined; }, ah.cfg('taskstate.store_named_list') === true, true);
  return st !== null ? st.list : prgAllTasks(p, home);
}

function prgPre(p, on, home) {
  var event = ah.cfg('pair_rule.event_pre'), name = prgInputName(p.tool_input);
  var unnamed = name.length < ah.cfgNum('pair_rule.name_min_chars');
  var byId = unnamed && ah.settings.bool('pair_rule.sw_by_id'), verdict = { result: 'unnamed' };
  var result = !unnamed ? 'named' : 'unnamed';
  if (byId) {
    // a script failure here (a throw) denies, as the base does: it is never an accept
    try { verdict = prgByTaskId(p, home); } catch (e) { verdict = { result: 'unnamed_unverified' }; ah.unable('task-pair-guard:by_id_failed'); }
    result = verdict.result;
    prgObserved(event, result);
    if (result === 'paired_by_task_id') return 'allow';
  } else prgObserved(event, result);
  if (!unnamed || !on) return 'allow';
  prgFired(event, 'unnamed');
  // an open task another agent owns: the denial names the owner and the two ways out
  var other = byId && result === 'unnamed_other_owner' && verdict.task !== undefined, t = verdict.task;
  var reason = text.message('block', ah.cfg('pair_rule.guard_name'), {
    what: ah.cfg('pair_rule.msg_pre_what'),
    why: other ? text.render(ah.cfg('pair_rule.msg_pre_why_owner'), { id: t.id, owner: t.owner }) : ah.cfg(byId ? 'pair_rule.msg_pre_why_id' : 'pair_rule.msg_pre_why'),
    instead: other ? text.render(ah.cfg('pair_rule.msg_pre_instead_owner'), { id: t.id, owner: tk.oneLine(t.owner, ah.cfgNum('pair_rule.name_max')) })
      : ah.cfg(byId ? 'pair_rule.msg_pre_instead_id' : 'pair_rule.msg_pre_instead'),
  });
  return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
}

// ---- PostToolUse ----
function prgErrorResponse(tr) {
  if (typeof tr === 'string') return new RegExp(ah.cfg('pair_rule.error_re'), 'i').test(tr);
  return prgIsObj(tr) && (tr.is_error === true || (typeof tr.error === 'string' && tr.error !== ''));
}

function prgPost(p, on, home) {
  var event = ah.cfg('pair_rule.event_post'), name = prgInputName(p.tool_input);
  if (name === '' || prgErrorResponse(p.tool_response)) return 'allow'; // an unnamed spawn is the Pre fact; a failed spawn started nothing
  // a name below pair_rule.name_min_chars is no name (the Pre fact too): with the by-id switch on there is no name to look for
  if (name.length < ah.cfgNum('pair_rule.name_min_chars') && ah.settings.bool('pair_rule.sw_by_id')) return 'allow';
  var open = prgOpenTasks(p, home);
  if (open === null) { prgSuppressed('no_rows'); return 'allow'; }
  var lc = prgLc(name), paired = open.some(function (t) { return prgLc(t.owner) === lc; });
  prgObserved(event, paired ? 'paired' : 'unpaired');
  if (paired || !on) return 'allow';
  prgFired(event, 'unpaired');
  // The visible line may show the name shortened or without its marks (prgInexact): that text only tells what is off. The step that clears it
  // always carries the FULL name, or, when the visible line cannot carry it exactly, points at the saved details that do.
  var shown = tk.oneLine(name, ah.cfgNum('pair_rule.name_max')), step = text.render(ah.cfg('pair_rule.msg_post_instead'), { name: name });
  var inexact = prgInexact(name);
  var note = text.message('warn', ah.cfg('pair_rule.guard_name'), {
    what: text.render(ah.cfg('pair_rule.msg_post_what'), { name: shown }), why: ah.cfg('pair_rule.msg_post_why'),
    instead: inexact ? ah.cfg('pair_rule.msg_post_instead_full') : step, extra: inexact ? [step] : [], details: inexact,
  });
  return { advisory: text.advisoryJson(event, note) };
}

// ---- Stop ----
// The loose reading of task-guard's tgMatchingOwners without the launch name: the owner is the agent's id, its whole description or a
// description substring of at least task_guard.owner_match_min characters.
function prgLooseOwner(owner, row) {
  var o = prgLc(owner), id = prgLc(row.id), d = prgLc(row.description);
  return o === id || (d !== '' && o === d) || (o.length >= ah.cfgNum('task_guard.owner_match_min') && d.indexOf(o) >= 0);
}

// ---- the pairing: a pure function of (tasks, agents) ----
// Pairing is by agent NAME, as a multiset: an open task owned by a name pairs with ONE live agent of that name and a live agent with ONE
// task of its name (a name's pairs = min(tasks owned by it, live agents launched with it); tasks and agents are matched one to one, the
// surplus of either side is the unpaired rest). A name is compared by prgLc. What is left over:
//   f2: per name, the live agents with no task of their name left (n of them), after the loose attendance below;
//   f3: the in-progress tasks whose owner is not any named agent's name but loosely names a live agent (its id or description): the owner
//       must become that agent's name. A task that names an agent of its launch name (live or not, whatever its liveness) is never f3;
//       a coordinator-like owner never matches loosely (an agent literally named like it pairs by name, above).
// An f3 task attends an unpaired agent (fixing the task pairs it), by a maximum matching of the f3 tasks onto the unpaired agents, so a
// block's stated step (TaskUpdate owner to the listed name, TaskCreate/TaskUpdate one task per listed agent) always clears it: the next
// Stop over the fixed list is clean. Open tasks with no owner, surplus tasks and owners naming no live agent are not this check's facts.
// tasks: [{id, owner, status}] (open tasks); agents: [{id, description, name, live}] (live: true | false | null = unknown);
// rules: {coordinator(owner), loose(owner, row), inProgress(task)}. Returns {f2: [{name, n}], f3: [{task, row}]}.
function prgPair(tasks, agents, rules) {
  // Every map below is keyed by prgKey (a prefixed name), never by the bare name: a name is data, and a plain object resolves `__proto__` and
  // `constructor` to inherited members (a throw in `.push`, or a phantom count), so no name may ever be a bare property key.
  var seenId = {}, rows = [], known = {}, live = [];
  agents.forEach(function (r) {
    if (r.name === '') return; // an unnamed agent cannot be paired (the spawn check's fact)
    if (r.id !== '') { if (seenId['id:' + r.id] === true) return; seenId['id:' + r.id] = true; } // one agent seen twice is one agent
    rows.push(r);
    known[prgKey(r.name)] = true;
    if (r.live === true) live.push(r);
  });
  var taskCount = {}, byName = {}, names = [];
  tasks.forEach(function (t) { var k = prgKey(t.owner); if (prgLc(t.owner) !== '') taskCount[k] = (taskCount[k] || 0) + 1; });
  live.forEach(function (r) {
    var k = prgKey(r.name);
    if (byName[k] === undefined) { byName[k] = []; names.push(k); }
    byName[k].push(r);
  });
  var slots = []; // one per unpaired agent: the name key it belongs to
  names.forEach(function (k) { for (var i = byName[k].length - (taskCount[k] || 0); i > 0; i--) slots.push(k); });
  var cand = []; // the f3 tasks with the names of the live agents each loosely names
  tasks.forEach(function (t) {
    if (prgLc(t.owner) === '' || known[prgKey(t.owner)] === true || rules.coordinator(t.owner) || !rules.inProgress(t)) return;
    var near = live.filter(function (r) { return rules.loose(t.owner, r); });
    if (near.length > 0) cand.push({ task: t, near: near });
  });
  var slotOf = []; // slot -> index of the f3 task attending it (-1 free)
  slots.forEach(function () { slotOf.push(-1); });
  function attend(ci, seen) {
    for (var si = 0; si < slots.length; si++) {
      if (seen[si] === true || !cand[ci].near.some(function (r) { return prgKey(r.name) === slots[si]; })) continue;
      seen[si] = true;
      if (slotOf[si] < 0 || attend(slotOf[si], seen)) { slotOf[si] = ci; return true; }
    }
    return false;
  }
  cand.forEach(function (c, ci) { attend(ci, {}); });
  var left = {}, f3 = [];
  slots.forEach(function (k, si) { if (slotOf[si] < 0) left[k] = (left[k] || 0) + 1; });
  cand.forEach(function (c, ci) {
    var row = c.near[0]; // listed with the agent it attends; an unattending one (its agents are paired) with the first it names
    for (var si = 0; si < slots.length; si++) {
      if (slotOf[si] !== ci) continue;
      for (var j = 0; j < c.near.length; j++) if (prgKey(c.near[j].name) === slots[si]) { row = c.near[j]; break; }
      break;
    }
    f3.push({ task: c.task, row: row });
  });
  // f2: per name, n agents have no task of their name; `agents` live agents bear the name and `owned` open tasks are owned by it (owned > 0:
  // the name has tasks, but fewer than agents, so only a NEW task clears it: changing the owner of a task the name already owns cannot).
  var f2 = [];
  names.forEach(function (k) { if (left[k] > 0) f2.push({ name: byName[k][0].name, n: left[k], agents: byName[k].length, owned: taskCount[k] || 0 }); });
  return { f2: f2, f3: f3 };
}

function prgStop(p, on, home) {
  var event = ah.cfg('pair_rule.event_stop');
  var open = prgOpenTasks(p, home), rows = open === null ? null : prgAgents(p);
  if (open === null || rows === null) { prgSuppressed('no_rows'); return 'allow'; }
  // a launch name below pair_rule.name_min_chars is no name (the spawn check lets such an agent through when its description names a task id)
  if (ah.settings.bool('pair_rule.sw_by_id')) rows.forEach(function (r) { if (r.name.length < ah.cfgNum('pair_rule.name_min_chars')) r.name = ''; });
  var unknown = rows.filter(function (r) { return r.name !== '' && r.live === null; });
  if (unknown.length > 0) prgSuppressed('liveness_unknown', unknown.length);
  var inProgress = ah.cfg('taskstate.in_progress_statuses');
  var res = prgPair(open, rows, {
    coordinator: prgCoordinator, loose: prgLooseOwner,
    // F3 speaks only for an in-progress task; a task in another open status that names the agent loosely does not attend it (F2 fires)
    inProgress: function (t) { return inProgress.indexOf(tk.statusLc(t)) >= 0; },
  });
  var f2 = res.f2, f3 = res.f3;
  var result = f2.length > 0 ? 'agent_without_task' : f3.length > 0 ? 'inexact_owner' : 'clean';
  prgObserved(event, result);
  if (result === 'clean' || !on) return 'allow';
  if (f2.length > 0) prgFired(event, 'agent_without_task');
  if (f3.length > 0) prgFired(event, 'inexact_owner');
  var max = ah.cfgNum('pair_rule.ids_max'), nameMax = ah.cfgNum('pair_rule.name_max'), items = [], full = [], inexact = [];
  f2.forEach(function (a) {
    // the name owns no task at all: one agent (item_agent) or several (item_agent_many); it owns some, but fewer than its agents: item_agent_share
    var share = a.owned > 0, many = !share && a.n > 1, args = { name: a.name, n: a.n, agents: a.agents, owned: a.owned };
    items.push(text.render(ah.cfg(share ? 'pair_rule.item_agent_share' : many ? 'pair_rule.item_agent_many' : 'pair_rule.item_agent'), { name: tk.oneLine(a.name, nameMax), n: a.n, agents: a.agents, owned: a.owned }));
    full.push(text.render(ah.cfg(share ? 'pair_rule.detail_agent_share' : many ? 'pair_rule.detail_agent_many' : 'pair_rule.detail_agent'), args));
    inexact.push(prgInexact(a.name));
  });
  f3.forEach(function (x) {
    items.push(text.render(ah.cfg('pair_rule.item_task'), { id: x.task.id, owner: tk.oneLine(x.task.owner, nameMax), name: tk.oneLine(x.row.name, nameMax) }));
    full.push(text.render(ah.cfg('pair_rule.detail_task'), { id: x.task.id, owner: x.task.owner, name: x.row.name }));
    inexact.push(prgInexact(x.row.name) || prgInexact(x.task.owner));
  });
  // The visible line is cut near pair_rule.what_budget units, and the cut must never hide the "(+n more)" tail: items are taken while the
  // line fits (at most ids_max, at least one), the rest is counted, and the saved details (the whole list, every name whole) are linked when any
  // is left out. They are also linked, and the step says to use them, when a shown item has a name the line shows inexactly: a step must
  // never ask for an owner that is not the name that pairs.
  function whatOf(k) {
    var left = items.length - k;
    return text.render(ah.cfg('pair_rule.msg_stop_what'), {
      n: items.length, items: items.slice(0, k).join(ah.cfg('pair_rule.item_sep')),
      more: left > 0 ? text.render(ah.cfg('pair_rule.more'), { n: left }) : '',
    });
  }
  // (an item left off the line is linked anyway: the step says to use the saved details whenever ANY item's name is inexact)
  function linked(k) { return k < items.length || inexact.slice(0, k).some(function (b) { return b; }); }
  var k = Math.min(items.length, max);
  while (k > 1 && text.plain(whatOf(k)).length > ah.cfgNum(linked(k) ? 'pair_rule.what_budget_more' : 'pair_rule.what_budget')) k--;
  // an agent short of a task (f2) needs a NEW task: changing an owner cannot supply a missing slot, so its step says create
  var anyInexact = inexact.some(function (b) { return b; }), insteadKey = f2.length === 0 ? (anyInexact ? 'pair_rule.msg_stop_instead_full' : 'pair_rule.msg_stop_instead')
    : f3.length === 0 ? (anyInexact ? 'pair_rule.msg_stop_instead_create_full' : 'pair_rule.msg_stop_instead_create')
    : (anyInexact ? 'pair_rule.msg_stop_instead_full' : 'pair_rule.msg_stop_instead_mixed');
  var reason = text.message('block', ah.cfg('pair_rule.guard_name'), {
    what: whatOf(k), why: ah.cfg('pair_rule.msg_stop_why'), instead: ah.cfg(insteadKey),
    extra: full, details: linked(k),
  });
  return { exact: { code: 0, out: text.blockJson(reason), err: '' } };
}

function decide(p) {
  if (ah.env.get(ah.cfg('task_guard.judge_child_env')) === '1') return 'allow';
  if (p === null || typeof p !== 'object') return 'allow';
  if (ah.settings.skipped(ah.cfg('pair_rule.guard_name'))) return 'allow';
  var event = prgEvent(p);
  if (event !== ah.cfg('pair_rule.event_pre') && event !== ah.cfg('pair_rule.event_post') && event !== ah.cfg('pair_rule.event_stop')) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (event !== ah.cfg('pair_rule.event_stop') && ah.cfg('pair_rule.tools').indexOf(tool) < 0) return 'allow';
  // HOME unset: the passwd home, as task-guard adopts it (state, settings and skips live under it)
  if (ah.env.get(ah.cfg('env.home')) === null) {
    var nh = hookProc.nodeHome();
    if (nh.home === undefined) { ah.unable('task-pair-guard:no_home', 'abandoned'); return 'allow'; }
    if (hookProc.testGuarded(nh.home)) { ah.unable('task-pair-guard:home_test_guard', 'abandoned'); return 'allow'; }
    ah.useHome(nh.home);
  }
  var home = ah.home();
  var why = prgScope(p, home, event);
  if (why !== null) { prgSuppressed(why); return 'allow'; }
  var on = ah.settings.bool('pair_rule.sw');
  if (event === ah.cfg('pair_rule.event_pre')) return prgPre(p, on, home);
  if (!home) { prgSuppressed('no_rows'); return 'allow'; }
  return event === ah.cfg('pair_rule.event_post') ? prgPost(p, on, home) : prgStop(p, on, home);
}

// check = "task-pair-guard" (PreToolUse and PostToolUse on Agent and Task, Stop; Claude, engine-only, no Node twin; R-pair, switch guards.pairRule,
// off by default). Every task is paired with the named agent working on it: spawn the agent with a `name`, then `TaskUpdate owner=<name>`, so
// the task panel shows the owner and its live activity. Three facts, one per event:
//   PreToolUse Agent/Task: the spawn has no usable `name` (shorter than pair_rule.name_min_chars): denied, with the step that clears it.
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
function prgLc(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }

// The event the payload names; a payload without the name is read by its shape (a tool response: after, a tool name: before, else a turn end).
function prgEvent(p) {
  if (typeof p.hook_event_name === 'string' && p.hook_event_name !== '') return p.hook_event_name;
  if (p.tool_response !== undefined) return ah.cfg('pair_rule.event_post');
  return typeof p.tool_name === 'string' && p.tool_name !== '' ? ah.cfg('pair_rule.event_pre') : ah.cfg('pair_rule.event_stop');
}

// The launch name of an Agent/Task call input, trimmed ('' when there is none).
function prgInputName(inp) {
  var v = prgIsObj(inp) ? inp[ah.cfg('task_guard.owner_name_key')] : undefined;
  return typeof v === 'string' ? v.trim() : '';
}

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

// The open tasks of the session ([] with `.unreadable` when the list cannot be read exactly).
function prgOpenTasks(p, home) {
  var tp = p.transcript_path;
  if (!tp || typeof tp !== 'string' || !home) return null;
  var given = p.session_id ? String(p.session_id) : '';
  var tasks = tk.tasks(tp, home, given === '' ? undefined : given);
  if (tasks.unsure) return null;
  return tasks.filter(tk.isOpen);
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
function prgPre(p, on) {
  var event = ah.cfg('pair_rule.event_pre'), name = prgInputName(p.tool_input);
  var unnamed = name.length < ah.cfgNum('pair_rule.name_min_chars');
  prgObserved(event, unnamed ? 'unnamed' : 'named');
  if (!unnamed || !on) return 'allow';
  prgFired(event, 'unnamed');
  var reason = text.message('block', ah.cfg('pair_rule.guard_name'), { what: ah.cfg('pair_rule.msg_pre_what'), why: ah.cfg('pair_rule.msg_pre_why'), instead: ah.cfg('pair_rule.msg_pre_instead') });
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
  var open = prgOpenTasks(p, home);
  if (open === null) { prgSuppressed('no_rows'); return 'allow'; }
  var lc = prgLc(name), paired = open.some(function (t) { return prgLc(t.owner) === lc; });
  prgObserved(event, paired ? 'paired' : 'unpaired');
  if (paired || !on) return 'allow';
  prgFired(event, 'unpaired');
  var shown = tk.oneLine(name, ah.cfgNum('pair_rule.name_max'));
  var note = text.message('warn', ah.cfg('pair_rule.guard_name'), {
    what: text.render(ah.cfg('pair_rule.msg_post_what'), { name: shown }), why: ah.cfg('pair_rule.msg_post_why'),
    instead: text.render(ah.cfg('pair_rule.msg_post_instead'), { name: shown }),
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

function prgStop(p, on, home) {
  var event = ah.cfg('pair_rule.event_stop');
  var open = prgOpenTasks(p, home), rows = open === null ? null : prgAgents(p);
  if (open === null || rows === null) { prgSuppressed('no_rows'); return 'allow'; }
  var live = rows.filter(function (r) { return r.name !== '' && r.live === true; });
  var unknown = rows.filter(function (r) { return r.name !== '' && r.live === null; });
  if (unknown.length > 0) prgSuppressed('liveness_unknown', unknown.length);
  var owned = open.filter(function (t) { return t.owner && !prgCoordinator(t.owner); });
  var paired = {}, loose = {}, f3 = [];
  owned.forEach(function (t) {
    var o = prgLc(t.owner), exact = -1, near = -1;
    live.forEach(function (r, i) {
      if (exact < 0 && prgLc(r.name) === o) exact = i;
      else if (near < 0 && prgLooseOwner(t.owner, r)) near = i;
    });
    if (exact >= 0) { paired[exact] = true; return; }
    if (near < 0) return;
    loose[near] = true;
    if (ah.cfg('taskstate.in_progress_statuses').indexOf(tk.statusLc(t)) >= 0) f3.push({ task: t, row: live[near] });
  });
  var f2 = [], seen = {};
  live.forEach(function (r, i) {
    var k = prgLc(r.name);
    if (paired[i] || loose[i] || seen[k] === true) return;
    seen[k] = true;
    f2.push(r);
  });
  var result = f2.length > 0 ? 'agent_without_task' : f3.length > 0 ? 'inexact_owner' : 'clean';
  prgObserved(event, result);
  if (result === 'clean' || !on) return 'allow';
  if (f2.length > 0) prgFired(event, 'agent_without_task');
  if (f3.length > 0) prgFired(event, 'inexact_owner');
  var max = ah.cfgNum('pair_rule.ids_max'), nameMax = ah.cfgNum('pair_rule.name_max'), items = [], full = [];
  f2.forEach(function (r) {
    items.push(text.render(ah.cfg('pair_rule.item_agent'), { name: tk.oneLine(r.name, nameMax) }));
    full.push(text.render(ah.cfg('pair_rule.detail_agent'), { name: r.name }));
  });
  f3.forEach(function (x) {
    items.push(text.render(ah.cfg('pair_rule.item_task'), { id: x.task.id, owner: tk.oneLine(x.task.owner, nameMax), name: tk.oneLine(x.row.name, nameMax) }));
    full.push(text.render(ah.cfg('pair_rule.detail_task'), { id: x.task.id, owner: x.task.owner, name: x.row.name }));
  });
  var more = items.length > max ? text.render(ah.cfg('pair_rule.more'), { n: items.length - max }) : '';
  var reason = text.message('block', ah.cfg('pair_rule.guard_name'), {
    what: text.render(ah.cfg('pair_rule.msg_stop_what'), { n: items.length, items: items.slice(0, max).join(ah.cfg('pair_rule.item_sep')), more: more }),
    why: ah.cfg('pair_rule.msg_stop_why'), instead: ah.cfg('pair_rule.msg_stop_instead'), extra: full,
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
  if (event === ah.cfg('pair_rule.event_pre')) return prgPre(p, on);
  if (!home) { prgSuppressed('no_rows'); return 'allow'; }
  return event === ah.cfg('pair_rule.event_post') ? prgPost(p, on, home) : prgStop(p, on, home);
}

// check = "task-guard" (Stop; mirrors hooks/task-guard.js and lib/dispatch-demand.js). Blocks a Stop while the session's task list
// still has open tasks: rebuilds the list from the transcript tail (ah.transcript.tasks, variant guard) and answers the quiet Stops
// (no open task, every open task honestly blocked, the same set already blocked, the block cap reached), the steps aside (an OMC
// loop, live agents, a spent per-prompt budget) and both blocks: the sharp idle-neglect block (dispatchable tasks no running agent
// covers) and the generic one, with the loop-state file, the per-prompt budget file and the idle-neglect metrics written as Node
// writes them. State is written only after the reply is delivered. Nothing is handed back to Node: a state file, timestamp or
// transcript line only V8 reads exactly is counted (native_unable at `task-guard.*`) and read as absent, so a corrupt state can only
// make a block fire again (bounded by the block cap and the per-prompt budget), never silence one; the DevSwarm app database is read
// natively (ah.mesh / tk.childAttended). The fixed stderr notes pass the advisory gate (once per session, again after N calls).
// Keys and texts: task_guards.toml (task_guard.*, taskstate.*, taskkit.*), advisory.toml.
'use strict';

function tgRe(key, flags) { return jx.re(key, flags); }

function tgCoordinator(owner) { return tgRe('task_guard.coordinator_owner_re', 'i').test(owner); }

// `isOwnerBlocked` of lib/dispatch-demand.js.
function tgOwnerBlocked(t) {
  if (!ah.settings.bool('dispatch_tier.owner_marker_setting')) return false;
  if (ah.cfg('dispatch_tier.owner_values').indexOf(tk.blockedOnText(t)) >= 0) return true;
  var value = [t.owner || '', t.content || '', t.description || ''].join(' ').toLowerCase();
  if (ah.cfg('task_guard.owner_decision_markers').some(function (m) { return value.indexOf(m.toLowerCase()) >= 0; })) return true;
  return tgRe('dispatch_tier.owner_subject_re', 'i').test(t.content);
}

function tgPriorityRank(p) {
  var dflt = ah.cfgNum('task_guard.priority_default_rank');
  if (!p) return dflt;
  var s = p.trim().toLowerCase(), m = tgRe('task_guard.priority_rank_re').exec(s);
  if (m) return parseInt(m[1], 10);
  if (ah.cfg('task_guard.priority_low').indexOf(s) >= 0) return ah.cfgNum('task_guard.priority_low_rank');
  return dflt;
}

function tgMinPriorityRank() {
  var raw = ah.settings.enum('task_guard.min_priority_setting').trim().toLowerCase(), m = tgRe('task_guard.priority_rank_re').exec(raw);
  return m ? parseInt(m[1], 10) : ah.cfgNum('task_guard.priority_default_rank');
}

// The open tasks that can be dispatched now.
function tgActionable(open, tasks) {
  var known = {}, notDone = {};
  tasks.forEach(function (t) { known[t.id] = true; if (!tk.isDone(t)) notDone[t.id] = true; });
  var floor = tgMinPriorityRank(), pending = ah.cfg('task_guard.pending_status');
  return open.filter(function (t) {
    if (tk.statusLc(t) !== pending || t.blockUnknown) return false;
    if (t.owner && !tgCoordinator(t.owner)) return false;
    if (tgOwnerBlocked(t)) return false;
    if (t.blockedBy.some(function (id) { return notDone[id] === true || known[id] !== true; })) return false;
    return tgPriorityRank(t.priority) <= floor;
  });
}

// `devswarmChildAttended(owner)`: the app database shows the owner's workspace live (tk.childAttended).
function tgChildAttended(owner) { return tk.childAttended(owner); }

// A task whose owner names an agent this session has running (its id, the name it was launched with, or its description) is attended: the agent is working
// it. `rows` is the running-agent list of the transcript scan (null when unreadable: nothing is attended through it).
function tgMatchingOwners(owner, rows) {
  var o = (owner || '').trim().toLowerCase();
  if (!o || rows === null || tgCoordinator(o)) return [];
  var min = ah.cfgNum('task_guard.owner_match_min'), nameKey = ah.cfg('task_guard.owner_name_key');
  return rows.filter(function (r) {
    var id = String(r.id || '').toLowerCase(), d = String(r.description || '').toLowerCase();
    var nm = jx.isObj(r.spawnInput) && typeof r.spawnInput[nameKey] === 'string' ? r.spawnInput[nameKey].trim().toLowerCase() : '';
    return o === id || (d !== '' && o === d) || (nm !== '' && o === nm) || (o.length >= min && d.indexOf(o) >= 0);
  });
}

function tgLiveAgentOwner(owner, rows) {
  return tgMatchingOwners(owner, rows).some(function (r) { return r.live === true; });
}

function tgUnresolvedOwner(t, rows) {
  if (!t.owner || tgCoordinator(t.owner) || tgOwnerBlocked(t) || tgChildAttended(t.owner)) return false;
  return !tgMatchingOwners(t.owner, rows).some(function (r) { return r.live !== null; });
}

// The open tasks the generic block lists: a task waiting (through any chain) on an open task that is itself free or waiting on the
// owner is honestly blocked and left out, as is a task waiting on the owner and one owned by a live DevSwarm workspace.
function tgUnblocked(open, tasks, rows) {
  var byId = {}, openIds = [];
  tasks.forEach(function (t) { byId[t.id] = t; if (ah.cfg('taskstate.open_statuses').indexOf(tk.statusLc(t)) >= 0 && openIds.indexOf(t.id) < 0) openIds.push(t.id); });
  function valid(t) { return t.blockedBy.filter(function (id) { return id !== t.id && openIds.indexOf(id) >= 0; }); }
  var reach = {};
  openIds.forEach(function (id) { var t = byId[id]; if (t && (valid(t).length === 0 || tgOwnerBlocked(t))) reach[id] = true; });
  for (var changed = true; changed;) {
    changed = false;
    openIds.forEach(function (id) {
      if (reach[id]) return;
      var t = byId[id];
      if (t && valid(t).some(function (b) { return reach[b] === true; })) { reach[id] = true; changed = true; }
    });
  }
  var out = [];
  for (var i = 0; i < open.length; i++) {
    var t = open[i];
    if (tgOwnerBlocked(t) || valid(t).some(function (b) { return reach[b] === true; })) continue;
    if (tgLiveAgentOwner(t.owner, rows)) continue;
    if (ah.cfg('task_guard.advise_unresolved_owners') && tgUnresolvedOwner(t, rows)) continue;
    if (!tgChildAttended(t.owner)) out.push(t);
  }
  return out;
}

// `agentsRunning()`: some ~/.anti-hall/agents/*.json heartbeat (its `ts`, else the file time) is fresh. A heartbeat the script cannot
// parse exactly counts by its file time.
function tgAgentsRunning(home, now) {
  var dir = home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('task_guard.agents_dir');
  var names = ah.fs.listDir(dir);
  if (names === null) return false;
  var fresh = ah.cfgNum('task_guard.agents_fresh_ms');
  for (var i = 0; i < names.length; i++) {
    var n = names[i], ext = ah.cfg('task_guard.agents_ext');
    if (n.length < ext.length || n.slice(-ext.length) !== ext) continue;
    var full = dir + '/' + n, ts = 0;
    var f = jx.read(full);
    if (f.text !== undefined) {
      var r = jx.parse(f.text);
      if (r.unsure) ah.unable('task-guard:heartbeat_unsure');
      else if (!r.invalid && jx.isObj(r.v) && typeof r.v[ah.cfg('task_guard.agents_ts_key')] === 'number') ts = r.v[ah.cfg('task_guard.agents_ts_key')];
    }
    if (ts === 0) { var m = ah.fs.mtimeMs(full); ts = m === null ? 0 : m; }
    if (ts !== 0 && !isNaN(ts) && now - ts < fresh) return true;
  }
  return false;
}



// `evaluate`: the per-task cover from this session's running agents, the parallel cap and the proven count (lib/69-tasks.js).
function tgEvaluate(actionable, tasks, open, running, now) { return tk.evaluate(actionable, tasks, open, running, now, true); }
function tgLabel(t) { return tk.label(t); }


function tgRenderList(ts) {
  var parts = [], max = Math.min(ts.length, ah.cfgNum('task_guard.list_max'));
  for (var i = 0; i < max; i++) {
    var t = ts[i], unknown = ah.cfg('task_guard.subject_unknown');
    var subj = tk.oneLine(t.content && t.content !== t.id ? t.content : unknown, ah.cfgNum('task_guard.subject_max'));
    if (!subj) subj = unknown;
    var openWord = ah.cfg('task_guard.status_open');
    var st = tk.oneLine(t.status ? t.status : openWord, ah.cfgNum('task_guard.status_max'));
    if (!st) st = openWord;
    parts.push(JSON.stringify(subj) + ' [' + JSON.stringify(st) + ']');
  }
  return parts.join(ah.cfg('task_guard.list_sep'));
}

function tgIds(ts) {
  var ids = ts.map(function (t) { return t.id ? t.id : t.content; });
  ids.sort();
  return ids.join(ah.cfg('task_guard.hash_sep'));
}

// {hash, blocks} of the loop-state file of the last block (or a legacy bare hash); a file over the read cap or one the script cannot
// parse exactly reads as no earlier block (counted).
function tgReadState(path) {
  var f = jx.read(path);
  if (f.big) { ah.unable('task-guard:state_big'); return { hash: '', blocks: 0 }; }
  if (f.text === undefined) return { hash: '', blocks: 0 };
  var raw = f.text.trim();
  if (!raw) return { hash: '', blocks: 0 };
  var r = jx.parse(raw);
  if (r.unsure) { ah.unable('task-guard:state_unsure'); return { hash: '', blocks: 0 }; }
  if (!r.invalid && r.v !== null && typeof r.v === 'object') {
    var h = r.v[ah.cfg('task_guard.state_hash_key')], b = r.v[ah.cfg('task_guard.state_blocks_key')];
    return Object.assign({}, r.v, { hash: typeof h === 'string' ? h : '', blocks: typeof b === 'number' && isFinite(b) ? b : 0 });
  }
  return { hash: raw, blocks: 0 };
}

function tgCodex(p) {
  if (p.tool_name === ah.cfg('task_guard.codex_patch_tool')) return true;
  return typeof p.turn_id === 'string' && p.turn_id !== '' && typeof p.model === 'string' && p.model !== '';
}

// ---- an OMC autonomous loop (hooks/omc-detect.js isOmcLoopActive): task-guard steps aside instead of deadlocking against it ----

function tgSmallJson(path, max) {
  var size = ah.fs.size(path);
  if (size === null || size > max) return { none: true };
  var f = jx.read(path);
  if (f.text === undefined) return { none: true };
  var r = jx.parse(f.text);
  if (r.unsure) return { unsure: true };
  return r.invalid ? { none: true } : { v: r.v };
}

// true / false; a settings file the script cannot parse exactly counts as absent (counted).
function tgOmcEnabled(home, cwd) {
  var files = [home + '/' + ah.cfg('task_guard.omc_claude_dir') + '/' + ah.cfg('task_guard.omc_settings_file')];
  if (cwd) ah.cfg('task_guard.omc_project_settings').forEach(function (f) { files.push(cwd + '/' + ah.cfg('task_guard.omc_claude_dir') + '/' + f); });
  for (var i = 0; i < files.length; i++) {
    var r = tgSmallJson(files[i], ah.cfgNum('task_guard.omc_settings_max_bytes'));
    if (r.unsure) { ah.unable('task-guard:omc_settings_unsure'); continue; }
    if (r.none) continue;
    var plugins = jx.field(r.v, ah.cfg('task_guard.omc_plugins_key'));
    if (plugins && plugins[ah.cfg('task_guard.omc_plugin_id')] === true) return true;
  }
  return false;
}

function tgOmcActive(home, cwd, sid, now) {
  if (ah.env.get(ah.cfg('task_guard.omc_disable_env')) === ah.cfg('task_guard.omc_disable_value')) return false;
  var skip = ah.env.get(ah.cfg('task_guard.omc_skip_env')) || '';
  if (skip.split(',').some(function (s) { return s.trim() === ah.cfg('task_guard.omc_skip_token'); })) return false;
  if (cwd && (cwd.charAt(0) !== '/' || cwd.split('/').some(function (s) { return s === '.' || s === '..'; }))) { ah.unable('task-guard:omc_relative_cwd'); cwd = null; } // Node resolves it against its own directory; only the home's files are read
  var enabled = tgOmcEnabled(home, cwd);
  if (!enabled) return false;
  var rel = ah.cfg('task_guard.omc_state_dir').join('/');
  var root = cwd && ah.fs.isDir(cwd + '/' + rel) ? cwd + '/' + rel : home + '/' + rel;
  var files = ah.cfg('task_guard.omc_state_files');
  for (var i = 0; i < files.length; i++) {
    var r = tgSmallJson(root + '/' + files[i], ah.cfgNum('task_guard.omc_state_max_bytes'));
    if (r.unsure) { ah.unable('task-guard:omc_state_unsure'); continue; }
    if (r.none || !jx.isObj(r.v) || r.v[ah.cfg('task_guard.omc_active_key')] !== true) continue;
    var found = false, keys = ah.cfg('task_guard.omc_ts_keys');
    for (var k = 0; k < keys.length && !found; k++) {
      var v = r.v[keys[k]], n = 0;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string') {
        n = jx.isoMs(v);
        if (n === undefined) { ah.unable('task-guard:omc_ts_form'); n = 0; } // a form only V8's date parser reads counts as no time
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

// ---- the per-prompt Stop budget (hooks/lib/stop-policy.js budgetSpent) ----

// The payload's prompt_id, else the uuid of the newest real user entry in the tail: a string or '' (none). A line the script cannot parse
// exactly is skipped (counted).
function tgPromptKey(p, transcript) {
  var pid = p[ah.cfg('task_guard.prompt_id_key')];
  if (typeof pid === 'string' && pid) return pid;
  var user = ah.cfg('task_guard.user_type');
  // only the lines that name a user entry are read below, so only those are fetched
  var lines = ah.fs.tailLines(transcript, ah.cfgNum('taskstate.tail_bytes'), false, ['"' + user + '"']);
  if (lines === null) return '';
  for (var i = lines.length - 1; i >= 0; i--) {
    var t = lines[i].trim();
    if (!t || t.indexOf('"' + user + '"') < 0) continue;
    var r = jx.parse(t);
    if (r.unsure) { ah.unable('task-guard:prompt_line_unsure'); continue; }
    if (r.invalid) continue;
    var e = r.v;
    if (!e || e.type !== user || e.isMeta === true || e.isSidechain === true) continue;
    if (!e.uuid || typeof e.uuid !== 'string') continue;
    var c = e.message ? e.message.content : undefined, real = false;
    if (typeof c === 'string') real = c.trim() !== '';
    else if (Array.isArray(c)) real = c.some(function (b) { return !!b && b.type !== ah.cfg('task_guard.tool_result_type'); });
    if (real) return e.uuid;
  }
  return '';
}

// {spent: true}, {rel, body} (the bucket file to write before the block) or {} (no budget applies). A bucket file over the read cap or
// one the script cannot parse exactly is neither counted against nor rewritten (its other buckets are other hooks' counts): the budget
// reads as spent, so the Stop fails open as it does for a budget that cannot be persisted.
function tgBudget(guard, p, transcript, safeSession, now) {
  if (guard.status !== 'ok') return {};
  var v = ah.settings.num('task_guard.budget_setting'), budget = isFinite(v) && v > 0 ? Math.floor(v) : 0;
  if (budget === 0) return {};
  var key = tgPromptKey(p, transcript);
  if (key === '') return {};
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('task_guard.stop_policy_dir').join('/') + '/' + safeSession + ah.cfg('task_guard.stop_policy_ext');
  var buckets = {}, f = jx.read(guard.home + '/' + rel);
  if (f.big) { ah.unable('task-guard:budget_big'); return { spent: true }; }
  if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) { ah.unable('task-guard:budget_unsure'); return { spent: true }; }
    if (!r.invalid && jx.isObj(r.v)) buckets = r.v;
  }
  var bk = safeSession + '|' + ah.cfg('task_guard.guard_name') + '|' + ah.cfg('task_guard.budget_bucket');
  var kk = ah.cfg('task_guard.budget_key_field'), kc = ah.cfg('task_guard.budget_count_field'), ka = ah.cfg('task_guard.budget_at_field');
  var b = buckets[bk], n = b !== null && typeof b === 'object' && b[kk] === key && typeof b[kc] === 'number' && isFinite(b[kc]) ? b[kc] : 0;
  if (n >= budget) return { spent: true };
  var nb = {}; nb[kk] = key; nb[kc] = n + 1; nb[ka] = now;
  buckets[bk] = nb;
  return { rel: rel, body: JSON.stringify(buckets) };
}

// The idle-neglect metrics file after `recordIdleNeglect`: {rel, body}. A file over the read cap, one the script cannot parse exactly
// or an array starts the counters afresh (counted; the write repairs it).
function tgMetrics(guard) {
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('task_guard.metrics_file');
  var m = {}, f = jx.read(guard.home + '/' + rel);
  if (f.big) ah.unable('task-guard:metrics_big');
  else if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) ah.unable('task-guard:metrics_unsure');
    else if (!r.invalid && r.v !== null && typeof r.v === 'object') { if (Array.isArray(r.v)) ah.unable('task-guard:metrics_array'); else m = r.v; }
  }
  ah.cfg('task_guard.metrics_counters').forEach(function (k) { if (!(typeof m[k] === 'number' && isFinite(m[k]) && m[k] >= 0)) m[k] = 0; });
  var pk = ah.cfg('task_guard.metrics_pending_key');
  if (m[pk] === null || typeof m[pk] !== 'object') m[pk] = {};
  var key = ah.cfg('task_guard.metrics_idle_key');
  m[key] = (typeof m[key] === 'number' && isFinite(m[key]) ? m[key] : 0) + 1;
  return { rel: rel, body: JSON.stringify(m) };
}

function tgBlockReason(p, idle, demand, nudge, home) {
  var upd = ah.cfg(tgCodex(p) ? 'task_guard.update_codex' : 'task_guard.update_claude'), guard = ah.cfg('task_guard.guard_name');
  if (idle) {
    var max = ah.cfgNum('task_guard.dispatch_list_max'), labels = [];
    for (var i = 0; i < Math.min(max, demand.dispatch.length); i++) labels.push(tgLabel(demand.dispatch[i]));
    var n = demand.dispatch.length;
    var more = n > max ? text.render(ah.cfg('task_guard.more'), { n: n - max }) : '';
    var cap = demand.cap !== null && demand.cap !== 0 ? String(demand.cap) : ah.cfg('task_guard.cap_formula');
    var what = text.render(ah.cfg('task_guard.idle_what'), { n: n, list: labels.join(ah.cfg('task_guard.label_sep')), more: more });
    var instead = text.render(ah.cfg('task_guard.idle_instead'), { cap: cap, upd: upd, devswarm: tk.anyLiveChildren() ? text.render(ah.cfg('task_guard.devswarm_hint'), { upd: upd }) : '' });
    return text.message('block', guard, { what: what, why: ah.cfg('task_guard.idle_why'), instead: instead, allowed: ah.cfg('task_guard.idle_allowed') });
  }
  var lmax = ah.cfgNum('task_guard.list_max'), cnt = nudge.length;
  var list = tgRenderList(nudge);
  var gmore = cnt > lmax ? text.render(ah.cfg('task_guard.more'), { n: cnt - lmax }) : '';
  return text.message('block', guard, {
    what: text.render(ah.cfg('task_guard.generic_what'), { list: list, more: gmore }), why: ah.cfg('task_guard.generic_why'),
    instead: text.render(ah.cfg('task_guard.generic_instead'), { upd: upd }), allowed: text.render(ah.cfg('task_guard.generic_allowed'), { upd: upd }),
  });
}

// `note` (the advisories and the unknown-state note) goes to stderr: stdout stays empty or ONE JSON object, else the host reads a
// block printed after a note as plain text (the block is lost) and the dispatcher cannot merge it with another Stop hook's JSON.
function tgExact(note, json) {
  json = json || '';
  return note === '' && json === '' ? 'allow' : { exact: { code: 0, out: json, err: note } };
}

function tgQuiet(out, tasks, home, sessionId) {
  var plan = tk.unknownNote(tasks, home, sessionId, ah.cfg('task_guard.unknown_tag'));
  var note = plan.write();
  if (note) out += text.render(ah.cfg('task_guard.note_line'), { note: note });
  return tgExact(out);
}

function decide(p) {
  if (ah.env.get(ah.cfg('task_guard.judge_child_env')) === '1') return 'allow';
  if (!ah.settings.bool('task_guard.setting') || ah.settings.skipped(ah.cfg('task_guard.guard_name'))) return 'allow';
  if (p === null || typeof p !== 'object') p = {};
  var transcript = p.transcript_path;
  if (!transcript || typeof transcript !== 'string') return 'allow';
  // HOME unset: Node's os.homedir() is the passwd home, and state, settings and skips live under it (adopted for the call, as the other guards do)
  if (ah.env.get(ah.cfg('env.home')) === null) {
    var nh = hookProc.nodeHome();
    if (nh.home === undefined) { ah.unable('task-guard:no_home', 'abandoned'); return 'allow'; }
    if (hookProc.testGuarded(nh.home)) { ah.unable('task-guard:home_test_guard', 'abandoned'); return 'allow'; } // the real home under a test marker is never touched
    ah.useHome(nh.home);
  }
  var home = ah.home();
  if (!home) { ah.unable('task-guard:no_home', 'abandoned'); return 'allow'; } // no home: no state to read or write, and nothing to guard it with
  var given = p.session_id ? String(p.session_id) : '';
  var sessionId = given === '' ? ah.sha1(transcript).slice(0, ah.cfgNum('task_guard.session_hash_len')) : given;
  var safeSession = tk.safeKey(sessionId);
  var stateRel = ah.cfg('paths.base_dir') + '/' + ah.cfg('task_guard.state_prefix') + safeSession;
  var tasks = tk.tasks(transcript);
  // the prune-the-list advisory is NOT here: a Stop hook's stderr at exit 0 never reaches the model (KB-claude-code-hooks.md, Stop row), so
  // it is delivered by task-tracker on UserPromptSubmit (additionalContext) instead
  var out = '';
  var open = tasks.filter(tk.isOpen);
  if (open.length === 0) {
    if (!tasks.unsure) ah.state.remove(stateRel);
    return tgQuiet(out, tasks, home, sessionId);
  }

  var now = ah.clock.now();
  var agMemo;
  function tgAgents() { if (agMemo === undefined) agMemo = ah.transcript.agents(transcript); return agMemo; }
  var actionable = tgActionable(open, tasks);
  var haveAgents = tgAgentsRunning(home, now);
  var demand = { fire: false, proven: false, unknown: false, dispatch: [], cap: null };
  if (actionable.length > 0) {
    if (ah.settings.bool('task_guard.dispatch_demand_setting')) {
      var ag = tgAgents();
      if (ag !== null && ag.unsure) { ah.unable('task-guard:agents_unsure'); ag = null; } // an agent list read inexactly is read as unreadable
      demand = tgEvaluate(actionable, tasks, open, ag === null ? null : ag.rows, now);
      if (ah.settings.bool('task_guard.proven_only_setting') && !demand.unknown) demand.fire = demand.proven;
    } else {
      demand = { fire: !haveAgents, proven: false, unknown: false, dispatch: actionable, cap: null };
    }
  }
  var idle = demand.fire;
  // the running agents are read once, and only when a dispatch check or an owned open task needs them
  var rows = null;
  if (open.some(function (t) { return t.owner && !tgCoordinator(t.owner); })) {
    var own = tgAgents();
    if (own !== null && own.unsure) { ah.unable('task-guard:owner_agents_unsure'); own = null; }
    var tracked = ah.transcript.trackedAgents(p);
    rows = (own === null ? [] : own.rows).map(function (r) {
      r.live = ah.transcript.trackedLiveness(r.id, tracked);
      return r;
    });
    tracked.forEach(function (r) {
      rows.push({ id: r.id, description: r.name, live: ah.transcript.trackedLiveness(r.id, tracked) });
    });
  }
  var unresolved = ah.cfg('task_guard.advise_unresolved_owners') ? open.filter(function (t) { return tgUnresolvedOwner(t, rows); }) : [];
  if (unresolved.length > 0) out += text.render(ah.cfg('task_guard.unresolved_owner_advisory'), { list: tgRenderList(unresolved) });
  var nudge = tgUnblocked(open, tasks, rows);
  if (!idle && nudge.length === 0) return tgQuiet(out, tasks, home, sessionId);

  var sep = ah.cfg('task_guard.hash_sep');
  var hash = idle ? ah.sha1(ah.cfg('task_guard.idle_hash_tags').join(sep) + sep + tgIds(demand.dispatch)) : ah.sha1(tgIds(nudge));
  var prior = tgReadState(home + '/' + stateRel);
  var cap = blockCap.open(prior, transcript, 'task_guard.cap_scope', home, stateRel);
  prior = cap.state;
  if (hash === prior.hash || prior.blocks >= ah.cfgNum('task_guard.max_blocks')) return tgQuiet(out, tasks, home, sessionId);
  var cwd = typeof p.cwd === 'string' ? p.cwd : null;
  var sid = p.session_id ? String(p.session_id) : null;
  var omc = tgOmcActive(home, cwd, sid || null, now);
  if (omc) return tgExact(out + (adv.gate(ah.cfg('advisory.kind_task_guard_omc'), sessionId) ? ah.cfg('task_guard.omc_line') : ''));
  if (!idle && haveAgents) return tgExact(out + (adv.gate(ah.cfg('advisory.kind_task_guard_agents'), sessionId) ? ah.cfg('task_guard.agents_line') : ''));

  // from here the Stop blocks unless the budget is spent; everything that can defer is settled before the first write
  var guard = ah.homeGuard();
  if (guard.status === 'unknown') ah.unable('task-guard:home_unknown'); // no usable home: no budget or metrics state, the block itself stands
  var budget = tgBudget(guard, p, transcript, safeSession, now);
  var reason = tgBlockReason(p, idle, demand, nudge, home);
  var metrics = null;
  if (guard.status === 'ok' && idle) metrics = tgMetrics(guard);
  var plan = tk.unknownNote(tasks, home, sessionId, ah.cfg('task_guard.unknown_tag'));
  if (budget.spent) return tgExact(out);
  if (!cap.backup()) return tgExact(out);
  if (budget.rel !== undefined && !ah.state.op(guard.home, 'after_reply', budget.rel, budget.body)) return tgExact(out);
  var state = cap.blocked(); state[ah.cfg('task_guard.state_hash_key')] = hash; state[ah.cfg('task_guard.state_blocks_key')] = prior.blocks + 1;
  if (!ah.state.op(home, 'after_reply', stateRel, JSON.stringify(state))) return tgExact(out);
  if (metrics !== null) { try { ah.state.writeAtomic(metrics.rel, metrics.body); } catch (e) { /* fail-open, as Node's writeMetrics */ } }
  var note = plan.write();
  if (note) reason += '\n' + note;
  return tgExact(out, text.render(ah.cfg('task_guard.block_json'), { reason: JSON.stringify(reason) }));
}

// check = "task-tracker" (UserPromptSubmit; the Claude and the Codex entry). On every prompt the hook keeps the task-list discipline in
// front of the model without repeating it every turn: the full directive on the first prompt of a session, again when its window
// elapses or the transcript has grown by the growth threshold, a short reminder in between that the injection keepalive rations, plus
// one line about the open tasks. It also asks Jev (integration `newRequest`) to label the prompt, and scores the previous turn's
// dispatch demand, and names the tasks nobody is on in the per-turn DISPATCH NOW line (annotated with the cached dispatchTier verdict of
// Jev). First everything is read and decided, and every point at which this script cannot answer exactly is counted and decided
// natively (a payload, a state file or a transcript timestamp in a shape only V8 reads); only then the effects are performed, in Node's order: the Jev ask, the
// directive's state file, the demand score, the outcomes of earlier recommendations, the unknown-state note, the tier requests and
// the recommendations shown, the dedupe records and the demand record. Nothing is handed back to Node: a payload, state file or
// transcript timestamp in a shape only V8 reads exactly is counted (native_unable at `task-tracker.*`) and decided natively. The two
// state tables (the open-tasks line and the DISPATCH NOW line) reach the model only when their content changed (advisory.toml,
// lib/79-advisory.js), with a per-session cap per kind. The transcript scans that would not fit the script's time
// (the delivery search of the dedupe store, the spawn and dispatch searches, the running-agent proof) are host primitives. Mirrors
// hooks/task-tracker.js `main`, `pickMessage` and `freshnessNote`, hooks/lib/dispatch-demand.js and hooks/lib/dispatch-tier.js. Keys, texts, limits and switches:
// task_tracker.toml (task_tracker.*), task_guards.toml (taskstate.*, dispatch_tier.*).
'use strict';

function ttT(k) { return ah.cfg('task_tracker.' + k); }
function ttN(k) { return ah.cfgNum('task_tracker.' + k); }

function ttShort() { return text.message('tip', ttT('guard_name'), { what: ttT('what_short') }); }

// The full directive: with the non-blocking clause at the full protocol level, without it at the compact one; the Codex text names a
// plan list where the Claude text names the task tool.
function ttFull(codex) {
  var fullLevel = ah.settings.enum('orch_state.protocol_setting') === ttT('full_level');
  var m = text.message('tip', ttT('guard_name'), { what: ttT('what_full'), instead: ttT('instead_head') + (fullLevel ? ttT('non_blocking') : '') + ttT('instead_tail') });
  return codex ? m.replace(ttT('codex_from'), ttT('codex_to')) : m;
}

function ttFinite(v) { return typeof v === 'number' && isFinite(v); }

// `pickMessage`: read the state of this session and choose; nothing is written here. {full: bool, size}.
function ttPick(home, rel, tp, now) {
  var size = tp !== null ? ah.fs.size(tp) : null;
  if (size === null) size = -1;
  var lastFull = 0, lastSize = -1;
  var f = jx.read(home + '/' + rel);
  if (f.big) ah.unable('task-tracker:pick_state_big');
  else if (f.text !== undefined) {
    var t = f.text.trim();
    if (t !== '') {
      var r = jx.parse(t);
      if (r.unsure) ah.unable('task-tracker:pick_state_unsure');
      else if (!r.invalid && jx.isObj(r.v)) {
        if (ttFinite(r.v.lastFull) && r.v.lastFull <= now + ttN('future_tolerance_ms')) lastFull = r.v.lastFull;
        if (ttFinite(r.v.lastFullSize) && r.v.lastFullSize >= 0) lastSize = r.v.lastFullSize;
      }
    }
  }
  var fresh = now - lastFull < ttN('window_ms');
  // a transcript that grows by the threshold on every turn would re-send the full directive each turn: growth re-sends it only once the
  // minimum gap since the last full directive has passed (the window still re-sends it on expiry)
  var grew = size >= 0 && lastSize >= 0 && size - lastSize >= ttN('growth_bytes') && now - lastFull >= ttN('growth_min_gap_ms');
  return { full: !(fresh && !grew), size: size, lastFull: lastFull, lastSize: lastSize };
}

// The Jev ask for a prompt (`askDetached` of integration `newRequest`): the spec (a cut through a surrogate pair drops the half pair).
function ttJevSpec(p, prompt, sessionRaw) {
  var limit = ttN('jev_state_limit'), state = prompt;
  if (prompt.length > limit) {
    var last = prompt.charCodeAt(limit - 1);
    if (last >= 0xd800 && last <= 0xdbff) ah.unable('task-tracker:jev_prompt_pair_cut');
    state = jx.sliceUnits(prompt, limit);
  }
  var labels = ttT('jev_labels'), texts = ttT('jev_label_texts'), criteria = [];
  for (var i = 0; i < labels.length; i++) criteria.push([labels[i], texts[i]]);
  var spec = { id: ttT('jev_id'), question: { type: 'choice', instructions: ttT('jev_instructions'), criteria: criteria }, state: state, trust: 'advisory', baseline: null };
  if (sessionRaw !== '') spec.sessionId = sessionRaw;
  if (typeof p.transcript_path === 'string' && p.transcript_path !== '') spec.turnRefFrom = p.transcript_path;
  if (typeof p.cwd === 'string') spec.projectFrom = p.cwd;
  return spec;
}

// `isOwnerBlocked(t)`: a task waiting on the owner (the `blockedOn` marker or an `OWNER:` subject) is not work the agent can close.
function ttOwnerBlocked(t) {
  if (!ah.settings.bool('dispatch_tier.owner_marker_setting')) return false;
  if (ah.cfg('dispatch_tier.owner_values').indexOf(tk.blockedOnText(t)) >= 0) return true;
  return new RegExp(ah.cfg('dispatch_tier.owner_subject_re'), 'i').test(t.content);
}

// A task the demand line never names: any `blockedOn` value (the documented key, whoever it names) or a status that says it waits.
function ttHeld(t) {
  if (!ah.settings.bool('task_tracker.held_setting')) return false;
  if (tk.blockedOnText(t) !== '') return true;
  return new RegExp(ttT('held_status_re'), 'i').test(String(t.status || ''));
}

// Words of a task that name files (a path or a file name), lowercased.
function ttFileTokens(t) {
  var src = String(t.content || '') + ' ' + String(t.description || ''), out = [], m, re = new RegExp(ttT('file_token_re'), 'g');
  while ((m = re.exec(src)) !== null) { out.push(m[0].toLowerCase()); if (m[0].length === 0) re.lastIndex++; }
  return out;
}

// The text of the running agents (description and spawn prompt), lowercased, for the file-conflict test.
function ttAgentTexts(tp, rows) {
  var ids = {}, texts = [];
  rows.forEach(function (r) { ids[r.id] = true; texts.push(String(r.description || '').toLowerCase()); });
  var w = ah.transcript.agentsWindow(tp);
  if (w !== null && !w.unsure && w.rows) w.rows.forEach(function (a) {
    if (ids[a.id] && a.spawnInput && typeof a.spawnInput.prompt === 'string') texts.push(a.spawnInput.prompt.toLowerCase());
  });
  return texts;
}

// `classifyOpen(open, taskMap)`: the pending, unowned (or coordinator-owned) tasks no open blocker holds back.
function ttActionable(open, tasks) {
  var done = ttT('done_statuses'), known = new Set(), notDone = new Set();
  tasks.forEach(function (t) { known.add(t.id); if (done.indexOf(tk.statusLc(t)) < 0) notDone.add(t.id); });
  var mainOwner = new RegExp(ttT('main_owner_re'), 'i'), out = [];
  open.forEach(function (t) {
    if (tk.statusLc(t) !== ttT('pending_status') || t.blockUnknown) return;
    if (t.owner && !mainOwner.test(t.owner)) return;
    if (ttOwnerBlocked(t)) return;
    if (ttHeld(t)) return;
    if ((t.blockedBy || []).some(function (b) { return notDone.has(b) || !known.has(b); })) return;
    out.push(t);
  });
  return out;
}

// A fingerprint of the open-task list (id, status, owner, blockedOn), so the short reminder can tell a changed list from an unchanged one.
function ttListHash(tasks) {
  return ah.sha1(tasks.filter(tk.isOpen).map(function (t) { return [t.id, tk.statusLc(t), t.owner || '', tk.blockedOnText(t)].join('|'); }).sort().join(';')).slice(0, 16);
}

// What the previous prompt left in the state file: {hash, quiet}.
function ttChangeState(home, rel) {
  var out = { hash: '', quiet: 0 }, f = jx.read(home + '/' + rel);
  if (f.text === undefined || f.big) return out;
  var r = jx.parse(f.text.trim());
  if (r.unsure || r.invalid || !jx.isObj(r.v)) return out;
  if (typeof r.v.openHash === 'string') out.hash = r.v.openHash;
  if (ttFinite(r.v.quiet) && r.v.quiet >= 0) out.quiet = r.v.quiet;
  return out;
}

// `oneLine(s, max)`; a cut through a surrogate pair drops the half pair.
function ttOneLine(s, max) {
  var o = s.replace(new RegExp(ttT('control_re'), 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) {
    var last = o.charCodeAt(max - 1);
    if (last >= 0xd800 && last <= 0xdbff) ah.unable('task-tracker:oneline_pair_cut');
    o = jx.sliceUnits(o, max).trimEnd() + ttT('ellipsis');
  }
  return o;
}

// ---- the metrics file (hooks/lib/dispatch-demand.js readMetrics/recordDemand, hooks/lib/dispatch-tier.js metricsTier) ----
// All of it runs in the effects block: the file is read again there, after the writes that came before it, as Node reads it.
function ttMetricsRel() { return ah.cfg('paths.base_dir') + '/' + ttT('metrics_file'); }
function ttMetricsLoad(home) {
  var f = jx.read(home + '/' + ttMetricsRel()), m = {};
  if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) ah.unable('task-tracker:metrics_unsure');
    else if (!r.invalid && r.v !== null && typeof r.v === 'object' && !Array.isArray(r.v)) m = r.v;
  }
  return m;
}
function ttMetricsSave(m) { ah.state.writeAtomic(ttMetricsRel(), JSON.stringify(m)); }
function ttWord(k) { return ah.cfg('task_tracker.tier_words')[k]; }
// `metricsTier(home, fn)`: `fn` bumps counters in the `tier` object of the metrics file.
function ttMetricsTier(home, fn) {
  var mm = ttMetricsLoad(home), key = ttWord('metrics_key');
  if (!mm[key] || typeof mm[key] !== 'object') mm[key] = {};
  fn(mm[key]);
  ttMetricsSave(mm);
}
function ttBump(t, k) { t[k] = (ttFinite(t[k]) ? t[k] : 0) + 1; }
// `recordDemand`: one more demand shown, to be scored at the next prompt.
function ttRecordDemand(home, sessionRaw, count) {
  var m = ttMetricsLoad(home);
  ttT('metrics_counters').forEach(function (k) { if (!ttFinite(m[k]) || m[k] < 0) m[k] = 0; });
  var pk = ttT('metrics_pending');
  if (!m[pk] || typeof m[pk] !== 'object') m[pk] = {};
  m[ttT('metrics_shown')]++;
  m[pk][ttSessionKey(sessionRaw)] = { ts: ah.clock.now(), n: count || 0 };
  ttMetricsSave(m);
}

// ---- the dispatch tier (hooks/lib/dispatch-tier.js): outcome tracking, the annotation and its request ----
function ttTierRel() { return ah.cfg('paths.base_dir') + '/' + ah.cfg('dispatch_tier.state_file'); }

// `dispatchEvidence(lines, id)`: the spawns that name `#<id>` in the end of the transcript: {agents, workflow, workspace}. An id that is
// not a plain id (Node reads it as a pattern) and a tail the engine cannot read exactly show no spawn (counted).
function ttEvidence(tp, id) {
  var out = { agents: 0, workflow: 0, workspace: 0 };
  if (!new RegExp(ttT('tier_id_ok_re')).test(id)) { ah.unable('task-tracker:tier_id_pattern'); return out; }
  var g = ah.transcript.grep(tp, ah.cfgNum('taskstate.tail_bytes'), [ttT('tier_use_marker'), '#' + id]);
  if (g === null) return out;
  if (g.unsure) { ah.unable('task-tracker:tier_evidence_unsure'); return out; }
  var re = new RegExp('#' + id + ttT('tier_id_after')), shell = new RegExp(ttT('tier_spawn_shell_re'));
  var agentTools = ttT('tier_spawn_agent_tools'), wf = ttT('tier_spawn_workflow_tool'), sh = ttT('tier_spawn_shell_tool');
  g.lines.forEach(function (raw) {
    var e;
    try { e = JSON.parse(raw); } catch (x) { return; }
    var c = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    c.forEach(function (b) {
      if (!b || b.type !== 'tool_use') return;
      var inp = b.input || {};
      if (agentTools.indexOf(b.name) >= 0 && re.test(String(inp.description || ''))) out.agents++;
      else if (b.name === wf && re.test(JSON.stringify(inp))) out.workflow++;
      else if (b.name === sh && shell.test(String(inp.command || '')) && re.test(String(inp.command || ''))) out.workspace++;
    });
  });
  return out;
}

// `trackOutcomes`: label each tracked recommendation of this session once with the actual dispatch and once with its result.
// {apply: function | null}. Nothing is written here; `apply` writes the state, the counters and the outcome records. A session record
// of another shape is skipped (counted).
function ttTrack(home, sessionRaw, tp, tasks) {
  var st = tk.tierRead(home + '/' + ttTierRel(), true);
  var sess = st.sessions[sessionRaw === '' ? ttT('unknown_session') : sessionRaw];
  if (!sess || !sess.tasks) return { apply: null };
  if (!jx.isObj(sess.tasks)) { ah.unable('task-tracker:tier_tasks_shape'); return { apply: null }; }
  var w = ttWord, counters = [], outcomes = [], dirty = false, done = new RegExp(ttT('tier_done_re'), 'i'), jevId = ah.cfg('dispatch_tier.jev_id');
  var ids = Object.keys(sess.tasks);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], rec = sess.tasks[id];
    if (!jx.isObj(rec)) { ah.unable('task-tracker:tier_record_shape'); continue; }
    if (rec.dispatch && rec.result) continue;
    var ev = ttEvidence(tp, id);
    var actual = ev.workspace ? ttT('tier_workspace') : ev.workflow ? ttT('tier_workflow') : ev.agents ? ttT('tier_default') : null;
    if (!rec.dispatch && actual) {
      rec.dispatch = actual;
      var how = actual === rec.tier ? w('followed') : w('overridden');
      counters.push(how);
      outcomes.push({ h: rec.h, outcome: w('dispatched') + actual });
      outcomes.push({ h: rec.h, outcome: how });
      dirty = true;
    }
    var task = null;
    for (var k = 0; k < tasks.length; k++) if (tasks[k].id === id) { task = tasks[k]; break; }
    var finished = task && done.test(String(task.status || ''));
    if (rec.dispatch && !rec.result) {
      var fanout = ev.agents >= ttN('tier_min_workflow_agents');
      if (rec.tier === ttT('tier_default') && rec.dispatch === ttT('tier_default') && (finished || ev.agents > 1 || ev.workflow || ev.workspace)) {
        rec.result = (ev.agents <= 1 && !ev.workflow && !ev.workspace) ? w('one_lane') : w('escalated');
        counters.push(rec.result === w('one_lane') ? w('one_lane_counter') : w('escalated_counter'));
      } else if (rec.tier === ttT('tier_workflow') && (ev.workflow || fanout || finished)) {
        rec.result = (ev.workflow || fanout) ? w('fanned_out') : w('no_fanout');
        counters.push(rec.result === w('fanned_out') ? w('fanned_out_counter') : w('no_fanout_counter'));
      } else if (rec.tier === ttT('tier_workspace') || rec.dispatch !== rec.tier) {
        rec.result = w('not_applicable');
      }
      if (rec.result && rec.result !== w('not_applicable')) outcomes.push({ h: rec.h, outcome: rec.result });
      if (rec.result) dirty = true;
    }
  }
  if (!dirty) return { apply: null };
  return {
    apply: function () {
      sess.t = ah.clock.now();
      tk.tierWrite(ttTierRel(), st, ah.clock.now());
      if (counters.length) ttMetricsTier(home, function (t) { counters.forEach(function (c) { ttBump(t, c); }); });
      outcomes.forEach(function (o) { ah.jev.recordOutcome(jevId, o.h, o.outcome, null, null); });
    },
  };
}

function ttTierText(t) {
  var subj = String(t.content || t.subject || ''), desc = String(t.description || '');
  return (desc && desc !== subj ? subj + ttT('tier_text_joiner') + desc : subj).slice(0, ah.cfgNum('dispatch_tier.text_cap'));
}

// `request`: ask Jev (detached) about a task text with no cached verdict, once while the first ask may be in flight.
function ttTierRequest(home, text, h, sessionRaw, tp) {
  var rel = ttTierRel(), st = tk.tierRead(home + '/' + rel), now = ah.clock.now(), at = st.requested[h];
  if (ttFinite(at) && now - at < ah.cfgNum('dispatch_tier.request_ttl_ms')) return;
  st.requested[h] = now;
  tk.tierWrite(rel, st, now);
  var tiers = [['workspace', ah.cfg('dispatch_tier.tier_workspace')], ['workflow', ah.cfg('dispatch_tier.tier_workflow')], ['subagent', ah.cfg('dispatch_tier.tier_subagent')]];
  var spec = { id: ah.cfg('dispatch_tier.jev_id'), question: { type: 'choice', instructions: ah.cfg('dispatch_tier.question_instructions'), criteria: tiers }, state: text, cacheKey: text, trust: 'advisory', baseline: null, turnRefFrom: tp };
  if (sessionRaw !== '') spec.sessionId = sessionRaw;
  ah.jev.ask(spec);
}

// `remember`: the first sighting of a (task id, text hash) recommendation in this session: count the verdict, track its outcome.
function ttTierRemember(home, sessionRaw, recs, mode) {
  var rel = ttTierRel(), st = tk.tierRead(home + '/' + rel), sid = String(sessionRaw || ttT('unknown_session'));
  var sess = st.sessions[sid] || (st.sessions[sid] = { t: 0, tasks: {} });
  sess.t = ah.clock.now();
  var fresh = [];
  recs.forEach(function (r) {
    var cur = sess.tasks[r.id];
    if (cur && cur.h === r.h) return;
    sess.tasks[r.id] = { h: r.h, tier: r.tier, raw: r.raw, conf: r.conf, mode: mode, repoOverride: !!r.repoOverride, lowConf: !!r.lowConf };
    fresh.push(r);
  });
  tk.tierWrite(rel, st, ah.clock.now());
  if (!fresh.length) return;
  ttMetricsTier(home, function (t) { fresh.forEach(function (r) { ttBump(t, ttWord('verdict') + r.tier); }); });
  var jevId = ah.cfg('dispatch_tier.jev_id');
  fresh.forEach(function (r) {
    if (r.repoOverride) ah.jev.recordOutcome(jevId, r.h, ttWord('repo_override'), null, null);
    else if (r.lowConf) ah.jev.recordOutcome(jevId, r.h, ttWord('low_conf'), null, null);
  });
}

// The annotator for the tasks the demand line names: {notes: [string per task], footer, run: effects}. Reading only; `run`
// performs the requests for the tasks without a cached verdict and then records the recommendations that were shown or logged.
function ttAnnotate(home, p, tp, sessionRaw, shown) {
  var jevId = ah.cfg('dispatch_tier.jev_id'), mode = ah.jev.mode(jevId);
  var out = { notes: [], footer: '', run: function () {} };
  if (mode === 'off') { shown.forEach(function () { out.notes.push(''); }); return out; }
  var st = tk.tierRead(home + '/' + ttTierRel());
  var kindNote = ah.cfg('advisory.kind_task_tier_note');
  var names = ttT('tier_names'), floor = Number(ttT('tier_conf_floor')), recs = [], requests = [], count = 0;
  for (var i = 0; i < shown.length; i++) {
    var t = shown[i], ttext = ttTierText(t);
    out.notes.push('');
    if (ttext === '') continue;
    if (jx.loneSurrogate(ttext)) { ah.unable('task-tracker:tier_lone_surrogate'); ttext = ahWf(ttext); }
    var h = ah.contentHash([jevId, ah.cfg('jev.question_version'), ttext]);
    var e = ah.jev.cachePeek(h);
    adv.metric(kindNote, 'flagged');
    if (e !== null && e.unsure) { ah.unable('task-tracker:tier_cache_unsure'); adv.metric(kindNote, 'jev_error'); e = null; } // an unreadable cache entry: ask again (the request marker bounds repeats)
    if (e === null) { requests.push({ text: ttext, h: h }); continue; }
    if (names.indexOf(e.answer) < 0) { adv.metric(kindNote, 'suppressed'); continue; } // a cached entry that names no tier: no annotation, and no new question
    adv.metric(kindNote, 'confirmed');
    var tier = e.answer, override = false;
    if (tier === ttT('tier_workspace')) {
      var cwd = p.cwd, nw = false;
      if (!cwd || typeof cwd !== 'string' || cwd.charAt(0) !== '/') ah.unable('task-tracker:tier_relative_cwd'); // Node resolves it against its own directory; no repo override here
      else {
        nw = vf.noWorkspaceRepo(ah.path.resolveAbs(cwd));
        if (nw === null) { ah.unable('task-tracker:tier_repo_unclassified'); nw = false; }
      }
      if (nw) { tier = ttT('tier_default'); override = true; }
    }
    var conf = e.confidence;
    var low = tier !== ttT('tier_default') && conf !== null && conf < floor;
    if (low) tier = ttT('tier_default');
    recs.push({ id: String(t.id), h: h, tier: tier, raw: e.answer, conf: conf, repoOverride: override, lowConf: low });
    if (mode !== 'on') adv.metric(kindNote, 'suppressed'); // shadow mode: logged, never shown
    if (mode === 'on') {
      count++;
      adv.metric(kindNote, 'injected');
      out.notes[i] = ttT('tier_arrow') + tier + (conf !== null ? text.render(ttT('tier_conf'), { conf: (Math.round(conf * 100) / 100).toFixed(2) }) : '');
    }
  }
  out.footer = count > 0 ? ttT('tier_footer') : '';
  out.run = function () {
    requests.forEach(function (r) { adv.metric(kindNote, 'asked'); ttTierRequest(home, r.text, r.h, sessionRaw, tp); });
    if (recs.length) ttTierRemember(home, sessionRaw, recs, mode);
  };
  return out;
}

// The note for this prompt: null (no transcript to read) or {tasks, demand, openLine, plan}. `plan` holds the effects the note brings.
function ttFresh(home, tp, sessionRaw, p) {
  if (tp === null) return null;
  var size = ah.fs.size(tp);
  if (!size) return null;
  var r = ah.transcript.tasks(tp, 'state', ah.cfgNum('taskstate.tail_bytes'));
  if (r.unsure) { ah.unable('task-tracker:tasks_unsure'); return null; } // a tail the engine cannot read exactly is read as no tasks
  if (r.unreadable) return null;
  var tasks = r.tasks;
  var plan = { track: null, annotate: null, demandShown: 0 };
  var tr = ttTrack(home, sessionRaw, tp, tasks);
  plan.track = tr.apply;
  var open = tasks.filter(tk.isOpen);
  if (open.length === 0) return { tasks: tasks, demand: '', openLine: '', plan: plan };
  // the per-turn DISPATCH NOW line: it counts running agents, asks Jev for a tier and records a demand
  var demand = '';
  if (ah.settings.bool('task_tracker.dd_setting')) {
    var actionable = ttActionable(open, tasks);
    var stopped = ah.settings.bool('task_tracker.stop_setting') && sd.spawnStop(p) !== null; // the weekly-usage spawn stop: nothing can be dispatched
    if (actionable.length >= 1 && !stopped) {
      var proof = ah.transcript.countProof(tp);
      if (proof.unsure) { ah.unable('task-tracker:count_proof_unsure'); proof = { rows: null, seen: [], windowBytes: 0 }; } // the running-agent count cannot be trusted
      if (proof.rows !== null && proof.rows.length && ah.settings.bool('task_tracker.conflict_setting')) {
        var texts = ttAgentTexts(tp, proof.rows);
        actionable = actionable.filter(function (t) { // a task on a file a running agent already works on is not dispatched in parallel
          return !ttFileTokens(t).some(function (f) { return texts.some(function (x) { return x.indexOf(f) >= 0; }); });
        });
      }
    }
    if (actionable.length >= 1 && !stopped) {
      var res = tk.evaluate(actionable, tasks, open, proof.rows, 0, false);
      if (res.fire) {
        var max = ttN('demand_show_max'), shown = res.dispatch.slice(0, max);
        var ann = ttAnnotate(home, p, tp, sessionRaw, shown);
        var parts = [];
        for (var d = 0; d < shown.length; d++) {
          var label = tk.label(shown[d]);
          parts.push(ann.notes[d] ? label + ttT('annotation_joiner') + ann.notes[d] : label);
        }
        var more = res.dispatch.length > max ? text.render(ttT('demand_more'), { n: res.dispatch.length - max }) : '';
        demand = text.render(ttT('demand_line'), { running: proof.rows.length, cap: res.cap, shown: parts.join(ttT('demand_joiner')), more: more });
        if (ann.footer) demand += ttT('footer_joiner') + ann.footer;
        plan.annotate = ann;
        plan.demandShown = res.dispatch.length;
      } else if (res.unknown) {
        var seen = proof.seen, bytes = proof.windowBytes, mb = bytes ? Math.round(bytes / ttN('bytes_per_mb')) : 0;
        var ids = seen.slice(0, ttN('unknown_ids_max')).join(ttT('unknown_ids_joiner')) + (seen.length > ttN('unknown_ids_max') ? text.render(ttT('unknown_ids_more'), { n: seen.length - ttN('unknown_ids_max') }) : '');
        demand = ttT('unknown_head') + (seen.length ? text.render(ttT('unknown_saw'), { n: seen.length, ids: ids }) : ttT('unknown_none')) +
          (mb ? text.render(ttT('unknown_older'), { mb: mb }) : ttT('unknown_unreadable')) + ttT('unknown_tail');
      }
    }
  }
  var blocked = open.filter(ttOwnerBlocked), counted = open.filter(function (t) { return !ttOwnerBlocked(t); });
  var inProgress = new RegExp(ttT('in_progress_re'), 'i'), oldest = null;
  for (var i = 0; i < counted.length; i++) if (inProgress.test(counted[i].status || '')) { oldest = counted[i]; break; }
  var subject = '';
  if (oldest !== null) {
    subject = ttOneLine(oldest.content !== oldest.id ? oldest.content : ttT('subject_unknown'), ttN('subject_max'));
  }
  var tail = oldest !== null && subject !== '' ? text.render(ttT('subject_tail'), { subject: JSON.stringify(subject) }) : '';
  var why = [];
  blocked.forEach(function (t) { var b = tk.blockedOnText(t), w = b === '' ? ttT('owner_word') : b; if (why.indexOf(w) < 0) why.push(w); });
  var blockedTail = blocked.length ? text.render(ttT('blocked_tail'), { n: blocked.length, why: why.join(ttT('why_joiner')) }) : '';
  var line = counted.length === 0
    ? text.render(ttT('open_zero'), { blocked: blockedTail })
    : text.render(ttT('open_some'), { n: counted.length, blocked: blockedTail, tail: tail });
  return { tasks: tasks, demand: demand, openLine: line, plan: plan };
}

// `sessionKey(sid)` of hooks/lib/dispatch-demand.js.
function ttSessionKey(sid) { return String(sid || ttT('unknown_session')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ttN('session_key_max')); }

// `spawnedSince(transcriptPath, sinceMs)`: an Agent, Task or Workflow tool call at or after `since` in the end of the transcript.
// true / false; a tail or timestamp the engine cannot read exactly shows no spawn (counted).
function ttSpawnedSince(tp, since) {
  var g = ah.transcript.grep(tp, ah.cfgNum('taskstate.tail_bytes'), [ttT('spawn_marker')], ttT('spawn_name_re'), '');
  if (g === null) return false;
  if (g.unsure) { ah.unable('task-tracker:spawn_grep_unsure'); return false; }
  var names = ttT('spawn_names');
  for (var i = 0; i < g.lines.length; i++) {
    var raw = g.lines[i], e;
    try { e = JSON.parse(raw); } catch (x) { continue; }
    if (e === null || typeof e !== 'object') continue;
    var ts = NaN;
    if (typeof e.timestamp === 'string') { ts = jx.isoMs(e.timestamp); if (ts === undefined) { ah.unable('task-tracker:spawn_ts_form'); ts = NaN; } }
    if (!isFinite(ts) || ts < since) continue;
    var c = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    if (c.some(function (b) { return b && b.type === 'tool_use' && names.indexOf(b.name) >= 0; })) return true;
  }
  return false;
}

// `resolvePending`: the metrics file after scoring the previous turn's demand, when it differs from what is on disk:
// {rel, body} or null. A metrics file over the read cap, unparsable or an array starts afresh (counted; the write repairs it).
function ttResolvePending(home, sessionRaw, tp, hasTranscript, now) {
  var rel = ah.cfg('paths.base_dir') + '/' + ttT('metrics_file'), m = {};
  var f = jx.read(home + '/' + rel);
  if (f.big) ah.unable('task-tracker:pending_big');
  else if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) ah.unable('task-tracker:pending_unsure');
    else if (!r.invalid && r.v !== null && typeof r.v === 'object') m = r.v;
  }
  if (Array.isArray(m)) { ah.unable('task-tracker:pending_array'); m = {}; }
  ttT('metrics_counters').forEach(function (k) { if (!ttFinite(m[k]) || m[k] < 0) m[k] = 0; });
  var pk = ttT('metrics_pending');
  if (!m[pk] || typeof m[pk] !== 'object') m[pk] = {};
  if (Array.isArray(m[pk])) { ah.unable('task-tracker:pending_part_array'); m[pk] = {}; }
  var dirty = false, ttl = ttN('metrics_pending_ttl_ms');
  Object.keys(m[pk]).forEach(function (k) {
    var v = m[pk][k];
    if (!v || !ttFinite(v.ts) || now - v.ts > ttl) { delete m[pk][k]; dirty = true; }
  });
  var key = ttSessionKey(sessionRaw), p = m[pk][key];
  if (p && hasTranscript) {
    var sp = tp !== null ? ttSpawnedSince(tp, p.ts) : false;
    var counter = sp ? ttT('metrics_followed') : ttT('metrics_ignored');
    m[counter] = m[counter] + 1;
    delete m[pk][key];
    dirty = true;
  }
  return dirty ? { rel: rel, body: JSON.stringify(m) } : null;
}

function decide(p) {
  if (spawn.judgeChild() || !ah.settings.bool('task_tracker.setting')) return 'allow';
  // `payload.prompt` on a null payload throws in Node, which swallows it and exits silently; any other value that is not an object has no
  // session and no working directory (Node would fall back to its own), so it is read as an empty payload (counted)
  if (!jx.isObj(p)) {
    if (p === null) return 'allow';
    ah.unable('task-tracker:payload_shape');
    p = {};
  }
  if (ah.settings.skipped(ttT('guard_name'))) return 'allow';
  // A message from another Claude session (not a person typing) is no new user request: no task-capture directive for it.
  if (typeof p.prompt === 'string' && ah.re.test(ah.cfg('task_tracker.peer_prompt_re'), 'i', p.prompt.slice(0, ah.cfgNum('task_tracker.peer_prompt_chars')))) return 'allow';
  var sh = spawn.stateHome();
  // a guarded or unknown state home keeps no state (Node's metrics home refuses it); the directive state then lives under the passwd home
  var home = sh.ok !== undefined ? sh.ok : (ah.env.passwdHome() || spawn.osHome());
  if (sh.ok === undefined) ah.unable('task-tracker:state_home');
  if (!home) { ah.unable('task-tracker:no_home'); return { advisory: text.advisoryJson(ttT('event'), ttFull(vf.codexPayload(p))) }; } // no home at all: the full directive, no state
  // the DevSwarm Primary block: whether it applies depends on the repository's own documents (unclassified: withheld, counted)
  var primaryOn = vf.tierTextOn(p);
  if (primaryOn === null) { ah.unable('task-tracker:primary_unclassified'); primaryOn = false; }
  var now = ah.clock.now(), codex = vf.codexPayload(p);
  var tp = vf.transcriptOf(p), dsid = vf.sessionOf(p);
  if (tp === undefined) { ah.unable('task-tracker:relative_transcript'); tp = null; } // Node resolves it against its own directory; here it reads nothing
  if (dsid === undefined) { ah.unable('task-tracker:session_shape'); dsid = String(p.session_id); }
  var sessionRaw = '';
  if (p.session_id) {
    if (typeof p.session_id === 'object') ah.unable('task-tracker:session_object');
    sessionRaw = String(p.session_id);
  }
  var session = sessionRaw;
  if (sessionRaw === '') {
    if (!p.cwd) ah.unable('task-tracker:no_session_no_cwd'); // Node uses its own working directory
    session = ah.sha1(String(p.cwd || '')).slice(0, ttN('session_hash_len'));
  }

  // ---- decide: nothing below this line writes until the effects block ----
  var stateName = ttT('state_prefix') + tk.safeKey(session) + ttT('state_suffix');
  var stateRel = ah.cfg('paths.base_dir') + '/' + stateName;
  var chosen = ttPick(home, stateRel, tp, now);
  var full = ttFull(codex), short = ttShort();
  var fresh = ttFresh(home, tp, sessionRaw, p);
  // change-only: the short reminder speaks when the open-task list changed, or after `untracked_prompts` unchanged prompts (a request may
  // be untracked); otherwise it is withheld. The full directive keeps its own window.
  var ch = { hash: '', quiet: 0, hold: false, track: false };
  if (fresh !== null) {
    ch.hash = ttListHash(fresh.tasks);
    ch.track = true;
    if (!chosen.full && ah.settings.bool('task_tracker.change_setting')) {
      var prev = ttChangeState(home, stateRel);
      var changed = prev.hash !== ch.hash;
      ch.quiet = changed ? 0 : prev.quiet + 1;
      ch.hold = !changed && ch.quiet < ah.settings.num('task_tracker.untracked_prompts');
      if (!ch.hold) ch.quiet = 0;
    }
  }
  var unknown = null;
  if (fresh !== null) unknown = tk.unknownNote(fresh.tasks, home, sessionRaw, ttT('unknown_tag'));
  var demand = ttResolvePending(home, sessionRaw, tp, !!p.transcript_path, now);
  var jev = null;
  if (typeof p.prompt === 'string' && p.prompt.trim() !== '') jev = ttJevSpec(p, p.prompt, sessionRaw);
  // the state tables reach the model only when their content changed (advisory layer); a held-back table leaves the line out
  var kDemand = ah.cfg('advisory.kind_task_demand_line'), kOpen = ah.cfg('advisory.kind_task_open_line');
  var advState = adv.load(session); // one state for both tables, so their entries are saved together
  var gDemand = fresh !== null && fresh.demand !== '' ? adv.decide(kDemand, session, fresh.demand, advState) : null;
  var gOpen = fresh !== null && fresh.openLine !== '' ? adv.decide(kOpen, session, fresh.openLine, advState) : null;
  var lineParts = [];
  if (gDemand !== null && gDemand.emit) lineParts.push(fresh.demand);
  if (gOpen !== null && gOpen.emit) lineParts.push(fresh.openLine);
  var freshLine = lineParts.join(ttT('freshness_joiner'));
  // `freshLineAll`: the tables as Node writes them, whether or not the advisory layer holds one back; the dedupe store hashes this text
  // (Node's), so a turn that changed nothing is suppressed whole, as in Node, instead of re-showing the short reminder.
  var freshLineAll = fresh === null ? '' : [fresh.demand, fresh.openLine].filter(function (x) { return x !== ''; }).join(ttT('freshness_joiner'));
  function compose(unknownNote) {
    var open = '', openAll = '';
    if (fresh !== null) {
      open = freshLine === '' ? unknownNote : (unknownNote === '' ? freshLine : freshLine + ' ' + unknownNote);
      openAll = freshLineAll === '' ? unknownNote : (unknownNote === '' ? freshLineAll : freshLineAll + ' ' + unknownNote);
    }
    var lead = chosen.full ? full : (ch.hold ? '' : short);
    if (lead === '') return { text: open, textAll: openAll, open: open };
    return { text: open === '' ? lead : lead + ttT('note_joiner') + open, textAll: openAll === '' ? lead : lead + ttT('note_joiner') + openAll, open: open };
  }
  var every = ah.settings.num('verify_first.num_repeat_every');
  var keepalive = isFinite(every) && every > 0 ? every : 0;
  var normalize = function (t) { return t.split(full).join(short); };
  // the dedupe store; a transcript timestamp only V8 reads exactly makes it emit (counted), never hand back
  function should(o) {
    if (dsid === null) return true;
    var r = dedupe.evaluate(o, true);
    if (r === 'unsure') { ah.unable('task-tracker:dedupe_ts_form'); return true; }
    return r;
  }

  var primaryText = text.message('tip', ttT('guard_name'), { what: ttT('primary_what'), instead: ttT('primary_instead') });
  var primaryOpts = function () { return { sessionId: dsid, key: ttT('primary_key'), content: primaryText, transcriptPath: tp, keepaliveTurns: keepalive, normalize: function (x) { return x; } }; };

  // ---- effects, in Node's order ----
  if (jev !== null) { try { ah.jev.ask(jev); } catch (e) { /* best effort, as Node's try/catch */ } }
  if (chosen.full) {
    try {
      var st = { lastFull: Math.floor(now), lastFullSize: chosen.size };
      if (ch.track) { st.openHash = ch.hash; st.quiet = 0; }
      ah.state.writeAtomic(stateRel, JSON.stringify(st));
      gk.pruneStale(ah.cfg('paths.base_dir'), ttT('prune_prefix'));
    } catch (e) { /* Node ignores a failed state write and injects regardless */ }
  } else if (ch.track && ah.settings.bool('task_tracker.change_setting')) {
    try {
      ah.state.writeAtomic(stateRel, JSON.stringify({ lastFull: Math.floor(chosen.lastFull), lastFullSize: chosen.lastSize, openHash: ch.hash, quiet: ch.quiet }));
    } catch (e) { /* a lost write only repeats the reminder */ }
  }
  if (demand !== null) { try { ah.state.writeAtomic(demand.rel, demand.body); } catch (e) { /* lost silently, as Node's */ } }
  var plan = fresh !== null ? fresh.plan : null;
  if (plan !== null && plan.track) plan.track(); // the outcomes of the recommendations made earlier
  var c = compose(unknown !== null ? unknown.write() : '');
  if (plan !== null && plan.annotate) plan.annotate.run(); // the requests for tasks without a verdict, then the recommendations shown
  // held out of `t`, so a burst-collapsed copy and a delivered one hash alike
  var primaryBlock = '';
  if (primaryOn) primaryBlock = (dsid === null || should(primaryOpts())) ? primaryText : '';
  var t = c.text, out = t, emit = true;
  if (ch.hold) emit = c.open !== ''; // the short reminder is withheld; the open-task tables have their own change gate
  else if (dsid !== null) {
    var o = { sessionId: dsid, key: ttT('dedupe_key'), content: c.textAll, transcriptPath: tp, normalize: normalize };
    if (t.indexOf(full) === 0) dedupe.record(o);
    else emit = should(o);
  }
  if (emit && !ch.hold && t.indexOf(short) === 0) {
    var show = should({ sessionId: dsid, key: ttT('dedupe_short_key'), content: short, transcriptPath: tp, keepaliveTurns: keepalive });
    out = show ? [short, c.open].filter(function (x) { return x !== ''; }).join(ttT('segment_joiner')) : c.open;
  }
  var finalText = [emit ? out : '', primaryBlock].filter(function (x) { return x !== ''; }).join(ttT('segment_joiner'));
  // count the tables: delivered ones are recorded as injected (and their hash remembered), held-back ones as suppressed
  var delivered = emit && finalText.indexOf(freshLine) >= 0 && freshLine !== '';
  [[gDemand, fresh !== null ? fresh.demand : ''], [gOpen, fresh !== null ? fresh.openLine : '']].forEach(function (g) {
    if (g[0] === null) return;
    if (!g[0].emit) adv.commit(g[0]);
    else if (delivered) adv.commit(g[0]);
    else { adv.metric(g[0].kind, 'flagged'); adv.metric(g[0].kind, 'suppressed'); } // the dedupe store held the whole text back; the table stays due
  });
  var shownDemand = gDemand !== null && gDemand.emit && delivered && plan !== null ? plan.demandShown : 0;
  if ((emit || primaryBlock !== '') && shownDemand > 0) ttRecordDemand(home, sessionRaw, shownDemand);
  return finalText !== '' ? { advisory: text.advisoryJson(ttT('event'), finalText) } : 'allow';
}

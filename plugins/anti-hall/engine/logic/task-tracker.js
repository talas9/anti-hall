// check = "task-tracker" (UserPromptSubmit; the Claude and the Codex entry). On every prompt the hook keeps the task-list discipline in
// front of the model without repeating it every turn: the full directive on the first prompt of a session, again when its window
// elapses or the transcript has grown by the growth threshold, a short reminder in between that the injection keepalive rations, plus
// one line about the open tasks. It also asks Jev (integration `newRequest`) to label the prompt, and scores the previous turn's
// dispatch demand. First everything is read and decided, and every point at which this script cannot answer exactly defers (a
// session that could be a DevSwarm Primary, a task the per-turn DISPATCH NOW line would name, a dispatch-tier outcome still to be
// labelled, a state file that cannot be read the way Node reads it); only then the effects are performed, in Node's order: the Jev
// ask, the directive's state file, the demand score, the unknown-state note and the dedupe records. Mirrors hooks/task-tracker.js
// `main`, `pickMessage` and `freshnessNote`, and hooks/lib/dispatch-demand.js `resolvePending`. Keys, texts, limits and switches:
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

// `pickMessage`: read the state of this session and choose; nothing is written here. {full: bool, size}, or 'defer'.
function ttPick(home, rel, tp, now) {
  var size = tp !== null ? ah.fs.size(tp) : null;
  if (size === null) size = -1;
  var lastFull = 0, lastSize = -1;
  var f = jx.read(home + '/' + rel);
  if (f.big) return 'defer';
  if (f.text !== undefined) {
    var t = f.text.trim();
    if (t !== '') {
      var r = jx.parse(t);
      if (r.unsure) return 'defer';
      if (!r.invalid && jx.isObj(r.v)) {
        if (ttFinite(r.v.lastFull) && r.v.lastFull <= now + ttN('future_tolerance_ms')) lastFull = r.v.lastFull;
        if (ttFinite(r.v.lastFullSize) && r.v.lastFullSize >= 0) lastSize = r.v.lastFullSize;
      }
    }
  }
  var fresh = now - lastFull < ttN('window_ms');
  var grew = size >= 0 && lastSize >= 0 && size - lastSize >= ttN('growth_bytes');
  return { full: !(fresh && !grew), size: size };
}

// The Jev ask for a prompt (`askDetached` of integration `newRequest`): the spec, or 'defer' when the prompt cannot be cut for Jev
// exactly as Node cuts it.
function ttJevSpec(p, prompt, sessionRaw) {
  var limit = ttN('jev_state_limit'), state = prompt;
  if (prompt.length > limit) {
    var last = prompt.charCodeAt(limit - 1);
    if (last >= 0xd800 && last <= 0xdbff) return 'defer';
    state = prompt.slice(0, limit);
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

// `classifyOpen(open, taskMap)`: how many pending, unowned (or coordinator-owned) tasks no open blocker holds back.
function ttActionable(open, tasks) {
  var done = ttT('done_statuses'), known = new Set(), notDone = new Set();
  tasks.forEach(function (t) { known.add(t.id); if (done.indexOf(tk.statusLc(t)) < 0) notDone.add(t.id); });
  var mainOwner = new RegExp(ttT('main_owner_re'), 'i'), n = 0;
  open.forEach(function (t) {
    if (tk.statusLc(t) !== ttT('pending_status') || t.blockUnknown) return;
    if (t.owner && !mainOwner.test(t.owner)) return;
    if (ttOwnerBlocked(t)) return;
    if ((t.blockedBy || []).some(function (b) { return notDone.has(b) || !known.has(b); })) return;
    n++;
  });
  return n;
}

// `oneLine(s, max)`; null when the cut would split a surrogate pair.
function ttOneLine(s, max) {
  var o = s.replace(new RegExp(ttT('control_re'), 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) {
    var last = o.charCodeAt(max - 1);
    if (last >= 0xd800 && last <= 0xdbff) return null;
    o = o.slice(0, max).trimEnd() + ttT('ellipsis');
  }
  return o;
}

// Whether the dispatch-tier state holds a recommendation of this session whose outcome `trackOutcomes` would still label (the
// script does not label outcomes, so such a session is left to Node). 'defer' when the file cannot be read the way Node reads it.
function ttOutcomePending(home, sid) {
  var f = jx.read(home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('dispatch_tier.state_file'));
  if (f.big) return 'defer';
  if (f.text === undefined) return false;
  var r = jx.parse(f.text);
  if (r.unsure) return 'defer';
  if (r.invalid) return false;
  var sessions = jx.field(r.v, 'sessions');
  var sess = jx.isObj(sessions) && Object.prototype.hasOwnProperty.call(sessions, sid) ? sessions[sid] : undefined;
  var tasks = jx.field(sess, 'tasks');
  if (tasks === undefined || tasks === null) return false;
  if (!jx.isObj(tasks)) return 'defer';
  var ids = Object.keys(tasks);
  for (var i = 0; i < ids.length; i++) {
    var rec = tasks[ids[i]];
    if (!jx.isObj(rec)) return 'defer';
    if (!(rec.dispatch && rec.result)) return true;
  }
  return false;
}

// The note for this prompt: null (no transcript to read), {tasks, line}, or 'defer'.
function ttFresh(home, tp, sessionRaw) {
  if (tp === null) return null;
  var size = ah.fs.size(tp);
  if (!size) return null;
  var r = ah.transcript.tasks(tp, 'state', ah.cfgNum('taskstate.tail_bytes'));
  if (r.unsure) return 'defer';
  if (r.unreadable) return null;
  var tasks = r.tasks;
  var pend = ttOutcomePending(home, sessionRaw === '' ? ttT('unknown_session') : sessionRaw);
  if (pend !== false) return 'defer';
  var open = tasks.filter(tk.isOpen);
  if (open.length === 0) return { tasks: tasks, line: '' };
  // the per-turn DISPATCH NOW line: it counts running agents, asks Jev for a tier and records a demand
  if (ah.settings.bool('task_tracker.dd_setting') && ttActionable(open, tasks) >= 1) return 'defer';
  var blocked = open.filter(ttOwnerBlocked), counted = open.filter(function (t) { return !ttOwnerBlocked(t); });
  var inProgress = new RegExp(ttT('in_progress_re'), 'i'), oldest = null;
  for (var i = 0; i < counted.length; i++) if (inProgress.test(counted[i].status || '')) { oldest = counted[i]; break; }
  var subject = '';
  if (oldest !== null) {
    subject = ttOneLine(oldest.content !== oldest.id ? oldest.content : ttT('subject_unknown'), ttN('subject_max'));
    if (subject === null) return 'defer';
  }
  var tail = oldest !== null && subject !== '' ? text.render(ttT('subject_tail'), { subject: JSON.stringify(subject) }) : '';
  var why = [];
  blocked.forEach(function (t) { var b = tk.blockedOnText(t), w = b === '' ? ttT('owner_word') : b; if (why.indexOf(w) < 0) why.push(w); });
  var blockedTail = blocked.length ? text.render(ttT('blocked_tail'), { n: blocked.length, why: why.join(ttT('why_joiner')) }) : '';
  var line = counted.length === 0
    ? text.render(ttT('open_zero'), { blocked: blockedTail })
    : text.render(ttT('open_some'), { n: counted.length, blocked: blockedTail, tail: tail });
  return { tasks: tasks, line: line };
}

// `sessionKey(sid)` of hooks/lib/dispatch-demand.js.
function ttSessionKey(sid) { return String(sid || ttT('unknown_session')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ttN('session_key_max')); }

// `spawnedSince(transcriptPath, sinceMs)`: an Agent, Task or Workflow tool call at or after `since` in the end of the transcript.
// true / false, or 'defer' when a timestamp is in a form only V8 reads.
function ttSpawnedSince(tp, since) {
  var tail = ah.fs.readTail(tp, ah.cfgNum('taskstate.tail_bytes'));
  if (tail === null) return false;
  var lines = tail.split('\n'), nameRe = new RegExp(ttT('spawn_name_re')), names = ttT('spawn_names');
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    if (raw.indexOf(ttT('spawn_marker')) < 0 || !nameRe.test(raw)) continue;
    var e;
    try { e = JSON.parse(raw); } catch (x) { continue; }
    if (e === null || typeof e !== 'object') continue;
    var ts = NaN;
    if (typeof e.timestamp === 'string') { ts = jx.isoMs(e.timestamp); if (ts === undefined) return 'defer'; }
    if (!isFinite(ts) || ts < since) continue;
    var c = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    if (c.some(function (b) { return b && b.type === 'tool_use' && names.indexOf(b.name) >= 0; })) return true;
  }
  return false;
}

// `resolvePending`: the metrics file after scoring the previous turn's demand, when it differs from what is on disk:
// {rel, body}, null, or 'defer'.
function ttResolvePending(home, sessionRaw, tp, hasTranscript, now) {
  var rel = ah.cfg('paths.base_dir') + '/' + ttT('metrics_file'), m = {};
  var f = jx.read(home + '/' + rel);
  if (f.big) return 'defer';
  if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) return 'defer';
    if (!r.invalid && r.v !== null && typeof r.v === 'object') m = r.v;
  }
  if (Array.isArray(m)) return 'defer';
  ttT('metrics_counters').forEach(function (k) { if (!ttFinite(m[k]) || m[k] < 0) m[k] = 0; });
  var pk = ttT('metrics_pending');
  if (!m[pk] || typeof m[pk] !== 'object') m[pk] = {};
  if (Array.isArray(m[pk])) return 'defer';
  var dirty = false, ttl = ttN('metrics_pending_ttl_ms');
  Object.keys(m[pk]).forEach(function (k) {
    var v = m[pk][k];
    if (!v || !ttFinite(v.ts) || now - v.ts > ttl) { delete m[pk][k]; dirty = true; }
  });
  var key = ttSessionKey(sessionRaw), p = m[pk][key];
  if (p && hasTranscript) {
    var sp = tp !== null ? ttSpawnedSince(tp, p.ts) : false;
    if (sp === 'defer') return 'defer';
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
  // session and no working directory, so Node falls back to its own working directory
  if (!jx.isObj(p)) return p === null ? 'allow' : 'defer';
  if (ah.settings.skipped(ttT('guard_name'))) return 'allow';
  var sh = spawn.stateHome();
  if (sh.ok === undefined) return 'defer';
  var home = sh.ok;
  // the DevSwarm Primary block: whether it applies depends on the repository's own documents (null: not reproducible)
  var primaryOn = vf.tierTextOn(p);
  if (primaryOn === null) return 'defer';
  var now = ah.clock.now(), codex = vf.codexPayload(p);
  var tp = vf.transcriptOf(p), dsid = vf.sessionOf(p);
  if (tp === undefined || dsid === undefined) return 'defer';
  var sessionRaw = '';
  if (p.session_id) {
    if (typeof p.session_id === 'object') return 'defer';
    sessionRaw = String(p.session_id);
  }
  var session = sessionRaw;
  if (sessionRaw === '') {
    if (!p.cwd) return 'defer'; // else Node uses its own working directory
    session = ah.sha1(String(p.cwd)).slice(0, ttN('session_hash_len'));
  }

  // ---- decide: nothing below this line writes until the effects block ----
  var stateName = ttT('state_prefix') + tk.safeKey(session) + ttT('state_suffix');
  var stateRel = ah.cfg('paths.base_dir') + '/' + stateName;
  var chosen = ttPick(home, stateRel, tp, now);
  if (chosen === 'defer') return 'defer';
  var full = ttFull(codex), short = ttShort();
  var fresh = ttFresh(home, tp, sessionRaw);
  if (fresh === 'defer') return 'defer';
  var unknown = null;
  if (fresh !== null) {
    unknown = tk.unknownNote(fresh.tasks, home, sessionRaw, ttT('unknown_tag'));
    if (unknown === null) return 'defer';
  }
  var demand = ttResolvePending(home, sessionRaw, tp, !!p.transcript_path, now);
  if (demand === 'defer') return 'defer';
  var jev = null;
  if (typeof p.prompt === 'string' && p.prompt.trim() !== '') {
    jev = ttJevSpec(p, p.prompt, sessionRaw);
    if (jev === 'defer') return 'defer';
  }
  function compose(unknownNote) {
    var open = '';
    if (fresh !== null) open = fresh.line === '' ? unknownNote : (unknownNote === '' ? fresh.line : fresh.line + ' ' + unknownNote);
    var lead = chosen.full ? full : short;
    return { text: open === '' ? lead : lead + ttT('note_joiner') + open, open: open };
  }
  var every = ah.settings.num('verify_first.num_repeat_every');
  var keepalive = isFinite(every) && every > 0 ? every : 0;
  var normalize = function (t) { return t.split(full).join(short); };

  // the dedupe store must be able to decide both blocks before anything is written (a transcript timestamp only V8 reads exactly defers)
  if (dsid !== null) {
    var tt0 = compose(unknown !== null ? unknown.note : '').text;
    if (tt0.indexOf(full) !== 0) {
      if (!dedupe.canDecide({ sessionId: dsid, key: ttT('dedupe_key'), content: tt0, transcriptPath: tp, normalize: normalize })) return 'defer';
      if (tt0.indexOf(short) === 0 && !dedupe.canDecide({ sessionId: dsid, key: ttT('dedupe_short_key'), content: short, transcriptPath: tp, keepaliveTurns: keepalive })) return 'defer';
    }
  }

  var primaryText = text.message('tip', ttT('guard_name'), { what: ttT('primary_what'), instead: ttT('primary_instead') });
  var primaryOpts = function () { return { sessionId: dsid, key: ttT('primary_key'), content: primaryText, transcriptPath: tp, keepaliveTurns: keepalive, normalize: function (x) { return x; } }; };
  if (primaryOn && dsid !== null && !dedupe.canDecide(primaryOpts())) return 'defer';

  // ---- effects, in Node's order ----
  if (jev !== null) { try { ah.jev.ask(jev); } catch (e) { /* best effort, as Node's try/catch */ } }
  if (chosen.full) {
    try {
      ah.state.writeAtomic(stateRel, JSON.stringify({ lastFull: Math.floor(now), lastFullSize: chosen.size }));
      gk.pruneStale(ah.cfg('paths.base_dir'), ttT('prune_prefix'));
    } catch (e) { /* Node ignores a failed state write and injects regardless */ }
  }
  if (demand !== null) { try { ah.state.writeAtomic(demand.rel, demand.body); } catch (e) { /* lost silently, as Node's */ } }
  var c = compose(unknown !== null ? unknown.write() : '');
  // held out of `t`, so a burst-collapsed copy and a delivered one hash alike
  var primaryBlock = '';
  if (primaryOn) primaryBlock = (dsid === null || dedupe.shouldEmit(primaryOpts())) ? primaryText : '';
  var t = c.text, out = t, emit = true;
  if (dsid !== null) {
    var o = { sessionId: dsid, key: ttT('dedupe_key'), content: t, transcriptPath: tp, normalize: normalize };
    if (t.indexOf(full) === 0) dedupe.record(o);
    else emit = dedupe.shouldEmit(o);
  }
  if (emit && t.indexOf(short) === 0) {
    var show = true;
    if (dsid !== null) show = dedupe.shouldEmit({ sessionId: dsid, key: ttT('dedupe_short_key'), content: short, transcriptPath: tp, keepaliveTurns: keepalive });
    out = show ? [short, c.open].filter(function (x) { return x !== ''; }).join(ttT('segment_joiner')) : c.open;
  }
  var finalText = [emit ? out : '', primaryBlock].filter(function (x) { return x !== ''; }).join(ttT('segment_joiner'));
  return finalText !== '' ? { advisory: text.advisoryJson(ttT('event'), finalText) } : 'allow';
}

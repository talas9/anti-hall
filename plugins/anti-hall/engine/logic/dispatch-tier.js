// check = "dispatch-tier" (PostToolUse on TaskCreate and TaskUpdate; mirrors hooks/dispatch-tier.js and the `request` function of
// hooks/lib/dispatch-tier.js). Asks Jev, detached, how a new or changed task should be dispatched (the `dispatchTier` integration:
// a choice among workspace, workflow and subagent), once per task text: a text with an answer in the shared cache is not asked
// again, and a request marker in dispatch-tier-state.json stops a repeat while the first ask may still be in flight. Everything
// before the ask only reads; the one write is that marker. While the integration is off nothing is read or written. A task waiting on
// the owner (the `blockedOn` marker or an `OWNER:` subject) is never classified. Anything this script cannot reproduce exactly
// defers (a request without a usable home, a task field of a type whose text differs, a text cut through a surrogate pair, a
// state file that is an array). Keys and texts: task_guards.toml (dispatch_tier.*).
'use strict';

function dtFirstText(inp) {
  var keys = ['subject', 'title', 'content', 'description'];
  for (var i = 0; i < keys.length; i++) {
    var v = jx.field(inp, keys[i]);
    if (!v) continue;
    if (typeof v !== 'string') return null; // a truthy non-string field: Node prints it however it prints; the Node hook decides
    return v;
  }
  return '';
}

// `isOwnerBlocked` of lib/dispatch-demand.js.
function dtOwnerBlocked(t) {
  if (!ah.settings.bool('dispatch_tier.owner_marker_setting')) return false;
  if (typeof t.blockedOn === 'string' && ah.cfg('dispatch_tier.owner_values').indexOf(t.blockedOn.trim().toLowerCase()) >= 0) return true;
  return new RegExp(ah.cfg('dispatch_tier.owner_subject_re'), 'i').test(t.content);
}

// The task of the call: {content, description, blockedOn}, 'none' when the hook has nothing to classify, 'defer'.
function dtTask(p, tool) {
  var inp = p.tool_input ? p.tool_input : null;
  var meta = jx.field(inp, 'metadata');
  var metaBlocked = meta ? jx.field(meta, 'blockedOn') : undefined;
  if (tool === 'TaskCreate') {
    var content = dtFirstText(inp);
    if (content === null) return 'defer';
    var d = jx.field(inp, 'description');
    return { content: content, description: typeof d === 'string' ? d : '', blockedOn: metaBlocked !== undefined && metaBlocked !== null ? metaBlocked : jx.field(inp, 'blockedOn') };
  }
  var subject = jx.field(inp, 'subject');
  if (subject && typeof subject !== 'string') return 'defer';
  var desc = jx.field(inp, 'description');
  var hasText = !!subject || typeof desc === 'string';
  var tid = jx.field(inp, 'taskId'), alt = jx.field(inp, 'id');
  var id = tid !== undefined && tid !== null ? String(tid) : (alt !== undefined && alt !== null ? String(alt) : null);
  if (!hasText || id === null) return 'none';
  var base = { content: '', description: '', blockedOn: undefined };
  var tp = p.transcript_path;
  if (tp) {
    if (typeof tp !== 'string') return 'defer'; // Node's readTail answers null for a path that is not a string; not modelled
    var r = ah.transcript.tasks(tp, 'state', ah.cfgNum('taskstate.tail_bytes'));
    if (r.unsure) return 'defer';
    if (!r.unreadable) {
      for (var i = 0; i < r.tasks.length; i++) {
        if (r.tasks[i].id === id) { base = { content: r.tasks[i].content, description: r.tasks[i].description, blockedOn: r.tasks[i].blockedOn }; break; }
      }
    }
  }
  if (subject) base.content = subject;
  if (typeof desc === 'string') base.description = desc;
  if (metaBlocked !== undefined) base.blockedOn = metaBlocked;
  return base;
}

// `readState(home)`: the state object with `requested` and `sessions` objects in place; null for a state only the Node hook handles.
function dtReadState(path) {
  var s = {};
  var f = jx.read(path);
  if (f.big) return null;
  if (f.text !== undefined) {
    var r = jx.parse(f.text);
    if (r.unsure) return null;
    if (r.v !== undefined && r.v !== null && typeof r.v === 'object') {
      if (Array.isArray(r.v)) return null;
      s = r.v;
    }
  }
  var keys = ['requested', 'sessions'];
  for (var i = 0; i < keys.length; i++) {
    var v = s[keys[i]];
    if (Array.isArray(v)) return null;
    if (!v || typeof v !== 'object') s[keys[i]] = {};
  }
  return s;
}

// `writeState(home, s)`: bounded, then replaced atomically. Best effort, as in Node.
function dtWriteState(rel, s, now) {
  var max = ah.cfgNum('dispatch_tier.max_sessions');
  var sids = Object.keys(s.sessions);
  if (sids.length > max) {
    sids.sort(function (a, b) { return ((s.sessions[a] && s.sessions[a].t) || 0) - ((s.sessions[b] && s.sessions[b].t) || 0); });
    sids.slice(0, sids.length - max).forEach(function (k) { delete s.sessions[k]; });
  }
  var ttl = ah.cfgNum('dispatch_tier.request_ttl_ms');
  Object.keys(s.requested).forEach(function (k) { var v = s.requested[k]; if (!Number.isFinite(v) || now - v > ttl) delete s.requested[k]; });
  ah.state.writeAtomic(rel, JSON.stringify(s)); // a lost write only means the tier question is asked again
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('dispatch_tier.tools').indexOf(tool) < 0) return 'allow';
  var h = ah.env.get(ah.cfg('env.home'));
  if (h === null) h = ah.env.get(ah.cfg('env.home_alt'));
  if (!h) return 'defer';
  var jevId = ah.cfg('dispatch_tier.jev_id');
  if (ah.jev.mode(jevId) === 'off') return 'allow';
  var guard = ah.homeGuard();
  if (guard.status !== 'ok') return 'defer';
  var task = dtTask(p, tool);
  if (task === 'defer') return 'defer';
  if (task === 'none') return 'allow';
  if (!task.content || dtOwnerBlocked(task)) return 'allow';
  var joined = task.description && task.description !== task.content ? task.content + '\n' + task.description : task.content;
  var text = joined.slice(0, ah.cfgNum('dispatch_tier.text_cap'));
  if (jx.loneSurrogate(text)) return 'defer'; // a cut through a surrogate pair leaves half of it; it cannot cross into the engine
  var hash = ah.contentHash([jevId, ah.cfg('jev.question_version'), text]);
  var cached = ah.jev.cacheHas(hash);
  if (cached === null) return 'defer';
  if (cached) return 'allow';
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('dispatch_tier.state_file');
  var st = dtReadState(guard.home + '/' + rel);
  if (st === null) return 'defer';
  var now = ah.clock.now();
  var at = st.requested[hash];
  if (Number.isFinite(at) && now - at < ah.cfgNum('dispatch_tier.request_ttl_ms')) return 'allow';
  // the session, as `String(payload.session_id)` when truthy
  var session = p.session_id ? String(p.session_id) : undefined;
  st.requested[hash] = now;
  dtWriteState(rel, st, ah.clock.now());
  var tiers = [['workspace', ah.cfg('dispatch_tier.tier_workspace')], ['workflow', ah.cfg('dispatch_tier.tier_workflow')], ['subagent', ah.cfg('dispatch_tier.tier_subagent')]];
  ah.jev.ask({
    id: jevId,
    question: { type: 'choice', instructions: ah.cfg('dispatch_tier.question_instructions'), criteria: tiers },
    state: text, trust: 'advisory', baseline: null, cacheKey: text, sessionId: session,
    turnRefFrom: typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : undefined,
    projectFrom: typeof p.cwd === 'string' ? p.cwd : undefined,
  });
  return 'allow';
}

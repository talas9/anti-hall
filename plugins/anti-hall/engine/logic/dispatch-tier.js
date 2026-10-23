// check = "dispatch-tier" (PostToolUse on TaskCreate and TaskUpdate; mirrors hooks/dispatch-tier.js and the `request` function of
// hooks/lib/dispatch-tier.js). Asks Jev, detached, how a new or changed task should be dispatched (the `dispatchTier` integration:
// a choice among workspace, workflow and subagent), once per task text: a text with an answer in the shared cache is not asked
// again, and a request marker in dispatch-tier-state.json stops a repeat while the first ask may still be in flight. Everything
// before the ask only reads; the one write is that marker. While the integration is off nothing is read or written. A task waiting on
// the owner (the `blockedOn` marker or an `OWNER:` subject) is never classified. Nothing is handed back to Node: a case the script
// cannot model exactly (a request without a usable home, a task field of another type, a text cut through a surrogate pair, a state
// file that is an array) is counted (native_unable at `dispatch-tier.*`) and decided natively. The hook is an advisory source: the
// ask is detached, the verdict is injected on a later turn by the task tracker, and the advisory counters (kind dispatch_tier) count
// flagged / asked / suppressed. Keys and texts: task_guards.toml (dispatch_tier.*), advisory.toml.
'use strict';

function dtFirstText(inp) {
  var keys = ['subject', 'title', 'content', 'description'];
  for (var i = 0; i < keys.length; i++) {
    var v = jx.field(inp, keys[i]);
    if (!v) continue;
    if (typeof v !== 'string') { ah.unable('dispatch-tier:field_type'); return String(v); } // a truthy non-string field is read as its text
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

// The task of the call: {content, description, blockedOn}, or 'none' when the hook has nothing to classify.
function dtTask(p, tool) {
  var inp = p.tool_input ? p.tool_input : null;
  var meta = jx.field(inp, 'metadata');
  var metaBlocked = meta ? jx.field(meta, 'blockedOn') : undefined;
  if (tool === 'TaskCreate') {
    var content = dtFirstText(inp);
    var d = jx.field(inp, 'description');
    return { content: content, description: typeof d === 'string' ? d : '', blockedOn: metaBlocked !== undefined && metaBlocked !== null ? metaBlocked : jx.field(inp, 'blockedOn') };
  }
  var subject = jx.field(inp, 'subject');
  if (subject && typeof subject !== 'string') { ah.unable('dispatch-tier:subject_type'); subject = String(subject); }
  var desc = jx.field(inp, 'description');
  var hasText = !!subject || typeof desc === 'string';
  var tid = jx.field(inp, 'taskId'), alt = jx.field(inp, 'id');
  var id = tid !== undefined && tid !== null ? String(tid) : (alt !== undefined && alt !== null ? String(alt) : null);
  if (!hasText || id === null) return 'none';
  var base = { content: '', description: '', blockedOn: undefined };
  var tp = p.transcript_path;
  if (tp) {
    var r = typeof tp === 'string' ? ah.transcript.tasks(tp, 'state', ah.cfgNum('taskstate.tail_bytes')) : { unreadable: true }; // a path that is not a string reads nothing
    if (typeof tp !== 'string') ah.unable('dispatch-tier:transcript_type');
    if (r.unsure) { ah.unable('dispatch-tier:tasks_unsure'); r = { unreadable: true }; }
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

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('dispatch_tier.tools').indexOf(tool) < 0) return 'allow';
  var h = ah.env.get(ah.cfg('env.home'));
  if (h === null) h = ah.env.get(ah.cfg('env.home_alt'));
  if (!h) { ah.unable('dispatch-tier:no_home', 'abandoned'); return 'allow'; } // nothing to read or write without a home
  var jevId = ah.cfg('dispatch_tier.jev_id');
  if (ah.jev.mode(jevId) === 'off') return 'allow';
  var guard = ah.homeGuard();
  if (guard.status !== 'ok') { ah.unable('dispatch-tier:home_guard', 'abandoned'); return 'allow'; } // a guarded or unknown home keeps no state
  var task = dtTask(p, tool);
  if (task === 'none') return 'allow';
  if (!task.content || dtOwnerBlocked(task)) return 'allow';
  var joined = task.description && task.description !== task.content ? task.content + '\n' + task.description : task.content;
  var text = joined.slice(0, ah.cfgNum('dispatch_tier.text_cap'));
  if (jx.loneSurrogate(text)) { ah.unable('dispatch-tier:lone_surrogate'); text = ahWf(text); } // a lone half pair is read as U+FFFD, as Node encodes it
  var hash = ah.contentHash([jevId, ah.cfg('jev.question_version'), text]);
  var cached = ah.jev.cacheHas(hash);
  var kind = ah.cfg('advisory.kind_dispatch_tier');
  if (cached === null) { ah.unable('dispatch-tier:cache_unsure'); cached = false; adv.metric(kind, 'jev_error'); } // an unreadable cache: ask again (the request marker bounds repeats)
  if (cached) return 'allow';
  adv.metric(kind, 'flagged');
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('dispatch_tier.state_file');
  var st = tk.tierRead(guard.home + '/' + rel);
  var now = ah.clock.now();
  var at = st.requested[hash];
  if (Number.isFinite(at) && now - at < ah.cfgNum('dispatch_tier.request_ttl_ms')) { adv.metric(kind, 'suppressed'); return 'allow'; }
  // the session, as `String(payload.session_id)` when truthy
  var session = p.session_id ? String(p.session_id) : undefined;
  st.requested[hash] = now;
  tk.tierWrite(rel, st, ah.clock.now());
  var tiers = [['workspace', ah.cfg('dispatch_tier.tier_workspace')], ['workflow', ah.cfg('dispatch_tier.tier_workflow')], ['subagent', ah.cfg('dispatch_tier.tier_subagent')]];
  adv.metric(kind, 'asked');
  ah.jev.ask({
    id: jevId,
    question: { type: 'choice', instructions: ah.cfg('dispatch_tier.question_instructions'), criteria: tiers },
    state: text, trust: 'advisory', baseline: null, cacheKey: text, sessionId: session,
    turnRefFrom: typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : undefined,
    projectFrom: typeof p.cwd === 'string' ? p.cwd : undefined,
  });
  return 'allow';
}

// check = "idle-agent-sweep" (UserPromptSubmit, advisory only). Once per user prompt, lists the agents this session's transcript shows
// finished but never stopped (Claude: named teammates; Codex: multi_agent_v1 agents never closed) and gives the exact call that ends
// each one. It fires when at least guards.idleAgentSweepCount finished agents are idle, or any one for at least guards.idleAgentSweepMin
// minutes, and never for a <task-notification> turn. The advisory goes through the emit-dedupe store (key idle-agent-sweep, the minutes
// in the text normalized away), so a queued burst of prompts yields one copy. The replay of the transcript is ah.transcript.teammates /
// ah.transcript.codexAgents; a transcript the host cannot read exactly as JavaScript would, a relative transcript path and a request
// whose HOME is unset defer to Node before anything is written. Mirrors hooks/idle-agent-sweep.js and hooks/lib/idle-agents.js.
// Keys and texts: prompt_emit.toml (idle_sweep.*).
'use strict';

function idNow() {
  if (ah.env.get(ah.cfg('idle_sweep.env_test_isolation')) === '1') {
    var raw = ah.env.get(ah.cfg('idle_sweep.env_test_now'));
    if (raw !== null && raw !== '') { var n = Number(raw); if (isFinite(n)) return n; }
  }
  return ah.clock.now();
}

function idOneLine(s, max) {
  var o = String(s).replace(new RegExp(ah.cfg('idle_sweep.re_control_chars'), 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + ah.cfg('idle_sweep.ellipsis');
  return o;
}

function idMessage(list, codex, now) {
  var words = ah.cfg(codex ? 'idle_sweep.words_codex' : 'idle_sweep.words_claude'), maxNamed = ah.cfgNum('idle_sweep.max_named'), labelMax = ah.cfgNum('idle_sweep.label_max');
  var shown = list.slice(0, maxNamed).map(function (a) {
    return idOneLine(a.label, labelMax) + ' (' + Math.max(0, Math.floor((now - a.idleSinceMs) / ah.cfgNum('idle_sweep.ms_per_minute'))) + 'm)';
  });
  var more = list.length > maxNamed ? text.render(ah.cfg('idle_sweep.more'), { m: list.length - maxNamed }) : '';
  var n = list.length, be = ah.cfg(n === 1 ? 'idle_sweep.be_one' : 'idle_sweep.be_many');
  var call = text.render(ah.cfg(codex ? 'idle_sweep.call_codex' : 'idle_sweep.call_claude'), { id: list[0].id });
  return text.message('tip', ah.cfg('idle_sweep.guard_name'), {
    what: text.render(ah.cfg('idle_sweep.what'), { n: n, be: be, past: words.past, shown: shown.join(', '), more: more }),
    why: text.render(ah.cfg('idle_sweep.why'), { why_head: words.why_head, past: words.past }),
    instead: text.render(ah.cfg('idle_sweep.instead'), { verb: words.verb, call: call }),
  });
}

// GH #744: the open-task owners of this session (names that own an unfinished task), or null when the list cannot be read.
function idOpenOwners(p, tp, home) {
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  var r = tk.tasksOf(home, sid, tp, 'state');
  if (r.unsure || r.unreadable) return null;
  var out = [];
  (r.tasks || []).forEach(function (t) { if (tk.isOpen(t) && typeof t.owner === 'string' && t.owner !== '') out.push(t.owner); });
  return out;
}

// GH #744: the order for finished agents idle past guards.idleOrderAfterMin on the escalating schedule. {plan, text}: `text` is '' when no
// order is due this turn (the plain advisory then speaks as before); null when orders are off or the session cannot keep a record.
function idOrder(p, tp, agents, codex, now) {
  if (!idleOrder.enabled() || typeof p.session_id !== 'string' || p.session_id === '') return null;
  var home = spawn.osHome(), kind = ah.cfg('idle_order.kind_teammate');
  var owners = codex || home === null ? [] : idOpenOwners(p, tp, home);
  var after = idleOrder.afterMs(), cands = [], keep = [];
  agents.forEach(function (a) {
    var idle = now - a.idleSinceMs;
    if (idle < after) return;
    if (owners !== null && owners.indexOf(a.id) >= 0) { idleOrder.skip(kind, 'open_task'); keep.push(a.id); return; }
    cands.push({ id: a.id, label: idOneLine(a.label, ah.cfgNum('idle_sweep.label_max')), idleMs: idle });
  });
  var plan = idleOrder.plan(kind, p.session_id, cands, now, keep);
  if (plan.due.length === 0) return { plan: plan, text: '' };
  var key = codex ? 'idle_order.msg_codex_agent' : 'idle_order.msg_teammate';
  return { plan: plan, text: text.render(ah.cfg(key), { n: plan.due.length, list: idleOrder.list(plan.due, 'idle_order.item_mate'), id: plan.due[0].id }) };
}

var idPlan = null;

// The advisory text, '' for nothing to say (a transcript the scan cannot read exactly counts as nothing to say).
function idAdvisory(p, now) {
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!tp) return '';
  var prompt = typeof p.prompt === 'string' ? p.prompt.trimStart() : '';
  if (prompt.indexOf(ah.cfg('idle_sweep.notification_tag')) === 0) return '';
  tp = hookProc.open(p, tp);
  var codex = cb.codexPayload(p), found, agents;
  if (codex) {
    found = ah.transcript.codexAgents(tp, ah.cfgNum('idle_sweep.scan_bytes'));
    if (found === null) return '';
    if (found.unsure) { ah.unable('idle-agent-sweep:codex_scan_unsure'); return ''; }
    agents = found.agents.map(function (a) { return { id: a.id, label: a.label, idleSinceMs: a.idleSinceMs }; });
  } else {
    found = ah.transcript.teammates(tp, ah.cfgNum('idle_sweep.scan_bytes'));
    if (found === null) return '';
    if (found.unsure) { ah.unable('idle-agent-sweep:teammates_scan_unsure'); return ''; }
    agents = found.teammates.map(function (f) { return { id: f.name, label: f.name, idleSinceMs: f.idleSinceMs }; });
  }
  // An agent idle past the stale bound is long gone (its stop may have failed as "No task found"), not idle: it drops out.
  var staleMs = ah.cfgNum('idle_sweep.stale_minutes') * ah.cfgNum('idle_sweep.ms_per_minute');
  agents = agents.filter(function (a) { return now - a.idleSinceMs < staleMs; });
  agents.sort(function (a, b) { return a.idleSinceMs - b.idleSinceMs; });
  var order = idOrder(p, tp, agents, codex, now);
  if (order !== null) { idPlan = order.plan; if (order.text !== '') return order.text; }
  var count = ah.settings.num('idle_sweep.num_count'), minutes = ah.settings.num('idle_sweep.num_minutes');
  var fire = agents.length > 0 && (agents.length >= count || agents.some(function (a) { return now - a.idleSinceMs >= minutes * ah.cfgNum('idle_sweep.ms_per_minute'); }));
  return fire ? idMessage(agents, codex, now) : '';
}

// Delivered turns before the same advisory is sent again (a changed set of idle agents is a new advisory and is sent at once); a
// repeat the model already holds is counted as suppressed (only when the interval is on: with 0 the dedupe is the old pending-only one, not this fix).
function idRepeatEvery() {
  var every = ah.settings.num('idle_sweep.num_repeat_every');
  return isFinite(every) && every > 0 ? every : 0;
}

function decide(p) {
  if (ah.env.get(ah.cfg('prompt_emit.judge_child_env')) === '1') return 'allow';
  if (spawn.osHome() === null) { ah.unable('idle-agent-sweep:no_home', 'abandoned'); return 'allow'; } // no absolute HOME: no dedupe state to keep
  if (!ah.settings.bool('idle_sweep.sw_enabled') || p === null || typeof p !== 'object' || ah.settings.skipped(ah.cfg('idle_sweep.skip_name'))) return 'allow';
  idPlan = null;
  var t = idAdvisory(p, idNow());
  if (idPlan !== null) {
    ah.commit();
    idleOrder.apply(idPlan);
    if (idPlan.due.length > 0) return { advisory: text.advisoryJson(ah.cfg('idle_sweep.event'), t) }; // the schedule is the repeat control
  }
  if (t === '') return 'allow';
  var emit = true, home = spawn.stateHome();
  if (home.guarded !== true) {
    emit = dedupe.shouldEmit({
      sessionId: p.session_id, transcriptPath: p.transcript_path, key: ah.cfg('idle_sweep.dedupe_key'), content: t,
      keepaliveTurns: idRepeatEvery(),
      normalize: function (x) { return x.replace(new RegExp(ah.cfg('idle_sweep.re_minutes'), 'g'), ''); },
    });
  }
  if (!emit && idRepeatEvery() > 0) ah.metric('misfire_suppressed', ['guard', 'idle-agent-sweep', 'reason', 'repeat_delivered']);
  return emit ? { advisory: text.advisoryJson(ah.cfg('idle_sweep.event'), t) } : 'allow';
}

// The idWaiting function of idle-agent-sweep.js as it was before the scan moved into the engine (#953), verbatim except for its name:
// the oracle ah-engine/src/checks/idle_agent_sweep/tests.rs compares the engine's answer to.
function idWaitingOld(tp, now, finished) {
  var tag = ah.cfg('idle_order.idle_marker'), lines = ah.fs.tailLines(tp, ah.cfgNum('idle_sweep.scan_bytes'), false, ah.cfg('idle_order.scan_needles').concat([tag]));
  if (lines === null || !Array.isArray(lines)) return [];
  var jsonRe = jx.re('idle_order.re_idle_json'), retaskRe = jx.re('idle_order.re_retask'), stopRe = jx.re('idle_order.re_stop'), goneRe = jx.re('idle_order.re_gone'), taskIdRe = jx.re('idle_order.re_task_id'), spawnTag = ah.cfg('idle_sweep.spawned_status'), resultField = ah.cfg('idle_order.spawn_result_field'), nameField = ah.cfg('idle_order.spawn_name_field'), state = {}, ended = {};
  lines.forEach(function (raw) {
    if (typeof raw !== 'string' || raw.length > ah.cfgNum('idle_order.line_max')) return;
    if (raw.indexOf(tag) >= 0) {
      var e = null;
      try { e = JSON.parse(raw); } catch (x) { e = null; }
      var c = e && e.message && typeof e.message.content === 'string' ? e.message.content : '';
      var m = jsonRe.exec(c), o = null;
      try { o = m ? JSON.parse(m[0]) : null; } catch (y) { o = null; }
      if (o && o.type === tag && typeof o.from === 'string') {
        var ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
        // a stopped or removed teammate stays gone: its last idle notice can land after the stop and must not list it again
        if (isFinite(ts) && ended[o.from] !== true) state[o.from] = { ms: ts, reason: typeof o.idleReason === 'string' ? o.idleReason : '' };
      }
      return;
    }
    // a teammate spawned again under a stopped name is a new one
    // read by structure: the record's prompt/description hold braces, so no pattern over the text can find its name field
    if (raw.indexOf(spawnTag) >= 0) {
      var rec = null;
      try { rec = JSON.parse(raw); } catch (z) { rec = null; }
      var res = rec && typeof rec === 'object' ? rec[resultField] : null;
      if (res && typeof res === 'object' && res.status === spawnTag && typeof res[nameField] === 'string') {
        delete ended[res[nameField]];
        var sid = res[ah.cfg('idle_order.spawn_id_field')];
        if (typeof sid === 'string' && sid !== '') idStopIds[res[nameField]] = sid;
      }
    }
    var gone = goneRe.exec(raw);
    if (gone && typeof gone[1] === 'string') { var gn = idStopName(gone[1]); ended[gn] = true; delete state[gn]; }
    if (stopRe.test(raw)) {
      // the teammate a stop names (task_id), seen or not yet idle
      var stopped = taskIdRe.exec(raw);
      if (stopped) { var sn = idStopName(stopped[1]); ended[sn] = true; delete state[sn]; }
    }
    // a message to a stopped teammate resumes it: it may idle (and be listed) again
    if (retaskRe.test(raw) && !stopRe.test(raw)) Object.keys(ended).forEach(function (n) { if (raw.indexOf('"' + n + '"') >= 0) delete ended[n]; });
    if (retaskRe.test(raw)) Object.keys(state).forEach(function (n) { if (raw.indexOf('"' + n + '"') >= 0) delete state[n]; });
  });
  var after = ah.cfgNum('idle_order.waiting_after_min') * ah.cfgNum('idle_order.ms_per_minute'), stale = ah.cfgNum('idle_sweep.stale_minutes') * ah.cfgNum('idle_sweep.ms_per_minute');
  var out = [];
  Object.keys(state).forEach(function (n) {
    var st = state[n], idle = now - st.ms;
    if (st.reason !== '' || finished.indexOf(n) >= 0 || idle < after || idle >= stale) return;
    out.push({ id: n, label: n, idleSinceMs: st.ms });
  });
  return out;
}


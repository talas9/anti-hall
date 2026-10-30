// Shared by delegate-only guards and the up-front switch notice: read-only spawn capability and guard predicates,
// and the once-per-state stand-down note. Keys and texts: session_switches.toml
// (standdown.*), spawn_guards.toml (spawn_usage.*), ctxbudget.toml (usage cache).
'use strict';

function swgUsageBuckets(home) {
  var rel = ah.cfg('ctxbudget.usage_cache'), path = ah.path.join(home, rel), size = ah.fs.size(path);
  if (size === null) return null;
  if (size > ah.cfgNum('script.read_max_bytes')) { ah.unable('swarm-guard:usage_big'); return null; }
  var raw = ah.fs.readText(path), parsed;
  if (raw === null) return null;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return null;
  var d = parsed.data, ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0, now = ah.clock.now();
  var pcts = ah.cfg('spawn_usage.bucket_pct'), resets = ah.cfg('spawn_usage.bucket_resets'), names = ah.cfg('spawn_usage.bucket_names'), out = [];
  for (var i = 0; i < pcts.length; i++) {
    var at = typeof d[resets[i]] === 'string' ? d[resets[i]] : null, pct = typeof d[pcts[i]] === 'number' ? d[pcts[i]] : 0;
    if (at) { var rt = new Date(at).getTime(); if (isFinite(rt) && rt < now) pct = 0; } // a window that already reset counts as empty
    else if (ts > 0 && (now - ts) > ah.cfgNum('ctxbudget.usage_max_stale_ms')) pct = 0; // a stale reading with no reset time
    out.push({ name: names[i], pct: pct, resetsAt: at });
  }
  return out;
}

// The fullest bucket {name, pct, resetsAt}, or null when there is no reading.
function swgFullest(buckets) {
  if (!buckets || !buckets.length) return null;
  return buckets.reduce(function (a, b) { return b.pct > a.pct ? b : a; });
}

function swgResetText(b) {
  var t = b.resetsAt ? new Date(b.resetsAt).getTime() : NaN;
  return isFinite(t) ? text.render(ah.cfg('spawn_usage.msg_resets_at'), { at: new Date(t).toISOString().slice(0, 16) + 'Z' }) : ah.cfg('spawn_usage.msg_resets_unknown');
}

// The ceiling at this usage: the base, less the reduce of the highest step whose percent the fullest bucket has reached, never under the floor.
function swgCeiling(full) {
  var ceil = ah.cfgNum('spawn_ceiling.base'), at = ah.cfg('spawn_ceiling.step_pct'), cut = ah.cfg('spawn_ceiling.step_reduce');
  if (full) for (var i = 0; i < at.length; i++) if (full.pct >= at[i]) ceil = ah.cfgNum('spawn_ceiling.base') - cut[i];
  return Math.max(ah.cfgNum('spawn_ceiling.floor'), ceil);
}

// The running agents of the session {n, names}, or null when they cannot be counted exactly (counted).
function swgRunning(p) {
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return null;
  var found = ah.transcript.agents(hookProc.open(p, tp));
  if (found === null) return null;
  if (found.unsure) { ah.unable('swarm-guard:ceiling_agents_unsure'); return null; }
  var tracked = ah.transcript.trackedAgents(p);
  var rows = found.rows.filter(function (a) {
    if (ah.cfg('spawn_ceiling.excluded_task_types').indexOf(a.taskType) >= 0) return false;
    var live = ah.transcript.trackedLiveness(a.id, tracked);
    return live === null ? !ah.cfg('spawn_ceiling.ignore_unknown_liveness') : live;
  });
  var max = ah.cfgNum('spawn_ceiling.list_max'), ctl = new RegExp(ah.cfg('spawn_ceiling.control_re'), 'g');
  var names = rows.slice(0, max).map(function (a) {
    return String(a.description || '').replace(ctl, ' ').trim().slice(0, ah.cfgNum('spawn_ceiling.desc_max')) || ah.cfg('spawn_ceiling.unnamed');
  });
  return { n: rows.length, names: names };
}


// The owner's cap count {n, names, toolUseIds} of the session, never null (a lower bound): the transcript's running agents (one of
// unknown liveness counts as running) united with the tracker's live children, whose launches may lie outside the transcript window
// (GH #494). toolUseIds: the launching tool call ids the transcript shows, which release their spawn reservations.
function swgCapRunning(p) {
  var tp = p.transcript_path, session = typeof p.session_id === 'string' ? p.session_id : '';
  var found = typeof tp === 'string' && tp !== '' ? ah.transcript.agents(hookProc.open(p, tp)) : null;
  if (found !== null && found.unsure) { ah.unable('swarm-guard:cap_agents_unsure'); found = null; }
  var tracked = ah.transcript.trackedAgents(p), rows = [], seen = {}, uses = {};
  if (!Array.isArray(tracked)) tracked = [];
  if (found !== null && Array.isArray(found.rows)) found.rows.forEach(function (a) {
    if (typeof a.toolUseId === 'string' && a.toolUseId !== '') uses[a.toolUseId] = true;
    if (ah.cfg('spawn_ceiling.excluded_task_types').indexOf(a.taskType) >= 0) return;
    if (ah.transcript.trackedLiveness(a.id, tracked) === false) return;
    seen[a.id] = true;
    rows.push(a.description);
  });
  tracked.forEach(function (t) {
    if (!t || t.id === session || t.parent !== session || seen[t.id] || seen[t.name]) return;
    if (ah.transcript.trackedLiveness(t.id, [t]) !== true) return;
    seen[t.id] = true;
    rows.push(t.name);
  });
  var max = ah.cfgNum('spawn_ceiling.list_max'), ctl = new RegExp(ah.cfg('spawn_ceiling.control_re'), 'g');
  var names = rows.slice(0, max).map(function (d) {
    return String(d || '').replace(ctl, ' ').trim().slice(0, ah.cfgNum('spawn_ceiling.desc_max')) || ah.cfg('spawn_ceiling.unnamed');
  });
  return { n: rows.length, names: names, toolUseIds: uses };
}

// The same fresh breaker marker gates every spawn and every non-report tool call. Read-only.
function bbMarker(p) {
  var id = p[ah.cfg('burn.agent_field')];
  if (typeof id !== 'string' || id === '') return null;
  if (!ah.settings.bool('burn.sw') || ah.settings.skipped(ah.cfg('burn.guard_name'))) return null;
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (!home) return null;
  var paths = ah.cfg('agent_tracker.paths'), key = '', max = ah.cfg('agent_reminders.key_max');
  for (var i = 0; i < id.length && i < max; i++) key += /[A-Za-z0-9._-]/.test(id.charAt(i)) ? id.charAt(i) : '_';
  var rel = ah.cfg('paths.base_dir') + '/' + paths.dir + '/' + ah.cfg('burn.marker_dir') + '/' + key + ah.cfg('burn.marker_ext');
  var marker = ah.path.join(home, rel);
  if (ah.fs.size(marker) === null) return null;
  var raw = ah.fs.readText(marker), m;
  if (raw === null) return null;
  try { m = JSON.parse(raw); } catch (e) { return null; }
  if (m === null || typeof m !== 'object' || typeof m.ts !== 'number' || ah.clock.now() - m.ts > ah.cfgNum('burn.marker_ttl_ms')) return null;
  return { marker: m, rel: rel };
}

// A request-local decision: never infer a session-wide ban from one rejected model choice.
var sd = {
  reason: function (stop) {
    return text.render(ah.cfg('standdown.reasons')[stop.kind], stop);
  },
  can_spawn: function (p) {
    p = jx.isObj(p) ? p : {};
    var opts = ah.request || {}, host = opts.host || p.host || (coordinator.isCodexPayload(p) ? ah.cfg('standdown.codex_host') : ah.cfg('dispatch.default_host'));
    var hosts = ah.cfg('standdown.hosts'), policy = hosts[host], tools = null;
    var fields = ah.cfg('standdown.tool_fields');
    for (var i = 0; i < fields.length && tools === null; i++) {
      if (Array.isArray(p[fields[i]])) tools = p[fields[i]];
      else if (Array.isArray(opts[fields[i]])) tools = opts[fields[i]];
    }
    var mode = ah.settings.enum('standdown.spawn_setting');
    var available = mode === 'on' || (mode !== 'off' && (!policy || (tools === null ? policy.default_available : tools.some(function (t) {
      var name = typeof t === 'string' ? t : (t && t.name);
      return policy.tools.indexOf(name) >= 0;
    }))));
    var stop = available ? null : { kind: 'host', host: host };
    if (stop === null && !ah.settings.bool('nested_spawn.setting') && !ah.settings.skipped(ah.cfg('nested_spawn.guard_name')) && coordinator.subagentByPayload(p)) stop = { kind: 'nested' };
    if (stop === null && bbMarker(p) !== null) stop = { kind: 'burn' };
    // Claude's budget gates are inside swarm-guard's switch; Codex spawns currently bypass these gates.
    if (stop === null && host !== ah.cfg('standdown.codex_host') && ah.settings.bool('swarm_guard.setting') && !ah.settings.skipped(ah.cfg('swarm_guard.guard_name'))) {
      stop = sd.spawnStop(p);
      if (stop === null && ah.settings.bool('spawn_ceiling.setting') && !ah.settings.skipped(ah.cfg('spawn_ceiling.guard_name'))) {
        var home = hookProc.home(p), run = swgRunning(p);
        if (home !== null && run !== null) {
          var ceiling = swgCeiling(swgFullest(swgUsageBuckets(home)));
          if (run.n >= ceiling) stop = { kind: 'ceiling', n: run.n, ceiling: ceiling };
        }
      }
    }
    if (stop === null && host !== ah.cfg('standdown.codex_host') && mrSpawnBan(p)) stop = { kind: 'routing' };
    return { allowed: stop === null, stop: stop };
  },
  // The usage hard stop for this call as {name, pct, resets}, or null when spawning is allowed (the guard is off or skipped, no
  // reading, or the fullest bucket is under spawn_usage.block_pct).
  spawnStop: function (p) {
    if (!ah.settings.bool('spawn_usage.setting') || ah.settings.skipped(ah.cfg('spawn_usage.guard_name'))) return null;
    var home = hookProc.home(p);
    if (home === null) return null;
    var full = swgFullest(swgUsageBuckets(home));
    if (full === null || full.pct < ah.cfgNum('spawn_usage.block_pct')) return null;
    return { kind: 'usage', name: full.name, pct: Math.round(full.pct), resets: swgResetText(full) };
  },
  // The stop when `guard` is a delegate-only guard that stands down for this call, else null.
  applies: function (p, guard) {
    if (!ah.settings.bool('standdown.setting') || ah.cfg('standdown.guards').indexOf(guard) < 0) return null;
    return sd.can_spawn(p).stop;
  },
  // The stand-down note, once per session and reset time ('' when already told or there is no session).
  note: function (p, stop) {
    var sid = p && typeof p.session_id === 'string' ? p.session_id : '';
    if (sid === '') return '';
    var what = text.render(ah.cfg('standdown.msg_what'), { reason: sd.reason(stop) });
    ah.commit();
    if (!adv.gate(ah.cfg('standdown.note_kind'), sid, what)) return '';
    return text.message('warn', ah.cfg('standdown.guard_name'), { what: what, why: ah.cfg('standdown.msg_why') });
  },
};

function mrRunsUpdate(corpus) {
  var mrT = function (key, t) { return ah.re.test(ah.cfg(key), 'i', t); };
  return mrT('model_routing.update_skill_path_re', corpus) || mrT('model_routing.update_slash_re', corpus) ||
    (mrT('model_routing.update_node_re', corpus) && corpus.toLowerCase().indexOf(ah.cfg('model_routing.update_qualifier')) >= 0);
}

// Only the update-in-session row denies every model. Strict mechanical routing still allows the cheap tier.
function mrSpawnBan(p) {
  if (ah.settings.skipped(ah.cfg('model_routing.guard_name')) || ah.settings.enum('model_routing.mode_setting') === ah.cfg('model_routing.off_mode') || !ah.settings.bool('model_routing.update_setting')) return false;
  var inp = jx.isObj(p.tool_input) ? p.tool_input : {};
  var corpus = jx.sliceUnits((typeof inp.description === 'string' ? inp.description : '') + '\n' + (typeof inp.prompt === 'string' ? inp.prompt : (typeof p.prompt === 'string' ? p.prompt : '')), ah.cfgNum('model_routing.scan_limit'));
  return mrRunsUpdate(corpus);
}

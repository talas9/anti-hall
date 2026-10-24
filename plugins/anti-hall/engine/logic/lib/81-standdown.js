// Shared by the guards that stand down while spawning is stopped (the usage hard stop of swarm-guard) and by the up-front switch
// notice: the usage reading, the hard-stop test and the once-per-reset stand-down note. Keys and texts: session_switches.toml
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

var sd = {
  // The usage hard stop for this call as {name, pct, resets}, or null when spawning is allowed (the guard is off or skipped, no
  // reading, or the fullest bucket is under spawn_usage.block_pct).
  spawnStop: function (p) {
    if (!ah.settings.bool('spawn_usage.setting') || ah.settings.skipped(ah.cfg('spawn_usage.guard_name'))) return null;
    var home = hookProc.home(p);
    if (home === null) return null;
    var full = swgFullest(swgUsageBuckets(home));
    if (full === null || full.pct < ah.cfgNum('spawn_usage.block_pct')) return null;
    return { name: full.name, pct: Math.round(full.pct), resets: swgResetText(full) };
  },
  // The stop when `guard` is a delegate-only guard that stands down for this call, else null.
  applies: function (p, guard) {
    if (!ah.settings.bool('standdown.setting') || ah.cfg('standdown.guards').indexOf(guard) < 0) return null;
    return sd.spawnStop(p);
  },
  // The stand-down note, once per session and reset time ('' when already told or there is no session).
  note: function (p, stop) {
    var sid = p && typeof p.session_id === 'string' ? p.session_id : '';
    if (sid === '') return '';
    var what = text.render(ah.cfg('standdown.msg_what'), { limit: stop.name, pct: stop.pct, resets: stop.resets });
    ah.commit();
    if (!adv.gate(ah.cfg('standdown.note_kind'), sid, what)) return '';
    return text.message('warn', ah.cfg('standdown.guard_name'), { what: what, why: ah.cfg('standdown.msg_why') });
  },
};

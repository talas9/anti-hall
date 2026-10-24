// check = "switch-notice" (run by the dispatcher on UserPromptSubmit and PreToolUse, not a hook row of its own; engine-only). Tells
// the agent ONE short line when the set of session-wide switches changes: the spawn-usage stop, limit conserve, and a guard skip set
// or just expired in ~/.anti-hall/skip.json. The line is a state table of the advisory layer (lib/79-advisory.js), so the same state
// is never told twice and a change (including back to normal) is told once, at whichever of the two events comes first.
// Keys and texts: session_switches.toml (upfront.*, standdown.*).
'use strict';

// The limit-conserve state {reason} or null: the manual mode, or a usage bucket at or over the threshold (the account-change refinement
// of limit-conserve-inject is left out: this only reports).
function snConserving(home) {
  var mode = ah.settings.enum('ctxbudget.set_limit_mode');
  if (mode === 'on') return { reason: ah.cfg('ctxbudget.lc_reason_manual') };
  if (mode === 'off' || ah.settings.skipped(ah.cfg('ctxbudget.skip_limit_conserve'))) return null;
  var size = ah.fs.size(home + '/' + ah.cfg('ctxbudget.usage_cache'));
  if (size === null || size > ah.cfgNum('script.read_max_bytes')) return null;
  var raw = ah.fs.readText(home + '/' + ah.cfg('ctxbudget.usage_cache')), parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return null;
  var d = parsed.data, now = ah.clock.now(), threshold = ah.settings.num('ctxbudget.set_limit_threshold');
  var pcts = ah.cfg('ctxbudget.lc_bucket_pct'), resets = ah.cfg('ctxbudget.lc_bucket_resets'), names = ah.cfg('ctxbudget.lc_bucket_trip'), trips = [];
  for (var i = 0; i < pcts.length; i++) {
    var pct = typeof d[pcts[i]] === 'number' ? d[pcts[i]] : 0, at = d[resets[i]];
    if (typeof at === 'string') { var t = new Date(at).getTime(); if (isFinite(t) && t < now) pct = 0; }
    if (pct >= threshold) trips.push(names[i]);
  }
  return trips.length ? { reason: trips.join('+') } : null;
}

// The guard skips {live: [names], expired: [names]} of the skip file; an entry that expired longer ago than upfront.expired_window_ms is history.
function snSkips(home) {
  var out = { live: [], expired: [] };
  var rel = home + '/' + ah.cfg('guardkit.skip_file'), size = ah.fs.size(rel);
  if (size === null || size > ah.cfgNum('script.read_max_bytes')) return out;
  var o;
  try { o = JSON.parse(ah.fs.readText(rel)); } catch (e) { return out; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  var now = ah.clock.now(), win = ah.cfgNum('upfront.expired_window_ms');
  Object.keys(o).sort().forEach(function (k) {
    var t = o[k];
    if (typeof t !== 'number' || !isFinite(t)) return;
    if (t > now) out.live.push(k);
    else if (now - t <= win) out.expired.push(k);
  });
  return out;
}

function decide(p, opts, event) {
  if (!jx.isObj(p) || !ah.settings.bool('upfront.setting')) return 'allow';
  if (ah.cfg('upfront.events').indexOf(event) < 0) return 'allow';
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  if (sid === '') return 'allow';
  var home = hookProc.home(p);
  if (home === null) return 'allow';
  var lines = [], stop = sd.spawnStop(p), conserve = snConserving(home), skips = snSkips(home), join = ah.cfg('upfront.guards_join');
  if (stop !== null) lines.push(text.render(ah.cfg('upfront.msg_spawn_stop'), { limit: stop.name, pct: stop.pct, resets: stop.resets }));
  if (conserve !== null) lines.push(text.render(ah.cfg('upfront.msg_conserve'), { reason: conserve.reason }));
  if (skips.live.length) lines.push(text.render(ah.cfg('upfront.msg_skip_set'), { guards: skips.live.join(join) }));
  if (skips.expired.length) lines.push(text.render(ah.cfg('upfront.msg_skip_expired'), { guards: skips.expired.join(join) }));
  var kind = ah.cfg('upfront.kind'), content = lines.join(ah.cfg('upfront.join'));
  var d = adv.decide(kind, sid, content);
  // nothing active and nothing was ever told: silent; nothing active after a told state: the all-clear line, once
  if (content === '' && d.e.n === 0) return 'allow';
  if (!d.emit) return 'allow';
  ah.commit();
  adv.commit(d);
  var line = text.message('tip', ah.cfg('upfront.guard_name'), { what: content === '' ? ah.cfg('upfront.msg_clear') : content });
  return { advisory: text.advisoryJson(event, line) };
}

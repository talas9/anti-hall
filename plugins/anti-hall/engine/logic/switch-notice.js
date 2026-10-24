// check = "switch-notice" (UserPromptSubmit and PreToolUse, engine-only dispatch row). Tells
// the agent ONE short line when the set of session-wide switches changes: the spawn-usage stop, limit conserve, and a guard skip set
// or just expired in ~/.anti-hall/skip.json. The line is a state table of the advisory layer (lib/79-advisory.js), so the same state
// is never told twice and a change (including back to normal) is told once, at whichever of the two events comes first.
// Keys and texts: session_switches.toml (upfront.*, standdown.*).
'use strict';

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
  var lines = [], availability = sd.can_spawn(p), stop = availability.stop, conserve = lcSessionConserving(p, { w: null }), skips = snSkips(home), join = ah.cfg('upfront.guards_join');
  if (stop !== null) lines.push(text.render(ah.cfg('upfront.msg_spawn_stop'), { reason: sd.reason(stop) }));
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

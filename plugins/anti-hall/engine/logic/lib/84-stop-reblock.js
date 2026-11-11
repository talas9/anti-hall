// #709: bounded repeats of an unchanged coordination Stop block. Safety checks never opt in.
// Persistence is immediate: another Stop may arrive before any assistant reply is recorded.
'use strict';
var stopReblock = {
  stable: function (v) {
    if (Array.isArray(v)) return v.map(stopReblock.stable);
    if (typeof v === 'string') return stopReblock.normal(v);
    if (!v || typeof v !== 'object') return v;
    var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = stopReblock.stable(v[k]); }); return o;
  },
  normal: function (s) {
    ah.cfg('stop_reblock.normalise').forEach(function (pat) { s = s.replace(new RegExp(pat, 'gi'), ' '); });
    return s.replace(/\s+/g, ' ').trim();
  },
  finish: function (guard, p, result, state) {
    if (!ah.settings.bool('stop_reblock.setting') || !p || !p.session_id) return result;
    if (ah.cfg('stop_reblock.excluded').indexOf(guard) >= 0 || ah.cfg('stop_reblock.guards').indexOf(guard) < 0) return result;
    if (!result || !result.exact || typeof result.exact.out !== 'string') return result;
    var lines = result.exact.out.trim().split('\n'), block = null, at = -1;
    lines.forEach(function (line, i) {
      var o; try { o = JSON.parse(line); } catch (e) { return; }
      if (o && o.decision === 'block' && typeof o.reason === 'string') { block = o; at = i; }
    });
    if (block === null) return result;
    var normal = stopReblock.normal(block.reason);
    var sig = ah.sha1(JSON.stringify([normal, stopReblock.stable(state)]));
    var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('stop_reblock.path').dir + '/' + ah.sha1(String(p.session_id)) + ah.cfg('stop_reblock.path').ext;
    var lock = ah.cfg('stop_reblock.lock'), held;
    try { held = ah.state.flock(rel + lock.suffix, lock.group, lock.wait_ms); } catch (e) { return result; }
    if (typeof held !== 'number') return result;
    try { return stopReblock.held(guard, result, lines, at, sig, rel); } finally { ah.state.unlock(held); }
  },
  held: function (guard, result, lines, at, sig, rel) {
    var raw = ah.state.readText(rel), doc = {}, prior;
    try { doc = JSON.parse(raw); } catch (e) { doc = {}; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
    prior = doc[guard];
    var count = prior && prior.sig === sig && typeof prior.count === 'number' && isFinite(prior.count) && prior.count >= 0 ? prior.count : 0;
    var max = ah.settings.num('stop_reblock.max_setting');
    if (!isFinite(max) || max < 0) return result;
    max = Math.floor(max);
    var release = count > max;
    doc[guard] = { sig: sig, count: release ? count : count + 1, announced: release || false };
    // An unwritable record cannot prove that a repeat budget was spent. Preserve the guard's decision.
    try { if (!ah.state.writeAtomic(rel, JSON.stringify(doc))) return result; } catch (e) { return result; }
    if (!release) return result;
    ah.metric('waste_events_total', ['category', ah.cfg('stop_reblock.category'), 'source', guard]);
    lines.splice(at, 1);
    return { exact: { code: 0, out: lines.filter(Boolean).join('\n') + (lines.some(Boolean) ? '\n' : ''),
      err: result.exact.err + (prior && prior.announced ? '' : text.render(ah.cfg('stop_reblock.released'), { guard: guard })) } };
  },
};

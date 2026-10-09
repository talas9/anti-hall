// check = "codex-quota-detect" (PostToolUse on Agent; advisory only). When a codex:codex-rescue Agent call comes back with a quota or
// rate-limit exhaustion message, it records the outage ONCE in the shared availability file instead of every lane rediscovering it on its
// next spawn, and says so. It fires only for an Agent whose subagent type names the Codex rescue seat, and scans the tool result
// (tool_response / tool_output, whichever the harness populates) for the quota message. A result whose text only V8's key order can fix, or
// a date only V8 reads exactly, defers. This script builds on codex-availability.js (script.includes). Mirrors hooks/codex-quota-detect.js.
// Keys and texts: codex_handover.toml (codex_handover.*).
'use strict';

// True when no object inside `v` has more than one key (so JSON.stringify gives Node's text whatever order the keys arrive in).
function cxOrderSafe(v) {
  if (Array.isArray(v)) return v.every(cxOrderSafe);
  if (v !== null && typeof v === 'object') { var ks = Object.keys(v); return ks.length <= 1 && ks.every(function (k) { return cxOrderSafe(v[k]); }); }
  return true;
}

// True when some string (a key or a value) anywhere in `v` could be part of a quota message.
function cxMentions(v) {
  if (typeof v === 'string') return !cxCannotMatch(v);
  if (Array.isArray(v)) return v.some(cxMentions);
  if (v !== null && typeof v === 'object') return Object.keys(v).some(function (k) { return !cxCannotMatch(k) || cxMentions(v[k]); });
  return false;
}

// The text the quota words are searched in: a string, '' for nothing, or null when the Node hook must decide.
function cxBlob(p) {
  var parts = [], skipped = false;
  var keys = ['tool_response', 'tool_output'];
  for (var i = 0; i < keys.length; i++) {
    var v = p[keys[i]];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') { parts.push(v); continue; }
    if (cxOrderSafe(v)) parts.push(JSON.stringify(v));
    else if (cxMentions(v)) return null;
    else skipped = true;
  }
  // a part left out has an unknown length, which would move where the scan cap cuts the others
  if (skipped && parts.length > 0) return null;
  if (skipped) return '';
  var joined = parts.join('\n'), cap = cxN('detect_scan_cap');
  if (joined.length > cap) {
    var last = joined.charCodeAt(cap - 1);
    if (last >= 0xd800 && last <= 0xdbff) return null;
    return joined.slice(0, cap);
  }
  return joined;
}

function decide(p) {
  if (!ah.settings.bool('codex_handover.setting_quota_detect')) return 'allow';
  if (!jx.isObj(p) || p.tool_name !== 'Agent') return 'allow';
  var input = p.tool_input, sub = jx.isObj(input) ? (input.subagent_type || input.agentType || input.agent_type) : undefined;
  if (typeof sub !== 'string' || !new RegExp(cxT('rescue_re'), 'i').test(sub.trim())) return 'allow';
  var blob = cxBlob(p);
  if (blob === null) return 'defer';
  if (blob === '') return 'allow';
  var hit = cxDetect(blob);
  if (hit === 'unsure') return 'defer';
  if (hit === null) return 'allow';
  var home = cxHome();
  if (home === null) return 'defer';
  if (cxRecordQuota(home, hit.until, hit.reason, ah.clock.now()) === null) return 'defer';
  var until;
  if (hit.until) {
    try { until = new Date(hit.until).toISOString(); } catch (e) { return 'allow'; } // toISOString threw: the advisory is skipped, the record already written
  } else until = cxT('cooldown_default_label');
  var t = text.message('warn', cxT('quota_guard'), { what: text.render(cxT('quota_what'), { reason: hit.reason }), why: text.render(cxT('quota_why'), { until: until }), instead: cxT('quota_instead') });
  return { advisory: text.advisoryJson(cxT('quota_event'), t) };
}

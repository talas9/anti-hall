// check = "codex-quota-detect" (PostToolUse on Agent; advisory only). When a codex:codex-rescue Agent call comes back with a quota or
// rate-limit exhaustion message, it records the outage ONCE in the shared availability file instead of every lane rediscovering it on its
// next spawn, and says so. It fires only for an Agent whose subagent type names the Codex rescue seat, and scans the tool result
// (tool_response / tool_output, whichever the harness populates) for the quota message. A result whose text only V8's key order can fix, or
// a date only V8 reads exactly, records the default cooldown (counted). This script builds on codex-availability.js (script.includes). Mirrors hooks/codex-quota-detect.js.
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

// The text the quota words are searched in: a string, '' for nothing.
function cxBlob(p) {
  var parts = [], skipped = false;
  var keys = ['tool_response', 'tool_output'];
  for (var i = 0; i < keys.length; i++) {
    var v = p[keys[i]];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') { parts.push(v); continue; }
    if (cxOrderSafe(v)) parts.push(JSON.stringify(v));
    else if (cxMentions(v)) { ah.unable('codex-quota-detect:key_order'); parts.push(JSON.stringify(v)); } // the host's key order is unknown: the text is searched in the order given
    else skipped = true;
  }
  // a part left out has an unknown length, which would move where the scan cap cuts the others
  if (skipped && parts.length > 0) ah.unable('codex-quota-detect:part_skipped');
  if (skipped) return '';
  var joined = parts.join('\n'), cap = cxN('detect_scan_cap');
  if (joined.length > cap) {
    var last = joined.charCodeAt(cap - 1);
    if (last >= 0xd800 && last <= 0xdbff) { ah.unable('codex-quota-detect:surrogate_cut'); return cxStripEcho(joined.slice(0, cap - 1), p); }
    return cxStripEcho(joined.slice(0, cap), p);
  }
  return cxStripEcho(joined, p);
}

// The result without the lines of the agent's own prompt (and their JSON-escaped forms): a result that echoes the brief back is not a quota message.
function cxStripEcho(blob, p) {
  var input = p.tool_input, prompt = jx.isObj(input) ? input.prompt : undefined;
  if (typeof prompt !== 'string' || prompt === '') return blob;
  var min = cxN('detect_echo_min_chars'), lines = prompt.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l.length < min) continue;
    blob = blob.split(l).join('');
    var esc = JSON.stringify(l).slice(1, -1);
    if (esc !== l) blob = blob.split(esc).join('');
  }
  return blob;
}

function decide(p) {
  if (!ah.settings.bool('codex_handover.setting_quota_detect')) return 'allow';
  if (!jx.isObj(p) || p.tool_name !== 'Agent') return 'allow';
  var input = p.tool_input, sub = jx.isObj(input) ? (input.subagent_type || input.agentType || input.agent_type) : undefined;
  if (typeof sub !== 'string' || !new RegExp(cxT('rescue_re'), 'i').test(sub.trim())) return 'allow';
  var blob = cxBlob(p);
  if (blob === '') return 'allow';
  var hit = cxDetect(blob);
  if (hit === 'unsure') { ah.unable('codex-quota-detect:reason_unsure', 'abandoned'); return 'allow'; } // a reason cut through a surrogate pair: the text cannot match Node's
  if (hit === null) return 'allow';
  if (hit.dateUnsure) ah.unable('codex-quota-detect:date_unsure'); // a date only V8 reads exactly: the outage is recorded with the default cooldown
  var home = cxHome();
  if (home === null) { ah.unable('codex-quota-detect:no_home', 'abandoned'); return 'allow'; } // no usable home: no state to keep
  if (cxRecordQuota(home, hit.until, hit.reason, ah.clock.now()) === null) ah.unable('codex-quota-detect:record_unsure'); // the warning still goes out
  var until;
  if (hit.until) {
    try { until = new Date(hit.until).toISOString(); } catch (e) { return 'allow'; } // toISOString threw: the advisory is skipped, the record already written
  } else until = cxT('cooldown_default_label');
  var t = text.message('warn', cxT('quota_guard'), { what: text.render(cxT('quota_what'), { reason: hit.reason }), why: text.render(cxT('quota_why'), { until: until }), instead: cxT('quota_instead') });
  return { advisory: text.advisoryJson(cxT('quota_event'), t) };
}

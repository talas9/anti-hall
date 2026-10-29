// Shared reader of the advisor rules (GH #404): is the advisor tool present in this session, where its calls and the last user
// message sit in the transcript tail, and the per-session retry state. Offsets are transcript byte offsets (monotonic), so
// "called since X" is an offset comparison. Every name, size and pattern: advisor.* in advisor.toml. Reads fail open (null).
'use strict';
var advisorKit = {
  // The tool names in `p`'s tool-list fields.
  payloadTools: function (p) {
    var out = [], keys = ah.cfg('advisor.payload_tool_keys');
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]];
      if (!Array.isArray(v)) continue;
      for (var j = 0; j < v.length; j++) {
        if (typeof v[j] === 'string') out.push(v[j]);
        else if (jx.isObj(v[j]) && typeof v[j].name === 'string') out.push(v[j].name);
      }
    }
    return out;
  },
  // {lastAdvisor, lastUser, any} from the transcript tail: byte offsets of the newest advisor tool call and the newest real user
  // message (-1 when none in the window), `any` true when the window holds an advisor call; null when the transcript is unreadable.
  scan: function (p) {
    var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
    if (!tp || !ah.path.isAbsolute(tp)) return null;
    var r = ah.transcript.tailEntries(tp, ah.cfgNum('advisor.window_bytes'), ah.cfgNum('advisor.line_max_bytes'),
      [['type'], ['message', 'content'], ['message', 'content', '*', 'type'], ['message', 'content', '*', 'name']], ah.cfgNum('advisor.max_lines'));
    if (r === null || !r.lines) return null;
    var names = ah.cfg('advisor.tool_names'), types = ah.cfg('advisor.block_types');
    var out = { lastAdvisor: -1, lastUser: -1, any: false };
    for (var i = 0; i < r.lines.length; i++) {
      var off = r.lines[i][0], e = r.lines[i][1];
      if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { continue; } }
      if (!jx.isObj(e) || !jx.isObj(e.message)) continue;
      var c = e.message.content;
      if (e.type === 'user') {
        var real = typeof c === 'string' && c !== '';
        if (Array.isArray(c)) for (var k = 0; k < c.length; k++) if (jx.isObj(c[k]) && c[k].type === 'text') real = true;
        if (real && off > out.lastUser) out.lastUser = off;
      } else if (e.type === 'assistant' && Array.isArray(c)) {
        for (var b = 0; b < c.length; b++) {
          var blk = c[b];
          if (jx.isObj(blk) && types.indexOf(blk.type) >= 0 && names.indexOf(blk.name) >= 0) { out.any = true; if (off > out.lastAdvisor) out.lastAdvisor = off; }
        }
      }
    }
    return out;
  },
  // Does the session have an advisor tool? The payload's tool list, else an advisor call anywhere in the transcript tail.
  present: function (p, scan) {
    var names = ah.cfg('advisor.tool_names'), listed = advisorKit.payloadTools(p);
    for (var i = 0; i < listed.length; i++) if (names.indexOf(listed[i]) >= 0) return true;
    return scan !== null && scan.any;
  },
  // Block once per trigger: the advisory layer's hash gate (an unchanged trigger is held back) and per-kind cap, with its counters.
  gate: function (kindKey, p, trigger) {
    return adv.gate(ah.cfg(kindKey), advisorKit.scope(p), trigger);
  },
  block: function (what, instead) {
    var reason = text.message('block', ah.cfg('advisor.guard_name'), { what: what, why: ah.cfg('advisor.msg_why'), instead: instead, override: '' });
    return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
  },
  stopping: function (p) { return p.stop_hook_active === true; },
  // The state owner: the session, or the subagent inside it (a payload with an agent_id): subagents never share the main thread's state.
  scope: function (p) {
    var sid = typeof p.session_id === 'string' ? p.session_id : '';
    return typeof p.agent_id === 'string' && p.agent_id !== '' ? sid + '.' + p.agent_id : sid;
  },
  stateRel: function (p) {
    var safe = String(advisorKit.scope(p) || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('advisor.session_safe_max'));
    return ah.cfg('paths.base_dir') + '/' + ah.cfg('advisor.state_prefix') + '-' + safe + ah.cfg('advisor.state_ext');
  },
  // {fail: null | {advisorAt, files: [edited before the failure]}, edits: {file: n}}; anything unreadable is a fresh state.
  load: function (p) {
    var raw = null;
    try { raw = ah.state.readText(advisorKit.stateRel(p)); } catch (e) { raw = null; }
    if (raw !== null) {
      var r = jx.parse(raw);
      if (!r.unsure && !r.invalid && jx.isObj(r.v) && jx.isObj(r.v.edits)) return r.v;
    }
    return { fail: null, edits: {} };
  },
  save: function (p, st) { try { ah.state.writeAtomic(advisorKit.stateRel(p), JSON.stringify(st)); } catch (e) { /* best effort */ } },
};

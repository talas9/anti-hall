// Shared reader of the advisor rules (GH #404): is the advisor tool present in this session, where its calls and the last owner
// message sit in the transcript, the main model, and the per-agent state. Offsets are transcript byte offsets (monotonic), so
// "called since X" is an offset comparison. Phase 3: a subagent is read from its OWN transcript (never the main one), and what a
// scan saw is folded into the state (fold), so "advisor seen" and the newest offsets survive past the tail window. Every name,
// size and pattern: advisor.* in advisor.toml. Reads fail open (null).
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
  // The transcript this hook call belongs to: the main session's, or a subagent's own (payload field, else advisor.agent_transcript_tpl).
  // '' when a subagent's own transcript cannot be found: its rules then stay silent rather than read the main thread's.
  transcript: function (p) {
    var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
    if (typeof p.agent_id !== 'string' || p.agent_id === '') return tp;
    var keys = ah.cfg('advisor.agent_transcript_keys');
    for (var i = 0; i < keys.length; i++) if (typeof p[keys[i]] === 'string' && p[keys[i]] !== '') return p[keys[i]];
    var ext = ah.cfg('advisor.transcript_ext'), cut = tp.lastIndexOf('/');
    if (!tp || cut < 0 || tp.slice(-ext.length) !== ext) return '';
    var own = text.render(ah.cfg('advisor.agent_transcript_tpl'), { dir: tp.slice(0, cut), session: tp.slice(cut + 1, tp.length - ext.length), agent: p.agent_id });
    return ah.fs.isFile(own) ? own : '';
  },
  // Is a user entry the owner typing (not harness text, a reminder, a task notification or a peer)?
  owner: function (e) {
    if (e[ah.cfg('advisor.owner_skip_meta')] === true) return false;
    if (jx.isObj(e.origin) && typeof e.origin.kind === 'string' && ah.cfg('advisor.owner_origin_kinds').indexOf(e.origin.kind) < 0) return false;
    var c = e.message.content, skip = ah.cfg('advisor.non_owner_text_re');
    if (typeof c === 'string') return c !== '' && !ah.re.test(skip, 'r', c);
    if (!Array.isArray(c)) return false;
    for (var k = 0; k < c.length; k++) if (jx.isObj(c[k]) && c[k].type === 'text' && typeof c[k].text === 'string' && !ah.re.test(skip, 'r', c[k].text)) return true;
    return false;
  },
  ts: function (e) { var t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN; return isFinite(t) ? t : -1; },
  // {path, size, lastAdvisor, lastUser, any, calls: [{off, ts, userTs}], model, sayAt} from the transcript tail: byte offsets of the
  // newest advisor call or result and the newest owner message (-1 when none in the window), the newest known main model, the newest
  // assistant text announcing an advisor call; null when the transcript is unreadable.
  scan: function (p) {
    var tp = advisorKit.transcript(p);
    if (!tp || !ah.path.isAbsolute(tp)) return null;
    var r = ah.transcript.tailEntries(tp, ah.cfgNum('advisor.window_bytes'), ah.cfgNum('advisor.line_max_bytes'),
      [['type'], ['isMeta'], ['origin', 'kind'], ['timestamp'], ['message', 'model'], ['message', 'content'], ['message', 'content', '*', 'type'],
        ['message', 'content', '*', 'name'], ['message', 'content', '*', 'text']], ah.cfgNum('advisor.max_lines'));
    if (r === null || !r.lines) return null;
    var names = ah.cfg('advisor.tool_names'), types = ah.cfg('advisor.block_types'), results = ah.cfg('advisor.result_types');
    var flag = ah.cfg('advisor.flagship_model_re'), known = ah.cfg('advisor.known_model_re'), say = ah.cfg('advisor.say_do_re');
    var out = { path: tp, size: ah.fs.size(tp), lastAdvisor: -1, lastUser: -1, any: false, calls: [], model: null, sayAt: -1 };
    var userTs = -1;
    for (var i = 0; i < r.lines.length; i++) {
      var off = r.lines[i][0], e = r.lines[i][1];
      if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { continue; } }
      if (!jx.isObj(e) || !jx.isObj(e.message)) continue;
      var c = e.message.content;
      if (e.type === 'user') {
        if (advisorKit.owner(e) && off > out.lastUser) { out.lastUser = off; userTs = advisorKit.ts(e); out.sayAt = -1; }
      } else if (e.type === 'assistant') {
        var m = e.message.model;
        if (typeof m === 'string' && m !== '' && (ah.re.test(known, 'r', m) || ah.re.test(flag, 'r', m))) out.model = m;
        if (!Array.isArray(c)) continue;
        for (var b = 0; b < c.length; b++) {
          var blk = c[b];
          if (!jx.isObj(blk)) continue;
          if (types.indexOf(blk.type) >= 0 && names.indexOf(blk.name) >= 0) {
            out.any = true; out.calls.push({ off: off, ts: advisorKit.ts(e), userTs: userTs });
            if (off > out.lastAdvisor) out.lastAdvisor = off;
          } else if (results.indexOf(blk.type) >= 0) {
            out.any = true;
            if (off > out.lastAdvisor) out.lastAdvisor = off;
          } else if (blk.type === 'text' && typeof blk.text === 'string' && ah.re.test(say, 'r', blk.text)) {
            if (off > out.sayAt) out.sayAt = off;
          }
        }
      }
    }
    return out;
  },
  // The scan folded into the state `st` (st.tx): the newest owner message and advisor call ever seen, "advisor seen" and the main model
  // survive a tail window that no longer holds them. A different transcript or a shorter file (rewritten) starts the fold afresh.
  // Returns the folded view {lastAdvisor, lastUser, seen, model, sayAt, scan} or null when the transcript is unreadable.
  fold: function (p, st) {
    var s = advisorKit.scan(p);
    if (s === null) return null;
    var tx = jx.isObj(st.tx) ? st.tx : null;
    if (tx === null || tx.path !== s.path || (typeof s.size === 'number' && typeof tx.size === 'number' && s.size < tx.size)) tx = { path: s.path, size: 0, lastAdvisor: -1, lastUser: -1, seen: false, model: null };
    tx.size = typeof s.size === 'number' ? s.size : tx.size;
    if (s.lastAdvisor > tx.lastAdvisor) tx.lastAdvisor = s.lastAdvisor;
    if (s.lastUser > tx.lastUser) tx.lastUser = s.lastUser;
    if (s.any) tx.seen = true;
    if (s.model !== null) tx.model = s.model;
    st.tx = tx;
    return { lastAdvisor: tx.lastAdvisor, lastUser: tx.lastUser, seen: tx.seen, model: tx.model, sayAt: s.sayAt, scan: s };
  },
  // Does the session have an advisor tool? The payload's tool list, else an advisor call in the transcript tail or seen before (fold).
  present: function (p, scan, view) {
    var names = ah.cfg('advisor.tool_names'), listed = advisorKit.payloadTools(p);
    for (var i = 0; i < listed.length; i++) if (names.indexOf(listed[i]) >= 0) return true;
    if (view && view.seen) return true;
    return scan !== null && scan !== undefined && scan.any;
  },
  // Is the main model a flagship? null when no known model was seen (the phase-3 rules are then silent).
  flagship: function (model) {
    if (typeof model !== 'string' || model === '') return null;
    return ah.re.test(ah.cfg('advisor.flagship_model_re'), 'r', model);
  },
  // Block once per trigger: the advisory layer's hash gate (an unchanged trigger is held back) and per-kind cap, with its counters.
  gate: function (kindKey, p, trigger) {
    return adv.gate(ah.cfg(kindKey), advisorKit.scope(p), trigger);
  },
  block: function (what, instead, why) {
    var reason = text.message('block', ah.cfg('advisor.guard_name'), { what: what, why: why || ah.cfg('advisor.msg_why'), instead: instead, override: '' });
    return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
  },
  advise: function (event, t) { return { exact: { code: 0, out: text.advisoryJson(event, t) + '\n', err: '' } }; },
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
  // {fail: null | {advisorAt, files: [edited before the failure]}, edits: {file: n}, tx, tasks, fixes, sayDo, nudge}; anything
  // unreadable is a fresh state.
  load: function (p) {
    var raw = null;
    try { raw = ah.state.readText(advisorKit.stateRel(p)); } catch (e) { raw = null; }
    if (raw !== null) {
      var r = jx.parse(raw);
      if (!r.unsure && !r.invalid && jx.isObj(r.v) && jx.isObj(r.v.edits)) return r.v;
    }
    return { fail: null, edits: {} };
  },
  // Adherence monitoring (GH #404 phase 2): count one event of `name` in the session's own tally and in the engine-wide advisory
  // counters (kind `kindKey`, metric `metric`, a key of advisory.metric_names).
  bump: function (st, name, kindKey, metric) {
    if (!jx.isObj(st.stats)) st.stats = {};
    st.stats[name] = (typeof st.stats[name] === 'number' ? st.stats[name] : 0) + 1;
    adv.metric(ah.cfg(kindKey), metric);
  },
  // A counter whose name is built from a template of advisor.toml (a thinking type, a latency bucket): bounded by those lists.
  raw: function (kindKey, name) { ah.advisory(ah.cfg(kindKey), name); },
  // Count the advisor calls the transcript scan shows that were not counted yet (offsets past st.counted), once each: nudged (a
  // phase-3 nudge or block was pending) or spontaneous, and the time from the owner's message to the call, bucketed.
  // Returns true when the state changed.
  consults: function (st, scan) {
    if (scan === null || scan === undefined || !Array.isArray(scan.calls)) return false;
    var done = typeof st.counted === 'number' ? st.counted : -1, top = done;
    for (var i = 0; i < scan.calls.length; i++) {
      var call = scan.calls[i];
      if (call.off <= done) continue;
      advisorKit.bump(st, 'consults', 'advisor.kind_consult', 'consult');
      if (jx.isObj(st.nudge) && st.nudge.at < call.off) { advisorKit.bump(st, 'nudged', 'advisor.kind_consult', 'consult_nudged'); st.nudge = null; }
      else advisorKit.bump(st, 'spontaneous', 'advisor.kind_consult', 'consult_spontaneous');
      if (call.ts >= 0 && call.userTs >= 0 && call.ts >= call.userTs) advisorKit.raw('advisor.kind_consult', advisorKit.bucket((call.ts - call.userTs) / 1000));
      if (call.off > top) top = call.off;
    }
    st.counted = top;
    return top !== done;
  },
  bucket: function (secs) {
    var b = ah.cfg('advisor.latency_buckets_s');
    for (var i = 0; i < b.length; i++) if (secs <= b[i]) return text.render(ah.cfg('advisor.metric_latency_le_tpl'), { s: b[i] });
    return text.render(ah.cfg('advisor.metric_latency_gt_tpl'), { s: b[b.length - 1] });
  },
  // Keep at most advisor.tasks_max keys of map `m` (the numerically or insertion oldest go first).
  trim: function (m) {
    var keys = Object.keys(m), max = ah.cfgNum('advisor.tasks_max');
    for (var i = 0; i < keys.length - max; i++) delete m[keys[i]];
  },
  save: function (p, st) { try { ah.state.writeAtomic(advisorKit.stateRel(p), JSON.stringify(st)); } catch (e) { /* best effort */ } },
};

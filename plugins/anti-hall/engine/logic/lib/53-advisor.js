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
  // Claude Code keeps a subagent's transcript at <dir>/<session>/subagents/agent-<agent_id>.jsonl and writes `agentId` on its first
  // line. In order: a payload field naming it, transcript_path when it already is that file, else the template from the main path.
  // A file whose head names another agent is a mismatch: silent, never the main transcript credited to a subagent.
  transcript: function (p) {
    var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
    if (typeof p.agent_id !== 'string' || p.agent_id === '') return tp;
    var own = '', keys = ah.cfg('advisor.agent_transcript_keys');
    for (var i = 0; i < keys.length && own === ''; i++) if (typeof p[keys[i]] === 'string' && p[keys[i]] !== '') own = p[keys[i]];
    var ext = ah.cfg('advisor.transcript_ext'), cut = tp.lastIndexOf('/');
    if (own === '' && tp !== '' && ah.path.basename(tp) === text.render(ah.cfg('advisor.agent_file_tpl'), { agent: p.agent_id }) + ext) own = tp;
    if (own === '' && tp !== '' && cut >= 0 && tp.slice(-ext.length) === ext) {
      own = text.render(ah.cfg('advisor.agent_transcript_tpl'), { dir: tp.slice(0, cut), session: tp.slice(cut + 1, tp.length - ext.length), agent: p.agent_id });
    }
    if (own === '' || !ah.fs.isFile(own)) { advisorKit.silence('no_agent_transcript'); return ''; }
    var head = ah.fs.readText(own, ah.cfgNum('advisor.agent_head_bytes'));
    var m = typeof head === 'string' ? ah.re.find(ah.cfg('advisor.agent_id_re'), 'r', head) : null;
    if (Array.isArray(m) && m.length >= 2) {
      var hit = head.slice(m[0], m[1]), q = hit.lastIndexOf('"', hit.length - 2);
      if (hit.slice(q + 1, hit.length - 1) !== p.agent_id) { advisorKit.silence('agent_mismatch'); return ''; }
    }
    return own;
  },
  // A rule stayed silent for `why` (a key of advisor.silence_metrics): counted, so "the agent never asks" can be told apart from
  // "anti-hall could not tell the advisor is there".
  silence: function (why) { var n = ah.cfg('advisor.silence_metrics')[why]; if (typeof n === 'string') advisorKit.raw('advisor.kind_availability', n); },
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
  // A fold of transcript `tp` that has read nothing yet.
  freshTx: function (tp) { return { path: tp, pos: -1, full: false, lastAdvisor: -1, lastUser: -1, userTs: -1, seen: false, avail: null, model: null, sayAt: -1 }; },
  // The transcript read INCREMENTALLY into the per-agent state `st` (st.tx): only the bytes appended since the last call (from
  // st.tx.pos, at most advisor.window_bytes per call, a line over advisor.line_max_bytes skipped without being buffered), folded
  // into the newest owner message, advisor call, main model, advisor announcement and advisor_tool attachment. A first read of a
  // transcript longer than the window, or a gap past it, reads the last window (`full` false: the head was not read). Another path
  // or a shorter file (rewritten) starts afresh. Returns {lastAdvisor, lastUser, seen, avail, full, model, sayAt, scan: {calls (new
  // this call), size, read, peak}} or null when the transcript is unreadable.
  fold: function (p, st) {
    var tp = advisorKit.transcript(p);
    if (!tp || !ah.path.isAbsolute(tp)) return null;
    var tx = jx.isObj(st.tx) && st.tx.path === tp && typeof st.tx.pos === 'number' && typeof st.tx.full === 'boolean' ? st.tx : advisorKit.freshTx(tp);
    var keep = [['type'], ['isMeta'], ['origin', 'kind'], ['timestamp'], ['message', 'model'], ['message', 'content'], ['message', 'content', '*', 'type'],
      ['message', 'content', '*', 'name'], ['message', 'content', '*', 'text']];
    var att = ah.cfg('advisor.attachment');
    keep.push([att.field, 'type'], [att.field, att.available_key], [att.field, att.change_key]);
    var read = function (from) { return ah.transcript.rangeEntries(tp, from, ah.cfgNum('advisor.window_bytes'), ah.cfgNum('advisor.line_max_bytes'), keep, ah.cfgNum('advisor.max_lines')); };
    var r = read(tx.pos);
    if (r !== null && r.shrunk === true) { tx = advisorKit.freshTx(tp); r = read(-1); }
    if (r === null || !Array.isArray(r.lines)) return null;
    if (tx.pos < 0) tx.full = r.start === 0;
    else if (r.jumped === true) tx.full = false;
    var names = ah.cfg('advisor.tool_names'), types = ah.cfg('advisor.block_types'), results = ah.cfg('advisor.result_types');
    var flag = ah.cfg('advisor.flagship_model_re'), known = ah.cfg('advisor.known_model_re'), say = ah.cfg('advisor.say_do_re');
    var calls = [];
    for (var i = 0; i < r.lines.length; i++) {
      var off = r.lines[i][0], e = r.lines[i][1];
      if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { continue; } }
      if (!jx.isObj(e)) continue;
      var a = e[att.field];
      if (e.type === att.entry_type && jx.isObj(a) && a.type === att.type) { // the harness put the advisor tool in (or took it out of) the prompt
        var ch = a[att.change_key];
        tx.avail = a[att.available_key] !== false && (typeof ch !== 'string' || att.change_on.indexOf(ch) >= 0);
        continue;
      }
      if (!jx.isObj(e.message)) continue;
      var c = e.message.content;
      if (e.type === 'user') {
        if (advisorKit.owner(e) && off > tx.lastUser) { tx.lastUser = off; tx.userTs = advisorKit.ts(e); tx.sayAt = -1; }
      } else if (e.type === 'assistant') {
        var m = e.message.model;
        if (typeof m === 'string' && m !== '' && (ah.re.test(known, 'r', m) || ah.re.test(flag, 'r', m))) tx.model = m;
        if (!Array.isArray(c)) continue;
        for (var b = 0; b < c.length; b++) {
          var blk = c[b];
          if (!jx.isObj(blk)) continue;
          if (types.indexOf(blk.type) >= 0 && names.indexOf(blk.name) >= 0) {
            tx.seen = true; calls.push({ off: off, ts: advisorKit.ts(e), userTs: tx.userTs });
            if (off > tx.lastAdvisor) tx.lastAdvisor = off;
          } else if (results.indexOf(blk.type) >= 0) {
            tx.seen = true;
            if (off > tx.lastAdvisor) tx.lastAdvisor = off;
          } else if (blk.type === 'text' && typeof blk.text === 'string' && ah.re.test(say, 'r', blk.text)) {
            tx.seen = true; // announcing an advisor call is evidence the tool is in the model's prompt
            if (off > tx.sayAt) tx.sayAt = off;
          }
        }
      }
    }
    tx.pos = typeof r.next === 'number' ? r.next : tx.pos;
    st.tx = tx;
    advisorKit.consults(st, { calls: calls }); // counted where read: a call is read once, by whichever rule folds first
    return { lastAdvisor: tx.lastAdvisor, lastUser: tx.lastUser, seen: tx.seen, avail: tx.avail, full: tx.full, model: tx.model, sayAt: tx.sayAt,
      scan: { calls: calls, size: r.size, read: r.read, peak: r.peak } };
  },
  // Does the session have an advisor tool? Signals that need no earlier advisor use come first: the payload's tool list, then the
  // newest advisor_tool attachment of this agent's own transcript (the harness's record of the tool entering the prompt: an explicit
  // "off" is silent). Then an advisor call, result or announcement seen. Last, when the head of the transcript was never read (so a
  // missing attachment proves nothing), an advisor model configured in the Claude Code settings (advisor.settings_files). Else
  // unknown: silent (fail open), counted.
  present: function (p, scan, view) {
    var names = ah.cfg('advisor.tool_names'), listed = advisorKit.payloadTools(p);
    for (var i = 0; i < listed.length; i++) if (names.indexOf(listed[i]) >= 0) return true;
    if (!view) { advisorKit.silence('unknown'); return false; }
    if (view.avail === false) { advisorKit.silence('off'); return false; }
    if (view.avail === true || view.seen) return true;
    if (!view.full && advisorKit.configured(p)) { advisorKit.silence('settings_only'); return true; }
    advisorKit.silence('unknown');
    return false;
  },
  // Is an advisor model set in one of the Claude Code settings files (advisor.settings_files: {root: home|cwd|abs, path})?
  configured: function (p) {
    var files = ah.cfg('advisor.settings_files'), key = ah.cfg('advisor.settings_key'), max = ah.cfgNum('advisor.settings_read_max_bytes');
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!jx.isObj(f) || typeof f.path !== 'string') continue;
      var base = f.root === 'home' ? ah.home() : f.root === 'cwd' ? (typeof p.cwd === 'string' ? p.cwd : '') : '';
      var full = base === '' ? f.path : base + '/' + f.path;
      if (!ah.path.isAbsolute(full)) continue;
      var t = ah.fs.readText(full, max), o = null;
      if (typeof t !== 'string' || t === '') continue;
      try { o = JSON.parse(t); } catch (x) { continue; }
      if (jx.isObj(o) && typeof o[key] === 'string' && o[key] !== '') return true;
    }
    return false;
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
  // Save the state, then return `verdict`; anything but allow falls back to allow when the save failed (the once-per-task cap lives in
  // that state: unpersisted, the same block would repeat on every call). Counted.
  keep: function (p, st, verdict) {
    if (advisorKit.save(p, st) || verdict === 'allow') return verdict;
    advisorKit.silence('state_unwritable');
    return 'allow';
  },
  // Persist the state; false when it could not be written (a block then falls back to allow: an unpersisted cap is no cap).
  save: function (p, st) { try { return ah.state.writeAtomic(advisorKit.stateRel(p), JSON.stringify(st)) === true; } catch (e) { return false; } },
};

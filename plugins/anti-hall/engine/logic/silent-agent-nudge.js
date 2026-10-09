// check = "silent-agent-nudge" (Stop; mirrors hooks/silent-agent-nudge.js; on UserPromptSubmit it gives the engine-only stuck-agent
// advisory of the process watch, procwatch.toml). Nudges once when a background agent has gone quiet: reads
// the transcript tail, finds the agents launched and not finished (ah.transcript.agentScan), judges each by the newest of its output
// file, its sidechain transcript and its resume, adds the heartbeat files of this session's own subagents, then compares with the
// state file. A silent agent not yet nudged for this snapshot and not covered by the once-per-agent cap is nudged: the state is
// written (after the reply is delivered) and the Stop is blocked, unless the host already registered a newer plugin version than
// the one running (stop-version-gate: nothing said, nothing written) or this exact set of agents was acked for the session
// (stop-ack: state written, nothing said). Anything this script cannot reproduce exactly defers BEFORE a write. Keys and texts:
// agent_controls.toml (silent_nudge.*, agent_scan.*).
'use strict';

function snNum(v) { return typeof v === 'number' && isFinite(v); }

// `Number(v)` of a stored time, NaN where JavaScript gives NaN.
function snNumber(v) { return v === null ? 0 : Number(v); }

function snCandidates(p, home, now, threshold, session) {
  var out = [], transcript = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (transcript) {
    var scan = ah.transcript.agentScan(transcript, ah.cfgNum('silent_nudge.scan_bytes'));
    if (scan !== null) {
      if (scan.unsure) return null;
      var terminal = {};
      scan.terminal.forEach(function (id) { terminal[id] = true; });
      for (var i = 0; i < scan.launched.length; i++) {
        var rec = scan.launched[i], id = rec.id;
        if (terminal[id] === true || rec.pendingMessage) continue;
        var reference = NaN, snapshot = ah.cfg('silent_nudge.missing'), missing = true;
        if (rec.outputFile && rec.outputFile.charAt(0) !== '/') return null;
        if (rec.outputFile) {
          var m = ah.fs.mtimeMs(rec.outputFile);
          if (m !== null) { reference = m; snapshot = String(Math.floor(m)); missing = false; }
        }
        if (missing) {
          if (rec.adopted && !snNum(rec.launchedAtMs)) continue;
          reference = snNum(rec.launchedAtMs) ? rec.launchedAtMs : 0;
          snapshot = ah.cfg('silent_nudge.missing');
        }
        if (id.indexOf('/') >= 0 || id.indexOf('..') >= 0) return null;
        var dir = transcript.replace(/\/+$/, ''), cut = dir.lastIndexOf('/');
        var base = dir.slice(cut + 1), parent = cut === 0 ? '/' : (cut < 0 ? '.' : dir.slice(0, cut));
        var ext = ah.cfg('agent_scan.transcript_ext');
        if (base.length > ext.length && base.slice(-ext.length) === ext) base = base.slice(0, -ext.length);
        var side = ah.fs.mtimeMs(parent + '/' + base + '/' + ah.cfg('agent_scan.subagents_dir') + '/' + ah.cfg('silent_nudge.sidechain_file_prefix') + id + ext);
        if (side !== null && side > reference) reference = side;
        if (snNum(rec.lastSeenMs) && rec.lastSeenMs > reference) reference = rec.lastSeenMs;
        var resumed = snNum(rec.resumedAtMs) ? rec.resumedAtMs : 0;
        if (resumed > reference) reference = resumed;
        if (resumed !== 0) snapshot = snapshot + ah.cfg('silent_nudge.resume_mark') + String(resumed);
        if (now - reference < threshold) continue;
        out.push({ key: ah.cfg('silent_nudge.key_transcript') + id, id: id, resumedAt: resumed, snapshot: snapshot, label: rec.description ? rec.description : id, age: now - reference });
      }
    }
  }
  var names = ah.fs.listDir(home + '/' + ah.cfg('silent_nudge.agents_dir'));
  if (names === null) return out;
  var finished = ah.cfg('silent_nudge.finished_words').split(/\s+/).filter(Boolean);
  for (var j = 0; j < names.length; j++) {
    var f = names[j];
    if (f.slice(-ah.cfg('silent_nudge.heartbeat_ext').length) !== ah.cfg('silent_nudge.heartbeat_ext') || f === ah.cfg('silent_nudge.heartbeat_skip_name') ||
        f.indexOf(ah.cfg('silent_nudge.heartbeat_skip_prefix')) === 0) continue;
    var txt = ah.fs.readText(home + '/' + ah.cfg('silent_nudge.agents_dir') + '/' + f);
    if (txt === null) continue;
    var r = jx.parse(txt);
    if (r.unsure) return null;
    if (r.invalid || !jx.isObj(r.v)) continue;
    var d = r.v;
    if (typeof d.id !== 'string' || !d.id || typeof d.status !== 'string') continue;
    if (typeof d.session !== 'string' || !d.session) continue;
    if (!session || d.session !== session) continue;
    var ts = snNum(d.ts) ? d.ts : 0;
    if (ts === 0) continue;
    var status = d.status.trim().toLowerCase();
    if (finished.some(function (w) { return w.toLowerCase() === status; })) continue;
    if (now - ts < threshold) continue;
    if (ts !== Math.trunc(ts) || Math.abs(ts) >= ah.cfgNum('agent_scan.safe_int')) return null;
    out.push({ key: ah.cfg('silent_nudge.key_heartbeat') + d.id, id: d.id, resumedAt: 0, snapshot: String(ts), label: typeof d.step === 'string' && d.step ? d.step : d.id, age: now - ts });
  }
  return out;
}

// {nudged: {key: snapshot}, ever: {key: time}} of the state file; null to defer (an array member: JavaScript reads its indices as keys).
function snState(path) {
  var empty = { nudged: {}, ever: {} };
  var f = jx.read(path);
  if (f.big) return null;
  if (f.text === undefined) return empty;
  var r = jx.parse(f.text);
  if (r.unsure) return null;
  if (r.invalid || !jx.isObj(r.v)) return empty;
  var out = {};
  var keys = ['nudged', 'ever'];
  for (var i = 0; i < 2; i++) {
    var m = r.v[ah.cfg('silent_nudge.' + (i === 0 ? 'nudged_key' : 'ever_key'))];
    if (Array.isArray(m)) return null;
    if (jx.isObj(m)) {
      for (var k in m) if (/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295) return null; // JavaScript orders index-like keys first
    }
    out[keys[i]] = jx.isObj(m) ? m : {};
  }
  return out;
}

function snOneLine(s, max) {
  var o = jx.replaceAll(ah.cfg('silent_nudge.control_re'), '', s, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) {
    var cut = o.slice(0, max), last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) return null; // a cut through a surrogate pair
    return cut.replace(/\s+$/, '') + ah.cfg('silent_nudge.ellipsis');
  }
  return o;
}

function snAckPath(home, session) {
  var raw = session || ah.cfg('silent_nudge.ack_no_session');
  var safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('silent_nudge.ack_session_max'));
  return home + '/' + ah.cfg('silent_nudge.ack_dir') + '/' + ah.cfg('silent_nudge.ack_file_prefix') + safe + ah.cfg('silent_nudge.ack_file_ext');
}

// ---- UserPromptSubmit: the stuck-agent warning of the process watch (engine-only; warn only, nothing here stops an agent) ----
// The same candidates the Stop nudge finds, named in a coordinator advisory with a per-agent cooldown (procwatch.stuck_*).
function snStuckLabel(src, id) {
  var l = Array.from(String(src).split(/\s+/).filter(Boolean).join(' ')).slice(0, ah.cfgNum('procwatch.stuck_label_chars')).join('');
  return l === '' ? id : l + ' [' + id + ']';
}

function snStuckAdvisory(p) {
  if (!ah.settings.bool('procwatch.sw_enabled') || ah.settings.skipped(ah.cfg('procwatch.guard_name'))) return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (!home || home.charAt(0) !== '/') return 'allow';
  var session = typeof p.session_id === 'string' ? p.session_id : '';
  var minutes = Math.max(1, ah.settings.num('procwatch.stuck_minutes'));
  var now = ah.clock.now();
  // a transcript or heartbeat this scan cannot read exactly is no warning (the Stop nudge defers for it; an advisory stays quiet)
  var cands = snCandidates(p, home, now, minutes * 60000, session);
  if (cands === null || cands.length === 0) return 'allow';
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir') + '/' + ah.cfg('procwatch.stuck_state_file');
  var nowS = Math.floor(now / 1000), last = {};
  var raw = ah.fs.readText(home + '/' + rel);
  if (raw !== null) { try { var o = JSON.parse(raw); if (o !== null && typeof o === 'object' && !Array.isArray(o)) last = o; } catch (e) { last = {}; } }
  var cooldown = ah.cfgNum('procwatch.stuck_cooldown_s');
  cands = cands.filter(function (c) {
    var key = session + ':' + c.key + ':' + c.snapshot;
    if (typeof last[key] === 'number' && nowS - last[key] < cooldown) return false;
    last[key] = nowS;
    return true;
  });
  if (cands.length === 0) return 'allow';
  var keep = ah.cfgNum('procwatch.state_keep_s');
  Object.keys(last).forEach(function (k) { if (nowS - last[k] > keep) delete last[k]; });
  try { ah.state.writeAtomic(rel, JSON.stringify(last)); } catch (e) { /* a lost cooldown record repeats one warning */ }
  var max = ah.cfgNum('procwatch.stuck_max_named');
  var list = cands.slice(0, max).map(function (c) { return snStuckLabel(c.label, c.id) + ' (' + Math.floor(c.age / 60000) + ' min)'; }).join(', ');
  var more = cands.length > max ? text.render(ah.cfg('procwatch.msg_more'), { m: cands.length - max }) : '';
  var what = text.render(ah.cfg('procwatch.msg_stuck_what'), { n: cands.length, minutes: String(Math.round(minutes)), list: list, more: more });
  var msg = text.message('warn', ah.cfg('procwatch.guard_name'), { what: what, why: ah.cfg('procwatch.msg_stuck_why'), instead: ah.cfg('procwatch.msg_stuck_instead') });
  return { advisory: text.advisoryJson(ah.cfg('procwatch.stuck_event'), msg) };
}

function decide(p, opts) {
  if (ah.env.get(ah.cfg('silent_nudge.judge_child_env')) === ah.cfg('silent_nudge.judge_child_value')) return 'allow';
  if (p !== null && typeof p === 'object' && p[ah.cfg('procwatch.f_event')] === ah.cfg('procwatch.stuck_event')) return snStuckAdvisory(p);
  var home = ah.env.get(ah.cfg('env.home'));
  if (!home || home.charAt(0) !== '/') return 'defer';
  if (!ah.settings.bool('silent_nudge.setting')) return 'allow';
  var guard = ah.cfg('silent_nudge.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  if (p === null || typeof p !== 'object') return 'allow';
  var session = typeof p.session_id === 'string' ? p.session_id : '';
  var minutes = ah.settings.num('silent_nudge.min_setting');
  if (!isFinite(minutes) || minutes < 1) minutes = ah.cfgNum('silent_nudge.min_default');
  var threshold = minutes * 60000, now = ah.clock.now();
  var candidates = snCandidates(p, home, now, threshold, session);
  if (candidates === null) return 'defer';
  if (candidates.length === 0) return 'allow';
  var stateRel = ah.cfg('silent_nudge.state_file');
  var state = snState(home + '/' + stateRel);
  if (state === null) return 'defer';

  var live = {};
  candidates.forEach(function (c) { live[c.key] = true; });
  var stale = candidates.filter(function (c) { return state.nudged[c.key] !== c.snapshot; });
  var nextNudged = {};
  for (var k in state.nudged) if (live[k] === true) nextNudged[k] = state.nudged[k];
  var ttl = ah.cfgNum('silent_nudge.ever_nudged_ttl_ms'), nextEver = {};
  for (var e in state.ever) { var t = snNumber(state.ever[e]); if (isFinite(t) && now - t < ttl) nextEver[e] = t; }
  function everKey(c) { return session + ah.cfg('silent_nudge.ever_sep') + c.id + (c.resumedAt !== 0 ? ah.cfg('silent_nudge.resume_mark') + String(c.resumedAt) : ''); }
  var toNudge = stale.filter(function (c) { return !session || !Object.prototype.hasOwnProperty.call(nextEver, everKey(c)); });
  function render() {
    for (var nk in nextNudged) if (typeof nextNudged[nk] !== 'string') return null;
    for (var ek in nextEver) if (nextEver[ek] !== Math.trunc(nextEver[ek]) || Math.abs(nextEver[ek]) >= ah.cfgNum('agent_scan.safe_int')) return null;
    var o = {}; o[ah.cfg('silent_nudge.nudged_key')] = nextNudged; o[ah.cfg('silent_nudge.ever_key')] = nextEver;
    return JSON.stringify(o);
  }
  if (toNudge.length === 0) {
    stale.forEach(function (c) { nextNudged[c.key] = c.snapshot; });
    var quiet = render();
    if (quiet === null) return 'defer';
    ah.state.op(home, 'after_reply', stateRel, quiet);
    return 'allow';
  }

  // stale-build downgrade: a newer version is already registered than the running plugin; say nothing, keep the state as it was
  // the rule's plugin_root option, else the engine's variable for it; empty is unknown (Node judges against its own install directory)
  var root = opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root')) || '';
  if (!root) return 'defer';
  if (ah.settings.bool('silent_nudge.version_gate_setting')) {
    var v = ah.plugin.versions(root);
    if (v.unsure) return 'defer';
    if (v.registered && v.running && jx.isSemver(v.registered) && jx.isSemver(v.running) && jx.cmpVersions(v.running, v.registered) < 0) return 'allow';
  }
  stale.forEach(function (c) { nextNudged[c.key] = c.snapshot; });
  var seen = {}, shown = toNudge.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = true; return true; });
  if (session) shown.forEach(function (c) { nextEver[everKey(c)] = now; });
  var stateText = render();
  if (stateText === null) return 'defer';
  var max = ah.cfgNum('silent_nudge.label_max'), labels = [];
  for (var i = 0; i < shown.length; i++) { var l = snOneLine(shown[i].label, max); if (l === null) return 'defer'; labels.push(l); }
  var ids = shown.map(function (c) { return c.id; }).sort();
  var signature = ah.sha1(ids.join(ah.cfg('silent_nudge.ack_subject_sep'))).slice(0, ah.cfgNum('silent_nudge.signature_len'));
  var ackKey = guard + ah.cfg('silent_nudge.ack_sep') + signature;
  var acked = false;
  if (session && ah.settings.bool('silent_nudge.ack_setting')) {
    var a = jx.read(snAckPath(home, session));
    if (a.big) return 'defer';
    if (a.text !== undefined) {
      var ar = jx.parse(a.text);
      if (ar.unsure) return 'defer';
      acked = !ar.invalid && jx.isObj(ar.v) && snNum(ar.v[ackKey]) && ar.v[ackKey] > 0;
    }
  }
  ah.state.op(home, 'after_reply', stateRel, stateText);
  if (acked) return 'allow';
  var named = ah.cfgNum('silent_nudge.max_named');
  var items = shown.slice(0, named).map(function (c, n) { return text.render(ah.cfg('silent_nudge.msg_item'), { label: labels[n], mins: String(Math.floor(c.age / 60000)) }); });
  var more = shown.length > named ? text.render(ah.cfg('silent_nudge.msg_more'), { n: shown.length - named }) : '';
  var what = text.render(ah.cfg('silent_nudge.msg_what'), { count: shown.length, min: String(minutes), shown: items.join(ah.cfg('silent_nudge.msg_item_sep')), more: more });
  var instead = text.render(ah.cfg('silent_nudge.msg_instead'), { them: ah.cfg(shown.length === 1 ? 'silent_nudge.pronoun_one' : 'silent_nudge.pronoun_many') });
  var hint = session ? text.render(ah.cfg('silent_nudge.ack_hint'), { key: ackKey, now: String(ah.clock.now()), path: snAckPath(home, session) }) : '';
  var reason = text.message('block', guard, { what: what, why: ah.cfg('silent_nudge.msg_why'), instead: instead, allowed: ah.cfg('silent_nudge.msg_allowed'), extra: [hint] });
  return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } };
}

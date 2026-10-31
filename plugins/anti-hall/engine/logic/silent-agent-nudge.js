// check = "silent-agent-nudge" (Stop; mirrors hooks/silent-agent-nudge.js; on UserPromptSubmit it gives the engine-only stuck-agent
// advisory of the process watch, procwatch.toml). Nudges once when a background agent has gone quiet: reads
// the transcript tail, finds the agents launched and not finished (ah.transcript.agentScan), judges each by the newest of its output
// file, its sidechain transcript and its resume, adds the heartbeat files of this session's own subagents, then compares with the
// state file. A silent agent not yet nudged for this snapshot and not covered by the once-per-agent cap is nudged: the state is
// written (after the reply is delivered) and the Stop is blocked, unless the host already registered a newer plugin version than
// the one running (stop-version-gate: nothing said, nothing written) or this exact set of agents was acked for the session
// (stop-ack: state written, nothing said). Every Stop is decided here: a relative HOME, transcript or output path resolves against the stand-in
// directory (hookProc); an input the interpreter cannot read as V8 does is counted and logged (silent_nudge.unsure_log_kind) and read
// the way that never says less than Node: the state or ack file over the read cap or too deep to parse is read as no state and no ack
// (every silent agent counts as not yet nudged and not acked), a heartbeat file too deep to parse is no heartbeat (one whose text is
// not a JSON object Node skips too), and a transcript tail the scan cannot read exactly adds no transcript agents while the heartbeats
// are still judged. Keys and texts: agent_controls.toml (silent_nudge.*, agent_scan.*).
'use strict';

function snNum(v) { return typeof v === 'number' && isFinite(v); }

// Log and count (native_unable) an input this script cannot read exactly as Node does. Returns true; the caller reads the input the
// way that never says less than Node (see the header).
function snUnsure(why) {
  ah.unable('silent-agent-nudge:' + why);
  ah.log(ah.cfg('silent_nudge.unsure_log_kind'), why);
  return true;
}

// A JSON array member of the state read the way Node's Object.keys reads it: an object keyed by the indices.
function snIndexObj(a) { var o = {}; for (var i = 0; i < a.length; i++) o[String(i)] = a[i]; return o; }

// `Number(v)` of a stored time, NaN where JavaScript gives NaN.
function snNumber(v) { return v === null ? 0 : Number(v); }

// Whether the output file sits in another session's task directory (.../<session id>/tasks/<id>.output): an agent a previous
// session started, carried into this transcript by a restart or compaction. No session id, or another path shape, is never "other".
function snFromOtherSession(outputFile, session) {
  if (!session || typeof outputFile !== 'string') return false;
  var parts = outputFile.split('/'), n = parts.length;
  if (n < 3 || parts[n - 2] !== ah.cfg('silent_nudge.tasks_dir')) return false;
  return parts[n - 3].length === ah.cfgNum('silent_nudge.session_id_len') && parts[n - 3] !== session;
}

function snCandidates(p, home, now, threshold, session) {
  var out = [], transcript = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (transcript) {
    transcript = hookProc.open(p, transcript); // Node reads a relative path from its own directory, the payload's cwd
    var scan = ah.transcript.agentScan(transcript, ah.cfgNum('silent_nudge.scan_bytes'));
    if (scan !== null && scan.unsure) { snUnsure('transcript'); scan = null; } // no transcript agents; the heartbeats are still judged
    if (scan !== null) {
      var terminal = {};
      scan.terminal.forEach(function (id) { terminal[id] = true; });
      for (var i = 0; i < scan.launched.length; i++) {
        var rec = scan.launched[i], id = rec.id;
        if (terminal[id] === true || rec.pendingMessage) continue;
        if (snFromOtherSession(rec.outputFile, session)) continue; // a previous session's agent, not ours
        var reference = NaN, snapshot = ah.cfg('silent_nudge.missing'), missing = true;
        if (rec.outputFile) {
          var m = ah.fs.mtimeMs(hookProc.open(p, rec.outputFile));
          if (m !== null) { reference = m; snapshot = String(Math.floor(m)); missing = false; }
        }
        if (missing) {
          if (rec.adopted && !snNum(rec.launchedAtMs)) continue;
          reference = snNum(rec.launchedAtMs) ? rec.launchedAtMs : 0;
          snapshot = ah.cfg('silent_nudge.missing');
        }
        var dir = transcript.replace(/\/+$/, ''), cut = dir.lastIndexOf('/');
        var base = dir.slice(cut + 1), parent = cut === 0 ? '/' : (cut < 0 ? '.' : dir.slice(0, cut));
        var ext = ah.cfg('agent_scan.transcript_ext');
        if (base.length > ext.length && base.slice(-ext.length) === ext) base = base.slice(0, -ext.length);
        // path.join: an id holding '/' or '..' is normalized the way Node joins it
        var side = ah.fs.mtimeMs(ah.path.resolveAbs(parent + '/' + base + '/' + ah.cfg('agent_scan.subagents_dir') + '/' + ah.cfg('silent_nudge.sidechain_file_prefix') + id + ext));
        if (side !== null && side > reference) reference = side;
        if (snNum(rec.lastSeenMs) && rec.lastSeenMs > reference) reference = rec.lastSeenMs;
        var resumed = snNum(rec.resumedAtMs) ? rec.resumedAtMs : 0;
        if (resumed > reference) reference = resumed;
        if (resumed !== 0) snapshot = snapshot + ah.cfg('silent_nudge.resume_mark') + String(resumed);
        if (now - reference < threshold) continue;
        var staleMax = ah.cfgNum('silent_nudge.stale_max_ms');
        if (staleMax > 0 && now - reference >= staleMax) continue; // a record this old outlived its agent
        var isShell = rec.taskType === ah.cfg('silent_nudge.shell_task_type');
        if (isShell && rec.shellKind === ah.cfg('silent_nudge.monitor_shell_kind')) continue; // a Monitor task is an event stream: no events is its normal state
        if (isShell && jx.re('silent_nudge.daemon_re', 'i').test(rec.description || '')) continue; // a daemon is quiet by design
        out.push({ key: ah.cfg('silent_nudge.key_transcript') + id, id: id, resumedAt: resumed, snapshot: snapshot, label: rec.description ? rec.description : id, age: now - reference, shell: rec.taskType === ah.cfg('silent_nudge.shell_task_type') });
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
    if (r.unsure) { snUnsure('heartbeat'); continue; } // too deep for the interpreter: read as no heartbeat
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
    if (ah.cfgNum('silent_nudge.stale_max_ms') > 0 && now - ts >= ah.cfgNum('silent_nudge.stale_max_ms')) continue; // a heartbeat this old outlived its agent
    out.push({ key: ah.cfg('silent_nudge.key_heartbeat') + d.id, id: d.id, resumedAt: 0, snapshot: String(ts), label: typeof d.step === 'string' && d.step ? d.step : d.id, age: now - ts, shell: false });
  }
  return out;
}

// {nudged: {key: snapshot}, ever: {key: time}} of the state file (an array member: JavaScript reads its indices as keys). A file the
// interpreter cannot read as Node reads it (over the read cap, too deep to parse) is read as no state: every silent agent counts as
// not yet nudged, so the answer never says less than Node's, and the rewritten state replaces it.
function snState(path) {
  var empty = { nudged: {}, ever: {} };
  var f = jx.read(path);
  if (f.big) { snUnsure('state_big'); return empty; }
  if (f.text === undefined) return empty;
  var r = jx.parse(f.text);
  if (r.unsure) { snUnsure('state_parse'); return empty; }
  if (r.invalid || !jx.isObj(r.v)) return empty;
  var out = {};
  var keys = ['nudged', 'ever'];
  for (var i = 0; i < 2; i++) {
    var m = r.v[ah.cfg('silent_nudge.' + (i === 0 ? 'nudged_key' : 'ever_key'))];
    if (Array.isArray(m)) m = snIndexObj(m);
    // an index-like key is ordered first by both interpreters (ordinary own property keys), so the rewritten state matches Node
    out[keys[i]] = jx.isObj(m) ? m : {};
  }
  return out;
}

function snOneLine(s, max) {
  var o = jx.replaceAll(ah.cfg('silent_nudge.control_re'), '', s, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) {
    // a cut through a surrogate pair keeps the lone high half, as Node does (JSON.stringify writes it as the ASCII escape \ud83d)
    var cut = o.slice(0, max);
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
  // a transcript tail this scan cannot read exactly adds no agents and a heartbeat it cannot parse is none (no Node twin to defer to)
  var cands = snCandidates(p, home, now, minutes * 60000, session, false);
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

// ---- Stop: a child whose runtime nudges keep repeating (agent_nudge.runtime_escalation, published by the nudge loop) blocks the
// coordinator's Stop, at most rt_stop_cap times per session (GH #484). The rows leave the file when the child finishes or is stopped.
function snRuntimeEscalation(p, home, session) {
  var cap = ah.cfgNum('silent_nudge.rt_stop_cap');
  if (cap < 1 || !session) return null;
  var file = ah.cfg('agent_nudge.runtime_escalation').file;
  var raw = ah.fs.readText(home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('agent_tracker.paths').dir + '/' + file);
  if (raw === null) return null;
  var doc; try { doc = JSON.parse(raw); } catch (e) { return null; }
  var rows = doc && Array.isArray(doc.rows) ? doc.rows.filter(function (r) { return r && r.session === session; }) : [];
  if (rows.length === 0) return null;
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir') + '/' + ah.cfg('silent_nudge.rt_state_file');
  var given = {}, sraw = ah.fs.readText(home + '/' + rel);
  if (sraw !== null) { try { var o = JSON.parse(sraw); if (o !== null && typeof o === 'object' && !Array.isArray(o)) given = o; } catch (e) { given = {}; } }
  if (typeof given[session] === 'number' && given[session] >= cap) return null;
  given[session] = (typeof given[session] === 'number' ? given[session] : 0) + 1;
  var ok = false;
  try { ok = ah.state.writeAtomic(rel, JSON.stringify(given)) === true; } catch (e) { ok = false; }
  if (!ok) { // an unrecorded block could repeat past the cap (GH #494): say nothing, count it, log it once
    ah.metric('runtime_escalation_stop_unrecorded', []);
    ah.log(ah.cfg('silent_nudge.rt_unrecorded_log').kind, ah.cfg('silent_nudge.rt_unrecorded_log').text);
    return null;
  }
  var max = ah.cfgNum('silent_nudge.max_named');
  var items = rows.slice(0, max).map(function (r) {
    var mins = Math.floor((typeof r.dur_ms === 'number' ? r.dur_ms : 0) / 60000), h = Math.floor(mins / 60);
    var dur = h > 0 ? text.render(ah.cfg('silent_nudge.rt_dur_hours'), { h: String(h), m: String(mins % 60) }) : text.render(ah.cfg('silent_nudge.rt_dur_minutes'), { m: String(mins) });
    return text.render(ah.cfg('silent_nudge.msg_rt_item'), { name: snOneLine(String(r.name || ''), ah.cfgNum('silent_nudge.label_max')), dur: dur });
  });
  var more = rows.length > max ? text.render(ah.cfg('silent_nudge.msg_more'), { n: rows.length - max }) : '';
  ah.advisory('flagged', 'runtime_escalation_stop');
  var reason = text.message('block', ah.cfg('silent_nudge.guard_name'), {
    what: text.render(ah.cfg('silent_nudge.msg_rt_what'), { names: items.join(ah.cfg('silent_nudge.msg_item_sep')), more: more }),
    why: ah.cfg('silent_nudge.msg_why'), instead: ah.cfg('silent_nudge.msg_rt_instead') });
  return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } };
}

function decide(p, opts) { return snDecide(p, opts); }

function snDecide(p, opts) {
  if (ah.env.get(ah.cfg('silent_nudge.judge_child_env')) === ah.cfg('silent_nudge.judge_child_value')) return 'allow';
  if (p !== null && typeof p === 'object' && p[ah.cfg('procwatch.f_event')] === ah.cfg('procwatch.stuck_event')) return snStuckAdvisory(p);
  // Node: HOME || USERPROFILE (an empty one falls through), and no nudge without either. A relative one names a directory of the hook
  // process's own: it resolves against the stand-in directory (counted).
  var home = ah.env.get(ah.cfg('env.home')) || ah.env.get(ah.cfg('silent_nudge.home_fallback_env'));
  if (!home) return 'allow';
  if (home.charAt(0) !== '/') { snUnsure('relative_home'); home = ah.path.resolveAbs(hookProc.base() + '/' + home); }
  if (!ah.settings.bool('silent_nudge.setting')) return 'allow';
  var guard = ah.cfg('silent_nudge.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  if (p === null || typeof p !== 'object') return 'allow';
  var session = typeof p.session_id === 'string' ? p.session_id : '';
  var rt = snRuntimeEscalation(p, home, session);
  if (rt !== null) return rt;
  var minutes = ah.settings.num('silent_nudge.min_setting');
  if (!isFinite(minutes) || minutes < 1) minutes = ah.cfgNum('silent_nudge.min_default');
  var threshold = minutes * 60000, now = ah.clock.now();
  var candidates = snCandidates(p, home, now, threshold, session, true);
  if (candidates === null || candidates.length === 0) return 'allow';
  var stateRel = ah.cfg('silent_nudge.state_file');
  var state = snState(home + '/' + stateRel);
  if (state === null) return 'allow';

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
    var o = {}; o[ah.cfg('silent_nudge.nudged_key')] = nextNudged; o[ah.cfg('silent_nudge.ever_key')] = nextEver;
    return JSON.stringify(o);
  }
  if (toNudge.length === 0) {
    stale.forEach(function (c) { nextNudged[c.key] = c.snapshot; });
    ah.state.op(home, 'after_reply', stateRel, render());
    return 'allow';
  }

  // stale-build downgrade: a newer version is already registered than the running plugin; say nothing, keep the state as it was
  // the rule's plugin_root option, else the engine's variable for it. Unreadable versions: no newer build is known to be waiting,
  // so the gate passes and the nudge is said (Node's answer whenever its own install is the newest)
  var root = opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root')) || '';
  // no root to judge by: Node judges against its own install directory and may stay quiet; the gate passes and the nudge is said (counted)
  if (!root && ah.settings.bool('silent_nudge.version_gate_setting')) snUnsure('no_plugin_root');
  if (root && ah.settings.bool('silent_nudge.version_gate_setting')) {
    var v = ah.plugin.versions(root);
    if (v.unsure) ah.log(ah.cfg('silent_nudge.unsure_log_kind'), 'plugin_versions');
    if (!v.unsure && v.registered && v.running && jx.isSemver(v.registered) && jx.isSemver(v.running) && jx.cmpVersions(v.running, v.registered) < 0) return 'allow';
  }
  stale.forEach(function (c) { nextNudged[c.key] = c.snapshot; });
  var seen = {}, shown = toNudge.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = true; return true; });
  if (session) shown.forEach(function (c) { nextEver[everKey(c)] = now; });
  var stateText = render();
  var max = ah.cfgNum('silent_nudge.label_max'), labels = [];
  for (var i = 0; i < shown.length; i++) labels.push(snOneLine(shown[i].label, max));
  var ids = shown.map(function (c) { return c.id; }).sort();
  var signature = ah.sha1(ids.join(ah.cfg('silent_nudge.ack_subject_sep'))).slice(0, ah.cfgNum('silent_nudge.signature_len'));
  var ackKey = guard + ah.cfg('silent_nudge.ack_sep') + signature;
  var acked = false;
  if (session && ah.settings.bool('silent_nudge.ack_setting')) {
    var a = jx.read(snAckPath(home, session));
    // an ack file the interpreter cannot read as Node reads it is no ack: the nudge is said (never less than Node)
    if (a.big) snUnsure('ack_big');
    else if (a.text !== undefined) {
      var ar = jx.parse(a.text);
      if (ar.unsure) snUnsure('ack_parse');
      acked = !ar.invalid && !ar.unsure && jx.isObj(ar.v) && snNum(ar.v[ackKey]) && ar.v[ackKey] > 0;
    }
  }
  ah.state.op(home, 'after_reply', stateRel, stateText);
  if (acked) { ah.metric('silent_agent_nudge_acked', []); return 'allow'; }
  var named = ah.cfgNum('silent_nudge.max_named');
  var items = shown.slice(0, named).map(function (c, n) { return text.render(ah.cfg('silent_nudge.msg_item'), { label: (c.shell ? ah.cfg('silent_nudge.shell_label_prefix') : '') + labels[n], mins: String(Math.floor(c.age / 60000)) }); });
  var more = shown.length > named ? text.render(ah.cfg('silent_nudge.msg_more'), { n: shown.length - named }) : '';
  var anyShell = shown.some(function (c) { return c.shell; }), anyAgent = shown.some(function (c) { return !c.shell; });
  var noun = ah.cfg(anyShell ? (anyAgent ? 'silent_nudge.noun_mixed' : 'silent_nudge.noun_shell') : 'silent_nudge.noun_agent');
  var what = text.render(ah.cfg('silent_nudge.msg_what'), { count: shown.length, noun: noun, min: String(minutes), shown: items.join(ah.cfg('silent_nudge.msg_item_sep')), more: more });
  var instead = text.render(ah.cfg('silent_nudge.msg_instead'), { them: ah.cfg(shown.length === 1 ? 'silent_nudge.pronoun_one' : 'silent_nudge.pronoun_many') });
  var hint = session ? text.render(ah.cfg('silent_nudge.ack_hint'), { key: ackKey, now: String(ah.clock.now()), path: snAckPath(home, session) }) : '';
  var reason = text.message('block', guard, { what: what, why: ah.cfg('silent_nudge.msg_why'), instead: instead, allowed: ah.cfg('silent_nudge.msg_allowed'), extra: [hint] });
  ah.metric('silent_agent_nudge_fired', []); // #519: every Stop nudge said is counted
  return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } };
}

// check = "speculation-guard" (Stop; mirrors hooks/speculation-guard.js). Takes the reply being stopped (the payload's
// last_assistant_message, else the transcript's last assistant text), looks for hedge words that assert without evidence ("probably",
// "should be", "I suspect"), and blocks once when it finds one and the reply holds no acknowledgment that would make the hedge
// honest. A reply is blocked once per distinct text and at most a few times per session, so the guard can never wedge a session.
// While the Jev master switch is on the reply is also asked about on the Jev lane (add-block trust: a confident "speculative" adds a
// block; a hedge under a plan or expectation heading is asked once more with relax-block trust), every decision is written to the
// guard's own jev-judge.ndjson, and the Stop after a block reports that block's outcome to the Jev decision log. Anything this
// script cannot reproduce exactly defers BEFORE a side effect (guards.inferenceCheck on, which reads tool evidence; Jev on with a
// payload that lacks the reply text; a relative transcript path). Keys and texts: response_guards.toml (speculation_guard.*).
'use strict';

function sgT(key, flags, t) { return ah.re.test(ah.cfg(key), flags, t); }

function sgHasAck(t) {
  var ci = ah.cfg('speculation_guard.ack_ci'), cs = ah.cfg('speculation_guard.ack_cs'), i;
  for (i = 0; i < ci.length; i++) if (ah.re.test(ci[i], 'i', t)) return true;
  for (i = 0; i < cs.length; i++) if (ah.re.test(cs[i], '', t)) return true;
  return false;
}

// A "must be" / "should be" that states a duty, not a claim: the 40 units after it read as an obligation, or its line is a requirement.
function sgObligation(text, start, end) {
  if (sgT('speculation_guard.obligation_re', 'i', jx.sliceUnits(text.slice(end), ah.cfgNum('speculation_guard.obligation_window')))) return true;
  var ls = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1, le = text.indexOf('\n', start);
  return sgT('speculation_guard.requirement_line_re', 'i', text.slice(ls, le < 0 ? text.length : le));
}

// The first hedge, in pattern order, that is not exempt: {text, at} or null.
function sgHit(text) {
  var markers = ah.cfg('speculation_guard.markers'), modal = ah.cfg('speculation_guard.modal_markers');
  for (var i = 0; i < markers.length; i++) {
    var all = ah.re.findAll(markers[i], 'i', text);
    if (all.length === 0) continue;
    var first = text.slice(all[0][0], all[0][1]);
    if (modal.indexOf(first.toLowerCase()) < 0) return { text: first, at: all[0][0] };
    for (var j = 0; j < all.length; j++) {
      if (!sgObligation(text, all[j][0], all[j][1])) return { text: text.slice(all[j][0], all[j][1]), at: all[j][0] };
    }
  }
  return null;
}

// The hit sits on a line, or under a heading or labelled line of its section, that frames it as an expectation or a plan.
function sgFramed(text, at) {
  var label = ah.cfg('speculation_guard.frame_label');
  var prefix = new RegExp(ah.cfg('speculation_guard.frame_line_prefix').replace('LABEL', label), 'i');
  var heading = new RegExp(ah.cfg('speculation_guard.frame_heading'));
  var headingLabel = new RegExp(ah.cfg('speculation_guard.frame_heading_label').replace('LABEL', label), 'i');
  var inline = new RegExp(ah.cfg('speculation_guard.frame_inline'), 'i');
  var ls = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1, le = text.indexOf('\n', at);
  var line = text.slice(ls, le < 0 ? text.length : le);
  if (prefix.test(line) || inline.test(line)) return true;
  var blank = 0, before = text.slice(0, ls).split('\n');
  for (var i = before.length - 1; i >= 0; i--) {
    var l = before[i];
    if (!l.trim()) { blank++; if (blank >= 2) return false; continue; }
    blank = 0;
    var h = heading.exec(l);
    if (h) return headingLabel.test(h[1].trim());
    if (prefix.test(l)) return true;
  }
  return false;
}

// {hash, blocks, pending} of the session's state file (nothing blocked yet when it is absent, empty or not JSON); null to defer.
function sgPrior(path) {
  var none = { hash: '', blocks: 0, pending: null };
  var f = jx.read(path);
  if (f.big) return null;
  if (f.text === undefined) return none;
  var t = f.text.trim();
  if (!t) return none;
  var r = jx.parse(t);
  if (r.unsure) return null;
  if (r.invalid) return none;
  var v = r.v;
  if (v && typeof v === 'object') {
    var pending = null;
    if (jx.isObj(v.pending) && typeof v.pending.h === 'string' && typeof v.pending.source === 'string') pending = { h: v.pending.h, source: v.pending.source };
    return { hash: typeof v.hash === 'string' ? v.hash : '', blocks: typeof v.blocks === 'number' && Number.isFinite(v.blocks) ? v.blocks : 0, pending: pending };
  }
  // a legacy file holding just a hash (or any other JSON scalar): the whole text is the blocked hash
  return { hash: t, blocks: 0, pending: null };
}

function sgLog(home, line) {
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('speculation_guard.judge_log');
  var size = ah.fs.size(home + '/' + rel);
  // an append-only log cut at its cap, as Node does
  if (size !== null && size > ah.cfgNum('speculation_guard.judge_log_max_bytes')) ah.state.op(home, 'write', rel, '');
  ah.state.appendFile(rel, line);
}

function sgEntryLine(e, verdict) {
  return JSON.stringify({ ts: new Date(ah.clock.now()).toISOString(), backend: e.backend, reason: e.reason, ms: e.ms, confidence: e.confidence, regexVerdict: e.regexVerdict, verdict: verdict }) + '\n';
}

function sgSession(p, transcript) {
  if (p.session_id) {
    var t = typeof p.session_id;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return null;
    return String(p.session_id);
  }
  return ah.sha1(transcript).slice(0, 16);
}

function sgAsk(spec, p) {
  spec.sync = true;
  spec.full = true;
  spec.projectFrom = typeof p.cwd === 'string' ? p.cwd : undefined;
  return ah.jev.ask(spec);
}

function decide(p) {
  var home = ah.env.get(ah.cfg('env.home'));
  if (!home) return 'defer';
  if (!ah.settings.bool('speculation_guard.setting')) return 'allow';
  if (p === null || typeof p !== 'object') p = {};
  var transcript = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!transcript) return 'allow';
  if (transcript.charAt(0) !== '/') return 'defer';
  var sessionRaw = sgSession(p, transcript);
  if (sessionRaw === null) return 'defer';
  var stateName = ah.cfg('speculation_guard.state_prefix') + sessionRaw.replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('replykit.json_ext');
  var stateDir = ah.cfg('replykit.state_dir');
  var stateRel = stateDir + '/' + stateName;

  var payloadText = typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim() ? p.last_assistant_message : null;
  var mask = ah.text.maskQuoted;
  var tailLines;
  function fromTranscript(map) {
    if (tailLines === undefined) tailLines = rp.lines(transcript, ah.cfgNum('speculation_guard.window_bytes'));
    return tailLines === null ? { text: null } : rp.lastAssistant(tailLines, map);
  }
  var lastText;
  if (payloadText !== null) lastText = payloadText;
  else {
    var r = fromTranscript();
    if (r.unsure) return 'defer';
    if (r.text === null) return 'allow';
    lastText = r.text;
  }
  if (lastText === '') return 'allow';
  if (jx.loneSurrogate(lastText)) return 'defer';
  var markerText;
  if (payloadText !== null) markerText = mask(payloadText);
  else {
    var m = fromTranscript(mask);
    if (m.unsure) return 'defer';
    markerText = m.text === null ? '' : m.text;
  }
  if (!markerText.trim()) markerText = lastText;
  var msgHash = ah.sha1(lastText);
  var prior = sgPrior(home + '/' + stateRel);
  if (prior === null) return 'defer';
  var guard = ah.cfg('speculation_guard.guard_name');
  var skipped = ah.settings.skipped(guard);
  var jevOn = ah.jev.enabled();
  var loopSafe = msgHash === prior.hash || prior.blocks >= ah.cfgNum('speculation_guard.max_blocks');
  var inferenceOn = ah.settings.bool('speculation_guard.inference_setting');
  // everything that would have to be rebuilt from the transcript, or that Node alone can judge, is decided before the first side effect
  if (inferenceOn && !loopSafe && jevOn) return 'defer';
  var jevText = null;
  if (jevOn && !loopSafe && !skipped) {
    if (payloadText === null) return 'defer';
    jevText = jx.sliceUnits(payloadText, ah.cfgNum('speculation_guard.jev_state_chars'));
    if (jevText.length < payloadText.length && jevText.length < ah.cfgNum('speculation_guard.jev_state_chars')) return 'defer'; // the cut splits a surrogate pair
  }
  var jevId = ah.cfg('speculation_guard.jev_id');

  // outcome capture: the previous Stop's block is classified against THIS reply (before the skip check: a skip is itself one of the
  // outcomes), reported to the Jev decision log, and cleared so it is evaluated once
  if (prior.pending !== null) {
    var outcome = null;
    if (skipped) outcome = ah.cfg('speculation_guard.outcome_override');
    else if (sgHasAck(lastText)) outcome = ah.cfg('speculation_guard.outcome_evidence');
    else if (sgHit(markerText) !== null) outcome = ah.cfg('speculation_guard.outcome_repeat');
    if (outcome !== null) ah.jev.recordOutcome(jevId, prior.pending.h, outcome, prior.pending.source, typeof p.cwd === 'string' ? p.cwd : null);
    ah.state.writeAtomic(stateRel, JSON.stringify({ hash: prior.hash, blocks: prior.blocks, pending: null }));
  }
  if (skipped) return 'allow';

  var hit = sgHit(markerText);
  var wouldBlock = hit !== null && !sgHasAck(lastText);

  // JEV: the speculation question (add-block). A confident "speculative" adds a block; any failure leaves the regex verdict.
  var entry = null, jevBlock = false, jevHash = '';
  if (jevOn && loopSafe) {
    entry = { backend: 'none', reason: 'loop-safe', ms: null, confidence: null, regexVerdict: wouldBlock };
  } else if (jevText !== null) {
    var d = sgAsk({
      id: jevId, state: jevText, trust: 'add_block', baseline: false, compare: wouldBlock, sessionId: sessionRaw,
      question: { type: 'noul', instructions: ah.cfg('speculation_guard.jev_instructions'), criteria: [['true', ah.cfg('speculation_guard.jev_true')], ['false', ah.cfg('speculation_guard.jev_false')]] },
    }, p);
    if (d === null) d = { jev: null, outcome: false, reason: null };
    if (d.jev === null) {
      if (d.reason) entry = { backend: 'jev→regex', reason: d.reason, ms: d.ms, confidence: null, regexVerdict: wouldBlock };
    } else if (d.outcome === true) {
      jevBlock = true;
      jevHash = d.hash;
      entry = { backend: 'jev', reason: 'confident', ms: d.ms, confidence: d.confidence, regexVerdict: wouldBlock };
    } else {
      entry = { backend: 'jev→regex', reason: d.confident === true ? 'confident-allow-untrusted' : 'low-confidence', ms: d.ms, confidence: d.confidence, regexVerdict: wouldBlock };
    }
  }
  function finish(v, verdict) {
    if (entry !== null) sgLog(home, sgEntryLine(entry, verdict));
    return v;
  }

  var marker = null, hitAt = 0;
  if (!jevBlock) {
    if (hit !== null && !sgHasAck(lastText)) { marker = hit.text; hitAt = hit.at; }
    else {
      // no hedge, or an honest one: the causal-claim scan (off unless guards.inferenceCheck is on) reads tool evidence
      if (!loopSafe && inferenceOn) return 'defer';
      return finish('allow', 'allow');
    }
  }
  if (loopSafe) return finish('allow', 'allow');

  // FRAMED EXPECTATION (relax-block): only for a genuine regex hit under a plan or expectation frame; Jev may turn that block into a
  // non-block, never add one.
  if (!jevBlock && marker !== null && jevOn && sgFramed(markerText, hitAt)) {
    sgLog(home, JSON.stringify({ ts: new Date(ah.clock.now()).toISOString(), event: 'trigger', id: ah.cfg('speculation_guard.jev_framed_id'), outcome: 'seen' }) + '\n');
    if (jevText === null) return 'defer';
    var fd = sgAsk({
      id: ah.cfg('speculation_guard.jev_framed_id'), state: jevText, trust: 'relax_block', baseline: true, sessionId: sessionRaw,
      question: { type: 'noul', instructions: ah.cfg('speculation_guard.framed_instructions'), criteria: [['true', ah.cfg('speculation_guard.framed_true')], ['false', ah.cfg('speculation_guard.framed_false')]] },
    }, p);
    if (fd !== null && fd.outcome === false) return finish('allow', 'allow');
  }

  var pendingH = jevBlock ? (jevHash || msgHash) : msgHash;
  var source = jevBlock ? ah.cfg('speculation_guard.source_jev') : ah.cfg('speculation_guard.source_regex');
  var body = JSON.stringify({ hash: msgHash, blocks: prior.blocks + 1, pending: { h: pendingH, source: source } });
  if (!ah.state.writeAtomic(stateRel, body)) return finish('allow', 'allow');
  ah.state.prune(ah.cfg('speculation_guard.prune_prefix'), stateName);
  var what = jevBlock ? ah.cfg('speculation_guard.msg_what_jev') : text.render(ah.cfg('speculation_guard.msg_what'), { marker: marker });
  var reason = text.message('block', guard, { what: what, why: ah.cfg('speculation_guard.msg_why'), instead: ah.cfg('speculation_guard.msg_instead') });
  return finish({ exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } }, 'block');
}

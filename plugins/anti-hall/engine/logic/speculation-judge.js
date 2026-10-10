// check = "speculation-judge" (Stop; the opt-in semantic judge, mirrors hooks/speculation-judge.js and lib/judge-core.js). The hook asks
// a Claude model whether the reply states something as fact that nothing in the session supports, and blocks once when the model says
// so. It is off unless jev.semanticJudge is on, and then it does nothing at all. Everything that needs no model is answered here, in
// the Node order: the judge-child guard, the switch, the skip file, the backend switch (jev.speculationBackend `jev` leaves the
// question to speculation-guard's Jev path), Jev's own speculation integration being fully on, a payload without a transcript, a
// judge backend with no Anthropic key (Node makes no call), an empty reply, a reply already blocked and the block cap. A reply that
// needs the model makes the call through the Claude CLI (ah.judge.cli) in a process that may wait seconds for it (the dispatcher
// process, which runs the check again after the daemon deferred it); the daemon itself defers it. An API call (a visible key) stays
// the Node hook's: the engine never sends a key anywhere. Keys and
// texts: judge.toml (speculation_judge.*, judge.*).
'use strict';

// The route of a judge call: 'cli', 'api' (a visible key: the Node hook's), 'nokey', or 'unknown' (the answer depends on a key this
// request's environment cannot show).
function sjRoute() {
  var backend = ah.settings.enum('judge.backend_setting');
  if (backend === ah.cfg('judge.backend_cli')) return 'cli';
  var key = ah.env.get(ah.cfg('judge.anthropic_key_env'));
  var visible;
  if (key !== null && key.trim() !== '') visible = true;
  else if (!ah.settings.bool('judge.anthropic_env_optin')) visible = false;
  else {
    var legacy = ah.env.get(ah.cfg('judge.anthropic_legacy_env'));
    visible = legacy === null ? null : legacy.trim() !== '';
  }
  if (visible === null) return 'unknown';
  if (visible) return 'api';
  return backend === ah.cfg('judge.backend_auto') ? 'cli' : 'nokey';
}

// {hash, blocks} of the judge's state file for the session (nothing blocked yet when it is absent, unreadable or not JSON).
function sjPrior(path) {
  var f = jx.read(path);
  if (f.big) return null;
  if (f.text === undefined || !f.text.trim()) return { hash: '', blocks: 0 };
  var r = jx.parse(f.text.trim());
  if (r.unsure) return null;
  if (r.invalid) return { hash: '', blocks: 0 };
  var v = r.v;
  return { hash: v && typeof v.hash === 'string' ? v.hash : '', blocks: jx.isObj(v) && typeof v.blocks === 'number' && Number.isFinite(v.blocks) ? v.blocks : 0 };
}

// The judge's echoed claim is model-produced and reflected into the block reason: control characters become spaces, bidi controls go,
// white space collapses, and it is cut to claim_max units (Node: sanitizeClaim).
function sjClaim(s) {
  var dflt = ah.cfg('speculation_judge.claim_default');
  if (typeof s !== 'string') return dflt;
  var out = s.replace(new RegExp(ah.cfg('speculation_judge.claim_controls_re'), 'g'), ' ').replace(new RegExp(ah.cfg('speculation_judge.claim_bidi_re'), 'g'), '')
    .replace(new RegExp(ah.cfg('speculation_judge.claim_ws_re'), 'g'), ' ').trim();
  if (!out) return dflt;
  var max = ah.cfgNum('speculation_judge.claim_max');
  if (out.length > max) out = out.slice(0, max).trimEnd() + ah.cfg('speculation_judge.claim_ellipsis');
  return out;
}

function decide(p) {
  if (ah.env.get(ah.cfg('speculation_judge.child_env')) === ah.cfg('speculation_judge.child_value')) return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (!home) return 'defer';
  if (!ah.settings.bool('speculation_judge.setting')) return 'allow';
  if (ah.settings.skipped(ah.cfg('speculation_judge.guard_name'))) return 'allow';
  // the per-integration backend switch: `jev` leaves the speculation question to speculation-guard's Jev path alone
  var backend = ah.settings.enum('speculation_judge.backend_setting');
  if (backend === ah.cfg('speculation_judge.backend_jev') || backend === ah.cfg('cascade.backend')) return 'allow';
  // Jev's own speculation integration fully on: speculation-guard already asks it on every Stop (no double pay)
  if (ah.jev.mode(ah.cfg('speculation_judge.jev_id')) === 'on') return 'allow';
  if (p === null || typeof p !== 'object') p = {};
  var transcript = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!transcript) return 'allow';
  var route = sjRoute();
  if (route === 'nokey') return 'allow';
  if (route !== 'cli') return 'defer'; // an API call, or a key this request cannot show: the Node hook's
  if (transcript.charAt(0) !== '/') return 'defer';
  var session;
  if (p.session_id) {
    var t = typeof p.session_id;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return 'defer';
    session = String(p.session_id);
  } else {
    session = ah.sha1(transcript).slice(0, 16);
  }
  var stateRel = ah.cfg('replykit.state_dir') + '/' + ah.cfg('speculation_judge.state_prefix') + session.replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('replykit.json_ext');
  var last;
  if (typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim()) {
    last = p.last_assistant_message;
  } else {
    var lines = rp.lines(transcript, ah.cfgNum('speculation_judge.reply_window'));
    last = '';
    if (lines !== null) {
      var r = rp.lastAssistant(lines);
      if (r.unsure) return 'defer';
      last = r.text === null ? '' : r.text;
    }
  }
  if (!last.trim()) return 'allow';
  if (jx.loneSurrogate(last)) return 'defer';
  var hash = ah.sha1(last + ah.cfg('speculation_judge.hash_suffix'));
  var prior = sjPrior(home + '/' + stateRel);
  if (prior === null) return 'defer';
  if (hash === prior.hash || prior.blocks >= ah.cfgNum('speculation_judge.max_blocks')) return 'allow';
  // The model call takes seconds: the daemon cannot wait for it (ah.judge.cli answers null there and the dispatcher process, which can,
  // runs this check again), and an unreadable transcript line is the Node hook's.
  var call = ah.judge.cli({ transcript: transcript, message: last });
  if (call === null) return 'defer';
  var d = call.decision;
  // fail-open: no answer, a non-object, a missing decision field or "allow"
  if (d === null || typeof d !== 'object' || d.decision !== ah.cfg('speculation_judge.decision_block')) return 'allow';
  if (!ah.state.writeAtomic(stateRel, JSON.stringify({ hash: hash, blocks: prior.blocks + 1 }))) return 'allow';
  var guard = ah.cfg('speculation_judge.guard_name');
  var what = text.render(ah.cfg('speculation_judge.msg_what'), { claim: sjClaim(typeof d.claim === 'string' && d.claim ? d.claim : null) });
  var reason = text.message('block', guard, { what: what, why: ah.cfg('speculation_judge.msg_why'), instead: ah.cfg('speculation_judge.msg_instead') });
  return { exact: { code: 0, out: JSON.stringify({ decision: ah.cfg('speculation_judge.decision_block'), reason: reason }) + '\n', err: '' } };
}

// check = "claim-evidence-guard" (Stop, Claude, loop-safe; engine-only, no Node twin; GH #313). Two rules, each with its own switch:
// (1) claim needs evidence: a reply that asserts a result ("tests pass", "verified", "deployed", "is fixed") with no tool call this
// turn that could have produced it is held once; (2) pushed is not done: a reply that calls the work done after a push or PR created
// in this turn, with no later look at CI or the merge state, is held once. Almost no reply makes such a claim, so the reply text is
// tested first and the transcript is touched only for a hit: the engine's evidence walk (ah.transcript.evidenceWalk, shared with the
// claim ledger) counts the tool calls of the turn, and the host's tool-use scan (ah.transcript.toolUseScan) names the commands of
// the last N of them. A reply that labels itself honest (not verified, CI pending, earlier run) is never held; the same reply is
// held once, at most max_blocks times per owner turn (blockCap, as the speculation guard); stop_hook_active, subagents, Codex
// payloads (the evidence walk reads Claude transcripts only) and a script failure allow. A claim is judged per sentence: one that
// is negated, future/conditional or reported from someone else's words (its own clause, neg_res/future_res/reported_res) is not a claim. mode = log writes the hit and allows.
// Every pattern, list, number and text: claim_evidence.toml.
'use strict';

function ceCollapse(s) { return s.normalize('NFC').replace(/\s+/g, ' ').trim(); }

// The first hit [start, end] of any pattern of `list` in `t`, else null.
function ceAny(list, t) {
  for (var i = 0; i < list.length; i++) {
    var r = ah.re.find(list[i], 'i', t);
    if (r) return r;
  }
  return null;
}

// The commands (strings) of the last `n` tool uses of the transcript, in order; null when the uses cannot be read.
function ceCommands(tp, n) {
  var items = ah.transcript.toolUseScan(tp, ah.cfgNum('claim_ledger.window_bytes'), ['tool_use'], ah.cfg('taskstate.tools_collect_keys'));
  if (items === null) return null;
  var uses = [];
  for (var i = 0; i < items.length; i++) {
    var u = items[i][1];
    for (var j = 0; j < u.length; j++) uses.push(typeof u[j][2] === 'string' ? u[j][2] : '');
  }
  return uses.slice(Math.max(0, uses.length - n));
}

// The reply cut into sentences at claim_evidence.sentence_end_re (a hit that consumes nothing ends the cut).
function ceSentences(t) {
  var re = ah.cfg('claim_evidence.sentence_end_re'), out = [], rest = t;
  for (;;) {
    var m = ah.re.find(re, 'i', rest);
    if (!m || m[1] <= 0) break;
    out.push(rest.slice(0, m[0]));
    rest = rest.slice(m[1]);
  }
  out.push(rest);
  return out;
}

// The text of `sent` that governs a claim found at [a, b]: from the last clause break before it (or `win` chars back, the nearer) to its end.
function ceContext(sent, a, b) {
  var br = ah.cfg('claim_evidence.clause_break_re'), before = sent.slice(0, a), from = 0, off = 0;
  for (;;) {
    var m = ah.re.find(br, 'i', before.slice(off));
    if (!m || m[1] <= m[0]) break;
    from = off + m[1];
    off = from;
  }
  return sent.slice(Math.max(from, a - ah.cfgNum('claim_evidence.skip_window')), b);
}

// The first claim of the reply that is stated as fact: a hit whose own clause is negated, future/conditional or reported speech is passed over.
function ceFindClaim(scan) {
  var rows = ah.cfg('claim_evidence.claims'), sents = ceSentences(scan);
  var skip = [].concat(ah.cfg('claim_evidence.neg_res'), ah.cfg('claim_evidence.future_res'), ah.cfg('claim_evidence.reported_res'));
  for (var k = 0; k < sents.length; k++) {
    for (var i = 0; i < rows.length; i++) {
      var hit = ah.re.find(rows[i].re, 'i', sents[k]);
      if (hit && ceAny(skip, ceContext(sents[k], hit[0], hit[1])) === null) return { row: rows[i], quote: sents[k].slice(hit[0], hit[1]) };
    }
  }
  return null;
}

function ceAnyCmd(list, cmds) {
  for (var i = 0; i < cmds.length; i++) if (cmds[i] !== '' && ceAny(list, cmds[i]) !== null) return true;
  return false;
}

// Rule 2 on the commands of the turn: true when something was pushed and nothing after the last push looked at CI or the merge state.
function cePushedUnchecked(cmds) {
  var push = ah.cfg('claim_evidence.push_res'), last = -1, i;
  for (i = 0; i < cmds.length; i++) if (cmds[i] !== '' && ceAny(push, cmds[i]) !== null) last = i;
  if (last < 0) return false;
  return !ceAnyCmd(ah.cfg('claim_evidence.state_res'), cmds.slice(last + 1));
}

function ceState(path) {
  var none = { hash: '', blocks: 0 };
  var f = jx.read(path);
  if (f.big || f.text === undefined) return none;
  var r = jx.parse(f.text.trim());
  if (r.unsure || r.invalid || !jx.isObj(r.v)) return none;
  return Object.assign({}, r.v, { hash: typeof r.v.hash === 'string' ? r.v.hash : '', blocks: typeof r.v.blocks === 'number' && isFinite(r.v.blocks) ? r.v.blocks : 0 });
}

function decide(p) {
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  var r1 = ah.settings.bool('claim_evidence.sw_claim'), r2 = ah.settings.bool('claim_evidence.sw_pushed');
  if (!r1 && !r2) return 'allow';
  if (p === null || typeof p !== 'object' || p.stop_hook_active === true) return 'allow';
  if (ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; }) || coordinator.isCodexPayload(p)) return 'allow';
  var guard = ah.cfg('claim_evidence.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  var reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!reply.trim() || !tp) return 'allow';

  // the cheap gate: the reply alone, with quoted text and code removed
  var scan = ah.text.maskQuoted(reply), claim = null, done = false;
  if (r1) {
    claim = ceFindClaim(scan);
    if (claim !== null && ceAny(ah.cfg('claim_evidence.ack_res'), scan) !== null) claim = null;
  }
  if (r2) done = ceAny(ah.cfg('claim_evidence.done_res'), scan) !== null && ceAny(ah.cfg('claim_evidence.ack_pushed_res'), scan) === null;
  if (claim === null && !done) return 'allow';

  // the transcript, for a hit only
  var tpOpen = hookProc.open(p, tp);
  var ev = ah.transcript.evidenceWalk(tpOpen, ah.cfgNum('claim_ledger.window_bytes'), reply);
  if (ev === null || ev.unsure || !ev.walked) return 'allow';
  var inLast = ev.lastText !== '' && ceCollapse(reply).indexOf(ceCollapse(ev.lastText)) >= 0;
  var tools = inLast ? ev.toolsThisTurn : ev.toolsAtEnd;
  var cmds = null, what = null;
  if (done && tools > 0) {
    cmds = ceCommands(tpOpen, tools);
    if (cmds !== null && cePushedUnchecked(cmds)) what = ah.cfg('claim_evidence.msg_pushed_what');
  }
  if (what === null && claim !== null) {
    var needs = claim.row.needs;
    if (tools === 0) what = text.render(ah.cfg('claim_evidence.msg_claim_what'), { claim: claim.row.id, quote: text.clean(claim.quote) });
    else if (needs.length > 0) {
      if (cmds === null) cmds = ceCommands(tpOpen, tools);
      if (cmds !== null && !ceAnyCmd(needs, cmds)) what = text.render(ah.cfg('claim_evidence.msg_claim_what'), { claim: claim.row.id, quote: text.clean(claim.quote) });
    }
  }
  if (what === null) return 'allow';
  var instead = what === ah.cfg('claim_evidence.msg_pushed_what') ? ah.cfg('claim_evidence.msg_pushed_instead') : ah.cfg('claim_evidence.msg_claim_instead');
  ah.log(ah.cfg('claim_evidence.log_kind'), what);
  if (ah.cfg('claim_evidence.mode') !== 'block') return 'allow';

  // loop safety: the same reply once, a bounded number of holds per owner turn
  var home = ah.env.get(ah.cfg('env.home')) || ah.home();
  if (!home) return 'allow';
  var sid = (p.session_id && String(p.session_id)) || ah.sha1(tp).slice(0, 16);
  var stateName = ah.cfg('claim_evidence.state_prefix') + sid.replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('replykit.json_ext');
  var stateRel = ah.cfg('replykit.state_dir') + '/' + stateName;
  var hash = ah.sha1(reply);
  var cap = blockCap.open(ceState(home + '/' + stateRel), tp, 'claim_evidence.cap_scope', home, stateRel);
  var prior = cap.state;
  if (prior.hash === hash || prior.blocks >= ah.cfgNum('claim_evidence.max_blocks')) return 'allow';
  if (!cap.backup()) return 'allow';
  if (!ah.state.writeAtomic(stateRel, JSON.stringify(Object.assign({}, cap.blocked(), { hash: hash, blocks: prior.blocks + 1 })))) return 'allow';
  ah.state.prune(ah.cfg('claim_evidence.state_prefix'), stateName);
  var reason = text.message('block', guard, { what: what, instead: instead });
  return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } };
}

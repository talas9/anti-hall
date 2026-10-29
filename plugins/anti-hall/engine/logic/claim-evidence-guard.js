// check = "claim-evidence-guard" (Stop, Claude, loop-safe; engine-only, no Node twin; GH #313). Two rules, each with its own switch:
// (1) claim needs evidence: a reply that asserts a result ("tests pass", "verified", "deployed", "is fixed") with no tool call this
// turn that could have produced it is held once; (2) pushed is not done: a reply that calls the work done after a push or PR created
// in this turn, with no later look at CI or the merge state, is held once. Almost no reply makes such a claim, so the reply text is
// tested first and the transcript is touched only for a hit: the engine's evidence walk (ah.transcript.evidenceWalk, shared with the
// claim ledger) counts the tool calls of the turn, and the host's tool-use scan (ah.transcript.toolUseScan) names the commands of
// the last N of them. The same reply is held once, at most max_blocks times per owner turn (blockCap, as the speculation guard); stop_hook_active, subagents, Codex
// payloads (the evidence walk reads Claude transcripts only) and a script failure allow. A claim is judged per sentence: one that
// is negated, future/conditional, a rule or criterion statement, reported from someone else's words, or labelled honest is not a claim, but only
// when the suppressor is local to the claim (claim_evidence.suppress reach, reach_label): a second predicate between them ends its reach,
// an idiom ('once again', 'no doubt') covers nothing, and quote marks alone cover nothing. mode = log writes the hit and allows.
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

// Where the text of `sent` that governs a claim found at `a` starts: after the last clause break before it (or `win` chars back, the nearer).
function ceStart(sent, a) {
  var br = ah.cfg('claim_evidence.clause_break_re'), before = sent.slice(0, a), from = 0, off = 0;
  for (;;) {
    var m = ah.re.find(br, 'i', before.slice(off));
    if (!m || m[1] <= m[0]) break;
    from = off + m[1];
    off = from;
  }
  return Math.max(from, a - ah.cfgNum('claim_evidence.skip_window'));
}

// How far `gap` (the text between a suppressor and the claim) is from the claim: the number of counted words in it. Words of
// claim_evidence.gap_skip_re are free; every other word counts, so an unknown word uses up the reach instead of extending it; a word of
// gap_restart_re after a counted word means a second phrase, and the gap is out of every reach (Infinity).
function ceGapWords(gap) {
  var words = ah.re.findAll(ah.cfg('claim_evidence.gap_word_re'), 'i', gap), n = 0;
  for (var i = 0; i < words.length; i++) {
    var w = gap.slice(words[i][0], words[i][1]);
    if (n > 0 && ah.re.find(ah.cfg('claim_evidence.gap_restart_re'), 'i', w)) return Infinity;
    if (!ah.re.find(ah.cfg('claim_evidence.gap_skip_re'), 'i', w)) n++;
  }
  return n;
}

// True when some hit of a pattern of `list` in `head` ends within `reach` counted words of the end of `head` (where the claim starts)
// and is not an idiom (`idiom`, a regex or null, matched against the hit and the text after it: 'Once again ...', 'No doubt ...' cover nothing).
function ceInReach(list, head, reach, idiom) {
  for (var i = 0; i < list.length; i++) {
    var all = ah.re.findAll(list[i], 'i', head);
    for (var j = 0; j < all.length; j++) {
      if (ceGapWords(head.slice(all[j][1])) <= reach && (idiom === null || !ah.re.find(idiom, 'i', head.slice(all[j][0])))) return true;
    }
  }
  return false;
}

// True when an honest label (claim_evidence.ack_res) in the claim's own sentence sits within reach_label counted words of the claim.
function ceLabelled(sent, hit) {
  var list = ah.cfg('claim_evidence.ack_res'), reach = ah.cfgNum('claim_evidence.reach_label');
  for (var i = 0; i < list.length; i++) {
    var all = ah.re.findAll(list[i], 'i', sent);
    for (var j = 0; j < all.length; j++) {
      var gap = all[j][1] <= hit[0] ? sent.slice(all[j][1], hit[0]) : all[j][0] >= hit[1] ? sent.slice(hit[1], all[j][0]) : '';
      if (ceGapWords(gap) <= reach) return true;
    }
  }
  // a label that closes the sentence as its own clause covers every claim before it ('...; unverified.')
  var tail = ah.re.find(ah.cfg('claim_evidence.trailing_label_re'), 'i', sent);
  return !!tail && tail[0] >= hit[1];
}

// Why a claim hit is not a claim, else null, as {reason, chain}. A suppressor covers a claim only when it is LOCAL to it: a row of
// claim_evidence.suppress whose list hits the claim's clause within that row's reach (counted words between the hit and the claim) and
// not as an idiom, the consequent of a claim a chain row covered (`prev`: {end, start} of that claim and of its clause), or an honest
// label next to the claim in its own sentence. A second predicate, an unknown connector or a second phrase between them ends the reach.
function ceReason(sent, hit, prev) {
  var sup = ah.cfg('claim_evidence.suppress'), from = ceStart(sent, hit[0]), head = sent.slice(from, hit[0]);
  for (var i = 0; i < sup.length; i++) {
    var idiom = sup[i].idiom ? ah.cfg(sup[i].idiom) : null;
    if (ceInReach(ah.cfg(sup[i].list), head, ah.cfgNum(sup[i].reach), idiom)) return { reason: sup[i].reason, chain: sup[i].chain === true };
  }
  if (prev !== null && prev.start === from && prev.end <= hit[0] && ceGapWords(sent.slice(prev.end, hit[0])) <= ah.cfgNum('claim_evidence.reach_consequent')) {
    return { reason: prev.reason, chain: true };
  }
  if (ceLabelled(sent, hit)) return { reason: ah.cfg('claim_evidence.ack_reason'), chain: false };
  return null;
}

// The first claim of the reply that is stated as fact. EVERY match of every row is judged on its own clause (a skip never reaches the rest
// of the sentence); a hit whose clause is negated, future/conditional, reported speech or a rule/criterion statement is passed over and
// pushed to `seen` as [reason, quote, claim id] for the log.
function ceFindClaim(scan, seen) {
  var rows = ah.cfg('claim_evidence.claims'), sents = ceSentences(scan);
  for (var k = 0; k < sents.length; k++) {
    // every hit of every row, in text order, so a consequent follows the condition it depends on
    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      var all = ah.re.findAll(rows[i].re, 'i', sents[k]);
      for (var j = 0; j < all.length; j++) hits.push([all[j][0], all[j][1], i]);
    }
    hits.sort(function (x, y) { return x[0] - y[0] || x[2] - y[2]; });
    var prev = null;
    for (var h = 0; h < hits.length; h++) {
      var why = ceReason(sents[k], hits[h], prev), quote = sents[k].slice(hits[h][0], hits[h][1]), row = rows[hits[h][2]];
      if (why === null) return { row: row, quote: quote };
      seen.push([why.reason, quote, row.id]);
      if (why.chain && (prev === null || hits[h][1] > prev.end)) prev = { end: hits[h][1], start: ceStart(sents[k], hits[h][0]), reason: why.reason };
    }
  }
  return null;
}

// The reply with its quote marks (claim_evidence.quote_mark_re) blanked, so a claim in quotes is judged like any other; an apostrophe
// inside a word stays.
function ceUnquote(t) {
  var all = ah.re.findAll(ah.cfg('claim_evidence.quote_mark_re'), 'i', t), out = '', at = 0;
  for (var i = 0; i < all.length; i++) {
    out += t.slice(at, all[i][0]) + ' ';
    at = all[i][1];
  }
  return out + t.slice(at);
}

// Telemetry: one engine-log line (claim_evidence.log_kind) per suppressed hit, at most claim_evidence.max_suppress_logs per reply.
function ceLogSuppressed(seen) {
  var n = Math.min(seen.length, ah.cfgNum('claim_evidence.max_suppress_logs'));
  for (var i = 0; i < n; i++) ah.log(ah.cfg('claim_evidence.log_kind'), text.render(ah.cfg('claim_evidence.msg_suppressed'), { reason: seen[i][0], claim: seen[i][2], quote: text.clean(seen[i][1]) }));
}

// Counters (guards.claimEvidenceTelemetry): the registered metrics and the advisory counters of `status`. A lost count never changes a decision.
function ceCountSuppressed(seen) {
  if (!ah.settings.bool('claim_evidence.sw_telemetry')) return;
  for (var i = 0; i < seen.length; i++) {
    ah.metric('claim_evidence_suppressed', ['reason', seen[i][0]]);
    ah.advisory('claim_evidence', 'suppressed_' + seen[i][0]);
  }
}

function ceCountFired(rule) {
  if (!ah.settings.bool('claim_evidence.sw_telemetry')) return;
  ah.metric('claim_evidence_fired', ['rule', rule]);
  ah.advisory('claim_evidence', 'fired_' + rule);
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
    // rule 1 reads quoted text too (quote marks out, code, fences and blockquotes still masked): a quote is covered only by a
    // reporting verb that opens its clause, never by its quote marks alone
    var seen = [], scan1 = ah.text.maskQuoted(ceUnquote(reply));
    claim = ceFindClaim(scan1, seen);
    // a claim that exists only inside code, a fence or a blockquote is suppressed (the masked scan cannot see it)
    if (claim === null && scan1 !== reply) {
      var raw = [], rawClaim = ceFindClaim(reply, raw);
      if (rawClaim !== null) seen.push([ah.cfg('claim_evidence.quoted_reason'), rawClaim.quote, rawClaim.row.id]);
    }
    ceLogSuppressed(seen);
    ceCountSuppressed(seen);
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
  ceCountFired(what === ah.cfg('claim_evidence.msg_pushed_what') ? 'pushed' : 'claim');
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

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
function ceAny(list, t, flags) {
  for (var i = 0; i < list.length; i++) {
    var r = ah.re.find(list[i], flags === undefined ? 'i' : flags, t);
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
  return ceSentencesAt(t).map(function (x) { return x.s; });
}

// The sentences of `t` with the offset each starts at.
function ceSentencesAt(t) {
  var re = ah.cfg('claim_evidence.sentence_end_re'), out = [], rest = t, at = 0;
  for (;;) {
    var m = ah.re.find(re, 'i', rest);
    if (!m || m[1] <= 0) break;
    out.push({ s: rest.slice(0, m[0]), at: at });
    at += m[1];
    rest = rest.slice(m[1]);
  }
  out.push({ s: rest, at: at });
  return out;
}

// #972 wave 2: the text that governs a sentence starting at `at`: its paragraph (claim_evidence.paragraph_break_re) plus the nearest
// heading line (claim_evidence.heading_line_re) at or before the paragraph's start.
function ceScope(t, at) {
  var br = ah.cfg('claim_evidence.paragraph_break_re'), start = 0, end = t.length, off = 0;
  for (;;) {
    var m = ah.re.find(br, '', t.slice(off));
    if (!m || m[1] <= m[0]) break;
    var a = off + m[0], b = off + m[1];
    if (b <= at) start = b;
    else if (a >= at) { end = a; break; }
    off = b;
  }
  var head = '', lines = t.slice(0, start).split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    if (ah.re.find(ah.cfg('claim_evidence.heading_line_re'), '', lines[i])) { head = lines[i]; break; }
  }
  return head + '\n' + t.slice(start, end);
}

// #972 wave 2: the claim's paragraph or heading attributes the result to another agent AND says it was not verified here.
function ceAttributedUnverified(scope) {
  return scope !== '' && ceAny(ah.cfg('claim_evidence.attribution_res'), scope) !== null && ceAny(ah.cfg('claim_evidence.unverified_scope_res'), scope) !== null;
}

// Where the text of `sent` that governs a claim found at `a` starts: after the last clause break before it (or `win` chars back, the nearer).
// With guards.claimEvidenceStrict on, a comma (claim_evidence.clause_join_break_re) that closes an 'according to <source>' phrase (claim_evidence.clause_join_re) does not end the
// clause: the source still governs the words after its comma ('According to the PR body, the change is merged').
function ceStart(sent, a) {
  var br = ah.cfg('claim_evidence.clause_break_re'), before = sent.slice(0, a), from = 0, off = 0, strict = ceStrict();
  for (;;) {
    var m = ah.re.find(br, 'i', before.slice(off));
    if (!m || m[1] <= m[0]) break;
    if (strict && ah.re.find(ah.cfg('claim_evidence.clause_join_break_re'), 'i', before.slice(off + m[0], off + m[1])) &&
        ah.re.find(ah.cfg('claim_evidence.clause_join_re'), 'i', before.slice(0, off + m[0]))) {
      off = off + m[1];
      continue;
    }
    from = off + m[1];
    off = from;
  }
  return Math.max(from, a - ah.cfgNum('claim_evidence.skip_window'));
}

// Switch guards.claimEvidenceStrict: the suppressor checks of GH #427 (compound or noun source words, filler openers, negated labels).
function ceStrict() { return ah.settings.bool('claim_evidence.sw_strict'); }

// Counter (guards.claimEvidenceTelemetry): a suppressor candidate the strict checks refused, by reason. A lost count never changes a decision.
function ceRejected(reason) {
  if (!ah.settings.bool('claim_evidence.sw_telemetry')) return;
  ah.metric('claim_evidence_suppressor_rejected', ['reason', reason]);
  ah.advisory('claim_evidence', 'rejected_' + reason);
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
// and is not an idiom (`row.idiom`, a regex key or absent, matched against the hit and the text after it: 'Once again ...', 'No doubt ...' cover nothing).
// With guards.claimEvidenceStrict on, three more checks refuse a hit (GH #427): `row.idiom_strict` (filler openers: 'If you ask', 'If true'),
// `row.noun_before` (a reporting verb that is a noun after an article: 'the reports') and `row.compound` (a source word that is the start of
// a compound: 'doc-string', 'report-card'); each refusal is counted in claim_evidence_suppressor_rejected {reason}.
function ceInReach(list, head, reach, row) {
  var strict = ceStrict();
  var idiom = row.idiom ? ah.cfg(row.idiom) : null;
  var filler = strict && row.idiom_strict ? ah.cfg(row.idiom_strict) : null;
  var noun = strict && row.noun_before ? ah.cfg(row.noun_before) : null;
  var comp = strict && row.compound ? ah.cfg(row.compound) : null;
  for (var i = 0; i < list.length; i++) {
    var all = ah.re.findAll(list[i], 'i', head);
    for (var j = 0; j < all.length; j++) {
      if (ceGapWords(head.slice(all[j][1])) > reach) continue;
      var from = head.slice(all[j][0]);
      if (idiom !== null && ah.re.find(idiom, 'i', from)) continue;
      if (filler !== null && ah.re.find(filler, 'i', from)) { ceRejected('filler_opener'); continue; }
      if (noun !== null && ah.re.find(noun, 'i', head.slice(0, all[j][0]))) { ceRejected('source_noun'); continue; }
      if (comp !== null && ah.re.find(comp, 'i', head.slice(all[j][1]))) { ceRejected('source_compound'); continue; }
      return true;
    }
  }
  return false;
}

// True when an honest label (claim_evidence.ack_res) in the claim's own sentence sits within reach_label counted words of the claim.
function ceLabelled(sent, hit) {
  var list = ah.cfg('claim_evidence.ack_res'), reach = ah.cfgNum('claim_evidence.reach_label'), strict = ceStrict();
  for (var i = 0; i < list.length; i++) {
    var all = rp.wordHits(list[i], 'i', sent);
    for (var j = 0; j < all.length; j++) {
      // GH #427: a label word that is itself negated ('not unverified') or used as a noun/aside ('unchecked boxes', 'unverified aside') is no label
      if (strict && (ah.re.find(ah.cfg('claim_evidence.ack_before_not_re'), 'i', sent.slice(0, all[j][0])) || ah.re.find(ah.cfg('claim_evidence.ack_after_not_re'), 'i', sent.slice(all[j][1])))) {
        ceRejected('label_not_a_label');
        continue;
      }
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
    if (ceInReach(ah.cfg(sup[i].list), head, ah.cfgNum(sup[i].reach), sup[i])) return { reason: sup[i].reason, chain: sup[i].chain === true };
  }
  var aft = ah.cfg('claim_evidence.suppress_after'), tail = sent.slice(hit[1]);
  for (var a = 0; a < aft.length; a++) {
    var pl = ah.cfg(aft[a].list), pre = aft[a].before ? ah.cfg(aft[a].before) : null, lead = sent.slice(0, hit[0]), ok = pre === null;
    for (var c = 0; pre !== null && c < pre.length && !ok; c++) ok = !!ah.re.find(pre[c], 'i', lead); // the claim must sit in a plan (a later list item or a Plan: line)
    for (var b = 0; ok && b < pl.length; b++) if (ah.re.find(pl[b], 'i', tail)) return { reason: aft[a].reason, chain: false };
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
  var rows = ah.cfg('claim_evidence.claims'), at = ceSentencesAt(scan), sents = at.map(function (x) { return x.s; });
  for (var k = 0; k < sents.length; k++) {
    var scoped = null; // whether the sentence's paragraph or heading marks its results as another agent's, unverified (computed once, on a hit)
    // every hit of every row, in text order, so a consequent follows the condition it depends on
    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      var all = ah.re.findAll(rows[i].re, 'i', sents[k]);
      for (var j = 0; j < all.length; j++) {
        var hitText = sents[k].slice(all[j][0], all[j][1]);
        if (typeof rows[i].not_after === 'string' && (typeof rows[i].not_after_hit !== 'string' || ah.re.find(rows[i].not_after_hit, 'i', hitText)) && ah.re.find(rows[i].not_after, 'i', sents[k].slice(0, all[j][0]))) { seen.push([ah.cfg('claim_evidence.nonsoftware_reason'), sents[k].slice(all[j][0], all[j][1]), rows[i].id]); continue; }
        // a name, not a claim: the hit ends in a capitalised word that a capitalised word follows ('is Live Activity'); case-sensitive
        if (typeof rows[i].not_before === 'string' && (typeof rows[i].not_before_hit !== 'string' || ah.re.find(rows[i].not_before_hit, '', hitText)) && ah.re.find(rows[i].not_before, '', sents[k].slice(all[j][1]))) { seen.push([ah.cfg('claim_evidence.featurename_reason'), hitText, rows[i].id]); continue; }
        hits.push([all[j][0], all[j][1], i]);
      }
    }
    hits.sort(function (x, y) { return x[0] - y[0] || x[2] - y[2]; });
    var prev = null;
    for (var h = 0; h < hits.length; h++) {
      var why = ceReason(sents[k], hits[h], prev), quote = sents[k].slice(hits[h][0], hits[h][1]), row = rows[hits[h][2]];
      if (why === null) {
        if (scoped === null) scoped = ceAttributedUnverified(ceScope(scan, at[k].at));
        if (scoped) why = { reason: ah.cfg('claim_evidence.attributed_reason'), chain: false };
      }
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

// The tool calls of the last `n` of the transcript as [command, output text, tool name, errored] (command '' for a call without one, output '' when the
// result is not in the window), in order: the output a call returned is the tool_result block that names its tool_use id.
function ceTurnCalls(tp, n) {
  var lines = ah.fs.tailLines(tp, ah.cfgNum('claim_ledger.window_bytes'), true, ['tool_use', 'tool_result']);
  if (lines === null) return null;
  var uses = [], outs = {}, errs = {};
  for (var i = 0; i < lines.length; i++) {
    var e;
    try { e = JSON.parse(lines[i]); } catch (x) { continue; }
    var c = e && e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (var j = 0; j < c.length; j++) {
      var b = c[j];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') uses.push({ id: b.id, name: typeof b.name === 'string' ? b.name : '', cmd: b.input && typeof b.input.command === 'string' ? b.input.command : '' });
      else if (b.type === 'tool_result') {
        var t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(function (x) { return x && typeof x.text === 'string' ? x.text : ''; }).join('\n') : '';
        outs[b.tool_use_id] = t;
        if (b.is_error === true) errs[b.tool_use_id] = true;
      }
    }
  }
  return uses.slice(Math.max(0, uses.length - n)).map(function (u) { return [u.cmd, typeof outs[u.id] === 'string' ? outs[u.id] : '', u.name, errs[u.id] === true]; });
}

// GH #376 (claim_evidence.log_read_counts): true when a read of a log or output file ran this turn (claim_evidence.log_read_res) and every
// figure of the claim is a whole number the output of such reads spells next to a pass / fail / test / check word
// (claim_evidence.output_pass_res, output_fail_res, output_bare_res: a line number, a version, a hash digit or a size is no count; 1 is not found inside 142; the figure in
// the prompt, in a command or in an earlier turn does not count). The read verbs are matched case-sensitively (git's HEAD is not head). A claim with no figure is never backed by a read alone.
function ceLogReadBacks(claim, tp, tools) {
  if (!ah.settings.bool('claim_evidence.log_read_counts')) return false;
  var re = ah.cfg('claim_evidence.figure_re'), figs = ah.re.findAll(re, 'i', claim.quote);
  if (!figs.length) return false;
  var calls = ceTurnCalls(tp, tools), reads = ah.cfg('claim_evidence.log_read_res');
  if (calls === null) return false;
  var passRes = ah.cfg('claim_evidence.output_pass_res'), failRes = ah.cfg('claim_evidence.output_fail_res');
  var bareRes = ah.cfg('claim_evidence.output_bare_res'), listRes = ah.cfg('claim_evidence.output_listing_res');
  var passHave = {};
  for (var i = 0; i < calls.length; i++) {
    if (calls[i][0] === '' || ceAny(reads, calls[i][0], '') === null) continue;
    var out = calls[i][1], p = ceNums(passRes, re, out), f = ceNums(failRes, re, out), bare = ceNums(bareRes, re, out, ceSpans(listRes, out));
    var failSeen = false, k;
    for (k in f.map) if (Number(k) > 0) failSeen = true;
    for (k in p.map) passHave[k] = true;
    // a bare "N tests" count says nothing about pass or fail: it backs a pass claim only when this output shows no failure
    if (!failSeen) for (k in bare.map) passHave[k] = true;
  }
  for (var q = 0; q < figs.length; q++) {
    var want = Number(claim.quote.slice(figs[q][0], figs[q][1]).replace(/,/g, ''));
    if (!isFinite(want)) return false;
    if (passHave[want] !== true) return false;
  }
  return true;
}

// The tool uses since the last OWNER prompt of the transcript: the evidence walk restarts its tool count at every user line that is
// no tool result, so a task notification, system reminder or teammate message that lands between a check and the reply made the
// check vanish ("no matching check run this turn"). A user line that matches block_cap.injected_re (the engine's list of non-owner
// text) is no turn boundary here. Returns null when the transcript cannot be read.
function ceToolsSinceOwner(tp) {
  var lines = ah.fs.tailLines(tp, ah.cfgNum('claim_ledger.window_bytes'), true, ['tool_use', ah.cfg('claim_evidence.user_line_needle')]);
  if (lines === null) return null;
  var n = 0, bounded = false, injected = ah.cfg('block_cap.injected_re');
  for (var i = 0; i < lines.length; i++) {
    var e;
    try { e = JSON.parse(lines[i]); } catch (x) { continue; }
    var m = e && e.message, c = m && m.content;
    if (!m || (e.type !== 'user' && m.role !== 'user')) {
      if (Array.isArray(c)) for (var a = 0; a < c.length; a++) if (c[a] && c[a].type === 'tool_use') n++;
      continue;
    }
    var text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(function (b) { return b && b.type === 'tool_result' ? null : b && typeof b.text === 'string' ? b.text : ''; }).join('\n') : '';
    if (Array.isArray(c) && c.some(function (b) { return b && b.type === 'tool_result'; })) continue;
    if (!text.trim() || ah.re.find(injected, 'i', text)) continue;
    n = 0;
    bounded = true;
  }
  // no owner prompt in the window: the turn's start is unknown, so no earlier tool use may back the reply
  return bounded ? n : null;
}

// claim_evidence.tool_evidence: true when a tool call of this turn that is not a shell command backs the claim by its OWN success result.
// A row names the claim ids it backs (claims), the tool's name (tool_re, matched case-sensitively against the tool_use name) and the
// result that tool must have returned (result_re, matched against the tool_result text of that very call, which the reply cannot write).
// An errored result never backs anything; the words of the reply and of the command line are never read.
function ceToolBacks(claim, tp, tools) {
  var rows = ah.cfg('claim_evidence.tool_evidence');
  if (!Array.isArray(rows) || !rows.length) return false;
  var calls = ceTurnCalls(tp, tools);
  if (calls === null) return false;
  for (var i = 0; i < calls.length; i++) {
    if (calls[i][3] === true || !calls[i][2]) continue;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].claims.indexOf(claim.row.id) < 0) continue;
      if (ah.re.find(rows[r].tool_re, '', calls[i][2]) && ah.re.find(rows[r].result_re, 'i', calls[i][1])) return true;
    }
  }
  return false;
}

// spans of every pattern of a list in a text
function ceSpans(res, text) {
  var all = [];
  for (var j = 0; j < res.length; j++) all = all.concat(ah.re.findAll(res[j], 'i', text));
  return all;
}

// the whole numbers the spans of a pattern list spell in a text; a span starting inside a skip span is left out
function ceNums(res, re, text, skip) {
  var map = {}, spans = ceSpans(res, text);
  for (var m = 0; m < spans.length; m++) {
    var gone = false;
    for (var s = 0; skip && s < skip.length; s++) if (spans[m][0] >= skip[s][0] && spans[m][0] < skip[s][1]) gone = true;
    if (gone) continue;
    var piece = text.slice(spans[m][0], spans[m][1]), nums = ah.re.findAll(re, 'i', piece);
    for (var k = 0; k < nums.length; k++) map[Number(piece.slice(nums[k][0], nums[k][1]).replace(/,/g, ''))] = true;
  }
  return { map: map };
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

// The cells of one markdown table row (the outer pipes dropped).
function ceCells(line, pipe) {
  var t = line.trim();
  if (t.indexOf(pipe) === 0) t = t.slice(pipe.length);
  if (t.length >= pipe.length && t.slice(t.length - pipe.length) === pipe) t = t.slice(0, t.length - pipe.length);
  return t.split(pipe);
}

// claim_evidence.mask_table_header: the header row of a markdown table and its separator are labels, not statements, so a column named
// "Verified" or "Merged" is not a claim. Only a genuine header is masked: the first row of its table (the line above it holds no pipe),
// with a separator of as many cells, every cell of which is a label (claim_evidence.table_label_cell_re: a few words, no sentence
// punctuation). A body row, a row with an assertion in a cell, a lone pipe row and a rule line (`---`) are all still scanned. The line
// breaks stay, so nothing else moves.
function ceMaskTableHeader(text0) {
  if (!ah.settings.bool('claim_evidence.sw_mask_table_header')) return text0;
  var sep = ah.cfg('claim_evidence.table_sep_re'), pipe = ah.cfg('claim_evidence.table_pipe'), label = ah.cfg('claim_evidence.table_label_cell_re'), lines = text0.split('\n'), original = lines.slice();
  for (var i = 1; i < lines.length; i++) {
    if (!ah.re.test(sep, '', lines[i]) || lines[i - 1].indexOf(pipe) < 0) continue;
    if (i >= 2 && original[i - 2].indexOf(pipe) >= 0) continue; // the line above is a table row too: this one is a body row, not a header
    var head = ceCells(lines[i - 1], pipe);
    if (head.length !== ceCells(lines[i], pipe).length) continue;
    if (!head.every(function (c) { return ah.re.test(label, '', c); })) continue;
    lines[i - 1] = lines[i - 1].replace(/[^\s]/g, ' ');
    lines[i] = '';
  }
  return lines.join('\n');
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

  // the cheap gate: the reply alone, with quoted text and code removed (and the table headers, which only label columns)
  var sreply = ceMaskTableHeader(reply);
  var scan = ah.text.maskQuoted(sreply), claim = null, done = false;
  if (r1) {
    // rule 1 reads quoted text too (quote marks out, code, fences and blockquotes still masked): a quote is covered only by a
    // reporting verb that opens its clause, never by its quote marks alone
    var seen = [], scan1 = ah.text.maskQuoted(ceUnquote(sreply));
    claim = ceFindClaim(scan1, seen);
    // a claim that exists only inside code, a fence or a blockquote is suppressed (the masked scan cannot see it)
    if (claim === null && scan1 !== sreply) {
      var raw = [], rawClaim = ceFindClaim(sreply, raw);
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
  if (claim !== null && tools === 0) { var since = ceToolsSinceOwner(tpOpen); if (since !== null && since > 0) tools = since; }
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
      if (cmds !== null && !ceAnyCmd(needs, cmds)) {
        if (ceLogReadBacks(claim, tpOpen, tools)) {
          if (ah.settings.bool('claim_evidence.sw_telemetry')) ah.metric('claim_evidence_log_read_ok', ['claim', claim.row.id]);
        } else if (ceToolBacks(claim, tpOpen, tools)) {
          if (ah.settings.bool('claim_evidence.sw_telemetry')) ah.metric('claim_evidence_tool_ok', ['claim', claim.row.id]);
        } else what = text.render(ah.cfg('claim_evidence.msg_claim_what'), { claim: claim.row.id, quote: text.clean(claim.quote) });
      }
    }
  }
  if (what === null) return 'allow';
  var instead = what === ah.cfg('claim_evidence.msg_pushed_what') ? ah.cfg('claim_evidence.msg_pushed_instead') : ah.cfg('claim_evidence.msg_claim_instead');
  // rule 1 names the check that would satisfy the claim row (its `check` text), so the hold says what to run, not only that it failed
  if (what !== ah.cfg('claim_evidence.msg_pushed_what') && claim !== null && typeof claim.row.check === 'string') {
    instead = text.render(ah.cfg('claim_evidence.msg_satisfy'), { check: claim.row.check });
  }
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

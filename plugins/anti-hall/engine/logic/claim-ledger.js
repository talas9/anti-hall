// check = "claim-ledger" (Stop; ledger only, never blocks, never prints). Cross-checks the last assistant message against the evidence
// the session produced (tool results, tool inputs, hook attachments, user prompts in the last two megabytes of the transcript) and
// records every checkable token whose referent never appeared: a count with a unit noun, a git SHA, "task N of", "N days ago", a
// runtime-state claim made in a turn with no tool call. The record goes to ~/.anti-hall/claim-ledger/<session>.jsonl and the hash of
// the last message to <session>.last, so one message is recorded once; every flag is then asked on the shared Jev lane without
// waiting (the answer only reaches the Jev decision log). The transcript is read by ah.transcript.evidence (the records as plain
// text, in order) and the numbers of the evidence come from ah.re.numbers (one native pass); the rest is decided here. A relative
// transcript path or a line only JavaScript reads defers to Node. Mirrors hooks/claim-ledger.js. Keys and texts: response_guards.toml
// (claim_ledger.*).
'use strict';

function clCollapse(s) { return s.normalize('NFC').replace(/\s+/g, ' ').trim(); }

function clWalk(items, payloadText) {
  var allowNoReply = payloadText !== null, payloadNorm = allowNoReply ? clCollapse(payloadText) : null;
  var ev = [], tools = 0, last = null, i;
  var pushEv = function (text) {
    if (payloadNorm !== null) { var n = clCollapse(text); if (n !== '' && payloadNorm.indexOf(n) >= 0) return; }
    ev.push(text);
  };
  for (i = 0; i < items.length; i++) {
    var it = items[i], kind = it[0];
    if (kind === 'p') { tools = 0; ev.push(it[1]); }
    else if (kind === 'r' || kind === 'a') ev.push(it[1]);
    else if (kind === 'i') { tools++; ev.push(it[1]); }
    else if (kind === 't') {
      var id = it[2];
      if (last && id !== null && last.id === id) { last.text += '\n' + it[1]; last.tools = tools; }
      else { if (last) pushEv(last.text); last = { id: id, text: it[1], tools: tools }; }
    }
  }
  if (!last) {
    if (!allowNoReply) return null;
    var j = ev.join('\n');
    return { lastText: '', evidence: j, toolsThisTurn: tools, evidenceWithLast: j, toolsAtEnd: tools };
  }
  var evidence = ev.join('\n');
  return { lastText: last.text, evidence: evidence, toolsThisTurn: last.tools, evidenceWithLast: evidence + '\n' + last.text, toolsAtEnd: tools };
}

function clDecimals(s) { var i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }

// Some evidence number equals the claimed one at the claim's own precision. `nums` is sorted ascending: the nearest two bound the test.
function clNumberIn(token, nums) {
  var clean = token.replace(/,/g, ''), target = Number(clean);
  if (!isFinite(target)) return true;
  var tol = 0.5 * Math.pow(10, -clDecimals(clean));
  var lo = 0, hi = nums.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (nums[mid] < target) lo = mid + 1; else hi = mid; }
  return (lo < nums.length && Math.abs(nums[lo] - target) <= tol) || (lo > 0 && Math.abs(nums[lo - 1] - target) <= tol);
}

function clContext(text, idx) {
  var start = text.lastIndexOf('\n', idx) + 1, end = text.indexOf('\n', idx);
  if (end < 0) end = text.length;
  return text.slice(start, end).slice(0, ah.cfgNum('claim_ledger.context_chars'));
}

function clFlags(text, evidence, tools) {
  var flags = [], max = ah.cfgNum('claim_ledger.max_flags'), m, re;
  var push = function (cls, kind, token, idx) { if (flags.length < max) flags.push({ cls: cls, kind: kind, token: token, context: clContext(text, idx) }); };
  var nums = null;
  re = new RegExp(ah.cfg('claim_ledger.count_js_re'), 'gi');
  while ((m = re.exec(text)) !== null) {
    if (nums === null) nums = ah.re.numbers(ah.cfg('claim_ledger.number_re'), '', evidence, ',');
    if (!clNumberIn(m[1], nums)) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_count'), m[0], m.index);
  }
  re = new RegExp(ah.cfg('claim_ledger.sha_re'), 'g');
  while ((m = re.exec(text)) !== null) {
    if (/^\d+$/.test(m[0])) continue;
    if (evidence.indexOf(m[0]) < 0) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_sha'), m[0], m.index);
  }
  re = new RegExp(ah.cfg('claim_ledger.task_re'), 'gi');
  while ((m = re.exec(text)) !== null) {
    if (evidence.indexOf(m[0]) < 0) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_task'), m[0], m.index);
  }
  if (tools === 0) {
    re = new RegExp(ah.cfg('claim_ledger.state_re'), 'gi');
    while ((m = re.exec(text)) !== null) push(ah.cfg('claim_ledger.cls_soft'), ah.cfg('claim_ledger.kind_state'), m[0], m.index);
  }
  re = new RegExp(ah.cfg('claim_ledger.days_ago_re'), 'gi');
  while ((m = re.exec(text)) !== null) push(ah.cfg('claim_ledger.cls_soft'), ah.cfg('claim_ledger.kind_days_ago'), m[0], m.index);
  return flags;
}

function clAsk(flag, sessionId, projectFrom, transcript) {
  var spec = {
    id: ah.cfg('claim_ledger.jev_id'),
    question: { type: 'noul', instructions: ah.cfg('claim_ledger.jev_instructions'), criteria: [['true', ah.cfg('claim_ledger.jev_true')], ['false', ah.cfg('claim_ledger.jev_false')]] },
    state: 'claim: ' + flag.token + '\ncontext: ' + flag.context, trust: 'relax-block', baseline: true,
    cacheKey: flag.kind + '\u0001' + flag.token + '\u0001' + flag.context, sessionId: sessionId,
  };
  if (transcript !== null) spec.turnRefFrom = transcript;
  if (projectFrom !== null) spec.projectFrom = projectFrom;
  // best effort, as Node's try/catch: the shadow question of a flag whose context holds half a surrogate pair (a cut through an
  // astral character) cannot be sent as UTF-8 text and is skipped; the ledger above is already written
  try { ah.jev.ask(spec); } catch (e) { /* shadow only */ }
}

function decide(p) {
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  if (spawn.osHome() === null) return 'defer';
  if (!ah.settings.bool('claim_ledger.setting') || ah.settings.skipped(ah.cfg('claim_ledger.guard_name'))) return 'allow';
  var tp = p && p.transcript_path;
  if (!tp || typeof tp !== 'string') return 'allow';
  var ev = ah.transcript.evidence(tp, ah.cfgNum('claim_ledger.window_bytes'));
  if (ev === null) return 'allow';
  if (ev.unsure) return 'defer';
  var payloadText = typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim() !== '' ? p.last_assistant_message : null;
  var walked = clWalk(ev.items, payloadText);
  if (!walked) return 'allow';
  var reply = walked.lastText, evidence = walked.evidence, tools = walked.toolsThisTurn, fromPayload = false;
  if (payloadText !== null) {
    var nPay = clCollapse(payloadText), nLast = clCollapse(walked.lastText);
    if (nLast === '' || nPay.indexOf(nLast) < 0) { reply = payloadText; evidence = walked.evidenceWithLast; tools = walked.toolsAtEnd; fromPayload = true; }
    else if (nPay !== nLast) reply = payloadText;
  }
  var sid = (p.session_id && String(p.session_id)) || ah.sha1(tp).slice(0, 16);
  var safe = sid.replace(/[^A-Za-z0-9_.-]/g, '_');
  var dir = ah.cfg('replykit.state_dir') + '/' + ah.cfg('claim_ledger.dir'), lastRel = dir + '/' + safe + ah.cfg('claim_ledger.last_ext');
  var hash = ah.sha1(reply), prev = ah.state.readText(lastRel);
  if (prev !== null && prev.trim() === hash) return 'allow';
  var flags = clFlags(reply, evidence, tools);
  try {
    ah.state.writeAtomic(lastRel, hash);
    if (flags.length) {
      ah.state.appendFile(dir + '/' + safe + ah.cfg('claim_ledger.ledger_ext'), JSON.stringify({
        ts: new Date(ah.clock.now()).toISOString(), session: safe, hash: hash, tools_this_turn: tools, msg_chars: reply.length,
        evidence_chars: evidence.length, window_truncated: ev.truncated, flags: flags,
      }) + '\n');
    }
  } catch (e) { /* best effort, as Node: a lost record never changes the answer */ }
  var cwd = typeof p.cwd === 'string' ? p.cwd : null;
  for (var i = 0; i < flags.length; i++) clAsk(flags[i], sid, cwd, fromPayload ? null : tp);
  return 'allow';
}

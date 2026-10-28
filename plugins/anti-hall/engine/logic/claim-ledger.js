// check = "claim-ledger" (Stop; ledger only, never blocks, never prints). Cross-checks the last assistant message against the evidence
// the session produced (tool results, tool inputs, hook attachments, user prompts in the last two megabytes of the transcript) and
// records every checkable token whose referent never appeared: a count with a unit noun, a git SHA, "task N of", "N days ago", a
// runtime-state claim made in a turn with no tool call. The record goes to ~/.anti-hall/claim-ledger/<session>.jsonl and the hash of
// the last message to <session>.last, so one message is recorded once; every flag is then asked on the shared Jev lane without
// waiting (the answer only reaches the Jev decision log). The transcript is read by ah.transcript.evidence (the records as plain
// text, in order) is walked by the engine (ah.transcript.evidenceWalk: the merge of one message's text, the payload skip, the join) and
// stays there; this script asks it whether a token is in it (walkHas) and for its numbers (walkNumbers), so no megabyte string is
// ever built in the interpreter; the rest is decided here. The home is Node's os.homedir() (hookProc.adoptHome: HOME unset adopts
// the passwd home); a relative transcript path is opened from the absolute payload cwd. What the engine cannot reproduce exactly
// records nothing (counted, native_unable): no home, the real home under a test marker, a transcript record only JavaScript reads
// exactly (an unsure walk); a relative HOME or transcript path resolves against the stand-in directory (counted). Mirrors hooks/claim-ledger.js. Keys and texts: response_guards.toml
// (claim_ledger.*).
'use strict';

function clCollapse(s) { return s.normalize('NFC').replace(/\s+/g, ' ').trim(); }

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

// `which` names the engine's kept text: 'evidence' (what the session produced before the last reply) or 'withLast' (and that reply).
function clFlags(text, which, tools) {
  var flags = [], max = ah.cfgNum('claim_ledger.max_flags'), m, re;
  var push = function (cls, kind, token, idx) { if (flags.length < max) flags.push({ cls: cls, kind: kind, token: token, context: clContext(text, idx) }); };
  var nums = null;
  re = new RegExp(ah.cfg('claim_ledger.count_js_re'), 'gi');
  while ((m = re.exec(text)) !== null) {
    if (nums === null) nums = ah.transcript.walkNumbers(which, ah.cfg('claim_ledger.number_re'), '', ',');
    if (!clNumberIn(m[1], nums)) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_count'), m[0], m.index);
  }
  re = new RegExp(ah.cfg('claim_ledger.sha_re'), 'g');
  while ((m = re.exec(text)) !== null) {
    if (/^\d+$/.test(m[0])) continue;
    if (!ah.transcript.walkHas(which, m[0])) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_sha'), m[0], m.index);
  }
  re = new RegExp(ah.cfg('claim_ledger.task_re'), 'gi');
  while ((m = re.exec(text)) !== null) {
    if (!ah.transcript.walkHas(which, m[0])) push(ah.cfg('claim_ledger.cls_hard'), ah.cfg('claim_ledger.kind_task'), m[0], m.index);
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

// Node's os.homedir() for this call: false when there is none or it is the real home under a test marker (Node's own guard then writes nothing);
// a relative HOME is resolved against the stand-in directory (counted).
function clAdopt(p) {
  var why = hookProc.adoptHome();
  if (why === null) return true;
  ah.unable('claim-ledger:' + why);
  ah.log(ah.cfg('claim_ledger.unsure_log_kind'), why);
  if (why !== 'relative_home') return false;
  var h = hookProc.home(p);
  if (h === null) return false;
  ah.useHome(h);
  return true;
}

function decide(p) {
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  if (!clAdopt(p)) return 'allow';
  if (!ah.settings.bool('claim_ledger.setting') || ah.settings.skipped(ah.cfg('claim_ledger.guard_name'))) return 'allow';
  var tp = p && p.transcript_path;
  if (!tp || typeof tp !== 'string') return 'allow';
  var tpOpen = hookProc.open(p, tp); // a relative path opens against the stand-in directory; the session hash below keeps the payload's
  if (hookProc.openKnown(p, tp) === null) ah.unable('claim-ledger:relative_transcript');
  var payloadText = typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim() !== '' ? p.last_assistant_message : null;
  var ev = ah.transcript.evidenceWalk(tpOpen, ah.cfgNum('claim_ledger.window_bytes'), payloadText);
  if (ev === null) return 'allow';
  if (ev.unsure) { ah.unable('claim-ledger:transcript_unsure', 'abandoned'); return 'allow'; } // a transcript JavaScript reads differently: no ledger entry
  if (!ev.walked) return 'allow';
  var reply = ev.lastText, which = 'evidence', evidenceChars = ev.evidenceChars, tools = ev.toolsThisTurn, fromPayload = false;
  if (payloadText !== null) {
    var nPay = clCollapse(payloadText), nLast = clCollapse(ev.lastText);
    if (nLast === '' || nPay.indexOf(nLast) < 0) { reply = payloadText; which = 'withLast'; evidenceChars = ev.withLastChars; tools = ev.toolsAtEnd; fromPayload = true; }
    else if (nPay !== nLast) reply = payloadText;
  }
  var sid = (p.session_id && String(p.session_id)) || ah.sha1(tp).slice(0, 16);
  var safe = sid.replace(/[^A-Za-z0-9_.-]/g, '_');
  var dir = ah.cfg('replykit.state_dir') + '/' + ah.cfg('claim_ledger.dir'), lastRel = dir + '/' + safe + ah.cfg('claim_ledger.last_ext');
  var hash = ah.sha1(reply), prev = ah.state.readText(lastRel);
  if (prev !== null && prev.trim() === hash) return 'allow';
  var flags = clFlags(reply, which, tools);
  try {
    ah.state.writeAtomic(lastRel, hash);
    if (flags.length) {
      ah.state.appendFile(dir + '/' + safe + ah.cfg('claim_ledger.ledger_ext'), JSON.stringify({
        ts: new Date(ah.clock.now()).toISOString(), session: safe, hash: hash, tools_this_turn: tools, msg_chars: reply.length,
        evidence_chars: evidenceChars, window_truncated: ev.truncated, flags: flags,
      }) + '\n');
    }
  } catch (e) { /* best effort, as Node: a lost record never changes the answer */ }
  var cwd = typeof p.cwd === 'string' ? p.cwd : null;
  for (var i = 0; i < flags.length; i++) clAsk(flags[i], sid, cwd, fromPayload ? null : tpOpen);
  return 'allow';
}

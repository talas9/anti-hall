// check = "compact-advice-guard" (Stop, loop-safe). Blocks, once per declaration, a final reply that recommends compacting while the
// context is low or a compact just happened: LOW CONTEXT (context % below autoHandover.pct minus guards.compactAdviceMarginPct) or a
// RECENT COMPACT (a boundary within guards.compactAdviceRecentTurns turns), unless the threshold-fired auto-handover latch allows it.
// Almost no reply recommends compacting, so the cheap tests come first: the final text (last_assistant_message, else the current turn's
// assistant text read by ah.transcript.turnText) must hold the words of a recommendation before the transcript is parsed. The phrase
// rules are lib/76-compact-advice.js (the Node regular expressions); the context and latch are lib/75-ctxbudget.js. Every Stop is
// decided here: the home is Node's os.homedir() (HOME when set, else the passwd home; under a test marker the real
// home is refused as companion/lib/test-home-guard.js does, where Node's hook ends with an error that never blocks); a relative
// transcript path is opened from the absolute payload cwd (hookProc.openKnown); a compact boundary's timestamp is read by jx.isoMs, else
// jx.dateParse. Four cases only V8 or the Node process can decide exactly are decided natively, counted and logged
// (ctxbudget.ca_unsure_log_kind), towards the stricter verdict: a relative or empty HOME and a relative transcript path resolve against
// the stand-in directory, a transcript line the interpreter cannot parse as V8 does leaves the turn to the context reading alone, and a
// latch comparison that needs a compact boundary time neither reader reads takes the boundary as after the fire. Mirrors hooks/compact-advice-guard.js. Keys and
// texts: ctxbudget.toml (ctxbudget.ca_*).
'use strict';

function caAllow(w) {
  if (w.inferred) cb.writeInferred(w.inferred);
  return 'allow';
}

// A compact boundary whose timestamp neither jx.isoMs nor jx.dateParse reads (V8's legacy parser and the local zone decide it).
var CA_UNKNOWN_TS = { unknownTs: true };

// A case only V8 or the Node process decides exactly is decided natively, counted (native_unable) and logged; for a block input the
// stricter reading is taken (an unreadable boundary time counts as compacted after the fire; an unreadable turn is judged on the context reading alone).
function caUnsure(why) { ah.unable('compact-advice-guard:' + why); ah.log(ah.cfg('ctxbudget.ca_unsure_log_kind'), why); }

// Node's resolveHome() (companion/lib/test-home-guard.js over os.homedir(), hookProc.nodeHome): {home, passwd}, {relative: true} (a
// relative or empty HOME, resolved against the stand-in directory), or {allow: why} (no home at all, or the real home refused under a test marker: the Node hook throws, and
// its own try/catch ends it silently).
function caHome() {
  var nh = hookProc.nodeHome();
  if (nh.relative) return { relative: true };
  if (nh.none) return { allow: 'home_none' };
  if (hookProc.testGuarded(nh.home)) return { allow: 'home_test_guard' };
  return nh;
}

// cadv.readTurn with the timestamp forms jx.dateParse reads too (the shared reader stays as the other guards use it).
function caReadTurn(lines) {
  var tsOf = cadv.tsOf;
  cadv.tsOf = function (e) {
    if (!e || typeof e.timestamp !== 'string') return null;
    var ms = jx.isoMs(e.timestamp);
    if (ms === undefined) ms = jx.dateParse(e.timestamp);
    if (ms === undefined) return CA_UNKNOWN_TS;
    return isFinite(ms) ? ms : null;
  };
  try { return cadv.readTurn(lines); } finally { cadv.tsOf = tsOf; }
}

function caBlock(reason) { return { exact: { code: 0, out: text.render(cb.c('ctxbudget.stop_block_line'), { reason: JSON.stringify(reason) }), err: '' } }; }

// The handover budgets a "safe to compact/restart" declaration must meet: the session task list (open tasks, subject length, no
// finished task left in it) and the MEMORY.md index that sits beside the transcript. Returns the breaches as text (empty: within budget).
function caOverBudget(tp) {
  var out = [], done = cb.c('ctxbudget.hb_done_statuses');
  var r = ah.transcript.tasks(tp, 'state', ah.cfgNum('taskstate.tail_bytes'));
  if (r && !r.unsure && !r.unreadable && Array.isArray(r.tasks)) {
    var live = r.tasks.filter(function (t) { return done.indexOf(String(t.status)) < 0; });
    var finished = r.tasks.length - live.length, budget = ah.settings.num('ctxbudget.set_h_task_budget'), maxSubject = ah.settings.num('ctxbudget.set_h_task_subject');
    var long = live.filter(function (t) { return Array.from(String(t.content)).length > maxSubject; }).length;
    if (live.length > budget) out.push(cb.r('ctxbudget.hb_tasks_over', { n: live.length, max: budget }));
    if (finished > 0) out.push(cb.r('ctxbudget.hb_tasks_done', { n: finished }));
    if (long > 0) out.push(cb.r('ctxbudget.hb_subjects_over', { n: long, max: maxSubject }));
  }
  var mem = ah.path.resolveAbs(tp + '/..') + '/' + cb.c('ctxbudget.hb_mem_dir') + '/' + cb.c('ctxbudget.hb_mem_file'), size = ah.fs.size(mem);
  var body = size === null || size === undefined ? null : ah.fs.readText(mem, size);
  if (body !== null && body !== undefined) {
    var lines = body.split('\n'), n = lines.length - (lines[lines.length - 1] === '' ? 1 : 0), chars = Array.from(body).length;
    var maxLines = ah.settings.num('ctxbudget.set_h_mem_lines'), maxChars = ah.settings.num('ctxbudget.set_h_mem_chars');
    if (n > maxLines) out.push(cb.r('ctxbudget.hb_mem_lines_over', { n: n, max: maxLines }));
    if (chars > maxChars) out.push(cb.r('ctxbudget.hb_mem_chars_over', { n: chars, max: maxChars }));
  }
  return out;
}

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  var home = caHome();
  if (home.relative) {
    caUnsure('home_relative');
    var rh = hookProc.home(p);
    if (rh === null) return 'allow';
    ah.useHome(rh);
  }
  if (home.allow) { ah.log(ah.cfg('ctxbudget.ca_unsure_log_kind'), home.allow); return 'allow'; }
  // HOME unset: settings, skips and state are read and written under the passwd home, as Node's os.homedir() does
  if (home.passwd) ah.useHome(home.home);
  if (!ah.settings.bool('ctxbudget.set_compact_advice_guard')) return 'allow';
  if (p === null || typeof p !== 'object' || ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; }) || p.stop_hook_active === true) return 'allow';
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_compact_advice'))) return 'allow';
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : null;
  if (!tp) return 'allow';
  if (hookProc.openKnown(p, tp) === null) caUnsure('relative_transcript'); // no absolute payload cwd: the stand-in directory is used
  tp = hookProc.open(p, tp);
  var tailBytes = cb.n('ctxbudget.tail_bytes');
  // an unreadable transcript allows. A zero-byte window opens and measures the file exactly as the full read does, without
  // pulling it in: most Stops end at `mayAdvise` below and never need the text.
  if (ah.fs.tailLines(tp, 0, false, ['\u0000']) === null) return 'allow';
  var lam = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  if (lam.trim()) {
    if (!cadv.mayAdvise(lam)) return 'allow';
  } else {
    // the final text is the turn's last part: a cheap exact test on the host first, then the whole turn's text (a superset of it)
    var hint = ah.cfg('ctxbudget.advice_prefilter');
    var seen = ah.fs.tailHasAny(tp, tailBytes, ['\\u'], hint.map(function (w) { return w.toLowerCase(); }));
    if (seen === null || !seen) return 'allow';
    var tt = ah.transcript.turnText(tp, cb.n('ctxbudget.tail_bytes'), '');
    if (tt !== null && !tt.unsure && tt.parts && !cadv.mayAdvise(tt.parts.join('\n'))) return 'allow';
  }
  var lines = ah.fs.tailLines(tp, tailBytes, false); // a trailing \r stays: JSON.parse reads past it
  if (lines === null) return 'allow';
  var turn = caReadTurn(lines);
  if (turn === null) {
    // a transcript line only V8 reads exactly: judged on the last message and the context reading alone (no recent-compaction exemption)
    caUnsure('transcript_line');
    turn = { finalText: lam, turnsSinceCompact: null, compactAt: null };
  }
  var finalText = lam.trim() ? lam : turn.finalText;
  if (!cadv.mayAdvise(finalText)) return 'allow';
  var found = cadv.findAdvice(finalText);
  if (!found.length) return 'allow';
  var last = found[found.length - 1];
  if (cadv.lastRetraction(finalText) > last.index) return 'allow';
  var over = caOverBudget(tp);
  if (over.length) {
    return caBlock(text.message('block', cb.c('ctxbudget.ca_guard'), {
      what: cb.r('ctxbudget.hb_what', { phrase: last.phrase, why: over.join(cb.c('ctxbudget.ca_why_join')) }),
      why: cb.c('ctxbudget.hb_why'), instead: cb.c('ctxbudget.hb_instead'),
    }));
  }
  var w = { inferred: null };
  var result = cb.getContextPct(tp, p.session_id, w); // tp is absolute here
  var pct = result && isFinite(result.pct) ? result.pct : null;
  var threshold = ah.settings.num('ctxbudget.set_ah_pct'), margin = ah.settings.num('ctxbudget.set_ca_margin'), window = ah.settings.num('ctxbudget.set_ca_recent');
  var low = pct !== null && pct < threshold - margin;
  var recent = window > 0 && turn.turnsSinceCompact !== null && turn.turnsSinceCompact <= window;
  if (!low && !recent) return caAllow(w);
  var tag = cb.sessionTag(p);
  if (!tag) return caAllow(w);
  var latch = cb.readLatch(tag);
  var firedAt = typeof latch.firedAt === 'number' && isFinite(latch.firedAt) ? latch.firedAt : null;
  // only this comparison needs the boundary's time: one only V8 reads leaves it unknown
  if (turn.compactAt === CA_UNKNOWN_TS && turn.turnsSinceCompact !== null && latch.fired === true && firedAt !== null) { caUnsure('compact_timestamp'); turn.compactAt = null; }
  var compactAfterFire = turn.turnsSinceCompact !== null && (turn.compactAt === null || firedAt === null || turn.compactAt >= firedAt);
  var tokensFired = latch.fired === true && cb.c('ctxbudget.ca_tokens_vias').indexOf(latch.firedVia) !== -1;
  if (latch.fired === true && (!low || tokensFired) && !compactAfterFire) return caAllow(w);
  var hash = ah.sha1(finalText), rel = cb.rel(cb.c('ctxbudget.ca_state_dir'), tag + '.json');
  var prevText = ah.state.readText(rel);
  if (prevText !== null) {
    try { var prev = JSON.parse(prevText); if (prev && prev.hash === hash) return caAllow(w); } catch (e) { /* no state */ }
  }
  if (w.inferred) cb.writeInferred(w.inferred);
  var wrote = false;
  try { wrote = ah.state.writeAtomic(rel, JSON.stringify({ hash: hash, at: ah.clock.now() })); } catch (e) { wrote = false; }
  if (!wrote) return 'allow';
  var why = [pct !== null ? cb.r('ctxbudget.ca_why_pct', { pct: Math.round(pct), threshold: String(threshold) }) : cb.c('ctxbudget.ca_why_unknown')];
  if (recent) {
    var n = turn.turnsSinceCompact;
    why.push(cb.r(n === 0 ? 'ctxbudget.ca_recent_now' : n === 1 ? 'ctxbudget.ca_recent_one' : 'ctxbudget.ca_recent_n', { n: n }));
  }
  var ctx = pct !== null ? cb.r('ctxbudget.ca_ctx_pct', { pct: Math.round(pct) }) : cb.c('ctxbudget.ca_ctx_low');
  return caBlock(text.message('block', cb.c('ctxbudget.ca_guard'), {
    what: cb.r('ctxbudget.ca_what', { phrase: last.phrase, why: why.join(cb.c('ctxbudget.ca_why_join')) }),
    why: cb.c('ctxbudget.ca_why'), instead: cb.r('ctxbudget.ca_instead', { ctx: ctx }),
  }));
}

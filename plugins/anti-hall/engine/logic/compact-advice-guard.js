// check = "compact-advice-guard" (Stop, loop-safe). Blocks, once per declaration, a final reply that recommends compacting while the
// context is low or a compact just happened: LOW CONTEXT (context % below autoHandover.pct minus guards.compactAdviceMarginPct) or a
// RECENT COMPACT (a boundary within guards.compactAdviceRecentTurns turns), unless the threshold-fired auto-handover latch allows it.
// Almost no reply recommends compacting, so the cheap tests come first: the final text (last_assistant_message, else the current turn's
// assistant text read by ah.transcript.turnText) must hold the words of a recommendation before the transcript is parsed. The phrase
// rules are lib/76-compact-advice.js (the Node regular expressions); the context and latch are lib/75-ctxbudget.js. A transcript path
// that is not absolute, a transcript line only V8 reads and a request whose HOME is unset defer to Node. Mirrors
// hooks/compact-advice-guard.js. Keys and texts: ctxbudget.toml (ctxbudget.ca_*).
'use strict';

function caAllow(w) {
  if (w.inferred) cb.writeInferred(w.inferred);
  return 'allow';
}

function caBlock(reason) { return { exact: { code: 0, out: text.render(cb.c('ctxbudget.stop_block_line'), { reason: JSON.stringify(reason) }), err: '' } }; }

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  var home = ah.env.get(ah.cfg('ctxbudget.home_env'));
  if (home === null || !ah.path.isAbsolute(home)) return 'defer';
  if (!ah.settings.bool('ctxbudget.set_compact_advice_guard')) return 'allow';
  if (p === null || typeof p !== 'object' || ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; }) || p.stop_hook_active === true) return 'allow';
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_compact_advice'))) return 'allow';
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : null;
  if (!tp) return 'allow';
  if (!ah.path.isAbsolute(tp)) return 'defer';
  var tail = ah.fs.readTail(tp, cb.n('ctxbudget.tail_bytes'));
  if (tail === null) return 'allow';
  var lam = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  if (lam.trim()) {
    if (!cadv.mayAdvise(lam)) return 'allow';
  } else {
    // the final text is the turn's last part: a cheap exact test on the host first, then the whole turn's text (a superset of it)
    var hint = ah.cfg('ctxbudget.advice_prefilter');
    var lower = tail.toLowerCase();
    if (tail.indexOf('\\u') === -1 && !hint.some(function (w) { return lower.indexOf(w.toLowerCase()) !== -1; })) return 'allow';
    var tt = ah.transcript.turnText(tp, cb.n('ctxbudget.tail_bytes'), '');
    if (tt !== null && !tt.unsure && tt.parts && !cadv.mayAdvise(tt.parts.join('\n'))) return 'allow';
  }
  var lines = tail.split('\n'); // a trailing \r stays: JSON.parse reads past it
  var turn = cadv.readTurn(lines);
  if (turn === null) return 'defer';
  var finalText = lam.trim() ? lam : turn.finalText;
  if (!cadv.mayAdvise(finalText)) return 'allow';
  var found = cadv.findAdvice(finalText);
  if (!found.length) return 'allow';
  var last = found[found.length - 1];
  if (cadv.lastRetraction(finalText) > last.index) return 'allow';
  var w = { inferred: null };
  var result = cb.getContextPct(tp, p.session_id, w);
  if (result === 'defer') return 'defer';
  var pct = result && isFinite(result.pct) ? result.pct : null;
  var threshold = ah.settings.num('ctxbudget.set_ah_pct'), margin = ah.settings.num('ctxbudget.set_ca_margin'), window = ah.settings.num('ctxbudget.set_ca_recent');
  var low = pct !== null && pct < threshold - margin;
  var recent = window > 0 && turn.turnsSinceCompact !== null && turn.turnsSinceCompact <= window;
  if (!low && !recent) return caAllow(w);
  var tag = cb.sessionTag(p);
  if (!tag) return caAllow(w);
  var latch = cb.readLatch(tag);
  var firedAt = typeof latch.firedAt === 'number' && isFinite(latch.firedAt) ? latch.firedAt : null;
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

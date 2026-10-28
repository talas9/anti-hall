// check = "jev-weekly-scorecard" (SessionStart): the weekly Jev scorecard notice of hooks/jev-weekly-scorecard.js. Silent when the weekly
// notice cannot be due (Jev off, the notice switched off, a child workspace, a check already made within the week). When it is due the
// 7-day verdicts are built by the jev-report code (ah.jev.weeklyScorecard: the KEEP / REVIEW / REMOVE verdict of every integration with
// its current mode); the first integration whose verdict is KEEP but mode is not on, or REMOVE but mode is not off, is named, and the
// weekly latch is stamped. A scorecard that could not be built consumes nothing (counted, native_unable: the next session asks again).
// Keys: engine/defaults/session_gates.toml (session_gates.*, jev_weekly.*), jev_report.toml (jevrep.t_verdict_*).
'use strict';

// The first integration of the scorecard (calls descending, the report's own order) whose mode lags its verdict, or null.
function pickCandidate(card) {
  var keep = ah.cfg('jevrep.t_verdict_keep'), remove = ah.cfg('jevrep.t_verdict_remove'), on = ah.cfg('jev_weekly.mode_on'), off = ah.cfg('jev_weekly.mode_off');
  for (var i = 0; i < card.integrations.length; i++) {
    var r = card.integrations[i];
    if (r.suggestion === keep && r.mode !== on) return { id: r.id, to: ah.cfg('jev_weekly.to_on') };
    if (r.suggestion === remove && r.mode !== off) return { id: r.id, to: ah.cfg('jev_weekly.to_off') };
  }
  return null;
}

function decide(p, opts) {
  if (!gates.homeKnown()) { ah.unable('jev-weekly-scorecard:no_home', 'abandoned'); return 'allow'; } // no absolute HOME: no latch to keep
  var root = gates.pluginRoot(opts);
  if (gates.judgeChild()) return 'allow';
  if (!gates.isTrue('session_gates.jev_enabled_setting', gates.legacyEnabledStrict(), root)) return 'allow';
  if (gates.setting('jev_weekly.notice_setting', true, root) === false) return 'allow';
  var child = ah.env.get(ah.cfg('session_gates.child_branch_env'));
  if (child !== null && child.trim() !== '') return 'allow';
  var key = ah.cfg('jev_weekly.latch_key');
  var last = gates.storedTime(ah.cfg('jev_weekly.latch_file'), key);
  var now = Date.now();
  if (now - (last === undefined ? 0 : last) < ah.cfgNum('jev_weekly.period_ms')) return 'allow';
  ah.commit(); // the build below reads the whole decision log: the time limit is lifted from here
  var card = ah.jev.weeklyScorecard();
  if (card === null) { ah.unable('jev-weekly-scorecard:report_not_built', 'abandoned'); return 'allow'; } // nothing is stamped: the week is asked again
  // `writeLatch`: best effort; a failure is swallowed and the notice still shows.
  ah.state.op(ah.home(), 'write', ah.cfg('session_gates.anti_hall_dir') + '/' + ah.cfg('jev_weekly.latch_file'), '{' + JSON.stringify(key) + ':' + Math.floor(now) + '}');
  var c = pickCandidate(card);
  if (c === null) return 'allow';
  var msg = text.message('tip', ah.cfg('jev_weekly.guard'), { what: text.render(ah.cfg('jev_weekly.notice_what'), { id: c.id, to: c.to }), instead: ah.cfg('jev_weekly.notice_instead') });
  return { advisory: text.advisoryJson(gates.eventName(p), msg) };
}

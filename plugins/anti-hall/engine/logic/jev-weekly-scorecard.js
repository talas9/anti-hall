// check = "jev-weekly-scorecard" (SessionStart): the weekly Jev scorecard notice gate. Silent when the notice cannot be due (Jev off, the
// notice off, a child workspace, checked within a week); when it is due and the Jev decision log holds no row, the weekly latch is the
// only effect (the report of an empty log prints nothing); a log with rows defers (the report is Node's). This script builds on
// jev-review-reminder.js (script.includes). Mirrors hooks/jev-weekly-scorecard.js. Keys: session_gates.toml (jev_weekly.*).
'use strict';

// True when the decision log (and its rotated generations `<log>.<n>`) holds no row; false when any non-blank line is there.
function sgNoLogRows(rel) {
  var log = sgDir() + '/' + rel, slash = log.lastIndexOf('/'), dir = log.slice(0, slash), base = log.slice(slash + 1);
  var names = ah.fs.readdir(dir);
  if (names === null) return true; // `fs.readdirSync` failing yields no file at all, the live log included
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    var generation = n.indexOf(base + '.') === 0 && n.length > base.length + 1 && /^[0-9]+$/.test(n.slice(base.length + 1));
    if (n !== base && !generation) continue;
    var f = jx.read(dir + '/' + n);
    if (f.big) return false; // too large to prove empty
    if (f.text === undefined) continue; // an unreadable file (a directory, a dangling link) is skipped, as `readFileSync` throwing is
    if (f.text.split('\n').some(function (l) { return l.trim() !== ''; })) return false;
  }
  return true;
}

function decide(p, opts) {
  if (!sgHomeKnown()) return 'defer';
  var root = sgRoot(opts);
  if (sgJudgeChild()) return 'allow';
  var on = sgIsTrue('session_gates.jev_enabled_setting', sgLegacyEnabledStrict(), root);
  if (on === null) return 'defer';
  if (!on) return 'allow';
  // `get('jev', 'weeklyNotice', true) !== false`
  var notice = sgGet('jev_weekly.notice_setting', true, root);
  if (notice === null) return 'defer';
  if (notice.value === false) return 'allow';
  var child = ah.env.get(sgT('child_branch_env'));
  if (child !== null && child.trim() !== '') return 'allow';
  var key = ah.cfg('jev_weekly.latch_key'), last = sgStoredTime(ah.cfg('jev_weekly.latch_file'), key), now = ah.clock.now();
  if (now - (last === null ? 0 : last) < ah.cfgNum('jev_weekly.period_ms')) return 'allow';
  if (!sgNoLogRows(ah.cfg('jev_weekly.decision_log'))) return 'defer';
  // `writeLatch`: best effort, a failure is swallowed and the (empty) report still runs.
  var body = {}; body[key] = Math.floor(now);
  try { ah.state.writeAtomic(sgT('anti_hall_dir') + '/' + ah.cfg('jev_weekly.latch_file'), JSON.stringify(body)); } catch (e) { /* best effort */ }
  return 'allow';
}

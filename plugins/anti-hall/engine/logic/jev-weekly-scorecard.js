// check = "jev-weekly-scorecard" (SessionStart): the gates of hooks/jev-weekly-scorecard.js. Silent when the weekly notice cannot
// be due; when the check is due and the Jev decision log holds no row it stamps the weekly latch itself; otherwise the Node hook
// builds the report. Keys: engine/defaults/session_gates.toml (session_gates.*, jev_weekly.*).
'use strict';

// True when the weekly report would read no row at all: no retained generation of the decision log (`<log>.<n>` and the log
// itself) holds a line that is not blank. A line that does not parse as JSON is skipped by Node too, but this does not decide
// that, so such a file leaves the report to Node.
function noLogRows(log) {
  var i = log.lastIndexOf('/'), dir = i < 0 ? '.' : log.slice(0, i), base = log.slice(i + 1);
  var names = ah.fs.listDir(dir);
  if (names === null) return true;
  var prefix = base + '.', cap = ah.cfgNum('script.read_max_bytes');
  return names.every(function (name) {
    var rest = name.indexOf(prefix) === 0 ? name.slice(prefix.length) : null;
    if (name !== base && !(rest !== null && /^[0-9]+$/.test(rest))) return true;
    var file = dir + '/' + name, size = ah.fs.size(file);
    if (size !== null && size > cap) throw gates.UNDECIDABLE;
    var t = ah.fs.readText(file);
    return t === null || t.split('\n').every(function (l) { return l.trim() === ''; });
  });
}

function decide(p, opts) {
  if (!gates.homeKnown()) return 'defer';
  return gates.run(function () {
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
    var dir = ah.home() + '/' + ah.cfg('session_gates.anti_hall_dir');
    if (!noLogRows(dir + '/' + ah.cfg('jev_weekly.decision_log'))) return 'defer';
    // `writeLatch`: best effort; a failure is swallowed and the (empty) report still runs.
    ah.state.op(ah.home(), 'write', ah.cfg('session_gates.anti_hall_dir') + '/' + ah.cfg('jev_weekly.latch_file'),
      '{' + JSON.stringify(key) + ':' + Math.floor(now) + '}');
    return 'allow';
  });
}

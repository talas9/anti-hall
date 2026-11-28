// check = "session-banner" (SessionStart). One line shown to the user (the hook's systemMessage): plugin version, how many rules the
// engine enforces, and the blocks of the last session. Off switch ui.banner. Keys and texts: guard_rules.toml (guard_rules.*).
'use strict';

function decide(p, opts, event) {
  if (!jx.isObj(p) || sess.judgeChild()) return 'allow';
  // the session start is recorded whatever the switch says, so the next banner's "last session" is this one (Codex round 2)
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  var counts = ah.sessionBlocks(sid);
  if (!ah.settings.bool('guard_rules.sw_banner')) return 'allow';
  var root = sess.pluginRoot(opts), version = '', files = ah.cfg('guard_rules.manifest_files');
  for (var i = 0; root !== null && version === '' && i < files.length; i++) {
    var raw = ah.fs.readText(root + '/' + files[i]);
    try { version = JSON.parse(raw).version || ''; } catch (e) { version = ''; }
  }
  var last = counts.last > 0 ? text.render(ah.cfg('guard_rules.banner_last'), { blocks: counts.last }) : '';
  var msg = text.render(ah.cfg('guard_rules.banner_text'), { version: version, rules: ah.cfg('guard_rules.rules').filter(function (r) { return r.tier !== 'off'; }).length, last: last });
  return { advisory: JSON.stringify({ systemMessage: msg }) };
}

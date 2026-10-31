// check = "session-summary" (SessionEnd). One line shown to the user: the blocks of the session and the rules that fired most.
// ui.sessionSummary = off | end. Keys and texts: guard_rules.toml (guard_rules.*).
'use strict';

function decide(p, opts, event) {
  if (!jx.isObj(p) || sess.judgeChild() || ah.settings.enum('guard_rules.enum_summary') !== 'end') return 'allow';
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  if (sid === '') return 'allow';
  var counts = ah.sessionBlocks(sid), msg;
  if (counts.current === 0) {
    msg = ah.cfg('guard_rules.summary_none');
  } else {
    var top = counts.top.slice(0, ah.cfgNum('guard_rules.summary_top_n')).map(function (t) { return t[0] + ' x' + t[1]; }).join(', ');
    msg = text.render(ah.cfg('guard_rules.summary_text'), { blocks: counts.current, top: top === '' ? '' : text.render(ah.cfg('guard_rules.summary_top'), { top: top }) });
  }
  return { advisory: JSON.stringify({ systemMessage: msg }) };
}

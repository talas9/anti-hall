// check = "verify-first-full" (SessionStart): injects the verify-first protocol and discipline index for the session, the Claude
// or the Codex text; compact mode names <root>/PROTOCOL.md (a root that cannot be proven answers nothing, Node decides).
// Mirrors hooks/verify-first-full.js `main`. Texts and switches: verify_first.toml.
'use strict';

function decide(p, opts) {
  if (vf.judgeChild() || !ah.settings.bool('verify_first.setting_session')) return 'allow';
  var codex = vf.codexPayload(p), t;
  if (ah.settings.enum('verify_first.setting_level') === 'full') {
    t = ah.cfg(codex ? 'verify_first.full_codex' : 'verify_first.full_claude');
  } else {
    var root = vf.pluginRoot(opts);
    if (root === null) return null;
    t = vf.withRoot(ah.cfg('verify_first.compact_session'), root);
    if (!ah.settings.bool('verify_first.setting_orchestration')) t += '\n' + ah.cfg(codex ? 'verify_first.mn_line_codex' : 'verify_first.mn_line');
  }
  return { advisory: text.advisoryJson('SessionStart', t) };
}

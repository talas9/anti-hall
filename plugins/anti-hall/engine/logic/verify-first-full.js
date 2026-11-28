// check = "verify-first-full" (SessionStart): injects the verify-first protocol and discipline index for the session, the Claude
// or the Codex text; compact mode names <root>/PROTOCOL.md (a root that cannot be proven answers nothing, Node decides).
// Mirrors hooks/verify-first-full.js `main`. Texts and switches: verify_first.toml.
'use strict';

// What this SessionStart owes the session about the protocol ('first', 'resend' or 'repeat'): the shared vf.deliveryKind, so the
// protocol and the orchestration rules follow one rule (a compaction or resume sends the whole text again while
// context.protocolFullAfterCompact is on, #519). The state is one small file per session (verify_first.delivery_*).
function vfDelivery(p) { return vf.deliveryKind(p, 'verify_first.delivery_dir', 'verify_first.delivery_prefix', true); }

function decide(p, opts) {
  if (vf.judgeChild() || !ah.settings.bool('verify_first.setting_session')) return 'allow';
  var codex = vf.codexPayload(p), t;
  if (ah.settings.enum('verify_first.setting_level') === 'full') {
    t = ah.cfg(codex ? 'verify_first.full_codex' : 'verify_first.full_claude');
  } else {
    var root = vf.pluginRoot(opts);
    if (root === null) return null;
    var kind = vfDelivery(p);
    t = vf.withRoot(ah.cfg(kind === 'first' ? 'verify_first.compact_session' : kind === 'resend' ? 'verify_first.resend_session' : 'verify_first.repeat_session'), root);
    if (!ah.settings.bool('verify_first.setting_orchestration')) t += '\n' + ah.cfg(codex ? 'verify_first.mn_line_codex' : 'verify_first.mn_line');
  }
  return { advisory: text.advisoryJson('SessionStart', t) };
}

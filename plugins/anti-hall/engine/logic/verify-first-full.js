// check = "verify-first-full" (SessionStart): injects the verify-first protocol and discipline index for the session, the Claude
// or the Codex text; compact mode names <root>/PROTOCOL.md (a root that cannot be proven answers nothing, Node decides).
// Mirrors hooks/verify-first-full.js `main`. Texts and switches: verify_first.toml.
'use strict';

// What this SessionStart owes the session about the protocol: 'first' (the whole compact text: a fresh context, or no delivery on
// record), 'resend' (a short digest: the session was compacted or resumed since the full text went out) or 'repeat' (one line: the
// full text was delivered earlier in this session and the start is neither fresh nor a compaction or resume). The state is one small
// file per session (verify_first.delivery_*); any problem with it, or a switch off, means 'first', never silence.
function vfDelivery(p) {
  if (!ah.settings.bool('verify_first.setting_once')) return 'first';
  var sid = jx.isObj(p) && typeof p.session_id === 'string' && p.session_id !== '' ? p.session_id : null;
  var home = spawn.stateHome();
  if (sid === null || home.ok === undefined) return 'first';
  var dirRel = ah.cfg('script.write_root') + '/' + ah.cfg('verify_first.delivery_dir'), prefix = ah.cfg('verify_first.delivery_prefix');
  var rel = dirRel + '/' + prefix + '-' + spawn.sanitize(sid) + '.json';
  var seen = ah.fs.readText(ah.path.join(home.ok, rel)) !== null;
  var source = typeof p.source === 'string' ? p.source : '';
  var kind = 'first';
  if (seen && ah.cfg('verify_first.fresh_sources').indexOf(source) < 0) kind = ah.cfg('verify_first.resend_sources').indexOf(source) >= 0 ? 'resend' : 'repeat';
  try { ah.state.writeAtomic(rel, JSON.stringify({ source: source, kind: kind })); } catch (e) { /* a lost write only means the next start sends the whole text */ }
  gk.pruneStale(dirRel, prefix);
  return kind;
}

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

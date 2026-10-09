// check = "verify-first-subagent" (SubagentStart): injects the verify-first protocol into every spawned subagent, compact (it
// names <root>/PROTOCOL.md) or full when context.protocolLevel is full. A plugin root that cannot be proven answers nothing,
// so Node prints the path it derives. Mirrors hooks/verify-first-subagent.js `main`. Texts and switches: verify_first.toml.
'use strict';

function decide(p, opts) {
  if (!ah.settings.bool('verify_first.setting_subagent') || ah.settings.skipped(ah.cfg('verify_first.guard_subagent'))) return 'allow';
  var base;
  if (ah.settings.enum('verify_first.setting_level') === 'full') {
    base = ah.cfg('verify_first.subagent_full');
  } else {
    var root = vf.pluginRoot(opts);
    if (root === null) return null;
    base = vf.withRoot(ah.cfg('verify_first.compact_subagent'), root) + '\n' + ah.cfg('verify_first.worker');
  }
  var t = vf.childWorkspace() ? base + '\n' + ah.cfg('verify_first.child_note') : base;
  return { advisory: text.advisoryJson('SubagentStart', t) };
}

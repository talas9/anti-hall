// check = "devswarm-parent-inbox" (UserPromptSubmit). The silent half of the Node hook: it answers every case where Node
// prints and writes nothing (a Jev judge child, a child workspace, the integration killed or switched off, DevSwarm
// inactive). An active Primary defers to Node, which owns the roster, mailbox and dedupe state. Mirrors
// hooks/devswarm-parent-inbox.js up to its gate. Keys: small_guards.toml (devswarm_prompt.*).
'use strict';

function decide() {
  return devswarmGate.silent(false, 'devswarm_prompt.parent_setting') ? 'allow' : 'defer';
}

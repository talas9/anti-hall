// check = "devswarm-child-turn" (UserPromptSubmit). The silent half of the Node hook: it answers every case where Node
// prints and writes nothing (a Jev judge child, not a child workspace, the integration killed or switched off, DevSwarm
// inactive). An active child defers to Node, which writes the heartbeat and descriptor and renders the mailbox. Mirrors
// hooks/devswarm-child-turn.js up to its gate. Keys: small_guards.toml (devswarm_prompt.*).
'use strict';

function decide() {
  return devswarmGate.silent(true, 'devswarm_prompt.child_setting') ? 'allow' : 'defer';
}

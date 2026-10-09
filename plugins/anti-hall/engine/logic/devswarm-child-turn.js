// check = "devswarm-child-turn" (UserPromptSubmit): the child half of the DevSwarm prompt gate; see devswarm-parent-inbox.js, which this
// script builds on (script.includes). Silent outside an active child workspace; an active child defers to the Node hook, which writes the
// heartbeat and descriptor and renders the mailbox. Mirrors hooks/devswarm-child-turn.js up to the first step that reads anything.
'use strict';

function decide() { return dpSilent('child') ? 'allow' : 'defer'; }

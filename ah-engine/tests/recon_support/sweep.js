'use strict';
// Test support: Node's own reconcileSweepIfDue, the ground truth of the engine's sweep duty. usage: node sweep.js <root> <home>
// Prints the line the supervisor logs for the sweep (compactReconcileForLog).
const path = require('path');
const [root, home] = process.argv.slice(2);
process.env.HOME = home;
process.env.ANTIHALL_CALLER = 'supervisor';
const S = require(path.join(root, 'companion', 'devswarm-supervisor.js'));
const r = S.reconcileSweepIfDue({ home });
process.stdout.write(JSON.stringify(S.compactReconcileForLog(r, null).line) + '\n');

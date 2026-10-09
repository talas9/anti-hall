'use strict';
// Node's reference for the liveness sweep: computeLiveness + writeVerdict for every descriptor readDescriptors accepts, at a
// pinned clock. usage: node lv_reference.js <home> <nowMs> <idleMs> <nudgeWindowMs>
// Prints {id: JSON.stringify(verdict)} (the exact text writeVerdict wrote).
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const [home, now, idle, win] = process.argv.slice(2);
process.env.HOME = home;
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const L = require(path.join(plugin, 'companion', 'lib', 'liveness.js'));
const S = require(path.join(plugin, 'companion', 'devswarm-supervisor.js'));
const out = {};
for (const d of S.readDescriptors(home)) {
  try {
    const v = L.computeLiveness({ descriptor: d, now: Number(now), home, idleThresholdMs: Number(idle), nudgeWindowMs: Number(win) });
    L.writeVerdict(d.id, v, home);
    out[d.id] = fs.readFileSync(L.livenessPathFor(d.id, home), 'utf8');
  } catch (e) { out[d.id] = 'error: ' + String(e && e.message); }
}
process.stdout.write(JSON.stringify(out));

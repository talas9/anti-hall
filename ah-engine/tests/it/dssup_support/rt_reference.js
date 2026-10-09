'use strict';
// Node's reference for the retention sweep, at a pinned clock, with the settings given as environment variables.
//   usage: node rt_reference.js <home> <nowMs> '<env json>'
// Prints Node's sweep result as JSON.
const path = require('path');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const [home, now, envText] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
process.env.HOME = home;
Object.assign(process.env, JSON.parse(envText || '{}'));
const R = require(path.join(plugin, 'companion', 'lib', 'devswarm-retention.js'));
process.stdout.write(JSON.stringify(R.sweep({ home, now: Number(now) })));

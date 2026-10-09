'use strict';
// Node's app sync at a pinned clock against a scratch home: scripts/devswarm.js syncAppState.
//   usage: node as_reference.js <home> <nowMs> <appDb> [dry]
const path = require('path');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const [home, now, appdb, dry] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
process.env.HOME = home;
process.env.ANTIHALL_DEVSWARM_APP_DB = appdb;
const C = require(path.join(plugin, 'scripts', 'devswarm.js'));
const r = C.syncAppState(home, { env: process.env, now: Number(now), dryRun: dry === 'dry' });
process.stdout.write(JSON.stringify({ ok: r.ok, appDb: r.appDb, reason: r.reason || null, archived: r.archived || null, retiredMarkers: r.retiredMarkers || null, names: r.names || null, unknown: r.unknownToAntiHall == null ? null : r.unknownToAntiHall, gapTotal: r.gapTotal == null ? null : r.gapTotal, gapsScanned: !!r.gapsScanned, error: r.error || null }));

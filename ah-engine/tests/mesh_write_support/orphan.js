'use strict';
// D45 stage 2 parity: adds one unread message to a partition no registry row owns (an orphan) in a SCRATCH home's store,
// so the summary refresh needs Node's orphan classification and the engine must hand the verb to Node.
// usage: node orphan.js <home> <repoKey>
const path = require('path');
const store = require(path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));
const [home, repoKey] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const s = store.openStore({ home, hash: repoKey });
const f = { from: 'someone', to: 'orphan-ws', type: 'direct', message: 'nobody reads this', timestamp: 1790000500000, urgency: 'normal', needsReply: false };
store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
s.close();

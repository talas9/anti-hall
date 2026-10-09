'use strict';
// Heartbeat / unread-union parity fixture, run AFTER ack_seed.js on a SCRATCH home, with Node's OWN store code and
// unread module. One JSON spec:
//   { files: [{rel, text}],                 // raw files under the home (inbox NDJSON, cursor files, descriptors, markers)
//     mesh:  [{to, from, ts, hash, message}],      // direct store rows (appendMeshMessage)
//     legacy:[{workspaceId, ts, hash, body}],      // bare rows (appendMessage: no sender), hash may be {legacyOf:{id,index,line}}
//     chmod: [{rel, mode}] }
// usage: node union_seed.js <home> <repoKey> '<spec json>'
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const unread = require(path.join(plugin, 'companion', 'lib', 'devswarm-unread.js'));
const [home, repoKey, specText] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
// a spec of '-' is read from stdin: one argument is capped at 128 KiB on Linux (MAX_ARG_STRLEN), and a large spec exceeds it
const spec = JSON.parse(specText === '-' ? fs.readFileSync(0, 'utf8') : specText);
for (const f of spec.files || []) {
  const p = path.join(home, f.rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, f.text);
}
if ((spec.mesh || []).length || (spec.legacy || []).length) {
  const s = store.openStore({ home, hash: repoKey });
  for (const m of spec.mesh || []) {
    store.appendMeshMessage(s, { from: m.from, to: m.to, type: 'direct', message: m.message, timestamp: m.ts, urgency: 'normal', needsReply: false, hash: m.hash });
  }
  for (const m of spec.legacy || []) {
    const hash = m.hash && typeof m.hash === 'object' ? unread.legacyLineHash(m.hash.legacyOf.id, m.hash.legacyOf.index, m.hash.legacyOf.line) : m.hash;
    s.appendMessage({ workspaceId: m.workspaceId, ts: m.ts, hash, body: m.body });
  }
  s.close();
}
for (const c of spec.chmod || []) fs.chmodSync(path.join(home, c.rel), c.mode);

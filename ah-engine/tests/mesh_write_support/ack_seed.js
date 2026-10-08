'use strict';
// inbox ack-primary parity fixture: adds reader_cursors rows, read receipts, descriptors, legacy cursor files and extra
// registry rows to a SCRATCH home's store, using Node's OWN store code, from one JSON spec:
// { rows: [{partition, ns, reader, value, retiredLine?, updatedAt}], receipts: [{dir, name, rec}],
//   registry: [{id, worktreePath, sessionId}], descriptors: [{id, ...fields}], cursorFiles: [{id, text}], cursorsTable: [{id, value}] }
// usage: node ack_seed.js <home> <repoKey> '<spec json>'
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const [home, repoKey, specText] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const spec = JSON.parse(specText);
const root = path.join(home, '.anti-hall', 'devswarm');
const s = store.openStore({ home, hash: repoKey });
for (const r of spec.registry || []) {
  s.upsertRegistry({ id: r.id, worktreePath: r.worktreePath || null, sessionId: r.sessionId || null, inboxPath: null, cursorPath: null, nudgeCommand: null });
}
if ((spec.rows || []).length) {
  s.readerCursorTxn((tx) => {
    for (const r of spec.rows) {
      const rec = { partition: r.partition, ns: r.ns, reader: r.reader, value: r.value, updatedAt: r.updatedAt };
      if (Object.prototype.hasOwnProperty.call(r, 'retiredLine')) rec.retiredLine = r.retiredLine;
      tx.put(rec);
    }
  });
}
for (const c of spec.cursorsTable || []) s.setCursor(c.id, c.value);
s.close();
for (const r of spec.receipts || []) {
  const dir = path.join(root, 'read-receipts', r.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, r.name + '.json'), JSON.stringify(r.rec));
}
for (const d of spec.descriptors || []) {
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', d.id + '.json'), JSON.stringify(d));
}
for (const c of spec.cursorFiles || []) {
  fs.mkdirSync(path.join(root, 'cursors'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cursors', c.id + '.json'), c.text);
}
for (const f of spec.sessions || []) {
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', f.pid + '.json'), JSON.stringify(f));
}

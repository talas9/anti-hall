'use strict';
// Seeds an isolated HOME for the read-side parity test with Node's OWN writers: a child workspace descriptor with a durable
// NDJSON inbox, and a mesh store (under the repoKey of the given worktree) holding direct rows for that workspace.
// usage: node readside_seed.js <home> <worktree> <id> <ndjsonLines> <storeRows>
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'companion', 'lib');
const store = require(path.join(root, 'devswarm-store.js'));
const repokey = require(path.join(root, 'devswarm-repokey.js'));
const [home, worktree, id, nd, rows] = process.argv.slice(2);
const dir = path.join(home, '.anti-hall', 'devswarm');
const inboxPath = path.join(dir, 'inbox', id + '.ndjson');
const cursorPath = path.join(dir, 'cursors', id + '.json');
fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
const lines = [];
for (let i = 0; i < Number(nd); i++) lines.push(JSON.stringify({ _h: 'h' + i, fromBranch: 'main', message: 'nd ' + i, createdAt: 1790000000000 + i, status: 'unread' }));
fs.writeFileSync(inboxPath, lines.length ? lines.join('\n') + '\n' : '');
fs.writeFileSync(cursorPath, '0');
fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
fs.writeFileSync(path.join(dir, 'workspaces', id + '.json'), JSON.stringify({ id, worktreePath: worktree, inboxPath, cursorPath, registeredAt: 1790000000000 }));
const key = repokey.repoKeyForWorktree(worktree);
if (!key) throw new Error('no repo key for ' + worktree);
const s = store.openStore({ home, workspaceId: id, hash: key });
for (let i = 0; i < Number(rows); i++) {
  s.appendMeshRow({ workspaceId: id, ts: 1790000100000 + i, hash: 'mesh-' + i, body: 'direct ' + i, sender: 'primary', recipient: id, mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: i === 0, origHash: null, instanceNonce: null });
}
s.upsertRegistry({ id, worktreePath: worktree, sessionId: 's1', inboxPath, cursorPath, nudgeCommand: null });
s.close();

'use strict';
// Builds fixture stores with Node's OWN writer (devswarm-store.js), so the rows are exactly what production writes: direct,
// broadcast and heartbeat mesh rows, duplicate-hash attempts (which leave gaps in the AUTOINCREMENT ids), legacy rows with no
// mesh columns, needs-reply questions, cursors, gates set and cleared, reader cursors, and registry rows with every nullable
// field. usage: node fixture.js <home>
const path = require('path');
const fs = require('fs');
const store = require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));
const home = process.argv[2];

const rich = store.openStore({ home, hash: 'rich-aaaaaa' });
const t0 = 1790000000000;
const bodies = ['hello', 'multi\nline\r\nbody\ttab', 'unicode: éè 中文 🚀   \u007f', '', 'quote " backslash \\ slash /', 'x'.repeat(5000), '{"json":"in a body","n":1e3}'];
let n = 0;
for (const ws of ['primary-aaaa1111', 'child-one', 'child-two', '*mesh-broadcast*']) {
  for (let i = 0; i < 9; i++) {
    const m = {
      workspaceId: ws, ts: t0 + (n++) * 1000, hash: store.meshMessageHash({ from: 's' + i, to: ws, type: 'direct', urgency: i % 3 === 0 ? 'high' : 'normal', message: bodies[i % bodies.length] + i, timestamp: String(t0 + n) }),
      body: bodies[i % bodies.length] + i, sender: i % 4 === 0 ? null : 'sender-' + (i % 3), recipient: ws,
      mtype: ws === '*mesh-broadcast*' ? 'broadcast' : (i % 5 === 0 ? 'heartbeat' : 'direct'), urgency: i % 2 ? 'normal' : 'high',
      isHeartbeat: i % 5 === 0, needsReply: i % 3 === 1, origHash: i === 7 ? 'mesh:orig' : null, instanceNonce: i === 2 ? 'nonce-1' : null,
    };
    rich.appendMeshRow(m);
    rich.appendMeshRow(m); // duplicate hash: ignored, but it burns an AUTOINCREMENT id
  }
}
rich.appendMessage({ workspaceId: 'child-one', ts: t0 + 99999, hash: 'legacy:abc', body: 'legacy row' });
rich.appendMessage({ workspaceId: 'child-one', ts: t0 + 100000, hash: null, body: 'null-hash row 1' });
rich.appendMessage({ workspaceId: 'child-one', ts: t0 + 100001, hash: null, body: 'null-hash row 2' });
rich.appendMessage({ workspaceId: 'child-two', ts: t0 + 100002, hash: 'native:xyz', body: undefined });
rich.upsertRegistry({ id: 'primary-aaaa1111', worktreePath: '/wt/main', sessionId: 'sess-1', inboxPath: '/inbox/p.ndjson', cursorPath: '/cur/p', nudgeCommand: ['hivecontrol', 'workspace', 'monitor'] });
rich.upsertRegistry({ id: 'child-one', worktreePath: '/wt/one', sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
rich.upsertRegistry({ id: 'child-one', worktreePath: '/wt/one', sessionId: 'sess-2', inboxPath: '', cursorPath: null, nudgeCommand: 'plain string' });
rich.upsertRegistry({ id: 'child-two', worktreePath: '/wt/two', sessionId: 's3', inboxPath: null, cursorPath: null, nudgeCommand: { a: [1, 2.5, 'x'] } });
rich.setCursor('primary-aaaa1111', 4);
rich.setCursor('child-one', 0);
rich.setCursor('child-two', 99); // past the end
rich.setBroadcastCursor('child-one', 3);
rich.setGate({ workspaceId: 'child-one', name: 'done', value: true, setBy: 'devswarm-done@abc123' });
rich.setGate({ workspaceId: 'child-one', name: 'merged', value: true, setBy: null });
rich.setGate({ workspaceId: 'child-one', name: 'done', value: false, setBy: 'me' });
rich.setGate({ workspaceId: 'child-one', name: 'tests_passed', value: true, setBy: 'x' });
rich.readerCursorTxn((tx) => {
  tx.put({ partition: 'child-one', ns: 'store', reader: '#floor', value: 5, updatedAt: t0 });
  tx.put({ partition: 'child-one', ns: 'store', reader: 'h:123:1790000000000', value: 7, retiredLine: 2, updatedAt: t0 + 5 });
  tx.put({ partition: 'child-one', ns: 'nd', reader: '#floor', value: 1, updatedAt: t0 });
  tx.put({ partition: 'primary-aaaa1111', ns: 'store', reader: '#floor', value: 2, updatedAt: t0 });
});
rich.close();

// a store with only a registry row and a cursor (no messages): ids that exist outside `messages`
const thin = store.openStore({ home, hash: 'thin-bbbbbb' });
thin.upsertRegistry({ id: 'lonely', worktreePath: '/wt/lonely' });
thin.setCursor('ghost', 3);
thin.setGate({ workspaceId: 'ghost2', name: 'done', value: true, setBy: 'a' });
thin.close();

// an empty (just-created) store
store.openStore({ home, hash: 'empty-cccccc' }).close();

// a store from before the mesh columns and reader_cursors existed (<= 0.56): both readers must fail the same way
const { DatabaseSync } = require('node:sqlite');
const olddir = path.join(home, '.anti-hall', 'devswarm', 'store', 'old-dddddd');
fs.mkdirSync(olddir, { recursive: true });
const old = new DatabaseSync(path.join(olddir, 'devswarm.db'));
old.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, UNIQUE(hash));');
old.exec('CREATE TABLE registry (id TEXT PRIMARY KEY, worktree_path TEXT, session_id TEXT, inbox_path TEXT, cursor_path TEXT, nudge_command TEXT, updated_at INTEGER);');
old.exec("INSERT INTO messages (workspace_id, ts, hash, body) VALUES ('w', 1, 'h1', 'b1'), ('w', 2, 'h2', 'b2');");
old.exec("INSERT INTO registry (id, worktree_path, updated_at) VALUES ('w', '/x', 5);");
old.close();

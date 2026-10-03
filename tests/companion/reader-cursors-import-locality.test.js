'use strict';
// companion/lib/reader-cursors.js — v0.106.0 regression: the one-time import
// declared EVERY live Claude session on the machine (every ~/.claude/sessions
// file: other repos, child worktrees) as a reader of EVERY partition, so the
// floor (MIN of live declared) was pinned at the import value forever. And the
// ack/fold callers imported without a cursorPath, so the nd floor imported as 0.
//   (b) import declares only sessions whose cwd resolves to the partition's worktree
//   (c) once that in-repo session acks, the floor rises
//   (d) the nd floor imports from the legacy descriptor cursor file

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

const HASH = 'rc-locality-abcdef';
const BACKENDS = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? ['sqlite', 'journal'] : ['journal'];
const ID = 'child-ws';
const STARTED = 1790000000000;

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function mkRepo(dir) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); return fs.realpathSync(dir); }
function writeSession(home, pid, cwd) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: 's-' + pid, cwd, startedAt: STARTED + pid }));
  return 'h:' + pid + ':' + (STARTED + pid);
}
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-locality-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const wt = mkRepo(path.join(base, 'child-wt'));
  const other = mkRepo(path.join(base, 'other-repo'));
  const sibling = mkRepo(path.join(base, 'sibling-wt'));
  const root = liveness.devswarmRoot(home);
  const cursorPath = path.join(root, 'cursors', ID + '.nd.json');
  const inboxPath = path.join(root, 'inbox', ID + '.ndjson');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', ID + '.json'), JSON.stringify({ id: ID, worktreePath: wt, sessionId: 's-child', inboxPath, cursorPath }));
  const inRepo = writeSession(home, 4101, path.join(wt));
  const elsewhere1 = writeSession(home, 4102, other);
  const elsewhere2 = writeSession(home, 4103, sibling);
  return { base, home, wt, cursorPath, inRepo, elsewhere1, elsewhere2 };
}
function declaredReaders(s, id, ns) {
  return s.readerCursorRows(id).filter((r) => r.ns === ns && r.reader !== rc.FLOOR).map((r) => r.reader).sort();
}
function floor(s, id, ns) { const r = s.readerCursorRows(id).find((x) => x.ns === ns && x.reader === rc.FLOOR); return r ? r.value : null; }

for (const backend of BACKENDS) {
  test(`[${backend}] (b) import with 3 live sessions (1 in-repo, 2 elsewhere) declares only the in-repo one`, () => {
    const f = fixture();
    const s = storeLib.openStore({ home: f.home, hash: HASH, backend });
    try {
      for (let i = 0; i < 5; i++) s.appendMessage({ workspaceId: ID, hash: 'm' + i, body: 'b' + i, ts: i + 1 });
      // procTable null = nothing provable -> every session file counts as live.
      rc.importLegacy(s, { partition: ID, home: f.home, procTable: null });
      assert.deepStrictEqual(declaredReaders(s, ID, 'store'), [f.inRepo]);
      assert.deepStrictEqual(declaredReaders(s, ID, 'nd'), [f.inRepo]);
    } finally { s.close(); rm(f.base); }
  });

  test(`[${backend}] (c) after the in-repo session acks, the floor rises (not pinned by foreign sessions)`, () => {
    const f = fixture();
    const s = storeLib.openStore({ home: f.home, hash: HASH, backend });
    try {
      for (let i = 0; i < 5; i++) s.appendMessage({ workspaceId: ID, hash: 'm' + i, body: 'b' + i, ts: i + 1 });
      // Lazy first-touch import through the ack path itself (the live shape).
      const r = rc.ackFor(s, { partition: ID, ns: 'store', reader: f.inRepo, target: 5, home: f.home, procTable: null });
      assert.ok(r.ok, r.error);
      assert.strictEqual(floor(s, ID, 'store'), 5, 'floor follows the only local reader');
      assert.strictEqual(rc.countFor(s, { partition: ID, reader: null, home: f.home }).unread, 0);
    } finally { s.close(); rm(f.base); }
  });

  test(`[${backend}] (d) import via a caller without cursorPath -> nd floor = the legacy descriptor cursor`, () => {
    const f = fixture();
    fs.writeFileSync(f.cursorPath, '3');
    const s = storeLib.openStore({ home: f.home, hash: HASH, backend });
    try {
      // commitInstanceAck / raiseAllLossFree shape: no cursorPath passed.
      rc.ackFor(s, { partition: ID, ns: 'store', reader: null, target: 0, home: f.home, procTable: null });
      assert.strictEqual(floor(s, ID, 'nd'), 3);
    } finally { s.close(); rm(f.base); }
    const g = fixture();
    fs.writeFileSync(g.cursorPath, '4');
    const s2 = storeLib.openStore({ home: g.home, hash: HASH, backend });
    try {
      rc.importLegacy(s2, { partition: ID, home: g.home, cursorPath: g.cursorPath, procTable: null });
      assert.strictEqual(floor(s2, ID, 'nd'), 4, 'explicit cursorPath still honoured');
    } finally { s2.close(); rm(g.base); }
  });
}

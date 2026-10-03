'use strict';
// A2 archived-stranded split (permanent false-positive fix).
//
// DEFECT: computeSummary's orphans[] counted an ARCHIVED workspace's own undrained
// partition as "unread nobody is reading". healOrphanPartitions classifies exactly
// that shape as `unhealable / archived-no-family` and writes NOTHING, so the unread
// can never drain and parent-inbox's "⚠ DEVSWARM ORPHANED MESH" warning re-fired
// every turn, forever, with no possible remediation.
//
// FIX: those ids move into a QUIET `archivedStranded[]` field. They are NOT dropped
// (the count/ids stay in the projection) and NOTHING else moves — an archived orphan
// that still has a live identity family, a live-workspace orphan, and the broadcast
// partition are all unaffected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archstranded-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function devswarmRoot(home) { return path.join(home, '.anti-hall', 'devswarm'); }

function writeDescriptor(home, sub, id, desc) {
  const dir = path.join(devswarmRoot(home), sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)), 'utf8');
}
// an unread-bearing partition with NO registry row -> an A2 orphan candidate
function seedUnread(s, id, n) {
  for (let i = 0; i < n; i++) s.appendMessage({ workspaceId: id, body: 'm' + i, hash: id + '-h' + i });
}
const ids = (arr) => (arr || []).map((o) => o.id).sort();

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  // (a) THE DEFECT: archived + no live identity family -> out of orphans[], into archivedStranded[]
  test(`[${B.name}] archived orphan with NO live family is quiet (archivedStranded, not orphans)`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-dead'); // deliberately NOT created: the worktree is gone
      writeDescriptor(home, 'archived', 'dead-child', { worktreePath: wt, sessionId: 'sess-dead' });
      seedUnread(s, 'dead-child', 3);

      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.deepStrictEqual(ids(sum.orphans), [], 'an unreadable-forever archived orphan must NOT nag as orphans[]');
      assert.deepStrictEqual(ids(sum.archivedStranded), ['dead-child'],
        'it must still be COUNTED in the quiet archivedStranded[] field, never silently dropped');
      assert.deepStrictEqual(sum.archivedStranded[0], { id: 'dead-child', messageCount: 3, unread: 3 },
        'archivedStranded[] carries the same {id,messageCount,unread} shape as orphans[]');
      s.close();
    } finally { rm(home); }
  });

  // (b) ANTI-BLINDING: archived BUT a live identity-family survivor exists -> STILL an orphan
  test(`[${B.name}] archived orphan WITH a live identity-family survivor stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-shared');
      fs.mkdirSync(wt, { recursive: true });
      // live sibling registry row on the SAME worktree -> same canonical mesh family
      s.upsertRegistry({ id: 'live-sibling', worktreePath: wt, sessionId: 'sess-live', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
      writeDescriptor(home, 'workspaces', 'live-sibling', { worktreePath: wt, sessionId: 'sess-live' });
      // the archived child shares that worktree -> heal would FORWARD, not give up
      writeDescriptor(home, 'archived', 'archived-with-family', { worktreePath: wt, sessionId: 'sess-old' });
      seedUnread(s, 'archived-with-family', 2);

      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.deepStrictEqual(ids(sum.orphans), ['archived-with-family'],
        'an archived orphan whose family still has a live row is ACTIONABLE and must keep warning');
      assert.equal(sum.archivedStranded, undefined, 'nothing should be classified stranded here');
      s.close();
    } finally { rm(home); }
  });

  // (c) a plain live-workspace orphan is untouched
  test(`[${B.name}] a non-archived orphan partition is unaffected`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-live');
      fs.mkdirSync(wt, { recursive: true });
      writeDescriptor(home, 'workspaces', 'live-orphan', { worktreePath: wt, sessionId: 'sess-x' });
      seedUnread(s, 'live-orphan', 1); // descriptor on disk but NO registry row -> orphan

      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.deepStrictEqual(ids(sum.orphans), ['live-orphan']);
      assert.equal(sum.archivedStranded, undefined);
      s.close();
    } finally { rm(home); }
  });

  // (d) the shared broadcast partition is still excluded from BOTH lists
  test(`[${B.name}] broadcast partition is excluded from orphans[] AND archivedStranded[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      store.appendMeshMessage(s, { from: 'someone', body: 'hello mesh', ts: 5 });
      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.ok(!ids(sum.orphans).includes(store.BROADCAST_PARTITION_ID));
      assert.ok(!ids(sum.archivedStranded).includes(store.BROADCAST_PARTITION_ID));
      s.close();
    } finally { rm(home); }
  });

  // (e) no-orphan projection stays byte-identical (additive field, omitted when empty)
  test(`[${B.name}] a clean projection carries neither key`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.equal(Object.prototype.hasOwnProperty.call(sum, 'orphans'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(sum, 'archivedStranded'), false);
      s.close();
    } finally { rm(home); }
  });

  // (f) an archived id with NO resolvable descriptor is heal's `no-descriptor`, a
  //     DIFFERENT class (a descriptor can reappear and be adopted) -> stays an orphan.
  test(`[${B.name}] archived id whose descriptor is unreadable stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      // archived/<id>.json PRESENT but not a readable descriptor -> resolves to null,
      // which is heal's `unhealable/no-descriptor`, not `archived-no-family`.
      const adir = path.join(devswarmRoot(home), 'archived');
      fs.mkdirSync(adir, { recursive: true });
      fs.writeFileSync(path.join(adir, 'ghost.json'), '{not json', 'utf8');
      seedUnread(s, 'ghost', 1);
      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.deepStrictEqual(ids(sum.orphans), ['ghost']);
      assert.equal(sum.archivedStranded, undefined);
      s.close();
    } finally { rm(home); }
  });
}

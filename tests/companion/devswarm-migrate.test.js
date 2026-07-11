'use strict';
// devswarm-migrate — AUTOMATIC-BUT-SAFE migration of on-disk state into the
// store. Idempotence, non-destructiveness, count-verification, and the
// single-consumer lock refusal, all against a forced journal backend.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrate = require('../../plugins/anti-hall/companion/devswarm-migrate.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-migrate-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// writeWorkspace(home, id, {lines, cursor}) — a legacy descriptor + its NDJSON
// durable inbox + a consumed-count cursor, matching the shipped file contracts.
function writeWorkspace(home, id, opts) {
  const o = opts || {};
  const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  const inbox = path.join(home, 'inbox-' + id + '.ndjson');
  const cursor = path.join(home, 'cursor-' + id + '.json');
  if (o.lines) fs.writeFileSync(inbox, o.lines.join('\n') + '\n');
  if (o.cursor != null) fs.writeFileSync(cursor, String(o.cursor));
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({
    id, worktreePath: '/wt/' + id, sessionId: 'sess-' + id,
    inboxPath: inbox, cursorPath: cursor, nudgeCommand: null,
  }));
  return { inbox, cursor };
}
const opts = (home) => ({ home, backend: 'journal', env: {} });

test('migrates descriptors + NDJSON inbox lines + cursor, count-verified', () => {
  const home = tmpHome();
  try {
    writeWorkspace(home, 'a', { lines: ['m1', 'm2', 'm3'], cursor: 1 });
    writeWorkspace(home, 'b', { lines: ['x'], cursor: 0 });

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.locked, true);
    assert.equal(rep.workspaces, 2);
    assert.equal(rep.verifiedAll, true);
    const a = rep.migrated.find((m) => m.id === 'a');
    assert.equal(a.imported, 3);
    assert.equal(a.storeCount, 3);
    assert.equal(a.cursor, 1);
    assert.equal(a.verified, true);

    // store actually holds them + the projection reflects unread
    const s = storeLib.openStore({ home, backend: 'journal' });
    try {
      assert.equal(s.messageCount('a'), 3);
      assert.equal(s.cursorValue('a'), 1);
    } finally { s.close(); }
    const sum = storeLib.readSummary(home);
    assert.equal(sum.workspaces.a.unread, 2); // 3 total - cursor 1
  } finally { rm(home); }
});

test('re-run is idempotent (imports 0 new) and NON-DESTRUCTIVE (sources intact)', () => {
  const home = tmpHome();
  try {
    const { inbox, cursor } = writeWorkspace(home, 'a', { lines: ['m1', 'm2'], cursor: 0 });
    const inboxBefore = fs.readFileSync(inbox, 'utf8');
    const cursorBefore = fs.readFileSync(cursor, 'utf8');

    migrate.migrateToStore(opts(home));
    const rep2 = migrate.migrateToStore(opts(home));
    assert.equal(rep2.migrated.find((m) => m.id === 'a').imported, 0); // nothing new
    assert.equal(rep2.verifiedAll, true);

    // store still holds exactly 2 (no duplicates from the second run)
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('a'), 2); } finally { s.close(); }

    // sources byte-for-byte untouched (never deletes/mutates)
    assert.equal(fs.readFileSync(inbox, 'utf8'), inboxBefore);
    assert.equal(fs.readFileSync(cursor, 'utf8'), cursorBefore);
    assert.equal(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'a.json')), true);
  } finally { rm(home); }
});

test('a re-run imports ONLY newly-appended lines (append-only catch-up)', () => {
  const home = tmpHome();
  try {
    const { inbox } = writeWorkspace(home, 'a', { lines: ['m1', 'm2'], cursor: 0 });
    migrate.migrateToStore(opts(home));
    fs.appendFileSync(inbox, 'm3\n'); // new message arrives in the legacy inbox
    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.migrated.find((m) => m.id === 'a').imported, 1); // only m3
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('a'), 3); } finally { s.close(); }
  } finally { rm(home); }
});

test('a MISSING/unreadable legacy inbox reports unverified+error, never verified-empty', () => {
  const home = tmpHome();
  try {
    // Descriptor points at an inbox path that does NOT exist on disk. A read of it
    // returns 0 lines just like a genuinely-empty inbox would — but we must NOT
    // treat the two the same: reporting verified-empty here would silently drop the
    // workspace's real (unread) messages.
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.writeFileSync(path.join(wsDir, 'x.json'), JSON.stringify({
      id: 'x', worktreePath: '/wt/x', sessionId: 'sess-x',
      inboxPath: path.join(home, 'does-not-exist.ndjson'),
      cursorPath: path.join(home, 'cursor-x.json'), nudgeCommand: null,
    }));

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.workspaces, 1);
    assert.equal(rep.verifiedAll, false, 'an unreadable inbox must NOT verify the whole run');
    const x = rep.migrated.find((m) => m.id === 'x');
    assert.equal(x.verified, false, 'the workspace is explicitly unverified');
    assert.ok(x.error && /unreadable|missing/.test(x.error), `error must name the read failure; got=${x.error}`);
    assert.equal(x.imported, 0, 'nothing imported when the inbox could not be read');
  } finally { rm(home); }
});

test('migrateOne unit: readable-empty inbox verifies; unreadable inbox errors', () => {
  const home = tmpHome();
  try {
    const s = storeLib.openStore({ home, backend: 'journal' });
    try {
      // readable but empty -> genuinely 0, honestly verified.
      const emptyInbox = path.join(home, 'empty.ndjson');
      fs.writeFileSync(emptyInbox, '');
      const okRep = migrate.migrateOne(s, {
        id: 'e', worktreePath: '/wt/e', sessionId: 's', inboxPath: emptyInbox, cursorPath: null,
      }, fs);
      assert.equal(okRep.verified, true, 'a readable EMPTY inbox is honestly verified');
      assert.equal(okRep.error, undefined);

      // unreadable/missing -> not verified, error surfaced.
      const badRep = migrate.migrateOne(s, {
        id: 'b', worktreePath: '/wt/b', sessionId: 's',
        inboxPath: path.join(home, 'nope.ndjson'), cursorPath: null,
      }, fs);
      assert.equal(badRep.verified, false);
      assert.ok(badRep.error);
    } finally { s.close(); }
  } finally { rm(home); }
});

test('refuses to run when another consumer holds the migrate lock', () => {
  const home = tmpHome();
  try {
    writeWorkspace(home, 'a', { lines: ['m1'], cursor: 0 });
    // Pre-acquire the lock with a LIVE holder (this process) — it is not stealable.
    const release = migrate.acquireMigrateLock(home);
    assert.ok(release, 'expected to acquire the lock first');
    try {
      const rep = migrate.migrateToStore(opts(home));
      assert.equal(rep.ok, false);
      assert.equal(rep.locked, false);
    } finally { release(); }
    // once released, migration proceeds
    const rep2 = migrate.migrateToStore(opts(home));
    assert.equal(rep2.ok, true);
    assert.equal(rep2.locked, true);
  } finally { rm(home); }
});

test('empty state (no descriptors) is a successful no-op', () => {
  const home = tmpHome();
  try {
    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.workspaces, 0);
    assert.equal(rep.verifiedAll, true);
  } finally { rm(home); }
});

test('legacyLineHash is stable per (id,index,content) and distinguishes duplicates', () => {
  assert.equal(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('a', 0, 'x'));
  assert.notEqual(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('a', 1, 'x')); // same text, diff index
  assert.notEqual(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('b', 0, 'x')); // diff workspace
});

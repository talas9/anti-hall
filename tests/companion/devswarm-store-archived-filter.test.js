'use strict';
// devswarm-store archivedOnlyIds / computeSummary archive filter (READ-SIDE half of
// the archive fold — see archivedOnlyIds's own comment in devswarm-store.js for the
// full rationale). Proves computeSummary excludes a genuinely-archived registry row
// from the ACTIVE projection WITHOUT running the write-migration
// foldArchivedRegistryRows (devswarm.js, invoked only from doctor/update), and that
// this can never blind a still-live workspace.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-store-archfilter-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

function devswarmRoot(home) { return path.join(home, '.anti-hall', 'devswarm'); }

function writeArchived(home, id) {
  const dir = path.join(devswarmRoot(home), 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id }), 'utf8');
}
function writeWorkspace(home, id) {
  const dir = path.join(devswarmRoot(home), 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id }), 'utf8');
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  test(`[${B.name}] archived row is excluded from computeSummary WITHOUT running doctor`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-archived');
      fs.mkdirSync(wt, { recursive: true });
      s.upsertRegistry({ id: 'archived-only', worktreePath: wt, sessionId: 'sess-1', inboxPath: '/inbox/a', cursorPath: '/cursor/a', nudgeCommand: null });
      writeArchived(home, 'archived-only'); // archived/<id>.json present
      // deliberately NO workspaces/<id>.json

      const summary = store.computeSummary(s, { home, now: 1000 });
      assert.ok(!Object.prototype.hasOwnProperty.call(summary.workspaces, 'archived-only'),
        'archived-only workspace row should NOT be projected as ACTIVE');
    } finally { rm(home); }
  });

  test(`[${B.name}] ANTI-BLINDING (mandatory): a genuinely live row IS still shown`, () => {
    const home = tmpHome();
    try {
      const s = open(home);

      // second id: BOTH archived/<id>.json AND workspaces/<id>.json present -> LIVE
      const wtBoth = path.join(home, 'wt-both');
      fs.mkdirSync(wtBoth, { recursive: true });
      s.upsertRegistry({ id: 'both-present', worktreePath: wtBoth, sessionId: 'sess-2', inboxPath: '/inbox/b', cursorPath: '/cursor/b', nudgeCommand: null });
      writeArchived(home, 'both-present');
      writeWorkspace(home, 'both-present');

      // third id: no archived file at all -> plain live row
      const wtPlain = path.join(home, 'wt-plain');
      fs.mkdirSync(wtPlain, { recursive: true });
      s.upsertRegistry({ id: 'plain-live', worktreePath: wtPlain, sessionId: 'sess-3', inboxPath: '/inbox/c', cursorPath: '/cursor/c', nudgeCommand: null });

      const summary = store.computeSummary(s, { home, now: 1000 });
      assert.ok(Object.prototype.hasOwnProperty.call(summary.workspaces, 'both-present'),
        'a workspace with BOTH archived/ and workspaces/ files must still be projected ACTIVE (structurally cannot be blinded)');
      assert.ok(Object.prototype.hasOwnProperty.call(summary.workspaces, 'plain-live'),
        'a workspace with no archived/ file at all must still be projected ACTIVE');
    } finally { rm(home); }
  });

  test(`[${B.name}] archived workspace WITH unread surfaces as an ORPHAN (not active, not vanished)`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-archived-unread');
      fs.mkdirSync(wt, { recursive: true });
      s.upsertRegistry({ id: 'archived-unread', worktreePath: wt, sessionId: 'sess-au', inboxPath: '/inbox/au', cursorPath: '/cursor/au', nudgeCommand: null });
      writeArchived(home, 'archived-unread'); // archived/<id>.json present, workspaces/<id>.json absent
      s.appendMessage({ workspaceId: 'archived-unread', body: 'stranded after archive', hash: 'au1' }); // unread 1

      const summary = store.computeSummary(s, { home, now: 1000 });
      assert.ok(!Object.prototype.hasOwnProperty.call(summary.workspaces, 'archived-unread'),
        'archived workspace must NOT be projected as ACTIVE');
      const orphans = summary.orphans || [];
      const found = orphans.find((o) => o.id === 'archived-unread');
      assert.ok(found, 'archived workspace with real unread must surface as an orphan');
      assert.equal(found.unread, 1, 'orphan unread count must reflect the stranded message');
      const stale = summary.staleRegistryPartitions || [];
      assert.ok(!stale.some((p) => (p.id || p) === 'archived-unread'),
        'archived workspace must not also appear in staleRegistryPartitions');
    } finally { rm(home); }
  });

  test(`[${B.name}] archived workspace with ZERO unread is fully invisible`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-archived-drained');
      fs.mkdirSync(wt, { recursive: true });
      s.upsertRegistry({ id: 'archived-drained', worktreePath: wt, sessionId: 'sess-ad', inboxPath: '/inbox/ad', cursorPath: '/cursor/ad', nudgeCommand: null });
      writeArchived(home, 'archived-drained');
      s.appendMessage({ workspaceId: 'archived-drained', body: 'seen already', hash: 'ad1' });
      s.setCursor('archived-drained', 1); // fully drained: cursor == messageCount

      const summary = store.computeSummary(s, { home, now: 1000 });
      assert.ok(!Object.prototype.hasOwnProperty.call(summary.workspaces, 'archived-drained'),
        'fully-drained archived workspace must not be ACTIVE');
      const orphans = summary.orphans || [];
      assert.ok(!orphans.some((o) => o.id === 'archived-drained'),
        'fully-drained archived workspace must not appear in orphans (no real unread)');
      const stale = summary.staleRegistryPartitions || [];
      assert.ok(!stale.some((p) => (p.id || p) === 'archived-drained'),
        'fully-drained archived workspace must not appear in staleRegistryPartitions');
    } finally { rm(home); }
  });

  test(`[${B.name}] fail-open: unreadable archived dir does not throw and filters nothing`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-x');
      fs.mkdirSync(wt, { recursive: true });
      s.upsertRegistry({ id: 'x', worktreePath: wt, sessionId: 'sess-x', inboxPath: '/inbox/x', cursorPath: '/cursor/x', nudgeCommand: null });

      const throwingFsi = Object.assign({}, fs, {
        readdirSync: (p, opts) => {
          if (String(p).endsWith(path.join('devswarm', 'archived'))) throw new Error('boom: unreadable archived dir');
          return fs.readdirSync(p, opts);
        },
      });

      let summary;
      assert.doesNotThrow(() => { summary = store.computeSummary(s, { home, now: 1000, fsi: throwingFsi }); });
      assert.ok(Object.prototype.hasOwnProperty.call(summary.workspaces, 'x'),
        'unreadable archived/ must fail open: nothing gets filtered');
    } finally { rm(home); }
  });
}

// ---- direct unit tests of archivedOnlyIds --------------------------------

test('archivedOnlyIds returns empty Set when archived/ is missing', () => {
  const home = tmpHome();
  try {
    const out = store.archivedOnlyIds(home, fs);
    assert.strictEqual(out.size, 0);
  } finally { rm(home); }
});

test('archivedOnlyIds ignores non-.json names', () => {
  const home = tmpHome();
  try {
    const dir = path.join(devswarmRoot(home), 'archived');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'not-json.txt'), 'hi', 'utf8');
    fs.writeFileSync(path.join(dir, 'README'), 'hi', 'utf8');
    const out = store.archivedOnlyIds(home, fs);
    assert.strictEqual(out.size, 0);
  } finally { rm(home); }
});

test('archivedOnlyIds ignores unsafe ids', () => {
  const home = tmpHome();
  try {
    const dir = path.join(devswarmRoot(home), 'archived');
    fs.mkdirSync(dir, { recursive: true });
    // '..' style traversal / path-separator-bearing names are unsafe ids
    fs.writeFileSync(path.join(dir, '..foo.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, '*.json'), '{}', 'utf8');
    const out = store.archivedOnlyIds(home, fs);
    assert.strictEqual(out.size, 0);
  } finally { rm(home); }
});

test('archivedOnlyIds includes a safe id that is archived-only', () => {
  const home = tmpHome();
  try {
    writeArchived(home, 'clean-id');
    const out = store.archivedOnlyIds(home, fs);
    assert.ok(out.has('clean-id'));
  } finally { rm(home); }
});

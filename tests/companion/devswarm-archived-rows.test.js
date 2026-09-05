'use strict';
// Wave D item 3 — ARCHIVED ROWS MUST NEVER ALERT.
//
// Field report: after the owner archived workspaces, their rows kept rendering
// as escalated / not-draining in the parent-gate header and the roster. Nothing
// in the neglect classification consulted archive state at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARCHIVED = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-archived.js');
const { isArchivedWorkspace } = require(ARCHIVED);

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-arch-'));
  fs.mkdirSync(path.join(d, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(d, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
function writeArchived(home, id, desc) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'archived', id + '.json'), JSON.stringify(desc));
}

test('item 3: an archived descriptor for THIS worktree marks the row archived', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-wt-'));
  try {
    writeArchived(home, 'ws-done', { id: 'ws-done', worktreePath: wt, sessionId: 'sX' });
    assert.strictEqual(isArchivedWorkspace(home, 'ws-done', wt), true);
  } finally { rm(home); rm(wt); }
});

test('item 3: an archived descriptor for a DIFFERENT worktree does NOT mark the row archived (id reuse)', () => {
  const home = tmpHome();
  const wtOld = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-old-'));
  const wtNew = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-new-'));
  try {
    writeArchived(home, 'ws-reused', { id: 'ws-reused', worktreePath: wtOld });
    assert.strictEqual(isArchivedWorkspace(home, 'ws-reused', wtNew), false,
      'a REUSED id must not inherit a previous workspace archive');
  } finally { rm(home); rm(wtOld); rm(wtNew); }
});

test('item 3: no archived record at all -> not archived (fail-closed)', () => {
  const home = tmpHome();
  try {
    assert.strictEqual(isArchivedWorkspace(home, 'ws-live', '/tmp/whatever'), false);
    assert.strictEqual(isArchivedWorkspace(home, 'ws-live', null), false);
  } finally { rm(home); }
});

test('item 3: unsafe ids and unparseable records are fail-closed, never throwing', () => {
  const home = tmpHome();
  try {
    assert.strictEqual(isArchivedWorkspace(home, '../escape', null), false);
    assert.strictEqual(isArchivedWorkspace(home, '', null), false);
    fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'archived', 'ws-bad.json'), '{not json');
    assert.strictEqual(isArchivedWorkspace(home, 'ws-bad', null), false);
  } finally { rm(home); }
});

test('item 3: the parent-gate consults it and drops the stale/escalated axis for an archived row', () => {
  // The wiring, asserted at the source level rather than by booting the whole
  // Stop hook: the suppressor must sit in the same suppressor chain as the
  // heartbeat and archive-ready ones, and must touch ONLY staleOrEscalated.
  const gate = fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-gate.js'), 'utf8');
  assert.ok(gate.includes("require('../companion/lib/devswarm-archived.js')"), 'gate must import the predicate');
  assert.ok(gate.includes('if (archived) staleOrEscalated = false;'),
    'gate must suppress ONLY the liveness axis for an archived row');
  assert.ok(!/if \(archived\)[\s\S]{0,120}realUnread = 0/.test(gate),
    'the archived suppressor must never zero realUnread — unread is a separate axis');
});

test('MUTATION: dropping the worktree match makes a REUSED id read archived', () => {
  // Simulates the naive "archived/<id>.json exists" rule this predicate rejects.
  const home = tmpHome();
  const wtOld = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mo-'));
  const wtNew = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-mn-'));
  try {
    writeArchived(home, 'ws-reused', { id: 'ws-reused', worktreePath: wtOld });
    const naive = fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'archived', 'ws-reused.json'));
    assert.strictEqual(naive, true, 'the naive rule would say archived');
    assert.strictEqual(isArchivedWorkspace(home, 'ws-reused', wtNew), false, 'the real rule must not');
  } finally { rm(home); rm(wtOld); rm(wtNew); }
});

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
function writeLive(home, id, desc) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json'), JSON.stringify(desc));
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

// P0 (field, anchor row): a repo's anchor always sits at the repo root, so
// worktreePath alone cannot discriminate a REUSED id when the new occupant
// sits at the SAME worktree — exactly the shape of a stale archived marker
// left by a previous occupant, still matching on worktreePath, of a Primary
// anchor row. The archived marker's own sessionId vs. the live descriptor's
// (or an explicit opts.sessionId) sessionId is the only thing that can tell
// them apart.
test('P0: archived marker from a PRIOR occupant (different sessionId, same worktree, via live descriptor read) is not archived', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor-'));
  try {
    writeArchived(home, 'anchor-1', { id: 'anchor-1', worktreePath: wt, sessionId: 'session-old' });
    writeLive(home, 'anchor-1', { id: 'anchor-1', worktreePath: wt, sessionId: 'session-new' });
    assert.strictEqual(isArchivedWorkspace(home, 'anchor-1', wt), false,
      'a stale marker from a prior occupant of a reused id must not mark the live row archived');
  } finally { rm(home); rm(wt); }
});

test('P0: archived marker from a PRIOR occupant, discriminated via opts.sessionId instead of a live-descriptor read', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor2-'));
  try {
    writeArchived(home, 'anchor-2', { id: 'anchor-2', worktreePath: wt, sessionId: 'session-old' });
    // No workspaces/anchor-2.json written — the caller supplies the live
    // sessionId itself (the cheap path computeDiagnosis/rosterHints take).
    assert.strictEqual(
      isArchivedWorkspace(home, 'anchor-2', wt, { sessionId: 'session-new' }), false,
      'opts.sessionId must discriminate exactly like a live-descriptor read would'
    );
  } finally { rm(home); rm(wt); }
});

test('P0 unchanged case: archived marker and live descriptor SAME sessionId still reads archived', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor3-'));
  try {
    writeArchived(home, 'anchor-3', { id: 'anchor-3', worktreePath: wt, sessionId: 'session-same' });
    writeLive(home, 'anchor-3', { id: 'anchor-3', worktreePath: wt, sessionId: 'session-same' });
    assert.strictEqual(isArchivedWorkspace(home, 'anchor-3', wt), true,
      'a genuinely-still-archived row (same occupant) must keep reading archived');
  } finally { rm(home); rm(wt); }
});

test('P0 unchanged case: archived marker carries NO sessionId — nothing to discriminate, unchanged behavior', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor4-'));
  try {
    writeArchived(home, 'anchor-4', { id: 'anchor-4', worktreePath: wt });
    writeLive(home, 'anchor-4', { id: 'anchor-4', worktreePath: wt, sessionId: 'session-new' });
    assert.strictEqual(isArchivedWorkspace(home, 'anchor-4', wt), true,
      'no marker sessionId means nothing to contradict — existing behavior holds');
  } finally { rm(home); rm(wt); }
});

test('P0 unchanged case: no live descriptor known at all (opts.sessionId omitted, no workspaces/<id>.json) — nothing to discriminate', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor5-'));
  try {
    writeArchived(home, 'anchor-5', { id: 'anchor-5', worktreePath: wt, sessionId: 'session-old' });
    assert.strictEqual(isArchivedWorkspace(home, 'anchor-5', wt), true,
      'no live sessionId knowable at all — fail-open to the pre-existing (worktree-only) behavior');
  } finally { rm(home); rm(wt); }
});

test('P0: opts.log is called exactly on the superseded-marker path, never on any other return', () => {
  const home = tmpHome();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-anchor6-'));
  try {
    writeArchived(home, 'anchor-6', { id: 'anchor-6', worktreePath: wt, sessionId: 'session-old' });
    writeLive(home, 'anchor-6', { id: 'anchor-6', worktreePath: wt, sessionId: 'session-new' });
    const events = [];
    const result = isArchivedWorkspace(home, 'anchor-6', wt, {
      log(event, details) { events.push({ event, details }); },
    });
    assert.strictEqual(result, false);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'archived-marker-superseded');
    assert.strictEqual(events[0].details.id, 'anchor-6');

    // Same-sessionId path: log must NOT fire.
    const home2 = tmpHome();
    try {
      writeArchived(home2, 'x', { id: 'x', sessionId: 's1' });
      const events2 = [];
      isArchivedWorkspace(home2, 'x', null, { log(event, details) { events2.push({ event, details }); } });
      assert.strictEqual(events2.length, 0);
    } finally { rm(home2); }
  } finally { rm(home); rm(wt); }
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

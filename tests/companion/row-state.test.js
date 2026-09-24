'use strict';
// row-state — THE one read-side row-state derivation (mesh redesign Phase 4).
// Isolated tmp HOME per test; pure reads under test, fixtures written directly.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib');
const rs = require(path.join(LIB, 'row-state.js'));
const cacheLib = require(path.join(LIB, 'devswarm-archived-cache.js'));

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rowstate-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function root(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeDesc(home, dir, id, desc) {
  fs.mkdirSync(path.join(root(home), dir), { recursive: true });
  fs.writeFileSync(path.join(root(home), dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

test('active: a row the caller holds, no archive signal', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    const st = rs.rowState({ home, id: 'w1', worktreePath: '/x/w1' });
    assert.deepStrictEqual(st, { status: 'active', archived: false, appArchived: false, present: true });
    assert.strictEqual(rs.isRowArchived({ home, id: 'w1', worktreePath: '/x/w1' }), false);
  } finally { rm(home); }
});

test('unknown: caller says no registry row and no descriptor exists — never guessed active', () => {
  const home = mkHome();
  try {
    const st = rs.rowState({ home, id: 'ghost', worktreePath: '/x/g', registryRow: null });
    assert.strictEqual(st.status, 'unknown');
    assert.strictEqual(st.present, false);
  } finally { rm(home); }
});

test('archived beats everything: matching marker, registry row gone (cmdArchive tombstone)', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'archived', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    const st = rs.rowState({ home, id: 'w1', worktreePath: '/x/w1', registryRow: null });
    assert.strictEqual(st.status, 'archived');
    assert.strictEqual(st.archived, true);
    assert.strictEqual(rs.isArchiveComplete(home, 'w1'), true, 'marker present, active descriptor gone');
    assert.deepStrictEqual([...rs.archiveCompleteIds(home)], ['w1']);
  } finally { rm(home); }
});

test('mid-archive (marker AND active descriptor): archived for alerting, NOT archive-complete', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'workspaces', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    writeDesc(home, 'archived', 'w1', { worktreePath: '/x/w1', sessionId: 's1' });
    assert.strictEqual(rs.rowState({ home, id: 'w1', worktreePath: '/x/w1' }).status, 'archived');
    assert.strictEqual(rs.isArchiveComplete(home, 'w1'), false);
    assert.strictEqual(rs.archiveCompleteIds(home).size, 0);
  } finally { rm(home); }
});

test('a reused id at a DIFFERENT worktree, or a superseded session, is not archived', () => {
  const home = mkHome();
  try {
    writeDesc(home, 'archived', 'w1', { worktreePath: '/x/old', sessionId: 's-old' });
    assert.strictEqual(rs.rowState({ home, id: 'w1', worktreePath: '/x/new' }).status, 'active');
    writeDesc(home, 'archived', 'w2', { worktreePath: '/x/w2', sessionId: 's-old' });
    writeDesc(home, 'workspaces', 'w2', { worktreePath: '/x/w2', sessionId: 's-new' });
    assert.strictEqual(rs.rowState({ home, id: 'w2', worktreePath: '/x/w2' }).status, 'active');
    assert.strictEqual(rs.rowState({ home, id: 'w2', worktreePath: '/x/w2', sessionId: 's-new' }).status, 'active');
  } finally { rm(home); }
});

test('app-archived: fresh cache, under the DevSwarm repos root, absent, past the grace', () => {
  const home = mkHome();
  try {
    const wt = path.join(home, '.devswarm', 'repos', 'proj', 'wt-a');
    fs.mkdirSync(wt, { recursive: true });
    writeDesc(home, 'workspaces', 'wsA', { worktreePath: wt, sessionId: 'sa' });
    const old = Date.now() - 3600 * 1000;
    fs.utimesSync(path.join(root(home), 'workspaces', 'wsA.json'), old / 1000, old / 1000);
    const other = path.join(home, '.devswarm', 'repos', 'proj', 'wt-b');
    cacheLib.writeActiveCache({ home, byRepoKey: { 'proj-abc123': [{ id: 'wsB', worktreePath: other }] }, now: Date.now() });
    const st = rs.rowState({ home, id: 'wsA', worktreePath: wt, repoKey: 'proj-abc123' });
    assert.strictEqual(st.status, 'app-archived');
    assert.strictEqual(st.appArchived, true);
    assert.strictEqual(rs.isRowArchived({ home, id: 'wsA', worktreePath: wt, repoKey: 'proj-abc123' }), true);
    // Without the row's repoKey there is no snapshot to judge by -> not archived.
    assert.strictEqual(rs.rowState({ home, id: 'wsA', worktreePath: wt }).status, 'active');
    // Both flags are reported when both hold; status follows the precedence.
    writeDesc(home, 'archived', 'wsA', { worktreePath: wt, sessionId: 'sa' });
    const both = rs.rowState({ home, id: 'wsA', worktreePath: wt, repoKey: 'proj-abc123' });
    assert.strictEqual(both.status, 'archived');
    assert.strictEqual(both.archived, true);
    assert.strictEqual(both.appArchived, true);
  } finally { rm(home); }
});

test('a symlinked archived/ directory is never believed (fail-open: nothing archive-complete)', () => {
  const home = mkHome();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rowstate-link-'));
  try {
    fs.writeFileSync(path.join(elsewhere, 'w1.json'), JSON.stringify({ id: 'w1' }));
    fs.symlinkSync(elsewhere, path.join(root(home), 'archived'));
    assert.strictEqual(rs.isArchiveComplete(home, 'w1'), false);
    assert.strictEqual(rs.archiveCompleteIds(home).size, 0);
  } finally { rm(home); rm(elsewhere); }
});

test('unsafe ids and unreadable input fail open to not-archived', () => {
  const home = mkHome();
  try {
    assert.strictEqual(rs.rowState({ home, id: '../x', registryRow: null }).status, 'unknown');
    assert.strictEqual(rs.isArchiveComplete(home, '../x'), false);
    assert.strictEqual(rs.rowState({}).status, 'active');
  } finally { rm(home); }
});

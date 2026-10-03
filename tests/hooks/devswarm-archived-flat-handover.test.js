'use strict';
// A handover written as a FLAT .anti-hall/handovers/<name>.md (not the nested
// <date>/<session>/HANDOVER*.md form) must count for an ARCHIVED child — doctor
// section 5n reads the `handoverWritten` flag the archived-child Stop gate /
// turn hook record, and it read "NOT written" for a flat file. A flat file only
// counts when its mtime is at or after the archive time; the Primary-seat
// callers (no opts) keep ignoring flat files.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const seat = require('../../plugins/anti-hall/companion/lib/primary-seat.js');
const metricsLib = require('../../plugins/anti-hall/companion/lib/archived-child-metrics.js');

const HOUR = 3600 * 1000;
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feat/x', PATH: path.join(os.tmpdir(), 'antihall-flat-handover-no-bin') };

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function tmpWorktree() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-flat-handover-wt-')); }
function writeFlat(wt, name, mtimeMs) {
  const dir = path.join(wt, '.anti-hall', 'handovers');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '# handover\n');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}
function writeMarker(home, id, wt, archivedAt) {
  const adir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: 's1', archivedAt }));
}

test('newestWorktreeHandover: flat file ignored without opts (Primary-seat callers unchanged)', () => {
  const wt = tmpWorktree();
  try {
    writeFlat(wt, '2026-10-02-topic.md', Date.now());
    assert.strictEqual(seat.newestWorktreeHandover(wt), null);
  } finally { rm(wt); }
});

test('newestWorktreeHandover: flat file accepted only at/after flatSinceMs', () => {
  const wt = tmpWorktree();
  try {
    const now = Date.now();
    writeFlat(wt, 'a.md', now - 2 * HOUR);
    assert.strictEqual(seat.newestWorktreeHandover(wt, { flatSinceMs: now - HOUR }), null, 'stale flat file must not count');
    const fresh = writeFlat(wt, 'b.md', now);
    const got = seat.newestWorktreeHandover(wt, { flatSinceMs: now - HOUR });
    assert.ok(got && got.path === fresh);
  } finally { rm(wt); }
});

test('ARCHIVED CHILD-GATE: a fresh flat handover is recorded handoverWritten=true', () => {
  const h = makeHome();
  const wt = tmpWorktree();
  try {
    const id = 'flat-ho-fresh';
    writeMarker(h.home, id, wt, Date.now() - HOUR);
    writeFlat(wt, '2026-10-02-web-ota-r2.md', Date.now());
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: 's1' }));
    testHook('devswarm-child-gate.js', { hook_event_name: 'Stop', session_id: 's1', cwd: wt }, { home: h.home, expectJson: true, env: Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: id }) });
    assert.strictEqual(metricsLib.readMetrics(h.home).byId[id].handoverWritten, true);
  } finally { h.cleanup(); rm(wt); }
});

test('ARCHIVED CHILD-GATE: a flat handover written 5 MINUTES BEFORE the archive (write, then archived) counts', () => {
  const h = makeHome();
  const wt = tmpWorktree();
  try {
    const id = 'flat-ho-before';
    const archivedAt = Date.now();
    writeMarker(h.home, id, wt, archivedAt);
    writeFlat(wt, 'just-before.md', archivedAt - 5 * 60 * 1000);
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: 's1' }));
    testHook('devswarm-child-gate.js', { hook_event_name: 'Stop', session_id: 's1', cwd: wt }, { home: h.home, expectJson: true, env: Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: id }) });
    assert.strictEqual(metricsLib.readMetrics(h.home).byId[id].handoverWritten, true);
  } finally { h.cleanup(); rm(wt); }
});

test('ARCHIVED CHILD-GATE: a STALE flat handover (3 days before the archive) is recorded handoverWritten=false', () => {
  const h = makeHome();
  const wt = tmpWorktree();
  try {
    const id = 'flat-ho-stale';
    writeMarker(h.home, id, wt, Date.now());
    writeFlat(wt, 'old-notes.md', Date.now() - 3 * 24 * HOUR);
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, worktreePath: wt, sessionId: 's1' }));
    testHook('devswarm-child-gate.js', { hook_event_name: 'Stop', session_id: 's1', cwd: wt }, { home: h.home, expectJson: true, env: Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: id }) });
    assert.strictEqual(metricsLib.readMetrics(h.home).byId[id].handoverWritten, false);
  } finally { h.cleanup(); rm(wt); }
});

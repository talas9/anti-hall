'use strict';
// lib/state-prune.js — bounded, throttled, fail-open self-pruning for the
// per-session state files under ~/.anti-hall/ (task-tracker-*,
// speculation-guard-state-*, tasklist-guard-state-*, codex-nudge-state-*, ...).
//
// Root cause this guards against: each of those hooks writes ONE file per
// session_id and nothing ever reads an OLD session's file back, so without
// pruning every session that ever ran leaves a permanent orphan (proven:
// ~47K task-tracker-*.json accumulated over ~71 days of real usage).
//
// Uses an isolated fake HOME (via makeHome()) for every case — never touches
// the real ~/.anti-hall/.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { makeHome } = require('../helpers/fixtures.js');

const { pruneStale } = require('../../plugins/anti-hall/hooks/lib/state-prune.js');

const DAY = 24 * 60 * 60 * 1000;

// touch(dir, name, ageMs) -> write a file then backdate its mtime by ageMs.
function touch(dir, name, ageMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{}', 'utf8');
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

test('state-prune: removes files past TTL', () => {
  const h = makeHome();
  try {
    touch(h.antiHall, 'task-tracker-old1.json', 10 * DAY);
    touch(h.antiHall, 'task-tracker-old2.json', 8 * DAY);
    const removed = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', ttlMs: 7 * DAY, throttleMs: 0,
    });
    assert.strictEqual(removed, 2);
    assert.ok(!fs.existsSync(path.join(h.antiHall, 'task-tracker-old1.json')));
    assert.ok(!fs.existsSync(path.join(h.antiHall, 'task-tracker-old2.json')));
  } finally {
    h.cleanup();
  }
});

test('state-prune: leaves files within TTL', () => {
  const h = makeHome();
  try {
    const fresh = touch(h.antiHall, 'task-tracker-fresh.json', 1 * DAY);
    const removed = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', ttlMs: 7 * DAY, throttleMs: 0,
    });
    assert.strictEqual(removed, 0);
    assert.ok(fs.existsSync(fresh));
  } finally {
    h.cleanup();
  }
});

test('state-prune: never removes the current session\'s file even if old', () => {
  const h = makeHome();
  try {
    const current = touch(h.antiHall, 'task-tracker-current.json', 30 * DAY);
    const removed = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', keepFile: current,
      ttlMs: 7 * DAY, throttleMs: 0,
    });
    assert.strictEqual(removed, 0);
    assert.ok(fs.existsSync(current));
  } finally {
    h.cleanup();
  }
});

test('state-prune: throttle prevents a sweep running twice in a row', () => {
  const h = makeHome();
  try {
    touch(h.antiHall, 'task-tracker-old1.json', 10 * DAY);
    const first = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', ttlMs: 7 * DAY, throttleMs: 6 * 60 * 60 * 1000,
    });
    assert.strictEqual(first, 1);

    // A second stale file appears immediately after; a second sweep within
    // the throttle window must NOT run (stamp file still fresh) -> 0 removed.
    touch(h.antiHall, 'task-tracker-old2.json', 10 * DAY);
    const second = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', ttlMs: 7 * DAY, throttleMs: 6 * 60 * 60 * 1000,
    });
    assert.strictEqual(second, 0);
    assert.ok(fs.existsSync(path.join(h.antiHall, 'task-tracker-old2.json')));
  } finally {
    h.cleanup();
  }
});

test('state-prune: fs errors fail open silently (no throw, returns 0)', () => {
  // Nonexistent stateDir -> readdir throws internally; must swallow and
  // return 0, never propagate.
  assert.doesNotThrow(() => {
    const removed = pruneStale({
      stateDir: '/nonexistent/does/not/exist/anti-hall-test',
      prefix: 'task-tracker',
      throttleMs: 0,
    });
    assert.strictEqual(removed, 0);
  });
});

test('state-prune: missing stateDir/prefix args -> 0, no throw', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(pruneStale({}), 0);
    assert.strictEqual(pruneStale(null), 0);
    assert.strictEqual(pruneStale(undefined), 0);
  });
});

test('state-prune: only touches files matching the given prefix', () => {
  const h = makeHome();
  try {
    touch(h.antiHall, 'task-tracker-old1.json', 10 * DAY);
    touch(h.antiHall, 'speculation-guard-state-old1.json', 10 * DAY);
    const removed = pruneStale({
      stateDir: h.antiHall, prefix: 'task-tracker', ttlMs: 7 * DAY, throttleMs: 0,
    });
    assert.strictEqual(removed, 1);
    assert.ok(fs.existsSync(path.join(h.antiHall, 'speculation-guard-state-old1.json')));
  } finally {
    h.cleanup();
  }
});

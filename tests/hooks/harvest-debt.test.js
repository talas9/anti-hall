'use strict';
// tests/hooks/harvest-debt.test.js — unit tests for harvest-debt.js
// Uses a temp dir per test; injects gitTime so no real git repo needed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harvestMarkers } = require('../../plugins/anti-hall/scripts/harvest-debt.js');

// gitTime injectors
const NO_GIT     = () => null;                              // git unavailable
const OLD_EPOCH  = () => 0;                                 // 1970-01-01, always stale
const NOW_EPOCH  = () => Math.floor(Date.now() / 1000);    // current time, never stale

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-debt-test-'));
  function write(name, content) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
  }
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { dir, write, cleanup };
}

test('parses // marker: ceiling and when extracted correctly', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.js', '// anti-hall: 30 lines, when >3 callers\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, '30 lines');
    assert.strictEqual(markers[0].when, 'when >3 callers');
  } finally { cleanup(); }
});

test('parses # marker: ceiling and when extracted correctly', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('script.sh', '# anti-hall: O(n^2), when n>1000\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, 'O(n^2)');
    assert.strictEqual(markers[0].when, 'when n>1000');
  } finally { cleanup(); }
});

test('parses /* */ marker: trailing closer stripped', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.c', '/* anti-hall: 2 deps, when we drop node18 */\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, '2 deps');
    assert.strictEqual(markers[0].when, 'when we drop node18');
  } finally { cleanup(); }
});

test('parses /* */ marker without leaking trailing code into when', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.c', 'int x = 1; /* anti-hall: 2 deps, when we drop node18 */ return x;\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, '2 deps');
    assert.strictEqual(markers[0].when, 'when we drop node18');
  } finally { cleanup(); }
});

test('no-comma marker with trailing code does not leak the closer into ceiling', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.c', '/* anti-hall: solo ceiling */ doStuff();\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, 'solo ceiling');
    assert.strictEqual(markers[0].when, null);
    assert.strictEqual(markers[0].rotRisk, true, 'no-when marker is still rot-risk');
  } finally { cleanup(); }
});

test('parses HTML marker: ceiling and when extracted correctly', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('page.html', '<!-- anti-hall: 4 selectors, when CSS module lands -->\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, '4 selectors');
    assert.strictEqual(markers[0].when, 'when CSS module lands');
  } finally { cleanup(); }
});

test('parses -- marker: ceiling and when extracted correctly', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('query.sql', '-- anti-hall: temp index, when query planner changes\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].ceiling, 'temp index');
    assert.strictEqual(markers[0].when, 'when query planner changes');
  } finally { cleanup(); }
});

test('no-comma marker → when:null, rotRisk:true, rotReason mentions no trigger', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.js', '// anti-hall: temporary hack\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].when, null);
    assert.strictEqual(markers[0].rotRisk, true);
    assert.ok(markers[0].rotReason, 'rotReason should be set');
    assert.ok(/trigger|absent|no payback/i.test(markers[0].rotReason),
      'rotReason should mention missing trigger, got: ' + markers[0].rotReason);
  } finally { cleanup(); }
});

test('injected old gitTime → rotRisk:true with stale reason (when present)', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.js', '// anti-hall: shortcut, when refactor done\n');
    const markers = harvestMarkers({ dir, gitTime: OLD_EPOCH, staleDays: 90 });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].rotRisk, true);
    assert.ok(markers[0].rotReason, 'rotReason should be set');
    assert.ok(/days/i.test(markers[0].rotReason),
      'rotReason should mention days, got: ' + markers[0].rotReason);
  } finally { cleanup(); }
});

test('injected recent gitTime + when present → rotRisk:false', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.js', '// anti-hall: shortcut, when refactor done\n');
    const markers = harvestMarkers({ dir, gitTime: NOW_EPOCH, staleDays: 90 });
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].rotRisk, false);
    assert.strictEqual(markers[0].rotReason, null);
  } finally { cleanup(); }
});

test('multiple markers on one line are all captured with the same line number', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('same-line.js', '// anti-hall: first ceiling, when first // anti-hall: second ceiling, when second\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 2);
    assert.strictEqual(markers[0].line, 1);
    assert.strictEqual(markers[0].ceiling, 'first ceiling');
    assert.strictEqual(markers[0].when, 'when first');
    assert.strictEqual(markers[1].line, 1);
    assert.strictEqual(markers[1].ceiling, 'second ceiling');
    assert.strictEqual(markers[1].when, 'when second');
  } finally { cleanup(); }
});

test('multiple markers in one file: all found with correct line numbers', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('multi.js', [
      '// anti-hall: 10 lines, when extracting module',
      '// plain comment, ignored',
      '# anti-hall: O(n^2), when n>500',
    ].join('\n') + '\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 2);
    assert.strictEqual(markers[0].line, 1);
    assert.strictEqual(markers[1].line, 3);
  } finally { cleanup(); }
});

test('json-style summary counts: total, rotRisk, withTrigger', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('a.js', '// anti-hall: fix me\n');           // no when → rotRisk
    write('b.js', '// anti-hall: ok, when later\n');   // has when + recent → no rot
    const markers = harvestMarkers({ dir, gitTime: NOW_EPOCH });
    const total      = markers.length;
    const rotRisk    = markers.filter((m) => m.rotRisk).length;
    const withTrigger = markers.filter((m) => m.when).length;
    assert.strictEqual(total, 2);
    assert.strictEqual(rotRisk, 1);       // only 'fix me' (no when)
    assert.strictEqual(withTrigger, 1);   // only 'ok, when later'
  } finally { cleanup(); }
});

test('skips files over the size cap instead of parsing truncated content', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const overCap = '// anti-hall: oversized marker, when never\n' + 'x'.repeat((2 * 1024 * 1024) + 1);
    write('large.js', overCap);
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 0);
  } finally { cleanup(); }
});

test('skips node_modules directory', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('node_modules/pkg/index.js', '// anti-hall: skip me, when never\n');
    write('real.js', '// anti-hall: include me, when later\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.ok(markers[0].file.includes('real.js'));
  } finally { cleanup(); }
});

test('skips dot-directories', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.hidden/secret.js', '// anti-hall: skip me, when never\n');
    write('visible.js', '// anti-hall: include me, when later\n');
    const markers = harvestMarkers({ dir, gitTime: NO_GIT });
    assert.strictEqual(markers.length, 1);
    assert.ok(markers[0].file.includes('visible.js'));
  } finally { cleanup(); }
});

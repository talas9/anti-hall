'use strict';
// gcStaleSummaries (devswarm-store.js) — age-based GC for summaries/<hash>.json,
// keyed on the summary's OWN `generatedAt`, never mtime.
//
// summaries/ holds ONE PROJECTION PER (repo x project) EVER DERIVED — verified
// live: ~150 modules-*.json-shaped files, nothing pruning them. These are NOT
// duplicates (the same workspace id legitimately appears under several distinct
// repoKey-keyed summary files), so GC must never dedupe by an id found inside a
// summary — the unit of GC is the summary FILE, decided by its own age and its
// own hash. A repoKey with a live `store/<hash>/` dir must NEVER be GC'd
// regardless of its summary's age.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const DAY = 24 * 60 * 60 * 1000;

function summariesDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'summaries'); }
function storeSubdir(home, hash) { return path.join(home, '.anti-hall', 'devswarm', 'store', hash); }

function seedSummary(home, hash, generatedAt) {
  fs.mkdirSync(summariesDir(home), { recursive: true });
  fs.writeFileSync(path.join(summariesDir(home), hash + '.json'), JSON.stringify({ generatedAt, workspaces: {} }));
}
function seedStoreDir(home, hash) {
  fs.mkdirSync(storeSubdir(home, hash), { recursive: true });
}

test('check mode: an OLD summary with NO corresponding store dir is reported pending and left in place', () => {
  const h = makeHome();
  try {
    const old = Date.now() - (40 * DAY);
    seedSummary(h.home, '04a8539f', old);
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'check', now: Date.now() });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'pending');
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), '04a8539f.json')), 'check mode must never delete');
  } finally { h.cleanup(); }
});

test('repair mode: an OLD summary with NO store dir is removed', () => {
  const h = makeHome();
  try {
    const old = Date.now() - (40 * DAY);
    seedSummary(h.home, '04a8539f', old);
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
    assert.ok(!fs.existsSync(path.join(summariesDir(h.home), '04a8539f.json')));
  } finally { h.cleanup(); }
});

test('repair mode: a RECENT summary (inside the retention window) is kept, even with no store dir', () => {
  const h = makeHome();
  try {
    const recent = Date.now() - (2 * DAY);
    seedSummary(h.home, 'abc12345', recent);
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    assert.strictEqual(rows.length, 0);
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'abc12345.json')));
  } finally { h.cleanup(); }
});

test('repair mode: an OLD summary whose repoKey IS still in use (store/<hash>/ exists) is NEVER removed', () => {
  const h = makeHome();
  try {
    const old = Date.now() - (400 * DAY);
    seedSummary(h.home, 'deadbeef', old);
    seedStoreDir(h.home, 'deadbeef');
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    assert.strictEqual(rows.length, 0, 'an in-use repoKey is not even reported — nothing to do');
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'deadbeef.json')), 'must never be removed while its store dir exists');
  } finally { h.cleanup(); }
});

test('repair mode: env override ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS is honored', () => {
  const h = makeHome();
  try {
    const nineDaysOld = Date.now() - (9 * DAY);
    seedSummary(h.home, 'f00dcafe', nineDaysOld);
    // Default window (30d) would keep this; a 5-day override makes it stale.
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now(), env: { ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS: '5' } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
  } finally { h.cleanup(); }
});

test('repair mode: a summary with NO generatedAt (no age evidence) is left untouched, never treated as old', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(summariesDir(h.home), { recursive: true });
    fs.writeFileSync(path.join(summariesDir(h.home), 'no-age-1234.json'), JSON.stringify({ workspaces: {} }));
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    assert.strictEqual(rows.length, 0);
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'no-age-1234.json')));
  } finally { h.cleanup(); }
});

test('repair mode: a corrupt/unparseable summary file is left untouched (fail-open), never guessed at', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(summariesDir(h.home), { recursive: true });
    fs.writeFileSync(path.join(summariesDir(h.home), 'corrupt-abcd.json'), 'not valid json{{{');
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    assert.strictEqual(rows.length, 0);
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'corrupt-abcd.json')));
  } finally { h.cleanup(); }
});

test('no summaries dir at all -> returns [] without throwing (routine, e.g. a fresh install)', () => {
  const h = makeHome();
  try {
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'check' });
    assert.deepStrictEqual(rows, []);
  } finally { h.cleanup(); }
});

test('mixed: two old, unused summaries are removed; a fresh one and an in-use one are both kept, in one pass', () => {
  const h = makeHome();
  try {
    const old = Date.now() - (60 * DAY);
    const recent = Date.now() - (1 * DAY);
    seedSummary(h.home, 'aaaa1111', old);   // stale, unused -> removed
    seedSummary(h.home, 'bbbb2222', old);   // stale, unused -> removed
    seedSummary(h.home, 'cccc3333', recent); // fresh -> kept
    seedSummary(h.home, 'dddd4444', old);   // stale but IN USE -> kept
    seedStoreDir(h.home, 'dddd4444');
    const rows = store.gcStaleSummaries({ home: h.home, mode: 'repair', now: Date.now() });
    const removed = rows.filter((r) => r.status === 'fixed').map((r) => path.basename(r.file));
    assert.deepStrictEqual(removed.sort(), ['aaaa1111.json', 'bbbb2222.json']);
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'cccc3333.json')));
    assert.ok(fs.existsSync(path.join(summariesDir(h.home), 'dddd4444.json')));
  } finally { h.cleanup(); }
});

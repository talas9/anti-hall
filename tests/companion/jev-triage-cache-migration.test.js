'use strict';
// migrateJevTriageCache + pruneJevTriage — seeded bad state in an isolated HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');
const M = require('../../plugins/anti-hall/companion/lib/migrations.js');
const { pruneJevTriage } = require('../../plugins/anti-hall/hooks/lib/state-prune.js');

const cacheDir = (home) => path.join(home, '.anti-hall', 'cache');
const cacheFile = (home) => path.join(cacheDir(home), 'jev-triage.json');
function seed(home, obj) { fs.mkdirSync(cacheDir(home), { recursive: true }); fs.writeFileSync(cacheFile(home), JSON.stringify(obj)); }
function age(p, ms) { const t = (Date.now() - ms) / 1000; fs.utimesSync(p, t, t); }

test('poisoned no-label entries dropped; labelled and nl entries kept; second run is a no-op', () => {
  const h = makeHome();
  try {
    seed(h.home, {
      a: { urgency: 'urgent', kind: 'blocker', _seq: 1 },
      b: { _seq: 2 },                 // old poisoned shape
      c: {},                          // older bare shape
      d: { _seq: 4, nl: true },       // real no-label verdict
      e: { kind: 'fyi', _seq: 5 },
      f: null,
    });
    const r = M.migrateJevTriageCache(h.home, {});
    assert.strictEqual(r.status, 'fixed');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile(h.home), 'utf8'))).sort(), ['a', 'd', 'e']);
    assert.strictEqual(M.migrateJevTriageCache(h.home, {}).status, 'skipped');
  } finally { h.cleanup(); }
});

test('dry-run writes nothing; missing or corrupt cache is a fail-open skip', () => {
  const h = makeHome();
  try {
    assert.strictEqual(M.migrateJevTriageCache(h.home, {}).status, 'skipped');
    seed(h.home, { b: { _seq: 2 } });
    const before = fs.readFileSync(cacheFile(h.home), 'utf8');
    assert.strictEqual(M.migrateJevTriageCache(h.home, { dryRun: true }).status, 'skipped');
    assert.strictEqual(fs.readFileSync(cacheFile(h.home), 'utf8'), before);
    fs.writeFileSync(cacheFile(h.home), '{not json');
    assert.strictEqual(M.migrateJevTriageCache(h.home, {}).status, 'skipped');
    assert.strictEqual(fs.readFileSync(cacheFile(h.home), 'utf8'), '{not json');
  } finally { h.cleanup(); }
});

test('pruneJevTriage removes stale claims/lock/queue only; keeps fresh ones and the label cache; throttled', () => {
  const h = makeHome();
  try {
    const dir = cacheDir(h.home);
    const claims = path.join(dir, 'jev-triage.claims');
    fs.mkdirSync(claims, { recursive: true });
    const stale = path.join(claims, 'stale'); const fresh = path.join(claims, 'fresh');
    fs.writeFileSync(stale, ''); fs.writeFileSync(fresh, ''); age(stale, 30 * 60 * 1000);
    const lock = path.join(dir, 'jev-triage-arrival.lock'); fs.writeFileSync(lock, '1'); age(lock, 30 * 60 * 1000);
    const queue = path.join(dir, 'jev-triage-arrival.queue'); fs.writeFileSync(queue, '{}\n'); age(queue, 3 * 3600 * 1000);
    const work = queue + '.work.99'; fs.writeFileSync(work, ''); age(work, 3 * 3600 * 1000);
    seed(h.home, { a: { kind: 'fyi', _seq: 1 } }); age(cacheFile(h.home), 30 * 24 * 3600 * 1000);
    assert.strictEqual(pruneJevTriage(h.home), 4);
    assert.ok(fs.existsSync(fresh) && fs.existsSync(cacheFile(h.home)));
    assert.ok(!fs.existsSync(stale) && !fs.existsSync(lock) && !fs.existsSync(queue) && !fs.existsSync(work));
    fs.writeFileSync(stale, ''); age(stale, 30 * 60 * 1000);
    assert.strictEqual(pruneJevTriage(h.home), 0, 'throttled');
    assert.strictEqual(pruneJevTriage(h.home, { throttleMs: 0 }), 1);
    // a live queue (fresh) is left alone
    fs.writeFileSync(queue, '{}\n');
    assert.strictEqual(pruneJevTriage(h.home, { throttleMs: 0 }), 0);
    assert.ok(fs.existsSync(queue));
  } finally { h.cleanup(); }
});

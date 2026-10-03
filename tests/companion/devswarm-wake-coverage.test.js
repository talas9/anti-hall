'use strict';
// companion/lib/devswarm-wake-coverage.js wakeCoverage() + hooks/lib/devswarm-wake.js
// noWakePathLine(): the shared "does this Primary have any mailbox wake path?"
// read. Temp HOME, real temp git repo + child worktree, fixture lock file and
// wake-tick marker.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const { wakeCoverage } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-coverage.js'));
const { lockPathFor } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));
const { noWakePathLine } = require(path.join(ROOT, 'hooks', 'lib', 'devswarm-wake.js'));

const PRIMARY_ID = 'primary-abc123';
const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakecov-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeRepo() {
  const dir = tmp('repo');
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'i']);
  return dir;
}
function addChild(repo, home) {
  const wt = tmp('child');
  fs.rmSync(wt, { recursive: true, force: true });
  const r = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'c-' + path.basename(wt)]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'child1.json'), JSON.stringify({ id: 'child1', worktreePath: wt, sessionId: 's-child1' }));
  return wt;
}
function writeLock(home, ts, pid) {
  const p = lockPathFor(home, PRIMARY_ID);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, pid }));
}
function writeTick(home, ts) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'wake-tick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PRIMARY_ID + '.json'), JSON.stringify({ ts }));
}

// watcher: live | none ; tick: fresh | stale | absent ; child: bool
const CASES = [
  { child: true, watcher: 'live', tick: 'fresh', cronMissing: false },
  { child: true, watcher: 'live', tick: 'stale', cronMissing: true },
  { child: true, watcher: 'live', tick: 'absent', cronMissing: true },
  { child: true, watcher: 'none', tick: 'fresh', cronMissing: false },
  { child: true, watcher: 'none', tick: 'stale', cronMissing: true },
  { child: true, watcher: 'none', tick: 'absent', cronMissing: true },
  { child: false, watcher: 'none', tick: 'absent', cronMissing: true },
  { child: false, watcher: 'live', tick: 'fresh', cronMissing: false },
];
for (const c of CASES) {
  test(`wakeCoverage truth table: liveChild=${c.child} watcher=${c.watcher} tick=${c.tick}`, () => {
    const home = tmp('home');
    const repo = makeRepo();
    try {
      if (c.child) addChild(repo, home);
      if (c.watcher === 'live') writeLock(home, NOW - 10 * 1000, process.pid);
      if (c.tick === 'fresh') writeTick(home, NOW - 5 * MIN);
      if (c.tick === 'stale') writeTick(home, NOW - 90 * MIN);
      const cov = wakeCoverage({ home, cwd: repo, id: PRIMARY_ID, now: NOW, env: { HOME: home, USERPROFILE: home } });
      assert.strictEqual(cov.unknown, false);
      assert.strictEqual(cov.liveChildren, c.child);
      assert.strictEqual(cov.watcherLive, c.watcher === 'live');
      assert.strictEqual(cov.cronLikelyMissing, c.cronMissing);
      assert.strictEqual(cov.lastTickAgeMin, c.tick === 'fresh' ? 5 : c.tick === 'stale' ? 90 : null);
    } finally { rm(home); rm(repo); }
  });
}

test('wakeCoverage: a stale lock ts, or a dead pid, is not a live watcher', () => {
  const home = tmp('home');
  const repo = makeRepo();
  try {
    addChild(repo, home);
    const env = { HOME: home, USERPROFILE: home };
    writeLock(home, NOW - 10 * MIN, process.pid); // older than WATCH_LOCK_STALE_MS (2 min)
    assert.strictEqual(wakeCoverage({ home, cwd: repo, id: PRIMARY_ID, now: NOW, env }).watcherLive, false);
    writeLock(home, NOW - 1000, 2147483646); // fresh ts, pid that cannot exist
    assert.strictEqual(wakeCoverage({ home, cwd: repo, id: PRIMARY_ID, now: NOW, env }).watcherLive, false);
  } finally { rm(home); rm(repo); }
});

test('wakeCoverage: devswarm.cronMissingWarnMin is honored', () => {
  const home = tmp('home');
  const repo = makeRepo();
  try {
    addChild(repo, home);
    writeTick(home, NOW - 20 * MIN);
    const env = { HOME: home, USERPROFILE: home };
    assert.strictEqual(wakeCoverage({ home, cwd: repo, id: PRIMARY_ID, now: NOW, env }).cronLikelyMissing, false);
    const env10 = Object.assign({ ANTIHALL_DEVSWARM_CRON_MISSING_WARN_MIN: '10' }, env);
    assert.strictEqual(wakeCoverage({ home, cwd: repo, id: PRIMARY_ID, now: NOW, env: env10 }).cronLikelyMissing, true);
  } finally { rm(home); rm(repo); }
});

test('wakeCoverage: an error (bad id / missing home) reports unknown and nothing else', () => {
  for (const o of [{ home: tmp('h'), cwd: '/', id: '../x' }, { cwd: '/', id: PRIMARY_ID }, null]) {
    const cov = wakeCoverage(o);
    assert.deepStrictEqual(cov, { liveChildren: false, watcherLive: false, lastTickAgeMin: null, cronLikelyMissing: false, unknown: true });
    assert.strictEqual(noWakePathLine(cov, { DEVSWARM_AI_AGENT: 'claude' }, '/c', '/w', PRIMARY_ID), '');
    if (o && o.home) rm(o.home);
  }
});

// --- noWakePathLine --------------------------------------------------------
const CLAUDE = { DEVSWARM_AI_AGENT: 'claude' };
const CLI = '/Users/x/.anti-hall/bin/devswarm.js';
const WATCH = '/Users/x/.anti-hall/bin/wake-watch.js';
const base = { liveChildren: true, watcherLive: false, lastTickAgeMin: null, cronLikelyMissing: true, watcherWanted: true, unknown: false };

test('noWakePathLine: both missing -> the full line, names both launchers, under 400 chars', () => {
  const t = noWakePathLine(base, CLAUDE, CLI, WATCH, PRIMARY_ID);
  assert.ok(t.startsWith('NO MAILBOX WAKE PATH: you have live workspaces but no watcher and no recent mailbox tick. Do both now:'), t);
  assert.ok(t.includes('Monitor: node ' + WATCH), t);
  assert.ok(t.includes('CronList, then CronCreate "7,37 * * * *"'), t);
  assert.ok(t.includes('node ' + CLI + ' inbox tick ' + PRIMARY_ID + ' --quiet'), t);
  assert.ok(t.length < 400, 'length ' + t.length);
});

test('noWakePathLine: only the watcher missing / only the cron missing -> shorter line naming just that one', () => {
  const w = noWakePathLine(Object.assign({}, base, { cronLikelyMissing: false, lastTickAgeMin: 4 }), CLAUDE, CLI, WATCH, PRIMARY_ID);
  assert.ok(w.startsWith('NO MAILBOX WATCHER'), w);
  assert.ok(w.includes(WATCH) && !w.includes('CronCreate'), w);
  const c = noWakePathLine(Object.assign({}, base, { watcherLive: true }), CLAUDE, CLI, WATCH, PRIMARY_ID);
  assert.ok(c.startsWith('NO MAILBOX TICK'), c);
  assert.ok(c.includes('CronCreate') && !c.includes('Monitor:'), c);
  assert.ok(w.length < 400 && c.length < 400);
});

test('noWakePathLine: empty when healthy, no live child, not Claude, or watcher switched off with a fresh tick', () => {
  assert.strictEqual(noWakePathLine(Object.assign({}, base, { watcherLive: true, cronLikelyMissing: false }), CLAUDE, CLI, WATCH, PRIMARY_ID), '');
  assert.strictEqual(noWakePathLine(Object.assign({}, base, { liveChildren: false }), CLAUDE, CLI, WATCH, PRIMARY_ID), '');
  assert.strictEqual(noWakePathLine(base, { DEVSWARM_AI_AGENT: 'codex' }, CLI, WATCH, PRIMARY_ID), '');
  assert.strictEqual(noWakePathLine(Object.assign({}, base, { watcherWanted: false, cronLikelyMissing: false }), CLAUDE, CLI, WATCH, PRIMARY_ID), '');
});

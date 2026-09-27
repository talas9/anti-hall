'use strict';
// companion/lib/devswarm-maintainer-notice.js — the cross-project maintainer
// broadcast channel. Every test seeds an isolated tmp HOME; nothing here
// touches the real ~/.anti-hall or a real checkout's plugin.json.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the shared anti-hall-log.js sink before requiring anything that may
// log (same pattern as tests/scripts/devswarm-v064.test.js) so a `post()`
// metric event never leaks into the real ~/.anti-hall/logs/devswarm.jsonl.
process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-maintnotice-log-'));

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const notice = require(path.join(ROOT, 'companion', 'lib', 'devswarm-maintainer-notice.js'));
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-maintnotice-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// fakeCheckout(dir, name) -> writes plugins/anti-hall/.claude-plugin/plugin.json
// with the given name so checkoutIsAntiHall can be tested against a fixture
// instead of the real repo.
function fakeCheckout(dir, name) {
  const p = path.join(dir, 'plugins', 'anti-hall', '.claude-plugin');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

test('post refused when setting is off', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const r = notice.post({ home, cwd, text: 'hello', settingsEnabled: false, now: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'setting-off');
    assert.strictEqual(notice.readAllRows(home).length, 0);
  } finally { rm(home); }
});

test('post refused when checkout is not anti-hall', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'some-other-plugin');
    const r = notice.post({ home, cwd, text: 'hello', settingsEnabled: true, now: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'wrong-checkout');
  } finally { rm(home); }
});

test('post refused when no plugin.json exists at all', () => {
  const home = tmpHome();
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-empty-'));
    const r = notice.post({ home, cwd, text: 'hello', settingsEnabled: true, now: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'wrong-checkout');
  } finally { rm(home); }
});

test('post succeeds when setting on + checkout is anti-hall', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const r = notice.post({ home, cwd, text: 'ship it', settingsEnabled: true, now: 1000 });
    assert.strictEqual(r.ok, true);
    assert.ok(r.id);
    const rows = notice.readAllRows(home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].text, 'ship it');
    assert.strictEqual(rows[0].expiresAt, 1000 + notice.DEFAULT_TTL_MS);
  } finally { rm(home); }
});

test('post rejects text over 2KB', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const big = 'x'.repeat(2049);
    const r = notice.post({ home, cwd, text: big, settingsEnabled: true, now: 1000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'text-too-long');
  } finally { rm(home); }
});

test('post honors custom ttl (7d/24h/30m)', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const r = notice.post({ home, cwd, text: 'a', ttl: '24h', settingsEnabled: true, now: 0 });
    assert.strictEqual(r.expiresAt, 24 * 60 * 60 * 1000);
  } finally { rm(home); }
});

test('post rejects an unparseable ttl', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const r = notice.post({ home, cwd, text: 'a', ttl: 'not-a-duration', settingsEnabled: true, now: 0 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad-ttl');
  } finally { rm(home); }
});

test('rate limit: at most 3 posts per rolling 24h', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const opts = (now, text) => ({ home, cwd, text, settingsEnabled: true, now });
    assert.strictEqual(notice.post(opts(1000, 'a')).ok, true);
    assert.strictEqual(notice.post(opts(2000, 'b')).ok, true);
    assert.strictEqual(notice.post(opts(3000, 'c')).ok, true);
    const fourth = notice.post(opts(4000, 'd'));
    assert.strictEqual(fourth.ok, false);
    assert.strictEqual(fourth.reason, 'rate-limited');
    // once the oldest post ages past 24h, a new post is allowed again
    const dayMs = 24 * 60 * 60 * 1000;
    const fifth = notice.post(opts(1000 + dayMs + 1, 'e'));
    assert.strictEqual(fifth.ok, true);
  } finally { rm(home); }
});

test('at most 5 unexpired notices are shown; expired ones are hidden, never deleted', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    // Post 3 short-TTL notices that will have expired by "now", spread across
    // 24h windows to dodge the rate limit, then 5 more that stay live.
    const dayMs = 24 * 60 * 60 * 1000;
    let t = 0;
    for (let i = 0; i < 2; i++) {
      notice.post({ home, cwd, text: 'expired-' + i, ttl: '1ms', settingsEnabled: true, now: t });
      t += 1;
    }
    t = 10 * dayMs;
    for (let i = 0; i < 7; i++) {
      notice.post({ home, cwd, text: 'live-' + i, ttl: '30d', settingsEnabled: true, now: t });
      t += dayMs + 1; // dodge the 3/24h rate limit
    }
    const finalNow = t + 1000;
    const shown = notice.list({ home, now: finalNow });
    assert.strictEqual(shown.notices.length, 5);
    // newest 5 of the 7 live ones (live-2..live-6), oldest-first
    assert.deepStrictEqual(shown.notices.map((n) => n.text), ['live-2', 'live-3', 'live-4', 'live-5', 'live-6']);
    // expired rows are never deleted from the underlying log
    const all = notice.readAllRows(home);
    assert.ok(all.some((r) => r.text === 'expired-0'));
    assert.ok(all.some((r) => r.text === 'expired-1'));
  } finally { rm(home); }
});

test('unseenFor / markSeen: a repoKey sees a notice once', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const r1 = notice.post({ home, cwd, text: 'first', settingsEnabled: true, now: 1000 });
    const before = notice.unseenFor({ home, repoKey: 'repoA', now: 2000 });
    assert.strictEqual(before.notices.length, 1);
    assert.strictEqual(before.notices[0].id, r1.id);

    notice.markSeen({ home, repoKey: 'repoA', id: r1.id, now: 2000 });
    const after = notice.unseenFor({ home, repoKey: 'repoA', now: 2000 });
    assert.strictEqual(after.notices.length, 0);

    // a DIFFERENT repoKey has not seen it yet
    const otherRepo = notice.unseenFor({ home, repoKey: 'repoB', now: 2000 });
    assert.strictEqual(otherRepo.notices.length, 1);

    // a second notice: repoA sees only the new one
    const r2 = notice.post({ home, cwd, text: 'second', settingsEnabled: true, now: 3000 });
    const afterSecond = notice.unseenFor({ home, repoKey: 'repoA', now: 3000 });
    assert.strictEqual(afterSecond.notices.length, 1);
    assert.strictEqual(afterSecond.notices[0].id, r2.id);
  } finally { rm(home); }
});

test('CLI: notice --post refused via settings.json off, allowed once flipped on', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-co-')), 'anti-hall');
    const envOff = { HOME: home };
    let { result: r1 } = cli.run(['notice', '--post', 'hello'], { home, env: envOff, cwd, now: 1000 });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.reason, 'setting-off');

    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'),
      JSON.stringify({ devswarm: { 'maintainerNotice.post': true } }));
    const { result: r2 } = cli.run(['notice', '--post', 'hello', '--ttl', '1d'], { home, env: envOff, cwd, now: 1000 });
    assert.strictEqual(r2.ok, true);

    const { result: r3 } = cli.run(['notice', '--list'], { home, env: envOff, cwd, now: 1000 });
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.notices.length, 1);
    assert.strictEqual(r3.notices[0].text, 'hello');
  } finally { rm(home); }
});

test('CLI: notice with no --post/--list is a usage error', () => {
  const home = tmpHome();
  try {
    const { result, code } = cli.run(['notice'], { home, env: {}, now: 1000 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(code, 2);
  } finally { rm(home); }
});

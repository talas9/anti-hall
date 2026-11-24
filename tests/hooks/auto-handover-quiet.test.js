'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('../../plugins/anti-hall-node/hooks/lib/auto-handover-quiet.js');

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-quiet-')); }
const payload = { session_id: 's1', cwd: '/nonexistent' };

test('not quiet with no flag, no state and no open task', () => {
  assert.strictEqual(q.isQuiet(home(), payload), false);
});

test('quiet while the AFK flag, the session no-stop state or an open task exists', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(h, '.anti-hall', 'afk-nostop-s1.json'), JSON.stringify({ on: true }));
  assert.strictEqual(q.isQuiet(h, payload), true);
  const h2 = home();
  fs.mkdirSync(path.join(h2, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(h2, '.anti-hall', 'afk.json'), JSON.stringify({ on: true }));
  assert.strictEqual(q.isQuiet(h2, payload), true);
  const h3 = home();
  const d = path.join(h3, '.claude', 'tasks', 'session-s1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '1.json'), JSON.stringify({ id: '1', subject: 'x', status: 'pending' }));
  assert.strictEqual(q.isQuiet(h3, payload), true);
  fs.writeFileSync(path.join(d, '1.json'), JSON.stringify({ id: '1', subject: 'x', status: 'completed' }));
  assert.strictEqual(q.isQuiet(h3, payload), false);
});

test('refresh nudge: only for a stale or missing handover, never repeated, never a stopping-point or compact advice', () => {
  const h = home();
  const now = Date.now();
  const none = q.refreshNudge(h, payload, {}, 90, now, null);
  assert.match(none, /Do now: write the handover/);
  assert.doesNotMatch(none, /stopping point|\/compact|\/clear/);
  assert.strictEqual(q.refreshNudge(h, payload, { lastRefreshAt: now }, 90, now, null), null);
  assert.strictEqual(q.refreshNudge(h, payload, {}, 90, now, { mtimeMs: now }), null, 'a current handover is not nudged');
  const d = path.join(h, '.claude', 'tasks', 'session-s1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '1.json'), '{"id":"1","status":"pending"}');
  assert.match(q.refreshNudge(h, payload, {}, 90, now + 3600000, { mtimeMs: now - 3600000 }), /update the handover/);
});

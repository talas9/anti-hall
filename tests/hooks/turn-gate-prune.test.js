'use strict';
// turn-gate.js self-prunes stale tg-<session>.json files. Regression: PREFIX was
// 'tg-' and state-prune.js appends '-', so the sweep looked for 'tg--*' and
// never removed anything. Isolated HOME; never touches the real ~/.anti-hall.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { makeHome } = require('../helpers/fixtures.js');
const { firstThisTurn } = require('../../plugins/anti-hall/hooks/lib/turn-gate.js');

const DAY = 24 * 60 * 60 * 1000;

test('turn-gate: prunes stale tg-<session>.json, keeps fresh and the live one', () => {
  const h = makeHome();
  try {
    const dir = path.join(h.home, '.anti-hall', 'turn-gate');
    fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 10 * DAY) / 1000;
    const stale = path.join(dir, 'tg-old-session.json');
    const fresh = path.join(dir, 'tg-fresh-session.json');
    fs.writeFileSync(stale, '{}');
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(fresh, '{}');

    assert.strictEqual(firstThisTurn({ home: h.home, sessionId: 'live', key: 'k', agentId: 'a1' }), true);

    assert.ok(!fs.existsSync(stale), 'stale tg- file must be removed');
    assert.ok(fs.existsSync(fresh), 'fresh tg- file must stay');
    assert.ok(fs.existsSync(path.join(dir, 'tg-live.json')), 'live session file must stay');
  } finally { h.cleanup(); }
});

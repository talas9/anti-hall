'use strict';
// install-devswarm-supervisor pure-builder tests. No real launchctl/systemctl/fs
// writes — only the text builders + the interval clamp, with a nasty path.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');
const m = require(MOD);

const NASTY = '/Users/a b & c/<x>/"q\'/node';
const NASTY_SCRIPT = '/Users/a b & c/devswarm-supervisor.js';

test('clampInterval: default 90, clamps to 60..120, rejects garbage', () => {
  assert.strictEqual(m.clampInterval(undefined), 90);
  assert.strictEqual(m.clampInterval('90'), 90);
  assert.strictEqual(m.clampInterval('30'), 60);   // below floor
  assert.strictEqual(m.clampInterval('999'), 120); // above ceiling
  assert.strictEqual(m.clampInterval('abc'), 90);  // garbage -> default
});

test('buildPlist XML-escapes exec/script/log, embeds the clamped interval, well-formed', () => {
  const xml = m.buildPlist({ exec: NASTY, script: NASTY_SCRIPT, log: '/log/a & b.log', interval: 90 });
  assert.ok(xml.includes('<string>/Users/a b &amp; c/&lt;x&gt;/&quot;q&apos;/node</string>'));
  assert.ok(xml.includes('<string>/Users/a b &amp; c/devswarm-supervisor.js</string>'));
  assert.ok(xml.includes('<integer>90</integer>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no bare ampersands allowed');
  assert.strictEqual((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length);
  assert.ok(xml.includes(m.LABEL));
});

test('buildService double-quotes exec + script (space-safe)', () => {
  const unit = m.buildService({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(unit.includes(`ExecStart="${NASTY}" "${NASTY_SCRIPT}"`));
});

test('buildTimer carries the clamped interval on OnUnitActiveSec', () => {
  const t = m.buildTimer({ interval: 120 });
  assert.ok(/OnUnitActiveSec=120/.test(t));
  assert.ok(/WantedBy=timers.target/.test(t));
});

test('buildCronLine double-quotes exec + script and discards output', () => {
  const line = m.buildCronLine({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(line.includes(`"${NASTY}" "${NASTY_SCRIPT}"`));
  assert.ok(line.endsWith('>/dev/null 2>&1'));
});

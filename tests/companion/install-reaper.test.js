'use strict';
// install-reaper pure-builder tests (FIX 4). No real launchctl/systemctl/fs writes —
// only the text builders are exercised, with a path containing a space and `&`.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-reaper.js');
const m = require(MOD);

const NASTY = '/Users/a b & c/<x>/"q\'/node';
const NASTY_SCRIPT = '/Users/a b & c/mcp-reaper.js';

test('xmlEscape escapes & < > " \' (ampersand first)', () => {
  assert.strictEqual(m.xmlEscape('a & b < c > d " e \' f'),
    'a &amp; b &lt; c &gt; d &quot; e &apos; f');
});

test('buildPlist XML-escapes interpolated exec/script/log and is well-formed', () => {
  const xml = m.buildPlist({ exec: NASTY, script: NASTY_SCRIPT, log: '/log/a & b.log' });
  // No raw special chars leaked inside the document body (besides the literal &amp; etc).
  assert.ok(!/[<>"']x[<>"']/.test(xml)); // sanity
  assert.ok(xml.includes('<string>/Users/a b &amp; c/&lt;x&gt;/&quot;q&apos;/node</string>'));
  assert.ok(xml.includes('<string>/Users/a b &amp; c/mcp-reaper.js</string>'));
  assert.ok(xml.includes('<string>/log/a &amp; b.log</string>'));
  // No UNescaped ampersand anywhere (every & must be part of an entity).
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no bare ampersands allowed');
  // Tags balanced enough to be well-formed-ish.
  assert.strictEqual((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length);
});

test('buildService double-quotes exec and script paths (space-safe)', () => {
  const unit = m.buildService({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(unit.includes(`ExecStart="${NASTY}" "${NASTY_SCRIPT}"`));
});

test('buildCronLine double-quotes exec and script paths (space-safe)', () => {
  const line = m.buildCronLine({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(line.includes(`"${NASTY}" "${NASTY_SCRIPT}"`));
  assert.ok(line.endsWith('>/dev/null 2>&1'));
});

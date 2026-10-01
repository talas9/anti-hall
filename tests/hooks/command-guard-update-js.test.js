'use strict';
// command-guard.js — the update skill runs update.js IN-SESSION on the main
// model (it runs migrations), so the exact invocation is allowed (optionally
// piped to a bounded sink). Look-alikes and chained commands stay blocked.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function blocked(command) {
  const h = makeHome();
  try {
    return testHook('command-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 't', cwd: process.cwd(),
    }, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }).status === 2;
  } finally { h.cleanup(); }
}

const MKT = 'node "$HOME/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/skills/update/scripts/update.js"';

test('update.js: skill invocations (marketplace, cache, checkout, flags, sink) are allowed', () => {
  for (const ok of [
    MKT, `${MKT} --check`, `${MKT} --check 2>&1 | tail -40`,
    'node ~/.claude/plugins/cache/anti-hall/anti-hall/0.120.6/skills/update/scripts/update.js',
    'node plugins/anti-hall/skills/update/scripts/update.js --check',
    'node /Users/x/anti-hall/plugins/anti-hall/skills/update/scripts/update.js | head -50',
  ]) assert.strictEqual(blocked(ok), false, ok);
});

test('update.js: look-alikes and chained heavy commands stay blocked', () => {
  for (const bad of [
    'node plugins/anti-hall/skills/update/scripts/update.js.evil',
    'node plugins/anti-hall/skills/other/scripts/update.js',
    'node plugins/anti-hall/skills/update/update.js',
    'node scripts/update.js',
    'node evil/update.js',
    `${MKT}; npm test`,
    `${MKT} && npm run build`,
    `${MKT} | npm test`,
    'npm run build -- node plugins/anti-hall/skills/update/scripts/update.js',
  ]) assert.ok(blocked(bad), bad);
});

test('install-devswarm-* companion installers: exact names allowed, look-alikes blocked', () => {
  for (const ok of ['node companion/install-devswarm-supervisor.js', 'node companion/install-devswarm-ingest.js']) {
    assert.strictEqual(blocked(ok), false, ok);
  }
  for (const bad of ['node companion/install-devswarm-ingest.js.evil', 'node companion/install-evil.js',
    'node companion/install-devswarm-ingest.js; npm test']) assert.ok(blocked(bad), bad);
});

'use strict';
// hooks/lib/work-detect.js — the shared "what counts as a file-changing
// action" primitive (tasklist-guard.js + handover-freshness.js).
//
// defect T4(b) (7-workspace sweep, 2026-09-27): a Bash command that is ONLY
// anti-hall's own DevSwarm mesh housekeeping (the stable launcher's inbox/
// heartbeat/send/roster verbs, or a `crontab` install/check for the
// mailbox-wake cron job) must never count as file-changing work, the same
// way scratchpad-only traffic already doesn't. Agent/Task/CronCreate/
// CronDelete tool_uses (spawn/schedule actions, not file mutations) must
// never count either.

const { test } = require('node:test');
const assert = require('node:assert');
const wd = require('../../plugins/anti-hall/hooks/lib/work-detect.js');

test('isDevswarmHousekeepingOnly: a chained inbox pull && inbox ack is housekeeping-only', () => {
  assert.strictEqual(
    wd.isDevswarmHousekeepingOnly('node /x/devswarm.js inbox pull child-1 && node /x/devswarm.js inbox ack child-1'),
    true
  );
});

test('isDevswarmHousekeepingOnly: a crontab read/install for the mailbox-wake cron is housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('crontab -l > /tmp/cron.txt'), true);
});

test('isDevswarmHousekeepingOnly: a devswarm verb chained with GENUINE other work is NOT housekeeping-only', () => {
  assert.strictEqual(
    wd.isDevswarmHousekeepingOnly('node /x/devswarm.js heartbeat child-1 --summary "x" && rm -rf /project/file.txt'),
    false
  );
});

test('isDevswarmHousekeepingOnly: an unrelated command is not housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('git commit -am "fix bug"'), false);
});

test('isCountedWork: a crontab mailbox-wake install does not count as work', () => {
  assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: 'crontab -l > /tmp/cron.txt' } }), false);
});

test('isCountedWork: devswarm stable-launcher inbox pull/ack chain does not count as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node /x/devswarm.js inbox pull child-1 && node /x/devswarm.js inbox ack child-1' } }),
    false
  );
});

test('isCountedWork: a housekeeping verb chained with a genuine mutation still counts', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node /x/devswarm.js heartbeat child-1 --summary "x" && rm -rf /project/file.txt' } }),
    true
  );
});

test('isCountedWork: a genuine git commit still counts (regression guard)', () => {
  assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: 'git commit -am "fix bug"' } }), true);
});

test('isCountedWork: Agent/Task/CronCreate/CronDelete tool_uses never count', () => {
  for (const name of ['Agent', 'Task', 'CronCreate', 'CronDelete']) {
    assert.strictEqual(wd.isCountedWork({ name, input: { prompt: 'do something' } }), false, `${name} must not count`);
  }
});

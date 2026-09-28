'use strict';
// jev-review.js — durable "time to review the Jev shadow numbers" tracking:
// due-date computation (shadow duration + decision count thresholds),
// snooze, reviewed, and the jev-setup.js CLI verbs (review-due/reviewed/
// snooze) that front it. Every test gets an isolated HOME (never the real ~).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const REVIEW = require('../../plugins/anti-hall/hooks/lib/jev-review.js');
const CLI = require.resolve('../../plugins/anti-hall/scripts/jev-setup.js');

function writeJevConfig(home, cfg) {
  const dir = path.join(home, '.anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify(cfg));
}

// writeDecisionRows(home, id, n, ageDays) — n decision rows for `id`, all
// timestamped `ageDays` ago, in jev-assist.ndjson.
function writeDecisionRows(home, id, n, ageDays) {
  const dir = path.join(home, '.anti-hall', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageDays * 86400000).toISOString();
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      ts, id, h: id + '-h' + i, base: true, jev: true, conf: 0.9, ms: 10,
      backend: 'jev', final: true, changed: null, cached: false, mode: 'shadow',
    }));
  }
  fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), lines.join('\n') + '\n');
}

function runCli(args, home) {
  const env = Object.assign({}, process.env, { HOME: home });
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout: out };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '' };
  }
}

test('due after N days with enough decisions', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 35, 10); // 10 days old, 35 rows
    const result = REVIEW.computeReviewDue(h.home);
    assert.ok(result.due.find((d) => d.id === 'modelRouting'), 'modelRouting should be due');
    const row = result.due.find((d) => d.id === 'modelRouting');
    assert.strictEqual(row.decisions, 35);
    assert.ok(row.days >= 7, 'days must be >= reviewAfterDays');
  } finally {
    h.cleanup();
  }
});

test('not due below the decision count', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 5, 10); // 10 days old, only 5 rows (< default 30)
    const result = REVIEW.computeReviewDue(h.home);
    assert.strictEqual(result.due.find((d) => d.id === 'modelRouting'), undefined);
  } finally {
    h.cleanup();
  }
});

test('not due before reviewAfterDays even with enough decisions', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 50, 1); // only 1 day old
    const result = REVIEW.computeReviewDue(h.home);
    assert.strictEqual(result.due.find((d) => d.id === 'modelRouting'), undefined);
  } finally {
    h.cleanup();
  }
});

test('snooze works: a snoozed integration is not due even when otherwise qualifying', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const before = REVIEW.computeReviewDue(h.home);
    assert.ok(before.due.find((d) => d.id === 'modelRouting'));

    const snoozeResult = REVIEW.snoozeIntegration('modelRouting', h.home, 3);
    assert.strictEqual(snoozeResult.ok, true);

    const after = REVIEW.computeReviewDue(h.home);
    assert.strictEqual(after.due.find((d) => d.id === 'modelRouting'), undefined, 'snoozed integration must not be due');
  } finally {
    h.cleanup();
  }
});

test('reviewed clears the reminder', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const before = REVIEW.computeReviewDue(h.home);
    assert.ok(before.due.find((d) => d.id === 'modelRouting'));

    const r = REVIEW.markReviewed('modelRouting', h.home);
    assert.strictEqual(r.ok, true);

    const after = REVIEW.computeReviewDue(h.home);
    assert.strictEqual(after.due.find((d) => d.id === 'modelRouting'), undefined, 'reviewed integration must not still be due');
  } finally {
    h.cleanup();
  }
});

test('shadowSince is derived from the earliest decision row when unknown, not invented', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 5, 15); // rows are 15 days old
    REVIEW.computeReviewDue(h.home);
    const state = REVIEW.readState(h.home);
    const shadowSince = state.integrations.modelRouting.shadowSince;
    const ageDays = (Date.now() - Date.parse(shadowSince)) / 86400000;
    assert.ok(ageDays > 14 && ageDays < 16, `shadowSince should reflect the earliest row's age (~15d), got ${ageDays}`);
  } finally {
    h.cleanup();
  }
});

test('not due when Jev is not enabled at all', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: false, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const result = REVIEW.computeReviewDue(h.home);
    assert.deepStrictEqual(result.due, []);
  } finally {
    h.cleanup();
  }
});

test('CLI: review-due --json reports the due integration', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const r = runCli(['review-due', '--json'], h.home);
    assert.strictEqual(r.code, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.ok(rows.find((d) => d.id === 'modelRouting'));
  } finally {
    h.cleanup();
  }
});

test('CLI: reviewed <id> then review-due shows nothing due', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    let r = runCli(['review-due', '--json'], h.home);
    assert.ok(JSON.parse(r.stdout).find((d) => d.id === 'modelRouting'));

    r = runCli(['reviewed', 'modelRouting'], h.home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /marked reviewed/);

    r = runCli(['review-due', '--json'], h.home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout).filter((d) => d.id === 'modelRouting'), []);
  } finally {
    h.cleanup();
  }
});

test('CLI: snooze <id> --days N removes it from review-due', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    let r = runCli(['snooze', 'modelRouting', '--days', '5'], h.home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /snoozed until/);

    r = runCli(['review-due', '--json'], h.home);
    assert.deepStrictEqual(JSON.parse(r.stdout).filter((d) => d.id === 'modelRouting'), []);
  } finally {
    h.cleanup();
  }
});

test('CLI: snooze with a non-positive --days fails cleanly', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    const r = runCli(['snooze', 'modelRouting', '--days', '0'], h.home);
    assert.notStrictEqual(r.code, 0);
  } finally {
    h.cleanup();
  }
});

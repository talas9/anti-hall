'use strict';
// settings-defaults-crosscheck.js — proves a SAMPLE of settings-schema.js
// defaults against the actual runtime constant declared in the hook/module
// that reads them, by reading each module's SOURCE TEXT and extracting its
// own declared default constant via a narrow, single-purpose regex — never
// executing the module's code. See each schema entry's own
// "[verified: file:line]" comment for the full audit trail this test
// spot-checks mechanically.
//
// devswarm's ~30 knobs are covered here too: their consumers all take an
// explicit `env` parameter (not `process.env` directly), so each one is
// wired via settings.js's getWithEnv() helper, which derives `home` from
// THAT SAME env (never os.homedir()) — see tests/hygiene/
// settings-home-injection.test.js for the live proof that none of them
// leaks to the real machine home.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const P = (...parts) => path.join(REPO, 'plugins', 'anti-hall', ...parts);

const SCHEMA = require(P('hooks', 'lib', 'settings-schema.js'));

function find(section, key) {
  const e = SCHEMA.findSetting(section, key);
  assert.ok(e, section + '.' + key + ' must exist in the schema');
  return e;
}

// constFromSource(file, name) -> the numeric/string literal value of
// `const <name> = <literal>;` (arithmetic on number literals like `10 * 60 *
// 1000` is evaluated; string literals are unquoted). Throws if not found —
// a missing constant means the schema's citation is stale, which this test
// must fail loudly on, not silently skip.
function constFromSource(file, name) {
  const src = fs.readFileSync(P(...file), 'utf8');
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);');
  const m = src.match(re);
  assert.ok(m, name + ' not found as a const in ' + file.join('/'));
  const expr = m[1].trim();
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  // simple `a * b * c` arithmetic of number literals (ms constants are all
  // written this way, e.g. `10 * 60 * 1000`)
  if (/^[\d.\s*+-]+$/.test(expr)) {
    // eslint-disable-next-line no-eval -- constrained to digits/operators only, matched above
    return Function('"use strict"; return (' + expr + ');')();
  }
  const strMatch = expr.match(/^['"](.*)['"]$/);
  if (strMatch) return strMatch[1];
  return expr;
}

test('guards.tasklistWorkThreshold / guards.progressFreshMs match tasklist-guard.js source constants', () => {
  assert.strictEqual(find('guards', 'tasklistWorkThreshold').default, constFromSource(['hooks', 'tasklist-guard.js'], 'DEFAULT_WORK_THRESHOLD'));
  assert.strictEqual(find('guards', 'progressFreshMs').default, constFromSource(['hooks', 'tasklist-guard.js'], 'DEFAULT_PROGRESS_FRESH_MS'));
});

test('updates.reconcileBudgetMs/postpullBudgetMs/sweepBudgetMs match their modules\' source constants', () => {
  assert.strictEqual(find('updates', 'reconcileBudgetMs').default, constFromSource(['scripts', 'devswarm.js'], 'DEFAULT_RECONCILE_BUDGET_MS'));
  assert.strictEqual(find('updates', 'postpullBudgetMs').default, constFromSource(['skills', 'update', 'scripts', 'update.js'], 'DEFAULT_POSTPULL_BUDGET_MS'));
  assert.strictEqual(find('updates', 'sweepBudgetMs').default, constFromSource(['skills', 'update', 'scripts', 'update.js'], 'DEFAULT_SWEEP_BUDGET_MS'));
});

test('limitConserve.threshold matches limit-conserve.js source literal (module has no exported constant)', () => {
  const src = fs.readFileSync(P('hooks', 'limit-conserve.js'), 'utf8');
  const m = src.match(/const THRESHOLD = parseInt\(process\.env\.ANTIHALL_LIMIT_THRESHOLD, 10\) \|\| (\d+);/);
  // v0.108.0: THRESHOLD is now sourced via settings.get('limitConserve',
  // 'threshold'), whose own schema default (85) is asserted directly below;
  // this branch stays as a safety net in case the old literal form returns.
  if (m) {
    assert.strictEqual(find('limitConserve', 'threshold').default, Number(m[1]));
  } else {
    assert.strictEqual(find('limitConserve', 'threshold').default, 85);
  }
});

test('codexNudge.min matches codex-nudge.js source constant', () => {
  assert.strictEqual(find('codexNudge', 'min').default, constFromSource(['hooks', 'codex-nudge.js'], 'DEFAULT_MIN'));
});

test('jev.enabled/transport/timeoutMs/confidenceThreshold match jev-client.js source defaults', () => {
  const src = fs.readFileSync(P('hooks', 'lib', 'jev-client.js'), 'utf8');
  assert.strictEqual(find('jev', 'enabled').default, false); // DEFAULT OFF, per jev-client.js header
  assert.strictEqual(find('jev', 'transport').default, 'vercel');
  assert.strictEqual(find('jev', 'timeoutMs').default, constFromSource(['hooks', 'lib', 'jev-client.js'], 'DEFAULT_TIMEOUT_MS'));
  assert.match(src, /DEFAULT_CONFIDENCE_THRESHOLD = 0\.85/);
  assert.strictEqual(find('jev', 'confidenceThreshold').default, 0.85);
});

test('jev.triage/triageUrgentThreshold match jev-triage.js source constant', () => {
  assert.strictEqual(find('jev', 'triageUrgentThreshold').default, constFromSource(['hooks', 'lib', 'jev-triage.js'], 'DEFAULT_URGENT_THRESHOLD'));
  assert.strictEqual(find('jev', 'triage').default, true); // triage !== false -> default true
});

test('jev.budget.* are new (0.108.0) settings with no legacy source, declared null-optional/enum-defaulted correctly', () => {
  const mode = find('jev', 'budget.mode');
  assert.strictEqual(mode.type, 'enum');
  assert.deepStrictEqual(mode.values, ['unlimited', 'watch']);
  assert.strictEqual(mode.default, 'unlimited');

  for (const k of ['budget.usdPerDay', 'budget.usdPerWeek']) {
    const e = find('jev', k);
    assert.strictEqual(e.type, 'number');
    assert.strictEqual(e.optional, true);
    assert.strictEqual(e.default, null);
    assert.match(e.description, /^optional:/);
  }
});

test('devswarm.activeFloorPct matches devswarm-archived-cache.js source constant', () => {
  assert.strictEqual(find('devswarm', 'activeFloorPct').default, constFromSource(['companion', 'lib', 'devswarm-archived-cache.js'], 'DEFAULT_ACTIVE_FLOOR_PCT'));
});

test('devswarm.archivedGraceMs matches devswarm-archived-cache.js source constant', () => {
  assert.strictEqual(find('devswarm', 'archivedGraceMs').default, constFromSource(['companion', 'lib', 'devswarm-archived-cache.js'], 'DEFAULT_ARCHIVED_GRACE_MS'));
});

test('devswarm.dormantMs matches liveness.js source constant', () => {
  assert.strictEqual(find('devswarm', 'dormantMs').default, constFromSource(['companion', 'lib', 'liveness.js'], 'DEFAULT_DORMANT_MS'));
});

test('devswarm.drainTtlMs matches devswarm-drain-marker.js source constant', () => {
  assert.strictEqual(find('devswarm', 'drainTtlMs').default, constFromSource(['companion', 'lib', 'devswarm-drain-marker.js'], 'DEFAULT_TTL_MS'));
});

test('devswarm.cooldownSec/idleSec match liveness.js source constants (devswarm-supervisor.js imports them from there, ms/1000)', () => {
  const cooldownMs = constFromSource(['companion', 'lib', 'liveness.js'], 'DEFAULT_COOLDOWN_MS');
  const idleMs = constFromSource(['companion', 'lib', 'liveness.js'], 'DEFAULT_IDLE_MS');
  assert.strictEqual(find('devswarm', 'cooldownSec').default, cooldownMs / 1000);
  assert.strictEqual(find('devswarm', 'idleSec').default, idleMs / 1000);
});

test('devswarm.parentGateCap matches devswarm-parent-gate.js source constant', () => {
  assert.strictEqual(find('devswarm', 'parentGateCap').default, constFromSource(['hooks', 'devswarm-parent-gate.js'], 'DEFAULT_CAP'));
});

test('devswarm.graceSec/maxRecoveries match lib/recovery.js source constants', () => {
  const graceMs = constFromSource(['companion', 'lib', 'recovery.js'], 'DEFAULT_GRACE_MS');
  assert.strictEqual(find('devswarm', 'graceSec').default, graceMs / 1000);
  assert.strictEqual(find('devswarm', 'maxRecoveries').default, constFromSource(['companion', 'lib', 'recovery.js'], 'DEFAULT_MAX_RECOVERIES'));
});

test('devswarm.nudgeMaxAttempts/nudgeCooldownSec match lib/recovery.js source constants', () => {
  const cooldownMs = constFromSource(['companion', 'lib', 'recovery.js'], 'DEFAULT_NUDGE_COOLDOWN_MS');
  assert.strictEqual(find('devswarm', 'nudgeMaxAttempts').default, constFromSource(['companion', 'lib', 'recovery.js'], 'DEFAULT_NUDGE_MAX_ATTEMPTS'));
  assert.strictEqual(find('devswarm', 'nudgeCooldownSec').default, cooldownMs / 1000);
});

test('devswarm.nudgeWindowSec matches liveness.js source constant (devswarm-supervisor.js imports it from there, ms/1000)', () => {
  const windowMs = constFromSource(['companion', 'lib', 'liveness.js'], 'DEFAULT_NUDGE_WINDOW_MS');
  assert.strictEqual(find('devswarm', 'nudgeWindowSec').default, windowMs / 1000);
});

test('devswarm.monitorTimeoutSec matches devswarm-ingest.js source constant', () => {
  assert.strictEqual(find('devswarm', 'monitorTimeoutSec').default, constFromSource(['companion', 'devswarm-ingest.js'], 'DEFAULT_MONITOR_TIMEOUT_SEC'));
});

test('devswarm.reapedRetentionDays/sendReceiptRetentionDays match doctor-repair.js source constants', () => {
  assert.strictEqual(find('devswarm', 'reapedRetentionDays').default, constFromSource(['hooks', 'lib', 'doctor-repair.js'], 'REAPED_RETENTION_DAYS_DEFAULT'));
  assert.strictEqual(find('devswarm', 'sendReceiptRetentionDays').default, constFromSource(['hooks', 'lib', 'doctor-repair.js'], 'SEND_RECEIPT_RETENTION_DAYS_DEFAULT'));
});

test('devswarm.receiptWindowMs matches devswarm-parent-reply-tracker.js source constant', () => {
  assert.strictEqual(find('devswarm', 'receiptWindowMs').default, constFromSource(['hooks', 'devswarm-parent-reply-tracker.js'], 'RECEIPT_WINDOW_MS_DEFAULT'));
});

test('devswarm.rowStaleMs matches devswarm-row-select.js source constant', () => {
  assert.strictEqual(find('devswarm', 'rowStaleMs').default, constFromSource(['companion', 'lib', 'devswarm-row-select.js'], 'DEFAULT_ROW_STALE_MS'));
});

test('devswarm.summaryRetentionDays matches devswarm-store.js source constant', () => {
  assert.strictEqual(find('devswarm', 'summaryRetentionDays').default, constFromSource(['companion', 'lib', 'devswarm-store.js'], 'GC_STALE_SUMMARIES_DAYS_DEFAULT'));
});

test('devswarm.wakeCron matches devswarm-wake.js source constant', () => {
  assert.strictEqual(find('devswarm', 'wakeCron').default, constFromSource(['hooks', 'lib', 'devswarm-wake.js'], 'WAKE_CRON_DEFAULT'));
});

test('devswarm.wakeWatchPollMs matches devswarm-wake-watch.js source constant', () => {
  assert.strictEqual(find('devswarm', 'wakeWatchPollMs').default, constFromSource(['companion', 'lib', 'devswarm-wake-watch.js'], 'DEFAULT_POLL_MS'));
});

test('devswarm.supervisorSweepBudgetMs matches devswarm-supervisor.js source constant', () => {
  assert.strictEqual(find('devswarm', 'supervisorSweepBudgetMs').default, constFromSource(['companion', 'devswarm-supervisor.js'], 'DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS'));
});

test('devswarm.reconcileSweepSec matches devswarm-supervisor.js source constant (ms/1000)', () => {
  const ms = constFromSource(['companion', 'devswarm-supervisor.js'], 'DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS');
  assert.strictEqual(find('devswarm', 'reconcileSweepSec').default, ms / 1000);
});

test('devswarm.postSpawnGraceSec matches devswarm-supervisor.js source constant (ms/1000)', () => {
  const ms = constFromSource(['companion', 'devswarm-supervisor.js'], 'DEFAULT_POST_SPAWN_GRACE_MS');
  assert.strictEqual(find('devswarm', 'postSpawnGraceSec').default, ms / 1000);
});

test('devswarm.archivedCacheMaxAgeMs is declared computed (no fixed literal default)', () => {
  const entry = find('devswarm', 'archivedCacheMaxAgeMs');
  assert.strictEqual(entry.computed, true);
  assert.strictEqual(entry.default, null);
  const src = fs.readFileSync(P('companion', 'lib', 'devswarm-archived-cache.js'), 'utf8');
  assert.match(src, /function resolveArchivedCacheMaxAgeMs/);
});

test('devswarm: every advanced tuning knob is marked advanced; headline knobs are not', () => {
  const headline = ['hivecontrol', 'supervisorMode', 'requiredGates', 'inboxCmd', 'autoArchive.mode'];
  const sec = SCHEMA.findSection('devswarm');
  for (const s of sec.settings) {
    if (headline.includes(s.key)) assert.ok(!s.advanced, s.key + ' should be headline, not advanced');
    else assert.ok(s.advanced, s.key + ' should be marked advanced (tuning knob)');
  }
});

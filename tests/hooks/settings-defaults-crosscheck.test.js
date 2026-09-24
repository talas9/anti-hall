'use strict';
// settings-defaults-crosscheck.js — proves a SAMPLE of settings-schema.js
// defaults against the actual runtime constant declared in the hook/module
// that reads them, by reading each module's SOURCE TEXT and extracting its
// own declared default constant via a narrow, single-purpose regex — never
// executing the module's code. See each schema entry's own
// "[verified: file:line]" comment for the full audit trail this test
// spot-checks mechanically.
//
// NOTE: there is deliberately no `devswarm` section in settings-schema.js —
// see the removal note at that spot in the schema file. Its knobs' consumers
// all take an explicit `env` parameter (not `process.env` directly), which
// makes wiring settings.get() into them unsafe without a `home` parameter
// threaded through first; they were removed rather than shipped as fake
// controls.

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

test('the schema has no devswarm section (removed pending a home-injectable resolver refactor)', () => {
  assert.strictEqual(SCHEMA.findSection('devswarm'), null);
});

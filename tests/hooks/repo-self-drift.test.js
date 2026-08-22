'use strict';
// repo-self-drift.js (SessionStart hook) — Probe 3 of anti-hall's
// drift-probe family. Two independent checks, synchronous (no background
// refresh): (1) docs/KB.md's claimed hooks/skills counts vs actual counts on
// disk; (2) model-KB audit-date staleness vs a threshold. Advisory only,
// dedup'd, fail-open + silent on any error or missing source.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'repo-self-drift.js';
const HOOK_ABS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', HOOK);
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 't' };
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const rsd = require(HOOK_ABS);
const { MODEL_KB_AUDIT_DATE, STALENESS_THRESHOLD_DAYS } = require(
  path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'repo-audit-baseline.js')
);

function writeCache(h, obj) {
  h.writeState('repo-self-drift.json', obj);
}

function readCache(h) {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'repo-self-drift.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function hasContext(r) {
  return (
    r.json &&
    r.json.hookSpecificOutput &&
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
}

// A fresh cache with a date well inside the staleness threshold, and
// matching claimed/actual counts — the "everything is fine" baseline every
// test that isn't specifically probing one check starts from, so the OTHER
// check never fires and pollutes the assertion.
function quietCache(overrides) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.assign(
    {
      checkedAt: NOW,
      claimedHooks: 10,
      actualHooks: 10,
      claimedSkills: 5,
      actualSkills: 5,
      modelKbAuditDate: today,
      modelKbAgeDays: 0,
    },
    overrides
  );
}

// ── Pure helper unit tests ──────────────────────────────────────────────

test('parseClaims: extracts hooks + skills counts from real KB.md prose shape', () => {
  const text = 'Hooks: **49** `.js` files + `hooks.json` = 50. Claude\nskills: **15** (+ `MODEL-POLICY.md`, not itself a skill); Codex skills: **18**.';
  assert.deepStrictEqual(rsd.parseClaims(text), { claimedHooks: 49, claimedSkills: 15 });
});

test('parseClaims: no match => null (never guess)', () => {
  assert.deepStrictEqual(rsd.parseClaims('nothing relevant here'), { claimedHooks: null, claimedSkills: null });
});

test('daysBetween: computes integer day difference', () => {
  assert.strictEqual(rsd.daysBetween('2026-05-29', '2026-08-22'), 85);
  assert.strictEqual(rsd.daysBetween('2026-08-22', '2026-08-22'), 0);
});

test('daysBetween: unparseable date => null', () => {
  assert.strictEqual(rsd.daysBetween('not-a-date', '2026-08-22'), null);
});

test('countJsFiles / countSkillDirs: counts real repo hooks dir (sanity, not exact — repo evolves)', () => {
  const hooksDir = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');
  const skillsDir = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'skills');
  assert.ok(rsd.countJsFiles(hooksDir) > 0);
  assert.ok(rsd.countSkillDirs(skillsDir) > 0);
});

test('countJsFiles: absent dir => null (fail-open, never guess)', () => {
  assert.strictEqual(rsd.countJsFiles('/nonexistent/path/xyz'), null);
  assert.strictEqual(rsd.countSkillDirs('/nonexistent/path/xyz'), null);
});

test('resolveKbPath: tries installed-package layout then dev-repo layout', () => {
  const p = rsd.resolveKbPath(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks'));
  assert.ok(p, 'must find docs/KB.md via the dev-repo fallback in this checkout');
  assert.ok(fs.existsSync(p));
});

test('resolveKbPath: neither candidate exists => null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-nokb-'));
  const hooksDir = path.join(tmp, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  try {
    assert.strictEqual(rsd.resolveKbPath(hooksDir), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scan: real repo — actual counts are computed, model-kb staleness computed', () => {
  const hooksDir = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');
  const r = rsd.scan(hooksDir);
  assert.ok(Number.isFinite(r.actualHooks));
  assert.ok(Number.isFinite(r.actualSkills));
  assert.strictEqual(r.modelKbAuditDate, MODEL_KB_AUDIT_DATE);
  assert.ok(Number.isFinite(r.modelKbAgeDays));
});

// ── Black-box hook contract tests ───────────────────────────────────────

test('cache absent => hook scans synchronously and exits 0 (no background spawn needed)', () => {
  const h = makeHome();
  try {
    const start = Date.now();
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0);
    assert.ok(elapsed < 5000, `should return promptly; took ${elapsed}ms`);
    // The scan always populates a cache file (synchronous, not detached).
    assert.ok(fs.existsSync(path.join(h.antiHall, 'repo-self-drift.json')));
  } finally { h.cleanup(); }
});

test('installed cache: claimed === actual on both counts, fresh staleness => silent', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache());
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent when everything matches; stdout: ${r.stdout}`);
    assert.strictEqual(r.stdout.trim(), '');
  } finally { h.cleanup(); }
});

test('claimed hooks != actual hooks => one advisory naming both numbers', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ claimedHooks: 49, actualHooks: 53 }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /49/);
    assert.match(ctx, /53/);
    assert.match(ctx, /docs\/KB\.md/);
  } finally { h.cleanup(); }
});

test('claimed skills != actual skills => one advisory naming both numbers', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ claimedSkills: 15, actualSkills: 17 }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /15/);
    assert.match(ctx, /17/);
  } finally { h.cleanup(); }
});

test('same count-drift twice => second session silent (dedupe holds)', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ claimedHooks: 49, actualHooks: 53 }));
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first), 'first run should advise');

    const second = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(second.status, 0);
    assert.ok(!hasContext(second), `repeat advisory must be suppressed; stdout: ${second.stdout}`);
  } finally { h.cleanup(); }
});

test('count-drift re-arms when the actual number changes again', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ claimedHooks: 49, actualHooks: 53 }));
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first));

    writeCache(h, Object.assign(quietCache({ claimedHooks: 49, actualHooks: 54 }), { lastAdvised: readCache(h).lastAdvised }));
    const second = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(second), `changed actual count must re-arm; stdout: ${second.stdout}`);
    assert.match(second.json.hookSpecificOutput.additionalContext, /54/);
  } finally { h.cleanup(); }
});

test('model-KB staleness exceeds threshold => advisory naming the audit date', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ modelKbAuditDate: '2026-01-01', modelKbAgeDays: STALENESS_THRESHOLD_DAYS + 30 }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected staleness advisory; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /2026-01-01/);
  } finally { h.cleanup(); }
});

test('model-KB staleness under threshold => silent', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ modelKbAuditDate: '2026-08-01', modelKbAgeDays: STALENESS_THRESHOLD_DAYS - 5 }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.ok(!hasContext(r), `under-threshold staleness must be silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('same staleness drift twice => second session silent (dedupe)', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({ modelKbAuditDate: '2026-01-01', modelKbAgeDays: STALENESS_THRESHOLD_DAYS + 30 }));
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first));

    const second = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.ok(!hasContext(second), `repeat staleness advisory must be suppressed; stdout: ${second.stdout}`);
  } finally { h.cleanup(); }
});

test('both checks drift simultaneously => one advisory containing both facts', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({
      claimedHooks: 49, actualHooks: 53,
      modelKbAuditDate: '2026-01-01', modelKbAgeDays: STALENESS_THRESHOLD_DAYS + 30,
    }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r));
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /49/);
    assert.match(ctx, /53/);
    assert.match(ctx, /2026-01-01/);
  } finally { h.cleanup(); }
});

test('source missing (no claimed counts, e.g. KB.md unreadable at scan time) => that check silent', () => {
  const h = makeHome();
  try {
    // claimedHooks/claimedSkills absent (unparseable/missing source at scan time).
    writeCache(h, {
      checkedAt: NOW,
      modelKbAuditDate: new Date().toISOString().slice(0, 10),
      modelKbAgeDays: 0,
    });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `missing claim data must not crash or falsely advise; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('malformed cache => treated as stale, re-scanned, never throws', () => {
  const h = makeHome();
  try {
    h.writeState('repo-self-drift.json', 'not valid json{{{');
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('stale cache (>24h) => re-scanned synchronously, uses fresh real counts', () => {
  const h = makeHome();
  try {
    writeCache(h, Object.assign(quietCache(), { checkedAt: NOW - DAY_MS - 1 }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    const cache = readCache(h);
    assert.ok(cache.checkedAt > NOW - DAY_MS, 'cache must have been refreshed');
  } finally { h.cleanup(); }
});

// ── advisory content sanity: only computed values, no file content ──────

test('advisory text contains only computed numbers/dates, no file content', () => {
  const h = makeHome();
  try {
    writeCache(h, quietCache({
      claimedHooks: 49, actualHooks: 53,
      modelKbAuditDate: '2026-01-01', modelKbAgeDays: STALENESS_THRESHOLD_DAYS + 30,
    }));
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(
      ctx,
      /^anti-hall repo self-drift — hooks: KB\.md claims \d+, actual \d+ \(docs\/KB\.md\)\nanti-hall model KBs last audited \d{4}-\d{2}-\d{2} \(\d+d ago, threshold \d+d\) — re-verify model lineup\/pricing$/
    );
  } finally { h.cleanup(); }
});

// ── hooks registration wiring (Probe 2 + Probe 3, SessionStart only) ────

test('hooks.json: claude-cli-version.js and repo-self-drift.js registered on SessionStart, absent from Stop', () => {
  const claudeHooks = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'hooks.json'), 'utf8'
  ));
  const codexHooks = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.json'), 'utf8'
  ));

  for (const [label, hj] of [['claude', claudeHooks], ['codex', codexHooks]]) {
    const sessionStart = JSON.stringify(hj.hooks.SessionStart || []);
    const stop = JSON.stringify(hj.hooks.Stop || []);
    assert.match(sessionStart, /claude-cli-version\.js/, `${label}: claude-cli-version.js must be on SessionStart`);
    assert.match(sessionStart, /repo-self-drift\.js/, `${label}: repo-self-drift.js must be on SessionStart`);
    assert.doesNotMatch(stop, /claude-cli-version\.js/, `${label}: claude-cli-version.js must NOT be on Stop`);
    assert.doesNotMatch(stop, /repo-self-drift\.js/, `${label}: repo-self-drift.js must NOT be on Stop`);
  }
});

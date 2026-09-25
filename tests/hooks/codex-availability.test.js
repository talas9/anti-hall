'use strict';
// codex-availability (SessionStart). Regression guard for a P0 bug: the PATH
// probe used fs.accessSync(candidate, X_OK) with NO isFile() check, so a
// DIRECTORY named "codex" on PATH (which has the execute/search bit set on
// POSIX) falsely satisfied X_OK and reported available:true. The fix requires
// isFile() before treating a candidate as a match (see hooks/codex-availability.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'codex-availability.js';

// Candidate filename the hook probes for on this platform: bare "codex" on
// POSIX (exts === ['']); "codex.exe" on win32 (matches the ".EXE" PATHEXT entry).
const CANDIDATE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

function readState(home) {
  const p = path.join(home, '.anti-hall', 'codex-availability.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('NEGATIVE (the bug): a directory named "codex" on PATH must NOT report available', () => {
  const h = makeHome();
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-codexavail-negdir-'));
  try {
    fs.mkdirSync(path.join(pathDir, CANDIDATE_NAME));

    const r = testHook(HOOK, {}, { home: h.home, env: { PATH: pathDir } });

    assert.strictEqual(r.status, 0, 'hook must always exit 0 (fail-open)');
    assert.strictEqual(r.stdout.trim(), '', 'must NOT emit availability context for a directory match');
    assert.ok(!/hookSpecificOutput/.test(r.stdout), 'must NOT emit hookSpecificOutput for a directory match');

    const state = readState(h.home);
    assert.strictEqual(state.available, false, 'a directory named "codex" must not count as available');
    assert.strictEqual(state.source, 'path-probe');
  } finally {
    h.cleanup();
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

test('POSITIVE: a real executable file named "codex" on PATH reports available:true', () => {
  const h = makeHome();
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-codexavail-posfile-'));
  try {
    const candidate = path.join(pathDir, CANDIDATE_NAME);
    fs.writeFileSync(candidate, '#!/bin/sh\necho codex\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(candidate, 0o755);
    }

    const r = testHook(HOOK, {}, { home: h.home, env: { PATH: pathDir }, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON context on stdout, got: ${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(r.json.hookSpecificOutput.additionalContext, /Codex binary detected on PATH/);

    const state = readState(h.home);
    assert.strictEqual(state.available, true);
    assert.strictEqual(state.source, 'path-probe');
  } finally {
    h.cleanup();
    fs.rmSync(pathDir, { recursive: true, force: true });
  }
});

test('FAIL-OPEN: empty PATH -> available:false, exit 0, no throw', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, {}, { home: h.home, env: { PATH: '' } });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.strictEqual(r.stderr.trim(), '', 'must not throw/print to stderr on empty PATH');

    const state = readState(h.home);
    assert.strictEqual(state.available, false);
  } finally {
    h.cleanup();
  }
});

// 0.111 item 2: a live recorded quota outage (lib/codex-quota.js) must
// surface even when the PATH probe alone found nothing worth reporting, and
// must state the routing fallback + until-time.
test('QUOTA: a live recorded quota outage is surfaced with the routing fallback, even with codex off PATH', () => {
  const h = makeHome();
  try {
    const until = Date.now() + 30 * 60 * 1000;
    require('../../plugins/anti-hall/hooks/lib/codex-quota.js').recordQuota({
      until, reason: 'out of quota until later today', home: h.home,
    });

    const r = testHook(HOOK, {}, { home: h.home, env: { PATH: '' }, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON context on stdout, got: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Codex unavailable until/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /route correctness review to Sonnet/);
  } finally {
    h.cleanup();
  }
});

test('QUOTA: an expired quota record is treated as available again — no prefix, PATH probe controls emission', () => {
  const h = makeHome();
  try {
    // recordQuota() self-heals an already-past `until` (never records an
    // instantly-expired outage) — write the record directly to simulate real
    // time having passed since it was legitimately recorded in the future.
    const quota = require('../../plugins/anti-hall/hooks/lib/codex-quota.js');
    fs.mkdirSync(path.dirname(quota.statePath(h.home)), { recursive: true });
    fs.writeFileSync(quota.statePath(h.home), JSON.stringify({
      quota: { available: false, until: Date.now() - 1000, reason: 'stale', recordedAt: Date.now() - 5000 },
    }));

    const r = testHook(HOOK, {}, { home: h.home, env: { PATH: '' } });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'expired quota record must not force emission');
  } finally {
    h.cleanup();
  }
});

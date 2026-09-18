'use strict';
// doctor-repair.js's codex-graphify-cleanup AUTO-SAFE step (2026-09-18) —
// unit tests. This is a SEPARATE code path from the "codex hook refresh"
// step above it: that step only re-runs the installer when an EXPECTED
// EVENT is entirely unwired, so an event that already carries a
// non-graphify anti-hall group (SessionStart also has verify-first-full.js)
// reports `wired: true` and the installer never re-runs — leaving a stale
// graphify-session.js/graphify-guard.js/graphify-reminder.js group in place.
// The cleanup step runs independently of `wired` and must catch exactly
// that case.
//
// Isolated HOME/cwd (repo rule: tests never touch the real home). Runs the
// REAL runRepairs() — home/cwd point at tmp dirs so a config.toml IS present
// (scanCodex requires it) but nothing touches the real machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repair-graphify-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// Every event ANTI_HALL_HOOKS expects gets at least one NON-graphify
// anti-hall group so scanCodex's `wired` check reports true for this scope —
// proving the cleanup step fires independently of that coarse per-event
// check, not because the installer re-ran anyway.
const STALE_CONFIG = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/verify-first-full.js', timeout: 10 }] },
      { hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/graphify-session.js', timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/verify-first.js', timeout: 10 }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/task-guard.js', timeout: 30 }] },
      { hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/graphify-reminder.js', timeout: 30 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/git-guard.js', timeout: 10 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/graphify-guard.js', timeout: 10 }] },
    ],
    PostToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/devswarm-parent-reply-tracker.js', timeout: 10 }] },
    ],
  },
};

function setupCodexScope(dir) {
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), '[features]\nhooks = true\n');
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify(STALE_CONFIG, null, 2));
}

test('doctor-repair codex-graphify-cleanup: cleans a stale global config even though the scope is already "wired"', () => {
  const home = mkTmp('home');
  const cwd = mkTmp('cwd');
  try {
    setupCodexScope(home); // global scope
    const results = repair.runRepairs({ cwd, home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, dryRun: false, platform: process.platform });

    // The "codex hook refresh" step must see this scope as already wired
    // (SessionStart/Stop/PreToolUse each have a non-graphify anti-hall group).
    const wiredEntry = results.find((r) => r.id === 'codex-global' && r.action === 'install-codex');
    assert.ok(wiredEntry, 'expected a codex-global/install-codex result');
    assert.strictEqual(wiredEntry.status, 'skipped', 'scope with existing non-graphify hooks reports already-wired');

    // The dedicated cleanup step must still have fixed it.
    const cleanupEntry = results.find((r) => r.id === 'codex-graphify-cleanup-global');
    assert.ok(cleanupEntry, 'expected a codex-graphify-cleanup-global result');
    assert.strictEqual(cleanupEntry.status, 'fixed');
    assert.match(cleanupEntry.msg, /removed 3 stale graphify group/);

    const after = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.strictEqual(after.hooks.SessionStart.length, 1);
    assert.strictEqual(after.hooks.Stop.length, 1);
    assert.strictEqual(after.hooks.PreToolUse.length, 1);
    assert.ok(!JSON.stringify(after).includes('graphify'));
  } finally {
    rm(home);
    rm(cwd);
  }
});

test('doctor-repair codex-graphify-cleanup: a second run is a clean no-op (idempotent)', () => {
  const home = mkTmp('home2');
  const cwd = mkTmp('cwd2');
  try {
    setupCodexScope(home);
    repair.runRepairs({ cwd, home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, dryRun: false, platform: process.platform });
    const afterFirst = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');

    const results2 = repair.runRepairs({ cwd, home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, dryRun: false, platform: process.platform });
    const cleanupEntry2 = results2.find((r) => r.id === 'codex-graphify-cleanup-global');
    assert.ok(cleanupEntry2);
    assert.strictEqual(cleanupEntry2.status, 'skipped');
    assert.match(cleanupEntry2.msg, /no stale graphify group/);

    const afterSecond = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(afterSecond, afterFirst, 'second run must not rewrite the file');
  } finally {
    rm(home);
    rm(cwd);
  }
});

test('doctor-repair codex-graphify-cleanup: dry-run never writes', () => {
  const home = mkTmp('home3');
  const cwd = mkTmp('cwd3');
  try {
    setupCodexScope(home);
    const before = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
    const results = repair.runRepairs({ cwd, home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, dryRun: true, platform: process.platform });
    const cleanupEntry = results.find((r) => r.id === 'codex-graphify-cleanup-global');
    assert.ok(cleanupEntry);
    assert.strictEqual(cleanupEntry.status, 'skipped');
    assert.match(cleanupEntry.msg, /\[dry-run\]/);
    const after = fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(after, before, 'dry-run must not modify the file');
  } finally {
    rm(home);
    rm(cwd);
  }
});

test('doctor-repair codex-graphify-cleanup: no Codex install at all is a clean skip, no crash', () => {
  const home = mkTmp('home4');
  const cwd = mkTmp('cwd4');
  try {
    const results = repair.runRepairs({ cwd, home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, dryRun: false, platform: process.platform });
    const cleanupEntries = results.filter((r) => r.id.startsWith('codex-graphify-cleanup'));
    assert.ok(cleanupEntries.length > 0, 'cleanup step should still report (nothing to clean)');
    for (const e of cleanupEntries) assert.notStrictEqual(e.status, 'failed');
  } finally {
    rm(home);
    rm(cwd);
  }
});

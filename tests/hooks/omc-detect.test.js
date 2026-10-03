'use strict';
// omc-detect — unit tests for isOmcLoopActive({ cwd, sessionId })
//
// All tests use a fake HOME (via makeHome) so they never touch real machine
// state. The omc-detect module is loaded fresh per test via delete require.cache
// because it reads process.env on each call (not on load), but the settings
// path uses os.homedir() which is process-level. We redirect HOME in the child
// env for spawn-based tests; for direct-require tests we write fixtures under a
// temp dir and pass cwd/settingsPath via the controlled file tree.
//
// Strategy: omc-detect reads os.homedir() for settings.json and the global
// ~/.omc/state/ fallback. We redirect HOME to the fake home so those reads land
// in the fixture tree. We then write the relevant fixture files there.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeTmpDir() — isolated temp dir (analogous to makeHome but lighter).
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-detect-test-'));
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { dir, cleanup };
}

// writeSettings(dir, obj) — write <dir>/.claude/settings.json
function writeSettings(dir, obj) {
  const settingsDir = path.join(dir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(obj), 'utf8');
}

// writeStateFile(root, filename, obj) — write <root>/<filename>
function writeStateFile(root, filename, obj) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, filename), JSON.stringify(obj), 'utf8');
}

// freshIso() — an ISO-8601 timestamp within the 2h freshness window (real OMC format).
// OMC 4.14.6 writes new Date().toISOString() for all last_checked_at / updated_at writes.
function freshIso() {
  return new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
}

// staleIso() — an ISO-8601 timestamp outside the 2h freshness window.
function staleIso() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 h ago
}

// freshTs() — legacy numeric ms-since-epoch, kept for backward-compat tolerance test.
function freshTs() {
  return Date.now() - 30 * 60 * 1000; // 30 min ago (numeric)
}

// staleTs() — legacy numeric, stale.
function staleTs() {
  return Date.now() - 3 * 60 * 60 * 1000; // 3 h ago (numeric)
}

// callDetect(home, opts, envOverrides) — set HOME + extra env vars, clear the
// module cache, call isOmcLoopActive(opts), then restore everything.
// HOME must remain set for the DURATION of the call because os.homedir() is
// evaluated at call time (not at require time) inside the module.
function callDetect(home, opts, envOverrides) {
  const detectorPath = require.resolve(
    '../../plugins/anti-hall/hooks/omc-detect.js'
  );
  delete require.cache[detectorPath];

  // Keys we will mutate — save originals first, then apply.
  const keysToMutate = ['HOME'];
  if (process.platform === 'win32') keysToMutate.push('USERPROFILE');
  for (const k of Object.keys(envOverrides || {})) {
    if (!keysToMutate.includes(k)) keysToMutate.push(k);
  }

  const saved = {};
  for (const k of keysToMutate) {
    saved[k] = process.env[k]; // undefined if unset
  }

  // Apply: HOME + Windows alias + caller overrides.
  process.env.HOME = home;
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  for (const [k, v] of Object.entries(envOverrides || {})) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    const { isOmcLoopActive } = require(detectorPath);
    return isOmcLoopActive(opts);
  } finally {
    for (const k of keysToMutate) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// Ensure kill-switch env vars are clean for a test unless explicitly overridden.
function cleanEnv() {
  return { DISABLE_OMC: undefined, OMC_SKIP_HOOKS: undefined };
}

// ---------------------------------------------------------------------------
// Tests: kill-switch (Gate 1)
// ---------------------------------------------------------------------------

test('omc-detect: DISABLE_OMC=1 → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, { DISABLE_OMC: '1', OMC_SKIP_HOOKS: undefined });
    assert.strictEqual(result, false, 'DISABLE_OMC=1 must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: OMC_SKIP_HOOKS includes persistent-mode → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'autopilot-state.json', {
      active: true, updated_at: freshIso(),
    });
    const result = callDetect(
      dir,
      { cwd: dir },
      { DISABLE_OMC: undefined, OMC_SKIP_HOOKS: 'persistent-mode,other' }
    );
    assert.strictEqual(result, false, 'OMC_SKIP_HOOKS with persistent-mode must return false');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: enabledPlugins missing (Gate 2)
// ---------------------------------------------------------------------------

test('omc-detect: enabledPlugins missing → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // settings.json exists but no enabledPlugins key
    writeSettings(dir, { someOtherKey: true });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'missing enabledPlugins must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: settings.json missing → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // No settings.json written at all — also no project-scope settings (cwd is dir)
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'missing settings.json must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: enabledPlugins[oh-my-claudecode@omc] === false → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': false } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ultrawork-state.json', {
      active: true, started_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'enabledPlugins===false must return false');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: active + fresh → true
// ---------------------------------------------------------------------------

test('omc-detect: ralph active + fresh ISO last_checked_at → true', () => {
  // Uses real OMC 4.14.6 format: new Date().toISOString() for last_checked_at.
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'active+fresh ISO ralph must return true');
  } finally {
    cleanup();
  }
});

test('omc-detect: ralph active + fresh ISO — real ralph-state shape from OMC 4.14.6', () => {
  // Verbatim key set written by persistent-mode.mjs ralph branch:
  // active, iteration, max_iterations, last_checked_at (ISO), prompt, session_id.
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true,
      iteration: 3,
      max_iterations: 100,
      last_checked_at: freshIso(),
      prompt: 'Fix the thing',
      session_id: 'ses-real',
    });
    const result = callDetect(dir, { cwd: dir, sessionId: 'ses-real' }, cleanEnv());
    assert.strictEqual(result, true, 'real ralph-state shape must return true');
  } finally {
    cleanup();
  }
});

test('omc-detect: session-PINNED state + caller WITHOUT sessionId → false (R1-6)', () => {
  // A loop pinned to some session must not suppress a guard that cannot prove
  // it is that session — pinned + missing caller sid = no deference.
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    writeStateFile(path.join(dir, '.omc', 'state'), 'ralph-state.json', {
      active: true, last_checked_at: freshIso(), session_id: 'ses-other',
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'pinned state + no caller sid must NOT defer');
  } finally {
    cleanup();
  }
});

test('omc-detect: session-PINNED state + DIFFERENT caller sessionId → false (R1-6)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    writeStateFile(path.join(dir, '.omc', 'state'), 'ralph-state.json', {
      active: true, last_checked_at: freshIso(), session_id: 'ses-a',
    });
    const result = callDetect(dir, { cwd: dir, sessionId: 'ses-b' }, cleanEnv());
    assert.strictEqual(result, false, 'pinned state + different sid must NOT defer');
  } finally {
    cleanup();
  }
});

test('omc-detect: ultrawork active + fresh ISO updated_at → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ultrawork-state.json', {
      active: true, updated_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'active+fresh ISO ultrawork must return true');
  } finally {
    cleanup();
  }
});

test('omc-detect: autopilot active + fresh ISO started_at → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'autopilot-state.json', {
      active: true, started_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'active+fresh ISO autopilot must return true');
  } finally {
    cleanup();
  }
});

test('omc-detect: numeric timestamp (legacy tolerance) → true', () => {
  // Keeps one numeric-format test to ensure backward compat with pre-4.14.6 state files.
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshTs(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'numeric timestamp must still be accepted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: stale (> 2h) → false
// ---------------------------------------------------------------------------

test('omc-detect: active but stale ISO >2h → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true,
      last_checked_at: staleIso(),
      updated_at: staleIso(),
      started_at: staleIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'stale ISO state must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: active=true but all timestamps missing → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ultrawork-state.json', { active: true });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'no timestamps must return false (treated as stale)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: session mismatch → false
// ---------------------------------------------------------------------------

test('omc-detect: session_id present and matches → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(), session_id: 'ses-abc',
    });
    const result = callDetect(dir, { cwd: dir, sessionId: 'ses-abc' }, cleanEnv());
    assert.strictEqual(result, true, 'matching session_id must return true');
  } finally {
    cleanup();
  }
});

test('omc-detect: session_id present but mismatches → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: true, last_checked_at: freshIso(), session_id: 'ses-abc',
    });
    const result = callDetect(dir, { cwd: dir, sessionId: 'ses-xyz' }, cleanEnv());
    assert.strictEqual(result, false, 'mismatched session_id must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: session_id absent in state → any sessionId matches → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'team-state.json', {
      active: true, updated_at: freshIso(),
      // no session_id field
    });
    const result = callDetect(dir, { cwd: dir, sessionId: 'any-session' }, cleanEnv());
    assert.strictEqual(result, true, 'absent session_id must match any passed sessionId');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: malformed / missing state file → false
// ---------------------------------------------------------------------------

test('omc-detect: malformed JSON in state file → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'ralph-state.json'), '{bad json', 'utf8');
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'malformed JSON must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: state file missing entirely → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    // No .omc/state dir written at all
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'no state files must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: active=false → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', {
      active: false, last_checked_at: freshIso(),
    });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'active=false must return false');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: fallback to ~/.omc/state/ when cwd has no .omc/state
// ---------------------------------------------------------------------------

test('omc-detect: falls back to ~/.omc/state/ when cwd lacks .omc/state', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    // Write state in ~/.omc/state (dir = fake HOME)
    const globalStateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(globalStateRoot, 'ultrawork-state.json', {
      active: true, last_checked_at: freshIso(),
    });
    // cwd is a separate dir with no .omc/state
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-cwd-'));
    try {
      const result = callDetect(dir, { cwd }, cleanEnv());
      assert.strictEqual(result, true, 'global fallback state must return true');
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: Gate 2 project-scope enablement (R1-5)
// ---------------------------------------------------------------------------

// writeProjectSettings(cwd, filename, obj) — write <cwd>/.claude/<filename>
function writeProjectSettings(cwd, filename, obj) {
  const d = path.join(cwd, '.claude');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, filename), JSON.stringify(obj), 'utf8');
}

test('omc-detect: OMC enabled only in <cwd>/.claude/settings.json → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Global ~/.claude/settings.json has NO enabledPlugins (global is disabled)
    writeSettings(dir, { someOtherKey: true });
    // Project .claude/settings.json enables OMC
    writeProjectSettings(dir, 'settings.json', { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', { active: true, last_checked_at: freshIso() });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'project-scope settings.json must enable OMC');
  } finally {
    cleanup();
  }
});

test('omc-detect: OMC enabled only in <cwd>/.claude/settings.local.json → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { someOtherKey: true });
    writeProjectSettings(dir, 'settings.local.json', { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ultrawork-state.json', { active: true, updated_at: freshIso() });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'project-scope settings.local.json must enable OMC');
  } finally {
    cleanup();
  }
});

test('omc-detect: OMC disabled in all three settings files → false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': false } });
    writeProjectSettings(dir, 'settings.json', { enabledPlugins: { 'oh-my-claudecode@omc': false } });
    writeProjectSettings(dir, 'settings.local.json', { enabledPlugins: { 'oh-my-claudecode@omc': false } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'ralph-state.json', { active: true, last_checked_at: freshIso() });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, false, 'all three files disabled must return false');
  } finally {
    cleanup();
  }
});

test('omc-detect: OMC enabled only in global settings, no cwd → true', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Global enabled, no project .claude/ dir
    writeSettings(dir, { enabledPlugins: { 'oh-my-claudecode@omc': true } });
    const stateRoot = path.join(dir, '.omc', 'state');
    writeStateFile(stateRoot, 'autopilot-state.json', { active: true, started_at: freshIso() });
    const result = callDetect(dir, { cwd: dir }, cleanEnv());
    assert.strictEqual(result, true, 'global settings enabling OMC must return true');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests: deference integration — task-guard suppresses block when OMC active
// ---------------------------------------------------------------------------
// Uses spawn-hook harness to run the real task-guard.js hook as a subprocess
// with HOME set to a fixture that has a would-block transcript AND a fresh
// ralph-state.json.  Expects: exit 0, no {decision:'block'} on stdout,
// advisory text present.

test('task-guard deference: would-block scenario + active OMC → advisory, no block', () => {
  const { makeHome } = require('../helpers/fixtures.js');
  const { testHook } = require('../helpers/spawn-hook.js');

  const h = makeHome();
  try {
    // Write .claude/settings.json enabling OMC under fake HOME.
    const claudeDir = path.join(h.home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'oh-my-claudecode@omc': true } }),
      'utf8'
    );

    // Write a fresh ralph-state.json under <home>/.omc/state/
    // (cwd in payload = h.home, but .omc/state not present there → falls back to
    //  ~/.omc/state/ = h.home/.omc/state/)
    const omcStateDir = path.join(h.home, '.omc', 'state');
    fs.mkdirSync(omcStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(omcStateDir, 'ralph-state.json'),
      JSON.stringify({ active: true, last_checked_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
      'utf8'
    );

    // Transcript with open (pending) tasks — would normally trigger a block.
    const tp = h.writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw',
            input: { todos: [{ id: '1', content: 'pending work', status: 'pending' }] },
          }],
        },
      },
    ]);

    const payload = {
      hook_event_name: 'Stop',
      transcript_path: tp,
      session_id: 't',
      cwd: h.home,
    };

    const r = testHook('task-guard.js', payload, { home: h.home });

    assert.strictEqual(r.status, 0, 'exit code must be 0');
    // stdout must NOT contain a block decision
    assert.ok(
      !(r.json && r.json.decision === 'block'),
      `must not emit a block decision; stdout: ${r.stdout}`
    );
    // Advisory text must be present (plain text line, not JSON block)
    assert.ok(
      /OMC|omc|deferring/i.test(r.stdout),
      `expected advisory text in stdout; got: ${r.stdout}`
    );
  } finally {
    h.cleanup();
  }
});

'use strict';
// phase-tracker.js — PreToolUse(Agent/Task) auto activity tracker. It appends a
// per-session-tagged spawn line "<ms> <tag>" to ~/.anti-hall/agent-spawns.log so
// the statusline can show ONLY the rendering session's swarm activity (no cross-
// session/cross-project bleed). It NEVER blocks a spawn (always exit 0) and prunes
// lines older than 5 min. Each test runs under a fresh fake HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-pt-'));
  return {
    home,
    log: path.join(home, '.anti-hall', 'agent-spawns.log'),
    readLog() { return fs.readFileSync(this.log, 'utf8'); },
    writeLog(text) {
      fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
      fs.writeFileSync(this.log, text, 'utf8');
    },
    cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} },
  };
}

const spawnPayload = (extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, ...extra,
});

test('phase-tracker tags a spawn line with the session_id and never blocks', () => {
  const h = makeHome();
  try {
    const r = testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    assert.strictEqual(r.status, 0, 'always exit 0 (never blocks a spawn)');
    const lines = h.readLog().trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^\d+ sessA$/, 'line is "<ms> sessA"');
  } finally { h.cleanup(); }
});

test('phase-tracker falls back to a cwd-hash tag when session_id is absent', () => {
  const h = makeHome();
  try {
    const cwd = '/work/proj-x';
    testHook('phase-tracker.js', spawnPayload({ cwd }), { home: h.home });
    const expected = 'cwd-' + crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
    assert.match(h.readLog().trim(), new RegExp(`^\\d+ ${expected}$`));
  } finally { h.cleanup(); }
});

test('phase-tracker tags "unknown" when neither session_id nor cwd is present', () => {
  const h = makeHome();
  try {
    testHook('phase-tracker.js', spawnPayload(), { home: h.home });
    assert.match(h.readLog().trim(), /^\d+ unknown$/);
  } finally { h.cleanup(); }
});

test('phase-tracker preserves other sessions\' recent lines (per-session isolation)', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    h.writeLog(`${now - 1000} sessB\n`);
    testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    const lines = h.readLog().trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 2, 'sessB line kept, sessA line appended');
    assert.match(lines[0], /sessB$/);
    assert.match(lines[1], /sessA$/);
  } finally { h.cleanup(); }
});

test('phase-tracker prunes lines older than the 5-min retention window', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    const old = now - 6 * 60 * 1000; // 6 min ago > 5 min KEEP_MS
    h.writeLog(`${old} sessOld\n${now - 1000} sessFresh\n`);
    testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    const text = h.readLog();
    assert.ok(!text.includes('sessOld'), 'stale line pruned');
    assert.ok(text.includes('sessFresh'), 'fresh line retained');
    assert.ok(text.includes('sessA'), 'new line appended');
  } finally { h.cleanup(); }
});

test('phase-tracker prunes legacy bare-timestamp lines too (by leading int)', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    h.writeLog(`${now - 6 * 60 * 1000}\n${now - 1000}\n`);
    testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    const lines = h.readLog().trim().split(/\r?\n/);
    // old legacy line pruned; fresh legacy line kept; new tagged line added.
    assert.strictEqual(lines.length, 2);
    assert.match(lines[1], /sessA$/);
  } finally { h.cleanup(); }
});

test('phase-tracker fail-open on malformed stdin (still exit 0, tags unknown)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw('phase-tracker.js', '{not json', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.match(h.readLog().trim(), /^\d+ unknown$/);
  } finally { h.cleanup(); }
});

test('phase-tracker fail-open on a corrupt existing log (does not throw)', () => {
  const h = makeHome();
  try {
    h.writeLog('\x00\x01garbage\nlines\n');
    const r = testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(h.readLog().includes('sessA'));
  } finally { h.cleanup(); }
});

// ---- Heartbeat (FIX 1) ----

test('phase-tracker writes recent-spawn.json with numeric ts (agentsRunning heartbeat)', () => {
  const h = makeHome();
  try {
    const before = Date.now();
    testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    const after = Date.now();
    const heartbeatPath = path.join(h.home, '.anti-hall', 'agents', 'recent-spawn.json');
    assert.ok(fs.existsSync(heartbeatPath), 'recent-spawn.json must be created');
    const data = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
    assert.ok(typeof data.ts === 'number', 'ts must be a number');
    assert.ok(data.ts >= before && data.ts <= after, 'ts must be within the spawn window');
    // agent-spawns.log must still be written (the statusline depends on it)
    assert.ok(h.readLog().includes('sessA'), 'agent-spawns.log must still be written alongside heartbeat');
  } finally { h.cleanup(); }
});

test('phase-tracker heartbeat makes agentsRunning() return true (integration)', () => {
  // Replicate the agentsRunning() check (task-guard/tasklist-guard) against the
  // fake HOME so we confirm the heartbeat satisfies the exact contract those
  // functions use: a *.json file under ~/.anti-hall/agents/ with a numeric ts
  // within the 20-min fresh window.
  const h = makeHome();
  try {
    testHook('phase-tracker.js', spawnPayload({ session_id: 'sessB' }), { home: h.home });
    const agentsDir = path.join(h.home, '.anti-hall', 'agents');
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length >= 1, 'at least one .json heartbeat file written');
    const FRESH = 20 * 60 * 1000;
    let anyFresh = false;
    for (const f of files) {
      const full = path.join(agentsDir, f);
      let ts = 0;
      try { const d = JSON.parse(fs.readFileSync(full, 'utf8')); if (d && typeof d.ts === 'number') ts = d.ts; } catch (_) {}
      if (!ts) { try { ts = fs.statSync(full).mtimeMs; } catch (_) { ts = 0; } }
      if (ts && (Date.now() - ts) < FRESH) { anyFresh = true; break; }
    }
    assert.ok(anyFresh, 'agentsRunning() must return true — heartbeat is fresh');
  } finally { h.cleanup(); }
});

test('phase-tracker fail-open when agents dir cannot be created (heartbeat error never blocks spawn)', () => {
  // Make ~/.anti-hall/agents a regular FILE so mkdirSync throws; the hook must
  // still exit 0 and still write agent-spawns.log.
  const h = makeHome();
  try {
    const antiHall = path.join(h.home, '.anti-hall');
    fs.mkdirSync(antiHall, { recursive: true });
    // Occupy the agents path with a file — mkdirSync will throw when it tries to
    // create the directory (EEXIST / ENOTDIR depending on OS).
    fs.writeFileSync(path.join(antiHall, 'agents'), 'not-a-dir', 'utf8');
    const r = testHook('phase-tracker.js', spawnPayload({ session_id: 'sessA' }), { home: h.home });
    assert.strictEqual(r.status, 0, 'must always exit 0 even when heartbeat write fails');
    assert.ok(h.readLog().includes('sessA'), 'agent-spawns.log must still be written despite heartbeat error');
  } finally { h.cleanup(); }
});

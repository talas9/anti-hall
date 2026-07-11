'use strict';
// ============================================================================
// DevSwarm substrate — FULL end-to-end suite.
//
// Unlike the per-module unit tests, this suite drives the REAL entry points end
// to end inside an isolated temp HOME: it spawns the hooks as child processes and
// runs the CLI as `node scripts/devswarm.js ... `, wiring the pieces together
// (CLI writes registry/store/summary -> a spawned hook reads it -> CLI advances a
// cursor -> the gate clears) and asserting REAL outcomes, not internal state.
//
// Every test uses a fresh tmp HOME and rm()'s it in a finally, so no state ever
// lands outside the fixture. OS-gated primitives (symlink to /dev/zero, FIFO) are
// skipped cleanly WITH a logged reason on platforms where they are unavailable.
//
// Coverage map (task items 1..9):
//   1  guard: raw monitor/read-messages blocked, message-count + quoted/unquoted
//      data allowed, symlink descriptor does not hang (fail-open).
//   2  parent-inbox hook injects the real unread count; empty when zero.
//   3  parent-gate blocks on unread, CLEARS after CLI inbox ack, cap resets on a
//      changed unread set.
//   4  child-turn/child-gate write + require a heartbeat; freshness drives
//      active-vs-archived classification (both directions).
//   5  store round-trip on BOTH backends (journal always; sqlite where available).
//   6  ingest idempotence (replay -> no dupes) + single-consumer lock refusal.
//   7  auto-migration: legacy registry + NDJSON inbox imported, count-verified,
//      source intact, re-run is a no-op.
//   8  CLI JSON shapes + exit codes for register/heartbeat/inbox/workspaces/nudge/
//      archive.
//   9  archive-ready: gates -> archive_ready -> parent-inbox surfaces the "inform
//      the user to archive" nudge, cooldown'd + persistent across turns, ignore
//      mark suppresses one while a second still-ready workspace keeps being
//      reminded; anti-hall NEVER archives/deletes or removes a descriptor.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const H = require('./helpers.js');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const { readDescriptors } = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
const { DEFAULT_IDLE_MS } = require('../../plugins/anti-hall/companion/lib/liveness.js');

// Env presets. isDevswarmActive => DEVSWARM_REPO_ID set; child => SOURCE_BRANCH set.
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const COORD_ENV = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-1' };
const childEnv = (branch) => ({ DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: branch });

function ctxOf(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

// ============================================================================
// 1. GUARD — command-guard.js DevSwarm destructive-read redirect, end to end.
// ============================================================================

test('1 GUARD: coordinator+DevSwarm blocks raw `monitor` (unconditional) with durable evidence on disk', () => {
  const home = H.makeHome();
  try {
    const r = testHook('command-guard.js', bashPayload('hivecontrol workspace monitor'),
      { home, env: COORD_ENV });
    assert.strictEqual(r.status, 2, `monitor must block; stdout=${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
    assert.match(r.json.reason, /COORDINATOR-READ REDIRECT/);
  } finally { H.rm(home); }
});

test('1 GUARD: `read-messages` blocks ONLY with durable-layer evidence (a registered descriptor)', () => {
  const home = H.makeHome();
  try {
    // No evidence yet -> a lone read-messages is a harmless single read -> ALLOW.
    const before = testHook('command-guard.js', bashPayload('hivecontrol workspace read-messages'),
      { home, env: COORD_ENV });
    assert.strictEqual(before.status, 0, `no evidence -> allow; stdout=${before.stdout}`);

    // Register a workspace via the REAL CLI -> descriptor now carries an inboxPath,
    // which is the durable-layer evidence that arms the read block.
    const reg = H.runCli(home, ['register', 'ws1', '--worktree', '/wt/ws1', '--session', 's1',
      '--inbox', path.join(home, 'inbox.ndjson'), '--cursor', path.join(home, 'cursor.json')]);
    assert.strictEqual(reg.status, 0);
    assert.ok(reg.json && reg.json.ok, 'register must succeed');

    const after = testHook('command-guard.js', bashPayload('hivecontrol workspace read-messages'),
      { home, env: COORD_ENV });
    assert.strictEqual(after.status, 2, `evidence present -> block; stdout=${after.stdout}`);
    assert.ok(after.json && after.json.decision === 'block');
  } finally { H.rm(home); }
});

test('1 GUARD: non-destructive `message-count` is allowed', () => {
  const home = H.makeHome();
  try {
    const r = testHook('command-guard.js', bashPayload('hivecontrol workspace message-count'),
      { home, env: COORD_ENV });
    assert.strictEqual(r.status, 0, `message-count must allow; stdout=${r.stdout}`);
    assert.strictEqual(r.stdout, '');
  } finally { H.rm(home); }
});

test('1 GUARD: quoted AND unquoted data mentioning the subcommands is allowed (no false block)', () => {
  const home = H.makeHome();
  try {
    // Quoted DATA arg to grep — the verb is grep, not hivecontrol.
    const quoted = testHook('command-guard.js',
      bashPayload("grep -n 'hivecontrol workspace read-messages' docs/KB.md"),
      { home, env: COORD_ENV });
    assert.strictEqual(quoted.status, 0, `quoted data must allow; stdout=${quoted.stdout}`);
    // Unquoted data as args to echo — verb echo, hivecontrol is not command-position.
    const unquoted = testHook('command-guard.js',
      bashPayload('echo hivecontrol workspace monitor is destructive'),
      { home, env: COORD_ENV });
    assert.strictEqual(unquoted.status, 0, `unquoted data must allow; stdout=${unquoted.stdout}`);
  } finally { H.rm(home); }
});

test('1 GUARD: a symlink descriptor (→/dev/zero) does NOT hang — fails open to allow', (t) => {
  if (process.platform === 'win32') { t.skip('symlink-to-/dev/zero is POSIX-only'); return; }
  if (!fs.existsSync('/dev/zero')) { t.skip('/dev/zero not present on this host'); return; }
  const home = H.makeHome();
  try {
    // The ONLY "descriptor" is a symlink to an infinite device. A blind read would
    // hang forever; hasDurableInboxEvidence must lstat-skip it (never follow), so
    // there is NO evidence -> read-messages is ALLOWED and the hook returns fast.
    fs.mkdirSync(H.workspacesDir(home), { recursive: true });
    try {
      fs.symlinkSync('/dev/zero', H.descriptorPath(home, 'zero'));
    } catch (e) { t.skip('symlink unsupported here: ' + e.message); return; }

    const started = Date.now();
    const r = testHook('command-guard.js', bashPayload('hivecontrol workspace read-messages'),
      { home, env: COORD_ENV });
    // A hang would make spawnSync hit its 10s timeout (status null). Assert it
    // completed with a real exit code, promptly, and allowed (fail-open).
    assert.notStrictEqual(r.status, null, 'hook must not hang (spawn timeout)');
    assert.strictEqual(r.status, 0, `symlink descriptor -> fail-open allow; stdout=${r.stdout}`);
    assert.ok(Date.now() - started < 8000, 'must return well under the spawn timeout');
  } finally { H.rm(home); }
});

// ============================================================================
// 2. PARENT-INBOX HOOK — injects the real unread count; empty when zero.
// ============================================================================

test('2 PARENT-INBOX: injects the exact unread count for a dummy inbox with N unread', () => {
  const home = H.makeHome();
  try {
    // Register via CLI (inits cursor=0), then append 3 durable messages to the inbox.
    const inbox = path.join(H.swarmRoot(home), 'inbox', 'wsA.ndjson');
    const cursor = path.join(H.swarmRoot(home), 'cursor', 'wsA.json');
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    const reg = H.runCli(home, ['register', 'wsA', '--worktree', '/wt/wsA', '--session', 'sA',
      '--inbox', inbox, '--cursor', cursor]);
    assert.ok(reg.json && reg.json.ok, 'register ok');
    fs.writeFileSync(inbox, ['{"m":1}', '{"m":2}', '{"m":3}'].join('\n') + '\n');

    const r = testHook('devswarm-parent-inbox.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' },
      { home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctxOf(r);
    assert.match(c, /DEVSWARM PARENT INBOX/);
    assert.match(c, /wsA/);
    assert.match(c, /3 unread/);
  } finally { H.rm(home); }
});

test('2 PARENT-INBOX: empty (no stdout) when the inbox is fully consumed', () => {
  const home = H.makeHome();
  try {
    H.seedWorkspace(home, 'wsA', { inbox: ['{"m":1}', '{"m":2}'], cursor: 2 }); // cursor==total
    const r = testHook('devswarm-parent-inbox.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' },
      { home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected no stdout; got ${r.stdout}`);
  } finally { H.rm(home); }
});

// ============================================================================
// 3. PARENT-GATE — blocks on unread, clears after CLI inbox ack (P1-A clear path),
//    cap resets when the unread set changes.
// ============================================================================

test('3 PARENT-GATE: blocks on unread, then CLEARS after `devswarm inbox ack` advances the cursor', () => {
  const home = H.makeHome();
  try {
    const inbox = path.join(H.swarmRoot(home), 'inbox', 'ws1.ndjson');
    const cursor = path.join(H.swarmRoot(home), 'cursor', 'ws1.json');
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    H.runCli(home, ['register', 'ws1', '--worktree', '/wt/ws1', '--session', 'c1',
      '--inbox', inbox, '--cursor', cursor]);
    fs.writeFileSync(inbox, ['a', 'b', 'c'].join('\n') + '\n'); // 3 unread past cursor 0

    const stop = { hook_event_name: 'Stop', session_id: 'gate-sess' };
    const blocked = testHookRaw('devswarm-parent-gate.js', JSON.stringify(stop),
      { home, env: PRIMARY_ENV });
    assert.strictEqual(blocked.status, 0, 'stop hook always exit 0');
    assert.ok(blocked.json && blocked.json.decision === 'block', `expected block; stdout=${blocked.stdout}`);
    assert.match(blocked.json.reason, /ws1/);
    assert.match(blocked.json.reason, /3 unread/);

    // CLEAR PATH: the real CLI ack-all primitive advances the cursor.
    const ack = H.runCli(home, ['inbox', 'ack', 'ws1']);
    assert.ok(ack.json && ack.json.ok, 'ack ok');
    assert.strictEqual(ack.json.cursor, 3, 'cursor advanced to consume all messages');

    const cleared = testHookRaw('devswarm-parent-gate.js', JSON.stringify(stop),
      { home, env: PRIMARY_ENV });
    assert.strictEqual(cleared.status, 0);
    assert.strictEqual(cleared.stdout, '', `gate must clear after ack; got ${cleared.stdout}`);
  } finally { H.rm(home); }
});

test('3 PARENT-GATE: per-SET cap goes quiet, then a CHANGED unread set re-opens the budget', () => {
  const home = H.makeHome();
  try {
    const { inboxPath } = H.seedWorkspace(home, 'ws1', { inbox: ['a', 'b'], cursor: 0 }); // 2 unread
    const env = { ...PRIMARY_ENV, ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: 'capsess' });

    const b1 = testHookRaw('devswarm-parent-gate.js', stop, { home, env });
    assert.ok(b1.json && b1.json.decision === 'block', 'block #1');
    const b2 = testHookRaw('devswarm-parent-gate.js', stop, { home, env });
    assert.ok(b2.json && b2.json.decision === 'block', 'block #2');
    const b3 = testHookRaw('devswarm-parent-gate.js', stop, { home, env });
    assert.strictEqual(b3.stdout, '', 'capped: same set goes quiet after CAP forced-acks');

    // A new message changes the unread SET signature -> cap resets -> re-block.
    fs.appendFileSync(inboxPath, 'c\n');
    const after = testHookRaw('devswarm-parent-gate.js', stop, { home, env });
    assert.ok(after.json && after.json.decision === 'block', 'changed set must re-block');
    assert.match(after.json.reason, /3 unread/);
  } finally { H.rm(home); }
});

// ============================================================================
// 4. CHILD-TURN / CHILD-GATE — write + require a heartbeat; freshness drives
//    active-vs-archived classification (both directions).
// ============================================================================

// classify(home, id, now) — the design's active/archived rule, assembled from the
// REAL primitives: a fresh turn-authored heartbeat AND a present descriptor => the
// workspace is active; a stale heartbeat OR a missing descriptor => archived
// (Verified fact #3: archival is implicit — absence of a live listener).
function classify(home, id, now) {
  let fresh = false;
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(H.heartbeatsDir(home), id + '.json'), 'utf8'));
    fresh = Number.isFinite(hb.ts) && (now - hb.ts) < DEFAULT_IDLE_MS;
  } catch (_) { fresh = false; }
  const present = readDescriptors(home).some((d) => d && d.id === id);
  return (fresh && present) ? 'active' : 'archived';
}

test('4 CHILD-TURN: a child turn WRITES a fresh turn-authored heartbeat + reminds to report to parent', () => {
  const home = H.makeHome();
  try {
    const r = testHook('devswarm-child-turn.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'child-sess', prompt: 'work' },
      { home, env: childEnv('feat-x'), expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.match(ctxOf(r), /message-parent/, 'child is reminded to report to the parent');
    const hbPath = path.join(H.heartbeatsDir(home), 'feat-x.json');
    assert.ok(fs.existsSync(hbPath), 'a heartbeat must be written by the child turn');
    const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.strictEqual(hb.source, 'child-turn', 'heartbeat is turn-authored, not ticker-authored');
    assert.ok(Date.now() - hb.ts < 60000, 'heartbeat ts is fresh (this turn)');
  } finally { H.rm(home); }
});

test('4 CHILD-GATE: a child stop is forced to emit a heartbeat / self-report (decision:block)', () => {
  const home = H.makeHome();
  try {
    const r = testHookRaw('devswarm-child-gate.js',
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'child-sess' }),
      { home, env: childEnv('feat-x') });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json && r.json.decision === 'block', `child gate must force a heartbeat; stdout=${r.stdout}`);
    assert.match(r.json.reason, /message-parent/);
  } finally { H.rm(home); }
});

test('4 CLASSIFY: fresh heartbeat + descriptor => ACTIVE (both real artifacts present)', () => {
  const home = H.makeHome();
  try {
    // Register a descriptor for id 'feat-x', then let the child turn author a fresh heartbeat.
    H.runCli(home, ['register', 'feat-x', '--worktree', '/wt/feat-x', '--session', 'c1']);
    testHook('devswarm-child-turn.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt: 'go' },
      { home, env: childEnv('feat-x') });
    assert.strictEqual(classify(home, 'feat-x', Date.now()), 'active');
  } finally { H.rm(home); }
});

test('4 CLASSIFY: stale heartbeat => ARCHIVED, and a missing descriptor => ARCHIVED (both directions)', () => {
  const home = H.makeHome();
  try {
    // Direction A: descriptor present but the heartbeat is old (> idle threshold).
    H.runCli(home, ['register', 'stale-ws', '--worktree', '/wt/stale', '--session', 'c2']);
    fs.mkdirSync(H.heartbeatsDir(home), { recursive: true });
    fs.writeFileSync(path.join(H.heartbeatsDir(home), 'stale-ws.json'),
      JSON.stringify({ id: 'stale-ws', ts: Date.now() - (2 * DEFAULT_IDLE_MS), source: 'seed' }));
    assert.strictEqual(classify(home, 'stale-ws', Date.now()), 'archived', 'stale heartbeat -> archived');

    // Direction B: a fresh heartbeat but NO descriptor in the registry (archived by absence).
    fs.writeFileSync(path.join(H.heartbeatsDir(home), 'gone-ws.json'),
      JSON.stringify({ id: 'gone-ws', ts: Date.now(), source: 'seed' }));
    assert.strictEqual(classify(home, 'gone-ws', Date.now()), 'archived', 'no descriptor -> archived');
  } finally { H.rm(home); }
});

// ============================================================================
// 5. STORE — round-trip on BOTH backends (journal always; sqlite where available).
// ============================================================================

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });
else {
  test('5 STORE: sqlite backend SKIPPED', (t) => t.skip('node:sqlite unavailable on this runtime (journal-only)'));
}

for (const B of backends) {
  test(`5 STORE [${B.name}]: write messages/registry/cursor/gates, derive atomic summary.json, read back`, () => {
    const home = H.makeHome();
    try {
      const s = store.openStore({ home, backend: B.backend });
      try {
        assert.strictEqual(s.backend, B.backend, 'selected the intended backend');
        s.upsertRegistry({ id: 'w', worktreePath: '/wt/w', sessionId: 'sw',
          inboxPath: '/i', cursorPath: '/c', nudgeCommand: ['poke', 'w'] });
        // idempotent-by-hash messages: the duplicate hash must not double-count.
        assert.strictEqual(s.appendMessage({ workspaceId: 'w', body: 'm1', hash: 'h1' }).inserted, true);
        assert.strictEqual(s.appendMessage({ workspaceId: 'w', body: 'm2', hash: 'h2' }).inserted, true);
        assert.strictEqual(s.appendMessage({ workspaceId: 'w', body: 'm3', hash: 'h3' }).inserted, true);
        assert.strictEqual(s.appendMessage({ workspaceId: 'w', body: 'm1', hash: 'h1' }).inserted, false);
        s.setCursor('w', 1);
        s.setGate({ workspaceId: 'w', name: 'done', value: true });
        assert.strictEqual(s.messageCount('w'), 3, 'dedupe by hash: 3 distinct, not 4');

        const sum = store.deriveSummary(s, { home, now: 4242 });
        assert.strictEqual(sum.generatedAt, 4242);
        const ws = sum.workspaces.w;
        assert.strictEqual(ws.total, 3);
        assert.strictEqual(ws.cursor, 1);
        assert.strictEqual(ws.unread, 2);
        assert.deepStrictEqual(ws.gates, { done: true });
        assert.strictEqual(ws.archive_ready, false); // merged/tests_passed still missing
        assert.deepStrictEqual(ws.nudgeCommand, ['poke', 'w'], 'argv round-trips through the store');
      } finally { s.close(); }

      // summary.json was written atomically (tmp+rename) and reads back identically.
      assert.ok(fs.existsSync(H.summaryPath(home)), 'summary.json exists after derive');
      const readBack = store.readSummary(home);
      assert.strictEqual(readBack.workspaces.w.unread, 2, 'read-back projection matches');

      // Durability: a fresh store handle sees the persisted rows (append-only trail).
      const s2 = store.openStore({ home, backend: B.backend });
      try { assert.strictEqual(s2.messageCount('w'), 3, 'trail survives reopen'); }
      finally { s2.close(); }

      // Append-only evidence (journal backend keeps every physical row on disk).
      if (B.backend === 'journal') {
        const msgs = fs.readFileSync(path.join(H.swarmRoot(home), 'store', 'journal', 'messages.ndjson'), 'utf8')
          .split('\n').filter((l) => l.trim() !== '');
        assert.strictEqual(msgs.length, 3, 'journal appended exactly the 3 distinct messages (dup not written)');
      }
    } finally { H.rm(home); }
  });
}

// ============================================================================
// 6. INGEST — replay idempotence (dedupe hash) + single-consumer lock refusal.
// ============================================================================

test('6 INGEST: replaying the same native batch inserts 0 the second time (dedupe hash)', () => {
  const home = H.makeHome();
  try {
    const batch = JSON.stringify([
      { message: 'hello', fromBranch: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { message: 'world', fromBranch: 'a', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    const run = () => ({ ok: true, raw: batch });

    const first = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {},
    });
    assert.strictEqual(first.started, true);
    assert.strictEqual(first.stats.inserted, 2, 'first ingest inserts both messages');

    const second = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, run, sleep: () => {},
    });
    assert.strictEqual(second.stats.inserted, 0, 'replay of the same batch inserts nothing');
    assert.strictEqual(second.stats.duplicate, 2, 'both counted as duplicates');

    const s = store.openStore({ home, backend: 'journal' });
    try { assert.strictEqual(s.messageCount('p'), 2, 'store holds exactly 2, no dupes'); }
    finally { s.close(); }
  } finally { H.rm(home); }
});

test('6 INGEST: refuses to start while another monitor consumer holds the single-consumer lock', () => {
  const home = H.makeHome();
  try {
    const held = ingest.acquireIngestLock(home);
    assert.ok(held, 'first consumer acquires the lock');
    try {
      const refused = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', maxIterations: 1,
        run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      });
      assert.strictEqual(refused.started, false, 'must refuse while the lock is held');
      assert.match(refused.reason, /lock|consumer/i);
    } finally { held(); }
  } finally { H.rm(home); }
});

// ============================================================================
// 7. AUTO-MIGRATION — legacy registry + NDJSON inbox -> store, count-verified,
//    source intact, re-run idempotent.
// ============================================================================

test('7 MIGRATE: imports a legacy descriptor + NDJSON inbox, count-verified, source NOT destroyed, re-run no-op', () => {
  const home = H.makeHome();
  try {
    // Seed a LEGACY registry + durable inbox in the tmp HOME (pre-store state).
    const inbox = path.join(home, 'legacy-inbox.ndjson');
    const cursor = path.join(home, 'legacy-cursor.json');
    fs.writeFileSync(inbox, ['m1', 'm2', 'm3'].join('\n') + '\n');
    fs.writeFileSync(cursor, '1');
    fs.mkdirSync(H.workspacesDir(home), { recursive: true });
    fs.writeFileSync(H.descriptorPath(home, 'legacy'), JSON.stringify({
      id: 'legacy', worktreePath: '/wt/legacy', sessionId: 'sL', inboxPath: inbox, cursorPath: cursor,
    }));

    const inboxBytesBefore = fs.readFileSync(inbox, 'utf8');

    const rep = H.runCli(home, ['migrate'], { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' });
    assert.strictEqual(rep.status, 0);
    assert.ok(rep.json && rep.json.ok, `migrate ok; stdout=${rep.stdout}`);
    assert.strictEqual(rep.json.verifiedAll, true, 'every workspace count-verified');
    const m = rep.json.migrated.find((x) => x.id === 'legacy');
    assert.strictEqual(m.imported, 3, 'all 3 legacy lines imported');
    assert.strictEqual(m.legacyCount, 3);
    assert.strictEqual(m.storeCount, 3);
    assert.strictEqual(m.cursor, 1, 'legacy consumed-count carried forward');
    assert.strictEqual(m.verified, true);

    // NON-DESTRUCTIVE: the legacy source files are byte-for-byte intact.
    assert.strictEqual(fs.readFileSync(inbox, 'utf8'), inboxBytesBefore, 'legacy inbox untouched');
    assert.ok(fs.existsSync(H.descriptorPath(home, 'legacy')), 'legacy descriptor untouched');

    // IDEMPOTENT: a second run imports 0 new (same physical lines dedupe-hash).
    const rerun = H.runCli(home, ['migrate'], { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' });
    assert.ok(rerun.json && rerun.json.ok);
    assert.strictEqual(rerun.json.verifiedAll, true);
    assert.strictEqual(rerun.json.migrated.find((x) => x.id === 'legacy').imported, 0, 're-run is a no-op');
  } finally { H.rm(home); }
});

// ============================================================================
// 8. CLI — JSON shapes + exit codes for the core subcommands.
// ============================================================================

test('8 CLI: register/heartbeat/inbox count/workspaces list/nudge/archive emit well-formed JSON + correct exit codes', () => {
  const home = H.makeHome();
  try {
    const inbox = path.join(home, 'inbox.ndjson');
    const cursor = path.join(home, 'cursor.json');
    fs.writeFileSync(inbox, 'x\ny\n');

    const reg = H.runCli(home, ['register', 'w', '--worktree', '/wt/w', '--session', 's',
      '--inbox', inbox, '--cursor', cursor, '--nudge', 'poke', '--nudge', 'w']);
    assert.strictEqual(reg.status, 0);
    assert.deepStrictEqual({ ok: reg.json.ok, action: reg.json.action }, { ok: true, action: 'registered' });

    const hb = H.runCli(home, ['heartbeat', 'w', '--progress', '50', '--phase', 'build']);
    assert.strictEqual(hb.status, 0);
    assert.strictEqual(hb.json.action, 'heartbeat');
    assert.strictEqual(hb.json.heartbeat.progress_pct, 50);

    const count = H.runCli(home, ['inbox', 'count', 'w']);
    assert.strictEqual(count.status, 0);
    assert.strictEqual(count.json.action, 'count');
    assert.strictEqual(count.json.unread, 2);

    const list = H.runCli(home, ['workspaces', 'list']);
    assert.strictEqual(list.status, 0);
    assert.strictEqual(list.json.action, 'workspaces');
    assert.strictEqual(list.json.count, 1);
    assert.strictEqual(list.json.workspaces[0].id, 'w');

    // nudge with no nudgeCommand-descriptor escalates; still ok:true, exit 0.
    const nudge = H.runCli(home, ['nudge', 'w']);
    assert.strictEqual(nudge.status, 0);
    assert.strictEqual(nudge.json.action, 'nudge');
    assert.ok(['nudged', 'escalate'].includes(nudge.json.result.action));

    const archive = H.runCli(home, ['archive', 'w']);
    assert.strictEqual(archive.status, 0);
    assert.strictEqual(archive.json.action, 'archive');
    assert.strictEqual(archive.json.descriptorArchived, true);
    assert.match(archive.json.manualStep, /DevSwarm app/);
    assert.strictEqual(fs.existsSync(H.descriptorPath(home, 'w')), false, 'descriptor moved out of the active set');

    // Error shape: inbox on an unregistered workspace -> ok:false + exit 2.
    const bad = H.runCli(home, ['inbox', 'count', 'ghost']);
    assert.strictEqual(bad.status, 2);
    assert.strictEqual(bad.json.ok, false);
  } finally { H.rm(home); }
});

// ============================================================================
// 9. ARCHIVE-READY — gates -> archive_ready -> parent-inbox surfaces the "inform
//    the user to archive" nudge; cooldown'd + persistent; ignore suppresses one
//    while a second still-ready workspace keeps being reminded; NEVER auto-archive.
// ============================================================================

const inboxPayload = () => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' });

test('9 ARCHIVE-READY: all gates met -> parent-inbox recommends the user archive it (never auto-archives)', () => {
  const home = H.makeHome();
  try {
    H.runCli(home, ['register', 'wsA', '--worktree', '/wt/wsA', '--session', 'sA']);
    const g = H.runCli(home, ['gate', 'wsA', '--set', 'done,merged,tests_passed']);
    assert.ok(g.json && g.json.archive_ready === true, 'store derives archive_ready once all gates met');

    const r = testHook('devswarm-parent-inbox.js', inboxPayload(),
      { home, env: PRIMARY_ENV, expectJson: true });
    const c = ctxOf(r);
    assert.match(c, /DEVSWARM ARCHIVE-READY/);
    assert.match(c, /wsA/);
    assert.match(c, /INFORM THE USER/i);
    assert.match(c, /NEVER auto-archive/i);

    // INVARIANT: anti-hall never removed the descriptor / ran any archive command.
    assert.ok(fs.existsSync(H.descriptorPath(home, 'wsA')), 'descriptor must remain (never auto-removed)');
    // Cooldown state recorded so it does not repeat every single turn.
    assert.ok(fs.existsSync(path.join(H.archiveNudgesDir(home), 'wsA.json')), 'cooldown recorded');
  } finally { H.rm(home); }
});

test('9 ARCHIVE-READY: reminder is COOLDOWN\'d (not repeated next turn) but PERSISTS once the cooldown elapses', () => {
  const home = H.makeHome();
  try {
    H.runCli(home, ['register', 'wsA', '--worktree', '/wt/wsA', '--session', 'sA']);
    H.runCli(home, ['gate', 'wsA', '--set', 'done,merged,tests_passed']);

    // Turn 1: surfaced + cooldown recorded.
    const t1 = testHook('devswarm-parent-inbox.js', inboxPayload(),
      { home, env: PRIMARY_ENV, expectJson: true });
    assert.match(ctxOf(t1), /DEVSWARM ARCHIVE-READY/);

    // Turn 2 (immediately after): within cooldown -> suppressed (not every-turn spam).
    const t2 = testHook('devswarm-parent-inbox.js', inboxPayload(), { home, env: PRIMARY_ENV });
    assert.strictEqual(t2.stdout, '', 'within cooldown the reminder is suppressed');

    // Later turn: cooldown elapsed -> the SAME still-ready, still-present workspace is
    // reminded AGAIN. Proves the reminder is persistent, not one-shot.
    H.setArchiveNudgeState(home, 'wsA', Date.now() - (11 * 60 * 1000)); // > 10min default cooldown
    const t3 = testHook('devswarm-parent-inbox.js', inboxPayload(),
      { home, env: PRIMARY_ENV, expectJson: true });
    assert.match(ctxOf(t3), /DEVSWARM ARCHIVE-READY/, 'persists: reminds again after cooldown elapses');
    assert.match(ctxOf(t3), /wsA/);
    // Still never removed.
    assert.ok(fs.existsSync(H.descriptorPath(home, 'wsA')), 'descriptor still present');
  } finally { H.rm(home); }
});

test('9 ARCHIVE-READY: `archive-ignore` suppresses ONE workspace while a second still-ready one keeps being reminded', () => {
  const home = H.makeHome();
  try {
    H.runCli(home, ['register', 'wsA', '--worktree', '/wt/wsA', '--session', 'sA']);
    H.runCli(home, ['register', 'wsB', '--worktree', '/wt/wsB', '--session', 'sB']);
    H.runCli(home, ['gate', 'wsA', '--set', 'done,merged,tests_passed']);
    H.runCli(home, ['gate', 'wsB', '--set', 'done,merged,tests_passed']);

    // Ignore wsA via the real CLI; ensure BOTH cooldowns are elapsed so the only
    // reason wsA is silent is the ignore mark (not a fresh cooldown).
    const ig = H.runCli(home, ['archive-ignore', 'wsA']);
    assert.ok(ig.json && ig.json.ignored === true);
    H.setArchiveNudgeState(home, 'wsA', Date.now() - (11 * 60 * 1000));
    H.setArchiveNudgeState(home, 'wsB', Date.now() - (11 * 60 * 1000));

    const r = testHook('devswarm-parent-inbox.js', inboxPayload(),
      { home, env: PRIMARY_ENV, expectJson: true });
    const c = ctxOf(r);
    assert.match(c, /DEVSWARM ARCHIVE-READY/, 'wsB still surfaces');
    assert.ok(!/wsA/.test(c), `ignored workspace must be suppressed; ctx=${c}`);
    assert.match(c, /wsB/, 'the non-ignored still-ready workspace keeps being reminded');

    // The ignored workspace stays TRACKED (descriptor intact) — ignore silences the
    // reminder only, it does not archive/delete.
    assert.ok(fs.existsSync(H.descriptorPath(home, 'wsA')), 'ignored workspace stays tracked');
  } finally { H.rm(home); }
});

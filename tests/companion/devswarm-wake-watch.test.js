'use strict';
// devswarm-wake-watch — unit tests for the PURE tick() core plus the IO edges
// that are cheap/safe to exercise directly (lock-refusal, env-knob parsing,
// identity resolution). Per the task brief: run ONLY this file
// (`node --test tests/companion/devswarm-wake-watch.test.js`), not the full
// suite (another agent owns that run).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const wakeWatch = require(MODULE_PATH);
const {
  tick, normalizeState, formatArmLine, formatWakeLine, formatDualWakeLine, formatErrorLine,
  ERROR_TOLERANCE, ERROR_BACKOFF_MS,
  pollMsFromEnv, realFormsOf, resolveIdentity, resolvePrimaryHashes, resolveChildHashes,
  readChildSnapshot, readPrimarySnapshot, readChildCombinedSnapshot,
  lockPathFor, POLL_ENV_VAR, DEFAULT_POLL_MS,
} = wakeWatch;

const STORE_MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
const storeMod = require(STORE_MODULE_PATH);
const repokeyMod = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));
const REPO_ROOT = path.join(__dirname, '..', '..');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-'));
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

function okSnapshot(total, extra) {
  return Object.assign({ ok: true, error: null, total, role: 'primary', id: 'primary-deadbeef', nowMs: 1000 }, extra || {});
}
function errSnapshot(nowMs, error) {
  return { ok: false, error: error || 'boom', total: null, role: 'primary', id: 'primary-deadbeef', nowMs };
}

// ---------------------------------------------------------------------------
// Arm line
// ---------------------------------------------------------------------------

test('arm line emitted even at total 0 / unread 0, and only once', () => {
  const r1 = tick(undefined, okSnapshot(0));
  assert.strictEqual(r1.lines.length, 1);
  assert.match(r1.lines[0], /armed/);
  assert.match(r1.lines[0], /primary-deadbeef/);

  const r2 = tick(r1.state, okSnapshot(0));
  assert.deepStrictEqual(r2.lines, []); // no re-arm, no false edge (0 -> 0)
});

// ---------------------------------------------------------------------------
// Edge-trigger on total delta
// ---------------------------------------------------------------------------

test('edge-trigger fires exactly once on a new total', () => {
  const armed = tick(undefined, okSnapshot(3)).state; // consumes the arm line
  const r = tick(armed, okSnapshot(7));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /3 -> 7/);
  assert.match(r.lines[0], /\+4/);
});

test('no re-emit when nothing changed (same total repeated)', () => {
  let state = tick(undefined, okSnapshot(5)).state;
  state = tick(state, okSnapshot(5)).state;
  const r = tick(state, okSnapshot(5));
  assert.deepStrictEqual(r.lines, []);
});

test('ack-drop immunity: total unchanged after a drop-to-unread-0 never fires; a genuinely new total still fires', () => {
  // Simulate: message arrives (total 4->5, fires), agent acks (unread would
  // drop to 0 in the real system, but total is unaffected -> no line), then a
  // genuinely new message arrives (total 5->6, fires again).
  let state = tick(undefined, okSnapshot(4)).state; // arm
  let r = tick(state, okSnapshot(5));
  assert.strictEqual(r.lines.length, 1);
  state = r.state;

  // "ack" happens here in the real system (unread->0); total stays 5.
  r = tick(state, okSnapshot(5));
  assert.deepStrictEqual(r.lines, []);
  state = r.state;

  r = tick(state, okSnapshot(6));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /5 -> 6/);
});

// ---------------------------------------------------------------------------
// Heartbeat immunity (directs-only v1 design — heartbeats live in the
// broadcast partition and never touch workspaces[<id>].total, so N ticks of
// "heartbeat-only" traffic elsewhere must never move our tracked total and
// must never emit beyond the initial arm line).
// ---------------------------------------------------------------------------

test('heartbeat-only traffic (unchanged total across many ticks) emits zero lines beyond the arm', () => {
  let state = tick(undefined, okSnapshot(10)).state; // arm, baseline total 10
  let totalLines = 0;
  for (let i = 0; i < 50; i++) {
    // Each tick represents one heartbeat broadcast landing elsewhere; the
    // direct total this watcher tracks is untouched.
    const r = tick(state, okSnapshot(10));
    totalLines += r.lines.length;
    state = r.state;
  }
  assert.strictEqual(totalLines, 0);
});

// M4 hole closer: the test above never varies `working_on` (it's always
// absent), and the emit-contract test below always changes `total` in lock-
// step with `working_on`, so neither one actually proves that a CHANGING
// working_on/decorative field is powerless to trigger an emit on its own. A
// real heartbeat updates exactly this field (computeSummary sets working_on
// from the sender's own last heartbeat body) while leaving the direct total
// untouched, so this is the precise shape a heartbeat-driven false-fire would
// take if tick() ever grew a second edge-trigger keyed on anything but total.
test('a changing decorative field (working_on) alone never triggers an emit while total stays flat', () => {
  let state = tick(undefined, okSnapshot(5, { working_on: 'first heartbeat body' })).state; // arm
  let totalLines = 0;
  const bodies = ['second heartbeat body', 'third heartbeat body', 'fourth heartbeat body'];
  for (const working_on of bodies) {
    const r = tick(state, okSnapshot(5, { working_on })); // total never moves
    totalLines += r.lines.length;
    state = r.state;
  }
  assert.strictEqual(totalLines, 0);
});

// ---------------------------------------------------------------------------
// Emit-contract: never decorate an event with a field from a DIFFERENT
// observation (the working_on / stale-context regression).
// ---------------------------------------------------------------------------

test('emit-contract: a decorative field from a prior tick never leaks into a later wake line', () => {
  let state = tick(undefined, okSnapshot(1, { working_on: 'OLD HEARTBEAT TEXT' })).state;
  let r = tick(state, okSnapshot(2, { working_on: 'OLD HEARTBEAT TEXT' }));
  assert.strictEqual(r.lines.length, 1);
  assert.doesNotMatch(r.lines[0], /OLD HEARTBEAT TEXT/);
  state = r.state;

  r = tick(state, okSnapshot(3, { working_on: 'OLD HEARTBEAT TEXT' })); // unchanged working_on, new total
  assert.strictEqual(r.lines.length, 1);
  assert.doesNotMatch(r.lines[0], /OLD HEARTBEAT TEXT/);
  assert.match(r.lines[0], /2 -> 3/);
});

// ---------------------------------------------------------------------------
// Child dual-channel: NDJSON (`total`) + mesh-direct/summary (`total2`).
// A child snapshot ALWAYS carries a `total2` key (even when null) so tick()
// can tell "this is a dual-channel child tick" apart from a single-channel
// Primary tick that never has the key at all.
// ---------------------------------------------------------------------------

function childSnapshot(total, total2, extra) {
  return Object.assign({ ok: true, error: null, total, total2, role: 'child', id: 'builder-xyz', nowMs: 1000 }, extra || {});
}

test('child: a mesh-direct (summary/total2) advance alone fires exactly one labeled line, ndjson total untouched', () => {
  const armed = tick(undefined, childSnapshot(0, 0)).state; // arm
  const r = tick(armed, childSnapshot(0, 4));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /mesh-direct/);
  assert.match(r.lines[0], /0 -> 4/);
  assert.match(r.lines[0], /\+4/);
  assert.strictEqual(r.state.lastTotal, 0); // ndjson cursor untouched
  assert.strictEqual(r.state.lastTotal2, 4);
});

test('child: an ndjson (native-queue) advance alone fires exactly one labeled line, mesh-direct total untouched', () => {
  const armed = tick(undefined, childSnapshot(0, 0)).state; // arm
  const r = tick(armed, childSnapshot(3, 0));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /ndjson/);
  assert.match(r.lines[0], /0 -> 3/);
  assert.strictEqual(r.state.lastTotal, 3);
  assert.strictEqual(r.state.lastTotal2, 0); // mesh-direct cursor untouched
});

test('child: both channels advancing in the SAME tick emits exactly ONE combined line, not two', () => {
  const armed = tick(undefined, childSnapshot(0, 0)).state; // arm
  const r = tick(armed, childSnapshot(2, 5));
  assert.strictEqual(r.lines.length, 1); // single-emit rule — never two lines
  assert.match(r.lines[0], /ndjson total 0 -> 2 \(\+2\)/);
  assert.match(r.lines[0], /mesh-direct total 0 -> 5 \(\+5\)/);
  assert.strictEqual(r.state.lastTotal, 2);
  assert.strictEqual(r.state.lastTotal2, 5);
});

test('child: independent cursors — one channel advancing does not suppress or consume the other\'s later edge', () => {
  let state = tick(undefined, childSnapshot(0, 0)).state; // arm
  // ndjson advances alone.
  let r = tick(state, childSnapshot(1, 0));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /ndjson/);
  state = r.state;
  // mesh-direct advances alone on a LATER tick — must still fire (not
  // suppressed by the earlier ndjson-only emission).
  r = tick(state, childSnapshot(1, 3));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /mesh-direct/);
  assert.match(r.lines[0], /0 -> 3/);
  state = r.state;
  // No change on either -> silent.
  r = tick(state, childSnapshot(1, 3));
  assert.deepStrictEqual(r.lines, []);
});

test('child: missing mesh-direct summary key (total2: null) -> no emit and no fabricated baseline for that channel', () => {
  const armed = tick(undefined, childSnapshot(0, null)).state; // arm; total2 absent-key case (unregistered/no-data-yet)
  // ndjson moves; mesh-direct stays null (never coerced to 0, never treated as an edge).
  const r = tick(armed, childSnapshot(2, null));
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.lines[0], /ndjson/);
  assert.doesNotMatch(r.lines[0], /mesh-direct/);
  assert.strictEqual(r.state.lastTotal2, 0); // still baseline — never advanced off a null reading
});

test('a Primary snapshot (no total2 key at all) still emits the ORIGINAL unlabeled wording', () => {
  // Regression guard: adding channelLabel support must not change Primary's line.
  const armed = tick(undefined, okSnapshot(3)).state;
  const r = tick(armed, okSnapshot(7));
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.lines[0], formatWakeLine(okSnapshot(7), 3, 7));
  assert.doesNotMatch(r.lines[0], /ndjson/);
  assert.doesNotMatch(r.lines[0], /mesh-direct/);
});

// ---------------------------------------------------------------------------
// resolveChildHashes — child counterpart of resolvePrimaryHashes
// ---------------------------------------------------------------------------

test('resolveChildHashes: repoKey first, legacy per-child hash as a DISTINCT fallback', () => {
  const io = {
    repoKeyForWorktree: () => 'anti-hall-abc123',
    hashFromWorkspaceId: () => 'aaaaaaaa',
  };
  const h = resolveChildHashes('/some/cwd', 'child-1', io);
  assert.strictEqual(h.repoKey, 'anti-hall-abc123');
  assert.strictEqual(h.fallbackHash, 'aaaaaaaa');
});

test('resolveChildHashes: fallbackHash suppressed when it equals repoKey', () => {
  const io = {
    repoKeyForWorktree: () => 'aaaaaaaa',
    hashFromWorkspaceId: () => 'aaaaaaaa',
  };
  const h = resolveChildHashes('/some/cwd', 'child-1', io);
  assert.strictEqual(h.repoKey, 'aaaaaaaa');
  assert.strictEqual(h.fallbackHash, null);
});

test('resolveChildHashes: null when nothing resolves', () => {
  const io = { repoKeyForWorktree: () => null, hashFromWorkspaceId: () => null };
  assert.strictEqual(resolveChildHashes('/nowhere', 'child-1', io), null);
});

// ---------------------------------------------------------------------------
// readChildCombinedSnapshot — combines the NDJSON read with a REUSED
// readPrimarySnapshot call keyed by the child's own id (real store, not
// mocked, for the mesh-direct half — closing the same gap the header comment
// documents was previously fixed).
// ---------------------------------------------------------------------------

test('readChildCombinedSnapshot (real store): a mesh-direct send --to <childId> is visible via total2, independent of ndjson', () => {
  const home = tmpHome();
  try {
    const childId = 'child-combined-1';
    const s = storeMod.openStore({ home, workspaceId: childId, backend: 'journal', fsi: fs, hash: 'reposhare1' });
    s.upsertRegistry({ id: childId, worktreePath: path.join(home, 'fake-child-worktree') });
    for (let i = 0; i < 4; i++) {
      storeMod.appendMeshMessage(s, {
        from: 'primary-deadbeef', to: childId, type: 'direct',
        message: 'parent says hi ' + i, timestamp: Date.now() + i,
      });
    }
    // NOTE: deriveSummary opts deliberately omit `workspaceId` — passing it would
    // make summaryHashFor target hashFromWorkspaceId(childId) instead of the
    // store handle's own `hash` ('reposhare1'), which is NOT what cmdSend does
    // (scripts/devswarm.js calls store.deriveSummary(s, { home, env, now }) with
    // no workspaceId override, so it targets store.hash — the repoKey bucket).
    storeMod.deriveSummary(s, { home, env: {} });
    s.close();

    const inboxPath = path.join(home, 'nope', 'absent.ndjson'); // no NDJSON traffic for this child yet
    const cursorPath = path.join(home, 'nope', 'absent.cursor');
    const hashes = { repoKey: 'reposhare1', fallbackHash: null };
    const snap = readChildCombinedSnapshot({ inboxPath, cursorPath }, hashes, childId, home, { fs });
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.total, 0);   // ndjson channel: genuinely empty, not an error
    assert.strictEqual(snap.total2, 4);  // mesh-direct channel: the 4 sends, via the SAME summary reader the Primary path uses
  } finally { rm(home); }
});

test('readChildCombinedSnapshot: an unresolvable hash bucket surfaces as total2: null (no data yet), never a fabricated zero', () => {
  const home = tmpHome();
  try {
    const inboxPath = path.join(home, 'nope', 'absent.ndjson');
    const cursorPath = path.join(home, 'nope', 'absent.cursor');
    const snap = readChildCombinedSnapshot({ inboxPath, cursorPath }, null, 'child-x', home, { fs });
    assert.strictEqual(snap.total, 0);     // ndjson: genuinely absent file = 0
    assert.strictEqual(snap.total2, null); // mesh-direct: unresolvable identity = no data, not 0
  } finally { rm(home); }
});

test('readChildCombinedSnapshot: an error on one channel surfaces as ok:false with a labeled message, other channel unaffected', () => {
  const home = tmpHome();
  try {
    const snap = readChildCombinedSnapshot(
      { inboxPath: 'x', cursorPath: 'y' },
      { repoKey: 'deadbeef', fallbackHash: null },
      'child-x',
      home,
      { readUnread: () => { throw new Error('ndjson blew up'); }, fs } // mesh-direct half reads the real (absent) summary -> ok:true
    );
    assert.strictEqual(snap.ok, false); // fail-closed: AND of both channels
    assert.strictEqual(snap.error, 'ndjson: ndjson blew up');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Error tolerance + 1min/5min/30min backoff
// ---------------------------------------------------------------------------

test('3-tick error tolerance, then immediate emission, then 1min/5min/30min repeat backoff', () => {
  let state = tick(undefined, okSnapshot(0)).state; // arm on a healthy first tick

  let t = 0;
  // 3 silent failures.
  let r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;
  r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;
  r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;

  // 4th consecutive failure -> immediate emission.
  r = tick(state, errSnapshot(t)); assert.strictEqual(r.lines.length, 1); state = r.state;

  // Before 1 minute elapses: silent.
  t += 30 * 1000;
  r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;

  // At/after 1 minute: repeat #2.
  t += 31 * 1000; // total +61s since last emission
  r = tick(state, errSnapshot(t)); assert.strictEqual(r.lines.length, 1); state = r.state;
  const afterSecond = t;

  // Before 5 minutes: silent.
  t = afterSecond + 4 * 60 * 1000;
  r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;

  // At/after 5 minutes: repeat #3.
  t = afterSecond + 5 * 60 * 1000 + 1;
  r = tick(state, errSnapshot(t)); assert.strictEqual(r.lines.length, 1); state = r.state;
  const afterThird = t;

  // Before 30 minutes: silent.
  t = afterThird + 29 * 60 * 1000;
  r = tick(state, errSnapshot(t)); assert.deepStrictEqual(r.lines, []); state = r.state;

  // At/after 30 minutes: repeat #4, and stays on a 30-minute cadence thereafter.
  t = afterThird + 30 * 60 * 1000 + 1;
  r = tick(state, errSnapshot(t)); assert.strictEqual(r.lines.length, 1); state = r.state;
  const afterFourth = t;

  t = afterFourth + 30 * 60 * 1000 + 1;
  r = tick(state, errSnapshot(t)); assert.strictEqual(r.lines.length, 1); state = r.state;
});

test('recovery after errors is silent, and resets the backoff schedule', () => {
  let state = tick(undefined, okSnapshot(0)).state;
  for (let i = 0; i < 4; i++) state = tick(state, errSnapshot(i)).state; // reach the immediate emission
  // Recover.
  let r = tick(state, okSnapshot(0));
  assert.deepStrictEqual(r.lines, []);
  state = r.state;
  assert.strictEqual(state.consecErrors, 0);
  assert.strictEqual(state.errorBackoffIdx, 0);
  assert.strictEqual(state.lastErrorEmitMs, null);

  // A fresh run of 3 failures after recovery should again be silent (schedule reset).
  r = tick(state, errSnapshot(0)); assert.deepStrictEqual(r.lines, []); state = r.state;
  r = tick(state, errSnapshot(0)); assert.deepStrictEqual(r.lines, []); state = r.state;
  r = tick(state, errSnapshot(0)); assert.deepStrictEqual(r.lines, []); state = r.state;
  r = tick(state, errSnapshot(0)); assert.strictEqual(r.lines.length, 1);
});

// ---------------------------------------------------------------------------
// tick never throws
// ---------------------------------------------------------------------------

test('tick never throws on garbage/partial/null snapshots or state', () => {
  const garbageSnapshots = [
    null, undefined, {}, 'a string', 42, [], true,
    { ok: true }, { ok: false }, { ok: true, total: 'not-a-number' },
    { ok: true, total: NaN }, { ok: true, total: Infinity },
    { ok: null, total: null, nowMs: 'nope' },
    { toString() { throw new Error('hostile'); } },
  ];
  const garbageStates = [null, undefined, {}, 'x', 42, [], { armed: 'yes', lastTotal: 'no' }];

  for (const gs of garbageStates) {
    for (const snap of garbageSnapshots) {
      assert.doesNotThrow(() => {
        const r = tick(gs, snap);
        assert.ok(r && typeof r === 'object');
        assert.ok(Array.isArray(r.lines));
        assert.ok(r.state && typeof r.state === 'object');
      });
    }
  }
});

// M5 hole closer: every garbage snapshot in the test above is one tickInner's
// own defensive `snapshot && snapshot.x` guards already survive WITHOUT ever
// needing tick()'s outer try/catch (none of those shapes actually throw
// during property access). That means the outer try/catch in tick() — the
// thing that stands between a genuine read-error edge case and the Monitor
// loop dying — was previously unexercised by any test. A hostile snapshot
// whose property ACCESS itself throws (e.g. a throwing getter, which a
// corrupted/proxied read result could plausibly produce) is the shape that
// actually reaches tick()'s catch. This proves the loop can never die from
// such an input, matching "never exits the loop on read error" by test, not
// just by inspection.
test('tick never propagates an exception even when snapshot property access itself throws', () => {
  const hostileSnapshot = { get ok() { throw new Error('read blew up'); } };
  assert.doesNotThrow(() => {
    const r = tick(undefined, hostileSnapshot);
    assert.ok(r && typeof r === 'object');
    assert.ok(Array.isArray(r.lines));
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.state.armed, false); // caught before the arm line could be recorded
  });
});

test('normalizeState never throws and fills safe defaults', () => {
  const s = normalizeState({ armed: 'truthy-string', lastTotal: 'nope', consecErrors: null });
  assert.strictEqual(typeof s.armed, 'boolean');
  assert.strictEqual(s.lastTotal, 0);
  assert.strictEqual(s.consecErrors, 0);
  assert.strictEqual(s.lastErrorEmitMs, null);
});

// ---------------------------------------------------------------------------
// Source-scan: the self-erasing-wake guard. None of the 5 forbidden mutating
// verb phrases may ever appear in this watcher's own source text.
// ---------------------------------------------------------------------------

test('source-scan: no forbidden mutating verb phrase appears anywhere in the module source', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const forbidden = [
    'inbox read-primary',
    'inbox pull',
    'mesh read',
    'roster --ack',
    'inbox ack',
  ];
  for (const phrase of forbidden) {
    assert.ok(!src.includes(phrase), 'forbidden mutating verb phrase found in source: ' + JSON.stringify(phrase));
  }
});

// ---------------------------------------------------------------------------
// pollMsFromEnv — charset-validated, fail-open env knob (mirrors devswarm-wake.js)
// ---------------------------------------------------------------------------

test('pollMsFromEnv: valid digits within range pass through; garbage/out-of-range fail open to default', () => {
  assert.strictEqual(pollMsFromEnv({ [POLL_ENV_VAR]: '5000' }), 5000);
  assert.strictEqual(pollMsFromEnv({}), DEFAULT_POLL_MS);
  assert.strictEqual(pollMsFromEnv({ [POLL_ENV_VAR]: 'not-a-number' }), DEFAULT_POLL_MS);
  assert.strictEqual(pollMsFromEnv({ [POLL_ENV_VAR]: '5000; rm -rf /' }), DEFAULT_POLL_MS);
  assert.strictEqual(pollMsFromEnv({ [POLL_ENV_VAR]: '0' }), DEFAULT_POLL_MS);
  assert.strictEqual(pollMsFromEnv({ [POLL_ENV_VAR]: '999999999' }) <= 60000, true); // clamped
});

// ---------------------------------------------------------------------------
// realFormsOf — raw + realpath'd forms (symlink footgun)
// ---------------------------------------------------------------------------

test('realFormsOf returns both the raw-resolved and realpath\'d forms', () => {
  const home = tmpHome();
  try {
    const real = path.join(home, 'real-dir');
    fs.mkdirSync(real);
    const link = path.join(home, 'link-dir');
    let hasSymlink = true;
    try { fs.symlinkSync(real, link, 'dir'); } catch (_) { hasSymlink = false; }
    if (hasSymlink) {
      const forms = realFormsOf(link, fs);
      assert.ok(forms.has(path.resolve(link)));
      assert.ok(forms.has(fs.realpathSync(real)));
    } else {
      const forms = realFormsOf(real, fs);
      assert.ok(forms.has(path.resolve(real)));
    }
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

test('resolveIdentity: env-based child role wins when DEVSWARM_SOURCE_BRANCH + DEVSWARM_BUILDER_ID are set', () => {
  const home = tmpHome();
  try {
    const env = { DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'builder-123' };
    const id = resolveIdentity(env, '/some/cwd', { home, fs });
    assert.deepStrictEqual({ role: id.role, id: id.id }, { role: 'child', id: 'builder-123' });
  } finally { rm(home); }
});

test('resolveIdentity: descriptor cwd-match fallback when env is absent, matching via realpath', () => {
  const home = tmpHome();
  try {
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'child-1.json'), JSON.stringify({
      id: 'child-1', worktreePath: worktree, sessionId: 's1',
    }));
    const readDescriptors = (h) => {
      const dir = path.join(h, '.anti-hall', 'devswarm', 'workspaces');
      return fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    };
    const identity = resolveIdentity({}, worktree, { home, fs, readDescriptors });
    assert.strictEqual(identity.role, 'child');
    assert.strictEqual(identity.id, 'child-1');
  } finally { rm(home); }
});

test('resolveIdentity: falls back to Primary via injected resolveMainWorktree/primaryWorkspaceId', () => {
  const home = tmpHome();
  try {
    const io = {
      home, fs,
      readDescriptors: () => [],
      resolveMainWorktree: () => '/main/worktree',
      primaryWorkspaceId: (wt) => 'primary-' + (wt === '/main/worktree' ? 'deadbeef' : 'wrong'),
    };
    const identity = resolveIdentity({}, '/some/cwd', io);
    assert.deepStrictEqual({ role: identity.role, id: identity.id }, { role: 'primary', id: 'primary-deadbeef' });
  } finally { rm(home); }
});

test('resolveIdentity returns null when Primary fallback cannot resolve a main worktree', () => {
  const io = { home: tmpHome(), fs, readDescriptors: () => [], resolveMainWorktree: () => null };
  const identity = resolveIdentity({}, '/nowhere', io);
  assert.strictEqual(identity, null);
});

// ---------------------------------------------------------------------------
// resolvePrimaryHashes — the two-probe hash resolution
// ---------------------------------------------------------------------------

test('resolvePrimaryHashes: repoKey first, legacy hash as a DISTINCT fallback', () => {
  const io = {
    repoKeyForWorktree: () => 'anti-hall-abc123',
    resolveMainWorktree: () => '/main/wt',
    primaryWorkspaceId: () => 'primary-deadbeef',
    hashFromWorkspaceId: () => 'deadbeef',
  };
  const h = resolvePrimaryHashes('/some/cwd', io);
  assert.strictEqual(h.repoKey, 'anti-hall-abc123');
  assert.strictEqual(h.fallbackHash, 'deadbeef');
  assert.strictEqual(h.primaryId, 'primary-deadbeef');
});

test('resolvePrimaryHashes: fallbackHash suppressed when it equals repoKey (never a redundant second read)', () => {
  const io = {
    repoKeyForWorktree: () => 'deadbeef',
    resolveMainWorktree: () => '/main/wt',
    primaryWorkspaceId: () => 'primary-deadbeef',
    hashFromWorkspaceId: () => 'deadbeef',
  };
  const h = resolvePrimaryHashes('/some/cwd', io);
  assert.strictEqual(h.repoKey, 'deadbeef');
  assert.strictEqual(h.fallbackHash, null);
});

test('resolvePrimaryHashes: null when nothing resolves (non-git cwd)', () => {
  const io = { repoKeyForWorktree: () => null, resolveMainWorktree: () => null };
  assert.strictEqual(resolvePrimaryHashes('/nowhere', io), null);
});

// ---------------------------------------------------------------------------
// readChildSnapshot — missing file = "no data yet" (ok:true, total:null),
// never a fabricated zero-triggered delta.
// ---------------------------------------------------------------------------

test('readChildSnapshot: a genuinely absent inbox reads as ok:true with total 0 via readUnread (never an error)', () => {
  const home = tmpHome();
  try {
    const inboxPath = path.join(home, 'nope', 'absent.ndjson');
    const cursorPath = path.join(home, 'nope', 'absent.cursor');
    const snap = readChildSnapshot({ inboxPath, cursorPath }, { fs });
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.total, 0);
  } finally { rm(home); }
});

test('readChildSnapshot: a thrown reader surfaces ok:false with the error message, never throws', () => {
  const snap = readChildSnapshot({ inboxPath: 'x', cursorPath: 'y' }, {
    readUnread: () => { throw new Error('disk exploded'); },
  });
  assert.strictEqual(snap.ok, false);
  assert.match(snap.error, /disk exploded/);
  assert.strictEqual(snap.total, null);
});

// ---------------------------------------------------------------------------
// readPrimarySnapshot — END-TO-END through the REAL store (not mocked), to
// independently verify the "heartbeat immunity is structural" claim made in
// devswarm-wake-watch.js's header comment (BROADCAST_PARTITION_ID exclusion
// in devswarm-store.js computeSummary/messageCount). Every other test in this
// file that touches "total" feeds it a hand-picked number straight into the
// pure tick() core — none of them ever exercise the real store projection
// this watcher reads in production. This test closes that gap: it writes
// real messages (3 direct + 50 broadcast heartbeats) through the actual
// store/deriveSummary pipeline, then reads the resulting summary file through
// the actual readPrimarySnapshot(), and asserts the broadcast flood never
// inflates the workspace's own total.
// ---------------------------------------------------------------------------

test('readPrimarySnapshot (real store, not mocked): 50 broadcast/heartbeat rows never inflate a workspace\'s own direct total', () => {
  const home = tmpHome();
  try {
    const workspaceId = 'primary-deadbeef';
    const store = storeMod.openStore({ home, workspaceId, backend: 'journal', fsi: fs });
    store.upsertRegistry({ id: workspaceId, worktreePath: path.join(home, 'fake-worktree') });

    // 3 genuine direct messages addressed to this workspace.
    for (let i = 0; i < 3; i++) {
      storeMod.appendMeshMessage(store, {
        from: 'sender-x', to: workspaceId, type: 'direct',
        message: 'hello ' + i, timestamp: Date.now() + i,
      });
    }
    // 50 broadcast heartbeats flooding the SHARED partition (same shape as the
    // real steady-state noise this file's header comment describes: one idle
    // sender's heartbeat, same body, high cadence).
    for (let i = 0; i < 50; i++) {
      storeMod.appendMeshMessage(store, {
        from: 'someone-else', type: 'broadcast', isHeartbeat: true,
        message: 'heartbeat', timestamp: Date.now() + i,
      });
    }
    storeMod.deriveSummary(store, { home, workspaceId });
    store.close();

    const hash = storeMod.hashFromWorkspaceId(workspaceId);
    const hashes = { repoKey: hash, fallbackHash: null, primaryId: workspaceId };
    const snap = readPrimarySnapshot(home, hashes, workspaceId, { fs });
    assert.strictEqual(snap.ok, true);
    assert.strictEqual(snap.total, 3); // NOT 53 — broadcast/heartbeat volume must never leak into a direct total
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Lock-refused path: stderr only, ZERO stdout, exit 0.
// ---------------------------------------------------------------------------

test('lock-refused: a live-held lock produces zero stdout and a stderr line, exit 0', (t) => {
  const home = tmpHome();
  try {
    const id = 'builder-lockrefusal-test';
    const lockPath = lockPathFor(home, id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Simulate a LIVE holder: pid = this test process's own pid (definitely alive).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'live-holder' }));

    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      DEVSWARM_REPO_ID: 'r1', // keep the non-DevSwarm gate OPEN — this test exercises the lock-refusal path beyond it
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, '');
    assert.match(res.stderr, /already holds the lock/);

    // Lock file must be left untouched (refusal never steals/removes a live lock).
    assert.ok(fs.existsSync(lockPath));
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// P0 FIX: non-DevSwarm session gate. monitors.json declares "when": "always",
// so main() starts at EVERY session start for every personal-scope install —
// this must produce ZERO stdout, exit 0, and create ZERO directories/files,
// for a genuinely non-DevSwarm session (no DEVSWARM_* env, virgin/isolated
// HOME). Mirrors skills/update/scripts/update.js's wakeMonitorPostUpdate gate:
// SAME helper (hooks/lib/devswarm-detect.js isDevswarmActive), same semantics.
// ---------------------------------------------------------------------------

test('main(): a non-DevSwarm session exits quietly — zero stdout, exit 0, zero files/dirs created', () => {
  const home = tmpHome();
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      // Deliberately NO DEVSWARM_* / ANTIHALL_DEVSWARM_* vars at all — a
      // virgin, non-DevSwarm session.
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, '', 'stdout must be byte-for-byte empty — stdout is what wakes an agent');
    // stderr MAY carry a one-line notice; that's fine and expected.
    assert.match(res.stderr, /not a DevSwarm session/);

    // ZERO directories/files created anywhere under the isolated HOME —
    // specifically no ~/.anti-hall/devswarm (locks/wake state dirs) at all.
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall')), false,
      'the gate must run before any mkdir/lock-acquisition/state write — found: ' + JSON.stringify(fs.readdirSync(home)));
  } finally { rm(home); }
});

test('main(): a DevSwarm-active session still arms normally (gate is not over-broad)', () => {
  const home = tmpHome();
  try {
    const id = 'arm-test-child-1';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      DEVSWARM_REPO_ID: 'r1',           // opens the isDevswarmActive gate
      DEVSWARM_SOURCE_BRANCH: 'main',   // child-role identity, resolved purely from env (no git needed)
      DEVSWARM_BUILDER_ID: id,
    };
    // The watcher loops forever (setTimeout(loop, pollMs)); let it run just
    // long enough to complete its first (arm) tick, then time out / SIGTERM it.
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, encoding: 'utf8', timeout: 1500 });
    assert.match(res.stdout, /\[wake-watch\] armed: watching child arm-test-child-1/,
      'expected an arm line on stdout; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));

    // A genuinely armed watcher DOES create its lock directory (proves the
    // gate did not silently neuter the feature for an active DevSwarm
    // session). The lock FILE itself is removed by the process's own SIGTERM
    // cleanup handler (release()) once spawnSync's timeout kills it — that is
    // correct, expected lock hygiene, not a sign nothing was created — so this
    // asserts on the directory the lock lived in instead of the (by-then
    // released) file.
    const lockDir = path.dirname(lockPathFor(home, id));
    assert.ok(fs.existsSync(lockDir), 'expected the watch-lock directory to have been created for an active DevSwarm session');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// REGRESSION FIX: the gate must arm on any of resolveIdentity's OWN positive-
// evidence tiers (child env, descriptor cwd-match, on-disk repo state), not
// only on isDevswarmActive(env) (DEVSWARM_REPO_ID / ANTIHALL_DEVSWARM_SUPERVISOR).
// A second-opinion verifier proved isDevswarmActiveGate({DEVSWARM_SOURCE_BRANCH,
// DEVSWARM_BUILDER_ID}) previously returned false while resolveIdentity on that
// SAME env correctly resolved a child identity — a genuine DevSwarm child would
// silently never arm. Each test below is one arming branch.
// ---------------------------------------------------------------------------

test('T2 (THE REGRESSION CASE): DEVSWARM_SOURCE_BRANCH + DEVSWARM_BUILDER_ID set, NO DEVSWARM_REPO_ID -> MUST arm', () => {
  const home = tmpHome();
  try {
    const id = 't2-regression-child';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      // Deliberately NO DEVSWARM_REPO_ID — env inheritance into a Monitor-
      // spawned process is unverified, and this is the case where it did not
      // survive. DEVSWARM_SOURCE_BRANCH + DEVSWARM_BUILDER_ID are the only
      // signals present, exactly like resolveIdentity's own tier 1.
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, encoding: 'utf8', timeout: 1500 });
    assert.match(res.stdout, /\[wake-watch\] armed: watching child t2-regression-child/,
      'expected an arm line on stdout; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
  } finally { rm(home); }
});

test('T3: descriptor cwd-match with ZERO DEVSWARM_* env -> MUST arm', () => {
  const home = tmpHome();
  try {
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'child-t3.json'), JSON.stringify({
      id: 'child-t3', worktreePath: worktree, sessionId: 's1',
    }));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      // Deliberately ZERO DEVSWARM_*/ANTIHALL_DEVSWARM_* vars — the descriptor
      // cwd-match is the ONLY positive signal available.
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, cwd: worktree, encoding: 'utf8', timeout: 1500 });
    assert.match(res.stdout, /\[wake-watch\] armed: watching child child-t3/,
      'expected an arm line on stdout; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
  } finally { rm(home); }
});

test('T4: on-disk DevSwarm state for this repo\'s own repoKey (summaries/<repoKey>.json) -> MUST arm', () => {
  const home = tmpHome();
  try {
    // Compute the SAME repoKey production code would derive for this real
    // repo (a real git spawn against REPO_ROOT, not mocked), then place a
    // summary file at the EXACT path readPrimarySnapshot/resolvePrimaryHashes
    // already read — the cheapest reliable positive signal that this repo has
    // genuinely participated in a DevSwarm mesh before.
    const repoKey = repokeyMod.repoKeyForWorktree(REPO_ROOT);
    assert.ok(repoKey, 'expected REPO_ROOT to resolve a repoKey (must be a real git worktree)');
    const summaryPath = storeMod.summaryPathForHash(home, repoKey);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify({ workspaces: {} }));

    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() resolves USERPROFILE and ignores HOME
      // Deliberately ZERO DEVSWARM_*/ANTIHALL_DEVSWARM_* vars — the on-disk
      // summary file is the ONLY positive signal available.
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 1500 });
    assert.match(res.stdout, /\[wake-watch\] armed: watching primary/,
      'expected an arm line on stdout; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
  } finally { rm(home); }
});

// T5 (the existing DEVSWARM_REPO_ID path -> still arms) is covered above by
// 'main(): a DevSwarm-active session still arms normally (gate is not
// over-broad)', which sets DEVSWARM_REPO_ID and asserts an arm line — kept
// green, not duplicated here.

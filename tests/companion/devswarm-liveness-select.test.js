'use strict';
// devswarm-liveness-select — unit tests for the ONE freshest-LIVE registry-row
// selection primitive shared by scripts/devswarm.js (resolveMeshTarget,
// pickSurvivor) and companion/lib/devswarm-store.js (resolveSenderRegistryId).
// spec item 6: "unit — evidence-based ranking picks live row over stale
// reference; all-candidates-equal falls back to updatedAt; unified primitive
// used by all three call sites (require-graph or behavioral)".
//
// HERMETIC: every fixture lives under a fresh fs.mkdtempSync temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const livenessSelect = require(path.join(ROOT, 'companion', 'lib', 'devswarm-liveness-select.js'));
const { pickFreshestLive, isLiveSessionId, sessionAuthoredHeartbeat, cursorEvidence, heartbeatPath } = livenessSelect;

function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'liveness-select-test-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function writeHeartbeat(home, id, fields) {
  const p = heartbeatPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fields));
}

// A minimal fake storeHandle: cursorValue/hasCursorRow/messageCount driven by
// a plain in-memory map, matching the real store handle's shape closely
// enough for pickFreshestLive's contract (it only calls these three).
function fakeStore(rows) {
  // rows: { [id]: { cursor, hasCursorRow, total } }
  return {
    cursorValue(id) { const r = rows[id]; return r && Number.isFinite(r.cursor) ? r.cursor : 0; },
    hasCursorRow(id) { const r = rows[id]; return !!(r && r.hasCursorRow); },
    messageCount(id) { const r = rows[id]; return r && Number.isFinite(r.total) ? r.total : 0; },
  };
}

// ============================================================================
// isLiveSessionId
// ============================================================================

test('isLiveSessionId: null/empty/synthetic -> false; a real string -> true', () => {
  assert.strictEqual(isLiveSessionId(null), false);
  assert.strictEqual(isLiveSessionId(undefined), false);
  assert.strictEqual(isLiveSessionId(''), false);
  assert.strictEqual(isLiveSessionId('unclaimed:abc'), false);
  assert.strictEqual(isLiveSessionId('real-session-id'), true);
});

// ============================================================================
// pickFreshestLive — (a) SESSION-REFERENCE INTEGRITY
// ============================================================================

test('SESSION-REFERENCE INTEGRITY: a row whose sessionId equals ANOTHER row id in the group ranks BELOW a self-consistent row', () => {
  const rows = [
    { id: 'dead-slug', sessionId: 'live-uuid', updatedAt: 2000 }, // ALIAS: sessionId === sibling's id, fresher updatedAt
    { id: 'live-uuid', sessionId: 'live-uuid-session', updatedAt: 1000 }, // self-consistent, older
  ];
  const picked = pickFreshestLive(rows, {});
  assert.strictEqual(picked.id, 'live-uuid', 'the self-consistent row must win despite losing on recency');
});

test('SESSION-REFERENCE INTEGRITY: a row whose sessionId equals its OWN id is NOT an alias', () => {
  const rows = [
    { id: 'row-a', sessionId: 'row-a', updatedAt: 500 },
    { id: 'row-b', sessionId: 'unclaimed:x', updatedAt: 1000 }, // not live at all
  ];
  const picked = pickFreshestLive(rows, {});
  assert.strictEqual(picked.id, 'row-a', 'a row whose sessionId equals its OWN id must not be penalized as an alias');
});

// ============================================================================
// pickFreshestLive — (b) DRAIN ACTIVITY (comparative, not absolute)
// ============================================================================

test('DRAIN ACTIVITY: a row with a cursor row present outranks a live sibling with none + unread backlog (comparative)', () => {
  const rows = [
    { id: 'no-cursor', sessionId: 'no-cursor-session', updatedAt: 2000 }, // fresher, but never drained
    { id: 'has-cursor', sessionId: 'has-cursor-session', updatedAt: 1000 }, // older, genuinely draining
  ];
  const storeHandle = fakeStore({
    'no-cursor': { hasCursorRow: false, cursor: 0, total: 2 }, // 2 unread, never touched
    'has-cursor': { hasCursorRow: true, cursor: 3, total: 3 }, // fully drained
  });
  const picked = pickFreshestLive(rows, { storeHandle });
  assert.strictEqual(picked.id, 'has-cursor', 'genuine drain evidence must outrank a fresher-but-undrained row');
});

test('DRAIN ACTIVITY: comparative-only — a freshly-registered child with NO cursor row yet is NOT penalized when nothing else in the group has genuine drain evidence either', () => {
  const rows = [
    { id: 'fresh-child', sessionId: 'fresh-child-session', updatedAt: 1000 },
    { id: 'sibling-nothing-to-drain', sessionId: 'sibling-session', updatedAt: 2000 },
  ];
  // Neither row has a cursor row nor any drain evidence — no absolute veto,
  // so this must fall through to the updatedAt tiebreak (sibling wins on
  // recency), never penalize the fresh child just for lacking a cursor.
  const storeHandle = fakeStore({
    'fresh-child': { hasCursorRow: false, cursor: 0, total: 1 },
    'sibling-nothing-to-drain': { hasCursorRow: false, cursor: 0, total: 0 },
  });
  const picked = pickFreshestLive(rows, { storeHandle });
  assert.strictEqual(picked.id, 'sibling-nothing-to-drain', 'with no genuine drain evidence anywhere in the group, updatedAt tiebreak must decide, never an absolute cursor-row veto');
});

// ============================================================================
// pickFreshestLive — (c) SESSION-AUTHORED HEARTBEAT credit
// ============================================================================

test('SESSION-AUTHORED HEARTBEAT: a row with a real sessionId in its heartbeat file outranks one with source:cli-heartbeat/sessionId:null, all else equal', () => {
  const h = tmpHome();
  try {
    writeHeartbeat(h.home, 'no-session-heartbeat', { source: 'cli-heartbeat', sessionId: null });
    writeHeartbeat(h.home, 'session-authored', { source: 'child-turn', sessionId: 'real-session-xyz' });
    const rows = [
      { id: 'no-session-heartbeat', sessionId: 'sess-a', updatedAt: 1000 },
      { id: 'session-authored', sessionId: 'sess-b', updatedAt: 1000 }, // tied updatedAt
    ];
    const picked = pickFreshestLive(rows, { home: h.home });
    assert.strictEqual(picked.id, 'session-authored', 'session-authored heartbeat credit must win the tie');
  } finally { h.cleanup(); }
});

test('SESSION-AUTHORED HEARTBEAT: a missing/unreadable heartbeat file is NEUTRAL (never disqualifying)', () => {
  const h = tmpHome();
  try {
    // Neither row has a heartbeat file at all.
    const rows = [
      { id: 'row-a', sessionId: 'sess-a', updatedAt: 500 },
      { id: 'row-b', sessionId: 'sess-b', updatedAt: 1000 },
    ];
    const picked = pickFreshestLive(rows, { home: h.home });
    assert.strictEqual(picked.id, 'row-b', 'with no heartbeat evidence anywhere, updatedAt tiebreak must decide');
  } finally { h.cleanup(); }
});

test('sessionAuthoredHeartbeat: malformed JSON -> null (neutral), never throws', () => {
  const h = tmpHome();
  try {
    const p = heartbeatPath(h.home, 'corrupt');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json');
    assert.strictEqual(sessionAuthoredHeartbeat(h.home, 'corrupt', null), null);
  } finally { h.cleanup(); }
});

// ============================================================================
// pickFreshestLive — priority ORDER (a) beats (b) beats (c) beats updatedAt
// ============================================================================

test('PRIORITY ORDER: session-reference integrity (a) outranks drain activity (b) — an alias never wins even with better drain evidence', () => {
  const rows = [
    { id: 'alias-but-draining', sessionId: 'self-consistent', updatedAt: 3000 }, // ALIAS of the other row's id
    { id: 'self-consistent', sessionId: 'self-consistent-session', updatedAt: 1000 },
  ];
  const storeHandle = fakeStore({
    'alias-but-draining': { hasCursorRow: true, cursor: 5, total: 5 }, // better drain evidence
    'self-consistent': { hasCursorRow: false, cursor: 0, total: 1 }, // worse drain evidence
  });
  const picked = pickFreshestLive(rows, { storeHandle });
  assert.strictEqual(picked.id, 'self-consistent', 'signal (a) must dominate (b) — an alias never wins regardless of drain evidence');
});

// ============================================================================
// pickFreshestLive — fallback semantics
// ============================================================================

test('FALLBACK: all candidates rank equally on every signal -> falls back to plain freshest-updatedAt', () => {
  const rows = [
    { id: 'older', sessionId: 'sess-older', updatedAt: 1000 },
    { id: 'newer', sessionId: 'sess-newer', updatedAt: 2000 },
  ];
  const picked = pickFreshestLive(rows, {});
  assert.strictEqual(picked.id, 'newer');
});

test('FALLBACK: no candidate is live at all -> never strand a mesh, returns the first candidate', () => {
  const rows = [
    { id: 'dead-a', sessionId: 'unclaimed:x', updatedAt: 1000 },
    { id: 'dead-b', sessionId: null, updatedAt: 2000 },
  ];
  const picked = pickFreshestLive(rows, {});
  assert.strictEqual(picked.id, 'dead-a', 'with nothing live, the first candidate must still be returned (never null)');
});

test('FALLBACK: empty candidate list -> returns null, never throws', () => {
  assert.strictEqual(pickFreshestLive([], {}), null);
  assert.strictEqual(pickFreshestLive(null, {}), null);
});

// ============================================================================
// cursorEvidence fail-open
// ============================================================================

test('cursorEvidence: a throwing storeHandle degrades to neutral sentinels, never throws', () => {
  const throwingStore = {
    cursorValue() { throw new Error('boom'); },
    hasCursorRow() { throw new Error('boom'); },
    messageCount() { throw new Error('boom'); },
  };
  const ev = cursorEvidence(throwingStore, 'x');
  assert.strictEqual(ev.exists, null);
  assert.strictEqual(ev.value, -1);
  assert.strictEqual(ev.unread, null);
});

// ============================================================================
// FIELD SCENARIO (spec item 6 E2E, unit-level reproduction): the exact
// SkyCrew ground-truth shape — dead slug row FRESHER updatedAt, sessionId set
// to the sibling row's registry id (stale cross-reference), NO cursor row,
// unread backlog; live UUID row OLDER updatedAt, self-consistent sessionId,
// cursor present (draining). Assert the ranking picks the UUID row despite
// losing on recency — the exact field defect this module fixes.
// ============================================================================

test('FIELD SCENARIO: dead slug row (fresher, stale cross-reference, no cursor, unread) loses to live UUID row (older, self-consistent, draining)', () => {
  const UUID_ID = '6eb03881-aaaa-bbbb-cccc-000000000001';
  const SLUG_ID = 'primary-abc12345';
  const rows = [
    { id: SLUG_ID, sessionId: UUID_ID, updatedAt: Date.now() }, // dead row refreshed by cli-heartbeat every ~30-45s
    { id: UUID_ID, sessionId: 'genuine-session-for-uuid', updatedAt: Date.now() - 10 * 60000 }, // older, but live
  ];
  const storeHandle = fakeStore({
    [SLUG_ID]: { hasCursorRow: false, cursor: 0, total: 2 }, // 2 unread (seq 25447 + 25469), never drained
    [UUID_ID]: { hasCursorRow: true, cursor: 3, total: 3 }, // being drained (cursor value 3)
  });
  const picked = pickFreshestLive(rows, { storeHandle });
  assert.strictEqual(picked.id, UUID_ID, 'the field scenario must pick the drained UUID row, not the fresher-but-dead slug row');
});

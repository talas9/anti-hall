'use strict';
// devswarm-parent-gate.js — v0.106.0 regression: the Primary's OWN descriptor
// (workspaces/<own.id>.json) was counted TWICE. The own row (readOwnUnread ->
// the summary / this reader's own reader_cursors row) already accounts for the
// Primary's mailbox, but the descriptor loop ALSO counted the same partition via
// countFor(reader:null) — the FLOOR view. With the floor pinned below the
// Primary's own row, that produced a phantom "primary-… (you) (205 unread,
// live-resolved)" block.
//
// P2-a FIX (defect follow-up): the original fix skipped the own descriptor
// UNCONDITIONALLY, which reopened a DIFFERENT hole — readOwnUnread's cache
// path (rawUnread<=0 -> unread=0, ownSource='cache', see that function's own
// header) trusts the cached summary's "0 unread" verbatim with NO live check,
// so mail that arrived on primary-<hash> AFTER the summary was last derived
// stayed hidden until the next computeSummary() run. The fix now skips the
// own descriptor ONLY when `own.ownSource === 'live'` (already fresh); for
// 'cache' (or a stale-cache null ownSource) it falls through and is counted
// like any other descriptor, but keyed to THIS READER'S OWN identity
// (ownReaderKey), never the partition's floor (reader:null) — reusing the
// floor here would resurrect the ORIGINAL v0.106.0 bug this file's first test
// still guards against (a live, fully-caught-up reader whose sibling readers'
// floor legitimately lags behind it).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const rc = require('../../plugins/anti-hall/companion/lib/reader-cursors.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + installIngest.worktreeHash(REPO_CWD);
const STARTED_AT = 1700000000000;
// THIS reader's own harness identity, exactly as reader-identity.js's
// deriveReaderNonce would derive it for the spawned gate hook (whose parent is
// THIS test process — see writeGateSession's own comment).
const GATE_READER = 'h:' + process.pid + ':' + STARTED_AT;

// writeGateSession(home, cwd, startedAt) — registers a REAL harness session
// record for THIS TEST PROCESS's own pid. The spawned gate hook is a direct
// child of this test process (no shell wrapper, see tests/helpers/spawn-hook.js),
// so deriveReaderNonce's ancestor walk fails to match the hook's OWN pid (hop 0,
// no file), then hops to its PARENT — this test process's pid (hop 1) — and
// finds this record. Mirrors tests/hooks/fix-nonce-cwd-cursor-parity.test.js's
// own helper of the same name/contract.
function writeGateSession(home, cwd, startedAt) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const rec = { pid: process.pid, cwd, startedAt, sessionId: 'own-descriptor-test' };
  fs.writeFileSync(path.join(dir, String(process.pid) + '.json'), JSON.stringify(rec));
}

// seedOwn(home, { total, floor, ownReaderValue }) — `total` real store rows on
// the own descriptor's partition, the shared FLOOR pinned at `floor` (< total,
// simulating a lagging SIBLING reader — never this reader), and, when
// `ownReaderValue` is given, a declared reader_cursors row for THIS reader
// (GATE_READER) at that value — this reader's own true read position.
function seedOwn(home, { total, floor, ownReaderValue }) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  // Own summary: cache says this reader has 0 unread (rawUnread<=0 path).
  fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(root, 'summaries', REPO_KEY + '.json'), JSON.stringify({
    workspaces: { [OWN_ID]: { unread: 0, total, cursor: total } }, archivedRegistryRows: [],
  }));
  // The Primary's OWN descriptor (the live SkyCrew shape: workspaces/primary-<hash>.json).
  const inboxPath = path.join(root, 'inbox', OWN_ID + '.ndjson');
  const cursorPath = path.join(root, 'cursors', OWN_ID + '.json');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(root, 'workspaces', OWN_ID + '.json'), JSON.stringify({
    id: OWN_ID, worktreePath: REPO_CWD, sessionId: 'sess-primary-own', inboxPath, cursorPath, repoKey: REPO_KEY,
  }));
  // Store partition: `total` rows, stored floor pinned at `floor` < total.
  const s = meshStore.openStore({ home, workspaceId: OWN_ID, hash: REPO_KEY });
  try {
    for (let i = 1; i <= total; i++) {
      meshStore.appendMeshMessage(s, { from: 'some-child', to: OWN_ID, type: 'direct', message: 'row ' + i, timestamp: Date.now(), hash: 'own-desc-' + i });
    }
    rc.importLegacy(s, { partition: OWN_ID, home, harnesses: [], procTable: new Map() });
    rc.ackFor(s, { partition: OWN_ID, ns: 'store', reader: null, target: floor, home, procTable: new Map() });
    assert.strictEqual(rc.floorOf(s, OWN_ID, 'store', { home }), floor, 'precondition: floor pinned below total');
    if (Number.isFinite(ownReaderValue)) {
      s.readerCursorTxn((tx) => {
        tx.put({ partition: OWN_ID, ns: 'store', reader: GATE_READER, value: ownReaderValue, updatedAt: Date.now() });
      });
    }
  } finally { s.close(); }
}

test('own descriptor present + floor < total + THIS reader genuinely caught up (own row at total) -> no block, no floor-view count under (you)', () => {
  const h = makeHome();
  try {
    writeGateSession(h.home, REPO_CWD, STARTED_AT);
    seedOwn(h.home, { total: 7, floor: 2, ownReaderValue: 7 });
    const r = testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-own-desc' }), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    const reason = r.json && r.json.reason ? String(r.json.reason) : '';
    assert.ok(!/5 unread/.test(reason), 'the floor view (total - floor = 5) must not be reported: ' + reason);
    assert.strictEqual(r.json, null, 'nothing is unread for this Primary; stdout=' + r.stdout);
  } finally { h.cleanup(); }
});

// P2-a regression test: the cached summary said 0 unread (rawUnread<=0, never
// live-checked), but THIS reader's own declared position (5) is genuinely
// behind the live store total (7) — 2 real messages arrived since the summary
// was last derived. The unconditional skip (pre-fix) hid this until the next
// computeSummary() run; the fix must catch it via the descriptor loop, keyed
// to this reader's own row, never the (irrelevant, lower) sibling floor.
test('cached-0 own summary + genuinely new unread on own descriptor (this reader behind live total) -> gate blocks', () => {
  const h = makeHome();
  try {
    writeGateSession(h.home, REPO_CWD, STARTED_AT);
    seedOwn(h.home, { total: 7, floor: 1, ownReaderValue: 5 });
    const r = testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-own-desc-stale' }), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.strictEqual(r.json.decision, 'block', `must block on the own descriptor's genuinely-new mail; reason=${r.json && r.json.reason}`);
    assert.match(r.json.reason, /\b2 unread\b/, `this reader's own row (5) vs live total (7) -> 2 unread; got ${r.json.reason}`);
  } finally { h.cleanup(); }
});

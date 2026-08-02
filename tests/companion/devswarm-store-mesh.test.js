'use strict';
// devswarm-store MESH schema (v0.57, PLAN-v0.57-mesh.md Phase 2 — D3-D7/D20/D22/D23).
// Additive to the existing devswarm-store.test.js suite: the physical mesh columns
// on `messages`, the new `broadcast_cursors` table, `appendMeshMessage`/
// `meshMessageHash`, the broadcast-cursor read/ack surface, the mesh-aware
// `deriveSummary` projections, and the `listStoreHashes` repoKey-shape extension.
// The behavioral contract is backend-independent, so the same suite runs against
// BOTH backends (journal always; sqlite only when node:sqlite is present).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const STORE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-store-mesh-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

const descriptor = (id, over) => Object.assign({
  id,
  worktreePath: '/wt/' + id,
  sessionId: 'sess-' + id,
  inboxPath: '/inbox/' + id + '.ndjson',
  cursorPath: '/cursor/' + id + '.json',
  nudgeCommand: null,
}, over || {});

// runNode(code) -> Promise resolved when `node -e <code>` exits {code, stderr}.
function runNode(code) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { stderr += String(d); });
    p.on('exit', (exitCode) => resolve({ exitCode, stderr }));
    p.on('error', reject);
  });
}

// ---- backend matrix -------------------------------------------------------
const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  test(`[${B.name}] a direct mesh send lands in the target partition's inbox as unread`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      const r = store.appendMeshMessage(s, {
        from: 'alice', to: 'bob', type: 'direct', message: 'hi bob',
        timestamp: 1000, urgency: 'normal', hash: store.meshMessageHash({
          from: 'alice', to: 'bob', type: 'direct', message: 'hi bob', timestamp: 1000, urgency: 'normal',
        }),
      });
      assert.equal(r.inserted, true);
      assert.equal(s.messageCount('bob'), 1);
      const msgs = s.listMessages('bob');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].body, 'hi bob');
      assert.equal(msgs[0].sender, 'alice');
      assert.equal(msgs[0].recipient, 'bob');
      assert.equal(msgs[0].mtype, 'direct');
      assert.equal(msgs[0].urgency, 'normal');
      assert.equal(msgs[0].isHeartbeat, false);

      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.bob.unread, 1);
      assert.equal(sum.workspaces.bob.directUnread, 1);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a broadcast is visible to every workspace via its OWN broadcast_cursors join point`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w1'));
      s.upsertRegistry(descriptor('w2'));
      store.appendMeshMessage(s, {
        from: 'w1', to: null, type: 'broadcast', message: 'main is broken',
        timestamp: 1000, urgency: 'high',
        hash: store.meshMessageHash({ from: 'w1', to: null, type: 'broadcast', message: 'main is broken', timestamp: 1000, urgency: 'high' }),
      });

      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w1.broadcastUnread, 1, 'w1 sees the unread broadcast (own send included)');
      assert.equal(sum.workspaces.w2.broadcastUnread, 1, 'w2 ALSO sees it unread — full visibility (D3)');

      // w1 ACKs (D23) -> w1's broadcastUnread clears; w2 (un-acked) still shows it.
      const newCursor = s.advanceBroadcastCursor('w1');
      assert.ok(newCursor > 0);
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w1.broadcastUnread, 0, 'w1 acked -> broadcastUnread returns to 0');
      assert.equal(sum.workspaces.w2.broadcastUnread, 1, 'w2 has NOT acked -> still unread');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a heartbeat row does NOT increment broadcastUnread (D22)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w1'));
      s.upsertRegistry(descriptor('w2'));
      // A genuine broadcast (counts).
      store.appendMeshMessage(s, {
        from: 'w1', to: null, type: 'broadcast', message: 'plain broadcast',
        timestamp: 1000, urgency: 'normal',
        hash: store.meshMessageHash({ from: 'w1', to: null, type: 'broadcast', message: 'plain broadcast', timestamp: 1000, urgency: 'normal' }),
      });
      // A heartbeat (mtype='broadcast' + is_heartbeat=1) -> excluded from broadcastUnread.
      store.appendMeshMessage(s, {
        from: 'w1', to: null, type: 'broadcast', message: 'building feature X', isHeartbeat: true,
        timestamp: 2000, urgency: 'low',
        hash: store.meshMessageHash({ from: 'w1', to: null, type: 'broadcast', message: 'building feature X', timestamp: 2000, urgency: 'low' }),
      });

      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w2.broadcastUnread, 1, 'only the NON-heartbeat broadcast counts');
      assert.equal(sum.workspaces.w1.working_on, 'building feature X', 'the heartbeat DOES populate working_on');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] two distinct broadcasts do NOT collapse under the mesh hash`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w1'));
      const f1 = { from: 'w1', to: null, type: 'broadcast', message: 'first', timestamp: 1000, urgency: 'normal' };
      const f2 = { from: 'w1', to: null, type: 'broadcast', message: 'second', timestamp: 2000, urgency: 'normal' };
      assert.notEqual(store.meshMessageHash(f1), store.meshMessageHash(f2), 'distinct fields -> distinct hashes');
      const r1 = store.appendMeshMessage(s, Object.assign({}, f1, { hash: store.meshMessageHash(f1) }));
      const r2 = store.appendMeshMessage(s, Object.assign({}, f2, { hash: store.meshMessageHash(f2) }));
      assert.equal(r1.inserted, true);
      assert.equal(r2.inserted, true);
      assert.equal(s.listMessages(store.BROADCAST_PARTITION_ID).length, 2, 'both rows physically present, no collapse');
    } finally { s.close(); rm(home); }
  });

  // EASY-WIN FIX (Round 3 review): needsReply was added to messages by an
  // earlier wave but never added to meshMessageHash's hashed tuple. Two
  // messages identical in every OTHER hashed field but differing ONLY in
  // needsReply (e.g. a plain message and a `--question` message with
  // byte-identical body text at the exact same millisecond) must NOT collapse
  // under UNIQUE(hash)/journal dedupe — both must produce DISTINCT hashes and
  // both must be newly inserted.
  test(`[${B.name}] two messages identical except for needsReply produce DISTINCT hashes and both insert (do not dedupe-collapse)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      const base = { from: 'alice', to: 'bob', type: 'direct', message: 'same body', timestamp: 1000, urgency: 'normal' };
      const plain = Object.assign({}, base, { needsReply: false });
      const question = Object.assign({}, base, { needsReply: true });
      assert.notEqual(
        store.meshMessageHash(plain), store.meshMessageHash(question),
        'identical fields differing ONLY in needsReply must produce distinct hashes'
      );
      const r1 = store.appendMeshMessage(s, Object.assign({}, plain, { hash: store.meshMessageHash(plain) }));
      const r2 = store.appendMeshMessage(s, Object.assign({}, question, { hash: store.meshMessageHash(question) }));
      assert.equal(r1.inserted, true, 'the plain message must be newly inserted');
      assert.equal(r2.inserted, true, 'the question message must ALSO be newly inserted, not deduped away');
      assert.equal(s.messageCount('bob'), 2, 'both rows physically present, no collapse');
    } finally { s.close(); rm(home); }
  });

  // BACKWARD-COMPAT FIX (Fix Wave 4): the needsReply slot in meshMessageHash
  // must be CONDITIONAL (only appended when genuinely truthy), not
  // unconditional, so a PLAIN message's hash stays byte-identical to the
  // pre-needsReply-hashing format. foldGroupIntoSurvivor's idempotence
  // (INSERT OR IGNORE no-ops on a re-run) depends on recomputing the SAME
  // hash for the SAME logical fields across an anti-hall upgrade boundary —
  // an unconditional append would change every plain message's hash and
  // duplicate already-forwarded rows on the next post-upgrade fold.
  test(`[${B.name}] a plain message's hash is IDENTICAL to the pre-needsReply-hashing tuple format (byte-identical across the upgrade boundary)`, () => {
    const crypto = require('node:crypto');
    const base = { from: 'alice', to: 'bob', type: 'direct', message: 'same body', timestamp: 1000, urgency: 'normal' };
    // Hand-computed OLD format: the 6-field tuple joined with ' ', with NO
    // needsReply slot at all (what meshMessageHash produced before needsReply
    // was added to the hashed tuple).
    const oldParts = [base.from, base.to, base.type, base.urgency, base.message, String(base.timestamp)].join(' ');
    const oldHash = 'mesh:' + crypto.createHash('sha256').update(oldParts).digest('hex');
    assert.equal(store.meshMessageHash(base), oldHash, 'needsReply absent -> hash matches the pre-existing (no-needsReply-slot) format');
    assert.equal(
      store.meshMessageHash(Object.assign({}, base, { needsReply: false })),
      oldHash,
      'needsReply:false -> hash STILL matches the pre-existing format (false is "not a question", same as absent)'
    );
  });

  test(`[${B.name}] needsReply:false and needsReply:undefined (absent) hash IDENTICALLY — both mean "not a question"`, () => {
    const withFalse = { from: 'alice', to: 'bob', type: 'direct', message: 'x', timestamp: 1, urgency: 'normal', needsReply: false };
    const withUndefined = { from: 'alice', to: 'bob', type: 'direct', message: 'x', timestamp: 1, urgency: 'normal' };
    assert.equal(store.meshMessageHash(withFalse), store.meshMessageHash(withUndefined));
  });

  test(`[${B.name}] seq is monotonic across sends (direct + broadcast interleaved)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('a'));
      s.upsertRegistry(descriptor('b'));
      const seqs = [];
      const sends = [
        { from: 'a', to: 'b', type: 'direct', message: 'm1', timestamp: 1 },
        { from: 'b', to: null, type: 'broadcast', message: 'm2', timestamp: 2 },
        { from: 'a', to: 'b', type: 'direct', message: 'm3', timestamp: 3 },
        { from: 'a', to: null, type: 'broadcast', message: 'm4', timestamp: 4 },
      ];
      for (const f of sends) {
        const full = Object.assign({ urgency: 'normal' }, f);
        const r = store.appendMeshMessage(s, Object.assign({}, full, { hash: store.meshMessageHash(full) }));
        assert.equal(r.inserted, true);
        seqs.push(r.seq);
      }
      assert.deepEqual(seqs, [1, 2, 3, 4], 'a per-store global seq counter, monotonic across BOTH direct and broadcast rows');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] urgencyMax reflects the highest urgency among a workspace's PENDING directs`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      for (const [msg, urgency] of [['a', 'low'], ['b', 'normal'], ['c', 'high']]) {
        const f = { from: 'alice', to: 'bob', type: 'direct', message: msg, timestamp: 1, urgency };
        store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      }
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.bob.urgencyMax, 'high');

      // Acking (advancing the DIRECT cursor past all three) -> no pending directs -> null.
      s.setCursor('bob', 3);
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.bob.unread, 0);
      assert.equal(sum.workspaces.bob.urgencyMax, null, 'no pending directs -> urgencyMax is null, not a stale value');
    } finally { s.close(); rm(home); }
  });

  // ---------------------------------------------------------------------
  // broadcastUrgencyMax (v0.58 P1 fix) — the direct-only urgencyMax above
  // carries NO signal for an urgent broadcast; a stale child with only an
  // unread urgent broadcast (no direct message at all) could never wake the
  // supervisor. broadcastUrgencyMax closes that gap by reusing maxUrgencyOf
  // over unread NON-heartbeat broadcast rows, mirroring broadcastUnread's own
  // heartbeat exclusion (D22).
  // ---------------------------------------------------------------------
  test(`[${B.name}] broadcastUrgencyMax reflects the highest urgency among a workspace's UNREAD non-heartbeat broadcasts`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w2'));
      for (const [msg, urgency] of [['a', 'low'], ['b', 'normal'], ['c', 'high']]) {
        const f = { from: 'w1', to: null, type: 'broadcast', message: msg, timestamp: 1, urgency };
        store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      }
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w2.broadcastUrgencyMax, 'high');
      assert.equal(sum.workspaces.w2.urgencyMax, null, 'no PENDING DIRECTS -> urgencyMax stays null even though broadcasts are urgent');

      // w2 ACKs all three broadcasts (D23) -> no pending unread broadcasts -> null.
      s.advanceBroadcastCursor('w2');
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w2.broadcastUnread, 0);
      assert.equal(sum.workspaces.w2.broadcastUrgencyMax, null, 'no pending unread broadcasts -> broadcastUrgencyMax is null, not a stale value');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] broadcastUrgencyMax EXCLUDES heartbeats — an urgent heartbeat never counts, matching broadcastUnread's D22 exclusion`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w2'));
      // An urgent HEARTBEAT (mtype='broadcast' + is_heartbeat=1) -> must be excluded.
      const hb = { from: 'w1', to: null, type: 'broadcast', message: 'still working', timestamp: 1, urgency: 'urgent' };
      store.appendMeshMessage(s, Object.assign({}, hb, { hash: store.meshMessageHash(hb), isHeartbeat: true }));
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w2.broadcastUnread, 0, 'a heartbeat never counts toward broadcastUnread');
      assert.equal(sum.workspaces.w2.broadcastUrgencyMax, null, 'an urgent HEARTBEAT must never surface as broadcastUrgencyMax — it is a normal status ping, not an urgent signal');

      // A genuine (non-heartbeat) normal-urgency broadcast now DOES count, but stays non-urgent.
      const normal = { from: 'w1', to: null, type: 'broadcast', message: 'fyi', timestamp: 2, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, normal, { hash: store.meshMessageHash(normal) }));
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w2.broadcastUnread, 1);
      assert.equal(sum.workspaces.w2.broadcastUrgencyMax, 'normal');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] ALL SIX wire fields round-trip through appendMeshMessage -> store row -> deriveSummary projection`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      const wire = { from: 'alice', to: 'bob', type: 'direct', message: 'round trip me', timestamp: 424242, urgency: 'urgent' };
      const r = store.appendMeshMessage(s, Object.assign({}, wire, { hash: store.meshMessageHash(wire) }));
      assert.equal(r.inserted, true);

      // 1) the physical store row carries all six fields intact.
      const row = s.listMessages('bob')[0];
      assert.equal(row.sender, wire.from);
      assert.equal(row.recipient, wire.to);
      assert.equal(row.mtype, wire.type);
      assert.equal(row.body, wire.message);
      assert.equal(row.ts, wire.timestamp);
      assert.equal(row.urgency, wire.urgency);

      // 2) deriveSummary's projection is DERIVED from that intact row.
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.bob.unread, 1);
      assert.equal(sum.workspaces.bob.urgencyMax, 'urgent');

      // A broadcast heartbeat round-trips through recent[] too.
      const hb = { from: 'alice', to: null, type: 'broadcast', message: 'working on X', timestamp: 999, urgency: 'low' };
      store.appendMeshMessage(s, Object.assign({}, hb, { hash: store.meshMessageHash(hb), isHeartbeat: true }));
      const sum2 = store.deriveSummary(s, { home });
      const last = sum2.recent[sum2.recent.length - 1];
      assert.equal(last.from, hb.from);
      assert.equal(last.summary, hb.message);
      assert.equal(last.ts, hb.timestamp);
      assert.equal(last.urgency, hb.urgency);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a direct send to an UNREGISTERED recipient still lands physically (fail-closed addressing is a Phase-4/CLI concern, not this layer's)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const f = { from: 'alice', to: 'ghost', type: 'direct', message: 'hi', timestamp: 1, urgency: 'normal' };
      const r = store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      assert.equal(r.inserted, true);
      assert.equal(s.messageCount('ghost'), 1);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] old (pre-mesh) rows have NULL mesh columns and stay fully readable (backward compat)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      s.appendMessage({ workspaceId: 'w', body: 'legacy row', hash: 'legacy-h1' }); // the OLD append path, untouched by Phase 2
      const rows = s.listMessages('w');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].body, 'legacy row');
      assert.equal(rows[0].sender, null);
      assert.equal(rows[0].recipient, null);
      assert.equal(rows[0].mtype, null);
      assert.equal(rows[0].urgency, null);
      assert.equal(rows[0].isHeartbeat, false);
      assert.equal(rows[0].storeSeq, null, 'a legacy appendMessage row never gets a physical mesh seq');

      // deriveSummary still works: unread/urgencyMax degrade gracefully (no urgency -> null max).
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w.unread, 1);
      assert.equal(sum.workspaces.w.urgencyMax, null);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] the shared broadcast partition id is never projected as a real workspace`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      const f = { from: 'w', to: null, type: 'broadcast', message: 'x', timestamp: 1, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces[store.BROADCAST_PARTITION_ID], undefined, 'the broadcast partition never appears in workspaces{}');
      assert.deepEqual(Object.keys(sum.workspaces), ['w']);
    } finally { s.close(); rm(home); }
  });

  // ---- archive_requested (v0.58, PLAN.md STORE + child-gate) ----------------
  test(`[${B.name}] deriveSummary marks archive_requested:true when an UNREAD DIRECT row's body carries the archive-request marker`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-1'));
      const body = store.ARCHIVE_REQUEST_MARKER + ' milestone shipped — your parent asks you to archive this '
        + 'workspace; confirm with your user, then run devswarm.js archive <id>.';
      const f = { from: 'primary-abc', to: 'child-1', type: 'direct', message: body, timestamp: 1, urgency: 'high' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-1'].archive_requested, true);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] deriveSummary leaves archive_requested false for an ordinary unread direct message (no marker)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-2'));
      const f = { from: 'primary-abc', to: 'child-2', type: 'direct', message: 'just checking in', timestamp: 1, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-2'].archive_requested, false);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] archive_requested clears once the marker row is ACKed (cursor advanced past it — no longer unread)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-3'));
      const f = { from: 'primary-abc', to: 'child-3', type: 'direct', message: store.ARCHIVE_REQUEST_MARKER + ' go', timestamp: 1, urgency: 'high' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-3'].archive_requested, true, 'unread marker -> requested');
      s.setCursor('child-3', s.messageCount('child-3')); // ack-all
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-3'].archive_requested, false, 'acked -> no longer unread -> not requested');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a marker string inside a BROADCAST row never sets archive_requested on any workspace (mtype must be 'direct')`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w1'));
      const f = { from: 'w1', to: null, type: 'broadcast', message: store.ARCHIVE_REQUEST_MARKER + ' not really a request', timestamp: 1, urgency: 'high' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w1.archive_requested, false, 'a broadcast row can never set archive_requested — it never lands in a workspace direct partition');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a NATIVE-DRAINED (mtype-null) row containing the marker text never sets archive_requested (mesh-direct only)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-4'));
      s.appendMessage({ workspaceId: 'child-4', body: store.ARCHIVE_REQUEST_MARKER + ' looks like a request but is native', hash: 'native-h1' });
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-4'].archive_requested, false, 'native rows carry mtype:null, never direct — defense-in-depth, never a false positive');
    } finally { s.close(); rm(home); }
  });

  // ---- needsReply / pendingQuestions (devswarm parent decide+reply gate) ----
  test(`[${B.name}] needsReply threads through appendMeshMessage -> appendMeshRow -> listMessages`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      const f = { from: 'alice', to: 'bob', type: 'direct', message: 'what do I do?', timestamp: 1, urgency: 'normal', needsReply: true };
      const r = store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      assert.equal(r.inserted, true);
      const msgs = s.listMessages('bob');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].needsReply, true);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a row sent WITHOUT needsReply reads back needsReply:false (default, byte-identical for old readers)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('bob'));
      const f = { from: 'alice', to: 'bob', type: 'direct', message: 'fyi', timestamp: 1, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const msgs = s.listMessages('bob');
      assert.equal(msgs[0].needsReply, false);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a legacy (pre-needs_reply) row via the OLD appendMessage path reads back needsReply:false`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      s.appendMessage({ workspaceId: 'w', body: 'legacy row', hash: 'legacy-nr1' });
      const rows = s.listMessages('w');
      assert.equal(rows[0].needsReply, false, 'a legacy appendMessage row never gets needs_reply -> reads back false, not null/undefined');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] deriveSummary's pendingQuestions includes an unread DIRECT row flagged needsReply`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      // sender registered under a resolvable worktree (Part 2 fix — an
      // unresolvable sender is now DROPPED, not kept raw, so this test's
      // sender must actually resolve for the row to survive).
      const senderWorktree = '/wt/primary-abc-sender';
      const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
      s.upsertRegistry(descriptor('primary-abc', { worktreePath: senderWorktree }));
      s.upsertRegistry(descriptor('child-5'));
      const f = { from: senderMeshId, to: 'child-5', type: 'direct', message: 'which approach?', timestamp: 111, urgency: 'high', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-5'].pendingQuestions.length, 1);
      assert.equal(sum.workspaces['child-5'].pendingQuestions[0].from, 'primary-abc');
      assert.equal(sum.workspaces['child-5'].pendingQuestions[0].ts, 111);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] deriveSummary's pendingQuestions is [] for a plain DIRECT row (needsReply not set)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const senderWorktree = '/wt/primary-abc-sender-2';
      const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
      s.upsertRegistry(descriptor('primary-abc', { worktreePath: senderWorktree }));
      s.upsertRegistry(descriptor('child-6'));
      const f = { from: senderMeshId, to: 'child-6', type: 'direct', message: 'just checking in', timestamp: 1, urgency: 'normal' };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.deepEqual(sum.workspaces['child-6'].pendingQuestions, []);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] deriveSummary's pendingQuestions EXCLUDES a broadcast/heartbeat row even if needsReply were somehow set (mtype must be 'direct')`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w1'));
      const bc = { from: 'w1', to: null, type: 'broadcast', message: 'not a real question', timestamp: 1, urgency: 'high', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, bc, { hash: store.meshMessageHash(bc) }));
      const hb = { from: 'w1', to: null, type: 'broadcast', message: 'still working', timestamp: 2, urgency: 'normal', isHeartbeat: true, needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, hb, { hash: store.meshMessageHash(hb) }));
      const sum = store.deriveSummary(s, { home });
      assert.deepEqual(sum.workspaces.w1.pendingQuestions, [], 'a broadcast/heartbeat row is never a pendingQuestion, regardless of needsReply');
    } finally { s.close(); rm(home); }
  });

  // P0-A fix (devswarm-parent-decide-gate fix wave): pendingQuestions used to be
  // computed from unreadRows (cursor-scoped), so `inbox read-primary` acking the
  // cursor past the question row cleared it with ZERO reply ever sent — the exact
  // bug the whole feature exists to fix. pendingQuestions is now computed from
  // ALL of this workspace's messages ever marked needs_reply, so a bare read/ack
  // must NOT clear it — only a genuine reply (cross-referenced downstream by
  // devswarm-reply-state.js's unansweredQuestions, never inside computeSummary
  // itself) can.
  test(`[${B.name}] pendingQuestions STAYS populated after the question row is ACKed (cursor advanced past it) with no reply ever sent (P0-A fix)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      // sender registered under a resolvable worktree (Part 2 fix — an
      // unresolvable sender is now DROPPED, not kept raw).
      const senderWorktree = '/wt/primary-abc-sender-3';
      const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
      s.upsertRegistry(descriptor('primary-abc', { worktreePath: senderWorktree }));
      s.upsertRegistry(descriptor('child-7'));
      const f = { from: senderMeshId, to: 'child-7', type: 'direct', message: 'decide?', timestamp: 1, urgency: 'high', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-7'].pendingQuestions.length, 1, 'unread question -> pending');
      s.setCursor('child-7', s.messageCount('child-7')); // ack-all (READ, not REPLIED)
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-7'].pendingQuestions.length, 1, 'acked/read alone must NOT clear a pending question — only a genuine reply does');
      assert.equal(sum.workspaces['child-7'].pendingQuestions[0].from, 'primary-abc');
      assert.equal(sum.workspaces['child-7'].pendingQuestions[0].ts, 1);
      // A SECOND ack (already-acked, still unanswered) must not change anything either.
      s.setCursor('child-7', s.messageCount('child-7'));
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-7'].pendingQuestions.length, 1, 'a repeat ack still does not clear an unanswered question');
    } finally { s.close(); rm(home); }
  });

  // P0-B fix: a question row's `sender` is the sender's worktree-derived meshId
  // (callerIdentity()), but a reply's echoed `toId` (cmdSend/resolveSendTarget) is
  // the REGISTRY ROW id — NOT necessarily the same value. Every real child
  // registers under a DEVSWARM_BUILDER_ID different from its own derived meshId
  // (scripts/devswarm.js's cmdInboxMessages "v0.57 mesh (P0 fix)" commentary).
  // pendingQuestions[].from must resolve to the SAME registry-row-id identity
  // space toId already uses, so unansweredQuestions' q.from <-> replyState[toId]
  // comparison actually lines up.
  test(`[${B.name}] pendingQuestions[].from resolves to the sender's REGISTRY ROW id (not its raw meshId) when registered under a divergent DEVSWARM_BUILDER_ID`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const senderWorktree = '/wt/sender-divergent';
      const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
      const builderId = 'sess-builder-xyz'; // DEVSWARM_BUILDER_ID, deliberately != senderMeshId
      assert.notEqual(senderMeshId, builderId, 'sanity: the two identity spaces really do diverge');
      s.upsertRegistry(descriptor(builderId, { worktreePath: senderWorktree, sessionId: 'sess-live' }));
      s.upsertRegistry(descriptor('child-9'));

      const f = { from: senderMeshId, to: 'child-9', type: 'direct', message: 'which approach?', timestamp: 5, urgency: 'high', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));

      const sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces['child-9'].pendingQuestions.length, 1);
      assert.equal(sum.workspaces['child-9'].pendingQuestions[0].from, builderId,
        'from must be the REGISTRY ROW id (the exact identity space a reply\'s toId echo uses), not the raw sender meshId');
    } finally { s.close(); rm(home); }
  });

  // PERMANENT-DEADLOCK FIX (Round 2 review, supersedes the prior fix-wave's
  // "keep the original unresolved value" behavior asserted here before): a
  // sender that resolves to NO live registry row at all is a STRUCTURALLY
  // unresolvable identity — under the now-PERMANENT pendingQuestions
  // semantics (P0-A above), keeping such a row would create an UNCONDITIONAL,
  // never-clearing Stop-gate deadlock (send --to fails closed on an
  // unregistered recipient, so no reply can ever be recorded for it either).
  // The row is now DROPPED from the projection entirely instead.
  test(`[${B.name}] pendingQuestions EXCLUDES a row whose sender cannot be resolved to any registry row (permanent-deadlock fix — never included, not kept under the raw sender)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-10'));
      const f = { from: 'orphan-sender-no-registry-row', to: 'child-10', type: 'direct', message: 'decide?', timestamp: 9, urgency: 'normal', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.deepEqual(sum.workspaces['child-10'].pendingQuestions, [],
        'a structurally unresolvable sender must never appear in pendingQuestions (would deadlock forever)');
    } finally { s.close(); rm(home); }
  });

  // Bug 1b regression coverage: the SAME exclusion for a sender that was NEVER
  // registered at all (as opposed to registered-then-removed) — the more
  // common real-world shape (a child that was archived/deregistered, or whose
  // worktree no longer resolves) — proving no deadlock either way.
  test(`[${B.name}] pendingQuestions EXCLUDES a row whose sender was NEVER registered in this store at all`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('child-11')); // only the recipient is registered
      const f = { from: 'never-registered-sender', to: 'child-11', type: 'direct', message: 'decide?', timestamp: 11, urgency: 'normal', needsReply: true };
      store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
      const sum = store.deriveSummary(s, { home });
      assert.deepEqual(sum.workspaces['child-11'].pendingQuestions, [],
        'a never-registered sender must never appear in pendingQuestions');
    } finally { s.close(); rm(home); }
  });

}

// Small fix #3 (Round 2 review): resolveSenderRegistryId's same-updatedAt
// tie-break must match scripts/devswarm.js's resolveMeshTarget/meshCursorValue
// EXACTLY — a non-finite cursor read on ONE side must never veto a decisive
// comparison against a genuinely finite cursor on the other side (the prior
// mirror required BOTH sides finite before comparing at all, silently
// defaulting to "keep the first-seen row" whenever either side's cursor read
// was unreadable/non-finite, even when the other side was perfectly
// decisive). Exercised directly through computeSummary (a pure function of
// its `store` argument, per its own header) with a hand-built store double so
// two registry rows can be forced to an EXACT updatedAt tie and a controlled
// non-finite cursor read — not reliably reproducible through the timing of
// real upsertRegistry() calls.
test('resolveSenderRegistryId tie-break (via computeSummary): a finite cursor on one side beats a non-finite cursor on the other, even though BOTH being finite is no longer required', () => {
  const senderWorktree = '/wt/fake-tie-sender';
  const senderMeshId = inst.primaryWorkspaceId(senderWorktree);
  // rowA is encountered FIRST (becomes the initial bestLive) and its cursor
  // read is deliberately non-finite (simulating an unreadable cursor). rowB
  // is encountered SECOND, ties rowA's updatedAt exactly, and has a
  // genuinely finite, positive cursor value — under the FIXED coercion
  // (non-finite -> -1, compared unconditionally) rowB must win (3 > -1).
  // Under the OLD buggy code (`Number.isFinite(curVal) && Number.isFinite(bestVal)`)
  // the comparison would be skipped entirely (bestVal=NaN is not finite) and
  // rowA — the row with the WORSE, unreadable cursor — would wrongly survive.
  const registry = [
    { id: 'rowA', worktreePath: senderWorktree, sessionId: 'sess-live-a', updatedAt: 5000 },
    { id: 'rowB', worktreePath: senderWorktree, sessionId: 'sess-live-b', updatedAt: 5000 },
    { id: 'child-x', worktreePath: '/wt/child-x', sessionId: 'sess-child-x', updatedAt: 5000 },
  ];
  const messagesByWorkspace = {
    'child-x': [{ mtype: 'direct', needsReply: true, sender: senderMeshId, ts: 100, storeSeq: 1, body: 'q?' }],
  };
  const cursorValues = { rowA: NaN, rowB: 3, 'child-x': 0 };
  const fakeStore = {
    listMessages(id) {
      if (id === store.BROADCAST_PARTITION_ID) return [];
      return messagesByWorkspace[id] || [];
    },
    listRegistry() { return registry; },
    messageCount(id) { return (messagesByWorkspace[id] || []).length; },
    cursorValue(id) { return cursorValues[id]; },
    currentGates() { return {}; },
  };
  const home = tmpHome();
  try {
    const sum = store.computeSummary(fakeStore, { home });
    assert.equal(sum.workspaces['child-x'].pendingQuestions.length, 1);
    assert.equal(sum.workspaces['child-x'].pendingQuestions[0].from, 'rowB',
      'the row with the FINITE, decisive cursor must win the tie-break, even though the other side is non-finite');
  } finally { rm(home); }
});

// ---- broadcastCursorValue / setBroadcastCursor (direct handle API) --------
test('[journal] broadcastCursorValue defaults to 0; setBroadcastCursor is a direct set (distinct from advance)', () => {
  const home = tmpHome();
  const s = store.openStore({ home, backend: 'journal' });
  try {
    assert.equal(s.broadcastCursorValue('w'), 0);
    s.setBroadcastCursor('w', 5);
    assert.equal(s.broadcastCursorValue('w'), 5);
    s.setBroadcastCursor('w', -2); // clamped to 0
    assert.equal(s.broadcastCursorValue('w'), 0);
  } finally { s.close(); rm(home); }
});

// ---- sqlite-only: migration from a pre-mesh table shape --------------------
if (store.sqliteAvailable()) {
  test('[sqlite] ensureMessagesMeshColumns: an EXISTING pre-0.57 messages table (no mesh columns) is additively migrated, data preserved', () => {
    const home = tmpHome();
    try {
      // Build a store dir with a pre-mesh-shape messages table by hand (simulating
      // an on-disk store created by <=0.56).
      const { DatabaseSync } = require('node:sqlite');
      const dir = store.storeDirForHash(home, 'legacy01');
      fs.mkdirSync(dir, { recursive: true });
      const raw = new DatabaseSync(path.join(dir, 'devswarm.db'));
      raw.exec(
        'CREATE TABLE messages ('
        + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
        + ' workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, UNIQUE(hash)'
        + ');'
      );
      raw.prepare('INSERT INTO messages (workspace_id, ts, hash, body) VALUES (?, ?, ?, ?);')
        .run('w', 111, 'pre-existing', 'pre-existing body');
      raw.close();

      // Re-open via the mesh-aware openSqlite (hash-keyed, same dir) -> additive
      // ALTER TABLE, no data loss.
      const s = store.openSqlite(home, null, { hash: 'legacy01' });
      try {
        assert.equal(s.messageCount('w'), 1, 'the pre-existing row survives the migration');
        const rows = s.listMessages('w');
        assert.equal(rows[0].body, 'pre-existing body');
        assert.equal(rows[0].sender, null, 'the migrated-in column reads back null for an old row');

        // And a NEW mesh row can be appended into the now-migrated table.
        const f = { from: 'a', to: 'w', type: 'direct', message: 'new', timestamp: 222, urgency: 'normal' };
        const r = store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
        assert.equal(r.inserted, true);
        assert.equal(s.messageCount('w'), 2);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[sqlite] a two-process concurrent writer under busy_timeout does NOT throw SQLITE_BUSY (D6)', async () => {
    const home = tmpHome();
    try {
      const hash = 'contend1';
      // Pre-create the store dir so both workers open the SAME db file.
      store.openSqlite(home, null, { hash }).close();

      const worker = ''
        + 'const store = require(' + JSON.stringify(STORE_PATH) + ');'
        + "const s = store.openSqlite(" + JSON.stringify(home) + ", null, { hash: " + JSON.stringify(hash) + " });"
        + 'for (let i = 0; i < 40; i++) {'
        + '  const f = { from: process.pid + "-" + i, to: null, type: "broadcast", message: "m" + process.pid + "-" + i, timestamp: i, urgency: "normal" };'
        + '  const hash2 = store.meshMessageHash(f);'
        + '  store.appendMeshMessage(s, Object.assign({}, f, { hash: hash2 }));'
        + '}'
        + 's.close();';
      const [w1, w2] = await Promise.all([runNode(worker), runNode(worker)]);
      assert.equal(w1.exitCode, 0, 'worker 1 must not throw under writer contention: ' + w1.stderr);
      assert.equal(w2.exitCode, 0, 'worker 2 must not throw under writer contention: ' + w2.stderr);
      assert.ok(!/SQLITE_BUSY/.test(w1.stderr) && !/SQLITE_BUSY/.test(w2.stderr), 'busy_timeout must absorb contention, not surface SQLITE_BUSY');

      const s = store.openSqlite(home, null, { hash });
      try {
        assert.equal(s.listMessages(store.BROADCAST_PARTITION_ID).length, 80, 'all 80 rows from both concurrent writers landed');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  // Regression test for the windows-latest/node24 CI failure (v0.58 hardening
  // follow-up): busy_timeout alone bounds the wait WITHIN a single statement
  // attempt, but under sustained contention that per-statement wait can still
  // be exhausted (observed live: a two-process/40-write race threw "database
  // is locked", errcode 5, at appendMeshRow's stmt.run()). This test INJECTS a
  // deterministic SQLITE_BUSY by holding a real BEGIN IMMEDIATE write lock
  // from a second process for LONGER than the store's (deliberately tiny)
  // busyTimeoutMs, so the first attempt is GUARANTEED to exhaust its
  // busy_timeout and throw — proving the store's own outer retry (not just
  // sqlite's built-in per-statement wait) is what makes the write succeed.
  // Deterministic and platform-agnostic (no reliance on real-world race
  // timing like the D6 test above).
  test('[sqlite] appendMeshRow retries past an injected SQLITE_BUSY that outlasts busy_timeout, and still succeeds', async () => {
    const home = tmpHome();
    try {
      const hash = 'busyretry1';
      // Pre-create the store file so both the holder and the main process
      // open the SAME db file.
      store.openSqlite(home, null, { hash }).close();
      const dbPath = store.sqlitePathForHash(home, hash);
      const markerPath = path.join(home, 'holder-locked.marker');
      const HOLD_MS = 250; // longer than the store's busyTimeoutMs below (50ms)

      // Holder process: takes a real WAL write lock via BEGIN IMMEDIATE,
      // signals via a marker file once held, sleeps past HOLD_MS, then
      // releases. A real second OS process is used (not same-process
      // interleaving) since everything on one thread here is synchronous —
      // there is no way to hold a lock "in the background" within one thread.
      const holder = ''
        + 'const { DatabaseSync } = require("node:sqlite");'
        + 'const fs = require("fs");'
        + 'const db = new DatabaseSync(' + JSON.stringify(dbPath) + ');'
        + 'db.exec("PRAGMA busy_timeout = 3000;");'
        + 'db.exec("BEGIN IMMEDIATE;");'
        + 'fs.writeFileSync(' + JSON.stringify(markerPath) + ', "locked");'
        + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ' + HOLD_MS + ');'
        + 'db.exec("COMMIT;");'
        + 'db.close();';
      const holderPromise = runNode(holder);

      // Poll (bounded) for the holder's marker so the write lock is
      // GUARANTEED held before the main-process attempt below.
      const pollDeadline = Date.now() + 3000;
      while (!fs.existsSync(markerPath)) {
        if (Date.now() > pollDeadline) throw new Error('holder never signaled lock acquisition');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }

      // busyTimeoutMs (50ms) is deliberately far shorter than HOLD_MS (250ms):
      // the FIRST appendMeshRow attempt is guaranteed to exhaust its internal
      // busy_timeout wait and throw SQLITE_BUSY while the holder still has
      // the lock. Only the store's own retrySqliteBusy outer retry (not
      // sqlite's per-statement busy_timeout wait) can make this succeed.
      const s = store.openSqlite(home, null, { hash, busyTimeoutMs: 50 });
      try {
        const f = { from: 'injector', to: null, type: 'broadcast', message: 'past-the-lock', timestamp: 1, urgency: 'normal' };
        const r = store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
        assert.equal(r.inserted, true, 'the write must land once the injected lock is released, via the retry — not throw');
        assert.ok(Number.isFinite(r.seq), 'a real seq is assigned once the retried insert succeeds');

        const rows = s.listMessages(store.BROADCAST_PARTITION_ID);
        assert.ok(rows.some((row) => row.body === 'past-the-lock'), 'the retried row is actually persisted, not just reported inserted');
      } finally { s.close(); }

      const holderResult = await holderPromise;
      assert.equal(holderResult.exitCode, 0, 'holder process must exit cleanly: ' + holderResult.stderr);
    } finally { rm(home); }
  });
}

// ---- listStoreHashes (D20 — repoKey-shape extension) -----------------------
test('listStoreHashes: legacy 8-hex AND repoKey-shaped dirs both enumerate by default; {shape:"legacy"} restricts to 8-hex only', () => {
  const home = tmpHome();
  try {
    const root = store.storeRootDir(home);
    fs.mkdirSync(path.join(root, 'aaaaaaaa'), { recursive: true }); // legacy 8-hex
    fs.mkdirSync(path.join(root, 'anti-hall-a1b2c3'), { recursive: true }); // repoKey shape
    fs.mkdirSync(path.join(root, 'not-a-store-dir'), { recursive: true }); // neither shape -> excluded
    fs.mkdirSync(path.join(root, 'zzzzzzzzz'), { recursive: true }); // 9 hex-like chars -> not legacy shape

    const all = store.listStoreHashes(home).sort();
    assert.deepEqual(all, ['aaaaaaaa', 'anti-hall-a1b2c3'].sort());

    const legacyOnly = store.listStoreHashes(home, null, { shape: 'legacy' });
    assert.deepEqual(legacyOnly, ['aaaaaaaa']);
  } finally { rm(home); }
});

test('listStoreHashes: missing store/ root -> [] (fail-open)', () => {
  const home = tmpHome();
  try {
    assert.deepEqual(store.listStoreHashes(home), []);
  } finally { rm(home); }
});

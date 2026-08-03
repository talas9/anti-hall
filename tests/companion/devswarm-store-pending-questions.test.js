'use strict';
// devswarm-store: listNeedsReply (the pushed-down needs_reply read) + the
// pendingQuestions PER-SENDER COLLAPSE and its backstop cap.
//
// TWO LINKED FIXES, both in computeSummary:
//
//  (a) PERF. pendingQuestions is DELIBERATELY not cursor-scoped (cursor-scoping it
//      WAS the original bug), so it needed EVERY row of a workspace's history on
//      EVERY projection, for EVERY registry row — `store.listMessages(d.id)`, full
//      history, all columns, all materialized. Replaced by a dedicated backend
//      method `listNeedsReply(id)` that filters in the backend and emits only
//      {sender, ts, storeSeq}. The RESULT must be identical to the old expression
//      on BOTH backends — that equivalence is what these tests pin.
//
//  (b) BOUNDING. The array grew without limit for the life of a project. The fix is
//      a per-sender collapse to the maximum-ts entry, which is LOSSLESS for the
//      blocking decision: devswarm-reply-state.js's unansweredQuestions keeps q
//      where `effTs(q) > replyState[q.from].lastReplyTs`, and for a FIXED sender
//      lastReplyTs is a SINGLE value, so "S has an unanswered question" is exactly
//      "S's max-effTs question is unanswered". The property test below is the real
//      statement of that claim; a naive tail-slice would fail it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const { unansweredQuestions } = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-pendingq-'));
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

// THE PRE-FIX EXPRESSION, verbatim from computeSummary before this change. Every
// equivalence assertion below compares listNeedsReply against THIS, not against a
// re-derivation of what listNeedsReply "should" return.
function oldFilter(s, id) {
  return s.listMessages(id)
    .filter((r) => r && r.mtype === 'direct' && r.needsReply)
    .map((r) => ({ sender: r.sender, ts: r.ts, storeSeq: r.storeSeq }));
}

// registerSender(s, regId, k) — register `regId` under a worktree path whose
// primaryWorkspaceId is the meshId a question row must carry for
// resolveSenderRegistryId to resolve it back to `regId`. An UNRESOLVABLE sender is
// dropped from pendingQuestions entirely (the permanent-deadlock fix), so every
// sender in these tests must genuinely resolve.
function registerSender(s, regId, worktree) {
  s.upsertRegistry(descriptor(regId, { worktreePath: worktree }));
  return inst.primaryWorkspaceId(worktree);
}

function ask(s, fromMeshId, to, ts, body) {
  const f = {
    from: fromMeshId, to, type: 'direct',
    message: body != null ? body : ('q@' + ts),
    timestamp: ts, urgency: 'normal', needsReply: true,
  };
  return store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

// ---------------------------------------------------------------------------
// 1. listNeedsReply: cross-backend PARITY on identically-seeded data.
// ---------------------------------------------------------------------------
test('listNeedsReply returns IDENTICAL results on the sqlite and journal backends', (t) => {
  if (!store.sqliteAvailable()) return t.skip('node:sqlite unavailable — no second backend to compare against');
  const seed = (s) => {
    s.upsertRegistry(descriptor('w'));
    const a = registerSender(s, 'A', '/wt/sender-a');
    const b = registerSender(s, 'B', '/wt/sender-b');
    ask(s, a, 'w', 100);
    ask(s, b, 'w', 200);
    // not a question (needsReply absent) -> must NOT appear
    const plain = { from: a, to: 'w', type: 'direct', message: 'fyi', timestamp: 300, urgency: 'normal' };
    store.appendMeshMessage(s, Object.assign({}, plain, { hash: store.meshMessageHash(plain) }));
    // a needs_reply row that is NOT mtype 'direct' -> must NOT appear
    s.appendMeshRow({
      workspaceId: 'w', ts: 400, hash: 'nd-1', body: 'broadcast-shaped', sender: a,
      recipient: null, mtype: 'broadcast', urgency: 'normal', isHeartbeat: false, needsReply: true,
    });
    // a legacy row (mtype null) -> must NOT appear
    s.appendMessage({ workspaceId: 'w', body: 'legacy', hash: 'legacy-1' });
    ask(s, a, 'w', 500);
  };
  const results = {};
  for (const backend of ['journal', 'sqlite']) {
    const home = tmpHome();
    const s = store.openStore({ home, backend });
    try { seed(s); results[backend] = s.listNeedsReply('w'); } finally { s.close(); rm(home); }
  }
  assert.deepStrictEqual(results.journal, results.sqlite, 'the two backends must project the same needs_reply set');
  assert.equal(results.journal.length, 3, 'exactly the three direct+needsReply rows');
  assert.deepStrictEqual(results.journal.map((r) => r.ts), [100, 200, 500], 'insertion order preserved');
});

// ---------------------------------------------------------------------------
// 1b. listNeedsReply: ts NORMALIZATION parity (P2 cross-backend divergence).
//     Pre-fix, sqlite did `ts: Number(rows[i].ts)` (a non-finite/absent ts on
//     disk becomes NaN) while the journal did `Number.isFinite(row.ts) ?
//     row.ts : null` — identical logical data read back as NaN vs null. This
//     never affected BLOCKING (pendingQuestionEffTs maps both to Infinity)
//     and never affected the ON-DISK summary (JSON.stringify flattens NaN to
//     null anyway), but an IN-MEMORY consumer comparing the two backends'
//     listNeedsReply output directly would see them diverge for the same row.
//
//     A bad ts can only reach the STORE this way by being poked in directly:
//     appendMeshRow's own write-time normalization on BOTH backends
//     (`Number.isFinite(m.ts) ? m.ts : Date.now()`) already forbids writing a
//     non-finite/absent ts through the normal API, so this simulates a
//     legacy/pre-migration or torn-write row that already has a bad ts on
//     disk — same rationale as the dup-hash raw-poke test above.
// ---------------------------------------------------------------------------
test('[journal+sqlite] listNeedsReply normalizes a non-finite on-disk ts to null on BOTH backends', (t) => {
  if (!store.sqliteAvailable()) return t.skip('node:sqlite unavailable — no second backend to compare against');

  // NON-FINITE — a literal garbage string in the ts column/field. Both
  // backends can represent this (sqlite's `ts INTEGER NOT NULL` has type
  // AFFINITY, not strict typing, so a non-numeric TEXT value still satisfies
  // NOT NULL), so this case is a true cross-backend parity assertion.
  const results = {};
  for (const backend of ['journal', 'sqlite']) {
    const home = tmpHome();
    if (backend === 'journal') {
      const file = path.join(store.journalDir(home, null), 'messages.ndjson');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({
        workspaceId: 'w', ts: 'garbage', hash: 'bad-ts-nf', body: 'q', sender: 'A',
        recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: true, seq: 500,
      }) + '\n');
    } else {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = store.sqlitePath(home, null);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec(
          'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,'
          + ' workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT,'
          + ' sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER,'
          + ' needs_reply INTEGER, seq INTEGER, UNIQUE(hash));'
        );
        raw.prepare(
          'INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, seq)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);'
        ).run('w', 'garbage', 'bad-ts-nf', 'q', 'A', 'w', 'direct', 'normal', 0, 1, 500);
      } finally { raw.close(); }
    }
    const s = store.openStore({ home, backend });
    try { results[backend] = s.listNeedsReply('w'); } finally { s.close(); rm(home); }
  }
  assert.deepStrictEqual(results.journal, results.sqlite, 'a non-finite on-disk ts must normalize identically on both backends');
  assert.deepStrictEqual(results.journal, [{ sender: 'A', ts: null, storeSeq: 500 }], 'non-finite ts -> null, never NaN');

  // ABSENT — no `ts` key at all. Journal-only by construction: it is
  // schemaless (a pre-migration or torn-write legacy row can genuinely omit
  // the field), while sqlite's `ts INTEGER NOT NULL` column makes this shape
  // impossible to represent on that backend at all (the non-finite case above
  // is therefore the only bad-ts shape sqlite's schema can produce, and is
  // already covered by the parity assertion above).
  const home2 = tmpHome();
  const file2 = path.join(store.journalDir(home2, null), 'messages.ndjson');
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.appendFileSync(file2, JSON.stringify({
    workspaceId: 'w', hash: 'bad-ts-absent', body: 'q', sender: 'A',
    recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: true, seq: 501,
    // `ts` deliberately omitted
  }) + '\n');
  const s2 = store.openStore({ home: home2, backend: 'journal' });
  try {
    assert.deepStrictEqual(s2.listNeedsReply('w'), [{ sender: 'A', ts: null, storeSeq: 501 }], 'absent ts -> null');
  } finally { s2.close(); rm(home2); }
});

// ---------------------------------------------------------------------------
// 2. listNeedsReply === the OLD listMessages filter expression, per backend.
// ---------------------------------------------------------------------------
for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  test(`[${B.name}] listNeedsReply is equivalent to the OLD listMessages(...).filter expression`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      const a = registerSender(s, 'A', '/wt/sender-a');
      const b = registerSender(s, 'B', '/wt/sender-b');
      ask(s, a, 'w', 10);
      s.appendMeshRow({ // non-direct + needs_reply
        workspaceId: 'w', ts: 20, hash: 'x-1', body: 'bc', sender: b,
        recipient: null, mtype: 'broadcast', urgency: 'high', isHeartbeat: false, needsReply: true,
      });
      s.appendMeshRow({ // direct WITHOUT needs_reply
        workspaceId: 'w', ts: 30, hash: 'x-2', body: 'chat', sender: b,
        recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: false,
      });
      s.appendMessage({ workspaceId: 'w', body: 'legacy', hash: 'x-3' }); // mtype null
      ask(s, b, 'w', 40);
      // a different workspace's question must never leak in
      s.upsertRegistry(descriptor('other'));
      ask(s, a, 'other', 50);
      assert.deepStrictEqual(s.listNeedsReply('w'), oldFilter(s, 'w'));
      assert.deepStrictEqual(s.listNeedsReply('other'), oldFilter(s, 'other'));
      assert.deepStrictEqual(s.listNeedsReply('nope'), [], 'unknown partition -> empty, never a throw');
    } finally { s.close(); rm(home); }
  });
}

// Duplicate-hash rows are journal-only by construction: sqlite has UNIQUE(hash) and
// appendMeshRow's journal path refuses to append a hash it already has, so a genuine
// duplicate can only reach the file the way a legacy/racy write would — by being in
// the NDJSON already. listNeedsReply must fold it with the SAME rule listMessages
// uses (dedupe by hash over ALL of the workspace's rows, FIRST occurrence wins,
// BEFORE the predicate), which is exactly the end state sqlite's UNIQUE(hash) has.
test('[journal] listNeedsReply applies listMessages\' hash-dedup rule (first occurrence wins, applied BEFORE the predicate)', () => {
  const home = tmpHome();
  const s = store.openStore({ home, backend: 'journal' });
  try {
    s.upsertRegistry(descriptor('w'));
    const a = registerSender(s, 'A', '/wt/sender-a');
    ask(s, a, 'w', 10);
    const file = path.join(store.journalDir(home, null), 'messages.ndjson');
    // Same hash 'dup-1' twice: the FIRST is NOT a question, the SECOND is. Dedup
    // BEFORE the predicate -> the second is dropped and NEITHER appears. Filtering
    // first would wrongly surface the second.
    fs.appendFileSync(file, JSON.stringify({
      workspaceId: 'w', ts: 20, hash: 'dup-1', body: 'first', sender: a,
      recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: false, seq: 90,
    }) + '\n');
    fs.appendFileSync(file, JSON.stringify({
      workspaceId: 'w', ts: 21, hash: 'dup-1', body: 'second', sender: a,
      recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: true, seq: 91,
    }) + '\n');
    // Same hash 'dup-2' twice where BOTH are questions -> exactly ONE survives.
    for (const ts of [30, 31]) {
      fs.appendFileSync(file, JSON.stringify({
        workspaceId: 'w', ts, hash: 'dup-2', body: 'q', sender: a,
        recipient: 'w', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: true, seq: 92,
      }) + '\n');
    }
    const got = s.listNeedsReply('w');
    assert.deepStrictEqual(got, oldFilter(s, 'w'), 'dedup must be computed identically to listMessages');
    assert.deepStrictEqual(got.map((r) => r.ts), [10, 30], 'dup-1 fully suppressed (first occurrence not a question); dup-2 kept once');
  } finally { s.close(); rm(home); }
});

// ---------------------------------------------------------------------------
// 3. Per-sender collapse: MAX-ts survives; occurrences/firstTs/lastTs appear ONLY
//    on an actually-collapsed entry (byte-identical output when nothing collapses).
// ---------------------------------------------------------------------------
for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  test(`[${B.name}] collapse keeps the MAX-ts entry per sender and carries occurrences/firstTs/lastTs`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      const a = registerSender(s, 'A', '/wt/sender-a');
      const b = registerSender(s, 'B', '/wt/sender-b');
      ask(s, a, 'w', 100);
      ask(s, a, 'w', 300); // newest for A
      ask(s, a, 'w', 200);
      ask(s, b, 'w', 150); // B asked exactly once
      const pq = store.computeSummary(s, { home }).workspaces.w.pendingQuestions;
      assert.equal(pq.length, 2, 'one entry per sender, not one per question');
      const [qa, qb] = pq;
      assert.equal(qa.from, 'A');
      assert.equal(qa.ts, 300, 'the MAXIMUM ts survives, not the first or the last-inserted');
      assert.equal(qa.occurrences, 3);
      assert.equal(qa.firstTs, 100);
      assert.equal(qa.lastTs, 300);
      // The uncollapsed entry must be BYTE-IDENTICAL to the pre-fix shape: {from, ts, seq}
      // and nothing else. A stray occurrences/firstTs/lastTs here would change the
      // projection for every existing reader of a healthy, no-repeat summary.
      assert.deepStrictEqual(Object.keys(qb).sort(), ['from', 'seq', 'ts']);
      assert.equal(qb.from, 'B');
      assert.equal(qb.ts, 150);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] a projection where no sender repeats is byte-identical to the pre-collapse output`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      const a = registerSender(s, 'A', '/wt/sender-a');
      const b = registerSender(s, 'B', '/wt/sender-b');
      ask(s, a, 'w', 100);
      ask(s, b, 'w', 200);
      const rows = s.listNeedsReply('w'); // the pre-collapse set, in insertion order
      const expected = [
        { from: 'A', ts: rows[0].ts, seq: rows[0].storeSeq },
        { from: 'B', ts: rows[1].ts, seq: rows[1].storeSeq },
      ];
      assert.deepStrictEqual(store.computeSummary(s, { home }).workspaces.w.pendingQuestions, expected);
    } finally { s.close(); rm(home); }
  });
}

// ---------------------------------------------------------------------------
// 4. BLOCKING-EQUIVALENCE PROPERTY TEST — the core correctness claim.
//    Over many randomized question sets and reply-states:
//      unansweredQuestions(COLLAPSED) is non-empty  <=>  unansweredQuestions(FULL) is non-empty
//    and, per sender, the two agree on whether that sender still blocks.
//    The collapse must also ACTUALLY collapse (else the property is vacuous).
// ---------------------------------------------------------------------------
// Deterministic LCG so a failing case is reproducible from its seed.
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

test('PROPERTY: unansweredQuestions over the COLLAPSED list blocks iff it blocks over the FULL list', () => {
  const CASES = 120;
  let collapsedSomewhere = 0;
  for (let c = 0; c < CASES; c++) {
    const rnd = lcg(0xC0FFEE + c * 7919);
    const home = tmpHome();
    const s = store.openStore({ home, backend: 'journal' });
    try {
      s.upsertRegistry(descriptor('w'));
      const senderCount = 1 + Math.floor(rnd() * 4);
      const meshIds = [];
      const regIds = [];
      for (let k = 0; k < senderCount; k++) {
        const regId = 'S' + k;
        regIds.push(regId);
        meshIds.push(registerSender(s, regId, '/wt/case' + c + '-sender' + k));
      }
      // Random questions. Timestamps are drawn from a small range so ties (and
      // therefore the storeSeq tiebreak) actually occur.
      const questionCount = 1 + Math.floor(rnd() * 12);
      for (let q = 0; q < questionCount; q++) {
        const k = Math.floor(rnd() * senderCount);
        ask(s, meshIds[k], 'w', 1000 + Math.floor(rnd() * 8) * 10, 'c' + c + '-q' + q);
      }
      // The FULL (pre-collapse) list, built by the pre-fix expression + the same
      // sender resolution the projection uses (here identity: regId per meshId).
      const meshToReg = new Map(meshIds.map((m, i) => [m, regIds[i]]));
      const full = s.listNeedsReply('w').map((r) => ({ from: meshToReg.get(r.sender), ts: r.ts, seq: r.storeSeq }));
      const collapsed = store.computeSummary(s, { home }).workspaces.w.pendingQuestions;
      if (collapsed.length < full.length) collapsedSomewhere++;

      // Random reply-state: some senders replied at a random ts, some never.
      for (let trial = 0; trial < 6; trial++) {
        const replyState = {};
        for (const regId of regIds) {
          if (rnd() < 0.7) replyState[regId] = { lastReplyTs: 1000 + Math.floor(rnd() * 9) * 10 };
        }
        const uFull = unansweredQuestions(full, replyState);
        const uColl = unansweredQuestions(collapsed, replyState);
        const ctx = 'case ' + c + ' trial ' + trial + ' state=' + JSON.stringify(replyState)
          + ' full=' + JSON.stringify(full) + ' collapsed=' + JSON.stringify(collapsed);
        assert.equal(uColl.length > 0, uFull.length > 0, 'blocking decision must match — ' + ctx);
        // Stronger than the top-level iff: the SET OF BLOCKING SENDERS must match too,
        // so the gate names the same children as still-owing a reply.
        const setOf = (list) => Array.from(new Set(list.map((q) => q.from))).sort();
        assert.deepStrictEqual(setOf(uColl), setOf(uFull), 'blocking sender set must match — ' + ctx);
      }
    } finally { s.close(); rm(home); }
  }
  // Guard against a vacuous property: if the collapse never fired, the assertions
  // above compared a list to itself and proved nothing.
  assert.ok(collapsedSomewhere > CASES / 4,
    'the generated cases must actually exercise the collapse (collapsed in ' + collapsedSomewhere + '/' + CASES + ')');
});

// ---------------------------------------------------------------------------
// 5. Backstop cap: truncates to the OLDEST entries and ALWAYS surfaces a signal.
// ---------------------------------------------------------------------------
test('the backstop cap keeps the OLDEST entries and sets the truncation signal', () => {
  const home = tmpHome();
  const s = store.openStore({ home, backend: 'journal' });
  try {
    s.upsertRegistry(descriptor('w'));
    // Five DISTINCT senders (the collapse cannot fold them), asking in ts order so
    // first-appearance order == oldest-first.
    for (let k = 0; k < 5; k++) {
      const mesh = registerSender(s, 'S' + k, '/wt/cap-sender-' + k);
      ask(s, mesh, 'w', 1000 + k * 10);
    }
    const uncapped = store.computeSummary(s, { home }).workspaces.w;
    assert.equal(uncapped.pendingQuestions.length, 5);
    assert.equal(uncapped.pendingQuestionsTruncated, undefined,
      'no truncation -> no signal field at all (byte-identical for existing readers)');

    const ws = store.computeSummary(s, { home, pendingQuestionsCap: 2 }).workspaces.w;
    assert.deepStrictEqual(ws.pendingQuestions.map((q) => q.from), ['S0', 'S1'],
      'truncation keeps the OLDEST (most overdue) entries, never the newest');
    assert.deepStrictEqual(ws.pendingQuestionsTruncated, { cap: 2, kept: 2, dropped: 3 });
  } finally { s.close(); rm(home); }
});

// ---------------------------------------------------------------------------
// 6. computeSummary still works against a PARTIAL store double that has no
//    listNeedsReply — the fallback to the old listMessages path.
// ---------------------------------------------------------------------------
test('computeSummary falls back to the listMessages filter when the handle has no listNeedsReply', () => {
  const home = tmpHome();
  const s = store.openStore({ home, backend: 'journal' });
  try {
    s.upsertRegistry(descriptor('w'));
    const a = registerSender(s, 'A', '/wt/sender-a');
    ask(s, a, 'w', 100);
    ask(s, a, 'w', 250);
    const withMethod = store.computeSummary(s, { home }).workspaces.w.pendingQuestions;
    // A double that predates listNeedsReply: every other method delegates.
    const legacy = Object.create(null);
    for (const k of ['hash', 'workspaceId', 'backend']) legacy[k] = s[k];
    for (const k of ['listMessages', 'listRegistry', 'messageCount', 'cursorValue', 'currentGates',
      'broadcastCursorValue', 'listWorkspaceIds']) legacy[k] = (...a2) => s[k](...a2);
    const withoutMethod = store.computeSummary(legacy, { home }).workspaces.w.pendingQuestions;
    assert.deepStrictEqual(withoutMethod, withMethod, 'the fallback must produce the identical projection');
  } finally { s.close(); rm(home); }
});

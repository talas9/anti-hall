'use strict';
// recent[] CONSECUTIVE-duplicate run collapse (devswarm-store.js computeSummary).
//
// THE BUG (measured): an idle child re-emits a BYTE-IDENTICAL heartbeat every
// turn. 1182 identical broadcast rows from ONE sender over 5.25 days filled 49
// of the 50 recent[] slots, EVICTING every genuine broadcast. meshMessageHash()
// includes the timestamp so identical bodies never collide on UNIQUE(hash), and
// isNoiseText() only matches the literal '[Primary poke]' prefix.
//
// THE FIX is PROJECTION-ONLY: consecutive rows that project identically
// (from, summary, urgency) fold into one entry carrying occurrences/firstTs/
// lastTs, BEFORE the recentCap slice is applied.
//
// LIVENESS IS THE HARD CONSTRAINT. devswarm-child-gate.js:alreadyReportedThisEpisode
// asks `recent.some(r.from === id && r.ts >= episodeSince)`. These tests pin BOTH
// directions: the collapse must never let a wedged session look fresh, and must
// never hide a genuine in-episode report.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-recent-collapse-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// bcast(s, from, body, ts, opts) — append ONE broadcast row. Distinct `ts` values
// yield distinct hashes (meshMessageHash includes the timestamp), which is
// precisely why byte-identical heartbeats all persist as separate rows.
function bcast(s, from, body, ts, opts) {
  const o = opts || {};
  const f = {
    from, to: null, type: 'broadcast', message: body, timestamp: ts,
    urgency: o.urgency != null ? o.urgency : null,
  };
  return store.appendMeshMessage(s, Object.assign({}, f, {
    hash: store.meshMessageHash(f),
    isHeartbeat: o.isHeartbeat !== false,
  }));
}

// EXACT predicate from devswarm-child-gate.js:166 (alreadyReportedThisEpisode).
// Replicated verbatim so these tests fail if the collapse ever changes what that
// Stop-gate check observes.
function alreadyReported(recent, id, episodeSince) {
  return recent.some((r) => r && r.from === id && Number.isFinite(r.ts) && r.ts >= episodeSince);
}

// The PRE-FIX projection: last `cap` RAW rows, no collapse. Used to prove the
// eviction was real and to compare gate behavior before/after.
function rawRecent(s, cap) {
  return s.listMessages(store.BROADCAST_PARTITION_ID).slice(-cap).map((r) => ({
    from: r.sender != null ? r.sender : null,
    summary: r.body != null ? r.body : '',
    ts: r.ts,
    urgency: r.urgency != null ? r.urgency : null,
  }));
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  // ---- 1. THE BUG + THE FIX: duplicates no longer evict genuine broadcasts ----
  test(`[${B.name}] duplicate heartbeats collapse and STOP evicting genuine broadcasts`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      bcast(s, 'w2', 'shipped phase 1', 1000, { isHeartbeat: false });
      bcast(s, 'w2', 'shipped phase 2', 1001, { isHeartbeat: false });
      bcast(s, 'w2', 'shipped phase 3', 1002, { isHeartbeat: false });
      for (let i = 0; i < 60; i++) bcast(s, 'w1', 'idle — resting', 2000 + i);

      // The bug is REAL on the pre-fix projection: the last 50 raw rows are all
      // w1 duplicates, so every genuine w2 broadcast is evicted.
      const before = rawRecent(s, 50);
      assert.equal(before.length, 50);
      assert.equal(before.filter((r) => r.from === 'w2').length, 0, 'PRE-FIX: genuine broadcasts evicted by duplicate noise');

      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 50 });
      const recent = sum.recent;

      assert.equal(recent.length, 4, '3 distinct w2 rows + 1 collapsed w1 run');
      assert.equal(recent.filter((r) => r.from === 'w2').length, 3, 'FIXED: all genuine broadcasts survive');
      const run = recent[recent.length - 1];
      assert.equal(run.from, 'w1');
      assert.equal(run.summary, 'idle — resting');
      assert.equal(run.occurrences, 60, '60 identical rows surface as ONE entry with a bounded count');
      assert.equal(run.firstTs, 2000);
      assert.equal(run.lastTs, 2059);
      assert.equal(run.ts, 2059, 'ts IS the newest of the run');
    } finally { s.close(); rm(home); }
  });

  // ---- 2. ts semantics: never synthesized, never bumped ----
  test(`[${B.name}] a collapsed entry's ts is always a REAL ts from a real row of that run`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const tsList = [];
      for (let i = 0; i < 12; i++) { const t = 5000 + i * 285; tsList.push(t); bcast(s, 'w1', 'same body', t); }
      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 50 });
      assert.equal(sum.recent.length, 1);
      const e = sum.recent[0];
      assert.equal(e.ts, Math.max.apply(null, tsList), 'ts == run MAX');
      assert.equal(e.firstTs, Math.min.apply(null, tsList), 'firstTs == run MIN');
      assert.equal(e.lastTs, e.ts);
      assert.ok(tsList.indexOf(e.ts) !== -1, 'ts is a ts an actual row carried — nothing synthesized');

      // Global invariant: EVERY ts in recent[] exists among the raw rows.
      const realTs = new Set(s.listMessages(store.BROADCAST_PARTITION_ID).map((r) => r.ts));
      for (const r of sum.recent) assert.ok(realTs.has(r.ts), 'no invented timestamps in recent[]');
    } finally { s.close(); rm(home); }
  });

  // ---- 3. LIVENESS (the dangerous direction): a wedged session STAYS dead ----
  test(`[${B.name}] LIVENESS: collapsing duplicates can NEVER make a stale sender look fresh`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      // 40 identical heartbeats, ALL of them old (newest ts 4000).
      for (let i = 0; i < 40; i++) bcast(s, 'wedged', 'still working on it', 1000 + i * 75);
      const newestReal = 1000 + 39 * 75; // 3925
      const episodeSince = 9000;         // episode began long AFTER the last row

      const sum = store.computeSummary(s, { home, now: 99999, recentCap: 50 });
      assert.equal(sum.recent.length, 1, 'the 40 duplicates collapsed to one entry');
      assert.equal(sum.recent[0].ts, newestReal);
      assert.ok(sum.recent[0].ts < episodeSince, 'the survivor is still OLDER than the episode start');

      assert.equal(alreadyReported(sum.recent, 'wedged', episodeSince), false,
        'REGRESSION GUARD: a wedged session must remain unable to satisfy the Stop-gate');
      // ...and that verdict is IDENTICAL to the pre-fix projection's.
      assert.equal(alreadyReported(rawRecent(s, 50), 'wedged', episodeSince), false);
    } finally { s.close(); rm(home); }
  });

  // ---- 4. LIVENESS (the safe direction): a genuine in-episode report still counts ----
  test(`[${B.name}] LIVENESS: an in-episode report still satisfies the gate after collapse`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      for (let i = 0; i < 30; i++) bcast(s, 'w1', 'heartbeat body', 7000 + i);
      const sum = store.computeSummary(s, { home, now: 99999, recentCap: 50 });
      // episodeSince == the newest row's ts: the boundary case the gate relies on.
      assert.equal(alreadyReported(sum.recent, 'w1', 7029), true, 'newest row is retained, gate satisfied');
      assert.equal(alreadyReported(sum.recent, 'w1', 7030), false, 'one ms past the newest row -> not reported');
    } finally { s.close(); rm(home); }
  });

  // ---- 5. LIVENESS: the collapse REDUCES false silence (evicted report recovered) ----
  test(`[${B.name}] LIVENESS: a genuine report evicted by duplicate noise is RECOVERED, not invented`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const episodeSince = 1000;
      bcast(s, 'w2', 'reported: phase A done', 1500, { isHeartbeat: false }); // genuine, in-episode
      for (let i = 0; i < 60; i++) bcast(s, 'w1', 'idle — resting', 2000 + i);

      // PRE-FIX: w2's real report was evicted -> the gate saw FALSE SILENCE.
      assert.equal(alreadyReported(rawRecent(s, 50), 'w2', episodeSince), false, 'PRE-FIX false silence confirmed');
      // POST-FIX: it is visible again. Its ts is its ORIGINAL 1500 — recovered, not bumped.
      const sum = store.computeSummary(s, { home, now: 99999, recentCap: 50 });
      assert.equal(alreadyReported(sum.recent, 'w2', episodeSince), true, 'the real report is visible again');
      const w2 = sum.recent.find((r) => r.from === 'w2');
      assert.equal(w2.ts, 1500, 'recovered with its ORIGINAL ts — never advanced');
      assert.equal(w2.occurrences, undefined, 'a single row is not marked as a collapsed run');
      // And it still cannot fake freshness for a LATER episode.
      assert.equal(alreadyReported(sum.recent, 'w2', 1501), false);
    } finally { s.close(); rm(home); }
  });

  // ---- 6. only CONSECUTIVE runs merge ----
  test(`[${B.name}] non-consecutive identical bodies do NOT merge`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      bcast(s, 'w1', 'A', 100);
      bcast(s, 'w2', 'B', 200);
      bcast(s, 'w1', 'A', 300);
      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 50 });
      assert.equal(sum.recent.length, 3, 'a body re-sent after another row keeps its own entry');
      for (const r of sum.recent) assert.equal(r.occurrences, undefined);
      assert.deepStrictEqual(sum.recent.map((r) => r.ts), [100, 200, 300], 'ts order and values untouched');
    } finally { s.close(); rm(home); }
  });

  // ---- 7. a differing urgency breaks the run ----
  test(`[${B.name}] same sender+body with DIFFERENT urgency stays two entries`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      bcast(s, 'w1', 'blocked on review', 100, { urgency: 'normal' });
      bcast(s, 'w1', 'blocked on review', 200, { urgency: 'high' });
      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 50 });
      assert.equal(sum.recent.length, 2, 'an urgency change is never silently folded away');
      assert.equal(sum.recent[0].urgency, 'normal');
      assert.equal(sum.recent[1].urgency, 'high');
    } finally { s.close(); rm(home); }
  });

  // ---- 8. no duplicates -> byte-identical shape for existing readers ----
  test(`[${B.name}] with no duplicate runs the entries are shape-identical to pre-collapse`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      bcast(s, 'w1', 'one', 100, { urgency: 'normal' });
      bcast(s, 'w2', 'two', 200);
      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 50 });
      // NOTE: appendMeshMessage (devswarm-store.js:278) defaults a null urgency to
      // the STRING 'normal' at insert time, so 'normal' here is the stored value,
      // not something the collapse introduced.
      assert.deepStrictEqual(sum.recent, [
        { from: 'w1', summary: 'one', ts: 100, urgency: 'normal' },
        { from: 'w2', summary: 'two', ts: 200, urgency: 'normal' },
      ], 'exactly the four original keys, no additive keys, same order');
      assert.deepStrictEqual(sum.recent, rawRecent(s, 50), 'identical to the pre-fix projection');
    } finally { s.close(); rm(home); }
  });

  // ---- 9. the cap now budgets DISTINCT broadcasts ----
  test(`[${B.name}] recentCap counts collapsed runs, not duplicate copies`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      for (let i = 0; i < 5; i++) {
        for (let k = 0; k < 20; k++) bcast(s, 'w' + i, 'body-' + i, 1000 + i * 100 + k);
      }
      const sum = store.computeSummary(s, { home, now: 9999, recentCap: 3 });
      assert.equal(sum.recent.length, 3, 'cap applies to runs');
      assert.deepStrictEqual(sum.recent.map((r) => r.from), ['w2', 'w3', 'w4'], 'the NEWEST runs are kept');
      for (const r of sum.recent) assert.equal(r.occurrences, 20);
    } finally { s.close(); rm(home); }
  });

  // ---- 10. per-sender max ts never exceeds ground truth ----
  test(`[${B.name}] no sender's ts in recent[] ever exceeds its true newest row`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      for (let i = 0; i < 25; i++) bcast(s, 'w1', 'dup', 1000 + i);
      bcast(s, 'w2', 'other', 5000, { isHeartbeat: false });
      for (let i = 0; i < 25; i++) bcast(s, 'w1', 'dup', 6000 + i);

      const truth = new Map();
      for (const r of s.listMessages(store.BROADCAST_PARTITION_ID)) {
        const cur = truth.get(r.sender);
        if (cur === undefined || r.ts > cur) truth.set(r.sender, r.ts);
      }
      const sum = store.computeSummary(s, { home, now: 99999, recentCap: 50 });
      for (const r of sum.recent) {
        assert.ok(r.ts <= truth.get(r.from), 'projection ts never exceeds the sender’s real newest row');
      }
      // Two separate w1 runs (split by w2), each collapsed independently.
      assert.deepStrictEqual(sum.recent.map((r) => r.from), ['w1', 'w2', 'w1']);
      assert.equal(sum.recent[0].ts, 1024);
      assert.equal(sum.recent[2].ts, 6024);
    } finally { s.close(); rm(home); }
  });
}

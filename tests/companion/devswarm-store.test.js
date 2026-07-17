'use strict';
// devswarm-store — the persistent write/derive side of the DevSwarm substrate.
// The behavioral contract is backend-INDEPENDENT, so the same suite runs against
// BOTH backends. Journal is forced via env even on a runtime that HAS node:sqlite
// (PLAN.md Phase 2: unit tests for BOTH backends, force the journal path); sqlite
// is only exercised when node:sqlite is actually present (skipped on 18/20).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

// runNode(code) -> Promise resolved when a `node -e <code>` child exits. Used to
// drive genuinely-concurrent writers against the same journal home.
function runNode(code) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', reject);
  });
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-store-'));
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
  nudgeCommand: ['echo', 'poke', id],
}, over || {});

// ---- backend matrix -------------------------------------------------------
const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  test(`[${B.name}] openStore reports the selected backend`, () => {
    const home = tmpHome();
    const s = open(home);
    try { assert.equal(s.backend, B.backend); } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] messages are append-only and idempotent by hash`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'a', hash: 'h1' }), { inserted: true });
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'a', hash: 'h1' }), { inserted: false }); // dup hash
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'b', hash: 'h2' }), { inserted: true });
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'c' }), { inserted: true }); // no hash -> always in
      assert.deepEqual(s.appendMessage({ workspaceId: 'w1', body: 'c' }), { inserted: true }); // no hash -> distinct
      assert.equal(s.messageCount('w1'), 4);
      assert.equal(s.messageCount('other'), 0);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] registry upsert + remove reduce to the active set`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('a'));
      s.upsertRegistry(descriptor('b'));
      s.upsertRegistry(descriptor('a', { sessionId: 'sess-a2' })); // update, not a duplicate row
      let reg = s.listRegistry();
      assert.deepEqual(reg.map((d) => d.id), ['a', 'b']);
      assert.equal(reg.find((d) => d.id === 'a').sessionId, 'sess-a2');
      assert.deepEqual(reg.find((d) => d.id === 'a').nudgeCommand, ['echo', 'poke', 'a']);

      s.removeRegistry('a'); // archived-by-absence
      reg = s.listRegistry();
      assert.deepEqual(reg.map((d) => d.id), ['b']);
    } finally { s.close(); rm(home); }
  });

  // F2 (P3, low-prob but in-scope): `id` is an 8-hex sha256(realpath) slice — a
  // hash COLLISION between two distinct worktree paths is astronomically
  // unlikely but possible. upsertRegistry must refuse to silently clobber an
  // existing id's worktree_path with a DIFFERENT one, while a same-path update
  // (the normal case) and the explicit rekey opt-in both still work.
  test(`[${B.name}] F2: upsertRegistry refuses to clobber an existing id mapped to a DIFFERENT worktreePath, but a same-path update still applies`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('collide', { worktreePath: '/wt/first' }));

      // A second upsert for the SAME id with a DIFFERENT worktreePath must be
      // refused — the existing mapping survives, no field from it lands.
      s.upsertRegistry(descriptor('collide', { worktreePath: '/wt/second', sessionId: 'sess-should-not-land' }));
      let row = s.listRegistry().find((d) => d.id === 'collide');
      assert.equal(row.worktreePath, '/wt/first', 'the FIRST worktreePath must survive a different-path upsert');
      assert.equal(row.sessionId, 'sess-collide', 'no field from the refused upsert may land, not even sessionId');

      // A same-id, SAME-path update (ordinary field refresh) must still apply.
      s.upsertRegistry(descriptor('collide', { worktreePath: '/wt/first', sessionId: 'sess-refreshed' }));
      row = s.listRegistry().find((d) => d.id === 'collide');
      assert.equal(row.sessionId, 'sess-refreshed', 'a same-path update must still take effect');

      // The explicit opt-in (rekeySubdirRegistryRows' own bypass) still permits an
      // intentional same-id path rewrite.
      s.upsertRegistry(descriptor('collide', { worktreePath: '/wt/rekeyed', sessionId: 'sess-refreshed' }), { allowPathChange: true });
      row = s.listRegistry().find((d) => d.id === 'collide');
      assert.equal(row.worktreePath, '/wt/rekeyed', 'allowPathChange:true must permit an intentional path rewrite');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] listMessages returns bodies in order; sinceCursor excludes acked (read-back round-trip)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      // appendMessage(wsId, body) -> listMessages(wsId) returns the body ...
      s.appendMessage({ workspaceId: 'p', body: 'first',  hash: 'h1' });
      s.appendMessage({ workspaceId: 'p', body: 'second', hash: 'h2' });
      s.appendMessage({ workspaceId: 'p', body: 'third',  hash: 'h3' });
      s.appendMessage({ workspaceId: 'other', body: 'nope', hash: 'x1' }); // partitioned out

      const all = s.listMessages('p');
      assert.deepEqual(all.map((m) => m.body), ['first', 'second', 'third'], 'bodies returned in insertion order');
      assert.deepEqual(all.map((m) => m.seq), [1, 2, 3], '1-based seq aligns with the consumed-count cursor');
      assert.equal(all[0].hash, 'h1');
      assert.deepEqual(s.listMessages('other').map((m) => m.body), ['nope'], 'keyed strictly by workspaceId');

      // ... cursor advance -> listMessages(wsId,{sinceCursor}) excludes it.
      assert.deepEqual(s.listMessages('p', { sinceCursor: 2 }).map((m) => m.body), ['third'], 'sinceCursor skips the first N');
      assert.deepEqual(s.listMessages('p', { sinceCursor: 3 }), [], 'cursor at total -> nothing unread');
      assert.deepEqual(s.listMessages('p', { sinceCursor: 0 }).map((m) => m.body), ['first', 'second', 'third']);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] listMessages dedupes identical hashes on read (parity with messageCount)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.appendMessage({ workspaceId: 'p', body: 'a', hash: 'dup' });
      s.appendMessage({ workspaceId: 'p', body: 'a', hash: 'dup' }); // ignored dup
      s.appendMessage({ workspaceId: 'p', body: 'b' }); // null hash -> distinct
      assert.equal(s.messageCount('p'), 2);
      assert.equal(s.listMessages('p').length, 2, 'listMessages count agrees with messageCount');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] cursor set + unread projection`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      for (let i = 0; i < 5; i++) s.appendMessage({ workspaceId: 'w', body: String(i), hash: 'm' + i });
      assert.equal(s.cursorValue('w'), 0);
      s.setCursor('w', 2);
      assert.equal(s.cursorValue('w'), 2);
      s.setCursor('w', -3); // clamped to 0
      assert.equal(s.cursorValue('w'), 0);
      s.setCursor('w', 3.9); // floored
      assert.equal(s.cursorValue('w'), 3);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] gates are append-only; current value = latest row`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.setGate({ workspaceId: 'w', name: 'done', value: true, setBy: 'consumer' });
      assert.deepEqual(s.currentGates('w'), { done: true });
      s.setGate({ workspaceId: 'w', name: 'done', value: false }); // clear = append false
      assert.deepEqual(s.currentGates('w'), { done: false });
      s.setGate({ workspaceId: 'w', name: 'done', value: true });
      s.setGate({ workspaceId: 'w', name: 'merged', value: true });
      s.setGate({ workspaceId: 'w', name: 'deployed', value: true }); // consumer-defined gate (agnostic)
      assert.deepEqual(s.currentGates('w'), { done: true, merged: true, deployed: true });
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] deriveSummary writes atomic summary.json with unread + gates`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      for (let i = 0; i < 4; i++) s.appendMessage({ workspaceId: 'w', body: String(i), hash: 'm' + i });
      s.setCursor('w', 1);
      s.setGate({ workspaceId: 'w', name: 'done', value: true });

      const sum = store.deriveSummary(s, { home, now: 111 });
      assert.equal(sum.generatedAt, 111);
      assert.deepEqual(sum.requiredGates, ['done', 'merged', 'tests_passed']);
      const ws = sum.workspaces.w;
      assert.equal(ws.total, 4);
      assert.equal(ws.cursor, 1);
      assert.equal(ws.unread, 3);
      assert.equal(ws.archive_ready, false); // only 1 of 3 required gates
      assert.deepEqual(ws.gates, { done: true });

      // written to disk + readable via the tolerant reader
      const onDisk = store.readSummary(home);
      assert.equal(onDisk.workspaces.w.unread, 3);
      assert.ok(fs.existsSync(store.summaryPath(home)));
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] archive_ready derives true only when ALL required gates met on an active workspace`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      s.setGate({ workspaceId: 'w', name: 'done', value: true });
      s.setGate({ workspaceId: 'w', name: 'merged', value: true });
      let sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w.archive_ready, false); // tests_passed missing

      s.setGate({ workspaceId: 'w', name: 'tests_passed', value: true });
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w.archive_ready, true);

      // a later clear flips it back off (gates are append-only; latest wins)
      s.setGate({ workspaceId: 'w', name: 'merged', value: false });
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w.archive_ready, false);

      // removed (archived) workspace drops out of the projection entirely
      s.removeRegistry('w');
      sum = store.deriveSummary(s, { home });
      assert.equal(sum.workspaces.w, undefined);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] required-gate set is configurable (consumer adds deployed)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.upsertRegistry(descriptor('w'));
      for (const g of ['done', 'merged', 'tests_passed']) s.setGate({ workspaceId: 'w', name: g, value: true });

      // default set -> ready
      assert.equal(store.deriveSummary(s, { home }).workspaces.w.archive_ready, true);
      // extended set requiring deployed (not yet set) -> not ready
      const req = ['done', 'merged', 'tests_passed', 'deployed'];
      assert.equal(store.deriveSummary(s, { home, requiredGates: req }).workspaces.w.archive_ready, false);
      s.setGate({ workspaceId: 'w', name: 'deployed', value: true });
      assert.equal(store.deriveSummary(s, { home, requiredGates: req }).workspaces.w.archive_ready, true);
    } finally { s.close(); rm(home); }
  });
}

// ---- PER-PROJECT physical isolation (v0.55) -------------------------------
test('PER-PROJECT: two workspaceIds -> two SEPARATE db files; a message in A is absent from B', () => {
  const home = tmpHome();
  try {
    const A = 'primary-aaaaaaaa';
    const B = 'primary-bbbbbbbb';
    // distinct hashes -> distinct store dirs
    assert.notEqual(store.hashFromWorkspaceId(A), store.hashFromWorkspaceId(B));

    const sa = store.openStore({ home, workspaceId: A, backend: 'journal' });
    try { sa.appendMessage({ workspaceId: A, body: 'in-A', hash: 'ha' }); } finally { sa.close(); }
    const sb = store.openStore({ home, workspaceId: B, backend: 'journal' });
    try { sb.appendMessage({ workspaceId: B, body: 'in-B', hash: 'hb' }); } finally { sb.close(); }

    // Two SEPARATE db files on disk, one per project hash.
    const fileA = path.join(store.journalDir(home, A), 'messages.ndjson');
    const fileB = path.join(store.journalDir(home, B), 'messages.ndjson');
    assert.notEqual(fileA, fileB, 'per-project stores live in different dirs');
    assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB), 'both physical files exist');

    // A message in A's store is absent from B's FILE (physical isolation, not just
    // a workspace_id column filter).
    const rawA = fs.readFileSync(fileA, 'utf8');
    const rawB = fs.readFileSync(fileB, 'utf8');
    assert.ok(rawA.includes('in-A') && !rawA.includes('in-B'), "A's file holds only A's message");
    assert.ok(rawB.includes('in-B') && !rawB.includes('in-A'), "B's file holds only B's message");

    // And a reopen of B's store never sees A's row.
    const rb = store.openStore({ home, workspaceId: B, backend: 'journal' });
    try {
      assert.equal(rb.messageCount(B), 1);
      assert.equal(rb.messageCount(A), 0, "B's physical store has no rows for A");
    } finally { rb.close(); }
  } finally { rm(home); }
});

// ---- backend-independent unit tests ---------------------------------------
test('requiredGatesFrom: default + env override', () => {
  assert.deepEqual(store.requiredGatesFrom({}), ['done', 'merged', 'tests_passed']);
  assert.deepEqual(
    store.requiredGatesFrom({ ANTIHALL_DEVSWARM_REQUIRED_GATES: 'done, merged ,tests_passed,deployed' }),
    ['done', 'merged', 'tests_passed', 'deployed']
  );
  assert.deepEqual(store.requiredGatesFrom({ ANTIHALL_DEVSWARM_REQUIRED_GATES: '   ' }), ['done', 'merged', 'tests_passed']);
});

test('selectBackend: env/opts force journal even where sqlite exists', () => {
  assert.equal(store.selectBackend({ backend: 'journal' }), 'journal');
  assert.equal(store.selectBackend({ env: { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' } }), 'journal');
  // feature-detect matches the runtime probe
  assert.equal(store.selectBackend({ env: {} }), store.sqliteAvailable() ? 'sqlite' : 'journal');
  // asking for sqlite where it is absent falls back to journal, never throws
  if (!store.sqliteAvailable()) assert.equal(store.selectBackend({ backend: 'sqlite' }), 'journal');
});

test('readSummary is tolerant of missing / zero-byte / partial files', () => {
  const home = tmpHome();
  try {
    assert.equal(store.readSummary(home), null); // missing
    fs.mkdirSync(path.dirname(store.summaryPath(home)), { recursive: true });
    fs.writeFileSync(store.summaryPath(home), '');
    assert.equal(store.readSummary(home), null); // zero-byte
    fs.writeFileSync(store.summaryPath(home), '{"workspaces": {"w"'); // torn/partial
    assert.equal(store.readSummary(home), null);
    fs.writeFileSync(store.summaryPath(home), '{"workspaces":{}}');
    assert.deepEqual(store.readSummary(home), { workspaces: {} });
  } finally { rm(home); }
});

test('journal backend persists across reopen (durability)', () => {
  const home = tmpHome();
  try {
    let s = store.openStore({ home, backend: 'journal' });
    s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' });
    s.upsertRegistry(descriptor('w'));
    s.setGate({ workspaceId: 'w', name: 'done', value: true });
    s.close();

    s = store.openStore({ home, backend: 'journal' }); // fresh handle, same files
    assert.equal(s.messageCount('w'), 1);
    assert.deepEqual(s.listRegistry().map((d) => d.id), ['w']);
    assert.deepEqual(s.currentGates('w'), { done: true });
    // append-only trail preserved on disk (2 gate rows after a flip)
    s.setGate({ workspaceId: 'w', name: 'done', value: false });
    const raw = fs.readFileSync(path.join(store.journalDir(home), 'gates.ndjson'), 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
    s.close();
  } finally { rm(home); }
});

test('writeSummaryAtomic stages to a UNIQUE tmp path per call (no shared .tmp race)', () => {
  const home = tmpHome();
  try {
    const tmps = [];
    const spy = Object.create(fs); // inherits real fs; override only the tmp write
    spy.writeFileSync = (p, data, ...rest) => {
      if (String(p).endsWith('.tmp')) tmps.push(String(p));
      return fs.writeFileSync(p, data, ...rest);
    };
    const s = store.openStore({ home, backend: 'journal' });
    try {
      s.upsertRegistry(descriptor('w'));
      store.deriveSummary(s, { home, fsi: spy });
      store.deriveSummary(s, { home, fsi: spy });
    } finally { s.close(); }
    assert.equal(tmps.length, 2, 'two derives -> two tmp writes');
    assert.notEqual(tmps[0], tmps[1], 'each call stages to a UNIQUE tmp path');
    const shared = store.summaryPath(home) + '.tmp';
    assert.ok(!tmps.includes(shared), 'never the single shared summary.json.tmp that racers would collide on');
  } finally { rm(home); }
});

test('[journal] concurrent writers never duplicate a deduped hash row (serialized append)', async () => {
  const home = tmpHome();
  try {
    const storePath = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
    const worker = ''
      + 'const store = require(' + JSON.stringify(storePath) + ');'
      + 'const s = store.openStore({ home: ' + JSON.stringify(home) + ", backend: 'journal' });"
      + "for (let i = 0; i < 60; i++) s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'dupe' });"
      + 's.close();';
    // Three genuinely-concurrent processes hammering the SAME dedupe hash. Without
    // a lock around check+append they can each miss the hash and each append it
    // (duplicate physical rows). The store lock makes exactly one row survive.
    await Promise.all([runNode(worker), runNode(worker), runNode(worker)]);

    const jp = path.join(store.journalDir(home), 'messages.ndjson');
    const rows = fs.readFileSync(jp, 'utf8').split('\n').filter((l) => l.includes('"hash":"dupe"'));
    assert.equal(rows.length, 1, 'exactly one physical row for the deduped hash despite concurrent writers');

    const s = store.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('w'), 1); } finally { s.close(); }
  } finally { rm(home); }
});

// ---- lock-soundness (v0.54.2): the critical section NEVER runs unlocked --------

test('[journal] a held (non-stale) lock makes appendMessage fail closed — no unlocked append, no dup, retryable', () => {
  const home = tmpHome();
  try {
    const dir = store.journalDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, 'messages.lock');
    const messagesFile = path.join(dir, 'messages.ndjson');
    // A live holder: fresh ts + a large stale window so it is NEVER stolen.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));

    // Small budget so exhaustion is fast + deterministic.
    const s = store.openStore({ home, backend: 'journal', lock: { maxTries: 3, appendRetries: 2, staleMs: 60000 } });
    try {
      let threw = null;
      try { s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'dupe' }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'ELOCKUNAVAIL',
        'append under a held lock surfaces ELOCKUNAVAIL, never runs the critical section unlocked');
      // CRITICAL: nothing was appended while the lock was unavailable.
      assert.equal(s.messageCount('w'), 0, 'no row written while the lock was held');
      assert.ok(!fs.existsSync(messagesFile) || fs.readFileSync(messagesFile, 'utf8').trim() === '',
        'messages.ndjson has no unlocked write');

      // Lock released -> a retry now persists EXACTLY once (idempotent by hash).
      fs.unlinkSync(lockPath);
      assert.deepEqual(s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'dupe' }), { inserted: true });
      assert.equal(s.messageCount('w'), 1);
      assert.deepEqual(s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'dupe' }), { inserted: false }, 'still deduped');
      assert.equal(s.messageCount('w'), 1, 'exactly one physical row, no dup');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('[journal] appendMessage retries transient lock-unavailability and eventually persists exactly once', () => {
  const home = tmpHome();
  try {
    const lockPath = path.join(store.journalDir(home), 'messages.lock');
    // maxTries:1 -> each withMessagesLock makes ONE acquire attempt, so a forced
    // EEXIST exhausts it and throws ELOCKUNAVAIL; appendMessage's outer retry then
    // recovers. Fail the first 2 acquire attempts, succeed on the 3rd.
    let fails = 2;
    const spy = Object.create(fs);
    spy.openSync = (p, flags, ...rest) => {
      if (String(p) === lockPath && String(flags) === 'wx' && fails > 0) {
        fails--;
        const e = new Error('EEXIST: forced contention'); e.code = 'EEXIST'; throw e;
      }
      return fs.openSync(p, flags, ...rest);
    };
    const s = store.openStore({ home, backend: 'journal', fsi: spy, lock: { maxTries: 1, appendRetries: 5 } });
    try {
      assert.deepEqual(s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' }), { inserted: true },
        'append recovers after 2 lock-unavailable attempts');
      assert.equal(fails, 0, 'all forced contention was consumed (retry actually happened)');
      assert.equal(s.messageCount('w'), 1);
      // A re-append of the same hash stays deduped — the retry never doubled it.
      assert.deepEqual(s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' }), { inserted: false });
      assert.equal(s.messageCount('w'), 1, 'exactly one physical row');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('[journal] a genuine fs error opening the lock fails closed (ELOCKFS), never appends unlocked', () => {
  const home = tmpHome();
  try {
    const dir = store.journalDir(home);
    const lockPath = path.join(dir, 'messages.lock');
    const messagesFile = path.join(dir, 'messages.ndjson');
    const spy = Object.create(fs);
    spy.openSync = (p, flags, ...rest) => {
      if (String(p) === lockPath && String(flags) === 'wx') {
        const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e;
      }
      return fs.openSync(p, flags, ...rest);
    };
    const s = store.openStore({ home, backend: 'journal', fsi: spy, lock: { maxTries: 5, appendRetries: 5 } });
    try {
      let threw = null;
      try { s.appendMessage({ workspaceId: 'w', body: 'x', hash: 'h1' }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'ELOCKFS', 'genuine fs error surfaces ELOCKFS (fail closed)');
      assert.ok(!fs.existsSync(messagesFile) || fs.readFileSync(messagesFile, 'utf8').trim() === '',
        'no row appended on a genuine fs error');
    } finally { s.close(); }
  } finally { rm(home); }
});

if (store.sqliteAvailable()) {
  test('[sqlite] uses WAL journal mode', () => {
    const home = tmpHome();
    const s = store.openStore({ home, backend: 'sqlite' });
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(store.sqlitePath(home));
      const mode = db.prepare('PRAGMA journal_mode;').get();
      db.close();
      assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');
    } finally { s.close(); rm(home); }
  });
}

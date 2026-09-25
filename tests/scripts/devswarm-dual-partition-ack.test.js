'use strict';
// DUAL-PARTITION ACK (0.106.0 field report, SkyCrew Primary).
//
// One DevSwarm-launched Primary is ONE process with TWO names: its cwd-derived
// `primary-<hash>` row (register-primary) and the hivecontrol workspace UUID in
// DEVSWARM_BUILDER_ID, registered on the SAME worktree. Children address the
// UUID; the Primary reads `primary-<hash>`. read-primary delivered the UUID rows
// through the mesh union, but siblingAckGate treated the UUID row as a FOREIGN
// LIVE sibling (its heartbeat is refreshed by this same process's `inbox tick`)
// and refused the ack — so the rows stayed unread there forever (peek/count/
// parent table "CHILD NOT DRAINING" about the Primary itself), and
// `read-primary <uuid>` was refused as ownership-mismatch.
//
// RED on 9324bec, GREEN after (declaredSelfId + the SELF leg in siblingAckGate
// + the ownership leg). The migration cases pin the forward repair of state
// already written by the defect.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const readerCursors = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const migrations = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const wakeWatch = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));

const UUID = '76cf862f-4dbd-4a14-904b-b84c8e255743';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-dualpart-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}
function devswarmDir(home) { return path.join(home, '.anti-hall', 'devswarm'); }

// The field shape: register-primary row (real session) + the UUID row on the
// SAME worktree (no sessionId, descriptor with a native NDJSON inbox) whose
// heartbeat this same process keeps fresh.
function fixture(opts) {
  const o = opts || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-dualpart-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = makeRepo();
  const env = { DEVSWARM_BUILDER_ID: UUID, CLAUDE_CODE_SESSION_ID: 'sess-primary-1' };
  const ctx = (over) => Object.assign({ home, env, cwd: repo }, over || {});
  const rp = cli.run(['register-primary', '--inbox', path.join(home, 'primary-inbox.ndjson')], ctx());
  assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
  const PID = rp.result.id;
  const repoKey = repokey.repoKeyForWorktree(repo);
  const inboxPath = path.join(repo, '.devswarm-temp', 'inbox.ndjson');
  const cursorPath = path.join(repo, '.devswarm-temp', 'inbox.cursor');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(inboxPath, '');
  const s = storeLib.openStore({ home, hash: repoKey });
  try { s.upsertRegistry({ id: UUID, worktreePath: repo, sessionId: null, inboxPath, cursorPath }); } finally { s.close(); }
  fs.mkdirSync(path.join(devswarmDir(home), 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(devswarmDir(home), 'workspaces', UUID + '.json'),
    JSON.stringify({ id: UUID, worktreePath: repo, sessionId: null, inboxPath, cursorPath, repoKey, ownerKey: repoKey }));
  if (o.uuidLive !== false) markLive(home, UUID);
  if (o.pidLive) markLive(home, PID);
  return { home, repo, env, ctx, PID, repoKey, inboxPath, cursorPath };
}
function markLive(home, id) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now(), state_ts: Date.now(), source: 'inbox-tick', sessionId: null }));
}
function withStore(f, fn) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try { return fn(s); } finally { s.close(); }
}
function send(f, to, body, extra) {
  return withStore(f, (s) => {
    const fields = Object.assign({ from: 'primary-child1', to, type: 'direct', urgency: 'normal', message: body, timestamp: 1790262004759 }, extra || {});
    storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    return storeLib.meshMessageHash(fields);
  });
}
const bodies = (r) => (r.result.messages || []).map((m) => m.body);
function readAndAck(f, id) {
  const rd = f.ctx && cli.run(['inbox', 'read-primary', id], f.ctx());
  assert.equal(rd.result.ok, true, JSON.stringify(rd.result));
  const got = bodies(rd);
  if (rd.result.readReceiptId) {
    const a = cli.run(['inbox', 'ack-primary', id, '--receipt', rd.result.readReceiptId], f.ctx());
    assert.equal(a.result.ok, true, JSON.stringify(a.result));
  }
  return got;
}
function summaryUnread(f) {
  const j = JSON.parse(fs.readFileSync(path.join(devswarmDir(f.home), 'summaries', f.repoKey + '.json'), 'utf8'));
  const w = j.workspaces || {};
  return { uuid: w[UUID] && w[UUID].unread, pid: w[f.PID] && w[f.PID].unread, uuidTotal: w[UUID] && w[UUID].total, pidTotal: w[f.PID] && w[f.PID].total };
}
function assertAllZero(f, label) {
  assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', UUID], f.ctx())), [], label + ': peek-primary <uuid> must be empty');
  assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', f.PID], f.ctx())), [], label + ': peek-primary <pid> must be empty');
  assert.equal(cli.run(['inbox', 'count', UUID], f.ctx()).result.unreadTotal, 0, label + ': inbox count <uuid>');
  assert.equal(cli.run(['inbox', 'count', f.PID], f.ctx()).result.unreadTotal, 0, label + ': inbox count <pid>');
  const su = summaryUnread(f);
  assert.equal(su.uuid, 0, label + ': summary (parent gate/table source) unread for the uuid row');
  assert.equal(su.pid, 0, label + ': summary unread for the primary row');
  const desc = { id: UUID, worktreePath: f.repo, inboxPath: f.inboxPath, cursorPath: f.cursorPath };
  const v = liveness.unionPendingFor(desc, f.home, { env: f.env });
  assert.equal(v.pending, false, label + ': the NOT-DRAINING verdict source must see nothing pending on the uuid row');
}

test('field shape: mail addressed to the UUID, read via primary-<hash> — ONE ack clears both partitions', () => {
  const f = fixture();
  try {
    send(f, UUID, 'L11 OPUS REVIEW of r2 @00ae310a');
    assert.deepEqual(readAndAck(f, f.PID), ['L11 OPUS REVIEW of r2 @00ae310a'], 'delivered once through the mesh union');
    assertAllZero(f, 'after one read+ack');
    assert.deepEqual(readAndAck(f, f.PID), [], 'not re-delivered');
  } finally { rm(f.home); rm(f.repo); }
});

test('the same send in BOTH partitions (forwarded copy) — read once, one ack clears both', () => {
  const f = fixture();
  try {
    const origHash = send(f, UUID, 'L3 -> PRIMARY: BLOCKED');
    send(f, f.PID, 'L3 -> PRIMARY: BLOCKED', { origHash });
    const got = readAndAck(f, f.PID);
    assert.deepEqual(got, ['L3 -> PRIMARY: BLOCKED'], 'the duplicate is delivered exactly once');
    assertAllZero(f, 'after one read+ack of a duplicated send');
  } finally { rm(f.home); rm(f.repo); }
});

test('read-primary on the session\'s OWN uuid partition is not refused as ownership-mismatch', () => {
  // pickFreshestLive ranks the primary row first (fresh heartbeat), which is
  // what made the pre-fix ownership check refuse the uuid.
  const f = fixture({ uuidLive: false, pidLive: true });
  try {
    send(f, UUID, 'direct to the uuid');
    const r = cli.run(['inbox', 'read-primary', UUID], f.ctx());
    assert.equal(r.result.ok, true, 'read-primary <own uuid> must succeed: ' + JSON.stringify(r.result));
    assert.deepEqual(bodies(r), ['direct to the uuid']);
    const a = cli.run(['inbox', 'ack-primary', UUID, '--receipt', r.result.readReceiptId], f.ctx());
    assert.equal(a.result.ok, true, JSON.stringify(a.result));
    assertAllZero(f, 'after read+ack via the uuid');
  } finally { rm(f.home); rm(f.repo); }
});

test('a receipt issued for one alias is ackable through ANY alias in the same identity family (read-receipt canonicalization)', () => {
  const f = fixture();
  try {
    // Mail landed directly in the primary-<hash> row's OWN store — exercises
    // the 'own' ack op (not a 'sibling' op), the exact branch that used to
    // ack against the outer ack-primary caller's id instead of the op's own
    // partition.
    send(f, f.PID, 'own-partition mail');
    const rd = cli.run(['inbox', 'read-primary', f.PID], f.ctx());
    assert.equal(rd.result.ok, true, JSON.stringify(rd.result));
    assert.deepEqual(bodies(rd), ['own-partition mail']);
    // ackCommand is unchanged — it still names the id the READ was addressed
    // to, never the canonical family id.
    assert.match(rd.result.ackCommand, new RegExp(' inbox ack-primary ' + f.PID + ' --receipt r[a-z0-9]+$'));
    // Ack through the OTHER alias in the family (UUID), not the one that read.
    const ack = cli.run(['inbox', 'ack-primary', UUID, '--receipt', rd.result.readReceiptId], f.ctx());
    assert.equal(ack.result.ok, true, JSON.stringify(ack.result));
    assert.equal(ack.result.reason, undefined, 'not refused as receipt-owner-mismatch');
    assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', f.PID], f.ctx())), [], 'the actual owning partition (primary-<hash>) is the one that got acked');
    // Idempotent: re-acking through the ORIGINAL alias also reports alreadyAcked.
    const again = cli.run(['inbox', 'ack-primary', f.PID, '--receipt', rd.result.readReceiptId], f.ctx());
    assert.equal(again.result.ok, true, JSON.stringify(again.result));
    assert.equal(again.result.alreadyAcked, true);
  } finally { rm(f.home); rm(f.repo); }
});

test('foldReadReceiptsAllStores repairs receipts written under a literal id BEFORE canonicalReceiptId existed (idempotent, no-delete)', () => {
  const f = fixture();
  try {
    // Simulate a pre-fix receipt: written directly to disk under the literal
    // f.PID directory (byte-identical to what writeReadReceipt produced before
    // it learned to accept `dirId`), never through the CLI, so the repair is
    // exercised independently of the write-time fix above.
    const receiptId = 'r' + Date.now().toString(36) + 'deadbeef01';
    const literalDir = path.join(devswarmDir(f.home), 'read-receipts', f.PID);
    fs.mkdirSync(literalDir, { recursive: true });
    const receiptBody = { id: f.PID, reader: 'someone', ops: [], hashes: [], createdAt: Date.now() };
    fs.writeFileSync(path.join(literalDir, receiptId + '.json'), JSON.stringify(receiptBody));

    // dryRun first: reports pending, writes nothing.
    const dry = cli.foldReadReceiptsAllStores(f.home, { dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.ok(dry.pending > 0, 'dry-run finds the alias-keyed receipt: ' + JSON.stringify(dry));
    assert.equal(dry.folded, 0, 'dry-run must not write');

    // Apply via the SAME migrations machinery update.js/doctor use.
    const rows = migrations.runMigrations({ home: f.home, cwd: f.repo, env: f.env, version: '0.108.2-test', devswarm: cli });
    const row = rows.find((r) => r.id === 'fold-read-receipts');
    assert.ok(row, 'fold-read-receipts migration ran: ' + JSON.stringify(rows));
    assert.equal(row.status, 'fixed', JSON.stringify(row));

    // The original literal-id file is NEVER removed (no-delete).
    assert.ok(fs.existsSync(path.join(literalDir, receiptId + '.json')), 'literal-id receipt file is left in place');

    // A canonical-family copy now exists somewhere findable by readReadReceipt
    // through EITHER alias — prove it by resolving via ack-primary through the
    // OTHER alias in the family for a FRESH receipt (write path), and by
    // re-running the repair (idempotent: nothing left to fold).
    const again = cli.foldReadReceiptsAllStores(f.home, { dryRun: true });
    assert.equal(again.pending, 0, 're-running the dry-run finds nothing left to fold (idempotent): ' + JSON.stringify(again));

    // Re-running the migration a second time is a no-op skip (marker + nothing pending).
    const rows2 = migrations.runMigrations({ home: f.home, cwd: f.repo, env: f.env, version: '0.108.2-test', devswarm: cli });
    const row2 = rows2.find((r) => r.id === 'fold-read-receipts');
    assert.equal(row2.status, 'skipped', JSON.stringify(row2));
  } finally { rm(f.home); rm(f.repo); }
});

test('the declared id grants nothing off its own worktree, and a foreign live sibling stays protected', () => {
  const f = fixture();
  const other = makeRepo();
  try {
    // A process in ANOTHER worktree declaring the uuid owns nothing here.
    withStore(f, (s) => assert.equal(cli.declaredSelfId(f.env, other, s.listRegistry()), null));
    // A second live workspace on the same worktree (a different builder id) is
    // still a foreign sibling: its mail is delivered but never acked by us.
    const FOREIGN = '11111111-2222-4333-8444-555555555555';
    withStore(f, (s) => s.upsertRegistry({ id: FOREIGN, worktreePath: f.repo, sessionId: 'sess-foreign' }));
    markLive(f.home, FOREIGN);
    send(f, FOREIGN, 'foreign mail');
    readAndAck(f, f.PID);
    assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', FOREIGN], f.ctx({ env: { DEVSWARM_BUILDER_ID: FOREIGN } }))), ['foreign mail'],
      'a live foreign sibling keeps its own unread mail');
  } finally { rm(f.home); rm(f.repo); rm(other); }
});

test('wake-watch: a fold sweep after the ack adds no already-acked duplicate to either watched total', () => {
  const f = fixture({ pidLive: true });
  try {
    send(f, UUID, 'ack me once');
    readAndAck(f, f.PID);
    const before = summaryUnread(f);
    let st = wakeWatch.tick(undefined, { ok: true, error: null, total: before.pidTotal, total2: before.uuidTotal }).state;
    cli.foldMeshDuplicates(f.home, { cwd: f.repo, env: f.env });
    cli.run(['inbox', 'count', f.PID], f.ctx()); // refresh the projection
    const after = summaryUnread(f);
    assert.equal(after.pidTotal, before.pidTotal, 'no forwarded copy of an acked row lands in the primary partition');
    assert.equal(after.uuidTotal, before.uuidTotal, 'nor in the uuid partition');
    const t = wakeWatch.tick(st, { ok: true, error: null, total: after.pidTotal, total2: after.uuidTotal });
    assert.deepEqual(t.lines.filter((l) => /new mesh mail/.test(l)), [], 'no wake for already-acked mail');
    assertAllZero(f, 'after the fold sweep');
  } finally { rm(f.home); rm(f.repo); }
});

// ---- forward migration: repair state the defect already wrote ------------------
function floorOf(f, id) { return withStore(f, (s) => cli.floorCursor(s, id, f.home)); }

function seededBadState() {
  const f = fixture();
  // Two messages reached BOTH partitions as fold forwards (the copy's origHash
  // names the uuid row). The primary partition consumed them; the uuid partition
  // still shows them unread. dup-3 is a SEPARATE delivery of the same text (no
  // origHash link) — the reader never saw THAT message, so it stays unread and
  // stops the prefix, as does every row after it.
  const h1 = send(f, UUID, 'dup-1', { timestamp: 1001 });
  const h2 = send(f, UUID, 'dup-2', { timestamp: 1002 });
  send(f, UUID, 'dup-3', { timestamp: 1003 });
  send(f, UUID, 'never-seen', { timestamp: 1004 });
  send(f, UUID, 'dup-after-gap', { timestamp: 1005 });
  send(f, f.PID, 'dup-1', { timestamp: 1001, origHash: h1 });
  send(f, f.PID, 'dup-2', { timestamp: 1002, origHash: h2 });
  send(f, f.PID, 'dup-3', { timestamp: 1003 });
  send(f, f.PID, 'dup-after-gap', { timestamp: 1005 });
  withStore(f, (s) => readerCursors.raiseAllLossFree(s, { partition: f.PID, ns: 'store', value: 4, home: f.home }));
  return f;
}

test('migration: plain doctor reports, --repair raises the twin floor through acked duplicates only, idempotent', () => {
  const f = seededBadState();
  try {
    assert.equal(floorOf(f, UUID), 0, 'precondition: the uuid partition shows every row unread');
    const report = migrations.runMigrations({ home: f.home, version: '9.9.9', dryRun: true, devswarm: cli, env: {} })
      .find((r) => r.id === 'reconcile-dual-partition-acks');
    assert.ok(report, 'the registry lists the migration');
    assert.equal(report.status, 'skipped');
    assert.match(report.msg, /\[dry-run\] would migrate: 2 already-acked duplicate row\(s\) unread in 1 twin partition/);
    assert.equal(floorOf(f, UUID), 0, 'a dry run writes nothing');

    const applied = migrations.runMigrations({ home: f.home, version: '9.9.9', devswarm: cli, env: {} })
      .find((r) => r.id === 'reconcile-dual-partition-acks');
    assert.equal(applied.status, 'fixed', JSON.stringify(applied));
    assert.equal(floorOf(f, UUID), 2, 'raised through the two forwarded copies and stopped at dup-3 (a separate, unread delivery)');
    assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', UUID], f.ctx({ env: {} }))), ['dup-3', 'never-seen', 'dup-after-gap'],
      'nothing past the first unacked row is skipped');
    assert.equal(floorOf(f, f.PID), 4, 'the canonical partition is untouched');

    const again = migrations.runMigrations({ home: f.home, version: '9.9.9', devswarm: cli, env: {} })
      .find((r) => r.id === 'reconcile-dual-partition-acks');
    assert.match(again.msg, /already applied/, 'stamped for the version');
    const rerun = cli.reconcileDualPartitionAcksAllStores(f.home, { env: {} });
    assert.equal(rerun.raised, 0, 'idempotent: a second pass finds nothing');
    assert.equal(rerun.errors, 0);
  } finally { rm(f.home); rm(f.repo); }
});

test('migration: two non-anchor rows on one worktree (two live children) are never reconciled', () => {
  const f = fixture();
  try {
    const B = '99999999-8888-4777-8666-555555555555';
    withStore(f, (s) => s.upsertRegistry({ id: B, worktreePath: f.repo, sessionId: 'sess-b' }));
    send(f, UUID, 'same text', { timestamp: 7 });
    send(f, B, 'same text', { timestamp: 7 });
    withStore(f, (s) => readerCursors.raiseAllLossFree(s, { partition: B, ns: 'store', value: 1, home: f.home }));
    const r = cli.reconcileDualPartitionAcksAllStores(f.home, { env: {} });
    assert.equal(r.raised, 0, 'no anchor in the pair -> no proof it is one identity -> untouched');
    assert.equal(floorOf(f, UUID), 0);
  } finally { rm(f.home); rm(f.repo); }
});

test('migration: ANTIHALL_INGEST_DRY_RUN=1 never writes', () => {
  const f = seededBadState();
  try {
    const r = cli.reconcileDualPartitionAcksAllStores(f.home, { env: { ANTIHALL_INGEST_DRY_RUN: '1' } });
    assert.equal(r.dryRun, true);
    assert.equal(r.wouldRaise, 1);
    assert.equal(floorOf(f, UUID), 0);
  } finally { rm(f.home); rm(f.repo); }
});

// ---- Opus review P1s: a CHILD registered on the Primary's worktree ---------
const CHILD = '11111111-2222-4333-8444-555555555555';

test('a live child on the Primary worktree never acks the Primary anchor partition', () => {
  const f = fixture({ pidLive: true });
  try {
    withStore(f, (s) => s.upsertRegistry({ id: CHILD, worktreePath: f.repo, sessionId: 'sess-child' }));
    markLive(f.home, CHILD);
    send(f, f.PID, 'mail for the PRIMARY anchor');
    const cenv = { DEVSWARM_BUILDER_ID: CHILD, CLAUDE_CODE_SESSION_ID: 'sess-child' };
    const rd = cli.run(['inbox', 'read-primary', CHILD], f.ctx({ env: cenv }));
    assert.equal(rd.result.ok, true, JSON.stringify(rd.result));
    if (rd.result.readReceiptId) {
      const a = cli.run(['inbox', 'ack-primary', CHILD, '--receipt', rd.result.readReceiptId], f.ctx({ env: cenv }));
      assert.equal(a.result.ok, true, JSON.stringify(a.result));
    }
    assert.deepEqual(bodies(cli.run(['inbox', 'peek-primary', f.PID], f.ctx())), ['mail for the PRIMARY anchor'],
      'the anchor carries the Primary session, not the child\'s: the child\'s read must leave the Primary\'s mail unread');
  } finally { rm(f.home); rm(f.repo); }
});

test('migration: a child on the anchor worktree is never reconciled against the anchor', () => {
  const f = fixture();
  try {
    withStore(f, (s) => s.upsertRegistry({ id: CHILD, worktreePath: f.repo, sessionId: 'sess-child' }));
    // One send addressed to both, and a fold forward of the child's row into the anchor.
    const hc = send(f, CHILD, 'to both', { timestamp: 21 });
    send(f, f.PID, 'to both', { timestamp: 21 });
    send(f, f.PID, 'to both', { timestamp: 21, origHash: hc, urgency: 'high' });
    withStore(f, (s) => readerCursors.raiseAllLossFree(s, { partition: f.PID, ns: 'store', value: 2, home: f.home }));
    const r = cli.reconcileDualPartitionAcksAllStores(f.home, { env: {} });
    assert.equal(r.errors, 0);
    assert.equal(floorOf(f, CHILD), 0, 'the child\'s copy stays unread — the Primary acking its own copy says nothing about the child');
  } finally { rm(f.home); rm(f.repo); }
});

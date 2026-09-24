'use strict';
// companion/lib/devswarm-retention.js — message retention (archive-then-prune of
// old message BODIES; rows/positions/hashes stay). Every test seeds a store in an
// isolated tmp HOME; nothing here touches the real ~/.anti-hall.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const ret = require(path.join(ROOT, 'companion', 'lib', 'devswarm-retention.js'));
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));

const HASH = 'ret-test-abcdef';
const P = 'ws-alpha';
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const OLD = NOW - 60 * 24 * 60 * 60 * 1000; // 60 days old
const HAS_SQLITE = storeLib.sqliteAvailable();
const t = HAS_SQLITE ? test : test.skip;

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-retention-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function open(home) { return storeLib.openStore({ home, hash: HASH, backend: 'sqlite' }); }
function env(extra) { return Object.assign({ ANTIHALL_DEVSWARM_RETENTION_DAYS: '30' }, extra || {}); }
function settings(home, extra) { return ret.resolveSettings({ home, env: env(extra) }); }
function body(i, pad) { return 'message ' + i + ' ' + 'x'.repeat(pad || 50); }

// seed(home, n, opts) -> seeds partition P with n direct rows (ts OLD+i unless
// opts.ts), registers P, and sets the headless floor to opts.floor.
function seed(home, n, opts) {
  const o = opts || {};
  const s = open(home);
  try {
    s.upsertRegistry({ id: o.partition || P, worktreePath: path.join(home, 'wt') });
    for (let i = 0; i < n; i++) {
      s.appendMeshRow({
        workspaceId: o.partition || P, hash: (o.partition || P) + '-h' + i, body: body(i, o.pad), ts: (o.ts != null ? o.ts : OLD) + i,
        sender: 'someone', recipient: o.partition || P, mtype: 'direct', needsReply: !!(o.questionAt && o.questionAt.includes(i)),
      });
    }
    if (o.floor != null) {
      const r = rc.ackFor(s, { partition: o.partition || P, target: o.floor, home, procTable: new Map() });
      assert.ok(r.ok, 'floor ack ok: ' + JSON.stringify(r));
    }
  } finally { s.close(); }
}
function bodies(home, partition) {
  const s = open(home);
  try { return s.listMessages(partition || P).map((r) => r.body); } finally { s.close(); }
}
function rawBodies(home) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(storeLib.sqlitePathForHash(home, HASH), { readOnly: true });
  try { return db.prepare('SELECT id, body FROM messages ORDER BY id').all(); } finally { db.close(); }
}
function prune(home, extra, more) {
  return ret.pruneStore(Object.assign({ home, hash: HASH, settings: settings(home, extra), now: NOW, state: ret.readState(home) }, more || {}));
}
function archiveLines(home) {
  const dir = ret.archiveDirFor(home, HASH);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ndjson\.gz$/.test(n)); } catch (_) {}
  for (const n of names) out.push(...ret.readArchiveFile(path.join(dir, n)));
  return out;
}

t('unread rows (above the floor) are never pruned; read old rows are archived then tombstoned', () => {
  const home = tmpHome();
  try {
    seed(home, 400, { floor: 300 });
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '50' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.tombstoned, 300);
    const b = bodies(home);
    assert.strictEqual(b.length, 400, 'no row deleted');
    for (let i = 0; i < 300; i++) assert.strictEqual(b[i], '', 'read row ' + i + ' pruned');
    for (let i = 300; i < 400; i++) assert.strictEqual(b[i], body(i), 'unread row ' + i + ' intact');
    const arch = archiveLines(home);
    assert.strictEqual(new Set(arch.map((x) => x.id)).size, 300);
    assert.ok(arch.every((x) => x.body === body(Number(x.hash.split('-h')[1]))), 'archive carries the original bodies');
  } finally { rm(home); }
});

t('a live declared reader below the floor pins pruning at ITS position (every reader, not just #floor)', () => {
  const home = tmpHome();
  try {
    seed(home, 400, { floor: 300 });
    const s = open(home);
    try {
      s.readerCursorTxn((tx) => tx.put({ partition: P, ns: 'store', reader: 'h:4242:1790000000000', value: 120, updatedAt: NOW }));
      // a RETIRED reader (proven ended) does not pin
      s.readerCursorTxn((tx) => tx.put({ partition: P, ns: 'store', reader: 'h:4343:1790000000000', value: 10, retiredLine: 10, updatedAt: NOW }));
    } finally { s.close(); }
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' });
    assert.strictEqual(r.tombstoned, 120);
    const b = bodies(home);
    assert.strictEqual(b[119], '');
    assert.strictEqual(b[120], body(120), 'position 121 is unread for the live reader at 120');
  } finally { rm(home); }
});

t('in-transaction re-check: a reader that falls back between plan and prune keeps its rows', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' }, {
      hooks: {
        afterArchive: () => {
          const s = open(home);
          try { s.readerCursorTxn((tx) => tx.put({ partition: P, ns: 'store', reader: 'h:5151:1790000000000', value: 40, updatedAt: NOW })); } finally { s.close(); }
        },
      },
    });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.tombstoned, 40);
    assert.strictEqual(bodies(home)[40], body(40));
  } finally { rm(home); }
});

t('keep-last-N: the latest keepPerPartition rows keep their bodies even when read and old', () => {
  const home = tmpHome();
  try {
    seed(home, 250, { floor: 250 });
    const r = prune(home);
    assert.strictEqual(r.tombstoned, 50);
    const b = bodies(home);
    assert.strictEqual(b[49], '');
    assert.strictEqual(b[50], body(50));
  } finally { rm(home); }
});

t('open questions (needs_reply) and bodies mirrored in the NDJSON inbox are protected', () => {
  const home = tmpHome();
  try {
    seed(home, 100, { floor: 100, questionAt: [5, 6] });
    const inbox = path.join(home, 'inbox.ndjson');
    fs.writeFileSync(inbox, body(7) + '\n' + body(8) + '\n');
    const s = open(home);
    try { s.upsertRegistry({ id: P, worktreePath: path.join(home, 'wt'), inboxPath: inbox }); } finally { s.close(); }
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' });
    assert.strictEqual(r.tombstoned, 96);
    const b = bodies(home);
    for (const i of [5, 6, 7, 8]) assert.strictEqual(b[i], body(i), 'row ' + i + ' protected');
  } finally { rm(home); }
});

t('size limit: prunes eligible rows regardless of age, stops at protected rows and WARNs (never touches unread)', () => {
  const home = tmpHome();
  try {
    seed(home, 200, { floor: 100, ts: NOW - 1000, pad: 4000 }); // young rows, ~800 KB of bodies
    const e = { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0', ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB: '0.1' };
    const aged = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' });
    assert.strictEqual(aged.tombstoned, 0, 'nothing is old enough without the size limit');
    const r = prune(home, e);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.tombstoned, 100, 'every read row went, oldest first');
    assert.ok(r.overLimit && r.overLimitProtected, JSON.stringify({ o: r.overLimit, p: r.overLimitProtected, a: r.bytesAfter }));
    const b = bodies(home);
    for (let i = 100; i < 200; i++) assert.strictEqual(b[i], body(i, 4000), 'unread row ' + i + ' intact');
    const st = ret.readState(home);
    st.phase = 'armed';
    st.stores[HASH] = { lastRunAt: NOW, overLimitProtected: true };
    ret.writeState(home, st);
    const doc = ret.doctorCheck({ home, env: env(e) });
    assert.ok(doc.some((x) => x.status === 'WARN' && /unread\/protected/.test(x.message)), JSON.stringify(doc));
    const log = fs.readFileSync(ret.logPath(home), 'utf8');
    assert.match(log, /over-limit-protected/);
    assert.doesNotMatch(log, /xxxx/, 'the log never carries bodies');
  } finally { rm(home); }
});

t('size limit: oldest-first stops as soon as the store is under the limit', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300, ts: NOW - 1000, pad: 4000 }); // ~1.2 MB bodies, all read
    const before = ret.storeBytes(home, HASH);
    const limitMB = (before / (1024 * 1024)) * 0.6;
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0', ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB: String(limitMB) });
    assert.ok(r.ok, r.error);
    assert.ok(r.bytesAfter <= limitMB * 1024 * 1024, r.bytesAfter + ' <= ' + limitMB * 1024 * 1024);
    assert.ok(r.tombstoned > 0 && r.tombstoned < 300, 'pruned only part: ' + r.tombstoned);
    const b = bodies(home);
    assert.strictEqual(b[0], '', 'oldest went first');
    assert.strictEqual(b[299], body(299, 4000), 'newest kept');
    assert.strictEqual(r.overLimitProtected, false);
  } finally { rm(home); }
});

t('crash between archive and prune: archive is durable first, bodies intact; re-run completes; restore dedupes', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const e = { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' };
    const crashed = prune(home, e, { hooks: { afterArchive: () => { throw new Error('simulated crash'); } } });
    assert.strictEqual(crashed.ok, false);
    assert.strictEqual(crashed.tombstoned, 0);
    const firstBatch = archiveLines(home);
    assert.strictEqual(firstBatch.length, ret.BATCH_ROWS > 300 ? 300 : ret.BATCH_ROWS, 'first batch archived before the crash');
    assert.ok(rawBodies(home).every((r) => r.body != null), 'no body lost');
    const again = prune(home, e);
    assert.ok(again.ok, again.error);
    assert.strictEqual(again.tombstoned, 300);
    const all = archiveLines(home);
    assert.ok(all.length > 300, 'duplicate lines from the crashed batch');
    const tomb = rawBodies(home).filter((r) => r.body == null).map((r) => Number(r.id));
    const archivedIds = new Set(all.map((x) => Number(x.id)));
    assert.ok(tomb.every((id) => archivedIds.has(id)), 'every tombstoned row is in the archive');
    const month = ret.monthOf(OLD);
    const rs = ret.restore({ home, hash: HASH, month, now: NOW });
    assert.ok(rs.ok, rs.error);
    assert.strictEqual(rs.unique, 300);
    assert.strictEqual(rs.restored, 300);
  } finally { rm(home); }
});

t('restore round-trips bodies exactly and holds them from immediate re-pruning; idempotent', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const before = bodies(home);
    const e = { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' };
    assert.strictEqual(prune(home, e).tombstoned, 300);
    const res = cli.run(['retention', 'restore', '--store', HASH, '--month', ret.monthOf(OLD)], { home, env: env(), now: NOW });
    assert.strictEqual(res.code, 0, JSON.stringify(res.result));
    assert.strictEqual(res.result.restored, 300);
    assert.deepStrictEqual(bodies(home), before);
    assert.strictEqual(ret.restore({ home, hash: HASH, month: ret.monthOf(OLD), now: NOW }).alreadyPresent, 300, 'restore twice is a no-op');
    assert.strictEqual(prune(home, e).tombstoned, 0, 'held for 7 days');
    const later = ret.pruneStore({ home, hash: HASH, settings: settings(home, e), now: NOW + 8 * 86400000, state: ret.readState(home) });
    assert.strictEqual(later.tombstoned, 300, 'hold expires');
  } finally { rm(home); }
});

t('idempotent: a second run prunes nothing and leaves the archive unchanged', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const e = { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' };
    assert.strictEqual(prune(home, e).tombstoned, 300);
    const size = ret.listArchiveFiles(home).reduce((a, f) => a + f.bytes, 0);
    const again = prune(home, e);
    assert.strictEqual(again.tombstoned, 0);
    assert.strictEqual(again.batches, 0);
    assert.strictEqual(ret.listArchiveFiles(home).reduce((a, f) => a + f.bytes, 0), size);
  } finally { rm(home); }
});

t('first sweep on a machine is a dry-run report only; the next sweep acts', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const e = env({ ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' });
    const first = ret.sweep({ home, env: e, now: NOW });
    assert.strictEqual(first.phase, 'dry-run');
    assert.ok(rawBodies(home).every((r) => r.body != null), 'dry-run changed nothing');
    assert.ok(!fs.existsSync(ret.archiveRoot(home)), 'dry-run wrote no archive');
    const report = JSON.parse(fs.readFileSync(ret.dryRunReportPath(home), 'utf8'));
    assert.strictEqual(report.stores[HASH].ageCandidates, 300);
    assert.strictEqual(ret.readState(home).phase, 'armed');
    const second = ret.sweep({ home, env: e, now: NOW });
    assert.strictEqual(second.phase, 'armed');
    assert.strictEqual(second.store.tombstoned, 300);
    const third = ret.sweep({ home, env: e, now: NOW + 1000 });
    assert.strictEqual(third.store, null, 'the store is not revisited inside the 6h interval');
  } finally { rm(home); }
});

t('floors, counts, unread rows and the summary projection are unchanged by a prune', () => {
  const home = tmpHome();
  try {
    seed(home, 400, { floor: 250, questionAt: [3] });
    const s0 = open(home);
    try {
      s0.upsertRegistry({ id: 'ws-beta', worktreePath: path.join(home, 'wt-beta') });
      // ws-beta only heartbeats early (its latest heartbeat is old and outside
      // keep-last-N — working_on must still survive); ws-alpha keeps talking.
      for (let i = 0; i < 300; i++) {
        const from = i < 100 && i % 2 ? 'ws-beta' : 'ws-alpha';
        const r = storeLib.appendMeshMessage(s0, {
          from, type: 'broadcast', isHeartbeat: i % 3 !== 0, message: 'hb ' + (i % 7) + ' ' + from, timestamp: OLD + i, hash: 'bc-' + i,
        });
        assert.ok(r.inserted);
        if (i === 150) s0.advanceBroadcastCursor(P); // alpha has seen broadcasts up to here; beta has no cursor (0)
      }
    } finally { s0.close(); }
    const snap = () => {
      const s = open(home);
      try {
        const c = rc.countFor(s, { partition: P, home });
        const sum = storeLib.computeSummary(s, { home, now: NOW });
        const w = sum.workspaces[P] || {};
        return {
          floor: rc.floorOf(s, P, 'store', { home }), total: s.messageCount(P), unread: c.unread, known: c.known,
          unreadRows: s.listMessages(P, { sinceCursor: c.storeCursor }).map((r) => [r.index, r.seq, r.hash, r.body]),
          summary: { total: w.total, unread: w.unread, pendingQuestions: w.pendingQuestions, working_on: w.working_on, broadcastUnread: w.broadcastUnread },
          beta: (sum.workspaces['ws-beta'] || {}).working_on,
          recent: sum.recent,
        };
      } finally { s.close(); }
    };
    const before = snap();
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '10' });
    assert.ok(r.ok, r.error);
    assert.ok(r.tombstoned >= 249, 'pruned: ' + r.tombstoned);
    assert.ok(r.partitions[storeLib.BROADCAST_PARTITION_ID].protected.broadcast > 0, 'broadcast rules engaged');
    assert.ok(r.partitions[storeLib.BROADCAST_PARTITION_ID].candidates > 0, 'old heartbeats are prunable');
    assert.ok(before.beta, 'beta has a working_on to protect');
    assert.deepStrictEqual(snap(), before);
  } finally { rm(home); }
});

t('VACUUM shrinks the file after a large prune', () => {
  const home = tmpHome();
  try {
    seed(home, 600, { floor: 600, pad: 3000 });
    const before = ret.storeBytes(home, HASH);
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' });
    assert.ok(r.vacuum && r.vacuum.ran, JSON.stringify(r.vacuum));
    assert.ok(r.bytesAfter < before / 2, before + ' -> ' + r.bytesAfter);
  } finally { rm(home); }
});

t('legacy journal of a merged split store is compressed into the archive and verified before removal', () => {
  const home = tmpHome();
  try {
    seed(home, 5, { floor: 5 });
    const dir = storeLib.storeDirForHash(home, HASH);
    fs.writeFileSync(path.join(dir, 'BACKEND'), 'sqlite');
    const s = open(home);
    let rows;
    try { rows = s.listMessages(P); } finally { s.close(); }
    const jdir = path.join(dir, 'journal');
    fs.mkdirSync(jdir);
    const text = rows.map((m) => JSON.stringify({ workspaceId: P, ts: m.ts, hash: m.hash, body: m.body })).join('\n') + '\n';
    fs.writeFileSync(path.join(jdir, 'messages.ndjson'), text);
    const notYet = ret.foldLegacyJournal({ home, hash: HASH });
    assert.strictEqual(notYet.reason, 'merge-not-recorded', 'no MERGE-STATE -> left alone');
    fs.writeFileSync(path.join(dir, 'MERGE-STATE.json'), JSON.stringify({ mergedAt: NOW }));
    const dry = ret.foldLegacyJournal({ home, hash: HASH, dryRun: true });
    assert.ok(dry.eligible, JSON.stringify(dry));
    assert.ok(fs.existsSync(path.join(jdir, 'messages.ndjson')), 'dry-run keeps the file');
    const r = ret.foldLegacyJournal({ home, hash: HASH });
    assert.ok(r.eligible);
    assert.ok(!fs.existsSync(jdir), 'raw journal removed');
    const gz = path.join(ret.archiveRoot(home), r.files[0].dest);
    assert.strictEqual(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), text);
  } finally { rm(home); }
});

t('archive cap evicts the oldest month files first and logs each', () => {
  const home = tmpHome();
  try {
    const dir = ret.archiveDirFor(home, HASH);
    fs.mkdirSync(dir, { recursive: true });
    for (const m of ['2026-01', '2026-02', '2026-03']) fs.writeFileSync(path.join(dir, m + '.ndjson.gz'), Buffer.alloc(400 * 1024));
    const r = ret.enforceArchiveCap({ home, env: env({ ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB: '0.9' }) });
    assert.deepStrictEqual(r.removed.map((x) => path.basename(x.file)), ['2026-01.ndjson.gz']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['2026-02.ndjson.gz', '2026-03.ndjson.gz']);
    assert.match(fs.readFileSync(ret.logPath(home), 'utf8'), /archive-evict.*2026-01/);
  } finally { rm(home); }
});

t('settings: env > settings.json (devswarm.retention.*) > defaults; days=0 disables', () => {
  const home = tmpHome();
  try {
    assert.deepStrictEqual(ret.resolveSettings({ home, env: {} }), Object.assign({}, ret.DEFAULTS, { enabled: true }));
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { retention: { days: 10, archive: false, maxStoreMB: 'junk' } } }));
    const s = ret.resolveSettings({ home, env: { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '7' } });
    assert.strictEqual(s.days, 10);
    assert.strictEqual(s.archive, false);
    assert.strictEqual(s.maxStoreMB, 100, 'invalid -> default');
    assert.strictEqual(s.keepPerPartition, 7);
    const off = ret.resolveSettings({ home, env: { ANTIHALL_DEVSWARM_RETENTION_DAYS: '0' } });
    assert.strictEqual(off.enabled, false);
    seed(home, 300, { floor: 300 });
    assert.strictEqual(ret.pruneStore({ home, hash: HASH, settings: off, now: NOW }).skipped, 'disabled');
  } finally { rm(home); }
});

t('archive=false prunes without writing an archive; CLI run --dry-run writes nothing', () => {
  const home = tmpHome();
  try {
    seed(home, 300, { floor: 300 });
    const dry = cli.run(['retention', 'run', '--dry-run', '--store', HASH], { home, env: env({ ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0' }), now: NOW });
    assert.strictEqual(dry.code, 0, JSON.stringify(dry.result));
    assert.strictEqual(dry.result.stores[0].ageCandidates, 300);
    assert.ok(rawBodies(home).every((r) => r.body != null));
    const r = prune(home, { ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION: '0', ANTIHALL_DEVSWARM_RETENTION_ARCHIVE: 'false' });
    assert.strictEqual(r.tombstoned, 300);
    assert.ok(!fs.existsSync(ret.archiveRoot(home)));
  } finally { rm(home); }
});

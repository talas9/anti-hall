'use strict';
// devswarm-store PROJECTION split (mesh self-heal Phase A — foundation).
// Covers the pure computeSummary / deriveSummary split (A1), orphan detection (A2),
// and stale-registry-partition detection (A3). Behavioral contract is backend-
// independent, so the same suite runs against BOTH backends (journal always; sqlite
// only when node:sqlite is present). NO behavior change to existing outputs — the
// byte-identical proof (A1) is a golden captured from the PRE-split deriveSummary.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-store-proj-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// walk(home) -> { relpath: {mtimeMs, size} } for every file under home. Used to
// prove computeSummary mutates NO file (mtime unchanged + no new file created).
function walk(dir, base) {
  const root = base || dir;
  const out = {};
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { Object.assign(out, walk(full, root)); continue; }
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    out[path.relative(root, full)] = { mtimeMs: st.mtimeMs, size: st.size };
  }
  return out;
}

// GOLDEN — the EXACT summary.json bytes produced by the PRE-split deriveSummary for
// the deterministic fixture below (home path normalized to <HOME>). Captured from
// the code as it stood BEFORE the computeSummary extraction; the refactor must
// reproduce it byte-for-byte. Both backends produced the identical string.
const GOLDEN = '{"generatedAt":1234567890,"requiredGates":["done","merged","tests_passed"],"workspaces":{"a":{"id":"a","worktreePath":"<HOME>/wt-a","sessionId":"sess-a","inboxPath":"/inbox/a","cursorPath":"/cursor/a","nudgeCommand":null,"total":1,"cursor":0,"unread":1,"directUnread":1,"broadcastUnread":0,"urgencyMax":"normal","broadcastUrgencyMax":null,"working_on":null,"gates":{},"archive_ready":false,"archive_requested":false}},"recent":[]}';

// normalizeHomeForGolden(raw, home) -> `raw` with every occurrence of `home`
// collapsed to `<HOME>`, comparable cross-platform against the forward-slash
// GOLDEN literal above. `raw` is JSON TEXT, not the parsed string: a literal
// backslash inside a JSON string is emitted doubled (`\\`), so on win32 a
// naive `raw.split(home)` never matches (home has single backslashes, raw has
// doubled ones) and the worktreePath separator itself (`path.join(home,
// 'wt-a')`) is backslash- not forward-slash-joined. Fix: collapse JSON's
// doubled backslash escaping down to a single logical backslash first, THEN
// normalize every separator (both sides) to '/', THEN substitute. This is a
// no-op on posix (no backslashes to collapse or normalize). It does NOT need
// to canonicalize 8.3 short names (e.g. win32 CI's `RUNNER~1`): `home` and
// the stored worktreePath both derive from the identical JS string
// (`path.join(home, 'wt-a')`, never realpath'd by deriveSummary — see A1's
// comment above), so whatever spelling `home` has, the emitted path carries
// the same spelling verbatim.
function normalizeHomeForGolden(raw, home) {
  const rawUnescaped = raw.replace(/\\\\/g, '\\').split('\\').join('/');
  const homeNorm = home.split('\\').join('/');
  return rawUnescaped.split(homeNorm).join('<HOME>');
}

// buildGoldenFixture(s, home) — the fixture the GOLDEN was captured from: one
// registered workspace whose worktreePath EXISTS on disk (so it is never flagged
// stale) with a single unread direct message (so the sole partition is registered ->
// no orphan). Deterministic given a pinned `now`.
function buildGoldenFixture(s, home) {
  const wtA = path.join(home, 'wt-a');
  fs.mkdirSync(wtA, { recursive: true });
  s.upsertRegistry({ id: 'a', worktreePath: wtA, sessionId: 'sess-a', inboxPath: '/inbox/a', cursorPath: '/cursor/a', nudgeCommand: null });
  store.appendMeshMessage(s, {
    from: 'z', to: 'a', type: 'direct', message: 'hi', timestamp: 1000, urgency: 'normal',
    hash: store.meshMessageHash({ from: 'z', to: 'a', type: 'direct', message: 'hi', timestamp: 1000, urgency: 'normal' }),
  });
}

// ---- backend matrix -------------------------------------------------------
const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  // ---- A1: byte-identical deriveSummary (regression proof vs pre-split golden) ----
  test(`[${B.name}] deriveSummary output is byte-identical to the pre-split golden`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      buildGoldenFixture(s, home);
      store.deriveSummary(s, { home, now: 1234567890 });
      const raw = fs.readFileSync(store.summaryPath(home), 'utf8');
      const norm = normalizeHomeForGolden(raw, home);
      assert.equal(norm, GOLDEN);
    } finally { s.close(); rm(home); }
  });

  // ---- A1: computeSummary == deriveSummary's projection ----
  test(`[${B.name}] computeSummary returns the same projection deriveSummary writes`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      buildGoldenFixture(s, home);
      const projection = store.computeSummary(s, { home, now: 42 });
      const written = store.deriveSummary(s, { home, now: 42 });
      assert.deepStrictEqual(projection, written, 'computeSummary object matches deriveSummary return');
      // and matches what actually hit disk
      const onDisk = JSON.parse(fs.readFileSync(store.summaryPath(home), 'utf8'));
      assert.deepStrictEqual(onDisk, projection, 'computeSummary object matches the on-disk summary.json');
    } finally { s.close(); rm(home); }
  });

  // ---- A1 HARD CONSTRAINT: computeSummary is PURE (writes nothing, mutates no mtime) ----
  test(`[${B.name}] computeSummary changes no file mtime and creates no file (pure)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      buildGoldenFixture(s, home);
      // Establish an on-disk summary first so there is a file that COULD be rewritten.
      store.deriveSummary(s, { home, now: 7 });
      const before = walk(home);
      assert.ok(Object.keys(before).length > 0, 'fixture wrote some files to snapshot');
      const projection = store.computeSummary(s, { home, now: 8 });
      assert.ok(projection && typeof projection === 'object');
      const after = walk(home);
      assert.deepStrictEqual(after, before, 'computeSummary must not create/modify any file (mtime + size + file set unchanged)');
    } finally { s.close(); rm(home); }
  });

  // ---- A2: orphan detection (surface-only) ----
  test(`[${B.name}] orphans[]: unread partition with no registry row appears`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.appendMessage({ workspaceId: 'ghost', body: 'stranded', hash: 'g1' }); // no registry row, cursor 0 -> unread
      const sum = store.computeSummary(s, { home, now: 1 });
      const orphans = sum.orphans || [];
      const ghost = orphans.find((o) => o.id === 'ghost');
      assert.ok(ghost, 'ghost partition is surfaced as an orphan');
      assert.equal(ghost.messageCount, 1);
      assert.equal(ghost.unread, 1);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] orphans[]: a partition WITH a live registry row is absent`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const wt = path.join(home, 'wt-live'); fs.mkdirSync(wt, { recursive: true });
      s.upsertRegistry({ id: 'live', worktreePath: wt, sessionId: 'x' });
      s.appendMessage({ workspaceId: 'live', body: 'm', hash: 'l1' }); // unread, but registered
      const sum = store.computeSummary(s, { home, now: 1 });
      const orphans = sum.orphans || [];
      assert.ok(!orphans.some((o) => o.id === 'live'), 'a registered partition is never an orphan');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] orphans[]: a partition with 0 unread is absent`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      s.appendMessage({ workspaceId: 'seen', body: 'm', hash: 's1' }); // no registry row
      s.setCursor('seen', 1); // fully consumed -> unread 0
      const sum = store.computeSummary(s, { home, now: 1 });
      const orphans = sum.orphans || [];
      assert.ok(!orphans.some((o) => o.id === 'seen'), 'a fully-read partition is never an orphan');
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] orphans/stale keys are OMITTED when empty (byte-identical guarantee)`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      buildGoldenFixture(s, home); // no orphan, no stale
      const sum = store.computeSummary(s, { home, now: 1 });
      assert.ok(!('orphans' in sum), 'orphans key omitted when empty');
      assert.ok(!('staleRegistryPartitions' in sum), 'staleRegistryPartitions key omitted when empty');
    } finally { s.close(); rm(home); }
  });

  // ---- A3: stale-registry-partition detection ----
  test(`[${B.name}] staleRegistryPartitions[]: registry row whose worktreePath vanished appears`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const gone = path.join(home, 'wt-gone'); fs.mkdirSync(gone, { recursive: true });
      s.upsertRegistry({ id: 'stale', worktreePath: gone, sessionId: 'y' });
      s.appendMessage({ workspaceId: 'stale', body: 'm', hash: 'st1' }); // unread
      fs.rmSync(gone, { recursive: true, force: true }); // the worktree disappears
      const sum = store.computeSummary(s, { home, now: 1 });
      const stale = sum.staleRegistryPartitions || [];
      const row = stale.find((r) => r.id === 'stale');
      assert.ok(row, 'a registry row with a vanished worktreePath is surfaced as stale');
      assert.equal(row.worktreePath, gone);
      assert.equal(row.unread, 1);
    } finally { s.close(); rm(home); }
  });

  test(`[${B.name}] staleRegistryPartitions[]: a live existing worktree is absent`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const live = path.join(home, 'wt-here'); fs.mkdirSync(live, { recursive: true });
      s.upsertRegistry({ id: 'here', worktreePath: live, sessionId: 'z' });
      const sum = store.computeSummary(s, { home, now: 1 });
      const stale = sum.staleRegistryPartitions || [];
      assert.ok(!stale.some((r) => r.id === 'here'), 'an on-disk worktree is never flagged stale');
    } finally { s.close(); rm(home); }
  });

  // P2a: a stale row (worktree gone) that has been fully DRAINED (unread:0) is NOT
  // stuck — surfacing it makes parent-inbox falsely warn it "still hold[s] unread".
  // Only a stale row that genuinely still holds unread is surfaced (parity with orphans).
  test(`[${B.name}] staleRegistryPartitions[]: a DRAINED stale row (unread:0) is NOT surfaced; still-unread IS`, () => {
    const home = tmpHome();
    const s = open(home);
    try {
      const goneDrained = path.join(home, 'wt-gone-drained'); fs.mkdirSync(goneDrained, { recursive: true });
      s.upsertRegistry({ id: 'drained', worktreePath: goneDrained, sessionId: 'd' });
      s.appendMessage({ workspaceId: 'drained', body: 'm', hash: 'd1' });
      s.setCursor('drained', 1); // fully consumed -> unread 0

      const goneUnread = path.join(home, 'wt-gone-unread'); fs.mkdirSync(goneUnread, { recursive: true });
      s.upsertRegistry({ id: 'unread', worktreePath: goneUnread, sessionId: 'u' });
      s.appendMessage({ workspaceId: 'unread', body: 'm', hash: 'u1' }); // unread 1

      fs.rmSync(goneDrained, { recursive: true, force: true });
      fs.rmSync(goneUnread, { recursive: true, force: true });

      const sum = store.computeSummary(s, { home, now: 1 });
      const stale = sum.staleRegistryPartitions || [];
      assert.ok(!stale.some((r) => r.id === 'drained'), 'a drained stale row (unread:0) is NOT surfaced as stuck');
      assert.ok(stale.some((r) => r.id === 'unread'), 'a still-unread stale row IS surfaced');
    } finally { s.close(); rm(home); }
  });
}

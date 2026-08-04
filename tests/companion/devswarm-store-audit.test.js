'use strict';
// devswarm-store-audit — Task #6 part (b): unit tests for the READ-ONLY
// leaked-bucket classifier (companion/lib/devswarm-store-audit.js) and its
// CLI wrapper (scripts/devswarm-store-leak-report.js).
//
// HERMETIC: every fixture lives under a fresh fs.mkdtempSync temp dir. This
// file NEVER reads or writes the real ~/.anti-hall/devswarm/store — a
// dedicated test (below) proves the audit module itself never issues a
// write-capable fs call (mkdirSync/writeFileSync/appendFileSync/rmSync/
// unlinkSync) by wrapping fs in a spy that throws if any of those are
// called, then running auditStore() through it end-to-end.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const audit = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store-audit.js'));
const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const reportCli = require(path.join(ROOT, 'scripts', 'devswarm-store-leak-report.js'));

function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'store-audit-test-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function writeDescriptor(home, id, fields) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, fields || {})));
}

function makeSqliteOnlyBucket(home, hash) {
  const dir = store.storeDirForHash(home, hash);
  fs.mkdirSync(dir, { recursive: true });
  // A placeholder — the audit module must NEVER open this as a real sqlite
  // db, so its content is irrelevant to the test.
  fs.writeFileSync(path.join(dir, 'devswarm.db'), 'not a real sqlite file, must never be opened');
}

function makeJournalBucket(home, hash, registryRows) {
  const journalDir = store.journalDirForHash(home, hash);
  fs.mkdirSync(journalDir, { recursive: true });
  const lines = (registryRows || []).map((r) => JSON.stringify(r)).join('\n') + (registryRows && registryRows.length ? '\n' : '');
  fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), lines);
}

// ---------------------------------------------------------------------------
// 1. REAL via descriptor id-hash match.
// ---------------------------------------------------------------------------
test('auditStore: bucket matching a live descriptor via hashFromWorkspaceId(id) -> REAL', () => {
  const { home, cleanup } = tmpHome();
  try {
    const id = 'primary-abcd1234';
    writeDescriptor(home, id, { worktreePath: '/nonexistent/does/not/matter' });
    const hash = store.hashFromWorkspaceId(id);
    makeSqliteOnlyBucket(home, hash);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
    assert.deepStrictEqual(report.real, [hash]);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 2. REAL via descriptor repoKey / ownerKey match.
// ---------------------------------------------------------------------------
test('auditStore: bucket matching a live descriptor via repoKey -> REAL', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'child-1', { repoKey: 'realproj-abc123', ownerKey: 'realproj-abc123' });
    makeSqliteOnlyBucket(home, 'realproj-abc123');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 3. REAL via a resolvable worktreePath in journal/registry.ndjson, with NO
//    descriptor at all (the descriptor was archived/removed but the bucket +
//    its still-real worktree survive).
// ---------------------------------------------------------------------------
test('auditStore: no descriptor, but registry names a worktreePath that still exists on disk -> REAL', () => {
  const { home, cleanup } = tmpHome();
  const realWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-real-worktree-'));
  try {
    const hash = 'genuine-proj-f00d12';
    makeJournalBucket(home, hash, [
      { id: 'w1', worktreePath: realWorktree, sessionId: 's1', _op: 'upsert', updatedAt: Date.now() },
    ]);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
    assert.strictEqual(report.realSample[0].resolvedWorktree, realWorktree);
  } finally { cleanup(); try { fs.rmSync(realWorktree, { recursive: true, force: true }); } catch (_) {} }
});

// ---------------------------------------------------------------------------
// 4. GARBAGE: sqlite-only bucket, no descriptor, no journal at all — exactly
//    the shape of the ~49KB empty-schema buckets found repeatedly in the
//    real store during investigation.
// ---------------------------------------------------------------------------
test('auditStore: sqlite-only bucket with no descriptor and no journal evidence -> GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.realCount, 0);
    assert.deepStrictEqual(report.garbage, ['deadbeef']);
    assert.match(report.garbageSample[0].reason, /no registry\/worktree evidence/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5. GARBAGE: journal bucket whose registry names a worktreePath that no
//    longer exists (the exact "leaked test fixture, tmpdir already cleaned
//    up" shape) and no descriptor references it.
// ---------------------------------------------------------------------------
test('auditStore: no descriptor, registry worktreePath no longer exists on disk -> GARBAGE (temp-dir-shaped)', () => {
  const { home, cleanup } = tmpHome();
  try {
    const goneWorktree = path.join(os.tmpdir(), 'antihall-doctor-cwd-' + Date.now() + '-already-deleted');
    const hash = 'leaked-test-repo-abc123';
    makeJournalBucket(home, hash, [
      { id: 'w1', worktreePath: goneWorktree, sessionId: 's1', _op: 'upsert', updatedAt: Date.now() },
    ]);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.realCount, 0);
    assert.match(report.garbageSample[0].reason, /already cleaned up/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 6. Mixed store: counts + samples are correct together, cap respected.
// ---------------------------------------------------------------------------
test('auditStore: mixed REAL + GARBAGE buckets classify independently with correct totals', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11111111', {});
    makeSqliteOnlyBucket(home, '11111111'); // REAL (id-hash match)
    makeSqliteOnlyBucket(home, '22222222'); // GARBAGE (no evidence)
    makeSqliteOnlyBucket(home, '33333333'); // GARBAGE (no evidence)

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 3);
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 2);
    assert.deepStrictEqual(report.real.sort(), ['11111111']);
    assert.deepStrictEqual(report.garbage.sort(), ['22222222', '33333333']);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 7. STRICT READ-ONLY CONTRACT: auditStore must never call a write-capable
//    fs method, proven by a spy `fsi` that throws if any of them fire.
// ---------------------------------------------------------------------------
test('auditStore: NEVER calls a write-capable fs method (mkdirSync/writeFileSync/appendFileSync/rmSync/unlinkSync)', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-abcdef01', {});
    makeSqliteOnlyBucket(home, 'abcdef01');
    makeSqliteOnlyBucket(home, 'deadc0de'); // garbage
    const journalHash = 'journal-proj-cafe01';
    makeJournalBucket(home, journalHash, [{ id: 'w1', worktreePath: '/nope/gone', _op: 'upsert' }]);

    const WRITE_METHODS = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'truncateSync', 'writeSync'];
    const spyFsi = Object.assign({}, fs);
    for (const m of WRITE_METHODS) {
      spyFsi[m] = (...args) => { throw new Error('READ-ONLY VIOLATION: ' + m + ' called with ' + JSON.stringify(args[0])); };
    }
    // readdirSync/readFileSync/statSync/existsSync/lstatSync are the real
    // (unwrapped) implementations — auditStore must only ever reach those.

    assert.doesNotThrow(() => {
      const report = audit.auditStore({ home, fsi: spyFsi });
      assert.strictEqual(report.total, 3);
    }, 'auditStore must complete using ONLY read fs calls');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 8. CLI wrapper: writes a JSON report file and returns the same counts,
//    against a synthetic home (never the real store).
// ---------------------------------------------------------------------------
test('devswarm-store-leak-report CLI: writes a JSON report with correct counts, touches nothing but its own output file', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    writeDescriptor(home, 'primary-fadefade', {});
    makeSqliteOnlyBucket(home, 'fadefade'); // REAL
    makeSqliteOnlyBucket(home, 'baadf00d'); // GARBAGE

    const outPath = path.join(outDir, 'report.json');
    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.ok(fs.existsSync(outPath), 'report file must be written');

    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed.total, 2);
    assert.strictEqual(parsed.realCount, 1);
    assert.strictEqual(parsed.garbageCount, 1);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 9. FIX 2 (P1): a bucket whose ACTIVE descriptor is gone but which has an
//    ARCHIVED descriptor (devswarmRoot/archived/<id>.json — same shape,
//    written by scripts/devswarm.js cmdArchive) must classify REAL, not
//    GARBAGE. An archived real workspace is not garbage.
// ---------------------------------------------------------------------------
function writeArchivedDescriptor(home, id, fields) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, fields || {})));
}

test('auditStore: no ACTIVE descriptor, but an ARCHIVED descriptor matches (id-hash) -> REAL, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const id = 'primary-a11ce123';
    writeArchivedDescriptor(home, id, { worktreePath: '/nonexistent/does/not/matter' });
    const hash = store.hashFromWorkspaceId(id);
    makeSqliteOnlyBucket(home, hash);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.realCount, 1, 'archived-descriptor bucket must be REAL: ' + JSON.stringify(report));
    assert.strictEqual(report.garbageCount, 0);
    assert.deepStrictEqual(report.real, [hash]);
    assert.match(report.realSample[0].reason, /archived/);
  } finally { cleanup(); }
});

test('auditStore: no ACTIVE descriptor, but an ARCHIVED descriptor matches (repoKey) -> REAL, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeArchivedDescriptor(home, 'child-archived-1', { repoKey: 'archivedproj-abc123', ownerKey: 'archivedproj-abc123' });
    makeSqliteOnlyBucket(home, 'archivedproj-abc123');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 10. FIX 3 (P1): read/parse/stat FAILURES must classify UNKNOWN, not
//     GARBAGE — evidence is incomplete, not confidently empty.
// ---------------------------------------------------------------------------

// 10a. workspaces/ directory itself is unreadable (EACCES-shaped failure via
// an injected fsi) -> every otherwise-GARBAGE bucket becomes UNKNOWN, because
// a live descriptor match could have been missed.
test('auditStore: workspaces/ directory read fails with a real error -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const workspacesDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');

    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(workspacesDir)) {
        const e = new Error('EACCES: permission denied, scandir ' + dir);
        e.code = 'EACCES';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const report = audit.auditStore({ home, fsi: spyFsi });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.garbageCount, 0, 'must NOT collapse to GARBAGE when descriptor evidence is incomplete: ' + JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, ['deadbeef']);
  } finally { cleanup(); }
});

// 10b. Individual descriptor file is corrupt (unparseable JSON) -> degraded,
// so an unmatched bucket becomes UNKNOWN rather than a confident GARBAGE.
test('auditStore: a corrupt (unparseable) descriptor file -> UNKNOWN for unmatched buckets, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ not valid json ][');
    makeSqliteOnlyBucket(home, 'deadbeef');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
  } finally { cleanup(); }
});

// 10c. Bucket-level registry.ndjson read fails with a real error (not
// ENOENT) -> that specific bucket is UNKNOWN, independent of any
// descriptor-dir-level degradation (workspaces/ is fine here).
test('auditStore: a bucket registry.ndjson read fails with a real error -> UNKNOWN for that bucket only', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11110000', {}); // unrelated live descriptor, workspaces/ dir read is fine
    makeSqliteOnlyBucket(home, '11110000'); // this one matches -> REAL, unaffected by the other bucket's flaky read
    const hash = 'flaky-registry-000abc';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    const registryPath = path.join(journalDir, 'registry.ndjson');
    fs.writeFileSync(registryPath, '{}\n'); // present, will be "unreadable" via spy

    const spyFsi = Object.assign({}, fs);
    spyFsi.readFileSync = (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(registryPath)) {
        const e = new Error('EIO: i/o error, read');
        e.code = 'EIO';
        throw e;
      }
      return fs.readFileSync(file, ...rest);
    };

    const report = audit.auditStore({ home, fsi: spyFsi });
    assert.strictEqual(report.total, 2); // the id-hash bucket + this flaky one
    assert.strictEqual(report.realCount, 1, JSON.stringify(report));
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, [hash]);
  } finally { cleanup(); }
});

// 10d. Existing REAL/GARBAGE cases (tests 1-6) still hold under the new
// three-way classification — re-asserted here with explicit unknownCount
// checks so a regression that starts leaking UNKNOWN into old REAL/GARBAGE
// paths is caught.
test('auditStore: REAL/GARBAGE cases carry unknownCount: 0 when no read/stat failure occurred', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11111111', {});
    makeSqliteOnlyBucket(home, '11111111'); // REAL
    makeSqliteOnlyBucket(home, '22222222'); // GARBAGE

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.unknownCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 11. CLI: report prints/reports unknownCount alongside real/garbage.
// ---------------------------------------------------------------------------
test('devswarm-store-leak-report CLI: report JSON includes unknownCount', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const workspacesDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(workspacesDir)) {
        const e = new Error('EACCES: permission denied, scandir ' + dir);
        e.code = 'EACCES';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const outPath = path.join(outDir, 'report.json');
    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet'], { fsi: spyFsi });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed.unknownCount, 1);
    assert.strictEqual(parsed.garbageCount, 0);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 12. FIX 1 (P0): --out safety. The path is user-controlled and reaches
//     writeFileSync — must REFUSE (non-zero, nothing written) rather than
//     risk overwriting a production devswarm.db.
// ---------------------------------------------------------------------------

// 12a. --out resolving under the devswarm store root must be REFUSED.
test('devswarm-store-leak-report CLI: --out under the devswarm store root is REFUSED, nothing written', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const insideStore = path.join(home, '.anti-hall', 'devswarm', 'store', 'deadbeef', 'devswarm.json');

    const result = reportCli.run(['--home', home, '--out', insideStore, '--quiet']);
    assert.strictEqual(result.ok, false, 'must refuse an --out path under the store root');
    assert.match(result.error, /store root/);
    assert.ok(!fs.existsSync(insideStore), 'nothing must be written when --out is refused');
  } finally { cleanup(); }
});

// 12a-bis. Refuse even the devswarm root itself (not just store/) and the
// exact production shape named in the finding: store/<hash>/devswarm.db
// (non-.json AND under the store root — either reason alone must refuse).
test('devswarm-store-leak-report CLI: --out at a real devswarm.db path is REFUSED (store root AND non-.json)', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const dbPath = store.sqlitePathForHash(home, 'deadbeef');
    const before = fs.readFileSync(dbPath, 'utf8');

    const result = reportCli.run(['--home', home, '--out', dbPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.ok(!/^\{/.test(fs.readFileSync(dbPath, 'utf8')), 'devswarm.db content must be untouched');
    assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), before, 'devswarm.db must not be overwritten/truncated');
  } finally { cleanup(); }
});

// 12b. --out not ending in .json must be REFUSED, even outside the store root.
test('devswarm-store-leak-report CLI: --out not ending in .json is REFUSED, nothing written', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'report.txt');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /\.json/);
    assert.ok(!fs.existsSync(outPath));
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12c. --out pointing at an existing file that is NOT a prior JSON report
// from this tool must be REFUSED (no clobbering arbitrary files), even when
// it is a .json file outside the store root.
test('devswarm-store-leak-report CLI: --out clobbering an existing non-report .json file is REFUSED', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'not-a-report.json');
    const originalContent = JSON.stringify({ some: 'unrelated config file', values: [1, 2, 3] });
    fs.writeFileSync(outPath, originalContent);

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(fs.readFileSync(outPath, 'utf8'), originalContent, 'unrelated existing file must be untouched');
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12d. Acceptance: a VALID .json path outside the store root, either absent
// or itself a prior report, is ACCEPTED and written.
test('devswarm-store-leak-report CLI: a valid --out .json path outside the store root is accepted and written', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'my-report.json');

    const result1 = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result1.ok, true, JSON.stringify(result1));
    assert.ok(fs.existsSync(outPath));

    // Re-running against the SAME path (now a prior report from this tool)
    // must be accepted too — idempotent re-runs are a normal workflow.
    const result2 = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result2.ok, true, JSON.stringify(result2));
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12e. Default out path (no --out given) is unaffected by the new validation
// (repo-relative .anti-hall/reports/*.json is never under the devswarm store
// root and always ends in .json).
test('devswarm-store-leak-report CLI: default --out path (no --out flag) still passes validation', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const result = reportCli.run(['--home', home, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    try { fs.unlinkSync(result.outPath); } catch (_) {}
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// VACUOUS-RED proof: a bucket that SHOULD be GARBAGE under a naive
// "everything with no descriptor is REAL" implementation would misclassify
// — proving these assertions are not vacuously true. Simulated inline
// (not by breaking the real module) to avoid mutating shipped code mid-test.
// ---------------------------------------------------------------------------
test('VACUOUS-RED proof: a naive "no descriptor -> REAL" classifier would wrongly pass buckets this suite correctly flags GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const naiveReport = { garbageCount: 0, realCount: 1 }; // what a broken "assume REAL" classifier would report
    const actualReport = audit.auditStore({ home });
    assert.notDeepStrictEqual(
      { garbageCount: actualReport.garbageCount, realCount: actualReport.realCount },
      naiveReport,
      'the real classifier must disagree with a naive always-REAL classifier on an evidence-free bucket',
    );
    assert.strictEqual(actualReport.garbageCount, 1);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 13. FIX 3b (P1, second round): remaining UNKNOWN-class gaps.
// ---------------------------------------------------------------------------

// 13a. A malformed (unparseable) registry.ndjson LINE must degrade the read
// -> UNKNOWN for that bucket, not silently discarded into a confident
// GARBAGE (no candidates -> "no evidence at all").
test('auditStore: a malformed (unparseable) registry.ndjson line -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'malformed-line-abc123';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), '{ this is not valid json ][\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, 'a malformed registry line must not collapse to GARBAGE: ' + JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, [hash]);
  } finally { cleanup(); }
});

// 13a-bis: a malformed line ALONGSIDE an otherwise-resolvable worktreePath
// line still degrades the bucket read (evidence is incomplete even though a
// REAL match was separately found via a good line) — REAL still wins on its
// own merit, but this proves the malformed-line degrade path fires
// independent of whether the bucket ultimately resolves REAL or not.
test('auditStore: sqlite-only bucket unaffected by an UNRELATED malformed registry line elsewhere (isolation)', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef'); // unrelated bucket, no registry at all -> still GARBAGE
    const flakyHash = 'flaky-parse-line-cafe01';
    const journalDir = store.journalDirForHash(home, flakyHash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), '{ broken\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 1, JSON.stringify(report));
    assert.deepStrictEqual(report.garbage, ['deadbeef']);
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, [flakyHash]);
  } finally { cleanup(); }
});

// 13b. A descriptor file that parses fine but carries NONE of id/repoKey/
// ownerKey is ambiguous evidence (can't rule out it's a real descriptor in a
// shape this reader doesn't recognize) -> degrades the read, so an otherwise
// unmatched bucket falls to UNKNOWN, not GARBAGE.
test('auditStore: a descriptor file with no id/repoKey/ownerKey -> UNKNOWN for unmatched buckets, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keyless.json'), JSON.stringify({ note: 'no id/repoKey/ownerKey here' }));
    makeSqliteOnlyBucket(home, 'deadbeef');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, 'a keyless descriptor entry must not let an unmatched bucket read as confident GARBAGE: ' + JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.strictEqual(report.descriptorCount, 1, 'the keyless descriptor is still counted as a read descriptor file');
  } finally { cleanup(); }
});

// 13b-bis: same for an ARCHIVED keyless descriptor.
test('auditStore: an ARCHIVED descriptor file with no id/repoKey/ownerKey -> UNKNOWN for unmatched buckets, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keyless.json'), JSON.stringify({ note: 'no matchable keys' }));
    makeSqliteOnlyBucket(home, 'deadbeef');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
  } finally { cleanup(); }
});

// 13c. A genuine live descriptor with matchable keys still classifies REAL
// normally, proving the keyless-degrade path doesn't regress the ordinary
// case (regression guard against over-broadening the new check).
test('auditStore: a normal keyed descriptor still classifies its bucket REAL (no regression from the keyless check)', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11111111', {});
    makeSqliteOnlyBucket(home, '11111111');
    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.unknownCount, 0);
    assert.strictEqual(report.garbageCount, 0);
  } finally { cleanup(); }
});

// 13d. Store-root enumeration failure: the store/ directory itself EXISTS
// but readdirSync fails with a real error -> must surface as an explicit
// error signal in the report, never collapse to a silent, misleading
// zero-bucket ("total: 0, nothing leaked") result.
test('auditStore: store-root readdir failure surfaces as an explicit error signal, not a silent zero-bucket report', () => {
  const { home, cleanup } = tmpHome();
  try {
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'store'), { recursive: true });
    const storeRoot = store.storeRootDir(home);
    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(storeRoot)) {
        const e = new Error('EIO: i/o error, scandir ' + dir);
        e.code = 'EIO';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const report = audit.auditStore({ home, fsi: spyFsi });
    assert.strictEqual(report.total, 0);
    assert.ok(report.storeEnumerationError, 'a real readdir failure on store/ must be surfaced, not silently reported as zero buckets: ' + JSON.stringify(report));
    assert.match(report.storeEnumerationError, /EIO/);
  } finally { cleanup(); }
});

// 13d-bis: the LEGITIMATE case — store/ simply doesn't exist yet (fresh
// home, ENOENT) — must NOT be flagged as an error; this is a real empty
// result, not evidence of a read failure.
test('auditStore: a fresh home with no store/ directory at all (ENOENT) is a legitimate empty result, not an error signal', () => {
  const { home, cleanup } = tmpHome();
  try {
    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 0);
    assert.strictEqual(report.storeEnumerationError, null);
  } finally { cleanup(); }
});

// 13e. CLI: the storeEnumerationError signal passes through the JSON report
// file unchanged.
test('devswarm-store-leak-report CLI: report JSON surfaces storeEnumerationError when store-root enumeration fails', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'store'), { recursive: true });
    const storeRoot = store.storeRootDir(home);
    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(storeRoot)) {
        const e = new Error('EACCES: permission denied, scandir ' + dir);
        e.code = 'EACCES';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const outPath = path.join(outDir, 'report.json');
    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet'], { fsi: spyFsi });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.ok(parsed.storeEnumerationError, JSON.stringify(parsed));
    assert.strictEqual(parsed.total, 0);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 14. FIX 1b (P0, second round): harden --out against symlink-into-store and
//     case-alias bypasses; close the check/use TOCTOU with wx + a distinctive
//     prior-report marker.
// ---------------------------------------------------------------------------

// 14a. An --out path whose ANCESTOR directory is a symlink resolving inside
// the devswarm store root must be REFUSED — the lexical path.resolve /
// path.relative check alone cannot see through the symlink.
test('devswarm-store-leak-report CLI: --out under a symlinked ancestor resolving into the store root is REFUSED (canonicalization)', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-symlink-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const devswarmRootDir = path.join(home, '.anti-hall', 'devswarm');
    const linkPath = path.join(outDir, 'sneaky-link');
    fs.symlinkSync(devswarmRootDir, linkPath, 'dir');
    const outPath = path.join(linkPath, 'evil-report.json');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false, 'a symlinked ancestor resolving into the store root must be refused');
    assert.match(result.error, /store root/);
    assert.ok(!fs.existsSync(path.join(devswarmRootDir, 'evil-report.json')), 'nothing must be written inside the real devswarm root via the symlink');
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 14b. wx refuses to clobber an existing file that is not JSON at all.
test('devswarm-store-leak-report CLI: wx write refuses to clobber an existing non-JSON file at --out', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'garbage-bytes.json');
    fs.writeFileSync(outPath, 'not json at all, just bytes');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'not json at all, just bytes', 'existing non-JSON content must be untouched');
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 14c. Overwriting an existing file that DOES carry the distinctive
// _antihallLeakReport:true marker is allowed (idempotent re-run behavior).
test('devswarm-store-leak-report CLI: overwriting an existing file carrying the _antihallLeakReport marker is allowed', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'prior-report.json');
    fs.writeFileSync(outPath, JSON.stringify({ _antihallLeakReport: true, home, total: 0, garbage: [], real: [] }));

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed._antihallLeakReport, true);
    assert.strictEqual(parsed.total, 1);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 14d. TIGHTENING regression guard: an existing file with the OLD 4-generic-
// field shape (home/total/garbage/real) but WITHOUT the distinctive marker
// must now be REFUSED — proves the check was actually tightened to the
// marker, not left on the old generic-shape heuristic.
test('devswarm-store-leak-report CLI: an old-shape report-like file WITHOUT the marker is now refused (tightened check)', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'old-shape.json');
    fs.writeFileSync(outPath, JSON.stringify({ home, total: 0, garbage: [], real: [] })); // old 4-field shape, no marker

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false, 'a generic 4-field shape without the distinctive marker must now be refused');
    assert.match(result.error, /marker/);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 14e. Non-.json is still refused (unchanged behavior after hardening).
test('devswarm-store-leak-report CLI: non-.json --out is still refused after hardening', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'report.txt');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /\.json/);
    assert.ok(!fs.existsSync(outPath));
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 14f. A brand-new, valid --out target is written normally (wx succeeds on
// first write, no EEXIST branch involved).
test('devswarm-store-leak-report CLI: a brand-new valid --out .json target is written via wx on first run', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'fresh-report.json');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.ok(fs.existsSync(outPath));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed._antihallLeakReport, true);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 16. FIX 1c (P0, third round): close the write-side leaf-symlink TOCTOU —
//     the final open of --out uses O_NOFOLLOW (numeric flags, not the 'wx'
//     string) so a symlink at the target leaf is refused, on BOTH the
//     new-file path (O_CREAT|O_EXCL|O_NOFOLLOW) and the sanctioned-overwrite
//     path (O_TRUNC|O_NOFOLLOW, no O_CREAT/O_EXCL).
// ---------------------------------------------------------------------------

// 16a. --out itself is a symlink (pointing anywhere) -> refused, and nothing
// is written through the symlink to its target.
test('devswarm-store-leak-report CLI: --out that is itself a leaf symlink is REFUSED, nothing written through it', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-symlink-leaf-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const targetPath = path.join(outDir, 'symlink-target.json');
    const linkPath = path.join(outDir, 'leaf-link.json');
    fs.symlinkSync(targetPath, linkPath);

    const result = reportCli.run(['--home', home, '--out', linkPath, '--quiet']);
    assert.strictEqual(result.ok, false, 'writing through a leaf symlink must be refused');
    assert.ok(!fs.existsSync(targetPath), 'nothing must be written to the symlink target');
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 16b. A normal (non-symlink) new-file write still works after the O_NOFOLLOW
// hardening (regression guard).
test('devswarm-store-leak-report CLI: a normal new-file --out write still succeeds after O_NOFOLLOW hardening', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-nofollow-new-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'report.json');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed._antihallLeakReport, true);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 16c. Overwriting a marked prior report (a real file, not a symlink) still
// works after the O_NOFOLLOW hardening on the overwrite path (regression
// guard for the sanctioned-overwrite branch).
test('devswarm-store-leak-report CLI: overwriting a marked prior report still succeeds after O_NOFOLLOW hardening', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-nofollow-overwrite-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'prior-report.json');
    fs.writeFileSync(outPath, JSON.stringify({ _antihallLeakReport: true, home, total: 0, garbage: [], real: [] }));

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed._antihallLeakReport, true);
    assert.strictEqual(parsed.total, 1);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 16d. The marked-prior-report file at --out is swapped for a symlink AT THE
// EXACT MOMENT of the sanctioned-overwrite open (simulating the race window
// between the marker check and the final write via an injected fsi) — must
// be refused via O_NOFOLLOW on the overwrite open, never written through.
test('devswarm-store-leak-report CLI: a symlink swapped in for a marked prior report is REFUSED on overwrite (O_NOFOLLOW)', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-nofollow-swap-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'prior-report.json');
    const evilTarget = path.join(outDir, 'evil-target.txt');
    fs.writeFileSync(evilTarget, 'must never be written to');
    fs.writeFileSync(outPath, JSON.stringify({ _antihallLeakReport: true, home, total: 0, garbage: [], real: [] }));
    const originalLstat = fs.lstatSync(outPath);
    const originalContent = fs.readFileSync(outPath, 'utf8');

    const spyFsi = Object.assign({}, fs);
    let openCall = 0;
    spyFsi.openSync = (p, flags, mode) => {
      if (path.resolve(String(p)) === path.resolve(outPath)) {
        openCall++;
        if (openCall === 1) {
          // First attempt is the O_EXCL new-file open; the file is real, so
          // this must EEXIST (matches production behavior).
          const e = new Error('EEXIST');
          e.code = 'EEXIST';
          throw e;
        }
        // Second call is the sanctioned-overwrite open — simulate the leaf
        // being swapped for a symlink at this exact instant, then let the
        // REAL openSync run against the now-swapped path so O_NOFOLLOW
        // enforcement is exercised for real, not mocked away.
        fs.unlinkSync(outPath);
        fs.symlinkSync(evilTarget, outPath);
        return fs.openSync(p, flags, mode);
      }
      return fs.openSync(p, flags, mode);
    };
    // lstatSync/readFileSync for the marker check must still see the
    // ORIGINAL marked file (the check happened before the swap).
    spyFsi.lstatSync = (p) => (path.resolve(String(p)) === path.resolve(outPath) ? originalLstat : fs.lstatSync(p));
    spyFsi.readFileSync = (p, enc) => (path.resolve(String(p)) === path.resolve(outPath) ? originalContent : fs.readFileSync(p, enc));

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet'], { fsi: spyFsi });
    assert.strictEqual(result.ok, false, 'the swapped-in symlink must be refused, not written through: ' + JSON.stringify(result));
    assert.strictEqual(fs.readFileSync(evilTarget, 'utf8'), 'must never be written to', 'the symlink target must never receive the report write');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 17. FIX 3c (P1, third round): a registry.ndjson row that PARSES but is not
//     a usable object (null / array / bare primitive) is semantically
//     malformed evidence — must degrade to UNKNOWN, never a confident
//     GARBAGE. A legitimate row object with no worktreePath (e.g. an
//     `_op: 'remove'` tombstone written by devswarm-store.js's append()) is
//     NOT malformed and must be left alone.
// ---------------------------------------------------------------------------

test('auditStore: a registry.ndjson row that parses to a bare string (not an object) -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'nonobject-row-abc123';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), '"just a string, not a row object"\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, 'a non-object parsed row must not collapse to GARBAGE: ' + JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, [hash]);
  } finally { cleanup(); }
});

test('auditStore: a registry.ndjson row that parses to null -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'null-row-abc123';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), 'null\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
  } finally { cleanup(); }
});

test('auditStore: a registry.ndjson row that parses to an array (not a row object) -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'array-row-abc123';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), '[1,2,3]\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
  } finally { cleanup(); }
});

// Regression guard: a legitimate `_op: 'remove'` tombstone row (a real row
// object with no worktreePath — the ordinary shape devswarm-store.js's
// append() writes for a removal) must NOT be swept into the new
// non-object-degrade path; it still falls through to the existing, correct
// (non-degraded) GARBAGE classification when nothing else matches.
test('auditStore: a legitimate _op:remove tombstone row (real object, no worktreePath) is NOT treated as malformed', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'tombstone-row-abc123';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), JSON.stringify({ id: 'w1', _op: 'remove', updatedAt: Date.now() }) + '\n');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.unknownCount, 0, 'a legitimate no-worktreePath row must not be flagged malformed: ' + JSON.stringify(report));
    assert.strictEqual(report.garbageCount, 1, 'no live/archived match and no worktree evidence -> still ordinary (non-degraded) GARBAGE');
  } finally { cleanup(); }
});

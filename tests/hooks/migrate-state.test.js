'use strict';
// tests/hooks/migrate-state.test.js — unit tests for migrate-state.js
// Uses a temp dir per test (script lives under plugins/anti-hall/scripts/,
// but its test follows this repo's tests/hooks/ convention — see
// harvest-debt.test.js for the same pattern).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyState, migrateGsdPlanning, migrateDevswarmStore } = require('../../plugins/anti-hall/scripts/migrate-state.js');

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-state-test-'));
  function write(name, content) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
  }
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { dir, write, cleanup };
}

test('migrates both legacy files into .anti-hall/history/legacy/', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress\n- did stuff\n');
    write('.anti-hall-history.md', '# history\n- fixed stuff\n');

    const results = migrateLegacyState({ dir });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.action === 'migrated'));

    const destProgress = path.join(dir, '.anti-hall', 'history', 'legacy', '.anti-hall-progress.md');
    const destHistory = path.join(dir, '.anti-hall', 'history', 'legacy', '.anti-hall-history.md');
    assert.strictEqual(fs.readFileSync(destProgress, 'utf8'), '# progress\n- did stuff\n');
    assert.strictEqual(fs.readFileSync(destHistory, 'utf8'), '# history\n- fixed stuff\n');
  } finally { cleanup(); }
});

test('idempotent: second run is a no-op that reports skipped, not duplicated', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress\n- did stuff\n');

    const first = migrateLegacyState({ dir });
    assert.strictEqual(first[0].action, 'migrated');

    const destPath = first[0].dest;
    const afterFirstRun = fs.readFileSync(destPath, 'utf8');

    const second = migrateLegacyState({ dir });
    assert.strictEqual(second[0].action, 'skipped');
    assert.strictEqual(
      fs.readFileSync(destPath, 'utf8'),
      afterFirstRun,
      'destination content unchanged on re-run'
    );
  } finally { cleanup(); }
});

test('non-destructive: original legacy files are byte-for-byte unchanged after migration', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const original = '# progress\n- line one\n- line two\n';
    const srcPath = write('.anti-hall-progress.md', original);

    migrateLegacyState({ dir });
    migrateLegacyState({ dir }); // run twice to be sure

    assert.strictEqual(fs.readFileSync(srcPath, 'utf8'), original);
  } finally { cleanup(); }
});

test('lossless: full original content is present in the migrated copy', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const original = '# history\n' + 'line\n'.repeat(500);
    write('.anti-hall-history.md', original);

    const results = migrateLegacyState({ dir });
    const migrated = results.find((r) => r.file === '.anti-hall-history.md');
    assert.strictEqual(fs.readFileSync(migrated.dest, 'utf8'), original);
  } finally { cleanup(); }
});

test('fail-open: no legacy files present does not throw and reports not-found', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const results = migrateLegacyState({ dir });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.action === 'not-found'));
  } finally { cleanup(); }
});

test('creates missing .anti-hall/history/legacy/ directory tree', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.anti-hall')));
    write('.anti-hall-progress.md', '# progress\n');

    migrateLegacyState({ dir });

    assert.ok(fs.existsSync(path.join(dir, '.anti-hall', 'history', 'legacy')));
  } finally { cleanup(); }
});

test('only one legacy file present: migrates that one, reports not-found for the other', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress only\n');

    const results = migrateLegacyState({ dir });
    const progress = results.find((r) => r.file === '.anti-hall-progress.md');
    const history = results.find((r) => r.file === '.anti-hall-history.md');
    assert.strictEqual(progress.action, 'migrated');
    assert.strictEqual(history.action, 'not-found');
  } finally { cleanup(); }
});

// --- migrateGsdPlanning (GSD .planning/ -> .anti-hall/history/legacy/planning/) ---

test('GSD: no .planning/ directory -> single not-found entry, no throw', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const results = migrateGsdPlanning({ dir });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].action, 'not-found');
  } finally { cleanup(); }
});

test('GSD: migrates a nested .planning/ tree preserving relative structure', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.planning/ROADMAP.md', '# roadmap\n');
    write('.planning/1-context.md', '# phase 1 context\n');
    write('.planning/codebase/architecture.md', '# arch map\n');

    const results = migrateGsdPlanning({ dir });
    assert.strictEqual(results.length, 3);
    assert.ok(results.every((r) => r.action === 'migrated'));

    const base = path.join(dir, '.anti-hall', 'history', 'legacy', 'planning');
    assert.strictEqual(fs.readFileSync(path.join(base, 'ROADMAP.md'), 'utf8'), '# roadmap\n');
    assert.strictEqual(fs.readFileSync(path.join(base, '1-context.md'), 'utf8'), '# phase 1 context\n');
    assert.strictEqual(fs.readFileSync(path.join(base, 'codebase', 'architecture.md'), 'utf8'), '# arch map\n');
  } finally { cleanup(); }
});

test('GSD: deletes each source file once its copy is verified, but NEVER removes .planning/ (or a subdirectory) itself', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const original = '# roadmap\n- phase 1\n- phase 2\n';
    const srcPath = write('.planning/ROADMAP.md', original);
    const nestedSrcPath = write('.planning/codebase/architecture.md', '# arch\n');

    const results = migrateGsdPlanning({ dir });
    assert.ok(results.every((r) => r.action === 'migrated'));

    // Source FILES are gone (verified-copy delete)...
    assert.ok(!fs.existsSync(srcPath), 'ROADMAP.md source should be deleted after verified migration');
    assert.ok(!fs.existsSync(nestedSrcPath), 'nested source file should be deleted after verified migration');
    // ...but the directory tree itself is never removed, only emptied of migrated files.
    assert.ok(fs.existsSync(path.join(dir, '.planning')), '.planning/ directory itself must still exist');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'codebase')), '.planning/codebase/ subdirectory must still exist');

    // The migrated content is fully present at the destination (lossless).
    const base = path.join(dir, '.anti-hall', 'history', 'legacy', 'planning');
    assert.strictEqual(fs.readFileSync(path.join(base, 'ROADMAP.md'), 'utf8'), original);
  } finally { cleanup(); }
});

test('GSD: idempotent -- second run finds nothing left to migrate (source already deleted), reports empty, no error', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.planning/STATE.md', '# state\n');

    const first = migrateGsdPlanning({ dir });
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].action, 'migrated');

    const second = migrateGsdPlanning({ dir });
    assert.deepStrictEqual(second, [], 'second run should find zero files left under .planning/ and not throw');

    // .planning/ itself is still there, just empty of the file that was migrated.
    assert.ok(fs.existsSync(path.join(dir, '.planning')));
  } finally { cleanup(); }
});

test('GSD: dedupe is per source path, not global content -- two different files with identical content each get their own migrated+deleted copy', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const content = '# duplicate content\n';
    write('.planning/A.md', content);
    write('.planning/B.md', content);

    const results = migrateGsdPlanning({ dir });
    const aResult = results.find((r) => r.file === '.planning/A.md');
    const bResult = results.find((r) => r.file === '.planning/B.md');
    assert.ok(aResult && bResult, 'expected an entry for both A.md and B.md');
    assert.strictEqual(aResult.action, 'migrated');
    assert.strictEqual(bResult.action, 'migrated');

    // Each source is independently deleted after its own verified copy --
    // one file's migration is never mistaken for the other's.
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'A.md')));
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'B.md')));
    const base = path.join(dir, '.anti-hall', 'history', 'legacy', 'planning');
    assert.strictEqual(fs.readFileSync(path.join(base, 'A.md'), 'utf8'), content);
    assert.strictEqual(fs.readFileSync(path.join(base, 'B.md'), 'utf8'), content);
  } finally { cleanup(); }
});

// --- migrateDevswarmStore dryRun pending (Bug 3: must be IDEMPOTENT, not a
// bare descriptor count) ------------------------------------------------------

function withHome(fn) {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-state-devswarm-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  process.env.HOME = home;
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = origHome;
    if (process.platform === 'win32') process.env.USERPROFILE = origUserProfile;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
}

function seedDescriptor(home, id, lines) {
  const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  const inbox = path.join(home, 'inbox-' + id + '.ndjson');
  fs.writeFileSync(inbox, lines.join('\n') + '\n');
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({
    id, worktreePath: '/wt/' + id, sessionId: 'sess-' + id,
    inboxPath: inbox, cursorPath: null, nudgeCommand: null,
  }));
}

test('migrateDevswarmStore dryRun: pending flips true -> false after a real migrate (idempotent, not a bare descriptor count)', () => {
  withHome((home) => {
    seedDescriptor(home, 'w1', ['hello-from-w1']);

    const before = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(before.pending, true, 'an un-migrated descriptor with inbox content must be pending');
    assert.strictEqual(before.workspaces, 1);

    const applied = migrateDevswarmStore({});
    assert.strictEqual(applied.ok, true);

    // The descriptor itself is NEVER deleted (non-destructive migration) — a
    // buggy `pending = descriptors.length > 0` would stay true forever here,
    // which is exactly the false-FAILED bug doctor-repair.js hit on every run.
    const after = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(after.pending, false, 'pending must flip to false once the descriptor is actually migrated');
    assert.strictEqual(after.workspaces, 1, 'the descriptor is still counted (non-destructive) even though nothing is pending');

    // Re-running the real migration again stays a no-op (idempotent) and pending
    // stays false.
    migrateDevswarmStore({});
    const after2 = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(after2.pending, false);
  });
});

test('migrateDevswarmStore dryRun: a descriptor with an empty/unreadable inbox is never pending', () => {
  withHome((home) => {
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.writeFileSync(path.join(wsDir, 'w2.json'), JSON.stringify({
      id: 'w2', worktreePath: '/wt/w2', sessionId: 'sess-w2',
      inboxPath: path.join(home, 'does-not-exist.ndjson'), cursorPath: null, nudgeCommand: null,
    }));
    const r = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(r.pending, false, 'an unreadable inbox contributes nothing migratable, so it must not be pending');
    assert.strictEqual(r.workspaces, 1);
  });
});

test('migrateDevswarmStore dryRun: no descriptors at all -> not pending', () => {
  withHome((home) => {
    const r = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(r.pending, false);
    assert.strictEqual(r.workspaces, 0);
  });
});

// --- P1 regression (Codex re-review, fixed here): a cross-path dedupe in
// devswarm-migrate.js's migrateOne (colliding a message copied by the
// global-store split, hash `native:*`, with the SAME message mirrored in a
// descriptor's legacy inbox) intentionally skips writing that line's
// legacyLineHash once the store already holds an equivalent row under the
// OTHER hash namespace. The dryRun pending check used to test raw
// legacyLineHash PRESENCE, so it could never see that skipped-but-covered
// line as migrated -> `pending` stayed true FOREVER after a real, verified
// migrate whenever this cross-path collision occurred -- doctor's
// migrate-devswarm-store repair would report FAILED on an otherwise-healthy,
// fully-migrated machine. pendingLegacyLines (the shared multiset identity)
// fixes this: "imported" and "pending" now agree on the exact same line. ----
test('migrateDevswarmStore dryRun: pending flips true -> false after a migrate that cross-path-dedupes against a pre-existing global-store row', () => {
  withHome((home) => {
    const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
    const id = 'primary-aaaaaaaa';

    // Seed a legacy GLOBAL store with a native-hash row (as the v0.54 ingest
    // daemon would have written directly, BEFORE the per-project split).
    const legacyDir = storeLib.storeRootDir(home);
    const src = storeLib.openStore({ home, backend: 'journal', dir: legacyDir, hash: 'legacy' });
    try { src.appendMessage({ workspaceId: id, body: 'DUP-MSG', hash: 'native:dup1' }); }
    finally { src.close(); }

    // Descriptor whose legacy NDJSON inbox mirrors the SAME message text.
    seedDescriptor(home, id, ['DUP-MSG']);

    const before = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(before.pending, true, 'un-migrated descriptor content must be pending');

    const applied = migrateDevswarmStore({});
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.verifiedAll, true, 'the cross-path dup must still count-verify clean');

    // messageCount must be 1 (collapsed), not 2 (duplicated).
    const s = storeLib.openStore({ home, workspaceId: id });
    try { assert.strictEqual(s.messageCount(id), 1); } finally { s.close(); }

    // THE REGRESSION: this must flip to false, not stay stuck true.
    const after = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(after.pending, false, 'pending must flip to false — the message IS migrated, just under a different hash namespace');

    // Idempotent re-run stays clean.
    migrateDevswarmStore({});
    const after2 = migrateDevswarmStore({ dryRun: true });
    assert.strictEqual(after2.pending, false);
  });
});

// --- migrateDevswarmStore markRead threading (v0.56.0 opt-in) ---------------

test('migrateDevswarmStore: markRead OFF (default) preserves the legacy (absent -> 0) cursor -- backlog surfaces as unread', () => {
  withHome((home) => {
    const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
    seedDescriptor(home, 'w1', ['m1', 'm2', 'm3']); // no cursorPath -> legacy cursor 0

    const applied = migrateDevswarmStore({});
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.markRead, false);

    const sum = storeLib.readSummary(home, 'w1');
    assert.strictEqual(sum.workspaces.w1.unread, 3, 'DEFAULT: unmarked backlog is a big unread wall');
  });
});

test('migrateDevswarmStore: markRead ON via opts advances the cursor -- imported backlog reads unread 0', () => {
  withHome((home) => {
    const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
    seedDescriptor(home, 'w1', ['m1', 'm2', 'm3']);

    const applied = migrateDevswarmStore({ markRead: true });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.markRead, true);

    const sum = storeLib.readSummary(home, 'w1');
    assert.strictEqual(sum.workspaces.w1.unread, 0, 'markRead: imported backlog reads as already-seen');

    // Idempotent re-run stays at unread 0, no duplicate rows.
    const applied2 = migrateDevswarmStore({ markRead: true });
    assert.strictEqual(applied2.ok, true);
    const sum2 = storeLib.readSummary(home, 'w1');
    assert.strictEqual(sum2.workspaces.w1.unread, 0);
    const s = storeLib.openStore({ home, workspaceId: 'w1' });
    try { assert.strictEqual(s.messageCount('w1'), 3); } finally { s.close(); }
  });
});

test('GSD: re-run after a file is re-created with DIFFERENT content migrates the new content (not confused with prior state)', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.planning/NOTES.md', '# version one\n');
    const first = migrateGsdPlanning({ dir });
    assert.strictEqual(first[0].action, 'migrated');

    // File re-appears (e.g. a fresh GSD session wrote it again) with new content.
    write('.planning/NOTES.md', '# version two\n');
    const second = migrateGsdPlanning({ dir });
    assert.strictEqual(second[0].action, 'migrated', 'different content at the same path must be treated as fresh, not skipped');
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'NOTES.md')), 'source deleted again after the second verified migration');

    const base = path.join(dir, '.anti-hall', 'history', 'legacy', 'planning');
    assert.strictEqual(fs.readFileSync(path.join(base, 'NOTES.md'), 'utf8'), '# version two\n');
  } finally { cleanup(); }
});

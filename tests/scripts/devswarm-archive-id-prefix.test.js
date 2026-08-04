'use strict';
// ARCHIVE ID-PREFIX RESOLUTION — the per-turn table and roster render
// `name (shortId)` (devswarm-names.js's displayName/shortId: first 8 chars of
// the UUID) as the only copyable-looking token. The real archivable id is the
// full UUID, shown nowhere. resolveArchiveId() (scripts/devswarm.js) lets the
// `archive` CLI verb accept that shortId — or any unambiguous longer prefix —
// directly, with ZERO new injection tokens rendered anywhere.
//
// Contract under test:
//   1. An exact existing descriptor id short-circuits (no prefix search).
//   2. A unique prefix among the CURRENT PROJECT's active workspace ids resolves.
//   3. An ambiguous prefix archives NOTHING and errors listing every candidate.
//   4. A non-matching prefix gets the existing 'invalid or missing workspace id' error.
//   5. A prefix containing '/' or '..' is rejected by isSafeId before any lookup.
//
// Fixture style mirrors devswarm-archive-selfheal.test.js / devswarm-archive-group.test.js
// (real git worktree as cwd — repoKeyForWorktree spawns git).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const BACKEND = 'journal';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archprefix-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archprefix-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const openS = (home, bucket) => storeLib.openStore({ home, hash: bucket, backend: BACKEND });
function seedReg(home, bucket, desc) { const s = openS(home, bucket); try { s.upsertRegistry(desc); } finally { s.close(); } }
function regIds(home, bucket) { const s = openS(home, bucket); try { return s.listRegistry().map((d) => String(d.id)).sort(); } finally { s.close(); } }
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
  return p;
}

const UUID_A = 'b3f1c2d4-1111-4000-8000-abcdef012345'; // shortId 'b3f1c2d4'
const UUID_B = 'b3f1c2d5-2222-4000-8000-abcdef067890'; // shortId 'b3f1c2d5' — same first 7 chars as A, differs at char 8
const UUID_C = 'ffffffff-3333-4000-8000-abcdef000000'; // unrelated, unique prefix 'ffffffff'

function seedThree(home, W) {
  const repoKey = repokey.repoKeyForWorktree(W);
  const top = inst.resolveWorktree(W);
  const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
  const mk = (id) => ({ id, worktreePath: top, sessionId: 'sess-' + id, ownerKey: repoKey, repoKey });
  const descA = mk(UUID_A); const descB = mk(UUID_B); const descC = mk(UUID_C);
  seedReg(home, repoKey, descA); writeDesc(home, UUID_A, descA);
  seedReg(home, repoKey, descB); writeDesc(home, UUID_B, descB);
  seedReg(home, repoKey, descC); writeDesc(home, UUID_C, descC);
  return { ctx, repoKey };
}

// ---------------------------------------------------------------------------
// (1) EXACT full-id match short-circuits — unchanged behaviour.
// ---------------------------------------------------------------------------
test('resolveArchiveId: an exact existing descriptor id short-circuits with zero prefix search', () => {
  const home = tmpHome();
  const W = makeGitRepo('exact');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId(UUID_A, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.id, UUID_A);
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (2) UNIQUE PREFIX resolves to the one matching descriptor.
// ---------------------------------------------------------------------------
test('resolveArchiveId: a unique shortId prefix resolves to the right descriptor', () => {
  const home = tmpHome();
  const W = makeGitRepo('unique');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId('ffffffff', ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.id, UUID_C);
  } finally { rm(W); rm(home); }
});

test('archive verb (via cli.run) with a unique prefix archives exactly the right workspace', () => {
  const home = tmpHome();
  const W = makeGitRepo('unique-e2e');
  try {
    const { ctx, repoKey } = seedThree(home, W);
    const r = cli.run(['archive', 'ffffffff'], ctx);
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.id, UUID_C, 'resolved to the full id, not the prefix');
    assert.strictEqual(r.result.descriptorArchived, true);
    assert.deepStrictEqual(regIds(home, repoKey), [UUID_A, UUID_B].sort(), 'ONLY UUID_C was archived');
    assert.strictEqual(fs.existsSync(cli.descriptorPath(home, UUID_A)), true, 'A untouched');
    assert.strictEqual(fs.existsSync(cli.descriptorPath(home, UUID_B)), true, 'B untouched');
    assert.strictEqual(fs.existsSync(cli.descriptorPath(home, UUID_C)), false, 'C archived');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (3) AMBIGUOUS PREFIX archives NOTHING and reports candidates.
// ---------------------------------------------------------------------------
test('resolveArchiveId: an ambiguous prefix resolves to nothing and lists both candidates', () => {
  const home = tmpHome();
  const W = makeGitRepo('ambiguous');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId('b3f1c2d', ctx); // matches both A and B
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(String(r.error), /ambiguous/i);
    assert.ok(Array.isArray(r.candidates), JSON.stringify(r));
    assert.deepStrictEqual(r.candidates.sort(), [UUID_A, UUID_B].sort());
  } finally { rm(W); rm(home); }
});

test('archive verb (via cli.run) with an ambiguous prefix archives NOTHING', () => {
  const home = tmpHome();
  const W = makeGitRepo('ambiguous-e2e');
  try {
    const { ctx, repoKey } = seedThree(home, W);
    const r = cli.run(['archive', 'b3f1c2d'], ctx);
    assert.strictEqual(r.code, 2, JSON.stringify(r.result));
    assert.strictEqual(r.result.ok, false);
    assert.match(String(r.result.error), /ambiguous/i);
    assert.deepStrictEqual(regIds(home, repoKey), [UUID_A, UUID_B, UUID_C].sort(),
      'all three descriptors remain registered — nothing was archived');
    assert.strictEqual(fs.existsSync(cli.descriptorPath(home, UUID_A)), true);
    assert.strictEqual(fs.existsSync(cli.descriptorPath(home, UUID_B)), true);
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (4) NO MATCH -> the existing 'invalid or missing' error, unchanged wording.
// ---------------------------------------------------------------------------
test('resolveArchiveId: a prefix matching nothing gets the existing "invalid or missing" error', () => {
  const home = tmpHome();
  const W = makeGitRepo('nomatch');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId('deadbeef', ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.error, 'invalid or missing workspace id');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (5) UNSAFE PREFIX ('/' or '..') is rejected by isSafeId before any lookup —
// never path.join'd, never leaks into a candidate scan.
// ---------------------------------------------------------------------------
test('resolveArchiveId: a prefix containing "/" is rejected outright (path-traversal guard)', () => {
  const home = tmpHome();
  const W = makeGitRepo('slash');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId('../etc/passwd', ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.error, 'invalid or missing workspace id');
  } finally { rm(W); rm(home); }
});

test('resolveArchiveId: a bare ".." prefix is rejected outright', () => {
  const home = tmpHome();
  const W = makeGitRepo('dotdot');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.resolveArchiveId('..', ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.error, 'invalid or missing workspace id');
  } finally { rm(W); rm(home); }
});

test('archive verb (via cli.run) rejects a "/"-bearing id at the dispatcher gate, unchanged', () => {
  const home = tmpHome();
  const W = makeGitRepo('slash-e2e');
  try {
    const { ctx } = seedThree(home, W);
    const r = cli.run(['archive', 'a/b'], ctx);
    assert.strictEqual(r.code, 2, JSON.stringify(r.result));
    assert.strictEqual(r.result.error, 'invalid or missing workspace id');
  } finally { rm(W); rm(home); }
});

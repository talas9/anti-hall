'use strict';
// D11-C, defect e7307778b614 — foldArchivedRegistryRows swept EVERY (store
// bucket × archived id) pair with NO ctx.deadline at all, and re-read
// `s.listRegistry()` once PER PAIR (a redundant full-registry read for every
// archived id checked against every bucket). Field-measured: this stage never
// finished before update.js's own post-pull run was killed at a 300s ceiling.
// The fix adds a per-pair deadline gate (stop before the next pair, never
// mid-pair, first pair always runs) plus a resume marker
// (fold-archived-resume.json, keyed per bucket — this file's stand-in for
// repoKey) so a bucket's still-un-swept ids are prioritized FIRST next call —
// mirroring cmdReconcile's own resume rotation.
//
// ONE store bucket, two archived ids on two INDEPENDENT, non-git worktree
// paths (each its own real directory, no shared git toplevel) — deliberately
// avoids two archived ids sharing one real worktree (which would make them
// "sameWorktree" siblings of EACH OTHER via canonicalWorktreeRealPath, a
// different code path entirely, and would collapse if built from two
// subdirectories of the SAME git repo).
//
// MUTATION CHECK: removing the deadline check must turn the first test below
// RED — both archived rows would retire in one pass instead of only one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const BACKEND = 'journal';
const BUCKET = 'foldarchdltest-abcdef';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-foldarch-dl-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const openS = (home) => storeLib.openStore({ home, hash: BUCKET, backend: BACKEND });
function seedReg(home, desc) { const s = openS(home); try { s.upsertRegistry(desc); } finally { s.close(); } }
function regIds(home) { const s = openS(home); try { return s.listRegistry().map((d) => String(d.id)).sort(); } finally { s.close(); } }
function writeArchivedDesc(home, id, desc) {
  const p = path.join(cli.archivedDir(home), id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function resumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'fold-archived-resume.json');
}
// A real, non-git directory — resolveCallerWorktree returns null for it (not
// inside any git repo), so canonicalWorktreeRealPath falls back to its OWN
// realpath rather than collapsing to a shared git toplevel.
function nonGitDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-foldarch-dl-plain-' + tag + '-'));
  return d;
}
function seedArchivedRow(home, id, worktreePath) {
  seedReg(home, { id, worktreePath, sessionId: 's-' + id });
  writeArchivedDesc(home, id, { id, worktreePath, sessionId: 's-' + id });
}

test('foldArchivedRegistryRows: an already-spent ctx.deadline retires only ONE archived row this pass, defers the other via a resume marker', () => {
  const home = tmpHome();
  const dirA = nonGitDir('a');
  const dirB = nonGitDir('b');
  try {
    seedArchivedRow(home, 'arch-a', dirA);
    seedArchivedRow(home, 'arch-b', dirB);

    const r1 = cli.foldArchivedRegistryRows(home, { home, env: {}, backend: BACKEND, deadline: Date.now() - 1 });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.budgetExhausted, true);
    assert.strictEqual(r1.skipped, 1, 'exactly one (bucket,id) pair deferred');
    assert.strictEqual(r1.retired.length, 1, 'exactly one archived row retired this pass');

    const idsAfter1 = regIds(home);
    const retiredCount = ['arch-a', 'arch-b'].filter((id) => !idsAfter1.includes(id)).length;
    assert.strictEqual(retiredCount, 1, 'exactly one of the two archived rows was actually removed');

    assert.ok(fs.existsSync(resumePath(home)), 'a resume marker must be written');
    const resume = JSON.parse(fs.readFileSync(resumePath(home), 'utf8'));
    assert.ok(resume.buckets && Array.isArray(resume.buckets[BUCKET]) && resume.buckets[BUCKET].length === 1);

    // A SECOND call with no deadline (unlimited) finishes the deferred pair
    // FIRST (resume rotation) and clears the marker.
    const r2 = cli.foldArchivedRegistryRows(home, { home, env: {}, backend: BACKEND });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.retired.length, 1, 'the deferred row retires on the next pass');
    const idsAfter2 = regIds(home);
    assert.ok(!idsAfter2.includes('arch-a') && !idsAfter2.includes('arch-b'), 'both archived rows are gone now');
    assert.strictEqual(fs.existsSync(resumePath(home)), false, 'a fully-drained pass removes the resume marker');
  } finally { rm(home); rm(dirA); rm(dirB); }
});

test('foldArchivedRegistryRows: no ctx.deadline set still retires every archived row in one pass (unchanged default behavior)', () => {
  const home = tmpHome();
  const dirA = nonGitDir('nodl-a');
  const dirB = nonGitDir('nodl-b');
  try {
    seedArchivedRow(home, 'arch-a', dirA);
    seedArchivedRow(home, 'arch-b', dirB);

    const r = cli.foldArchivedRegistryRows(home, { home, env: {}, backend: BACKEND });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.retired.length, 2);
    assert.strictEqual(r.budgetExhausted || false, false);
  } finally { rm(home); rm(dirA); rm(dirB); }
});

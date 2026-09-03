'use strict';
// Shared mutation-test kit for devswarm.js's byte-exact RED/GREEN mutation
// checks (used by tests/scripts/devswarm-fixwave2-f1-f2-f3-f4-f5.test.js and
// tests/scripts/devswarm-fixwave3-g1-g2-g3.test.js).
//
// ROOT CAUSE this exists to fix: both callers used to mutate
// plugins/anti-hall/scripts/devswarm.js ON DISK, IN PLACE — writing a
// "buggy" variant, requiring it, running assertions, then writing the
// original bytes back. `.github/workflows/test.yml` runs bare `node --test`,
// which parallelizes per FILE by default, and node:test files across a run
// share the process's module cache and the real filesystem. There is no
// cross-file lock over that one shared path, so two mutating test files (or
// even two files that merely `require()` devswarm.js while a third mutates
// it) can interleave: snapshot-under-mutation, restore-over-a-different-
// mutation, and in the worst case a buggy variant is left on disk when the
// run ends. The SAME failure mode hits the plugin's own documented local
// dev command (`node --test` with no extra flags) — not just CI.
//
// FIX: never touch the live file. Every mutation test gets its OWN isolated
// scratch copy of scripts/devswarm.js (the ONLY file any mutation in this
// suite ever edits) inside a fresh `fs.mkdtempSync` directory, mutates ONLY
// that copy, `require()`s the copy, and discards the whole scratch directory
// afterward. `plugins/anti-hall/scripts/devswarm.js` is opened READ-ONLY by
// every helper here.
//
// companion/ and hooks/ are SYMLINKED into the scratch dir rather than
// copied. Two reasons:
//   1. Cheap/fast — devswarm.js's own dependency footprint (companion/ +
//      hooks/, ~2MB) would otherwise be copied per mutation, of which this
//      suite runs dozens.
//   2. Required for correctness, not just speed: devswarm-fixwave3's G1/G2
//      tests monkeypatch `devswarm-store.js`'s exported `openStore` (a
//      module-singleton property reassignment) to inject a corrupted/
//      duplicate row at the store layer, and assert the CLI under test
//      picks up that patched behavior. Node resolves a symlinked require()
//      path to its target's REAL path before keying the module cache
//      (default behavior, no --preserve-symlinks), so `require('../
//      companion/lib/devswarm-store.js')` from the scratch copy's
//      devswarm.js returns the EXACT SAME module object the test file gets
//      from its own top-level `require('.../companion/lib/devswarm-
//      store.js')` — the monkeypatch is visible to the copy's CLI. A full
//      copy of companion/ would give the scratch CLI its OWN, separate
//      devswarm-store.js module instance, silently breaking that
//      monkeypatch (the patch would land on a module object the copy's CLI
//      never sees).
//
// Because each scratch copy is single-use and discarded, there is no need
// to "restore" it between successive mutations the way the old in-place
// live-file dance did — a caller composing two mutations onto the same
// scratch copy (devswarm-fixwave3's G1 mutation-check test does exactly
// this: null-preserving-maps + a reverted ack-target formula, together, to
// reproduce the real end-to-end regression) can just mutate() again on the
// same path and requireFresh() again; nothing needs undoing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');
const LIVE_DEVSWARM_PATH = path.join(PLUGIN_ROOT, 'scripts', 'devswarm.js');

// createCopy: fresh scratch dir with a real (mutable) copy of
// scripts/devswarm.js and read-only SYMLINKS for companion/ and hooks/
// (module-identity-preserving — see header comment). Returns
// { dir, devswarmPath }.
function createCopy(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'anti-hall-devswarm-mutant') + '-'));
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir);
  const devswarmPath = path.join(scriptsDir, 'devswarm.js');
  fs.copyFileSync(LIVE_DEVSWARM_PATH, devswarmPath);
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'companion'), path.join(dir, 'companion'), 'dir');
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'hooks'), path.join(dir, 'hooks'), 'dir');
  return { dir, devswarmPath };
}

// discardCopy: best-effort cleanup. Never throws — a cleanup failure must
// not fail (or mask the real failure of) the test that created the copy.
function discardCopy(copy) {
  try { fs.rmSync(copy.dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

// mutate: byte-exact string-replace against a scratch copy's devswarm.js.
// Throws (fails the test) if `oldStr` isn't present verbatim, or if the
// replace is a no-op — same guarantees the old in-place version gave.
function mutate(devswarmPath, oldStr, newStr) {
  const before = fs.readFileSync(devswarmPath, 'utf8');
  if (!before.includes(oldStr)) {
    throw new Error('mutant target string not found verbatim — cannot apply: ' + JSON.stringify(oldStr.slice(0, 120)));
  }
  const after = before.replace(oldStr, newStr);
  if (after === before) {
    throw new Error('mutant produced no change');
  }
  fs.writeFileSync(devswarmPath, after);
}

// mutateWith: same contract as mutate(), but takes a transform(source)
// function instead of a single oldStr/newStr pair — for mutants that need
// more than one coordinated replacement in a single write (e.g. removing a
// guard AND appending to module.exports).
function mutateWith(devswarmPath, transform) {
  const before = fs.readFileSync(devswarmPath, 'utf8');
  const after = transform(before);
  if (after === before) {
    throw new Error('mutant produced no change');
  }
  fs.writeFileSync(devswarmPath, after);
}

// requireFresh: bust the module cache entry for this exact scratch path and
// require it again. Each scratch copy lives at a unique tmp path, so this
// never collides with (or evicts) the cache entry for the LIVE devswarm.js
// or for any OTHER scratch copy.
function requireFresh(devswarmPath) {
  delete require.cache[require.resolve(devswarmPath)];
  return require(devswarmPath);
}

// withMutant: the common case end-to-end — fresh scratch copy, one
// string-replace mutation, run fn(mutatedCli, copy), discard the copy.
// `copy` is passed to `fn` so a caller can, if needed, apply a FURTHER
// mutation to the very same scratch file (see devswarm-fixwave3's G1
// mutation-check test for a real use of this).
function withMutant(oldStr, newStr, fn, opts) {
  const copy = createCopy(opts && opts.prefix);
  try {
    mutate(copy.devswarmPath, oldStr, newStr);
    fn(requireFresh(copy.devswarmPath), copy);
  } finally {
    discardCopy(copy);
  }
}

// withMutantTransform: like withMutant, but for a multi-replacement
// transform function instead of a single oldStr/newStr pair.
function withMutantTransform(transform, fn, opts) {
  const copy = createCopy(opts && opts.prefix);
  try {
    mutateWith(copy.devswarmPath, transform);
    fn(requireFresh(copy.devswarmPath), copy);
  } finally {
    discardCopy(copy);
  }
}

// assertLiveUntouched: proves the live devswarm.js is byte-identical to a
// snapshot taken before a mutation test ran. Call with the snapshot from
// BEFORE any createCopy()/mutate() calls in the test.
function assertLiveUntouched(liveBefore, assert) {
  assert.equal(fs.readFileSync(LIVE_DEVSWARM_PATH, 'utf8'), liveBefore, 'live plugins/anti-hall/scripts/devswarm.js must never be modified by a mutation test');
}

module.exports = {
  PLUGIN_ROOT,
  LIVE_DEVSWARM_PATH,
  createCopy,
  discardCopy,
  mutate,
  mutateWith,
  requireFresh,
  withMutant,
  withMutantTransform,
  assertLiveUntouched,
};

'use strict';
// devswarm-repokey — the shared per-project store key primitive (v0.57 mesh
// Phase 1, PLAN-v0.57-mesh.md D1/D2/D28). Unit-tests sanitizeRepoName,
// gitCommonDir, and repoKeyForWorktree WITHOUT spawning a real git binary or
// touching the real filesystem: every git spawn and every realpath call is
// injected via io.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { sanitizeRepoName, gitCommonDir, repoKeyForWorktree } = repokey;

// makeRun(rawOut, {ok}) -> an injectable git runner that always returns the
// given raw `--git-common-dir` stdout (or a failure when ok===false).
function makeRun(rawOut, opts) {
  const o = opts || {};
  const calls = [];
  function run(spec) {
    calls.push(spec);
    if (o.ok === false) return { ok: false, raw: '' };
    return { ok: true, raw: rawOut };
  }
  return { run, calls };
}

// identityRealpath — a fake fs whose realpathSync is the identity function
// (no real filesystem access), so gitCommonDir is testable purely on the
// resolve/hash logic.
const identityFs = { realpathSync: (p) => p };

test('sanitizeRepoName: lowercases, maps non-alnum to -, collapses repeats, trims edges', () => {
  assert.equal(sanitizeRepoName('Anti-Hall'), 'anti-hall');
  assert.equal(sanitizeRepoName('My Cool App!!'), 'my-cool-app');
  assert.equal(sanitizeRepoName('  leading and trailing  '), 'leading-and-trailing');
  assert.equal(sanitizeRepoName('a___b---c'), 'a-b-c');
  assert.equal(sanitizeRepoName('-already-dashed-'), 'already-dashed');
});

test('sanitizeRepoName: empty or all-dash input falls back to the literal "repo"', () => {
  assert.equal(sanitizeRepoName(''), 'repo');
  assert.equal(sanitizeRepoName('---'), 'repo');
  assert.equal(sanitizeRepoName('!!!'), 'repo');
  assert.equal(sanitizeRepoName(null), 'repo');
  assert.equal(sanitizeRepoName(undefined), 'repo');
});

test('sanitizeRepoName: caps at 40 chars with the dash-strip applied AFTER the cap (D28)', () => {
  // 39 'a's + a '-' as the 40th char: slicing to 40 lands exactly on the dash.
  // Stripping AFTER the slice must remove it, leaving no trailing/double dash.
  const name = 'a'.repeat(39) + '-' + 'b'.repeat(10);
  const out = sanitizeRepoName(name);
  assert.equal(out.length, 39, 'trailing dash at the 40-char cut must be stripped, not kept');
  assert.equal(out, 'a'.repeat(39));
  assert.ok(!out.endsWith('-'), 'no trailing dash');
  assert.ok(!out.startsWith('-'), 'no leading dash');
  assert.ok(!/--/.test(out), 'no double dash');
});

test('sanitizeRepoName: a much longer name is capped to 40 chars, no trailing dash', () => {
  const out = sanitizeRepoName('x'.repeat(100));
  assert.equal(out.length, 40);
  assert.ok(!out.endsWith('-'));
});

test('gitCommonDir: resolves a RELATIVE common-dir (main worktree, bare ".git") against cwd', () => {
  // Expected is computed via path.resolve (the SAME call gitCommonDir makes)
  // rather than a hardcoded POSIX literal, since on Windows `path` is
  // path.win32: a root-relative POSIX-shaped input resolves against the
  // process's current drive, yielding a native `\`-separated, drive-prefixed
  // path. Computing expected the same way keeps this test platform-agnostic.
  const wt = '/Users/dev/anti-hall';
  const R = makeRun('.git');
  const cd = gitCommonDir(wt, { io: { run: R.run, fs: identityFs } });
  assert.equal(cd, path.resolve(wt, '.git'));
  assert.equal(R.calls.length, 1);
  assert.deepEqual(R.calls[0].args, ['-C', wt, 'rev-parse', '--git-common-dir']);
});

test('gitCommonDir: an ABSOLUTE common-dir (linked worktree) is used as-is (still realpath\'d)', () => {
  const wt = '/Users/dev/.devswarm/repos/1/abc/anti-hall-wt';
  const rawOut = '/Users/dev/anti-hall/.git';
  const R = makeRun(rawOut);
  const cd = gitCommonDir(wt, { io: { run: R.run, fs: identityFs } });
  assert.equal(cd, path.resolve(wt, rawOut));
});

test('gitCommonDir: relative-form main worktree and absolute-form linked worktree collapse to the SAME string', () => {
  const mainRun = makeRun('.git');
  const linkedRun = makeRun('/Users/dev/anti-hall/.git');
  const cdMain = gitCommonDir('/Users/dev/anti-hall', { io: { run: mainRun.run, fs: identityFs } });
  const cdLinked = gitCommonDir('/Users/dev/.devswarm/repos/1/abc/anti-hall-wt', { io: { run: linkedRun.run, fs: identityFs } });
  assert.equal(cdMain, cdLinked, 'Phase-0 probe finding: both worktrees of one repo must resolve to the identical common-dir');
});

test('gitCommonDir: git failure (non-git cwd) returns null, never throws', () => {
  const R = makeRun('', { ok: false });
  const cd = gitCommonDir('/tmp/not-a-repo', { io: { run: R.run, fs: identityFs } });
  assert.equal(cd, null);
});

test('gitCommonDir: empty stdout returns null', () => {
  const R = makeRun('   ');
  const cd = gitCommonDir('/tmp/whatever', { io: { run: R.run, fs: identityFs } });
  assert.equal(cd, null);
});

test('gitCommonDir: a throwing realpathSync is caught, returns null (fail-open)', () => {
  const R = makeRun('.git');
  const throwingFs = { realpathSync: () => { throw new Error('ENOENT'); } };
  const cd = gitCommonDir('/tmp/whatever', { io: { run: R.run, fs: throwingFs } });
  assert.equal(cd, null);
});

test('gitCommonDir: empty worktree arg returns null without spawning', () => {
  const R = makeRun('.git');
  const cd = gitCommonDir('', { io: { run: R.run, fs: identityFs } });
  assert.equal(cd, null);
  assert.equal(R.calls.length, 0);
});

test('repoKeyForWorktree: null common-dir (non-git cwd) yields null repoKey (mesh dormant, O-D5)', () => {
  const R = makeRun('', { ok: false });
  const key = repoKeyForWorktree('/tmp/not-a-repo', { io: { run: R.run, fs: identityFs } });
  assert.equal(key, null);
});

test('repoKeyForWorktree: shape is sanitized-basename + "-" + 6 lowercase hex chars', () => {
  const R = makeRun('.git');
  const key = repoKeyForWorktree('/Users/dev/anti-hall', { io: { run: R.run, fs: identityFs } });
  assert.match(key, /^[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.ok(key.startsWith('anti-hall-'), `expected readable basename prefix, got ${key}`);
});

test('repoKeyForWorktree: deterministic — identical input always yields the identical key', () => {
  const run1 = makeRun('.git');
  const run2 = makeRun('.git');
  const k1 = repoKeyForWorktree('/Users/dev/anti-hall', { io: { run: run1.run, fs: identityFs } });
  const k2 = repoKeyForWorktree('/Users/dev/anti-hall', { io: { run: run2.run, fs: identityFs } });
  assert.equal(k1, k2);
});

test('repoKeyForWorktree: two linked worktrees of ONE repo (relative vs absolute common-dir) yield the SAME key', () => {
  const mainRun = makeRun('.git');
  const linkedRun = makeRun('/Users/dev/anti-hall/.git');
  const kMain = repoKeyForWorktree('/Users/dev/anti-hall', { io: { run: mainRun.run, fs: identityFs } });
  const kLinked = repoKeyForWorktree('/Users/dev/.devswarm/repos/1/abc/anti-hall-worktree', { io: { run: linkedRun.run, fs: identityFs } });
  assert.equal(kMain, kLinked);
});

test('repoKeyForWorktree: two DIFFERENT repos sharing a basename yield DIFFERENT keys (6-hex disambiguates)', () => {
  const runA = makeRun('/Users/a/app/.git');
  const runB = makeRun('/Users/b/app/.git');
  const keyA = repoKeyForWorktree('/Users/a/app', { io: { run: runA.run, fs: identityFs } });
  const keyB = repoKeyForWorktree('/Users/b/app', { io: { run: runB.run, fs: identityFs } });
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.startsWith('app-'));
  assert.ok(keyB.startsWith('app-'));
});

test('repoKeyForWorktree: an all-dash/empty basename falls back to "repo-<6hex>"', () => {
  // common-dir's parent directory basename sanitizes to nothing.
  const R = makeRun('/Users/dev/!!!/.git');
  const key = repoKeyForWorktree('/Users/dev/!!!', { io: { run: R.run, fs: identityFs } });
  assert.match(key, /^repo-[0-9a-f]{6}$/);
});

test('repoKeyForWorktree: a 40th-char-dash basename yields a key with no trailing/double dash (D28)', () => {
  const longName = 'a'.repeat(39) + '-' + 'b'.repeat(10);
  const R = makeRun(`/Users/dev/${longName}/.git`);
  const key = repoKeyForWorktree(`/Users/dev/${longName}`, { io: { run: R.run, fs: identityFs } });
  const base = key.slice(0, key.lastIndexOf('-'));
  assert.equal(base, 'a'.repeat(39));
  assert.ok(!base.endsWith('-'));
  assert.ok(!/--/.test(key));
});

test('repoKeyForWorktree: result is a safe id — matches the liveness isSafeId shape ^[A-Za-z0-9._-]+$', () => {
  const R = makeRun('.git');
  const key = repoKeyForWorktree('/Users/dev/Some Weird Repo!!', { io: { run: R.run, fs: identityFs } });
  assert.match(key, /^[A-Za-z0-9._-]+$/);
});

test('repoKeyForWorktree: falls back to the default (real) io when no io is passed — does not throw', () => {
  // No injected io: exercises the real defaultRun/fs path against a directory
  // that is not a git worktree so it must resolve to null without throwing.
  assert.doesNotThrow(() => {
    const key = repoKeyForWorktree(require('os').tmpdir());
    assert.ok(key === null || typeof key === 'string');
  });
});

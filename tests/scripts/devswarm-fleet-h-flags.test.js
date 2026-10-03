'use strict';
// Item H (fleet wave): three independent, small robustness fixes bundled
// together in plugins/anti-hall/scripts/devswarm.js:
//
//   1. readRetiredRedirect(home, id) joined caller-controlled `id` straight
//      into a filesystem path with no validation — a traversal id (e.g.
//      containing `../`) reached fs.readFileSync unchecked. Fixed with the
//      same isSafeId guard every other id-keyed path helper in this file
//      already applies.
//   2. cmdMeshRead's `--seq` flag: a BARE `--seq` (parseArgs' bare-boolean
//      fallback stamps the literal `true`) silently coerced via
//      `Number(true) === 1` into a valid-looking seq=1 baseline instead of
//      being refused as malformed.
//   3. parseArgs (~:1156) had no "always boolean, never consumes the next
//      token" flag set — `--force`/`--peek` being the LAST flag before an
//      unrelated positional token would swallow that positional as their
//      own value. Fixed via a new BOOLEAN_ONLY_FLAGS set.
//
// Points at ANTIHALL_TEST_PLUGIN_ROOT (a `plugins/anti-hall`-shaped tree) so
// this SAME file proves RED against HEAD (pre-fix) and GREEN against the
// live, already-fixed working tree without duplication. Defaults to the
// real repo tree (the current, already-patched working copy).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const antiHallDir = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(antiHallDir, 'scripts', 'devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-h-flags-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-h-flags-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// ---------------------------------------------------------------------------
// H1: readRetiredRedirect path-traversal guard
// ---------------------------------------------------------------------------

test('H1: readRetiredRedirect(home, id) refuses a path-traversal id instead of reading outside its own directory', () => {
  const home = tmpHome();
  try {
    // Plant a file OUTSIDE the retired/ directory that a traversal id could
    // reach if unvalidated (retiredRedirectDir is <home>/.anti-hall/devswarm/retired).
    const secretDir = path.join(home, '.anti-hall', 'devswarm');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'secret.json'), JSON.stringify({ retiredTo: 'pwned' }));

    const traversalId = '../secret';
    const result = cli.readRetiredRedirect(home, traversalId);
    assert.strictEqual(result, null, 'a traversal id must be refused (isSafeId) and never resolve to a redirect');
  } finally { rm(home); }
});

test('H1: readRetiredRedirect(home, id) still resolves a genuine, safe redirect', () => {
  const home = tmpHome();
  try {
    cli.writeRetiredRedirect(home, 'old-id', 'new-id');
    assert.strictEqual(cli.readRetiredRedirect(home, 'old-id'), 'new-id',
      'a normal, safe id must still resolve its redirect exactly as before this fix');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// H2: cmdMeshRead --seq bare-boolean guard
// ---------------------------------------------------------------------------

test('H2: mesh read --seq (bare, no value) is refused as bad-seq, never silently coerced to seq=1', () => {
  const home = tmpHome();
  const main = makeGitRepo('h2-seq');
  try {
    const reg = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'sess-h2' } }));
    assert.strictEqual(reg.result.ok, true);

    // Simulate the bare-boolean shape parseArgs produces for a flag with no
    // trailing value token: flags.seq = [true]. Calling cmdMeshRead directly
    // (exported) with this exact shape reproduces exactly what a bare
    // `mesh read --seq` CLI invocation parses to.
    const out = cli.cmdMeshRead({ seq: [true] }, ctx(home, { cwd: main }));
    assert.strictEqual(out.ok, false, 'a bare --seq must be refused, not silently treated as seq=1 (got: ' + JSON.stringify(out) + ')');
    assert.strictEqual(out.reason, 'bad-seq');
  } finally { rm(main); rm(home); }
});

test('H2: mesh read --seq 5 (a real explicit value) still works exactly as before', () => {
  const home = tmpHome();
  const main = makeGitRepo('h2-seq-ok');
  try {
    const reg = cli.run(['register-primary'], ctx(home, { cwd: main, env: { CLAUDE_CODE_SESSION_ID: 'sess-h2b' } }));
    assert.strictEqual(reg.result.ok, true);
    const out = cli.cmdMeshRead({ seq: ['5'] }, ctx(home, { cwd: main }));
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.since, 5);
    assert.strictEqual(out.peek, true, '--seq always implies peek');
  } finally { rm(main); rm(home); }
});

// ---------------------------------------------------------------------------
// H3: BOOLEAN_ONLY_FLAGS (--force / --peek never swallow the next token)
// ---------------------------------------------------------------------------

test('H3: register-primary --force followed by an unrelated positional does not swallow it as --force\'s value', () => {
  const home = tmpHome();
  const main = makeGitRepo('h3-force');
  try {
    // A positional AFTER --force must remain a positional, not get consumed
    // as --force's own value (which would make `flags.force` a non-boolean
    // string like "stray-positional" instead of `true`).
    const parsed = cli.parseArgs(['register-primary', '--force', 'stray-positional']);
    assert.deepStrictEqual(parsed.flags.force, [true], '--force must always be a bare boolean, never swallow the next token');
    assert.ok(parsed.positionals.includes('stray-positional'), 'the token after --force must remain a positional');
  } finally { rm(main); rm(home); }
});

test('H3: mesh read --peek followed by an unrelated positional does not swallow it as --peek\'s value', () => {
  const parsed = cli.parseArgs(['mesh', 'read', '--peek', 'stray-positional']);
  assert.deepStrictEqual(parsed.flags.peek, [true], '--peek must always be a bare boolean, never swallow the next token');
  assert.ok(parsed.positionals.includes('stray-positional'), 'the token after --peek must remain a positional');
});

// fl-wave3 fix (item 8): `send`'s own header comment on `--answers`
// (~line 10375) already documents it as "a bare boolean flag" — but it was
// simply missing from BOOLEAN_ONLY_FLAGS, so parseArgs' generic heuristic
// would swallow a following positional as --answers' own value.
test('H3: send --answers followed by an unrelated positional does not swallow it as --answers\'s value', () => {
  const parsed = cli.parseArgs(['send', '--answers', 'stray-positional']);
  assert.deepStrictEqual(parsed.flags.answers, [true], '--answers must always be a bare boolean, never swallow the next token');
  assert.ok(parsed.positionals.includes('stray-positional'), 'the token after --answers must remain a positional');
});

'use strict';
// Item 8, defect d1c57e67998f (P1, field-verified): install-devswarm-ingest.js's
// EnvironmentVariables/Environment= never pinned HOME, and devswarm-ingest.js
// resolves its store root via `o.home || os.homedir()` with no `--home` ever
// passed on ProgramArguments/ExecStart — so a unit installed under a NON-
// DEFAULT HOME (a review agent's temp-HOME experiment, label
// `...r3repo-bare-i7ycii-cc6261`) got a live daemon that, once actually
// launched by launchd/systemd (which hands its own default HOME to the
// process), silently wrote into the operator's REAL ~/.anti-hall store.
//
// Three parts, all covered here:
//   (a) HOME/USERPROFILE are now unconditionally pinned into every unit shape.
//   (b) the installer refuses (forces dry-run + a loud stderr notice) when the
//       resolved HOME is under os.tmpdir(), unless
//       ANTIHALL_INGEST_ALLOW_TMP_HOME=1 — closing the class NODE_TEST_CONTEXT
//       cannot see (a non-`node --test` run under a scratch HOME).
//   (c) a doctor report line for an already-installed unit whose plist/service
//       lacks HOME (covered in tests/hooks/doctor-runtime.test.js, not here).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
const m = require(MOD);

// ---------------------------------------------------------------------------
// (a) HOME/USERPROFILE pinned into every unit shape.
// ---------------------------------------------------------------------------

test('(a) unitEnvFor always includes HOME/USERPROFILE matching the installer\'s own resolved HOME', () => {
  const env = m.unitEnvFor('/opt/dv/bin/hivecontrol', '/usr/bin/node');
  assert.strictEqual(env.HOME, m.HOME);
  assert.strictEqual(env.USERPROFILE, m.HOME);
});

test('(a) buildPlist bakes <key>HOME</key> matching the installer HOME, even with nothing absolute resolved', () => {
  const plist = m.buildPlist({ label: 'com.x', exec: 'node', script: '/s', log: '/l', workdir: '/w' });
  const match = plist.match(/<key>HOME<\/key>\s*<string>([^<]*)<\/string>/);
  assert.ok(match, 'HOME key must be present in the generated plist');
  assert.strictEqual(m.xmlEscape(m.HOME), match[1]);
});

test('(a) buildService bakes Environment="HOME=<installer HOME>"', () => {
  const svc = m.buildService({ exec: 'node', script: '/s' });
  assert.match(svc, new RegExp('^Environment="HOME=' + m.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"$', 'm'));
});

test('(a) buildCronLine bakes a HOME=\'<installer HOME>\' assignment prefix', () => {
  const line = m.buildCronLine({ exec: 'node', script: '/s' });
  assert.ok(line.includes("HOME='" + m.HOME + "'"));
});

// ---------------------------------------------------------------------------
// (b) tmp-HOME refusal — pure function coverage.
// ---------------------------------------------------------------------------

test('(b) homeIsUnderTmpdir: true for a path under os.tmpdir(), false for an unrelated path', () => {
  const underTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-tmphome-'));
  try {
    assert.strictEqual(m.homeIsUnderTmpdir(underTmp), true);
    assert.strictEqual(m.homeIsUnderTmpdir(os.tmpdir()), true, 'os.tmpdir() itself counts');
    assert.strictEqual(m.homeIsUnderTmpdir('/definitely/not/a/tmp/dir/xyz'), false);
  } finally { fs.rmSync(underTmp, { recursive: true, force: true }); }
});

// os.tmpdir() alone does not resolve to /tmp or /private/tmp on macOS (it
// returns the per-user $TMPDIR under /var/folders/...), so a HOME planted
// directly under /tmp or /private/tmp (e.g. an agent session scratchpad)
// previously sailed past this guard entirely — homeIsUnderTmpdir() now also
// checks those two well-known roots explicitly.
test('(b) homeIsUnderTmpdir: true for a /private/tmp/... HOME even when it is not under os.tmpdir()', () => {
  // /private/tmp only exists on macOS (it's /tmp's real, non-symlinked
  // path there); Linux CI has no /private at all, so mkdtempSync against it
  // is an ENOENT, not a guard failure — exercise the literal-path checks
  // ('/tmp' exists on every platform this test runs on) everywhere, and
  // only mkdtemp a real /private/tmp child on darwin.
  assert.strictEqual(m.homeIsUnderTmpdir('/tmp'), true, '/tmp itself must trip the guard');
  if (process.platform !== 'darwin') return; // /private/tmp is macOS-only
  assert.strictEqual(m.homeIsUnderTmpdir('/private/tmp'), true, '/private/tmp itself must trip the guard');
  const underPrivateTmp = fs.mkdtempSync('/private/tmp/ah-tmphome-priv-');
  try {
    assert.strictEqual(m.homeIsUnderTmpdir(underPrivateTmp), true,
      'a HOME under /private/tmp must trip the guard even if distinct from os.tmpdir()');
  } finally { fs.rmSync(underPrivateTmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// (b) tmp-HOME refusal — real subprocess coverage (never touches the real
// scheduler; NODE_TEST_CONTEXT is inherited by the child either way, so this
// proves the TMP_HOME_GUARD's OWN notice/logic fires or is suppressed
// correctly — not that a genuinely unmocked write would occur, which this
// codebase never exercises directly for safety, see
// install-devswarm-ingest-orphan-reap.test.js's own header on the same point).
// ---------------------------------------------------------------------------

test('(b) install refuses under a temp HOME without ANTIHALL_INGEST_ALLOW_TMP_HOME: prints the loud stderr notice', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-tmphome-refuse-'));
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    delete env.ANTIHALL_INGEST_ALLOW_TMP_HOME;
    delete env.ANTIHALL_INGEST_DRY_RUN;
    const r = cp.spawnSync(process.execPath, [MOD], { env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'main() must still exit 0 (fail-open to dry-run, never crash): ' + r.stderr);
    assert.match(r.stderr, /resolved HOME .* under the system temp/, 'must print the tmp-home refusal notice');
    assert.match(r.stderr, /ANTIHALL_INGEST_ALLOW_TMP_HOME=1/, 'must name the exact opt-out');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('(b) ANTIHALL_INGEST_ALLOW_TMP_HOME=1 suppresses the tmp-home guard\'s own notice', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-tmphome-allow-'));
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_ALLOW_TMP_HOME: '1' });
    delete env.ANTIHALL_INGEST_DRY_RUN;
    const r = cp.spawnSync(process.execPath, [MOD], { env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'main() must exit 0: ' + r.stderr);
    assert.ok(!/resolved HOME .* under the system temp/.test(r.stderr),
      'ANTIHALL_INGEST_ALLOW_TMP_HOME=1 must suppress the tmp-home guard\'s own notice — stderr was:\n' + r.stderr);
    // NODE_TEST_CONTEXT is still inherited by this child (this test itself
    // runs under `node --test`), so it still forces dry-run independently —
    // that is a SEPARATE guard and expected; only the tmp-home notice itself
    // must be gone.
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('(b) a normal (non-tmp) HOME never trips the tmp-home guard', () => {
  const home = path.join(os.homedir(), '.__anti-hall-nonexistent-probe__');
  assert.strictEqual(m.homeIsUnderTmpdir(os.homedir()), false, 'the real machine home must never read as a tmp home');
});

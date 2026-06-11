'use strict';
// flutter-debug — unit tests for the preflight helper (preflight.js), the
// agent frontmatter, the SKILL.md lint, and the doctor no-duplication contract.
//
// NO real CLIs, NO simulators (public CI is static-only). preflight.js is
// factored so every check takes an injectable `run` (exec) stub and `fsImpl`,
// so the FP9 registration flow, the Android SDK-path resolution, the dart
// tiers, and the degradation messages are all exercised against pure stubs.
//
// Test floor per the plan (workstream G, ≥19): FP9 flow ≥4, Android SDK-path 2,
// doctor no-duplication 1, degradation messages 7, dart full/warn/fail 3,
// SKILL lint, agent frontmatter parse (FP5 passed → included).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const P = require('../../plugins/anti-hall/skills/flutter-debug/scripts/preflight.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const REPO = path.join(__dirname, '..', '..');
const AGENT_MD = path.join(PLUGIN, 'agents', 'flutter-debug.md');
const SKILL_MD = path.join(PLUGIN, 'skills', 'flutter-debug', 'SKILL.md');
const DOCTOR_JS = path.join(PLUGIN, 'hooks', 'doctor.js');
const PREFLIGHT_JS = path.join(PLUGIN, 'skills', 'flutter-debug', 'scripts', 'preflight.js');
const PROBE_RECORD = path.join(REPO, 'tests', 'fixtures', 'step0-probe-record-v0.34.0.md');
const PLAN_DOC = path.join(REPO, 'docs', '2026-06-10-v0.34.0-flutter-debug-plan.md');
const CHANGELOG = path.join(REPO, 'CHANGELOG.md');

// Owner-private identifier denylist for PUBLIC files. Generic patterns +
// specific names; add future leaked names here. /Users/ home paths and the
// owner's private app/device names must never ship.
const OWNER_IDENTIFIER_DENYLIST = [
  { re: /\/Users\/[a-z0-9._-]+/i, label: '/Users/<home> path' },
  { re: /\btalas9\b/, label: 'owner username (talas9)' },
  { re: /\bskylog\b/i, label: 'owner app name (skylog)' },
  { re: /Pixel_9_Pro_XL/, label: 'owner AVD name (Pixel_9_Pro_XL)' },
];

/** Extract only the 0.34.x sections from CHANGELOG (## 0.34.x … next ##). */
function changelog034Sections(text) {
  const out = [];
  const re = /^##\s+0\.34\.[0-9]+[^\n]*$/gm;
  let m;
  const starts = [];
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    // next top-level "## " heading (any version) ends this slice
    const rest = text.slice(from + 3);
    const nextRel = rest.search(/\n##\s+/);
    const to = nextRel === -1 ? text.length : from + 3 + nextRel;
    out.push(text.slice(from, to));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// run-stub: map { dart: out|Error|fn, claude: …, flutter: …, xcrun: …, idb: … }
// keyed by the FIRST argv (the binary). A function receives (file, args). An
// Error simulates a non-zero/spawn failure → { ok:false, err }.
// ---------------------------------------------------------------------------
function runStub(map, calls) {
  return function (file, args) {
    if (calls) calls.push({ file, args: (args || []).slice() });
    const v = map[file];
    const resolved = typeof v === 'function' ? v(file, args) : v;
    if (resolved instanceof Error) return { ok: false, out: '', err: resolved.message };
    if (resolved && typeof resolved === 'object' && 'ok' in resolved) return resolved;
    return { ok: true, out: resolved == null ? '' : String(resolved), err: '' };
  };
}

// ---------------------------------------------------------------------------
// dart tier: full / warn / fail (3)
// ---------------------------------------------------------------------------
test('checkDart: >= 3.12 → FULL', () => {
  const run = runStub({ dart: 'Dart SDK version: 3.12.0 (stable)', flutter: 'Flutter 3.44.0' });
  const r = P.checkDart(run);
  assert.strictEqual(r.status, P.FULL);
  assert.strictEqual(r.version, '3.12.0');
  assert.match(r.message, /Agentic Hot Reload/);
});

test('checkDart: 3.9–3.11 → WARN (server shipped with 3.9; recommend 3.12)', () => {
  const run = runStub({ dart: 'Dart SDK version: 3.10.4 (stable)', flutter: 'Flutter 3.40.0' });
  const r = P.checkDart(run);
  assert.strictEqual(r.status, P.WARN);
  assert.strictEqual(r.version, '3.10.4');
  assert.match(r.message, /manual copy|Recommend/i);
});

test('checkDart: < 3.9 → FAIL; missing dart → FAIL', () => {
  const low = P.checkDart(runStub({ dart: 'Dart SDK version: 3.8.0 (stable)' }));
  assert.strictEqual(low.status, P.FAIL);
  const missing = P.checkDart(runStub({ dart: new Error('ENOENT') }));
  assert.strictEqual(missing.status, P.FAIL);
  assert.match(missing.message, /dart not found/);
});

// ---------------------------------------------------------------------------
// FP9 registration flow (≥4): get-absent → add; get-present → SKIP;
// get-unparsable → no add + manual note; add hard-error surfaced not crashed.
// ---------------------------------------------------------------------------
test('FP9: get-absent → add with the chosen scope', () => {
  const calls = [];
  // `mcp get` returns absent (non-zero + "No MCP server found"); `mcp add` succeeds.
  const run = runStub({
    claude: (f, a) => {
      if (a[1] === 'get') return { ok: false, out: '', err: 'No MCP server found with name: ' + a[2] };
      if (a[1] === 'add') return { ok: true, out: 'Added', err: '' };
      return { ok: true, out: '', err: '' };
    },
  }, calls);
  const r = P.registerServer('dart', ['--transport', 'stdio', 'dart', '--', 'dart', 'mcp-server'], 'user', run);
  assert.strictEqual(r.action, 'added');
  assert.strictEqual(r.status, P.FULL);
  // the add carried --scope user
  const addCall = calls.find(c => c.args[1] === 'add');
  assert.ok(addCall.args.includes('--scope'));
  assert.ok(addCall.args.includes('user'), 'chosen scope passed through to add');
});

test('FP9: get-present (any scope) → SKIP, never re-adds', () => {
  const calls = [];
  const run = runStub({
    claude: (f, a) => {
      if (a[1] === 'get') return { ok: true, out: 'dart:\n  scope: user\n  transport: stdio\n  command: dart mcp-server\n  status: connected', err: '' };
      return { ok: true, out: '', err: '' };
    },
  }, calls);
  const r = P.registerServer('dart', ['x'], 'local', run);
  assert.strictEqual(r.action, 'present');
  assert.ok(!calls.some(c => c.args[1] === 'add'), 'must NOT add when already present');
});

test('FP9: get-unparsable → no add + manual-verify note ("unknown, don\'t add")', () => {
  const calls = [];
  const run = runStub({
    claude: (f, a) => {
      if (a[1] === 'get') return { ok: true, out: 'some unexpected blob with no recognizable markers', err: '' };
      return { ok: true, out: '', err: '' };
    },
  }, calls);
  const r = P.registerServer('marionette', ['x'], 'local', run);
  assert.strictEqual(r.action, 'skip-unknown');
  assert.strictEqual(r.status, P.WARN);
  assert.ok(!calls.some(c => c.args[1] === 'add'), 'unparsable ⇒ never a blind add');
  assert.match(r.message, /verify manually/);
});

test('FP9: add hard-error (same-scope duplicate) surfaced, not crashed', () => {
  const run = runStub({
    claude: (f, a) => {
      if (a[1] === 'get') return { ok: false, out: '', err: 'No MCP server found' };
      if (a[1] === 'add') return { ok: false, out: '', err: 'Error: Server already exists with name dart' };
      return { ok: true, out: '', err: '' };
    },
  });
  const r = P.registerServer('dart', ['x'], 'local', run);
  // "already exists" is treated as a benign concurrent add → present, not a crash.
  assert.strictEqual(r.action, 'present');
});

test('FP9: claude CLI unavailable → manual note, never a false FAIL/blind add', () => {
  const calls = [];
  // On Windows, claudeCandidates returns ['claude', 'claude.cmd']; both must fail for cli-unavailable.
  const run = runStub({
    claude: new Error('spawn claude ENOENT'),
    'claude.cmd': new Error('spawn claude.cmd ENOENT'),
  }, calls);
  const r = P.registerServer('dart', ['x'], 'local', run);
  assert.strictEqual(r.action, 'cli-unavailable');
  assert.strictEqual(r.status, P.WARN);
  assert.ok(!calls.some(c => c.args[1] === 'add'), 'no add when CLI is unreachable');
});

test('FP9: a generic add failure surfaces the manual command, status WARN', () => {
  const run = runStub({
    claude: (f, a) => {
      if (a[1] === 'get') return { ok: false, out: '', err: 'No MCP server found' };
      if (a[1] === 'add') return { ok: false, out: '', err: 'some other failure' };
      return { ok: true };
    },
  });
  const r = P.registerServer('dart', ['--transport', 'stdio', 'dart'], 'local', run);
  assert.strictEqual(r.action, 'add-failed');
  assert.match(r.message, /claude mcp add/);
});

test('parseMcpGet: absent / present / unknown classification', () => {
  assert.strictEqual(P.parseMcpGet('dart', { ok: false, out: '', err: 'No MCP server found with name: dart' }), 'absent');
  assert.strictEqual(P.parseMcpGet('dart', { ok: true, out: 'dart:\n scope: user\n command: dart mcp-server', err: '' }), 'present');
  assert.strictEqual(P.parseMcpGet('dart', { ok: true, out: 'mystery blob', err: '' }), 'unknown');
  assert.strictEqual(P.parseMcpGet('dart', null), 'unknown');
});

// ---------------------------------------------------------------------------
// Windows .cmd best-effort for the claude CLI (R1-F10)
// ---------------------------------------------------------------------------
test('runClaude: falls through claude → claude.cmd on Windows-style ENOENT', () => {
  const seen = [];
  const run = runStub({
    claude: new Error('spawn claude ENOENT'),
    'claude.cmd': { ok: true, out: 'ok', err: '' },
  }, seen);
  // Force the Windows candidate list by monkeypatching platform via the export.
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const r = P.runClaude(['mcp', 'get', 'dart'], run);
    assert.strictEqual(r.bin, 'claude.cmd', 'second candidate used after ENOENT');
    assert.ok(r.ok);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

// F-WIN-01 — on Windows BOTH candidates (claude, claude.cmd) failing with a
// spawn error ⇒ cli-unavailable (a manual-verify WARN), never a false FAIL or a
// blind add. Monkeypatch platform so claudeCandidates() returns the win32 pair.
test('F-WIN-01: Windows — both claude + claude.cmd ENOENT ⇒ cli-unavailable (not a false FAIL)', () => {
  const calls = [];
  const run = runStub({
    claude: new Error('spawn claude ENOENT'),
    'claude.cmd': new Error('spawn claude.cmd ENOENT'),
  }, calls);
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    // Both candidates must actually be attempted.
    const r = P.registerServer('dart', ['x'], 'local', run);
    assert.strictEqual(r.action, 'cli-unavailable');
    assert.strictEqual(r.status, P.WARN, 'cli-unavailable is a WARN, never a FAIL');
    assert.ok(calls.some(c => c.file === 'claude'), 'tried claude');
    assert.ok(calls.some(c => c.file === 'claude.cmd'), 'tried claude.cmd (win32 candidate)');
    assert.ok(!calls.some(c => c.args[1] === 'add'), 'no blind add when CLI is unreachable');
    // The aggregate must NOT collapse to FAIL on a cli-unavailable dart result.
    const agg = P.checkMcpRegistration('local', run);
    assert.notStrictEqual(agg.status, P.FAIL, 'cli-unavailable dart ⇒ WARN aggregate, not FAIL');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

// ---------------------------------------------------------------------------
// Android SDK-path resolution (2): env-var + default path; bare-PATH never used
// ---------------------------------------------------------------------------
test('Android: resolves $ANDROID_HOME explicitly (env var wins)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-android-'));
  try {
    const sdk = path.join(tmp, 'sdk');
    fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    fs.mkdirSync(path.join(sdk, 'emulator'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb'), '');
    fs.writeFileSync(path.join(sdk, 'emulator', 'emulator'), '');
    const res = P.resolveAndroidSdk({ ANDROID_HOME: sdk }, tmp);
    assert.strictEqual(res.sdkRoot, sdk);
    assert.strictEqual(res.source, '$ANDROID_HOME');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Android: falls back to ~/Library/Android/sdk default path (never bare PATH)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-android-home-'));
  try {
    const sdk = path.join(tmp, 'Library', 'Android', 'sdk');
    fs.mkdirSync(sdk, { recursive: true });
    // No env vars → must resolve via the explicit ~/Library/Android/sdk path.
    const res = P.resolveAndroidSdk({}, tmp);
    assert.strictEqual(res.sdkRoot, sdk);
    assert.strictEqual(res.source, '~/Library/Android/sdk');
    // checkAndroid must NEVER spawn a bare `adb`/`which`/`emulator` PATH probe.
    const calls = [];
    const run = runStub({ flutter: 'Doctor summary' }, calls);
    P.checkAndroid({ run, env: {}, homedir: tmp });
    const bareProbes = calls.filter(c => /^(adb|which|where|emulator)$/.test(c.file));
    assert.strictEqual(bareProbes.length, 0, 'no bare-PATH adb/emulator/which probe');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// marionette host auto-fix
// ---------------------------------------------------------------------------
test('marionette host: present & >= 0.4.0 → FULL, no activate', () => {
  const calls = [];
  const run = runStub({ dart: (f, a) => a.includes('list') ? 'marionette_mcp 0.5.0' : '' }, calls);
  const r = P.checkMarionetteHost(run);
  assert.strictEqual(r.status, P.FULL);
  assert.ok(!calls.some(c => c.args.includes('activate')), 'no auto-provision when present');
});

test('marionette host: absent → auto-provision via dart pub global activate (wrapper on PATH ⇒ provisioned)', () => {
  const calls = [];
  const run = runStub({
    dart: (f, a) => {
      if (a.includes('list')) return { ok: true, out: 'no packages', err: '' };
      if (a.includes('activate')) return { ok: true, out: 'Activated marionette_mcp', err: '' };
      return { ok: true, out: '', err: '' };
    },
  }, calls);
  // Inject env+fs so the post-activate wrapper resolves under $PUB_CACHE/bin.
  const env = { PUB_CACHE: '/pc', PATH: '' };
  const fsImpl = { statSync: (p) => {
    if (/[\\/]pc[\\/]bin[\\/]marionette_mcp/.test(p)) return { isFile: () => true };
    throw new Error('ENOENT');
  } };
  const r = P.checkMarionetteHost(run, { env, fsImpl });
  assert.strictEqual(r.action, 'provisioned');
  assert.ok(calls.some(c => c.args.includes('activate')), 'auto-fix runs activate');
});

// F-PATH-01 — a successful activate whose wrapper is NOT on PATH ⇒ WARN with the
// exact manual PATH fix line (fail-open, never a hard FAIL).
test('F-PATH-01: activate succeeds but wrapper not on PATH ⇒ WARN + manual export PATH fix', () => {
  const run = runStub({
    dart: (f, a) => {
      if (a.includes('list')) return { ok: true, out: 'no packages', err: '' };
      if (a.includes('activate')) return { ok: true, out: 'Activated marionette_mcp', err: '' };
      return { ok: true, out: '', err: '' };
    },
  });
  // No PUB_CACHE wrapper file exists and PATH is empty ⇒ nothing resolves.
  const env = { PUB_CACHE: '/pc', PATH: '' };
  const fsImpl = { statSync: () => { throw new Error('ENOENT'); } };
  const r = P.checkMarionetteHost(run, { env, fsImpl });
  assert.strictEqual(r.action, 'provisioned-not-on-path');
  assert.strictEqual(r.status, P.WARN, 'fail-open WARN, never a FAIL');
  assert.match(r.message, /not on PATH/);
  // Build the expectation the same way the code does (path.join) so the
  // assertion holds on Windows ('\pc\bin') and POSIX ('/pc/bin') alike —
  // R2-REV1-01: a hardcoded forward-slash regex here went red on Windows CI.
  const expectedBin = path.join('/pc', 'bin');
  assert.ok(r.message.includes(expectedBin), 'cites the exact pub-cache bin dir to add');
});

test('pubCacheBinDir + marionetteBinResolves: $PUB_CACHE/bin honored; PATH fallback works', () => {
  assert.strictEqual(P.pubCacheBinDir({ env: { PUB_CACHE: '/pc' } }), path.join('/pc', 'bin'));
  // resolves when the wrapper sits on a PATH dir even if pub-cache bin is empty.
  const env = { PATH: ['/somewhere', '/binx'].join(path.delimiter) };
  const fsImpl = { statSync: (p) => {
    if (/[\\/]binx[\\/]marionette_mcp/.test(p)) return { isFile: () => true };
    throw new Error('ENOENT');
  } };
  assert.strictEqual(P.marionetteBinResolves(fsImpl, { env }), true);
  assert.strictEqual(P.marionetteBinResolves({ statSync: () => { throw new Error('ENOENT'); } }, { env: { PATH: '' } }), false);
});

// ---------------------------------------------------------------------------
// Degradation messages (7): one assertion per row, exact "skill says" text
// ---------------------------------------------------------------------------
test('degradation table: all 7 rows present with their verbatim "skill says" text', () => {
  const rows = P.DEGRADATION_ROWS;
  assert.strictEqual(rows.length, 7, 'exactly the 7 plan rows');
  const says = rows.map(r => r.skillSays);
  assert.ok(says.some(s => /refuse to claim debug-loop capability/.test(s)), 'Dart MCP row');
  assert.ok(says.some(s => /WARN \+ upgrade recommendation/.test(s)), 'dart 3.9–3.11 row');
  assert.ok(says.some(s => /semantic taps unavailable — coordinate fallback/.test(s)), 'marionette row');
  assert.ok(says.some(s => /marionette is the only semantic input\/screenshot path/.test(s)), 'FP1b-gated row');
  assert.ok(says.some(s => /evidence is runtime-error state only/.test(s)), 'both-visual-missing row');
  assert.ok(says.some(s => /get_app_logs unavailable on this path/.test(s)), 'lifecycle row');
  assert.ok(says.some(s => /Android visual status = FP7 VERIFIED/.test(s)), 'Android row');
  // The FP1b row is explicitly gated.
  const fp1b = rows.find(r => r.gated === 'FP1b');
  assert.ok(fp1b, 'FP1b-gated row present');
  assert.strictEqual(fp1b.gated, 'FP1b');
  // The Android row carries the FP7 outcome phrasing (VERIFIED as of FP7 2026-06-11).
  const android = rows.find(r => /Android target/.test(r.missing));
  assert.match(android.degradesTo, /FP7 2026-06-11/);
});

test('renderDegradationTable: prints every row + its skill-says line', () => {
  const out = P.renderDegradationTable();
  for (const row of P.DEGRADATION_ROWS) {
    assert.ok(out.includes(row.skillSays), 'row "' + row.missing + '" rendered');
  }
});

// F-FP1B-TEST-01 — FP1b is NEGATIVE: the gated row must NOT claim a no-package /
// no-modification driver path, and MUST state the in-app extension requirement.
test('FP1b row honors the NEGATIVE verdict: no no-package claim; cites the extension requirement', () => {
  const fp1b = P.DEGRADATION_ROWS.find(r => r.gated === 'FP1b');
  assert.ok(fp1b, 'FP1b-gated row present');
  const blob = (fp1b.degradesTo + ' ' + fp1b.skillSays);
  // Must NOT promise a no-package / no-modification driver tap+screenshot path.
  assert.ok(!/no app package/i.test(blob), 'no "no app package" claim (FP1b NEGATIVE)');
  assert.ok(!/no[- ]modification/i.test(blob), 'no "no-modification" claim');
  // Must state the extension requirement.
  assert.match(fp1b.degradesTo, /enableFlutterDriverExtension/, 'cites enableFlutterDriverExtension requirement');
  assert.match(blob, /marionette is the only semantic input\/screenshot/i, 'marionette is the only semantic route');
  // The inspection-without-extension nuance survives.
  assert.match(blob, /widget_inspector|inspection/i, 'inspection-without-extension nuance retained');
});

// ---------------------------------------------------------------------------
// tier selection (orchestration)
// ---------------------------------------------------------------------------
test('pickTier: dart FAIL → blocked', () => {
  const r = P.pickTier([{ id: 'project', status: P.FULL }, { id: 'dart', status: P.FAIL }]);
  assert.strictEqual(r.tier, 'blocked');
});

test('pickTier: marionette host+app → full-visual', () => {
  const r = P.pickTier([
    { id: 'project', status: P.FULL }, { id: 'dart', status: P.FULL },
    { id: 'marionette-host', status: P.FULL }, { id: 'marionette-app', integrated: true },
  ]);
  assert.strictEqual(r.tier, 'full-visual');
});

test('pickTier: no visual MCP → error-only', () => {
  const r = P.pickTier([
    { id: 'project', status: P.FULL }, { id: 'dart', status: P.FULL },
    { id: 'marionette-host', status: P.WARN }, { id: 'marionette-app', integrated: false },
    { id: 'ios', idb: false },
  ]);
  assert.strictEqual(r.tier, 'error-only');
});

// ---------------------------------------------------------------------------
// runAllChecks read-only mode (doctor uses skipRegistration → no add/activate)
// ---------------------------------------------------------------------------
test('runAllChecks: skipRegistration → never adds MCP, never activates marionette', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ro-'));
  try {
    fs.writeFileSync(path.join(tmp, 'pubspec.yaml'), 'name: demo');
    const calls = [];
    const run = runStub({
      dart: (f, a) => a.includes('list') ? { ok: true, out: 'no packages', err: '' } : 'Dart SDK version: 3.12.0',
      claude: (f, a) => a[1] === 'get' ? { ok: false, out: '', err: 'No MCP server found' } : { ok: true },
      flutter: 'Flutter 3.44.0',
    }, calls);
    P.runAllChecks({ projectDir: tmp, run, skipRegistration: true, env: {}, homedir: tmp });
    assert.ok(!calls.some(c => c.file === 'claude' && c.args[1] === 'add'), 'read-only: no mcp add');
    assert.ok(!calls.some(c => c.file === 'dart' && c.args.includes('activate')), 'read-only: no marionette activate');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// F-TEST-01 — doctor conditionality: the flutter-debug section appears ONLY in a
// Flutter context (pubspec.yaml in cwd or the skill explicitly in use), and is
// SILENT otherwise. Runs doctor.js as a subprocess with a controlled cwd so the
// real `process.cwd()` gate is exercised end-to-end.
// ---------------------------------------------------------------------------
const { execFileSync } = require('node:child_process');
function runDoctor(cwd, extraEnv) {
  // --quiet still computes every section; it just suppresses the banner print.
  // doctor.js exits non-zero when other anti-hall checks fail in a bare tmpdir,
  // so capture stdout regardless of exit status.
  try {
    return execFileSync(process.execPath, [DOCTOR_JS], {
      cwd,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { ANTIHALL_DOCTOR_CONTEXT: '' }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
  }
}

test('doctor conditionality: NO flutter-debug section without pubspec.yaml; section present with it', () => {
  // (a) bare tmpdir, no pubspec → the flutter-debug section must be ABSENT.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-doctor-bare-'));
  // (b) tmpdir WITH pubspec → the flutter-debug section must be PRESENT.
  const flut = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-doctor-flutter-'));
  try {
    fs.writeFileSync(path.join(flut, 'pubspec.yaml'), 'name: demo\n');
    const outBare = runDoctor(bare);
    const outFlut = runDoctor(flut);
    assert.ok(!/flutter-debug \(Flutter project detected\)/.test(outBare),
      'flutter-debug section is silent in a non-Flutter cwd');
    assert.match(outFlut, /flutter-debug \(Flutter project detected\)/,
      'flutter-debug section appears when a pubspec.yaml is in cwd');
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(flut, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Doctor no-duplication: doctor require()s the SAME exported checks (in-process)
// and does NOT re-implement the probe logic.
// ---------------------------------------------------------------------------
test('doctor no-duplication: hooks/doctor.js require()s preflight.js and calls its exports', () => {
  const src = fs.readFileSync(DOCTOR_JS, 'utf8');
  // require()s the preflight by path (shared implementation, not a subprocess spawn).
  assert.match(src, /skills['"\s,)\]]+.*flutter-debug.*preflight\.js|flutter-debug['"\s,)\]]+.*scripts['"\s,)\]]+.*preflight\.js/);
  assert.match(src, /preflight\.runAllChecks/, 'calls the exported runAllChecks');
  assert.match(src, /skipRegistration:\s*true/, 'doctor stays read-only');
  // It must NOT spawn preflight.js as a subprocess (that would be the duplicated
  // entry point the plan forbids). No spawnSync/execFileSync of preflight.js.
  assert.ok(!/spawn\w*\([^)]*preflight\.js/.test(src), 'no subprocess spawn of preflight.js');
});

// ---------------------------------------------------------------------------
// Agent frontmatter parse (FP5 passed → this test is INCLUDED)
// ---------------------------------------------------------------------------
function parseFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Handle both Unix (\n) and Windows (\r\n) line endings
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'frontmatter block present in ' + path.basename(file));
  const fm = {};
  // Split on both \n and \r\n, then normalize
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test('agent frontmatter: {name: flutter-debug, description, model: sonnet}, NO tools allowlist', () => {
  const fm = parseFrontmatter(AGENT_MD);
  assert.strictEqual(fm.name, 'flutter-debug');
  assert.strictEqual(fm.model, 'sonnet', 'code-authoring floor; never haiku/flagship');
  assert.ok(fm.description && fm.description.length > 30, 'has trigger description');
  assert.ok(!('tools' in fm), 'NO tools allowlist (a wrong allowlist bricks MCP reachability)');
});

test('agent body: carries the loop + escalation report-back (escalate: opus after 2 iterations)', () => {
  const text = fs.readFileSync(AGENT_MD, 'utf8');
  assert.match(text, /escalate:\s*opus/, 'escalation signal present');
  assert.match(text, /2 full loop iterations/, 'escalation trigger stated');
  assert.match(text, /never respawns? yourself|never respawn yourself/i, 'agent does not self-respawn');
  assert.match(text, /No repro, no fix|No proven cause, no fix/i, 'evidence discipline');
  assert.match(text, /visually unverified/, 'no-screenshot honesty');
});

// ---------------------------------------------------------------------------
// SKILL.md lint
// ---------------------------------------------------------------------------
test('SKILL.md: frontmatter has name + description, no model field', () => {
  const fm = parseFrontmatter(SKILL_MD);
  assert.strictEqual(fm.name, 'flutter-debug');
  assert.ok(fm.description && fm.description.length > 30);
  assert.ok(!('model' in fm), 'skills carry no model field');
});

test('SKILL.md: scope question, own claude-mcp-get pre-check, delegated preflight, spawn, escalation respawn', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  assert.match(text, /AskUserQuestion/, 'scope question via AskUserQuestion in main context');
  assert.match(text, /claude mcp get dart/, 'own quick mcp get pre-check in main context');
  assert.match(text, /preflight\.js.*--scope/s, 'delegated preflight with scope arg');
  assert.match(text, /subagent_type:\s*["']?flutter-debug/, 'spawns the flutter-debug agent');
  assert.match(text, /escalate:\s*opus[\s\S]*model:\s*["']opus["']/, 'escalation respawn rule (opus)');
  assert.match(text, /kDebugMode/, 'auto-apply kDebugMode integration');
  assert.match(text, /git diff/i, 'git-diff visibility for the auto-apply');
});

// ---------------------------------------------------------------------------
// repo-agnostic: shipped flutter-debug files name no owner paths / app names
// ---------------------------------------------------------------------------
test('shipped flutter-debug files are public-repo agnostic (denylist: no owner paths / app / device names)', () => {
  for (const f of [AGENT_MD, SKILL_MD, PREFLIGHT_JS]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const { re, label } of OWNER_IDENTIFIER_DENYLIST) {
      assert.ok(!re.test(text), label + ' must not appear in ' + path.basename(f));
    }
  }
});

test('public docs/fixtures carry no owner identifiers (probe record + plan doc + CHANGELOG 0.34.x)', () => {
  // Probe record + plan doc: scrub app + device names + /Users/ paths (the
  // standard `~/Library/Android/sdk` path carries no username and is allowed).
  for (const f of [PROBE_RECORD, PLAN_DOC]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const { re, label } of OWNER_IDENTIFIER_DENYLIST) {
      assert.ok(!re.test(text), label + ' must not appear in ' + path.basename(f));
    }
  }
  // CHANGELOG: only the 0.34.x sections are in scope for this scrub.
  const sections = changelog034Sections(fs.readFileSync(CHANGELOG, 'utf8'));
  assert.ok(sections.length > 0, 'CHANGELOG 0.34.x sections found');
  for (const { re, label } of OWNER_IDENTIFIER_DENYLIST) {
    assert.ok(!re.test(sections), label + ' must not appear in CHANGELOG 0.34.x sections');
  }
});

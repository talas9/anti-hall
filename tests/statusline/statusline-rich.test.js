'use strict';
// statusline-rich.js — the generic rich line-1 renderer. Two surfaces:
//   1. safeLabel() — the terminal-escape sanitizer, exported + pure, tested
//      directly via require().
//   2. The rendered line — tested via subprocess with a crafted session JSON on
//      stdin, NO_COLOR=1 (so we assert visible text, not ANSI), and a NON-git
//      temp cwd so git segments are deterministic (empty branch). The script
//      reads project root from its OWN cwd, so we run it with cwd = a temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runSL, makeStatusHome, makeProjectDir } = require('./helper.js');

const rich = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'statusline', 'statusline-rich.js'));

// --- safeLabel (pure, exported) --------------------------------------------

test('safeLabel strips SGR/CSI color escapes but keeps the text', () => {
  assert.strictEqual(rich.safeLabel('\x1b[31mred\x1b[0mABC'), 'redABC');
});

test('safeLabel removes C0 control chars, NUL and DEL', () => {
  assert.strictEqual(rich.safeLabel('a\x07b\x00c\x7fd'), 'abcd');
});

test('safeLabel strips an OSC window-title injection (ESC ] ... BEL)', () => {
  assert.strictEqual(rich.safeLabel('ti\x1b]0;evil\x07tle'), 'title');
});

test('safeLabel removes Unicode bidi override characters', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE between x and y.
  assert.strictEqual(rich.safeLabel('x‮y'), 'xy');
});

test('safeLabel returns empty string for a non-string input (fail-open)', () => {
  assert.strictEqual(rich.safeLabel(123), '');
  assert.strictEqual(rich.safeLabel(null), '');
  assert.strictEqual(rich.safeLabel(undefined), '');
});

test('safeLabel passes a clean label through unchanged', () => {
  assert.strictEqual(rich.safeLabel('feature/login-v2'), 'feature/login-v2');
});

test('safeLabel removes embedded newlines/tabs (C0 range)', () => {
  assert.strictEqual(rich.safeLabel('line1\nline2\ttab'), 'line1line2tab');
});

// --- Rendered line via subprocess ------------------------------------------

// Run rich in a NON-git temp dir with colors off and email chip suppressed.
function renderRich(stdin, home, cwd) {
  return runSL('statusline-rich.js', {
    home, cwd, stdin,
    env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
  }).stdout;
}

test('rich line shows model name, project basename, ctx%, duration and cost', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const payload = JSON.stringify({
      model: { display_name: 'Opus 4.8' },
      context_window: { used_percentage: 42 },
      cost: { total_cost_usd: 1.23, total_duration_ms: 125000 },
    });
    const out = renderRich(payload, h.home, proj.dir);
    assert.match(out, /Opus 4\.8/, 'model name from stdin');
    assert.match(out, new RegExp(path.basename(proj.dir)), 'project basename = cwd basename (non-git)');
    assert.match(out, /42% ctx/);
    assert.match(out, /2m5s/, '125000ms -> 2m5s');
    assert.match(out, /\$1\.23/);
  } finally { h.cleanup(); proj.cleanup(); }
});

test('rich line omits cost and ctx chips when the payload lacks them', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const out = renderRich(JSON.stringify({ model: { display_name: 'Haiku' } }), h.home, proj.dir);
    assert.match(out, /Haiku/);
    assert.doesNotMatch(out, /ctx/, 'no context chip without context_window');
    assert.doesNotMatch(out, /\$/, 'no cost chip without cost');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('rich line renders a GSD chip when .planning/STATE.md is present at cwd', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    proj.mkPlanningState([
      '---',
      "milestone: 'v1.2'",
      'status: Phase 3 executing the build',
      'progress:',
      '  percent: 40',
      '---',
    ].join('\n'));
    const out = renderRich(JSON.stringify({ model: { display_name: 'Opus' } }), h.home, proj.dir);
    assert.match(out, /v1\.2/, 'milestone in GSD chip');
    assert.match(out, /Phase 3/);
    assert.match(out, /40%/);
  } finally { h.cleanup(); proj.cleanup(); }
});

test('rich line fail-open: garbage stdin still produces a (header) line, never crashes', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: 'not json at all',
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, new RegExp(path.basename(proj.dir)), 'header still renders project name');
  } finally { h.cleanup(); proj.cleanup(); }
});

// --- getModelName() fallback branches: Fable detection -------------------

// lastModelUsage path: fable model id → 'Fable'
test('getModelName returns Fable from lastModelUsage when model id contains fable segment', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Write ~/.claude.json keyed to the realpath of proj.dir so it matches
    // process.cwd() in the subprocess (macOS /var -> /private/var symlink).
    h.writeClaudeJson({
      [fs.realpathSync(proj.dir)]: {
        lastModelUsage: {
          'claude-fable-5': { inputTokens: 100, outputTokens: 50, costUSD: 0.1 },
        },
      },
    });
    // No stdin model — forces file-fallback path
    const out = renderRich('', h.home, proj.dir);
    assert.match(out, /Fable/, 'Fable label rendered via lastModelUsage path');
  } finally { h.cleanup(); proj.cleanup(); }
});

// settings path: fable model id → 'Fable'
test('getModelName returns Fable from settings.json when model field contains fable segment', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Write <proj.dir>/.claude/settings.json — the path getSettings() reads
    h.writeProjectSettings(proj.dir, { model: 'claude-fable-5' });
    const out = renderRich('', h.home, proj.dir);
    assert.match(out, /Fable/, 'Fable label rendered via settings.json path');
  } finally { h.cleanup(); proj.cleanup(); }
});

// Collision negative: 'confable-local' must NOT produce 'Fable'
test('getModelName does NOT match fable for a model id where fable is a substring not a segment (confable-local)', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    h.writeClaudeJson({
      [fs.realpathSync(proj.dir)]: {
        lastModelUsage: {
          'confable-local': { inputTokens: 1, outputTokens: 1, costUSD: 0 },
        },
      },
    });
    const out = renderRich('', h.home, proj.dir);
    assert.doesNotMatch(out, /\bFable\b/, 'confable-local must NOT render as Fable');
  } finally { h.cleanup(); proj.cleanup(); }
});

// Existing tier segments still pass via lastModelUsage
test('getModelName segment matching: opus segment → Opus', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    h.writeClaudeJson({
      [fs.realpathSync(proj.dir)]: {
        lastModelUsage: {
          'claude-opus-4-8': { inputTokens: 1, outputTokens: 1, costUSD: 0 },
        },
      },
    });
    const out = renderRich('', h.home, proj.dir);
    assert.match(out, /Opus/);
  } finally { h.cleanup(); proj.cleanup(); }
});

test('getModelName segment matching: sonnet segment → Sonnet', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    h.writeClaudeJson({
      [fs.realpathSync(proj.dir)]: {
        lastModelUsage: {
          'claude-sonnet-4-6': { inputTokens: 1, outputTokens: 1, costUSD: 0 },
        },
      },
    });
    const out = renderRich('', h.home, proj.dir);
    assert.match(out, /Sonnet/);
  } finally { h.cleanup(); proj.cleanup(); }
});

// --- AH version chip -----------------------------------------------------------

test('rich line shows AH version chip (AH: Vx.x.x) between cost and email', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Write ~/.claude.json with oauthAccount so the email chip renders
    fs.writeFileSync(
      path.join(h.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com' } }),
      'utf8'
    );
    const payload = JSON.stringify({
      model: { display_name: 'Sonnet' },
      cost: { total_cost_usd: 0.5, total_duration_ms: 60000 },
    });
    // Run WITHOUT suppressing email so all three segments (cost, AH, email) appear
    const out = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: payload,
      env: { NO_COLOR: '1' },
    }).stdout;
    assert.match(out, /AH: V\d+\.\d+\.\d+/, 'AH version chip present in output');
    // Ordering: cost ($) < AH version < email
    const dollarIdx = out.indexOf('$');
    const ahIdx     = out.indexOf('AH: V');
    const emailIdx  = out.indexOf('test@example.com');
    assert.ok(dollarIdx !== -1, 'cost chip present');
    assert.ok(ahIdx     !== -1, 'AH version chip present');
    assert.ok(emailIdx  !== -1, 'email chip present');
    assert.ok(dollarIdx < ahIdx,    'cost segment appears before AH version');
    assert.ok(ahIdx     < emailIdx, 'AH version appears before email segment');
  } finally { h.cleanup(); proj.cleanup(); }
});

// --- AH version update indicator -------------------------------------------

// Helper: write version-check.json into fake HOME's .anti-hall dir.
function writeVersionCheck(antiHallDir, obj) {
  fs.writeFileSync(path.join(antiHallDir, 'version-check.json'), JSON.stringify(obj), 'utf8');
}

// Derive fixture versions from the running plugin.json so these tests never
// break on a version bump.
const _pluginVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'), 'utf8')
).version;
const [_pMajor, _pMinor] = _pluginVersion.split('.').map(Number);
const _minorAheadLatest = `${_pMajor}.${_pMinor + 1}.0`;
const _majorAheadLatest = `${_pMajor + 1}.0.0`;

// (a) cache latest minor-ahead → segment contains "★" + yellow ANSI code
test('AH version chip: minor-ahead cache shows star and yellow color', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // latest minor is ahead of running (current < _minorAheadLatest)
    writeVersionCheck(h.antiHall, { latest: _minorAheadLatest, checkedAt: Date.now() });
    const out = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: JSON.stringify({ model: { display_name: 'Sonnet' } }),
      env: { ANTIHALL_STATUSLINE_NO_EMAIL: '1' }, // colors ON (no NO_COLOR)
    }).stdout;
    assert.match(out, /★/, 'star present for minor update');
    // yellow ANSI: \x1b[0;33m
    assert.ok(out.includes('\x1b[0;33m'), 'yellow color code present for minor update');
  } finally { h.cleanup(); proj.cleanup(); }
});

// (b) cache latest major-ahead → segment contains "★" + red ANSI code
test('AH version chip: major-ahead cache shows star and red color', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // latest major is ahead of running (current < _majorAheadLatest)
    writeVersionCheck(h.antiHall, { latest: _majorAheadLatest, checkedAt: Date.now() });
    const out = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: JSON.stringify({ model: { display_name: 'Sonnet' } }),
      env: { ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
    }).stdout;
    assert.match(out, /★/, 'star present for major update');
    // red ANSI: \x1b[0;31m
    assert.ok(out.includes('\x1b[0;31m'), 'red color code present for major update');
  } finally { h.cleanup(); proj.cleanup(); }
});

// (c) cache latest == running → no star, dim plain style
test('AH version chip: same version in cache shows no star', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    writeVersionCheck(h.antiHall, { latest: '0.36.1', checkedAt: Date.now() });
    const out = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: JSON.stringify({ model: { display_name: 'Sonnet' } }),
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
    }).stdout;
    assert.match(out, /AH: V/, 'AH chip still present');
    assert.doesNotMatch(out, /★/, 'no star when version is current');
  } finally { h.cleanup(); proj.cleanup(); }
});

// (d) no cache file → no star, plain, no crash
test('AH version chip: no cache file shows no star and does not crash', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // antiHall dir exists but version-check.json is absent
    const out = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: JSON.stringify({ model: { display_name: 'Sonnet' } }),
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
    }).stdout;
    assert.match(out, /AH: V/, 'AH chip still present without cache');
    assert.doesNotMatch(out, /★/, 'no star without cache');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('getModelName segment matching: haiku segment → Haiku', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    h.writeClaudeJson({
      [fs.realpathSync(proj.dir)]: {
        lastModelUsage: {
          'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, costUSD: 0 },
        },
      },
    });
    const out = renderRich('', h.home, proj.dir);
    assert.match(out, /Haiku/);
  } finally { h.cleanup(); proj.cleanup(); }
});

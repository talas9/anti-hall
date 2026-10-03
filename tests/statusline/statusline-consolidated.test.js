'use strict';
// statusline-consolidated.test.js — tests for the consolidated (base-passthrough) mode
// of statusline-rich.js.
//
// Consolidated mode: if ANTIHALL_STATUSLINE_BASE env var is set (a shell command),
// statusline-rich.js runs that command first with the same stdin the harness
// provides, captures its stdout, and APPENDS the AH version chip as the only
// anti-hall-specific segment.  Fail-open: absent / failing base command → full
// rich render (no crash).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSL, makeStatusHome, makeProjectDir } = require('./helper.js');

// Cross-platform base command that prints the given output to stdout.
// Writes a temp script so we avoid shell quoting hell around single-quoted
// strings inside double quotes across POSIX sh vs Windows cmd.
// Uses an incrementing counter (not Date.now()) to avoid filename collisions
// when multiple helpers are called within the same millisecond.
let _scriptSeq = 0;
function makeTmpScript(content) {
  const script = path.join(os.tmpdir(), 'ah-sl-tmp-' + process.pid + '-' + (++_scriptSeq) + '.js');
  fs.writeFileSync(script, content, 'utf8');
  return script;
}

function makeBaseCmd(output) {
  const script = makeTmpScript("process.stdout.write(" + JSON.stringify(output) + ");");
  return process.execPath + ' ' + script;
}

function makeFailCmd() {
  const script = makeTmpScript('process.exit(1);');
  return process.execPath + ' ' + script;
}

// ── (a) Base passthrough ────────────────────────────────────────────────────
// Given a fake base command that prints "BASE", the consolidated render must
// contain "BASE" followed by the AH chip ("AH: V").

test('consolidated: base command output is prepended and AH chip is appended', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const baseCmd = makeBaseCmd('BASE');
    const payload = JSON.stringify({ model: { display_name: 'Sonnet' } });
    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: payload,
      env: {
        NO_COLOR: '1',
        ANTIHALL_STATUSLINE_NO_EMAIL: '1',
        ANTIHALL_STATUSLINE_BASE: baseCmd,
      },
    });
    assert.strictEqual(r.status, 0, 'exits 0');
    assert.match(r.stdout, /BASE/, 'base command output present');
    assert.match(r.stdout, /AH: V/, 'AH version chip appended');
    const baseIdx = r.stdout.indexOf('BASE');
    const ahIdx   = r.stdout.indexOf('AH: V');
    assert.ok(baseIdx !== -1, 'BASE in output');
    assert.ok(ahIdx   !== -1, 'AH chip in output');
    assert.ok(baseIdx < ahIdx, 'BASE appears before the AH chip');
  } finally { h.cleanup(); proj.cleanup(); }
});

// Same test via the config-file path (consolidated-base.json) to exercise the
// file-based detection in getConsolidatedBase().
test('consolidated: config file (consolidated-base.json) triggers passthrough', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const baseCmd = makeBaseCmd('CFGBASE');
    // Write ~/.anti-hall/consolidated-base.json in the fake home
    const cfgPath = path.join(h.antiHall, 'consolidated-base.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ command: baseCmd }), 'utf8');

    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir,
      stdin: JSON.stringify({ model: { display_name: 'Haiku' } }),
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
      // ANTIHALL_STATUSLINE_BASE intentionally NOT set — must come from file
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /CFGBASE/, 'base output from config file');
    assert.match(r.stdout, /AH: V/, 'AH chip appended');
  } finally { h.cleanup(); proj.cleanup(); }
});

// Env var takes priority over config file when both are present.
test('consolidated: ANTIHALL_STATUSLINE_BASE env var takes priority over config file', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const envCmd  = makeBaseCmd('ENVBASE');
    const fileCmd = makeBaseCmd('FILEBASE');
    const cfgPath = path.join(h.antiHall, 'consolidated-base.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ command: fileCmd }), 'utf8');

    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir,
      stdin: JSON.stringify({ model: { display_name: 'Opus' } }),
      env: {
        NO_COLOR: '1',
        ANTIHALL_STATUSLINE_NO_EMAIL: '1',
        ANTIHALL_STATUSLINE_BASE: envCmd,
      },
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /ENVBASE/, 'env var base wins');
    assert.doesNotMatch(r.stdout, /FILEBASE/, 'file base not used when env var present');
  } finally { h.cleanup(); proj.cleanup(); }
});

// Stdin JSON is forwarded to the base command unchanged.
test('consolidated: stdin JSON payload is forwarded to the base command', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Base command echoes what it receives on stdin back to stdout.
    const echoScript = path.join(os.tmpdir(), 'ah-sl-echo-' + process.pid + '.js');
    fs.writeFileSync(echoScript, [
      'const c=[];',
      'process.stdin.on("data",d=>c.push(d));',
      'process.stdin.on("end",()=>process.stdout.write(Buffer.concat(c).toString()));',
    ].join('\n'), 'utf8');
    const baseCmd = process.execPath + ' ' + echoScript;
    const payload = JSON.stringify({ model: { display_name: 'Haiku' }, _sentinel: 'FORWARDED' });

    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: payload,
      env: {
        NO_COLOR: '1',
        ANTIHALL_STATUSLINE_NO_EMAIL: '1',
        ANTIHALL_STATUSLINE_BASE: baseCmd,
      },
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /FORWARDED/, 'stdin payload forwarded to base command');
  } finally { h.cleanup(); proj.cleanup(); }
});

// ── (b) Fail-open: base command absent / failing ────────────────────────────
// When the base command exits non-zero, the renderer must fall back to the full
// rich anti-hall line without crashing.

test('consolidated: failing base command falls back to full rich line (no crash)', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const failCmd = makeFailCmd();
    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir,
      stdin: JSON.stringify({ model: { display_name: 'Opus' } }),
      env: {
        NO_COLOR: '1',
        ANTIHALL_STATUSLINE_NO_EMAIL: '1',
        ANTIHALL_STATUSLINE_BASE: failCmd,
      },
    });
    assert.strictEqual(r.status, 0, 'exits 0 even when base command fails');
    // Falls back to own rich render — model name and AH chip should appear
    assert.match(r.stdout, /Opus/, 'own rich render shows model name');
    assert.match(r.stdout, /AH: V/, 'AH chip present in fallback render');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('consolidated: empty ANTIHALL_STATUSLINE_BASE (whitespace) is ignored → own rich render', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir,
      stdin: JSON.stringify({ model: { display_name: 'Haiku' } }),
      env: {
        NO_COLOR: '1',
        ANTIHALL_STATUSLINE_NO_EMAIL: '1',
        ANTIHALL_STATUSLINE_BASE: '   ',  // whitespace-only → treated as absent
      },
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Haiku/, 'own rich render');
  } finally { h.cleanup(); proj.cleanup(); }
});

// ── (c) No consolidated config → exact current behaviour ───────────────────
// When neither ANTIHALL_STATUSLINE_BASE nor consolidated-base.json is present,
// the renderer must behave exactly as it did before this feature was added.

test('consolidated: absent env var and absent config file → normal rich render unchanged', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const payload = JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 55 },
      cost: { total_cost_usd: 0.42, total_duration_ms: 90000 },
    });
    const r = runSL('statusline-rich.js', {
      home: h.home, cwd: proj.dir, stdin: payload,
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
      // Neither ANTIHALL_STATUSLINE_BASE nor consolidated-base.json
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Sonnet/, 'model chip');
    assert.match(r.stdout, /55% ctx/, 'context chip');
    assert.match(r.stdout, /\$0\.42/, 'cost chip');
    assert.match(r.stdout, /1m30s/, 'duration chip');
    assert.match(r.stdout, /AH: V/, 'AH version chip');
  } finally { h.cleanup(); proj.cleanup(); }
});

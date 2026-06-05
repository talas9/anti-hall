'use strict';
// statusline.js — the two-line dispatcher. LINE 1 = base command (if
// ~/.anti-hall/base-statusline.json) else own-dispatch (rich/monorepo/simple);
// LINE 2 = phase-bar.js. We drive it with a fake HOME (for base config + phase
// state) and a non-git temp cwd (so line-1 rich is deterministic), and assert
// the composed output. Line 2 is the deterministic part we pin hardest.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runSL, stripAnsi, makeStatusHome, makeProjectDir } = require('./helper.js');

function run(payloadObj, home, cwd) {
  return runSL('statusline.js', {
    home, cwd, stdin: JSON.stringify(payloadObj),
    env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
  });
}

test('dispatcher emits line 1 (own-dispatch) + line 2 (phase bar) when a phase is active', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    h.writePhaseState({ code: 'P3', desc: 'ship', done: 3, total: 4, started: Date.now() });
    const r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 30 } }, h.home, proj.dir);
    assert.strictEqual(r.status, 0);
    const lines = stripAnsi(r.stdout).split('\n');
    assert.strictEqual(lines.length, 2, 'two lines emitted');
    assert.match(lines[0], new RegExp(path.basename(proj.dir)), 'line 1 = rich header for the cwd project');
    assert.match(lines[1], /P3.*ship.*3\/4/, 'line 2 = phase bar');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('dispatcher line 2 falls back to the context gauge when no phase is active', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 56 } }, h.home, proj.dir);
    const out = stripAnsi(r.stdout);
    assert.match(out, /56% context/, 'line 2 is the context gauge');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('dispatcher uses a base-statusline.json command as line 1 when present', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Cross-platform base line-1: a tiny .js file run via `node "<path>"`. We do
    // NOT use `node -e "..."` because cmd /c (the Windows shell the dispatcher
    // uses) mangles the nested quotes, so the JS never reaches node — the cause
    // of the original Windows CI failure. A single quoted path arg survives both
    // sh -c and cmd /c. JSON.stringify escapes the Windows backslashes in the path.
    const baseScript = path.join(h.antiHall, 'baseline.js');
    fs.writeFileSync(baseScript, "process.stdout.write('BASELINE-X');\n", 'utf8');
    const baseCmd = `node "${baseScript}"`;
    fs.writeFileSync(path.join(h.antiHall, 'base-statusline.json'), JSON.stringify({ command: baseCmd }), 'utf8');
    const r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 20 } }, h.home, proj.dir);
    const lines = stripAnsi(r.stdout).split('\n');
    assert.strictEqual(lines[0], 'BASELINE-X', 'line 1 = the base command stdout, verbatim');
    assert.match(lines[1], /20% context/, 'line 2 still rendered');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('dispatcher falls through to own-dispatch when the base command fails', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // A command that exits non-zero -> runBaseCommand returns null -> own-dispatch.
    // Use a quoted script path (not `node -e "..."`) so it works under cmd /c on
    // Windows too — see the base-command test above for the quote-mangling rationale.
    const failScript = path.join(h.antiHall, 'fail3.js');
    fs.writeFileSync(failScript, 'process.exit(3);\n', 'utf8');
    fs.writeFileSync(path.join(h.antiHall, 'base-statusline.json'),
      JSON.stringify({ command: `node "${failScript}"` }), 'utf8');
    const r = run({ model: { display_name: 'Opus' } }, h.home, proj.dir);
    const lines = stripAnsi(r.stdout).split('\n');
    assert.match(lines[0], new RegExp(path.basename(proj.dir)), 'fell back to own rich header');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('dispatcher fail-open: never crashes on empty stdin', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const r = runSL('statusline.js', {
      home: h.home, cwd: proj.dir, stdin: '',
      env: { NO_COLOR: '1', ANTIHALL_STATUSLINE_NO_EMAIL: '1' },
    });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); proj.cleanup(); }
});

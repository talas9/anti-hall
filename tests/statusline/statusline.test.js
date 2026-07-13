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
    // Cross-platform base line-1: the dispatcher runs the base command via the
    // system shell (`cmd /c` on Windows, `sh -c` elsewhere). `echo BASELINE-X` is
    // a builtin of BOTH shells, needs no PATH/PATHEXT resolution and no quoted
    // path, so it sidesteps the `cmd /c node "<abspath>"` arg-escaping that failed
    // on the Windows runners. cmd appends CRLF / sh appends LF; runBaseCommand
    // trims trailing newlines, leaving exactly 'BASELINE-X' on every platform.
    const baseCmd = 'echo BASELINE-X';
    fs.writeFileSync(path.join(h.antiHall, 'base-statusline.json'), JSON.stringify({ command: baseCmd }), 'utf8');
    const r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 20 } }, h.home, proj.dir);
    const lines = stripAnsi(r.stdout).split('\n');
    assert.strictEqual(lines[0], 'BASELINE-X', 'line 1 = the base command stdout, verbatim');
    assert.match(lines[1], /20% context/, 'line 2 still rendered');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('dispatcher still uses the base command when a large stdin payload overflows the pipe buffer (benign stdin-write race)', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    // Regression for a real CI flake (originally seen on ubuntu-latest, all
    // node majors; Windows hits the same race with a different errno — see
    // below): `echo` never reads stdin. If our write of stdinBytes to the
    // child's stdin pipe doesn't fully land before the child exits —
    // guaranteed here by a payload well past any OS pipe buffer (~64KB on
    // POSIX, much smaller on Windows named pipes) — spawnSync reports a
    // benign write error on `result.error` even though the child ran to
    // completion with status 0 and correct stdout. The errno is platform-
    // specific: POSIX reports `EPIPE`; Windows' libuv pipe-write completion
    // path routes a broken-pipe write through the generic error translator,
    // which maps it to `EOF` instead (not the write-specific EPIPE override),
    // while still capturing the child's real exit status independently.
    // runBaseCommand must not discard that successful result on ANY platform
    // — so this test asserts on the OUTCOME (base command output wins),
    // never on the specific errno, and must pass unmodified on every OS.
    const baseCmd = 'echo BASELINE-LARGE';
    fs.writeFileSync(path.join(h.antiHall, 'base-statusline.json'), JSON.stringify({ command: baseCmd }), 'utf8');
    const r = run({
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 20 },
      _padding: 'x'.repeat(300000),
    }, h.home, proj.dir);
    const lines = stripAnsi(r.stdout).split('\n');
    assert.strictEqual(lines[0], 'BASELINE-LARGE', 'line 1 = the base command stdout, despite the stdin-write race (errno varies by platform)');
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

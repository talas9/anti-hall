'use strict';
// statusline-simple.js — minimal line-1 renderer: model | branch | dir | ctx%.
// branch comes from `git` run against data.workspace.current_dir; to keep the
// test deterministic we point current_dir at a NON-git temp dir so the branch
// segment is omitted, leaving model/dir/ctx% which are pure functions of stdin.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runSL, makeStatusHome, makeProjectDir } = require('./helper.js');

function renderSimple(payloadObj, home) {
  return runSL('statusline-simple.js', { home, stdin: JSON.stringify(payloadObj) }).stdout;
}

test('simple line shows model, dir basename and a green ctx% under 50', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir(); // non-git -> no branch segment
  try {
    const out = renderSimple(
      { model: { display_name: 'Haiku' }, workspace: { current_dir: proj.dir },
        context_window: { remaining_percentage: 90 } },
      h.home,
    );
    assert.match(out, /Haiku/);
    assert.match(out, new RegExp(path.basename(proj.dir)));
    assert.match(out, /10%/, '100 - 90 = 10% used');
    assert.match(out, /\x1b\[32m/, 'green SGR for <50% used');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('simple line uses red ctx color when usage is high', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const out = renderSimple(
      { model: { display_name: 'Opus' }, workspace: { current_dir: proj.dir },
        context_window: { remaining_percentage: 10 } },
      h.home,
    );
    assert.match(out, /90%/, '100 - 10 = 90% used');
    assert.match(out, /\x1b\[31m/, 'red SGR for >=75% used');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('simple line defaults the model to "Claude" when absent', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const out = renderSimple({ workspace: { current_dir: proj.dir } }, h.home);
    assert.match(out, /Claude/);
  } finally { h.cleanup(); proj.cleanup(); }
});

test('simple line omits the ctx segment when remaining_percentage is non-numeric', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const out = renderSimple(
      { model: { display_name: 'Opus' }, workspace: { current_dir: proj.dir },
        context_window: { remaining_percentage: 'n/a' } },
      h.home,
    );
    assert.doesNotMatch(out, /%/, 'no percent segment for a non-numeric value');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('simple line fail-open: invalid JSON yields empty output, exits 0', () => {
  const h = makeStatusHome();
  try {
    const r = runSL('statusline-simple.js', { home: h.home, stdin: 'nope' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

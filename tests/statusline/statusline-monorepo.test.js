'use strict';
// statusline-monorepo.js — the GSD/monorepo line-1 renderer. It reads the
// project from data.workspace.current_dir on stdin (NOT its own cwd), parses
// <current_dir>/.planning/STATE.md, and composes a line. We drive it with a
// fixture .planning/STATE.md tree + a crafted payload and assert the visible
// (ANSI-stripped) line. CLAUDE_CONFIG_DIR is pointed at the fake HOME so the
// todos lookup never reads the real machine.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runSL, stripAnsi, makeStatusHome, makeProjectDir } = require('./helper.js');

function renderMono(payloadObj, home, claudeDir) {
  const out = runSL('statusline-monorepo.js', {
    home,
    stdin: JSON.stringify(payloadObj),
    env: { CLAUDE_CONFIG_DIR: claudeDir },
  }).stdout;
  return stripAnsi(out);
}

test('monorepo line renders model, milestone+progress, active phase, dir basename', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    proj.mkPlanningState([
      '---',
      'milestone: v1.2',
      'status: executing',
      'active_phase: 3',
      'progress:',
      '  completed_phases: 2',
      '  total_phases: 5',
      '  percent: 40',
      '---',
      'Phase: 3 of 5 (build api)',
    ].join('\n'));
    const out = renderMono(
      { model: { display_name: 'Sonnet' }, workspace: { current_dir: proj.dir },
        context_window: { remaining_percentage: 80, total_tokens: 1000000 } },
      h.home, h.claude,
    );
    assert.match(out, /Sonnet/);
    assert.match(out, /v1\.2/);
    assert.match(out, /40%/, 'milestone progress percent');
    assert.match(out, /Phase 3 executing/);
    assert.match(out, new RegExp(path.basename(proj.dir)), 'dir basename segment');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('monorepo line falls back to plain model|dir when no .planning state exists', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir(); // no .planning
  try {
    const out = renderMono(
      { model: { display_name: 'Haiku' }, workspace: { current_dir: proj.dir } },
      h.home, h.claude,
    );
    assert.match(out, /Haiku/);
    assert.match(out, new RegExp(path.basename(proj.dir)));
    assert.doesNotMatch(out, /Phase/, 'no GSD middle segment without state');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('monorepo line renders the context meter from remaining_percentage', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    const out = renderMono(
      { model: { display_name: 'Opus' }, workspace: { current_dir: proj.dir },
        context_window: { remaining_percentage: 50, total_tokens: 1000000 } },
      h.home, h.claude,
    );
    // remaining 50% with the auto-compact buffer -> a non-trivial used%; assert a [bar] %.
    assert.match(out, /\[[#-]{10}\]\s+\d+%/, 'context meter bar rendered');
  } finally { h.cleanup(); proj.cleanup(); }
});

test('monorepo line shows "milestone complete" at 100 percent', () => {
  const h = makeStatusHome();
  const proj = makeProjectDir();
  try {
    proj.mkPlanningState([
      '---',
      'milestone: v2',
      'progress:',
      '  percent: 100',
      '---',
    ].join('\n'));
    const out = renderMono(
      { model: { display_name: 'Opus' }, workspace: { current_dir: proj.dir } },
      h.home, h.claude,
    );
    assert.match(out, /milestone complete/);
  } finally { h.cleanup(); proj.cleanup(); }
});

test('monorepo fail-open: invalid JSON stdin yields empty output, no crash', () => {
  const h = makeStatusHome();
  try {
    const r = runSL('statusline-monorepo.js', {
      home: h.home, stdin: '{bad json',
      env: { CLAUDE_CONFIG_DIR: h.claude },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'render() silently bails on bad input');
  } finally { h.cleanup(); }
});

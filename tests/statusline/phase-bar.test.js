'use strict';
// phase-bar.js — the line-2 renderer. Priority: (1) semantic phase-state ->
// progress bar, (2) recent agent-spawns.log -> live "orchestrating" sweep,
// (3) context_window on stdin -> context gauge, else nothing. Each source lives
// under a fake HOME so the real machine is untouched. We strip ANSI and assert
// on the visible text.

const { test } = require('node:test');
const assert = require('node:assert');
const { runSL, stripAnsi, makeStatusHome } = require('./helper.js');

function render(h, stdin) {
  return stripAnsi(runSL('phase-bar.js', { home: h.home, stdin: stdin || '' }).stdout).trim();
}

// --- Case A: semantic phase bar from phase-state.json ---------------------

test('phase-bar renders code, desc, done/total and computed percent', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P2', desc: 'build api', done: 3, total: 5, started: Date.now() });
    const out = render(h, '{}');
    assert.match(out, /P2/);
    assert.match(out, /build api/);
    assert.match(out, /3\/5/);
    assert.match(out, /60%/, '3 of 5 -> 60 percent');
  } finally { h.cleanup(); }
});

test('phase-bar shows agents and step extras when present', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P1', desc: 'x', done: 1, total: 2, started: Date.now(), agents: 3, step: 'wiring routes' });
    const out = render(h, '{}');
    assert.match(out, /3 agents/);
    assert.match(out, /wiring routes/);
  } finally { h.cleanup(); }
});

test('phase-bar uses singular "agent" for a count of 1', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P1', desc: 'x', done: 0, total: 2, started: Date.now(), agents: 1 });
    const out = render(h, '{}');
    assert.match(out, /1 agent\b/);
    assert.doesNotMatch(out, /1 agents/);
  } finally { h.cleanup(); }
});

test('phase-bar truncates an over-long desc to 32 chars with ellipsis', () => {
  const h = makeStatusHome();
  try {
    const longDesc = 'x'.repeat(50);
    h.writePhaseState({ code: 'P1', desc: longDesc, done: 1, total: 2, started: Date.now() });
    const out = render(h, '{}');
    assert.match(out, /x{31}\.\.\./, '31 chars + ellipsis');
    assert.doesNotMatch(out, /x{33}/, 'never 33 raw chars');
  } finally { h.cleanup(); }
});

test('phase-bar strips ANSI/control injection from desc (safeLabel)', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P1', desc: 'safe\x1b[31mRED\x07', done: 1, total: 2, started: Date.now() });
    const out = render(h, '{}');
    assert.match(out, /safeRED/, 'control chars removed, visible text preserved');
    // The injected SGR (\x1b[31m) must not appear in the raw (un-stripped) output.
    const raw = runSL('phase-bar.js', { home: h.home, stdin: '{}' }).stdout;
    assert.ok(!raw.includes('safe\x1b[31m'), 'injected escape sequence is gone from raw output');
  } finally { h.cleanup(); }
});

test('phase-bar returns nothing when state is missing required fields', () => {
  const h = makeStatusHome();
  try {
    // total <= 0 is invalid -> phaseBarLine returns null, no context on stdin -> empty.
    h.writePhaseState({ code: 'P1', desc: 'x', done: 0, total: 0, started: Date.now() });
    const out = render(h, '{}');
    assert.strictEqual(out, '', 'invalid phase state renders no line');
  } finally { h.cleanup(); }
});

test('phase-bar treats a stale (old-mtime) state file as absent', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P1', desc: 'old', done: 1, total: 2, started: Date.now() });
    h.agePhaseState(40 * 60); // 40 minutes old > STALE_MS (30 min)
    const out = render(h, '{}'); // no context on stdin -> falls through to empty
    assert.strictEqual(out, '', 'stale phase state is ignored');
  } finally { h.cleanup(); }
});

// --- Case A2: live activity from agent-spawns.log -------------------------

test('phase-bar shows live "orchestrating" with a recent-spawn count', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    h.writeSpawnLog([now, now - 1000, now - 5000]); // all within the 2-min window
    const out = render(h, '{}');
    assert.match(out, /orchestrating/);
    assert.match(out, /3 agents active/);
  } finally { h.cleanup(); }
});

test('phase-bar ignores spawn-log entries older than the 2-min activity window', () => {
  const h = makeStatusHome();
  try {
    const old = Date.now() - 5 * 60 * 1000; // 5 min ago
    h.writeSpawnLog([old, old - 1000]);
    const out = render(h, '{}');
    assert.strictEqual(out, '', 'no recent spawns -> no activity line, no context -> empty');
  } finally { h.cleanup(); }
});

// --- Case B: context-window gauge from stdin ------------------------------

test('phase-bar renders the context gauge from used_percentage + token counts', () => {
  const h = makeStatusHome();
  try {
    const out = render(h, '{"context_window":{"used_percentage":56,"used_tokens":128000,"max_tokens":230000}}');
    assert.match(out, /56% context/);
    assert.match(out, /128k\/230k tokens/);
  } finally { h.cleanup(); }
});

test('phase-bar derives context percent from remaining_percentage', () => {
  const h = makeStatusHome();
  try {
    const out = render(h, '{"context_window":{"remaining_percentage":75}}');
    assert.match(out, /25% context/, '100 - 75 = 25');
  } finally { h.cleanup(); }
});

test('phase-bar phase state takes priority over a context_window on stdin', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState({ code: 'P9', desc: 'priority', done: 1, total: 2, started: Date.now() });
    const out = render(h, '{"context_window":{"used_percentage":90}}');
    assert.match(out, /P9/, 'phase bar wins');
    assert.doesNotMatch(out, /context/, 'context gauge suppressed when a phase is active');
  } finally { h.cleanup(); }
});

// --- Fail-open --------------------------------------------------------------

test('phase-bar prints nothing and exits 0 on empty stdin with no state', () => {
  const h = makeStatusHome();
  try {
    const r = runSL('phase-bar.js', { home: h.home, stdin: '' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('phase-bar fail-open: malformed phase-state JSON yields no phase line', () => {
  const h = makeStatusHome();
  try {
    h.writePhaseState('{not valid json');
    const out = render(h, '{}');
    assert.strictEqual(out, '', 'unparseable state falls through, no crash');
  } finally { h.cleanup(); }
});

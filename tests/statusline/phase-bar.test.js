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

test('phase-bar shows live "orchestrating" with a recent-spawn count (own session only)', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    h.writeSpawnLog([[now, 'sessA'], [now - 1000, 'sessA'], [now - 5000, 'sessA']]);
    const out = render(h, '{"session_id":"sessA"}');
    assert.match(out, /orchestrating/);
    assert.match(out, /3 agents active/);
  } finally { h.cleanup(); }
});

test('phase-bar ignores spawn-log entries older than the 2-min activity window', () => {
  const h = makeStatusHome();
  try {
    const old = Date.now() - 5 * 60 * 1000; // 5 min ago
    h.writeSpawnLog([[old, 'sessA'], [old - 1000, 'sessA']]);
    const out = render(h, '{"session_id":"sessA"}');
    assert.strictEqual(out, '', 'no recent spawns -> no activity line, no context -> empty');
  } finally { h.cleanup(); }
});

// --- Case A2: PER-SESSION isolation (no cross-session/cross-project bleed) --

test('phase-bar counts ONLY the current session\'s spawns, not another session\'s', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    // sessB has a busy swarm; sessA has 2 recent spawns. Rendering for sessA must
    // see exactly 2 — never sessB's count (the cross-session bleed bug).
    h.writeSpawnLog([
      [now, 'sessA'], [now - 1000, 'sessA'],
      [now, 'sessB'], [now - 500, 'sessB'], [now - 800, 'sessB'], [now - 900, 'sessB'],
    ]);
    const out = render(h, '{"session_id":"sessA"}');
    assert.match(out, /2 agents active/, 'sessA sees only its own 2 spawns');
    assert.doesNotMatch(out, /4 agents/, 'sessB count must not bleed in');
  } finally { h.cleanup(); }
});

test('phase-bar: session B sees its own swarm independently', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    h.writeSpawnLog([
      [now, 'sessA'], [now - 1000, 'sessA'],
      [now, 'sessB'], [now - 500, 'sessB'], [now - 800, 'sessB'], [now - 900, 'sessB'],
    ]);
    const out = render(h, '{"session_id":"sessB"}');
    assert.match(out, /4 agents active/, 'sessB sees only its own 4 spawns');
  } finally { h.cleanup(); }
});

test('phase-bar ignores LEGACY untagged spawn lines (no bleed, they age out)', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    // Bare timestamps (old format) belong to no session -> never counted.
    h.writeSpawnLog([now, now - 1000, now - 2000]);
    const out = render(h, '{"session_id":"sessA"}');
    assert.strictEqual(out, '', 'legacy untagged lines are not attributed to any session');
  } finally { h.cleanup(); }
});

test('phase-bar falls back to cwd-hash when no session_id is present', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    const crypto = require('node:crypto');
    const cwd = '/some/project/path';
    const tag = 'cwd-' + crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
    h.writeSpawnLog([[now, tag], [now - 1000, tag]]);
    const out = render(h, JSON.stringify({ cwd }));
    assert.match(out, /2 agents active/, 'cwd-hash identity matches the tracker tag');
  } finally { h.cleanup(); }
});

test('phase-bar renders NO activity line when session identity is unavailable', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    h.writeSpawnLog([[now, 'sessA'], [now, 'sessB']]);
    // stdin has neither session_id nor cwd -> no identity -> safer to show nothing.
    const out = render(h, '{}');
    assert.strictEqual(out, '', 'no identity -> no (possibly-wrong) activity count');
  } finally { h.cleanup(); }
});

test('phase-bar tolerates a malformed spawn-log line (fail-open count)', () => {
  const h = makeStatusHome();
  try {
    const now = Date.now();
    h.writeSpawnLog(['garbage-no-number', `${now} sessA`, 'sessA-only-no-ts']);
    const out = render(h, '{"session_id":"sessA"}');
    assert.match(out, /1 agent active/, 'only the one valid sessA line counts');
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

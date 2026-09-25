'use strict';
// Post-handover new-work gate (hooks/auto-handover.js + hooks/lib/auto-handover-gate.js):
// once context is over the auto-handover threshold AND this session's
// handover file has been written, every new prompt carries a concise
// directive (judge size first; > budget -> offer park-or-proceed), and a
// one-shot measured backstop fires when usage grows more than gateBudgetPct
// points past the pct recorded when the handover was first seen.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'auto-handover.js';
const ENV = { ANTIHALL_EMIT_DEDUPE: '0', ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };
const SID = 'gate-s1';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function setPct(h, pct) {
  const p = path.join(h.home, 'transcript.jsonl');
  fs.writeFileSync(p, JSON.stringify({
    type: 'assistant', isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.round((pct / 100) * 200000) } },
  }) + '\n', 'utf8');
  return p;
}

function localDate() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

// writeHandover(cwd, name, offsetMs) — the file the handover skill writes.
function writeHandover(cwd, name, offsetMs) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', localDate(), SID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name || 'HANDOVER.md');
  fs.writeFileSync(p, '# handover\n', 'utf8');
  const t = (Date.now() + (offsetMs || 1000)) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

function setup() {
  const h = makeHome();
  const cwd = path.join(h.home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const prompt = (pct, extra) => testHook(HOOK, Object.assign({
    hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'build a whole new feature', cwd,
    transcript_path: setPct(h, pct),
  }, extra || {}), { home: h.home, env: ENV, expectJson: true });
  const latch = () => {
    try { return JSON.parse(fs.readFileSync(path.join(h.home, '.anti-hall', 'auto-handover', SID + '.json'), 'utf8')); } catch (_) { return {}; }
  };
  return { h, cwd, prompt, latch };
}

const GATE_RE = /POST-HANDOVER NEW-WORK GATE/;
const BACKSTOP_RE = /POST-HANDOVER BUDGET EXCEEDED/;

test('gate: off below the threshold, even with a handover on disk', () => {
  const s = setup();
  try {
    writeHandover(s.cwd);
    const r = s.prompt(60);
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(ctx(r), GATE_RE);
  } finally { s.h.cleanup(); }
});

test('gate: off when over threshold but no handover has been written yet', () => {
  const s = setup();
  try {
    const r1 = s.prompt(86);
    assert.match(ctx(r1), /AUTO-HANDOVER REQUIRED/);
    assert.doesNotMatch(ctx(r1), GATE_RE);
    const r2 = s.prompt(87);
    assert.doesNotMatch(ctx(r2), GATE_RE, 'no handover file -> no gate: ' + ctx(r2));
  } finally { s.h.cleanup(); }
});

test('gate: a handover from BEFORE this arm fired does not arm the gate', () => {
  const s = setup();
  try {
    writeHandover(s.cwd, 'HANDOVER.md', -60 * 60 * 1000); // an hour-old handover
    s.prompt(86);
    const r = s.prompt(87);
    assert.doesNotMatch(ctx(r), GATE_RE, ctx(r));
  } finally { s.h.cleanup(); }
});

test('gate: on after the handover is written — directive + recorded baseline pct', () => {
  const s = setup();
  try {
    s.prompt(86);
    writeHandover(s.cwd);
    const r = s.prompt(87);
    const t = ctx(r);
    assert.match(t, GATE_RE);
    assert.match(t, /AskUserQuestion/);
    assert.match(t, /BEFORE/);
    assert.match(t, /\(a\)/);
    assert.match(t, /\(b\)/);
    assert.match(t, /insist/i);
    assert.match(t, /DevSwarm workspace/);
    assert.match(t, /5%/);
    assert.ok(Math.round(s.latch().handoverPct) === 87, JSON.stringify(s.latch()));
    // still armed on the next prompt
    assert.match(ctx(s.prompt(88)), GATE_RE);
  } finally { s.h.cleanup(); }
});

test('gate: Codex payload gets platform wording (no AskUserQuestion, /new)', () => {
  const s = setup();
  try {
    s.prompt(86, { turn_id: 't1' });
    writeHandover(s.cwd);
    const t = ctx(s.prompt(87, { turn_id: 't2' }));
    assert.match(t, GATE_RE);
    assert.doesNotMatch(t, /AskUserQuestion/);
    assert.match(t, /\/new/);
  } finally { s.h.cleanup(); }
});

test('gate: autoHandover.gateNewWork=false turns it off (and suppresses the backstop)', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.h.home, '.anti-hall', 'settings.json'),
      JSON.stringify({ autoHandover: { gateNewWork: false } }), 'utf8');
    s.prompt(86);
    writeHandover(s.cwd);
    const r = s.prompt(87);
    assert.doesNotMatch(ctx(r), GATE_RE);
    const r2 = s.prompt(95);
    assert.doesNotMatch(ctx(r2), BACKSTOP_RE);
  } finally { s.h.cleanup(); }
});

test('backstop: fires once past the budget, is capped, and re-baselines on a refreshed handover', () => {
  const s = setup();
  try {
    s.prompt(86);
    writeHandover(s.cwd);
    const base = s.prompt(87); // baseline recorded at 87
    assert.doesNotMatch(ctx(base), BACKSTOP_RE);
    const under = s.prompt(91); // +4 < 5
    assert.doesNotMatch(ctx(under), BACKSTOP_RE);
    const over = s.prompt(93); // +6 >= 5
    assert.match(ctx(over), BACKSTOP_RE);
    assert.match(ctx(over), /refresh/i);
    assert.match(ctx(over), /park/i);
    assert.doesNotMatch(ctx(over), /CONTEXT NOW ~/, 'milestone nag folded into the backstop, not doubled');
    const again = s.prompt(97);
    assert.doesNotMatch(ctx(again), BACKSTOP_RE, 'capped: once per handover baseline');
    assert.match(ctx(again), GATE_RE, 'gate directive itself stays on');
    // refresh the handover -> new baseline, backstop re-armed
    writeHandover(s.cwd, 'HANDOVER-2.md', 5000);
    const rebased = s.prompt(97);
    assert.doesNotMatch(ctx(rebased), BACKSTOP_RE);
    assert.strictEqual(Math.round(s.latch().handoverPct), 97);
  } finally { s.h.cleanup(); }
});

test('backstop: honors a custom gateBudgetPct', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.h.home, '.anti-hall', 'settings.json'),
      JSON.stringify({ autoHandover: { gateBudgetPct: 10 } }), 'utf8');
    s.prompt(86);
    writeHandover(s.cwd);
    s.prompt(87);
    assert.doesNotMatch(ctx(s.prompt(93)), BACKSTOP_RE);
    assert.doesNotMatch(ctx(s.prompt(96)), BACKSTOP_RE); // +9 < 10
    assert.match(ctx(s.prompt(98)), BACKSTOP_RE);
  } finally { s.h.cleanup(); }
});

test('gate re-arms (clears) once usage drops back below the threshold', () => {
  const s = setup();
  try {
    s.prompt(86);
    writeHandover(s.cwd);
    assert.match(ctx(s.prompt(87)), GATE_RE);
    assert.doesNotMatch(ctx(s.prompt(20)), GATE_RE); // after /compact
    assert.strictEqual(s.latch().handoverPct, undefined);
  } finally { s.h.cleanup(); }
});

test('jev: postHandoverGate is consulted in shadow only — a decision row lands, the text is unchanged', () => {
  const s = setup();
  try {
    s.prompt(86);
    writeHandover(s.cwd);
    const t = ctx(s.prompt(87));
    assert.match(t, GATE_RE);
    const log = fs.readFileSync(path.join(s.h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8');
    const rows = log.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.id === 'postHandoverGate');
    assert.strictEqual(rows.length, 1, log);
  } finally { s.h.cleanup(); }
});

test('jev: postHandoverGate defaults to shadow (schema + getMode)', () => {
  const schema = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
  const e = schema.findSetting('jevIntegrations', 'postHandoverGate');
  assert.ok(e, 'schema row missing');
  assert.strictEqual(e.default, 'shadow');
  assert.deepStrictEqual(e.values, ['on', 'shadow', 'off']);
  const h = makeHome();
  try {
    const { getMode } = require('../../plugins/anti-hall/hooks/lib/jev-assist.js');
    assert.strictEqual(getMode('postHandoverGate', { enabled: true }, h.home), 'shadow');
  } finally { h.cleanup(); }
});

test('settings: gateNewWork / gateBudgetPct schema, defaults, validation and resolveEffective', () => {
  const schema = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
  const g = schema.findSetting('autoHandover', 'gateNewWork');
  const b = schema.findSetting('autoHandover', 'gateBudgetPct');
  assert.deepStrictEqual([g.type, g.default], ['boolean', true]);
  assert.deepStrictEqual([b.type, b.default, b.min, b.max], ['number', 5, 1, 50]);
  const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
  const cfg = require('../../plugins/anti-hall/hooks/lib/auto-handover-config.js');
  const h = makeHome();
  try {
    let eff = cfg.resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(eff.gateNewWork, true);
    assert.strictEqual(eff.gateBudgetPct, 5);
    assert.strictEqual(settings.set('autoHandover', 'gateBudgetPct', 0, { home: h.home }).ok, false);
    assert.strictEqual(settings.set('autoHandover', 'gateBudgetPct', 51, { home: h.home }).ok, false);
    assert.strictEqual(settings.set('autoHandover', 'gateBudgetPct', 12, { home: h.home }).ok, true);
    assert.strictEqual(settings.set('autoHandover', 'gateNewWork', 'maybe', { home: h.home }).ok, false);
    assert.strictEqual(settings.set('autoHandover', 'gateNewWork', false, { home: h.home }).ok, true);
    eff = cfg.resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(eff.gateBudgetPct, 12);
    assert.strictEqual(eff.gateNewWork, false);
    // an out-of-range value hand-written into settings.json is CLAMPED to the
    // range (settings.js coerceValue's min/max contract), never used raw
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify({ autoHandover: { gateBudgetPct: 99 } }));
    assert.strictEqual(cfg.resolveEffective({ home: h.home, env: {} }).gateBudgetPct, 50);
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify({ autoHandover: { gateBudgetPct: 'lots' } }));
    assert.strictEqual(cfg.resolveEffective({ home: h.home, env: {} }).gateBudgetPct, 5);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// PERFORMANCE: noteHandover() runs on EVERY prompt once the gate's fire arm
// is set. It must look up THIS session's own handover only, bounded to
// <date>/<sessionId>/ -- never a full recursive walk of every OTHER
// session's directory under .anti-hall/handovers (hooks/lib/handover-find.js's
// findNewestHandoverForSession, used by auto-handover-gate.js's
// sessionHandover()).
// ---------------------------------------------------------------------------

test('sessionHandover(): bounded to THIS session only -- never readdirs another session\'s directory, on a repo with many other sessions/dates', () => {
  const gate = require('../../plugins/anti-hall/hooks/lib/auto-handover-gate.js');
  const h = makeHome();
  const cwd = path.join(h.home, 'proj2');
  fs.mkdirSync(cwd, { recursive: true });
  const targetSid = 'target-session';
  const otherSids = ['other-a', 'other-b', 'other-c'];
  const dates = ['2026-09-20', '2026-09-21', '2026-09-22'];

  // Many OTHER sessions' handover dirs, across several dates -- these must
  // never be walked by a session-scoped lookup.
  for (const date of dates) {
    for (const sid of otherSids) {
      const dir = path.join(cwd, '.anti-hall', 'handovers', date, sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'HANDOVER.md'), '# other\n', 'utf8');
    }
  }
  // THIS session's own handover, on the most recent date.
  const ownDir = path.join(cwd, '.anti-hall', 'handovers', dates[dates.length - 1], targetSid);
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(path.join(ownDir, 'HANDOVER.md'), '# mine\n', 'utf8');

  const realReaddirSync = fs.readdirSync;
  const readdirPaths = [];
  fs.readdirSync = (...args) => {
    readdirPaths.push(String(args[0]));
    return realReaddirSync.apply(fs, args);
  };
  let result;
  try {
    result = gate.sessionHandover({ cwd, session_id: targetSid });
  } finally {
    fs.readdirSync = realReaddirSync;
    h.cleanup();
  }

  assert.ok(result, 'must still find this session\'s own handover');
  assert.match(result.filePath, /target-session/);

  for (const p of readdirPaths) {
    for (const sid of otherSids) {
      assert.ok(!p.endsWith(path.sep + sid) && !p.includes(path.sep + sid + path.sep),
        'must never readdir another session\'s directory: ' + p);
    }
  }
  // Sanity: it DID look inside this session's own directories (not a vacuous
  // pass from finding nothing to walk at all).
  assert.ok(readdirPaths.some((p) => p.endsWith(path.sep + targetSid)),
    'must have looked inside the target session\'s own directory: ' + JSON.stringify(readdirPaths));
});

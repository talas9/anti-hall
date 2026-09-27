'use strict';
// compact-advice-guard.js (Stop) + compact-declaration-guard.js (PreToolUse):
// don't recommend /compact at low context or right after a compact, and don't
// start new work in the same turn after declaring SAFE TO COMPACT.
// Synthetic transcripts in isolated tmp HOMEs only.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { sessionTag, writeLatch } = require('../../plugins/anti-hall/hooks/lib/auto-handover-state.js');
const advice = require('../../plugins/anti-hall/hooks/lib/compact-advice.js');

const STOP = 'compact-advice-guard.js';
const PRE = 'compact-declaration-guard.js';
const SESSION = 'cadv-1';
const ENV = { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };
const T0 = Date.parse('2026-09-27T10:00:00.000Z');
let tick = 0;
const ts = () => new Date(T0 + (tick++) * 1000).toISOString();

const user = (text) => ({ type: 'user', isSidechain: false, timestamp: ts(), message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', isSidechain: false, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const toolUse = (name) => ({ type: 'assistant', isSidechain: false, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] } });
function say(text, pct) {
  const m = { type: 'assistant', isSidechain: false, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text }] } };
  if (pct != null) m.message.usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.round(pct * 2000) };
  return m;
}
const boundary = (trigger) => ({ type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: ts(), content: 'Conversation compacted', compactMetadata: { trigger: trigger || 'manual' } });
const summary = () => ({ type: 'user', isSidechain: false, isCompactSummary: true, timestamp: ts(), message: { role: 'user', content: 'This session is being continued... ✅ SAFE TO COMPACT NOW' } });
const compactCmd = () => user('<command-name>/compact</command-name>\n<command-message>compact</command-message>');

function stopPayload(tp) { return { hook_event_name: 'Stop', session_id: SESSION, cwd: process.cwd(), transcript_path: tp }; }
function prePayload(tp, tool_name, tool_input) { return { hook_event_name: 'PreToolUse', session_id: SESSION, cwd: process.cwd(), transcript_path: tp, tool_name, tool_input: tool_input || {} }; }
const blocked = (r) => (r.json && r.json.decision === 'block' ? r.json.reason : null);

function withHome(fn) {
  const h = makeHome();
  try { return fn(h); } finally { h.cleanup(); }
}

// ------------------------------------------------------------------ lib unit
test('findAdvice: own recommendations match; negated / quoted / retracted do not', () => {
  assert.ok(advice.findAdvice('✅ **SAFE TO COMPACT NOW**').length);
  assert.ok(advice.findAdvice('🟢 **GOOD POINT TO /compact NOW**: handover saved').length);
  assert.ok(advice.findAdvice('Run `/compact focus: finish the release`').length);
  assert.ok(advice.findAdvice('Next:\n`/compact focus: phase 2`').length);
  assert.strictEqual(advice.findAdvice('⏳ **NOT SAFE to compact yet** — waiting on agent X').length, 0);
  assert.strictEqual(advice.findAdvice('no need to /compact now; continue working, or /compact / restart when you choose').length, 0);
  assert.strictEqual(advice.findAdvice('You typed "/compact focus: foo" earlier — noted.').length, 0);
  assert.strictEqual(advice.findAdvice('> /compact focus: foo').length, 0);
  assert.strictEqual(advice.activeDeclaration('✅ SAFE TO COMPACT NOW\n\nRETRACT SAFE TO COMPACT — context is 20%'), null);
  assert.ok(advice.activeDeclaration('RETRACT SAFE TO COMPACT\n\nlater: ✅ SAFE TO COMPACT NOW'));
});

test('readTurn: task-notifications count toward turnsSinceCompact but do not reset the turn', () => {
  const lines = [user('go'), boundary('auto'), summary(), say('a'), user('<task-notification>x</task-notification>'), say('b'),
    user('<task-notification>y</task-notification>'), say('c')].map((m) => JSON.stringify(m));
  const r = advice.readTurn(lines);
  assert.strictEqual(r.turnsSinceCompact, 2);
  assert.strictEqual(r.turnText, 'a\nb\nc');
  assert.strictEqual(r.finalText, 'c');
});

// ------------------------------------------------------------ (a) Stop check
test('Stop: SAFE right after a compact boundary -> block (names turns + pct)', () => withHome((h) => {
  const tp = h.writeTranscript([
    user('work'), say('done', 80), boundary('manual'), summary(), compactCmd(),
    user('next thing'), say('ok', 12), user('and another'), say('ok', 13),
    user('status?'), say('No background agents running.\n\n✅ SAFE TO COMPACT NOW\n\n`/compact focus: release`', 14),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  const reason = blocked(r);
  assert.ok(reason, 'expected a block: ' + r.stdout);
  assert.match(reason, /context is 14%/);
  assert.match(reason, /a compact happened 3 turns ago/);
  // once per declaration: the identical final message is not blocked again
  const r2 = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r2), null);
  // stop_hook_active never re-blocks
  const r3 = testHook(STOP, Object.assign(stopPayload(tp), { stop_hook_active: true }), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r3), null);
}));

test('Stop: SAFE at 90% after the threshold directive fired -> allow', () => withHome((h) => {
  writeLatch(h.home, sessionTag({ session_id: SESSION }), { fired: true, firedAt: Date.now(), firedPct: 86, lastNagPct: 86, lastNagAt: Date.now() });
  const tp = h.writeTranscript([
    user('keep going'), say('working', 86), toolUse('Write'), toolResult(),
    say('🟢 **HANDOVER COMPLETE — GOOD POINT TO /compact NOW**\n\n✅ SAFE TO COMPACT NOW', 90),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r), null, r.stdout);
}));

test('Stop: SAFE at 20% with no compact and no threshold fire -> block', () => withHome((h) => {
  const tp = h.writeTranscript([user('wrap up'), say('All agents finished.\n\n✅ SAFE TO COMPACT NOW', 20)]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  const reason = blocked(r);
  assert.ok(reason, r.stdout);
  assert.match(reason, /context is 20% \(auto-handover threshold 85%\)/);
  assert.doesNotMatch(reason, /compact happened/);
}));

test('Stop: a /compact line quoted from the user -> allow', () => withHome((h) => {
  const tp = h.writeTranscript([
    user('/compact focus: foo — should I run this?'),
    say('You wrote "/compact focus: foo". Context is only 20%, so there is no need to compact yet.', 20),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r), null, r.stdout);
}));

test('Stop: unknown context % -> only the recent-compact rule applies', () => withHome((h) => {
  // no usage anywhere -> getContextPct() is null
  const noCompact = h.writeTranscript([user('wrap up'), say('✅ SAFE TO COMPACT NOW')]);
  assert.strictEqual(blocked(testHook(STOP, stopPayload(noCompact), { home: h.home, env: ENV })), null);
  const p2 = path.join(h.home, 't2.jsonl');
  fs.writeFileSync(p2, [boundary('auto'), summary(), user('go on'), say('✅ SAFE TO COMPACT NOW')].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const reason = blocked(testHook(STOP, stopPayload(p2), { home: h.home, env: ENV }));
  assert.ok(reason);
  assert.match(reason, /context % is unknown, and a compact happened 1 turn ago/);
}));

test('Stop: switch off -> silent on the same blocking fixture', () => withHome((h) => {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactAdviceGuard: false } }));
  const tp = h.writeTranscript([user('wrap up'), say('✅ SAFE TO COMPACT NOW', 20)]);
  assert.strictEqual(blocked(testHook(STOP, stopPayload(tp), { home: h.home, env: ENV })), null);
}));

test('Stop: recentTurns=0 disables the recent-compact rule', () => withHome((h) => {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactAdviceRecentTurns: 0 } }));
  const tp = h.writeTranscript([boundary('auto'), summary(), user('go'), say('✅ SAFE TO COMPACT NOW', 88)]);
  assert.strictEqual(blocked(testHook(STOP, stopPayload(tp), { home: h.home, env: ENV })), null);
}));

// ---------------------------------------------------- (b) PreToolUse check
const safeTurn = () => [user('finish up'), say('Everything is idle.\n\n✅ SAFE TO COMPACT NOW', 88)];

test('PreToolUse: Agent spawn after SAFE in the same turn -> block', () => withHome((h) => {
  const tp = h.writeTranscript(safeTurn());
  const reason = blocked(testHook(PRE, prePayload(tp, 'Agent', { prompt: 'x', run_in_background: true }), { home: h.home }));
  assert.ok(reason);
  assert.match(reason, /you declared SAFE TO COMPACT this turn/);
}));

test('PreToolUse: state-changing Bash after SAFE -> block; read-only Bash -> allow', () => withHome((h) => {
  const tp = h.writeTranscript(safeTurn());
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git merge feature/x' }), { home: h.home })));
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git status --short' }), { home: h.home })), null);
}));

test('PreToolUse: Read after SAFE -> allow', () => withHome((h) => {
  const tp = h.writeTranscript(safeTurn());
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Read', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: after the next user message -> allow', () => withHome((h) => {
  const tp = h.writeTranscript([...safeTurn(), user('ok, actually do one more thing first')]);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Write', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: a task-notification does NOT reset the turn', () => withHome((h) => {
  const tp = h.writeTranscript([...safeTurn(), user('<task-notification><status>completed</status></task-notification>')]);
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Edit', { file_path: '/x' }), { home: h.home })));
}));

test('PreToolUse: a retraction line -> allow', () => withHome((h) => {
  const tp = h.writeTranscript([...safeTurn(), say('RETRACT SAFE TO COMPACT — one more fix is needed; I will refresh the handover after.')]);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Edit', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: switch off -> silent on the same blocking fixture', () => withHome((h) => {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactDeclarationGuard: false } }));
  const tp = h.writeTranscript(safeTurn());
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Agent', {}), { home: h.home })), null);
}));

test('PreToolUse: Codex rollout shape (Bash) -> block after SAFE, allow after a new user_message', () => withHome((h) => {
  const ev = (payload) => ({ timestamp: ts(), type: 'event_msg', payload });
  const msg = (text) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  const tp = h.writeTranscript([ev({ type: 'user_message', message: 'wrap up' }), msg('✅ SAFE TO COMPACT NOW')]);
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git commit -m x' }), { home: h.home })));
  fs.appendFileSync(tp, JSON.stringify(ev({ type: 'user_message', message: 'go on' })) + '\n');
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git commit -m x' }), { home: h.home })), null);
}));

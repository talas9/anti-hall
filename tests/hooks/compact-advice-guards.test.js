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

// compact-declaration-guard shipped opt-in in 0.116.0 and was re-enabled by
// default in 0.117.0 (see settings-schema.js). enableDeclGuard is kept for
// tests that want to be explicit about the setting regardless of default.
function enableDeclGuard(h) {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactDeclarationGuard: true } }));
}

// ------------------------------------------------------------------ lib unit
test('findAdvice: own recommendations match; negated / quoted / retracted do not', () => {
  assert.ok(advice.findAdvice('✅ **SAFE TO COMPACT NOW**').length);
  assert.ok(advice.findAdvice('🟢 **GOOD POINT TO /compact NOW**: handover saved').length);
  assert.ok(advice.findAdvice('Run `/compact focus: finish the release`').length);
  assert.ok(advice.findAdvice('Next:\n`/compact focus: phase 2`').length);
  assert.ok(advice.findAdvice('🟢 **HANDOVER COMPLETE — GOOD POINT FOR /compact OR /new NOW**').length);
  assert.ok(advice.findAdvice('✅ Safe for a context reset now.').length);
  assert.strictEqual(advice.findAdvice('⏳ NOT SAFE for a context reset yet — waiting on: agent X').length, 0);
  assert.strictEqual(advice.findAdvice('A good time for new tests.').length, 0);
  assert.strictEqual(advice.activeDeclaration('Safe for a context reset now.\nRETRACT SAFE FOR A CONTEXT RESET — more work needed'), null);
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

test('PreToolUse: default on (0.117.0) -> blocks the same fixture with no explicit opt-in', () => withHome((h) => {
  const tp = h.writeTranscript(safeTurn());
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Agent', { prompt: 'x', run_in_background: true }), { home: h.home })));
}));

test('PreToolUse: Agent spawn after SAFE in the same turn -> block (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript(safeTurn());
  const reason = blocked(testHook(PRE, prePayload(tp, 'Agent', { prompt: 'x', run_in_background: true }), { home: h.home }));
  assert.ok(reason);
  assert.match(reason, /you declared SAFE TO COMPACT this turn/);
}));

test('PreToolUse: state-changing Bash after SAFE -> block; read-only Bash -> allow (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript(safeTurn());
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git merge feature/x' }), { home: h.home })));
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git status --short' }), { home: h.home })), null);
}));

test('PreToolUse: Read after SAFE -> allow (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript(safeTurn());
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Read', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: after the next user message -> allow (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript([...safeTurn(), user('ok, actually do one more thing first')]);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Write', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: a task-notification does NOT reset the turn (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript([...safeTurn(), user('<task-notification><status>completed</status></task-notification>')]);
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Edit', { file_path: '/x' }), { home: h.home })));
}));

test('PreToolUse: a retraction line -> allow (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript([...safeTurn(), say('RETRACT SAFE TO COMPACT — one more fix is needed; I will refresh the handover after.')]);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Edit', { file_path: '/x' }), { home: h.home })), null);
}));

test('PreToolUse: switch explicitly off -> silent on the same blocking fixture', () => withHome((h) => {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactDeclarationGuard: false } }));
  const tp = h.writeTranscript(safeTurn());
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Agent', {}), { home: h.home })), null);
}));

test('PreToolUse: Codex rollout shape (Bash) -> block after SAFE, allow after a new user_message (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const ev = (payload) => ({ timestamp: ts(), type: 'event_msg', payload });
  const msg = (text) => ({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  const tp = h.writeTranscript([ev({ type: 'user_message', message: 'wrap up' }), msg('✅ SAFE TO COMPACT NOW')]);
  assert.ok(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git commit -m x' }), { home: h.home })));
  fs.appendFileSync(tp, JSON.stringify(ev({ type: 'user_message', message: 'go on' })) + '\n');
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'git commit -m x' }), { home: h.home })), null);
}));

// ------------------------------------------------------- R1-6: block via exit 2
test('PreToolUse: block matches sibling PreToolUse guards -> exit 2, not 0 (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const tp = h.writeTranscript(safeTurn());
  const r = testHook(PRE, prePayload(tp, 'Agent', { prompt: 'x', run_in_background: true }), { home: h.home });
  assert.ok(blocked(r), r.stdout);
  assert.strictEqual(r.status, 2, 'compact-declaration-guard must exit 2 to block, like command-guard/edit-guard');
}));

// --------------------------------------------- R1-5: last_assistant_message
test('Stop: last_assistant_message (when present) is preferred over the transcript tail', () => withHome((h) => {
  // The transcript's own final text block is benign; the Stop payload's
  // last_assistant_message carries the actual declaration — must still block.
  const tp = h.writeTranscript([user('wrap up'), say('Everything looks fine, continuing.', 20)]);
  const payload = Object.assign(stopPayload(tp), { last_assistant_message: '✅ SAFE TO COMPACT NOW' });
  const reason = blocked(testHook(STOP, payload, { home: h.home, env: ENV }));
  assert.ok(reason, 'expected a block driven by last_assistant_message');
  assert.match(reason, /context is 20%/);
}));

test('Stop: empty/absent last_assistant_message falls back to the transcript tail (best-effort)', () => withHome((h) => {
  const tp = h.writeTranscript([user('wrap up'), say('✅ SAFE TO COMPACT NOW', 20)]);
  const payload = Object.assign(stopPayload(tp), { last_assistant_message: '' });
  assert.ok(blocked(testHook(STOP, payload, { home: h.home, env: ENV })), 'fallback to transcript must still catch the declaration');
}));

// --------------------------------------------------------------- A1-CA-1
test('findAdvice: A1-CA-1 — "safe to clear the cache" and a /compact-mentioning bullet/example do NOT count as declarations', () => {
  assert.strictEqual(advice.findAdvice('It should now be safe to clear the cache directory before the next run.').length, 0);
  assert.strictEqual(advice.findAdvice('- /compact clears the context automatically once triggered, for reference.').length, 0);
  assert.strictEqual(
    advice.findAdvice('Here is the syntax:\n```\n/compact focus: <topic>\n```\nThat is just documentation, not a recommendation.').length,
    0,
  );
});

test('findAdvice: A1-CA-1 — explicit declaration forms still match after tightening', () => {
  assert.ok(advice.findAdvice('safe to /clear now').length);
  assert.ok(advice.findAdvice('- /compact now').length);
  assert.ok(advice.findAdvice('run /compact').length);
});

// R2-2: a short leading interjection/adverb + comma still opens a genuine
// declaration ("Yes, safe to compact now.") - it must be detected, not
// silently dropped as an under-detection gap.
test('findAdvice: R2-2 — a comma-prefixed genuine declaration still counts', () => {
  assert.ok(advice.findAdvice('Yes, safe to compact now.').length);
  assert.ok(advice.findAdvice('Overall, safe to compact now.').length);
  assert.ok(advice.findAdvice('Great, safe to compact.').length);
});

// R2-2 companion: the comma allowance must NOT reintroduce round-1's false
// blocks — a comma before a conditional/negated clause still doesn't count.
test('findAdvice: R2-2 — the comma allowance does not reopen round-1 false-block classes', () => {
  assert.strictEqual(
    advice.findAdvice('Safe to compact, but first I need to write the progress file.').length,
    0,
  );
  assert.strictEqual(advice.findAdvice('Wait, not safe to compact yet.').length, 0);
  assert.strictEqual(advice.findAdvice('For instance, safe to compact examples vary in wording.').length, 0);
});

// ------------------------------------------------------------- R3A1 / #29
// The reviewer's false-positive probe (dl116/r4/c1/cdg-fp.js): 6 texts, only
// the last (an unambiguous ALL-CAPS declaration) is a real recommendation.
test('findAdvice: R3A1/#29 — a backtick-quoted mention of the declaration phrase does not count', () => {
  assert.strictEqual(
    advice.findAdvice('Reviewing: compact-declaration-guard blocks work after `SAFE TO COMPACT` is declared. Let me edit the test.').length,
    0
  );
});

test('findAdvice: R3A1/#29 — a single-quoted mention of the declaration phrase does not count', () => {
  assert.strictEqual(
    advice.findAdvice("The handover skill says 'SAFE TO COMPACT' must be last. Editing now.").length,
    0
  );
});

test('findAdvice: R3A1/#29 — a question sentence does not count', () => {
  assert.strictEqual(
    advice.findAdvice('Is it safe to compact now? No — two agents are still running, so I will keep going.').length,
    0
  );
});

test('findAdvice: R3A1/#29 — "far from safe to compact" is negated', () => {
  assert.strictEqual(advice.findAdvice('Context is at 20%, far from safe to compact. Continuing.').length, 0);
});

test('findAdvice: R3A1/#29 — a conditional "once ... it will be safe to compact; first ..." does not count', () => {
  assert.strictEqual(
    advice.findAdvice('Once this lands it will be safe to compact; first I need to write the progress file.').length,
    0
  );
});

test('findAdvice: R3A1/#29 — the real ALL-CAPS declaration still matches', () => {
  assert.ok(advice.findAdvice('SAFE TO COMPACT NOW.').length);
});

// ------------------------------------------------------------- round-1 F2/F3
// deadly-loop round-1 F2/A1-5/C1-3: activeDeclaration() false-blocked
// conditional/meta phrasing that only DESCRIBES a future or rule-governed
// declaration, not a present-tense recommendation.
test('findAdvice: round-1 F2 — conditional/meta phrasing does not count as a declaration', () => {
  assert.strictEqual(
    advice.findAdvice('Safe to compact, but first let me write the progress file.').length, 0
  );
  assert.strictEqual(
    advice.findAdvice('I will only say SAFE TO COMPACT after the handover file is written.').length, 0
  );
  assert.strictEqual(
    advice.findAdvice('The guard fires when I write SAFE TO COMPACT, so I will hold it until the end.').length, 0
  );
  assert.strictEqual(advice.findAdvice('When CI is green: safe to compact.').length, 0);
  assert.strictEqual(advice.findAdvice('The skill says to run /compact only after a handover.').length, 0);
  assert.strictEqual(advice.findAdvice('We are nowhere near a good point to /compact.').length, 0);
});

test('findAdvice: round-1 F2 — genuine declarations in the same shapes still match', () => {
  assert.ok(advice.findAdvice('✅ HANDOVER COMPLETE — SAFE TO COMPACT OR CLEAR NOW').length);
  assert.ok(advice.findAdvice('Safe to compact now.').length);
  assert.ok(advice.findAdvice('SAFE TO COMPACT\nsome trailer').length);
  assert.ok(advice.findAdvice('Run /compact now.').length);
});

// deadly-loop round-1 F3: a declaration at the start of its own line, whose
// preceding line does not end in sentence-terminal punctuation, must still
// be treated as positioned (a line start is a line start).
test('findAdvice: round-1 F3 — a declaration at the start of its own line (no terminal punctuation before it) matches', () => {
  assert.ok(advice.findAdvice('All agents finished\nSafe to compact now.').length);
  assert.ok(advice.findAdvice('All agents finished\n✅ Safe to compact now.').length);
});

// --------------------------------------------------------------- A1-CA-2
test('Stop: a tokens-latch (firedVia:"tokens") fired below the pct threshold may still declare SAFE', () => withHome((h) => {
  const firedAt = T0 - 100000; // safely before every transcript timestamp
  writeLatch(h.home, sessionTag({ session_id: SESSION }), {
    fired: true, firedAt, firedPct: 20, firedVia: 'tokens', lastNagPct: 20, lastNagAt: firedAt,
  });
  const tp = h.writeTranscript([
    user('keep going'), say('working', 20), toolUse('Write'), toolResult(),
    say('✅ SAFE TO COMPACT NOW', 20),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r), null, r.stdout);
}));

// R2-RV1-6: the Stop-time pause-nag writer records firedVia:'stop-tokens'.
test('Stop: a Stop-time tokens-latch (firedVia:"stop-tokens") fired below the pct threshold may still declare SAFE', () => withHome((h) => {
  const firedAt = T0 - 100000;
  writeLatch(h.home, sessionTag({ session_id: SESSION }), {
    fired: true, firedAt, firedPct: 20, firedVia: 'stop-tokens', lastNagPct: 20, lastNagAt: firedAt,
  });
  const tp = h.writeTranscript([
    user('keep going'), say('working', 20), toolUse('Write'), toolResult(),
    say('✅ SAFE TO COMPACT NOW', 20),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.strictEqual(blocked(r), null, r.stdout);
}));

test('Stop: the tokens-latch exception does not apply once a compact happened after the latch fired', () => withHome((h) => {
  const firedAt = T0 - 100000;
  writeLatch(h.home, sessionTag({ session_id: SESSION }), {
    fired: true, firedAt, firedPct: 20, firedVia: 'tokens', lastNagPct: 20, lastNagAt: firedAt,
  });
  const tp = h.writeTranscript([
    user('keep going'), say('working', 20), boundary('manual'), summary(), compactCmd(),
    user('more'), say('✅ SAFE TO COMPACT NOW', 20),
  ]);
  const r = testHook(STOP, stopPayload(tp), { home: h.home, env: ENV });
  assert.ok(blocked(r), 'a compact after the tokens-fire must still be blocked');
}));

// L18 (4): a free-form RETRACT line (not the canonical "RETRACT SAFE TO COMPACT")
// must clear the declaration in the same turn.
test('activeDeclaration: a line starting with RETRACT clears it, whatever follows; mid-sentence mention does not', () => {
  const D = 'This is a good point to compact.\n';
  assert.strictEqual(advice.activeDeclaration(D + 'RETRACT — not a good point to compact'), null);
  assert.strictEqual(advice.activeDeclaration(D + 'RETRACT: the compact recommendation, still working'), null);
  assert.strictEqual(advice.activeDeclaration(D + '**Retracting** that, more work remains'), null);
  assert.ok(advice.activeDeclaration(D + 'I will not retract anything here.'));
  assert.ok(advice.activeDeclaration('RETRACT — earlier\n' + D));
});

test('PreToolUse: a free-form RETRACT line in the same turn -> allow (explicit opt-in)', () => withHome((h) => {
  enableDeclGuard(h);
  const good = [user('finish up'), say('All idle. This is a good point to compact.', 88), say('RETRACT — not a good point to compact, one more fix first.')];
  const tp = h.writeTranscript(good);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Edit', { file_path: '/x' }), { home: h.home })), null);
  assert.strictEqual(blocked(testHook(PRE, prePayload(tp, 'Bash', { command: 'rm -f /x' }), { home: h.home })), null);
}));

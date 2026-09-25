'use strict';
// v0.108.0 contract 1 — auto-handover (hooks/auto-handover.js, UserPromptSubmit)
// + auto-handover-pause-nag.js (Stop). Settings: autoHandover.{enabled, pct=85,
// nag=true, nagStepPct=5, nagQuietMin=15}.
//
//   - Context % = main-thread (isSidechain !== true) usage over the context
//     window. Window: ANTIHALL_CONTEXT_WINDOW_TOKENS, else the statusline's
//     last-seen max_tokens for the session (sticky), else "inferred 1M" once
//     usage exceeds 200k, else UNKNOWN (200k assumed).
//   - Below pct => silent.
//   - Crossing pct with a KNOWN window, or crossing the OPT-IN absolute
//     maxTokens ceiling (default 0 = off; real token count, so
//     window-independent, when a user sets one) => the mandatory directive,
//     once per arm: write a handover unasked, tell
//     the user, urge /compact or /clear, explain the hallucination risk.
//   - Crossing with an UNKNOWN window => one soft advisory per arm, never the
//     mandatory directive (a 200k guess could be badly wrong on a 1M session).
//   - After the directive, a milestone nag at every +nagStepPct past the last
//     nag; dropping below pct re-arms.
//   - Stop side: if the directive has not gone out this arm and the agent is
//     over threshold at a Stop, the Stop hook delivers it (once, shared latch);
//     after that a pause nag at most once per nagQuietMin, no open task work.
//   - autoHandover.enabled=false silences it; ANTIHALL_AUTO_HANDOVER_PCT
//     overrides the threshold.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeHome, rm, runHook, writeJson, settingsPath, antiHallDir,
  mainAssistantUsageLine, sidechainAssistantUsageLine, writeTranscript,
} = require('./lib.js');

const HOOK = 'auto-handover.js';
const NAG_HOOK = 'auto-handover-pause-nag.js';
// A KNOWN 200k window (explicit override) — the mandatory-directive path.
const KNOWN_200K = { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };

const CONTEXT_WINDOW_200K = 200000;
const CONTEXT_WINDOW_1M = 1000000;

// tokensFor(pctOfWindow, window) -> an input_tokens value that lands at
// approximately pctOfWindow percent of the given context window.
function tokensFor(pctOfWindow, window) {
  return Math.round((pctOfWindow / 100) * window);
}

function payload(transcriptPath, extra) {
  return Object.assign({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-ah-1',
    transcript_path: transcriptPath,
    prompt: 'continue',
  }, extra || {});
}

function hasDirective(r) {
  return !!(r.json && r.json.hookSpecificOutput && typeof r.json.hookSpecificOutput.additionalContext === 'string' && r.json.hookSpecificOutput.additionalContext.length > 0);
}

test('below 85%: silent, no handover file written', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(50, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `should be silent below threshold; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('crossing 85%: directive fires exactly once — writes a handover file, explains context-bloat risk, urges /compact or /clear', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home, KNOWN_200K);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasDirective(r), `should fire a directive at 90%; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /AUTO-HANDOVER REQUIRED/);
    assert.match(ctx, /handover/i, 'must tell the agent to write a handover');
    assert.match(ctx, /hallucinat/i, 'must explain WHY: context bloat -> less accurate / more hallucination');
    assert.match(ctx, /\/compact|\/clear/, 'must urge /compact or /clear');

    // A SECOND UserPromptSubmit at the same (or slightly higher, non-milestone) percent must be silent.
    const t2 = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(91, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(t2), home, KNOWN_200K);
    assert.ok(!hasDirective(r2), `must not re-fire until the next milestone; stdout: ${r2.stdout}`);
  } finally { rm(home); }
});

test('sidechain/subagent transcript entries are ignored for main-thread percent — silent even above threshold', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [sidechainAssistantUsageLine({ inputTokens: tokensFor(95, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `sidechain usage must not trigger a directive; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('milestone nag fires only at +nagStepPct (default +5) past the original crossing, not every turn', () => {
  const home = makeHome();
  try {
    const first = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(86, CONTEXT_WINDOW_200K) })]);
    const r1 = runHook(HOOK, payload(first), home, KNOWN_200K);
    assert.ok(hasDirective(r1), `initial crossing at 86% must fire; stdout: ${r1.stdout}`);

    const noMilestone = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(88, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(noMilestone), home, KNOWN_200K);
    assert.ok(!hasDirective(r2), `88% is not a +5 milestone past 86%; stdout: ${r2.stdout}`);

    const milestone = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(91, CONTEXT_WINDOW_200K) })]);
    const r3 = runHook(HOOK, payload(milestone), home, KNOWN_200K);
    assert.ok(hasDirective(r3), `91% crosses the +5 milestone past 86%; stdout: ${r3.stdout}`);
    assert.match(r3.json.hookSpecificOutput.additionalContext, /handover already saved/);
  } finally { rm(home); }
});

test('drop below threshold re-arms: a later crossing after /compact fires a fresh directive', () => {
  const home = makeHome();
  try {
    const high = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r1 = runHook(HOOK, payload(high), home, KNOWN_200K);
    assert.ok(hasDirective(r1), `initial crossing must fire; stdout: ${r1.stdout}`);

    // Simulates a /compact: usage drops back down.
    const low = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(40, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(low), home, KNOWN_200K);
    assert.ok(!hasDirective(r2), `below threshold after compact must be silent; stdout: ${r2.stdout}`);

    const highAgain = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r3 = runHook(HOOK, payload(highAgain), home, KNOWN_200K);
    assert.ok(hasDirective(r3), `re-crossing after a drop must fire again (re-armed); stdout: ${r3.stdout}`);
  } finally { rm(home); }
});

test('1M window from the statusline (sticky max_tokens): 150k tokens is 15% -> silent; 900k fires', () => {
  const home = makeHome();
  try {
    // The statusline persisted this session's real window earlier (stale ts:
    // the 10-min live reading has expired, the window size has not).
    const store = path.join(antiHallDir(home), 'context-pct', 'sess-ah-1.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ pct: 10, usedTokens: 100000, maxTokens: CONTEXT_WINDOW_1M, ts: Date.now() - 60 * 60 * 1000 }));
    const under = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: 150000 })]);
    const r1 = runHook(HOOK, payload(under), home);
    assert.ok(!hasDirective(r1), `150k of a 1M window is 15%; stdout: ${r1.stdout}`);
    const over = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_1M) })]);
    const r2 = runHook(HOOK, payload(over), home);
    assert.ok(hasDirective(r2), `900k of a 1M window is 90%; stdout: ${r2.stdout}`);
    assert.match(r2.json.hookSpecificOutput.additionalContext, /AUTO-HANDOVER REQUIRED/);
  } finally { rm(home); }
});

test('no window info but usage > 200k proves a 1M window (inferred-1m): 900k fires the directive at ~90%', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_1M) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.ok(hasDirective(r), `stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /CONTEXT AT ~90%/);
    assert.match(ctx, /inferred 1M window/);
  } finally { rm(home); }
});

test('UNKNOWN window (no override, no statusline, <=200k) with the token ceiling off: one soft advisory per arm, never the mandatory directive', () => {
  const home = makeHome();
  try {
    writeJson(settingsPath(home), { autoHandover: { maxTokens: 0 } });
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r1 = runHook(HOOK, payload(t), home);
    assert.ok(hasDirective(r1), `stdout: ${r1.stdout}`);
    const ctx = r1.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /soft heads-up/);
    assert.doesNotMatch(ctx, /AUTO-HANDOVER REQUIRED/);
    const r2 = runHook(HOOK, payload(t), home);
    assert.ok(!hasDirective(r2), `the advisory is not repeated every turn; stdout: ${r2.stdout}`);
  } finally { rm(home); }
});

test('settings off (autoHandover.enabled=false) => silent even far above threshold', () => {
  const home = makeHome();
  try {
    writeJson(settingsPath(home), { autoHandover: { enabled: false } });
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(99, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `disabled setting must silence the hook; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('ANTIHALL_AUTO_HANDOVER_PCT overrides the configured/default threshold', () => {
  const home = makeHome();
  try {
    // 60% would be silent under the default 85% threshold, but must fire
    // once the env override lowers the bar to 50%.
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(60, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home, Object.assign({ ANTIHALL_AUTO_HANDOVER_PCT: '50' }, KNOWN_200K));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasDirective(r), `env override to 50% must fire at 60% usage; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

// ── auto-handover-pause-nag.js (Stop hook) ────────────────────────────────
function latchPath(home) { return path.join(antiHallDir(home), 'auto-handover', 'sess-ah-1.json'); }
function hasStopNag(r) { return !!(r.json && r.json.decision === 'block' && typeof r.json.reason === 'string' && r.json.reason.length > 0); }

test('pause-nag: silent within nagQuietMin of the last nag; nags once after it; then quiet again', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const uh = runHook(HOOK, payload(t), home, KNOWN_200K);
    assert.ok(hasDirective(uh), `precondition: the directive fired; stdout: ${uh.stdout}`);

    const stopPayload = { hook_event_name: 'Stop', session_id: 'sess-ah-1', transcript_path: t };
    const early = runHook(NAG_HOOK, stopPayload, home, KNOWN_200K);
    assert.strictEqual(early.status, 0, early.stderr);
    assert.ok(!hasStopNag(early), `the directive itself counts as the last nag; stdout: ${early.stdout}`);

    // 16 minutes later (latch's lastNagAt moved back past nagQuietMin=15).
    const latch = JSON.parse(fs.readFileSync(latchPath(home), 'utf8'));
    latch.lastNagAt = Date.now() - 16 * 60 * 1000;
    fs.writeFileSync(latchPath(home), JSON.stringify(latch));
    const nag1 = runHook(NAG_HOOK, stopPayload, home, KNOWN_200K);
    assert.ok(hasStopNag(nag1), `a Stop past the quiet window should nag; stdout: ${nag1.stdout}`);

    const nag2 = runHook(NAG_HOOK, stopPayload, home, KNOWN_200K);
    assert.ok(!hasStopNag(nag2), `a second Stop within the 15-min window must be silent; stdout: ${nag2.stdout}`);
  } finally { rm(home); }
});

test('opt-in absolute maxTokens ceiling: 175k tokens fires the mandatory directive even on a 1M window at 17.5%, once set', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: 175000 })]);
    const r = runHook(HOOK, payload(t), home, { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000', ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '170000' });
    assert.ok(hasDirective(r), `stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /AUTO-HANDOVER REQUIRED/);
    const off = makeHome();
    try {
      const r2 = runHook(HOOK, payload(writeTranscript(off, [mainAssistantUsageLine({ inputTokens: 175000 })])), off, { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000', ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '0' });
      assert.ok(!hasDirective(r2), `maxTokens=0 turns the ceiling off; stdout: ${r2.stdout}`);
    } finally { rm(off); }
  } finally { rm(home); }
});

test('maxTokens default is OFF (v0.108.2): 1M window, 214k tokens, no settings at all -> does NOT fire', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: 214000 })]);
    const r = runHook(HOOK, payload(t), home, { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000' });
    assert.ok(!hasDirective(r), `default ceiling must be off (214K on a 1M window is only 21.4%, nowhere near the 85% pct threshold); stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('Stop-side fire: over threshold at a Stop with no directive yet this arm -> the Stop hook delivers it once', () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const stopPayload = { hook_event_name: 'Stop', session_id: 'sess-ah-1', transcript_path: t };
    const r1 = runHook(NAG_HOOK, stopPayload, home, KNOWN_200K);
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.ok(hasStopNag(r1), `stdout: ${r1.stdout}`);
    assert.match(r1.json.reason, /AUTO-HANDOVER REQUIRED/);
    const r2 = runHook(NAG_HOOK, stopPayload, home, KNOWN_200K);
    assert.ok(!hasStopNag(r2), `already fired this arm; stdout: ${r2.stdout}`);
    const below = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(40, CONTEXT_WINDOW_200K) })]);
    const r3 = runHook(NAG_HOOK, { hook_event_name: 'Stop', session_id: 'sess-ah-1', transcript_path: below }, home, KNOWN_200K);
    assert.ok(!hasStopNag(r3), `below threshold: silent; stdout: ${r3.stdout}`);
  } finally { rm(home); }
});

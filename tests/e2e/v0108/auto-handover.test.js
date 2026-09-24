'use strict';
// v0.108.0 contract 1 — auto-handover (hooks/auto-handover.js, UserPromptSubmit)
// + auto-handover-pause-nag.js (Stop).
//
// GATE: hookExists('auto-handover.js') — a literal file-existence check.
// Neither hooks/auto-handover.js nor hooks/auto-handover-pause-nag.js exist
// in this working tree yet (confirmed: `hooks/handover-resume.js` exists for
// the MANUAL /anti-hall:handover skill, but no auto-* hook). Every test below
// is written against the agreed contract and auto-enables the instant both
// files land — no test is unconditionally skipped.
//
// AGREED CONTRACT (settings-schema.js's `autoHandover` section is already
// shipped and pins the exact knobs this hook must read: enabled, pct=85,
// nag=true, nagStepPct=5, nagQuietMin=15 — see hooks/lib/settings-schema.js):
//   - UserPromptSubmit hook reads the main-thread transcript JSONL, sums the
//     most recent assistant usage entry's tokens against the model's context
//     window, and computes a percent-used.
//   - Below pct (default 85%) => silent.
//   - Crossing pct => DIRECTIVE: write a handover file UNASKED, then tell the
//     user WHY (context bloat => less accurate / more hallucination-prone),
//     urge /compact or /clear, and offer a good stopping point. Fires exactly
//     ONCE for a given crossing (not every subsequent turn above threshold).
//   - A transcript entry that is a sidechain/subagent payload (isSidechain:
//     true) must be ignored for the main-thread percent computation — silent.
//   - After the handover file is written, a MILESTONE nag re-fires only at
//     +nagStepPct (default +5) increments past the original crossing.
//   - hooks/auto-handover-pause-nag.js (Stop hook) nags at most once per
//     nagQuietMin (default 15) minutes.
//   - If usage drops back below pct (e.g. after /compact), the hook is
//     RE-ARMED — a later crossing fires again as a fresh directive.
//   - A 1M-context-window model (e.g. a `-1m` suffixed model id) computes
//     percent against 1,000,000 tokens, not the default 200,000.
//   - autoHandover.enabled=false (settings.json/plugin-option) => silent.
//   - ANTIHALL_AUTO_HANDOVER_PCT overrides the configured pct.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  makeHome, rm, runHook, writeJson, settingsPath, hookExists,
  mainAssistantUsageLine, sidechainAssistantUsageLine, writeTranscript,
} = require('./lib.js');

const HOOK = 'auto-handover.js';
const NAG_HOOK = 'auto-handover-pause-nag.js';
const FEATURE_LIVE = hookExists(HOOK) && hookExists(NAG_HOOK);
const GATE = { skip: FEATURE_LIVE ? false : 'feature not in base: auto-handover (hooks/auto-handover.js and/or hooks/auto-handover-pause-nag.js do not exist yet)' };

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

test('below 85%: silent, no handover file written', GATE, () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(50, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `should be silent below threshold; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('crossing 85%: directive fires exactly once — writes a handover file, explains context-bloat risk, urges /compact or /clear', GATE, () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasDirective(r), `should fire a directive at 90%; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /hallucinat/i, 'must explain WHY: context bloat -> less accurate / more hallucination');
    assert.match(ctx, /\/compact|\/clear/, 'must urge /compact or /clear');

    // A SECOND UserPromptSubmit at the same (or slightly higher, non-milestone) percent must be silent.
    const t2 = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(91, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(t2), home);
    assert.ok(!hasDirective(r2), `must not re-fire until the next milestone; stdout: ${r2.stdout}`);
  } finally { rm(home); }
});

test('sidechain/subagent transcript entries are ignored for main-thread percent — silent even above threshold', GATE, () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [sidechainAssistantUsageLine({ inputTokens: tokensFor(95, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `sidechain usage must not trigger a directive; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('milestone nag fires only at +nagStepPct (default +5) past the original crossing, not every turn', GATE, () => {
  const home = makeHome();
  try {
    const first = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(86, CONTEXT_WINDOW_200K) })]);
    const r1 = runHook(HOOK, payload(first), home);
    assert.ok(hasDirective(r1), `initial crossing at 86% must fire; stdout: ${r1.stdout}`);

    const noMilestone = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(88, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(noMilestone), home);
    assert.ok(!hasDirective(r2), `88% is not a +5 milestone past 86%; stdout: ${r2.stdout}`);

    const milestone = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(91, CONTEXT_WINDOW_200K) })]);
    const r3 = runHook(HOOK, payload(milestone), home);
    assert.ok(hasDirective(r3), `91% crosses the +5 milestone past 86%; stdout: ${r3.stdout}`);
  } finally { rm(home); }
});

test('drop below threshold re-arms: a later crossing after /compact fires a fresh directive', GATE, () => {
  const home = makeHome();
  try {
    const high = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r1 = runHook(HOOK, payload(high), home);
    assert.ok(hasDirective(r1), `initial crossing must fire; stdout: ${r1.stdout}`);

    // Simulates a /compact: usage drops back down.
    const low = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(40, CONTEXT_WINDOW_200K) })]);
    const r2 = runHook(HOOK, payload(low), home);
    assert.ok(!hasDirective(r2), `below threshold after compact must be silent; stdout: ${r2.stdout}`);

    const highAgain = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const r3 = runHook(HOOK, payload(highAgain), home);
    assert.ok(hasDirective(r3), `re-crossing after a drop must fire again (re-armed); stdout: ${r3.stdout}`);
  } finally { rm(home); }
});

test('1M-context-window model fires at 85% of 1,000,000 tokens, not 85% of 200,000', GATE, () => {
  const home = makeHome();
  try {
    // 90% of the 200k window would be well above 85% of 1M, so this transcript
    // proves the hook is using the 1M denominator: tokensFor(90, 200k) is far
    // below 85% of 1,000,000 and must stay silent for a 1M-window model.
    const under1mThreshold = writeTranscript(home, [mainAssistantUsageLine({
      inputTokens: tokensFor(90, CONTEXT_WINDOW_200K),
      model: 'claude-sonnet-4-5-1m-20250929',
    })]);
    const r1 = runHook(HOOK, payload(under1mThreshold), home);
    assert.ok(!hasDirective(r1), `90% of the 200k window is well under 85% of a 1M window; stdout: ${r1.stdout}`);

    const over1mThreshold = writeTranscript(home, [mainAssistantUsageLine({
      inputTokens: tokensFor(90, CONTEXT_WINDOW_1M),
      model: 'claude-sonnet-4-5-1m-20250929',
    })]);
    const r2 = runHook(HOOK, payload(over1mThreshold), home);
    assert.ok(hasDirective(r2), `90% of a real 1M window must fire; stdout: ${r2.stdout}`);
  } finally { rm(home); }
});

test('settings off (autoHandover.enabled=false) => silent even far above threshold', GATE, () => {
  const home = makeHome();
  try {
    writeJson(settingsPath(home), { autoHandover: { enabled: false } });
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(99, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!hasDirective(r), `disabled setting must silence the hook; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

test('ANTIHALL_AUTO_HANDOVER_PCT overrides the configured/default threshold', GATE, () => {
  const home = makeHome();
  try {
    // 60% would be silent under the default 85% threshold, but must fire
    // once the env override lowers the bar to 50%.
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(60, CONTEXT_WINDOW_200K) })]);
    const r = runHook(HOOK, payload(t), home, { ANTIHALL_AUTO_HANDOVER_PCT: '50' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(hasDirective(r), `env override to 50% must fire at 60% usage; stdout: ${r.stdout}`);
  } finally { rm(home); }
});

// ── auto-handover-pause-nag.js (Stop hook) ────────────────────────────────
test('pause-nag: after a handover file is written, the Stop hook nags at most once per 15 minutes', GATE, () => {
  const home = makeHome();
  try {
    const t = writeTranscript(home, [mainAssistantUsageLine({ inputTokens: tokensFor(90, CONTEXT_WINDOW_200K) })]);
    const uh = runHook(HOOK, payload(t), home);
    assert.ok(hasDirective(uh), `precondition: UserPromptSubmit must have written a handover; stdout: ${uh.stdout}`);

    const stopPayload = { hook_event_name: 'Stop', session_id: 'sess-ah-1', transcript_path: t };
    const nag1 = runHook(NAG_HOOK, stopPayload, home);
    assert.strictEqual(nag1.status, 0, nag1.stderr);
    assert.ok(hasDirective(nag1), `first Stop after a due handover should nag; stdout: ${nag1.stdout}`);

    const nag2 = runHook(NAG_HOOK, stopPayload, home);
    assert.ok(!hasDirective(nag2), `a second Stop within the 15-min cooldown must be silent; stdout: ${nag2.stdout}`);
  } finally { rm(home); }
});

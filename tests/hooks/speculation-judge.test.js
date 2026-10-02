'use strict';
// speculation-judge (Stop hook, OPT-IN). Without ANTIHALL_SEMANTIC_JUDGE=1 it
// exits 0 immediately regardless of transcript. We never test the live API path.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'speculation-judge.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

test('OPT-OUT default: no ANTIHALL_SEMANTIC_JUDGE -> exit 0, no block', () => {
  const h = makeHome();
  try {
    // A confidently-stated unverified inference (would be a candidate to block if
    // the judge ran) — but the judge is disabled by default.
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

// SKIP-HATCH: speculation-judge calls isSkipped('speculation-judge') at
// speculation-judge.js:290, AFTER the ANTIHALL_SEMANTIC_JUDGE=1 env gate (line 64)
// but BEFORE the API-key check (line 306) and any network call. So to exercise the
// skip path we must ENABLE the judge (else it exits 0 at the env gate, never
// reaching the skip check). With the judge enabled AND an API key present, an
// unverified-inference transcript WOULD proceed toward the API; an explicit skip
// must short-circuit to exit 0 at line 290 before any of that. We assert exit 0 +
// no block. We never make a real API call: the skip fires before the network path.
test('SKIP-HATCH: skip.json {speculation-judge: future} -> exit 0, no block (judge enabled + key present)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-judge': Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('SKIP-HATCH: broad "all" skip also covers speculation-judge (non-destructive)', () => {
  const h = makeHome();
  try {
    // speculation-judge is NOT in skip-guard's DESTRUCTIVE set, so a broad "all"
    // skip applies (skip-guard.js:50-53). Enabled judge + key, "all" skip -> exit 0.
    h.writeSkip({ all: Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under "all" skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `"all" skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL default: no override -> hook reaches API path, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-ant-fake-default' },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL override: custom model env var -> hook accepts override, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: {
        ANTIHALL_SEMANTIC_JUDGE: '1',
        CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-ant-fake-override',
        ANTIHALL_JUDGE_MODEL: 'claude-test-model-override',
      },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0 with model override; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// last_assistant_message: the judge evaluates the reply being stopped (Stop
// payload), not the previous transcript message. No network: a NODE_OPTIONS
// preload stub replaces https.request, records the request body under the temp
// home and answers with a canned allow/block.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const STUB = path.join(__dirname, '..', 'helpers', 'stub-judge-https.js').replace(/\\/g, '/');

function judgeRun(h, payload, reply) {
  const logFile = path.join(h.home, 'judge-requests.ndjson');
  const r = testHook(HOOK, payload, {
    home: h.home,
    env: {
      ANTIHALL_SEMANTIC_JUDGE: '1',
      CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-ant-stubbed',
      NODE_OPTIONS: `--require "${STUB}"`,
      ANTIHALL_TEST_JUDGE_LOG: logFile,
      ANTIHALL_TEST_JUDGE_REPLY: reply,
    },
  });
  let bodies = [];
  try { bodies = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch (_) { /* no request made */ }
  return { r, bodies };
}

const OLD_HEDGE = 'The cause is the stale build artifact, so rebuilding fixes it.';
const PAYLOAD_CLEAN = 'Rebuilt and ran node --test: 12 pass, 0 fail.';
const BLOCK = '{"decision":"block","claim":"cause asserted without evidence"}';
const ALLOW = '{"decision":"allow"}';

test('LAM judge: stale transcript + clean payload -> request carries the payload text, result allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage(OLD_HEDGE)]);
    const { r, bodies } = judgeRun(h, Object.assign(stopPayload(tp), { last_assistant_message: PAYLOAD_CLEAN }), ALLOW);
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'), `expected allow; stdout: ${r.stdout}`);
    assert.strictEqual(bodies.length, 1, 'the stubbed API must have been called once');
    assert.ok(bodies[0].includes('12 pass, 0 fail'), 'request must carry the payload text');
    assert.ok(!bodies[0].includes('stale build artifact'), 'request must not carry the older transcript text');
  } finally {
    h.cleanup();
  }
});

test('LAM judge: hedge in the payload -> request carries it and the canned block is honoured', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('Earlier: all good.')]);
    const { r, bodies } = judgeRun(h, Object.assign(stopPayload(tp), { last_assistant_message: OLD_HEDGE }), BLOCK);
    assert.strictEqual(r.status, 0);
    assert.ok(r.json && r.json.decision === 'block', `expected block; stdout: ${r.stdout}`);
    assert.strictEqual(bodies.length, 1);
    assert.ok(bodies[0].includes('stale build artifact'));
    assert.ok(!bodies[0].includes('Earlier: all good'));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Enable gate: the jev.semanticJudge setting OR ANTIHALL_SEMANTIC_JUDGE=1
// enables the judge (the schema maps the env var onto the setting; env wins
// when set to a recognised on/off token). Default stays OFF. Stubbed https.
// ---------------------------------------------------------------------------
function gateRun(opts) {
  const h = makeHome();
  try {
    if (opts.settings) {
      fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(opts.settings));
    }
    const tp = h.writeTranscript([assistantMessage(OLD_HEDGE)]);
    const logFile = path.join(h.home, 'judge-requests.ndjson');
    const env = {
      CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: 'sk-ant-stubbed',
      NODE_OPTIONS: `--require "${STUB}"`,
      ANTIHALL_TEST_JUDGE_LOG: logFile,
      ANTIHALL_TEST_JUDGE_REPLY: ALLOW,
    };
    if (opts.env !== undefined) env.ANTIHALL_SEMANTIC_JUDGE = opts.env;
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env });
    let bodies = [];
    try { bodies = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch (_) { /* none */ }
    return { r, calls: bodies.length };
  } finally {
    h.cleanup();
  }
}

test('GATE: jev.semanticJudge=true in settings, no env -> judge called', () => {
  const { r, calls } = gateRun({ settings: { jev: { semanticJudge: true } } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(calls, 1, 'the setting alone must enable the judge');
});

test('GATE: default (no setting, no env) -> judge not called', () => {
  const { r, calls } = gateRun({});
  assert.strictEqual(r.status, 0);
  assert.strictEqual(calls, 0);
});

test('GATE: env ANTIHALL_SEMANTIC_JUDGE=1 -> judge called', () => {
  const { calls } = gateRun({ env: '1' });
  assert.strictEqual(calls, 1);
});

test('GATE precedence: env 0 beats setting true (env > settings.json)', () => {
  const { r, calls } = gateRun({ env: '0', settings: { jev: { semanticJudge: true } } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(calls, 0);
});

test('GATE precedence: env 1 beats setting false', () => {
  const { calls } = gateRun({ env: '1', settings: { jev: { semanticJudge: false } } });
  assert.strictEqual(calls, 1);
});

test('LAM judge: payload absent -> old behaviour (transcript text is judged)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage(OLD_HEDGE)]);
    const { r, bodies } = judgeRun(h, stopPayload(tp), BLOCK);
    assert.ok(r.json && r.json.decision === 'block', `expected block; stdout: ${r.stdout}`);
    assert.strictEqual(bodies.length, 1);
    assert.ok(bodies[0].includes('stale build artifact'));
  } finally {
    h.cleanup();
  }
});

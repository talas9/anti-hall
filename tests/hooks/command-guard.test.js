'use strict';
// command-guard (PreToolUse Bash). Coordinator => may block (exit 2 + decision);
// subagent => always allow (exit 0).
//
// COORDINATOR env: CLAUDE_CODE_ENTRYPOINT='cli' AND no agent_id in the payload.
// SUBAGENT: agent_id in the PAYLOAD (the cmux-reliable signal).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

// Coordinator run with a fresh fake HOME (no skip.json -> guard active).
function runCoord(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home, env: COORD });
  } finally {
    h.cleanup();
  }
}

const BLOCK = [
  'npm run build',
  'npm test',
  'git status && npm run build',
  'cd app && npm test',
  'echo "$(npm run build)"',
  'bash -c "npm run build"',
  'eval "npm test"',
  'go env -w GOFLAGS=-mod=mod',
  // Arbitrary node scripts stay blocked — the helper exception must be narrow.
  'node evil.js',
  'node build.js',
  'node scripts/deploy.mjs',
  // Wrong filename inside the same helper dir is NOT exempted.
  'node /abs/plugins/anti-hall/statusline/other.js',
  // Spoof attempt: a look-alike dir prefix must not satisfy the anchored exception.
  'node evilstatusline/phase.js',
  'node fakehooks/agent-watchdog.js',
  // Look-alike prefix must NOT satisfy the anchored devswarm.js carve-out.
  'node evilscripts/devswarm.js',
  'node scripts/other.js',
];

const ALLOW = [
  'git status',
  'echo "npm run build"',
  "printf 'go test ./...'",
  'eval "echo hi"',
  'git push --dry-run origin main',
  'go env GOPATH',
  'echo "hello world"',
  // Coordinator-owned phase-state helpers (orchestration/SKILL.md:305, ship-it/SKILL.md:280).
  // Documented relative form (path relative to plugin root) ...
  'node statusline/phase.js set PLAN "Planning feature X" 0 3',
  'node statusline/phase.js advance',
  'node hooks/agent-watchdog.js 1200000',
  // ... and the documented absolute form (path.join(pluginRoot, ...)).
  'node /Users/x/plugins/anti-hall/statusline/phase.js clear',
  'node /Users/x/plugins/anti-hall/hooks/agent-watchdog.js',
  // Windows-separator form must resolve identically (OS-agnostic).
  'node C:\\proj\\plugins\\anti-hall\\statusline\\phase.js agents 4',
  // DevSwarm CLI wrapper (scripts/devswarm.js) — the catch-22 carve-out (PLAN.md
  // Phase 2). Relative, absolute, and Windows-separator forms all resolve.
  'node scripts/devswarm.js workspaces list',
  'node scripts/devswarm.js gate w --set done',
  'node /Users/x/plugins/anti-hall/scripts/devswarm.js migrate',
  'node C:\\proj\\plugins\\anti-hall\\scripts\\devswarm.js register w',
  // Child-side reception drain (v0.54.2) — bounded, guard-safe pull. It IS the
  // devswarm.js wrapper, so the same anchored LIGHT_EXCEPTION allows it inline in
  // coordinator context (its internal spawn is the non-destructive count-gate +
  // one bounded read-messages, never a blocking monitor).
  'node scripts/devswarm.js inbox pull x',
];

for (const cmd of BLOCK) {
  test(`COORD BLOCK: ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

for (const cmd of ALLOW) {
  test(`COORD ALLOW: ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

test('SUBAGENT allows heavy command (agent_id in payload, no cli entrypoint)', () => {
  const h = makeHome();
  try {
    // No CLAUDE_CODE_ENTRYPOINT; agent_id present in the payload.
    const r = testHook(HOOK, bashPayload('npm run build', { agentId: 'x' }), { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('INJECTION: block reason does not echo arbitrary command text', () => {
  const r = runCoord('npm run build && echo INJECTSECRET');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DevSwarm destructive-read REDIRECT branch. Fires when the DevSwarm liveness
// supervisor is active for THIS session (DEVSWARM_REPO_ID set -> isDevswarmActive
// auto-true), in ALL contexts (coordinator AND subagent), with its OWN skip name
// (`devswarm-read-guard`), BEFORE command-guard's own skip/coordinator gate.
//   - `monitor`      -> block UNCONDITIONALLY (no-timeout long-poll hangs the shell).
//   - `read-messages`-> block UNCONDITIONALLY too (Part B, v0.55): a raw native read
//                       desyncs the durable cursor regardless of evidence, so it blocks
//                       like `monitor` (the old durable-evidence gate is removed).
//   - raw file reads (cat/head/… of the inbox or store) -> block via the Bash-side
//                       companion to inbox-read-guard.js (the shared path classifier).
const fsx = require('node:fs');
const pathx = require('node:path');
const DEVSWARM_COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' };
const DURABLE_ENV = { ANTIHALL_DEVSWARM_INBOX_CMD: 'my-inbox-reader' };

// runDevswarm(command, extraEnv, opts) — DevSwarm-active coordinator, fresh HOME.
//   opts.agentId    -> lands in the payload (subagent discriminator).
//   opts.descriptor -> object written to ~/.anti-hall/devswarm/workspaces/ws.json
//                      BEFORE the run (durable-evidence-via-descriptor case).
//   opts.skip       -> object written to ~/.anti-hall/skip.json BEFORE the run.
function runDevswarm(command, extraEnv, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.descriptor) {
      const wdir = pathx.join(h.antiHall, 'devswarm', 'workspaces');
      fsx.mkdirSync(wdir, { recursive: true });
      fsx.writeFileSync(pathx.join(wdir, 'ws.json'), JSON.stringify(o.descriptor), 'utf8');
    }
    if (o.skip) h.writeSkip(o.skip);
    return testHook(HOOK, bashPayload(command, { agentId: o.agentId }), {
      home: h.home,
      env: Object.assign({}, DEVSWARM_COORD, extraEnv || {}),
    });
  } finally {
    h.cleanup();
  }
}

// --- NEGATIVE (the regression these changes fix): quoted DATA must NOT block ---
const HIVECTL_ALLOW_DATA = [
  // grep of a DATA string that mentions the subcommand — a false-positive before.
  "grep -n 'hivecontrol workspace read-messages' docs/KB.md",
  // echo of a DATA string that mentions monitor — a false-positive before.
  'echo "do not run hivecontrol workspace monitor inline"',
];
for (const cmd of HIVECTL_ALLOW_DATA) {
  test(`DEVSWARM ALLOW (quoted data): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for quoted data: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- POSITIVE: real destructive reads / smuggled forms must block ---
// Part B: BOTH monitor and read-messages block UNCONDITIONALLY (no evidence needed).
const HIVECTL_BLOCK = [
  { cmd: 'hivecontrol workspace read-messages', env: {} }, // unconditional (Part B)
  { cmd: 'hivecontrol workspace read-messages', env: DURABLE_ENV },
  { cmd: 'hivecontrol workspace monitor', env: {} }, // unconditional
  { cmd: 'bash -c "hivecontrol workspace read-messages"', env: {} },
  { cmd: '$(hivecontrol workspace monitor)', env: {} },
  // Chained after a benign command — caught on the destructive segment.
  { cmd: 'echo hi && hivecontrol workspace monitor', env: {} },
  // Flag insertion must not bypass the matcher.
  { cmd: 'hivecontrol --json workspace monitor', env: {} },
];
for (const { cmd, env } of HIVECTL_BLOCK) {
  test(`DEVSWARM BLOCK: ${cmd}`, () => {
    const r = runDevswarm(cmd, env);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// REGRESSION (P0, live-verified bypass): quoting a bareword does NOT change argv —
// the shell executes `hivecontrol workspace "monitor"` identically to the unquoted
// form. Previously the per-segment pattern test ran against
// neutralizeQuotedContents(seg), which BLANKS quoted content instead of dequoting
// it, so every quoted variant of monitor/read-messages sailed through (exit 0).
// This defeated the single-consumer invariant: the guard's own block reason echoes
// the exact blocked subcommand back, so a blocked model's natural retry is to quote
// it. Covers: double-quoted subcommand, single-quoted subcommand, a mid-token split
// quote, and a quoted VERB (which must also still anchor to `hivecontrol`).
const HIVECTL_QUOTE_BYPASS_BLOCK = [
  'hivecontrol workspace "monitor"',
  "hivecontrol workspace 'monitor'",
  'hivecontrol workspace mon"ito"r',
  '"hivecontrol" workspace monitor',
  'hivecontrol workspace "read-messages"',
  "hivecontrol workspace 'read-messages'",
  'hivecontrol workspace read"-mess"ages',
  '"hivecontrol" workspace read-messages',
];
for (const cmd of HIVECTL_QUOTE_BYPASS_BLOCK) {
  test(`DEVSWARM BLOCK (quote-bypass regression): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// --- SCOPING ---
// Part B inversion: read-messages with NO durable evidence now BLOCKS unconditionally
// (was ALLOW). A raw native read desyncs the durable cursor regardless of evidence.
test('DEVSWARM BLOCK read-messages with NO durable evidence (Part B: unconditional)', () => {
  const r = runDevswarm('hivecontrol workspace read-messages');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

// The block reason redirects to the wrapper (`inbox pull`) and names the kill-switch.
test('DEVSWARM read-messages reason names `inbox pull` + DISABLE_ANTIHALL_DEVSWARM kill-switch', () => {
  const r = runDevswarm('hivecontrol workspace read-messages');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /inbox pull/.test(r.json.reason),
    'reason should redirect to `devswarm.js inbox pull`');
  assert.ok(r.json && /DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason),
    'reason should name the DISABLE_ANTIHALL_DEVSWARM=1 kill-switch');
});

test('DEVSWARM SUBAGENT (agent_id) + monitor still blocks (all-contexts)', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, { agentId: 'x' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

const HIVECTL_ALLOW = [
  'hivecontrol workspace message-count',
];
for (const cmd of HIVECTL_ALLOW) {
  test(`DEVSWARM ALLOW (non-destructive): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// ---------------------------------------------------------------------------
// v0.58 "mesh-only messaging" branch: HIVECTL_MESSAGE_CHILD / HIVECTL_MESSAGE_PARENT.
// Native SEND subcommands are now guard-blocked; every LIFECYCLE verb
// (create/list/check-merge/merge) and the read-only message-count counter stay
// default-allow — breaking those would break DevSwarm spawn/merge.

// --- POSITIVE: real message-child/message-parent sends, smuggled forms too ---
const HIVECTL_MESSAGE_BLOCK = [
  'hivecontrol workspace message-parent "status update"',
  'hivecontrol workspace message-child "status update"',
  'bash -c "hivecontrol workspace message-parent hi"',
  '$(hivecontrol workspace message-child hi)',
  'echo hi && hivecontrol workspace message-parent hi',
  'hivecontrol --json workspace message-parent hi', // flag insertion must not bypass
];
for (const cmd of HIVECTL_MESSAGE_BLOCK) {
  test(`DEVSWARM MESSAGE-SEND BLOCK: ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
    assert.ok(/DEVSWARM MESH-ONLY MESSAGING/.test(r.json.reason), `reason must name the mesh-only-messaging rule; got=${r.json.reason}`);
  });
}

// REGRESSION (P0, live-verified bypass): quoting message-parent/message-child (or
// the hivecontrol verb) does NOT change argv, so it must block IDENTICALLY to the
// unquoted form. Previously ran against neutralizeQuotedContents(seg), which
// BLANKS quoted content, so every quoted variant sailed through (exit 0) — this
// defeated v0.58's headline invariant (mesh store is the SOLE agent-initiated
// transport), and was trivially reachable since the block reason echoes the exact
// blocked subcommand back, inviting a quoted retry.
const HIVECTL_MESSAGE_QUOTE_BYPASS_BLOCK = [
  'hivecontrol workspace "message-parent" hi',
  "hivecontrol workspace 'message-parent' hi",
  'hivecontrol workspace mes"sage-par"ent hi',
  '"hivecontrol" workspace message-parent hi',
  'hivecontrol workspace "message-child" hi',
  "hivecontrol workspace 'message-child' hi",
  'hivecontrol workspace mes"sage-chi"ld hi',
  '"hivecontrol" workspace message-child hi',
];
for (const cmd of HIVECTL_MESSAGE_QUOTE_BYPASS_BLOCK) {
  test(`DEVSWARM MESSAGE-SEND BLOCK (quote-bypass regression): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

test('DEVSWARM MESSAGE-SEND BLOCK: fires in SUBAGENT context too (all-contexts, like devswarm-read-guard)', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, { agentId: 'sub' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND reason redirects to the mesh CLI (send / heartbeat)', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi');
  assert.strictEqual(r.status, 2);
  assert.ok(/devswarm\.js send/.test(r.json.reason), `reason must redirect to devswarm.js send; got=${r.json.reason}`);
  assert.ok(/devswarm\.js heartbeat/.test(r.json.reason), `reason must redirect to devswarm.js heartbeat; got=${r.json.reason}`);
  assert.ok(/DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason), 'reason must name the kill-switch');
});

test('DEVSWARM MESSAGE-SEND INJECTION: block reason does not echo command text', () => {
  const r = runDevswarm('hivecontrol workspace message-parent "INJECTSECRET"');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

// --- NEGATIVE: lifecycle verbs, message-count, and DATA mentions must ALLOW ---
const HIVECTL_MESSAGE_ALLOW = [
  'hivecontrol workspace create feature-x',
  'hivecontrol workspace list',
  'hivecontrol workspace check-merge',
  'hivecontrol workspace merge',
  'hivecontrol workspace merge-into-source',
  'hivecontrol workspace message-count',
  // Quoted DATA / grep of a string mentioning the subcommand name — verb is
  // grep, not hivecontrol -> must never classify as a send.
  'grep message-parent docs/KB.md',
  'grep -n "hivecontrol workspace message-parent" docs/KB.md',
];
for (const cmd of HIVECTL_MESSAGE_ALLOW) {
  test(`DEVSWARM MESSAGE-SEND ALLOW (lifecycle/count/data): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- SKIP (own name `devswarm-send-guard`, independent of devswarm-read-guard
// and command-guard's own skip) ---
test('DEVSWARM MESSAGE-SEND SKIP: devswarm-send-guard skipped -> message-parent allowed', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'devswarm-send-guard': FUTURE },
  });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND SKIP: devswarm-read-guard skip does NOT cover message-parent', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'devswarm-read-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND SKIP: command-guard skip does NOT cover message-parent', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'command-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND KILL-SWITCH: DISABLE_ANTIHALL_DEVSWARM=1 -> message-parent allowed', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', { DISABLE_ANTIHALL_DEVSWARM: '1' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND gate off: non-DevSwarm coordinator allows message-parent', () => {
  const r = runCoord('hivecontrol workspace message-parent hi');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// --- EXEMPTION confirmation: the devswarm.js carve-out already covers every
// mesh coordination verb (generic, no subcommand restriction) ---
const DEVSWARM_JS_MESH_VERB_ALLOW = [
  'node scripts/devswarm.js send --to-primary --message "hi"',
  'node scripts/devswarm.js heartbeat w1 --summary "status"',
  'node scripts/devswarm.js roster',
  'node scripts/devswarm.js mesh read',
  'node scripts/devswarm.js inbox read-primary w1',
  'node scripts/devswarm.js archive-request w1',
  'node scripts/devswarm.js reconcile',
];
for (const cmd of DEVSWARM_JS_MESH_VERB_ALLOW) {
  test(`COORD ALLOW (mesh CLI verb, devswarm.js carve-out): ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- SKIP (own name, independent of command-guard) ---
const FUTURE = Date.now() + 60 * 60 * 1000;
test('DEVSWARM SKIP: devswarm-read-guard skipped -> monitor allowed', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { 'devswarm-read-guard': FUTURE },
  });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM SKIP: command-guard skipped but devswarm-read-guard NOT -> monitor still blocks', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { 'command-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM SKIP: blanket {all} does NOT cover devswarm-read-guard -> monitor still blocks', () => {
  // devswarm-read-guard is in skip-guard's DESTRUCTIVE set (irreversible native-queue
  // drain), so a broad {all} skip must NOT silence it — only an explicit name does.
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { all: FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- GATE OFF: non-DevSwarm env ---
test('NON-DEVSWARM coordinator allows monitor (gate off)', () => {
  // No DEVSWARM_REPO_ID -> isDevswarmActive false -> branch dormant; hivecontrol is
  // not a HEAVY_VERB so the heavy gate does not fire either -> allow.
  const r = runCoord('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// --- REASON HYGIENE ---
test('DEVSWARM monitor reason does NOT claim a message-count 0 means empty', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && !/message-count/.test(r.json.reason),
    'monitor reason must not tell the user message-count reflects emptiness');
});

test('DEVSWARM read-messages reason: message-count caveat states NATIVE-queue-only', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', DURABLE_ENV);
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /message-count/.test(r.json.reason) && /NATIVE/i.test(r.json.reason),
    'read-messages reason must caveat message-count as native-queue-only');
});

test('DEVSWARM block reason names ANTIHALL_DEVSWARM_INBOX_CMD when it is set', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', DURABLE_ENV);
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /ANTIHALL_DEVSWARM_INBOX_CMD/.test(r.json.reason),
    'reason should name the durable-inbox env var when configured');
});

test('DEVSWARM block reason omits the env var when it is unset', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && !/ANTIHALL_DEVSWARM_INBOX_CMD/.test(r.json.reason),
    'reason should NOT mention the env var when it is not configured');
});

test('DEVSWARM block reason includes the do-not-delegate line', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /do not delegate/i.test(r.json.reason),
    'reason must warn that delegating the read drains the queue identically');
});

test('DEVSWARM INJECTION: block reason does not echo command text', () => {
  const r = runDevswarm('hivecontrol workspace monitor # INJECTSECRET');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

// --- FIX 3: command-position anchoring drops the unquoted-args false-positive ---
// Unquoted args that are literally these words in order but whose command VERB is
// grep/echo (not hivecontrol) must ALLOW — hivecontrol is not at command position.
const HIVECTL_ALLOW_UNQUOTED_ARGS = [
  'grep hivecontrol workspace monitor docs/KB.md',
  'echo hivecontrol workspace monitor',
];
for (const cmd of HIVECTL_ALLOW_UNQUOTED_ARGS) {
  test(`DEVSWARM ALLOW (unquoted args, verb not hivecontrol): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// A path-/wrapper-prefixed hivecontrol IS still the verb -> must STILL block
// (guards that the anchoring did not weaken smuggling detection).
test('DEVSWARM BLOCK: /usr/bin/hivecontrol workspace monitor (path prefix, still verb)', () => {
  const r = runDevswarm('/usr/bin/hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});
test('DEVSWARM BLOCK: sudo hivecontrol workspace monitor (wrapper, still verb)', () => {
  const r = runDevswarm('sudo hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- FIX 4 (SUPERSEDED by the dequote fix): these two quote-split forms were
// previously documented as an ACCEPTED, out-of-scope limitation, because the old
// matcher ran against neutralizeQuotedContents (which BLANKS quoted content) —
// that made the split-quote obfuscation indistinguishable from a genuine bypass.
// dequoteSegment (the P0 fix below) recovers the literal argv text for ANY
// quote-delimited split, not just the specific message-parent/monitor examples,
// so these now correctly BLOCK too (a strict improvement, not a regression). Only
// TRUE shell-expansion forms (parameter/command substitution, which need a full
// shell-expansion simulation to resolve) remain out of scope — see
// HIVECTL_ACCEPTED_SHELL_EXPANSION below. ---
const HIVECTL_NOW_BLOCKED_QUOTE_SPLIT = [
  "hiv'ec'ontrol workspace monitor",   // verb dequotes to hivecontrol
  "hivecontrol workspace 'mon'itor",   // subcommand dequotes to monitor
];
for (const cmd of HIVECTL_NOW_BLOCKED_QUOTE_SPLIT) {
  test(`DEVSWARM BLOCK (quote-split, previously an accepted gap — now fixed): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// --- ACCEPTED LIMITATION (still out of scope): forms that only synthesize the
// verb/subcommand via shell PARAMETER or COMMAND expansion need a full
// shell-expansion simulation to resolve, which this drift-guard does not attempt
// (it defends against accidental and quote-obfuscated destructive reads, not a
// determined shell-expansion bypass). ---
const HIVECTL_ACCEPTED_SHELL_EXPANSION = [
  'mon=itor; hivecontrol workspace $mon',   // resolved only after variable expansion
];
for (const cmd of HIVECTL_ACCEPTED_SHELL_EXPANSION) {
  test(`DEVSWARM accepted-limitation (shell expansion NOT caught, allows): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `documented accepted bypass should allow: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// ---------------------------------------------------------------------------
// Bash file-read branch (item 3): detectProtectedFileRead — closes the `cat`/`head`
// bypass that this Bash-verb-only guard could not otherwise see. Paths are built
// ABSOLUTE under the fresh fake HOME's ~/.anti-hall/devswarm root (the real inbox
// location), so classification resolves unambiguously. Store-CLI-present gating is
// exercised at the classifier UNIT level (inbox-read-guard.test.js); here the store
// probe finds NO listMessages yet, so a raw store read fails OPEN (ALLOW) — proving
// a pre-#13 Primary is never bricked.
// runDevswarmFileRead(mkCommand) — DevSwarm-active, fresh HOME; mkCommand(dsRoot)
// receives the absolute devswarm root and returns the command string to test.
function runDevswarmFileRead(mkCommand) {
  const h = makeHome();
  try {
    const dsRoot = pathx.join(h.antiHall, 'devswarm');
    return testHook(HOOK, bashPayload(mkCommand(dsRoot)), {
      home: h.home,
      env: DEVSWARM_COORD,
    });
  } finally {
    h.cleanup();
  }
}

// BLOCK: an unquoted `cat`/`head`/… of the raw inbox NDJSON (inbox deny is NOT gated).
test('DEVSWARM FILE-READ BLOCK: cat of the raw inbox ndjson', () => {
  const r = runDevswarmFileRead((root) => `cat ${pathx.join(root, 'inbox', 'x.ndjson')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
  assert.ok(/CURSOR DESYNC/.test(r.json.reason) && /does NOT drain the queue/.test(r.json.reason),
    'reason must use the accurate cursor-desync harm model (append-only, not a drain)');
});

// BLOCK: head/tail forms of the inbox also block.
test('DEVSWARM FILE-READ BLOCK: head of the raw inbox ndjson', () => {
  const r = runDevswarmFileRead((root) => `head -n 5 ${pathx.join(root, 'inbox', 'x.ndjson')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// Store deny is self-healing: it arms once devswarm-store.js exposes the read-CLI
// (listMessages), which has landed -> a raw `head` of the store db BLOCKS. The
// fail-OPEN-when-absent direction is covered by the classifier UNIT test (CLI_OFF)
// in inbox-read-guard.test.js.
test('DEVSWARM FILE-READ BLOCK: head of store db (read-CLI present -> gate armed)', () => {
  const r = runDevswarmFileRead((root) => `head ${pathx.join(root, 'store', 'devswarm.db')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && /STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
});

// REGRESSION (P1): a raw inbox/store path QUOTED with double or single quotes is a
// completely normal, everyday shell pattern — it must block IDENTICALLY to the
// unquoted form. Previously the segment was neutralized (quoted content blanked to
// spaces) BEFORE path classification, so the quoted path argument became invisible
// to detectProtectedFileRead and the read sailed through (exit 0). Verified fixed:
// unquoted / double-quoted / single-quoted all now classify the SAME path text.
const QUOTE_FORMS = [
  ['unquoted', (p) => p],
  ['double-quoted', (p) => `"${p}"`],
  ['single-quoted', (p) => `'${p}'`],
];
for (const verb of ['cat', 'head', 'tail']) {
  for (const [label, quote] of QUOTE_FORMS) {
    test(`DEVSWARM FILE-READ BLOCK (regression): ${verb} of ${label} raw inbox ndjson`, () => {
      const r = runDevswarmFileRead((root) => `${verb} ${quote(pathx.join(root, 'inbox', 'w1.ndjson'))}`);
      assert.strictEqual(r.status, 2, `expected block for ${label} ${verb}\nstdout: ${r.stdout}`);
      assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
    });
    test(`DEVSWARM FILE-READ BLOCK (regression): ${verb} of ${label} raw store db`, () => {
      const r = runDevswarmFileRead((root) => `${verb} ${quote(pathx.join(root, 'store', 'devswarm.db'))}`);
      assert.strictEqual(r.status, 2, `expected block for ${label} ${verb}\nstdout: ${r.stdout}`);
      assert.ok(r.json && /STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
    });
  }
}

// ALLOW: reads of the ALLOW-taxonomy surfaces (summary/cursors/workspaces), both
// unquoted and double-quoted (the quoted form must resolve identically, not merely
// "not block" — it must classify the SAME non-protected path).
const FILE_READ_ALLOW = [
  (root) => `cat ${pathx.join(root, 'summary.json')}`,
  (root) => `cat ${pathx.join(root, 'cursors', 'x.cursor')}`,
  (root) => `cat ${pathx.join(root, 'workspaces', 'x.json')}`,
  (root) => `cat "${pathx.join(root, 'summary.json')}"`,
  (root) => `cat "${pathx.join(root, 'cursors', 'x')}"`,
];
for (let i = 0; i < FILE_READ_ALLOW.length; i++) {
  test(`DEVSWARM FILE-READ ALLOW (non-protected surface #${i})`, () => {
    const r = runDevswarmFileRead(FILE_READ_ALLOW[i]);
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

// ALLOW: quoted DATA that mentions the inbox path must NOT block — `echo` is not a
// read verb, and grep/sed/awk's first non-flag operand is a PATTERN/script (never
// classified as a path), so only a TRAILING file operand can trip the classifier.
test('DEVSWARM FILE-READ ALLOW: echo of a quoted inbox path (echo is not a read verb)', () => {
  const r = runDevswarmFileRead((root) => `echo "${pathx.join(root, 'inbox', 'x.ndjson')}"`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
test('DEVSWARM FILE-READ ALLOW: grep with a quoted bare-word PATTERN over a non-protected file', () => {
  const r = runDevswarmFileRead(() => `grep 'inbox' docs/KB.md`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
test('DEVSWARM FILE-READ ALLOW: grep with the literal inbox path AS THE PATTERN (not a file operand)', () => {
  const r = runDevswarmFileRead((root) => `grep -n '${pathx.join(root, 'inbox', 'x')}' docs/KB.md`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// Subagent context (agent_id in payload): the file-read branch fires in ALL contexts.
test('DEVSWARM FILE-READ BLOCK: inbox cat in SUBAGENT context (all-contexts)', () => {
  const h = makeHome();
  try {
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`, { agentId: 'sub' }), {
      home: h.home, env: DEVSWARM_COORD,
    });
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// SKIP: an explicit devswarm-read-guard skip allows the raw file read.
test('DEVSWARM FILE-READ SKIP: devswarm-read-guard skipped -> inbox cat allowed', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-read-guard': Date.now() + 60 * 60 * 1000 });
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`), { home: h.home, env: DEVSWARM_COORD });
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// GATE OFF: without DevSwarm active, a raw inbox cat is NOT the guard's concern -> allow.
test('DEVSWARM FILE-READ gate off: inbox cat allowed when DevSwarm inactive', () => {
  const h = makeHome();
  try {
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

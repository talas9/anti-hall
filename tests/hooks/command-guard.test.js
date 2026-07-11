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
//   - `read-messages`-> block ONLY with durable-layer evidence (ANTIHALL_DEVSWARM_INBOX_CMD
//                       set, OR a ~/.anti-hall/devswarm/workspaces/*.json descriptor
//                       with a truthy inboxPath); otherwise ALLOW (harmless single read).
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
// monitor blocks with no durable evidence; read-messages needs durable evidence.
const HIVECTL_BLOCK = [
  { cmd: 'hivecontrol workspace read-messages', env: DURABLE_ENV },
  { cmd: 'hivecontrol workspace monitor', env: {} }, // unconditional
  { cmd: 'bash -c "hivecontrol workspace read-messages"', env: DURABLE_ENV },
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

// Durable evidence via a workspace DESCRIPTOR (not env) also arms the read block.
test('DEVSWARM BLOCK read-messages when a descriptor has inboxPath', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', {}, {
    descriptor: { id: 'ws', worktreePath: '/x', sessionId: 's', inboxPath: '/x/inbox.jsonl' },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- SCOPING ---
test('DEVSWARM ALLOW read-messages with NO durable evidence (no env, no descriptor)', () => {
  const r = runDevswarm('hivecontrol workspace read-messages');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM SUBAGENT (agent_id) + monitor still blocks (all-contexts)', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, { agentId: 'x' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

const HIVECTL_ALLOW = [
  'hivecontrol workspace message-count',
  'hivecontrol workspace message-parent',
  'hivecontrol workspace message-child',
];
for (const cmd of HIVECTL_ALLOW) {
  test(`DEVSWARM ALLOW (non-destructive): ${cmd}`, () => {
    const r = runDevswarm(cmd);
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

// --- FIX 4: shell-obfuscation forms are ACCEPTED as NOT caught (drift-guard, not
// an adversary defense). These synthesize the verb/subcommand only after shell
// expansion; catching them needs full expansion simulation (out of scope). ---
const HIVECTL_ACCEPTED_OBFUSCATION = [
  "hiv'ec'ontrol workspace monitor",   // verb tokenizes as hiv'ec'ontrol, not hivecontrol
  "hivecontrol workspace 'mon'itor",   // subcommand split across quotes
];
for (const cmd of HIVECTL_ACCEPTED_OBFUSCATION) {
  test(`DEVSWARM accepted-limitation (obfuscation NOT caught, allows): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `documented accepted bypass should allow: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- FIX 2: whitespace-only inboxPath must NOT arm the read block ---
test('DEVSWARM ALLOW read-messages when descriptor inboxPath is whitespace-only', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', {}, {
    descriptor: { id: 'ws', inboxPath: '   ' },
  });
  assert.strictEqual(r.status, 0, `whitespace inboxPath is not evidence\nstdout: ${r.stdout}`);
});
test('DEVSWARM BLOCK read-messages when descriptor inboxPath is a real path', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', {}, {
    descriptor: { id: 'ws', inboxPath: '/real/path/inbox.jsonl' },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- FIX 1: descriptor scan must never wedge and must not be fooled into evidence
// by a non-regular / oversized candidate. Uses a custom HOME so we can plant a
// symlink or an oversized file where a descriptor would live. ---
function runDevswarmWithWorkspace(command, plant) {
  const h = makeHome();
  try {
    const wdir = pathx.join(h.antiHall, 'devswarm', 'workspaces');
    fsx.mkdirSync(wdir, { recursive: true });
    plant(wdir);
    return testHook(HOOK, bashPayload(command), {
      home: h.home,
      env: DEVSWARM_COORD,
    });
  } finally {
    h.cleanup();
  }
}

// A *.json descriptor that is a SYMLINK must be skipped (lstat, not followed) — so
// even though its target holds a valid inboxPath, it counts as NO evidence -> ALLOW.
// This is the fail-open-integrity guarantee (a symlink to /dev/zero would otherwise
// wedge the hook). Skipped on platforms where symlink creation is unavailable.
test('DEVSWARM FIX1: symlink descriptor is skipped (not followed) -> read-messages allows', (t) => {
  let symlinkOk = true;
  const r = runDevswarmWithWorkspace('hivecontrol workspace read-messages', (wdir) => {
    const target = pathx.join(wdir, 'real-target.txt');
    fsx.writeFileSync(target, JSON.stringify({ inboxPath: '/x/inbox.jsonl' }), 'utf8');
    try {
      fsx.symlinkSync(target, pathx.join(wdir, 'ws.json'));
    } catch (_) {
      symlinkOk = false; // e.g. Windows without privilege
    }
  });
  if (!symlinkOk) return t.skip('symlink creation unavailable on this platform');
  assert.strictEqual(r.status, 0, `symlink descriptor must not count as evidence\nstdout: ${r.stdout}`);
});

// An oversized (> 64 KB) *.json candidate is skipped before it is ever read, so a
// huge file cannot stall the scan nor (here) supply evidence -> ALLOW.
test('DEVSWARM FIX1: oversized descriptor is skipped -> read-messages allows', () => {
  const big = JSON.stringify({ inboxPath: '/x/inbox.jsonl', pad: 'x'.repeat(70 * 1024) });
  const r = runDevswarmWithWorkspace('hivecontrol workspace read-messages', (wdir) => {
    fsx.writeFileSync(pathx.join(wdir, 'ws.json'), big, 'utf8');
  });
  assert.strictEqual(r.status, 0, `oversized descriptor must be skipped\nstdout: ${r.stdout}`);
});

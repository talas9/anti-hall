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

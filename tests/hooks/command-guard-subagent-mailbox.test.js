'use strict';
// devswarm-subagent-mailbox-guard (command-guard.js PreToolUse Bash branch).
//
// Defect f0958b13fe2b (P0, field-measured by SkyCrew 2026-09-08): inside a
// DevSwarm child workspace, the child's OWN subagents ran
// `devswarm.js inbox pull <id> && ... inbox ack <id>` — each ack advanced the
// shared mailbox cursor so the workspace's own MAIN THREAD silently missed
// mail (155 executions across 120 subagent transcripts in one workspace;
// brief-level prohibitions proven non-mitigating). Only the main thread may
// own the mailbox — a subagent (Task-tool worker, agent_id in the payload)
// must never pull/ack/read/read-primary/tick the inbox or heartbeat.
//
// Fires on SUBAGENT context alone — independent of DevSwarm-active/child-
// workspace detection (an accidental subagent mailbox-touch is wrong even
// outside a recognized child workspace), and independent of coordinator
// status (command-guard's normal isCoordinator() gate is bypassed for this
// branch, same as devswarm-read-guard/devswarm-send-guard).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function runSubagent(command, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.skip) h.writeSkip(o.skip);
    return testHook(HOOK, bashPayload(command, { agentId: 'sub-1' }), {
      home: h.home,
      env: o.env || {},
    });
  } finally {
    h.cleanup();
  }
}

function runMainThread(command, env) {
  const h = makeHome();
  try {
    // No agent_id in the payload, no CLAUDE_CODE_ENTRYPOINT='agent_tool' ->
    // main-thread context (mirrors a child workspace's own cron tick / Monitor
    // turn, which must keep working).
    return testHook(HOOK, bashPayload(command), { home: h.home, env: env || {} });
  } finally {
    h.cleanup();
  }
}

// --- Cursor-advancing / mailbox-consuming verbs: blocked for a subagent ---
const SUBAGENT_BLOCK = [
  'node scripts/devswarm.js inbox ack ws1',
  'node scripts/devswarm.js inbox pull ws1 && node scripts/devswarm.js inbox ack ws1',
  // Marketplace-cache absolute path.
  'node /Users/x/.claude/plugins/cache/anti-hall/scripts/devswarm.js inbox pull ws1',
  'node scripts/devswarm.js inbox read ws1',
  'node scripts/devswarm.js inbox read-primary ws1',
  'node scripts/devswarm.js inbox tick ws1',
  'node scripts/devswarm.js heartbeat ws1 --summary "did a thing"',
  // Wave R3 C4 P2: reap-orphans writes cursors on reap (scripts/devswarm.js ~13396).
  'node scripts/devswarm.js reap-orphans',
  // Wave R3 C1 P0: `inbox messages ... --ack`/`--ack-as-owner` IS the
  // documented, cursor-advancing expansion of read-primary (SKILL.md), not
  // the safe non-acking form — must block regardless of flag position.
  'node scripts/devswarm.js inbox messages ws1 --unread --ack',
  'node scripts/devswarm.js inbox messages ws1 --ack-as-owner',
  'node scripts/devswarm.js inbox messages ws1 --ack --tail 5',
  // Wave R3 C2 P1: mesh read / roster --ack advance the broadcast cursor
  // (scripts/devswarm.js ~12332) unless peeked.
  'node scripts/devswarm.js mesh read',
  'node scripts/devswarm.js roster --ack',
  // Wave R3 Reviewer 1 P2: a valued flag BEFORE the verb must not bypass the
  // guard (the prior `(?:-\S+\s+)*` only skipped bare flags, so it broke the
  // match entirely at the flag's VALUE and let the whole command through).
  'node scripts/devswarm.js --session X inbox ack Y',
  'node scripts/devswarm.js --json inbox ack ws1',
  'node scripts/devswarm.js --repo /x inbox ack ws1',
  'node scripts/devswarm.js --flag=value inbox ack ws1',
  // Wave R3 item 12 (R4 Critic): register/archive advance cursors through
  // foldGroupIntoSurvivor — a subagent never legitimately registers or
  // archives a workspace.
  'node scripts/devswarm.js register ws1',
  'node scripts/devswarm.js archive ws1',
];
for (const cmd of SUBAGENT_BLOCK) {
  test(`SUBAGENT BLOCK (mailbox guard): ${cmd}`, () => {
    const r = runSubagent(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// --- Read-only / non-cursor-advancing verbs: stay allowed for a subagent ---
const SUBAGENT_ALLOW = [
  'node scripts/devswarm.js inbox count ws1',
  'node scripts/devswarm.js inbox messages ws1 --tail 5',
  'node scripts/devswarm.js send --to-primary --message-file /tmp/m.txt',
  // Wave R3: peeked/seq'd mesh reads and plain roster stay non-mutating.
  'node scripts/devswarm.js mesh read --peek',
  'node scripts/devswarm.js mesh read --seq 5',
  'node scripts/devswarm.js roster',
  // inbox count/messages variants with an ordinary (non-ack) flag are unaffected.
  'node scripts/devswarm.js inbox count ws1 --json',
  // Wave R3 item 12: register/archive's SIBLING verbs are separate and unaffected.
  'node scripts/devswarm.js register-primary',
  'node scripts/devswarm.js archive-request ws1',
  'node scripts/devswarm.js archive-ignore ws1',
  'node scripts/devswarm.js archive-unignore ws1',
  'node scripts/devswarm.js unarchive ws1',
];
for (const cmd of SUBAGENT_ALLOW) {
  test(`SUBAGENT ALLOW (mailbox guard): ${cmd}`, () => {
    const r = runSubagent(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- Main-thread (no subagent markers) stays allowed — cron tick / Monitor turns ---
test('MAIN THREAD allows inbox ack (owns the mailbox)', () => {
  const r = runMainThread('node scripts/devswarm.js inbox ack ws1');
  assert.strictEqual(r.status, 0, `expected allow for main thread\nstdout: ${r.stdout}`);
});

test('MAIN THREAD allows register (owns workspace lifecycle)', () => {
  const r = runMainThread('node scripts/devswarm.js register ws1');
  assert.strictEqual(r.status, 0, `expected allow for main thread\nstdout: ${r.stdout}`);
});

test('MAIN THREAD allows archive (owns workspace lifecycle)', () => {
  const r = runMainThread('node scripts/devswarm.js archive ws1');
  assert.strictEqual(r.status, 0, `expected allow for main thread\nstdout: ${r.stdout}`);
});

// Wave R3 P2 (Reviewer 4 + Critic): this guard must key off PAYLOAD markers
// only, not the env-only CLAUDE_CODE_ENTRYPOINT=agent_tool fallback — a
// DevSwarm child workspace's env is inherited by its entire process tree, so
// a leaked agent_tool value could otherwise permanently misclassify that
// workspace's own main-thread cron tick / Monitor wake as a subagent.
test('ENV-ONLY agent_tool + NO payload markers -> still ALLOWED (payload-only signal)', () => {
  const r = runMainThread('node scripts/devswarm.js inbox ack ws1', { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' });
  assert.strictEqual(r.status, 0, `expected allow — payload has no agent_id/agent_type\nstdout: ${r.stdout}`);
});

test('PAYLOAD markers present (agent_id) -> still BLOCKED regardless of env', () => {
  const r = runSubagent('node scripts/devswarm.js inbox ack ws1');
  assert.strictEqual(r.status, 2, `expected block — payload carries agent_id\nstdout: ${r.stdout}`);
});

// --- Overrides ---
test('OVERRIDE: env ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1 allows a subagent ack', () => {
  const r = runSubagent('node scripts/devswarm.js inbox ack ws1', {
    env: { ANTIHALL_ALLOW_SUBAGENT_MAILBOX: '1' },
  });
  assert.strictEqual(r.status, 0, `expected allow with env override\nstdout: ${r.stdout}`);
});

test('OVERRIDE: skip.json for devswarm-subagent-mailbox-guard allows a subagent ack', () => {
  const r = runSubagent('node scripts/devswarm.js inbox ack ws1', {
    skip: { 'devswarm-subagent-mailbox-guard': Date.now() + 15 * 60 * 1000 },
  });
  assert.strictEqual(r.status, 0, `expected allow with skip.json\nstdout: ${r.stdout}`);
});

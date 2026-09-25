'use strict';
// codex-jev-hooks-parity: five Jev-bearing Stop hooks are registered in BOTH
// plugins/anti-hall/hooks/hooks.json AND plugins/anti-hall/codex/hooks/
// hooks.json (+ codex/install-codex.js's ANTI_HALL_HOOKS) — confirmed by
// direct read of both manifests, not assumed. This file proves the RUNTIME
// half tests/hygiene/manifest-drift.test.js does not cover: each hook
// actually RUNS and FAILS OPEN (exit 0, no throw, no hang) against a
// Codex-shaped Stop payload — one carrying only the fields the Stop contract
// documents as platform-neutral (session_id, cwd, transcript_path), with NO
// Claude-Code-specific tool_name/tool_input fields a PostToolUse/PreToolUse
// hook would read. Per docs/KB-claude-codex.md §"Common keys" and
// docs/KB-codex-platform-hooks-plugins.md ("Matchers ... UserPromptSubmit and
// Stop ignore matchers"), Stop fires identically regardless of which tool
// surface (Claude Bash vs Codex shell) produced the transcript — there is no
// documented Codex-specific field-name variant for a Stop payload to assert
// against, so this deliberately does NOT invent one.
//
// Hooks covered (each already Codex-wired per both hooks.json files):
//   speculation-guard.js, speculation-judge.js, tasklist-guard.js,
//   claim-ledger.js, devswarm-parent-gate.js
//
// model-routing-guard.js and output-verify-guard.js are DELIBERATELY not
// covered here — both are genuinely Claude-only (see CLAUDE_ONLY_ALLOWLIST in
// tests/hygiene/manifest-drift.test.js): model-routing-guard reads
// tool_input.model/subagent_type/description/prompt off a PreToolUse
// Agent/Task-tool call, and Codex dispatches subagents through a separate
// SubagentStart/SubagentStop event (docs/KB-claude-codex.md §5.4;
// docs/KB-codex-platform-hooks-plugins.md "Hook events" row) with no
// pre-spawn tool_input payload to classify — there is no Codex trigger to
// wire. output-verify-guard reads a PostToolUse Bash tool_response whose
// exact shape is documented as unverified-on-Codex (see the hook's own
// FIELD-SHAPE CAVEAT); wiring a hook whose trigger shape is unproven on the
// target platform is exactly the "fake wiring" this task was told not to do.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOKS_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');

const HOOKS = [
  'speculation-guard.js',
  'speculation-judge.js',
  'tasklist-guard.js',
  'claim-ledger.js',
  'devswarm-parent-gate.js',
];

// A minimal Codex-shaped Stop payload: only the platform-neutral Stop
// fields, deliberately WITHOUT tool_name/tool_input (those are Claude
// Bash-tool-call artifacts a Stop hook has no business reading, and none of
// these five do — verified by grep against each file's own `payload.tool_*`
// reads: zero hits).
function codexStopPayload(home) {
  return {
    hook_event_name: 'Stop',
    session_id: 'codex-parity-t',
    cwd: home,
    transcript_path: path.join(home, 'nonexistent-transcript.jsonl'),
  };
}

for (const hook of HOOKS) {
  test(`${hook} runs against a Codex-shaped Stop payload and fails open (exit 0)`, () => {
    const h = makeHome();
    try {
      const r = testHook(hook, codexStopPayload(h.home), { home: h.home });
      assert.strictEqual(r.status, 0, `${hook} must exit 0 on a Codex-shaped Stop payload (fail-open), got ${r.status}. stderr: ${r.stderr}`);
      // No hard crash / uncaught-exception noise on stderr.
      assert.ok(!/Cannot read propert|is not a function|Unhandled/i.test(r.stderr || ''), `${hook} stderr looks like a crash, not a clean fail-open: ${r.stderr}`);
    } finally {
      h.cleanup && h.cleanup();
    }
  });
}

test('all five hooks in this file are registered in codex/hooks/hooks.json under Stop', () => {
  const fs = require('node:fs');
  const codexHooksJson = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, '..', 'codex', 'hooks', 'hooks.json'), 'utf8'));
  const stopFiles = new Set();
  for (const group of codexHooksJson.hooks.Stop || []) {
    for (const h of group.hooks || []) {
      const m = (h.command || '').match(/([A-Za-z0-9_.-]+\.js)"?\s*$/);
      if (m) stopFiles.add(m[1]);
    }
  }
  for (const hook of HOOKS) {
    assert.ok(stopFiles.has(hook), `${hook} expected in codex/hooks/hooks.json Stop group, found: ${[...stopFiles].join(', ')}`);
  }
});

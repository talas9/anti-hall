'use strict';
// model-routing-guard (PreToolUse Agent/Task — anti-waste routing). Covers the
// full decision table (rows 1/2-default/2-strict/3/4/5), the row-1 debate-role
// exemption modifier, strict-unconditional + no-parent-inference, classification
// edge cases (homoglyph/case, 128 KB bound, complex-anywhere veto), fail-open,
// the skip hatch, the hooks.json ORDER contract, and Agent vs Task tool shapes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'model-routing-guard.js';

// Build a PreToolUse Agent/Task payload. tool_name defaults to 'Agent'.
function payload(toolInput, { toolName = 'Agent' } = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput || {},
    session_id: 't',
    cwd: process.cwd(),
  };
}

// A blocked spawn: top-level decision:'block' + exit 2.
function assertBlock(r, reMsg) {
  assert.strictEqual(r.status, 2, `expected block exit 2; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', `expected decision block; json: ${JSON.stringify(r.json)}`);
  if (reMsg) assert.match(r.json.reason, reMsg);
}

// An advisory: nested hookSpecificOutput.additionalContext + exit 0, NOT a block.
function assertAdvisory(r, reCtx) {
  assert.strictEqual(r.status, 0, `expected advisory exit 0; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.hookSpecificOutput, `expected hookSpecificOutput; json: ${JSON.stringify(r.json)}`);
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!(r.json && r.json.decision === 'block'), 'advisory must not be a block');
  if (reCtx) assert.match(r.json.hookSpecificOutput.additionalContext, reCtx);
}

// A silent allow: exit 0, no JSON output (no decision, no hookSpecificOutput).
function assertSilentAllow(r) {
  assert.strictEqual(r.status, 0, `expected allow exit 0; stdout: ${r.stdout}`);
  assert.ok(r.json === null, `allow must be silent (no JSON); json: ${JSON.stringify(r.json)}`);
}

// ---------------------------------------------------------------- Row 1 BLOCK

test('ROW 1: mechanical-only + explicit fable + generic agent -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      description: 'fetch the data',
      prompt: 'curl the endpoint and download the dump, then tail the logs',
    }), { home: h.home });
    assertBlock(r, /execution-shaped task on a flagship model/);
    assert.match(r.json.reason, /haiku/);
    // Block reason must NOT advertise the skip hatch.
    assert.doesNotMatch(r.json.reason, /skip/i);
  } finally { h.cleanup(); }
});

test('ROW 1: mechanical-only + explicit opus + MISSING subagent_type -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'opus',
      // subagent_type omitted -> qualifies as generic
      prompt: 'run the build and run the tests, then git push',
    }), { home: h.home });
    assertBlock(r, /flagship model/);
    assert.match(r.json.reason, /opus/);
  } finally { h.cleanup(); }
});

// ----------------------------------------- Row 1 exemption modifier (advisory)

test('ROW 1 EXEMPT: role word in description downgrades BLOCK -> advisory (not silent)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      description: 'Round 1 Reviewer',
      prompt: 'fetch and grep the logs, run the build',
    }), { home: h.home });
    assertAdvisory(r, /debate-role exempt/);
  } finally { h.cleanup(); }
});

test('EXEMPTION SCOPE: role word in prompt (no complex token) does NOT exempt -> BLOCK', () => {
  const h = makeHome();
  try {
    // 'critic' is a role word but NOT a complex signal; placing it ONLY in the
    // prompt must not exempt. Description holds a pure mechanical phrase.
    const r = testHook(HOOK, payload({
      model: 'opus',
      subagent_type: 'general-purpose',
      description: 'download the export',
      prompt: 'as the critic, fetch and curl and tail the logs and git push',
    }), { home: h.home });
    assertBlock(r, /flagship model/);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------- Row 2 (omitted model)

// ROW 2: strict is now the DEFAULT (v0.35.0+). Advisory is the opt-out.

test('ROW 2 default (strict): mechanical-only + OMITTED model + generic -> BLOCK (default, no env needed)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      prompt: 'fetch and download the dump, tail the logs, git push',
    }), { home: h.home });
    // Strict is now the default — no env var needed to get a block.
    assertBlock(r, /strict.*default|default.*strict/);
    assert.match(r.json.reason, /haiku/);
  } finally { h.cleanup(); }
});

test('ROW 2 advisory opt-out: ANTIHALL_MODEL_ROUTING=advisory -> advisory (not a block)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      prompt: 'fetch and grep and tail the logs, run the build',
    }), { home: h.home, env: { ANTIHALL_MODEL_ROUTING: 'advisory' } });
    // advisory opt-out reverts omitted-model mechanical spawn to advisory-only.
    assertAdvisory(r, /omitted model inherits/);
  } finally { h.cleanup(); }
});

test('ROW 2 strict default: role words do NOT downgrade strict block (C5-2)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      description: 'Reviewer auditor critic',  // role words present
      prompt: 'fetch and download and tail the logs',
    }), { home: h.home });
    // 'review'/'audit'/'critique' are complex signals, but these exact role tokens
    // (reviewer/auditor/critic) are NOT in the complex list, so no complex veto.
    // Strict is now the default — block applies without any env var.
    assertBlock(r, /strict/);
  } finally { h.cleanup(); }
});

test('ROW 2 strict-is-default: no env var set -> BLOCK (variable absent = strict)', () => {
  const h = makeHome();
  try {
    // The spawn-hook helper gives an isolated env without ANTIHALL_MODEL_ROUTING —
    // verifies that strict fires without any explicit opt-in env var.
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      prompt: 'fetch and tail the logs, run the build',
    }), { home: h.home });
    assertBlock(r, /strict/);
  } finally { h.cleanup(); }
});

// ------------------------------------------------------- No-parent-inference (C5-4)

test('NO PARENT INFERENCE: strict block never opens ~/.claude.json (sentinel untouched)', () => {
  const h = makeHome();
  try {
    // Plant a sentinel ~/.claude.json under the fake HOME with a known mtime. If the
    // hook reads it, atime would change; we assert the file is never accessed by
    // comparing a content hash AND that no read mutated its stat in a detectable way.
    const claudeJson = path.join(h.home, '.claude.json');
    const sentinel = JSON.stringify({ SENTINEL: 'do-not-read', projects: {} });
    fs.writeFileSync(claudeJson, sentinel, 'utf8');
    const before = fs.statSync(claudeJson);

    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      prompt: 'fetch and download and tail the logs',
    }), { home: h.home });
    // Strict is the default — no env var needed.
    assertBlock(r, /strict/);
    // Content unchanged (never written) and present (never deleted).
    assert.strictEqual(fs.readFileSync(claudeJson, 'utf8'), sentinel);
    const after = fs.statSync(claudeJson);
    // mtime/ctime unchanged: the hook never touched the file in any way.
    assert.strictEqual(after.mtimeMs, before.mtimeMs);
    assert.strictEqual(after.ctimeMs, before.ctimeMs);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------- Row 3 (custom subagent_type)

test('ROW 3: mechanical-only + flagship + custom subagent_type -> advisory', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'opus',
      subagent_type: 'my-custom-fetcher',
      prompt: 'fetch and download the dump, tail the logs',
    }), { home: h.home });
    assertAdvisory(r, /custom subagent_type/);
  } finally { h.cleanup(); }
});

// ------------------------------------------------------------ Row 4 (complex+haiku)

test('ROW 4: complex signal + haiku -> advisory', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'haiku',
      subagent_type: 'general-purpose',
      description: 'plan and review the architecture',
      prompt: 'audit the design and validate the security model',
    }), { home: h.home });
    assertAdvisory(r, /planning-shaped/);
  } finally { h.cleanup(); }
});

// -------------------------------------------------------------- Row 5 (catch-all)

test('ROW 5: explicit haiku on mechanical -> silent allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'haiku',
      subagent_type: 'general-purpose',
      prompt: 'fetch and download the dump, tail the logs',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('ROW 5: explicit sonnet on mechanical -> silent allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'sonnet',
      prompt: 'run the build and git push',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('ROW 5: no signals at all -> silent allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      description: 'do the thing',
      prompt: 'handle whatever needs handling here',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('UNKNOWN MODEL token -> allow (forward-compat), even on mechanical task', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'some-future-tier',
      subagent_type: 'general-purpose',
      prompt: 'fetch and download and tail the logs',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------- COMPLEX-ANYWHERE veto

test('COMPLEX-ANYWHERE: a planning signal vetoes a flagship mechanical block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      description: 'fetch the data',
      // 'plan' is a complex signal -> never block (mixed signals).
      prompt: 'fetch and download, then plan the migration',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

// --------------------------------------------------- Homoglyph / case folding

test('HOMOGLYPH/CASE: fullwidth + uppercase mechanical tokens still classify -> BLOCK', () => {
  const h = makeHome();
  try {
    // 'ＦＥＴＣＨ' fullwidth (U+FF26...) NFKC-folds to 'fetch'; 'GREP' uppercases down.
    const r = testHook(HOOK, payload({
      model: 'opus',
      subagent_type: 'general-purpose',
      description: 'ＦＥＴＣＨ the data',
      prompt: 'GREP the files and TAIL the LOGS and GIT PUSH',
    }), { home: h.home });
    assertBlock(r, /flagship model/);
  } finally { h.cleanup(); }
});

test('WORD-BOUNDARY: substring of a mechanical token does NOT classify (e.g. "listen")', () => {
  const h = makeHome();
  try {
    // 'listen'/'listener' must NOT match the 'list' token (word-boundary matching).
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      description: 'set up a listener',
      prompt: 'the listener handles inbound connections quietly',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------------- 128 KB bound

test('128 KB BOUND: mechanical token PAST the scan limit is not seen -> allow', () => {
  const h = makeHome();
  try {
    // Fill past 128 KB with a neutral filler, then place 'fetch' AFTER the cap.
    const filler = 'x '.repeat(70 * 1024); // ~140 KB of harmless tokens
    const r = testHook(HOOK, payload({
      model: 'opus',
      subagent_type: 'general-purpose',
      description: 'neutral header',
      prompt: filler + ' fetch download tail logs git push',
    }), { home: h.home });
    // The mechanical tokens sit beyond the 128 KB scan window, so no signal -> allow.
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('128 KB BOUND: mechanical token WITHIN the limit IS seen -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'opus',
      subagent_type: 'general-purpose',
      description: 'fetch and download the dump',
      prompt: 'x '.repeat(70 * 1024),
    }), { home: h.home });
    assertBlock(r, /flagship model/);
  } finally { h.cleanup(); }
});

// -------------------------------------------------------------------- Fail-open

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json === null, 'malformed stdin must not emit a block');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: non-string field types -> exit 0 (typeof guards)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 123,            // not a string
      subagent_type: ['x'],  // not a string
      description: { a: 1 },  // not a string
      prompt: null,          // not a string
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- Skip hatch

test('SKIP-HATCH: skip.json {model-routing-guard: future} -> allow even on row-1 case', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'model-routing-guard': Date.now() + 600000 });
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      prompt: 'fetch and download and tail the logs',
    }), { home: h.home });
    assert.strictEqual(r.status, 0, `skip must suppress the block; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `json: ${JSON.stringify(r.json)}`);
  } finally { h.cleanup(); }
});

// --------------------------------------------------------- Agent vs Task shapes

test('TASK tool_name: row-1 case blocks identically to Agent', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      model: 'fable',
      subagent_type: 'general-purpose',
      prompt: 'fetch and download and tail the logs and git push',
    }, { toolName: 'Task' }), { home: h.home });
    assertBlock(r, /flagship model/);
  } finally { h.cleanup(); }
});

test('AGENT tool_name: row-2 default strict -> BLOCK (strict is now default)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      prompt: 'fetch and download and tail the logs',
    }, { toolName: 'Agent' }), { home: h.home });
    // Strict is now the default — omitted-model mechanical spawn on Agent tool -> BLOCK.
    assertBlock(r, /strict/);
  } finally { h.cleanup(); }
});

// ------------------------------------------------------------ Row 6 (Explore advisory)

test('ROW 6 (a): research-shaped + general-purpose + no model -> advisory mentions Explore', () => {
  const h = makeHome();
  try {
    // No mechanical signals -> Row 2 (strict) does NOT fire (isMechanicalOnly=false).
    // No complex signals -> Row 4 does NOT fire. Row 6 fires on "investigate"+"find".
    const r = testHook(HOOK, payload({
      subagent_type: 'general-purpose',
      description: 'investigate the codebase structure',
      prompt: 'research and find all usages of the deprecated API, then gather results',
    }), { home: h.home });
    assertAdvisory(r, /Explore/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /AGENT-ROUTING/);
  } finally { h.cleanup(); }
});

test('ROW 6 (b): research-shaped + Explore subagent_type -> NO advisory (silent allow)', () => {
  const h = makeHome();
  try {
    // Explore is a named/custom type (isGenericAgent=false) -> Row 6 skips entirely.
    const r = testHook(HOOK, payload({
      model: 'haiku',
      subagent_type: 'Explore',
      description: 'investigate the codebase structure',
      prompt: 'search and find all usages of the deprecated API',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('ROW 6 (c): non-research task + general-purpose -> NO Explore advisory', () => {
  const h = makeHome();
  try {
    // "implement"/"write"/"add" are not research keywords -> RESEARCH_RE won't match.
    const r = testHook(HOOK, payload({
      model: 'sonnet',
      subagent_type: 'general-purpose',
      description: 'implement the new feature',
      prompt: 'write the code to add user authentication with JWT tokens',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('ROW 6 (d): research-shaped + codex:codex-rescue -> NO advisory', () => {
  const h = makeHome();
  try {
    // codex:codex-rescue is a named/custom type (isGenericAgent=false) -> Row 6 skips.
    const r = testHook(HOOK, payload({
      model: 'sonnet',
      subagent_type: 'codex:codex-rescue',
      description: 'investigate and research the bug',
      prompt: 'scout the codebase to locate the failing module',
    }), { home: h.home });
    assertSilentAllow(r);
  } finally { h.cleanup(); }
});

test('ROW 6 (f): pure research spawn + general-purpose -> STILL nudges Explore', () => {
  const h = makeHome();
  try {
    // Only research keywords, no write/execute signals -> advisory fires as before.
    const r = testHook(HOOK, payload({
      model: 'sonnet',
      subagent_type: 'general-purpose',
      description: 'research X, find Y, report findings',
      prompt: 'investigate the codebase, search for usages, gather results and report',
    }), { home: h.home });
    assertAdvisory(r, /Explore/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /AGENT-ROUTING/);
  } finally { h.cleanup(); }
});

test('ROW 6 (g): research+write spawn + general-purpose -> NO Explore nudge (WRITE_RE suppresses)', () => {
  const h = makeHome();
  try {
    // "audit"+"find" are research signals, but "commit"+"release" are write signals ->
    // WRITE_RE suppresses the Row-6 advisory (Explore can't write/commit).
    const r = testHook(HOOK, payload({
      model: 'sonnet',
      subagent_type: 'general-purpose',
      description: 'audit the diff then commit the fix and release',
      prompt: 'find the changed files, apply the patch, commit, tag, and push the release',
    }), { home: h.home });
    // Must NOT emit an Explore advisory.
    assert.strictEqual(r.status, 0);
    if (r.json && r.json.hookSpecificOutput) {
      assert.doesNotMatch(
        r.json.hookSpecificOutput.additionalContext,
        /Explore/,
        'WRITE_RE should suppress the Explore advisory when write signals are present',
      );
    }
  } finally { h.cleanup(); }
});

test('ROW 6 (e): FAIL-OPEN: null tool_input on research corpus -> exit 0', () => {
  const h = makeHome();
  try {
    // Malformed payload (tool_input: null) must not throw — fail-open per contract.
    const r = testHookRaw(HOOK, JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: null,
    }), { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------- hooks.json ORDER

test('ORDER: model-routing-guard is FIRST (before swarm-guard) in BOTH Agent and Task', () => {
  const hooksJson = path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'hooks.json',
  );
  const cfg = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
  const pre = cfg.hooks.PreToolUse;
  for (const matcher of ['Agent', 'Task']) {
    const entry = pre.find((e) => e.matcher === matcher);
    assert.ok(entry, `missing ${matcher} matcher`);
    const cmds = entry.hooks.map((hk) => hk.command);
    const idxRouting = cmds.findIndex((c) => c.includes('model-routing-guard.js'));
    const idxSwarm = cmds.findIndex((c) => c.includes('swarm-guard.js'));
    assert.ok(idxRouting >= 0, `${matcher}: model-routing-guard not present`);
    assert.ok(idxSwarm >= 0, `${matcher}: swarm-guard not present`);
    assert.strictEqual(idxRouting, 0, `${matcher}: model-routing-guard must be FIRST`);
    assert.ok(idxRouting < idxSwarm, `${matcher}: model-routing-guard must precede swarm-guard`);
  }
});

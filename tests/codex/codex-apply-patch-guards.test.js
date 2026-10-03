'use strict';
// Codex apply_patch wiring for edit-guard, api-guard (blocking path) and
// ship-it-guard (existence gate). Payload shape is the one captured from
// codex-cli 0.160.0: { tool_name: 'apply_patch', tool_input: { command: <patch> },
// cwd, session_id, turn_id, model, permission_mode, ... } with agent_id/agent_type
// present ONLY inside a spawned subagent.
//
// Every run uses the controlled spawn-hook env (no CLAUDE_CODE_ENTRYPOINT), which
// is what a native Codex hook process sees.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function patch(...hunks) { return ['*** Begin Patch', ...hunks, '*** End Patch'].join('\n'); }
function add(p, ...lines) { return ['*** Add File: ' + p, ...(lines.length ? lines : ['x']).map((l) => '+' + l)].join('\n'); }

function codexPayload(command, cwd, extra) {
  return Object.assign({
    session_id: 'codex-sess', turn_id: 'turn-1', transcript_path: null, cwd,
    hook_event_name: 'PreToolUse', model: 'gpt-5.5', permission_mode: 'default',
    tool_name: 'apply_patch', tool_input: { command }, tool_use_id: 'call_1',
  }, extra || {});
}
const SUB = { agent_id: '01a102e5-9d51-7063-9dd8-8bda5c51b741', agent_type: 'executor' };

function withRepo(fn) {
  const h = makeHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-repo-'));
  try { return fn(h.home, repo); } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    h.cleanup();
  }
}

// ---------------------------------------------------------------- edit-guard
const EG = 'edit-guard.js';
function eg(home, payload, env) { return testHook(EG, payload, { home, env: env || {} }); }

// Codex honors exit 2 ONLY with the reason on stderr; stdout JSON is parsed only
// on exit 0 (codex-rs/hooks/src/events/pre_tool_use.rs, rust-v0.160.0: exit 2 with
// empty stderr -> "did not write a blocking reason to stderr", tool call proceeds).
// A live codex exec run confirmed the stdout-only block was ignored.
function assertCodexBlock(r) {
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(r.stderr.trim().length > 0, 'Codex needs the block reason on stderr');
  if (r.json && r.json.reason) assert.strictEqual(r.stderr.trim(), r.json.reason.trim());
}

test('edit-guard: Codex main thread apply_patch on a source file -> BLOCK', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('src/app.js')), repo));
  assertCodexBlock(r);
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /EDIT-DELEGATION RULE/);
  assert.match(r.json.reason, /\(tool: apply_patch\)/);
}));

test('edit-guard: Codex subagent (agent_id in payload) -> ALLOW', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('src/app.js')), repo, SUB));
  assert.strictEqual(r.status, 0, r.stdout);
}));

test('edit-guard: Codex main thread under a Claude Code process (CLAUDE_CODE_ENTRYPOINT set) -> ALLOW (delegated worker)', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('src/app.js')), repo), { CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.strictEqual(r.status, 0, r.stdout);
}));

test('edit-guard: Codex main thread, allowlisted path with a space -> ALLOW', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('.anti-hall/history/my notes.md')), repo));
  assert.strictEqual(r.status, 0, r.stdout);
}));

test('edit-guard: multi-file patch, one allowlisted + one source -> BLOCK', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('.anti-hall/history/n.md'), add('lib/x.js')), repo));
  assertCodexBlock(r);
}));

test('edit-guard: Update of an allowlisted file with Move to a source path -> BLOCK', () => withRepo((home, repo) => {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'a.md'), 'a\n');
  const r = eg(home, codexPayload(patch('*** Update File: .anti-hall/a.md\n*** Move to: src/a.js\n@@\n-a\n+b'), repo));
  assertCodexBlock(r);
}));

test('edit-guard: ../ traversal out of the repo -> BLOCK', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('../escape.js')), repo));
  assertCodexBlock(r);
}));

test('edit-guard: ../ traversal dressed as an allowlisted dir does not slip through', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload(patch(add('.anti-hall/../src/evil.js')), repo));
  assertCodexBlock(r);
}));

test('edit-guard: malformed patch on the main thread -> BLOCK (fail closed)', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload('*** Begin Patch\n*** Add File: .anti-hall/x.md\n+x', repo));
  assertCodexBlock(r);
  assert.match(r.json.reason, /could not parse/i);
}));

test('edit-guard: missing command on the main thread -> BLOCK (fail closed)', () => withRepo((home, repo) => {
  const p = codexPayload('', repo); p.tool_input = {};
  const r = eg(home, p);
  assertCodexBlock(r);
}));

test('edit-guard: malformed patch in a subagent -> ALLOW (Codex rejects it anyway)', () => withRepo((home, repo) => {
  const r = eg(home, codexPayload('not a patch', repo, SUB));
  assert.strictEqual(r.status, 0, r.stdout);
}));

test('edit-guard: launcher dir is denied even in a Codex subagent', () => withRepo((home, repo) => {
  const target = path.join(home, '.anti-hall', 'bin', 'anti-hall-update');
  const r = eg(home, codexPayload(patch(add(target)), repo, SUB));
  assertCodexBlock(r);
  assert.match(r.json.reason, /launcher/);
}));

test('edit-guard: plan mode allows a doc, still blocks source', () => withRepo((home, repo) => {
  const doc = eg(home, codexPayload(patch(add('notes/design.md')), repo, { permission_mode: 'plan' }));
  assert.strictEqual(doc.status, 0, doc.stdout);
  const src = eg(home, codexPayload(patch(add('scripts/x.js')), repo, { permission_mode: 'plan' }));
  assertCodexBlock(src);
}));

// ----------------------------------------------------------------- api-guard
const AG = 'api-guard.js';

test('api-guard: apply_patch Add File with a fabricated JS API -> BLOCK', () => withRepo((home, repo) => {
  const r = testHook(AG, codexPayload(patch(add('a.js', "const b = Buffer.fromString('x');")), repo), { home });
  assertCodexBlock(r);
  assert.match(r.json.reason, /fromString/);
}));

test('api-guard: Update hunk checks only added lines; language follows Move to', () => withRepo((home, repo) => {
  const bad = testHook(AG, codexPayload(patch("*** Update File: a.txt\n*** Move to: b.js\n@@\n-old\n+const b = Buffer.fromString('x');"), repo), { home });
  assertCodexBlock(bad);
  const ctxOnly = testHook(AG, codexPayload(patch("*** Update File: b.js\n@@\n const b = Buffer.fromString('x');\n-old\n+const ok = 1;"), repo), { home });
  assert.strictEqual(ctxOnly.status, 0, ctxOnly.stdout);
}));

test('api-guard: real API via apply_patch -> ALLOW', () => withRepo((home, repo) => {
  const r = testHook(AG, codexPayload(patch(add('a.js', "const b = Buffer.from('x');")), repo), { home });
  assert.strictEqual(r.status, 0, r.stdout);
}));

test('api-guard: malformed apply_patch -> ALLOW (fail open)', () => withRepo((home, repo) => {
  const r = testHook(AG, codexPayload("*** Begin Patch\n*** Add File: a.js\n+Buffer.fromString('x')", repo), { home });
  assert.strictEqual(r.status, 0, r.stdout);
}));

// ------------------------------------------------------------- ship-it-guard
const SG = 'ship-it-guard.js';
const ON = { ANTIHALL_SHIPIT_GATE: '1' };

test('ship-it-guard: ON + apply_patch on a hard-risk path + no PLAN.md -> BLOCK', () => withRepo((home, repo) => {
  const r = testHook(SG, codexPayload(patch(add('README.md'), add('db/migrations/001_init.sql')), repo), { home, env: ON });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ship-it gate/);
  assert.match(r.stderr, /001_init\.sql/);
}));

test('ship-it-guard: hard-risk Move to destination is gated too', () => withRepo((home, repo) => {
  const r = testHook(SG, codexPayload(patch('*** Update File: x.js\n*** Move to: auth/x.js\n@@\n+y'), repo), { home, env: ON });
  assert.strictEqual(r.status, 2, r.stderr);
}));

test('ship-it-guard: OFF (default) -> no-op on apply_patch', () => withRepo((home, repo) => {
  const r = testHook(SG, codexPayload(patch(add('db/migrations/001.sql')), repo), { home });
  assert.strictEqual(r.status, 0, r.stderr);
}));

test('ship-it-guard: PLAN.md present -> ALLOW with no conformance advisory (Claude-only by design)', () => withRepo((home, repo) => {
  fs.writeFileSync(path.join(repo, 'PLAN.md'), '# Plan\n\n## Phases\n\n### Phase 1: x\n- files: other/thing.js\n');
  const r = testHook(SG, codexPayload(patch(add('db/migrations/001.sql'), add('src/unrelated.js')), repo), { home, env: ON });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '');
}));

test('ship-it-guard: malformed apply_patch -> ALLOW (fail open)', () => withRepo((home, repo) => {
  const r = testHook(SG, codexPayload('*** Begin Patch\n*** Add File: db/migrations/1.sql\n+x', repo), { home, env: ON });
  assert.strictEqual(r.status, 0, r.stderr);
}));

'use strict';
// graphify-guard (PreToolUse Grep/Glob/Bash — graph-first enforcement).
//
// CONTRACT (from plugins/anti-hall/hooks/graphify-guard.js):
//   - Fires ONLY when a graphify graph exists at the payload cwd (or git toplevel):
//     a `graphify-out/` dir or a `.planning/graphs/` dir (findGraphRoot ~:68).
//   - Gated calls: Grep tool (any), Glob tool (any), and Bash whose command is a
//     code-nav search (rg/grep/ag/find/ack/git grep/git log --grep|-S|-G), incl.
//     `bash -c "rg foo"` unwrap and `$(rg foo)` substitution (isCodeNavBashCommand).
//   - `/graphify` is exempt as the EFFECTIVE verb of a segment (isGraphifyBashCommand);
//     `echo /graphify && rg secret` is NOT exempt (the rg segment still gates).
//   - LOOP SAFETY: blocks ONCE per session+graphRoot. Marker written to
//     ~/.anti-hall/graphify-guard-<sha1(session|root)[:20]> BEFORE blocking, so the
//     SECOND identical call in the same session is allowed (exit 0).
//   - Skip hatch: isSkipped('graphify-guard') (~:275) -> exit 0.
//   - Block: stdout {decision:'block', reason:'GRAPHIFY-FIRST: ...'}, exit 2.
//   - sanitizePath (~:250) strips C0/C1 control + bidi from the reflected graph
//     path and truncates to 80 chars + '…'.
//
// ISOLATION: each test gets a FRESH fake HOME (makeHome) so the once-per-session
// marker dir (~/.anti-hall) is empty, AND a FRESH temp cwd holding the graph dir.
// The temp cwd lives under os.tmpdir() (not a git repo) so findGraphRoot resolves
// graphRoot == cwd deterministically. A unique session_id per test adds belt-and-
// suspenders separation of the marker key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'graphify-guard.js';

// makeCwd({ graph, root }) -> { cwd, cleanup }
//   graph: 'graphify-out' | '.planning/graphs' | null (no graph -> hook no-ops)
//   root:  optional explicit project-root dir name (for sanitize tests).
function makeCwd(graph, rootName) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-gg-'));
  const cwd = rootName ? path.join(base, rootName) : base;
  fs.mkdirSync(cwd, { recursive: true });
  if (graph) fs.mkdirSync(path.join(cwd, graph), { recursive: true });
  return {
    cwd,
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} },
  };
}

let sessionSeq = 0;
function payload(toolName, toolInput, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: 'gg-sess-' + (sessionSeq++) + '-' + Math.random().toString(36).slice(2),
    cwd,
  };
}

function run(toolName, toolInput, { graph = 'graphify-out', rootName = null, skip = null } = {}) {
  const h = makeHome();
  const c = makeCwd(graph, rootName);
  try {
    if (skip !== null) h.writeSkip(skip);
    const r = testHook(HOOK, payload(toolName, toolInput, c.cwd), { home: h.home });
    return { ...r, home: h.home, cwd: c.cwd };
  } finally {
    h.cleanup();
    c.cleanup();
  }
}

const future = () => Date.now() + 600000;

// ---------------------------------------------------------------------------
// 1. Graph EXISTS + gated code-nav Bash -> FIRST blocks, SECOND (same session) allows.
// ---------------------------------------------------------------------------
test('graph exists + `rg foo`: FIRST call blocks (exit 2, decision block, GRAPHIFY-FIRST reason)', () => {
  // Drive BOTH calls against the SAME home + cwd + session so the marker logic is
  // genuinely exercised across calls (not two independent fresh-home runs).
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'once-per-session-1';
  try {
    const pl = () => ({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    });

    const first = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(first.status, 2, `FIRST must block; stdout=${first.stdout}`);
    assert.ok(first.json && first.json.decision === 'block', 'decision:block expected');
    assert.match(first.json.reason, /^GRAPHIFY-FIRST: this project has a knowledge graph/);
    assert.match(first.json.reason, /this block fires only once per session/);

    const second = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(second.status, 0, `SECOND identical call must allow; stdout=${second.stdout}`);
    assert.strictEqual(second.json, null, 'SECOND must not emit a block payload');
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. No graph -> never blocks.
// ---------------------------------------------------------------------------
test('no graph present + `rg foo`: allow (exit 0)', () => {
  const r = run('Bash', { command: 'rg foo' }, { graph: null });
  assert.strictEqual(r.status, 0, `no graph must allow; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('no graph present + Grep tool: allow (exit 0)', () => {
  const r = run('Grep', { pattern: 'foo' }, { graph: null });
  assert.strictEqual(r.status, 0, `no graph must allow; stdout=${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 3. Skip hatch overrides the block even with graph + gated cmd.
// ---------------------------------------------------------------------------
test('skip.json {graphify-guard: future} + graph + `rg foo`: allow (exit 0, override)', () => {
  const r = run('Bash', { command: 'rg foo' }, { skip: { 'graphify-guard': future() } });
  assert.strictEqual(r.status, 0, `skip must override block; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null, 'skipped guard must not emit a block payload');
});

// ---------------------------------------------------------------------------
// 4. Grep / Glob tool calls are ALWAYS gated (toolName Grep/Glob => isSearch=true).
// ---------------------------------------------------------------------------
test('graph exists + Grep tool: blocks (exit 2)', () => {
  const r = run('Grep', { pattern: 'secret' });
  assert.strictEqual(r.status, 2, `Grep must block when graph exists; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
  assert.match(r.json.reason, /Raw search \(Grep\) is allowed/);
});

test('graph exists + Glob tool: blocks (exit 2)', () => {
  const r = run('Glob', { pattern: '**/*.js' });
  assert.strictEqual(r.status, 2, `Glob must block when graph exists; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
  assert.match(r.json.reason, /Raw search \(Glob\) is allowed/);
});

// graph exists + a NON-search Bash command -> not gated -> allow.
test('graph exists + non-search Bash `ls -la`: allow (exit 0, not code-nav)', () => {
  const r = run('Bash', { command: 'ls -la' });
  assert.strictEqual(r.status, 0, `non-search Bash must allow; stdout=${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 5. /graphify exemption — and proof it is NOT fooled by a substring.
// ---------------------------------------------------------------------------
test('graph exists + `/graphify query "x"` Bash: exempt -> allow (exit 0)', () => {
  const r = run('Bash', { command: '/graphify query "where is auth"' });
  assert.strictEqual(r.status, 0, `/graphify must be exempt; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('graph exists + `echo /graphify && rg secret`: NOT exempt -> blocks (exit 2)', () => {
  const r = run('Bash', { command: 'echo /graphify && rg secret' });
  assert.strictEqual(r.status, 2, `/graphify as a non-verb substring must NOT exempt; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

// ---------------------------------------------------------------------------
// 6. Nested code-nav detection: bash -c "rg foo" and $(rg foo).
// ---------------------------------------------------------------------------
test('graph exists + `bash -c "rg foo"`: unwrapped -> blocks (exit 2)', () => {
  const r = run('Bash', { command: 'bash -c "rg foo"' });
  assert.strictEqual(r.status, 2, `bash -c payload must be detected; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('graph exists + `echo "$(rg foo)"`: command-substitution -> blocks (exit 2)', () => {
  const r = run('Bash', { command: 'echo "$(rg foo)"' });
  assert.strictEqual(r.status, 2, `$(...) substitution must be detected; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

// ---------------------------------------------------------------------------
// 7. sanitizePath reflected-reason hardening.
// ---------------------------------------------------------------------------
test('reflected graph path with control + bidi chars: reason is sanitized (no raw control/bidi)', () => {
  // Root name carries a C0 control char (\x07 bell) and a bidi override (U+202E).
  // sanitizePath replaces C0/C1 with space and strips bidi entirely, so the
  // reflected reason must contain NEITHER the raw control char NOR the bidi char.
  const rootName = 'proj\x07x‮evil';
  const r = run('Grep', { pattern: 'x' }, { rootName });
  assert.strictEqual(r.status, 2, `should still block; stdout=${r.stdout}`);
  const reason = r.json.reason;
  assert.ok(!/[\x00-\x1F\x7F-\x9F]/.test(reason), 'reason must contain no raw C0/C1 control chars');
  assert.ok(!/[‪-‮⁦-⁩]/.test(reason), 'reason must contain no raw bidi override/isolate chars');
  // The visible non-control letters of the path survive (proof the path is reflected).
  assert.match(reason, /projxevil|proj xevil/);
});

test('reflected graph path > 80 chars: truncated with ellipsis in reason', () => {
  // Build a project root whose graphify-out path comfortably exceeds 80 chars so
  // sanitizePath truncates to 80 + '…'.
  const rootName = 'r'.repeat(140);
  const r = run('Grep', { pattern: 'x' }, { rootName });
  assert.strictEqual(r.status, 2, `should still block; stdout=${r.stdout}`);
  const reason = r.json.reason;
  assert.match(reason, /…/, 'truncated path must carry the ellipsis');
  // No single reflected path run should exceed 81 chars (80 + ellipsis).
  // Pull the quoted graph-dir path and assert it is capped.
  const m = reason.match(/knowledge graph at "([^"]*)"/);
  assert.ok(m, 'graph path is quoted in reason');
  assert.ok(m[1].length <= 81, `reflected path must be capped (<=81), got ${m[1].length}`);
  assert.ok(m[1].endsWith('…'), 'capped path ends with ellipsis');
});

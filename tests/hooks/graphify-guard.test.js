'use strict';
// graphify-guard (PreToolUse Grep/Glob/Bash — graph-first enforcement).
//
// CONTRACT (from plugins/anti-hall/hooks/graphify-guard.js):
//   - Fires ONLY when a graphify graph exists at the payload cwd (or git toplevel):
//     a `graphify-out/` dir (findGraphRoot ~:68). (`.planning/graphs/` — a GSD-adjacent
//     fallback — was removed 2026-07-03; GSD is discontinued.)
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
const crypto = require('node:crypto');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'graphify-guard.js';

// Replicates graphify-guard.js's getSessionGraphKey() exactly, so tests can
// pre-seed / locate the marker file directly (for re-arm tests that need to
// control marker CONTENTS, not just observe block/allow behavior).
function markerKeyFor(sessionId, graphRoot) {
  return crypto.createHash('sha1').update(String(sessionId) + '|' + String(graphRoot))
    .digest('hex').slice(0, 20);
}

// makeCwd({ graph, root }) -> { cwd, cleanup }
//   graph: 'graphify-out' | null (no graph -> hook no-ops)
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
    assert.match(first.json.reason, /this nudge re-arms after ~240KB of transcript growth/);

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
  // win32: control chars and U+202x are ILLEGAL in filenames (mkdir throws
  // ENOENT), so a directory whose NAME carries them cannot exist on Windows —
  // skip there. The sanitize-on-reflect logic is OS-independent and fully
  // exercised on POSIX.
  if (process.platform === 'win32') return;
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

// ---------------------------------------------------------------------------
// 8. Subagent-awareness: session_id is IDENTICAL between a coordinator and any
//    Task-tool subagent it spawns (verified empirically — see the hook's
//    COORDINATOR-ONLY header comment). Without isSubagent() gating, a
//    delegated subagent's OWN first code-nav search would silently burn the
//    COORDINATOR's one-time marker. Both discriminators from isSubagent() are
//    covered: agent_id in the payload, and CLAUDE_CODE_ENTRYPOINT=agent_tool.
// ---------------------------------------------------------------------------
test('subagent payload (agent_id set): search allowed, and does NOT consume the coordinator marker', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'subagent-sess-1';
  try {
    const subagentPl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
      agent_id: 'agent-123',
    };
    const coordPl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    };

    // Subagent call FIRST: must allow, must not write the marker.
    const sub = testHook(HOOK, subagentPl, { home: h.home });
    assert.strictEqual(sub.status, 0, `subagent call must allow; stdout=${sub.stdout}`);
    assert.strictEqual(sub.json, null, 'subagent call must not emit a block payload');

    // Coordinator call SECOND, SAME session_id: must still block (the
    // subagent's search did not consume the coordinator's one-time marker).
    const coord = testHook(HOOK, coordPl, { home: h.home });
    assert.strictEqual(coord.status, 2, `coordinator must still block; stdout=${coord.stdout}`);
    assert.ok(coord.json && coord.json.decision === 'block');
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('subagent via CLAUDE_CODE_ENTRYPOINT=agent_tool env: search allowed, coordinator marker untouched', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'subagent-sess-2';
  try {
    const pl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    };
    const sub = testHook(HOOK, pl, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' } });
    assert.strictEqual(sub.status, 0, `agent_tool entrypoint must allow; stdout=${sub.stdout}`);
    assert.strictEqual(sub.json, null);

    // Coordinator call SECOND, same session, NO agent markers/entrypoint: must
    // still block (proves the subagent call above never touched the marker).
    const coord = testHook(HOOK, pl, { home: h.home });
    assert.strictEqual(coord.status, 2, `coordinator must still block; stdout=${coord.stdout}`);
    assert.ok(coord.json && coord.json.decision === 'block');
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Re-arm: the marker must EXPIRE (not block forever, and not stay silent
//    forever) once EITHER trigger passes — transcript growth >= 240KB since
//    the marker was written, OR 2h of wall-clock time. Growth is exercised via
//    a real transcript file (payload.transcript_path) whose byte size the hook
//    stats directly; wall-clock is exercised by pre-seeding the marker file
//    (via markerKeyFor) with a controlled writtenAt, since real elapsed time
//    can't be faked in a spawned child process.
// ---------------------------------------------------------------------------

function makeTranscriptFile(dir, sizeBytes) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, 'x'.repeat(sizeBytes), 'utf8');
  return p;
}

function growTranscriptFile(p, extraBytes) {
  fs.appendFileSync(p, 'y'.repeat(extraBytes), 'utf8');
}

test('RE-ARM (growth): marker expires and re-blocks after transcript grows >= 240KB since last write', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'rearm-growth-1';
  const tp = makeTranscriptFile(h.home, 1000);
  try {
    const pl = () => ({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
      transcript_path: tp,
    });

    // 1st call: no marker yet -> blocks, records transcriptSize=1000.
    const first = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(first.status, 2, `first must block; stdout=${first.stdout}`);

    // 2nd call, SAME transcript size: marker fresh, no growth -> allow.
    const second = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(second.status, 0, `second (no growth) must allow; stdout=${second.stdout}`);

    // Grow the transcript by > 240KB (the REARM_GROWTH_BYTES threshold).
    growTranscriptFile(tp, 260 * 1024);

    // 3rd call: growth trigger fires -> re-arm -> blocks again.
    const third = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(third.status, 2, `third (grown >=240KB) must re-block; stdout=${third.stdout}`);
    assert.ok(third.json && third.json.decision === 'block');

    // 4th call, SAME (now-grown) size again: proves the marker was actually
    // REFRESHED with the new size baseline (not stuck comparing against the
    // stale 1000-byte baseline, which would spuriously re-block forever).
    const fourth = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(fourth.status, 0, `fourth (post-rearm, no further growth) must allow; stdout=${fourth.stdout}`);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('RE-ARM (wall-clock fallback): stale marker (>2h old, transcript size unknown) re-arms and blocks', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'rearm-clock-stale';
  try {
    const key = markerKeyFor(sess, c.cwd);
    const staleWrittenAt = Date.now() - (3 * 60 * 60 * 1000); // 3h ago > 2h TTL
    h.writeState('graphify-guard-' + key, JSON.stringify({ writtenAt: staleWrittenAt, transcriptSize: -1 }));

    // No transcript_path -> size unknown on both sides -> growth trigger can't
    // fire -> must fall back to the wall-clock trigger.
    const pl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    };
    const r = testHook(HOOK, pl, { home: h.home });
    assert.strictEqual(r.status, 2, `stale (>2h) marker must re-arm and block; stdout=${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('RE-ARM (wall-clock fallback): fresh marker (<2h old, transcript size unknown) stays quiet', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'rearm-clock-fresh';
  try {
    const key = markerKeyFor(sess, c.cwd);
    const freshWrittenAt = Date.now() - (30 * 60 * 1000); // 30 min ago < 2h TTL
    h.writeState('graphify-guard-' + key, JSON.stringify({ writtenAt: freshWrittenAt, transcriptSize: -1 }));

    const pl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    };
    const r = testHook(HOOK, pl, { home: h.home });
    assert.strictEqual(r.status, 0, `fresh (<2h) marker must stay quiet; stdout=${r.stdout}`);
    assert.strictEqual(r.json, null);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('LEGACY marker format (bare millis timestamp string): still honored as a fresh marker', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  const sess = 'legacy-marker-1';
  try {
    const key = markerKeyFor(sess, c.cwd);
    // Pre-upgrade marker format: plain `String(Date.now())`, no JSON object.
    h.writeState('graphify-guard-' + key, String(Date.now()));

    const pl = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg foo' }, session_id: sess, cwd: c.cwd,
    };
    const r = testHook(HOOK, pl, { home: h.home });
    assert.strictEqual(r.status, 0, `fresh legacy marker must stay quiet; stdout=${r.stdout}`);
    assert.strictEqual(r.json, null);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

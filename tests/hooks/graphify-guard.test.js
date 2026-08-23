'use strict';
// graphify-guard (PreToolUse Grep/Glob/Bash — graph-first ADVISORY + child
// workspace graphify write-ban).
//
// CONTRACT (from plugins/anti-hall/hooks/graphify-guard.js), two concerns:
//
//   1. CHILD-WORKSPACE WRITE-BAN (real block, exit 2): when
//      isChildWorkspace(process.env) (DEVSWARM_SOURCE_BRANCH set), a Bash
//      command whose effective verb resolves to graphify AND classifies as a
//      WRITE (`graphify update`, `--update`, `--obsidian`, or a bare target
//      path with no read subcommand) is blocked, independent of whether a
//      graph currently exists at cwd. `/graphify query ...`, --help/--version,
//      and anything unclassifiable are ALLOWED (fail-open). Not a child
//      workspace -> always allowed (Primary may still update).
//
//   2. QUERY-FIRST ADVISORY (non-blocking, exit 0): fires ONLY when a
//      graphify graph exists at the payload cwd (or git toplevel): a
//      `graphify-out/` dir (findGraphRoot). Gated calls: Grep tool (any),
//      Glob tool (any), and Bash whose command is a code-nav search
//      (rg/grep/ag/find/ack/git grep/git log --grep|-S|-G), incl.
//      `bash -c "rg foo"` unwrap and `$(rg foo)` substitution
//      (isCodeNavBashCommand). `/graphify` is exempt as the EFFECTIVE verb of
//      a segment (isGraphifyBashCommand); `echo /graphify && rg secret` is
//      NOT exempt (the rg segment still triggers the advisory). LOOP SAFETY:
//      advises ONCE per session+graphRoot. Marker written to
//      ~/.anti-hall/graphify-guard-<sha1(session|root)[:20]> BEFORE the
//      advisory fires, so the SECOND identical call in the same session gets
//      no advisory (json === null either way — this path NEVER blocks).
//      Advisory shape: stdout {hookSpecificOutput:{hookEventName:
//      'PreToolUse', additionalContext: 'GRAPHIFY-FIRST: ...'}}, exit 0.
//      sanitizePath strips C0/C1 control + bidi from the reflected graph
//      path and truncates to 80 chars + '…'.
//
//   Skip hatch: isSkipped('graphify-guard') -> exit 0 for BOTH concerns.
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

function run(toolName, toolInput, { graph = 'graphify-out', rootName = null, skip = null, env = null } = {}) {
  const h = makeHome();
  const c = makeCwd(graph, rootName);
  try {
    if (skip !== null) h.writeSkip(skip);
    const r = testHook(HOOK, payload(toolName, toolInput, c.cwd), { home: h.home, env: env || undefined });
    return { ...r, home: h.home, cwd: c.cwd };
  } finally {
    h.cleanup();
    c.cleanup();
  }
}

const future = () => Date.now() + 600000;

// Pull the advisory text out of a non-blocking hookSpecificOutput payload, or
// null if this call emitted nothing / not that shape.
function advisoryText(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || null;
}

// ---------------------------------------------------------------------------
// 1. Graph EXISTS + gated code-nav Bash -> FIRST call gets the advisory
//    (non-blocking, exit 0), SECOND (same session) gets no advisory at all.
//    CHANGED 2026-08-23: this path used to exit 2 / decision:block. It is now
//    ADVISORY-ONLY (never blocks) because isSubagent() already exits before
//    this point, so a coordinator-only nudge that blocks produced friction
//    (incl. on legitimate commands) without reaching delegated search.
// ---------------------------------------------------------------------------
test('graph exists + `rg foo`: FIRST call advises (exit 0, additionalContext, GRAPHIFY-FIRST), never blocks', () => {
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
    assert.strictEqual(first.status, 0, `advisory must never block; stdout=${first.stdout}`);
    assert.strictEqual(first.json && first.json.decision, undefined, 'must not emit decision:block');
    const text = advisoryText(first);
    assert.ok(text, 'expected an additionalContext advisory on the first call');
    assert.match(text, /^GRAPHIFY-FIRST: this project has a knowledge graph/);
    assert.match(text, /this pointer re-arms after ~240KB of transcript growth/);

    const second = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(second.status, 0, `SECOND identical call must allow; stdout=${second.stdout}`);
    assert.strictEqual(second.json, null, 'SECOND must not emit any payload (marker still fresh)');
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
test('graph exists + Grep tool: advises, does not block (exit 0)', () => {
  const r = run('Grep', { pattern: 'secret' });
  assert.strictEqual(r.status, 0, `Grep must never block; stdout=${r.stdout}`);
  const text = advisoryText(r);
  assert.ok(text, 'expected advisory');
  assert.match(text, /Raw search \(Grep\) is not blocked/);
});

test('graph exists + Glob tool: advises, does not block (exit 0)', () => {
  const r = run('Glob', { pattern: '**/*.js' });
  assert.strictEqual(r.status, 0, `Glob must never block; stdout=${r.stdout}`);
  const text = advisoryText(r);
  assert.ok(text, 'expected advisory');
  assert.match(text, /Raw search \(Glob\) is not blocked/);
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

test('graph exists + `echo /graphify && rg secret`: NOT exempt -> still advises (exit 0)', () => {
  const r = run('Bash', { command: 'echo /graphify && rg secret' });
  assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
  const text = advisoryText(r);
  assert.ok(text, `/graphify as a non-verb substring must NOT exempt from the advisory; stdout=${r.stdout}`);
});

// ---------------------------------------------------------------------------
// 6. Nested code-nav detection: bash -c "rg foo" and $(rg foo).
// ---------------------------------------------------------------------------
test('graph exists + `bash -c "rg foo"`: unwrapped -> advises (exit 0)', () => {
  const r = run('Bash', { command: 'bash -c "rg foo"' });
  assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
  assert.ok(advisoryText(r), `bash -c payload must still be detected; stdout=${r.stdout}`);
});

test('graph exists + `echo "$(rg foo)"`: command-substitution -> advises (exit 0)', () => {
  const r = run('Bash', { command: 'echo "$(rg foo)"' });
  assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
  assert.ok(advisoryText(r), `$(...) substitution must still be detected; stdout=${r.stdout}`);
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
  assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
  const reason = advisoryText(r);
  assert.ok(reason, 'expected an advisory');
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
  assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
  const reason = advisoryText(r);
  assert.ok(reason, 'expected an advisory');
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

    // Coordinator call SECOND, SAME session_id: must still get the advisory
    // (the subagent's search did not consume the coordinator's one-time marker).
    const coord = testHook(HOOK, coordPl, { home: h.home });
    assert.strictEqual(coord.status, 0, `advisory never blocks; stdout=${coord.stdout}`);
    assert.ok(advisoryText(coord), `coordinator must still get the advisory; stdout=${coord.stdout}`);
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
    // still get the advisory (proves the subagent call above never touched the marker).
    const coord = testHook(HOOK, pl, { home: h.home });
    assert.strictEqual(coord.status, 0, `advisory never blocks; stdout=${coord.stdout}`);
    assert.ok(advisoryText(coord), `coordinator must still get the advisory; stdout=${coord.stdout}`);
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

test('RE-ARM (growth): marker expires and re-advises after transcript grows >= 240KB since last write', () => {
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

    // 1st call: no marker yet -> advises, records transcriptSize=1000.
    const first = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(first.status, 0, `advisory never blocks; stdout=${first.stdout}`);
    assert.ok(advisoryText(first), `first must advise; stdout=${first.stdout}`);

    // 2nd call, SAME transcript size: marker fresh, no growth -> quiet.
    const second = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(second.status, 0, `second (no growth) must allow; stdout=${second.stdout}`);
    assert.strictEqual(second.json, null, 'second must stay quiet (marker fresh)');

    // Grow the transcript by > 240KB (the REARM_GROWTH_BYTES threshold).
    growTranscriptFile(tp, 260 * 1024);

    // 3rd call: growth trigger fires -> re-arm -> advises again.
    const third = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(third.status, 0, `advisory never blocks; stdout=${third.stdout}`);
    assert.ok(advisoryText(third), `third (grown >=240KB) must re-advise; stdout=${third.stdout}`);

    // 4th call, SAME (now-grown) size again: proves the marker was actually
    // REFRESHED with the new size baseline (not stuck comparing against the
    // stale 1000-byte baseline, which would spuriously re-advise forever).
    const fourth = testHook(HOOK, pl(), { home: h.home });
    assert.strictEqual(fourth.status, 0, `fourth (post-rearm, no further growth) must allow; stdout=${fourth.stdout}`);
    assert.strictEqual(fourth.json, null, 'fourth must stay quiet (marker refreshed)');
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('RE-ARM (wall-clock fallback): stale marker (>2h old, transcript size unknown) re-arms and advises', () => {
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
    assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
    assert.ok(advisoryText(r), `stale (>2h) marker must re-arm and advise; stdout=${r.stdout}`);
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

// ---------------------------------------------------------------------------
// 10. Recommendation-text truthfulness: the reason must only name a path that
//     actually exists in graphify-out/ (wiki index / GRAPH_REPORT.md /
//     manifest.json are all OPTIONAL outputs of `graphify update`). See the
//     hook's `safeIsFile` gating around the `extraRecommendation` build.
// ---------------------------------------------------------------------------
test('wiki index EXISTS: reason recommends the wiki index', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  try {
    fs.mkdirSync(path.join(c.cwd, 'graphify-out', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(c.cwd, 'graphify-out', 'wiki', 'index.md'), '# wiki\n', 'utf8');
    const r = testHook(HOOK, payload('Grep', { pattern: 'x' }, c.cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
    const reason = advisoryText(r);
    assert.ok(reason, 'expected advisory');
    assert.match(reason, /read the wiki index at/);
    assert.doesNotMatch(reason, /GRAPH_REPORT\.md/);
    assert.doesNotMatch(reason, /manifest\.json/);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('wiki index ABSENT, GRAPH_REPORT.md present: reason recommends GRAPH_REPORT.md, never mentions wiki', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  try {
    fs.writeFileSync(path.join(c.cwd, 'graphify-out', 'GRAPH_REPORT.md'), '# report\n', 'utf8');
    const r = testHook(HOOK, payload('Grep', { pattern: 'x' }, c.cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
    const reason = advisoryText(r);
    assert.ok(reason, 'expected advisory');
    assert.match(reason, /read the graph report at/);
    assert.doesNotMatch(reason, /wiki/);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('neither wiki index nor GRAPH_REPORT.md, manifest.json present: reason recommends manifest.json only', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  try {
    fs.writeFileSync(path.join(c.cwd, 'graphify-out', 'manifest.json'), '{}', 'utf8');
    const r = testHook(HOOK, payload('Grep', { pattern: 'x' }, c.cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
    const reason = advisoryText(r);
    assert.ok(reason, 'expected advisory');
    assert.match(reason, /read the graph manifest at/);
    assert.doesNotMatch(reason, /wiki/);
    assert.doesNotMatch(reason, /GRAPH_REPORT\.md/);
  } finally {
    h.cleanup();
    c.cleanup();
  }
});

test('none of wiki/GRAPH_REPORT.md/manifest.json present (this repo\'s real shape): reason names only the /graphify query command, no dead path', () => {
  const h = makeHome();
  const c = makeCwd('graphify-out', null);
  try {
    // Nothing written under graphify-out/ beyond the bare dir itself — mirrors
    // this repo's actual graphify-out/ shape (graph.json, cache/, obsidian/ —
    // none of the three optional recommendation targets).
    const r = testHook(HOOK, payload('Grep', { pattern: 'x' }, c.cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `advisory never blocks; stdout=${r.stdout}`);
    const reason = advisoryText(r);
    assert.ok(reason, 'expected advisory');
    assert.match(reason, /run `\/graphify query "<question>"`\. /, 'query command still recommended');
    assert.doesNotMatch(reason, /wiki/);
    assert.doesNotMatch(reason, /GRAPH_REPORT\.md/);
    assert.doesNotMatch(reason, /manifest\.json/);
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

// ---------------------------------------------------------------------------
// 11. CHILD-WORKSPACE GRAPHIFY WRITE-BAN (Change 1). A DevSwarm child
//     workspace (DEVSWARM_SOURCE_BRANCH set, per lib/devswarm-role.js's
//     isChildWorkspace) may READ the graph but must never WRITE it. This is a
//     REAL block (exit 2, decision:block), independent of whether a graph
//     exists at cwd (graph:null throughout, to prove that independence) and
//     independent of the query-first advisory tested above.
// ---------------------------------------------------------------------------
const CHILD_ENV = { DEVSWARM_SOURCE_BRANCH: 'feature/child-branch' };

test('child workspace + `graphify update .`: BLOCKED, reason names read-only', () => {
  const r = run('Bash', { command: 'graphify update .' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `child write must block; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
  assert.match(r.json.reason, /READ-ONLY IN CHILD WORKSPACES/);
  assert.match(r.json.reason, /maintained by the Primary/);
});

test('child workspace + `/graphify . --update --obsidian`: BLOCKED (slash-command write form)', () => {
  const r = run('Bash', { command: '/graphify . --update --obsidian' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `child write must block; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('child workspace + `/graphify query "where is X"`: ALLOWED (read)', () => {
  const r = run('Bash', { command: '/graphify query "where is X"' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 0, `child read must be allowed; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null, 'no block payload for a read');
});

test('child workspace + `graphify --help`: ALLOWED (read)', () => {
  const r = run('Bash', { command: 'graphify --help' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 0, `--help must be allowed; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('NOT a child workspace (no DEVSWARM_SOURCE_BRANCH) + `graphify update .`: ALLOWED (Primary may update)', () => {
  const r = run('Bash', { command: 'graphify update .' }, { graph: null });
  assert.strictEqual(r.status, 0, `Primary write must be allowed; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('child workspace + unclassifiable bare `graphify` (no args): ALLOWED (fail-open)', () => {
  const r = run('Bash', { command: 'graphify' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 0, `unclassifiable invocation must fail-open to allow; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('child workspace + `bash -c "graphify update ."`: unwrapped -> BLOCKED', () => {
  const r = run('Bash', { command: 'bash -c "graphify update ."' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `wrapped write must still be caught; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('child workspace + `echo "$(graphify update .)"`: command-substitution -> BLOCKED', () => {
  const r = run('Bash', { command: 'echo "$(graphify update .)"' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `$(...) write must still be caught; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('child workspace write-ban: isSkipped bypass still overrides (exit 0)', () => {
  const r = run('Bash', { command: 'graphify update .' }, {
    graph: null, env: CHILD_ENV, skip: { 'graphify-guard': future() },
  });
  assert.strictEqual(r.status, 0, `skip must override the write-ban too; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

// ---------------------------------------------------------------------------
// P2-1: a write flag (--update/--obsidian) must win regardless of whether
// `query` appears earlier in the args. Pre-fix, classifyGraphifyArgs returned
// 'read' as soon as firstNonFlag === 'query', before checking the flags —
// contradicting the header comment that says --update/--obsidian is always
// a write. These forms must BLOCK in a child workspace.
// ---------------------------------------------------------------------------
test('child workspace + `graphify query --update`: BLOCKED (write flag wins over query)', () => {
  const r = run('Bash', { command: 'graphify query --update' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `write flag must block even with query first; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('child workspace + `/graphify query "x" --obsidian`: BLOCKED (write flag wins over query)', () => {
  const r = run('Bash', { command: '/graphify query "x" --obsidian' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `write flag must block even with query first; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('child workspace + `graphify query "x"` (no write flags): ALLOWED (no regression)', () => {
  const r = run('Bash', { command: 'graphify query "x"' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 0, `plain query must still be allowed; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('NOT a child workspace + `graphify query --update`: ALLOWED (Primary unaffected)', () => {
  const r = run('Bash', { command: 'graphify query --update' }, { graph: null });
  assert.strictEqual(r.status, 0, `Primary must be unaffected; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('NOT a child workspace + `/graphify query "x" --obsidian`: ALLOWED (Primary unaffected)', () => {
  const r = run('Bash', { command: '/graphify query "x" --obsidian' }, { graph: null });
  assert.strictEqual(r.status, 0, `Primary must be unaffected; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

test('NOT a child workspace + `graphify query "x"`: ALLOWED', () => {
  const r = run('Bash', { command: 'graphify query "x"' }, { graph: null });
  assert.strictEqual(r.status, 0, `Primary read must be allowed; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null);
});

// ---------------------------------------------------------------------------
// P2-2: `eval` wraps a write and must be recursed into like `bash -c '...'`,
// so it cannot be used to bypass the child-workspace write-ban.
// ---------------------------------------------------------------------------
test('child workspace + `eval "graphify update ."`: unwrapped -> BLOCKED', () => {
  const r = run('Bash', { command: 'eval "graphify update ."' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `eval-wrapped write must still be caught; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

// ---------------------------------------------------------------------------
// P1-a: heredoc bodies must not be split into independent segments and
// misclassified as commands (e.g. a commit message body containing the words
// "graphify update" must not be treated as a graphify write invocation).
// ---------------------------------------------------------------------------
test('P1-a: `git commit -F - <<EOF` heredoc body mentioning "graphify update" is ALLOWED, not blocked', () => {
  const command = "git commit -F - <<'EOF'\ngraphify update: switched to lazy loading\nEOF";
  const r = run('Bash', { command }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 0, `heredoc body must not be parsed as a command; stdout=${r.stdout}`);
  assert.strictEqual(r.json, null, 'no block payload for a heredoc-body false positive');
});

test('P1-a: a REAL `graphify update .` in a child workspace is still BLOCKED (no regression)', () => {
  const r = run('Bash', { command: 'graphify update .' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `real write must still block; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('P1-a: heredoc whose OUTER command is itself `graphify update` stays BLOCKED (no bypass)', () => {
  const command = "graphify update <<'EOF'\nsome unrelated body text\nEOF";
  const r = run('Bash', { command }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2, `outer graphify write must still block even with a heredoc tail; stdout=${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('P1-a: block reason mentions the skip.json escape hatch', () => {
  const r = run('Bash', { command: 'graphify update .' }, { graph: null, env: CHILD_ENV });
  assert.strictEqual(r.status, 2);
  assert.match(r.json.reason, /skip\.json/);
});

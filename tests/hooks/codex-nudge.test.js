'use strict';
// codex-nudge (Stop hook, advisory). Nudges ONCE when a session shipped >= MIN
// substantial code-file edits with no Codex review. Block => stdout {decision:'block'}
// + exit 0. Mirrors the speculation-guard test harness; adds tool_use transcript lines.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'codex-nudge.js';
const STATE_FILE = 'codex-nudge-state-t.json';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}
function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}
// Build an assistant transcript line carrying tool_use blocks.
function toolUseMessage(tools) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: tools.map((t, i) => ({
        type: 'tool_use', name: t.name, id: 'tu' + i, input: t.input,
      })),
    },
  };
}
const edit = (file_path) => ({ name: 'Edit', input: { file_path } });
const codexSpawn = () => ({ name: 'Agent', input: { subagent_type: 'codex:codex-rescue', description: 'review' } });
// Workflow agent() uses `agentType` (not subagent_type) — must also count as a review.
const codexSpawnWorkflow = () => ({ name: 'Agent', input: { agentType: 'codex:codex-rescue', label: 'critic' } });

test('NUDGE: 3 code edits, no Codex review -> block', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts')]),
      toolUseMessage([edit('/x/c.py')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected nudge; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /codex/i);
  } finally { h.cleanup(); }
});

test('ALLOW: below threshold (only 2 code edits)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts')])]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (below MIN); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: 3 code edits but a Codex review already happened', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
      toolUseMessage([codexSpawn()]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (codex consulted); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: Codex review via Workflow `agentType` field (not subagent_type)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
      toolUseMessage([codexSpawnWorkflow()]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (codex via agentType); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NUDGE: .vue/.svelte frontend files count as substantial code', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/A.vue'), edit('/x/B.svelte'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected nudge (.vue/.svelte are code); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: 3 doc/.md edits are NOT substantial code', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.md'), edit('/x/b.json'), edit('/x/c.txt')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (docs only); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// FIX: edits to the SESSION'S OWN scratchpad (lib/scratchpad.js
// ownScratchpadDirs, derived from transcript_path's encoded-cwd segment)
// must not count toward the "substantial code edits" threshold — a throwaway
// repro script written there is disposable scratch I/O, not a change worth a
// Codex review. Also: any edited path outside the session's git worktree
// (companion/lib/identity.js resolveContext) is excluded, when payload.cwd
// resolves to a real worktree.
// ---------------------------------------------------------------------------
const { ownScratchpadDirs } = require('../../plugins/anti-hall/hooks/lib/scratchpad.js');

// writeTranscriptAt(tp, messages) -> writes a JSONL transcript at an EXACT
// path (unlike fixtures.writeTranscript, which always uses <home>/transcript.jsonl),
// so the parent directory's basename can be controlled to match the harness's
// own ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl shape that
// ownScratchpadDirs()'s transcriptEncodedSegment() derives from.
function writeTranscriptAt(tp, messages) {
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  const body = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(tp, body, 'utf8');
}

test('REPRO -> FIX: scratchpad-only edits (e.g. .py repro scripts) do not trigger the nudge', () => {
  const h = makeHome();
  try {
    const sessionId = 'sess-scratch-repro';
    const projectDir = path.join(h.home, 'proj-enc-scratch');
    const tp = path.join(projectDir, sessionId + '.jsonl');
    const dirs = ownScratchpadDirs({ transcript_path: tp, session_id: sessionId });
    assert.ok(dirs.length > 0, 'must compute at least one scratchpad candidate dir');
    // Pick a candidate rooted at '/tmp' or '/private/tmp' (NOT bare
    // os.tmpdir()): the spawned hook child env carries no TMPDIR (see
    // spawn-hook.js isolatedEnv), so os.tmpdir() inside the hook can
    // differ from this (parent) test process's TMPDIR; the two hardcoded
    // roots are unaffected by that and stay identical on both sides.
    const scratchDir = dirs.find((d) => d.startsWith('/tmp/') || d.startsWith('/private/tmp/')) || dirs[0];
    const files = [
      path.join(scratchDir, 'repro1.py'),
      path.join(scratchDir, 'repro2.py'),
      path.join(scratchDir, 'repro3.js'),
    ];
    writeTranscriptAt(tp, [toolUseMessage(files.map((f) => edit(f)))]);
    // Sanity: WITHOUT the fix (raw count) this is 3 substantial code edits ->
    // would nudge. With the fix, all 3 are inside this session's own
    // scratchpad and must be excluded.
    const r = testHook(HOOK, { hook_event_name: 'Stop', transcript_path: tp, session_id: sessionId }, { home: h.home });
    assert.ok(!isBlock(r), `expected allow (scratchpad-only edits excluded); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FIX: repo (non-scratchpad) edits still count and still nudge, unchanged', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.py')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected nudge (ordinary repo edits, no cwd/scratchpad match); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FIX: mixed scratchpad + repo edits -> only repo edits count toward the threshold', () => {
  const h = makeHome();
  try {
    const sessionId = 'sess-mixed';
    const projectDir = path.join(h.home, 'proj-enc-mixed');
    const tp = path.join(projectDir, sessionId + '.jsonl');
    const dirs = ownScratchpadDirs({ transcript_path: tp, session_id: sessionId });
    // Pick a candidate rooted at '/tmp' or '/private/tmp' (NOT bare
    // os.tmpdir()): the spawned hook child env carries no TMPDIR (see
    // spawn-hook.js isolatedEnv), so os.tmpdir() inside the hook can
    // differ from this (parent) test process's TMPDIR; the two hardcoded
    // roots are unaffected by that and stay identical on both sides.
    const scratchDir = dirs.find((d) => d.startsWith('/tmp/') || d.startsWith('/private/tmp/')) || dirs[0];
    const scratchFiles = ['a.py', 'b.py', 'c.py', 'd.py', 'e.py'].map((n) => path.join(scratchDir, n));
    const repoFiles = ['/x/a.ts', '/x/b.ts']; // below MIN (3) on their own
    writeTranscriptAt(tp, [
      toolUseMessage(scratchFiles.map((f) => edit(f))),
      toolUseMessage(repoFiles.map((f) => edit(f))),
    ]);
    const r = testHook(HOOK, { hook_event_name: 'Stop', transcript_path: tp, session_id: sessionId }, { home: h.home });
    assert.ok(!isBlock(r),
      `expected allow: 5 scratch edits excluded, only 2 repo edits remain (< MIN); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FIX: edits outside the session git worktree (payload.cwd resolves) are excluded', () => {
  const h = makeHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nudge-repo-'));
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: repo });
    const inRepo = [
      path.join(repo, 'a.ts'), path.join(repo, 'b.ts'), path.join(repo, 'c.ts'),
    ];
    const outsideRepo = [
      path.join(os.tmpdir(), 'codex-nudge-outside-1.ts'),
      path.join(os.tmpdir(), 'codex-nudge-outside-2.ts'),
    ];
    const tp = h.writeTranscript([
      toolUseMessage(inRepo.map((f) => edit(f))),
      toolUseMessage(outsideRepo.map((f) => edit(f))),
    ]);
    const payload = { hook_event_name: 'Stop', transcript_path: tp, session_id: 't', cwd: repo };
    const r = testHook(HOOK, payload, { home: h.home });
    // 3 in-worktree edits still hit MIN on their own -> nudge fires (proves
    // in-worktree files are NOT excluded, only the outside ones are).
    assert.ok(isBlock(r), `expected nudge from the 3 in-worktree edits; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  }
});

test('FIX: edits outside the session git worktree ALONE (below MIN in-worktree) do not nudge', () => {
  const h = makeHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nudge-repo2-'));
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: repo });
    const inRepo = [path.join(repo, 'a.ts')]; // below MIN alone
    const outsideRepo = [
      path.join(os.tmpdir(), 'codex-nudge-outside-3.ts'),
      path.join(os.tmpdir(), 'codex-nudge-outside-4.ts'),
      path.join(os.tmpdir(), 'codex-nudge-outside-5.ts'),
    ];
    const tp = h.writeTranscript([
      toolUseMessage(inRepo.map((f) => edit(f))),
      toolUseMessage(outsideRepo.map((f) => edit(f))),
    ]);
    const payload = { hook_event_name: 'Stop', transcript_path: tp, session_id: 't', cwd: repo };
    const r = testHook(HOOK, payload, { home: h.home });
    assert.ok(!isBlock(r),
      `expected allow: only 1 in-worktree edit counts, 3 outside-worktree excluded; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  }
});

test('DEDUPE: same code-file set already nudged -> allow', () => {
  const h = makeHome();
  try {
    // Pre-seed state with the signature for {a.ts,b.ts,c.ts} would require the hook's
    // hash; instead assert idempotency by running twice and checking the 2nd allows
    // only when the file set is unchanged. First run nudges, second (same set) quiet.
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r1 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r1), `first run should nudge; stdout: ${r1.stdout}`);
    const r2 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r2), `second run (same files) should be quiet; stdout: ${r2.stdout}`);
  } finally { h.cleanup(); }
});

test('CAP: nudges>=2 already -> allow even with a new file set', () => {
  const h = makeHome();
  try {
    h.writeState(STATE_FILE, { sig: 'oldsig', nudges: 2 });
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/p.ts'), edit('/x/q.ts'), edit('/x/r.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `cap reached; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ENV off-switch: ANTIHALL_CODEX_NUDGE=off -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTIHALL_CODEX_NUDGE: 'off' } });
    assert.ok(!isBlock(r), `off-switch; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ESCAPE HATCH: skip.json {codex-nudge: future} -> allow', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'codex-nudge': Date.now() + 600000 });
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: empty stdin -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

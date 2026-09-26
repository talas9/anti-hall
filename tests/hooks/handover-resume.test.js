'use strict';
// handover-resume (SessionStart, all sources). Detects the newest session
// handover under <cwd>/.anti-hall/handovers/ and injects a GUIDED RESUME
// pointer + protocol so a fresh/compacted context resumes from the handover
// instead of the lossy compact summary. Never inlines file content.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'handover-resume.js';

// makeProjectCwd() -> a fresh temp project dir (distinct from HOME) so tests
// don't rely on the real anti-hall repo's own .anti-hall/handovers/.
function makeProjectCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-handoverresume-'));
}

// writeHandover(cwd, date, sessionId, seq, opts) -> filePath. Creates the
// session dir and a minimal HANDOVER*.md file, optionally back-dating its
// mtime via fs.utimesSync.
function writeHandover(cwd, date, sessionId, seq, opts = {}) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', date, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const fname = seq > 1 ? `HANDOVER-${seq}.md` : 'HANDOVER.md';
  const filePath = path.join(dir, fname);
  fs.writeFileSync(filePath, opts.body || '# Handover\n\n## Situation\ntest\n', 'utf8');
  if (opts.ageMs != null) {
    const t = new Date(Date.now() - opts.ageMs);
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

// writeDetailFiles(cwd, date, sessionId, names) -> writes an empty-but-real
// file for each name (e.g. 'state.md') beside the handover, for the
// adaptive-shape tests below (peer ask 3, 0.112 lane).
function writeDetailFiles(cwd, date, sessionId, names) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', date, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), '# ' + name + '\n', 'utf8');
}

// FULL_SHAPE_BODY -- a handover carrying the skill template's OWN
// "## Resume-verification checklist" heading verbatim.
const FULL_SHAPE_BODY = '# Handover\n\n## Situation\ntest\n\n## Resume-verification checklist\n' +
  '- [ ] `git status`\n- [ ] `pwd`\n';

function appendIndexRow(cwd, date, sessionId, outcome, seq = 1) {
  const indexPath = path.join(cwd, '.anti-hall', 'handovers', 'INDEX.md');
  const line = `- ${date} · ${sessionId} · seq ${seq} · ${outcome} · [main](${date}/${sessionId}/HANDOVER.md)\n`;
  fs.appendFileSync(indexPath, line, 'utf8');
}

test('(a) no .anti-hall/handovers dir + source compact -> THREAD 4 negative report injected', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const r = testHook(HOOK, {
      session_id: 's1',
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.strictEqual(r.status, 0, 'must always exit 0 (fail-open)');
    assert.ok(r.json, `expected JSON negative-report context, got: ${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(r.json.hookSpecificOutput.additionalContext, /No session handover found/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /wrong location/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(a2) no .anti-hall/handovers dir + source startup -> silent (no noise on ordinary fresh sessions)', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const r = testHook(HOOK, {
      session_id: 's1',
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'startup',
      hook_event_name: 'SessionStart',
    }, { home: h.home });

    assert.strictEqual(r.status, 0, 'must always exit 0 (fail-open)');
    assert.strictEqual(r.stdout.trim(), '', 'startup with no handovers dir must stay silent');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(a3) handovers dir exists but is empty (no HANDOVER*.md yet) + source clear -> negative report injected', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.anti-hall', 'handovers'), { recursive: true });
    const r = testHook(HOOK, {
      session_id: 's1',
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'clear',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON negative-report context, got: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /No session handover found/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("(b) handover present (minimal shape, no checklist/detail files) + source 'compact' -> context has path, SUPERSEDES, and the FALLBACK guided steps", () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-01';
    const sessionId = 'session-abc123';
    const filePath = writeHandover(cwd, date, sessionId, 1);
    appendIndexRow(cwd, date, sessionId, 'finished the widget refactor');

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON context on stdout, got: ${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');

    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(filePath), 'context must include the full HANDOVER.md path');
    assert.match(ctx, /SUPERSEDES/, 'must carry the override clause');
    // ADAPTIVE (peer ask 3, 0.112 lane): this handover has NO
    // "## Resume-verification checklist" section and none of the detail
    // files (state.md/decisions.md/trials.md/knowledge.md) — the guided
    // steps must name only what actually exists, falling back to a generic
    // 3-check + still require the resume-verified line.
    assert.match(ctx, /^1\. Read/m, 'numbered guided step 1');
    assert.match(ctx, /^2\. No Resume-verification checklist section was found in it -- fall back to a generic check/m, 'numbered guided step 2: fallback checklist');
    assert.match(ctx, /`git status --short --branch`/, 'fallback checklist must name git status --short --branch');
    assert.match(ctx, /`pwd`/, 'fallback checklist must name pwd');
    assert.match(ctx, /CLAUDE\.md re-read/, 'fallback checklist must name re-reading CLAUDE.md');
    assert.match(ctx, /resume-verified: <ISO timestamp>/, 'fallback branch must still require the resume-verified line');
    assert.ok(!/Load detail files ONLY as needed/.test(ctx), 'must NOT mention the detail-file pointer table when none exist');
    assert.ok(!/Check trials\.md do-not-repeat list/.test(ctx), 'must NOT mention trials.md when it does not exist');
    assert.match(ctx, /^3\. READ-BACK: .*Session rules \(verbatim\)/m, 'step 3 (renumbered): receiver read-back');
    assert.match(ctx, /^4\. Continue from the single Next Action/m, 'step 4 (renumbered)');
    assert.ok(!/Recreate\/reconcile your task list from state\.md/.test(ctx), 'must NOT reference state.md\'s task-list snapshot when state.md does not exist');
    assert.match(ctx, /finished the widget refactor/, 'must surface the INDEX.md one-line outcome');
    assert.match(ctx, /found for this continuation/, 'compact source must use the continuation prefix wording');
    assert.ok(ctx.length < 4000, `context must stay well under 4k chars, got ${ctx.length}`);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("(b-full) handover present (FULL shape: checklist section + all 4 detail files) + source 'compact' -> the ORIGINAL full guided steps", () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-02';
    const sessionId = 'session-fullshape';
    const filePath = writeHandover(cwd, date, sessionId, 1, { body: FULL_SHAPE_BODY });
    writeDetailFiles(cwd, date, sessionId, ['state.md', 'decisions.md', 'trials.md', 'knowledge.md']);

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON context on stdout, got: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(filePath), 'context must include the full HANDOVER.md path');
    assert.match(ctx, /^1\. Read/m, 'numbered guided step 1');
    assert.match(ctx, /^2\. Run its Resume-verification checklist/m, 'numbered guided step 2: real checklist named');
    assert.match(ctx, /resume-verified: <ISO timestamp>/, 'must still require the resume-verified line');
    assert.match(ctx, /^3\. Load detail files ONLY as needed via the pointer table \(state\.md \/ decisions\.md \/ trials\.md \/ knowledge\.md\)/m, 'numbered guided step 3');
    assert.match(ctx, /^4\. Check trials\.md do-not-repeat list/m, 'numbered guided step 4');
    assert.match(ctx, /^5\. READ-BACK: .*Session rules \(verbatim\)/m, 'numbered guided step 5');
    assert.match(ctx, /^6\. Continue from the single Next Action/m, 'numbered guided step 6');
    assert.match(ctx, /^7\. Recreate\/reconcile your task list from state\.md/m, 'numbered guided step 7');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(b2) successful injection writes a resume-state marker under HOME keyed by the RESUMING session id', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-01';
    const sessionId = 'session-abc123';
    const filePath = writeHandover(cwd, date, sessionId, 1);

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.ok(r.json, `expected JSON context, got: ${r.stdout}`);
    const statePath = path.join(h.home, '.anti-hall', 'handover-resume-state-' + sessionId + '.json');
    assert.ok(fs.existsSync(statePath), 'resume-state marker must be written on successful injection');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.handoverFile, filePath, 'marker must record the referenced HANDOVER file path');
    assert.ok(Number.isFinite(state.ts), 'marker must record a timestamp');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(b3) no candidate found -> no resume-state marker written', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.anti-hall', 'handovers'), { recursive: true });
    const sessionId = 'no-handover-session';
    testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'clear',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    const statePath = path.join(h.home, '.anti-hall', 'handover-resume-state-' + sessionId + '.json');
    assert.ok(!fs.existsSync(statePath), 'no marker should be written when nothing was injected');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(c) same-session dir preferred over a newer other-session dir', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-01';
    const mySession = 'my-session';
    const otherSession = 'other-session';

    // My session's handover is OLDER by mtime...
    const mine = writeHandover(cwd, date, mySession, 1, { ageMs: 60 * 60 * 1000 });
    // ...but the other session's handover is NEWER.
    const other = writeHandover(cwd, date, otherSession, 1, { ageMs: 0 });
    // Force a real mtime gap regardless of write-order rounding.
    fs.utimesSync(mine, new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));
    fs.utimesSync(other, new Date(), new Date());

    const r = testHook(HOOK, {
      session_id: mySession,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.ok(r.json, `expected JSON context, got: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(mine), 'must prefer the SAME-session handover even though it is older');
    assert.ok(!ctx.includes(other), 'must NOT pick the newer other-session handover');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(d) stale (>7 days old) handover -> silent, no injection', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-01-01';
    const sessionId = 'old-session';
    writeHandover(cwd, date, sessionId, 1, { ageMs: 8 * 24 * 60 * 60 * 1000 });

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'startup',
      hook_event_name: 'SessionStart',
    }, { home: h.home });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'a >7-day-old handover must produce no injection');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(e) garbage stdin -> exit 0, no crash, no output', () => {
  const h = makeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    const r = testHookRaw(HOOK, '{not valid json', { home: h.home });

    assert.strictEqual(r.status, 0, 'must exit 0 on garbage stdin (fail-open)');
    assert.strictEqual(r.stdout.trim(), '');
    assert.strictEqual(r.stderr.trim(), '', 'must not throw/print to stderr on garbage stdin');
  } finally {
    h.cleanup();
  }
});

test('(g) multi-seq session -> INDEX outcome for the matching seq, not the seq-1 row', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-01';
    const sessionId = 'multi-seq-session';
    // seq 1 (older) and seq 2 (newest by mtime) in the SAME session dir.
    writeHandover(cwd, date, sessionId, 1, { ageMs: 2 * 60 * 60 * 1000 });
    const seq2 = writeHandover(cwd, date, sessionId, 2);
    appendIndexRow(cwd, date, sessionId, 'first pass outcome', 1);
    appendIndexRow(cwd, date, sessionId, 'second pass outcome', 2);

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'compact',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.ok(r.json, `expected JSON context, got: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(seq2), 'must pick the newest seq file (HANDOVER-2.md)');
    assert.match(ctx, /predecessor HANDOVER\.md/, 'seq 2 must name its predecessor');
    assert.match(ctx, /second pass outcome/, 'must surface the seq-2 INDEX row outcome');
    assert.doesNotMatch(ctx, /first pass outcome/, 'must NOT surface the stale seq-1 outcome');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("(f) 'startup' source with a fresh handover -> different prefix wording than compact", () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const date = '2026-08-01';
    const sessionId = 'startup-session';
    writeHandover(cwd, date, sessionId, 1);

    const r = testHook(HOOK, {
      session_id: sessionId,
      transcript_path: '/tmp/whatever.jsonl',
      cwd,
      source: 'startup',
      hook_event_name: 'SessionStart',
    }, { home: h.home, expectJson: true });

    assert.ok(r.json, `expected JSON context, got: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /a previous session left a handover/i);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// PreCompact snapshot awareness (hooks/precompact-snapshot.js writes
// PRECOMPACT-<n>.md into the session dir right before compaction).
function writeSnapshot(cwd, date, sessionId, n, ageMs) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', date, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `PRECOMPACT-${n}.md`);
  fs.writeFileSync(p, '# PRECOMPACT snapshot\n', 'utf8');
  if (ageMs != null) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

function resumeCtx(h, cwd, sessionId, source) {
  const r = testHook(HOOK, { session_id: sessionId, cwd, source, hook_event_name: 'SessionStart' }, { home: h.home, expectJson: true });
  assert.strictEqual(r.status, 0);
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('(h) snapshot NEWER than the handover -> pointer names it as newer (work happened after the handover)', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    writeHandover(cwd, '2026-09-24', 'sess-h', 1, { ageMs: 60 * 60 * 1000 });
    const snap = writeSnapshot(cwd, '2026-09-24', 'sess-h', 1, 1000);
    const c = resumeCtx(h, cwd, 'sess-h', 'compact');
    assert.match(c, /GUIDED RESUME PATH/);
    assert.ok(c.includes('PRE-COMPACTION SNAPSHOT (newer than the handover): ' + snap), c);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(i) snapshot OLDER than the handover -> named as already covered', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    writeSnapshot(cwd, '2026-09-24', 'sess-i', 1, 60 * 60 * 1000);
    writeHandover(cwd, '2026-09-24', 'sess-i', 1, { ageMs: 1000 });
    const c = resumeCtx(h, cwd, 'sess-i', 'compact');
    assert.match(c, /older than the handover, which already covers it/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(j) no handover but a same-session snapshot -> snapshot pointer instead of the negative report', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const snap = writeSnapshot(cwd, '2026-09-24', 'sess-j', 2, 1000);
    const c = resumeCtx(h, cwd, 'sess-j', 'compact');
    assert.ok(c.includes('PRE-COMPACTION SNAPSHOT: ' + snap), c);
    assert.doesNotMatch(c, /No session handover found/);
    assert.ok(!fs.existsSync(path.join(h.home, '.anti-hall', 'handover-resume-state-sess-j.json')),
      'no resume-verified rail for a snapshot-only resume (there is no handover to mark)');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("(k) another session's snapshot is ignored -> negative report as before", () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    writeSnapshot(cwd, '2026-09-24', 'other-session', 1, 1000);
    const c = resumeCtx(h, cwd, 'sess-k', 'compact');
    assert.match(c, /No session handover found/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Freshness facts + platform-aware wording.
const { execFileSync } = require('node:child_process');

test('(l) freshness: HEAD, commits since the handover mtime, dirty-file count', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const g = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    g('init', '-q');
    const hp = writeHandover(cwd, '2026-09-24', 'sess-l', 1, { ageMs: 60 * 60 * 1000 });
    // Two commits made AFTER the handover's (back-dated) mtime.
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'a');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'b');
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x');
    const c = resumeCtx(h, cwd, 'sess-l', 'compact');
    assert.match(c, /FRESHNESS \(measured now\): HEAD [0-9a-f]+; 2 commit\(s\) since this handover was written/);
    // .anti-hall/ (the handover itself) is untracked too, so dirty counts it + dirty.txt.
    assert.match(c, /; 2 dirty file\(s\) in the working tree/);
    assert.ok(c.includes(hp));
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(m) freshness line omitted outside a git repo', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    writeHandover(cwd, '2026-09-24', 'sess-m', 1);
    const c = resumeCtx(h, cwd, 'sess-m', 'compact');
    assert.doesNotMatch(c, /FRESHNESS/);
    assert.match(c, /CLAUDE\.md re-read/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(n) Codex payload (rollout transcript) -> AGENTS.md re-read wording', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    writeHandover(cwd, '2026-09-24', 'sess-n', 1);
    const r = testHook(HOOK, { session_id: 'sess-n', cwd, source: 'compact', hook_event_name: 'SessionStart',
      transcript_path: '/home/u/.codex/sessions/2026/09/24/rollout-2026-09-24T10-00-00-abc.jsonl' }, { home: h.home, expectJson: true });
    const c = r.json.hookSpecificOutput.additionalContext;
    assert.match(c, /AGENTS\.md re-read/);
    assert.doesNotMatch(c, /CLAUDE\.md re-read/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// 2026-09-25 verified field bug: precompact-snapshot.js wrote to a cwd-doubled
// path when the session's cwd AT /compact was itself under
// .anti-hall/handovers/ (e.g. an agent that cd'd there to inspect a prior
// handover). handover-resume.js must find that repo's handover/snapshot
// whether the RESUMING session's cwd is the repo root or that same weird
// subdir -- both must resolve to the SAME repo-rooted .anti-hall/handovers/.
test('(o) cwd = <repo>/.anti-hall/handovers at resume time -> still finds the handover (matches the write side)', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    // Must be a real git repo: repoRoot() only resolves via the toplevel
    // walk-up when cwd IS inside a repo -- a non-git cwd falls back to
    // itself unchanged (spec requirement 3), which would make this
    // assertion pass trivially without exercising the fix at all.
    const g = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first commit');
    const hp = writeHandover(cwd, '2026-09-24', 'sess-o', 1);
    const weirdCwd = path.join(cwd, '.anti-hall', 'handovers');
    const c = resumeCtx(h, weirdCwd, 'sess-o', 'compact');
    assert.ok(c.includes(hp), 'resume from a cwd under .anti-hall/handovers/ must still find the repo-rooted handover');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('(p) precompact-snapshot writes from a weird cwd, then handover-resume (normal cwd) finds it -- write/read sides agree', () => {
  const h = makeHome();
  const cwd = makeProjectCwd();
  try {
    const g = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first commit');
    const weirdCwd = path.join(cwd, '.anti-hall', 'handovers');
    fs.mkdirSync(weirdCwd, { recursive: true });
    const tp = h.writeTranscript([
      { type: 'user', message: { role: 'user', content: 'weird-cwd precompact rule' }, timestamp: '2026-09-25T10:00:00Z' },
    ]);
    const pr = testHook('precompact-snapshot.js', {
      session_id: 'sess-p', transcript_path: tp, cwd: weirdCwd, hook_event_name: 'PreCompact', trigger: 'auto',
    }, { home: h.home });
    assert.strictEqual(pr.status, 0);
    const c = resumeCtx(h, cwd, 'sess-p', 'compact');
    assert.match(c, /PRE-COMPACTION SNAPSHOT/, c);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

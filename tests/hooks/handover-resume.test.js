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
  fs.writeFileSync(filePath, '# Handover\n\n## Situation\ntest\n', 'utf8');
  if (opts.ageMs != null) {
    const t = new Date(Date.now() - opts.ageMs);
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

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

test("(b) handover present + source 'compact' -> context has path, SUPERSEDES, and guided steps", () => {
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
    assert.match(ctx, /^1\. Read/m, 'numbered guided step 1');
    assert.match(ctx, /^2\. Run its section-10 resume-verification checklist/m, 'numbered guided step 2');
    assert.match(ctx, /^3\. Load detail files ONLY as needed/m, 'numbered guided step 3');
    assert.match(ctx, /^4\. Check trials\.md do-not-repeat list/m, 'numbered guided step 4');
    assert.match(ctx, /^5\. Continue from the single Next Action/m, 'numbered guided step 5');
    assert.match(ctx, /finished the widget refactor/, 'must surface the INDEX.md one-line outcome');
    assert.match(ctx, /found for this continuation/, 'compact source must use the continuation prefix wording');
    assert.ok(ctx.length < 4000, `context must stay well under 4k chars, got ${ctx.length}`);
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

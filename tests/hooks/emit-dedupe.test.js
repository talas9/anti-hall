'use strict';
// lib/emit-dedupe.js — per-session suppression of repeated hook blocks.
// Primary rule: a copy is suppressed while the previous identical copy is still
// UNDELIVERED per the transcript (Claude Code writes a UserPromptSubmit hook's
// additionalContext as a `hook_additional_context` attachment only when the
// queued prompt is delivered). On-change keys (WORKSPACES table, ORPHANED MESH
// banner) additionally stay quiet while unchanged, with a keepalive counted in
// DELIVERED turns. The 15s window survives only as the fallback when the
// transcript is unusable. Every state write goes to a mkdtemp HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dedupe = require('../../plugins/anti-hall/hooks/lib/emit-dedupe.js');
const inbox = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');
const { testHook } = require('../helpers/spawn-hook.js');

const ON = { ANTIHALL_EMIT_DEDUPE: '1' };
const OFF = { ANTIHALL_EMIT_DEDUPE: '0' };
const T0 = Date.parse('2026-09-20T14:00:00.000Z');
const MIN = 60 * 1000;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-emit-dedupe-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// --- transcript fixtures (real Claude Code entry shapes) ---
function attLine(ts, text) {
  return JSON.stringify({
    type: 'attachment', timestamp: new Date(ts).toISOString(),
    attachment: { type: 'hook_additional_context', content: [text], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' },
  }) + '\n';
}
function assistantLine(ts) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [] } }) + '\n';
}
// A transcript with one earlier, already-delivered turn (so the tail holds UPS
// attachments and the consumption signal is usable).
function mkTranscript(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, attLine(T0 - 60 * MIN, 'OLDER TURN') + assistantLine(T0 - 59 * MIN));
  return tp;
}
function deliver(tp, ts, text) { dedupe._resetMemo(); fs.appendFileSync(tp, attLine(ts, text)); }
function assistant(tp, ts) { dedupe._resetMemo(); fs.appendFileSync(tp, assistantLine(ts)); }
function emit(o) { dedupe._resetMemo(); return dedupe.shouldEmit(o); }

// ---------------- rule (a): pending copy (transcript consumption) ----------------

test('burst of 5 invocations 60s apart with no delivery in between -> exactly 1 emit', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    let n = 0;
    for (let i = 0; i < 5; i++) if (emit({ ...b, now: T0 + i * MIN })) n++;
    assert.strictEqual(n, 1);
  } finally { rm(home); }
});

test('vacuity: with dedupe disabled the same 60s-apart burst sees 5 emits, nothing recorded', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: OFF };
    let n = 0;
    for (let i = 0; i < 5; i++) if (emit({ ...b, now: T0 + i * MIN })) n++;
    assert.strictEqual(n, 5);
    assert.ok(!fs.existsSync(dedupe.statePath(home, 's1')));
  } finally { rm(home); }
});

test('busy turn: assistant entries after the emit but the copy NOT yet delivered -> still suppressed', () => {
  // Field transcript: in 251/694 UPS attachments the busy turn kept writing
  // assistant entries (up to 45s) before the queued prompt was delivered, so an
  // assistant entry alone is not a consumption signal.
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assistant(tp, T0 + 5000);
    assistant(tp, T0 + 30000);
    assert.strictEqual(emit({ ...b, now: T0 + 40000 }), false);
  } finally { rm(home); }
});

test('delivery (attachment + assistant reply) in between -> emits again', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + 30000 }), false, 'second queued copy suppressed');
    deliver(tp, T0 + 20, 'OTHER HOOK\n\nBLOCK'); // delivered; stamped with the hook time
    assistant(tp, T0 + 50000);
    assert.strictEqual(emit({ ...b, now: T0 + 60000 }), true, 'next turn after delivery emits');
  } finally { rm(home); }
});

test('an older delivered copy of the same text does not count as consuming the new emit', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    deliver(tp, T0 - 10 * MIN, 'BLOCK');
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + MIN }), false);
  } finally { rm(home); }
});

test('changed content while a copy is pending -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: 'A', now: T0 }), true);
    assert.strictEqual(emit({ ...b, content: 'A', now: T0 + 1000 }), false);
    assert.strictEqual(emit({ ...b, content: 'B', now: T0 + 2000 }), true);
  } finally { rm(home); }
});

test('a copy pending longer than maxPendingMs (e.g. cancelled queued prompt) -> re-emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'A', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + 9 * MIN }), false);
    assert.strictEqual(emit({ ...b, now: T0 + 11 * MIN }), true);
  } finally { rm(home); }
});

test('delivered attachment beyond the 256KB tail is found by the one-time 4MB widen', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    deliver(tp, T0 + 10, 'BLOCK');
    const filler = assistantLine(T0 + 1000).replace('"content":[]', '"content":["' + 'x'.repeat(1000) + '"]');
    fs.appendFileSync(tp, filler.repeat(400)); // ~400KB after the delivery
    // Inside the 15s fallback window on purpose: without the widen the tail holds
    // no UPS attachment -> window fallback -> suppressed. Only the widen emits.
    assert.strictEqual(emit({ ...b, now: T0 + 5000 }), true);
  } finally { rm(home); }
});

test('P1: an attachment sharing a long PREFIX (not the exact string) is not a false "consumed"', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const content = 'X'.repeat(130) + ' variant A';
    const b = { home, sessionId: 's1', key: 'k', content, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    deliver(tp, T0 + 20, 'X'.repeat(130) + ' variant B'); // same 130-char prefix, different block
    deliver(tp, T0 + 30, content + ' plus trailing text'); // superstring, not a whole segment
    assert.strictEqual(emit({ ...b, now: T0 + MIN }), false, 'still pending');
    deliver(tp, T0 + 40, 'OTHER\n\n' + content); // the exact block as a whole segment
    assert.strictEqual(emit({ ...b, now: T0 + 2 * MIN }), true, 'exact delivery is consumption');
  } finally { rm(home); }
});

test('P0: /clear (new transcript_path) -> unchanged pending/consumed block emits into the new transcript', () => {
  const home = tmpHome();
  try {
    const tpOld = mkTranscript(home);
    const dir2 = fs.mkdtempSync(path.join(home, 'clear-'));
    const tpNew = mkTranscript(dir2);
    const b = { home, sessionId: 's1', key: 'table', content: 'T', keepaliveTurns: 10, env: ON };
    assert.strictEqual(emit({ ...b, transcriptPath: tpOld, now: T0 }), true);
    deliver(tpOld, T0 + 20, 'T');
    assert.strictEqual(emit({ ...b, transcriptPath: tpOld, now: T0 + MIN }), false, 'precondition: suppressed in old transcript');
    assert.strictEqual(emit({ ...b, transcriptPath: tpNew, now: T0 + 2 * MIN }), true, 'new transcript -> emits');
  } finally { rm(home); }
});

test('P0: SessionStart compact reset (emit-dedupe-reset.js hook) -> next invocation emits even though unchanged', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const base = Date.now() - 10 * MIN;
    const b = { home, sessionId: 'sess-c', key: 'table', content: 'T', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: base }), true);
    deliver(tp, base + 20, 'T');
    assert.strictEqual(emit({ ...b, now: base + MIN }), false, 'precondition: unchanged + consumed -> suppressed');
    const r = testHook('emit-dedupe-reset.js',
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-c', transcript_path: tp, cwd: home },
      { home, env: ON });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'state-only hook: no stdout');
    const after = Date.now() + 1000;
    assert.strictEqual(emit({ ...b, now: after }), true, 'post-compact: re-emitted');
    deliver(tp, after + 20, 'T');
    assert.strictEqual(emit({ ...b, now: after + MIN }), false, 'dedupe resumes after the re-emit');
  } finally { rm(home); }
});

test('emit-dedupe-reset hook: fail-open without session_id / bad stdin; kill switch records nothing', () => {
  const home = tmpHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    assert.strictEqual(testHookRaw('emit-dedupe-reset.js', '{bad', { home, env: ON }).status, 0);
    assert.strictEqual(testHook('emit-dedupe-reset.js', { source: 'clear' }, { home, env: ON }).status, 0);
    const r = testHook('emit-dedupe-reset.js', { source: 'clear', session_id: 'k1' }, { home, env: OFF });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(dedupe.statePath(home, 'k1')));
  } finally { rm(home); }
});

// ---------------- rule (b): on-change + keepalive in delivered turns ----------------

test('on-change key unchanged for 10 delivered turns -> suppressed, keepalive emit on the 11th', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'table', content: 'T', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    const turn = (i) => T0 + i * MIN;
    assert.strictEqual(emit({ ...b, now: turn(0) }), true);
    deliver(tp, turn(0) + 20, 'OVERRIDE\n\nT');
    for (let i = 1; i <= 10; i++) {
      assert.strictEqual(emit({ ...b, now: turn(i) }), false, 'turn ' + i + ' suppressed');
      deliver(tp, turn(i) + 20, 'OVERRIDE'); // this turn's prompt delivered (table not in it)
    }
    assert.strictEqual(emit({ ...b, now: turn(11) }), true, 'keepalive on the 11th');
    deliver(tp, turn(11) + 20, 'OVERRIDE\n\nT');
    assert.strictEqual(emit({ ...b, now: turn(12) }), false, 'counter reset after keepalive');
  } finally { rm(home); }
});

test('on-change key: undelivered queued invocations do not count toward the keepalive', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'table', content: 'T', keepaliveTurns: 2, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    deliver(tp, T0 + 20, 'OVERRIDE\n\nT');
    // 6 invocations 30s apart, none delivered yet: turn 1 counts once, the rest are one pending burst.
    for (let j = 0; j < 6; j++) assert.strictEqual(emit({ ...b, now: T0 + MIN + j * 30000 }), false);
    deliver(tp, T0 + MIN + 5 * 30000 + 20, 'OVERRIDE'); // the burst is delivered
    assert.strictEqual(emit({ ...b, now: T0 + 10 * MIN }), false, 'turn 2 still suppressed');
    deliver(tp, T0 + 10 * MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, now: T0 + 11 * MIN }), true, 'keepalive after 2 delivered turns');
  } finally { rm(home); }
});

test('WORKSPACES table: age-only change -> suppressed; unread change -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const row = (unread) => ({
      id: 'ws-a', wsName: 'Fix the thing', label: 'active', rank: 4, finish: '1/3', unread, lastActivityTs: T0 - 30000,
    });
    const t1 = inbox.buildWorkspaceTable([row(2)], T0, false, 0, [], 0);
    const t2 = inbox.buildWorkspaceTable([row(2)], T0 + 5 * MIN, false, 0, [], 0);
    const t3 = inbox.buildWorkspaceTable([row(3)], T0 + 10 * MIN, false, 0, [], 0);
    assert.notStrictEqual(t1, t2, 'precondition: the raw tables differ (age column)');
    assert.ok(t1.startsWith('DEVSWARM WORKSPACES (re-sent on change'), 'header no longer claims every turn');
    const b = { home, sessionId: 's1', key: 'parent-inbox-table', keepaliveTurns: 10,
      normalize: inbox.normalizeTableAges, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: t1, now: T0 }), true);
    deliver(tp, T0 + 20, t1);
    assert.strictEqual(emit({ ...b, content: t2, now: T0 + 5 * MIN }), false, 'age-only change suppressed');
    deliver(tp, T0 + 5 * MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, content: t3, now: T0 + 10 * MIN }), true, 'unread change emitted');
  } finally { rm(home); }
});

test('PARENT INBOX nudge: trend/age flip in a pending burst -> suppressed; unread count change -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: 's1', key: 'parent-inbox-nudge', normalize: inbox.normalizeInboxVolatile, transcriptPath: tp, env: ON };
    const a = 'DEVSWARM PARENT INBOX: 1 active workspace(s) need attention — X (3 unread, oldest 5m, rising). tail';
    const aFlat = 'DEVSWARM PARENT INBOX: 1 active workspace(s) need attention — X (3 unread, oldest 6m, flat). tail';
    const c = 'DEVSWARM PARENT INBOX: 1 active workspace(s) need attention — X (4 unread, oldest 5m, rising). tail';
    assert.strictEqual(emit({ ...b, content: a, now: T0 }), true);
    assert.strictEqual(emit({ ...b, content: aFlat, now: T0 + 40000 }), false);
    assert.strictEqual(emit({ ...b, content: c, now: T0 + 50000 }), true);
  } finally { rm(home); }
});

test('ORPHANED MESH banner: unchanged next delivered turn -> suppressed; changed unread -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const s1 = inbox.buildOrphansSegment([{ id: 'abc123', unread: 4 }]);
    const s2 = inbox.buildOrphansSegment([{ id: 'abc123', unread: 5 }]);
    const b = { home, sessionId: 's1', key: 'parent-inbox-orphans', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: s1, now: T0 }), true);
    deliver(tp, T0 + 20, s1);
    assert.strictEqual(emit({ ...b, content: s1, now: T0 + MIN }), false);
    deliver(tp, T0 + MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, content: s2, now: T0 + 2 * MIN }), true);
  } finally { rm(home); }
});

test('URGENT INBOX segment: unchanged next delivered turn -> suppressed; changed unread -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const s1 = inbox.buildUrgentUnreadSegment([{ id: 'ws-a', unread: 2, urgencyMax: 'urgent' }]);
    const s2 = inbox.buildUrgentUnreadSegment([{ id: 'ws-a', unread: 3, urgencyMax: 'urgent' }]);
    const b = { home, sessionId: 's1', key: 'parent-inbox-urgent', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: s1, now: T0 }), true);
    deliver(tp, T0 + 20, s1);
    assert.strictEqual(emit({ ...b, content: s1, now: T0 + MIN }), false, 'unchanged -> suppressed');
    deliver(tp, T0 + MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, content: s2, now: T0 + 2 * MIN }), true, 'unread change -> emitted');
  } finally { rm(home); }
});

test('ARCHIVE-READY segment: unchanged next delivered turn -> suppressed; changed list -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const s1 = inbox.buildArchiveSegment(['ws-a']);
    const s2 = inbox.buildArchiveSegment(['ws-a', 'ws-b']);
    const b = { home, sessionId: 's1', key: 'parent-inbox-archive', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: s1, now: T0 }), true);
    deliver(tp, T0 + 20, s1);
    assert.strictEqual(emit({ ...b, content: s1, now: T0 + MIN }), false, 'unchanged -> suppressed');
    deliver(tp, T0 + MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, content: s2, now: T0 + 2 * MIN }), true, 'list change -> emitted');
  } finally { rm(home); }
});

test('STALE WORKSPACE(S) segment: unchanged next delivered turn -> suppressed; changed unread -> emitted', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const s1 = inbox.buildStaleRegistrySegment([{ id: 'gone-ws', unread: 3 }]);
    const s2 = inbox.buildStaleRegistrySegment([{ id: 'gone-ws', unread: 4 }]);
    const b = { home, sessionId: 's1', key: 'parent-inbox-stale-registry', keepaliveTurns: 10, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, content: s1, now: T0 }), true);
    deliver(tp, T0 + 20, s1);
    assert.strictEqual(emit({ ...b, content: s1, now: T0 + MIN }), false, 'unchanged -> suppressed');
    deliver(tp, T0 + MIN + 20, 'OVERRIDE');
    assert.strictEqual(emit({ ...b, content: s2, now: T0 + 2 * MIN }), true, 'unread change -> emitted');
  } finally { rm(home); }
});

// ---------------- fallbacks + fail-open ----------------

test('transcript missing -> 15s window fallback (burst inside the window collapses, 60s apart emits)', () => {
  const home = tmpHome();
  try {
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: path.join(home, 'nope.jsonl'), env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + 1000 }), false);
    assert.strictEqual(emit({ ...b, now: T0 + MIN }), true);
  } finally { rm(home); }
});

test('transcript with no UPS attachment at all -> unknown -> window fallback (never silenced for 10 min)', () => {
  const home = tmpHome();
  try {
    const tp = path.join(home, 't.jsonl');
    fs.writeFileSync(tp, assistantLine(T0 - MIN));
    const b = { home, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + MIN }), true);
  } finally { rm(home); }
});

test('no session_id -> always emit', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { home, sessionId: null, key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    for (let i = 0; i < 3; i++) assert.strictEqual(emit({ ...b, now: T0 + i }), true);
  } finally { rm(home); }
});

test('unwritable home -> fail-open (always emit)', () => {
  const dir = tmpHome();
  try {
    const tp = mkTranscript(dir);
    const fileHome = path.join(dir, 'not-a-dir');
    fs.writeFileSync(fileHome, 'x'); // mkdir under a regular file -> ENOTDIR
    const b = { home: fileHome, sessionId: 's1', key: 'k', content: 'BLOCK', transcriptPath: tp, env: ON };
    for (let i = 0; i < 5; i++) assert.strictEqual(emit({ ...b, now: T0 + i * MIN }), true);
  } finally { rm(dir); }
});

test('different sessions do not suppress each other', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const b = { key: 'k', content: 'BLOCK', home, transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, sessionId: 's1', now: T0 }), true);
    assert.strictEqual(emit({ ...b, sessionId: 's2', now: T0 + 1 }), true);
    assert.strictEqual(emit({ ...b, sessionId: 's1', now: T0 + 2 }), false);
  } finally { rm(home); }
});

test('corrupt state file -> fail-open emit, then self-heals', () => {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    const p = dedupe.statePath(home, 's1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    const b = { home, sessionId: 's1', key: 'k', content: 'A', transcriptPath: tp, env: ON };
    assert.strictEqual(emit({ ...b, now: T0 }), true);
    assert.strictEqual(emit({ ...b, now: T0 + MIN }), false);
  } finally { rm(home); }
});

test('keys unseen for 24h are pruned from the session file on write', () => {
  const home = tmpHome();
  try {
    const b = { home, sessionId: 's1', content: 'A', env: ON };
    emit({ ...b, key: 'old', now: T0 });
    emit({ ...b, key: 'new', now: T0 + 25 * 60 * MIN });
    const st = JSON.parse(fs.readFileSync(dedupe.statePath(home, 's1'), 'utf8'));
    assert.deepStrictEqual(Object.keys(st), ['new']);
  } finally { rm(home); }
});

// ---------------- hook-level: real spawned hooks, isolated HOME ----------------

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
// Spawn `n` queued invocations with no delivery between them, then simulate the
// delivery (write the emitted copy as the harness would) and spawn once more.
// Returns [hitsDuringBurst, hitAfterDelivery].
function burst(hook, n, env, payload, match) {
  const home = tmpHome();
  try {
    const tp = mkTranscript(home);
    let hits = 0;
    let firstCtx = '';
    const run = (i) => {
      const r = testHook(hook, { ...payload(i), transcript_path: tp }, { home, env: { ANTIHALL_INGEST_DRY_RUN: '1', ...env } });
      assert.strictEqual(r.status, 0);
      return ctx(r);
    };
    const startTs = Date.now();
    for (let i = 0; i < n; i++) {
      const c = run(i);
      if (match(c)) { hits++; if (!firstCtx) firstCtx = c; }
    }
    fs.appendFileSync(tp, attLine(startTs, firstCtx)); // delivered, stamped at (first) hook time
    const after = match(run(n)) ? 1 : 0;
    return [hits, after];
  } finally { rm(home); }
}

test('verify-first hook: 5 queued prompts (distinct text) -> 1 VERIFY-FIRST, emits again after delivery; vacuity off -> 5', () => {
  const p = (i) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'burst', prompt: 'cron tick ' + i, cwd: '/tmp/x' });
  const m = (c) => c.startsWith('VERIFY-FIRST:');
  assert.deepStrictEqual(burst('verify-first.js', 5, ON, p, m), [1, 1]);
  assert.deepStrictEqual(burst('verify-first.js', 5, OFF, p, m), [5, 1]);
});

test('task-tracker hook: 5 queued prompts -> 1 TASK-LIST block, emits again after delivery; vacuity off -> 5', () => {
  const p = () => ({ hook_event_name: 'UserPromptSubmit', session_id: 'burst', prompt: 'tick', cwd: process.cwd() });
  const m = (c) => c.startsWith('TASK-LIST');
  assert.deepStrictEqual(burst('task-tracker.js', 5, ON, p, m), [1, 1]);
  assert.deepStrictEqual(burst('task-tracker.js', 5, OFF, p, m), [5, 1]);
});

test('devswarm-child-turn hook: COMMS OVERRIDE block once per burst, again after delivery; vacuity off -> 5', () => {
  const env = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y', DEVSWARM_BUILDER_ID: 'b-1' };
  const p = () => ({ hook_event_name: 'UserPromptSubmit', session_id: 'burst', prompt: 'tick', cwd: '/tmp/x' });
  const m = (c) => c.includes('DEVSWARM COMMS OVERRIDE');
  assert.deepStrictEqual(burst('devswarm-child-turn.js', 5, { ...env, ...ON }, p, m), [1, 1]);
  assert.deepStrictEqual(burst('devswarm-child-turn.js', 5, { ...env, ...OFF }, p, m), [5, 1]);
});

test('parent-inbox logSegmentError: appends {ts, segment, code, message} NDJSON; fail-open on unwritable home', () => {
  const home = tmpHome();
  try {
    const e = Object.assign(new Error('boom'), { code: 'EBOOM' });
    inbox.logSegmentError(home, 'summary-read', e);
    const p = path.join(home, '.anti-hall', 'logs', 'parent-inbox-segment-errors.ndjson');
    const rec = JSON.parse(fs.readFileSync(p, 'utf8').trim());
    assert.strictEqual(rec.segment, 'summary-read');
    assert.strictEqual(rec.code, 'EBOOM');
    assert.strictEqual(rec.message, 'boom');
    assert.ok(Number.isFinite(rec.ts));
    const fileHome = path.join(home, 'f');
    fs.writeFileSync(fileHome, 'x');
    assert.doesNotThrow(() => inbox.logSegmentError(fileHome, 'orphans', e));
  } finally { rm(home); }
});

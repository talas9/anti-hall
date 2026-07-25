'use strict';
// devswarm-ingest-loss-quarantine.test.js — B1 fix (v0.66.0 lane B).
//
// PROVEN GAP THIS FILE LOCKS DOWN: normalizeMonitorPayload returns `[]` when a
// monitor batch does not match the expected shape (unparseable JSON, or valid
// JSON in an unrecognized shape). The native queue is DESTRUCTIVE — those
// messages are ALREADY POPPED by the time `raw` reaches this code, so a
// monitor output-shape change, stderr contamination, or a hardTimeoutMs kill
// mid-print (truncated JSON) used to produce: messages consumed, zero
// inserted, ZERO log lines, and NOTHING preserved to diagnose it — a
// permanent, silent loss.
//
// The fix: ingestPayload() reports `lossy: true` whenever `raw` carried
// substantive (non-whitespace) bytes AND parseMonitorPayload could not even
// RECOGNIZE its shape (unparseable JSON, or JSON matching none of the known
// container shapes); runIngestLoop's ingest call site quarantines the raw
// bytes to disk and logs the event via the shared structured logger.
// POLARITY CARE is verified two ways: (1) a genuinely empty/whitespace poll
// window (the ordinary quiet-cycle case) must NEVER be flagged as a loss, and
// (2) a RECOGNIZED-but-empty JSON container (`[]`, `{"messages":[]}`,
// `{"data":[]}`) — hivecontrol's plausible "nothing arrived" response, since
// it always emits JSON — must ALSO never be flagged as a loss. Only an
// unparseable or genuinely unrecognized shape is a real, unrecoverable loss.
//
// HERMETIC: every test uses a fresh mkdtemp HOME (both for the daemon's own
// state root and, where log assertions are made, for ANTI_HALL_LOG_DIR) and
// never spawns a real `hivecontrol` (that would destructively pop the real
// native queue) — every monitor run is injected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lossq-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// A real git worktree so repoKey (and therefore the heartbeat/quarantine key)
// resolves — same posture as the other devswarm-ingest integration tests.
const WT = process.cwd();

// ---------------------------------------------------------------------------
// 1. ingestPayload().lossy — the core detection logic (pure, no I/O)
// ---------------------------------------------------------------------------

test('ingestPayload: genuinely empty raw ("") is NOT lossy (ordinary quiet poll)', () => {
  const calls = [];
  const store = { appendMessage: (m) => { calls.push(m); return { inserted: true }; } };
  const r = ingest.ingestPayload(store, '', { workspaceId: 'p' });
  assert.equal(r.total, 0);
  assert.equal(r.lossy, false, 'an empty raw string must never be flagged as a loss');
  assert.equal(calls.length, 0);
});

test('ingestPayload: whitespace-only raw is NOT lossy (ordinary quiet poll)', () => {
  const store = { appendMessage: () => ({ inserted: true }) };
  const r = ingest.ingestPayload(store, '   \n\t  ', { workspaceId: 'p' });
  assert.equal(r.total, 0);
  assert.equal(r.lossy, false, 'whitespace-only raw must never be flagged as a loss');
});

test('ingestPayload: a non-whitespace "[]" response is NOT flagged (a recognized, legitimately-empty container is a normal quiet poll)', () => {
  // CORRECTED (P1 fix, deadly-loop review): an earlier revision of this test
  // asserted lossy:true here on the theory that only raw empty/whitespace is
  // exempt. That over-fires on hivecontrol's real "nothing arrived" response:
  // `hivecontrol workspace monitor` always emits JSON (no --json flag; JSON is
  // the unconditional default per its own --help text — see
  // docs/KB-devswarm-hivecontrol.md §4.1) and "polls... then exits with them",
  // implying a still-JSON response on timeout/no-arrival, not necessarily
  // literal empty stdout. A well-formed `[]` (or `{"messages":[]}`/
  // `{"data":[]}`) is exactly the shape a JSON-only CLI would emit for "zero
  // messages this window" — flagging it as an unrecoverable loss on every idle
  // poll cycle reintroduces the log-storm/quarantine-spam failure mode the
  // v0.65/v0.66 ENOENT fixes were built to prevent, from a new trigger. Only a
  // payload that FAILS to parse or matches NONE of the known container shapes
  // (see the "UNRECOGNIZED shape" test below) indicates an actual loss.
  const store = { appendMessage: () => ({ inserted: true }) };
  const r = ingest.ingestPayload(store, '[]', { workspaceId: 'p' });
  assert.equal(r.total, 0);
  assert.equal(r.lossy, false, 'a recognized-but-empty JSON container ("[]") is a normal quiet poll, not a loss');
});

test('ingestPayload: "{\\"messages\\":[]}" and "{\\"data\\":[]}" are also NOT flagged (same recognized-empty-container case)', () => {
  const store = { appendMessage: () => ({ inserted: true }) };
  const r1 = ingest.ingestPayload(store, JSON.stringify({ messages: [] }), { workspaceId: 'p' });
  assert.equal(r1.lossy, false, '{"messages":[]} is a recognized, legitimately-empty container');
  const r2 = ingest.ingestPayload(store, JSON.stringify({ data: [] }), { workspaceId: 'p' });
  assert.equal(r2.lossy, false, '{"data":[]} is a recognized, legitimately-empty container');
});

test('ingestPayload: a real batch with messages is NOT lossy', () => {
  const inserted = [];
  const store = { appendMessage: (m) => { inserted.push(m); return { inserted: true }; } };
  const raw = JSON.stringify([{ message: 'hello', fromBranch: 'a', toBranch: 'b' }]);
  const r = ingest.ingestPayload(store, raw, { workspaceId: 'p' });
  assert.equal(r.total, 1);
  assert.equal(r.inserted, 1);
  assert.equal(r.lossy, false);
});

test('ingestPayload: TRUNCATED/unparseable JSON (non-whitespace) IS lossy — the hardTimeoutMs-kill-mid-print case', () => {
  const store = { appendMessage: () => ({ inserted: true }) };
  // A batch cut off mid-print by a hard timeout kill: valid-looking prefix, no
  // closing bracket — JSON.parse throws, normalizeMonitorPayload returns [].
  const truncated = '[{"message":"partial batch that got cut off mid-print';
  const r = ingest.ingestPayload(store, truncated, { workspaceId: 'p' });
  assert.equal(r.total, 0);
  assert.equal(r.lossy, true, 'non-empty, unparseable raw must be flagged as an unrecoverable loss');
});

test('ingestPayload: valid JSON in an UNRECOGNIZED shape IS lossy — the output-shape-change case', () => {
  const store = { appendMessage: () => ({ inserted: true }) };
  // Parses fine, but matches none of normalizeMonitorPayload's known shapes
  // (no `messages`/`data` array, no message-like single-object fields).
  const shaped = JSON.stringify({ totallyDifferentField: 'a hivecontrol upgrade changed the batch shape' });
  const r = ingest.ingestPayload(store, shaped, { workspaceId: 'p' });
  assert.equal(r.total, 0);
  assert.equal(r.lossy, true, 'a parseable-but-unrecognized shape must still be flagged as a loss');
});

test('ingestPayload: lossy is computed from raw, independent of appendMessage failures', () => {
  // Sanity: lossy is about normalization finding ZERO messages, not about
  // store-level dedupe/failure — a batch that DOES normalize to messages is
  // never lossy even if every one of them turns out to be a duplicate.
  const store = { appendMessage: () => ({ inserted: false }) }; // every message a duplicate
  const raw = JSON.stringify([{ message: 'dup', createdAt: '2024-01-01T00:00:00Z' }]);
  const r = ingest.ingestPayload(store, raw, { workspaceId: 'p' });
  assert.equal(r.total, 1);
  assert.equal(r.duplicate, 1);
  assert.equal(r.lossy, false, 'a batch that normalized to real messages is never lossy, regardless of dedupe outcome');
});

// ---------------------------------------------------------------------------
// 2. quarantineLossyMonitorBatch — best-effort preservation of the raw bytes
// ---------------------------------------------------------------------------

test('quarantineLossyMonitorBatch: writes the exact raw bytes to a recoverable file and returns its path', () => {
  const home = tmpHome();
  try {
    const raw = '[{"message":"cut off mid-pri';
    const p = ingest.quarantineLossyMonitorBatch(home, raw, 'testtag');
    assert.ok(p, 'a path is returned on success');
    assert.ok(fs.existsSync(p), 'the quarantine file actually exists on disk');
    assert.equal(fs.readFileSync(p, 'utf8'), raw, 'the quarantined content matches the raw bytes EXACTLY (recoverable)');
    assert.ok(p.startsWith(ingest.quarantineDir(home)), 'the file lives under the documented quarantine directory');
  } finally { rm(home); }
});

test('quarantineLossyMonitorBatch: fails open (returns null, never throws) when the write itself fails', () => {
  const home = tmpHome();
  try {
    const brokenFs = {
      mkdirSync: () => { throw new Error('disk full'); },
      writeFileSync: () => { throw new Error('unreachable'); },
    };
    let threw = false;
    let result;
    try { result = ingest.quarantineLossyMonitorBatch(home, 'some raw bytes', 'tag', brokenFs); }
    catch (_) { threw = true; }
    assert.equal(threw, false, 'a quarantine-write failure must never crash the caller');
    assert.equal(result, null, 'failure is reported as null, not a fabricated path');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 2b. BOUNDS (P1 fix) — quarantine was previously unbounded: no cap, no
// pruning, no rate-limit, no per-file size limit. These lock down the fix
// without violating the repo's no-delete invariant: bounding is done by
// REFUSING new writes past the cap, never by pruning/deleting existing files.
// ---------------------------------------------------------------------------

test('quarantineLossyMonitorBatch: stops writing once QUARANTINE_MAX_FILES is reached — existing files are NEVER pruned/deleted', () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < ingest.QUARANTINE_MAX_FILES; i++) {
      const p = ingest.quarantineLossyMonitorBatch(home, 'raw-' + i, 'tag' + i);
      assert.ok(p, 'write ' + i + ' should still succeed (under the cap)');
    }
    const dir = ingest.quarantineDir(home);
    const before = fs.readdirSync(dir).sort();
    assert.equal(before.length, ingest.QUARANTINE_MAX_FILES);

    const capped = ingest.quarantineLossyMonitorBatch(home, 'one-too-many', 'overflow');
    assert.equal(capped, null, 'a write past the cap is refused (returns null, not a fabricated path)');

    const after = fs.readdirSync(dir).sort();
    assert.equal(after.length, ingest.QUARANTINE_MAX_FILES, 'file count is unchanged by the refused write');
    assert.deepStrictEqual(after, before, 'every pre-existing quarantine file is still present, byte-identical set (no pruning/deletion)');
  } finally { rm(home); }
});

test('quarantineCapacityReached: true only once QUARANTINE_MAX_FILES exist; fails OPEN (false) on a readdir error', () => {
  const home = tmpHome();
  try {
    assert.equal(ingest.quarantineCapacityReached(home), false, 'an empty/nonexistent quarantine dir is never "at capacity"');
    for (let i = 0; i < ingest.QUARANTINE_MAX_FILES; i++) ingest.quarantineLossyMonitorBatch(home, 'r' + i, 't' + i);
    assert.equal(ingest.quarantineCapacityReached(home), true, 'at capacity once QUARANTINE_MAX_FILES files exist');

    const brokenFs = { readdirSync: () => { throw new Error('EIO'); } };
    assert.equal(ingest.quarantineCapacityReached(home, brokenFs), false,
      'a readdir failure fails OPEN — a bug here must never block a write that could be the only surviving evidence of a real loss');
  } finally { rm(home); }
});

test('quarantineLossyMonitorBatch: truncates a body larger than QUARANTINE_MAX_BODY_BYTES instead of writing it unbounded', () => {
  const home = tmpHome();
  try {
    const huge = 'x'.repeat(ingest.QUARANTINE_MAX_BODY_BYTES + 5000);
    const p = ingest.quarantineLossyMonitorBatch(home, huge, 'huge');
    assert.ok(p);
    const written = fs.readFileSync(p, 'utf8');
    assert.ok(Buffer.byteLength(written, 'utf8') < huge.length, 'the written file is smaller than the original oversized raw body');
    assert.ok(written.startsWith('x'.repeat(100)), 'the diagnostic PREFIX of the batch is preserved (still useful for identifying the shape)');
    assert.ok(written.includes('truncated'), 'the file records that it was truncated, so a reader never mistakes it for the full batch');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 3. Full loop integration — the destructive-read path end to end
// ---------------------------------------------------------------------------

test('runIngestLoop: a truncated monitor batch is quarantined + logged, and counted in stats.lossEvents', () => {
  const home = tmpHome();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lossq-log-'));
  const prevLogDir = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = logDir;
  try {
    const truncated = '[{"message":"a batch that got cut off by hardTimeoutMs mid-print';
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: WT,
      env: {}, run: () => ({ ok: true, raw: truncated, error: null }), sleep: () => {},
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.lossEvents, 1, 'the loss is counted exactly once');
    assert.equal(summary.stats.inserted, 0);

    // The raw bytes are recoverable on disk.
    const qDir = ingest.quarantineDir(home);
    assert.ok(fs.existsSync(qDir), 'a quarantine directory was created');
    const files = fs.readdirSync(qDir);
    assert.equal(files.length, 1, 'exactly one quarantine file for the one lossy batch');
    assert.equal(fs.readFileSync(path.join(qDir, files[0]), 'utf8'), truncated,
      'the quarantined file holds the UNRECOVERABLE raw bytes verbatim');

    // The loss was actually logged (not just silently counted).
    const logPath = path.join(logDir, 'devswarm.jsonl');
    assert.ok(fs.existsSync(logPath), 'the shared structured logger recorded the loss event');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    const entries = lines.map((l) => JSON.parse(l));
    const hit = entries.find((e) => e.op === 'monitor-batch-normalized-to-zero');
    assert.ok(hit, 'a log entry for the loss event exists: ' + JSON.stringify(entries));
    assert.equal(hit.level, 'error', 'a permanent, unrecoverable loss is logged at error level, not buried at debug/info');
  } finally {
    if (prevLogDir === undefined) delete process.env.ANTI_HALL_LOG_DIR; else process.env.ANTI_HALL_LOG_DIR = prevLogDir;
    rm(home); rm(logDir);
  }
});

test('runIngestLoop: RAPID repeated lossy batches are RATE-LIMITED to one quarantine write + one log line per window — every occurrence is still counted', () => {
  const home = tmpHome();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lossq-log3-'));
  const prevLogDir = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = logDir;
  try {
    const truncated = '[{"message":"cut off mid-print, repeated every poll (hot-spin simulation)';
    const summary = ingest.runIngestLoop({
      // 5 iterations, no real sleep (injected sleep is a no-op) -> all 5 land
      // inside the same QUARANTINE_RATE_LIMIT_MS window, simulating a fast-
      // returning/hot-spinning monitor call that would otherwise write 5
      // files and 5 error log lines for the SAME underlying fault.
      home, backend: 'journal', workspaceId: 'p', maxIterations: 5, worktree: WT,
      env: {}, run: () => ({ ok: true, raw: truncated, error: null }), sleep: () => {},
    });
    assert.equal(summary.stats.lossEvents, 5, 'every real loss occurrence is still counted, even the rate-limited ones');

    const qDir = ingest.quarantineDir(home);
    const files = fs.readdirSync(qDir);
    assert.equal(files.length, 1, 'rate-limited to exactly ONE quarantine file within the window, not one per poll');

    const logPath = path.join(logDir, 'devswarm.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    const entries = lines.map((l) => JSON.parse(l));
    const hits = entries.filter((e) => e.op === 'monitor-batch-normalized-to-zero');
    assert.equal(hits.length, 1, 'rate-limited to exactly ONE log line within the window, not one per poll');
  } finally {
    if (prevLogDir === undefined) delete process.env.ANTI_HALL_LOG_DIR; else process.env.ANTI_HALL_LOG_DIR = prevLogDir;
    rm(home); rm(logDir);
  }
});

test('runIngestLoop: an ordinary empty poll (no monitor output) never quarantines or logs anything', () => {
  const home = tmpHome();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lossq-log2-'));
  const prevLogDir = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = logDir;
  try {
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2, worktree: WT,
      env: {}, run: () => ({ ok: true, raw: '', error: null }), sleep: () => {},
    });
    assert.equal(summary.stats.lossEvents, 0, 'a genuinely empty poll window must NEVER be flagged as a loss');
    assert.ok(!fs.existsSync(ingest.quarantineDir(home)), 'no quarantine directory is created for an ordinary quiet cycle');
    const logPath = path.join(logDir, 'devswarm.jsonl');
    assert.ok(!fs.existsSync(logPath), 'no loss-event log line is emitted for an ordinary quiet cycle');
  } finally {
    if (prevLogDir === undefined) delete process.env.ANTI_HALL_LOG_DIR; else process.env.ANTI_HALL_LOG_DIR = prevLogDir;
    rm(home); rm(logDir);
  }
});

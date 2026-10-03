'use strict';
// fixtures.js — disposable fake HOME with a ~/.anti-hall state dir, a JSONL
// transcript builder, and a cleanup. Hooks read os.homedir() / write state under
// ~/.anti-hall, so each test gets its own isolated HOME so state never leaks
// between tests (and never touches the real machine).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

// Global test marker (0.108.0 launchd leak): every child this test process
// spawns from process.env carries it, so installers refuse launchd/systemd and
// user-config writes even when a caller's env drops NODE_TEST_CONTEXT.
process.env.ANTIHALL_TEST_ISOLATION = '1';

// Safety-net sweep: every makeHome() dir is tracked here, regardless of
// whether the caller ever invokes the returned cleanup(). A single after()
// hook (registered once, this module is require-cached) removes anything
// still standing when the test file finishes, so a caller that forgets
// cleanup() never leaks an `anti-hall-test-*` dir into os.tmpdir() (was
// leaking ~578 such entries across the suite). Per-test cleanup() remains
// available and still runs immediately when callers use it; this sweep is
// idempotent (fs.rmSync force) so double-removal is harmless.
const _tracked = new Set();
after(() => {
  for (const d of _tracked) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {
      /* best-effort */
    }
  }
});

// makeHome() -> a fresh temp HOME with <home>/.anti-hall created.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-'));
  _tracked.add(home);
  const antiHall = path.join(home, '.anti-hall');
  fs.mkdirSync(antiHall, { recursive: true });

  // writeSkip(obj): write ~/.anti-hall/skip.json (the escape-hatch marker).
  function writeSkip(obj) {
    fs.writeFileSync(path.join(antiHall, 'skip.json'), JSON.stringify(obj), 'utf8');
  }

  // writeTranscript(messagesArray) -> path. One JSON object per line (JSONL).
  function writeTranscript(messagesArray) {
    const p = path.join(home, 'transcript.jsonl');
    const body = messagesArray.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(p, body, 'utf8');
    return p;
  }

  // writeState(filename, obj): write an arbitrary state file under ~/.anti-hall.
  function writeState(filename, obj) {
    const p = path.join(antiHall, filename);
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return p;
  }

  function cleanup() {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (_) {
      /* best-effort */
    }
  }

  return { home, antiHall, writeSkip, writeTranscript, writeState, cleanup };
}

// Convenience: build an assistant transcript line in the Claude message shape
// the Stop hooks parse (role + content text block).
function assistantMessage(text) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

module.exports = { makeHome, assistantMessage };

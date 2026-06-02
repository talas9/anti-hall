'use strict';
// fixtures.js — disposable fake HOME with a ~/.anti-hall state dir, a JSONL
// transcript builder, and a cleanup. Hooks read os.homedir() / write state under
// ~/.anti-hall, so each test gets its own isolated HOME so state never leaks
// between tests (and never touches the real machine).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// makeHome() -> a fresh temp HOME with <home>/.anti-hall created.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-'));
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

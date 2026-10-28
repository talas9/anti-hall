'use strict';

const fs = require('fs');
const path = require('path');

function appendIndexLineIfAbsent(indexPath, sessionId, line) {
  if (!indexPath || !sessionId || !line) return;

  let existing = '';
  try {
    existing = fs.readFileSync(indexPath, 'utf8');
  } catch (_) {
    existing = '';
  }

  if (existing.includes(String(sessionId))) return;

  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const normalized = line.endsWith('\n') ? line : line + '\n';
    fs.appendFileSync(indexPath, normalized, { flag: 'a' });
  } catch (_) {
    // Hook callers fail-open; index maintenance is advisory.
  }
}

module.exports = { appendIndexLineIfAbsent };

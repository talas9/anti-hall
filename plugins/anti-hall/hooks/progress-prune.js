#!/usr/bin/env node
// anti-hall :: progress-prune (SessionStart)
//
// Archives stale per-session progress files into the matching history ledger,
// then deletes only after the append succeeds. Throttled per cwd so session
// startup stays cheap across projects.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.anti-hall', 'progress-prune-state.json');
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const PRUNE_SAFETY_MS = 6 * 60 * 60 * 1000;

function readPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  return JSON.parse(raw || '{}');
}

function cwdKey(cwd) {
  let hash = 0;
  const s = String(cwd || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return 'cwd_' + Math.abs(hash).toString(36);
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function blockquote(content) {
  const text = String(content || '');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return '> \n';
  return lines.map((line) => '> ' + line).join('\n') + '\n';
}

function archiveAndDelete(progressFile, historyFile, prunedAt) {
  let content;
  try {
    content = fs.readFileSync(progressFile, 'utf8');
  } catch (_) {
    return;
  }

  const entry =
    '\n## Archived progress (pruned ' + prunedAt + ')\n\n' +
    blockquote(content) +
    '\n';

  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.appendFileSync(historyFile, entry, { flag: 'a' });
    fs.unlinkSync(progressFile);
  } catch (_) {
    // Fail-safe: if archive append or delete fails, never risk deleting first.
  }
}

function pruneProject(cwd, now) {
  const progressRoot = path.join(cwd, '.anti-hall', 'progress');
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const entries = fs.readdirSync(progressRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dateDir = entry.name;
    if (dateDir === todayUtc || dateDir === 'legacy' || dateDir === 'INDEX.md') continue;

    const dirPath = path.join(progressRoot, dateDir);
    let files = [];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const progressFile = path.join(dirPath, file.name);
      let st;
      try {
        st = fs.statSync(progressFile);
      } catch (_) {
        continue;
      }
      if (now - st.mtimeMs <= PRUNE_SAFETY_MS) continue;

      const sessionId = path.basename(file.name, '.md');
      const historyFile = path.join(cwd, '.anti-hall', 'history', dateDir, sessionId + '.md');
      archiveAndDelete(progressFile, historyFile, new Date(now).toISOString());
    }
  }
}

function main() {
  const payload = readPayload();
  const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!cwd) return;

  const now = Date.now();
  const key = cwdKey(cwd);
  const state = readState();
  const projectState = state[key] && typeof state[key] === 'object' ? state[key] : {};
  const lastPrunedAt = Number.isFinite(projectState.lastPrunedAt) ? projectState.lastPrunedAt : 0;
  if (now - lastPrunedAt >= 0 && now - lastPrunedAt < THROTTLE_MS) return;

  pruneProject(cwd, now);
  state[key] = { lastPrunedAt: now };
  writeState(state);
}

try {
  main();
} catch (_) {
  // Fail-open: SessionStart must never be blocked by progress pruning.
}
process.exit(0);

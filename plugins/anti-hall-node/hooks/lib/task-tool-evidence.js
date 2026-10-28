'use strict';
// anti-hall :: task-tool-evidence — decides which form of the tasklist-guard nag a session gets
// (cost-trim Phase 1; setting guards.tasklistNoTaskTools).
//
// Why a transcript parse and not the tool list: under `claude -p` the task tools are listed in the
// init tool list but DEFERRED (ToolSearch needed before first use), and the list is the same for
// every --tools variant tried, so "TaskCreate is (not) listed" proves nothing. No hook payload lists
// available tools either. Evidence that task tools exist is therefore structural, never a substring:
//   - an assistant tool_use named TaskCreate / TaskUpdate / TodoWrite;
//   - an attachment entry (type 'attachment') whose attachment.type starts with 'deferred_tools'
//     and whose addedNames names TaskCreate;
//   - an attachment entry of attachment.type 'task_reminder'.
// A line that merely CONTAINS "TaskCreate" (this guard's own nag text, a quoted file) is not evidence.
//
// Positive ABSENCE (the only trigger for the reduced nag) is a Codex session with no such evidence:
// Codex has no TaskCreate tool, so demanding it is wrong. A Claude session with no evidence keeps
// today's full demand: in an interactive session task tools exist before they leave a trace.
//
// Pure Node built-ins. Never throws.

const fs = require('fs');

const WIDE_WINDOW = 16 * 1024 * 1024; // same widening as tasklist-guard's hasTaskActivityInText
const TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const PRE = /TaskCreate|TaskUpdate|TodoWrite|task_reminder/;

function toolUseNames(entry) {
  const out = [];
  const content = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  for (const b of content) if (b && b.type === 'tool_use' && typeof b.name === 'string') out.push(b.name);
  return out;
}

// entryIsEvidence(entry) -> bool. Strict structural check of one parsed transcript entry.
function entryIsEvidence(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'assistant') return toolUseNames(entry).some((n) => TOOL_NAMES.has(n));
  if (entry.type === 'attachment' && entry.attachment && typeof entry.attachment === 'object') {
    const a = entry.attachment;
    if (a.type === 'task_reminder') return true;
    if (typeof a.type === 'string' && a.type.startsWith('deferred_tools')) {
      return Array.isArray(a.addedNames) && a.addedNames.indexOf('TaskCreate') !== -1;
    }
  }
  return false;
}

// hasEvidence(transcriptPath) -> bool. Reads at most the last 16 MB; unreadable -> false.
function hasEvidence(transcriptPath) {
  let fd = null;
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return false;
    const size = fs.statSync(transcriptPath).size;
    if (size <= 0) return false;
    const n = Math.min(size, WIDE_WINDOW);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(transcriptPath, 'r');
    const got = fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8', 0, got).split(/\r?\n/);
    if (size > n) lines.shift(); // possibly-partial first line
    for (const line of lines) {
      if (!PRE.test(line)) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (entryIsEvidence(e)) return true;
    }
    return false;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

// configuredForm(opts) -> 'reduced' | 'full' | 'skip'. guards.tasklistNoTaskTools; when it was NOT set
// explicitly (source 'default'), context.protocolLevel=full flips the default to 'full' (one-key
// rollback). A settings failure -> 'full' (never trade protection for a read error).
function configuredForm(opts) {
  try {
    const s = require('./settings.js');
    const v = s.get('guards', 'tasklistNoTaskTools', 'reduced', opts);
    if (s.source('guards', 'tasklistNoTaskTools', opts) === 'default' &&
        s.get('context', 'protocolLevel', 'compact', opts) === 'full') return 'full';
    return v === 'full' || v === 'skip' ? v : 'reduced';
  } catch (_) {
    return 'full';
  }
}

// nagForm({ codex, transcriptPath, opts }) -> 'full' | 'reduced' | 'skip'.
// 'full' unless the session is positively known to lack task tools AND the setting allows it.
function nagForm(o) {
  try {
    const cfg = configuredForm(o && o.opts);
    if (cfg === 'full') return 'full';
    if (!(o && o.codex)) return 'full';
    if (hasEvidence(o.transcriptPath)) return 'full';
    return cfg;
  } catch (_) {
    return 'full';
  }
}

module.exports = { entryIsEvidence, hasEvidence, configuredForm, nagForm };

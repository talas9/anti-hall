#!/usr/bin/env node
// anti-hall :: edit-guard (PreToolUse Write|Edit|MultiEdit|NotebookEdit — coordinator only)
//
// WHAT IT DOES
//   Blocks direct file edits (Edit, Write, MultiEdit, NotebookEdit) when running in a
//   COORDINATOR context, requiring the model to delegate the edit to a subagent
//   instead. Silent pass-through in subagent context. Mirrors command-guard.js, but
//   for the Edit-family tools instead of Bash.
//
// COORDINATOR vs SUBAGENT DETECTION
//   Shared with command-guard.js — see hooks/coordinator-detect.js for the full
//   rationale (payload agent_id/agent_type is the reliable signal; entrypoint is a
//   fallback; fail-open on ambiguity).
//
// ALLOWLIST
//   Some paths are legitimately coordinator-owned (docs the coordinator itself is
//   expected to maintain, its own state/plan files). These are always allowed,
//   matched against a default glob list plus any globs supplied via
//   ANTIHALL_EDIT_GUARD_ALLOW (split on ':' and ','). Default patterns WITH '/'
//   (directory globs like '.claude/**') match by BOTH basename and cwd-relative
//   path, as before. Default BARE-filename patterns (no '/', e.g. 'CLAUDE.md',
//   'PLAN.md', 'STATE.json') are root-anchored: they match ONLY a root-level file
//   (no '/' in the cwd-relative path), never a same-named file nested anywhere
//   else in the tree. Env-supplied globs are unrestricted, as before.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { file_path | notebook_path, ... } }
//   stdout : JSON { decision: "block", reason: "..." } | nothing
//   exit 2 : to block (decision field); exit 0: allow
//   Fail-open on ANY error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');

// Tools this guard applies to. Anything else passes through untouched.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Default allow-globs: paths the coordinator is documented/expected to touch
// directly (its own state/plan/docs), never delegated.
const DEFAULT_ALLOW = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  '.claude/**', '.omc/**', '.anti-hall/**',
  'PLAN.md', 'STATE.json',
];

// Cross-platform basename: handle both / and \ path separators (mirrors
// command-guard.js's basename()).
function basename(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/');
  return parts[parts.length - 1];
}

// Normalize a path to forward slashes and, if absolute + a cwd is known, make
// it cwd-relative so a glob like '.claude/**' can match regardless of how the
// tool_input path was expressed.
function toRelPath(filePath, cwd) {
  if (!filePath) return '';
  let p = String(filePath);
  if (cwd) {
    try {
      if (path.isAbsolute(p)) p = path.relative(cwd, p);
    } catch (_) {
      // keep p as-is
    }
  }
  return p.replace(/\\/g, '/');
}

// Small self-contained glob matcher: '**' matches any sequence of characters
// (including '/'), '*' matches any sequence EXCEPT '/'. No new deps.
function escapeRegExpChar(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}
function globToRegExp(glob) {
  let src = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      src += '.*';
      i += 2;
      continue;
    }
    if (c === '*') {
      src += '[^/]*';
      i += 1;
      continue;
    }
    src += escapeRegExpChar(c);
    i += 1;
  }
  return new RegExp('^' + src + '$');
}

// isAllowed(filePath, cwd): true if filePath matches any default allow-glob or
// any glob from ANTIHALL_EDIT_GUARD_ALLOW (split on both ':' and ','). Empty
// filePath matches nothing (falls through to block).
//
// BARE-FILENAME ANCHORING: a DEFAULT_ALLOW pattern with no '/' (e.g.
// 'CLAUDE.md', 'PLAN.md', 'STATE.json') is a coordinator-owned ROOT file, not
// a filename anyone may drop anywhere in the tree. Such patterns are matched
// against the cwd-relative path AND required to have no '/' in it (i.e. the
// file must live at repo root) — matching only against the basename would
// silently allow-list e.g. 'src/deep/nested/CLAUDE.md', defeating the
// delegation gate for any nested file that happens to share a root filename.
// DEFAULT_ALLOW patterns WITH '/' (directory globs like '.claude/**') are
// unchanged: matched against both basename and cwd-relative path as before.
// Env-supplied globs (ANTIHALL_EDIT_GUARD_ALLOW) are also unchanged, so a user
// can opt back into nested matches (e.g. '**/CLAUDE.md') at any depth.
function isAllowed(filePath, cwd) {
  if (!filePath) return false;
  const base = basename(filePath);
  const rel = toRelPath(filePath, cwd);
  for (const pat of DEFAULT_ALLOW) {
    const re = globToRegExp(pat);
    if (pat.includes('/')) {
      if (re.test(base) || re.test(rel)) return true;
    } else {
      if (!rel.includes('/') && re.test(rel)) return true;
    }
  }
  const envAllow = String(process.env.ANTIHALL_EDIT_GUARD_ALLOW || '')
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pat of envAllow) {
    const re = globToRegExp(pat);
    if (re.test(base) || re.test(rel)) return true;
  }
  return false;
}

function main() {
  // Read stdin first (fail-open on any read error).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('edit-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  // Only block in coordinator context (subagents pass through).
  const { isCoordinator } = require('./coordinator-detect.js');
  if (!isCoordinator(payload)) process.exit(0);

  const toolName = payload && payload.tool_name;
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);

  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolName === 'NotebookEdit'
    ? (toolInput.notebook_path || '')
    : (toolInput.file_path || '');
  const cwd = (payload && payload.cwd) || '';

  if (isAllowed(filePath, cwd)) process.exit(0);

  // DevSwarm-aware wording switch (mirrors devswarm-child-role.js's pattern).
  let devswarmActive = false;
  try {
    devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
  } catch (_) {
    devswarmActive = false; // fail-open: treat as standalone/dormant
  }

  const reason = devswarmActive
    ? ('DEVSWARM EDIT-DELEGATION RULE: the sub-orchestrator does not touch files ' +
       'directly in its workspace — spawn a subagent to make this edit and have it ' +
       'report a tight summary. (tool: ' + toolName + ')')
    : ('EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
       'a subagent to make this edit and have it report a tight summary. The ' +
       'coordinator synthesizes the summary; raw edits never happen in the main ' +
       'thread. (tool: ' + toolName + ')');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);

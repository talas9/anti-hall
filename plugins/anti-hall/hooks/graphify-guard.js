#!/usr/bin/env node
// anti-hall :: graphify-guard (PreToolUse Grep/Glob/Bash — graph-first enforcement)
//
// When a graphify knowledge graph exists in the current project, blocks the FIRST
// code-navigation search of the session and prompts the model to query the graph
// first instead. Raw search is allowed on the second and subsequent calls (the model
// tried the graph and it didn't have the answer).
//
// SCOPE
//   Intercepts PreToolUse for:
//     - Grep tool (any call)
//     - Glob tool (any call)
//     - Bash tool: only if the command's first verb is a code-nav search tool
//       (grep, rg, ag, find, git grep / git log --grep / git log -S).
//   Does NOT block a Bash command that is itself a graphify query (/graphify).
//
// GRAPH DETECTION
//   Looks for graphify-out/ or .planning/graphs/ at the cwd (from stdin payload)
//   or the git toplevel. If no graph is found, this hook is a silent no-op.
//
// LOOP SAFETY (per-session, per-project)
//   Blocks ONCE per session per project-root. After the first block, a marker under
//   os.tmpdir()/anti-hall/ is written, and subsequent calls exit 0 (allow). This
//   means the model is nudged once, then allowed to proceed without repeated friction.
//
// Fail-open on ANY error (exit 0). Never blocks when uncertain.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input, session_id?, cwd?, ... }
//   stdout : JSON { decision: "block", reason: "..." } | nothing
//   exit 2 : to block; exit 0: allow
//   Fail-open on any error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Code-nav search verbs that warrant a graph-first nudge.
const SEARCH_VERBS = new Set(['grep', 'rg', 'ag', 'find', 'ack']);

// Git subcommand patterns that are code search.
// We check "git grep", "git log --grep=", "git log -S", "git log -G"
const GIT_SEARCH_RE = /\bgit\s+(?:grep\b|log\s+.*(?:--grep=|-S|-G)\b)/i;

function gitToplevel(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const top = (out || '').split(/\r?\n/)[0].trim();
    return top || null;
  } catch (_) {
    return null;
  }
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function findGraphRoot(cwd) {
  const roots = [cwd];
  const top = gitToplevel(cwd);
  if (top && top !== cwd) roots.push(top);
  for (const root of roots) {
    if (!root) continue;
    if (safeIsDir(path.join(root, 'graphify-out'))) return root;
    if (safeIsDir(path.join(root, '.planning', 'graphs'))) return root;
  }
  return null;
}

function isGraphifyBashCommand(command) {
  if (typeof command !== 'string') return false;
  // If the command contains /graphify, it IS a graphify query — do not block.
  return /\/graphify\b/.test(command);
}

function isCodeNavBashCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // Strip env prefix (FOO=bar grep ...) by finding first non-assignment token
  const tokens = command.trim().split(/\s+/);
  let verbIndex = 0;
  while (verbIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[verbIndex])) {
    verbIndex++;
  }
  const rawVerb = tokens[verbIndex] || '';
  const verb = rawVerb.replace(/^.*\//, '').toLowerCase();

  if (SEARCH_VERBS.has(verb)) return true;
  if (GIT_SEARCH_RE.test(command)) return true;
  return false;
}

function getSessionGraphKey(sessionId, graphRoot) {
  const combined = String(sessionId) + '|' + String(graphRoot);
  return crypto.createHash('sha1').update(combined).digest('hex').slice(0, 20);
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const toolName = (payload && typeof payload.tool_name === 'string') ? payload.tool_name : '';
  const toolInput = (payload && payload.tool_input) ? payload.tool_input : {};

  // Determine if this is a code-nav search call.
  let isSearch = false;
  if (toolName === 'Grep' || toolName === 'Glob') {
    isSearch = true;
  } else if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    // Graphify queries are explicitly allowed — do not intercept them.
    if (isGraphifyBashCommand(command)) {
      process.exit(0);
    }
    isSearch = isCodeNavBashCommand(command);
  }

  if (!isSearch) {
    process.exit(0);
  }

  // Determine cwd.
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd)
    ? payload.cwd
    : process.cwd();

  // Check for a graphify graph.
  let graphRoot;
  try {
    graphRoot = findGraphRoot(cwd);
  } catch (_) {
    process.exit(0); // fail-open
  }
  if (!graphRoot) {
    process.exit(0); // no graph -> nothing to enforce
  }

  // Session + project key for the once-per-session marker.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  const key = getSessionGraphKey(sessionId, graphRoot);

  const stateDir = path.join(os.tmpdir(), 'anti-hall');
  const markerFile = path.join(stateDir, 'graphify-guard-' + key);

  // Already blocked this session for this project -> allow (model tried the graph).
  try {
    if (fs.existsSync(markerFile)) {
      process.exit(0);
    }
  } catch (_) {
    process.exit(0); // fail-open
  }

  // Write the marker BEFORE blocking so the next call is always allowed.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(markerFile, String(Date.now()), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> fail-open (allow)
  }

  const graphDir = safeIsDir(path.join(graphRoot, 'graphify-out'))
    ? path.join(graphRoot, 'graphify-out')
    : path.join(graphRoot, '.planning', 'graphs');

  const toolLabel = toolName === 'Bash'
    ? ('Bash: ' + String((toolInput.command || '').slice(0, 80)))
    : toolName;

  const reason =
    'GRAPHIFY-FIRST: this project has a knowledge graph at "' + graphDir + '". ' +
    'Query it FIRST before raw code search: run `/graphify query "<question>"` ' +
    'or read the wiki index at "' + path.join(graphDir, 'wiki', 'index.md') + '". ' +
    'Raw search (' + toolLabel + ') is allowed after the graph has been consulted ' +
    'or lacks the answer (this block fires only once per session). ' +
    'Stop. Query the graph. Then come back to search if needed.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);

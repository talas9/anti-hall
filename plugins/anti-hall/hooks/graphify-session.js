#!/usr/bin/env node
// anti-hall :: graphify-first session primer (SessionStart)
//
// If the current project has a graphify knowledge graph, inject context telling
// the model to QUERY THE GRAPH FIRST (before grep / find / broad file reads)
// when answering "where/why/how does X work" questions.
//
// Safe no-op when graphify isn't used: if no graph is found we emit nothing and
// exit 0. Pure Node built-ins only (OS-agnostic). JSON via JSON.stringify so a
// graph path containing `"` / `\` / spaces yields VALID JSON (F-10).
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { session_id, cwd, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext } | nothing
//   exit 0 : always (never blocks). Fail-open on any error.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Detect git toplevel cross-platform by spawning git directly (no shell, no
// pipe through unix tools). Returns null if not a repo / git unavailable.
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

function findGraphDir(roots) {
  for (const root of roots) {
    if (!root) continue;
    const a = path.join(root, 'graphify-out');
    if (safeIsDir(a)) return a;
    const b = path.join(root, '.planning', 'graphs');
    if (safeIsDir(b)) return b;
  }
  return null;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function main() {
  // cwd: prefer the payload's cwd if present, else process.cwd().
  let cwd = process.cwd();
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    if (payload && typeof payload.cwd === 'string' && payload.cwd) {
      cwd = payload.cwd;
    }
  } catch (_) {
    // ignore - cwd fallback already set
  }

  const roots = [cwd];
  const top = gitToplevel(cwd);
  if (top && top !== cwd) roots.push(top);

  const graphDir = findGraphDir(roots);
  if (!graphDir) {
    // No graph -> safe no-op.
    process.exit(0);
  }

  const wikiIndex = path.join(graphDir, 'wiki', 'index.md');
  const additionalContext =
    "GRAPHIFY-FIRST PROTOCOL: this project has a graphify knowledge graph at '" +
    graphDir + "'. ALWAYS query the graph FIRST when looking up ANY issue, " +
    "feature, function, class, code path, configuration, document, or " +
    "'where/why/how does X work' / 'what connects to Y' question - BEFORE grep / " +
    "find / glob or broad file reads. Run '/graphify query \"<question>\"' (or " +
    "read '" + wikiIndex + "' / GRAPH_REPORT.md if present). The graph is the " +
    "FIRST resort, not the last; fall back to raw search only when the graph " +
    "lacks the answer. KEEP THE GRAPH UP TO DATE: after any change that " +
    "adds/moves/removes code or docs, and at the END of any session with " +
    "significant work, update it with '/graphify --obsidian'.";

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);

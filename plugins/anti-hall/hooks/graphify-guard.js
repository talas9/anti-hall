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
      timeout: 2000,
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

// Split a command on the shell sequencing operators ; && || | (and newlines) so
// each segment can be inspected for its OWN effective verb. Quote-aware so an
// operator inside a quoted string is not a split point.
function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;
  function flush() { if (cur.trim().length) segments.push(cur); cur = ''; }
  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';
    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') { flush(); i++; continue; }
    if (c === ';') { flush(); i++; continue; }
    if (c === '&') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }
    if (c === ')' || c === '(' || c === '{' || c === '}') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flush(); i += 2; continue; }
    if (c === '`') { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return segments;
}

// The effective verb of one segment: skip leading VAR=value assignments, return
// the first real token (with its leading path stripped, e.g. /usr/bin/grep -> grep).
// Keeps a leading `/` for the `/graphify` slash-command case (it is the literal verb).
const GRAPHIFY_WRAPPERS = new Set(['command', 'builtin', 'exec', 'sudo', 'env',
  'nice', 'nohup', 'time', 'timeout', 'then', 'do', 'else']);

function segmentVerb(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  // Skip wrapper words so `sudo rg secret` / `time grep x` are still detected as
  // code-nav. Best-effort: skip a wrapper and any immediately following -flags;
  // for env, skip VAR=value operands too. Keep the leading `/` for /graphify.
  while (i < tokens.length) {
    const word = tokens[i].replace(/^.*\//, '').toLowerCase();
    if (!GRAPHIFY_WRAPPERS.has(word)) break;
    i++;
    while (i < tokens.length &&
           (tokens[i].startsWith('-') ||
            (word === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))) i++;
    // timeout/nice carry a non-flag operand (duration / niceness); skip one.
    if ((word === 'timeout') && i < tokens.length && !tokens[i].startsWith('/')) i++;
  }
  return tokens[i] || '';
}

function isGraphifyBashCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // Exempt ONLY when /graphify is the EFFECTIVE command verb of a segment, not
  // merely a substring (so `echo /graphify && rg secret` is NOT exempted and the
  // rg segment is still subject to the graph-first nudge). The slash-command verb
  // is literally `/graphify`.
  for (const seg of splitSegments(command)) {
    const verb = segmentVerb(seg);
    if (/^\/graphify\b/.test(verb) || verb === '/graphify') return true;
  }
  return false;
}

// Shell verbs whose `-c '<payload>'` argument is itself command(s) to recurse into.
const SHELL_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// Extract command strings hidden in command substitution `$(...)` / backticks.
// Quote-aware: single quotes suppress $(...) expansion; backticks stay active
// inside double quotes. Balances nested parens so $(a $(b)) is captured whole.
function extractSubstitutions(s) {
  const found = [];
  let i = 0;
  const n = s.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = s[i];
    const c2 = i + 1 < n ? s[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (!inDouble && c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = !inDouble; i++; continue; }
    if (c === '$' && c2 === '(') {
      let depth = 1; let j = i + 2; let inner = '';
      while (j < n && depth > 0) {
        const cj = s[j];
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        inner += cj; j++;
      }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let inner = '';
      while (j < n && s[j] !== '`') { inner += s[j]; j++; }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

// If a segment is `bash -c '<payload>'` (or sh/zsh/dash -c "..."), return the
// unquoted payload command string, else ''. Best-effort quote-aware tokenizer.
function extractShellCPayload(segment) {
  const verb = segmentVerb(segment).replace(/^.*\//, '').toLowerCase();
  if (!verb || !SHELL_VERBS.has(verb)) return '';
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c' || t === '--command' || /^-[a-z]*c$/.test(t)) {
      return i + 1 < tokens.length ? tokens[i + 1] : '';
    }
  }
  return '';
}

function isCodeNavBashCommand(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const d = typeof depth === 'number' ? depth : 0;
  // Per-segment: a command is code-nav if ANY segment's effective verb is a
  // search tool (so `cd app && rg foo` is caught, not just first-verb commands).
  for (const seg of splitSegments(command)) {
    const rawVerb = segmentVerb(seg);
    const verb = rawVerb.replace(/^.*\//, '').toLowerCase();
    if (SEARCH_VERBS.has(verb)) return true;
    if (GIT_SEARCH_RE.test(seg)) return true;
    if (d < 3) {
      // bash -c "rg foo" payload — unwrap and check the inner command(s).
      const payload = extractShellCPayload(seg);
      if (payload && isCodeNavBashCommand(payload, d + 1)) return true;
    }
  }
  // Command substitution: `echo "$(rg foo)"` hides the search in $(...).
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      if (isCodeNavBashCommand(inner, d + 1)) return true;
    }
  }
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

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('graphify-guard')) process.exit(0);

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

  const stateDir = path.join(os.homedir(), '.anti-hall');
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
    ? 'Bash search/command'
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

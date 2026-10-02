'use strict';
// anti-hall :: shared-tree-note — ADVISORY (never blocks) for an Agent/Task spawn
// that is write-capable, has no `isolation: "worktree"`, while ANOTHER write-capable
// agent is still running in the same working tree: two such agents can stage and
// commit each other's uncommitted hunks. Silent when anything is unknown.
// Setting: guards.sharedTreeAgentNote (default on).

// Types that cannot edit files (their definitions exclude Edit/Write).
const READ_ONLY_TYPES = new Set([
  'explore', 'plan', 'claude-code-guide', 'web-fetch',
  'oh-my-claudecode:explore', 'oh-my-claudecode:analyst', 'oh-my-claudecode:architect',
  'oh-my-claudecode:code-reviewer', 'oh-my-claudecode:critic', 'oh-my-claudecode:document-specialist',
  'oh-my-claudecode:scientist', 'oh-my-claudecode:security-reviewer', 'oh-my-claudecode:verifier',
]);
const WRITE_TOOLS = ['edit', 'write', 'multiedit', 'notebookedit'];
const NO_WORKTREES_RE = /\bno\s+(?:git\s+)?worktrees?\b/i;

function toolList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return null;
}

// writeCapable(spawnInput) -> boolean. Unknown type / no tool list = write-capable.
function writeCapable(inp) {
  const i = inp && typeof inp === 'object' ? inp : {};
  const t = typeof i.subagent_type === 'string' ? i.subagent_type.trim().toLowerCase() : '';
  if (t && READ_ONLY_TYPES.has(t)) return false;
  const allow = toolList(i.tools || i.allowed_tools || i.allowedTools);
  if (allow && !allow.some((x) => WRITE_TOOLS.includes(x))) return false;
  const deny = toolList(i.disallowedTools || i.disallowed_tools);
  if (deny && WRITE_TOOLS.filter((x) => x !== 'notebookedit').every((x) => deny.includes(x))) return false;
  return true;
}

function isolated(inp) {
  const v = inp && typeof inp.isolation === 'string' ? inp.isolation.trim().toLowerCase() : '';
  return v === 'worktree' || v === 'remote';
}

// sharedTreeNote(payload, opts?) -> advisory text, or '' (silent). Fail-open to ''.
function sharedTreeNote(payload, opts) {
  try {
    if (!require('./settings.js').enabled('guards', 'sharedTreeAgentNote')) return '';
    const inp = payload && payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : null;
    if (!inp || !writeCapable(inp) || isolated(inp)) return '';
    const tp = payload.transcript_path;
    if (!tp || typeof tp !== 'string') return '';
    const agents = require('./agent-scan.js').runningAgents(tp);
    if (!Array.isArray(agents)) return '';
    // Another agent counts only when its own spawn input is known, write-capable and not isolated.
    if (!agents.some((a) => a && a.spawnInput && writeCapable(a.spawnInput) && !isolated(a.spawnInput))) return '';
    const home = opts && opts.home;
    const noWt = require('./dispatch-tier.js').repoDocsMatch(String(payload.cwd || process.cwd()), home, NO_WORKTREES_RE);
    return 'SHARED-TREE (advisory): another write-capable agent is still running in this working tree, and this spawn is write-capable too. '
      + 'Two such agents can stage and commit each other\'s uncommitted changes. '
      + (noWt
        ? 'Serialize them or give each its own scratch clone.'
        : 'Pass isolation:"worktree", serialize them, or give each its own scratch clone.');
  } catch (_) { return ''; }
}

module.exports = { sharedTreeNote, writeCapable, isolated };

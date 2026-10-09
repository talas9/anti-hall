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

// A spawn is treated as working OUTSIDE the session's git tree only when its prompt
// ESTABLISHES a scratch working location: "work in a scratch clone/dir", or a
// work-in / cd / cwd statement whose target is a /tmp, /private/tmp, /var/folders or
// scratchpad path. A bare mention ("use a scratch directory for notes", "verify in a
// scratch clone afterwards", an output/spec path, a verify clone) establishes nothing.
// Silent also requires no in-place statement about the session repo and no negation.
// When unsure: warn.
const SCRATCH_PATH = String.raw`[\x60'"]?(?:\/private\/tmp\/|\/tmp\/|\/var\/folders\/|[^\s\x60'"]*scratchpad\b)`;
const SCRATCH_RE = new RegExp([
  String.raw`\bwork(?:ing)?\s+(?:in|inside)\s+(?:a|an|the|your)?\s*scratch\s+(?:clone|dir(?:ectory)?|copy)\b`,
  String.raw`\b(?:cwd\s+is|cwd|work(?:ing)?\s+(?:in|inside)|working\s+dir(?:ectory)?|cd(?:\s+into)?)\s*[:=]?\s*` + SCRATCH_PATH,
  String.raw`\bscratch\s+(?:clone|dir(?:ectory)?|copy)\s+(?:under|at|in)\s+` + SCRATCH_PATH,
  String.raw`\bclone\s+(?:\S+\s+)?into\s+` + SCRATCH_PATH + String.raw`[^\s]*\s+and\s+(?:work|edit|make|fix)\b`,
  // a separate git worktree elsewhere (an absolute or ~ path) is its own working tree, as is "its own worktree"
  String.raw`\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\s+(?:-\S+\s+)*[\x60'"]?(?:~\/|\/|\$HOME\/)`,
  String.raw`\b(?:its|your|their)\s+own\s+(?:git\s+)?worktrees?\b`,
].join('|'), 'i');
const SCRATCH_NEGATED_RE = /\b(?:not|no|without|instead\s+of)\s+(?:in\s+|a\s+|the\s+|any\s+)?scratch\b/i;
const IN_PLACE_RE = /\bin\s+place\b|\bin\s+(?:the\s+)?(?:session\s+)?repo\b|\brepo\s+files\b|\b(?:session|main)\s+(?:checkout|working\s+tree)\b|\bin\s+the\s+(?:working\s+tree|checkout)\b|\bworking\s+copy\b|\bchecked[- ]out\s+(?:files?|tree|copy|branch)\b|\bon\s+main\b|\bmain\s+branch\b/i;
function inScratch(inp) {
  const i = inp && typeof inp === 'object' ? inp : {};
  const t = String(i.prompt || '') + '\n' + String(i.description || '');
  return SCRATCH_RE.test(t) && !SCRATCH_NEGATED_RE.test(t) && !IN_PLACE_RE.test(t);
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
    if (!inp || !writeCapable(inp) || isolated(inp) || inScratch(inp)) return '';
    const tp = payload.transcript_path;
    if (!tp || typeof tp !== 'string') return '';
    const agents = require('./agent-scan.js').runningAgents(tp);
    if (!Array.isArray(agents)) return '';
    // Another agent counts only when its own spawn input is known, write-capable and not isolated.
    if (!agents.some((a) => a && a.spawnInput && writeCapable(a.spawnInput) && !isolated(a.spawnInput) && !inScratch(a.spawnInput))) return '';
    const home = opts && opts.home;
    const noWt = require('./dispatch-tier.js').repoDocsMatch(String(payload.cwd || process.cwd()), home, NO_WORKTREES_RE);
    return require('./block-message.js').message({
      kind: 'warn',
      guard: 'shared-tree',
      what: 'another write-capable agent is still running in this working tree, and this spawn is write-capable too.',
      why: 'Two such agents can stage and commit each other\'s uncommitted changes.',
      instead: noWt ? 'serialize them or give each its own scratch clone.' : 'pass isolation:"worktree", serialize them, or give each its own scratch clone.',
    });
  } catch (_) { return ''; }
}

module.exports = { sharedTreeNote, writeCapable, isolated, inScratch };

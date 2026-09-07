#!/usr/bin/env node
// anti-hall :: graphify-guard (PreToolUse Grep/Glob/Bash — graph-first ADVISORY,
// plus a real child-workspace graphify write-ban)
//
// TWO independent concerns, two different enforcement levels:
//
//   1. CHILD-WORKSPACE WRITE-BAN (real block, exit 2). A DevSwarm child
//      workspace (isChildWorkspace(process.env)) may READ the graphify graph
//      but must never WRITE/regenerate it — the graph is maintained by the
//      Primary only. A Bash command whose effective verb resolves to graphify
//      AND classifies as a write (`graphify update`, `--update`, `--obsidian`,
//      or a bare target path with no read subcommand) is blocked with a
//      specific reason. `/graphify query ...` and anything unclassifiable are
//      allowed (fail-open).
//
//   2. QUERY-FIRST ADVISORY (non-blocking, exit 0). When a graphify knowledge
//      graph exists in the current project, the FIRST code-navigation search
//      of the session gets an informational nudge (hookSpecificOutput /
//      additionalContext) suggesting `/graphify query` first. This never
//      blocks — isSubagent() already exits before this point, so essentially
//      all delegated code search never reached this nudge anyway; blocking
//      only added friction to the coordinator (including on legitimate
//      commands like `git diff | grep`).
//
// SCOPE
//   Intercepts PreToolUse for:
//     - Grep tool (any call)
//     - Glob tool (any call)
//     - Bash tool: the code-nav-search advisory checks the command's effective
//       verb(s) (grep, rg, ag, find, git grep / git log --grep / git log -S);
//       the write-ban checks EVERY segment's effective verb for a graphify
//       write, independent of code-nav search detection.
//   Does NOT nudge/exempt a Bash command that is itself a graphify query
//   (/graphify) from the advisory.
//
// GRAPH DETECTION
//   Looks for graphify-out/ at the cwd (from stdin payload) or the git toplevel.
//   (`.planning/graphs/` — a GSD-adjacent fallback location — was removed
//   2026-07-03; GSD is discontinued.) If no graph is found, this hook is a
//   silent no-op.
//
// LOOP SAFETY (per-session, per-project, RE-ARMING)
//   Advises once per (session, project-root, nudge window) — non-blocking,
//   exit 0, hookSpecificOutput.additionalContext only (this code-nav path used
//   to block via exit 2/decision:block; it is advisory-only as of 2026-08-23 —
//   see the exit-2 write-ban carve-out in the Contract section below, and
//   tests/hooks/graphify-guard.test.js). After an advisory, a marker
//   under os.homedir()/.anti-hall is written and subsequent calls exit 0 (allow)
//   until the marker EXPIRES, at which point the nudge re-arms and the next
//   code-nav search advises again. Expiry fires on whichever trigger passes first
//   (mirrors task-tracker.js's dual-trigger design; KB-claude-codex.md's §6.2
//   adherence-cadence guidance: re-inject every 40-80K new tokens):
//     - the transcript has grown by REARM_GROWTH_BYTES (~240KB, the 40-80K-token
//       midpoint at a common ~4 bytes/token estimate) since the marker was
//       written, OR
//     - REARM_MS (2h) of wall-clock time has elapsed since the marker was written.
//   This keeps the nudge from firing on every call (never a loop) while ensuring a
//   long/heavy session gets re-nudged instead of going silent for the rest of it.
//
// COORDINATOR-ONLY (subagent-aware)
//   session_id is IDENTICAL between a coordinator and any Task-tool subagent it
//   spawns (verified empirically against this repo — see KB-claude-codex.md), so
//   a delegated subagent's OWN first code-nav search would otherwise silently
//   burn the COORDINATOR's one-time nudge. isSubagent() mirrors command-guard.js's
//   discriminator (agent_id/agent_type in the payload, or
//   CLAUDE_CODE_ENTRYPOINT === 'agent_tool'): when true, this hook exits 0
//   immediately and never reads or writes the marker, so subagent searches always
//   pass straight through without touching the coordinator's state.
//
// Fail-open on ANY error (exit 0). Never blocks when uncertain.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input, session_id?, cwd?, ... }
//   stdout : JSON { decision: "block", reason: "..." }               (write-ban)
//          | JSON { hookSpecificOutput: { hookEventName: "PreToolUse",
//                   additionalContext: "..." } }                      (advisory)
//          | nothing
//   exit 2 : write-ban block only; exit 0: everything else (allow / advisory).
//   Fail-open on any error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { isSubagent } = require('./coordinator-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');

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

function safeIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function findGraphRoot(cwd) {
  const roots = [cwd];
  const top = gitToplevel(cwd);
  if (top && top !== cwd) roots.push(top);
  for (const root of roots) {
    if (!root) continue;
    if (safeIsDir(path.join(root, 'graphify-out'))) return root;
  }
  return null;
}

// Split a command on the shell sequencing operators ; && || | (and newlines) so
// each segment can be inspected for its OWN effective verb. Quote-aware so an
// operator inside a quoted string is not a split point.
// Heredoc opener regex: <<[-]WORD, <<'WORD', <<"WORD", <<WORD. Captures the
// dash (tab-stripping mode) and the terminator word (quoted or bare).
const HEREDOC_RE = /^<<(-)?\s*("([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/;

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
    if (c === '<' && c2 === '<') {
      const m = HEREDOC_RE.exec(cmd.slice(i));
      const word = m ? (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5])) : '';
      if (m && word) {
        // Keep the opener text (e.g. `<<'EOF'`) as part of the current
        // segment so the invoking command's own verb is still classified
        // normally, but SKIP the heredoc body entirely (do not scan its
        // lines as separate segments/commands) — see P1-a header note.
        const dashStrip = !!m[1];
        cur += m[0];
        i += m[0].length;
        // Consume the rest of the opener line verbatim (e.g. trailing
        // redirections) up to the newline that starts the heredoc body.
        let lineEnd = cmd.indexOf('\n', i);
        if (lineEnd === -1) lineEnd = n;
        cur += cmd.slice(i, lineEnd);
        i = lineEnd;
        if (i < n && cmd[i] === '\n') i++;
        // Skip body lines until the terminator line (tab-stripped if `<<-`).
        while (i < n) {
          const nextNl = cmd.indexOf('\n', i);
          const lineRaw = nextNl === -1 ? cmd.slice(i) : cmd.slice(i, nextNl);
          const line = dashStrip ? lineRaw.replace(/^\t+/, '') : lineRaw;
          i += (nextNl === -1 ? (cmd.length - i) : (nextNl - i + 1));
          if (line === word) break;
          if (nextNl === -1) break; // unterminated heredoc: consumed to EOF
        }
        // The heredoc construct closes the current logical command/segment.
        flush();
        continue;
      }
    }
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

// ---------------------------------------------------------------------------
// CHILD-WORKSPACE WRITE-BAN (Change 1)
//
// Owner rule: a DevSwarm child workspace may READ the graphify graph
// (`/graphify query ...`) but must never WRITE/update it — the graph is
// maintained by the Primary only. isChildWorkspace(env) is the canonical
// role signal (hooks/lib/devswarm-role.js), already used by command-guard.js.
//
// Recognises BOTH real invocation forms:
//   - the slash command as a Bash verb: `/graphify . --update --obsidian`
//   - the bare CLI:                     `graphify update .`
//
// Classification (fail-open — uncertain -> NOT a write):
//   WRITE: `graphify update ...` / `/graphify update ...`, any invocation
//          carrying --update or --obsidian, or a bare target path with no
//          recognised read subcommand (e.g. `/graphify .`). A write flag
//          (--update/--obsidian) always wins, even if `query` is also present
//          (e.g. `graphify query --update` is a WRITE, not a read).
//   READ:  `graphify query ...`, --help/-h, --version/-v, or anything that
//          cannot be positively classified as a write.
//
// Wrapped-command recursion covers `bash|sh|zsh|dash|ksh|ash -c '...'`,
// `eval '...'`, and `$(...)`/backtick substitutions, depth-capped at 3.
// Known-uncovered: `source <(...)`, shell aliases, and other exotic
// indirection — those fail open (uncertain -> ALLOW) like any unclassifiable
// form.
// ---------------------------------------------------------------------------

// classifyGraphifySegment(seg) -> { args: string[] } | null (null = segment's
// effective verb is not graphify at all, in either invocation form).
function classifyGraphifySegment(seg) {
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length) {
    const word = tokens[i].replace(/^.*\//, '').toLowerCase();
    if (!GRAPHIFY_WRAPPERS.has(word)) break;
    i++;
    while (i < tokens.length &&
           (tokens[i].startsWith('-') ||
            (word === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))) i++;
    if ((word === 'timeout') && i < tokens.length && !tokens[i].startsWith('/')) i++;
  }
  if (i >= tokens.length) return null;
  const rawVerb = tokens[i];
  const baseVerb = rawVerb.replace(/^\//, '').replace(/^.*\//, '').toLowerCase();
  if (baseVerb !== 'graphify') return null;
  return { args: tokens.slice(i + 1) };
}

// classifyGraphifyArgs(args) -> 'read' | 'write' | 'uncertain'.
function classifyGraphifyArgs(args) {
  if (!args.length) return 'uncertain';
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  if (flags.has('--help') || flags.has('-h') || flags.has('--version') || flags.has('-v')) {
    return 'read';
  }
  // A write flag wins regardless of subcommand position: `graphify query
  // --update` and `/graphify query "x" --obsidian` are writes even though
  // `query` is the first non-flag token (see header comment above).
  if (flags.has('--update') || flags.has('--obsidian')) return 'write';
  const firstNonFlag = args.find((a) => !a.startsWith('-'));
  if (firstNonFlag === 'query') return 'read';
  if (firstNonFlag === 'update') return 'write';
  // A bare target path (e.g. `.`) with no recognised read subcommand -> write.
  if (firstNonFlag) return 'write';
  return 'uncertain'; // only unrecognised flags, no subcommand/path.
}

// findGraphifyWriteSegment(command) -> the offending segment string, or null.
// Mirrors isCodeNavBashCommand's recursion into `bash -c "..."` payloads and
// `$(...)`/backtick substitutions (same depth cap) so a wrapped write is still
// caught in a child workspace.
function findGraphifyWriteSegment(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const cls = classifyGraphifySegment(seg);
    if (cls && classifyGraphifyArgs(cls.args) === 'write') return seg;
    if (d < 3) {
      const payload = extractShellCPayload(seg) || extractEvalPayload(seg);
      if (payload) {
        const found = findGraphifyWriteSegment(payload, d + 1);
        if (found) return found;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const found = findGraphifyWriteSegment(inner, d + 1);
      if (found) return found;
    }
  }
  return null;
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

// If a segment is `eval '<payload>'` / `eval "<payload>"` / `eval payload`,
// return the reconstructed payload command string (eval concatenates its
// operands with a space, mirroring shell eval semantics), else ''. Same
// quote-aware tokenizer as extractShellCPayload.
function extractEvalPayload(segment) {
  const verb = segmentVerb(segment).replace(/^.*\//, '').toLowerCase();
  if (verb !== 'eval') return '';
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
  // tokens[0] is `eval` itself; join the rest as the reconstructed command.
  return tokens.slice(1).join(' ');
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

// sanitizePath — a graph dir / project path is reflected into the block reason
// (which the model reads). A crafted directory name could carry control chars /
// newlines to inject instruction-like lines into the reason. Strip C0/C1 control
// chars + newlines and truncate so the path can't reshape the message. Mirrors
// command-guard's closed-set / task-guard's sanitizeSubject hygiene.
function sanitizePath(p) {
  if (typeof p !== 'string') return '';
  let out = p.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    // Unicode bidi overrides (U+202A–U+202E) + isolates (U+2066–U+2069): strip
    // entirely so they cannot visually reorder the reflected reason.
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (out.length > 80) out = out.slice(0, 80).trimEnd() + '…';
  return out;
}

function getSessionGraphKey(sessionId, graphRoot) {
  const combined = String(sessionId) + '|' + String(graphRoot);
  return crypto.createHash('sha1').update(combined).digest('hex').slice(0, 20);
}

// isSubagent() is imported from coordinator-detect.js (the canonical shared
// definition, extracted from command-guard.js) so all hooks agree on
// coordinator-vs-subagent detection.

// Re-arm thresholds (see the LOOP SAFETY header comment for the full rationale).
const REARM_GROWTH_BYTES = 240 * 1024;
const REARM_MS = 2 * 60 * 60 * 1000;

// Tolerance for a stored timestamp slightly ahead of `now` (benign clock skew).
// Anything beyond this in the future is treated as corrupt/untrusted, mirroring
// task-tracker.js's future/garbage-timestamp guard (same failure class: a bad
// future timestamp would otherwise make `now - writtenAt` negative forever,
// permanently freezing the marker as "fresh" and never re-arming).
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Byte size of payload.transcript_path via a cheap stat, or -1 when unavailable
// (no path, ENOENT, any stat error). -1 is a sentinel distinct from a genuine
// 0-byte file (mirrors task-tracker.js's transcriptSize()).
function currentTranscriptSize(payload) {
  const tp = payload && payload.transcript_path;
  if (!tp || typeof tp !== 'string') return -1;
  try {
    return fs.statSync(tp).size;
  } catch (_) {
    return -1;
  }
}

// Read the marker's { writtenAt, transcriptSize } state. Tolerates the LEGACY
// format (a bare millis timestamp string, from before the re-arm mechanism
// existed) by treating it as { writtenAt: <that number>, transcriptSize: -1 }.
// Any missing/corrupt/unreadable marker collapses to { writtenAt: 0,
// transcriptSize: -1 } -- the same shape as "never written" -- so the caller's
// expiry check naturally treats a corrupt marker as expired (re-arm) rather than
// permanently blocking OR permanently silencing the nudge either way.
function readMarker(markerFile) {
  let writtenAt = 0;
  let transcriptSize = -1;
  try {
    const raw = fs.readFileSync(markerFile, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) {
        if (parsed <= Date.now() + FUTURE_TOLERANCE_MS) writtenAt = parsed;
      } else if (parsed && typeof parsed === 'object') {
        if (Number.isFinite(parsed.writtenAt) && parsed.writtenAt <= Date.now() + FUTURE_TOLERANCE_MS) {
          writtenAt = parsed.writtenAt;
        }
        if (Number.isFinite(parsed.transcriptSize) && parsed.transcriptSize >= 0) {
          transcriptSize = parsed.transcriptSize;
        }
      }
    }
  } catch (_) {
    // Missing/corrupt marker -> defaults above stand (treated as expired).
  }
  return { writtenAt, transcriptSize };
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

  // Subagent context: pass straight through, never touching (reading OR
  // writing) the coordinator's marker. See isSubagent() + the COORDINATOR-ONLY
  // header comment above for why.
  if (isSubagent(payload)) {
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

    // Change 1: a DevSwarm child workspace may READ graphify but never WRITE
    // it — the graph is maintained by the Primary. This is a REAL block
    // (exit 2), independent of the query-first advisory below and
    // independent of whether a graph currently exists at cwd. Fail-open on
    // any classification error: never block a legitimate write over an
    // uncertain read of process.env or the command string.
    try {
      if (isChildWorkspace(process.env)) {
        const writeSeg = findGraphifyWriteSegment(command);
        if (writeSeg) {
          const reason =
            'GRAPHIFY IS READ-ONLY IN CHILD WORKSPACES: the knowledge graph is ' +
            'maintained by the Primary only. This child workspace may READ it ' +
            '(`/graphify query "<question>"`) but must not update/regenerate it ' +
            '(blocked: `' + sanitizePath(writeSeg) + '`). Report findings to the ' +
            'Primary if the graph looks stale — do not run `graphify update` or ' +
            '`--obsidian`/`--update` here. User override: ~/.anti-hall/skip.json ' +
            '{"graphify-guard": <expiry-ms>}.';
          process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
          process.exit(2);
        }
      }
    } catch (_) {
      // fail-open: fall through to the read-only-advisory path below.
    }

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

  // Session + project key for the once-per-(session, re-arm window) marker.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  const key = getSessionGraphKey(sessionId, graphRoot);

  const stateDir = path.join(os.homedir(), '.anti-hall');
  const markerFile = path.join(stateDir, 'graphify-guard-' + key);

  // Marker still fresh (neither re-arm trigger has fired) -> allow (model
  // already tried the graph and hasn't earned another nudge yet).
  const now = Date.now();
  const marker = readMarker(markerFile);
  const curSize = currentTranscriptSize(payload);
  const windowFresh = (now - marker.writtenAt) < REARM_MS;
  // Growth trigger only fires when BOTH sizes are known (never assume growth
  // from an unknown baseline).
  const grew = curSize >= 0 && marker.transcriptSize >= 0 &&
    (curSize - marker.transcriptSize) >= REARM_GROWTH_BYTES;
  if (windowFresh && !grew) {
    process.exit(0);
  }

  // Window expired OR transcript grew past threshold since the marker was last
  // written: (re)arm — write a fresh marker BEFORE blocking so the next call is
  // always allowed until this marker itself expires.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ writtenAt: now, transcriptSize: curSize }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> fail-open (allow)
  }

  const graphDir = path.join(graphRoot, 'graphify-out');

  const toolLabel = toolName === 'Bash'
    ? 'Bash search/command'
    : toolName;

  const safeGraphDir = sanitizePath(graphDir);

  // The wiki index (and other artifact files) are OPTIONAL outputs of `graphify
  // update` — not every graph run produces graphify-out/wiki/. Only recommend a
  // path that actually exists on disk right now (checked with safeIsFile, never
  // throws), in preference order: wiki index -> GRAPH_REPORT.md -> manifest.json
  // -> (fallback) the /graphify query command alone, with no path named at all.
  // This keeps the reflected reason truthful instead of pointing the model at a
  // dead Read.
  let extraRecommendation = '';
  if (safeIsFile(path.join(graphDir, 'wiki', 'index.md'))) {
    const safeWikiIndex = sanitizePath(path.join(graphDir, 'wiki', 'index.md'));
    extraRecommendation = ' or read the wiki index at "' + safeWikiIndex + '"';
  } else if (safeIsFile(path.join(graphDir, 'GRAPH_REPORT.md'))) {
    const safeReport = sanitizePath(path.join(graphDir, 'GRAPH_REPORT.md'));
    extraRecommendation = ' or read the graph report at "' + safeReport + '"';
  } else if (safeIsFile(path.join(graphDir, 'manifest.json'))) {
    const safeManifest = sanitizePath(path.join(graphDir, 'manifest.json'));
    extraRecommendation = ' or read the graph manifest at "' + safeManifest + '"';
  }

  // Change 2: this is now an ADVISORY, not a block. Delegation-first work
  // routes essentially all code search through subagents, and isSubagent()
  // exits above BEFORE this point — so a Bash/Grep/Glob call from the
  // COORDINATOR is the only traffic that can ever reach here, and blocking
  // it produced friction (including on legitimate non-search-adjacent
  // commands like `git diff | grep`) without reaching the traffic the nudge
  // targets. Keep the informational pointer, drop the block/exit 2.
  const reason =
    'GRAPHIFY-FIRST: this project has a knowledge graph at "' + safeGraphDir + '". ' +
    'Consider querying it before raw code search: run `/graphify query "<question>"`' +
    extraRecommendation + '. ' +
    'Raw search (' + toolLabel + ') is not blocked (this pointer re-arms after ' +
    '~240KB of transcript growth or 2h, not just once).';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: reason,
    },
  }) + '\n');
  process.exit(0);
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);

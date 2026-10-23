'use strict';
// codex-apply-patch.js — parse the Codex `apply_patch` tool's PreToolUse payload.
//
// On Codex, file edits arrive as ONE PreToolUse call with tool_name
// "apply_patch" and tool_input = { command: <raw patch text> } — there is no
// file_path/content/new_string (captured from codex-cli 0.160.0; also
// codex-rs/core/src/tools/handlers/apply_patch.rs `apply_patch_payload_command`).
// Claude Code never sends tool_name "apply_patch", so callers branch on it and the
// Claude path stays untouched.
//
// The parser is a port of Codex's own lenient parser, not just the grammar
// (codex-rs/apply-patch/src/parser.rs + streaming_parser.rs, rust-v0.160.0;
// grammar: codex-rs/core/assets/tools/apply_patch.lark), so it accepts and
// rejects the same text Codex does:
//   - the whole text is trimmed; the first/last lines must be
//     "*** Begin Patch"/"*** End Patch" (whitespace-trimmed), or the patch may be
//     wrapped in a <<EOF / <<'EOF' / <<"EOF" ... EOF heredoc;
//   - outside an Update hunk, header lines are fully trimmed; inside one only the
//     line END is trimmed, so an indented "*** Add File:" there is a context line;
//   - paths are taken verbatim after the marker (inner spaces kept). Codex joins
//     them onto the turn cwd (Hunk::resolve_path), so "../" and absolute paths
//     are legal — patchTargetPaths() resolves them the same way.
//
// FAILURE POLICY (callers choose): parseApplyPatch() never throws; on any text
// Codex would reject it returns {ok:false, error}. edit-guard fails CLOSED on
// that in coordinator context (it cannot prove the targets are allowed, and Codex
// would reject the patch anyway, so the block costs nothing). api-guard and
// ship-it-guard fail OPEN (they are best-effort checks on top of a write Codex
// will refuse anyway).

const path = require('path');

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';
const CTX = '@@ ';
const CTX_EMPTY = '@@';
const ENV_ID = '*** Environment ID:';

function isCodexApplyPatch(payload) {
  return !!payload && typeof payload === 'object' && payload.tool_name === 'apply_patch';
}

function fail(error) { return { ok: false, error }; }

// Rust str::lines(): split on \n, drop one trailing \r per line.
function rustLines(s) {
  if (!s.length) return [];
  return s.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function boundariesOk(lines) {
  if (!lines.length) return false;
  return lines[0].trim() === BEGIN && lines[lines.length - 1].trim() === END;
}

function parseApplyPatch(text) {
  if (typeof text !== 'string') return fail('patch text is not a string');
  let lines = rustLines(text.trim());
  if (!boundariesOk(lines)) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (lines.length >= 4 && (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith('EOF')) {
      lines = lines.slice(1, -1);
      if (!boundariesOk(lines)) return fail('patch must start with *** Begin Patch and end with *** End Patch');
    } else {
      return fail('patch must start with *** Begin Patch and end with *** End Patch');
    }
  }

  // Streaming state machine (streaming_parser.rs). Codex feeds lines joined by
  // "\n" with no trailing newline, so every line but the last goes through
  // processLine and the last one through the finish() rule.
  const files = [];
  let mode = 'notStarted';
  let envSeen = false;
  let cur = null; // current update hunk: { file, chunks: [{old, nw, eof}] }

  function updateNotEmpty(line) {
    if (mode !== 'update' || !cur) return null;
    if (!cur.chunks.length) return "update hunk for '" + cur.file.path + "' is empty";
    const last = cur.chunks[cur.chunks.length - 1];
    if (last.old === 0 && last.nw === 0) {
      return line === END ? 'update hunk does not contain any lines' : 'unexpected line in update hunk: ' + line;
    }
    return null;
  }

  // Returns true (handled), false (not a header), or a string error.
  function headers(trimmed) {
    if (mode === 'started' && trimmed.startsWith(ENV_ID)) {
      if (envSeen) return 'environment id specified more than once';
      if (!trimmed.slice(ENV_ID.length).trim()) return 'environment id cannot be empty';
      envSeen = true;
      return true;
    }
    let err;
    if (trimmed === END) {
      if ((err = updateNotEmpty(trimmed))) return err;
      mode = 'ended';
      return true;
    }
    for (const [marker, op] of [[ADD, 'add'], [DELETE, 'delete'], [UPDATE, 'update']]) {
      if (trimmed.startsWith(marker)) {
        if ((err = updateNotEmpty(trimmed))) return err;
        const file = { op, path: trimmed.slice(marker.length), moveTo: null, addedLines: [] };
        files.push(file);
        mode = op;
        cur = op === 'update' ? { file, chunks: [] } : null;
        return true;
      }
    }
    return false;
  }

  function processLine(line) {
    const trimmed = line.trim();
    let h;
    switch (mode) {
      case 'notStarted':
        if (trimmed === BEGIN) { mode = 'started'; return null; }
        return 'first line must be *** Begin Patch';
      case 'started':
      case 'delete':
        h = headers(trimmed);
        if (h === true) return null;
        return typeof h === 'string' ? h : 'invalid hunk header: ' + trimmed;
      case 'add':
        h = headers(trimmed);
        if (h === true) return null;
        if (typeof h === 'string') return h;
        if (line.startsWith('+')) { files[files.length - 1].addedLines.push(line.slice(1)); return null; }
        return 'invalid hunk header: ' + trimmed;
      case 'update': {
        const u = line.replace(/\s+$/, '');
        h = headers(u);
        if (h === true) return null;
        if (typeof h === 'string') return h;
        const chunks = cur.chunks;
        const last = chunks[chunks.length - 1];
        const emptyLast = !!last && last.old === 0 && last.nw === 0;
        if (last && last.eof) {
          if (!u.length) return null;
          if (u !== CTX_EMPTY && !u.startsWith(CTX)) return 'expected @@ after End of File';
        }
        if (!chunks.length && cur.file.moveTo === null && u.startsWith(MOVE)) {
          cur.file.moveTo = u.slice(MOVE.length);
          return null;
        }
        if ((u === CTX_EMPTY || u.startsWith(CTX)) && emptyLast) return 'unexpected line in update hunk: ' + line;
        if (u === CTX_EMPTY || u.startsWith(CTX)) { chunks.push({ old: 0, nw: 0, eof: false }); return null; }
        if (u === EOF_MARK) {
          if (emptyLast) return 'update hunk does not contain any lines';
          if (last) last.eof = true;
          return null;
        }
        const ensure = () => { if (!chunks.length) chunks.push({ old: 0, nw: 0, eof: false }); return chunks[chunks.length - 1]; };
        if (!line.length || line.startsWith(' ')) { const c = ensure(); c.old++; c.nw++; return null; }
        if (line.startsWith('+')) { const c = ensure(); c.nw++; cur.file.addedLines.push(line.slice(1)); return null; }
        if (line.startsWith('-')) { const c = ensure(); c.old++; return null; }
        return 'unexpected line in update hunk: ' + line;
      }
      case 'ended':
        return trimmed.length ? 'content after *** End Patch' : null;
      default:
        return 'parser state error';
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let err;
    if (i === lines.length - 1 && line.length) {
      if (line.trim() === END) {
        err = updateNotEmpty(line.trim());
        if (!err) mode = 'ended';
      } else {
        err = processLine(line);
      }
    } else {
      err = processLine(line);
    }
    if (err) return fail(err);
  }
  if (mode !== 'ended') return fail('last line must be *** End Patch');
  return { ok: true, files };
}

// Every path the patch touches (source AND Move-to destination), resolved the
// way Codex resolves them: joined onto the turn cwd; an absolute path wins.
function patchTargetPaths(files, cwd) {
  const base = cwd ? String(cwd) : process.cwd();
  const out = [];
  for (const f of files || []) {
    out.push(path.resolve(base, f.path));
    if (f.moveTo !== null && f.moveTo !== undefined) out.push(path.resolve(base, f.moveTo));
  }
  return out;
}

module.exports = { parseApplyPatch, patchTargetPaths, isCodexApplyPatch };

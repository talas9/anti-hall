// check = "compact-declaration-guard" (PreToolUse). Blocks new work (a spawn, a file edit, a state-changing shell
// command) in a turn whose assistant text holds an active "SAFE TO COMPACT" declaration. The script answers the common case:
// the call is not new work, or the current turn cannot hold a declaration (its text has no "safe"); a turn that might is
// deferred to the Node guard, which owns the phrase analysis and the block. Mirrors hooks/compact-declaration-guard.js.
// Every pattern, list and limit is in engine/defaults/small_guards.toml (compact_decl.*).
'use strict';

// Blank quoted spans (delimiters included) so quoted data cannot match a work pattern. Mirrors work-detect.js.
function neutralizeQuoted(cmd) {
  var cs = Array.from(cmd), out = '', inS = false, inD = false, i = 0;
  while (i < cs.length) {
    var c = cs[i];
    if (inS) { out += ' '; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === '\\' && i + 1 < cs.length) { out += '  '; i += 2; continue; }
      out += ' ';
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "'") { inS = true; out += ' '; } else if (c === '"') { inD = true; out += ' '; } else out += c;
    i++;
  }
  return out;
}

// A `>` / `>>` file redirect that is not a descriptor duplicate.
function hasFileRedirect(s) {
  var cs = Array.from(s);
  for (var i = 0; i < cs.length; i++) {
    if (cs[i] !== '>') continue;
    var prev = i > 0 ? cs[i - 1] : '';
    if (/^[0-9&]$/.test(prev)) continue;
    if (cs[i + 1] === '&') continue;
    return true;
  }
  return false;
}

function bashIsWork(cmd) {
  var n = neutralizeQuoted(cmd);
  return ah.cfg('compact_decl.bash_work_always').some(function (src) { return ah.re.test(src, 'i', n); }) ||
    ah.re.test(ah.cfg('compact_decl.bash_work_command_position'), 'i', n) || hasFileRedirect(n) ||
    ah.re.test(ah.cfg('compact_decl.bash_work_extra'), 'i', n);
}

// true / false, or undefined when the path needs a working directory the payload does not give.
function isHandoverEdit(p) {
  var ti = p.tool_input;
  var field = function (k) { return ti !== null && ti !== undefined && typeof ti === 'object' && !Array.isArray(ti) && typeof ti[k] === 'string' ? ti[k] : undefined; };
  var fp = field('file_path');
  if (fp === undefined) fp = field('notebook_path');
  if (!fp) return false;
  var abs;
  if (ah.path.isAbsolute(fp)) abs = ah.path.resolveAbs(fp);
  else {
    var cwd = p.cwd;
    if (typeof cwd !== 'string' || !ah.path.isAbsolute(cwd)) return undefined;
    abs = ah.path.resolveAbs(cwd + '/' + fp);
  }
  return ah.re.test(ah.cfg('compact_decl.handover_file'), 'r', abs);
}

// 'yes', 'no' or 'defer'.
function isNewWork(p) {
  var name = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('compact_decl.work_tools').indexOf(name) >= 0) {
    var h = isHandoverEdit(p);
    return h === undefined ? 'defer' : h ? 'no' : 'yes';
  }
  var ti = p.tool_input;
  var cmd = ti !== null && typeof ti === 'object' && !Array.isArray(ti) ? ti.command : undefined;
  return typeof cmd === 'string' && bashIsWork(cmd) ? 'yes' : 'no';
}

function asciiLower(s) { return s.replace(/[A-Z]+/g, function (m) { return m.toLowerCase(); }); }

function decideInner(p) {
  if (!ah.settings.bool('compact_decl.setting') || p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  var markers = ah.cfg('compact_decl.agent_markers');
  if (markers.some(function (k) { return Object.prototype.hasOwnProperty.call(p, k) && p[k] !== null; }) || ah.settings.skipped(ah.cfg('compact_decl.guard_name'))) return null;
  var path = p.transcript_path;
  if (typeof path !== 'string' || !path) return null;
  var w = isNewWork(p);
  if (w === 'no') return null;
  if (w === 'defer') return 'defer';
  if (!ah.path.isAbsolute(path)) return 'defer';
  var word = ah.cfg('compact_decl.safe_word');
  var turn = ah.transcript.turnText(path, ah.cfgNum('compact_decl.tail_bytes'), word);
  if (turn === null || turn.hint === false) return null;
  if (turn.unsure) return 'defer';
  var needle = asciiLower(word);
  return needle && turn.parts.some(function (t) { return asciiLower(t).indexOf(needle) >= 0; }) ? 'defer' : null;
}

function decide(p) { var v = decideInner(p); return v === null ? 'allow' : v; }

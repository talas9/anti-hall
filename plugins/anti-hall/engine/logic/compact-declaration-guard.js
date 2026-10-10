// check = "compact-declaration-guard" (PreToolUse). Blocks new work (a spawn, a file edit, a state-changing shell
// command) in a turn whose assistant text holds an active "SAFE TO COMPACT" declaration. A turn whose text has no "safe" is
// answered from the host's turn scan; any other is read in full and judged with the phrase rules of hooks/lib/compact-advice.js
// (lib/76-compact-advice.js: readTurn, and findAdvice limited to the declaration forms, then the last retraction). Mirrors
// hooks/compact-declaration-guard.js. Patterns, lists and limits are in engine/defaults/small_guards.toml (compact_decl.*), the
// block texts and the declaration forms in guards_v1.toml (compact_decl_v1.*).
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

// Writing the handover itself is never new work; a relative path resolves against the hook process's directory.
function isHandoverEdit(p) {
  var ti = p.tool_input;
  var field = function (k) { return ti !== null && ti !== undefined && typeof ti === 'object' && !Array.isArray(ti) && typeof ti[k] === 'string' ? ti[k] : undefined; };
  var fp = field('file_path');
  if (fp === undefined) fp = field('notebook_path');
  if (!fp) return false;
  return ah.re.test(ah.cfg('compact_decl.handover_file'), 'r', hookProc.resolve(p, fp));
}

function isNewWork(p) {
  var name = String(p.tool_name || '');
  if (ah.cfg('compact_decl.work_tools').indexOf(name) >= 0) return !isHandoverEdit(p);
  var ti = p.tool_input;
  var cmd = ti !== null && typeof ti === 'object' && !Array.isArray(ti) ? ti.command : undefined;
  return typeof cmd === 'string' && bashIsWork(cmd);
}

function asciiLower(s) { return s.replace(/[A-Z]+/g, function (m) { return m.toLowerCase(); }); }

// The assistant text of the current turn (hooks/lib/compact-advice.js readTurn().turnText). A line the interpreter reads
// differently from Node (cadv.unsure: a timestamp form only V8 reads, which the turn text never uses; a JSON value too deep for
// the interpreter) is skipped and logged instead of abandoning the turn.
function turnTextOf(lines) {
  var parts = [], skipped = 0;
  for (var i = 0; i < lines.length; i++) {
    cadv.unsure = false;
    var ev = cadv.classify(lines[i]);
    if (cadv.unsure && !ev) skipped++;
    cadv.unsure = false;
    if (!ev) continue;
    (ev.kind === 'multi' ? ev.events : [ev]).forEach(function (e) {
      if (e.kind === 'user') parts = [];
      else if (e.kind === 'text') parts.push(e.text);
    });
  }
  if (skipped) ah.log('compact_decl_unsure_lines', String(skipped));
  return parts.join('\n');
}

// compact-advice.js activeDeclaration(text, {declarationsOnly: true}): the last declaration not followed by a retraction, or null.
function activeDeclaration(t) {
  var only = ah.cfg('compact_decl_v1.declaration_forms'), keep = [];
  var saved = cadv.ADVICE_RES;
  cadv.ADVICE_RES = saved.map(function (re, i) { return only.indexOf(i) >= 0 ? re : /(?!)/g; });
  try { keep = cadv.findAdvice(t); } finally { cadv.ADVICE_RES = saved; }
  if (!keep.length) return null;
  var last = keep[keep.length - 1];
  return cadv.lastRetraction(t) > last.index ? null : last;
}

function decideInner(p) {
  if (!ah.settings.bool('compact_decl.setting') || p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  var markers = ah.cfg('compact_decl.agent_markers');
  if (markers.some(function (k) { return Object.prototype.hasOwnProperty.call(p, k) && p[k] !== null; }) || ah.settings.skipped(ah.cfg('compact_decl.guard_name'))) return null;
  if (!isNewWork(p)) return null;
  var path = p.transcript_path;
  if (typeof path !== 'string' || !path) return null;
  path = hookProc.resolve(p, path);
  var word = ah.cfg('compact_decl.safe_word'), bytes = ah.cfgNum('compact_decl.tail_bytes');
  // fast path: a turn whose text cannot hold the word cannot hold a declaration
  var turn = ah.transcript.turnText(path, bytes, word);
  if (turn === null || turn.hint === false) return null;
  var needle = asciiLower(word);
  if (!turn.unsure && !(needle && turn.parts.some(function (t) { return asciiLower(t).indexOf(needle) >= 0; }))) return null;
  var tail = ah.fs.readTail(path, bytes);
  if (tail === null || tail === '') return null;
  var decl = activeDeclaration(turnTextOf(tail.split('\n')));
  if (!decl) return null;
  var tool = p.tool_name ? String(p.tool_name) : ah.cfg('compact_decl_v1.this_tool');
  var reason = text.message('block', ah.cfg('compact_decl.guard_name'), {
    what: text.render(ah.cfg('compact_decl_v1.msg_what'), { phrase: decl.phrase, tool: tool }),
    why: ah.cfg('compact_decl_v1.msg_why'), instead: ah.cfg('compact_decl_v1.msg_instead'), allowed: ah.cfg('compact_decl_v1.msg_allowed'),
  });
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}

function decide(p) { var v = decideInner(p); return v === null ? 'allow' : v; }

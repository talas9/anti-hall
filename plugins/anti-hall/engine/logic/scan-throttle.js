// check = "scan-throttle" (PreToolUse on Bash; advisory only). Recommends the background-throttled form of a user-configured
// heavy scan command (the patterns come from the environment; with none set it matches nothing). It never rewrites the
// command. A user pattern is a JavaScript regex; only a plain subset is matched here, any other construct defers to Node.
// Mirrors hooks/scan-throttle.js. Every list, pattern, text and tool name is in engine/defaults/small_guards.toml
// (scan_throttle.*).
'use strict';

function isAlnum(c) { return c !== undefined && /^[A-Za-z0-9]$/.test(c); }

// The end index of a plain character class starting at `i` (just after the `[`), or -1.
function plainClass(cs, i, lits, escapes) {
  var start = i;
  if (cs[i] === '^') i++;
  var first = i, prevEsc = false;
  while (i < cs.length) {
    var c = cs[i];
    if (c === ']') return i > first ? i : -1;
    if (c === '\\') {
      var e = cs[i + 1];
      if (e === undefined || escapes.indexOf(e) < 0 || 'SDWbB'.indexOf(e) >= 0) return -1;
      prevEsc = 'sdw'.indexOf(e) >= 0;
      i += 2;
      continue;
    }
    if (c === '-') {
      var last = cs[i + 1] === ']';
      var range = i > first && i > start && isAlnum(cs[i - 1]) && isAlnum(cs[i + 1]) && cs[i - 1] <= cs[i + 1];
      if (prevEsc || !(i === first || last || range)) return -1;
      if (range) { i += 2; prevEsc = false; continue; }
    } else if (c === '&' || c === '~' || c === '[') return -1;
    else if (!(lits.indexOf(c) >= 0 || '.$*+?()|'.indexOf(c) >= 0)) return -1;
    prevEsc = false;
    i++;
  }
  return -1;
}

// Whether a user pattern uses only constructs the engine matches itself.
function patternIsPlain(src) {
  var lits = ah.cfg('scan_throttle.pattern_literal_chars'), escapes = ah.cfg('scan_throttle.pattern_escapes');
  var cs = Array.from(src), i = 0, depth = 0, atom = false, quant = false, lazyUsed = false;
  while (i < cs.length) {
    var c = cs[i];
    if (quant && c === '?' && !lazyUsed) { lazyUsed = true; i++; continue; }
    var wasQuant = quant;
    quant = false; lazyUsed = false;
    if (c === '*' || c === '+' || c === '?') {
      if (!atom || wasQuant) return false;
      quant = true; atom = false;
    } else if (c === '.') atom = true;
    else if (c === '|' || c === '^' || c === '$') atom = false;
    else if (c === '(') {
      if (cs[i + 1] === '?') { if (cs[i + 2] !== ':') return false; i += 2; }
      depth++; atom = false;
    } else if (c === ')') {
      if (depth === 0) return false;
      depth--; atom = true;
    } else if (c === '\\') {
      var e = cs[i + 1];
      if (e === undefined || escapes.indexOf(e) < 0) return false;
      atom = !(e === 'b' || e === 'B');
      i++;
    } else if (c === '[') {
      var end = plainClass(cs, i + 1, lits, escapes);
      if (end < 0) return false;
      i = end; atom = true;
    } else if (lits.indexOf(c) >= 0) atom = true;
    else return false;
    i++;
  }
  return depth === 0;
}

// The user patterns, or null when one is not plain.
function userPatterns(envVal) {
  var out = [], parts = (envVal === null ? '' : envVal).split(',');
  for (var i = 0; i < parts.length; i++) {
    var src = parts[i].trim();
    if (src === '') continue;
    if (!patternIsPlain(src)) return null;
    try { ah.re.test(src, '', ''); } catch (e) { return null; }
    out.push(src);
  }
  return out;
}

// The command split into simple-command segments (quotes and heredoc bodies skipped).
function splitSegments(cmd) {
  var cs = Array.from(cmd), n = cs.length, segs = [], cur = '', inS = false, inD = false, i = 0;
  var flush = function () { if (cur.trim() !== '') segs.push(cur); cur = ''; };
  while (i < n) {
    var c = cs[i], c2 = cs[i + 1];
    if (inS) { cur += c; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === '\\' && c2 !== undefined) { cur += c + c2; i += 2; continue; }
      cur += c;
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === '<' && c2 === '<') {
      var h = ah.shell.heredocAt(cmd, i);
      if (h !== null) { cur += cs.slice(i, i + h.openerLen).join(''); i = h.end; flush(); continue; }
    }
    if ((c === '&' && c2 === '&') || (c === '|' && c2 === '|')) { flush(); i += 2; continue; }
    if ('|;&\n)({}`'.indexOf(c) >= 0) { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flush(); i += 2; continue; }
    cur += c;
    i++;
  }
  flush();
  return segs;
}

function onPath(pathVar, tool) {
  return pathVar.split(ah.cfg('scan_throttle.path_separator')).filter(function (d) { return d !== ''; })
    .some(function (d) { return ah.fs.isFile(d.replace(/\/+$/, '') + '/' + tool); });
}

// The throttle prefix for this platform, or null when its tool is not on PATH (or the platform has none).
function throttlePrefix(pathVar) {
  var os = ah.platform();
  if (os === 'macos') { var d = ah.cfg('scan_throttle.darwin'); return onPath(pathVar, d.tool) ? d.prefix : null; }
  if (os === 'linux') {
    var l = ah.cfg('scan_throttle.linux');
    if (!onPath(pathVar, l.tool)) return null;
    return (onPath(pathVar, l.io_tool) ? l.io_prefix : '') + l.prefix;
  }
  return null;
}

// The index just past leading NAME=value assignments that are each followed by white space.
function leadingAssignments(cmd) {
  var one = ah.cfg('scan_throttle.assign_one');
  var skipWs = function (from) { var m = /^\s*/.exec(cmd.slice(from)); return from + m[0].length; };
  var i = skipWs(0);
  for (;;) {
    var m = ah.re.find(one, '', cmd.slice(i));
    if (!m) break;
    var after = i + m[1], next = skipWs(after);
    if (next === after) break;
    i = next;
  }
  return i;
}

function unsafeInsertionPoint(rest) {
  return rest === '' || ah.cfg('scan_throttle.unsafe_start_chars').indexOf(rest.charAt(0)) >= 0 || rest.indexOf(ah.cfg('scan_throttle.unsafe_start_subst')) === 0;
}

function decide(p) {
  if (!ah.settings.bool('scan_throttle.setting')) return 'allow';
  if (p === null || typeof p !== 'object' || Array.isArray(p) || p.tool_name !== 'Bash') return 'allow';
  var ti = p.tool_input;
  var command = ti !== null && typeof ti === 'object' && !Array.isArray(ti) && typeof ti.command === 'string' ? ti.command : '';
  if (command.trim() === '') return 'allow';
  var patterns = userPatterns(ah.env.get(ah.cfg('scan_throttle.patterns_env')));
  if (patterns === null) return 'defer';
  if (patterns.length === 0) return 'allow';
  var pathVar = ah.env.get(ah.cfg('scan_throttle.path_var'));
  var prefix = throttlePrefix(pathVar === null ? '' : pathVar);
  if (prefix === null) return 'allow';
  var trimmed = command.replace(/^\s+/, '');
  if (ah.cfg('scan_throttle.known_prefixes').some(function (k) { return trimmed.indexOf(k) === 0; })) return 'allow';
  var segs = splitSegments(command), matchIndex = -1;
  for (var i = 0; i < segs.length && matchIndex < 0; i++) {
    if (patterns.some(function (src) { return ah.re.test(src, '', segs[i]); })) matchIndex = i;
  }
  if (matchIndex < 0) return 'allow';
  var at = leadingAssignments(command), leading = command.slice(0, at), rest = command.slice(at);
  var guard = ah.cfg('scan_throttle.guard_name'), t;
  if (matchIndex === 0 && !unsafeInsertionPoint(rest)) {
    t = text.message('tip', guard, {
      what: ah.cfg('scan_throttle.msg_first_what'), why: ah.cfg('scan_throttle.msg_first_why'),
      instead: text.render(ah.cfg('scan_throttle.msg_first_instead'), { throttled: leading + prefix + rest }),
    });
  } else {
    t = text.message('tip', guard, {
      what: ah.cfg('scan_throttle.msg_group_what'), instead: text.render(ah.cfg('scan_throttle.msg_group_instead'), { prefix: prefix.trim() }),
    });
  }
  return { advisory: text.advisoryJson('PreToolUse', t) };
}

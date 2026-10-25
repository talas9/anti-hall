// check = "scan-throttle" (PreToolUse on Bash; advisory only). Recommends the background-throttled form of a user-configured
// heavy scan command (the patterns come from the environment; with none set it matches nothing). It never rewrites the
// command. A user pattern is a JavaScript regex, compiled and matched by the script interpreter as Node does.
// Mirrors hooks/scan-throttle.js. Every list, pattern, text and tool name is in engine/defaults/small_guards.toml
// (scan_throttle.*).
'use strict';

// The user patterns as JavaScript regular expressions, compiled by this interpreter exactly as the Node hook compiles them
// (`new RegExp(src)`, no flags); an invalid one is skipped, as Node skips it.
function userPatterns(envVal) {
  var out = [];
  if (!envVal) return out;
  envVal.split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (src) {
    try { out.push(new RegExp(src)); } catch (e) { /* skip invalid pattern */ }
  });
  return out;
}

function segmentMatches(segment, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(segment)) return true; // only a stack or time limit can throw here: that reaches the engine
  }
  return false;
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
  if (patterns.length === 0) return 'allow';
  var pathVar = ah.env.get(ah.cfg('scan_throttle.path_var'));
  var prefix = throttlePrefix(pathVar === null ? '' : pathVar);
  if (prefix === null) return 'allow';
  var trimmed = command.replace(/^\s+/, '');
  if (ah.cfg('scan_throttle.known_prefixes').some(function (k) { return trimmed.indexOf(k) === 0; })) return 'allow';
  var segs = splitSegments(command), matchIndex = -1;
  for (var i = 0; i < segs.length && matchIndex < 0; i++) {
    if (segmentMatches(segs[i], patterns)) matchIndex = i;
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

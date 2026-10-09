// check = "scan-throttle" (PreToolUse on Bash; advisory only). The guard ships with no built-in scan patterns: it matches nothing unless
// the operator sets ANTI_HALL_THROTTLE_PATTERNS (comma-separated regex sources, JavaScript syntax; one that does not compile is skipped).
// When a command segment matches, the advisory recommends the background-throttled form (`taskpolicy -c utility nice -n 19 ...` on macOS,
// `nice -n 19 ...` on Linux, with `ionice -c 3 ` before it when that exists), quoting the exact command when the scan is the first simple
// command and giving a generic note otherwise. It never rewrites the command and never decides anything. Mirrors hooks/scan-throttle.js.
// Keys and texts: small_guards.toml (scan_throttle.*).
'use strict';

function stT(k) { return ah.cfg('scan_throttle.' + k); }

// Quote-aware, heredoc-aware split into simple commands: the opener line of a heredoc stays on its segment and the body is skipped.
function stSplit(cmd) {
  var n = cmd.length, segs = [], cur = '', inS = false, inD = false, i = 0;
  function flush() { if (cur.trim() !== '') segs.push(cur); cur = ''; }
  shellScan.reset();
  while (i < n) {
    var c = cmd.charAt(i), c2 = i + 1 < n ? cmd.charAt(i + 1) : null;
    if (inS) { cur += c; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === '\\' && c2 !== null) { cur += c + c2; i += 2; continue; }
      cur += c;
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === '<' && c2 === '<') {
      var h = shellScan.parseHeredocAt(cmd, i);
      if (h) { cur += cmd.slice(i, i + h.openerText.length); i = h.end; flush(); continue; }
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

// Whether `tool` is a file on the search path `pathVar` (a pure scan, no subprocess).
function stOnPath(pathVar, tool) {
  return pathVar.split(stT('path_separator')).some(function (d) { return d !== '' && ah.fs.isFile(d.replace(/\/+$/, '') + '/' + tool); });
}

// The exact prefix to prepend, or null when the platform has no known throttle tool on the path.
function stPrefix(pathVar) {
  var os = ah.platform();
  if (os === 'macos') { var d = stT('darwin'); return stOnPath(pathVar, d.tool) ? d.prefix : null; }
  if (os === 'linux') {
    var l = stT('linux');
    if (!stOnPath(pathVar, l.tool)) return null;
    return (stOnPath(pathVar, l.io_tool) ? l.io_prefix : '') + l.prefix;
  }
  return null;
}

// Index just past leading white space and NAME=value assignments (each followed by white space).
function stSkipAssignments(cmd) {
  var one = new RegExp(stT('assign_one')), skip = function (from) { var j = from; while (j < cmd.length && /\s/.test(cmd.charAt(j))) j++; return j; };
  var i = skip(0), m;
  while ((m = one.exec(cmd.slice(i))) !== null) {
    var after = i + m[0].length, next = skip(after);
    if (next === after) break; // not clearly a standalone assignment token
    i = next;
  }
  return i;
}

function decide(p) {
  if (!ah.settings.bool('scan_throttle.setting')) return 'allow';
  if (!jx.isObj(p) || p.tool_name !== 'Bash') return 'allow';
  var command = jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (command.trim() === '') return 'allow';
  var patterns = [], raw = ah.env.get(stT('patterns_env')) || '';
  raw.split(',').forEach(function (s) {
    var src = s.trim();
    if (src === '') return;
    try { patterns.push(new RegExp(src)); } catch (e) { /* an invalid pattern is skipped, as Node does */ }
  });
  if (patterns.length === 0) return 'allow'; // no pattern, no match: neither the platform nor PATH is probed
  var prefix = stPrefix(ah.env.get(stT('path_var')) || '');
  if (prefix === null) return 'allow';
  var trimmed = command.replace(/^\s+/, '');
  if (stT('known_prefixes').some(function (k) { return trimmed.indexOf(k) === 0; })) return 'allow';
  var segs = stSplit(command), idx = -1;
  for (var i = 0; i < segs.length && idx < 0; i++) if (patterns.some(function (re) { return re.test(segs[i]); })) idx = i;
  if (idx < 0) return 'allow';
  var start = stSkipAssignments(command), leading = command.slice(0, start), rest = command.slice(start), t;
  var unsafe = rest === '' || stT('unsafe_start_chars').indexOf(rest.charAt(0)) >= 0 || rest.indexOf(stT('unsafe_start_subst')) === 0;
  if (idx === 0 && !unsafe) {
    t = text.message('tip', stT('guard_name'), { what: stT('msg_first_what'), why: stT('msg_first_why'), instead: text.render(stT('msg_first_instead'), { throttled: leading + prefix + rest }) });
  } else {
    t = text.message('tip', stT('guard_name'), { what: stT('msg_group_what'), instead: text.render(stT('msg_group_instead'), { prefix: prefix.trim() }) });
  }
  return { advisory: text.advisoryJson('PreToolUse', t) };
}

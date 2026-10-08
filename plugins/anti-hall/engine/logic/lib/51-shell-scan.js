// Shared shell-text primitives (mirror hooks/lib/shell-scan.js): the heredoc opener parser and the arithmetic-context scan,
// the cross-platform basename and the shell-interpreter verb set. Pure: no file system or process access.
'use strict';
var shellScan = (function () {
  // <<[-]WORD, <<'WORD', <<"WORD", <<WORD: the dash (tab-stripping mode) and the terminator word (quoted or bare).
  var HEREDOC_RE = /^<<(-)?\s*("([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/;
  var verbs = null, verbsGen = -1;
  function shellVerbs() {
    var g = ahHost.cfgGen();
    if (verbs === null || g !== verbsGen) { verbs = new Set(ah.cfg('git.shell_verbs')); verbsGen = g; }
    return verbs;
  }
  function basename(p) {
    if (!p) return p;
    var parts = p.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  // The scan state resumes from where the last call for this exact `cmd` left off (calls come at non-decreasing positions).
  var scanState = null;

  function parseHeredocRaw(cmd, i) {
    var n = cmd.length;
    if (cmd[i] !== '<' || cmd[i + 1] !== '<') return null;
    // `<<<` is a here-STRING (no body): neither of its `<` opens a heredoc.
    if (cmd[i + 2] === '<' || (i > 0 && cmd[i - 1] === '<')) return null;
    var m = HEREDOC_RE.exec(cmd.slice(i));
    if (!m) return null;
    var dashStrip = !!m[1];
    // The delimiter is the FULL shell word with quote removal, as bash reads it; a word that cannot be modelled exactly
    // (unquoted `$` or backtick, unterminated quote, backslash-newline) returns null: no body is skipped, the strict fallback.
    var j = i + m[0].length - m[2].length, word = '', quoted = false;
    while (j < n && !/[ \t\r\n;&|<>()]/.test(cmd[j])) {
      var ch = cmd[j];
      if (ch === '$' || ch === '`') return null;
      if (ch === "'") {
        var close = cmd.indexOf("'", j + 1);
        if (close === -1) return null;
        word += cmd.slice(j + 1, close); quoted = true; j = close + 1; continue;
      }
      if (ch === '"') {
        var k = j + 1;
        while (k < n && cmd[k] !== '"') {
          if (cmd[k] === '$' || cmd[k] === '`') return null;
          if (cmd[k] === '\\' && k + 1 < n && '\\"'.indexOf(cmd[k + 1]) >= 0) { word += cmd[k + 1]; k += 2; continue; }
          word += cmd[k]; k++;
        }
        if (k >= n) return null;
        quoted = true; j = k + 1; continue;
      }
      if (ch === '\\') {
        if (j + 1 >= n || cmd[j + 1] === '\n' || cmd[j + 1] === '\r') return null;
        word += cmd[j + 1]; quoted = true; j += 2; continue;
      }
      word += ch; j++;
    }
    if (!word) return null;
    var openerEnd = j, lineEnd = cmd.indexOf('\n', openerEnd);
    if (lineEnd === -1) return { end: n, openerText: cmd.slice(i, n), openerEnd: openerEnd, word: word, quoted: quoted, dashStrip: dashStrip, body: '', terminated: false };
    var openerText = cmd.slice(i, lineEnd), idx = lineEnd + 1, bodyLines = [], terminated = false;
    while (idx <= n) {
      var nextNl = cmd.indexOf('\n', idx);
      var lineRaw = nextNl === -1 ? cmd.slice(idx) : cmd.slice(idx, nextNl);
      var line = dashStrip ? lineRaw.replace(/^\t+/, '') : lineRaw;
      if (line === word) { terminated = true; idx = nextNl === -1 ? n : nextNl + 1; break; }
      bodyLines.push(line);
      if (nextNl === -1) { idx = n; break; }
      idx = nextNl + 1;
    }
    return { end: idx, openerText: openerText, openerEnd: openerEnd, lineEnd: lineEnd, word: word, quoted: quoted, dashStrip: dashStrip, body: bodyLines.join('\n'), terminated: terminated };
  }

  // true when `pos` lies inside an open `$((`, `((` or `$[` whose innermost enclosing context is arithmetic.
  function inArithmeticAt(cmd, pos) {
    var n = cmd.length, st = scanState;
    if (!st || st.cmd !== cmd || st.j > pos) st = scanState = { cmd: cmd, j: 0, stack: [], inSingle: false, inDouble: false, skipFrom: -1, skipTo: -1 };
    while (st.j < pos) {
      if (st.skipFrom !== -1 && st.j >= st.skipFrom) {
        if (st.skipTo > pos) return false;
        st.j = st.skipTo; st.skipFrom = -1; continue;
      }
      var j = st.j, c = cmd[j], c2 = cmd[j + 1], stack = st.stack, top = stack[stack.length - 1];
      if (st.inSingle) { if (c === "'") st.inSingle = false; st.j = j + 1; continue; }
      if (c === '\\') { st.j = j + 2; continue; }
      if (!st.inDouble && c === '$' && c2 === "'") {
        var k = j + 2;
        while (k < n && cmd[k] !== "'") k += cmd[k] === '\\' ? 2 : 1;
        st.j = k + 1; continue;
      }
      if (!st.inDouble && c === "'") { st.inSingle = true; st.j = j + 1; continue; }
      if (c === '"') { st.inDouble = !st.inDouble; st.j = j + 1; continue; }
      if (c === '$' && c2 === '(' && cmd[j + 2] === '(') { stack.push('A'); st.j = j + 3; continue; }
      if (c === '$' && c2 === '[') { stack.push('B'); st.j = j + 2; continue; }
      if (c === '$' && c2 === '(') { stack.push('C'); st.j = j + 2; continue; }
      if (c === '(' && c2 === '(' && top !== 'A' && top !== 'B') { stack.push('A'); st.j = j + 2; continue; }
      if (c === '(') { stack.push('P'); st.j = j + 1; continue; }
      if (c === ')') {
        if (top === 'A' && c2 === ')') { stack.pop(); st.j = j + 2; continue; }
        if (top === 'C' || top === 'P') stack.pop();
        st.j = j + 1; continue;
      }
      if (c === '[' && (top === 'B' || top === 'Q')) { stack.push('Q'); st.j = j + 1; continue; }
      if (c === ']') { if (top === 'B' || top === 'Q') stack.pop(); st.j = j + 1; continue; }
      if (!st.inDouble && c === '<' && c2 === '<' && top !== 'A' && top !== 'B') {
        var h = parseHeredocRaw(cmd, j);
        if (h) {
          var bodyStart = j + h.openerText.length;
          if (bodyStart < h.end && (st.skipFrom === -1 || bodyStart < st.skipFrom)) { st.skipFrom = bodyStart; st.skipTo = h.end; }
        }
        st.j = j + 2; continue;
      }
      st.j = j + 1;
    }
    var t = st.stack[st.stack.length - 1];
    return t === 'A' || t === 'B';
  }

  function parseHeredocAt(cmd, i) {
    if (inArithmeticAt(cmd, i)) return null;
    return parseHeredocRaw(cmd, i);
  }

  return { HEREDOC_RE: HEREDOC_RE, basename: basename, shellVerbs: shellVerbs, parseHeredocAt: parseHeredocAt, parseHeredocRaw: parseHeredocRaw, inArithmeticAt: inArithmeticAt,
    // a fresh call starts from a clean scan state
    reset: function () { scanState = null; } };
})();

// Shared command reader of the token-waste guards (lane-test-guard, queued-wait-guard): splits a Bash command into its simple
// commands, removes the wrappers in front of each (nice, lockf <file>, env X=1, timeout 5) and follows `sh -c '...'` scripts.
// Quoted text stays inside one word, so a commit message that says "cargo test" is not a cargo command. Lists and limits:
// lane_waste.* in lane_waste.toml. Pure: no file system or process access.
'use strict';
var laneWaste = {
  // Simple commands of `cmd` as { words, inLoop }: `words` start at the command that really runs (wrappers, assignments and shell
  // keywords removed); `inLoop` says a while/until/for loop encloses it.
  commands: function (cmd, depth) {
    var out = [];
    if (depth > ah.cfgNum('lane_waste.max_depth') || typeof cmd !== 'string' || cmd.trim() === '') return out;
    var segs = laneWaste.split(cmd);
    var shells = ah.cfg('lane_waste.shells'), flagRe = ah.cfg('lane_waste.script_flag_re');
    for (var s = 0; s < segs.length; s++) {
      var at = laneWaste.commandAt(segs[s].words);
      if (at < 0) continue;
      var words = segs[s].words.slice(at);
      out.push({ words: words, inLoop: segs[s].inLoop });
      if (shells.indexOf(shellScan.basename(words[0])) >= 0) {
        for (var a = 1; a + 1 < words.length; a++) {
          if (ah.re.test(flagRe, 'r', words[a])) {
            var inner = laneWaste.commands(words[a + 1], depth + 1);
            for (var k = 0; k < inner.length; k++) { inner[k].inLoop = inner[k].inLoop || segs[s].inLoop; out.push(inner[k]); }
          }
        }
      }
    }
    return out;
  },
  // `cmd` cut at ; & | newline and braces into { words, inLoop }. A word keeps its quotes removed; a $( ... ) stays in its word.
  split: function (cmd) {
    var segs = [], words = [], cur = '', has = false, i = 0, n = cmd.length, loops = 0;
    var openers = ah.cfg('lane_waste.loop_openers'), closer = ah.cfg('lane_waste.loop_closer');
    function endWord() { if (has) words.push(cur); cur = ''; has = false; }
    function endSeg() {
      endWord();
      if (words.length > 0) {
        var first = words[0];
        if (first === closer && loops > 0) loops--;
        var inLoop = loops > 0;
        if (openers.indexOf(first) >= 0) { loops++; inLoop = true; }
        segs.push({ words: words, inLoop: inLoop });
      }
      words = [];
    }
    function skipQuote(from, q) {
      var k = from + 1;
      while (k < n && cmd[k] !== q) k += q === '"' && cmd[k] === '\\' ? 2 : 1;
      return k;
    }
    while (i < n) {
      var c = cmd[i];
      if (c === '\\') { if (i + 1 < n) { cur += cmd[i + 1]; has = true; } i += 2; continue; }
      if (c === "'") { var e1 = skipQuote(i, "'"); cur += cmd.slice(i + 1, e1); has = true; i = e1 + 1; continue; }
      if (c === '"') { var e2 = skipQuote(i, '"'); cur += cmd.slice(i + 1, e2); has = true; i = e2 + 1; continue; }
      if (c === '$' && cmd[i + 1] === '(') {
        var depth = 0, k2 = i + 1;
        while (k2 < n) {
          if (cmd[k2] === '(') depth++;
          else if (cmd[k2] === ')') { depth--; if (depth === 0) break; }
          k2++;
        }
        cur += cmd.slice(i, Math.min(k2 + 1, n)); has = true; i = k2 + 1; continue;
      }
      if (c === '#' && !has) { var nl = cmd.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
      if (c === ';' || c === '\n' || c === '(' || c === ')') { endSeg(); i++; continue; }
      if (c === '&') {
        if (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>') { cur += c; has = true; i++; continue; }
        endSeg(); i += cmd[i + 1] === '&' ? 2 : 1; continue;
      }
      if (c === '|') { endSeg(); i += cmd[i + 1] === '|' || cmd[i + 1] === '&' ? 2 : 1; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
      cur += c; has = true; i++;
    }
    endSeg();
    return segs;
  },
  // The index of the command word after wrappers, assignments and shell keywords, or -1.
  commandAt: function (words) {
    var wr = ah.cfg('lane_waste.wrappers'), pos = ah.cfg('lane_waste.wrapper_positional'), kw = ah.cfg('lane_waste.prefix_words');
    var i = 0;
    while (i < words.length) {
      var w = words[i];
      if (kw.indexOf(w) >= 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
      var b = shellScan.basename(w);
      if (!Object.prototype.hasOwnProperty.call(wr, b)) return i;
      var vals = wr[b], plain = Object.prototype.hasOwnProperty.call(pos, b) ? pos[b] : 0;
      i++;
      while (i < words.length) {
        var x = words[i];
        if (x === '--') { i++; break; }
        if (x.charAt(0) === '-' && x.length > 1) { i += vals.indexOf(x) >= 0 ? 2 : 1; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && b === 'env') { i++; continue; }
        if (plain > 0) { plain--; i++; continue; }
        break;
      }
    }
    return -1;
  },
  // The command as a user would read it: the words joined by a space, cut at lane_waste.cmd_max characters.
  shown: function (words) {
    var t = text.clean(words.join(' ')), max = ah.cfgNum('lane_waste.cmd_max');
    return t.length > max ? t.slice(0, max) + '...' : t;
  },
};

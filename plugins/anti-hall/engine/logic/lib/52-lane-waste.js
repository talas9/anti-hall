// Shared command reader of the token-waste guards (lane-test-guard, queued-wait-guard): splits a Bash command into its simple
// commands, removes the wrappers in front of each (nice, lockf <file>, env X=1, timeout 5) and follows `sh -c '...'` scripts.
// Quoted text stays inside one word, so a commit message that says "cargo test" is not a cargo command. Lists and limits:
// lane_waste.* in lane_waste.toml. Pure: no file system or process access.
'use strict';
var laneWaste = {
  // Simple commands of `cmd` as { words, inLoop }: `words` start at the command that really runs (wrappers, assignments and shell
  // keywords removed); `inLoop` says a while/until/for loop encloses it; `pre` is the wrapper words removed in front (and, for a
  // command inside `sh -c '...'`, those of the shell too), so a caller can read a `timeout N` that bounds it.
  commands: function (cmd, depth) {
    var out = [];
    if (depth > ah.cfgNum('lane_waste.max_depth') || typeof cmd !== 'string' || cmd.trim() === '') return out;
    var segs = laneWaste.split(cmd);
    var shells = ah.cfg('lane_waste.shells'), flagRe = ah.cfg('lane_waste.script_flag_re');
    for (var s = 0; s < segs.length; s++) {
      var at = laneWaste.commandAt(segs[s].words);
      if (at < 0) continue;
      var words = segs[s].words.slice(at), pre = segs[s].words.slice(0, at);
      // `bound`: the wrapper words whose `timeout` really limits this command. A wrapper inside a loop bounds one iteration only, so
      // it does not count; a detach word (nohup, setsid, disown) hides what stands before it; `detached` says the command outlives
      // the script around it (a trailing `&` or a detach word), so a timeout around that script does not bound it either.
      var detachWords = ah.cfg('lane_waste.detach_words'), cut = -1;
      for (var d = 0; d < segs[s].words.length; d++) if (detachWords.indexOf(shellScan.basename(segs[s].words[d])) >= 0) cut = d;
      var ownOk = !segs[s].inLoop;
      var own = { words: words, inLoop: segs[s].inLoop, pre: pre, bound: ownOk ? pre.slice(Math.min(cut + 1, pre.length)) : [], detached: segs[s].amp || cut >= 0 };
      out.push(own);
      // `eval 'script'` runs its words as a script: read it like `sh -c`, the eval word standing for the shell
      if (ah.cfg('lane_waste.eval_words').indexOf(shellScan.basename(words[0])) >= 0 && words.length > 1) {
        var ev = laneWaste.commands(words.slice(1).join(' '), depth + 1);
        for (var e = 0; e < ev.length; e++) {
          var evPre = pre.slice(Math.min(cut + 1, pre.length)).concat(words.slice(0, 1));
          ev[e].bound = !ownOk ? [] : (ev[e].detached ? ev[e].bound : evPre.concat(ev[e].bound));
          ev[e].inLoop = ev[e].inLoop || segs[s].inLoop;
          ev[e].pre = pre.concat(words.slice(0, 1), ev[e].pre);
          out.push(ev[e]);
        }
      }
      if (shells.indexOf(shellScan.basename(words[0])) >= 0) {
        for (var a = 1; a + 1 < words.length; a++) {
          if (ah.re.test(flagRe, 'r', words[a])) {
            var inner = laneWaste.commands(words[a + 1], depth + 1);
            for (var k = 0; k < inner.length; k++) {
              var outerPre = pre.slice(Math.min(cut + 1, pre.length)).concat(words.slice(0, a + 1));
              inner[k].bound = !ownOk ? [] : (inner[k].detached ? inner[k].bound : outerPre.concat(inner[k].bound));
              inner[k].inLoop = inner[k].inLoop || segs[s].inLoop;
              inner[k].pre = pre.concat(words.slice(0, a + 1), inner[k].pre);
              out.push(inner[k]);
            }
          }
        }
      }
    }
    return out;
  },
  // `cmd` cut at ; & | newline and braces into { words, inLoop }. A word keeps its quotes removed; a $( ... ) stays in its word.
  split: function (cmd) {
    var segs = [], words = [], cur = [], has = false, i = 0, n = cmd.length, loops = 0, starts = [];
    var openers = ah.cfg('lane_waste.loop_openers'), closer = ah.cfg('lane_waste.loop_closer');
    var gOpen = ah.cfg('lane_waste.group_opener'), gClose = ah.cfg('lane_waste.group_closer'), groups = [];
    var coprocs = ah.cfg('lane_waste.coproc_words'), psOpen = ah.cfg('lane_waste.process_subst_openers');
    function isCoproc(w) { return typeof w === 'string' && coprocs.indexOf(shellScan.basename(w)) >= 0; }
    // a subshell or brace group that is followed by `&` runs detached: every command inside loses the outer bound
    function detachFrom(from) { for (var q = from; q < segs.length; q++) segs[q].amp = true; }
    function endWord() { if (has) words.push(cur.join('')); cur = []; has = false; }
    function endSeg(amp) {
      endWord();
      if (words.length > 0) {
        var first = words[0];
        var from = -1;
        if (first === closer && loops > 0) { loops--; from = starts.pop(); }
        var inLoop = loops > 0;
        if (openers.indexOf(first) >= 0) { loops++; inLoop = true; starts.push(segs.length); }
        var gFrom = -1;
        var gDetach = false;
        // a `coproc [NAME] { ...; }` body runs detached from the script around it
        if (first === gOpen) groups.push({ at: segs.length, kind: 'b', detach: false });
        else if (isCoproc(first) && words.indexOf(gOpen) > 0) groups.push({ at: segs.length, kind: 'b', detach: true });
        else if (first === gClose && groups.length > 0 && groups[groups.length - 1].kind === 'b') { var gp = groups.pop(); gFrom = gp.at; gDetach = gp.detach; }
        segs.push({ words: words, inLoop: inLoop, amp: amp === true });
        if (gFrom >= 0 && (amp === true || gDetach)) detachFrom(gFrom);
        // `done &` sends the whole loop to the background
        if (from >= 0 && amp === true) for (var q = from; q < segs.length; q++) segs[q].amp = true;
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
      if (c === '\\') { if (i + 1 < n) { cur.push(cmd[i + 1]); has = true; } i += 2; continue; }
      if (c === "'") { var e1 = skipQuote(i, "'"); cur.push(cmd.slice(i + 1, e1)); has = true; i = e1 + 1; continue; }
      if (c === '"') { var e2 = skipQuote(i, '"'); cur.push(cmd.slice(i + 1, e2)); has = true; i = e2 + 1; continue; }
      if (c === '$' && cmd[i + 1] === '(') {
        var depth = 0, k2 = i + 1;
        while (k2 < n) {
          if (cmd[k2] === '(') depth++;
          else if (cmd[k2] === ')') { depth--; if (depth === 0) break; }
          k2++;
        }
        cur.push(cmd.slice(i, Math.min(k2 + 1, n))); has = true; i = k2 + 1; continue;
      }
      // process substitution <( ... ) / >( ... ): the body runs as a background process that outlives the command around it, so
      // its commands are read as detached (fail closed: no timeout around the script bounds them)
      var two = cmd.slice(i, i + 2);
      if (psOpen.indexOf(two) >= 0) {
        var pd = 0, k3 = i + 1;
        while (k3 < n) {
          if (cmd[k3] === '(') pd++;
          else if (cmd[k3] === ')') { pd--; if (pd === 0) break; }
          k3++;
        }
        var innerSegs = laneWaste.split(cmd.slice(i + 2, k3));
        for (var is = 0; is < innerSegs.length; is++) { innerSegs[is].amp = true; segs.push(innerSegs[is]); }
        cur.push(cmd.slice(i, Math.min(k3 + 1, n))); has = true; i = k3 + 1; continue;
      }
      if (c === '#' && !has) { var nl = cmd.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
      if (c === '(') { endWord(); var cpGroup = words.length > 0 && isCoproc(words[0]); endSeg(); groups.push({ at: segs.length, kind: 'p', detach: cpGroup }); i++; continue; }
      if (c === ')') {
        endSeg();
        var top = groups.length > 0 && groups[groups.length - 1].kind === 'p' ? groups.pop() : null;
        var nx = i + 1;
        while (nx < n && (cmd[nx] === ' ' || cmd[nx] === '\t')) nx++;
        if (top !== null && ((cmd[nx] === '&' && cmd[nx + 1] !== '&' && cmd[nx + 1] !== '>') || top.detach)) detachFrom(top.at);
        i++; continue;
      }
      if (c === ';' || c === '\n') { endSeg(); i++; continue; }
      if (c === '&') {
        if (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>') { cur.push(c); has = true; i++; continue; }
        var dbl = cmd[i + 1] === '&'; endSeg(!dbl); i += dbl ? 2 : 1; continue;
      }
      if (c === '|') { endSeg(); i += cmd[i + 1] === '|' || cmd[i + 1] === '&' ? 2 : 1; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
      cur.push(c); has = true; i++;
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
      // `coproc NAME { ...; }`: the name is not the command
      if (ah.cfg('lane_waste.coproc_words').indexOf(b) >= 0 && i + 1 < words.length && words[i + 1] === ah.cfg('lane_waste.group_opener')) i++;
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

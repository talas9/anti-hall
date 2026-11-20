// Shared command reader of the token-waste guards (lane-test-guard, queued-wait-guard): splits a Bash command into its simple
// commands, removes the wrappers in front of each (nice, lockf <file>, env X=1, timeout 5) and follows `sh -c '...'` scripts.
// Quoted text stays inside one word, so a commit message that says "cargo test" is not a cargo command. Lists and limits:
// lane_waste.* in lane_waste.toml. Pure: no file system or process access.
'use strict';
var laneWaste = {
  // Simple commands of `cmd` as { words, inLoop }: `words` start at the command that really runs (wrappers, assignments and shell
  // keywords removed); `inLoop` says a while/until/for loop encloses it; `pre` is the wrapper words removed in front (and, for a
  // command inside `sh -c '...'`, those of the shell too); `bound` is the part of `pre` a caller may read as a `timeout N` limit.
  // `det` says a detach token sits inside the timeout-wrapped segment (see laneWaste.segDetach), so no wrapper bounds that command;
  // whether the limit really holds is the caller's call (queued-wait-guard).
  commands: function (cmd, depth) {
    var out = [];
    if (depth > ah.cfgNum('lane_waste.max_depth') || typeof cmd !== 'string' || cmd.trim() === '') return out;
    var segs = laneWaste.split(cmd);
    var shells = ah.cfg('lane_waste.shells'), flagRe = ah.cfg('lane_waste.script_flag_re');
    for (var s = 0; s < segs.length; s++) {
      var at = laneWaste.commandAt(segs[s].words);
      if (at < 0) continue;
      var words = segs[s].words.slice(at), pre = segs[s].words.slice(0, at);
      // a wrapper inside a loop bounds one iteration only, so it does not count
      var ownOk = !segs[s].inLoop;
      var det = laneWaste.segDetach(segs[s], pre, words, depth);
      out.push({ words: words, inLoop: segs[s].inLoop, pre: pre, bound: ownOk ? pre : [], det: det });
      // `eval 'script'` runs its words as a script: read it like `sh -c`, the eval word standing for the shell
      if (ah.cfg('lane_waste.eval_words').indexOf(shellScan.basename(words[0])) >= 0 && words.length > 1) {
        var ev = laneWaste.commands(words.slice(1).join(' '), depth + 1);
        for (var e = 0; e < ev.length; e++) {
          ev[e].bound = !ownOk ? [] : pre.concat(words.slice(0, 1), ev[e].bound);
          ev[e].inLoop = ev[e].inLoop || segs[s].inLoop;
          ev[e].det = ev[e].det || det;
          ev[e].pre = pre.concat(words.slice(0, 1), ev[e].pre);
          out.push(ev[e]);
        }
      }
      if (shells.indexOf(shellScan.basename(words[0])) >= 0) {
        for (var a = 1; a + 1 < words.length; a++) {
          if (ah.re.test(flagRe, 'r', words[a])) {
            var inner = laneWaste.commands(words[a + 1], depth + 1);
            for (var k = 0; k < inner.length; k++) {
              inner[k].bound = !ownOk ? [] : pre.concat(words.slice(0, a + 1), inner[k].bound);
              inner[k].inLoop = inner[k].inLoop || segs[s].inLoop;
              inner[k].det = inner[k].det || det;
              inner[k].pre = pre.concat(words.slice(0, a + 1), inner[k].pre);
              out.push(inner[k]);
            }
          }
        }
      }
    }
    // inside a script a timeout wraps (depth > 0) the whole script is the wrapped segment: one detach anywhere in it taints all of it
    if (depth > 0) {
      var any = false;
      for (var t = 0; t < out.length; t++) any = any || out[t].det;
      if (any) for (var u = 0; u < out.length; u++) out[u].det = true;
    }
    return out;
  },
  // True when one simple command detaches work that can outlive a `timeout` around it (lane_waste.detach_words): its list element ends
  // in a lone `&` (seg.amp), it holds a process substitution `<(` `>(` (seg.proc), a detach word is its command word or a wrapper word
  // in front of it (nohup, setsid, coproc, disown; never a substring of a path or an argument), or a `$( ... )` in it detaches.
  // Quoted text is inert here: only a shell interpreter's or eval's script is read (laneWaste.commands recurses into it).
  segDetach: function (seg, pre, words, depth) {
    if (seg.amp || seg.proc) return true;
    var dw = ah.cfg('lane_waste.detach_words'), all = pre.concat(words.slice(0, 1));
    for (var i = 0; i < all.length; i++) if (dw.indexOf(shellScan.basename(all[i])) >= 0) return true;
    for (var j = 0; j < seg.words.length; j++) {
      var w = seg.words[j], at = w.indexOf('$(');
      if (at < 0) continue;
      var inner = laneWaste.commands(w.slice(at + 2, w.lastIndexOf(')') > at ? w.lastIndexOf(')') : w.length), depth + 1);
      for (var k = 0; k < inner.length; k++) if (inner[k].det) return true;
    }
    return false;
  },
  // `cmd` cut at ; & | newline into { words, inLoop }. A word keeps its quotes removed; a $( ... ) stays in its word.
  split: function (cmd) {
    var segs = [], words = [], cur = [], has = false, i = 0, n = cmd.length, loops = 0, listStart = 0, procNext = false;
    var openers = ah.cfg('lane_waste.loop_openers'), closer = ah.cfg('lane_waste.loop_closer');
    function endWord() { if (has) words.push(cur.join('')); cur = []; has = false; }
    function endSeg() {
      endWord();
      if (words.length > 0) {
        var first = words[0];
        if (first === closer && loops > 0) loops--;
        var inLoop = loops > 0;
        if (openers.indexOf(first) >= 0) { loops++; inLoop = true; }
        segs.push({ words: words, inLoop: inLoop, amp: false, proc: procNext });
      }
      words = []; procNext = false;
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
      if (c === '#' && !has) { var nl = cmd.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
      if (c === '(' || c === ')' || c === ';' || c === '\n') {
        if (c === '(' && (cmd[i - 1] === '<' || cmd[i - 1] === '>')) procNext = true;
        endSeg(); listStart = segs.length; i++; continue;
      }
      if (c === '&') {
        if (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>') { cur.push(c); has = true; i++; continue; }
        endSeg();
        // a lone & sends the whole list element (and-or chain, pipeline) to the background
        if (cmd[i + 1] !== '&') {
          // `( ... ) &` and `{ ...; } &`: the group closed just before, so the last segment stands for it
          for (var m = Math.min(listStart, segs.length - 1); m >= 0 && m < segs.length; m++) segs[m].amp = true;
          listStart = segs.length;
        }
        i += cmd[i + 1] === '&' ? 2 : 1; continue;
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
  // ---- wait-duration readers shared by queued-wait-guard and cache-ttl-wait-guard (lists and units: queued_wait.* in lane_waste.toml) ----
  // The seconds a `sleep` argument list spells (each argument a number with an optional s/m/h/d suffix, or an infinity word), or null
  // when one is not. A caller that judges a sleep treats null as an UNBOUNDED wait (fail closed), never as "not a wait".
  sleepSeconds: function (args) {
    var units = ah.cfg('queued_wait.duration_unit_s'), inf = ah.cfg('queued_wait.duration_infinity_words'), total = 0, seen = false;
    var start = args.length > 0 && args[0] === '--' ? 1 : 0; // `--` ends the options: the operands follow
    for (var i = start; i < args.length; i++) {
      if (inf.indexOf(String(args[i]).toLowerCase()) >= 0) { total = Infinity; seen = true; continue; }
      // a decimal (5, 5., .5, 0.5), optionally with an exponent (1e1), then an optional unit suffix
      var m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)([a-z]?)$/.exec(args[i]);
      if (m === null) return null;
      var mult = m[2] === '' ? 1 : (Object.prototype.hasOwnProperty.call(units, m[2]) ? units[m[2]] : null);
      if (mult === null) return null;
      total += parseFloat(m[1]) * mult; seen = true;
    }
    return seen ? total : null;
  },
  // The words of `args` without shell redirections (`>/dev/null`, `2>&1`, `&>f`, a bare `>` with the file after it, and a redirection
  // attached to a word: `60>/dev/null`, `60&>x`, `60<x` keep the `60`).
  stripRedirects: function (args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var a = String(args[i]), at = a.search(/[<>]/);
      if (at < 0) { out.push(a); continue; }
      var head = a.slice(0, at).replace(/&$/, '');
      // a lone 0/1/2 before the operator is the shell's fd number (`2>&1`), not a duration; any other attached word is kept
      if (/^[012]$/.test(head)) head = '';
      if (head !== '') out.push(head);
      if (/^[^<>]*[<>]+&?$/.test(a)) i++;
    }
    return out;
  },
  // True when the `timeout -s` value names a signal that does not terminate (queued_wait.timeout_silent_signals; SIG prefix and case ignored).
  silentSignal: function (v) {
    var t = String(v).toUpperCase().replace(/^SIG/, ''), list = ah.cfg('queued_wait.timeout_silent_signals');
    return list.indexOf(t) >= 0;
  },
  // The seconds of the tightest `timeout [flags] N` (N above 0) among the wrapper words `pre` that bound a command, or null when none does.
  timeoutSeconds: function (pre) {
    var names = ah.cfg('queued_wait.timeout_commands'), valued = ah.cfg('lane_waste.wrappers'), best = null;
    for (var i = 0; i < pre.length; i++) {
      var b = shellScan.basename(pre[i]);
      if (names.indexOf(b) < 0) continue;
      var vals = Object.prototype.hasOwnProperty.call(valued, b) ? valued[b] : [], j = i + 1, silent = false, killSecs = 0;
      var sigFlags = ah.cfg('queued_wait.timeout_signal_flags'), killFlags = ah.cfg('queued_wait.timeout_kill_flags');
      while (j < pre.length && pre[j].charAt(0) === '-' && pre[j].length > 1) {
        var fl = pre[j], val = null, eq = fl.indexOf('=');
        var name = fl.charAt(1) === '-' ? (eq > 0 ? fl.slice(0, eq) : fl) : fl.slice(0, 2);
        if (fl.charAt(1) === '-' && eq > 0) val = fl.slice(eq + 1);
        else if (fl.charAt(1) !== '-' && fl.length > 2) val = fl.slice(2);
        else if (vals.indexOf(fl) >= 0) { val = j + 1 < pre.length ? pre[j + 1] : null; j++; }
        j++;
        if (sigFlags.indexOf(name) >= 0 && val !== null && laneWaste.silentSignal(val)) silent = true;
        // a kill-after of 0 (GNU: no follow-up kill) or one that does not parse adds no escalation
        if (killFlags.indexOf(name) >= 0 && val !== null) { var ks = laneWaste.sleepSeconds([val]); killSecs = ks !== null && ks > 0 ? ks : 0; }
      }
      // a signal that does not terminate (0, CONT, STOP, ...) never ends the command; only a positive --kill-after still bounds it, and
      // then the command lives for the duration plus the kill-after (a kill-after within the grace margin counts as part of the duration)
      if (silent && killSecs <= 0) continue;
      var secs = j < pre.length ? laneWaste.sleepSeconds([pre[j]]) : null;
      // the duration itself must be positive (0 disables the timer, whatever the kill-after says)
      if (secs === null || secs <= 0) continue;
      if (secs !== null && silent) secs += Math.max(0, killSecs - ah.cfgNum('queued_wait.kill_after_grace_s'));
      // timeout 0 (or a negative number) disables the limit (GNU), so it bounds nothing
      if (secs !== null && secs > 0 && (best === null || secs < best)) best = secs;
    }
    return best;
  },
  // The command as a user would read it: the words joined by a space, cut at lane_waste.cmd_max characters.
  shown: function (words) {
    var t = text.clean(words.join(' ')), max = ah.cfgNum('lane_waste.cmd_max');
    return t.length > max ? t.slice(0, max) + '...' : t;
  },
};

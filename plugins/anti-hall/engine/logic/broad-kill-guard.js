// check = "broad-kill-guard" (PreToolUse on Bash, every agent; engine-only, no Node twin). Blocks the kill commands that select
// processes by name, pattern, port or "everything": pkill, killall, `kill -9 -1`, `kill 0`, a kill fed by a lookup
// (`kill $(pgrep -f x)`, `lsof -ti:3000 | xargs kill`) and `fuser -k`. Killing one explicit PID, and `pkill -P $$` (the caller's
// own children), stay allowed. Unlike command-guard (coordinator only) it also covers subagents, workspace children and Codex.
// It reads simple commands (quotes, substitutions, heredocs read by a shell, sh -c / eval scripts); scripts it cannot see
// (`bash run.sh`, an interpreter's kill call, a remote `ssh host pkill`) are out of reach. Every list, pattern and text is
// in broad_kill.toml. A failure of this script allows (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// Splits `cmd` into simple commands: { words: [string], sep: the operator before it, bodies: [heredoc body] }. A word keeps its
// quotes removed and its $(...) / `...` text in place; a substitution's own text is also returned as a nested script.
function bkParse(cmd) {
  var segs = [], words = [], bodies = [], subs = [], cur = '', has = false, sep = ';', skips = [], i = 0, n = cmd.length;
  function endWord() { if (has) words.push(cur); cur = ''; has = false; }
  function endSeg(nextSep) {
    endWord();
    if (words.length > 0 || bodies.length > 0) segs.push({ words: words, sep: sep, bodies: bodies });
    words = []; bodies = []; sep = nextSep;
  }
  function skipQuote(from, q) {
    var k = from + 1;
    while (k < n && cmd[k] !== q) k += q === '"' && cmd[k] === '\\' ? 2 : 1;
    return k;
  }
  // the end of a $( ... ) starting at `from` (the index of the "$"), honouring nested parens and quotes
  function skipParen(from) {
    var depth = 0, k = from + 1;
    while (k < n) {
      var c = cmd[k];
      if (c === '\\') { k += 2; continue; }
      if (c === "'" || c === '"') { k = skipQuote(k, c) + 1; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return k; }
      k++;
    }
    return n;
  }
  function sub(from, to) { subs.push(cmd.slice(from, to)); }
  while (i < n) {
    var skip = skips.length > 0 && skips[0].at <= i ? skips.shift() : null;
    if (skip) { i = Math.max(i, skip.to); endSeg(';'); continue; }
    var c = cmd[i];
    if (c === '\\') { if (i + 1 < n) { cur += cmd[i + 1]; has = true; } i += 2; continue; }
    if (c === "'") { var e1 = skipQuote(i, "'"); cur += cmd.slice(i + 1, e1); has = true; i = e1 + 1; continue; }
    if (c === '"') {
      var e2 = skipQuote(i, '"'), inner = cmd.slice(i + 1, e2), j = 0;
      cur += inner; has = true;
      while ((j = inner.indexOf('$(', j)) >= 0) {
        var pe = skipParen2(inner, j);
        subs.push(inner.slice(j + 2, pe)); j = pe + 1;
      }
      var b = -1;
      while ((b = inner.indexOf('`', b + 1)) >= 0) {
        var b2 = inner.indexOf('`', b + 1);
        if (b2 < 0) break;
        subs.push(inner.slice(b + 1, b2)); b = b2;
      }
      i = e2 + 1; continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      var pe2 = skipParen(i);
      cur += cmd.slice(i, Math.min(pe2 + 1, n)); has = true; sub(i + 2, pe2); i = pe2 + 1; continue;
    }
    if (c === '`') {
      var e3 = cmd.indexOf('`', i + 1); if (e3 < 0) e3 = n;
      cur += cmd.slice(i, Math.min(e3 + 1, n)); has = true; sub(i + 1, e3); i = e3 + 1; continue;
    }
    if (c === '#' && !has) { var nl = cmd.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      var h = shellScan.parseHeredocRaw(cmd, i);
      if (h && typeof h.lineEnd === 'number') {
        bodies.push(h.body);
        skips.push({ at: h.lineEnd, to: h.end });
        i = h.openerEnd; continue;
      }
    }
    if (c === ';' || c === '\n' || c === '(' || c === ')') { endSeg(';'); i++; continue; }
    if (c === '&') {
      if (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>') { cur += c; has = true; i++; continue; }
      endSeg(';'); i += cmd[i + 1] === '&' ? 2 : 1; continue;
    }
    if (c === '|') { endSeg(cmd[i + 1] === '|' ? ';' : '|'); i += cmd[i + 1] === '|' || cmd[i + 1] === '&' ? 2 : 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    cur += c; has = true; i++;
  }
  endSeg(';');
  return { segs: segs, subs: subs };
}

// the index of the ")" closing the "$(" at `from` inside `t` (no quote awareness needed for the short inner text)
function skipParen2(t, from) {
  var depth = 0;
  for (var k = from + 1; k < t.length; k++) {
    if (t[k] === '(') depth++;
    else if (t[k] === ')') { depth--; if (depth === 0) return k; }
  }
  return t.length;
}

function bkBase(w) { return shellScan.basename(w); }

// Skips wrappers, assignments and keywords before the command; returns the index of the command word, or -1.
function bkCommandAt(words, from) {
  var wr = ah.cfg('broad_kill.wrappers'), pos = ah.cfg('broad_kill.wrapper_positional'), kw = ah.cfg('broad_kill.prefix_words');
  var i = from;
  while (i < words.length) {
    var w = words[i];
    if (kw.indexOf(w) >= 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    var b = bkBase(w);
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
}

function bkIsLookupName(b) { return ah.cfg('broad_kill.lookup_commands').indexOf(b) >= 0; }

// The kind of broad kill a simple command is ('pattern' | 'everyone' | 'lookup'), or null. `segs`/`idx` give the pipeline before it.
function bkClassify(segs, idx, words, at) {
  var cmdName = bkBase(words[at]), args = words.slice(at + 1), k;
  if (ah.cfg('broad_kill.blocked_commands').indexOf(cmdName) >= 0) {
    var scoped = ah.cfg('broad_kill.scoped_commands'), flags = Object.prototype.hasOwnProperty.call(scoped, cmdName) ? scoped[cmdName] : [];
    for (k = 0; k < args.length; k++) {
      var a = args[k], val = null;
      if (flags.indexOf(a) >= 0) val = k + 1 < args.length ? args[k + 1] : null;
      else {
        for (var f = 0; f < flags.length; f++) {
          if (flags[f].indexOf('--') === 0 && a.indexOf(flags[f] + '=') === 0) val = a.slice(flags[f].length + 1);
          else if (flags[f].indexOf('--') !== 0 && a.length > flags[f].length && a.indexOf(flags[f]) === 0) val = a.slice(flags[f].length);
        }
      }
      if (val !== null && ah.re.test(ah.cfg('broad_kill.scope_ok_re'), 'r', val)) return null;
    }
    return 'pattern';
  }
  var fk = ah.cfg('broad_kill.flag_kill_commands');
  if (Object.prototype.hasOwnProperty.call(fk, cmdName)) {
    for (k = 0; k < args.length; k++) if (ah.re.test(fk[cmdName], 'r', args[k])) return 'pattern';
    return null;
  }
  if (ah.cfg('broad_kill.kill_commands').indexOf(cmdName) >= 0) return bkKillTargets(args);
  if (ah.cfg('broad_kill.xargs_commands').indexOf(cmdName) >= 0) {
    var xv = ah.cfg('broad_kill.xargs_value_flags'), j = 0;
    while (j < args.length && args[j].charAt(0) === '-' && args[j].length > 1) { if (args[j] === '--') { j++; break; } j += xv.indexOf(args[j]) >= 0 ? 2 : 1; }
    var at2 = bkCommandAt(args, j);
    if (at2 < 0) return null;
    var inner = bkBase(args[at2]), isKill = ah.cfg('broad_kill.kill_commands').indexOf(inner) >= 0;
    if (ah.cfg('broad_kill.blocked_commands').indexOf(inner) >= 0) return 'pattern';
    if (!isKill) return null;
    for (var p = idx - 1; p >= 0; p--) {
      var prev = segs[p + 1].sep === '|' ? segs[p] : null;
      if (prev === null) break;
      var pat = bkCommandAt(prev.words, 0);
      if (pat >= 0 && bkIsLookupName(bkBase(prev.words[pat]))) return 'lookup';
    }
    var tgt = bkKillTargets(args.slice(at2 + 1));
    return tgt === 'everyone' ? 'everyone' : null;
  }
  return null;
}

// kill [signal] target...: 'everyone' for -1 / 0, 'lookup' for a target that is a lookup substitution, else null.
function bkKillTargets(args) {
  var sv = ah.cfg('broad_kill.signal_value_flags'), i = 0, seenSignal = false, verdict = null;
  for (; i < args.length; i++) {
    var a = args[i];
    if (a === '--') { i++; break; }
    if (!seenSignal && a.charAt(0) === '-' && a.length > 1) {
      seenSignal = true;
      if (sv.indexOf(a) >= 0) i++;
      continue;
    }
    break;
  }
  var broad = ah.cfg('broad_kill.broad_target_re'), look = ah.cfg('broad_kill.lookup_re');
  for (; i < args.length; i++) {
    var t = args[i];
    if (ah.re.test(broad, 'r', t)) return 'everyone';
    if ((t.indexOf('$(') >= 0 || t.indexOf('`') >= 0) && ah.re.test(look, 'r', t)) verdict = 'lookup';
  }
  return verdict;
}

// Walks `cmd` (and the scripts and substitutions inside it) for a broad kill; returns { kind, cmd } or null.
function bkScan(cmd, depth) {
  if (depth > ah.cfgNum('broad_kill.max_depth') || cmd.trim() === '') return null;
  var parsed = bkParse(cmd), shells = shellScan.shellVerbs(), extra = ah.cfg('broad_kill.script_words'), flagRe = ah.cfg('broad_kill.script_flag_re');
  var found = null;
  for (var s = 0; s < parsed.segs.length && found === null; s++) {
    var seg = parsed.segs[s], at = bkCommandAt(seg.words, 0);
    if (at < 0) continue;
    var kind = bkClassify(parsed.segs, s, seg.words, at);
    if (kind !== null) return { kind: kind, cmd: seg.words.slice(at).join(' ') };
    var b = bkBase(seg.words[at]), args = seg.words.slice(at + 1);
    if (shells.has(b)) {
      for (var a = 0; a < args.length && found === null; a++) {
        if (ah.re.test(flagRe, 'r', args[a]) && a + 1 < args.length) found = bkScan(args[a + 1], depth + 1);
      }
      for (var h = 0; h < seg.bodies.length && found === null; h++) found = bkScan(seg.bodies[h], depth + 1);
    } else if (extra.indexOf(b) >= 0) {
      found = bkScan(args.join(' '), depth + 1);
    }
  }
  for (var u = 0; u < parsed.subs.length && found === null; u++) found = bkScan(parsed.subs[u], depth + 1);
  return found;
}

// One shipped key per kind of broad kill (full literals, so the defaults-keys gate sees every read).
var WHAT_KEY = { pattern: 'broad_kill.msg_what_pattern', everyone: 'broad_kill.msg_what_everyone', lookup: 'broad_kill.msg_what_lookup' };

function decide(p, opts) {
  if (!ah.settings.bool('broad_kill.sw') || ah.settings.skipped(ah.cfg('broad_kill.guard_name'))) return 'allow';
  var cmd = p && p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (cmd === '') return 'allow';
  var hit = bkScan(cmd, 0);
  if (hit === null) return 'allow';
  var max = ah.cfgNum('broad_kill.cmd_max'), shown = text.clean(hit.cmd);
  if (shown.length > max) shown = shown.slice(0, max) + '...';
  var reason = text.message('block', ah.cfg('broad_kill.guard_name'), {
    what: text.render(ah.cfg(WHAT_KEY[hit.kind]), { cmd: shown }),
    why: ah.cfg('broad_kill.msg_why'),
    instead: ah.cfg('broad_kill.msg_instead'),
    override: ah.cfg('broad_kill.msg_override'),
  });
  // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}

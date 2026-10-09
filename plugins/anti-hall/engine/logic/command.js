// check = "command" (PreToolUse on Bash): the command-guard's decision for the commands Node allows in EVERY context. command-guard's
// blocks depend on things a script cannot see exactly: the hook's own environment (`CLAUDE_CODE_ENTRYPOINT` decides coordinator vs
// subagent), the DevSwarm state files, edit-guard's verdict on a written path, the repo's command allowlist and git subprocesses for the
// plain-push carve-out. So this script answers only the commands Node allows in every context, and defers everything else to the Node hook:
//   1. no DevSwarm or stash trigger (`defer_substrings`, `defer_path_parts`, a DevSwarm CLI verb): the DevSwarm read/send/mailbox guards and
//      the git-stash guard cannot fire;
//   2. no write target the edit-guard parity branch would judge (a redirect, tee, sed -i, perl -i, cp, mv, an inline-code write);
//   3. not heavy (a build, test, deploy, push, a script run, a mutating cloud CLI call, ...), with the light exceptions.
// A payload that proves a subagent (agent markers, as the coordinator-work check reads them) needs only the first test: Node returns exit 0
// for a subagent right after the special guards. A command with a character outside ASCII is answered only for a proven subagent and only
// when no trigger word can be spelled by it; every other one defers. Mirrors hooks/command-guard.js `main`, `isHeavyCommand`,
// `splitSegmentsDetailed`, `effectiveVerb` and the write-target scan of hooks/lib/work-detect.js. Every table, pattern and limit is in
// command.toml (command.*).
'use strict';

function cmC(k) { return ah.cfg('command.' + k); }

// ---- tables (rebuilt when the defaults change) ----------------------------------------------------------------------------------------
var cmTabMemo = { gen: -1, t: null };
function cmSet(k) { var s = new Set(); cmC(k).forEach(function (x) { s.add(x); }); return s; }
function cmTables() {
  var g = ahHost.cfgGen();
  if (cmTabMemo.t !== null && cmTabMemo.gen === g) return cmTabMemo.t;
  var gh = {}, ghRaw = cmC('gh_mutating_subcommands');
  Object.keys(ghRaw).forEach(function (k) { gh[k] = new Set(ghRaw[k]); });
  cmTabMemo = { gen: g, t: {
    maxLen: cmC('max_classify_len'), maxDepth: cmC('max_depth'), deferSubstrings: cmC('defer_substrings'), devswarmVerbs: cmSet('devswarm_cli_verbs'),
    deferPathParts: cmC('defer_path_parts'), wrappers: cmSet('wrappers'), sudoValue: cmSet('sudo_value_flags'), timeoutValue: cmSet('timeout_value_flags'),
    niceValue: cmSet('nice_value_flags'), taskpolicyValue: cmSet('taskpolicy_value_flags'), shellVerbs: cmSet('shell_verbs'), testKeywords: cmSet('test_keywords'),
    patternFirst: cmSet('pattern_first_verbs'), heavyVerbs: cmSet('heavy_verbs'), nodeEvalFlags: cmSet('node_eval_flags'), nodeFsRead: cmSet('node_fs_read_allowlist'),
    gitGlobalValue: cmSet('git_global_value_opts'), gitFetchDangerous: cmSet('git_fetch_dangerous_flags'), gitHeavySubs: cmSet('git_heavy_subs'),
    cloudBinaries: cmSet('cloud_binaries'), cloudReadonly: cmSet('cloud_readonly_verbs'), cloudMutating: cmSet('cloud_mutating_verbs'), gcloudInspect: cmSet('gcloud_inspect_verbs'),
    gcloudBool: cmSet('gcloud_boolean_flags'), gcloudValue: cmSet('gcloud_value_flags'), ghMutating: gh, ghApiMethods: cmSet('gh_api_mutating_methods'),
    ghFieldFlags: cmSet('gh_api_field_flags'), ghGqlValue: cmSet('gh_gql_value_flags'), ghGqlBool: cmSet('gh_gql_bool_flags'), inlineVerbs: cmSet('inline_verbs'),
    roVerbsNone: null, nodeFsCall: new RegExp(cmC('node_fs_method_call'), 'g'), unknowable: cmC('write_target_unknowable'),
  } };
  return cmTabMemo.t;
}

// A pattern of command.toml (engine syntax, linear time) against a text.
function cmRe(src, t) { return ah.re.test(src, 'r', t); }
// The first match of an engine-syntax pattern as [start, end], or null.
function cmFind(src, t) { var r = ah.re.find(src, 'r', t); return r ? r : null; }
function cmReAny(k, t) { return cmC(k).some(function (src) { return cmRe(src, t); }); }

// ---- shell primitives ------------------------------------------------------------------------------------------------------------------
function cmIsWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\x0b' || c === '\x0c'; }
function cmTrim(s) { var a = 0, b = s.length; while (a < b && cmIsWs(s.charAt(a))) a++; while (b > a && cmIsWs(s.charAt(b - 1))) b--; return s.slice(a, b); }
function cmWords(s) { return s.split(/[ \t\n\r\x0b\x0c]+/).filter(function (w) { return w !== ''; }); }
function cmBase(p) { if (p === '') return ''; var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return p.slice(i + 1); }
function cmBaseLower(p) { return cmBase(p).toLowerCase(); }
function cmIsAssign(s) { return /^[A-Za-z_][A-Za-z0-9_]*=/.test(s); }
function cmHeredoc(text, i) { return shellScan.parseHeredocAt(text, i); }

// A run of characters the splitter below does nothing special with (taken at once, so a long plain word costs one step).
var CM_PLAIN = /[^'"\\$#<&|;\n(){}`\[\]]+/y;

// Quote-aware split into simple commands: {segments, delims}.
function cmSplit(cmd) {
  var n = cmd.length, out = { segments: [], delims: [] }, cur = '', i = 0, inS = false, inD = false, nest = [], inTick = false, escEnd = -1, heredoc = null;
  shellScan.reset();
  function flush(delim) { if (cmTrim(cur) !== '') { out.segments.push(cur); out.delims.push(delim); } cur = ''; }
  while (i < n) {
    if (heredoc !== null && i >= heredoc.lineEnd) { flush('heredoc'); i = Math.max(i, heredoc.end); heredoc = null; inS = false; inD = false; continue; }
    if (heredoc === null) {
      if (inS) {
        var q = cmd.indexOf("'", i);
        if (q < 0) { cur += cmd.slice(i); i = n; } else { cur += cmd.slice(i, q + 1); i = q + 1; inS = false; }
        continue;
      }
      if (!inD) {
        CM_PLAIN.lastIndex = i;
        var run = CM_PLAIN.exec(cmd);
        if (run !== null) { cur += run[0]; i += run[0].length; continue; }
      }
    }
    var c = cmd.charAt(i), c2 = i + 1 < n ? cmd.charAt(i + 1) : null;
    if (inS) { cur += c; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === '\\' && c2 !== null) { cur += c + cmd.charAt(i + 1); i += 2; continue; }
      cur += c;
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === '$' && c2 === "'") {
      var j = i + 2;
      while (j < n && cmd.charAt(j) !== "'") j += cmd.charAt(j) === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      cur += cmd.slice(i, j);
      i = j;
      continue;
    }
    if (c === "'") { inS = true; cur += "'"; i++; continue; }
    if (c === '"') { inD = true; cur += '"'; i++; continue; }
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd.charAt(i + 2) === '\n'))) { cur += ' '; i += c2 === '\r' ? 3 : 2; escEnd = i; continue; }
    if (c === '\\' && c2 !== null) { cur += c + cmd.charAt(i + 1); i += 2; escEnd = i; continue; }
    if (c === '#' && nest.length === 0 && !inTick && escEnd !== i && (i === 0 || ' \t\n;&|'.indexOf(cmd.charAt(i - 1)) >= 0)) {
      var nl = cmd.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '<' && c2 === '<' && heredoc === null) {
      var p = cmHeredoc(cmd, i);
      if (p) {
        cur += cmd.slice(i, p.openerEnd);
        i = p.openerEnd;
        if (p.lineEnd !== undefined) heredoc = { lineEnd: p.lineEnd, end: p.end };
        continue;
      }
    }
    if (c === '&' && c2 === '&') { flush('&&'); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush('||'); i += 2; continue; }
    if (c === '|') { flush('|'); i++; continue; }
    if (c === ';') { flush(';'); i++; continue; }
    if (c === '&' && ((escEnd !== i && i > 0 && (cmd.charAt(i - 1) === '>' || cmd.charAt(i - 1) === '<')) || c2 === '>')) { cur += '&'; i++; continue; }
    if (c === '&') { flush('&'); i++; continue; }
    if (c === '\n') { flush('\n'); i++; continue; }
    if (c === ')' || c === '(' || c === '{' || c === '}') {
      if (c === '(' || c === '{') nest.push(c);
      else if (nest.length > 0 && nest[nest.length - 1] === (c === ')' ? '(' : '{')) nest.pop();
      flush('group');
      i++;
      continue;
    }
    if (c === '$' && c2 === '(') { nest.push('('); flush('subst'); i += 2; continue; }
    if (c === '`') { inTick = !inTick; flush('subst'); i++; continue; }
    if (c === '$' && c2 === '[') { nest.push('['); cur += '$['; i += 2; continue; }
    if (c === '[' && nest.length > 0 && nest[nest.length - 1] === '[') nest.push('[');
    else if (c === ']' && nest.length > 0 && nest[nest.length - 1] === '[') nest.pop();
    cur += c;
    i++;
  }
  flush('end');
  return out;
}
function cmSegments(cmd) { return cmSplit(cmd).segments; }

// The segment's effective verb, skipping wrapper words and their options.
function cmVerb(segment) {
  var t = cmTables(), tokens = cmWords(segment), idx = 0;
  while (idx < tokens.length && cmIsAssign(tokens[idx])) idx++;
  var valueWrapper = function (vals, stopAtDashdash) {
    while (idx < tokens.length && tokens[idx].charAt(0) === '-') {
      var f = tokens[idx];
      idx++;
      if (stopAtDashdash && f === '--') break;
      if (vals.has(f) && idx < tokens.length && tokens[idx].charAt(0) !== '-') idx++;
    }
  };
  while (idx < tokens.length) {
    var word = cmBaseLower(tokens[idx]);
    if (!t.wrappers.has(word)) break;
    idx++;
    if (word === 'sudo') valueWrapper(t.sudoValue, true);
    else if (word === 'env') { while (idx < tokens.length && (cmIsAssign(tokens[idx]) || tokens[idx].charAt(0) === '-')) idx++; }
    else if (word === 'timeout') { valueWrapper(t.timeoutValue, false); if (idx < tokens.length) idx++; }
    else if (word === 'nice') valueWrapper(t.niceValue, false);
    else if (word === 'taskpolicy') valueWrapper(t.taskpolicyValue, false);
    else if (word === 'xargs') { while (idx < tokens.length && tokens[idx].charAt(0) === '-') idx++; }
  }
  return idx >= tokens.length ? '' : cmBaseLower(tokens[idx]);
}

// Split on blanks with quotes removed (a quoted piece joins its neighbours).
function cmTokQ(segment) {
  var tokens = [], cur = '', q = null, any = false, s = cmTrim(segment);
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q !== null) { if (c === q) q = null; else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (cmIsWs(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c;
    any = true;
  }
  if (any) tokens.push(cur);
  return tokens;
}
function cmDequote(segment) { return cmTokQ(segment).join(' '); }

// The text of every command substitution (`$( )` and backticks) of a command, outermost only.
function cmSubstitutions(s) {
  var n = s.length, found = [], i = 0, inS = false, inD = false;
  shellScan.reset();
  while (i < n) {
    var c = s.charAt(i), c2 = i + 1 < n ? s.charAt(i + 1) : null;
    if (!inS && !inD && c === '<' && c2 === '<') {
      var p = cmHeredoc(s, i);
      if (p) {
        if (p.quoted) i = p.end;
        else { i += p.openerText.length; if (i < n && s.charAt(i) === '\n') i++; }
        continue;
      }
    }
    if (inS) { if (c === "'") inS = false; i++; continue; }
    if (!inD && c === '$' && c2 === "'") { i += 2; while (i < n && s.charAt(i) !== "'") i += s.charAt(i) === '\\' ? 2 : 1; i++; continue; }
    if (!inD && c === "'") { inS = true; i++; continue; }
    if (c === '"') { inD = !inD; i++; continue; }
    if (c === '$' && c2 === '(') {
      var depth = 1, j = i + 2, start = j;
      while (j < n && depth > 0) {
        var cj = s.charAt(j);
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        j++;
      }
      var inner = s.slice(start, Math.min(j, n));
      if (cmTrim(inner) !== '') found.push(inner);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      var st = i + 1, k = st;
      while (k < n && s.charAt(k) !== '`') k++;
      var inn = s.slice(Math.min(st, n), Math.min(k, n));
      if (cmTrim(inn) !== '') found.push(inn);
      i = k + 1;
      continue;
    }
    i++;
  }
  return found;
}

// `bash -c '<payload>'` (also -lc ...): the payload text, or ''.
function cmShellCPayload(segment) {
  var verb = cmVerb(segment);
  if (verb === '' || !cmTables().shellVerbs.has(verb)) return '';
  var tokens = cmTokQ(segment);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i], cluster = t.length >= 2 && t.charAt(0) === '-' && t.charAt(t.length - 1) === 'c' && /^[a-z]*$/.test(t.slice(1));
    if (t === '-c' || t === '--command' || cluster) return i + 1 < tokens.length ? tokens[i + 1] : '';
  }
  return '';
}

function cmEvalPayload(segment) {
  if (cmVerb(segment) !== 'eval') return '';
  var tokens = cmTokQ(segment), idx = 0;
  while (idx < tokens.length && cmBaseLower(tokens[idx]) !== 'eval') idx++;
  idx++;
  return tokens.slice(idx).filter(function (t) { return t !== ''; }).join(' ');
}

// Blank the contents of quoted spans (delimiters included) so quoted data cannot match a pattern.
function cmNeutral(segment) {
  var n = segment.length, out = '', i = 0, inS = false, inD = false;
  while (i < n) {
    var c = segment.charAt(i), has2 = i + 1 < n;
    if (inS) { out += ' '; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === '\\' && has2) { out += '  '; i += 2; continue; }
      out += ' ';
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === '\\' && has2) { out += c + segment.charAt(i + 1); i += 2; continue; }
    if (c === "'") { inS = true; out += ' '; i++; continue; }
    if (c === '"') { inD = true; out += ' '; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

// Blank the pattern operand of grep, sed and awk.
function cmBlankPattern(text, verb) {
  if (verb === '' || !cmTables().patternFirst.has(verb)) return text;
  var b = text.length, found = false, i = 0;
  while (i < b) {
    if (cmIsWs(text.charAt(i))) { i++; continue; }
    var start = i;
    while (i < b && !cmIsWs(text.charAt(i))) i++;
    var tok = text.slice(start, i);
    if (!found) { if (cmBaseLower(tok) === verb) found = true; continue; }
    if (tok.charAt(0) === '-') continue;
    return text.slice(0, start) + ' '.repeat(tok.length) + text.slice(i);
  }
  return text;
}

function cmHasRedirectChar(segment) {
  var n = segment.length, inS = false, inD = false, i = 0;
  while (i < n) {
    var c = segment.charAt(i), has2 = i + 1 < n;
    if (inS) { if (c === "'") inS = false; }
    else if (inD) { if (c === '\\' && has2) i++; else if (c === '"') inD = false; }
    else if (c === '\\' && has2) i++;
    else if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === '>' || c === '<') return true;
    i++;
  }
  return false;
}

function cmHasSubstOutsideSingle(segment) {
  var n = segment.length, inS = false, inD = false, i = 0;
  while (i < n) {
    var c = segment.charAt(i), c2 = i + 1 < n ? segment.charAt(i + 1) : null;
    if (inS) { if (c === "'") inS = false; }
    else if (inD) {
      if (c === '\\' && c2 !== null) i++;
      else if (c === '"') inD = false;
      else if (c === '`' || (c === '$' && c2 === '(')) return true;
    } else if (c === '\\' && c2 !== null) i++;
    else if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === '`' || (c === '$' && c2 === '(')) return true;
    i++;
  }
  return false;
}

function cmHasExpansionAnywhere(command) {
  if (cmHasSubstOutsideSingle(command)) return true;
  return /[$`\\]/.test(command) || command.indexOf('<(') >= 0 || command.indexOf('>(') >= 0;
}

// Replace each `<( )` / `>( )` process substitution by a blank; returns {masked, inners}.
function cmMaskProc(cmd) {
  var n = cmd.length, inners = [], out = '', i = 0, q = null;
  shellScan.reset();
  while (i < n) {
    var c = cmd.charAt(i);
    if (q !== null) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += cmd.slice(i, i + 2); i += 2; continue; }
      out += c;
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) { out += cmd.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && cmd.charAt(i + 1) === '<') {
      var h = cmHeredoc(cmd, i);
      if (h) { out += cmd.slice(i, h.end); i = h.end; continue; }
    }
    if ((c === '<' || c === '>') && cmd.charAt(i + 1) === '(') {
      var j = i + 2, depth = 1, qq = null;
      while (j < n && depth > 0) {
        var d = cmd.charAt(j);
        if (qq !== null) { if (d === qq) qq = null; }
        else if (d === "'" || d === '"') qq = d;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
        j++;
      }
      var end = depth > 0 ? j : j - 1;
      inners.push(cmd.slice(i + 2, end));
      out += ' ';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { masked: out, inners: inners };
}

// Blank `<` and `>` that are test operators inside `[[ ]]` / `(( ))`.
function cmBlankTestOps(text) {
  if (!/[<>]/.test(text) || !(text.indexOf('((') >= 0 || text.indexOf('[[') >= 0)) return text;
  var n = text.length, stack = [], out = '', i = 0, q = null;
  shellScan.reset();
  var testCtx = function () { var t = stack[stack.length - 1]; return t === 'A' || t === 'a' || t === 'b' || t === 'g'; };
  var sep = function (c) { return c === ';' || c === '&' || c === '|' || c === '(' || c === '!' || c === '\n'; };
  var cmdPos = function (at) {
    var j = at - 1;
    while (j >= 0 && (text.charAt(j) === ' ' || text.charAt(j) === '\t')) j--;
    if (j < 0 || sep(text.charAt(j))) return true;
    var k = j;
    while (k >= 0 && /[A-Za-z]/.test(text.charAt(k))) k--;
    if (!cmTables().testKeywords.has(text.slice(k + 1, j + 1))) return false;
    while (k >= 0 && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) k--;
    return k < 0 || sep(text.charAt(k));
  };
  var drop = function (kinds) { while (stack.length > 0 && kinds.indexOf(stack[stack.length - 1]) >= 0) stack.pop(); };
  while (i < n) {
    var c = text.charAt(i), c2 = i + 1 < n ? text.charAt(i + 1) : null;
    if (q !== null) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += text.slice(i, i + 2); i += 2; continue; }
      out += c;
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === '$' && c2 === "'") {
      var j = i + 2;
      while (j < n && text.charAt(j) !== "'") j += text.charAt(j) === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && c2 === '<' && !testCtx()) {
      var h = cmHeredoc(text, i);
      if (h) { out += text.slice(i, h.end); i = h.end; continue; }
    }
    if (c === ';' || c === '\n') drop(['a', 'b', 'g']);
    else if ((c === '&' || c === '|') && c2 !== c && (i === 0 || text.charAt(i - 1) !== c)) drop(['b', 'g']);
    if (c === '$' && c2 === '(' && text.charAt(i + 2) === '(') { stack.push('A'); out += '$(('; i += 3; continue; }
    if (c === '$' && c2 === '(') { stack.push('p'); out += '$('; i += 2; continue; }
    if (c === '(' && c2 === '(' && !testCtx() && cmdPos(i)) { stack.push('a'); out += '(('; i += 2; continue; }
    if (c === '(') { stack.push(testCtx() ? 'g' : 'p'); out += '('; i++; continue; }
    if (c === ')') {
      var top = stack[stack.length - 1];
      if ((top === 'a' || top === 'A') && c2 === ')') { stack.pop(); out += '))'; i += 2; continue; }
      stack.pop();
      out += ')';
      i++;
      continue;
    }
    if (c === '[' && c2 === '[' && !testCtx() && cmdPos(i) && i + 2 < n && cmIsWs(text.charAt(i + 2))) { stack.push('b'); out += '[['; i += 2; continue; }
    if (c === ']' && c2 === ']' && stack[stack.length - 1] === 'b' && (i + 2 >= n || cmIsWs(text.charAt(i + 2)) || ';&|)<>'.indexOf(text.charAt(i + 2)) >= 0)) { stack.pop(); out += ']]'; i += 2; continue; }
    out += (c === '<' || c === '>') && testCtx() ? ' ' : c;
    i++;
  }
  return out;
}

// The body of every heredoc of a text, in order.
function cmHeredocBodies(text) {
  var out = [], q = null, i = 0, b = text.length;
  shellScan.reset();
  while (i < b) {
    var c = text.charAt(i);
    if (q !== null) {
      if (c === '\\' && q === '"') { i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    if (c === '<' && text.charAt(i + 1) === '<') {
      var h = cmHeredoc(text, i);
      if (h) {
        out.push(h.body);
        var stop = h.lineEnd !== undefined ? h.end : h.openerEnd;
        i = Math.max(i, stop - 1);
      } else if (text.charAt(i + 2) === '<') i += 2;
    }
    i++;
  }
  return out;
}

function cmSegmentHeredocBodies(segments, text) {
  var all = cmHeredocBodies(text), k = 0;
  return segments.map(function (s) {
    var n = cmHeredocBodies(s).length, lo = Math.min(k, all.length), hi = Math.min(k + n, all.length);
    k += n;
    return all.slice(lo, hi);
  });
}

// ---- write targets --------------------------------------------------------------------------------------------------------------------

function cmUnbrace(text) {
  var n = text.length, out = '', i = 0, ident = function (c) { return /[A-Za-z0-9_]/.test(c); };
  while (i < n) {
    if (text.charAt(i) === '$' && text.charAt(i + 1) === '{' && /[A-Za-z_]/.test(text.charAt(i + 2))) {
      var j = i + 3;
      while (j < n && ident(text.charAt(j))) j++;
      if (text.charAt(j) === '}' && !(j + 1 < n && ident(text.charAt(j + 1)))) { out += '$' + text.slice(i + 2, j); i = j + 1; continue; }
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

function cmRedirectTarget(s, i) {
  while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) i++;
  if (i >= s.length || s.charAt(i) === '&' || s.charAt(i) === '(') return null;
  var out = '', q = null;
  while (i < s.length) {
    var c = s.charAt(i);
    if (q !== null) { if (c === q) q = null; else out += c; }
    else if (c === "'" || c === '"') q = c;
    else if (c === '\\' && i + 1 < s.length) { out += s.charAt(i + 1); i++; }
    else if (cmIsWs(c) || ';|&<>()'.indexOf(c) >= 0) break;
    else out += c;
    i++;
  }
  return out === '' ? null : out;
}

function cmKeep(out, t) {
  if (t === null || t === '' || t.charAt(0) === '&' || t.charAt(0) === '(' || t.indexOf('>') >= 0 || t.indexOf('/dev/') === 0) return;
  out.push(t);
}

function cmJoin(a, b) { return posix.join(a, b); }

// The files a segment writes: redirections, tee, sed -i, perl -i, cp, mv.
function cmWriteTargets(segment) {
  var out = [];
  if (cmTrim(segment) === '') return out;
  var neutral = cmBlankTestOps(cmNeutral(segment)), opRe = /(^|[^<>&])(>\||&?>>?)/g, m;
  while ((m = opRe.exec(neutral)) !== null) {
    var op = m.index + m[1].length, bs = 0;
    while (op > bs && neutral.charAt(op - 1 - bs) === '\\') bs++;
    if (bs % 2 === 1) continue;
    cmKeep(out, cmRedirectTarget(segment, op + m[2].length));
  }
  var redir = /^\d*(?:&?>>?|>\||<)/, bare = /^\d*(?:&?>>?|>\||<+)$/, raw = cmTokQ(segment), toks = [], i = 0;
  while (i < raw.length) {
    if (raw[i] !== '' && redir.test(raw[i])) { if (bare.test(raw[i])) i++; i++; continue; }
    toks.push(raw[i]);
    i++;
  }
  var verb = cmVerb(segment);
  if (verb === '') return out;
  var vi = -1;
  for (var a = 0; a < toks.length; a++) if (cmBaseLower(toks[a]) === verb) { vi = a; break; }
  if (vi < 0) return out;
  var rest = toks.slice(vi + 1), t;
  if (verb === 'tee') {
    rest.forEach(function (x) { if (x.charAt(0) !== '-') cmKeep(out, x); });
  } else if (verb === 'sed') {
    var inPlace = false, scriptOpt = false, pos = [];
    for (i = 0; i < rest.length; i++) {
      t = rest[i];
      if (t === '--') { pos = pos.concat(rest.slice(i + 1)); break; }
      if (t === '-i') { inPlace = true; if (i + 1 < rest.length && rest[i + 1] === '') i++; }
      else if (t === '-e' || t === '-f' || t === '--expression' || t === '--file') { scriptOpt = true; i++; }
      else if (t.indexOf('--expression=') === 0 || t.indexOf('--file=') === 0) scriptOpt = true;
      else if (t === '--in-place' || t.indexOf('--in-place=') === 0) inPlace = true;
      else if (t.indexOf('--') === 0) { /* another long option */ }
      else if (/^-[A-Za-z]/.test(t)) {
        for (var k = 1; k < t.length; k++) {
          if (t.charAt(k) === 'i') { inPlace = true; break; }
          if (t.charAt(k) === 'e' || t.charAt(k) === 'f') { scriptOpt = true; if (k === t.length - 1) i++; break; }
        }
      } else pos.push(t);
    }
    if (inPlace) pos.slice(scriptOpt ? 0 : 1).forEach(function (x) { cmKeep(out, x); });
  } else if (verb === 'perl') {
    var ip = false, hasE = false, pp = [];
    for (i = 0; i < rest.length; i++) {
      t = rest[i];
      if (t === '--') { pp = pp.concat(rest.slice(i + 1)); break; }
      if (t.length >= 2 && t.charAt(0) === '-' && t.charAt(1) !== '-') {
        for (var k2 = 1; k2 < t.length; k2++) {
          if (t.charAt(k2) === 'i') { ip = true; break; }
          if (t.charAt(k2) === 'e' || t.charAt(k2) === 'E') { hasE = true; if (k2 === t.length - 1) i++; break; }
        }
      } else if (t.indexOf('--') !== 0) pp.push(t);
    }
    if (ip) pp.slice(hasE ? 0 : 1).forEach(function (x) { cmKeep(out, x); });
  } else if (verb === 'cp' || verb === 'mv') {
    var tdir = null, ps = [];
    for (i = 0; i < rest.length; i++) {
      t = rest[i];
      if (t === '--') { ps = ps.concat(rest.slice(i + 1)); break; }
      if (t === '-t' || t === '--target-directory') { tdir = i + 1 < rest.length && rest[i + 1] !== '' ? rest[i + 1] : null; i++; continue; }
      if (t.indexOf('--target-directory=') === 0) tdir = t.slice('--target-directory='.length);
      else if (t.length > 2 && t.indexOf('-t') === 0 && t.charAt(2) !== '\n' && t.charAt(2) !== '\r') tdir = t.slice(2);
      else if (t === '-S' || t === '--suffix') i++;
      else if (t.charAt(0) !== '-') ps.push(t);
    }
    var dest, srcs;
    if (tdir !== null) { dest = tdir; srcs = ps; }
    else { if (ps.length < 2) return out; dest = ps[ps.length - 1]; srcs = ps.slice(0, ps.length - 1); }
    var knownDir = tdir !== null || dest.charAt(dest.length - 1) === '/';
    srcs.forEach(function (s) { cmKeep(out, cmJoin(dest, cmBase(s))); });
    if (!knownDir) cmKeep(out, dest);
    if (verb === 'mv') srcs.forEach(function (s) { cmKeep(out, s); });
  }
  return out;
}

function cmInlineMayWrite(segment) {
  var t = cmTables(), verb = cmVerb(segment).replace(/["']/g, '');
  if (!t.inlineVerbs.has(verb)) return false;
  var toks = cmTokQ(segment), vi = -1;
  for (var a = 0; a < toks.length; a++) if (cmBaseLower(toks[a]) === verb) { vi = a; break; }
  if (vi < 0) return false;
  var flags = verb.indexOf('python') === 0 ? cmC('inline_python_flags') : cmC('inline_other_flags'), fi = -1;
  for (var k = 0; k < toks.length; k++) if (k > vi && flags.indexOf(toks[k]) >= 0) { fi = k; break; }
  if (fi < 0 || fi + 1 >= toks.length) return false;
  var body = toks[fi + 1];
  return cmC('inline_write_markers').some(function (m) { return body.indexOf(m) >= 0; });
}

function cmResolvable(t) {
  if (t === '' || t.charAt(0) === '~') return false;
  var u = cmTables().unknowable;
  for (var i = 0; i < t.length; i++) if (u.indexOf(t.charAt(i)) >= 0) return false;
  return true;
}

// The command texts a shell-run segment (`bash -c`, `eval`, a shell fed a heredoc) executes.
function cmShellRunPayloads(segments, text) {
  var out = [], bodies = null, t = cmTables();
  segments.forEach(function (seg, i) {
    var c = cmShellCPayload(seg), e = cmEvalPayload(seg);
    if (c !== '') out.push(c);
    if (e !== '') out.push(e);
    if (c === '' && t.shellVerbs.has(cmVerb(seg)) && seg.indexOf('<<') >= 0) {
      if (bodies === null) bodies = cmSegmentHeredocBodies(segments, text);
      var b = bodies[i];
      if (b && b.length > 0 && b[b.length - 1] !== '') out.push(b[b.length - 1]);
    }
  });
  return out;
}

// True when `command` may write a file edit-guard would judge.
function cmMayWrite(command, depth) {
  var t = cmTables();
  if (cmTrim(command) === '' || command.length > t.maxLen) return false;
  var masked = command, inners = [];
  if (command.indexOf('<(') >= 0 || command.indexOf('>(') >= 0) { var mp = cmMaskProc(command); masked = mp.masked; inners = mp.inners; }
  masked = cmBlankTestOps(masked);
  var split = cmSplit(cmUnbrace(masked));
  for (var i = 0; i < split.segments.length; i++) {
    var seg = split.segments[i];
    if (cmVerb(seg) === 'git') continue;
    if (cmWriteTargets(seg).some(cmResolvable) || cmInlineMayWrite(seg)) return true;
  }
  if (depth < t.maxDepth) {
    var inner = cmShellRunPayloads(split.segments, masked).concat(cmSubstitutions(masked), inners);
    return inner.some(function (s) { return cmMayWrite(s, depth + 1); });
  }
  return false;
}

// ---- heavy commands ---------------------------------------------------------------------------------------------------------------------

function cmWordBoundaryAfter(text, e) { return e >= text.length || !/[A-Za-z0-9_]/.test(text.charAt(e)); }

// A light exception with a negative lookahead: some match of `head` ends (at a word boundary, right after the text `end`) where `notAfter`
// does not match before the end of that line.
function cmNegLight(nl, text) {
  var lower = jx.asciiLower(text), end = nl.end.toLowerCase(), from = 0;
  for (;;) {
    var p = lower.indexOf(end, from);
    if (p < 0) return false;
    var e = p + end.length;
    from = p + 1;
    if (!cmWordBoundaryAfter(text, e) || !ah.re.test(nl.head + '$', 'r', text.slice(0, e))) continue;
    var nlAt = text.indexOf('\n', e), eol = nlAt < 0 ? text.length : nlAt;
    var m = cmFind(nl.not_after, text.slice(e));
    if (m === null || e + m[0] > eol) return true;
  }
}

function cmGitSubIndex(tokens, gitIdx) {
  var t = cmTables(), idx = gitIdx + 1;
  while (idx < tokens.length) {
    var tok = tokens[idx];
    if (tok.charAt(0) !== '-') return idx;
    var eq = tok.indexOf('='), base = eq < 0 ? tok : tok.slice(0, eq);
    if (t.gitGlobalValue.has(base)) { idx += eq < 0 ? 2 : 1; continue; }
    idx++;
  }
  return -1;
}

function cmGitSub(segment) {
  if (cmVerb(segment) !== 'git') return null;
  var tokens = cmTokQ(segment), gi = -1;
  for (var i = 0; i < tokens.length; i++) if (cmBaseLower(tokens[i]) === 'git') { gi = i; break; }
  if (gi < 0) return null;
  var sub = cmGitSubIndex(tokens, gi);
  return sub < 0 ? null : { tokens: tokens, sub: sub };
}

function cmSafeGitFetch(segment) {
  var g = cmGitSub(segment);
  if (g === null || g.tokens[g.sub].toLowerCase() !== 'fetch') return false;
  var d = cmTables().gitFetchDangerous;
  return g.tokens.slice(g.sub + 1).every(function (t) { return !d.has(t) && t.charAt(0) !== '+' && t.indexOf(':') < 0; });
}

function cmHeavyGit(segment) {
  var g = cmGitSub(segment);
  if (g === null) return false;
  var s = g.tokens[g.sub].toLowerCase();
  return cmTables().gitHeavySubs.has(s) || (s === 'fetch' && !cmSafeGitFetch(segment));
}

function cmPipedInto(whole, segment) {
  var idx = whole.indexOf(segment);
  if (idx <= 0) return false;
  var i = idx - 1;
  while (i >= 0 && cmIsWs(whole.charAt(i))) i--;
  return i >= 0 && whole.charAt(i) === '|' && (i === 0 || whole.charAt(i - 1) !== '|');
}

function cmSafeSqlite(segment, whole) {
  if (cmVerb(segment) !== 'sqlite3') return false;
  if (cmNeutral(segment).indexOf('<') >= 0 || cmPipedInto(whole, segment)) return false;
  var tokens = cmTokQ(segment), vi = -1;
  for (var a = 0; a < tokens.length; a++) if (cmBase(tokens[a]).toLowerCase() === 'sqlite3') { vi = a; break; }
  if (vi < 0) return false;
  var ro = -1, db = -1;
  for (var i = vi + 1; i < tokens.length; i++) {
    if (tokens[i] === '-readonly') { ro = i; continue; }
    if (tokens[i].charAt(0) === '-') continue;
    db = i;
    break;
  }
  if (ro < 0 || db < 0 || ro > db) return false;
  return !cmRe(cmC('sqlite_dangerous'), tokens.slice(db + 1).join(' '));
}

// The grammar of one read-only gcloud call: {path, verb}, or null.
function cmGcloudRead(rest, sepValues) {
  var t = cmTables(), i = 0, path = [];
  while (i < rest.length && rest[i].charAt(0) !== '-') {
    if (t.gcloudInspect.has(rest[i].toLowerCase())) break;
    path.push(rest[i]);
    i++;
  }
  if (i >= rest.length || rest[i].charAt(0) === '-') return null;
  var verb = rest[i].toLowerCase();
  i++;
  if (path.length === 0) return null;
  for (var k = 0; k < path.length; k++) {
    if (!/^[a-z][a-z0-9-]*$/.test(path[k])) return null;
    if (k === 0 && path[k] === 'run') continue;
    if (cmRe(cmC('gcloud_refused_path'), path[k])) return null;
  }
  if (i < rest.length && rest[i].charAt(0) !== '-') i++;
  while (i < rest.length) {
    var tok = rest[i];
    if (tok.indexOf('--') !== 0) return null;
    if (/^--[a-z][a-z0-9-]*=/.test(tok)) { if (tok.indexOf('--flags-file=') === 0) return null; i++; continue; }
    if (t.gcloudBool.has(tok)) { i++; continue; }
    if (sepValues && t.gcloudValue.has(tok) && i + 1 < rest.length && rest[i + 1].charAt(0) !== '-') { i += 2; continue; }
    return null;
  }
  return { path: path, verb: verb };
}

function cmGcloudReadOk(g) { return !(g.verb === 'read' && g.path[g.path.length - 1] !== cmC('gcloud_logging_group')); }
function cmStripStderrMerge(segment) { return segment.replace(/(^|[^\\])\s+2>&1\s*$/, '$1'); }

function cmCloudInspect(segment) {
  var t = cmTables(), tokens = cmTokQ(segment), bi = -1;
  for (var a = 0; a < tokens.length; a++) if (t.cloudBinaries.has(cmBase(tokens[a]).toLowerCase())) { bi = a; break; }
  if (bi < 0) return false;
  var bin = cmBase(tokens[bi]).toLowerCase(), rest = tokens.slice(bi + 1);
  if (bin === 'gcloud') {
    var stripped = cmStripStderrMerge(segment);
    if (cmHasRedirectChar(stripped)) return false;
    var st = cmTokQ(stripped), si = -1;
    for (var b = 0; b < st.length; b++) if (cmBase(st[b]).toLowerCase() === 'gcloud') { si = b; break; }
    if (si < 0) return false;
    var g = cmGcloudRead(st.slice(si + 1), false);
    return g !== null && cmGcloudReadOk(g);
  }
  var first = rest.length > 0 ? rest[0].toLowerCase() : '';
  if (!t.cloudReadonly.has(first)) return false;
  return rest.slice(1).every(function (w) { return w.charAt(0) === '-' || !t.cloudMutating.has(w.toLowerCase()); });
}

function cmClosedSinkTokens(t) {
  if (t.length === 0) return false;
  var first = t[0], rest = t.slice(1);
  if (first === 'head' || first === 'tail') {
    if (rest.length === 0) return true;
    if (rest.length === 1) return /^-(?:\d+|[nc]\+?\d+)$/.test(rest[0]);
    if (rest.length === 2) return (rest[0] === '-n' || rest[0] === '-c') && /^\+?\d+$/.test(rest[1]);
    return false;
  }
  if (first === 'wc') return rest.every(function (a) { return /^-[lcwm]$/.test(a); });
  if (first === 'grep') {
    var bounded = false, pattern = 0;
    for (var i = 0; i < rest.length; i++) {
      var a = rest[i];
      if (a === '-c') bounded = true;
      else if (a === '-m') { if (!(i + 1 < rest.length && /^\d+$/.test(rest[i + 1]))) return false; bounded = true; i++; }
      else if (/^-[EFGivwxnHhoa]+$/.test(a)) { /* a harmless flag */ }
      else if (a.charAt(0) === '-') return false;
      else pattern++;
    }
    return bounded && pattern === 1;
  }
  return false;
}

function cmClosedSinkStage(segment) {
  if (cmHasRedirectChar(segment) || cmHasExpansionAnywhere(segment)) return false;
  return cmClosedSinkTokens(cmTokQ(segment));
}

function cmStartsWithCli(cmd) {
  var lower = jx.asciiLower(cmd), clis = cmC('whole_command_clis');
  for (var i = 0; i < clis.length; i++) if (lower.indexOf(clis[i]) === 0 && lower.length > clis[i].length && cmIsWs(lower.charAt(clis[i].length))) return clis[i].length;
  return -1;
}

function cmWholeReadOnly(command) {
  var cmd = cmTrim(command);
  if (cmStartsWithCli(cmd) < 0) return false;
  if (/[\n\r]/.test(cmd) || cmHasExpansionAnywhere(cmd)) return false;
  var split = cmSplit(cmd), segs = split.segments, delims = split.delims;
  if (segs.length === 0 || delims[delims.length - 1] !== 'end') return false;
  for (var i = 0; i < delims.length - 1; i++) if (delims[i] !== '|') return false;
  var first = cmTrim(segs[0]), vq = first.replace(/\s+2>(?:&1|\/dev\/null)$/, ''), ok, c = cmStartsWithCli(vq);
  if (c >= 0 && /^\s+(?:--version|-V)$/i.test(vq.slice(c))) ok = !cmHasRedirectChar(vq);
  else {
    var stripped = cmStripStderrMerge(first);
    if (cmHasRedirectChar(stripped)) ok = false;
    else {
      var st = cmTokQ(stripped), g = st[0] === 'gcloud' ? cmGcloudRead(st.slice(1), true) : null;
      ok = g !== null && cmGcloudReadOk(g);
    }
  }
  return ok && segs.slice(1).every(function (s) { return cmClosedSinkStage(cmTrim(s)); });
}

function cmSafeNodeEval(payload) {
  var t = cmTables();
  if (payload === '' || cmC('node_eval_deny').some(function (src) { return cmRe(src, payload); })) return false;
  t.nodeFsCall.lastIndex = 0;
  var m;
  while ((m = t.nodeFsCall.exec(payload)) !== null) if (!t.nodeFsRead.has(m[1])) return false;
  return true;
}

function cmNodeEvalPayload(segment) {
  if (cmVerb(segment) !== 'node') return null;
  var tokens = cmTokQ(segment), t = cmTables();
  for (var i = 0; i < tokens.length; i++) if (t.nodeEvalFlags.has(tokens[i])) return i + 1 < tokens.length ? tokens[i + 1] : '';
  return null;
}

function cmReadOnlyGhGraphql(tokens, ghIdx) {
  var t = cmTables();
  if (!(ghIdx + 2 < tokens.length && /^\/?graphql$/i.test(tokens[ghIdx + 2]))) return false;
  var queries = 0, i = ghIdx + 3;
  while (i < tokens.length) {
    var tok = tokens[i];
    if (t.ghGqlBool.has(tok)) { i++; continue; }
    if (t.ghGqlValue.has(tok)) { if (i + 1 >= tokens.length) return false; i += 2; continue; }
    if (t.ghFieldFlags.has(tok)) {
      if (i + 1 >= tokens.length) return false;
      i++;
      var v = tokens[i], eq = v.indexOf('=');
      if (eq < 0) return false;
      if (v.slice(0, eq) !== 'query') { i++; continue; }
      var q = v.slice(eq + 1);
      if (/[$`]/.test(q) || q.charAt(0) === '@' || /\bmutation\b/i.test(q)) return false;
      var qt = cmTrim(q);
      if (qt !== '' && qt.charAt(0) !== '{' && !/^query[\s{(]/.test(qt)) return false;
      queries++;
      i++;
      continue;
    }
    return false;
  }
  return queries === 1;
}

function cmHeavyGh(segment, command) {
  var t = cmTables();
  if (cmVerb(segment) !== 'gh') return false;
  var tokens = cmTokQ(segment), gi = -1;
  for (var a = 0; a < tokens.length; a++) if (cmBase(tokens[a]).toLowerCase() === 'gh') { gi = a; break; }
  if (gi < 0) return false;
  var group = gi + 1 < tokens.length ? tokens[gi + 1].toLowerCase() : '', sub = gi + 2 < tokens.length ? tokens[gi + 2].toLowerCase() : '';
  if (Object.prototype.hasOwnProperty.call(t.ghMutating, group) && t.ghMutating[group].has(sub)) return true;
  if (group === 'api') {
    if (cmReadOnlyGhGraphql(tokens, gi) && command.indexOf('`') < 0) return false;
    for (var k = gi + 2; k < tokens.length; k++) if (/^\/?graphql$/i.test(tokens[k])) return true;
    for (var i = gi + 2; i < tokens.length; i++) {
      var x = tokens[i];
      if (t.ghFieldFlags.has(x) || /^-[fF]./.test(x) || /^--(field|raw-field|input)=/.test(x) || x === '--input') return true;
      if ((x === '-X' || x === '--method') && i + 1 < tokens.length && t.ghApiMethods.has(tokens[i + 1].toUpperCase())) return true;
    }
  }
  return false;
}

function cmFlaggedScript(segment) {
  var tokens = cmWords(segment);
  if (tokens.length < 3 || !cmRe(cmC('script_check_interpreter'), tokens[0]) || tokens[1].charAt(0) !== '-') return false;
  var ext = tokens[0] === 'node' ? cmC('node_script_ext') : cmC('python_script_ext');
  return tokens.slice(1).some(function (x) { return cmRe(ext, x); });
}

function cmHeavySegment(segment, command) {
  var t = cmTables(), first = cmFind(cmC('control_keyword_prefix'), segment);
  var seg = first === null ? segment : segment.slice(0, first[0]) + segment.slice(first[1]);
  var tm = cmFind(cmC('timeout_prefix'), seg), unwrapped = tm === null ? seg : seg.slice(0, tm[0]) + seg.slice(tm[1]);
  if (cmReAny('light_exceptions', seg) || cmReAny('light_exceptions', unwrapped)) return false;
  if (cmC('light_exceptions_neg').some(function (nl) { return cmNegLight(nl, seg) || cmNegLight(nl, unwrapped); })) return false;
  if (cmSafeGitFetch(seg) || cmSafeSqlite(seg, command) || cmCloudInspect(seg)) return false;
  var ev = cmNodeEvalPayload(seg);
  if (ev !== null) return !cmSafeNodeEval(ev);
  if (cmHeavyGit(seg) || cmHeavyGh(seg, command) || cmFlaggedScript(seg)) return true;
  var verb = cmVerb(seg);
  if (verb !== '' && t.heavyVerbs.has(verb)) return true;
  return cmReAny('heavy_patterns', cmBlankPattern(cmNeutral(seg), verb));
}

// One plain read-only git segment inside a chain (after a trailing `2>&1` is stripped).
function cmPlainReadGit(segment) {
  if (cmSafeGitFetch(segment)) return !cmHasRedirectChar(segment) && !cmHasExpansionAnywhere(segment);
  var m = cmFind(cmC('trailing_stderr_merge'), cmTrim(segment)), s = cmTrim(segment), trimmed = m === null ? s : s.slice(0, m[0]) + s.slice(m[1]);
  if (cmHasRedirectChar(trimmed) || cmHasSubstOutsideSingle(trimmed)) return false;
  return cmReAny('plain_read_git_segments', trimmed);
}

// The segments of a read-only chain (`git fetch && git rev-parse ... | head`) that are exempt: a Set of segment indices.
function cmReadOnlyUnits(split) {
  var out = new Set(), segments = split.segments, delims = split.delims;
  if (segments.length < 2 || !delims.some(function (x) { return x === '&&' || x === ';'; })) return new Set();
  var start = 0;
  for (var i = 0; i < segments.length; i++) {
    var last = i === segments.length - 1, cut = last || delims[i] === '&&' || delims[i] === ';';
    if (!cut) { if (delims[i] !== '|') return new Set(); continue; }
    var text = segments.slice(start, i + 1).map(cmTrim).join(' | ');
    if (cmWholeReadOnly(text)) { for (var k = start; k <= i; k++) out.add(k); }
    else if (!(start === i && cmPlainReadGit(cmTrim(segments[i])))) return new Set();
    start = i + 1;
  }
  return out;
}

function cmHeavyCommand(command, d) {
  if (cmTrim(command) === '') return false;
  if (d === 0 && cmWholeReadOnly(command)) return false;
  var max = cmTables().maxDepth, split = cmSplit(command), exempt = d === 0 ? cmReadOnlyUnits(split) : new Set();
  for (var si = 0; si < split.segments.length; si++) {
    if (exempt.has(si)) continue;
    var seg = split.segments[si];
    if (cmHeavySegment(seg, command)) return true;
    if (d < max) {
      var p = cmShellCPayload(seg);
      if (p !== '' && cmHeavyCommand(p, d + 1)) return true;
      var e = cmEvalPayload(seg);
      if (e !== '' && cmHeavyCommand(e, d + 1)) return true;
    }
  }
  return d < max && cmSubstitutions(command).some(function (inner) { return cmHeavyCommand(inner, d + 1); });
}

// ---- the special guards -------------------------------------------------------------------------------------------------------------------

// True when a segment the DevSwarm read/send guards scan has a DevSwarm CLI as its effective verb (segments, `sh -c` and `eval` payloads,
// command substitutions, three levels).
function cmDevswarmCli(cmd, d) {
  var t = cmTables();
  if (cmTrim(cmd) === '') return false;
  var segs = cmSegments(cmd);
  for (var i = 0; i < segs.length; i++) {
    if (t.devswarmVerbs.has(cmVerb(cmDequote(segs[i])))) return true;
    if (d < t.maxDepth) {
      var p = cmShellCPayload(segs[i]);
      if (p !== '' && cmDevswarmCli(p, d + 1)) return true;
      var e = cmEvalPayload(segs[i]);
      if (e !== '' && cmDevswarmCli(e, d + 1)) return true;
    }
  }
  return d < t.maxDepth && cmSubstitutions(cmd).some(function (s) { return cmDevswarmCli(s, d + 1); });
}

// True when `text` has one of the `defer_path_parts` as a component (splitting at more characters than a path separator only finds more).
function cmHasPathPart(text) {
  var parts = cmTables().deferPathParts;
  return text.toLowerCase().split(/[\/\;&|()<>`$='"\s]/).some(function (piece) { return parts.indexOf(piece) >= 0; });
}

// True when a DevSwarm or stash guard could act on this command.
function cmSpecialMayFire(cmd, cwd) {
  var t = cmTables(), norm = cmd.replace(/['"\\]/g, '').toLowerCase();
  if (t.deferSubstrings.some(function (w) { return norm.indexOf(w) >= 0; })) return true;
  return cmDevswarmCli(cmd, 0) || cmHasPathPart(cmd.replace(/['"]/g, '')) || cmHasPathPart(cwd === null ? '' : cwd);
}

// A character whose JavaScript lower-casing yields ASCII (Kelvin sign, dotted capital I) could spell a trigger word out of text that does
// not contain it.
function cmFoldsToAscii(s) { return /[\u212a\u0130]/.test(s); }

function cmUnicodeTrigger(cmd, cwd) {
  if (cmFoldsToAscii(cmd)) return true;
  var dropped = cmd.replace(/[^\x00-\x7f]/g, ''), blanked = cmd.replace(/[^\x00-\x7f]/g, ' ');
  return cmSpecialMayFire(dropped, cwd) || cmSpecialMayFire(blanked, cwd);
}

// The decision for one Bash command: 'allow' when Node allows it in every context, else 'defer'. `subagent`: the payload proves a subagent.
function cmDecide(cmd, cwd, subagent) {
  var t = cmTables();
  if (cmd.length > t.maxLen || cmd.length > cmC('script_max_len') || (cwd !== null && cmFoldsToAscii(cwd))) return 'defer';
  if (/[^\x00-\x7f]/.test(cmd)) return subagent && !cmUnicodeTrigger(cmd, cwd) ? 'allow' : 'defer';
  if (cmSpecialMayFire(cmd, cwd)) return 'defer';
  if (subagent) return 'allow';
  return cmMayWrite(cmd, 0) || cmHeavyCommand(cmd, 0) ? 'defer' : 'allow';
}

// A payload that proves a subagent (as the coordinator-work check reads them): one of the agent marker keys is set.
function cmSubagent(p) {
  var markers = ah.cfg('coordinator_work.agent_markers'), codex = ah.cfg('coordinator_work.codex_markers').every(function (k) { return typeof p[k] === 'string' && p[k] !== ''; });
  return codex ? markers.some(function (k) { return p[k] !== undefined && p[k] !== null; }) : markers.some(function (k) { return !!p[k]; });
}

function decide(p) {
  // Like the Node guard, this reads `tool_input.command` whatever the event and tool (the rule chooses those); a command that is not a
  // string is allowed, as Node treats it.
  var cmd = jx.isObj(p) && jx.isObj(p.tool_input) ? p.tool_input.command : undefined;
  if (typeof cmd !== 'string') return null;
  return cmDecide(cmd, typeof p.cwd === 'string' ? p.cwd : null, cmSubagent(p));
}

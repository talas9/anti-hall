// check = "git" (PreToolUse on Bash): the git guard. Blocks force pushes and remote ref deletion, AI self-credit in commit
// messages and in gh pr/issue/release bodies, session handovers in a commit, writes into the plugin launcher directory, and
// the same behind aliases, shell definitions, wrappers, runners (xargs, find -exec, parallel), eval and `sh -c`. Heredoc
// bodies whose consumer is not a shell are data and are masked before the shell scans. Mirrors hooks/git-guard.js and
// hooks/lib/git-alias-scan.js; every table, pattern, limit and text is in git.toml / limits.toml (git.*), the engine supplies
// only the file system, `git` process, settings and Jev primitives (`ah.*`).
//
// A script failure (an exception, a stack overflow on a pathological command, the time limit) defers to the Node hook.
// What the Node hook read from its own process (its working directory) is answered by lib/78-hook-proc.js; a file over one read is
// scanned at its head and tail; a Jev consult gets the time the request has left.
'use strict';

// ---------------------------------------------------------------------------------------------------------------------
// tables: built from the defaults when the defaults generation changes

var GT = null, GTGEN = -1;

function gitEsc(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

function gitBuildTables() {
  const c = (k) => ah.cfg('git.' + k);
  const set = (a) => new Set(a);
  const words = (s) => set(s.split(/\s+/).filter(Boolean));
  const t = {};
  t.wrappers = set(c('wrappers'));
  const wv = c('wrapper_value_opts');
  t.sudoVal = set(wv.sudo); t.timeoutVal = set(wv.timeout); t.niceVal = set(wv.nice);
  t.shellVerbs = set(c('shell_verbs'));
  t.optWrappers = new Map(Object.entries(c('opt_wrappers')).map(([k, v]) => [k, { s: v.s, v: v.v, l: v.l, L: v.big_l, ops: v.ops }]));
  t.xargsShortReq = c('xargs_short_req'); t.xargsShortOpt = c('xargs_short_opt');
  t.xargsLongReq = c('xargs_long_req'); t.xargsLongOther = c('xargs_long_other');
  t.findExec = set(c('find_exec_flags')); t.parallelSep = set(c('parallel_separators'));
  t.copyVerbs = set(c('copy_verbs')); t.gitBuiltins = set(c('git_builtins')); t.gitOptsWithValue = set(c('git_opts_with_value'));
  t.pushLongOpts = c('push_long_opts'); t.commitCreating = set(c('commit_creating'));
  t.commitLong = c('commit_long'); t.commitLongValue = set(c('commit_long_value'));
  t.commitValueOpts = set(c('add_commit_value_opts')); t.commitClusterValueFlags = c('commit_cluster_value_flags');
  t.backstopCommitSubs = set(c('backstop_commit_subs'));
  t.noopEditors = c('noop_editors');
  t.ghSubs = c('gh_subs'); t.ghActions = c('gh_actions');
  t.ghValueOpts = set(c('gh_value_opts')); t.ghValuePrefixes = c('gh_value_prefixes');
  t.ghFileOpts = set(c('gh_file_opts')); t.ghFilePrefixes = c('gh_file_prefixes');
  t.heredocSafeVerbs = set(c('heredoc_safe_verbs')); t.heredocGitMsgSubs = set(c('heredoc_git_msg_subs'));
  t.hdNotesSubs = set(c('hd_notes_subs')); t.hdGhSubs = set(c('hd_gh_subs')); t.hdGhActions = set(c('hd_gh_actions'));
  t.hdDenyFirst = set(c('hd_deny_first'));
  t.hdSedRange = new RegExp(c('hd_sed_range')); t.hdSedScript = new RegExp(c('hd_sed_script'));
  t.hdSedOperand = new RegExp(c('hd_sed_operand')); t.hdAssign = new RegExp(c('hd_assign'));
  t.hdVarDeny = set(c('hd_var_deny')); t.hdVarDenyPrefix = c('hd_var_deny_prefix');
  t.hdBadDirs = set(c('hd_bad_dirs')); t.gitHookNames = set(c('git_hook_names')); t.hdDataExt = set(c('hd_data_ext'));
  t.hdSinks = set(c('hd_sinks_basic').concat(c('hd_sinks_fd')));
  const read = [c('hd_read_long').join(' '), c('hd_read_val').join(' '), c('hd_read_opt').join(' ')];
  const spec = (o) => {
    let l = o.l || '', L = o.big_l || '', O = o.big_o || '';
    if (o.read) { l = read[0] + ' ' + l; L = read[1] + ' ' + L; O = read[2] + ' ' + O; }
    if (o.l_extra) l = l + ' ' + o.l_extra;
    return { s: o.s || '', v: o.v || '', o: o.o || '', l: words(l), L: words(L), O: words(O), num: !!o.num, strict: !!o.strict };
  };
  t.hdSpecs = new Map(Object.entries(c('hd_specs')).map(([k, v]) => [k, spec(v)]));
  t.hdGhSpec = spec(c('hd_gh_spec'));
  t.launcherDirRe = new RegExp(c('launcher_dir_pattern').replace(/^\(\?i\)/, ''), 'i');
  t.coauthor = new RegExp('^[ \\t]*' + gitEsc(c('self_credit_coauthor_key')) + '[ \\t]*[:=][^\\n]*(' +
    c('credit_coauthor_alts').map(gitEsc).concat([gitEsc(c('credit_gpt').prefix) + '[' + c('credit_gpt').versions + '][^a-z0-9]',
      gitEsc(c('credit_gpt').prefix) + '[' + c('credit_gpt').versions + ']$']).join('|') + ')', 'im');
  t.generated = new RegExp('^[ \\t]*[^A-Za-z0-9 \\t]{0,2}[ \\t]*' + gitEsc(c('self_credit_generated_prefix')) + '\\[?(' +
    c('credit_generated_alts').map(gitEsc).join('|') + ')\\b', 'im');
  t.ghBody = new RegExp(c('gh_body_markers').map(gitEsc).join('|'), 'i');
  t.trailerKeys = c('self_credit_trailer_keys');
  t.forwardEnvRe = new RegExp('^(?:GIT_CONFIG_(?:' + c('forward_config_names').concat(c('forward_config_indexed').map((p) => gitEsc(p) + '\\d+')).join('|') + ')|' +
    c('forward_env_names').map(gitEsc).join('|') + ')$');
  t.fileWriteHeredoc = c('re_file_write_heredoc'); t.fileWriteRedirect = c('re_file_write_redirect');
  t.fileWriteTee = c('re_file_write_tee'); t.fileWriteEcho = c('re_file_write_echo');
  t.maxRecursion = c('max_recursion'); t.aliasDepth = c('alias_depth'); t.launcherHops = c('launcher_hops');
  t.cdMaxChars = c('cd_max_chars'); t.cdMaxSegments = c('cd_max_segments'); t.maxChain = c('max_chain');
  t.pathArgMaxChars = c('path_arg_max_chars'); t.shown = c('shown_hits'); t.handoverAddsMax = c('handover_adds_max');
  t.commitHashLen = c('commit_hash_len'); t.commitHashShort = c('commit_hash_short');
  return t;
}

function gitTables() {
  const g = ahHost.cfgGen();
  if (GT === null || g !== GTGEN) { GT = gitBuildTables(); GTGEN = g; }
  return GT;
}

// ---------------------------------------------------------------------------------------------------------------------
// per-call state (one decide() = one hook invocation)

var S = null;
var TB = null;

function gitFreshState(raw, cwd, session) {
  return {
    raw: raw, procCwd: cwd, session: session, home: '', overflow: false, repls: [],
    launcherFsBudget: ah.cfg('git.budget_launcher_fs'), launcherCmdText: '',
    handoverQueryBudget: ah.cfg('git.budget_handover_queries'), handoverSkipped: 0, handoverEvalBudget: ah.cfg('git.budget_handover_evals'),
    handoverQueryCache: new Map(), handoverAdds: [], handoverOn: null,
    creditCache: new Map(), jevMemo: new Map(), jevSpentMs: 0,
    quotedLiteralsCache: null, stdinCandidateCache: null, hdOn: null, aliasOn: null, reuseOn: null,
    gitCache: new Map(), aliasCache: new Map(), shellDefsCache: new Map(), depthGuard: 0,
  };
}

function gitSettingOn(key) { return ah.settings.bool(key); }

// gm(opts) -> the block text in the shared layout (hooks/lib/block-message.js, guard git-guard).
function gitClean(s) { return String(s).split(/\s+/).filter(Boolean).join(' '); }
function gm(o) {
  const lines = [ah.cfg('git.block_emoji') + ah.cfg('git.block_mark') + gitClean(o.what)];
  if (o.why) lines.push(ah.cfg('git.label_why') + gitClean(o.why));
  if (o.instead) lines.push(ah.cfg('git.label_instead') + gitClean(o.instead));
  if (o.allowed) lines.push(ah.cfg('git.label_allowed') + gitClean(o.allowed));
  if (o.override) lines.push(ah.cfg('git.label_override') + gitClean(o.override));
  return lines.join('\n');
}
// a configured message table ({what, why, instead, override}) rendered with {name} arguments
function gmKey(key, args) {
  const m = ah.cfg('git.' + key), r = (s) => (s === undefined ? '' : text.render(s, args || {}));
  return gm({ what: r(m.what), why: r(m.why), instead: r(m.instead), override: r(m.override) });
}
function skipCmd(k) {
  const script = ah.cfg('git.skip_script');
  return text.render(ah.cfg('git.skip_command'), { script: (S.pluginRoot + '/' + script).split("'").join("'\\''"), key: k });
}

// ---------------------------------------------------------------------------------------------------------------------
// tokenizer, segments, effective verb

const CMDSUBST_SENTINEL = '\x00CMDSUBST\x00';

function tokenize(segment) {
  const tokens = [];
  let cur = '', curHasUnquoted = false, started = false, tokStart = -1, i = 0;
  const n = segment.length;
  const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
  function pushToken() {
    if (started) tokens.push({ text: cur, quotedOnly: !curHasUnquoted, raw: segment.slice(tokStart, i) });
    cur = ''; curHasUnquoted = false; started = false; tokStart = -1;
  }
  while (i < n) {
    const c = segment[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { pushToken(); i++; continue; }
    if (c === '#' && !started) break; // the rest of the segment is a comment
    if (tokStart < 0) tokStart = i;
    if (c === '$' && segment[i + 1] === "'") { // ANSI-C quoting: backslash escapes are decoded inside it
      started = true;
      i += 2;
      while (i < n && segment[i] !== "'") {
        if (segment[i] === '\\' && i + 1 < n) {
          const nx = segment[i + 1];
          cur += Object.prototype.hasOwnProperty.call(ESC, nx) ? ESC[nx] : nx;
          i += 2;
        } else { cur += segment[i]; i++; }
      }
      i++;
      continue;
    }
    if (c === "'") {
      started = true; i++;
      while (i < n && segment[i] !== "'") { cur += segment[i]; i++; }
      i++;
      continue;
    }
    if (c === '"') {
      started = true; i++;
      while (i < n && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < n) {
          const nx = segment[i + 1];
          // inside double quotes a backslash escapes only $ ` " \ and newline; before anything else it is literal
          if (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n') cur += nx; else cur += '\\' + nx;
          i += 2;
        } else { cur += segment[i]; i++; }
      }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) { started = true; curHasUnquoted = true; cur += segment[i + 1]; i += 2; continue; }
    started = true; curHasUnquoted = true; cur += c; i++;
  }
  pushToken();
  return tokens;
}

// true when the `{`/`}` at the current scan position is the reserved word (see hooks/git-guard.js isBraceGroupWord)
function isBraceGroupWord(cur, c, c2) {
  if (c2 !== '' && !/\s/.test(c2)) return c === '}' && cur.trim() === '' && /[;&|<>)]/.test(c2);
  return c === '}' ? cur.trim() === '' : (cur === '' || /\s$/.test(cur));
}

function splitSegments(cmd) {
  const segments = [];
  let cur = '', i = 0, inSingle = false, inDouble = false;
  const n = cmd.length;
  function flush() { if (cur.trim().length) segments.push(cur); cur = ''; }
  function flushWithSubst() { cur += ' ' + CMDSUBST_SENTINEL + ' '; flush(); }
  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';
    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      if ((c === '$' && c2 === '(') || c === '`') { cur += ' ' + CMDSUBST_SENTINEL + ' '; i += (c === '$') ? 2 : 1; continue; }
      cur += c;
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }
    // backslash-newline line continuation outside quotes: one logical command
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) { cur += ' '; i += (c2 === '\r') ? 3 : 2; continue; }
    // a backslash outside quotes makes the NEXT character literal: never an operator boundary
    if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') {
      const prev = cur.length ? cur[cur.length - 1] : '';
      let precedingBackslashes = 0;
      if (prev === '>') for (let k = cur.length - 2; k >= 0 && cur[k] === '\\'; k--) precedingBackslashes++;
      if (prev === '>' && precedingBackslashes % 2 === 0) { cur += c; i++; continue; } // `>|` clobber redirect
      flush(); i++; continue;
    }
    if (c === ';') { flush(); i++; continue; }
    if (c === '&' && c2 === '>') { cur += c; i++; continue; } // `&>` redirect-both
    if (c === '&') {
      const prev = cur.length ? cur[cur.length - 1] : '';
      let precedingBackslashes = 0;
      if (prev === '>' || prev === '<') for (let k = cur.length - 2; k >= 0 && cur[k] === '\\'; k--) precedingBackslashes++;
      if ((prev === '>' || prev === '<') && precedingBackslashes % 2 === 0) { cur += c; i++; continue; } // `2>&1`, `>&2`
      flush(); i++; continue;
    }
    if (c === '\n') { flush(); i++; continue; }
    if (c === ')') { flush(); i++; continue; }
    if ((c === '{' || c === '}') && isBraceGroupWord(cur, c, c2)) { flush(); i++; continue; }
    if (c === '(') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flushWithSubst(); i += 2; continue; }
    if (c === '`') { flushWithSubst(); i++; continue; }
    cur += c;
    i++;
  }
  flush();
  return segments;
}

function skipOptWrapper(tokens, idx, g) {
  while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-') && tokens[idx].text !== '-') {
    const w = tokens[idx++].text;
    if (w === '--') break;
    if (w.startsWith('--')) {
      if (w.indexOf('=') < 0 && g.L.includes(w.slice(2))) idx++;
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      if (g.v.includes(w[k])) { if (k === w.length - 1) idx++; break; }
    }
  }
  return idx + g.ops;
}

// the command token flock hands to `sh -c`, or null
function flockCommand(tokens, i) {
  const g = TB.optWrappers.get('flock');
  const isCmd = (n) => n.length >= 3 && 'command'.startsWith(n);
  const attached = (text) => ({ text: text, quotedOnly: false });
  let afterFile = false;
  for (; i < tokens.length; i++) {
    const w = tokens[i].text;
    if (afterFile) {
      if (w === '-c') return tokens[i + 1] || null;
      const m = /^--([^=]*)(=([\s\S]*))?$/.exec(w);
      if (m && isCmd(m[1])) return m[2] ? attached(m[3]) : (tokens[i + 1] || null);
      return null;
    }
    if (w === '--') { i++; afterFile = true; continue; }
    if (!w.startsWith('-') || w === '-') { afterFile = true; continue; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (isCmd(name)) return eq < 0 ? (tokens[i + 1] || null) : attached(w.slice(eq + 1));
      if (eq < 0 && g.L.includes(name)) i++;
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      if (w[k] === 'c') return k < w.length - 1 ? attached(w.slice(k + 1)) : (tokens[i + 1] || null);
      if (g.v.includes(w[k])) { if (k === w.length - 1) i++; break; }
    }
  }
  return null;
}

function effectiveVerb(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) { idx++; continue; }
    break;
  }
  while (idx < tokens.length) {
    const t = tokens[idx];
    const word = t.text;
    if (!t.quotedOnly && TB.optWrappers.has(word)) {
      const fc = word === 'flock' ? flockCommand(tokens, idx + 1) : null;
      if (fc) return { verb: 'sh', args: [{ text: '-c', quotedOnly: false }, fc] };
      idx = skipOptWrapper(tokens, idx + 1, TB.optWrappers.get(word));
      continue;
    }
    if (!t.quotedOnly && TB.wrappers.has(word)) {
      idx++;
      if (word === 'sudo') {
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          if (f === '--') break;
          if (TB.sudoVal.has(f) && idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
      } else if (word === 'env') {
        while (idx < tokens.length) {
          const e = tokens[idx];
          if (!e.quotedOnly && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e.text) || e.text.startsWith('-'))) { idx++; continue; }
          break;
        }
      } else if (word === 'timeout') {
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          if (TB.timeoutVal.has(f) && idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
        if (idx < tokens.length && !tokens[idx].quotedOnly) idx++; // the DURATION operand
      } else if (word === 'time' || word === 'command') {
        if (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text === '-p') idx++;
      } else if (word === 'nice') {
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          if (TB.niceVal.has(f) && idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;
  const verbTok = tokens[idx];
  if (verbTok.quotedOnly) return null; // a fully-quoted token is data, not a verb
  return { verb: shellScan.basename(verbTok.text), args: tokens.slice(idx + 1) };
}

// ---------------------------------------------------------------------------------------------------------------------
// git subcommand, force push, ref deletion

function gitSubcommand(args) {
  let i = 0;
  const aliasMap = new Map(), aliasBodyTokens = new Map();
  for (let j = 0; j < args.length; j++) {
    const a = args[j].text;
    let cfgVal = null;
    if (a === '--config-env') cfgVal = j + 1 < args.length ? args[j + 1].text : '';
    else if (a.startsWith('--config-env=')) cfgVal = a.slice('--config-env='.length);
    // an alias whose value comes from an environment variable is a smuggling form: a synthetic force push
    if (cfgVal !== null && /^alias\./i.test(cfgVal)) return { sub: 'push', rest: [{ text: '--force', quotedOnly: false }] };
  }
  for (let j = 0; j + 1 < args.length; j++) {
    if (args[j].text === '-c') {
      const cfg = args[j + 1] ? args[j + 1].text : '';
      const m = /^alias\.([^=]+)=(.*)$/s.exec(cfg);
      if (m) {
        const name = m[1];
        const val = m[2].trim();
        const firstWord = val.startsWith('!') ? '!' : (val.split(/\s+/)[0] || '');
        if (name) {
          aliasMap.set(name, firstWord);
          let parts = val.split(/[\s;&|()"'{}`]+/).slice(1).filter(Boolean);
          if (firstWord === '!') parts = parts.filter((p) => p !== '--');
          aliasBodyTokens.set(name, parts.map((p) => ({ text: p, quotedOnly: false })));
        }
      }
    }
  }
  while (i < args.length) {
    const t = args[i];
    const w = t.text;
    if (TB.gitOptsWithValue.has(w)) { i += 2; continue; }
    if (w.startsWith('-')) { i += 1; continue; }
    const rest = args.slice(i + 1);
    if (aliasMap.has(w)) {
      const expanded = aliasMap.get(w);
      if (expanded === 'push' || expanded === '!') {
        const body = aliasBodyTokens.get(w) || [];
        return { sub: 'push', rest: body.concat(rest) };
      }
      return { sub: expanded || w, rest: rest };
    }
    return { sub: w, rest: rest };
  }
  return { sub: null, rest: [] };
}

// every `--xxx[=value]` before `--` becomes the option(s) it can denote (an ambiguous prefix means every candidate)
function expandPushOptions(rest) {
  const out = [];
  let endOfOptions = false;
  const longs = TB.pushLongOpts;
  for (const t of rest) {
    const w = t.text;
    if (endOfOptions || !w.startsWith('--') || w.startsWith('--no-')) {
      if (w === '--') endOfOptions = true;
      out.push(t);
      continue;
    }
    const eq = w.indexOf('=');
    const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
    const val = eq === -1 ? '' : w.slice(eq);
    if (!name || longs.indexOf(name) !== -1) { out.push(t); continue; }
    const cands = longs.filter((o) => o.startsWith(name));
    if (cands.length === 0) { out.push(t); continue; }
    for (const c of cands) out.push(Object.assign({}, t, { text: '--' + c + val }));
  }
  return out;
}

function isForcePush(rest) {
  rest = expandPushOptions(rest);
  let endOfOptions = false;
  for (const t of rest) {
    const w = t.text;
    if (!endOfOptions && w === '--') { endOfOptions = true; continue; }
    if (endOfOptions) { if (w.startsWith('+') && w.length > 1) return true; continue; }
    if (w === '--force' || w === '--force-with-lease') return true;
    if (w.startsWith('--force-with-lease=')) return true;
    if (w === '--mirror') return true;
    if (/^-[a-zA-Z0-9]+$/.test(w) && w.indexOf('f') !== -1) return true;
    if (w.startsWith('+') && w.length > 1) return true;
  }
  return false;
}

function isDeleteRefPush(rest) {
  rest = expandPushOptions(rest);
  let endOfOptions = false;
  for (const t of rest) {
    const w = t.text;
    if (!endOfOptions && w === '--') { endOfOptions = true; continue; }
    if (!endOfOptions) {
      if (w === '--delete' || w === '--prune') return true;
      if (/^-[a-zA-Z0-9]+$/.test(w) && w.indexOf('d') !== -1) return true;
    }
    if (w.length > 1 && w.startsWith(':')) return true;
  }
  return false;
}

function hasCmdSubstArg(rest) {
  for (const t of rest) if (t.text.indexOf(CMDSUBST_SENTINEL) !== -1) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// self-credit

function creditRegexes(t) { return TB.coauthor.test(t) || TB.generated.test(t); }

function normEscapes(s) { return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t'); }

function hasSelfCredit(text) {
  if (!text) return false;
  const cached = S.creditCache.get(text);
  if (cached !== undefined) return cached;
  let result = false;
  for (const t of [text, normEscapes(text)]) if (creditRegexes(t)) { result = true; break; }
  S.creditCache.set(text, result);
  return result;
}

// Which COMMAND of the chain carries the whole-command self-credit text, or null (see hooks/git-guard.js creditElsewhereLabel).
function creditElsewhereLabel(ownVerb) {
  try {
    let label = null;
    for (const seg of splitSegments(S.raw)) {
      if (!hasSelfCredit(seg)) continue;
      const ev = effectiveVerb(tokenize(seg));
      if (!ev || (ev.verb !== 'git' && ev.verb !== 'gh')) return null;
      if (ev.verb === ownVerb) return null;
      if (label !== null) continue;
      const words = ev.verb === 'git' ? [gitSubcommand(ev.args).sub]
        : ev.args.map((t) => t.text).filter((w) => !w.startsWith('-')).slice(0, ah.cfg('git.credit_label_gh_words'));
      label = [ev.verb].concat(words.filter((w) => typeof w === 'string' && /^[a-z][a-z-]*$/.test(w))).join(' ');
    }
    return label;
  } catch (e) {
    if (gitFatal(e)) throw e;
    return null;
  }
}

function hasSelfCreditTrailerKeyRemap(args) {
  const keys = new Set(TB.trailerKeys);
  const is = (v) => keys.has(v.trim().toLowerCase());
  for (let j = 0; j < args.length; j++) {
    if (args[j].text !== '-c') continue;
    const cfg = j + 1 < args.length ? args[j + 1].text : '';
    const mEq = /^trailer\.[^=]*\.key=(.*)$/is.exec(cfg);
    if (mEq) { if (is(mEq[1])) return true; continue; }
    if (/^trailer\.[^=]*\.key$/i.test(cfg)) {
      const val = j + 2 < args.length ? args[j + 2].text : '';
      if (is(val)) return true;
    }
  }
  return false;
}

function inlineCommitMessages(rest) {
  const msgs = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].text;
    if (w === '--message') {
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--message=')) {
      msgs.push(w.slice('--message='.length));
    } else if (/^-[A-Za-z]*m$/.test(w)) {
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (/^-[A-Za-z]*m./.test(w)) {
      msgs.push(w.slice(w.indexOf('m', 1) + 1));
    } else if (w === '--trailer') {
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--trailer=')) {
      msgs.push(w.slice('--trailer='.length));
    }
  }
  return msgs;
}

function fileCommitMessages(rest) {
  const specs = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].text;
    if (w === '--file') {
      if (i + 1 < rest.length) { specs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--file=')) {
      specs.push(w.slice('--file='.length));
    } else if (/^-[A-Za-z]*F$/.test(w)) {
      if (i + 1 < rest.length) { specs.push(rest[i + 1].text); i++; }
    } else if (/^-[A-Za-z]*F./.test(w)) {
      specs.push(w.slice(w.indexOf('F', 1) + 1));
    }
  }
  return specs;
}

// ---- the Jev add-block consult (can only ADD a block; a memo, a cap and a total budget bound it) ----

function consultJev(text) {
  const key = String(text);
  // a Jev integration that is off never waits: the lane answers at once and logs its `off` row, as Node's consult does
  if (S.jevMemo.has(key)) return S.jevMemo.get(key);
  if (S.jevMemo.size >= ah.cfg('git.jev_consult_cap')) return false;
  const budget = ah.cfg('git.jev_budget_ms');
  if (S.jevSpentMs + budget + ah.cfg('git.jev_backstop_ms') > ah.cfg('git.jev_total_budget_ms')) return false;
  // inside a request whose client stops waiting before this consult could finish: the whole verdict goes to Node, whose hook
  // consults Jev with its full budget
  // inside a request whose client stops waiting before the full consult could finish: the consult gets what is left (an 'on'
  // answer that does not arrive adds no block, as a timed-out Node consult adds none); too little left to ask at all is logged
  const left = ah.jev.deadlineLeftMs();
  let wait = budget;
  if (left !== null && left < budget + ah.cfg('git.jev_backstop_ms')) {
    wait = left - ah.cfg('git.jev_backstop_ms');
    if (wait <= 0) { if (ah.jev.mode(ah.cfg('git.jev_id')) === 'on') ah.log('git_jev_no_time', String(left)); return false; }
  }
  let n = ah.cfg('git.jev_state_chars');
  // the window never ends in a lone high surrogate (Node's would; the question's state is one unit shorter, its answer unchanged)
  if (key.length > n && /[\ud800-\udbff]/.test(key.charAt(n - 1)) && /[\udc00-\udfff]/.test(key.charAt(n))) n--;
  const started = Date.now();
  let verdict = false;
  try {
    verdict = ah.jev.ask({
      id: ah.cfg('git.jev_id'),
      question: { type: 'noul', instructions: ah.cfg('git.jev_instructions'), criteria: [['true', ah.cfg('git.jev_true')], ['false', ah.cfg('git.jev_false')]] },
      state: key.slice(0, n), trust: 'add_block', baseline: false, budgetMs: wait,
      sessionId: S.session === null ? undefined : S.session, projectFrom: S.procCwd, sync: true,
    }) === true;
  } catch (e) { verdict = false; }
  S.jevMemo.set(key, verdict);
  S.jevSpentMs += Date.now() - started;
  return verdict;
}

// ---- gh pr/issue/release bodies ----

function readFileText(path) {
  const cap = ah.cfgNum('script.read_max_bytes');
  const size = ah.fs.size(path);
  if (size === null) return null;
  if (size <= cap) return ah.fs.readText(path, cap);
  // a file over one read: its head (cut at the last line end) and its tail (from a whole line) are scanned; the middle is not
  ah.log('git_file_over_read_cap', path);
  const head = ah.fs.readText(path, cap), tail = ah.fs.readTail(path, cap);
  if (head === null) return tail;
  const cut = head.lastIndexOf('\n');
  return (cut > 0 ? head.slice(0, cut) : head) + '\n' + (tail === null ? '' : tail);
}

function ghSelfCreditMessage(args) {
  const words = args.map((a) => a.text);
  const guardedSub = TB.ghSubs.some((w) => words.includes(w));
  const guardedAct = TB.ghActions.some((w) => words.includes(w));
  if (!guardedSub || !guardedAct) return null;
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (TB.ghValueOpts.has(w)) { if (i + 1 < args.length) { vals.push(args[i + 1].text); i++; } continue; }
    const pre = TB.ghValuePrefixes.find((p) => w.startsWith(p));
    if (pre !== undefined) { vals.push(w.slice(pre.length)); continue; }
    let fileSpec = null;
    if (TB.ghFileOpts.has(w)) { if (i + 1 < args.length) { fileSpec = args[i + 1].text; i++; } }
    else { const fp = TB.ghFilePrefixes.find((p) => w.startsWith(p)); if (fp !== undefined) fileSpec = w.slice(fp.length); }
    if (fileSpec && fileSpec !== '-') {
      const t = readFileText(S.abs(fileSpec));
      if (t !== null) vals.push(t);
    }
  }
  if (hasSelfCredit(S.raw)) vals.push(S.raw);
  for (const v of vals) {
    for (const t of [v, normEscapes(v)]) {
      if (TB.coauthor.test(t) || TB.generated.test(t) || TB.ghBody.test(t)) {
        const elsewhere = v === S.raw ? creditElsewhereLabel('gh') : null;
        if (elsewhere) return gmKey('msg_gh_credit_elsewhere', { elsewhere: elsewhere });
        return gmKey('msg_gh_credit');
      }
    }
  }
  for (const v of vals) if (v && consultJev(v)) return gmKey('msg_gh_jev');
  return null;
}

// ---- eval / shell -c / env -S payloads ----

function extractEvalPayload(segment) {
  const ev = effectiveVerb(tokenize(segment));
  if (!ev || ev.verb !== 'eval') return '';
  return ev.args.map((t) => t.text).filter((s) => s.length).join(' ');
}

function forwardPositional(script, pos) {
  if (!pos.length || script.indexOf('$') < 0) return script;
  const q = (w) => (/^[A-Za-z0-9_.\/:=@%+,{}-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\\''") + "'");
  const word = (t, quoted) => (quoted ? q(t.text) : t.text.split(/\s+/).filter(Boolean).map(q).join(' '));
  const val = (ref, quoted) => {
    if (ref === '@' || ref === '*') return pos.slice(1).map((t) => word(t, quoted)).join(' ');
    const n = Number(ref);
    return n < pos.length ? word(pos[n], quoted) : '';
  };
  return script.replace(/"\$(?:\{([0-9]+|[@*])\}|([0-9@*]))"|\$(?:\{([0-9]+|[@*])\}|([0-9@*]))/g,
    (m, a, b, c, e) => (a || b ? val(a || b, true) : val(c || e, false)));
}

function extractShellCPayload(segment) {
  const ev = effectiveVerb(tokenize(segment));
  if (!ev || !TB.shellVerbs.has(ev.verb.toLowerCase())) return '';
  const args = ev.args;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '-c' || t === '--command' || /^-[a-z]*c$/.test(t)) {
      if (i + 1 >= args.length) return '';
      return forwardPositional(args[i + 1].text, args.slice(i + 2));
    }
    if (t === '<<<') return i + 1 < args.length ? args[i + 1].text : '';
  }
  return '';
}

function extractEnvSPayload(segment) {
  const tokens = tokenize(segment);
  let idx = 0;
  while (idx < tokens.length && !tokens[idx].quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx].text)) idx++;
  if (idx >= tokens.length || tokens[idx].quotedOnly || tokens[idx].text !== 'env') return '';
  idx++;
  while (idx < tokens.length) {
    const t = tokens[idx];
    const w = t.quotedOnly ? '' : t.text;
    if (w === '-S' || w === '--split-string') return idx + 1 < tokens.length ? tokens[idx + 1].text : '';
    if (w.startsWith('--split-string=')) return w.slice('--split-string='.length);
    if (w && (w.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) { idx++; continue; }
    break;
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------------------
// runners: xargs, find -exec, parallel

function xargsCommandTokens(args) {
  let i = 0;
  const repls = [];
  const longReq = TB.xargsLongReq, longOther = TB.xargsLongOther;
  while (i < args.length) {
    const w = args[i].text;
    if (w === '--') { i++; break; }
    if (w === '-' || !w.startsWith('-')) break;
    i++;
    if (w.startsWith('--')) {
      if (w.startsWith('--replace')) repls.push(w.startsWith('--replace=') ? w.slice(10) : '{}');
      if (w.indexOf('=') >= 0) continue;
      const name = w.slice(2);
      if (longOther.includes(name) || longReq.includes(name)) {
        if (longReq.includes(name)) i++;
        continue;
      }
      if (longReq.some((o) => o.startsWith(name)) && !longOther.some((o) => o.startsWith(name))) i++;
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      const ch = w[k];
      if (TB.xargsShortOpt.includes(ch)) {
        if (ch === 'i') repls.push(w.slice(k + 1) || '{}');
        break;
      }
      if (TB.xargsShortReq.includes(ch)) {
        const val = k < w.length - 1 ? w.slice(k + 1) : (args[i] ? args[i].text : '');
        if (k === w.length - 1) i++;
        if ((ch === 'I' || ch === 'J') && val) repls.push(val);
        break;
      }
    }
  }
  return { tokens: args.slice(i), repls: repls };
}

function xargsGitVerdict(ev, d, cmd, heredocBodies, cwd, useJev) {
  const x = xargsCommandTokens(ev.args);
  return runnerVerdict(x.tokens, 'xargs', d, cmd, heredocBodies, cwd, useJev, x.repls);
}

function findExecVerdict(ev, d, cmd, heredocBodies, cwd, useJev) {
  const args = ev.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i].quotedOnly || !TB.findExec.has(args[i].text)) continue;
    let j = i + 1;
    while (j < args.length && args[j].text !== ';' && args[j].text !== '\;' &&
      !(args[j].text === '+' && j > i + 1 && args[j - 1].text === '{}')) j++;
    const hit = runnerVerdict(args.slice(i + 1, j), 'find', d, cmd, heredocBodies, cwd, useJev, ['{}']);
    if (hit) return hit;
    i = j;
  }
  return null;
}

function parallelVerdict(ev, d, cmd, heredocBodies, cwd, useJev) {
  const args = ev.args;
  const s = args.findIndex((t) => TB.parallelSep.has(t.text));
  const head = s < 0 ? args : args.slice(0, s);
  const inputs = s < 0 ? [] : args.slice(s).filter((t) => !TB.parallelSep.has(t.text));
  const repls = [/\{[^\s{}]*\}/, '{='];
  for (let k = 0; k < head.length; k++) {
    const w = head[k].text;
    if (w === '-I' && head[k + 1]) repls.push(head[k + 1].text);
    else if (w.length > 2 && w.startsWith('-I')) repls.push(w.slice(2));
    else if (w.startsWith('--replace=') && w.length > 10) repls.push(w.slice(10));
  }
  let certain = false;
  for (let k = 0; k < head.length && !certain; k++) {
    if (head[k].text.startsWith('-')) continue;
    certain = k === 0 || !head[k - 1].text.startsWith('-');
    let hit = runnerVerdict(head.slice(k).concat(inputs), 'parallel', d, cmd, heredocBodies, cwd, useJev, repls);
    for (const seg of hit ? [] : splitSegments(head.slice(k).map((t) => t.text).join(' '))) {
      hit = runnerVerdict(tokenize(seg).concat(inputs), 'parallel', d, cmd, heredocBodies, cwd, useJev, repls);
      if (hit) break;
    }
    if (hit) return hit;
  }
  if (!certain && d < 3) {
    for (const t of inputs) {
      const hit = scanCommand(t.text, d + 1, cwd);
      if (hit) return hit;
    }
    if (!inputs.length && s < 0) return stdinScriptVerdict(cmd, d, cwd);
  }
  return null;
}

function hasRepl(w, repls) { return repls.some((r) => (typeof r === 'string' ? w.indexOf(r) >= 0 : r.test(w))); }

function placeholderVerdict(ev, repls) {
  if (!repls.length) return null;
  let unknown = hasRepl(ev.verb, repls);
  if (!unknown && ev.verb === 'git') {
    const { sub, rest } = gitSubcommand(ev.args);
    const n = ev.args.length - rest.length;
    const pre = n >= 0 && (!rest.length || rest[0] === ev.args[n]) ? ev.args.slice(0, n) : ev.args;
    unknown = (sub !== null && hasRepl(sub, repls)) || pre.some((t) => hasRepl(t.text, repls));
  }
  if (!unknown || !(isForcePush(ev.args) || isDeleteRefPush(ev.args))) return null;
  return gmKey('msg_runner_placeholder');
}

function forceishAnywhere(cmd) {
  const texts = String(cmd).split(/[\s'"`;|&()<>\\]+/);
  for (const seg of splitSegments(cmd)) for (const t of tokenize(seg)) texts.push(...t.text.split(/\s+/));
  const words = texts.filter(Boolean).map((text) => ({ text: text, quotedOnly: false }));
  return isForcePush(words) || isDeleteRefPush(words);
}

function dropRedirects(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (args[i].quotedOnly || !/^[0-9]*(?:[<>]|&>)/.test(w)) { out.push(args[i]); continue; }
    if (/^[0-9]*(?:<<?<?|>>?|&>>?|>&|<&|<>|>\|)-?$/.test(w)) i++;
  }
  return out;
}

function stdinScriptVerdict(cmd, d, cwd) {
  if (d >= 3) return null;
  const texts = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"/g;
  let m;
  while ((m = re.exec(cmd))) texts.push(m[1] !== undefined ? m[1] : m[2]);
  for (const seg of splitSegments(cmd)) {
    const ev = effectiveVerb(tokenize(seg));
    if (ev && (ev.verb === 'echo' || ev.verb === 'printf')) texts.push(ev.args.map((t) => t.text).join(' '));
  }
  for (const t of texts) {
    const hit = scanCommand(t.replace(/\\n/g, '\n'), d + 1, cwd);
    if (hit) return hit;
  }
  return null;
}

function shellScriptIsInput(shTokens, repls) {
  const ev = effectiveVerb(shTokens);
  if (!ev || !TB.shellVerbs.has(ev.verb.toLowerCase())) return false;
  let script = null;
  for (let i = 0; i < ev.args.length; i++) {
    const t = ev.args[i].text;
    if (t === '-c' || t === '--command' || /^-[a-z]*c$/.test(t)) { script = ev.args[i + 1] ? ev.args[i + 1].text : ''; break; }
    if (!t.startsWith('-') || t === '-') return t === '-';
  }
  if (script === null) return true;
  for (const r of repls) script = typeof r === 'string' ? script.split(r).join(' ') : script.replace(new RegExp(r.source, 'g'), ' ');
  return script.replace(/\$\{?[0-9@*]\}?|\b(?:eval|exec)\b|["'\s;]/g, '') === '';
}

function runnerVerdict(cmdTokens, runner, d, cmd, heredocBodies, cwd, useJev, repls) {
  const saved = S.repls;
  S.repls = repls && repls.length ? saved.concat(repls) : saved;
  try { return runnerVerdictIn(cmdTokens, runner, d, cmd, heredocBodies, cwd, useJev); } finally { S.repls = saved; }
}

function runnerVerdictIn(cmdTokens, runner, d, cmd, heredocBodies, cwd, useJev) {
  if (!cmdTokens.length) return null;
  const innerEv = effectiveVerb(cmdTokens);
  if (!innerEv) return null;
  const pv = placeholderVerdict(innerEv, S.repls);
  if (pv) return pv;
  const appends = runner === 'xargs' || runner === 'parallel';
  if (innerEv.verb === 'git') {
    const { sub } = gitSubcommand(innerEv.args);
    if (appends && gitSubcommand(dropRedirects(innerEv.args)).sub === null && forceishAnywhere(cmd)) return gmKey('msg_runner_no_subcommand', { runner: runner });
    if (sub === 'push' && appends) return gmKey('msg_runner_push', { runner: runner });
    if (sub === 'push' && innerEv.args.some((t) => t.text.indexOf('{}') >= 0)) return gmKey('msg_find_push');
    return gitVerdict(innerEv, d, cmd, heredocBodies, cwd, useJev);
  }
  if (innerEv.verb === 'xargs') return xargsGitVerdict(innerEv, d, cmd, heredocBodies, cwd, useJev);
  if (innerEv.verb === 'find') return findExecVerdict(innerEv, d, cmd, heredocBodies, cwd, useJev);
  if (innerEv.verb === 'parallel') return parallelVerdict(innerEv, d, cmd, heredocBodies, cwd, useJev);
  if (d < 3 && (innerEv.verb === 'eval' || TB.shellVerbs.has(innerEv.verb.toLowerCase()))) {
    if (shellScriptIsInput(cmdTokens, S.repls)) {
      const sv = stdinScriptVerdict(cmd, d, cwd);
      if (sv) return sv;
    }
    let text = cmdTokens.map((t) => (typeof t.raw === 'string' ? t.raw : t.text)).join(' ');
    if (appends) text += ' --force';
    return scanCommand(text, d + 1, cwd);
  }
  return null;
}

const PIPED_ECHO_SHELL_RE = /(?:^|[;&\n]|\()\s*(?:echo|printf)\s+(['"])((?:(?!\1)[\s\S])*)\1\s*\|\s*(?:bash|sh|zsh|dash|ksh|ash)\s*(?=$|[;&\n)])/g;

function pipedEchoShellPayloads(cmd) {
  const out = [];
  let m;
  PIPED_ECHO_SHELL_RE.lastIndex = 0;
  while ((m = PIPED_ECHO_SHELL_RE.exec(cmd))) out.push(m[2]);
  return out;
}

// every heredoc BODY appearing anywhere in the raw command string, as a standalone side-channel scan
function extractHeredocBodies(cmd) {
  const bodies = [];
  const n = cmd.length;
  let i = 0, inSingle = false, inDouble = false;
  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { i += 2; continue; }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '<' && c2 === '<') {
      const parsed = shellScan.parseHeredocAt(cmd, i);
      if (parsed) {
        bodies.push({ word: parsed.word, quoted: parsed.quoted, body: parsed.body });
        i = parsed.end;
        if (!parsed.terminated) break;
        continue;
      }
    }
    i++;
  }
  return bodies;
}

// ---------------------------------------------------------------------------------------------------------------------
// data heredocs (guards.gitGuardHeredocData): a heredoc whose consumer is not a shell is data and is masked for the shell scans

function hdSedOk(args) {
  if (args.length < 2 || args[0].text !== '-n' || !TB.hdSedScript.test(args[1].text)) return false;
  for (let k = 2; k < args.length; k++) {
    if (!TB.hdSedOperand.test(args[k].text) || args[k].text.indexOf('__AH') >= 0) return false;
  }
  return true;
}

function hdVarAllowed(name) {
  const up = name.toUpperCase();
  return !TB.hdVarDeny.has(up) && !TB.hdVarDenyPrefix.some((x) => up.startsWith(x));
}

function hdRecordAssignments(tokens, vars) {
  const found = [];
  for (const t of tokens) {
    const m = t.quotedOnly ? null : TB.hdAssign.exec(t.text);
    if (!m || !hdVarAllowed(m[1]) || m[2].indexOf('__AH') >= 0) return false;
    found.push(m);
  }
  for (const m of found) vars.set(m[1], m[2]);
  return found.length > 0;
}

function hdExpandVar(t, vars) {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(?=\/|$)/.exec(t);
  return m && vars.has(m[1]) ? vars.get(m[1]) + t.slice(m[0].length) : t;
}

function hdFlagWords(args, spec) {
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k].text;
    if (w === '--') { for (k++; k < args.length; k++) words.push(args[k].text); break; }
    if (!w.startsWith('-') || w === '-') { words.push(w); continue; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (spec.L.has(name)) { if (eq < 0) k++; continue; }
      if (eq < 0 && spec.l.has(name)) continue;
      if (spec.O.has(name)) continue;
      return null;
    }
    if (spec.num && /^-[0-9]+$/.test(w)) continue;
    if (spec.strict) {
      const ch = w[1];
      if (w.length === 2 && spec.s.includes(ch)) continue;
      if (w.length === 2 && spec.v.includes(ch)) {
        if (!args[k + 1] || !/^[0-9]+$/.test(args[k + 1].text)) return null;
        k++;
        continue;
      }
      if (spec.v.includes(ch) && /^-.[0-9]+$/.test(w)) continue;
      if (spec.o.includes(ch) && /^-.[0-9]*%?$/.test(w)) continue;
      return null;
    }
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (spec.v.includes(ch)) { if (c === w.length - 1) k++; break; }
      if (spec.o.includes(ch)) break;
      if (!spec.s.includes(ch)) return null;
    }
  }
  return words;
}

const HD_SAFE_PATH_WORD = /^[A-Za-z0-9_.\/~+@%:,=-]+$/;

function hdGitOk(args) {
  let k = 0;
  while (k < args.length) {
    const w = args[k].text;
    if (w === '--no-pager' || w === '-P') { k++; continue; }
    if (w === '-C') {
      const dir = args[k + 1] ? args[k + 1].text : '';
      if (!HD_SAFE_PATH_WORD.test(dir) || dir.indexOf('__AH') >= 0) return false;
      k += 2;
      continue;
    }
    break;
  }
  const sub = k < args.length ? args[k].text : '';
  const spec = TB.hdSpecs.get(sub);
  if (!spec) return false;
  const words = hdFlagWords(args.slice(k + 1), spec);
  if (!words) return false;
  if (sub === 'notes' && words.length && !TB.hdNotesSubs.has(words[0])) return false;
  return true;
}

function hdGhWords(args) {
  if (args.some((a) => a.text === '--')) return null;
  const words = hdFlagWords(args, TB.hdGhSpec);
  if (!words || words.length < 2) return null;
  if (!(TB.hdGhSubs.has(words[0])) || !TB.hdGhActions.has(words[1])) return null;
  return words;
}

function hdDeniedFirstWord(skel) {
  for (const piece of backstopPieces(skel)) {
    const w = piece.replace(/^[\s{}!"'(]+/, '').split(/[\s"']/, 1)[0];
    if (!w) continue;
    const text = typeof piece === 'string' ? piece : piece.text;
    if (TB.hdAssign.test(text.trim()) && hdVarAllowed(text.trim().split('=')[0])) continue;
    if (TB.hdSedRange.test(text.trim())) continue;
    if (/[\/$~`]/.test(w)) return true;
    const lw = w.toLowerCase();
    if (TB.hdDenyFirst.has(lw) || /^(?:python|pypy)[0-9.]*$/.test(lw)) return true;
  }
  return false;
}

function hdBadPath(p) {
  const segs = String(p).split(/[\/]+/).map((x) => x.toLowerCase());
  return segs.some((x, k) => TB.hdBadDirs.has(x) || (x === '.anti-hall' && segs[k + 1] === 'bin'));
}

function heredocDataEnabled() {
  if (S.hdOn === null) S.hdOn = gitSettingOn('git.setting_heredoc_data');
  return S.hdOn;
}

function hdSkipQuote(s, i) {
  if (s[i] === "'") { const j = s.indexOf("'", i + 1); return j < 0 ? -1 : j + 1; }
  let k = i + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '"') return k + 1;
    if (c === '$' && s[k + 1] === '(') { const e = hdSubstEnd(s, k + 2, ')'); if (e < 0) return -1; k = e + 1; continue; }
    if (c === '`') { const e = hdSubstEnd(s, k + 1, '`'); if (e < 0) return -1; k = e + 1; continue; }
    k++;
  }
  return -1;
}

function hdSubstEnd(s, i, closer) {
  let depth = 0, wordStart = true;
  while (i < s.length) {
    const c = s[i];
    if (c === closer && (closer === '`' || depth === 0)) return i;
    if (c === '\\') { i += 2; wordStart = false; continue; }
    if (c === "'" || c === '"') { const j = hdSkipQuote(s, i); if (j < 0) return -1; i = j; wordStart = false; continue; }
    if (c === '$' && s[i + 1] === '(') { const e = hdSubstEnd(s, i + 2, ')'); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '`' && closer !== '`') { const e = hdSubstEnd(s, i + 1, '`'); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '#' && wordStart) { const nl = s.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (closer === ')' && c === '(') depth++;
    else if (closer === ')' && c === ')') depth--;
    wordStart = /[\s;&|()]/.test(c);
    i++;
  }
  return -1;
}

function hdSkeleton(cmd) {
  const docs = [];
  let out = '', i = 0;
  const n = cmd.length;
  const stack = [];
  let pending = null, wordStart = true;
  while (i < n) {
    const c = cmd[i];
    const top = stack[stack.length - 1];
    if (c === '\n') {
      if (top === 'D') return null;
      out += c; i++; wordStart = true;
      if (pending) {
        if (pending.lineEnd !== i - 1) return null;
        docs.push(pending);
        i = pending.end;
        pending = null;
      }
      continue;
    }
    if (top === 'D') {
      if (c === '\\') { out += cmd.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { stack.pop(); out += c; i++; continue; }
      if (c === '$' && cmd[i + 1] === '(') { stack.push('C'); out += '$('; i += 2; wordStart = true; continue; }
      if (c === '`') { stack.push('B'); out += c; i++; wordStart = true; continue; }
      out += c; i++;
      continue;
    }
    if (c === '\\') { if (cmd[i + 1] === '\n') return null; out += cmd.slice(i, i + 2); i += 2; wordStart = false; continue; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0 || cmd.slice(i, j).indexOf('\n') >= 0) return null;
      out += cmd.slice(i, j + 1); i = j + 1; wordStart = false;
      continue;
    }
    if (c === '"') { stack.push('D'); out += c; i++; wordStart = false; continue; }
    if (c === '#' && wordStart) {
      const nl = cmd.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      if (cmd.slice(i, end).indexOf('<<') >= 0 && pending) return null;
      out += cmd.slice(i, end); i = end;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') { stack.push('C'); out += '$('; i += 2; wordStart = true; continue; }
    if (c === '`') {
      if (top === 'B') stack.pop(); else stack.push('B');
      out += c; i++; wordStart = true;
      continue;
    }
    if (c === '(') { stack.push('P'); out += c; i++; wordStart = true; continue; }
    if (c === ')') {
      if (top === 'C' || top === 'P') stack.pop(); else return null;
      out += c; i++; wordStart = true;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      if (pending) return null;
      const p = shellScan.parseHeredocAt(cmd, i);
      if (!p || !p.terminated || typeof p.lineEnd !== 'number') return null;
      const bodyStart = p.lineEnd + 1;
      const termLines = cmd.slice(bodyStart, p.end).split('\n');
      if (termLines[termLines.length - 1] === '') termLines.pop();
      termLines.pop();
      for (const ln of termLines) if (ln.replace(/^[ \t]+/, '').startsWith(p.word)) return null;
      if (!p.quoted && /\$\(|`|\$\[|\\\n/.test(p.body)) return null;
      const id = docs.length;
      pending = { id: id, word: p.word, quoted: p.quoted, lineEnd: p.lineEnd, end: p.end };
      out += ' __AHDOC' + id + '__ ';
      i = p.openerEnd;
      wordStart = false;
      continue;
    }
    wordStart = /[\s;&|<>]/.test(c);
    out += c;
    i++;
  }
  if (pending || stack.length) return null;
  return { skeleton: out, docs: docs };
}

function hdLevels(text, out, depth, ownId) {
  if (depth > 6) return false;
  let flat = '', i = 0;
  const inner = [];
  const lift = (start, end) => {
    const id = out.nextId++;
    inner.push({ text: text.slice(start, end), id: id });
    flat += ' __AHSUB' + id + '__ ';
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { flat += text.slice(i, i + 2); i += 2; continue; }
    if (c === "'") { const j = text.indexOf("'", i + 1); if (j < 0) return false; flat += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$' && text[i + 1] === '(') {
      const e = hdSubstEnd(text, i + 2, ')');
      if (e < 0) return false;
      lift(i + 2, e); i = e + 1;
      continue;
    }
    if (c === '`') {
      const e = hdSubstEnd(text, i + 1, '`');
      if (e < 0) return false;
      lift(i + 1, e); i = e + 1;
      continue;
    }
    if (c === '"') {
      flat += c; i++;
      while (i < text.length && text[i] !== '"') {
        const d = text[i];
        if (d === '\\') { flat += text.slice(i, i + 2); i += 2; continue; }
        if (d === '$' && text[i + 1] === '(') {
          const e = hdSubstEnd(text, i + 2, ')');
          if (e < 0) return false;
          lift(i + 2, e); i = e + 1;
          continue;
        }
        if (d === '`') {
          const e = hdSubstEnd(text, i + 1, '`');
          if (e < 0) return false;
          lift(i + 1, e); i = e + 1;
          continue;
        }
        flat += d; i++;
      }
      if (i >= text.length) return false;
      flat += '"'; i++;
      continue;
    }
    flat += c; i++;
  }
  out.levels.push({ text: flat, id: ownId });
  for (const t of inner) if (!hdLevels(t.text, out, depth + 1, t.id)) return false;
  return true;
}

function hdIsDataSink(t) {
  if (/^\/dev\/(?:null|stdout|stderr)$/.test(t)) return true;
  const base = t.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && TB.hdDataExt.has(base.slice(dot + 1).toLowerCase());
}

function expandTilde(p, home) {
  if (p === '~') return home || p;
  if (p.startsWith('~/')) return home ? home.replace(/[\\/]+$/, '') + '/' + p.slice(2) : p;
  return p;
}

function hdTargetOk(t, dirs) {
  if (!t) return false;
  t = t.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, '~');
  if (TB.hdSinks.has(t)) return true;
  if (!HD_SAFE_PATH_WORD.test(t) || t.indexOf('__AH') >= 0) return false;
  if (hdBadPath(t)) return false;
  const base = t.split('/').pop();
  if (!base || base.startsWith('.')) return false;
  if (TB.gitHookNames.has(base.replace(/\.[^.]*$/, '').toLowerCase()) || TB.gitHookNames.has(base.toLowerCase())) return false;
  const home = S.home;
  for (const dir of dirs) {
    const abs = posix.resolveIn(S.procCwd, [dir || S.procCwd, t.startsWith('~/') && home ? posix.join(home, t.slice(2)) : t]);
    const st = ah.fs.lstat(abs);
    if (st !== null) {
      if (st.kind === 'link' || st.kind === 'error') return false;
    }
    let real = posix.dirname(abs);
    const rp = ah.fs.realpathEx(real);
    if (rp.path !== undefined) real = rp.path; else if (rp.error !== 'NotFound') return false;
    if (hdBadPath(real) || hdBadPath(abs)) return false;
  }
  return true;
}

function hdWriteTargets(tokens, ev) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quotedOnly) continue;
    const m = /^([0-9]*|&)(>>?|>\|)(.*)$/s.exec(t.text);
    if (!m) { if (t.text.indexOf('>') >= 0) return null; continue; }
    let w = m[3];
    if (w.startsWith('&')) { if (/^&[0-9-]?$/.test(w)) continue; return null; }
    if (w.startsWith('(')) return null;
    if (!w) { w = tokens[i + 1] ? tokens[i + 1].text : ''; i++; }
    out.push({ t: w, stdout: m[1] === '' || m[1] === '1' || m[1] === '&' });
  }
  if (ev && ev.verb === 'tee') {
    for (let k = 0; k < ev.args.length; k++) {
      const a = ev.args[k].text;
      if (/^(?:[0-9]*|&)>/.test(a)) { if (/^(?:[0-9]*|&)>>?\|?$/.test(a)) k++; continue; }
      if (a.startsWith('-') || /^__AHDOC[0-9]+__$/.test(a)) continue;
      out.push({ t: a, stdout: true });
    }
  }
  return out.some((w) => w.t.indexOf('__AH') >= 0) ? null : out;
}

function hdMarkers(tokens, re) {
  const ids = [];
  for (const t of tokens) {
    let m;
    const g = new RegExp(re.source, 'g');
    while ((m = g.exec(t.text)) !== null) ids.push(Number(m[1]));
  }
  return ids;
}

function hdMessageTaker(ev) {
  if (ev.verb === 'git') return TB.heredocGitMsgSubs.has(gitSubcommand(ev.args).sub);
  if (ev.verb === 'gh') return !!hdGhWords(ev.args);
  return false;
}

function maskDataHeredocs(cmd, baseCwd) {
  try {
    if (typeof cmd !== 'string' || cmd.indexOf('<<') === -1) return cmd;
    if (/[\r\0]/.test(cmd)) return cmd;
    if (!heredocDataEnabled()) return cmd;
    const sk = hdSkeleton(cmd);
    if (!sk || !sk.docs.length) return cmd;
    const skel = sk.skeleton;
    if (/[<>]\(|\$\{|\$'|\\\n/.test(skel)) return cmd;
    if (hdDeniedFirstWord(skel)) return cmd;
    const lv = { levels: [], nextId: 0 };
    if (!hdLevels(skel, lv, 0, null)) return cmd;
    const dirs = [(typeof baseCwd === 'string' && baseCwd) ? baseCwd : S.procCwd];
    if (hdBadPath(dirs[0])) return cmd;
    const vars = new Map(), outerOf = new Map(), consumers = [], seenDocs = new Set();
    for (const lvl of lv.levels) {
      for (const seg of splitSegments(lvl.text)) {
        const tokens = tokenize(seg);
        if (!tokens.length) continue;
        if (!tokens[0].quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].text)) {
          if (lvl.id !== null || !hdRecordAssignments(tokens, vars)) return cmd;
          continue;
        }
        const ev = effectiveVerb(tokens);
        if (!ev || !TB.heredocSafeVerbs.has(ev.verb) || tokens[0].quotedOnly || tokens[0].text !== ev.verb) return cmd;
        if (ev.verb === 'sed' && !hdSedOk(ev.args)) return cmd;
        if (ev.verb === 'gh' && !hdGhWords(ev.args)) return cmd;
        if (ev.verb === 'git' && !hdGitOk(ev.args)) return cmd;
        if (ev.verb === 'cd' || ev.verb === 'pushd') {
          const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
          if (dirTok) {
            if (!HD_SAFE_PATH_WORD.test(dirTok.text) || dirTok.text.indexOf('__AH') >= 0) return cmd;
            const home = S.home;
            const next = posix.resolveIn(S.procCwd, [dirs[dirs.length - 1], dirTok.text.startsWith('~/') && home ? posix.join(home, dirTok.text.slice(2)) : dirTok.text]);
            if (hdBadPath(next)) return cmd;
            dirs.push(next);
          }
        }
        const targets = hdWriteTargets(tokens, ev);
        if (targets === null) return cmd;
        if (lvl.id === null) for (const w of targets) w.t = hdExpandVar(w.t, vars);
        for (const w of targets) if (!hdTargetOk(w.t, dirs)) return cmd;
        for (const id of hdMarkers(tokens, /__AHSUB(\d+)__/)) outerOf.set(id, ev);
        const docIds = hdMarkers(tokens, /__AHDOC(\d+)__/);
        if (docIds.length) {
          for (const id of docIds) seenDocs.add(id);
          consumers.push({ ev: ev, targets: targets, levelId: lvl.id });
        }
      }
    }
    for (const d of sk.docs) if (!seenDocs.has(d.id)) return cmd;
    for (const c of consumers) {
      if (c.ev.verb === 'git' || c.ev.verb === 'gh') {
        if (!hdMessageTaker(c.ev)) return cmd;
        continue;
      }
      const sinks = c.targets.filter((w) => w.stdout);
      if (sinks.length) {
        if (!sinks.every((w) => hdIsDataSink(w.t))) return cmd;
        continue;
      }
      const outer = c.levelId === null ? null : outerOf.get(c.levelId);
      if (!outer || !hdMessageTaker(outer)) return cmd;
    }
    let out = '', last = 0;
    for (const d of sk.docs) {
      out += cmd.slice(last, d.lineEnd + 1);
      last = d.end;
    }
    return out + cmd.slice(last);
  } catch (e) {
    if (gitFatal(e)) throw e;
    return cmd; // fail closed: scan the raw text
  }
}

function extractQuotedLiterals(cmd) {
  const out = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, i + 1);
      if (j < 0) break;
      out.push(cmd.slice(i + 1, j));
      i = j + 1;
    } else i++;
  }
  return out;
}

function extractQuotedLiteralsCached(cmd) {
  if (S.quotedLiteralsCache && S.quotedLiteralsCache.cmd === cmd) return S.quotedLiteralsCache.result;
  const result = extractQuotedLiterals(cmd);
  S.quotedLiteralsCache = { cmd: cmd, result: result };
  return result;
}

function stdinCandidateTextCached(cmd, heredocBodies) {
  const c = S.stdinCandidateCache;
  if (c && c.cmd === cmd && c.heredocBodies === heredocBodies) return c;
  const candidates = [];
  if (heredocBodies.length) candidates.push(...heredocBodies.map((h) => h.body));
  candidates.push(...extractQuotedLiteralsCached(cmd));
  const text = candidates.length ? candidates.join('\n') : null;
  const credit = text !== null && (TB.coauthor.test(text) || TB.generated.test(text));
  S.stdinCandidateCache = { cmd: cmd, heredocBodies: heredocBodies, text: text, hasSelfCredit: credit };
  return S.stdinCandidateCache;
}

// command-valued config/env: git runs some values as commands
function scanCommandValue(v, d) {
  if (d >= 3 || !/push/.test(v)) return null;
  const s = v.trim();
  const cands = [s];
  const kv = /^'?[A-Za-z_][\w.-]*=([\s\S]*?)'?$/.exec(s);
  if (kv) cands.push(kv[1].trim());
  for (const c of cands) {
    const cmd = c.replace(/^!/, '');
    const hit = scanCommand(cmd, d + 1) || scanCommand('git ' + cmd, d + 1);
    if (hit) return hit;
  }
  return null;
}

const CONFIG_LINE_RE = /^[ \t]*(?:\[[^\]\n]*\][ \t]*)?[A-Za-z][\w.-]*[ \t]*=[ \t]*(.+)$/gm;

function scanConfigLines(text, d) {
  for (const m of text.matchAll(CONFIG_LINE_RE)) {
    const hit = scanCommandValue(m[1], d);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// the launcher directory (~/.anti-hall/bin): any write into it is blocked, literally or through a link

function normalizeGuardPath(raw, cdDir) {
  if (typeof raw !== 'string' || !raw) return '';
  const home = S.home;
  let base = expandTilde(raw.replace(/\\/g, '/'), home);
  if (!base.startsWith('/') && cdDir) {
    const dir = expandTilde(String(cdDir).replace(/\\/g, '/'), home);
    base = dir.replace(/\/+$/, '') + '/' + base;
  }
  return posix.normalize(base);
}

function pathHasLauncherSegment(normalized) {
  if (!normalized) return false;
  const segs = normalized.split('/').filter(Boolean).map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length; i++) if (segs[i] === '.anti-hall' && segs[i + 1] === 'bin') return true;
  return false;
}

function isLauncherDirRoot(normalized) {
  if (!normalized) return false;
  const home = S.home;
  if (!home) return false;
  const want = posix.normalize(home.replace(/\\/g, '/').replace(/\/+$/, '') + '/.anti-hall');
  return normalized.replace(/\/+$/, '').toLowerCase() === want.replace(/\/+$/, '').toLowerCase();
}

function hasAntiHallBinSegment(p, cdDir) {
  if (!p) return false;
  return pathHasLauncherSegment(normalizeGuardPath(p, cdDir));
}

function linkTargetOf(p, linkText) {
  const target = linkText.replace(/\\/g, '/');
  return target.startsWith('/') ? posix.normalize(target) : posix.normalize(posix.dirname(p) + '/' + target);
}

function resolveDanglingLinkTarget(p, hops) {
  const n = typeof hops === 'number' ? hops : 0;
  if (n > TB.launcherHops) return null;
  const linkText = ah.fs.readlink(p);
  if (linkText === null) return null;
  const target = linkTargetOf(p, linkText);
  const st = ah.fs.lstat(target);
  if (st !== null && st.kind === 'link') return resolveDanglingLinkTarget(target, n + 1);
  return target;
}

function targetResolvesIntoLauncherDir(rawPath, cdDir, opts) {
  const normalized = normalizeGuardPath(rawPath, cdDir);
  if (!normalized || !normalized.startsWith('/')) return false;
  if (S.launcherFsBudget <= 0) return false;
  S.launcherFsBudget--;
  if (opts && opts.deleteOnly) {
    if (normalized.endsWith('/')) {
      const r = ah.fs.realpath(normalized);
      return r === null ? false : pathHasLauncherSegment(r);
    }
    const st = ah.fs.lstat(normalized);
    if (st !== null && st.kind !== 'error') {
      if (st.kind === 'link') {
        const linkText = ah.fs.readlink(normalized);
        if (linkText === null) return false;
        return pathHasLauncherSegment(linkTargetOf(normalized, linkText));
      }
      const r = ah.fs.realpath(normalized);
      if (r !== null) return pathHasLauncherSegment(r);
    }
    const parent = posix.dirname(normalized), base = posix.basename(normalized);
    const rp = ah.fs.realpath(parent);
    return rp === null ? false : pathHasLauncherSegment(rp.replace(/\/+$/, '') + '/' + base);
  }
  const r0 = ah.fs.realpath(normalized);
  if (r0 !== null) return pathHasLauncherSegment(r0);
  const st0 = ah.fs.lstat(normalized);
  if (st0 !== null && st0.kind === 'link') {
    const target = resolveDanglingLinkTarget(normalized, 0);
    return target === null ? true : pathHasLauncherSegment(target);
  }
  const segs = normalized.split('/').filter(Boolean);
  let existing = '', cur = '';
  for (let i = 0; i < segs.length - 1; i++) {
    cur += '/' + segs[i];
    const st = ah.fs.lstat(cur);
    if (st === null || st.kind === 'error') break;
    existing = cur;
    if (st.kind === 'link') {
      const real = ah.fs.realpath(cur);
      if (real === null) return true; // unresolvable symlink in the chain: fail closed
      if (pathHasLauncherSegment(real)) return true;
    }
  }
  if (!existing) return false;
  const resolvedExisting = ah.fs.realpath(existing);
  if (resolvedExisting === null) return false;
  if (resolvedExisting === existing) return false;
  return pathHasLauncherSegment(posix.normalize(resolvedExisting + normalized.slice(existing.length)));
}

function redirectWords(raw) {
  const out = [];
  const n = raw.length;
  for (let k = raw.indexOf('>'); k >= 0; k = raw.indexOf('>', k + 1)) {
    let i = k + 1;
    if (raw[i] === '>' || raw[i] === '|') i++;
    if (raw[i] === '&' || raw[i] === '(') continue;
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    let w = '';
    while (i < n) {
      const c = raw[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && raw[j] !== c) j += (c === '"' && raw[j] === '\\') ? 2 : 1;
        if (j >= n) { i = n; break; }
        w += raw.slice(i + 1, j);
        i = j + 1;
      } else if (/[\s;&|<>()]/.test(c)) {
        break;
      } else if (c === '\\' && i + 1 < n) {
        w += raw[i + 1];
        i += 2;
      } else { w += c; i++; }
    }
    if (w) out.push(w);
  }
  return out;
}

function globCouldHitLauncher(p, cdDir) {
  if (!/[?*[]/.test(p)) return false;
  const home = S.home;
  if (!home) return false;
  const norm = normalizeGuardPath(p.replace(/^\$\{HOME\}|^\$HOME(?![\w])/, home), cdDir);
  if (!norm.startsWith('/')) return false;
  const want = (home.replace(/\\/g, '/').replace(/\/+$/, '') + '/.anti-hall/bin').split('/').filter(Boolean);
  const segs = norm.split('/').filter(Boolean);
  if (segs.length <= want.length) return false;
  return want.every((w, i) => {
    let re = '';
    const g = segs[i];
    for (let k = 0; k < g.length; k++) {
      const c = g[k];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') {
        const end = g.indexOf(']', k + 2);
        if (end < 0) { re += '\\['; continue; }
        let cls = g.slice(k + 1, end).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        k = end;
      } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
    try { return new RegExp('^' + re + '$', 'i').test(w); } catch (e) { return true; }
  });
}

function varTargetHitsLauncher(p, cdDir, hops) {
  const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(.*)$/s.exec(p);
  if (!m || !S.launcherCmdText || (hops || 0) > 4) return false;
  const name = m[1] || m[2], suffix = m[3];
  const re = new RegExp('(?:^|[\\s;&|(])(?:(?:export|local|declare|typeset)[ \\t]+(?:-\\w+[ \\t]+)*)?' + name +
    '=("[^"\\n]*"|\'[^\'\\n]*\'|[^\\s;&|)]*)', 'g');
  let a;
  while ((a = re.exec(S.launcherCmdText)) !== null) {
    const value = a[1].replace(/^["']|["']$/g, '');
    const c2 = (value + suffix).replace(/^\$\{HOME\}|^\$HOME(?![\w])/, S.home || '$HOME');
    if (/^\$/.test(c2)) {
      if (varTargetHitsLauncher(c2, cdDir, (hops || 0) + 1)) return true;
      continue;
    }
    if (TB.launcherDirRe.test(c2) || hasAntiHallBinSegment(c2, cdDir) || globCouldHitLauncher(c2, cdDir)) return true;
  }
  return false;
}

function launcherTargetHit(p, cdDir, opts) {
  return TB.launcherDirRe.test(p) || hasAntiHallBinSegment(p, cdDir) || targetResolvesIntoLauncherDir(p, cdDir, opts) ||
    globCouldHitLauncher(p, cdDir) || varTargetHitsLauncher(p, cdDir);
}

function writesLauncherDir(tokens, ev, cdDir) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quotedOnly) continue;
    for (let k = t.text.indexOf('>'); k >= 0; k = t.text.indexOf('>', k + 1)) {
      let rest = t.text.slice(k + 1);
      const nl = rest.indexOf('\n');
      if (nl >= 0) rest = rest.slice(0, nl);
      let after = rest.replace(/^>/, '').replace(/^\|/, '');
      if (after.startsWith('&') || after.startsWith('(')) continue;
      const word = after.replace(/^\s+/, '').split(/\s/, 1)[0];
      if (word && (/^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)(?:\/[^`$(){}'"\\]*)?$/.test(word) || !/[`$(){}'"\\]/.test(word))) after = word;
      if (after) targets.push(after);
      else if (nl < 0) targets.push(tokens[i + 1] ? tokens[i + 1].text : '');
    }
    if (t.raw && t.raw.indexOf('>') >= 0) targets.push(...redirectWords(t.raw));
  }
  const ops = ev.args.map((a) => a.text);
  const operands = ops.filter((w) => !w.startsWith('-'));
  if (ev.verb === 'tee' || ev.verb === 'truncate') targets.push(...operands);
  if (TB.copyVerbs.has(ev.verb)) {
    if (operands.length) targets.push(operands[operands.length - 1]);
    ops.forEach((w, j) => {
      if (w === '-t' || w === '--target-directory') targets.push(ops[j + 1] || '');
      else if (w.startsWith('--target-directory=')) targets.push(w.slice(19));
    });
  }
  if (ev.verb === 'ln' && operands.length >= 2) targets.push(...operands.slice(0, -1));
  if (ev.verb === 'mv' && operands.length >= 2) targets.push(...operands.slice(0, -1));
  const hardlinkFlag = ev.verb === 'cp' && ops.some((w) => w === '--link' || (/^-[a-zA-Z]+$/.test(w) && w.includes('l')));
  if (hardlinkFlag && operands.length >= 2) targets.push(...operands.slice(0, -1));
  if (ev.verb === 'dd') ops.forEach((w) => { if (w.startsWith('of=')) targets.push(w.slice(3)); });
  if ((ev.verb === 'sed' || ev.verb === 'perl') && ops.some((w) => /^-(?:[a-zA-Z]*i|-in-place)/.test(w))) targets.push(...operands);
  if (ev.verb === 'rm' && operands.length) targets.push(...operands);

  const rootTargets = [];
  if (ev.verb === 'mv' && operands.length >= 2) rootTargets.push(...operands.slice(0, -1));
  if (ev.verb === 'ln' && operands.length >= 2) rootTargets.push(...operands.slice(0, -1));
  if (ev.verb === 'rm' && operands.length) rootTargets.push(...operands);

  if (TB.copyVerbs.has(ev.verb) && operands.length >= 2) {
    const destNorm = normalizeGuardPath(operands[operands.length - 1], cdDir);
    let destIsDir = false;
    if (destNorm && destNorm.startsWith('/')) destIsDir = ah.fs.isDir(destNorm);
    if (destIsDir) {
      const destBase = destNorm.replace(/\/+$/, '');
      for (const src of operands.slice(0, -1)) {
        const srcBase = posix.basename(String(src).replace(/\\/g, '/').replace(/\/+$/, ''));
        if (srcBase) targets.push(destBase + '/' + srcBase);
      }
    }
  }

  const targetOpts = ev.verb === 'rm' ? { deleteOnly: true } : undefined;
  return targets.some((p) => launcherTargetHit(p, cdDir, targetOpts)) ||
    rootTargets.some((p) => isLauncherDirRoot(normalizeGuardPath(p, cdDir)));
}

const CALL_LITERAL_RE = /(?:\(|\b(?:system|exec)[ \t]+)[ \t]*[['"]/g;

function callLiteralCommands(cmd) {
  const src = cmd.replace(/\\(['"])/g, '$1');
  const out = [];
  for (const m of src.matchAll(CALL_LITERAL_RE)) {
    const parts = [];
    let i = m.index + m[0].length - 1;
    while (i < src.length && src[i] !== ')' && src[i] !== ';' && src[i] !== '\n') {
      const q = src[i];
      if (q === "'" || q === '"') {
        const j = src.indexOf(q, i + 1);
        if (j < 0) break;
        parts.push(src.slice(i + 1, j));
        i = j + 1;
      } else i++;
    }
    const joined = parts.join(' ');
    if (/push/.test(joined)) out.push(joined);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// handover commits (guards.handoverCommitGuard): a commit that includes a session handover is blocked

function gitRun(argv, dir, env, timeoutMs) {
  // a query that names its repository (`-C dir`) runs wherever the engine is; one given a directory runs there
  const cwd = dir && ah.fs.isDir(dir) ? dir : undefined;
  const r = ah.exec(ah.cfg('git.git_binary'), argv, { cwd: cwd, env: env || undefined, timeoutMs: timeoutMs });
  return r !== null && r.status === 0 ? r.stdout : null;
}

function isHandoverPath(p) {
  let norm = String(p || '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const hd = ah.cfg('git.handover_dir_prefix');
  if (norm.startsWith(hd) || norm.indexOf('/' + hd) >= 0) return true;
  return norm.indexOf('/') < 0 && /^(?:HANDOVER(?:-[^/]*)?\.md|CONTINUE-HERE\.md|[^/]*\.continue-here\.md)$/.test(norm);
}

function committedHandovers(ev, lastCdDir) {
  const { sub, rest } = gitSubcommand(ev.args);
  if (sub !== 'commit') return null;
  let dir = lastCdDir || S.procCwd;
  for (let k = 0; k < ev.args.length; k++) {
    const t = ev.args[k].text;
    if (t === '-C' && k + 1 < ev.args.length) { dir = posix.resolveIn(S.procCwd, [dir, ev.args[k + 1].text]); k++; continue; }
    if (t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) return null;
    if (t === '-c' || t === '--namespace' || t === '--config-env') { k++; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  let all = false;
  const specs = [];
  let afterDashDash = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (afterDashDash || !t.startsWith('-')) { specs.push(t); continue; }
    if (t === '--') { afterDashDash = true; continue; }
    if (t === '--all') { all = true; continue; }
    if (t.startsWith('--pathspec-from-file')) return null;
    if (t.startsWith('--')) { if (TB.commitValueOpts.has(t)) i++; continue; }
    const cluster = t.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      if (cluster[c] === 'a') all = true;
      if (TB.commitClusterValueFlags.includes(cluster[c])) { if (c === cluster.length - 1) i++; break; }
      if ('Su'.includes(cluster[c])) break;
    }
  }
  const relative = ah.cfg('git.argv_diff_relative');
  // null = unknown (the query failed or timed out); undefined = the budget ran out (counted as skipped by the caller)
  const query = (args, parse) => {
    const key = dir + '\0' + args.join('\0');
    if (S.handoverQueryCache.has(key)) return S.handoverQueryCache.get(key);
    if (S.handoverQueryBudget <= 0) return undefined;
    S.handoverQueryBudget--;
    const out = gitRun(['-C', dir].concat(relative, args), null, null, ah.cfg('git.handover_git_timeout_ms'));
    const parsed = out !== null ? parse(out) : null;
    S.handoverQueryCache.set(key, parsed);
    return parsed;
  };
  const names = (s) => s.split('\0').filter(Boolean);
  const diffNames = ah.cfg('git.argv_diff_names');
  const diff = (args) => query(diffNames.concat(args), names);
  let paths;
  if (specs.length) {
    paths = diff(['HEAD', '--'].concat(specs));
  } else {
    paths = diff(['--cached']);
    if (paths && all) {
      const tracked = diff([]);
      paths = tracked ? paths.concat(tracked) : tracked;
    }
  }
  if (paths && !specs.length && S.handoverAdds.length) {
    const st = query(['status', '--porcelain', '-z', '--untracked-files=all', '--',
      ':(top,glob)**/.anti-hall/handovers/**', ':(top,glob)HANDOVER.md', ':(top,glob)HANDOVER-*.md',
      ':(top,glob)CONTINUE-HERE.md', ':(top,glob)*.continue-here.md'],
    (s) => names(s).filter((e) => !/^( D|D |.D)/.test(e)).map((e) => e.slice(3)));
    if (st === undefined) paths = undefined;
    else if (st) {
      const covered = (p) => S.handoverAdds.some((a) => a === '.' || a === p || p.startsWith(a.replace(/\/+$/, '') + '/'));
      paths = paths.concat(st.filter(covered));
    }
  }
  if (paths === undefined) { S.handoverSkipped++; return null; }
  if (!paths) return null;
  const hits = paths.filter(isHandoverPath);
  if (!hits.length) return null;
  // mid merge / cherry-pick / revert / rebase: the incoming history may already carry a handover; fail open
  const gd = gitRun(['-C', dir].concat(ah.cfg('git.argv_git_dir')), null, null, ah.cfg('git.handover_git_timeout_ms'));
  if (gd === null || !gd.trim()) return null;
  const gitDir = posix.resolveIn(S.procCwd, [dir, gd.trim()]);
  for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (ah.fs.realpath(posix.join(gitDir, m)) !== null) return null; // existsSync follows links
  }
  return hits;
}

function handoverCommitVerdict(ev, lastCdDir) {
  if (!ev.args.some((t) => t.text === 'commit')) return null;
  if (S.handoverEvalBudget-- <= 0) { S.handoverSkipped++; return null; }
  try {
    if (S.handoverOn === null) S.handoverOn = gitSettingOn('git.setting_handover_guard');
    if (!S.handoverOn) return null;
    const hits = committedHandovers(ev, lastCdDir);
    if (!hits) return null;
    const shown = hits.slice(0, TB.shown).join(', ') + (hits.length > TB.shown ? ah.cfg('git.more_marker') : '');
    return gmKey('msg_handover', { shown: shown, skip: skipCmd(ah.cfg('git.guard_name')) });
  } catch (e) {
    if (gitFatal(e)) throw e;
    return null; // fail open
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// aliases and reused commit messages (hooks/lib/git-alias-scan.js)

function aliasEnabled() { if (S.aliasOn === null) S.aliasOn = gitSettingOn('git.setting_alias_resolve'); return S.aliasOn; }
function reuseEnabled() { if (S.reuseOn === null) S.reuseOn = gitSettingOn('git.setting_reused_message'); return S.reuseOn; }

function repoArgs(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if ((t === '-C' || t === '--git-dir' || t === '--work-tree') && k + 1 < args.length) { out.push(t, args[k + 1].text); k++; continue; }
    if (/^--(git-dir|work-tree)=/.test(t)) { out.push(t); continue; }
    if (t === '-c' || t === '--namespace' || t === '--exec-path' || t === '--config-env') { k++; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  return out;
}

function forwardable(tokens) {
  const out = {};
  const re = TB.forwardEnvRe;
  for (const t of tokens) {
    if (t.quotedOnly) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t.text);
    if (!m || !re.test(m[1])) continue;
    if (/[$`]/.test(m[2]) || m[2].indexOf(CMDSUBST_SENTINEL) !== -1) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function segmentEnv(tokens) {
  try {
    const gi = tokens.findIndex((t) => !t.quotedOnly && t.text === 'git');
    if (gi >= 0) return { inline: forwardable(tokens.slice(0, gi)), persist: {} };
    const first = tokens[0] && !tokens[0].quotedOnly ? tokens[0].text : '';
    const allAssign = tokens.every((t) => !t.quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text));
    if (first === 'export' || first === 'declare' || allAssign) return { inline: {}, persist: forwardable(tokens) };
  } catch (e) { if (gitFatal(e)) throw e; }
  return { inline: {}, persist: {} };
}

function spawnDir(dir) { return dir && ah.fs.isDir(dir) ? dir : undefined; }

// memoized per (argv, dir, env): each query runs git once
function gitq(argv, dir, env) {
  const key = JSON.stringify([argv, spawnDir(dir) || '', env || null]);
  if (!S.gitCache.has(key)) {
    const r = ah.exec(ah.cfg('git.git_binary'), argv, { cwd: spawnDir(dir) || S.procCwd, env: env && Object.keys(env).length ? env : undefined, timeoutMs: ah.cfg('git.git_timeout_ms') });
    S.gitCache.set(key, r !== null && r.status === 0 ? r.stdout : null);
  }
  return S.gitCache.get(key);
}

function aliasesFor(args, dir, env) {
  const ra = repoArgs(args);
  const key = JSON.stringify([ra, spawnDir(dir) || '', env || null]);
  if (S.aliasCache.has(key)) return S.aliasCache.get(key);
  const map = new Map();
  const out = gitq(ra.concat(ah.cfg('git.argv_alias_list')), dir, env);
  if (out) {
    for (const rec of out.split('\0')) {
      const nl = rec.indexOf('\n');
      if (nl <= 0) continue;
      const name = rec.slice(0, nl).replace(/^alias\./i, '').toLowerCase();
      if (name && !map.has(name)) map.set(name, rec.slice(nl + 1));
    }
  }
  S.aliasCache.set(key, map);
  return map;
}

function shellWords(tokens) {
  return tokens.map((t) => {
    if (t.text.indexOf(CMDSUBST_SENTINEL) !== -1) return '"$(:)"';
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t.text)) return t.text;
    return "'" + t.text.replace(/'/g, "'\\''") + "'";
  }).join(' ');
}

function firstWord(v) {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))([\s\S]*)$/.exec(v);
  if (!m) return { word: '', tail: '' };
  return { word: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3], tail: m[4] };
}

function aliasable(sub) { return typeof sub === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(sub) && !TB.gitBuiltins.has(sub); }

function expandAlias(args, sub, rest, dir, env) {
  if (!aliasEnabled() || !aliasable(sub)) return null;
  const map = aliasesFor(args, dir, env);
  if (!map.size) return null;
  let name = sub.toLowerCase();
  if (!map.has(name)) return null;
  const chain = [];
  const seen = new Set();
  let suffix = shellWords(rest);
  while (chain.length < TB.maxChain) {
    if (seen.has(name)) return null;
    seen.add(name);
    const v = map.get(name);
    chain.push(name);
    if (/^\s*!/.test(v)) return { chain: chain, verb: '!', command: v.replace(/^\s*!/, '') + (suffix ? ' ' + suffix : '') };
    const { word, tail } = firstWord(v);
    if (aliasable(word) && map.has(word.toLowerCase())) {
      suffix = tail.trim() + (suffix ? ' ' + suffix : '');
      name = word.toLowerCase();
      continue;
    }
    const prefix = shellWords(repoArgs(args).map((w) => ({ text: w })));
    return { chain: chain, verb: word, command: 'git ' + (prefix ? prefix + ' ' : '') + v.trim() + (suffix ? ' ' + suffix : '') };
  }
  return null;
}

function annotate(msg, note) {
  return String(msg).replace(new RegExp('^(\\S+' + gitEsc(ah.cfg('git.block_mark')) + ')'), '$1' + note + ' ');
}

function aliasBodyCommand(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return s.startsWith('!') ? s.slice(1) : 'git ' + s;
}

function scanBody(body, rescan, note) {
  if (!body) return null;
  const hit = rescan(body);
  return hit ? annotate(hit, note) : null;
}

function gitDefinitionVerdict(args, sub, rest, rescan) {
  for (let k = 0; k + 1 < args.length; k++) {
    if (args[k].text !== '-c') continue;
    const m = /^alias\.([^=]+)=([\s\S]*)$/i.exec(args[k + 1].text);
    if (!m) continue;
    const hit = scanBody(aliasBodyCommand(m[2]), rescan, text.render(ah.cfg('git.note_git_alias_def'), { name: m[1] }));
    if (hit) return hit;
  }
  if (sub !== 'config') return null;
  for (let k = 0; k + 1 < rest.length; k++) {
    const m = /^alias\.(\S+)$/i.exec(rest[k].text);
    if (!m) continue;
    const hit = scanBody(aliasBodyCommand(rest[k + 1].text), rescan, text.render(ah.cfg('git.note_git_alias_def'), { name: m[1] }));
    if (hit) return hit;
  }
  return null;
}

function commitLong(n) {
  if (TB.commitLong.includes(n)) return n;
  const c = TB.commitLong.filter((k) => k.startsWith(n));
  return c.length === 1 ? c[0] : null;
}

function commitSources(rest) {
  const o = { message: false, reuse: null, reedit: false, amend: false, noEdit: false, edit: false, template: null };
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].text;
    if (t === '--') break;
    const next = () => (k + 1 < rest.length ? rest[++k].text : '');
    const long = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(t);
    if (long) {
      const n = commitLong(long[1]);
      const val = long[2] !== undefined ? long[2] : (TB.commitLongValue.has(n) ? next() : undefined);
      if (n === 'message' || n === 'file' || n === 'fixup' || n === 'squash') o.message = true;
      else if (n === 'reuse-message') o.reuse = val;
      else if (n === 'reedit-message') { o.reuse = val; o.reedit = true; }
      else if (n === 'template') o.template = val;
      else if (n === 'amend') o.amend = true;
      else if (n === 'no-edit') o.noEdit = true;
      else if (n === 'edit') o.edit = true;
      continue;
    }
    if (!/^-[A-Za-z]/.test(t)) continue;
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (ch === 'e') { o.edit = true; continue; }
      if (ch === 'S' || ch === 'u') break;
      if (!TB.commitClusterValueFlags.includes(ch)) continue;
      const val = j + 1 < t.length ? t.slice(j + 1) : next();
      if (ch === 'm' || ch === 'F') o.message = true;
      else if (ch === 'C') o.reuse = val;
      else if (ch === 'c') { o.reuse = val; o.reedit = true; }
      else if (ch === 't') o.template = val;
      break;
    }
  }
  return o;
}

const EDITOR_SET_RE = /(?:^|[\s;&|(])(?:export\s+)?(?:GIT_EDITOR|EDITOR|VISUAL)=('[^']*'|"[^"]*"|\S*)|core\.editor[\s=]+('[^']*'|"[^"]*"|\S*)/gi;

function setsRealEditor(rawCmd) {
  const noop = new RegExp('^(?:\\S*\\/)?(?:' + TB.noopEditors.map(gitEsc).join('|') + ')$');
  for (const m of String(rawCmd || '').matchAll(EDITOR_SET_RE)) {
    const v = (m[1] !== undefined ? m[1] : m[2] || '').replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (!noop.test(v)) return true;
  }
  return false;
}

function readTemplate(args, dir, explicit, env) {
  let p = explicit;
  if (!p) {
    const out = gitq(repoArgs(args).concat(ah.cfg('git.argv_commit_template')), dir, env);
    p = out ? out.trim() : '';
  }
  if (!p) return null;
  if (p === '~' || p.startsWith('~/')) p = posix.join((env && env.HOME) || S.home, p.slice(1));
  const base = spawnDir(dir) || S.procCwd;
  return readFileText(posix.resolveIn(S.procCwd, [base, p]));
}

function reusedMessageVerdict(args, rest, dir, rawCmd, env) {
  if (!reuseEnabled()) return null;
  const o = commitSources(rest);
  if (o.message) return null;
  let text0 = null, origin = null, verbatim = false;
  const logArgv = (rev) => ah.cfg('git.argv_log_message').map((a) => a.split('{rev}').join(rev));
  if (o.reuse && !o.reuse.startsWith('-')) {
    text0 = gitq(repoArgs(args).concat(logArgv(o.reuse)), dir, env);
    const full = new RegExp('^[0-9a-f]{' + TB.commitHashLen + ',}$', 'i');
    origin = text.render(ah.cfg('git.origin_commit'), { ref: full.test(o.reuse) ? o.reuse.slice(0, TB.commitHashShort) : o.reuse });
    verbatim = !o.reedit && !o.edit;
    if (o.noEdit) verbatim = true;
  } else if (o.amend) {
    text0 = gitq(repoArgs(args).concat(logArgv('HEAD')), dir, env);
    origin = ah.cfg('git.origin_amend');
    verbatim = o.noEdit;
  } else if (!o.noEdit) {
    text0 = readTemplate(args, dir, o.template, env);
    origin = ah.cfg('git.origin_template');
  }
  if (!text0 || !hasSelfCredit(text0)) return null;
  if (!verbatim && setsRealEditor(rawCmd)) return null;
  return gmKey('msg_reused_message', { origin: origin });
}

function aliasGitVerdict(args, sub, rest, dir, depth, env, rescan) {
  try {
    if (aliasEnabled()) {
      const def = gitDefinitionVerdict(args, sub, rest, (c) => rescan(c, dir));
      if (def) return def;
      if (depth < TB.aliasDepth) {
        const ex = expandAlias(args, sub, rest, dir, env);
        if (ex) {
          const hit = rescan(ex.command, dir);
          if (hit) return annotate(hit, text.render(ah.cfg('git.note_git_alias_use'), { chain: ex.chain.join(ah.cfg('git.chain_joiner')) }));
        }
      }
    }
    if (sub === 'commit') return reusedMessageVerdict(args, rest, dir, S.raw, env);
  } catch (e) { if (gitFatal(e)) throw e; }
  return null;
}

function unquoteWord(v) { return v.replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1'); }

function matchingClose(text0, open) {
  const want = text0[open] === '{' ? '}' : ')';
  let depth = 0;
  for (let k = open; k < text0.length; k++) {
    if (text0[k] === text0[open]) depth++;
    else if (text0[k] === want && --depth === 0) return k;
  }
  return -1;
}

function shellDefs(rawCmd) {
  const raw = String(rawCmd || '');
  if (S.shellDefsCache.has(raw)) return S.shellDefsCache.get(raw);
  const defs = new Map();
  const aliasRe = /(?:^|[\s;&|(])alias[ \t]+([A-Za-z_][\w.-]*)=('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|]*)/g;
  for (const m of raw.matchAll(aliasRe)) defs.set(m[1], { kind: 'alias', body: unquoteWord(m[2]) });
  const fnRe = /(?:^|[\s;&|('"`]|\bfunction[ \t]+)[ \t]*([A-Za-z_][\w.-]*)[ \t]*(?:\([ \t]*\))?[ \t\n]*([{(])/g;
  for (const m of raw.matchAll(fnRe)) {
    const open = m.index + m[0].length - 1;
    if (!/\(\s*\)\s*[{(]$/.test(m[0]) && !/\bfunction[ \t]/.test(m[0])) continue;
    const close = matchingClose(raw, open);
    if (close > open) defs.set(m[1], { kind: 'function', body: raw.slice(open + 1, close) });
  }
  S.shellDefsCache.set(raw, defs);
  return defs;
}

const ARG_ASSIGN_RE = /(^|[\s;&|({])((?:(?:local|declare|typeset|readonly|export)[ \t]+(?:-[A-Za-z]+[ \t]+)?)?([A-Za-z_]\w*)=)("\$(?:[1-9]|\{[1-9]\})"|\$(?:[1-9]|\{[1-9]\}))(?=[\s;&|)}]|$)/g;
const SHELL_WORD_RE = /(?:^|[\s(])(?:eval|exec|source|\.|(?:ba|z|da|k|c)?sh|xargs|env|command|builtin|nohup|sudo|time)(?=\s|$)/;

function varRef(n) { return new RegExp('\\$(?:\\{' + n + '\\b|' + n + '\\b)'); }

function varIsExecuted(body, name, names) {
  const pipeToShell = /\|[ \t]*(?:\S*\/)?(?:(?:ba|z|da|k|c)?sh)\b/.test(body);
  const cmdPos = new RegExp('(?:^|[;&|(\\n{]|\\b(?:then|do|else)\\b)[ \\t]*(?:[A-Za-z_]\\w*=\\S*[ \\t]+)*"?\\$(?:\\{' + name + '\\}|' + name + '\\b)"?(?![\\w])');
  if (cmdPos.test(body) || pipeToShell) return true;
  const ref = varRef(name);
  for (const seg of body.split(/[;&|\n]+/)) if (ref.test(seg) && SHELL_WORD_RE.test(seg)) return true;
  for (const m of body.matchAll(/(?:^|[\s;&|({])(?:local[ \t]+)?([A-Za-z_]\w*)=([^;\n]*)/g)) {
    if (m[1] === name || names.has(m[1]) || !ref.test(m[2])) continue;
    names.add(m[1]);
    if (varIsExecuted(body, m[1], names)) return true;
  }
  return false;
}

function neutraliseDataArgAssignments(body) {
  return body.replace(ARG_ASSIGN_RE, (all, pre, lhs, name) => (varIsExecuted(body, name, new Set([name])) ? all : pre + lhs + '""'));
}

function wrapperExpansion(def, args) {
  const words = shellWords(args);
  if (def.kind === 'alias') return def.body + (words ? ' ' + words : '');
  return neutraliseDataArgAssignments(def.body)
    .replace(/"\$[@*]"|\$[@*]|"\$\{[@*]\}"|\$\{[@*]\}/g, words)
    .replace(/"?\$\{?([1-9])\}?"?/g, (_, n) => shellWords(args.slice(Number(n) - 1, Number(n))));
}

function shellDefinitionVerdict(tokens, ev, rescan, depth, rawCmd) {
  try {
    if (!aliasEnabled()) return null;
    if (ev.verb === 'alias') {
      for (const t of ev.args) {
        const m = /^([^=\s]+)=([\s\S]+)$/.exec(t.text);
        if (!m) continue;
        const hit = scanBody(m[2], rescan, text.render(ah.cfg('git.note_shell_alias_def'), { name: m[1] }));
        if (hit) return hit;
      }
    }
    for (const t of tokens) {
      if (t.quotedOnly) continue;
      const m = /^(GIT_CONFIG_VALUE_\d+)=([\s\S]+)$/.exec(t.text);
      if (!m) continue;
      const hit = scanBody(aliasBodyCommand(m[2]), rescan, text.render(ah.cfg('git.note_env_alias_def'), { name: m[1] }));
      if (hit) return hit;
    }
    if (depth < TB.aliasDepth && ev.args.length) {
      const def = shellDefs(rawCmd).get(ev.verb);
      if (def) {
        const kind = ah.cfg(def.kind === 'alias' ? 'git.word_alias' : 'git.word_function');
        const hit = scanBody(wrapperExpansion(def, ev.args), rescan, text.render(ah.cfg('git.note_shell_def_use'), { kind: kind, name: ev.verb }));
        if (hit) return hit;
      }
    }
  } catch (e) { if (gitFatal(e)) throw e; }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// the scan

function scanCommand(cmd, depth, baseCwd) {
  const d = typeof depth === 'number' ? depth : 0;
  if (d === 0) S.launcherCmdText = cmd;
  // heredoc bodies whose consumer is not a shell are data: blanked for the segment, call-literal and backstop scans
  const scanText = maskDataHeredocs(cmd, baseCwd);
  const segments = splitSegments(scanText);
  const heredocBodies = extractHeredocBodies(cmd);
  let lastCdDir = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;

  if (d < 3) {
    for (const lit of callLiteralCommands(scanText)) {
      const hit = scanCommand(lit, d + 1, baseCwd);
      if (hit) return hit;
    }
  }
  for (const h of heredocBodies) {
    const hit = scanConfigLines(h.body, d);
    if (hit) return hit;
  }

  const persistEnv = {};
  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const segEnv = segmentEnv(tokens);
    const gitEnv = Object.assign({}, persistEnv, segEnv.inline);
    Object.assign(persistEnv, segEnv.persist);

    for (const t of tokens) {
      if (t.quotedOnly) continue;
      const a = /^[A-Za-z_][A-Za-z0-9_]*=([\s\S]+)$/.exec(t.text);
      if (a) {
        const hit = scanCommandValue(a[1], d);
        if (hit) return hit;
      }
    }

    const ev = effectiveVerb(tokens);
    if (!ev) continue;
    ev.env = gitEnv;

    const aliasDef = shellDefinitionVerdict(tokens, ev, (c) => scanCommand(c, d + 1, lastCdDir), d, S.raw);
    if (aliasDef) return aliasDef;

    const pv = placeholderVerdict(ev, S.repls);
    if (pv) return pv;

    if (writesLauncherDir(tokens, ev, lastCdDir)) return gmKey('msg_launcher');

    if (ev.verb === 'echo' || ev.verb === 'printf') {
      const text0 = ev.args.map((t) => t.text).join(' ').replace(/\\[nt]/g, '\n');
      const hit = scanConfigLines(text0, d);
      if (hit) return hit;
      continue;
    }

    if (ev.verb === 'cd' || ev.verb === 'pushd') {
      const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
      if (dirTok) {
        if (lastCdDir && (lastCdDir.length > TB.cdMaxChars || lastCdDir.split('/').length > ah.cfg('git.cd_max_segments'))) lastCdDir = null;
        else lastCdDir = normalizeGuardPath(dirTok.text, lastCdDir) || dirTok.text;
      }
      continue;
    }

    if (ev.verb === 'eval') {
      if (d < 3) {
        const payload = extractEvalPayload(seg);
        if (payload) {
          const nested = scanCommand(payload, d + 1, lastCdDir);
          if (nested) return nested;
        }
      }
      continue;
    }

    if (TB.shellVerbs.has(ev.verb.toLowerCase())) {
      if (d < 3) {
        const payload = extractShellCPayload(seg);
        if (payload) {
          const nested = scanCommand(payload, d + 1, lastCdDir);
          if (nested) return nested;
        } else if (shellScriptIsInput(tokens, [])) {
          const sv = stdinScriptVerdict(cmd, d, lastCdDir);
          if (sv) return sv;
        }
      }
      continue;
    }

    if (ev.verb === 'gh') {
      const ghMsg = ghSelfCreditMessage(ev.args);
      if (ghMsg) return ghMsg;
      continue;
    }

    if (ev.verb === 'xargs') {
      const xv = xargsGitVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
      if (xv) return xv;
      continue;
    }
    if (ev.verb === 'find') {
      const fv = findExecVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
      if (fv) return fv;
      continue;
    }
    if (ev.verb === 'parallel') {
      const pa = parallelVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
      if (pa) return pa;
      continue;
    }

    if (ev.verb !== 'git') continue;

    const gv = gitVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
    if (gv) return gv;
    if (S.handoverAdds.length < TB.handoverAddsMax && ev.args.some((t) => t.text === 'add')) {
      const { sub: addSub, rest: addRest } = gitSubcommand(ev.args);
      if (addSub === 'add') {
        const specs = addRest.filter((t) => !t.text.startsWith('-') || t.text === '--').map((t) => t.text).filter((x) => x !== '--');
        const broad = !specs.length || addRest.some((t) => /^-(?:[A-Za-z]*[Au][A-Za-z]*|-all|-update)$/.test(t.text));
        if (broad) S.handoverAdds.push('.');
        for (const s of specs) S.handoverAdds.push(s.replace(/^\.\//, '') || '.');
      }
    }
    const hv = handoverCommitVerdict(ev, lastCdDir);
    if (hv) return hv;
  }
  if (d === 0) {
    const lb = launcherBackstop(scanText, baseCwd);
    if (lb) return lb;
  }
  return gitBackstop(scanText, d, heredocBodies, baseCwd);
}

function launcherBackstop(rawCmd, baseCwd) {
  if (rawCmd.replace(/[\s'"\\$]/g, '').indexOf('anti-hall') === -1 &&
      !(typeof baseCwd === 'string' && baseCwd.indexOf('/.anti-hall') !== -1)) return null;
  const cmd = rawCmd.replace(/(?<!\\)(\\+)\r?\n/g, (m, bs) => (bs.length % 2 ? bs.slice(1) : m));
  let cdDir = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;
  const baseDir = cdDir;
  const msg = () => gmKey('msg_launcher');
  for (const raw of backstopPieces(cmd)) {
    const trimmed = raw.replace(/^\s+/, '');
    const variants = [trimmed];
    if (/^["']/.test(trimmed)) variants.push(trimmed.replace(/^["']+/, ''));
    for (const v of variants) {
      const tokens = tokenize(v);
      if (!tokens.length) continue;
      const ev = backstopVerb(v);
      if (!ev) continue;
      if (ev.verb === 'cd' || ev.verb === 'pushd') {
        const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
        if (dirTok) {
          cdDir = (cdDir && (cdDir.length > TB.cdMaxChars || cdDir.split('/').length > ah.cfg('git.cd_max_segments')))
            ? null : (normalizeGuardPath(dirTok.text, cdDir) || dirTok.text);
        }
        continue;
      }
      if (writesLauncherDir(tokens, ev, cdDir)) return msg();
    }
  }
  for (const w of redirectWords(cmd)) {
    if (launcherTargetHit(w, baseDir) || (cdDir !== baseDir && launcherTargetHit(w, cdDir))) return msg();
  }
  return null;
}

function gitVerdict(ev, d, cmd, heredocBodies, lastCdDir, useJev) {
  for (let j = 0; j + 1 < ev.args.length; j++) {
    if (ev.args[j].text !== '-c') continue;
    const cv = /^[^=]+=([\s\S]*)$/.exec(ev.args[j + 1].text);
    const hit = cv ? scanCommandValue(cv[1], d) : null;
    if (hit) return hit;
  }
  const { sub, rest } = gitSubcommand(ev.args);
  if (sub === null) return null;

  const aliasHit = aliasGitVerdict(ev.args, sub, rest, lastCdDir, d, ev.env, (c, dir) => scanCommand(c, d + 1, dir));
  if (aliasHit) return aliasHit;

  if (sub === 'config') {
    for (const t of rest) {
      if (t.text.startsWith('-')) continue;
      const hit = scanCommandValue(t.text, d);
      if (hit) return hit;
    }
  }

  if (sub === 'push') {
    if (isForcePush(rest)) return gmKey('msg_force_push');
    if (isDeleteRefPush(rest)) return gmKey('msg_delete_ref', { skip: skipCmd(ah.cfg('git.guard_name')) });
    if (hasCmdSubstArg(rest)) {
      const m = ah.cfg('git.msg_push_cmdsubst');
      const note = /<<-?[ \t]*['"\\]?[A-Za-z_]/.test(S.raw) ? ah.cfg('git.push_cmdsubst_heredoc_note') : '';
      return gm({ what: m.what, why: m.why, instead: m.instead + note });
    }
  }

  if (TB.backstopCommitSubs.has(sub)) {
    if (hasSelfCreditTrailerKeyRemap(ev.args)) return gmKey('msg_trailer_remap');
    const msgs = inlineCommitMessages(rest);
    for (const m of msgs) {
      if (creditRegexes(m) || creditRegexes(normEscapes(m))) return gmKey('msg_commit_credit');
    }
    for (const m of msgs) if (m && useJev && consultJev(m)) return gmKey('msg_commit_jev');

    const fileSpecs = fileCommitMessages(rest);
    for (const spec of fileSpecs) {
      let text0 = null;
      let verdict = null;
      if (spec === '-' || spec === '/dev/stdin') {
        const cached = stdinCandidateTextCached(cmd, heredocBodies);
        text0 = cached.text;
        verdict = cached.hasSelfCredit;
      } else {
        let filePath = spec;
        if (!posix.isAbsolute(filePath) && lastCdDir) filePath = posix.join(lastCdDir, filePath);
        text0 = readFileText(posix.isAbsolute(filePath) ? filePath : posix.resolveIn(S.procCwd, [filePath]));
      }
      if (text0 === null) continue;
      if (verdict === null ? creditRegexes(text0) : verdict) return gmKey('msg_commit_file_credit');
      if (useJev && consultJev(text0)) return gmKey('msg_commit_file_jev');
    }
  }

  if (TB.commitCreating.has(sub) && hasSelfCredit(S.raw)) {
    const elsewhere = creditElsewhereLabel('git');
    if (elsewhere) return gmKey('msg_creating_credit_elsewhere', { sub: sub, elsewhere: elsewhere });
    return gmKey('msg_creating_credit', { sub: sub });
  }
  return null;
}

// ---- the quote-blind backstop ----

function backstopPieces(cmd) {
  const s = cmd.replace(/\\\r?\n/g, ' ');
  const n = s.length;
  const pieces = [];
  let start = 0, tightPipe = false, lineIndex = 0;
  function cut(end, next, subst, nextTight, newLine) {
    pieces.push({ text: s.slice(start, end) + (subst ? ' ' + CMDSUBST_SENTINEL + ' ' : ''), tightPipe: tightPipe, line: lineIndex });
    start = next;
    tightPipe = nextTight;
    if (newLine) lineIndex++;
  }
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '\n') { cut(i, i + 1, false, false, true); continue; }
    if (c === ';' || c === ')') { cut(i, i + 1, false, false); continue; }
    if (c === '(') { cut(i, i + 1, i > 0 && s[i - 1] === '$', false); continue; }
    if (c === '`') { cut(i, i + 1, true, false); continue; }
    if (c === '|') {
      if (i > 0 && s[i - 1] === '>') continue;
      if (s[i + 1] === '|' || s[i + 1] === '&') { cut(i, i + 2, false, false); i++; continue; }
      const tight = i > 0 && !/\s/.test(s[i - 1]) && i + 1 < n && !/\s/.test(s[i + 1]);
      cut(i, i + 1, false, tight);
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { cut(i, i + 2, false, false); i++; continue; }
      if ((i > 0 && (s[i - 1] === '>' || s[i - 1] === '<')) || s[i + 1] === '>') continue;
      cut(i, i + 1, false, false);
    }
  }
  cut(n, n, false, false);
  const out = [];
  let pending = null, dqParity = 0, sqParity = 0;
  for (const p of pieces) {
    const dq = (p.text.split('"').length - 1) % 2;
    const sq = (p.text.split("'").length - 1) % 2;
    const enteringDQ = dqParity, enteringSQ = sqParity;
    dqParity ^= dq;
    sqParity ^= sq;
    if (pending && p.line !== pending.line) { out.push(...pending.parts); pending = null; }
    if (pending) {
      pending.parts.push(p.text);
      if (!dqParity && !sqParity) {
        if (out.length) out[out.length - 1] += '|' + pending.parts.join('|'); else out.push(pending.parts.join('|'));
        pending = null;
      }
      continue;
    }
    if (p.tightPipe && out.length && (enteringDQ || enteringSQ)) {
      pending = { parts: [p.text], line: p.line };
      if (!dqParity && !sqParity) { out[out.length - 1] += '|' + pending.parts.join('|'); pending = null; }
      continue;
    }
    out.push(p.text);
  }
  if (pending) out.push(...pending.parts);
  return out;
}

function backstopVerb(text0) {
  const tokens = tokenize(text0.replace(/^(?:\s*[{}!](?=\s|$))+/, ''));
  let idx = 0;
  while (idx < tokens.length && !tokens[idx].quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx].text)) idx++;
  if (idx < tokens.length && tokens[idx].quotedOnly) tokens[idx] = { text: tokens[idx].text, quotedOnly: false };
  return effectiveVerb(tokens);
}

function backstopEnv(cmd) {
  const env = {};
  try {
    for (const seg of splitSegments(cmd)) {
      const e = segmentEnv(tokenize(seg));
      Object.assign(env, e.persist, e.inline);
    }
  } catch (e) { if (gitFatal(e)) throw e; }
  return env;
}

function gitBackstopLines(cmd, d, heredocBodies, cwd) {
  const benv = backstopEnv(cmd);
  const joined = cmd.replace(/\\\r?\n/g, ' ');
  for (const line of joined.split('\n')) {
    if (!/\bgit\b/.test(line)) continue;
    for (const seg of splitSegments(line)) {
      const tokens = tokenize(seg);
      if (!tokens.length) continue;
      const ev = effectiveVerb(tokens);
      if (!ev) continue;
      if (ev.verb === 'xargs') { const xv = xargsGitVerdict(ev, d, cmd, heredocBodies, cwd, false); if (xv) return xv; continue; }
      if (ev.verb === 'find') { const fv = findExecVerdict(ev, d, cmd, heredocBodies, cwd, false); if (fv) return fv; continue; }
      if (ev.verb === 'parallel') { const pa = parallelVerdict(ev, d, cmd, heredocBodies, cwd, false); if (pa) return pa; continue; }
      if (ev.verb !== 'git') continue;
      ev.env = benv;
      const hit = gitVerdict(ev, d, cmd, heredocBodies, cwd, false);
      if (hit) return hit;
    }
  }
  return null;
}

function gitBackstop(cmd, d, heredocBodies, baseCwd) {
  const benv = backstopEnv(cmd);
  const cwd = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;
  if (d < 3) {
    for (const payload of pipedEchoShellPayloads(cmd)) {
      const hit = gitBackstop(payload, d + 1, extractHeredocBodies(payload), cwd);
      if (hit) return hit;
    }
  }
  for (const raw of backstopPieces(cmd)) {
    const trimmed = raw.replace(/^\s+/, '');
    const variants = [trimmed];
    if (/^["']/.test(trimmed)) variants.push(trimmed.replace(/^["']+/, ''));
    for (const v of variants) {
      if (d < 3) {
        const envPayload = extractEnvSPayload(v);
        if (envPayload) {
          const hit = gitBackstop(envPayload, d + 1, extractHeredocBodies(envPayload), cwd);
          if (hit) return hit;
          continue;
        }
      }
      const ev = backstopVerb(v);
      if (!ev) continue;
      if (ev.verb === 'git') {
        ev.env = benv;
        const hit = gitVerdict(ev, d, cmd, heredocBodies, cwd, false);
        if (hit) return hit;
      } else if (d < 3 && (ev.verb === 'eval' || TB.shellVerbs.has(ev.verb.toLowerCase()))) {
        const payload = ev.verb === 'eval' ? extractEvalPayload(v) : extractShellCPayload(v);
        if (payload) {
          const hit = gitBackstop(payload, d + 1, extractHeredocBodies(payload), cwd);
          if (hit) return hit;
        }
      }
    }
  }
  return gitBackstopLines(cmd, d, heredocBodies, cwd);
}

// ---------------------------------------------------------------------------------------------------------------------
// entry

// a stack overflow, memory or time-limit exception must reach the engine (it then defers), never be swallowed by a fail-open catch
function gitFatal(e) {
  return e instanceof RangeError || (e && /stack|memory|interrupt/i.test(String(e.message || e)));
}

function looksLikeFileWriteShape(cmd) {
  const hd = new RegExp(TB.fileWriteHeredoc).test(cmd);
  const redirects = new RegExp(TB.fileWriteRedirect).test(cmd);
  if (hd) return redirects || new RegExp(TB.fileWriteTee).test(cmd);
  return new RegExp(TB.fileWriteEcho).test(cmd) && redirects;
}

function decide(p, opts, event) {
  if (event !== 'PreToolUse' || !p || p.tool_name !== 'Bash') return null;
  const ti = p.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.command !== 'string') return null;
  TB = gitTables();
  if (!gitSettingOn('git.setting_git_guard')) return 'allow';
  if (ah.settings.skipped(ah.cfg('git.guard_name'))) return 'allow';
  const cmd = ti.command;
  if (cmd === '') return 'allow';
  // `payload.cwd || process.cwd()`: without one, the hook process's own directory (lib/78-hook-proc.js)
  // a relative payload cwd resolves against the hook process's own directory, which the daemon cannot know: Node decides
  if (typeof p.cwd === 'string' && p.cwd !== '' && p.cwd.charAt(0) !== '/') return 'defer';
  const cwdIn = hookProc.cwd(p);
  let home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  const session = p.session_id ? String(p.session_id) : null;
  S = gitFreshState(cmd, cwdIn, session);
  S.home = home || '';
  S.abs = (q) => (q.charAt(0) === '/' ? q : posix.resolveIn(cwdIn, [q]));
  S.pluginRoot = (opts && typeof opts.plugin_root === 'string' && opts.plugin_root) || ah.env.get(ah.cfg('env.plugin_root')) || '';
  shellScan.reset();
  const hit = scanCommand(cmd, 0, cwdIn);
  if (hit) return { block: looksLikeFileWriteShape(cmd) ? hit + ah.cfg('git.file_write_tip') : hit };
  if (S.handoverSkipped > 0) {
    const t = text.render(ah.cfg('git.handover_skipped_advisory'), { n: S.handoverSkipped });
    return { advisory: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: t } }) };
  }
  return 'allow';
}

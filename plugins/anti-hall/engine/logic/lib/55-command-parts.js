// Helpers command.js (the command check, and the classifier coordinator-work-guard builds on) calls: shell-text scanners, token and
// segment walks and the tables they use. Moved out of command.js unchanged because that file must stay under the plugin directory's
// per-file size limit (ah-engine/tests/plugin-dir-limits.toml). Globals of the shared context, like the other lib files.
'use strict';

function cmdSet(k) { return new Set(ah.cfg(k)); }

function cmdRe(src, flags) {
  var f = flags || '';
  if (src.slice(0, 4) === '(?i)') { src = src.slice(4); f += 'i'; }
  return new RegExp(src, f);
}

function cmdEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The defaults entries that describe the settings the script reads.
var SETTING_KEYS = [
  'command.allow_subagent_mailbox_setting', 'command.stash_guard_setting', 'command.inbox_cmd_setting', 'command.setting_allow_read_only_verify',
  'command.setting_allow_read_only_verify_scripts', 'command.setting_project_command_allow', 'command.setting_allow_plain_push',
  'command.setting_allow_bg_scratch', 'command.setting_allow_gcloud_reads', 'command.setting_bash_edit_parity', 'command.setting_project_edit_allow',
  'command.eg_allow_setting', 'command.tier_repos_setting', 'command.tier_detect_setting', 'command.tier_text_setting',
  'coordinator_work.command_guard_setting', 'edit_guard.setting',
];

function cmdBuildTables() {
  var t = {};
  t.maxLen = ah.cfg('command.max_classify_len'); t.maxDepth = ah.cfg('command.max_depth');
  t.heavyVerbs = cmdSet('command.heavy_verbs'); t.heavyPatterns = ah.cfg('command.heavy_patterns').map(function (s) { return cmdRe(s); });
  t.light = ah.cfg('command.light_exceptions').map(function (s) { return cmdRe(s); }).concat(ah.cfg('command.light_exceptions_neg').map(function (n) {
    return cmdRe(n.head + '\\b(?![^\\n]*' + n.not_after.replace(RX1, '') + ')');
  }));
  t.devswarmVerbs = cmdSet('command.devswarm_cli_verbs');
  var alt = '(?:' + ah.cfg('command.devswarm_cli_verbs').join('|') + ')';
  var hv = function (w) { return new RegExp('\\b' + alt + '\\s+(?:-\\S+\\s+)*workspace\\s+(?:-\\S+\\s+)*' + w + '\\b', 'i'); };
  t.hcMonitor = hv('monitor'); t.hcReadMessages = hv('read-messages'); t.hcMessageChild = hv('message-child'); t.hcMessageParent = hv('message-parent');
  var fskip = ah.cfg('command.mailbox_flag_skip'), pre = ah.cfg('command.mailbox_js_prefix');
  var mailboxAlt = '(?:inbox\\s+' + fskip + '(?:pull|ack|read-primary|drain-primary-legacy|read|tick)\\b|heartbeat\\b|reap-orphans\\b|register(?!-)\\b|archive(?!-)\\b)';
  var mb = function (tail) { return new RegExp('\\b' + pre + '\\s+' + fskip + tail, 'i'); };
  t.mbMailbox = mb(mailboxAlt); t.mbInbox = mb('inbox\\s+' + fskip + 'messages\\b'); t.mbMesh = mb('mesh\\s+' + fskip + 'read\\b'); t.mbRoster = mb('roster\\b');
  t.ackFlag = RX2; t.meshSafe = RX3; t.rosterAck = RX4;
  t.stashGlobalValue = cmdSet('command.stash_global_value_opts'); t.stashPushValue = cmdSet('command.stash_push_value_flags');
  t.fileReadVerbs = cmdSet('command.file_read_verbs'); t.patternFirstVerbs = cmdSet('command.pattern_first_verbs');
  t.wrappers = cmdSet('command.wrappers'); t.sudoValue = cmdSet('command.sudo_value_flags'); t.timeoutValue = cmdSet('command.timeout_value_flags');
  t.niceValue = cmdSet('command.nice_value_flags'); t.taskpolicyValue = cmdSet('command.taskpolicy_value_flags');
  t.shellVerbs = cmdSet('command.shell_verbs'); t.testKeywords = cmdSet('command.test_keywords');
  t.nodeEvalFlags = cmdSet('command.node_eval_flags'); t.nodeEvalDeny = ah.cfg('command.node_eval_deny').map(function (s) { return cmdRe(s); });
  t.nodeSafeBracket = new RegExp(ah.cfg('command.node_eval_safe_bracket'), 'g'); t.nodeFsCall = new RegExp(ah.cfg('command.node_fs_method_call'), 'g'); t.nodeFsRead = cmdSet('command.node_fs_read_allowlist');
  t.fetchDangerous = cmdSet('command.git_fetch_dangerous_flags'); t.gitGlobalValue = cmdSet('command.git_global_value_opts'); t.gitGlobalFlag = cmdSet('command.git_global_flag_opts');
  t.gitHeavySubs = cmdSet('command.git_heavy_subs');
  t.sqliteDangerous = cmdRe(ah.cfg('command.sqlite_dangerous'));
  t.gcloudRefused = cmdRe(ah.cfg('command.gcloud_refused_path')); t.gcloudBool = cmdSet('command.gcloud_boolean_flags'); t.gcloudValue = cmdSet('command.gcloud_value_flags');
  t.gcloudInspect = cmdSet('command.gcloud_inspect_verbs'); t.gcloudLogging = ah.cfg('command.gcloud_logging_group');
  t.cloudBinaries = cmdSet('command.cloud_binaries'); t.cloudReadonly = cmdSet('command.cloud_readonly_verbs'); t.cloudMutating = cmdSet('command.cloud_mutating_verbs');
  t.wholeClis = ah.cfg('command.whole_command_clis');
  t.versionCli = new RegExp('^(?:' + t.wholeClis.map(cmdEsc).join('|') + ')\\s+(?:--version|-V)$', 'i');
  t.wholeCliStart = new RegExp('^(?:' + t.wholeClis.map(cmdEsc).join('|') + ')\\s', 'i');
  t.ghMutating = {};
  Object.keys(ah.cfg('command.gh_mutating_subcommands')).forEach(function (g) { t.ghMutating[g] = new Set(ah.cfg('command.gh_mutating_subcommands')[g]); });
  t.ghOneliner = {};
  Object.keys(ah.cfg('command.gh_oneliner_subcommands')).forEach(function (g) { t.ghOneliner[g] = new Set(ah.cfg('command.gh_oneliner_subcommands')[g]); });
  t.ghOnelinerMax = ah.cfgNum('command.gh_oneliner_max_chars');
  t.ghOnelinerRe = new RegExp(ah.cfg('command.gh_oneliner_deny_re'));
  t.scratchSyncSubs = cmdSet('command.scratch_clone_sync_subs');
  t.ghApiMethods = cmdSet('command.gh_api_mutating_methods'); t.ghGqlValue = cmdSet('command.gh_gql_value_flags'); t.ghGqlBool = cmdSet('command.gh_gql_bool_flags');
  t.ghField = cmdSet('command.gh_api_field_flags');
  t.timeoutPrefix = cmdRe(ah.cfg('command.timeout_prefix')); t.controlPrefix = cmdRe(ah.cfg('command.control_keyword_prefix'));
  t.scriptInterp = cmdRe(ah.cfg('command.script_check_interpreter'));
  t.nodeExt = cmdRe(ah.cfg('command.node_script_ext')); t.pyExt = cmdRe(ah.cfg('command.python_script_ext'));
  t.verifySyntaxCompilers = cmdSet('command.verify_syntax_only_compilers'); t.verifyTrivial = cmdSet('command.verify_trivial_verbs');
  t.checkFlagRefused = cmdSet('command.check_flag_refused_verbs');
  t.gcloudReadVerbs = cmdSet('command.gcloud_read_verbs'); t.jqSafe = cmdSet('command.jq_safe_flags'); t.curlBare = cmdSet('command.curl_bare_flags');
  t.jqRefusedWords = ah.cfg('command.jq_refused_words'); t.gcloudTokenVars = ah.cfg('command.gcloud_token_vars');
  t.bgInterpreters = cmdSet('command.background_script_interpreters'); t.bgDelims = cmdSet('command.background_chain_delims');
  t.plainReadGitKinds = cmdSet('command.plain_read_git_kinds');
  t.bgSafeFlags = {}; Object.keys(ah.cfg('command.background_script_safe_flags')).forEach(function (k) { t.bgSafeFlags[k] = new Set(ah.cfg('command.background_script_safe_flags')[k]); });
  t.cdDelims = ah.cfg('command.cd_delims'); t.pipelineEnds = ah.cfg('command.pipeline_ends'); t.cdContextsMax = ah.cfg('command.cd_contexts_max');
  t.inlineVerbs = cmdSet('command.inline_verbs'); t.inlinePythonFlags = ah.cfg('command.inline_python_flags'); t.inlineOtherFlags = ah.cfg('command.inline_other_flags');
  t.inlineWriteMarkers = ah.cfg('command.inline_write_markers');
  t.gitAlwaysWork = cmdSet('command.git_always_work'); t.gitTagValue = cmdSet('command.git_tag_value_flags');
  t.scriptShells = cmdSet('command.script_shells'); t.scriptInterpreters = cmdSet('command.script_interpreters');
  t.scriptNotRunFlag = {}; Object.keys(ah.cfg('command.script_not_a_run_flag')).forEach(function (f) { t.scriptNotRunFlag[f] = new RegExp(ah.cfg('command.script_not_a_run_flag')[f]); }); t.scriptValueFlags = cmdSet('command.script_value_flags');
  t.binaryMagics = ah.cfg('command.binary_magics'); t.homeManaged = ah.cfg('command.home_managed_dirs'); t.homePersonal = ah.cfg('command.home_personal_dirs');
  t.antiHallCli = ah.cfg('command.anti_hall_cli_patterns').map(function (s) { return cmdRe(s); });
  t.unknowable = ah.cfg('command.write_target_unknowable');
  t.classifyPushSubs = cmdSet('command.classify_push_subs'); t.classifyPullSubs = cmdSet('command.classify_pull_subs');
  t.stashReadSubs = cmdSet('command.stash_read_subs'); t.stashMutatingSubs = cmdSet('command.stash_mutating_subs');
  t.pluginWalkLevels = ah.cfgNum('command.plugin_walk_levels'); t.pluginManifestRel = ah.cfg('command.plugin_manifest_rel'); t.pluginName = ah.cfg('command.plugin_name');
  t.gitBranchArgv = ah.cfg('command.git_branch_argv'); t.gitTimeout = ah.cfgNum('command.git_timeout_ms'); t.gitStatusTimeout = ah.cfgNum('command.git_status_timeout_ms');
  t.gcloudSinkVerbs = cmdSet('command.gcloud_sink_verbs');
  // The settings the script reads by section and key (`settings.get(section, key)` of the Node hooks): each entry's own section and key say
  // which setting it is.
  t.settings = {};
  SETTING_KEYS.forEach(function (k) { var e = ah.cfg(k); t.settings[e.section + '.' + e.key] = k; });
  return t;
}

var parseHeredocAt = shellScan.parseHeredocAt;

function extractSubstitutionsJs(s) {
  const found = [];
  let i = 0;
  const n = s.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = s[i];
    const c2 = i + 1 < n ? s[i + 1] : '';
    if (!inSingle && !inDouble && c === '<' && c2 === '<') {
      const parsed = parseHeredocAt(s, i);
      if (parsed) {
        if (parsed.quoted) {
          i = parsed.end;
        } else {
          i = i + parsed.openerText.length;
          if (i < n && s[i] === '\n') i++;
        }
        continue;
      }
    }
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (!inDouble && c === '$' && c2 === "'") {
      i += 2;
      while (i < n && s[i] !== "'") i += s[i] === '\\' ? 2 : 1;
      i++; continue;
    }
    if (!inDouble && c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = !inDouble; i++; continue; }
    if (c === '$' && c2 === '(') {
      let depth = 1; let j = i + 2; let inner = [];
      while (j < n && depth > 0) {
        const cj = s[j];
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        inner.push(cj); j++;
      }
      if (inner.join('').trim()) found.push(inner.join(''));
      i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let inner = [];
      while (j < n && s[j] !== '`') { inner.push(s[j]); j++; }
      if (inner.join('').trim()) found.push(inner.join(''));
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

// The reference walk: scannersReference runs it next to the native splitter on the same input.
function splitSegmentsDetailedJs(cmd) {
  const segments = [];
  const delims = [];
  let cp = []; // chunks of the current segment, joined only when read (one growing string is reallocated per character)
  const cs = () => { if (cp.length > 1) cp = [cp.join('')]; return cp.length ? cp[0] : ''; };
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;
  // Shell-comment tracking. `nest` holds the open `(`/`{` (incl. `$(`, `$((`,
  // `${`) and `inTick` backtick state; `escEnd` is the index just past the
  // last backslash escape / line continuation (so `\ #` or `a\<nl>#` is
  // mid-word, not a comment).
  const nest = [];
  let inTick = false;
  let escEnd = -1;

  function flush(delim) {
    const cur = cs();
    if (cur.trim().length) { segments.push(cur); delims.push(delim); }
    cp = [];
  }

  let heredoc = null; // the pending heredoc whose body starts after its opener line

  while (i < n) {
    if (heredoc && i >= heredoc.lineEnd) {
      // End of the opener line: the heredoc closes the logical command.
      flush('heredoc');
      i = Math.max(i, heredoc.end);
      heredoc = null;
      inSingle = false;
      inDouble = false;
      continue;
    }
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';

    if (inSingle) { cp.push(c); if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cp.push(c + c2); i += 2; continue; }
      cp.push(c); if (c === '"') inDouble = false; i++; continue;
    }
    // ANSI-C `$'…'`: unlike plain '…', a backslash escapes the next char, so
    // `\'` does NOT close it. Reading it as plain '…' closed early at `\'`
    // and re-opened at the real closer, hiding `; go build` inside a fake
    // quoted span (`$'a\' # '; go build`).
    if (c === '$' && c2 === "'") {
      let j = i + 2;
      while (j < n && cmd[j] !== "'") j += cmd[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      cp.push(cmd.slice(i, j)); i = j; continue;
    }
    if (c === "'") { inSingle = true; cp.push(c); i++; continue; }
    if (c === '"') { inDouble = true; cp.push(c); i++; continue; }

    // Line continuation: backslash-newline joins lines.
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) {
      cp.push(' '); i += (c2 === '\r') ? 3 : 2; escEnd = i; continue;
    }
    // Outside quotes a backslash escapes the NEXT character: `\"`/`\'` are
    // literal quote chars (no quote state change) and `\;`/`\|`/`\&` are
    // literal, not operators — exactly as bash reads them. Without this,
    // `git commit -m \" ; npm test ; echo \"` looked like ONE quoted arg to
    // the splitter while bash runs `npm test` as its own command.
    if (c === '\\' && c2) { cp.push(c + c2); i += 2; escEnd = i; continue; }

    // Shell comment: an unquoted `#` that STARTS A WORD (start of input, or
    // right after unescaped whitespace or `;` `&` `|`) runs to the next newline
    // and is never executed — drop it so its text (`# 1) go to x`) is not
    // split into bogus segments. Recognized ONLY at nesting depth 0 and outside
    // backticks: inside `${x:- #}`, `(( 2 #))` and backticks bash does NOT
    // treat `#` as a comment past the closer (verified), so stripping there
    // could hide a real command; staying literal is the strict fallback. `)`
    // is deliberately not a word start (`$(echo a)#b` is the word `a#b`).
    // Mid-word `#` (`a#b`, `$#`, `${#x}`, `x=#`) stays code. The newline that
    // ends the comment is left for the normal `\n` split below.
    if (c === '#' && !nest.length && !inTick && escEnd !== i &&
        (i === 0 || RX27.test(cmd[i - 1]))) {
      const nl = cmd.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }

    // Heredoc: the operator word stays on the current segment and the rest of
    // the opener line is split as usual (`cat <<EOF | git commit -F -` is two
    // segments); at that line's newline the BODY (up to and including the
    // terminator line) is skipped without emitting segments. A second `<<` on
    // the same line is left as text (its body is not skipped: stricter).
    if (c === '<' && c2 === '<' && !heredoc) {
      const parsed = parseHeredocAt(cmd, i);
      if (parsed) {
        cp.push(cmd.slice(i, parsed.openerEnd));
        i = parsed.openerEnd;
        if (parsed.lineEnd !== undefined) heredoc = parsed;
        continue;
      }
    }

    if (c === '&' && c2 === '&') { flush('&&'); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush('||'); i += 2; continue; }
    if (c === '|') { flush('|'); i++; continue; }
    if (c === ';') { flush(';'); i++; continue; }
    // A redirection `&` is NOT a background separator: fd-dup `2>&1` / `>&2` /
    // `<&3` (unescaped `>`/`<` right before) and `&>file` / `&>>file`. Treating
    // it as `&` split `x 2>&1 | tail` into `x 2>` / `1 | tail`, losing the pipe.
    // `escEnd !== i` keeps `\>&` (literal `>` then a real `&`) a separator.
    if (c === '&' && ((escEnd !== i && (cmd[i - 1] === '>' || cmd[i - 1] === '<')) || c2 === '>')) {
      cp.push(c); i++; continue;
    }
    if (c === '&') { flush('&'); i++; continue; }
    if (c === '\n') { flush('\n'); i++; continue; }
    // Subshell / grouping / command-substitution boundaries -> segment splits.
    if (c === ')' || c === '(' || c === '{' || c === '}') {
      if (c === '(' || c === '{') nest.push(c);
      else if (nest.length && nest[nest.length - 1] === (c === ')' ? '(' : '{')) nest.pop();
      flush('group'); i++; continue;
    }
    if (c === '$' && c2 === '(') { nest.push('('); flush('subst'); i += 2; continue; }
    if (c === '`') { inTick = !inTick; flush('subst'); i++; continue; }
    // `$[ … ]` (legacy arithmetic) is a nesting context too: a `#` inside it
    // is not a comment, so it must not be stripped as one.
    if (c === '$' && c2 === '[') { nest.push('['); cp.push('$['); i += 2; continue; }
    if (c === '[' && nest.length && nest[nest.length - 1] === '[') nest.push('[');
    else if (c === ']' && nest.length && nest[nest.length - 1] === '[') nest.pop();

    cp.push(c);
    i++;
  }
  flush('end');
  return { segments, delims };
}

function closedSinkTokens(t) {
  if (!t.length) return false;
  const rest = t.slice(1);
  if (t[0] === 'head' || t[0] === 'tail') {
    if (rest.length === 0) return true;
    if (rest.length === 1) return RX39.test(rest[0]);
    if (rest.length === 2) return (rest[0] === '-n' || rest[0] === '-c') && RX40.test(rest[1]);
    return false;
  }
  if (t[0] === 'wc') return rest.every((a) => RX41.test(a));
  if (t[0] === 'grep') {
    // Bounded by -c or -m N; match-mode flags from a closed set; exactly one
    // non-flag operand (the pattern). No -f/-e/-r/-R/--include/--file: nothing
    // that names a file or a second pattern source.
    let bounded = false;
    let pattern = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-c') { bounded = true; continue; }
      if (a === '-m') {
        if (!RX42.test(rest[i + 1] || '')) return false;
        bounded = true; i++; continue;
      }
      if (RX43.test(a)) continue;
      if (a.startsWith('-')) return false;
      pattern++;
    }
    return bounded && pattern === 1;
  }
  return false;
}

// hasUnquotedRedirectChar(segment) -> true if a bare (unquoted) '>' or '<'
// appears anywhere — the per-project allowlist bans ANY redirect regardless
// of destination (unlike the narrow-allow carve-out above, which only cares
// about the destination path), since the whole point is running the
// project's declared command EXACTLY, never a redirected variant of it.
function hasUnquotedRedirectChar(segment) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const c2 = i + 1 < segment.length ? segment[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === '\\' && c2) { i++; continue; } // outside quotes: escaped char is literal
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '>' || c === '<') return true;
  }
  return false;
}

// A bare remote/ref token: no leading '-' or '+' (rules out every flag and
// force-refspec form), and no ':' anywhere (rules out `src:dst`/delete
// refspecs) — enforced by the character class simply never including ':'.
// The (up to two) flag slots right after `push` match ONLY `-q`/`--quiet`/
// `-u`/`--set-upstream` verbatim (not a character class), so `--force`/`-f`/anything else there
// still fails the whole regex, same as before this carve-out was widened.
const PLAIN_PUSH_SEGMENT_RE = /^git\s+push(?:\s+(-q|--quiet|-u|--set-upstream))?(?:\s+(-q|--quiet|-u|--set-upstream))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+(?::[A-Za-z0-9_.\/-]+)?))?\s*$/;

// (d) A trailing `2>&1` (stderr merged into stdout) - no other redirect.
const TRAILING_STDERR_MERGE_RE = /\s+2>&1\s*$/;

// Trailing read-only segments (c) — only ever consulted AFTER a push segment
// has already appeared in the chain (enforced in isAllowedPlainPushChain,
// not here). Each is an exact, narrow shape: no other flags, no redirects
// (redirect/substitution characters are already rejected by
// classifyPlainGitChainSegment before these run).
const PLAIN_LOG_SEGMENT_RE = /^git\s+log\s+--oneline(?:\s+-\d+)?\s*$/;

const PLAIN_STATUS_SEGMENT_RE = /^git\s+status(?:\s+(?:--short|-s))?\s*$/;

const PLAIN_SHOW_SEGMENT_RE = /^git\s+show\s+--stat(?:\s+(?:-\d+|HEAD))?\s*$/;

// Post-push verification reads: `git ls-remote [--heads] <remote> [<ref>]` and
// `git rev-parse [--short] <HEAD|ref>`. Bare tokens only (no flag other than
// the one listed, no `:`/`+`); the ls-remote remote must be a configured name.
const PLAIN_LSREMOTE_SEGMENT_RE = /^git\s+ls-remote(?:\s+--heads)?\s+((?![-+])[A-Za-z0-9_.\/-]+)(?:\s+(?![-+])[A-Za-z0-9_.\/-]+)?\s*$/;

const PLAIN_REVPARSE_SEGMENT_RE = /^git\s+rev-parse(?:\s+--short)?\s+(?![-+])[A-Za-z0-9_.\/-]+\s*$/;

// hasSubstitutionOutsideSingleQuotes(segment) -> true if a `` ` `` or `$(`
// appears anywhere the shell would actually EXPAND it — i.e. outside single
// quotes (double quotes still expand command substitution; only single
// quotes make it literal). This is what keeps `git commit -m "$(evil)"` out
// of the allow-chain even though it is still a single, unbroken `git commit`
// segment by the plain chain-delimiter check alone.
function hasSubstitutionOutsideSingleQuotes(segment) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const c2 = i + 1 < segment.length ? segment[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { i++; continue; }
      if (c === '"') { inDouble = false; continue; }
      if (c === '`') return true;
      if (c === '$' && c2 === '(') return true;
      continue;
    }
    if (c === '\\' && c2) { i++; continue; } // outside quotes: escaped char is literal
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') return true;
    if (c === '$' && c2 === '(') return true;
  }
  return false;
}

// classifyPlainGitChainSegment(segment) -> {kind:'add'|'commit'} |
// {kind:'push', remote, ref} | {kind:'log'|'status'|'show'} | null.
// `remote`/`ref` are the (post-quiet-flag) first/second bare tokens of a
// plain push (null when omitted).
function classifyPlainGitChainSegment(segment) {
  const trimmed = segment.trim().replace(TRAILING_STDERR_MERGE_RE, '');
  if (hasUnquotedRedirectChar(trimmed)) return null;
  if (hasSubstitutionOutsideSingleQuotes(trimmed)) return null;
  if (RX86.test(trimmed)) return { kind: 'add' };
  if (RX87.test(trimmed)) return { kind: 'commit' };
  const m = trimmed.match(PLAIN_PUSH_SEGMENT_RE);
  if (m) {
    // A1-6: with NO explicit remote token, git parses the sole positional
    // argument as the <repository> (remote), not a refspec — real git syntax
    // is `git push [<repository> [<refspec>...]]`, so a lone `SRC:DST`-shaped
    // token is only ever a refspec when an explicit remote token precedes it.
    // A colon-bearing token with no remote group is a scp-like remote URL
    // (`host:path`) to git, however ref-shaped it looks (e.g. a branch named
    // to look like a host: `git push evil.com:refs/heads/evil.com` passes
    // isPlainPushRefAllowed's SRC===DST===<current branch> check while git
    // itself pushes over ssh to host `evil.com`). Reject the segment outright
    // rather than let isPlainPushRefAllowed's ref-shaped check vouch for it.
    if (m[4] && m[4].indexOf(':') !== -1 && !m[3]) return null;
    // `-u`/`--set-upstream` is the ONLY upstream flag accepted, and only with
    // BOTH an explicit remote and an explicit ref (`git push -u origin
    // <branch>`) - a bare `git push -u`/`-u origin` never qualifies. Remote/ref
    // are then vetted exactly like the plain form. It shares the single flag
    // slot, so `-q -u`/`-u -q`/`-uf` never match the regex.
    const upstream = [m[1], m[2]].some((f) => f === '-u' || f === '--set-upstream');
    if (upstream && !(m[3] && m[4])) return null;
    return { kind: 'push', remote: m[3] || null, ref: m[4] || null };
  }
  if (PLAIN_LOG_SEGMENT_RE.test(trimmed)) return { kind: 'log' };
  if (PLAIN_STATUS_SEGMENT_RE.test(trimmed)) return { kind: 'status' };
  if (PLAIN_SHOW_SEGMENT_RE.test(trimmed)) return { kind: 'show' };
  const lr = trimmed.match(PLAIN_LSREMOTE_SEGMENT_RE);
  if (lr) return { kind: 'lsremote', remote: lr[1] };
  if (PLAIN_REVPARSE_SEGMENT_RE.test(trimmed)) return { kind: 'revparse' };
  return null;
}

// Shape C's curl segment. `tokenVar` is the variable the token was assigned
// to; `$T`/`${T}` may appear ONLY as `Authorization: Bearer $T`.
// The token may only ever reach Google: the URL's PARSED host must be
// googleapis.com or a subdomain of it — no userinfo, no IP literal, no other
// host. Redirect-following (-L), --resolve/--connect-to, proxies (-x),
// --url and -K/--config are refused by the flag allowlist below (every flag
// not listed is refused).
const GOOGLEAPIS_HOST_RE = /(^|\.)googleapis\.com$/;

function isGoogleApisHttpsUrl(raw) {
  // The RAW host text must already be plain ASCII and identical to what the
  // URL parser yields — no percent-encoding, IDN/full-width lookalikes or
  // curl URL globbing ({a,b} / [1-2]) that curl could expand differently.
  if (RX94.test(raw)) return false;
  const rawHost = (raw.match(RX95) || [])[1] || '';
  if (!RX96.test(rawHost)) return false;
  // `new URL(raw)` is not available here: an IDNA label is validated by the URL parser in ways this check does not reproduce, and
  // a port that is not empty digits up to the maximum makes the parser throw
  if (rawHost.split('.').some((l) => l.length >= 4 && l.slice(0, 4).toLowerCase() === 'xn--')) { ah.unable('command:idna_host'); return false; } // an IDNA label is not provably a Google API host: refused
  const afterHost = raw.slice('https://'.length + rawHost.length);
  if (afterHost.charAt(0) === ':') {
    const pm = RX97.exec(afterHost);
    const port = pm ? pm[1] : '';
    if (!RX98.test(port) || (port !== '' && port.replace(RX99, '').length > ah.cfgNum('command.port_digits_max')) || Number(port) > ah.cfgNum('command.port_max')) return false;
  }
  const u = { hostname: rawHost.toLowerCase(), protocol: 'https:', username: '', password: '' };
  if (u.hostname.toLowerCase() !== rawHost.toLowerCase()) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || raw.includes('@')) return false;
  const host = u.hostname.toLowerCase();
  if (!host || host.startsWith('[') || RX100.test(host)) return false; // IP literal
  return GOOGLEAPIS_HOST_RE.test(host);
}

function maskProcessSubstitutionsRaw(cmd) {
  const inners = [];
  let out = [];
  let i = 0;
  let q = '';
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) { out.push(c + cmd[i + 1]); i += 2; continue; }
      out.push(c); if (c === q) q = ''; i++; continue;
    }
    if (c === '\\' && i + 1 < n) { out.push(c + cmd[i + 1]); i += 2; continue; }
    if (c === "'" || c === '"') { q = c; out.push(c); i++; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      const h = parseHeredocAt(cmd, i);
      if (h) { out.push(cmd.slice(i, h.end)); i = h.end; continue; }
    }
    if ((c === '<' || c === '>') && cmd[i + 1] === '(') {
      let j = i + 2;
      let depth = 1;
      let qq = '';
      for (; j < n && depth; j++) {
        const d = cmd[j];
        if (qq) { if (d === qq) qq = ''; continue; }
        if (d === "'" || d === '"') qq = d;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
      inners.push(cmd.slice(i + 2, depth ? j : j - 1));
      out.push(' ');
      i = j;
      continue;
    }
    out.push(c); i++;
  }
  return { text: out.join(''), inners };
}

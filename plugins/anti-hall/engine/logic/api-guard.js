// check = "api-guard" (PreToolUse on Write, Edit, MultiEdit, Bash; apply_patch for Codex). Answers `allow` exactly when the
// Node guard exits 0 without probing an interpreter, else `defer` (Node resolves module attributes against the real runtime).
// Mirrors hooks/api-guard.js `main`, `newCodeChunks`, `langFor`, `pyCandidates`, `jsCandidates` (as conservative supersets).
// Every list, pattern, tool name and setting lives in engine/defaults/small_guards.toml (api_guard.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// `value || ''` in JavaScript; null for an array or object (their string form is not reproduced: Node decides).
function jsPath(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return '';
  if (typeof v === 'object') return null;
  return String(v);
}

function langFor(fp) {
  var m = new RegExp(ah.cfg('api_guard.extension_pattern'), 'i').exec(fp);
  if (!m) return null;
  var ext = m[1].toLowerCase();
  if (ah.cfg('api_guard.python_extensions').indexOf(ext) >= 0) return 'py';
  if (ah.cfg('api_guard.js_extensions').indexOf(ext) >= 0) return 'js';
  return null;
}

// The maximal runs of ASCII letters, digits and underscore in `code`.
function wordSet(code) {
  var set = new Set(), runs = code.match(/[A-Za-z0-9_]+/g) || [];
  for (var i = 0; i < runs.length; i++) set.add(runs[i]);
  return set;
}

function pyMayVerify(code, thirdparty) {
  var words = wordSet(code);
  return words.has(ah.cfg('api_guard.python_import_word')) &&
    (thirdparty || ah.cfg('api_guard.python_stdlib').some(function (m) { return words.has(m); }));
}

function jsMayVerify(code, thirdparty) {
  if (ah.cfg('api_guard.js_globals').some(function (g) { return code.indexOf(g + '.') >= 0; })) return true;
  return code.indexOf(ah.cfg('api_guard.js_require_word')) >= 0 &&
    (thirdparty || ah.cfg('api_guard.node_builtins').some(function (m) { return code.indexOf(m) >= 0; }));
}

// True when the command text could carry a reference pyMayVerify or jsMayVerify accept in the code a shell write builds from it.
// The text is reduced to its word characters, so quote removal and escape decoding cannot hide a word, and the words are
// tested as substrings (a superset of the Node tests, which look at whole words).
function textMayVerify(c, thirdparty) {
  var t = c.replace(new RegExp(ah.cfg('api_guard.noise_pattern'), 'g'), '');
  var hasMod = function (list) { return list.some(function (m) { return t.indexOf(m) >= 0; }); };
  if (t.indexOf(ah.cfg('api_guard.python_import_word')) >= 0 && (thirdparty || hasMod(ah.cfg('api_guard.python_stdlib')))) return true;
  if (ah.cfg('api_guard.js_globals').some(function (g) { return t.indexOf(g + '.') >= 0; })) return true;
  return t.indexOf(ah.cfg('api_guard.js_require_word')) >= 0 && (thirdparty || hasMod(ah.cfg('api_guard.node_builtins')));
}

function editCodes(tool, ti) {
  var str = function (v) { return typeof v === 'string' ? [v] : []; };
  if (tool === ah.cfg('api_guard.tool_write')) return isObj(ti) ? str(ti.content) : [];
  if (tool === ah.cfg('api_guard.tool_edit')) return isObj(ti) ? str(ti.new_string) : [];
  if (!isObj(ti) || !Array.isArray(ti.edits)) return [];
  var out = [];
  ti.edits.forEach(function (e) { if (isObj(e) && typeof e.new_string === 'string') out.push(e.new_string); });
  return out;
}

function decide(p) {
  if (!ah.settings.bool('api_guard.setting') || ah.settings.skipped(ah.cfg('api_guard.guard_name'))) return 'allow';
  var tool = isObj(p) ? p.tool_name : undefined;
  if (typeof tool !== 'string') return 'allow';
  var ti = (p.tool_input === undefined || p.tool_input === null || p.tool_input === false) ? null : p.tool_input;
  var is = function (k) { return tool === ah.cfg(k); };
  if (is('api_guard.tool_shell') || is('api_guard.tool_patch')) {
    // a shell write's visible text, or a patch's added lines: judged by Node. Only a command that names no code file (or,
    // for Bash, a switch that is off) is certainly a silent allow here.
    if (is('api_guard.tool_shell') && !ah.settings.bool('api_guard.shell_setting')) return 'allow';
    var c = isObj(ti) ? ti.command : undefined;
    if (c === undefined || c === null) return 'allow';
    if (typeof c === 'string' && !ah.re.test(ah.cfg('api_guard.code_name_pattern'), 'i', c)) return 'allow';
    // Bash: Node reads code only from a command its pre-filter says may write a file, and the code is built from the command
    // text (heredoc body, echo/printf arguments), so a verifiable reference needs its words in the text.
    if (is('api_guard.tool_shell') && typeof c === 'string') {
      if (!new RegExp(ah.cfg('api_guard.shell_write_pattern')).test(c)) return 'allow';
      if (!textMayVerify(c, ah.settings.bool('api_guard.thirdparty_setting'))) return 'allow';
    }
    return 'defer';
  }
  if (!(is('api_guard.tool_write') || is('api_guard.tool_edit') || is('api_guard.tool_multi'))) return 'allow';
  var codes = editCodes(tool, ti);
  if (codes.length === 0) return 'allow';
  var fp = jsPath(isObj(ti) ? ti.file_path : undefined);
  if (fp === null) return 'defer';
  var lang = langFor(fp);
  if (lang === null) return 'allow';
  var third = ah.settings.bool('api_guard.thirdparty_setting');
  var may = lang === 'py' ? pyMayVerify : jsMayVerify;
  return codes.some(function (c) { return may(c, third); }) ? 'defer' : 'allow';
}

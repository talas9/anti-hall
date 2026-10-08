// check = "ship-it-guard" (PreToolUse on Write, Edit, MultiEdit, NotebookEdit; Bash and apply_patch defer to Node).
// Opt-in plan gate: blocks an edit of a hard-risk file when the repo has no PLAN.md, and advises on a code file that no
// phase of the plan declares. Mirrors hooks/ship-it-guard.js. Every pattern, list and message is in
// engine/defaults/small_guards.toml (ship_it.*); this file is only the decision.
'use strict';

function isNonCode(fp) {
  var base = ah.path.basename(fp).toLowerCase();
  return base === ah.cfg('ship_it.non_code_name') || ah.re.test(ah.cfg('ship_it.non_code_ext'), 'i', base) ||
    ah.re.test(ah.cfg('ship_it.non_code_test_file'), 'i', base) || ah.re.test(ah.cfg('ship_it.non_code_test_dir'), 'i', fp);
}

function isHardRisk(fp) {
  var norm = fp.split('\\').join('/');
  return ah.cfg('ship_it.hard_risk').some(function (src) { return ah.re.test(src, 'i', norm) || ah.re.test(src, 'i', fp); });
}

// The token separator class (white space plus the configured separators), built once per separator list.
var sepMemo = { seps: null, re: null };
function sepRe(seps) {
  if (sepMemo.seps !== seps) sepMemo = { seps: seps, re: new RegExp('[\\s' + seps.replace(/[\\\]^-]/g, '\\$&') + ']') };
  return sepMemo.re;
}

function isAsciiAlnum(c) {
  var k = c.length === 1 ? c.charCodeAt(0) : -1;
  return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
}

// Path-like tokens of a `files:` value: list dashes at line starts dropped, split on white space and separators.
function extractPathTokens(t) {
  var chars = Array.from(t), cleaned = '', i = 0;
  var lineStart = function (k) { if (k === 0) return true; var c = chars[k - 1]; return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'; };
  while (i < chars.length) {
    if (lineStart(i)) {
      var j = i;
      while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) j++;
      if (j < chars.length && chars[j] === '-') {
        j++;
        while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) j++;
        cleaned += ' ';
        i = j;
        continue;
      }
    }
    cleaned += chars[i];
    i++;
  }
  var seps = ah.cfg('ship_it.token_separators'), trim = ah.cfg('ship_it.token_trim'), extMax = ah.cfgNum('ship_it.token_ext_max');
  var out = [];
  var sep = sepRe(seps);
  cleaned.split(sep).forEach(function (tok) {
    if (!tok) return;
    if (tok.charAt(0) === '.' && tok.charAt(1) === '/') tok = tok.slice(1).replace(/^\/+/, '');
    var e = tok.length;
    while (e > 0 && trim.indexOf(tok.charAt(e - 1)) >= 0) e--;
    tok = tok.slice(0, e);
    if (!tok) return;
    var run = 0;
    while (run < tok.length && isAsciiAlnum(tok.charAt(tok.length - 1 - run))) run++;
    var dotted = run >= 1 && run <= extMax && tok.charAt(tok.length - run - 1) === '.';
    if (tok.indexOf('/') >= 0 || dotted) out.push(tok.split('\\').join('/'));
  });
  return out;
}

// The files the plan's phases declare, or null when the plan has no phase or declares nothing.
function parsePlanDeclaredFiles(plan) {
  if (!plan) return null;
  var head = ah.re.find(ah.cfg('ship_it.phases_head'), 'i', plan);
  if (!head) return null;
  var after = plan.slice(head[1]);
  var endM = ah.re.find(ah.cfg('ship_it.phases_end'), '', after);
  var end = endM ? head[1] + endM[0] : plan.length;
  var block = plan.slice(head[0], end);
  var sections = [], from = 0;
  ah.re.findAll(ah.cfg('ship_it.phase_split'), '', block).forEach(function (m) { sections.push(block.slice(from, m[0])); from = m[0] + 1; });
  sections.push(block.slice(from));
  var declared = new Set(), phases = 0;
  sections.filter(function (s) { return ah.re.test(ah.cfg('ship_it.phase_head'), '', s); }).forEach(function (section) {
    phases++;
    var h = ah.re.find(ah.cfg('ship_it.files_head'), 'i', section);
    if (!h) return;
    var rest = section.slice(h[1]);
    var fe = ah.re.find(ah.cfg('ship_it.files_end'), 'i', rest);
    extractPathTokens(rest.slice(0, fe ? fe[0] : rest.length)).forEach(function (t) { declared.add(t); });
  });
  return phases === 0 || declared.size === 0 ? null : declared;
}

function fileMatchesDeclared(file, declared, cwd) {
  if (!file) return false;
  var abs = file.split('\\').join('/'), rel = abs;
  if (ah.path.isAbsolute(file) && cwd) {
    var r = ah.path.relative(cwd, file);
    if (r && r.slice(0, 2) !== '..') rel = r.split('\\').join('/');
  }
  var ends = function (s, suf) { return s.length >= suf.length && s.slice(s.length - suf.length) === suf; };
  return Array.from(declared).some(function (tok) {
    return tok && (abs === tok || rel === tok || ends(abs, '/' + tok) || ends(rel, '/' + tok) || ends(tok, '/' + rel) || ends(tok, '/' + abs));
  });
}

function targetPaths(ti) {
  var out = [];
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return out;
  if (typeof ti.file_path === 'string') out.push(ti.file_path);
  if (Array.isArray(ti.edits)) ti.edits.forEach(function (e) { if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.file_path === 'string') out.push(e.file_path); });
  return out;
}

function decideInner(p) {
  var guard = ah.cfg('ship_it.guard_name');
  if (ah.settings.skipped(guard) || !ah.settings.bool('ship_it.setting')) return null;
  var tool = p && typeof p === 'object' && !Array.isArray(p) ? p.tool_name : undefined;
  if (typeof tool === 'string' && ah.cfg('ship_it.deferred_tools').indexOf(tool) >= 0) return 'defer';
  var files = targetPaths(p && typeof p === 'object' && !Array.isArray(p) ? p.tool_input : undefined);
  var code = files.filter(function (f) { return !isNonCode(f); });
  if (code.length === 0) return null;
  var cwd = p.cwd;
  if (typeof cwd !== 'string' || !ah.path.isAbsolute(cwd)) return 'defer';
  var planPath = ah.path.join(cwd, ah.cfg('ship_it.plan_file'));
  var planExists = ah.fs.isFile(planPath);
  var risky = code.filter(isHardRisk);
  if (risky.length && !planExists) {
    return {
      block: text.message('block', guard, {
        what: text.render(ah.cfg('ship_it.msg_block_what'), { file: risky[0] }), why: ah.cfg('ship_it.msg_block_why'),
        instead: ah.cfg('ship_it.msg_block_instead'), override: ah.cfg('ship_it.msg_block_override'),
      }),
    };
  }
  if (!planExists) return null;
  var plan = ah.fs.readText(planPath) || '';
  var declared = parsePlanDeclaredFiles(plan);
  if (!declared) return null;
  var shown = code.filter(function (f) { return !fileMatchesDeclared(f, declared, cwd); })[0];
  if (shown === undefined) return null;
  var t = text.message('warn', guard, {
    what: text.render(ah.cfg('ship_it.msg_adv_what'), { file: shown, plan: planPath }), why: ah.cfg('ship_it.msg_adv_why'), instead: ah.cfg('ship_it.msg_adv_instead'),
  });
  return { advisory: text.advisoryJson('PreToolUse', t) };
}

function decide(p) { var v = decideInner(p); return v === null ? 'allow' : v; }

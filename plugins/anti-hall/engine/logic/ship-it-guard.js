// check = "ship-it-guard" (PreToolUse on Write, Edit, MultiEdit, NotebookEdit; Bash and apply_patch for Codex).
// Opt-in plan gate: blocks an edit of a hard-risk file when the repo has no PLAN.md, and advises on a code file that no
// phase of the plan declares (structured edits only). A Bash write's targets come from command-guard's shell parsers
// (script.includes: command, shell-writes), a Codex patch's from lib/77-apply-patch.js. Mirrors hooks/ship-it-guard.js. Every
// pattern, list and message is in engine/defaults/small_guards.toml (ship_it.*); this file is only the decision.
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

// The files the call writes: [files, kind] with kind 'edit', 'shell' or 'patch'; null when the shell-write switch is off.
function writeTargets(p, cwdAbs) {
  var tool = p.tool_name, ti = p.tool_input;
  if (tool === ah.cfg('api_guard.tool_shell')) {
    if (!ah.settings.bool('api_guard.shell_setting')) return null;
    var command = ti && ti.command;
    var realCwd = LIB['./lib/scratchpad.js'].realpathOrSelf(cwdAbs);
    var ws = swShellWrites(command, Object.assign({}, p, { cwd: cwdAbs }));
    if (S && S.unsure) { ah.log('ship_it_unsure', 'shell-write parse needed the hook process; parsed targets kept'); S.unsure = false; }
    return [ws.filter(function (w) { return !w.scratch; }).map(function (w) {
      var rel = ah.path.relative(realCwd, w.abs);
      return rel && rel.slice(0, 2) !== '..' && !ah.path.isAbsolute(rel) ? rel : w.abs;
    }), 'shell'];
  }
  if (tool === ah.cfg('api_guard.tool_patch')) {
    var parsed = applyPatch.parse(ti && ti.command);
    return [parsed.ok ? applyPatch.targetPaths(parsed.files, cwdAbs) : [], 'patch'];
  }
  return [targetPaths(ti), 'edit'];
}

function decideInner(p) {
  var guard = ah.cfg('ship_it.guard_name');
  if (p === undefined) return null;
  if (ah.settings.skipped(guard) || !ah.settings.bool('ship_it.setting')) return null;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) p = {};
  // `payload.cwd` as given (a string, even empty or relative), else the hook process's own; the files are read at its absolute form
  var cwd = typeof p.cwd === 'string' ? p.cwd : hookProc.cwd(p);
  var cwdAbs = cwd === '' ? hookProc.base() : ah.path.isAbsolute(cwd) ? cwd : ah.path.resolveAbs(hookProc.base() + '/' + cwd);
  var t = writeTargets(p, cwdAbs);
  if (t === null) return null;
  var files = t[0], kind = t[1];
  if (!files.length) return null;
  var code = files.filter(function (f) { return !isNonCode(f); });
  if (code.length === 0) return null;
  // findPlanPath(cwd): no plan for an empty cwd; the path is shown as Node joins it
  var planPath = cwd === '' ? '' : ah.path.join(cwd, ah.cfg('ship_it.plan_file'));
  var planAbs = cwd === '' ? '' : ah.path.join(cwdAbs, ah.cfg('ship_it.plan_file'));
  var planExists = planAbs !== '' && ah.fs.isFile(planAbs);
  var risky = code.filter(isHardRisk);
  if (risky.length && !planExists) {
    return {
      block: text.message('block', guard, {
        what: text.render(ah.cfg('ship_it.msg_block_what'), { file: risky[0] }), why: ah.cfg('ship_it.msg_block_why'),
        instead: ah.cfg('ship_it.msg_block_instead'), override: ah.cfg('ship_it.msg_block_override'),
      }),
    };
  }
  if (!planExists || kind !== 'edit') return null;
  var plan = ah.fs.readText(planAbs) || '';
  var declared = parsePlanDeclaredFiles(plan);
  if (!declared) return null;
  var shown = code.filter(function (f) { return !fileMatchesDeclared(f, declared, cwd === '' ? '' : cwdAbs); })[0];
  if (shown === undefined) return null;
  var adv = text.message('warn', guard, {
    what: text.render(ah.cfg('ship_it.msg_adv_what'), { file: shown, plan: planPath }), why: ah.cfg('ship_it.msg_adv_why'), instead: ah.cfg('ship_it.msg_adv_instead'),
  });
  return { advisory: text.advisoryJson('PreToolUse', adv) };
}

function decide(p, opts) {
  cmdBegin(opts);
  var v;
  // the Node guard fails open on any internal error; the time and memory limits still reach the engine
  try { v = decideInner(p); } catch (e) { if (cmdFatal(e) && !e.unsure) throw e; v = null; }
  cmdEnd();
  return v === null ? 'allow' : v;
}

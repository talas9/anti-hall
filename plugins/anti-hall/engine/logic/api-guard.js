// check = "api-guard" (PreToolUse on Write, Edit, MultiEdit, Bash; apply_patch for Codex). Blocks a write whose code references
// a `module.attribute` the installed runtime does not have (a fabricated API): it extracts the references the way
// hooks/api-guard.js does (`newCodeChunks`, `pyCandidates`, `jsCandidates`) and probes the user's own python3 / node, found on the
// request's PATH, through the bounded host spawn primitive (`ahHost.spawnProbe`; never the plugin's runtime, never a shell). A
// missing interpreter, a failed or timed-out probe and anything unparsable fail open, as the Node guard does; a timed-out probe
// says so on stderr. Bash writes go through command-guard's shell parsers (script.includes: command, shell-writes) and Codex
// patches through the shared parser (lib/77-apply-patch.js). Lists, settings and the tool names are in
// engine/defaults/small_guards.toml (api_guard.*); limits, the probe interpreters and every text in guards_v1.toml (api_guard_v1.*).
'use strict';

function agIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function agCfg(k) { return ah.cfg('api_guard_v1.' + k); }

function agThird() { return ah.settings.bool('api_guard.thirdparty_setting'); }

function agLangFor(fp) {
  var m = new RegExp(ah.cfg('api_guard.extension_pattern'), 'i').exec(fp || '');
  if (!m) return null;
  var ext = m[1].toLowerCase();
  if (ah.cfg('api_guard.python_extensions').indexOf(ext) >= 0) return 'py';
  if (ah.cfg('api_guard.js_extensions').indexOf(ext) >= 0) return 'js';
  return null;
}

// ---- reference extraction (hooks/api-guard.js, unchanged rules) ----

function agStripPy(code) {
  return code.replace(/#.*$/gm, '').replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}
function agStripJsComments(code) { return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' '); }
function agStripJs(code) { return agStripJsComments(code).replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' '); }

function agPyBound(src) {
  var bound = new Set(), m;
  var reAssign = /^[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/gm;
  while ((m = reAssign.exec(src))) bound.add(m[1]);
  var reDef = /\b(?:def|class)[ \t]+([A-Za-z_]\w*)/g;
  while ((m = reDef.exec(src))) bound.add(m[1]);
  var reFor = /\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/g;
  while ((m = reFor.exec(src))) bound.add(m[1]);
  var params = function (list) {
    list.split(',').forEach(function (part) { var pm = /^[ \t*]*([A-Za-z_]\w*)/.exec(part); if (pm) bound.add(pm[1]); });
  };
  var reDefParams = /\bdef[ \t]+\w+[ \t]*\(([^)]*)\)/g;
  while ((m = reDefParams.exec(src))) params(m[1]);
  var reLambda = /\blambda[ \t]+([^:\n]*):/g;
  while ((m = reLambda.exec(src))) params(m[1]);
  src.split('\n').forEach(function (line) {
    if (/^[ \t]*(?:import|from)\b/.test(line)) return;
    var am, reAs = /\bas[ \t]+([A-Za-z_]\w*)/g;
    while ((am = reAs.exec(line))) bound.add(am[1]);
  });
  return bound;
}

function agPyCandidates(code) {
  var src = agStripPy(code), cands = new Map(), fromImports = {}, m;
  var reFrom = /^[ \t]*from[ \t]+([a-zA-Z_][\w.]*)[ \t]+import[ \t]+(.+)$/gm;
  while ((m = reFrom.exec(src))) {
    var mod = m[1];
    m[2].split(',').forEach(function (part) {
      var mm = /([A-Za-z_]\w*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/.exec(part.trim());
      if (mm && mm[1] !== '*') fromImports[(mm[2] || mm[1])] = mod + '.' + mm[1];
    });
  }
  var aliasToMod = {}, imported = new Set();
  var reImport = /^[ \t]*import[ \t]+([a-zA-Z_][\w.]*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/gm;
  while ((m = reImport.exec(src))) {
    if (m[2]) aliasToMod[m[2]] = m[1];
    else imported.add(m[1]);
  }
  var bound = agPyBound(src), third = agThird(), stdlib = ah.cfg('api_guard.python_stdlib');
  var reAttr = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  while ((m = reAttr.exec(src))) {
    var recv = m[1], attr = m[2];
    if (attr.startsWith('__') || bound.has(recv)) continue;
    var receiverPath = null;
    if (fromImports[recv]) receiverPath = fromImports[recv];
    else if (aliasToMod[recv]) receiverPath = aliasToMod[recv];
    else if (imported.has(recv)) receiverPath = recv;
    else if (Array.from(imported).some(function (x) { return x.split('.')[0] === recv; })) receiverPath = recv;
    if (!receiverPath) continue;
    var baseMod = receiverPath.split('.')[0];
    if (!(third || stdlib.indexOf(baseMod) >= 0)) continue;
    cands.set(receiverPath + '.' + attr, { baseMod: baseMod, receiverPath: receiverPath, attr: attr });
  }
  return Array.from(cands.entries()).map(function (e) { return Object.assign({}, e[1], { label: e[0] }); });
}

function agIsPathSpec(mod) {
  return /^[.\/\\]/.test(mod) || /^[A-Za-z]:[\\/]/.test(mod) || mod.indexOf('..') !== -1 || mod.indexOf('\\') !== -1;
}

function agJsCandidates(code) {
  var out = [], seen = new Set(), third = agThird(), builtins = ah.cfg('api_guard.node_builtins');
  var globalsList = ah.cfg('api_guard.js_globals');
  var allowed = function (mod) { return third || builtins.indexOf(mod) >= 0; };
  var push = function (o) { if (!seen.has(o.label)) { seen.add(o.label); out.push(o); } };
  var noComments = agStripJsComments(code), m;
  var reqVar = {};
  var reReqVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)(?!\s*[.(\[?])/g;
  while ((m = reReqVar.exec(noComments))) { if (!agIsPathSpec(m[2]) && allowed(m[2])) reqVar[m[1]] = m[2]; }
  Object.keys(reqVar).forEach(function (v) {
    var re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
    if ((noComments.match(re) || []).length > 1) delete reqVar[v];
  });
  var reReqInline = /require\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g;
  while ((m = reReqInline.exec(noComments))) {
    if (agIsPathSpec(m[1]) || !allowed(m[1]) || m[2].startsWith('__')) continue;
    push({ kind: 'require', mod: m[1], attr: m[2], label: "require('" + m[1] + "')." + m[2] });
  }
  var src = agStripJs(code);
  Object.keys(reqVar).forEach(function (varName) {
    var mod = reqVar[varName];
    var re = new RegExp('\\b' + varName.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g'), mm;
    while ((mm = re.exec(src))) {
      if (mm[1].startsWith('__')) continue;
      if (/^[ \t]*=(?!=)/.test(src.slice(mm.index + mm[0].length))) continue;
      push({ kind: 'require', mod: mod, attr: mm[1], label: mod + '(' + varName + ').' + mm[1] });
    }
  });
  var jsBound = new Set(), g;
  var reDecl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((g = reDecl.exec(src))) jsBound.add(g[1]);
  var reReassign = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gm;
  while ((g = reReassign.exec(src))) jsBound.add(g[1]);
  var reFnParams = /\bfunction[ \t]*\*?[ \t]*[A-Za-z_$]?[\w$]*[ \t]*\(([^)]*)\)/g;
  while ((g = reFnParams.exec(src))) {
    g[1].split(',').forEach(function (part) { var pm = /([A-Za-z_$][\w$]*)/.exec(part); if (pm) jsBound.add(pm[1]); });
  }
  var reGlobal = /\b([A-Za-z]\w*)\.(?:(prototype)\.)?([A-Za-z_$][\w$]*)/g;
  while ((m = reGlobal.exec(src))) {
    var obj = m[1], proto = m[2], attr = m[3];
    if (globalsList.indexOf(obj) < 0 || jsBound.has(obj)) continue;
    if (attr.startsWith('__') || attr === 'prototype') continue;
    var path = proto ? (obj + '.prototype.' + attr) : (obj + '.' + attr);
    push({ kind: 'global', path: path, label: path });
  }
  return out;
}

// ---- the code chunks a call writes (hooks/api-guard.js newCodeChunks) ----

function agChunks(p) {
  var tn = p && p.tool_name, ti = (p && p.tool_input) || {}, fp = ti.file_path || '', out = [];
  if (tn === ah.cfg('api_guard.tool_write')) {
    if (typeof ti.content === 'string') out.push({ file_path: fp, code: ti.content });
  } else if (tn === ah.cfg('api_guard.tool_edit')) {
    if (typeof ti.new_string === 'string') out.push({ file_path: fp, code: ti.new_string });
  } else if (tn === ah.cfg('api_guard.tool_multi')) {
    (Array.isArray(ti.edits) ? ti.edits : []).forEach(function (e) { if (e && typeof e.new_string === 'string') out.push({ file_path: fp, code: e.new_string }); });
  } else if (tn === ah.cfg('api_guard.tool_shell')) {
    var cmd = ti.command;
    if (ah.settings.bool('api_guard.shell_setting') && swMayWrite(cmd) && new RegExp(ah.cfg('api_guard.code_name_pattern'), 'i').test(cmd)) {
      // the shell parsers resolve relative targets against the payload cwd, or the hook process's own when there is none
      var q = Object.assign({}, p, { cwd: hookProc.cwd(p) });
      swShellWrites(cmd, q).forEach(function (w) { if (typeof w.content === 'string') out.push({ file_path: w.abs, code: w.content }); });
      if (S && S.unsure) { ah.log('api_guard_unsure', 'shell-write parse needed the hook process; parsed targets kept'); S.unsure = false; }
    }
  } else if (tn === ah.cfg('api_guard.tool_patch')) {
    var parsed = applyPatch.parse(ti.command);
    if (parsed.ok) {
      parsed.files.forEach(function (f) {
        if (f.op === 'delete' || !f.addedLines.length) return;
        out.push({ file_path: f.moveTo !== null ? f.moveTo : f.path, code: f.addedLines.join('\n') + '\n' });
      });
    }
  }
  return out;
}

// ---- the probes ----

// The per-probe timeout the Node guard asks for (the env override is the Node guard's own test knob).
function agSpawnMs() {
  var v = parseInt(ah.env.get(agCfg('spawn_timeout_env')) || '', 10);
  return isFinite(v) && v > 0 ? v : ah.cfgNum('api_guard_v1.spawn_timeout_ms');
}

// Run one probe; the first timed-out, killed or skipped run is remembered for the notice. The run's record, or null.
function agRun(st, bin, args, cwd) {
  var r = JSON.parse(ahHost.spawnProbe(bin, args, cwd, agSpawnMs()));
  if (!r.found) return null;
  if (st.notice === null && (r.skipped || r.timedOut || r.signal !== null || r.overflow)) st.notice = { bin: bin, ms: agSpawnMs() };
  return r.skipped ? null : r;
}

function agJson(st, bin, args, cwd) {
  var r = agRun(st, bin, args, cwd);
  if (r === null || r.timedOut || r.overflow || r.signal !== null || r.status !== 0) return null;
  try { return JSON.parse((r.stdout || '').trim()); } catch (e) { return null; }
}

function agPyBin(st) {
  var bins = agCfg('python_bins');
  for (var i = 0; i < bins.length; i++) {
    var r = agRun(st, bins[i], agCfg('version_args'), null);
    if (r !== null && !r.timedOut && !r.overflow && r.signal === null && r.status === 0 &&
      new RegExp(agCfg('python3_version_pattern')).test((r.stdout || '') + (r.stderr || ''))) return bins[i];
  }
  return null;
}

function agVerifyPython(st, cands, bin) {
  var byMod = new Map(), fakes = [], spawns = 0, max = ah.cfgNum('api_guard_v1.max_modules');
  cands.forEach(function (c) { if (!byMod.has(c.baseMod)) byMod.set(c.baseMod, []); byMod.get(c.baseMod).push(c); });
  // the probe runs in the temporary directory, never the repo, so a bare `import localmodule` cannot resolve to a project file
  var tmp = ah.env.get(agCfg('tmpdir_env'));
  tmp = tmp !== null && ah.path.isAbsolute(tmp) ? tmp : agCfg('tmpdir_default');
  var groups = Array.from(byMod.values());
  for (var g = 0; g < groups.length; g++) {
    if (spawns++ >= max) break;
    var group = groups[g];
    var checks = group.map(function (c) { return [c.receiverPath, c.attr]; });
    var codes = agJson(st, bin, agCfg('python_args').concat([agCfg('python_probe'), JSON.stringify(checks)]), tmp);
    if (!Array.isArray(codes)) continue;
    group.forEach(function (c, i) { if (codes[i] === 0) fakes.push(c); });
  }
  return fakes;
}

function agVerifyJs(st, cands, cwd) {
  var reqByMod = new Map(), globals = [];
  cands.forEach(function (c) {
    if (c.kind === 'require') { if (!reqByMod.has(c.mod)) reqByMod.set(c.mod, []); reqByMod.get(c.mod).push(c); } else globals.push(c);
  });
  var modsObj = {}, groups = [], n = 0, max = ah.cfgNum('api_guard_v1.max_modules');
  reqByMod.forEach(function (group, mod) {
    if (n++ >= max) return;
    modsObj[mod] = group.map(function (c) { return c.attr; });
    groups.push([mod, group]);
  });
  var res = agJson(st, agCfg('node_bin'), agCfg('node_args').concat([agCfg('node_probe'), JSON.stringify(modsObj), JSON.stringify(globals.map(function (c) { return c.path; }))]), cwd);
  if (!res || typeof res !== 'object') return [];
  var fakes = [];
  groups.forEach(function (gm) {
    var codes = res.req && res.req[gm[0]];
    if (Array.isArray(codes)) gm[1].forEach(function (c, i) { if (codes[i] === 0) fakes.push(c); });
  });
  if (Array.isArray(res.glob)) globals.forEach(function (c, i) { if (res.glob[i] === 0) fakes.push(c); });
  return fakes;
}

function agVersion(st, bin) {
  var r = agRun(st, bin, agCfg('version_args'), null);
  if (r === null || r.timedOut) return bin;
  return ((r.stdout || r.stderr) || '').trim().split('\n')[0] || bin;
}

function agNotice(st) {
  if (st.notice === null) return '';
  return text.render(agCfg('msg_timeout'), { bin: st.notice.bin, ms: st.notice.ms }) + '\n';
}

function agMain(p) {
  if (!ah.settings.bool('api_guard.setting') || p === undefined || p === null) return 'allow';
  if (ah.settings.skipped(ah.cfg('api_guard.guard_name'))) return 'allow';
  if (typeof p !== 'object') return 'allow';
  var chunks = agChunks(p);
  if (!chunks.length) return 'allow';
  var py = [], js = [], cap = ah.cfgNum('api_guard_v1.max_code_chars');
  chunks.forEach(function (ch) {
    if (typeof ch.code !== 'string' || ch.code.length > cap) return;
    var lang = agLangFor(String(ch.file_path));
    if (lang === 'py') py = py.concat(agPyCandidates(ch.code));
    else if (lang === 'js') js = js.concat(agJsCandidates(ch.code));
  });
  if (!py.length && !js.length) return 'allow';
  var st = { notice: null }, fakes = [], bins = [];
  if (py.length) {
    var pb = agPyBin(st);
    if (pb) { bins.push(pb); fakes = fakes.concat(agVerifyPython(st, py, pb)); }
  }
  if (js.length) { bins.push(agCfg('node_bin')); fakes = fakes.concat(agVerifyJs(st, js, hookProc.cwd(p))); }
  if (!fakes.length) { var nt = agNotice(st); return nt ? { exact: { code: 0, out: '', err: nt } } : 'allow'; }
  var seen = new Set(), uniq = fakes.filter(function (f) { return seen.has(f.label) ? false : (seen.add(f.label), true); });
  var vers = bins.map(function (b) { return agVersion(st, b); }).join(agCfg('version_joiner'));
  var reason = text.message('block', ah.cfg('api_guard.guard_name'), {
    what: text.render(agCfg('msg_what'), { versions: vers }), why: agCfg('msg_why'), instead: agCfg('msg_instead'),
    override: agCfg('msg_override'), extra: uniq.map(function (f) { return agCfg('msg_item_prefix') + f.label; }),
  });
  // Codex honors exit 2 only with the reason on stderr; the shell tool and apply_patch carry it there, an edit tool on stdout only
  var toErr = p.tool_name === ah.cfg('api_guard.tool_patch') || p.tool_name === ah.cfg('api_guard.tool_shell');
  return { exact: { code: 2, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: toErr ? reason + '\n' : '' } };
}

function decide(p, opts) {
  cmdBegin(opts);
  var v;
  // the Node guard fails open on any internal error; the time and memory limits still reach the engine
  try { v = agMain(p); } catch (e) { if (cmdFatal(e) && !e.unsure) throw e; v = 'allow'; }
  cmdEnd();
  return v;
}

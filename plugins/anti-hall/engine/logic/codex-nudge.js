// check = "codex-nudge" (Stop). One soft nudge to get a Codex second opinion after several substantial code edits with no Codex review in
// the session: it reads the end of the transcript, counts the code-file edits (outside the session's scratchpad and, when the working
// directory is in a git work tree, inside that tree), notes a Codex review (a Codex agent or skill call), and blocks the stop once per
// distinct set of files, at most `nudge_max` times a session. A live Codex outage, a switch off and a skip say nothing; Jev (integration
// codexNudgeSubstantial) can judge the edits trivial. This script builds on codex-availability.js (script.includes). Mirrors
// hooks/codex-nudge.js. Keys and texts: codex_handover.toml (codex_handover.*).
'use strict';

// `realpath` of the longest existing ancestor with the rest appended.
function cxRealOrSelf(p) {
  var r = ah.fs.realpath(p);
  if (r !== null) return r;
  var cur = p, suffix = [];
  for (;;) {
    var parent = posix.dirname(cur);
    if (parent === cur) return p;
    suffix.unshift(posix.basename(cur));
    cur = parent;
    var rr = ah.fs.realpath(cur);
    if (rr !== null) { var out = rr; suffix.forEach(function (s) { out = posix.normalize(out + '/' + s); }); return out; }
  }
}

function cxInsideDir(p, dir) {
  var rel = ah.path.relative(cxRealOrSelf(dir), cxRealOrSelf(p));
  return rel !== '' && rel.indexOf('..') !== 0 && rel.charAt(0) !== '/';
}

// The scratchpad directories of this session (the host keeps temporary files there), under every temp root.
function cxScratch(p) {
  var sid = p.session_id;
  if (typeof sid !== 'string' || sid === '' || !/^[A-Za-z0-9._-]+$/.test(sid)) return [];
  var tp = p.transcript_path, seg = null;
  if (typeof tp === 'string' && tp.charAt(0) === '/') {
    var b = posix.basename(posix.dirname(tp));
    if (b !== '' && /^[A-Za-z0-9-]+$/.test(b)) seg = b;
  }
  if (seg === null && typeof p.cwd === 'string' && p.cwd.charAt(0) === '/') seg = p.cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (seg === null) return [];
  var tmp = null;
  cxT('tmp_env').forEach(function (k) { if (tmp === null) { var v = ah.env.get(k); if (v !== null && v !== '') tmp = v; } });
  if (tmp === null) tmp = cxT('tmp_default');
  if (tmp.length > 1 && tmp.charAt(tmp.length - 1) === '/') tmp = tmp.slice(0, -1);
  var roots = [];
  [tmp].concat(cxT('tmp_roots')).forEach(function (r) { if (r !== '' && roots.indexOf(r) < 0) roots.push(r); });
  var uid = ah.sys.uid();
  return roots.map(function (r) { return posix.normalize(r + '/' + cxT('scratch_prefix') + uid + '/' + seg + '/' + sid + '/' + cxT('scratch_leaf')); });
}

// {base, scratch, worktree}, or null when the answer depends on Node's own working directory.
function cxExclusion(p) {
  var cwd = typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : null, worktree = null;
  if (cwd !== null) {
    var ctx = ah.repo.context(cwd);
    if (ctx.unsure) return null;
    worktree = ctx.root;
  }
  return { base: cwd, scratch: cxScratch(p), worktree: worktree };
}

// true / false, or null when the path is relative to the hook's own working directory.
function cxExcluded(fp, ex) {
  var abs;
  if (fp.charAt(0) === '/') abs = posix.resolveIn('/', [fp]);
  else if (ex.base !== null && ex.base.charAt(0) === '/') abs = posix.resolveIn('/', [ex.base, fp]);
  else return null;
  if (ex.scratch.some(function (d) { return cxInsideDir(abs, d); })) return true;
  return ex.worktree !== null && !cxInsideDir(abs, ex.worktree);
}

function cxCollect(node, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.type === 'tool_use' && node.name) out.push(node);
  cxT('nudge_child_keys').forEach(function (k) {
    var v = node[k];
    if (Array.isArray(v)) v.forEach(function (it) { cxCollect(it, out); });
    else if (v !== null && typeof v === 'object') cxCollect(v, out);
  });
}

function cxFirstStr(inp, keys) { for (var i = 0; i < keys.length; i++) { var v = jx.isObj(inp) ? inp[keys[i]] : undefined; if (typeof v === 'string' && v !== '') return v; } return ''; }

// The scan of the transcript tail: {files, edits, review}; null when there is nothing to read, 'defer'.
function cxScanTranscript(path, p) {
  var tail = ah.fs.readTail(path, cxN('nudge_tail_bytes'));
  if (tail === null) return null;
  var lines = tail.split('\n'), scan = { files: [], edits: 0, review: false }, ex = null, seen = {};
  var codeExt = new RegExp(cxT('nudge_code_ext_re'), 'i'), agentRe = new RegExp(cxT('nudge_agent_re'), 'i');
  for (var li = 0; li < lines.length; li++) {
    var t = lines[li].trim();
    if (t === '') continue;
    var r = jx.parse(t);
    if (r.unsure) return 'defer';
    if (r.invalid) continue;
    var tus = [];
    cxCollect(r.v, tus);
    for (var i = 0; i < tus.length; i++) {
      var tu = tus[i], name = typeof tu.name === 'string' ? tu.name : '', inp = tu.input !== null && typeof tu.input === 'object' ? tu.input : null;
      var fp = inp !== null && !Array.isArray(inp) ? inp.file_path : undefined;
      if (cxT('nudge_edit_tools').indexOf(name) >= 0 && typeof fp === 'string' && fp !== '' && codeExt.test(fp)) {
        if (ex === null) { ex = cxExclusion(p); if (ex === null) return 'defer'; }
        var e = cxExcluded(fp, ex);
        if (e === null) return 'defer';
        if (!e) {
          scan.edits++;
          var b = posix.basename(fp);
          if (!Object.prototype.hasOwnProperty.call(seen, b)) { seen[b] = true; scan.files.push(b); }
        }
      }
      if (cxT('nudge_agent_tools').indexOf(name) >= 0 && agentRe.test(cxFirstStr(inp, cxT('agent_type_keys')))) scan.review = true;
      if (name === cxT('nudge_skill_tool')) {
        var sk = jx.isObj(inp) && typeof inp.skill === 'string' ? inp.skill : '', cm = jx.isObj(inp) && typeof inp.command === 'string' ? inp.command : '';
        if (jx.asciiLower(sk + ' ' + cm).indexOf(cxT('nudge_codex_word')) >= 0) scan.review = true;
      }
    }
  }
  return scan;
}

// The minimum number of edits that makes a session substantial: env, then the settings file, then the default; null when unsure.
function cxMin() {
  var floor = cxN('nudge_min_floor');
  var coerce = function (raw) {
    var n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string') { var t = raw.trim(); if (t === '') return null; n = Number(t); }
    else return null;
    return isFinite(n) ? Math.max(n, floor) : null;
  };
  var env = ah.env.get(cxT('nudge_min_env'));
  if (env !== null) { var v = coerce(env); if (v !== null) return v; }
  var f = jx.read(ah.home() + '/' + ah.cfg('guardkit.settings_file'));
  if (f.text !== undefined) {
    var r = jx.parse(f.text.trim());
    if (!r.invalid && !r.unsure && jx.isObj(r.v)) {
      var sec = r.v[cxT('nudge_section')];
      if (jx.isObj(sec)) { var c = coerce(sec[cxT('nudge_min_key')]); if (c !== null) return c; }
    }
  }
  return cxN('nudge_min_default');
}

function decide(p) {
  if (cxJudgeChild()) return 'allow';
  if (!ah.settings.bool('codex_handover.setting_nudge') || ah.settings.skipped(cxT('nudge_guard'))) return 'allow';
  var tp = jx.isObj(p) ? p.transcript_path : undefined;
  if (typeof tp !== 'string' || tp === '') return 'allow';
  if (tp.charAt(0) !== '/') return 'defer'; // relative to the hook's own working directory, which is not known here
  var scan = cxScanTranscript(tp, p);
  if (scan === 'defer') return 'defer';
  if (scan === null) return 'allow';
  var min = cxMin();
  if (scan.edits < min || scan.review) return 'allow';
  var home = cxHome();
  if (home === null) return 'defer';
  if (ah.settings.bool('codex_handover.setting_quota_detect') && !cxScanJobLogs(home, ah.clock.now())) return 'defer';
  var q = cxReadQuota(home, ah.clock.now());
  if (q === null) return 'defer';
  if (q !== false) return 'allow';
  var session = p.session_id ? String(p.session_id) : '';
  if (session === '') session = ah.sha1(tp).slice(0, cxN('nudge_session_hash_len'));
  // JEV (`codexNudgeSubstantial`, `consultRelax`): a confident "trivial" answer skips the nudge; shadow and off fire a detached ask.
  var spec = {
    id: cxT('nudge_jev_id'), relax: true, trust: 'relax_block', baseline: true, sessionId: session, turnRefFrom: tp,
    question: { type: 'noul', instructions: cxT('nudge_jev_instructions'), criteria: [['true', cxT('nudge_jev_true')], ['false', cxT('nudge_jev_false')]] },
    state: cxT('nudge_jev_files_label') + scan.files.slice(0, cxN('nudge_jev_files')).join(', ') + '\n' + cxT('nudge_jev_edits_label') + scan.edits,
  };
  if (typeof p.cwd === 'string') spec.projectFrom = p.cwd;
  var j = null;
  try { j = ah.jev.ask(spec); } catch (e) { j = null; }
  if (j === false) return 'allow';
  var dirRel = cxT('state_dir'), stateName = cxT('nudge_state_prefix') + '-' + String(session).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
  var sorted = scan.files.slice().sort(), sig = ah.sha1(sorted.join(cxT('nudge_sig_sep')));
  var lastSig = '', nudges = 0;
  var f = jx.read(home + '/' + dirRel + '/' + stateName);
  if (f.big) return 'defer';
  if (f.text !== undefined) {
    var t = f.text.trim();
    if (t !== '') {
      var r = jx.parse(t);
      if (r.unsure) return 'defer';
      if (!r.invalid && r.v !== null && typeof r.v === 'object') {
        if (typeof r.v.sig === 'string') lastSig = r.v.sig;
        if (typeof r.v.nudges === 'number' && isFinite(r.v.nudges)) nudges = r.v.nudges;
      }
    }
  }
  if (sig === lastSig || nudges >= cxN('nudge_max')) return 'allow';
  if (gk.pruneMeetsLink(dirRel, cxT('nudge_state_prefix'))) return 'defer'; // Node unlinks a stale linked state file; the host does not
  var ok = false;
  try { ok = ah.state.writeAtomic(dirRel + '/' + stateName, JSON.stringify({ sig: sig, nudges: nudges + 1 })); } catch (e) { ok = false; }
  if (!ok) return 'allow';
  gk.pruneStale(dirRel, cxT('nudge_state_prefix'));
  var shownMax = cxN('nudge_shown_files'), shown = scan.files.slice(0, shownMax).join(cxT('nudge_names_sep'));
  var what = text.render(cxT('nudge_what'), { edits: scan.edits, files: scan.files.length, names: shown, more: scan.files.length > shownMax ? cxT('nudge_more') : '' });
  var reason = text.message('tip', cxT('nudge_guard'), { what: what, why: cxT('nudge_why'), instead: cxT('nudge_instead'), allowed: cxT('nudge_allowed'), override: cxT('nudge_override') });
  return { advisory: JSON.stringify({ decision: 'block', reason: reason }) };
}

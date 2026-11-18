// check = "merge-side-pick" (PreToolUse and PostToolUse on Bash; advisory only, never blocks). PostToolUse records a conflict
// resolved by taking one side wholesale and the test runs that follow, per session; a push while a side-pick has no test run
// after it adds one advisory line. Mirrors hooks/merge-side-pick.js and hooks/lib/merge-side-pick.js. The state is the very
// file the Node guard keeps (~/.anti-hall/merge-side-pick-<session>.json). Every pattern, limit and text is in
// engine/defaults/small_guards.toml (merge_side_pick.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Blank heredoc bodies and quoted spans (same length) so text a command only carries (a commit message, a heredoc note, an echo
// argument) cannot be mistaken for a command. A body is text however many lines it spans, so its newlines stay and its characters
// go; an unterminated heredoc runs to the end, as the shell reads it. The opener pattern is merge_side_pick.heredoc_open
// (capture 1 = optional quote, 2 = the tag); a `<<<` here-string is not a heredoc.
// one allocation per line, not one match object per character
function blank(t) { return t.split('\n').map(function (l) { return ' '.repeat(l.length); }).join('\n'); }
function maskHeredocs(cmd) {
  // works on the original text with a cursor: rewriting the whole string for every heredoc (and slicing the rest of it to find the
  // terminator) made a command with many heredocs cost length x heredocs. A body is blanked in place, so every later position holds
  // what it held before.
  var parts = [], at = 0, from = 0, terms = Object.create(null), open = new RegExp(ah.cfg('merge_side_pick.heredoc_open'), 'g');
  for (;;) {
    open.lastIndex = from;
    var m = open.exec(cmd);
    if (!m) break;
    if (m.index > 0 && cmd.charAt(m.index - 1) === '<') { from = open.lastIndex; continue; }
    var nl = cmd.indexOf('\n', open.lastIndex);
    if (nl < 0) break;
    var term = terms[m[2]] || (terms[m[2]] = new RegExp('\\n[ \\t]*' + m[2] + '[ \\t]*(?=\\n|$)', 'g'));
    term.lastIndex = nl;
    var end = term.exec(cmd);
    var stop = end ? end.index : cmd.length;
    parts.push(cmd.slice(at, nl + 1), blank(cmd.slice(nl + 1, stop)));
    at = stop;
    from = stop;
  }
  parts.push(cmd.slice(at));
  return parts.join('');
}
function maskQuotes(cmd) {
  var s = maskHeredocs(cmd);
  ah.cfg('merge_side_pick.quote_masks').forEach(function (src) {
    var hits = ah.re.findAll(src, '', s), out = [], at = 0;
    hits.forEach(function (h) { out.push(s.slice(at, h[0]), blank(s.slice(h[0], h[1]))); at = h[1]; });
    out.push(s.slice(at));
    s = out.join('');
  });
  return s;
}

// Command segments split on `;`, `&`, `|` and newlines, quotes already masked.
function segments(cmd) {
  var s = maskQuotes(cmd), out = [], at = 0;
  var cut = function (a, b) { var t = s.slice(a, b).trim(); if (t) out.push(t); };
  ah.re.findAll(ah.cfg('merge_side_pick.segment_split'), '', s).forEach(function (h) { cut(at, h[0]); at = h[1]; });
  cut(at, s.length);
  return out;
}

function gitRe(tail) { return ah.cfg('merge_side_pick.git_prefix') + tail; }
function segPick(s) { return ah.cfg('merge_side_pick.pick_tails').some(function (t) { return ah.re.test(gitRe(t), '', s); }); }
function segTest(s) { return ah.cfg('merge_side_pick.test_patterns').some(function (src) { return ah.re.test(src, '', s); }); }
function segPush(s) { return ah.re.test(gitRe(ah.cfg('merge_side_pick.push_tail')), '', s) && !ah.re.test(ah.cfg('merge_side_pick.dry_run'), '', s); }


// ---- which branch a side-pick belongs to -----------------------------------------------------------------------------------------
// A pick is recorded with the git directory and branch it happened on; a push draws the advisory only when it may push that branch.
// Anything this cannot tell (a quoted push, a cd, GIT_DIR, a detached HEAD, --all) keeps the advisory, as before.
function quoted(cmd) { return maskQuotes(cmd) !== cmd; }
function words(s) { return s.split(/\s+/).filter(function (w) { return w !== ''; }); }
function cdLike(s) { return ah.re.test(ah.cfg('merge_side_pick.scope_unknown_re'), '', s); }

// The directory a git segment runs in: the payload cwd, moved by one plain `-C <dir>`; '' when that cannot be told.
function segDir(s, cwd, cmdQuoted) {
  var w = words(s), at = -1, n = 0;
  for (var i = 0; i < w.length; i++) if (w[i] === '-C') { n += 1; if (at < 0) at = i; }
  if (n === 0) return cwd;
  if (n > 1 || cmdQuoted || at + 1 >= w.length) return '';
  var d = w[at + 1];
  return ah.path.isAbsolute(d) ? d : (cwd === '' ? '' : ah.path.join(cwd, d));
}

// `t` without the match of the configured prefix regex at its start.
function cutPrefix(t, key) { var m = ah.re.find(ah.cfg(key), '', t); return m === null ? t : t.slice(m[1]); }

// {gitdir, branch} of the checkout around `dir` ('' for each when unknown): the nearest .git (a directory, or a file naming the git dir
// of a linked worktree) and the branch its HEAD names.
function scopeOf(dir) {
  var none = { gitdir: '', branch: '' };
  if (typeof dir !== 'string' || dir === '' || !ah.path.isAbsolute(dir)) return none;
  var d = ah.path.resolveAbs(dir), gitdir = '';
  for (var i = 0, n = ah.cfgNum('merge_side_pick.git_dir_levels'); i < n && d !== ''; i++) {
    var kind = ah.fs.kind(ah.path.join(d, '.git'));
    if (kind === 'dir') { gitdir = ah.path.join(d, '.git'); break; }
    if (kind === 'file') {
      var t = ah.fs.readText(ah.path.join(d, '.git'), ah.cfgNum('merge_side_pick.git_file_max'));
      var m = t === null ? null : ah.re.find(ah.cfg('merge_side_pick.gitdir_line_re'), 'm', t);
      if (m === null) return none;
      var g = cutPrefix(t.slice(m[0], m[1]), 'merge_side_pick.gitdir_prefix').trim();
      gitdir = ah.path.isAbsolute(g) ? g : ah.path.join(d, g);
      break;
    }
    if (kind !== null) return none;
    var up = d.lastIndexOf('/');
    d = up <= 0 ? (d === '/' ? '' : '/') : d.slice(0, up);
  }
  if (gitdir === '') return none;
  var head = ah.fs.readText(ah.path.join(gitdir, 'HEAD'), ah.cfgNum('merge_side_pick.git_file_max'));
  var r = head === null ? null : ah.re.find(ah.cfg('merge_side_pick.head_ref_re'), '', head);
  return { gitdir: gitdir, branch: r === null ? '' : cutPrefix(head.slice(r[0], r[1]), 'merge_side_pick.head_ref_prefix') };
}

// The local branches a push segment may push, or null when that cannot be told (the advisory then stays): an option that pushes
// several refs or takes a separate value, a ref that is not a plain branch name. No refspec pushes the current branch.
function pushedBranches(s, current) {
  var w = words(s), i = 0;
  while (i < w.length && w[i] !== 'push') i++;
  var rest = w.slice(i + 1), args = [];
  for (var j = 0; j < rest.length; j++) {
    var a = rest[j];
    if (ah.re.test(ah.cfg('merge_side_pick.push_unscoped_opts_re'), '', a)) return null;
    if (a.charAt(0) === '-') continue;
    args.push(a);
  }
  if (args.length <= 1) return [current];
  var out = [];
  for (var k = 1; k < args.length; k++) {
    var src = args[k].replace(/^\+/, '').split(':')[0];
    if (src === ah.cfg('merge_side_pick.head_word')) src = current;
    else if (src.indexOf(ah.cfg('merge_side_pick.heads_prefix')) === 0) src = src.slice(ah.cfg('merge_side_pick.heads_prefix').length);
    if (src === '') continue;
    if (!ah.re.test(ah.cfg('merge_side_pick.plain_branch_re'), '', src)) return null;
    out.push(src);
  }
  return out.length === 0 ? [current] : out;
}

// True when a push segment is, for sure, not a push of `pick`'s branch: another checkout, or other branches than the picked one.
function pushLeavesPick(pick, segsBefore, s, cwd, cmdQuoted) {
  if (pick.gitdir === '' || pick.branch === '' || cwd === '' || cmdQuoted) return false;
  if (segsBefore.some(cdLike) || cdLike(s)) return false;
  var dir = segDir(s, cwd, cmdQuoted);
  if (dir === '') return false;
  var here = scopeOf(dir);
  if (here.gitdir === '') return false;
  if (here.gitdir !== pick.gitdir) return true;
  if (here.branch === '') return false;
  var pushed = pushedBranches(s, here.branch);
  return pushed !== null && pushed.indexOf(pick.branch) < 0;
}

// A side-pick segment as stored and shown: white space collapsed, cut to the configured length in UTF-16 units, as Node cuts
// it (a cut through a surrogate pair keeps the lone half; JSON.stringify escapes it the same way in both interpreters).
function keep(s) {
  return s.replace(/\s+/g, ' ').slice(0, ah.cfgNum('merge_side_pick.cmd_keep'));
}

// One session's record, coerced as the Node guard coerces whatever the file holds.
function load(raw) {
  var o = null;
  if (raw !== null) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
  if (!isObj(o)) return { seq: 0, pickSeq: 0, testSeq: 0, cmd: '', gitdir: '', branch: '' };
  return { seq: o.seq | 0, pickSeq: o.pickSeq | 0, testSeq: o.testSeq | 0, cmd: String(o.cmd || ''), gitdir: String(o.gitdir || ''), branch: String(o.branch || '') };
}

// ---- is there a real conflict to resolve? ------------------------------------------------------------------------------------------
// A side-pick only counts as a one-sided conflict resolution when the checkout is mid merge/cherry-pick/revert/rebase (a marker in
// its git directory) or has unmerged paths. A `-X ours` that merged cleanly, or a stray --ours, resolves nothing. null = cannot tell
// (no known checkout, git did not answer): the pick is then recorded, as before. The markers and the query are merge_side_pick.*.
function conflictEvidence(dir, gitdir) {
  if (gitdir === '') return null;
  var marks = ah.cfg('merge_side_pick.conflict_markers');
  for (var i = 0; i < marks.length; i++) if (ah.fs.realpath(ah.path.join(gitdir, marks[i])) !== null) return true;
  if (dir === '') return null;
  var r = ah.exec('git', ah.cfg('merge_side_pick.unmerged_args'), { cwd: dir, timeoutMs: ah.cfgNum('merge_side_pick.unmerged_timeout_ms') });
  if (r === null || r.status !== 0) return null;
  return r.stdout.trim() !== '';
}
function pickScope(s, cwd, cq, moved) { return moved || cdLike(s) ? { gitdir: '', branch: '', dir: '' } : Object.assign({ dir: segDir(s, cwd, cq) }, scopeOf(segDir(s, cwd, cq))); }
function evidenceFor(at) { return conflictEvidence(at.dir, at.gitdir) !== false; }

// The pick's own bookkeeping lives in a second state file beside the record (merge_side_pick.meta_ns), so the record keeps the shape
// the Node guard wrote: {at: when the last pick was recorded, ev: a conflict existed when the pick command began}.
function loadMeta(ns, key) {
  var o = null, raw = ah.sessionState.get(ns, key);
  if (raw !== null) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
  return isObj(o) ? { at: typeof o.at === 'number' && o.at > 0 ? o.at : 0, ev: o.ev === true } : { at: 0, ev: false };
}
function saveMeta(key, at, ev) {
  ah.sessionState.update(ah.cfg('merge_side_pick.meta_ns'), key, function () { return JSON.stringify({ at: at, ev: ev }); });
}
function hasEvidenceNow(s, cwd, cq, moved) { var at = pickScope(s, cwd, cq, moved); return conflictEvidence(at.dir, at.gitdir) === true; }

// PreToolUse of a command that takes a side: the conflict may be gone by PostToolUse (`checkout --theirs . && add . && commit`),
// so its presence now is remembered for the Post record.
function arm(key, cmd, cwd) {
  if (key === '') return;
  var segs = segments(cmd), cq = quoted(cmd), moved = false, found = false;
  for (var i = 0; i < segs.length && !found; i++) {
    if (segPick(segs[i])) found = hasEvidenceNow(segs[i], cwd, cq, moved);
    if (cdLike(segs[i])) moved = true;
  }
  if (found) saveMeta(key, loadMeta(ah.cfg('merge_side_pick.meta_ns'), key).at, true);
}

function record(ns, key, cmd, cwd) {
  if (key === '') return;
  var segs = segments(cmd);
  if (!segs.some(function (s) { return segPick(s) || segTest(s); })) return;
  var cq = quoted(cmd), mns = ah.cfg('merge_side_pick.meta_ns'), meta = loadMeta(mns, key), picked = false;
  ah.sessionState.update(ns, key, function (cur) {
    var st = load(cur), moved = false, armed = meta.ev;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (segPick(s)) {
        var at = pickScope(s, cwd, cq, moved);
        // no conflict then and none now: nothing was resolved one-sidedly, so nothing is recorded
        if (armed || evidenceFor(at)) {
          st.seq += 1; st.pickSeq = st.seq;
          st.cmd = keep(s);
          st.gitdir = at.gitdir; st.branch = at.branch;
          picked = true;
        }
      } else if (segTest(s)) { st.seq += 1; st.testSeq = st.seq; }
      if (cdLike(s)) moved = true;
    }
    var o = { seq: st.seq, pickSeq: st.pickSeq, testSeq: st.testSeq, cmd: st.cmd };
    if (st.gitdir !== '' && st.branch !== '') { o.gitdir = st.gitdir; o.branch = st.branch; }
    return JSON.stringify(o);
  });
  if (picked) saveMeta(key, ah.clock.now(), false);
  else if (meta.ev) saveMeta(key, meta.at, false);
}

// The recorded side-pick with no test run after it: {cmd, gitdir, branch}, or null.
function pending(ns, key) {
  if (key === '') return null;
  var st = load(ah.sessionState.get(ns, key));
  // a record older than the TTL is stale (no meta = written before this existed: kept as it was)
  var at = loadMeta(ah.cfg('merge_side_pick.meta_ns'), key).at;
  if (at > 0 && ah.clock.now() - at > ah.cfgNum('merge_side_pick.pick_ttl_ms')) return null;
  if (st.pickSeq > 0 && st.pickSeq > st.testSeq) return { cmd: st.cmd === '' ? ah.cfg('merge_side_pick.fallback_cmd') : st.cmd, gitdir: st.gitdir, branch: st.branch };
  return null;
}

// The side-pick command to warn about when `cmd` pushes with an untested side-pick; '' for none.
function pushCheck(ns, key, cmd, cwd) {
  var pend = pending(ns, key), segs = segments(cmd), cq = quoted(cmd), moved = false;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (segPick(s)) {
      var at = pickScope(s, cwd, cq, moved);
      if (evidenceFor(at)) pend = { cmd: keep(s), gitdir: at.gitdir, branch: at.branch };
    } else if (segTest(s)) pend = null;
    else if (segPush(s) && pend !== null && !pushLeavesPick(pend, segs.slice(0, i), s, cwd, cq)) return pend.cmd;
    if (cdLike(s)) moved = true;
  }
  return '';
}

function decide(p, opts, event) {
  var bash = isObj(p) && p.tool_name === 'Bash';
  // no home for the state files: the request carries HOME (one without it never reaches a script), so only an empty value is
  // left, where the Node guard has no state either; advisory-only, so nothing is recorded or said
  if (!ah.sessionState.homeOk()) { if (bash) ah.log('merge_side_pick_no_home', ''); return bash ? 'allow' : null; }
  var ns = ah.cfg('merge_side_pick.state_ns');
  var ti = bash ? p.tool_input : null;
  var cmd = isObj(ti) && typeof ti.command === 'string' ? ti.command : '';
  var cwd = isObj(p) && typeof p.cwd === 'string' ? p.cwd : '';
  var sid = isObj(p) && typeof p.session_id === 'string' ? p.session_id.trim() : '';
  var key = ah.sessionState.key(sid);
  // a state file only Node would read differently (not UTF-8): read here as corrupt, a fresh record, and logged
  if (sid !== '' && !ah.sessionState.probe(ns, key)) ah.log('merge_side_pick_state_unsure', key);
  if (!bash || cmd === '' || sid === '') return 'allow';
  if (!ah.settings.bool('merge_side_pick.setting') || ah.settings.skipped(ah.cfg('merge_side_pick.guard_name'))) return 'allow';
  if (event === 'PostToolUse' || p.hook_event_name === 'PostToolUse') { record(ns, key, cmd, cwd); return 'allow'; }
  arm(key, cmd, cwd);
  var pick = pushCheck(ns, key, cmd, cwd);
  if (pick === '') return 'allow';
  var what = text.render(ah.cfg('merge_side_pick.msg_what'), { pick: pick });
  var t = text.message('warn', ah.cfg('merge_side_pick.guard_name'), { what: what, why: ah.cfg('merge_side_pick.msg_why'), instead: ah.cfg('merge_side_pick.msg_instead') });
  return { advisory: text.advisoryJson('PreToolUse', t) };
}

// check = "merge-side-pick" (PreToolUse and PostToolUse on Bash; advisory only). PostToolUse records a conflict resolved by taking one side
// wholesale (`git checkout --ours`, `git merge -X theirs`, ...) and test runs, per session; a push while a side-pick has no test run after it
// adds one advisory line. The state is the file the Node guard keeps, `~/.anti-hall/merge-side-pick-<session>.json`, so a restart forgets
// nothing and a Node hook that answers for the same session in turn reads and writes the same record. A state file this script cannot read
// the way Node reads it, or a request without a home directory, defers before anything is written. Mirrors hooks/merge-side-pick.js and
// hooks/lib/merge-side-pick.js. Keys and texts: small_guards.toml (merge_side_pick.*).
'use strict';

function mpT(k) { return ah.cfg('merge_side_pick.' + k); }

var mpMemo = { gen: -1, picks: null, push: null, dry: null, tests: null, masks: null, split: null };
function mpRes() {
  var g = ahHost.cfgGen();
  if (mpMemo.gen !== g) {
    var prefix = mpT('git_prefix');
    mpMemo = {
      gen: g, picks: mpT('pick_tails').map(function (t) { return new RegExp(prefix + t); }), push: new RegExp(prefix + mpT('push_tail')),
      dry: new RegExp(mpT('dry_run')), tests: mpT('test_patterns').map(function (s) { return new RegExp(s); }),
      masks: mpT('quote_masks').map(function (s) { return new RegExp(s, 'g'); }), split: new RegExp(mpT('segment_split')),
    };
  }
  return mpMemo;
}

// Blank quoted spans (same length) so a quoted message or echo argument cannot be mistaken for a command.
function mpMask(cmd) {
  var s = String(cmd || '');
  mpRes().masks.forEach(function (re) { s = s.replace(re, function (m) { return ' '.repeat(m.length); }); });
  return s;
}
function mpSegments(cmd) { return mpMask(cmd).split(mpRes().split).map(function (s) { return s.trim(); }).filter(Boolean); }
function mpPick(s) { return mpRes().picks.some(function (re) { return re.test(s); }); }
function mpTest(s) { return mpRes().tests.some(function (re) { return re.test(s); }); }
function mpPush(s) { var r = mpRes(); return r.push.test(s) && !r.dry.test(s); }

// A side-pick segment as stored and shown: white space collapsed, cut to the configured length; null when the cut splits a surrogate pair.
function mpKeep(s) { var c = s.replace(/\s+/g, ' '), cut = jx.sliceUnits(c, ah.cfgNum('merge_side_pick.cmd_keep')); return cut.length < Math.min(c.length, ah.cfgNum('merge_side_pick.cmd_keep')) ? null : cut; }

function mpLoad(raw) {
  try { var s = JSON.parse(raw); if (s && typeof s === 'object') return { seq: s.seq | 0, pickSeq: s.pickSeq | 0, testSeq: s.testSeq | 0, cmd: String(s.cmd || '') }; } catch (e) { /* absent or corrupt: fresh */ }
  return { seq: 0, pickSeq: 0, testSeq: 0, cmd: '' };
}

// PostToolUse: record a side-pick or a test run; false when the text could not be handled exactly (defer).
function mpRecord(key, cmd) {
  if (key === '') return true;
  var segs = mpSegments(cmd);
  if (!segs.some(function (s) { return mpPick(s) || mpTest(s); })) return true;
  var failed = false;
  ah.sessionState.update(mpT('state_ns'), key, function (cur) {
    var st = mpLoad(cur);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (mpPick(s)) {
        st.seq += 1; st.pickSeq = st.seq;
        var k = mpKeep(s);
        if (k === null) { failed = true; return null; }
        st.cmd = k;
      } else if (mpTest(s)) { st.seq += 1; st.testSeq = st.seq; }
    }
    return JSON.stringify({ seq: st.seq, pickSeq: st.pickSeq, testSeq: st.testSeq, cmd: st.cmd });
  });
  return !failed;
}

// The recorded side-pick command when no test run followed it, else ''.
function mpPending(key) {
  if (key === '') return '';
  var raw = ah.sessionState.get(mpT('state_ns'), key), st = mpLoad(raw === null ? '' : raw);
  return st.pickSeq > 0 && st.pickSeq > st.testSeq ? (st.cmd || mpT('fallback_cmd')) : '';
}

// The side-pick command to warn about when `cmd` pushes with an untested side-pick (recorded earlier or earlier in this same command),
// else ''; null means defer.
function mpPushCheck(key, cmd) {
  var pend = mpPending(key), segs = mpSegments(cmd);
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (mpPick(s)) { pend = mpKeep(s); if (pend === null) return null; }
    else if (mpTest(s)) pend = '';
    else if (mpPush(s) && pend !== '') return pend;
  }
  return '';
}

function decide(p, opts, event) {
  // No home directory: Node would fall back to the process home, which the engine cannot name. Defer.
  if (!ah.sessionState.homeOk()) return jx.isObj(p) && p.tool_name === 'Bash' ? 'defer' : 'allow';
  var sid = jx.isObj(p) && typeof p.session_id === 'string' ? p.session_id.trim() : '', key = sid === '' ? '' : ah.sessionState.key(sid);
  if (key !== '' && !ah.sessionState.probe(mpT('state_ns'), key)) return 'defer';
  if (!jx.isObj(p) || p.tool_name !== 'Bash') return 'allow';
  var cmd = jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (cmd === '' || sid === '') return 'allow';
  if (!ah.settings.bool('merge_side_pick.setting') || ah.settings.skipped(mpT('guard_name'))) return 'allow';
  if (event === 'PostToolUse' || p.hook_event_name === 'PostToolUse') return mpRecord(key, cmd) ? 'allow' : 'defer';
  var pick = mpPushCheck(key, cmd);
  if (pick === null) return 'defer';
  if (pick === '') return 'allow';
  var t = text.message('warn', mpT('guard_name'), { what: text.render(mpT('msg_what'), { pick: pick }), why: mpT('msg_why'), instead: mpT('msg_instead') });
  return { advisory: text.advisoryJson('PreToolUse', t) };
}

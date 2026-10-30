// check = "advisor-guard" (GH #404; engine-only, no Node twin). Every advisor rule but review (model-routing.js). Silent unless the
// session has an advisor tool (payload tool list, an advisor call in the transcript, or one seen earlier: the state's fold). Never on
// a Stop continuation, and a failure of this script allows (script.failure_mode_by_check: open).
//   PreToolUse ExitPlanMode / Write|Edit|MultiEdit of a plan file: no advisor call since the last owner message -> block once.
//   PostToolUseFailure Bash (test or build command): arms the retry rule with the transcript offset of the newest advisor call and
//   the files edited so far. PostToolUse Bash (the same commands, i.e. a passing run) disarms it and forgets the edits.
//   PreToolUse Write|Edit|MultiEdit: a file edited BEFORE the armed failure, edited again with no advisor call after the failure
//   -> block once, then the failure is disarmed. Test files are exempt (test-first red step); the state is per agent (agent_id).
// Phase 3 (non-flagship main only; the main model is the transcript's own `message.model`):
//   PreToolUse Agent/Task, thinking: thinking work with no advisor call since the owner's last message -> nudge on the first
//   dispatch of the task, ONE block on the second, then pass (block_capped). guards.advisorThinking.
//   PreToolUse Agent/Task, second attempt: a second fix dispatch for the same issue key with no advisor call since the first ->
//   blocked once per key. guards.advisorRetry.
//   Stop, say-do: the turn says it will ask the advisor and no advisor call follows -> ONE block per turn. guards.advisorSayDo.
'use strict';

function agFile(p) {
  var i = jx.isObj(p.tool_input) ? p.tool_input : {};
  return typeof i.file_path === 'string' ? i.file_path : '';
}

function agStr(o, k) { return jx.isObj(o) && typeof o[k] === 'string' ? o[k] : ''; }

// The thinking type of a dispatch: {type, key} or null for routine work. The description first, else the head of the prompt.
function agClassify(input) {
  var desc = agStr(input, 'description'), prompt = agStr(input, 'prompt').slice(0, ah.cfgNum('advisor.brief_head_bytes'));
  if (desc !== '' && ah.re.test(ah.cfg('advisor.thinking_exempt_re'), 'r', desc)) return null;
  var types = ah.cfg('advisor.thinking_types'), type = null, srcs = [desc, prompt];
  for (var s = 0; s < srcs.length && type === null; s++) {
    if (srcs[s] === '') continue;
    for (var i = 0; i < types.length; i++) if (jx.isObj(types[i]) && ah.re.test(types[i].re, 'r', srcs[s])) { type = types[i].type; break; }
  }
  if (type === null) return null;
  var key = agMatch(desc) || agMatch(prompt);
  return { type: type, key: key.toLowerCase() };
}

// The first issue key (advisor.issue_key_re) in `s`, '' when none (reFind gives [start, end] in UTF-16 units, or null).
function agMatch(s) {
  if (s === '') return '';
  var m = ah.re.find(ah.cfg('advisor.issue_key_re'), 'r', s);
  return Array.isArray(m) && m.length >= 2 ? s.slice(m[0], m[1]) : '';
}

// Phase 3 on PreToolUse Agent/Task.
function agDispatch(p) {
  var onThink = ah.settings.bool('advisor.sw_thinking'), onSecond = ah.settings.bool('advisor.sw_retry');
  if (!onThink && !onSecond) return 'allow';
  var st = advisorKit.load(p), view = advisorKit.fold(p, st);
  if (view === null) return 'allow'; // no readable transcript (or a subagent with no own transcript): fail open
  advisorKit.consults(st, view.scan);
  var flag = advisorKit.flagship(view.model);
  var verdict = 'allow';
  if (flag === null) advisorKit.silence('model_unknown');
  if (flag === false && advisorKit.present(p, view.scan, view)) verdict = agThinking(p, st, view, onThink, onSecond);
  return advisorKit.keep(p, st, verdict);
}

function agThinking(p, st, view, onThink, onSecond) {
  var cls = agClassify(jx.isObj(p.tool_input) ? p.tool_input : {});
  var kind = 'advisor.kind_thinking';
  if (cls === null) { // routine work: a pending nudge followed by unrelated work was (best effort) a false nag
    if (jx.isObj(st.nudge) && view.lastAdvisor < st.nudge.at) { advisorKit.bump(st, 'false_nag', kind, 'false_nag'); st.nudge = null; }
    return 'allow';
  }
  advisorKit.bump(st, 'dispatch', kind, 'dispatch');
  advisorKit.raw(kind, text.render(ah.cfg('advisor.metric_dispatch_tpl'), { type: cls.type }));
  var consulted = view.lastAdvisor >= 0 && view.lastAdvisor > view.lastUser;
  if (consulted) advisorKit.bump(st, 'consulted_before', kind, 'consulted_before');
  var at = view.scan.size === null ? view.lastUser : view.scan.size; // where this hit sits: a consult must come after it
  // One fix attempt, then the advisor: the second fix dispatch for one issue needs an advisor call since the first.
  if (onSecond && cls.type === 'fix' && cls.key !== '') {
    if (!jx.isObj(st.fixes)) st.fixes = {};
    var rec = st.fixes[cls.key];
    if (jx.isObj(rec) && view.lastAdvisor <= rec.advisorAt && rec.gated !== true) {
      rec.gated = true;
      st.nudge = { at: at };
      if (!jx.isObj(st.tasks)) st.tasks = {};
      var gt = jx.isObj(st.tasks[String(view.lastUser)]) ? st.tasks[String(view.lastUser)] : { n: 0 };
      if (gt.n < 2) gt.n = 2; // this block is the task's one block: a later thinking hit of the task passes (block_capped)
      st.tasks[String(view.lastUser)] = gt;
      advisorKit.bump(st, 'second_gated', 'advisor.kind_second', 'gated');
      return advisorKit.block(text.render(ah.cfg('advisor.msg_second_what'), { key: cls.key }), ah.cfg('advisor.msg_second_instead'), ah.cfg('advisor.msg_why_flagship'));
    }
    st.fixes[cls.key] = { advisorAt: view.lastAdvisor, gated: jx.isObj(rec) && rec.gated === true };
    advisorKit.trim(st.fixes);
  }
  if (!onThink || consulted) return 'allow';
  if (!jx.isObj(st.tasks)) st.tasks = {};
  var task = String(view.lastUser), t = jx.isObj(st.tasks[task]) ? st.tasks[task] : { n: 0 };
  t.n++;
  st.tasks[task] = t;
  advisorKit.trim(st.tasks);
  var args = { type: cls.type.replace(/_/g, ' '), model: view.model };
  if (t.n === 1) {
    st.nudge = { at: at };
    advisorKit.bump(st, 'nudge', kind, 'nudge');
    return advisorKit.advise('PreToolUse', text.render(ah.cfg('advisor.msg_thinking_nudge'), args));
  }
  if (t.n === 2) {
    st.nudge = { at: at };
    advisorKit.bump(st, 'blocked', kind, 'blocked');
    return advisorKit.block(text.render(ah.cfg('advisor.msg_thinking_what'), args), ah.cfg('advisor.msg_thinking_instead'), ah.cfg('advisor.msg_why_flagship'));
  }
  advisorKit.bump(st, 'block_capped', kind, 'block_capped'); // the task's one block is spent: pass, never a loop
  return 'allow';
}

// Phase 3 on Stop: the say-do check, and the consult counters of the turn (they no longer wait for an edit, plan or failure).
function agStop(p) {
  var st = advisorKit.load(p), view = advisorKit.fold(p, st);
  if (view === null) return 'allow';
  advisorKit.consults(st, view.scan);
  var verdict = 'allow';
  if (view.sayAt >= 0 && view.sayAt > view.lastUser && view.lastAdvisor < view.sayAt && advisorKit.flagship(view.model) === false && advisorKit.present(p, view.scan, view)) {
    if (!jx.isObj(st.sayDo)) st.sayDo = {};
    var turn = String(view.lastUser), rec = jx.isObj(st.sayDo[turn]) ? st.sayDo[turn] : { miss: -1, blocked: false };
    if (rec.miss !== view.sayAt) { rec.miss = view.sayAt; advisorKit.bump(st, 'say_do_miss', 'advisor.kind_say_do', 'miss'); }
    if (!rec.blocked && ah.settings.bool('advisor.sw_say_do')) {
      rec.blocked = true;
      st.nudge = { at: view.sayAt };
      advisorKit.bump(st, 'say_do_blocked', 'advisor.kind_say_do', 'blocked');
      verdict = advisorKit.block(ah.cfg('advisor.msg_say_do_what'), ah.cfg('advisor.msg_say_do_instead'), ah.cfg('advisor.msg_why_flagship'));
    }
    st.sayDo[turn] = rec;
    advisorKit.trim(st.sayDo);
  }
  return advisorKit.keep(p, st, verdict);
}

function decide(p) {
  if (!jx.isObj(p) || ah.settings.skipped(ah.cfg('advisor.guard_name')) || advisorKit.stopping(p)) return 'allow';
  return advisorKit.locked(p, function () { return agDecide(p); }, 'allow');
}

function agDecide(p) {
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  var event = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
  if (event === 'Stop') return agStop(p);
  if (event === 'PreToolUse' && ah.cfg('advisor.dispatch_tools').indexOf(tool) >= 0) return agDispatch(p);
  var scan = null, file = agFile(p);
  if (event === 'PostToolUseFailure' || event === 'PostToolUse') {
    if (tool !== 'Bash' || p.is_interrupt === true || !ah.settings.bool('advisor.sw_retry')) return 'allow';
    var cmd = jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
    if (!ah.re.test(ah.cfg('advisor.test_cmd_re'), 'r', cmd)) return 'allow';
    var st = advisorKit.load(p);
    if (event === 'PostToolUse') { // a passing test or build: the edits are settled, nothing stays armed
      if (st.fail !== null || st.blocked || Object.keys(st.edits).length > 0) { st.fail = null; st.blocked = null; st.edits = {}; advisorKit.save(p, st); }
      return 'allow';
    }
    var view = advisorKit.fold(p, st);
    scan = view === null ? null : view.scan;
    if (!advisorKit.present(p, scan, view)) return 'allow';
    advisorKit.consults(st, scan);
    advisorKit.bump(st, 'armed', 'advisor.kind_retry', 'armed'); // a failure the retry rule is watching: the denominator of the consult-after-failure rate
    st.fail = { advisorAt: view !== null ? view.lastAdvisor : -1, files: Object.keys(st.edits) }; // only files edited BEFORE this failure can trip the rule
    advisorKit.save(p, st);
    return 'allow';
  }
  var isPlan = ah.cfg('advisor.plan_tools').indexOf(tool) >= 0 || (ah.cfg('advisor.edit_tools').indexOf(tool) >= 0 && file !== '' && ah.re.test(ah.cfg('advisor.plan_file_re'), 'r', file));
  var isEdit = ah.cfg('advisor.edit_tools').indexOf(tool) >= 0 && file !== '' && !ah.re.test(ah.cfg('advisor.test_file_re'), 'r', file); // test files are exempt: test-first work re-edits the test after its red run
  if (isPlan && ah.settings.bool('advisor.sw_plan')) {
    var ps = advisorKit.load(p), pv = advisorKit.fold(p, ps);
    if (pv !== null) { advisorKit.consults(ps, pv.scan); advisorKit.save(p, ps); }
    if (pv !== null && advisorKit.present(p, pv.scan, pv) && pv.lastAdvisor < pv.lastUser && advisorKit.gate('advisor.kind_plan', p, tool + ':' + file)) {
      return advisorKit.block(ah.cfg('advisor.msg_plan_what'), ah.cfg('advisor.msg_plan_instead'));
    }
  }
  if (isEdit && ah.settings.bool('advisor.sw_retry')) {
    var s = advisorKit.load(p), v = null;
    var verdict = 'allow';
    if (jx.isObj(s.blocked)) { // a retry block fired: acted on when the advisor was consulted before this next edit
      v = advisorKit.fold(p, s);
      if (v !== null && v.lastAdvisor > s.blocked.advisorAt) { advisorKit.bump(s, 'acted_on', 'advisor.kind_retry', 'acted_on'); s.blocked = null; }
    }
    if (s.fail !== null && jx.isObj(s.fail) && Array.isArray(s.fail.files) && s.fail.files.indexOf(file) >= 0) {
      if (v === null) v = advisorKit.fold(p, s);
      if (v !== null && v.lastAdvisor > s.fail.advisorAt) { advisorKit.bump(s, 'consulted', 'advisor.kind_retry', 'consulted'); s.fail = null; } // consulted since the failure: disarm
      else if (v !== null && advisorKit.present(p, v.scan, v) && advisorKit.gate('advisor.kind_retry', p, file)) {
        s.blocked = { advisorAt: v.lastAdvisor };
        s.fail = null;
        verdict = advisorKit.block(text.render(ah.cfg('advisor.msg_retry_what'), { file: file }), ah.cfg('advisor.msg_retry_instead'));
      }
    }
    if (v !== null) advisorKit.consults(s, v.scan);
    if (verdict === 'allow') s.edits[file] = (s.edits[file] || 0) + 1;
    return advisorKit.keep(p, s, verdict);
  }
  return 'allow';
}

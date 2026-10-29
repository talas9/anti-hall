// check = "advisor-guard" (GH #404, phase 1; engine-only, no Node twin). Two of the three advisor rules; the third (review) is in
// model-routing.js. Silent unless the session has an advisor tool. Each rule blocks ONCE per trigger (advisory layer: hash gate and
// per-kind cap), never on a Stop continuation, and a failure of this script allows (script.failure_mode_by_check).
//   PreToolUse ExitPlanMode / Write|Edit|MultiEdit of a plan file: no advisor call since the last user message -> block once.
//   PostToolUseFailure Bash (test or build command): arms the retry rule with the transcript offset of the newest advisor call and
//   the files edited so far. PostToolUse Bash (the same commands, i.e. a passing run) disarms it and forgets the edits.
//   PreToolUse Write|Edit|MultiEdit: a file edited BEFORE the armed failure, edited again with no advisor call after the failure
//   -> block once, then the failure is disarmed. Test files are exempt (test-first red step); the state is per agent (agent_id).
'use strict';

function agFile(p) {
  var i = jx.isObj(p.tool_input) ? p.tool_input : {};
  return typeof i.file_path === 'string' ? i.file_path : '';
}

function decide(p) {
  if (!jx.isObj(p) || ah.settings.skipped(ah.cfg('advisor.guard_name')) || advisorKit.stopping(p)) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  var event = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
  var scan = null, file = agFile(p);
  if (event === 'PostToolUseFailure' || event === 'PostToolUse') {
    if (tool !== 'Bash' || p.is_interrupt === true || !ah.settings.bool('advisor.sw_retry')) return 'allow';
    var cmd = jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
    if (!ah.re.test(ah.cfg('advisor.test_cmd_re'), 'r', cmd)) return 'allow';
    var st = advisorKit.load(p);
    if (event === 'PostToolUse') { // a passing test or build: the edits are settled, nothing stays armed
      if (st.fail !== null || Object.keys(st.edits).length > 0) { st.fail = null; st.edits = {}; advisorKit.save(p, st); }
      return 'allow';
    }
    scan = advisorKit.scan(p);
    if (!advisorKit.present(p, scan)) return 'allow';
    st.fail = { advisorAt: scan !== null ? scan.lastAdvisor : -1, files: Object.keys(st.edits) }; // only files edited BEFORE this failure can trip the rule
    advisorKit.save(p, st);
    return 'allow';
  }
  var isPlan = ah.cfg('advisor.plan_tools').indexOf(tool) >= 0 || (ah.cfg('advisor.edit_tools').indexOf(tool) >= 0 && file !== '' && ah.re.test(ah.cfg('advisor.plan_file_re'), 'r', file));
  var isEdit = ah.cfg('advisor.edit_tools').indexOf(tool) >= 0 && file !== '' && !ah.re.test(ah.cfg('advisor.test_file_re'), 'r', file); // test files are exempt: test-first work re-edits the test after its red run
  if (isPlan && ah.settings.bool('advisor.sw_plan')) {
    scan = advisorKit.scan(p);
    if (advisorKit.present(p, scan) && scan !== null && scan.lastAdvisor < scan.lastUser && advisorKit.gate('advisor.kind_plan', p, tool + ':' + file)) {
      return advisorKit.block(ah.cfg('advisor.msg_plan_what'), ah.cfg('advisor.msg_plan_instead'));
    }
  }
  if (isEdit && ah.settings.bool('advisor.sw_retry')) {
    var s = advisorKit.load(p);
    var verdict = 'allow';
    if (s.fail !== null && jx.isObj(s.fail) && Array.isArray(s.fail.files) && s.fail.files.indexOf(file) >= 0) {
      if (scan === null) scan = advisorKit.scan(p);
      if (scan !== null && scan.lastAdvisor > s.fail.advisorAt) s.fail = null; // consulted since the failure: disarm
      else if (advisorKit.present(p, scan) && advisorKit.gate('advisor.kind_retry', p, file)) {
        s.fail = null;
        verdict = advisorKit.block(text.render(ah.cfg('advisor.msg_retry_what'), { file: file }), ah.cfg('advisor.msg_retry_instead'));
      }
    }
    if (verdict === 'allow') s.edits[file] = (s.edits[file] || 0) + 1;
    advisorKit.save(p, s);
    return verdict;
  }
  return 'allow';
}

// check = "lane-test-guard" (PreToolUse on Bash, subagents only; engine-only, no Node twin; GH #270). Blocks the suite-scale test
// commands a lane agent runs while it waits on the shared build lock: cargo test / nextest without a narrowing filter, --workspace,
// node --test without a file, test.sh, replay and soak runners. cargo check and a filtered single-module test stay allowed. The
// main session and a workspace child are never judged. Reads simple commands (quotes, wrappers, sh -c scripts); a script it cannot
// see (`bash run.sh`) is out of reach. Every list, pattern and text is in lane_waste.toml. A failure of this script allows
// (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// null, or the label of the suite-scale cargo test run `words` is (words[0] is the command).
function ltCargo(words) {
  if (ah.cfg('lane_test.cargo_commands').indexOf(shellScan.basename(words[0])) < 0) return null;
  var tcRe = ah.cfg('lane_test.cargo_toolchain_re'), i = 1;
  while (i < words.length && ah.re.test(tcRe, 'r', words[i])) i++;
  var sub = words[i];
  if (sub === undefined || ah.cfg('lane_test.cargo_test_subcommands').indexOf(sub) < 0) return null;
  var rest = words.slice(i + 1), suite = false, narrow = false, afterDash = false, k;
  var valueFlags = ah.cfg('lane_test.cargo_value_flags'), narrowFlags = ah.cfg('lane_test.cargo_narrow_flags');
  var suiteFlags = ah.cfg('lane_test.cargo_suite_flags'), noRun = ah.cfg('lane_test.cargo_no_run_flags');
  var runWords = ah.cfg('lane_test.nextest_run_words'), otherWords = ah.cfg('lane_test.nextest_other_words'), sawSub = sub !== 'nextest';
  for (k = 0; k < rest.length; k++) {
    var w = rest[k];
    if (afterDash) { if (w.charAt(0) !== '-') narrow = true; continue; }
    if (w === '--') { afterDash = true; continue; }
    if (noRun.indexOf(w) >= 0) return null;
    if (suiteFlags.indexOf(w) >= 0) { suite = true; continue; }
    if (narrowFlags.indexOf(w) >= 0) { narrow = true; k++; continue; }
    if (valueFlags.indexOf(w) >= 0) { k++; continue; }
    if (w.charAt(0) === '-') {
      var eq = w.indexOf('=');
      if (eq > 0 && narrowFlags.indexOf(w.slice(0, eq)) >= 0) narrow = true;
      if (eq > 0 && suiteFlags.indexOf(w.slice(0, eq)) >= 0) suite = true;
      continue;
    }
    if (!sawSub) {
      sawSub = true;
      if (otherWords.indexOf(w) >= 0) return null;
      if (runWords.indexOf(w) >= 0) continue;
    }
    narrow = true;
  }
  return suite || !narrow ? 'cargo ' + sub : null;
}

// null, or the label of the suite-scale runner (a lane_test.rules row) the command `words` is.
function ltRule(words) {
  var joined = words.join(' '), rules = ah.cfg('lane_test.rules');
  for (var r = 0; r < rules.length; r++) {
    if (!ah.re.test(rules[r].re, 'r', joined)) continue;
    if (rules[r].unless_re && ah.re.test(rules[r].unless_re, 'r', joined)) continue;
    return rules[r].label;
  }
  return null;
}

function decide(p, opts) {
  if (!ah.settings.bool('lane_test.sw') || ah.settings.bool('lane_test.sw_allow_suites') || ah.settings.skipped(ah.cfg('lane_test.guard_name'))) return 'allow';
  var cmd = p && p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (cmd === '' || !coordinator.subagentByPayload(p)) return 'allow';
  var cmds = laneWaste.commands(cmd, 0);
  for (var c = 0; c < cmds.length; c++) {
    var label = ltCargo(cmds[c].words) || ltRule(cmds[c].words);
    if (label === null) continue;
    var reason = text.message('block', ah.cfg('lane_test.guard_name'), {
      what: text.render(ah.cfg('lane_test.msg_what'), { cmd: laneWaste.shown(cmds[c].words), label: label }),
      why: ah.cfg('lane_test.msg_why'),
      instead: ah.cfg('lane_test.msg_instead'),
      override: ah.cfg('lane_test.msg_override'),
    });
    // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
    return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
  }
  return 'allow';
}

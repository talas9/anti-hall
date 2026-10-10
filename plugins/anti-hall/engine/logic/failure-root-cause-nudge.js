// check = "failure-root-cause-nudge" (PostToolUseFailure on Bash; advisory only, never blocks). When a Bash call fails, one short
// line points at the root-cause skill. The noise filter (guards.failureNudgeFilter, default on) stays silent for an interrupt, a
// harness refusal, an expected exit 1 from a predicate command, and for every nudge after the first in one turn (the state is the
// file the Node hook keeps). A request without a home directory defers; a payload whose answer the script cannot give defers.
// Mirrors hooks/failure-root-cause-nudge.js, hooks/lib/expected-failure.js and hooks/lib/turn-gate.js (lib/70-guardkit.js).
// Tables, patterns and texts: small_guards.toml (failure_nudge.*, expected_failure.*, turn_gate.*).
'use strict';

// Split on top-level separators only: outside quotes, backticks, $(...) and ${...}; null when quoting is unbalanced.
function fnSplitTop(cmd, seps) {
  var out = [], cur = '', i = 0, depth = 0, quote = '', n = cmd.length;
  while (i < n) {
    var c = cmd[i];
    if (quote === "'") { cur += c; if (c === "'") quote = ''; i++; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] || ''); i += 2; continue; }
    if (quote === '"') {
      cur += c;
      if (c === '"') quote = '';
      else if (c === '$' && cmd[i + 1] === '(') { depth++; cur += '('; i++; }
      i++; continue;
    }
    if (quote === '`') { cur += c; if (c === '`') quote = ''; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; i++; continue; }
    if (c === '(' || c === '{') { depth++; cur += c; i++; continue; }
    if (c === ')' || c === '}') { if (depth > 0) depth--; cur += c; i++; continue; }
    if (depth === 0) {
      var hit = null;
      for (var k = 0; k < seps.length; k++) { if (cmd.startsWith(seps[k], i)) { hit = seps[k]; break; } }
      if (hit) { out.push(cur); cur = ''; i += hit.length; continue; }
    }
    cur += c; i++;
  }
  if (quote) return null;
  out.push(cur);
  return out;
}

function fnSimpleVerb(seg) {
  var s = seg.trim();
  if (!s || s[0] === '(' || s[0] === '{' || s[0] === '!') return null;
  var toks = s.split(/\s+/), i = 0, pass = ah.cfg('expected_failure.pass_through'), assign = gk.re('expected_failure.assign');
  for (;;) {
    while (i < toks.length && assign.test(toks[i])) i++;
    if (i < toks.length && pass.indexOf(toks[i]) >= 0) { i++; continue; }
    if (i < toks.length && toks[i] === '-v' && i > 0 && toks[i - 1] === 'command') return { verb: ah.cfg('expected_failure.command_v_verb'), args: toks.slice(i + 1) };
    break;
  }
  if (i >= toks.length) return null;
  return { verb: toks[i].replace(/^.*\//, ''), args: toks.slice(i + 1) };
}

function fnIsPredicate(seg) {
  var t = seg.trim();
  if (gk.re('expected_failure.command_v').test(t)) return true;
  var sv = fnSimpleVerb(t);
  if (!sv) return false;
  if (ah.cfg('expected_failure.predicate_verbs').indexOf(sv.verb) >= 0) return true;
  if (sv.verb === ah.cfg('expected_failure.git_verb')) {
    var rest = sv.args.join(' ');
    return ah.cfg('expected_failure.git_predicates').some(function (src) { return new RegExp(src).test(rest); });
  }
  return false;
}

function fnIsTrivial(seg) {
  var sv = fnSimpleVerb(seg);
  return !!sv && ah.cfg('expected_failure.trivial_verbs').indexOf(sv.verb) >= 0;
}

function fnExitCodeOf(errorText) {
  if (typeof errorText !== 'string') return null;
  var m = gk.re('expected_failure.exit_code').exec(errorText);
  return m ? parseInt(m[1], 10) : null;
}

function fnIsHarnessRefusal(errorText) { return typeof errorText === 'string' && gk.re('expected_failure.refusal').test(errorText); }

function fnIsExpectedNonzero(command, errorText) {
  try {
    if (typeof command !== 'string' || !command.trim()) return false;
    if (fnExitCodeOf(errorText) !== parseInt(ah.cfg('expected_failure.predicate_exit'), 10)) return false;
    if (gk.re('expected_failure.bail').test(command)) return false;
    var flat = command.replace(/\\\n/g, ' ');
    var stmts = fnSplitTop(flat, [';', '\n']);
    if (!stmts) return false;
    var last = null;
    for (var k = stmts.length - 1; k >= 0; k--) { if (stmts[k].trim()) { last = stmts[k].trim(); break; } }
    if (!last) return false;
    if (gk.re('expected_failure.trailing_bg').test(last) && !gk.re('expected_failure.trailing_and').test(last)) return false;
    if (gk.re('expected_failure.comment_or_empty').test(last)) return false;
    if (gk.re('expected_failure.control').test(last)) return false;
    var orParts = fnSplitTop(last, ['||']);
    if (orParts === null || orParts.length > 1) return false;
    var links = fnSplitTop(last, ['&&']);
    if (!links) return false;
    var sawPredicate = false;
    for (var li = 0; li < links.length; li++) {
      var stages = fnSplitTop(links[li], ['|&', '|']);
      if (!stages) return false;
      var decider = stages[stages.length - 1];
      if (gk.re('expected_failure.subst').test(decider.split(gk.re('expected_failure.redirect_split'))[0])) return false;
      if (fnIsPredicate(decider)) { sawPredicate = true; continue; }
      if (links.length > 1 && fnIsTrivial(decider) && stages.length === 1) continue;
      return false;
    }
    return sawPredicate;
  } catch (e) {
    return false;
  }
}

function decide(p) {
  if (!ah.settings.bool('failure_nudge.setting') || ah.settings.skipped(ah.cfg('failure_nudge.guard_name'))) return 'allow';
  if (!p || p.tool_name !== 'Bash') return 'allow';
  var ti = p.tool_input, cmd = ti && typeof ti.command === 'string' ? ti.command : '';
  if (ah.settings.bool('failure_nudge.filter_setting')) {
    var errorText = typeof p.error === 'string' ? p.error : '';
    if (p.is_interrupt === true || fnIsHarnessRefusal(errorText) || fnIsExpectedNonzero(cmd, errorText)) return 'allow';
    // with no home for the gate's state the gate cannot persist and shows the nudge, as the Node gate does
    if (!turnGate.firstThisTurn({
      sessionId: p.session_id, agentId: typeof p.agent_id === 'string' ? p.agent_id : '', transcriptPath: p.transcript_path,
      key: ah.cfg('failure_nudge.gate_key'),
    })) return 'allow';
  }
  var one = cmd.replace(/\s+/g, ' ').trim(), max = ah.cfgNum('failure_nudge.max_cmd_len');
  var shown = one.length <= max ? one : one.slice(0, max) + ah.cfg('failure_nudge.ellipsis');
  var part = shown ? ah.cfg('failure_nudge.cmd_open') + shown + ah.cfg('failure_nudge.cmd_close') : '';
  var t = text.message('tip', ah.cfg('failure_nudge.message_guard'), {
    what: text.render(ah.cfg('failure_nudge.msg_what'), { cmd: part }), instead: ah.cfg('failure_nudge.msg_instead'),
  });
  return { advisory: text.advisoryJson(ah.cfg('failure_nudge.event'), t) };
}

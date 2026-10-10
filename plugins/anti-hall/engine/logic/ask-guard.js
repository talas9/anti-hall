// check = "ask-guard" (PreToolUse on AskUserQuestion). Optional and off by default (guards.noBlockingQuestions): `advise` adds the
// standing rule to the question call, `block` refuses it unless the first question starts with DESTRUCTIVE: or CREDENTIAL: (then
// the use is appended to the marker log). Independent of that mode, guards.questionAgentsNote adds one line naming the
// background agents the transcript proves are still in flight. In a DevSwarm child workspace the advice and the block point at
// the parent. A relative transcript path is read from the hook process's directory (lib/78-hook-proc.js); a transcript line the
// host cannot read exactly as JavaScript would defers the whole call to Node; a home that is not an absolute path leaves the
// marker line unwritten (logged), which does not change the decision.
// Mirrors hooks/ask-guard.js. Keys and texts: agent_controls.toml (ask_guard.*).
'use strict';

function askIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function askMarkerOf(ti) {
  var qs = askIsObj(ti) ? ti.questions : null;
  var first = Array.isArray(qs) ? qs[0] : null;
  if (first === null || first === undefined || typeof first !== 'object') return null;
  var fields = [first.header, first.question];
  for (var i = 0; i < fields.length; i++) {
    if (typeof fields[i] !== 'string') continue;
    var m = new RegExp(ah.cfg('ask_guard.marker_re')).exec(fields[i].trim());
    if (m) return m[1];
  }
  return null;
}

// One line naming the running agents; '' when none is provably in flight; null when the transcript cannot be read exactly as JavaScript would (Node decides).
function askAgentsNote(p) {
  if (!ah.settings.bool('ask_guard.note_setting')) return '';
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return '';
  var found = ah.transcript.agents(hookProc.open(p, tp));
  if (found === null) return '';
  if (found.unsure) return null;
  var agents = found.rows;
  if (agents.length === 0) return '';
  var max = ah.cfgNum('ask_guard.note_max_listed'), control = new RegExp(ah.cfg('ask_guard.note_control_re'), 'g');
  var names = agents.slice(0, max).map(function (a) {
    var d = String(a.description || '').replace(control, ' ').trim().slice(0, ah.cfgNum('ask_guard.note_desc_max'));
    return d || ah.cfg('ask_guard.note_unnamed');
  });
  var more = agents.length > max ? text.render(ah.cfg('ask_guard.note_more'), { n: agents.length - max }) : '';
  return agents.length + ah.cfg('ask_guard.note_head') + (agents.length === 1 ? ah.cfg('ask_guard.note_one') : ah.cfg('ask_guard.note_many')) +
    ah.cfg('ask_guard.note_mid') + names.join(ah.cfg('ask_guard.note_join')) + more + ah.cfg('ask_guard.note_tail');
}

function decide(p) {
  var home = spawn.osHome();
  var mode = ah.settings.enum('ask_guard.mode_setting');
  if (mode !== 'advise' && mode !== 'block') mode = 'off';
  if (mode === 'off' && !ah.settings.bool('ask_guard.note_setting')) return 'allow';
  var guard = ah.cfg('ask_guard.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  if (!askIsObj(p) || p.tool_name !== ah.cfg('ask_guard.tool')) return 'allow';
  var child = ah.env.get(ah.cfg('ask_guard.child_env'));
  var suffix = child !== null && child.trim() !== '' ? ah.cfg('ask_guard.child_text') : '';
  var marker = null;
  if (mode === 'block') {
    marker = askMarkerOf(p.tool_input);
    if (marker === null) {
      var reason = text.message('block', guard, {
        what: ah.cfg('ask_guard.block_what'), why: ah.cfg('ask_guard.block_why'),
        instead: ah.cfg('ask_guard.block_instead'), allowed: ah.cfg('ask_guard.block_allowed'),
      }) + suffix;
      return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
    }
  }
  var parts = [];
  if (mode === 'advise') {
    parts.push(text.message('tip', guard, { what: ah.cfg('ask_guard.advise_what'), instead: ah.cfg('ask_guard.advise_instead') }) + suffix);
  }
  var note = askAgentsNote(p);
  if (note === null) return 'defer';
  if (note !== '') parts.push(note);
  if (marker !== null && home === null) ah.log('ask_guard_marker_no_home', marker);
  else if (marker !== null) {
    ah.state.appendFile(ah.cfg('ask_guard.log_file'),
      JSON.stringify({ ts: new Date(ah.clock.now()).toISOString(), event: ah.cfg('ask_guard.log_event'), marker: marker }) + '\n');
  }
  if (parts.length === 0) return 'allow';
  return { advisory: text.advisoryJson('PreToolUse', parts.join('\n')) };
}

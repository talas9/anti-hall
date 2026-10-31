// check = "engine-role-note" (SessionStart and SubagentStart; engine-only, no Node twin). Tells the session its role, the engine
// verbs that role may run and where the full guide is (the main engine skill only). A role with a roles.describe_short entry gets one line instead (roles.msg_note_short). Each role sees only what it may use. The
// note is capped at roles.note_max characters. Texts, the matrix and the switch: roles.toml.
'use strict';

function decide(p, opts) {
  if (!ah.settings.bool('roles.sw_note') || ah.settings.skipped(ah.cfg('roles.guard_name'))) return 'allow';
  var host = (opts && opts.host === 'codex') || coordinator.payloadIsCodex(p) ? 'codex' : 'claude';
  var role = roles.detect(p, host);
  var verbs = roles.verbsFor(role), max = ah.cfg('roles.note_max');
  var skill = ah.cfg('roles.skill_host')[host].ref.replace('{skill}', ah.cfg('roles.main_skill').name);
  var what = ah.cfg('roles.describe')[role];
  var event = p && typeof p.hook_event_name === 'string' && p.hook_event_name !== '' ? p.hook_event_name : 'SessionStart';
  var brief = ah.cfg('roles.describe_short')[role];
  if (ah.settings.bool('roles.sw_note_short') && typeof brief === 'string' && brief !== '') {
    ah.advisory('role_note', ah.cfg('roles.event_emitted_short'));
    return { advisory: text.advisoryJson(event, text.render(ah.cfg('roles.msg_note_short'), { role: role, what: brief, skill: skill })) };
  }
  var shown = verbs.slice();
  function build() {
    var more = shown.length < verbs.length ? text.render(ah.cfg('roles.msg_note_more'), { n: verbs.length - shown.length }) : '';
    return text.render(ah.cfg('roles.msg_note'), {
      role: role, what: what, verbs: shown.length > 0 ? shown.join(', ') : ah.cfg('roles.msg_none'), more: more, skill: skill,
    });
  }
  var t = build();
  while (t.length > max && shown.length > 0) { shown.pop(); t = build(); }
  ah.advisory('role_note', ah.cfg('roles.event_emitted_full'));
  return { advisory: text.advisoryJson(event, t) };
}

// check = "engine-role-note" (SessionStart and SubagentStart; engine-only, no Node twin). Tells the session its role, the engine
// verbs that role may run and where the full guide is (the main engine skill only). A role with a roles.describe_short entry gets one line instead (roles.msg_note_short). Each role sees only what it may use. The
// note is capped at roles.note_max characters. Texts, the matrix and the switch: roles.toml.
'use strict';

// A key added after the released pristine copy is missing when the engine answers from that fallback (an edited roles.toml that does not parse):
// the one-line note then stays off and the full note is sent, as before the switch existed.
function optCfg(key) { try { return ah.cfg(key); } catch (e) { return undefined; } }
function optSwitch(key) { try { return ah.settings.bool(key); } catch (e) { return false; } }

function decide(p, opts) {
  if (!ah.settings.bool('roles.sw_note') || ah.settings.skipped(ah.cfg('roles.guard_name'))) return 'allow';
  var host = (opts && opts.host === 'codex') || coordinator.payloadIsCodex(p) ? 'codex' : 'claude';
  var role = roles.detect(p, host);
  var verbs = roles.verbsFor(role), max = ah.cfg('roles.note_max');
  var skill = ah.cfg('roles.skill_host')[host].ref.replace('{skill}', ah.cfg('roles.main_skill').name);
  var what = ah.cfg('roles.describe')[role];
  var event = p && typeof p.hook_event_name === 'string' && p.hook_event_name !== '' ? p.hook_event_name : 'SessionStart';
  // The one-line note is an extra DEFAULT for an unedited note: it replaces the full note only while roles.msg_note and this role's roles.describe
  // entry still hold their stock values and the line fits roles.note_max. An edited text (or limit) keeps the full note, edited, switch on or off.
  var shortMsg = optSwitch('roles.sw_note_short') ? optCfg('roles.msg_note_short') : undefined;
  var shortWhat = typeof shortMsg === 'string' ? optCfg('roles.describe_short') : undefined;
  var brief = shortWhat && typeof shortWhat === 'object' ? shortWhat[role] : undefined;
  if (typeof brief === 'string' && brief !== '') {
    var stockNote = optCfg('roles.stock_msg_note'), stockWhat = optCfg('roles.stock_describe');
    var unedited = typeof stockNote === 'string' && ah.cfg('roles.msg_note') === stockNote && stockWhat && typeof stockWhat === 'object' && what === stockWhat[role];
    var line = unedited ? text.render(shortMsg, { role: role, what: brief, skill: skill }) : '';
    if (unedited && line.length <= max) {
      var evShort = optCfg('roles.event_emitted_short');
      if (typeof evShort === 'string') ah.metric('role_note_emitted', ['form', evShort]);
      return { advisory: text.advisoryJson(event, line) };
    }
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
  var evFull = optCfg('roles.event_emitted_full');
  if (typeof evFull === 'string') ah.metric('role_note_emitted', ['form', evFull]);
  return { advisory: text.advisoryJson(event, t) };
}

// check = "rule-digest" (SessionStart; a compaction restarts the session context through the same event). Puts the essentials of
// the rules the engine enforces into the session context, from the file ah-regen generates out of the rule registry
// (guard_rules.rules), so the agent sees the same rules the engine checks. Off switch context.ruleDigest; context.ruleDigestTier
// widens it to the other listed rules up to roles.digest_budget bytes. Records the session's digest state for the
// blocks-per-100-calls comparison. Keys and texts: guard_rules.toml (guard_rules.*).
'use strict';

function decide(p, opts, event) {
  if (!jx.isObj(p) || sess.judgeChild()) return 'allow';
  var on = ah.settings.bool('guard_rules.sw_digest');
  ah.metric('rule_digest', ['state', on ? 'on' : 'off']);
  var sid = typeof p.session_id === 'string' ? p.session_id : '';
  // the on/off record is telemetry only: a refused or failed write never costs the session its digest
  if (sid !== '') {
    try { ah.state.appendFile(ah.cfg('guard_rules.digest_state_file'), sid + ' ' + (on ? 'on' : 'off') + ' ' + ah.clock.now() + '\n'); } catch (e) { ah.unable('rule-digest:state_write'); }
  }
  if (!on) return 'allow';
  var root = sess.pluginRoot(opts);
  if (root === null) return 'allow';
  // the host's own digest (its own model guidance): a Codex request reads guard_rules.digest_file_codex
  var host = (ah.request && ah.request.host) || (opts && opts.host) || p.host || (coordinator.isCodexPayload(p) ? ah.cfg('standdown.codex_host') : ah.cfg('dispatch.default_host'));
  var raw = ah.fs.readText(root + '/' + ah.cfg(host === ah.cfg('standdown.codex_host') ? 'guard_rules.digest_file_codex' : 'guard_rules.digest_file'));
  if (raw === null) { ah.unable('rule-digest:no_file'); return 'allow'; }
  var sep = ah.cfg('guard_rules.digest_sep'), parts = raw.split('\n' + sep + '\n');
  var lines = parts[0].split('\n').filter(function (l) { return l !== ''; });
  var budget = ah.cfgNum('roles.digest_budget'), head = ah.cfg('guard_rules.digest_head'), foot = ah.cfg('guard_rules.digest_foot');
  var size = head.length + foot.length + 2 + lines.join('\n').length;
  if (ah.settings.enum('guard_rules.enum_digest_tier') === 'skill' && parts.length > 1) {
    var extra = parts[1].split('\n').filter(function (l) { return l !== ''; });
    for (var i = 0; i < extra.length && size + extra[i].length + 1 <= budget; i++) { lines.push(extra[i]); size += extra[i].length + 1; }
  }
  var t = head + '\n' + lines.join('\n') + '\n' + foot;
  return { advisory: text.advisoryJson(event, t) };
}

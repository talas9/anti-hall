// check = "engine-role-guard" (PreToolUse on Bash; engine-only, no Node twin). Refuses an `ah-engine` command that the caller's
// role may not run, per roles.matrix: a subagent from the payload, a workspace child from the environment. The command line
// enforces the same matrix for what the environment alone proves. Texts, the matrix and the switch: roles.toml.
'use strict';

function decide(p, opts) {
  if (!ah.settings.bool('roles.sw_guard') || ah.settings.skipped(ah.cfg('roles.guard_name'))) return 'allow';
  var cmd = p && p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (cmd.indexOf(ah.cfg('roles.engine_bin')) < 0) return 'allow';
  var role = roles.detect(p, opts && opts.host);
  var calls = roles.invocations(cmd);
  for (var i = 0; i < calls.length; i++) {
    var why = roles.refusal(role, calls[i].verb, calls[i].args);
    if (why !== null) return { exact: { code: 2, out: text.blockJson(why), err: '' } };
  }
  return 'allow';
}

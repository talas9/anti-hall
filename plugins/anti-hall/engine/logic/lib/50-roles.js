// Caller roles (owner feature 22): who is calling, which engine verbs that role may run, and the refusal text. The matrix, the
// markers and every text are in roles.toml (roles.*). Mirrors ah-engine src/roles.rs, which gates the command line.
'use strict';
var roles = {
  // 'subagent' | 'workspace' | 'codex' | 'main'; the payload tells a subagent, the environment a workspace child.
  detect: function (p, host) {
    if (coordinator.subagentByPayload(p)) return 'subagent';
    var branch = ah.env.get(ah.cfg('roles.branch_env'));
    if (branch !== null && branch !== '') return 'workspace';
    return host === 'codex' || coordinator.payloadIsCodex(p) ? 'codex' : 'main';
  },
  row: function (verb) {
    var m = ah.cfg('roles.matrix');
    return Object.prototype.hasOwnProperty.call(m, verb) ? m[verb] : null;
  },
  verbsFor: function (role) {
    var m = ah.cfg('roles.matrix');
    return Object.keys(m).filter(function (v) { return m[v].roles.indexOf(role) >= 0; });
  },
  // null when the role may run it, else the refusal text.
  refusal: function (role, verb, args) {
    var r = roles.row(verb);
    if (r === null) return null;
    var ownerRoles = ah.cfg('roles.owner_roles');
    var owner = (r.owner_args || []).some(function (o) { return args.indexOf(o) >= 0; });
    if (r.roles.indexOf(role) < 0 || (owner && ownerRoles.indexOf(role) < 0)) {
      var pool = owner ? r.roles.filter(function (x) { return ownerRoles.indexOf(x) >= 0; }) : r.roles;
      return text.render(ah.cfg('roles.msg_refuse'), {
        verb: verb, role: role, allowed: pool.join(', '),
        why: ah.cfg(owner ? 'roles.msg_why_owner' : 'roles.msg_why_other'),
      });
    }
    if ((r.self_only || []).indexOf(role) >= 0) {
      var me = ah.env.get(ah.cfg('roles.builder_env')) || '';
      var flags = ah.cfg('roles.self_flags');
      for (var i = 0; i < args.length; i++) {
        if (flags.indexOf(args[i]) >= 0 && i + 1 < args.length && args[i + 1] !== me) {
          return text.render(ah.cfg('roles.msg_refuse_self'), { verb: verb, target: args[i + 1], self: me });
        }
      }
    }
    return null;
  },
  // Every engine invocation in a Bash command as { verb, args }, leading flags such as --json skipped.
  invocations: function (cmd) {
    var out = [], hits = ah.re.findAll(ah.cfg('roles.bash_re'), 'r', cmd);
    for (var i = 0; i < hits.length; i++) {
      var rest = cmd.slice(hits[i][1]);
      var cut = rest.search(/[;&|\n]/);
      if (cut >= 0) rest = rest.slice(0, cut);
      var toks = rest.split(/\s+/).filter(function (t) { return t !== ''; });
      while (toks.length > 0 && toks[0].charAt(0) === '-') toks.shift();
      if (toks.length > 0) out.push({ verb: toks[0], args: toks.slice(1) });
    }
    return out;
  },
};
